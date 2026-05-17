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
import cron from 'node-cron';

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
const SKIP_WORDS = new Set(['SET', 'AND', 'THE', 'FOR', 'ALL', 'GET', 'PUT', 'LET', 'CAN', 'ARE', 'NOT', 'BUT', 'USE', 'NEW', 'OLD', 'ANY', 'TWO', 'ONE', 'HIT', 'TOP', 'LOW', 'MAX', 'MIN', 'NOW', 'BUY', 'FROM']);

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

async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
}

async function sendTelegramChunked(chatId, text) {
  const maxLen = 3800;
  const chunks = [];
  let remaining = text.trim();

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt === -1) splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt === -1) splitAt = maxLen;
    chunks.push(remaining.substring(0, splitAt).trim());
    remaining = remaining.substring(splitAt).trim();
  }

  console.log('Sending', chunks.length, 'chunk(s), total length:', text.length);

  for (let i = 0; i < chunks.length; i++) {
    const prefix = i > 0 ? '📄 **(continued...)**\n\n' : '';
    await sendTelegramMessage(chatId, prefix + chunks[i]);
    console.log('Sent chunk', i + 1, 'of', chunks.length);
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

const basePrices = {};
const activeAlerts = {};
const activeFixedAlerts = {}; // symbol -> intervalId for fixed price target alerts (up direction)
const activeDropAlerts = {}; // symbol -> intervalId for fixed floor alerts (down direction)
const lastBalances = {};
const customThresholds = {};
const priceTargets = new Map(); // symbol -> { anchorPrice, thresholdPct, targetPrice, entryPrice }
const entryPrices = new Map(); // symbol -> number (DB-backed, persists across restarts)
let monitoringPaused = false;
let monitoringInterval = null;
const conversationHistory = new Map(); // chatId -> [{role, content}]

async function setThreshold(symbol, threshold) {
  const oldThreshold = customThresholds[symbol] ?? PUMP_THRESHOLD;
  customThresholds[symbol] = threshold;

  // Persist threshold to database so it survives server restarts
  // Note: no delete path exists currently; if one is added later, also run:
  // await db.execute('DELETE FROM custom_thresholds WHERE symbol = ?', [symbol]);
  await db.execute(
    'INSERT INTO custom_thresholds (symbol, threshold) VALUES (?, ?) ON DUPLICATE KEY UPDATE threshold = VALUES(threshold)',
    [symbol, threshold]
  );

  // Cancel any active alert interval for this coin
  if (activeAlerts[symbol]) {
    clearInterval(activeAlerts[symbol]);
    delete activeAlerts[symbol];
  }

  // Reset baseline to current price so monitoring restarts fresh
  try {
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
    const currentPrice = priceMap[symbol];
    if (currentPrice) {
      basePrices[symbol] = currentPrice;
      try {
        await db.execute(
          'INSERT INTO baselines (symbol, price) VALUES (?, ?) ON DUPLICATE KEY UPDATE price = VALUES(price)',
          [symbol, currentPrice]
        );
      } catch (err) { /* ignore */ }
    } else {
      delete basePrices[symbol];
    }
  } catch (err) {
    // If price fetch fails, delete baseline so checkPortfolio will re-set it on next run
    delete basePrices[symbol];
  }

  return { oldThreshold, newThreshold: threshold };
}

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

await db.execute(`CREATE TABLE IF NOT EXISTS custom_thresholds (
  symbol VARCHAR(50) PRIMARY KEY,
  threshold DECIMAL(10,6) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS price_targets (
  symbol VARCHAR(50) PRIMARY KEY,
  anchor_price DECIMAL(20,10) NOT NULL,
  threshold_pct DECIMAL(10,4) NOT NULL,
  target_price DECIMAL(20,10) NOT NULL,
  entry_price DECIMAL(20,10),
  set_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS entry_prices (
  symbol VARCHAR(50) PRIMARY KEY,
  entry_price DECIMAL(20,10) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS price_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  symbol VARCHAR(50) NOT NULL,
  price DECIMAL(20,10) NOT NULL,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_symbol_recorded (symbol, recorded_at)
)`);

// Add direction column to price_targets if it doesn't exist
try {
  await db.execute(`ALTER TABLE price_targets ADD COLUMN direction VARCHAR(4) NOT NULL DEFAULT 'up'`);
  console.log('Added direction column to price_targets');
} catch (e) {
  // Column already exists — ignore
}

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

const [thresholdRows] = await db.execute('SELECT symbol, threshold FROM custom_thresholds');
for (const row of thresholdRows) {
  customThresholds[row.symbol] = parseFloat(row.threshold);
}
console.log(`Loaded ${thresholdRows.length} custom thresholds from database`);

const [ptRows] = await db.execute('SELECT symbol, anchor_price, threshold_pct, target_price, entry_price, direction FROM price_targets');
for (const row of ptRows) {
  priceTargets.set(row.symbol, {
    anchorPrice: parseFloat(row.anchor_price),
    thresholdPct: parseFloat(row.threshold_pct),
    targetPrice: parseFloat(row.target_price),
    entryPrice: row.entry_price ? parseFloat(row.entry_price) : null,
    direction: row.direction || 'up'
  });
}
console.log(`Loaded ${ptRows.length} price targets from database`);

const [epRows] = await db.execute('SELECT symbol, entry_price FROM entry_prices');
for (const row of epRows) {
  entryPrices.set(row.symbol, parseFloat(row.entry_price));
}
console.log(`Loaded ${epRows.length} entry prices from database`);

async function getQuickAiRecommendation(symbol, changePct, currentPrice, direction = 'up') {
  try {
    const dirText = direction === 'down'
      ? `down ${Math.abs(changePct).toFixed(1)}% to $${currentPrice.toFixed(4)}`
      : `up ${changePct.toFixed(1)}% to $${currentPrice.toFixed(4)}`;
    const actionOptions = direction === 'down'
      ? 'HOLD, BUY THE DIP, or SELL'
      : 'HOLD, SELL, or BUY MORE';
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `In 2-3 sentences max, give a quick trading recommendation for ${symbol} which is ${dirText}. Consider current market conditions. Start with ${actionOptions} in bold.`
      }]
    });
    const textBlock = response.content.find(b => b.type === 'text');
    return textBlock ? textBlock.text : 'HOLD - Monitor the situation closely.';
  } catch (e) {
    console.error('Quick AI recommendation error:', e.message);
    return 'HOLD - Monitor the situation closely.';
  }
}

async function setFixedTarget(symbol, thresholdPct, direction = 'up') {
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
  const anchorPrice = priceMap[symbol];
  if (!anchorPrice) throw new Error(`No price available for ${symbol}`);
  // For 'up': target is above anchor. For 'down': floor is below anchor.
  const targetPrice = direction === 'down'
    ? anchorPrice * (1 - thresholdPct / 100)
    : anchorPrice * (1 + thresholdPct / 100);
  await db.execute(
    'INSERT INTO price_targets (symbol, anchor_price, threshold_pct, target_price, direction) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE anchor_price = VALUES(anchor_price), threshold_pct = VALUES(threshold_pct), target_price = VALUES(target_price), direction = VALUES(direction), updated_at = CURRENT_TIMESTAMP',
    [symbol, anchorPrice, thresholdPct, targetPrice, direction]
  );
  const existing = priceTargets.get(symbol) || {};
  priceTargets.set(symbol, { ...existing, anchorPrice, thresholdPct, targetPrice, direction });
  return { anchorPrice, thresholdPct, targetPrice, direction };
}

async function getCurrentPrice(symbol) {
  try {
    const tickerResponse = await revolutRequest('GET', '/tickers');
    const tickerList = Array.isArray(tickerResponse) ? tickerResponse : (tickerResponse.data || []);
    for (const ticker of tickerList) {
      if (!ticker.symbol) continue;
      const price = parseFloat(ticker.last_price || ticker.mid || ticker.ask || ticker.bid);
      if (price && (ticker.symbol === symbol || ticker.symbol.replace('/', '-') === symbol)) return price;
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function recordDailyPrices() {
  try {
    console.log('Recording daily prices for price_history...');
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
    for (const asset of balances) {
      if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
      const available = parseFloat(asset.available);
      if (available <= 0) continue;
      const symbol = `${asset.currency}-USD`;
      const price = priceMap[symbol];
      if (!price) continue;
      await db.execute('INSERT INTO price_history (symbol, price) VALUES (?, ?)', [symbol, price]);
    }
    console.log('Daily prices recorded.');
  } catch (e) {
    console.error('recordDailyPrices error:', e.message);
  }
}

async function sendMorningBriefing() {
  try {
    console.log('Sending morning briefing...');
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

    // Build holdings with overnight change
    const holdings = [];
    let totalUSD = 0;
    for (const asset of balances) {
      if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
      const available = parseFloat(asset.available);
      if (available <= 0) continue;
      const symbol = `${asset.currency}-USD`;
      const price = priceMap[symbol];
      if (!price) continue;
      const valueUSD = available * price;
      totalUSD += valueUSD;

      // Find yesterday's midnight price
      let overnightChange = null;
      try {
        const [histRows] = await db.execute(
          'SELECT price FROM price_history WHERE symbol = ? ORDER BY recorded_at DESC LIMIT 1',
          [symbol]
        );
        if (histRows.length > 0) {
          const prevPrice = parseFloat(histRows[0].price);
          overnightChange = ((price - prevPrice) / prevPrice) * 100;
        }
      } catch (e) { /* ignore */ }

      const entryPrice = entryPrices.get(symbol);
      const plPct = entryPrice ? ((price - entryPrice) / entryPrice) * 100 : null;

      holdings.push({ symbol, available, price, valueUSD, overnightChange, plPct });
    }
    holdings.sort((a, b) => b.valueUSD - a.valueUSD);

    // Format portfolio summary for Claude
    const portfolioSummary = holdings.map(h => {
      const overnightStr = h.overnightChange !== null
        ? ` (overnight: ${h.overnightChange >= 0 ? '+' : ''}${h.overnightChange.toFixed(1)}%)`
        : '';
      const plStr = h.plPct !== null
        ? ` | P&L from entry: ${h.plPct >= 0 ? '+' : ''}${h.plPct.toFixed(1)}%`
        : '';
      return `${h.symbol}: ${h.available} tokens @ $${h.price.toFixed(4)} = $${h.valueUSD.toFixed(2)}${overnightStr}${plStr}`;
    }).join('\n');

    // Get AI market briefing
    const dateStr = new Date().toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/London' });
    const claudeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role: 'user',
        content: `Good morning! Give me a concise daily crypto briefing for my portfolio. Search for current market conditions, Bitcoin price, and any major news. My portfolio:\n\n${portfolioSummary}\n\nTotal: $${totalUSD.toFixed(2)}\n\nProvide: 1) Market overview (BTC/ETH sentiment, 2-3 sentences), 2) Top movers in my portfolio, 3) Key news or risks to watch today, 4) One sentence action recommendation. Keep it under 800 words.`
      }]
    });

    const lastTextBlock = [...claudeResponse.content].reverse().find(b => b.type === 'text');
    const aiInsights = lastTextBlock ? lastTextBlock.text : 'Market data unavailable.';

    // Build header
    const header = `🌅 <b>GOOD MORNING BRYAN — DAILY PORTFOLIO BRIEFING</b>\n📅 ${dateStr} | ⏰ 9:00 AM\n\n💼 <b>Portfolio: $${totalUSD.toFixed(2)}</b>\n\n`;

    // Build holdings table
    const holdingsTable = holdings.map(h => {
      const arrow = h.overnightChange === null ? '➡️' : h.overnightChange >= 0 ? '📈' : '📉';
      const overnightStr = h.overnightChange !== null
        ? ` ${h.overnightChange >= 0 ? '+' : ''}${h.overnightChange.toFixed(1)}%`
        : '';
      return `${arrow} <b>${h.symbol}</b>: $${h.price.toFixed(4)}${overnightStr} | $${h.valueUSD.toFixed(0)}`;
    }).join('\n');

    const fullMessage = `${header}${holdingsTable}\n\n${aiInsights}`;
    await sendTelegramChunked(TELEGRAM_CHAT_ID, fullMessage);
    console.log('Morning briefing sent.');
  } catch (e) {
    console.error('sendMorningBriefing error:', e.message);
    await sendTelegram(`❌ Morning briefing failed: ${e.message}`);
  }
}

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

      // Trigger baseline alert if pumping
      const threshold = customThresholds[symbol] !== undefined ? customThresholds[symbol] : PUMP_THRESHOLD;
      if (change >= threshold && !activeAlerts[symbol]) {
        const pct = (change * 100).toFixed(1);
        const coinBase = asset.currency;
        const aiRec = await getQuickAiRecommendation(symbol, change * 100, currentPrice, 'up');
        const replyMenu = `\n\nReply:\n'sell ${coinBase}' - get sell advice\n'buy more ${coinBase}' - get buy advice\n'analyse ${coinBase}' - full analysis\n'acknowledge ${coinBase}' - stop alerts`;
        const alertMessage = `📈 <b>${symbol} DAILY PUMP ALERT</b>\n\nBaseline: $${basePrices[symbol].toFixed(4)} → Now $${currentPrice.toFixed(4)} (+${pct}%)\nYou hold: ${available} ${coinBase}\n\n⚡ RECOMMENDATION: ${aiRec}${replyMenu}`;
        await sendTelegram(alertMessage);

        activeAlerts[symbol] = setInterval(async () => {
          await sendTelegram(`⚠️ <b>REMINDER: ${symbol} DAILY PUMP ALERT still active!</b>\n\nStill up ${pct}% from baseline\nReply 'acknowledge ${coinBase}' to stop`);
        }, ALERT_INTERVAL_MS);
      }

      // Trigger baseline drop alert
      if (change <= -threshold && !activeDropAlerts[symbol]) {
        const pct = (Math.abs(change) * 100).toFixed(1);
        const coinBase = asset.currency;
        const aiRec = await getQuickAiRecommendation(symbol, change * 100, currentPrice, 'down');
        const replyMenu = `\n\nReply:\n'buy more ${coinBase}' - get buy the dip advice\n'sell ${coinBase}' - get sell advice\n'analyse ${coinBase}' - full analysis\n'acknowledge ${coinBase}' - stop alerts`;
        const alertMessage = `📉 <b>${symbol} DROP ALERT!</b>\n\nBaseline: $${basePrices[symbol].toFixed(4)} → Now $${currentPrice.toFixed(4)} (-${pct}%)\nYou hold: ${available} ${coinBase}\n\n⚡ RECOMMENDATION: ${aiRec}${replyMenu}`;
        await sendTelegram(alertMessage);

        activeDropAlerts[symbol] = setInterval(async () => {
          await sendTelegram(`⚠️ <b>REMINDER: ${symbol} DROP ALERT still active!</b>\n\nStill down ${pct}% from baseline\nReply 'acknowledge ${coinBase}' to stop`);
        }, ALERT_INTERVAL_MS);
      }
    }

    // Check fixed price targets (direction-aware)
    for (const [symbol, target] of priceTargets) {
      const currentPrice = priceMap[symbol];
      if (!currentPrice) continue;

      const direction = target.direction || 'up';

      if (direction === 'up' && currentPrice >= target.targetPrice && !activeFixedAlerts[symbol]) {
        const changePct = ((currentPrice - target.anchorPrice) / target.anchorPrice) * 100;
        const coinBase = symbol.replace('-USD', '');
        const aiRec = await getQuickAiRecommendation(symbol, changePct, currentPrice, 'up');
        const entryPrice = entryPrices.get(symbol) || target.entryPrice;
        const entryLine = entryPrice
          ? `\nEntry: $${entryPrice.toFixed(4)} | P&L: +${((currentPrice - entryPrice) / entryPrice * 100).toFixed(1)}%`
          : '';
        const replyMenu = `\n\nReply:\n'sell ${coinBase}' - get sell advice\n'buy more ${coinBase}' - get buy advice\n'analyse ${coinBase}' - full analysis\n'acknowledge ${coinBase}' - stop alerts\n'threshold ${coinBase} 15%' - change threshold\n'entry ${coinBase} 0.147' - correct my entry`;
        const alertMessage = `🎯 <b>${symbol} FIXED TARGET HIT!</b>\n\nAnchor: $${target.anchorPrice.toFixed(4)} → Now $${currentPrice.toFixed(4)} (+${changePct.toFixed(1)}%)${entryLine}\n\n⚡ RECOMMENDATION: ${aiRec}${replyMenu}`;
        await sendTelegram(alertMessage);

        activeFixedAlerts[symbol] = setInterval(async () => {
          await sendTelegram(`⚠️ <b>REMINDER: ${symbol} FIXED TARGET STILL ACTIVE!</b>\n\nTarget: $${target.targetPrice.toFixed(4)} | Now: $${currentPrice.toFixed(4)}\nReply 'acknowledge ${coinBase}' to stop`);
        }, ALERT_INTERVAL_MS);
      }

      if (direction === 'down' && currentPrice <= target.targetPrice && !activeFixedAlerts[symbol]) {
        const changePct = ((currentPrice - target.anchorPrice) / target.anchorPrice) * 100;
        const coinBase = symbol.replace('-USD', '');
        const aiRec = await getQuickAiRecommendation(symbol, changePct, currentPrice, 'down');
        const entryPrice = entryPrices.get(symbol) || target.entryPrice;
        const plPct = entryPrice ? ((currentPrice - entryPrice) / entryPrice * 100).toFixed(1) : null;
        const entryLine = plPct !== null
          ? `\nEntry: $${entryPrice.toFixed(4)} | P&L: ${plPct}%`
          : '';
        const replyMenu = `\n\nReply:\n'buy more ${coinBase}' - get buy the dip advice\n'sell ${coinBase}' - get sell advice\n'analyse ${coinBase}' - full analysis\n'acknowledge ${coinBase}' - stop alerts`;
        const alertMessage = `📉 <b>${symbol} FIXED FLOOR HIT!</b>\n\nAnchor: $${target.anchorPrice.toFixed(4)} → Now $${currentPrice.toFixed(4)} (${changePct.toFixed(1)}%)${entryLine}\n\n⚡ RECOMMENDATION: ${aiRec}${replyMenu}`;
        await sendTelegram(alertMessage);

        activeFixedAlerts[symbol] = setInterval(async () => {
          await sendTelegram(`⚠️ <b>REMINDER: ${symbol} FIXED FLOOR STILL ACTIVE!</b>\n\nFloor: $${target.targetPrice.toFixed(4)} | Now: $${currentPrice.toFixed(4)}\nReply 'acknowledge ${coinBase}' to stop`);
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

// Record prices at midnight every day (UK time)
cron.schedule('0 0 * * *', recordDailyPrices, { timezone: 'Europe/London' });

// Send morning briefing at 9:00 AM every day (UK time)
cron.schedule('0 9 * * *', sendMorningBriefing, { timezone: 'Europe/London' });

console.log('Cron jobs scheduled: midnight price recording + 9 AM morning briefing (Europe/London)');

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
app.post('/api/threshold/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const { threshold } = req.body;
  if (typeof threshold !== 'number' || threshold <= 0) {
    return res.status(400).json({ error: 'threshold must be a positive number (e.g. 0.15 for 15%)' });
  }
  const { oldThreshold, newThreshold } = await setThreshold(symbol, threshold);
  res.json({ ok: true, symbol, threshold: newThreshold, oldThreshold, message: 'Old alert cancelled and monitoring restarted fresh from current price.' });
});

// GET /api/targets — all fixed price targets
app.get('/api/targets', (req, res) => {
  const out = {};
  for (const [symbol, t] of priceTargets) {
    out[symbol] = { anchorPrice: t.anchorPrice, thresholdPct: t.thresholdPct, targetPrice: t.targetPrice, entryPrice: t.entryPrice || null };
  }
  res.json(out);
});

// POST /api/targets/:symbol — set or update fixed price target
app.post('/api/targets/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const { threshold_pct, anchor_price } = req.body;
  if (!threshold_pct || threshold_pct <= 0) return res.status(400).json({ error: 'threshold_pct required and must be > 0' });
  try {
    if (anchor_price) {
      // Explicit anchor provided
      const targetPrice = anchor_price * (1 + threshold_pct / 100);
      await db.execute(
        'INSERT INTO price_targets (symbol, anchor_price, threshold_pct, target_price) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE anchor_price = VALUES(anchor_price), threshold_pct = VALUES(threshold_pct), target_price = VALUES(target_price), updated_at = CURRENT_TIMESTAMP',
        [symbol, anchor_price, threshold_pct, targetPrice]
      );
      const existing = priceTargets.get(symbol) || {};
      priceTargets.set(symbol, { ...existing, anchorPrice: anchor_price, thresholdPct: threshold_pct, targetPrice });
      if (activeFixedAlerts[symbol]) { clearInterval(activeFixedAlerts[symbol]); delete activeFixedAlerts[symbol]; }
      return res.json({ ok: true, symbol, anchorPrice: anchor_price, targetPrice, thresholdPct: threshold_pct });
    } else if (priceTargets.has(symbol)) {
      // Use existing anchor, update threshold
      const existing = priceTargets.get(symbol);
      const targetPrice = existing.anchorPrice * (1 + threshold_pct / 100);
      await db.execute(
        'INSERT INTO price_targets (symbol, anchor_price, threshold_pct, target_price) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE threshold_pct = VALUES(threshold_pct), target_price = VALUES(target_price), updated_at = CURRENT_TIMESTAMP',
        [symbol, existing.anchorPrice, threshold_pct, targetPrice]
      );
      priceTargets.set(symbol, { ...existing, thresholdPct: threshold_pct, targetPrice });
      if (activeFixedAlerts[symbol]) { clearInterval(activeFixedAlerts[symbol]); delete activeFixedAlerts[symbol]; }
      return res.json({ ok: true, symbol, anchorPrice: existing.anchorPrice, targetPrice, thresholdPct: threshold_pct });
    } else {
      // No anchor — fetch current price
      const { anchorPrice, targetPrice } = await setFixedTarget(symbol, threshold_pct);
      return res.json({ ok: true, symbol, anchorPrice, targetPrice, thresholdPct: threshold_pct });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/targets/:symbol — remove fixed price target
app.delete('/api/targets/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  await db.execute('DELETE FROM price_targets WHERE symbol = ?', [symbol]);
  priceTargets.delete(symbol);
  if (activeFixedAlerts[symbol]) { clearInterval(activeFixedAlerts[symbol]); delete activeFixedAlerts[symbol]; }
  res.json({ ok: true, symbol });
});

// GET /api/entryprices — all average entry prices
app.get('/api/entryprices', (req, res) => {
  const out = {};
  for (const [sym, price] of entryPrices) out[sym] = price;
  res.json(out);
});

// POST /api/entryprices/:symbol — set average entry price
app.post('/api/entryprices/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const { entry_price } = req.body;
  if (!entry_price || entry_price <= 0) return res.status(400).json({ error: 'entry_price must be > 0' });
  entryPrices.set(symbol, entry_price);
  await db.execute(
    'INSERT INTO entry_prices (symbol, entry_price) VALUES (?, ?) ON DUPLICATE KEY UPDATE entry_price = VALUES(entry_price)',
    [symbol, entry_price]
  );
  res.json({ ok: true, symbol, entry_price });
});

// GET /api/thresholds — all custom daily thresholds
app.get('/api/thresholds', (req, res) => {
  res.json({ customThresholds, defaultThreshold: PUMP_THRESHOLD });
});

// GET /api/tradehistory — probe Revolut X API paths for position/entry price data
app.get('/api/tradehistory', async (req, res) => {
  const endpoints = [
    '/positions',
    '/portfolio',
    '/portfolio/positions',
    '/accounts/positions',
    '/balances/positions',
  ];

  const results = {};

  for (const path of endpoints) {
    try {
      console.log(`[tradehistory] Trying GET ${path}`);
      const data = await revolutRequest('GET', path);
      console.log(`[tradehistory] ${path} response:`, JSON.stringify(data).slice(0, 500));
      results[path] = { success: true, data };
    } catch (err) {
      console.log(`[tradehistory] ${path} error:`, err.message);
      results[path] = { success: false, error: err.message };
    }
  }

  res.json(results);
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

    // --- Command: acknowledge [COIN] or acknowledge/ack (generic) ---
    const ackMatch = commandText.match(/^(?:acknowledge|ack)(?:\s+([a-z0-9]{2,10}))?$/);
    if (ackMatch) {
      if (ackMatch[1]) {
        const coinBase = ackMatch[1].toUpperCase();
        const symbol = `${coinBase}-USD`;
        const stopped = [];
        if (activeAlerts[symbol]) { clearInterval(activeAlerts[symbol]); delete activeAlerts[symbol]; stopped.push('daily pump alert'); }
        if (activeDropAlerts[symbol]) { clearInterval(activeDropAlerts[symbol]); delete activeDropAlerts[symbol]; stopped.push('daily drop alert'); }
        if (activeFixedAlerts[symbol]) { clearInterval(activeFixedAlerts[symbol]); delete activeFixedAlerts[symbol]; stopped.push('fixed target alert'); }
        await sendReply(stopped.length ? `✅ ${symbol}: stopped ${stopped.join(' + ')}` : `✅ No active alerts for ${symbol}`);
      } else {
        const baseSymbol = Object.keys(activeAlerts)[0];
        const dropSymbol = Object.keys(activeDropAlerts)[0];
        const fixedSymbol = Object.keys(activeFixedAlerts)[0];
        const symbol = baseSymbol || dropSymbol || fixedSymbol;
        if (symbol) {
          if (activeAlerts[symbol]) { clearInterval(activeAlerts[symbol]); delete activeAlerts[symbol]; }
          if (activeDropAlerts[symbol]) { clearInterval(activeDropAlerts[symbol]); delete activeDropAlerts[symbol]; }
          if (activeFixedAlerts[symbol]) { clearInterval(activeFixedAlerts[symbol]); delete activeFixedAlerts[symbol]; }
          await sendReply(`✅ Acknowledged ${symbol}`);
        } else {
          await sendReply('✅ No active alerts to acknowledge.');
        }
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

    // --- Command: sell [COIN] ---
    const sellMatch = commandText.match(/^sell\s+([a-z]{2,10})$/);
    if (sellMatch) {
      const coinBase = sellMatch[1].toUpperCase();
      const symbol = `${coinBase}-USD`;
      await sendReply('🔍 Getting sell advice...');
      res.status(200).json({ ok: true });
      (async () => {
        try {
          const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-5',
            max_tokens: 600,
            tools: [{ type: "web_search_20250305", name: "web_search" }],
            messages: [{ role: 'user', content: `Give specific, actionable sell advice for ${symbol}. Search for current price and market conditions. Should I sell now or wait? Give a clear recommendation with 1-2 price levels to target. Under 300 words.` }]
          });
          const textBlock = [...response.content].reverse().find(b => b.type === 'text');
          await sendTelegramMessage(chatId, textBlock ? textBlock.text : 'Unable to generate sell advice.');
        } catch (e) {
          await sendTelegramMessage(chatId, '❌ Error: ' + e.message);
        }
      })();
      return;
    }

    // --- Command: buy more [COIN] ---
    const buyMatch = commandText.match(/^buy\s+more\s+([a-z]{2,10})$/);
    if (buyMatch) {
      const coinBase = buyMatch[1].toUpperCase();
      const symbol = `${coinBase}-USD`;
      await sendReply('🔍 Getting buy advice...');
      res.status(200).json({ ok: true });
      (async () => {
        try {
          const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-5',
            max_tokens: 600,
            tools: [{ type: "web_search_20250305", name: "web_search" }],
            messages: [{ role: 'user', content: `Give specific, actionable advice on buying more ${symbol}. Search for current price and market conditions. Is now a good DCA entry? What's the risk/reward? Under 300 words.` }]
          });
          const textBlock = [...response.content].reverse().find(b => b.type === 'text');
          await sendTelegramMessage(chatId, textBlock ? textBlock.text : 'Unable to generate buy advice.');
        } catch (e) {
          await sendTelegramMessage(chatId, '❌ Error: ' + e.message);
        }
      })();
      return;
    }

    // --- Command: entry [COIN] [PRICE] ---
    const entryMatch = commandText.match(/^entry\s+([a-z]{2,10})\s+([\d.]+)$/);
    if (entryMatch) {
      const coinBase = entryMatch[1].toUpperCase();
      const symbol = `${coinBase}-USD`;
      const price = parseFloat(entryMatch[2]);
      entryPrices.set(symbol, price);
      await db.execute(
        'INSERT INTO entry_prices (symbol, entry_price) VALUES (?, ?) ON DUPLICATE KEY UPDATE entry_price = VALUES(entry_price)',
        [symbol, price]
      );
      const currentPrice = await getCurrentPrice(symbol);
      const plStr = currentPrice
        ? ` Current price $${currentPrice.toFixed(4)} = ${((currentPrice - price) / price * 100).toFixed(1)}% from your entry.`
        : '';
      await sendReply(`✅ ${symbol} average entry updated to $${price}.${plStr}`);
      return res.status(200).json({ ok: true });
    }

    // --- Fixed target detection: "Set CC alert at X% from current price" etc ---
    const fixedTargetIntent = /\bfrom\s+current\b|\bfixed\s+(?:target|alert|floor)\b/i.test(rawText);
    if (fixedTargetIntent) {
      // Extract coin using specific patterns (most specific first)
      let ftCoinBase = null;

      // Pattern 1: "set [COIN] alert" — most reliable, coin sits between "set" and "alert"
      const setAlertMatch = rawText.match(/\bset\s+([A-Za-z]{2,10})\s+alert\b/i);
      if (setAlertMatch) ftCoinBase = setAlertMatch[1].toUpperCase();

      // Pattern 2: "when [COIN] rises/drops/falls/hits/reaches/goes up/goes down"
      if (!ftCoinBase) {
        const whenCoinMatch = rawText.match(/\bwhen\s+([A-Za-z]{2,10})\s+(?:rises?|drops?|falls?|hits?|reaches?|goes?\s+(?:up|down))\b/i);
        if (whenCoinMatch) ftCoinBase = whenCoinMatch[1].toUpperCase();
      }

      // Pattern 3: "[COIN] alert", "[COIN] fixed target", or "[COIN] fixed floor"
      if (!ftCoinBase) {
        const coinAlertMatch = rawText.match(/\b([A-Za-z]{2,10})\s+(?:alert|fixed\s+(?:target|floor))\b/i);
        if (coinAlertMatch) ftCoinBase = coinAlertMatch[1].toUpperCase();
      }

      // Determine direction: 'down' if drop/fall/floor keywords present, otherwise 'up'
      const isDropDirection = /\b(?:drops?|falls?|floor|below|down)\b/i.test(rawText);
      const ftDirection = isDropDirection ? 'down' : 'up';

      // Extract percentage (first number followed by %)
      const pctMatch = rawText.match(/([\d.]+)\s*%/);
      const thresholdPct = pctMatch ? parseFloat(pctMatch[1]) : null;

      if (ftCoinBase && !SKIP_WORDS.has(ftCoinBase) && thresholdPct && thresholdPct > 0 && thresholdPct <= 100) {
        const symbol = ftCoinBase.endsWith('-USD') ? ftCoinBase : `${ftCoinBase}-USD`;
        try {
          const { anchorPrice, targetPrice, direction } = await setFixedTarget(symbol, thresholdPct, ftDirection);
          const dirLabel = direction === 'down' ? 'floor' : 'target';
          const dirSign = direction === 'down' ? '-' : '+';
          const dirEmoji = direction === 'down' ? '📉' : '🎯';
          await sendReply(`${dirEmoji} ${symbol} fixed ${dirLabel} set!\nAnchor: $${anchorPrice.toFixed(4)} | ${dirLabel.charAt(0).toUpperCase() + dirLabel.slice(1)}: $${targetPrice.toFixed(4)} (${dirSign}${thresholdPct}%)\nI'll alert you when ${symbol} ${direction === 'down' ? 'drops to' : 'hits'} $${targetPrice.toFixed(4)} — permanently stored.`);
        } catch (e) {
          await sendReply(`❌ Could not set fixed ${ftDirection === 'down' ? 'floor' : 'target'} for ${symbol}: ${e.message}`);
        }
        return res.status(200).json({ ok: true });
      }
    }

    // --- Command: daily [COIN] [N]% → update daily baseline threshold ---
    const dailyMatch = commandText.match(/^daily\s+([a-z]{2,10})\s+([\d.]+)%?$/);
    if (dailyMatch) {
      const coinBase = dailyMatch[1].toUpperCase();
      const symbol = `${coinBase}-USD`;
      const thresholdPct = parseFloat(dailyMatch[2]);
      if (thresholdPct <= 0 || thresholdPct > 100) {
        await sendReply(`❌ Invalid percentage. Use e.g. 'daily CC 5%'`);
        return res.status(200).json({ ok: true });
      }
      await setThreshold(symbol, thresholdPct / 100);
      await sendReply(`✅ ${symbol} daily alert updated to ${thresholdPct}%. You'll be alerted when ${coinBase} pumps ${thresholdPct}% from daily baseline.`);
      return res.status(200).json({ ok: true });
    }

    // --- Command: target [COIN] [N]% → update fixed price target threshold from same anchor ---
    const targetCmdMatch = commandText.match(/^target\s+([a-z]{2,10})\s+([\d.]+)%?$/);
    if (targetCmdMatch) {
      const coinBase = targetCmdMatch[1].toUpperCase();
      const symbol = `${coinBase}-USD`;
      const thresholdPct = parseFloat(targetCmdMatch[2]);
      if (thresholdPct <= 0 || thresholdPct > 500) {
        await sendReply(`❌ Invalid percentage. Use e.g. 'target CC 5%'`);
        return res.status(200).json({ ok: true });
      }
      const existing = priceTargets.get(symbol);
      if (existing) {
        // Update threshold from same anchor
        const newTargetPrice = existing.anchorPrice * (1 + thresholdPct / 100);
        if (activeFixedAlerts[symbol]) { clearInterval(activeFixedAlerts[symbol]); delete activeFixedAlerts[symbol]; }
        await db.execute(
          'INSERT INTO price_targets (symbol, anchor_price, threshold_pct, target_price) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE threshold_pct = VALUES(threshold_pct), target_price = VALUES(target_price), updated_at = CURRENT_TIMESTAMP',
          [symbol, existing.anchorPrice, thresholdPct, newTargetPrice]
        );
        priceTargets.set(symbol, { ...existing, thresholdPct, targetPrice: newTargetPrice });
        await sendReply(`✅ ${symbol} fixed target updated to ${thresholdPct}%. New target: $${newTargetPrice.toFixed(4)} from anchor $${existing.anchorPrice.toFixed(4)}`);
      } else {
        // No existing anchor — create new fixed target from current price
        try {
          const { anchorPrice, targetPrice } = await setFixedTarget(symbol, thresholdPct);
          await sendReply(`✅ ${symbol} fixed target set to ${thresholdPct}%. Anchor: $${anchorPrice.toFixed(4)} | Target: $${targetPrice.toFixed(4)}`);
        } catch (e) {
          await sendReply(`❌ Could not set target for ${symbol}: ${e.message}`);
        }
      }
      return res.status(200).json({ ok: true });
    }

    // Simple multi-coin scanner: find ALL [COIN] [NUMBER]% pairs in the message
    // Pattern: 2-10 letter word followed by a number and %
    // e.g. "CC 5%" "HYPE 3%" "BTC 2.5%"
    const coinPctPattern = /\b([A-Za-z]{2,10})\b\s*(?:threshold\s*(?:to|at|=)?\s*|to\s+|at\s+|=\s*)?([\d.]+)\s*%/gi;
    const skipWords = SKIP_WORDS;

    const thresholdPairs = [];
    let m;
    coinPctPattern.lastIndex = 0; // reset before use
    while ((m = coinPctPattern.exec(rawText)) !== null) {
      const coinBase = m[1].toUpperCase();
      if (skipWords.has(coinBase)) continue;
      const pct = parseFloat(m[2]);
      if (pct > 0 && pct <= 100) {
        thresholdPairs.push({ symbol: coinBase.endsWith('-USD') ? coinBase : `${coinBase}-USD`, threshold: pct / 100 });
      }
    }

    // Only treat as threshold-setting if message contains threshold intent keywords
    const hasThresholdIntent = /\b(?:set|alert|threshold|notify|percent|%)\b/i.test(rawText);

    if (thresholdPairs.length > 0 && hasThresholdIntent) {
      const confirmations = [];
      for (const { symbol, threshold } of thresholdPairs) {
        console.log('EXECUTING threshold for:', symbol, (threshold * 100).toFixed(1) + '%');
        // Call the EXACT same function used for single-coin:
        const { oldThreshold } = await setThreshold(symbol, threshold);
        const newPct = (threshold * 100).toFixed(1);
        const oldPct = (oldThreshold * 100).toFixed(1);
        confirmations.push(`✅ ${symbol} set to ${newPct}% (was ${oldPct}%) - saved to server`);
      }
      await sendReply(confirmations.join('\n'));
      return res.status(200).json({ ok: true });
    }

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
      let stillResearchingTimer;
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
          model: 'claude-sonnet-4-5',
          max_tokens: 4000,
          tools: [{
            type: "web_search_20250305",
            name: "web_search"
          }],
          system: `You are an expert AI crypto trading analyst and advisor. You have access to the user's live Revolut X portfolio data provided below. When answering questions:
- Search the web for current news, prices and market conditions
- Give detailed technical and fundamental analysis
- Reference specific coins from the user's portfolio
- Give actionable insights and specific recommendations
- Format responses clearly with headers and bullet points
- Be thorough and comprehensive
- Always consider macro conditions, Bitcoin dominance, and market sentiment
- Keep responses under 4000 characters total
- End with a one line disclaimer only

${holdingsList}

Current baseline prices (set when monitoring started): ${JSON.stringify(basePrices)}
Active alerts (coins currently above threshold): ${Object.keys(activeAlerts).join(', ') || 'none'}`,
          messages,
        });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 110000)
        );

        // Send a follow-up message after 30 seconds if still processing
        stillResearchingTimer = setTimeout(async () => {
          try {
            await sendTelegramMessage(chatId, '⏳ Still researching, almost there...');
            await new Promise(r => setTimeout(r, 2000));
          } catch (e) { /* ignore */ }
        }, 30000);

        const response = await Promise.race([claudePromise, timeoutPromise]);
        clearTimeout(stillResearchingTimer);

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
              const { oldThreshold, newThreshold } = await setThreshold(symbol, threshold);
              const newPct = (newThreshold * 100).toFixed(1);
              const oldPct = (oldThreshold * 100).toFixed(1);
              actionTaken = `\n\n✅ Actually saved to server - ${symbol} threshold changed to ${newPct}% (was ${oldPct}%). Old alert cancelled and monitoring restarted fresh from current price.`;
            }
            break;
          }
        }

        // Send Claude's reply, chunked at paragraph boundaries if over 3800 chars
        await sendTelegramChunked(chatId, reply + (actionTaken || ''));
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

// GET /api/test-briefing — trigger morning briefing immediately (temporary test endpoint)
app.get('/api/test-briefing', async (req, res) => {
  res.json({ ok: true, message: 'Morning briefing triggered — check Telegram.' });
  sendMorningBriefing();
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
