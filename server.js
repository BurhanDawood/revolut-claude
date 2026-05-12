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
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const ALERT_INTERVAL_MS = 60 * 1000; // 1 minute
const PUMP_THRESHOLD = 0.20; // 20%

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
  console.log('Telegram sent:', message);
}

// Track baseline prices and active alerts
const basePrices = {};
const activeAlerts = {};
const lastBalances = {};

async function checkPortfolio() {
  try {
    console.log('Checking portfolio...');
    const balances = await revolutRequest('GET', '/balances');

    for (const asset of balances) {
      if (!asset.currency || parseFloat(asset.available) <= 0) continue;
      if (asset.currency === 'USD' || asset.currency === 'USDT' || asset.currency === 'USDC') continue;

      const symbol = `${asset.currency}-USD`;
      const available = parseFloat(asset.available);

      // Check if position was sold (balance went down significantly)
      if (activeAlerts[symbol] && lastBalances[symbol] && available < lastBalances[symbol] * 0.9) {
        console.log(`Position reduced for ${symbol}, stopping alerts`);
        clearInterval(activeAlerts[symbol]);
        delete activeAlerts[symbol];
        delete basePrices[symbol];
        await sendTelegram(`✅ Alert stopped for ${symbol} — position change detected.`);
      }

      lastBalances[symbol] = available;

      // Get current price
      try {
        const ticker = await revolutRequest('GET', `/market/tickers/${symbol}`);
        const currentPrice = parseFloat(ticker.last_price || ticker.ask || ticker.bid);
        if (!currentPrice) continue;

        // Set baseline if not set
        if (!basePrices[symbol]) {
          basePrices[symbol] = currentPrice;
          console.log(`Baseline set for ${symbol}: $${currentPrice}`);
          continue;
        }

        const change = (currentPrice - basePrices[symbol]) / basePrices[symbol];
        console.log(`${symbol}: $${currentPrice} (${(change * 100).toFixed(1)}% from baseline)`);

        // Trigger alert if pumping and not already alerting
        if (change >= PUMP_THRESHOLD && !activeAlerts[symbol]) {
          const pct = (change * 100).toFixed(1);
          const alertMessage = `🚀 <b>${symbol} is pumping!</b>\n\nUp <b>${pct}%</b> from $${basePrices[symbol].toFixed(2)} → $${currentPrice.toFixed(2)}\n\nYou hold: ${available} ${asset.currency}\nLog into Revolut X to act!`;

          await sendTelegram(alertMessage);

          // Keep alerting every minute until position changes
          activeAlerts[symbol] = setInterval(async () => {
            await sendTelegram(`⚠️ <b>REMINDER: ${symbol} still up ${pct}%!</b>\n\nCurrent price: $${currentPrice.toFixed(2)}\nYou hold: ${available} ${asset.currency}`);
          }, ALERT_INTERVAL_MS);
        }
      } catch (e) {
        console.log(`Could not get price for ${symbol}:`, e.message);
      }
    }
  } catch (e) {
    console.log('Portfolio check error:', e.message);
  }
}

// Start monitoring loop
setTimeout(async () => {
  await sendTelegram('🤖 Revolut X monitor started! Checking your portfolio every 5 minutes.');
  await checkPortfolio();
  setInterval(checkPortfolio, CHECK_INTERVAL_MS);
}, 5000);

const app = express();
app.use(express.json());

function createMcpServer() {
  const server = new McpServer({ name: 'revolut-x', version: '1.0.0' });

  server.tool('get_balances', 'Get Revolut X account balances', {}, async () => {
    const data = await revolutRequest('GET', '/balances');
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('get_prices', 'Get current crypto prices',
    { symbol: z.string().describe('Trading pair e.g. BTC-USD') },
    async ({ symbol }) => {
      const data = await revolutRequest('GET', `/market/tickers/${symbol}`);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
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