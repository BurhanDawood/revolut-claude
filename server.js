import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createPrivateKey, sign } from 'crypto';

const API_KEY = process.env.REVOLUTX_API_KEY;
const PRIVATE_KEY = process.env.REVOLUTX_PRIVATE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BASE_URL = 'https://revx.revolut.com/api/1.0';
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const ALERT_INTERVAL_MS = 60 * 1000;
const PUMP_THRESHOLD = 0.20;
const SKIP_CURRENCIES = ['USD', 'USDT', 'USDC', 'EUR', 'GBP'];

async function revolutRequest(method, path) {
  const timestamp = Date.now().toString();
  const message = `${timestamp}${method}/api/1.0${path}`;
  const privateKeyPem = PRIVATE_KEY.replace(/\\n/g, '\n');
  const pk = createPrivateKey({ key: privateKeyPem, format: 'pem', type: 'pkcs8' });
  const signature = sign(null, Buffer.from(message, 'utf8'), { key: pk, dsaEncoding: 'ieee-p1363' });
  const headers = {
    'X-Revx-API-Key': API_KEY,
    'X-Revx-Timestamp': timestamp,
    'X-Revx-Signature': signature.toString('base64'),
    'Content-Type': 'application/json'
  };
  const response = await fetch(`${BASE_URL}${path}`, { method, headers });
  const text = await response.text();
  return JSON.parse(text);
}

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
  });
  console.log('Telegram sent:', message.substring(0, 50));
}

const basePrices = {};
const activeAlerts = {};
const lastBalances = {};
const customThresholds = {};
let monitoringPaused = false;
let monitoringInterval = null;

async function checkPortfolio() {
  if (monitoringPaused) {
    console.log('Monitoring paused, skipping check.');
    return;
  }
  try {
    console.log('Checking portfolio...');

    // Get all balances
    const balances = await revolutRequest('GET', '/balances');

    // Get all tickers in one call
    const tickerResponse = await revolutRequest('GET', '/tickers');
    console.log('Got tickers response:', JSON.stringify(tickerResponse).substring(0, 300));

    // Build price map - handle both array and {data: [...]} formats
    const priceMap = {};
    const tickerList = Array.isArray(tickerResponse) ? tickerResponse : (tickerResponse.data || []);
    for (const ticker of tickerList) {
      if (ticker.symbol) {
        const price = parseFloat(ticker.last_price || ticker.mid || ticker.ask || ticker.bid);
        if (price) {
          // Store with both formats: BTC/USD and BTC-USD
          priceMap[ticker.symbol] = price;
          priceMap[ticker.symbol.replace('/', '-')] = price;
        }
      }
    }
    console.log('Price map size:', Object.keys(priceMap).length);

    console.log('Price map sample:', JSON.stringify(Object.entries(priceMap).slice(0, 3)));

    for (const asset of balances) {
      if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
      const available = parseFloat(asset.available);
      if (available <= 0) continue;

      const symbol = `${asset.currency}-USD`;
      const currentPrice = priceMap[symbol];

      if (!currentPrice) {
        console.log(`No price available for ${symbol}`);
        continue;
      }

      // Check if position was sold
      if (activeAlerts[symbol] && lastBalances[symbol] && available < lastBalances[symbol] * 0.9) {
        console.log(`Position reduced for ${symbol}, stopping alerts`);
        clearInterval(activeAlerts[symbol]);
        delete activeAlerts[symbol];
        delete basePrices[symbol];
        await sendTelegram(`✅ Alert stopped for ${symbol} — position change detected.`);
      }

      lastBalances[symbol] = available;

      // Set baseline if not set
      if (!basePrices[symbol]) {
        basePrices[symbol] = currentPrice;
        console.log(`Baseline set for ${symbol}: $${currentPrice}`);
        continue;
      }

      const change = (currentPrice - basePrices[symbol]) / basePrices[symbol];
      console.log(`${symbol}: $${currentPrice} (${(change * 100).toFixed(1)}% from baseline)`);

      // Trigger alert if pumping
      const threshold = customThresholds[symbol] !== undefined ? customThresholds[symbol] : PUMP_THRESHOLD;
      if (change >= threshold && !activeAlerts[symbol]) {
        const pct = (change * 100).toFixed(1);
        const alertMessage = `🚀 <b>${symbol} is pumping!</b>\n\nUp <b>${pct}%</b> from $${basePrices[symbol].toFixed(4)} → $${currentPrice.toFixed(4)}\n\nYou hold: ${available} ${asset.currency}\nLog into Revolut X to act!`;
        await sendTelegram(alertMessage);

        activeAlerts[symbol] = setInterval(async () => {
          await sendTelegram(`⚠️ <b>REMINDER: ${symbol} still up ${pct}%!</b>\n\nCurrent price: $${currentPrice.toFixed(4)}\nYou hold: ${available} ${asset.currency}`);
        }, ALERT_INTERVAL_MS);
      }
    }
  } catch (e) {
    console.log('Portfolio check error:', e.message, e.stack);
  }
}

// Start monitoring loop
setTimeout(async () => {
  await sendTelegram('🤖 Revolut X monitor started! Checking your portfolio every 5 minutes.');
  await checkPortfolio();
  monitoringInterval = setInterval(checkPortfolio, CHECK_INTERVAL_MS);
}, 5000);

const app = express();
app.use(express.json());

// CORS middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// GET /api/status — monitoring status, active alerts, baseline prices
app.get('/api/status', (req, res) => {
  const alerts = {};
  for (const symbol of Object.keys(activeAlerts)) {
    alerts[symbol] = { alerting: true };
  }
  res.json({
    paused: monitoringPaused,
    activeAlerts: alerts,
    basePrices,
    customThresholds,
    defaultThreshold: PUMP_THRESHOLD
  });
});

// GET /api/balances — balances with prices and total portfolio value
app.get('/api/balances', async (req, res) => {
  try {
    const balances = await revolutRequest('GET', '/balances');
    const tickerResponse = await revolutRequest('GET', '/tickers');
    const tickerList = Array.isArray(tickerResponse) ? tickerResponse : (tickerResponse.data || []);
    const priceMap = {};
    for (const ticker of tickerList) {
      if (ticker.symbol) {
        const price = parseFloat(ticker.last_price || ticker.mid || ticker.ask || ticker.bid);
        if (price) {
          priceMap[ticker.symbol] = price;
          priceMap[ticker.symbol.replace('/', '-')] = price;
        }
      }
    }
    let totalUSD = 0;
    const result = [];
    for (const asset of balances) {
      const available = parseFloat(asset.available);
      if (!asset.currency || available <= 0) continue;
      const symbol = `${asset.currency}-USD`;
      const price = SKIP_CURRENCIES.includes(asset.currency) ? 1 : (priceMap[symbol] || null);
      const valueUSD = price ? available * price : null;
      if (valueUSD) totalUSD += valueUSD;
      result.push({ currency: asset.currency, available, price, valueUSD, symbol });
    }
    res.json({ balances: result, totalUSD });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/acknowledge/:symbol — stop alerts for a coin
app.post('/api/acknowledge/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  if (activeAlerts[symbol]) {
    clearInterval(activeAlerts[symbol]);
    delete activeAlerts[symbol];
    await sendTelegram(`🔕 Alerts acknowledged for ${symbol} via dashboard.`);
    res.json({ ok: true, message: `Alerts stopped for ${symbol}` });
  } else {
    res.json({ ok: false, message: `No active alert for ${symbol}` });
  }
});

// POST /api/pause — pause all monitoring
app.post('/api/pause', async (req, res) => {
  monitoringPaused = true;
  await sendTelegram('⏸️ Portfolio monitoring paused via dashboard.');
  res.json({ ok: true, paused: true });
});

// POST /api/resume — resume monitoring
app.post('/api/resume', async (req, res) => {
  monitoringPaused = false;
  await sendTelegram('▶️ Portfolio monitoring resumed via dashboard.');
  res.json({ ok: true, paused: false });
});

// POST /api/threshold/:symbol — set per-coin alert threshold
app.post('/api/threshold/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const { threshold } = req.body;
  if (typeof threshold !== 'number' || threshold <= 0) {
    return res.status(400).json({ error: 'threshold must be a positive number (e.g. 0.15 for 15%)' });
  }
  customThresholds[symbol] = threshold;
  res.json({ ok: true, symbol, threshold });
});

function createMcpServer() {
  const server = new McpServer({ name: 'revolut-x', version: '1.0.0' });

  server.tool('get_balances', 'Get Revolut X account balances', {}, async () => {
    const data = await revolutRequest('GET', '/balances');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('get_prices', 'Get current crypto prices',
    { symbol: z.string().describe('Trading pair e.g. BTC-USD') },
    async ({ symbol }) => {
      const data = await revolutRequest('GET', '/market/tickers');
      const ticker = Array.isArray(data) ? data.find(t => t.symbol === symbol) : data;
      return { content: [{ type: 'text', text: JSON.stringify(ticker || data, null, 2) }] };
    }
  );

  server.tool('get_orders', 'Get your open orders', {}, async () => {
    const data = await revolutRequest('GET', '/orders/active');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  return server;
}

app.post('/mcp', async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
  await server.close();
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});