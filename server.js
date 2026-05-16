import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createPrivateKey, sign } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import mysql from 'mysql2/promise';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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
const conversationHistory = new Map(); // chatId -> [{role, content}]

const db = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

await db.execute(`CREATE TABLE IF NOT EXISTS baselines (
  symbol VARCHAR(50) PRIMARY KEY,
  price DECIMAL(20,10) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS conversation_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  role VARCHAR(10) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_chat_id (chat_id)
)`);

const [rows] = await db.execute('SELECT symbol, price FROM baselines');
for (const row of rows) {
  basePrices[row.symbol] = parseFloat(row.price);
}
console.log(`Loaded ${rows.length} baselines from database`);

const [histRows] = await db.execute(
  'SELECT chat_id, role, content FROM (SELECT chat_id, role, content, ROW_NUMBER() OVER (PARTITION BY chat_id ORDER BY created_at DESC) as rn FROM conversation_history) ranked WHERE rn <= 20 ORDER BY rn DESC'
);
for (const row of histRows) {
  const id = row.chat_id.toString();
  if (!conversationHistory.has(id)) conversationHistory.set(id, []);
  conversationHistory.get(id).unshift({ role: row.role, content: row.content });
}
console.log(`Loaded conversation history for ${conversationHistory.size} chat(s)`);

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
        await db.execute(
          'INSERT INTO baselines (symbol, price) VALUES (?, ?) ON DUPLICATE KEY UPDATE price = VALUES(price)',
          [symbol, currentPrice]
        );
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
app.use(cors());
app.use(express.json());
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
app.use(express.static(join(__dirname, 'public')));

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


app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'dashboard.html'));
});

// POST /telegram-webhook — handle incoming Telegram messages
app.post('/telegram-webhook', async (req, res) => {
  try {
    const message = req.body.message;
    if (!message || !message.text) {
      return res.status(200).json({ ok: true });
    }

    const chatId = message.chat.id;
    const rawText = message.text.trim();
    // Normalise: strip leading slash, lowercase
    const commandText = rawText.startsWith('/') ? rawText.slice(1).toLowerCase() : rawText.toLowerCase();

    const sendReply = async (text) => {
      const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
      });
    };

    // --- Command: acknowledge / ack ---
    if (commandText === 'acknowledge' || commandText === 'ack') {
      const symbol = Object.keys(activeAlerts)[0];
      if (symbol) {
        clearInterval(activeAlerts[symbol]);
        delete activeAlerts[symbol];
        await sendReply(`✅ Acknowledged ${symbol}`);
      } else {
        await sendReply('✅ No active alerts to acknowledge.');
      }
      return res.status(200).json({ ok: true });
    }

    // --- Command: pause ---
    if (commandText === 'pause') {
      monitoringPaused = true;
      await sendReply('⏸ Monitoring paused');
      return res.status(200).json({ ok: true });
    }

    // --- Command: resume ---
    if (commandText === 'resume') {
      monitoringPaused = false;
      await sendReply('▶️ Monitoring resumed');
      return res.status(200).json({ ok: true });
    }

    // --- Command: status ---
    if (commandText === 'status') {
      const alertedSymbols = Object.keys(activeAlerts);
      const statusMsg =
        `<b>Monitor Status</b>\n` +
        `Paused: ${monitoringPaused ? 'Yes' : 'No'}\n` +
        `Active alerts: ${alertedSymbols.length}\n` +
        (alertedSymbols.length ? `Alerted symbols: ${alertedSymbols.join(', ')}` : 'No active alerts');
      await sendReply(statusMsg);
      return res.status(200).json({ ok: true });
    }

    // --- Extended alert intent patterns — handle BEFORE Claude ---
    const alertPatterns = [
      // "alert me when CC increases 1%", "notify me when CC pumps 5%", "alert me when CC hits 1%"
      /(?:alert\s+me\s+when|notify\s+me\s+when|alert\s+when)\s+([A-Za-z]+)\s+(?:increases?|pumps?|hits?|goes?\s+up|moves?\s+up|rises?|reaches?)\s+([\d.]+)\s*%/i,
      // "set alert CC 1%", "set threshold CC 1%", "alert CC 1%"
      /(?:set\s+alert|set\s+threshold|alert)\s+([A-Za-z]+)\s+([\d.]+)\s*%/i,
      // "CC alert at 1%"
      /([A-Za-z]+)\s+alert\s+(?:at\s+)?([\d.]+)\s*%/i,
    ];

    let alertHandled = false;
    for (const pattern of alertPatterns) {
      const m = rawText.match(pattern);
      if (m) {
        const coinBase = m[1].toUpperCase();
        const symbol = coinBase.endsWith('-USD') ? coinBase : `${coinBase}-USD`;
        const threshold = parseFloat(m[2]) / 100;
        const oldThreshold = customThresholds[symbol] ?? PUMP_THRESHOLD;
        customThresholds[symbol] = threshold;
        const oldPct = (oldThreshold * 100).toFixed(1);
        const newPct = (threshold * 100).toFixed(1);
        await sendReply(`✅ Alert set for ${symbol} at ${newPct}% - saved to your server. Previous threshold was ${oldPct}%, now changed to ${newPct}%.`);
        alertHandled = true;
        break;
      }
    }
    if (alertHandled) return res.status(200).json({ ok: true });

    // --- Free-form message → Claude AI (async, fire-and-forget) ---

    // Capture user message for use inside the async closure
    const userMessage = rawText;

    // 1. Immediately send acknowledgment to Telegram
    await sendReply('🔍 Researching... give me a moment.');

    // 2. Immediately return 200 to Telegram so it doesn't timeout
    res.status(200).json({ ok: true });

    // 3. Continue processing the Claude API call asynchronously AFTER responding
    // Non-blocking — runs after response is sent
    (async () => {
      try {
        // Fetch fresh balances and prices directly via internal functions
        const balances = await revolutRequest('GET', '/balances');
        const tickerResponse = await revolutRequest('GET', '/tickers');
        const tickerList = Array.isArray(tickerResponse) ? tickerResponse : (tickerResponse.data || []);

        // Build price map
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

        // Compute holdings with USD values
        const holdings = [];
        for (const asset of balances) {
          const available = parseFloat(asset.available);
          if (!asset.currency || available <= 0) continue;
          const symbol = `${asset.currency}-USD`;
          const isStable = SKIP_CURRENCIES.includes(asset.currency);
          const price = isStable ? 1 : (priceMap[symbol] || null);
          if (!price) continue;
          const valueUSD = available * price;
          holdings.push({ symbol, available, price, valueUSD });
        }

        // Sort by USD value descending
        holdings.sort((a, b) => b.valueUSD - a.valueUSD);

        // Format as numbered list
        const holdingsList = holdings.length
          ? holdings.map((h, i) =>
              `${i + 1}. ${h.symbol}: ${h.available} tokens @ $${h.price.toFixed(2)} = $${h.valueUSD.toFixed(2)} USD`
            ).join('\n')
          : 'No holdings data available';

        const systemPrompt =
          `You are an AI crypto trading assistant. Use ONLY the holdings data provided below. Do not recalculate or estimate prices. The values shown are live and accurate.\n\n` +
          `Here are the user's current holdings sorted by USD value (already calculated):\n${holdingsList}\n\n` +
          `Current baseline prices (set when monitoring started): ${JSON.stringify(basePrices)}\n` +
          `Active alerts (coins currently above threshold): ${Object.keys(activeAlerts).join(', ') || 'none'}\n\n` +
          `Answer the user's questions about their portfolio, crypto market conditions, and trading decisions. Be concise since this is a Telegram message.`;

        const chatIdStr = chatId.toString();
        const history = conversationHistory.get(chatIdStr) || [];

        // Build messages array: history + current user message
        const messages = [
          ...history,
          { role: 'user', content: userMessage }
        ];

        const claudePromise = anthropic.messages.create({
          model: 'claude-opus-4-5',
          max_tokens: 2000,
          system: systemPrompt,
          messages,
          tools: [{
            type: "web_search_20250305",
            name: "web_search"
          }]
        });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 55000)
        );
        const response = await Promise.race([claudePromise, timeoutPromise]);

        // Extract the last text block (web_search may produce tool_use blocks before the final text)
        const lastTextBlock = [...response.content].reverse().find(b => b.type === 'text');
        const reply = lastTextBlock ? lastTextBlock.text : '(no response)';

        // Update in-memory history
        const updatedHistory = [
          ...history,
          { role: 'user', content: userMessage },
          { role: 'assistant', content: reply }
        ];
        // Keep last 10 exchanges (20 messages)
        const trimmed = updatedHistory.slice(-20);
        conversationHistory.set(chatIdStr, trimmed);

        // Persist to DB
        await db.execute('INSERT INTO conversation_history (chat_id, role, content) VALUES (?, ?, ?)', [chatId, 'user', userMessage]);
        await db.execute('INSERT INTO conversation_history (chat_id, role, content) VALUES (?, ?, ?)', [chatId, 'assistant', reply]);

        // Clean up old rows (keep last 20 per chat)
        await db.execute('DELETE FROM conversation_history WHERE chat_id = ? AND id NOT IN (SELECT id FROM (SELECT id FROM conversation_history WHERE chat_id = ? ORDER BY created_at DESC LIMIT 20) t)', [chatId, chatId]);

        // Check if Claude's response implies it set a threshold — actually execute it
        const claudeAlertPatterns = [
          /(?:alert(?:ing)?\s+you|set\s+(?:up\s+)?(?:an?\s+)?alert|creat(?:ed?)?\s+(?:an?\s+)?alert|threshold\s+set|notify\s+you|notification\s+set)\s+.*?([A-Za-z]{2,10}(?:-USD)?)\s+.*?([\d.]+)\s*%/i,
          /([A-Za-z]{2,10}(?:-USD)?)\s+.*?(?:alert|threshold|notification)\s+.*?([\d.]+)\s*%/i,
          /threshold.*?([A-Za-z]{2,10}(?:-USD)?)\s+.*?([\d.]+)\s*%/i,
        ];

        let actionTaken = null;
        for (const pattern of claudeAlertPatterns) {
          const m = reply.match(pattern);
          if (m) {
            const coinBase = m[1].toUpperCase();
            // Skip common false positives
            if (['THE', 'FOR', 'AND', 'YOU', 'SET', 'GET', 'HAS', 'ARE'].includes(coinBase)) continue;
            const symbol = coinBase.endsWith('-USD') ? coinBase : `${coinBase}-USD`;
            const threshold = parseFloat(m[2]) / 100;
            if (threshold > 0 && threshold <= 1) { // sanity check: 0–100%
              const oldThreshold = customThresholds[symbol] ?? PUMP_THRESHOLD;
              customThresholds[symbol] = threshold;
              const newPct = (threshold * 100).toFixed(1);
              const oldPct = (oldThreshold * 100).toFixed(1);
              actionTaken = `\n\n✅ Actually saved to server - ${symbol} threshold changed to ${newPct}% (was ${oldPct}%)`;
            }
            break;
          }
        }

        // Send reply (with action confirmation appended if applicable)
        await sendReply(reply + (actionTaken || ''));
      } catch (err) {
        console.error('Claude AI error:', err.message);
        if (err.message === 'timeout') {
          await sendReply('⏱️ That analysis is taking too long. Try asking something more specific or break it into smaller questions.');
        } else {
          await sendReply('❌ Error getting AI response: ' + err.message);
        }
      }
    })();

  } catch (err) {
    console.error('Telegram webhook error:', err.message);
    if (!res.headersSent) {
      res.status(200).json({ ok: true });
    }
  }
});

// GET /telegram-setup — register the webhook URL with Telegram
app.get('/telegram-setup', async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const webhookUrl = 'https://revolut-claude-production.up.railway.app/telegram-webhook';
  const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${webhookUrl}`);
  const data = await response.json();
  res.json(data);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});