import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createPrivateKey, sign, createHash } from 'crypto';
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
const COIN_NARRATIVES = {
  'SOL':  'Solana ecosystem, DeFi, NFTs',
  'HYPE': 'DeFi, perpetual trading',
  'CC':   'Canton Network, institutional blockchain, DTCC, tokenization, RWA',
  'ENA':  'Ethena, synthetic dollar, DeFi',
  'LINK': 'Chainlink, oracles, DeFi',
  'NEAR': 'NEAR Protocol, AI, blockchain',
  'BTC':  'Bitcoin, digital gold, macro',
  'ETH':  'Ethereum, smart contracts, DeFi',
};
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
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
  const data = await res.json();
  return data.result?.message_id || null;
}

async function editTelegramMessage(chatId, messageId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' })
  });
}

async function sendTelegramChunked(text) {
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

  console.log('Total chunks:', chunks.length, 'First 100 chars:', chunks[0]?.substring(0, 100));

  for (let i = 0; i < chunks.length; i++) {
    const prefix = i > 0 ? '📄 **(continued...)**\n\n' : '';
    await sendTelegram(prefix + chunks[i]);
    console.log('Sent chunk', i + 1, 'of', chunks.length);
    await new Promise(r => setTimeout(r, 3000));
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
let briefingInProgress = false;
let lastClaudeCallTime = 0;
let learningModelCache = ''; // updated by updateLearningModel()
const pendingJournalState = new Map(); // chatId -> { journalId, step: 'emotion'|'followed', hasClaudeRec, claudeRec, symbol }
const pendingTradeContext = new Map(); // symbol -> { journalId, detectedAt, timeoutHandle }
const previousBalances = new Map(); // symbol -> quantity (DB-backed)
let portfolioCheckCount = 0; // skip trade detection on first check (baseline establishment)
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

await db.execute(`CREATE TABLE IF NOT EXISTS balance_snapshots (
  symbol VARCHAR(50) PRIMARY KEY,
  quantity DECIMAL(20,10) NOT NULL,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS macro_alerts_sent (
  id INT AUTO_INCREMENT PRIMARY KEY,
  alert_hash VARCHAR(64) NOT NULL,
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_hash_sent (alert_hash, sent_at)
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS trading_journal (
  id INT AUTO_INCREMENT PRIMARY KEY,
  symbol VARCHAR(20) NOT NULL,
  action VARCHAR(10) NOT NULL,
  price DECIMAL(20,10),
  quantity DECIMAL(20,10),
  value_usd DECIMAL(20,4),
  reasoning TEXT,
  emotion VARCHAR(20),
  claude_recommendation VARCHAR(20),
  claude_reasoning TEXT,
  followed_recommendation TINYINT(1),
  outcome VARCHAR(20),
  outcome_price DECIMAL(20,10),
  outcome_pnl DECIMAL(10,4),
  outcome_notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_symbol (symbol),
  INDEX idx_action (action),
  INDEX idx_created (created_at)
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS trader_profile (
  id INT AUTO_INCREMENT PRIMARY KEY,
  preference_key VARCHAR(100) UNIQUE NOT NULL,
  preference_value TEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS analysis_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  symbol VARCHAR(20),
  analysis_type VARCHAR(50),
  price_at_analysis DECIMAL(20,10),
  recommendation VARCHAR(20),
  target_price DECIMAL(20,10),
  claude_summary TEXT,
  user_action_taken VARCHAR(20),
  action_price DECIMAL(20,10),
  outcome VARCHAR(20),
  outcome_pnl DECIMAL(10,4),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_symbol (symbol),
  INDEX idx_created (created_at)
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS recommendation_performance (
  id INT AUTO_INCREMENT PRIMARY KEY,
  recommendation_type VARCHAR(20),
  coin_type VARCHAR(30),
  market_condition VARCHAR(30),
  was_correct TINYINT(1),
  pnl_result DECIMAL(10,4),
  setup_description TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_rec_type (recommendation_type),
  INDEX idx_created (created_at)
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS rebalancing_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  analysis TEXT NOT NULL,
  symbol VARCHAR(20) NULL,
  total_value_usd DECIMAL(20,10),
  total_unrealised_loss_usd DECIMAL(20,10),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_created (created_at)
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

const [snapRows] = await db.execute('SELECT symbol, quantity FROM balance_snapshots');
for (const row of snapRows) {
  previousBalances.set(row.symbol, parseFloat(row.quantity));
}
console.log(`Loaded ${snapRows.length} balance snapshots from database`);

updateLearningModel().catch(() => {});

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
  if (briefingInProgress) {
    console.log('Briefing already in progress, skipping.');
    return;
  }
  briefingInProgress = true;
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

    // Build holdings sorted by USD value
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

      // Overnight change from price_history
      let overnightChange = null;
      try {
        const [histRows] = await db.execute(
          'SELECT price FROM price_history WHERE symbol = ? ORDER BY recorded_at DESC LIMIT 1',
          [symbol]
        );
        if (histRows.length > 0) {
          overnightChange = ((price - parseFloat(histRows[0].price)) / parseFloat(histRows[0].price)) * 100;
        }
      } catch (e) { /* ignore */ }

      const entryPrice = entryPrices.get(symbol);
      const plPct = entryPrice ? ((price - entryPrice) / entryPrice) * 100 : null;

      holdings.push({ symbol, coin: asset.currency, available, price, valueUSD, overnightChange, plPct });
    }
    holdings.sort((a, b) => b.valueUSD - a.valueUSD);

    const totalPct = totalUSD > 0 ? 100 : 0;

    // Build top holdings block (medals for top 3, numbers for rest, top 8 max)
    const medals = ['🥇', '🥈', '🥉'];
    const topHoldings = holdings.slice(0, 8).map((h, i) => {
      const rank = i < 3 ? medals[i] : `${i + 1}.`;
      const pct = ((h.valueUSD / totalUSD) * 100).toFixed(0);
      const overnightStr = h.overnightChange !== null
        ? ` (${h.overnightChange >= 0 ? '+' : ''}${h.overnightChange.toFixed(1)}% overnight)`
        : '';
      return `${rank} ${h.coin} $${h.price.toFixed(4)} — $${h.valueUSD.toFixed(0)} (${pct}%)${overnightStr}`;
    }).join('\n');

    // Check any coins approaching thresholds
    const alertsToWatch = [];
    for (const h of holdings) {
      const threshold = customThresholds[h.symbol] !== undefined ? customThresholds[h.symbol] : PUMP_THRESHOLD;
      if (basePrices[h.symbol]) {
        const change = (h.price - basePrices[h.symbol]) / basePrices[h.symbol];
        const pctOfThreshold = change / threshold;
        if (pctOfThreshold >= 0.7 && !activeAlerts[h.symbol]) {
          alertsToWatch.push(`${h.coin}: ${(change * 100).toFixed(1)}% move (alert at ${(threshold * 100).toFixed(0)}%)`);
        }
      }
      // Check fixed targets
      const target = priceTargets.get(h.symbol);
      if (target) {
        const distPct = Math.abs((h.price - target.targetPrice) / target.targetPrice) * 100;
        if (distPct <= 5) {
          const dir = target.direction === 'down' ? 'floor' : 'target';
          alertsToWatch.push(`${h.coin}: within ${distPct.toFixed(1)}% of fixed ${dir} $${target.targetPrice.toFixed(4)}`);
        }
      }
    }
    const alertsBlock = alertsToWatch.length > 0
      ? alertsToWatch.join('\n')
      : 'No coins approaching alert thresholds.';

    // Build data context for Claude — compact for token efficiency
    const portfolioContext = holdings.slice(0, 10).map(h => {
      const overnight = h.overnightChange !== null ? ` overnight:${h.overnightChange.toFixed(1)}%` : '';
      const pl = h.plPct !== null ? ` P&L:${h.plPct.toFixed(1)}%` : '';
      return `${h.coin} $${h.price.toFixed(4)} $${h.valueUSD.toFixed(0)}${overnight}${pl}`;
    }).join(', ');

    const dateStr = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });

    // Ask Claude for market conditions, news, and recommendations only
    const claudeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role: 'user',
        content: `You are writing a morning crypto briefing for Bryan. Search for current BTC price, market conditions, and top crypto news from today. His portfolio (top holdings): ${portfolioContext}. Total: $${totalUSD.toFixed(0)}.

Reply with EXACTLY this format and nothing else — no preamble, no sign-off:

🌍 MARKET CONDITIONS:
[2-3 sentences on BTC price right now, overall sentiment, key level to watch]

📰 KEY NEWS:
• [Most important crypto news item today]
• [Second important news item]
• [Third news item if relevant]

⚡ TODAY'S RECOMMENDATIONS:
1. [Specific action for his top holding by value]
2. [Specific action for second holding]
3. [BTC key watch level or macro point]

CRITICAL: Your entire response must be under 3000 characters. Be very concise. Use short bullet points. Maximum 2-3 words per bullet. No long explanations.`
      }]
    });

    const lastTextBlock = [...claudeResponse.content].reverse().find(b => b.type === 'text');
    const aiSection = lastTextBlock ? lastTextBlock.text.trim() : '🌍 Market data unavailable.';

    // Recent outcomes (last 24h) and weekly P&L
    let recentOutcomesBlock = '';
    let weeklyPnlBlock = '';
    try {
      const [recentOutcomes] = await db.execute(
        "SELECT symbol, outcome, outcome_pnl, outcome_notes FROM trading_journal WHERE outcome IS NOT NULL AND action != 'payment' AND updated_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) ORDER BY updated_at DESC LIMIT 5"
      );
      if (recentOutcomes.length > 0) {
        const outcomeLines = recentOutcomes.map(t => {
          const coin = t.symbol.replace('-USD', '');
          const pnl = t.outcome_pnl != null ? ` ${parseFloat(t.outcome_pnl) >= 0 ? '+' : ''}${parseFloat(t.outcome_pnl).toFixed(1)}%` : '';
          const emoji = t.outcome === 'profit' || t.outcome === 'partial_profit' ? '✅' : t.outcome === 'loss' || t.outcome === 'partial_loss' ? '❌' : '⚖️';
          return `${emoji} ${coin}:${pnl} (${t.outcome || 'recorded'})`;
        }).join('\n');
        recentOutcomesBlock = `\n\n📈 <b>YESTERDAY'S OUTCOMES:</b>\n${outcomeLines}`;
      }

      const [weekTrades] = await db.execute(
        "SELECT outcome_pnl FROM trading_journal WHERE outcome IS NOT NULL AND outcome_pnl IS NOT NULL AND action != 'payment' AND updated_at > DATE_SUB(NOW(), INTERVAL 7 DAY)"
      );
      if (weekTrades.length > 0) {
        const wins = weekTrades.filter(t => parseFloat(t.outcome_pnl) > 0);
        const totalPnl = weekTrades.reduce((s, t) => s + parseFloat(t.outcome_pnl), 0);
        const weekWinRate = Math.round(wins.length / weekTrades.length * 100);
        weeklyPnlBlock = `\n\n📊 <b>THIS WEEK:</b> ${weekTrades.length} trades | Win rate: ${weekWinRate}% | Avg P&L: ${totalPnl >= 0 ? '+' : ''}${(totalPnl / weekTrades.length).toFixed(1)}%`;
      }
    } catch (e) { /* ignore — don't break briefing */ }

    // Assemble final message
    const fullMessage =
      `🌅 <b>GOOD MORNING BRYAN!</b>\n` +
      `📅 ${dateStr} | Portfolio: <b>$${totalUSD.toFixed(0)}</b>\n\n` +
      `📊 <b>TOP HOLDINGS TODAY:</b>\n${topHoldings}\n\n` +
      `${aiSection}${recentOutcomesBlock}${weeklyPnlBlock}\n\n` +
      `🚨 <b>ALERTS TO WATCH:</b>\n${alertsBlock}`;

    // Send as single message (target <3500 chars)
    await sendTelegram(fullMessage);
    console.log('Morning briefing sent. Length:', fullMessage.length);
  } catch (e) {
    console.error('sendMorningBriefing error:', e.message);
    await sendTelegram(`❌ Morning briefing failed: ${e.message}`);
  } finally {
    briefingInProgress = false;
  }
}

async function updateLearningModel() {
  try {
    const [trades] = await db.execute(
      "SELECT * FROM trading_journal WHERE outcome IS NOT NULL AND outcome_pnl IS NOT NULL AND action != 'payment' ORDER BY created_at DESC LIMIT 200"
    );
    if (trades.length < 3) {
      learningModelCache = '';
      return '';
    }

    const wins = trades.filter(t => parseFloat(t.outcome_pnl) > 0).length;
    const overallWinRate = Math.round((wins / trades.length) * 100);

    // Stats by action
    const byAction = {};
    for (const t of trades) {
      const a = t.action;
      if (!byAction[a]) byAction[a] = { wins: 0, total: 0 };
      byAction[a].total++;
      if (parseFloat(t.outcome_pnl) > 0) byAction[a].wins++;
    }
    const actionLines = Object.entries(byAction).map(([action, s]) =>
      `- ${action.toUpperCase()} trades: ${Math.round(s.wins / s.total * 100)}% win rate (${s.wins}/${s.total} trades)`
    );

    // Stats by coin category
    const categories = {
      institutional: ['CC', 'LINK'],
      defi: ['HYPE', 'ENA', 'AAVE'],
      layer1: ['SOL', 'AVAX', 'NEAR', 'ADA'],
      meme: ['MOG', 'BONK', 'TURBO'],
    };
    const catLines = [];
    for (const [cat, coins] of Object.entries(categories)) {
      const catTrades = trades.filter(t => coins.some(c => t.symbol.startsWith(c)));
      if (catTrades.length === 0) continue;
      const catWins = catTrades.filter(t => parseFloat(t.outcome_pnl) > 0).length;
      catLines.push(`- ${cat.charAt(0).toUpperCase() + cat.slice(1)} coins: ${Math.round(catWins / catTrades.length * 100)}% win rate`);
    }

    // Stats by emotion
    const byEmotion = {};
    for (const t of trades) {
      if (!t.emotion) continue;
      if (!byEmotion[t.emotion]) byEmotion[t.emotion] = { wins: 0, total: 0 };
      byEmotion[t.emotion].total++;
      if (parseFloat(t.outcome_pnl) > 0) byEmotion[t.emotion].wins++;
    }
    const emotionLines = Object.entries(byEmotion).map(([emo, s]) =>
      `- Trading when ${emo}: ${Math.round(s.wins / s.total * 100)}% win rate (${s.total} trades)`
    );

    // Followed vs ignored recommendation win rates
    const followed = trades.filter(t => t.followed_recommendation === 1);
    const ignored = trades.filter(t => t.followed_recommendation === 0);
    const followedWinRate = followed.length > 0 ? Math.round(followed.filter(t => parseFloat(t.outcome_pnl) > 0).length / followed.length * 100) : null;
    const ignoredWinRate = ignored.length > 0 ? Math.round(ignored.filter(t => parseFloat(t.outcome_pnl) > 0).length / ignored.length * 100) : null;

    let summary = `LEARNING FROM PAST PERFORMANCE (${trades.length} completed trades, ${overallWinRate}% win rate):\n`;
    summary += actionLines.join('\n') + '\n';
    if (catLines.length) summary += catLines.join('\n') + '\n';
    if (emotionLines.length) summary += emotionLines.join('\n') + '\n';
    if (followedWinRate !== null) summary += `- Followed Claude's advice: ${followedWinRate}% win rate (${followed.length} trades)\n`;
    if (ignoredWinRate !== null) summary += `- Ignored Claude's advice: ${ignoredWinRate}% win rate (${ignored.length} trades)\n`;

    learningModelCache = summary.trim();
    return learningModelCache;
  } catch (e) {
    console.error('updateLearningModel error:', e.message);
    return '';
  }
}

async function getLearningContext() {
  try {
    const [recentTrades] = await db.execute(
      "SELECT * FROM trading_journal WHERE action != 'payment' ORDER BY created_at DESC LIMIT 10"
    );
    const [profileRows] = await db.execute('SELECT preference_key, preference_value FROM trader_profile');
    const [completedTrades] = await db.execute(
      "SELECT outcome_pnl FROM trading_journal WHERE outcome_pnl IS NOT NULL AND action != 'payment'"
    );

    if (recentTrades.length === 0 && profileRows.length === 0 && completedTrades.length === 0) return '';

    let context = '\n\n--- BRYAN\'S TRADING HISTORY ---\n';

    if (recentTrades.length > 0) {
      context += 'Bryan\'s recent trades:\n';
      for (const t of recentTrades) {
        const coin = t.symbol.replace('-USD', '');
        const followed = t.followed_recommendation === 1 ? 'followed' : t.followed_recommendation === 0 ? 'ignored' : 'N/A';
        const claudeNote = t.claude_recommendation ? `, Claude said ${t.claude_recommendation}, Bryan ${followed}` : '';
        const pnlStr = t.outcome_pnl != null ? ` — ${parseFloat(t.outcome_pnl) >= 0 ? '+' : ''}${parseFloat(t.outcome_pnl).toFixed(1)}% ${parseFloat(t.outcome_pnl) >= 0 ? '✅' : '❌'}` : ' — pending';
        context += `• ${t.action} ${coin} at $${parseFloat(t.price || 0).toFixed(4)}${claudeNote}${pnlStr}\n`;
      }
    }

    if (profileRows.length > 0) {
      context += 'Bryan\'s trading style:\n';
      for (const p of profileRows) {
        context += `• ${p.preference_value}\n`;
      }
    }

    if (learningModelCache) {
      context += `What works for Bryan:\n${learningModelCache}\n`;
    }

    if (completedTrades.length > 0) {
      const profits = completedTrades.filter(t => parseFloat(t.outcome_pnl) > 0);
      const losses = completedTrades.filter(t => parseFloat(t.outcome_pnl) <= 0);
      const winRate = Math.round(profits.length / completedTrades.length * 100);
      const avgProfit = profits.length > 0 ? (profits.reduce((s, t) => s + parseFloat(t.outcome_pnl), 0) / profits.length).toFixed(1) : 0;
      const avgLoss = losses.length > 0 ? (losses.reduce((s, t) => s + parseFloat(t.outcome_pnl), 0) / losses.length).toFixed(1) : 0;
      context += `Bryan's track record:\n• Win rate: ${winRate}% | Avg profit: +${avgProfit}% | Avg loss: ${avgLoss}%\n`;
    }

    return context;
  } catch (e) {
    console.error('getLearningContext error:', e.message);
    return '';
  }
}

async function getAutomationReadiness(symbol, action) {
  try {
    const [trades] = await db.execute(
      'SELECT outcome_pnl FROM trading_journal WHERE symbol = ? AND action = ? AND outcome_pnl IS NOT NULL',
      [symbol, action]
    );
    if (trades.length < 10) return null;
    const wins = trades.filter(t => parseFloat(t.outcome_pnl) > 0).length;
    const winRate = Math.round(wins / trades.length * 100);
    if (winRate < 75) return null;
    return { ready: true, winRate, sampleSize: trades.length };
  } catch (e) {
    return null;
  }
}

async function checkMacroNews() {
  let keywordsFound = false;
  let alertSent = false;
  try {
    console.log('Macro check:', new Date().toISOString(), '- Starting...');

    // STEP 1: Identify significant holdings (> $300 USD)
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
    const significantHoldings = [];
    for (const asset of balances) {
      if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
      const available = parseFloat(asset.available);
      if (available <= 0) continue;
      const symbol = `${asset.currency}-USD`;
      const price = priceMap[symbol];
      if (!price) continue;
      const valueUSD = available * price;
      if (valueUSD < 300) continue;
      const narrative = COIN_NARRATIVES[asset.currency] || `${asset.currency} cryptocurrency`;
      significantHoldings.push({ coin: asset.currency, symbol, available, price, valueUSD, narrative });
    }
    significantHoldings.sort((a, b) => b.valueUSD - a.valueUSD);

    if (significantHoldings.length === 0) {
      console.log('Macro check:', new Date().toISOString(), '- No significant holdings, skipping.');
      return;
    }

    // STEP 2: Fetch free news RSS (no API cost)
    const rssUrls = [
      'https://cointelegraph.com/rss',
      'https://www.coindesk.com/arc/outboundfeeds/rss/',
    ];
    let rawNewsText = '';
    for (const url of rssUrls) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (response.ok) {
          const xml = await response.text();
          // Extract CDATA and plain text from <title> and <description> tags
          const extract = (tag) => [...xml.matchAll(new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*?))</${tag}>`, 'g'))]
            .map(m => (m[1] || m[2] || '').trim())
            .filter(Boolean);
          rawNewsText += extract('title').join(' ') + ' ' + extract('description').join(' ') + ' ';
        }
      } catch (e) {
        console.log('RSS fetch failed for', url, '-', e.message);
      }
    }

    if (!rawNewsText.trim()) {
      console.log('Macro check:', new Date().toISOString(), '- Keywords found: false - Alert sent: false (no news fetched)');
      return;
    }

    // STEP 3: Keyword check — FREE, no Claude API
    const HIGH_IMPACT_KEYWORDS = [
      'war', 'invasion', 'military', 'sanctions', 'conflict',
      'sec', 'ban', 'regulation', 'legislation', 'congress', 'senate', 'clarity act',
      'fed rate', 'interest rate', 'inflation', 'recession', 'tariff',
      'hack', 'exploit', 'crash', 'rally', 'etf', 'institutional'
    ];
    const coinKeywords = significantHoldings.map(h => h.coin.toLowerCase());
    const lowerNews = rawNewsText.toLowerCase();
    const foundKeywords = [...HIGH_IMPACT_KEYWORDS, ...coinKeywords].filter(kw => lowerNews.includes(kw));
    keywordsFound = foundKeywords.length > 0;

    if (!keywordsFound) {
      console.log('Macro check:', new Date().toISOString(), '- Keywords found: false - Alert sent: false');
      return;
    }
    console.log('Macro check:', new Date().toISOString(), '- Keywords found:', foundKeywords.slice(0, 8).join(', '));

    // STEP 4: Call Claude API for impact analysis (only reached if keywords found, max once per 2 hours)
    if (Date.now() - lastClaudeCallTime < 2 * 60 * 60 * 1000) {
      console.log('Macro check:', new Date().toISOString(), '- Keywords found: true - Claude rate limited (last call', Math.round((Date.now() - lastClaudeCallTime) / 60000), 'min ago)');
      return;
    }
    const holdingsList = significantHoldings
      .map(h => `${h.coin} ($${h.valueUSD.toFixed(0)} — ${h.narrative})`)
      .join(', ');
    const newsSnippet = rawNewsText.substring(0, 1500);
    const totalSignificant = significantHoldings.reduce((s, h) => s + h.valueUSD, 0);

    const claudeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role: 'user',
        content: `The user holds these crypto assets worth over $300: ${holdingsList}. Total: $${totalSignificant.toFixed(0)}.\n\nRSS headlines just fetched (scan for relevance): ${newsSnippet}\n\nSearch for the latest news on: ${foundKeywords.slice(0, 5).join(', ')}.\n\nAnalyse if any current news could significantly impact the user's holdings. Rate each affected coin HIGH/MEDIUM/LOW. Only report HIGH or MEDIUM impacts.\n\nStart your response with EXACTLY one of:\n🚨 MACRO ALERT\n✅ NO SIGNIFICANT ALERTS\n\nIf alert, for each issue:\n- What happened\n- Which coins affected and direction (bullish/bearish)\n- Recommended action (1 sentence)\n- Urgency: act now / watch / FYI\n\nKeep total response under 1800 characters.`
      }]
    });

    lastClaudeCallTime = Date.now();
    const lastTextBlock = [...claudeResponse.content].reverse().find(b => b.type === 'text');
    const analysis = lastTextBlock ? lastTextBlock.text.trim() : '✅ NO SIGNIFICANT ALERTS';
    console.log('Claude macro response:', analysis.substring(0, 300));

    // STEP 5: Only send if MACRO ALERT and not a duplicate in last 6 hours
    if (!analysis.includes('🚨 MACRO ALERT')) {
      console.log('Macro check:', new Date().toISOString(), '- Keywords found: true - Alert sent: false (no significant alert from Claude)');
      return;
    }

    const alertHash = createHash('sha256').update(analysis.substring(0, 200)).digest('hex');
    const [existingRows] = await db.execute(
      'SELECT id FROM macro_alerts_sent WHERE alert_hash = ? AND sent_at > DATE_SUB(NOW(), INTERVAL 6 HOUR)',
      [alertHash]
    );
    if (existingRows.length > 0) {
      console.log('Macro check:', new Date().toISOString(), '- Duplicate suppressed (hash:', alertHash.substring(0, 8) + ')');
      return;
    }

    // Build affected holdings lines (coins mentioned in Claude's analysis)
    const affectedLines = significantHoldings
      .filter(h => analysis.toUpperCase().includes(h.coin.toUpperCase()))
      .map(h => `• ${h.coin}: $${h.valueUSD.toFixed(0)}`);
    const affectedSection = affectedLines.length > 0
      ? `\n\n💼 <b>Your affected holdings:</b>\n${affectedLines.join('\n')}\n\nReply 'analyse [COIN]' for deeper analysis`
      : '';

    const telegramMessage = `🌍 <b>MACRO ALERT — PORTFOLIO IMPACT DETECTED</b>\n\n${analysis}${affectedSection}`;
    await sendTelegram(telegramMessage);
    await db.execute('INSERT INTO macro_alerts_sent (alert_hash) VALUES (?)', [alertHash]);
    alertSent = true;

  } catch (e) {
    console.error('checkMacroNews error:', e.message);
  }
  console.log('Macro check:', new Date().toISOString(), '- Keywords found:', keywordsFound, '- Alert sent:', alertSent);
}

async function recordTradeOutcome(symbol, sellPrice, sellQty, currentQty) {
  try {
    const coinBase = symbol.replace('-USD', '');

    // Find most recent open BUY entry
    const [buyRows] = await db.execute(
      "SELECT * FROM trading_journal WHERE symbol = ? AND action = 'buy' AND outcome IS NULL ORDER BY created_at DESC LIMIT 1",
      [symbol]
    );
    if (buyRows.length === 0) return null;

    const buy = buyRows[0];
    const buyPrice = parseFloat(buy.price);
    const buyQty = parseFloat(buy.quantity || sellQty);

    const pnlPct = ((sellPrice - buyPrice) / buyPrice) * 100;

    // Partial exit: balance still exists and sold < 95% of original buy qty
    const isPartial = currentQty > 0.001 && sellQty < buyQty * 0.95;

    // Dollar P&L on the portion sold
    const soldValue = sellQty * sellPrice;
    const costBasis = sellQty * buyPrice;
    const dollarPnl = soldValue - costBasis;

    // Hold duration
    const buyDate = new Date(buy.created_at);
    const durationMs = Date.now() - buyDate.getTime();
    const durationDays = Math.floor(durationMs / (1000 * 60 * 60 * 24));
    const durationHours = Math.floor((durationMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const durationStr = durationDays > 0
      ? `${durationDays} day${durationDays !== 1 ? 's' : ''}`
      : `${durationHours} hour${durationHours !== 1 ? 's' : ''}`;

    let outcome, outcomeNotes;
    if (isPartial) {
      outcome = pnlPct >= 0 ? 'partial_profit' : 'partial_loss';
      outcomeNotes = `Partial exit: sold ${sellQty.toFixed(4)} tokens at $${sellPrice.toFixed(4)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`;
    } else if (Math.abs(pnlPct) <= 0.5) {
      outcome = 'breakeven';
      outcomeNotes = `Breakeven exit after ${durationStr}`;
    } else {
      outcome = pnlPct > 0 ? 'profit' : 'loss';
      outcomeNotes = `Full exit: ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% over ${durationStr}`;
    }

    // Update the BUY journal entry
    await db.execute(
      'UPDATE trading_journal SET outcome = ?, outcome_price = ?, outcome_pnl = ?, outcome_notes = ? WHERE id = ?',
      [outcome, sellPrice, pnlPct.toFixed(4), outcomeNotes, buy.id]
    );

    await updateLearningModel().catch(() => {});

    // Build rich Telegram notification
    const pnlSign = pnlPct >= 0 ? '+' : '';
    const dollarSign = dollarPnl >= 0 ? '+' : '';
    const dollarStr = `${dollarSign}$${Math.abs(dollarPnl).toFixed(2)}`;
    const buyPriceStr = `$${buyPrice.toFixed(4)}`;
    const sellPriceStr = `$${sellPrice.toFixed(4)}`;
    let msg;

    if (isPartial) {
      const label = pnlPct >= 0 ? '💰 PARTIAL PROFIT' : '📉 PARTIAL LOSS';
      msg = `📊 <b>PARTIAL EXIT RECORDED — ${coinBase}</b>\n` +
        `${label}: ${pnlSign}${pnlPct.toFixed(1)}%\n` +
        `Sold ${sellQty.toFixed(4)} tokens at ${sellPriceStr} (bought at ${buyPriceStr})\n` +
        `Gain on this portion: ${dollarStr}\n` +
        `Remaining position: still open\n\n` +
        `🧠 Learning model updated`;
    } else if (outcome === 'breakeven') {
      msg = `📊 <b>TRADE OUTCOME RECORDED — ${coinBase}</b>\n` +
        `⚖️ BREAKEVEN: ${pnlSign}${pnlPct.toFixed(1)}%\n` +
        `Bought: ${buyPriceStr} → Sold: ${sellPriceStr}\n` +
        `Net: ${dollarStr} | Duration: ${durationStr}\n\n` +
        `🧠 Learning model updated`;
    } else if (outcome === 'profit') {
      msg = `🎉 <b>TRADE OUTCOME RECORDED — ${coinBase}</b>\n` +
        `✅ PROFIT: ${pnlSign}${pnlPct.toFixed(1)}%\n` +
        `Bought: ${buyPriceStr} → Sold: ${sellPriceStr}\n` +
        `Gain: ${dollarStr} | Duration: ${durationStr}\n\n` +
        `🧠 Learning model updated — this adds to your win rate!`;
    } else {
      msg = `📊 <b>TRADE OUTCOME RECORDED — ${coinBase}</b>\n` +
        `❌ LOSS: ${pnlSign}${pnlPct.toFixed(1)}%\n` +
        `Bought: ${buyPriceStr} → Sold: ${sellPriceStr}\n` +
        `Loss: ${dollarStr} | Duration: ${durationStr}\n\n` +
        `🧠 Learning updated — recording what didn't work helps improve future recommendations.`;
    }

    await sendTelegram(msg);
    return { outcome, pnlPct, dollarPnl, durationStr };
  } catch (e) {
    console.error('recordTradeOutcome error:', e.message);
    return null;
  }
}

async function autoLogTrade(symbol, action, price, qtyChange, currentQty) {
  try {
    const coinBase = symbol.replace('-USD', '');
    const absQty = Math.abs(qtyChange);
    const valueUsd = absQty * price;

    // Debounce: if same symbol detected within 10 minutes, skip
    const existing = pendingTradeContext.get(symbol);
    if (existing && (Date.now() - existing.detectedAt) < 10 * 60 * 1000) {
      console.log(`Trade detection debounced for ${symbol} (within 10 min window)`);
      return;
    }

    // Look up most recent Claude recommendation for this coin
    let claudeRec = null;
    try {
      const [recRows] = await db.execute(
        'SELECT recommendation FROM analysis_history WHERE symbol = ? AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY) ORDER BY created_at DESC LIMIT 1',
        [symbol]
      );
      if (recRows.length > 0) claudeRec = recRows[0].recommendation;
    } catch (e) { /* ignore */ }

    // Insert journal entry
    const [result] = await db.execute(
      'INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, claude_recommendation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [symbol, action, price, absQty, valueUsd, 'auto-detected', 'pending', claudeRec]
    );
    const journalId = result.insertId;

    // If sell: record outcome with full P&L notification
    let pnlLine = '';
    if (action === 'sell') {
      const result = await recordTradeOutcome(symbol, price, absQty, currentQty);
      if (result) {
        pnlLine = `\nP&L: ${result.pnlPct >= 0 ? '+' : ''}${result.pnlPct.toFixed(1)}% ${result.pnlPct >= 0 ? '✅' : '❌'}`;
      }
    }

    // If buy: detect re-entry (previous sell with outcome exists)
    let reentryNote = '';
    if (action === 'buy') {
      try {
        const [prevSell] = await db.execute(
          "SELECT action, outcome, outcome_pnl FROM trading_journal WHERE symbol = ? AND action = 'sell' AND outcome IS NOT NULL ORDER BY created_at DESC LIMIT 1",
          [symbol]
        );
        if (prevSell.length > 0) {
          const prev = prevSell[0];
          const prevOutcome = prev.outcome_pnl != null
            ? `${parseFloat(prev.outcome_pnl) >= 0 ? 'profit' : 'loss'} (${parseFloat(prev.outcome_pnl) >= 0 ? '+' : ''}${parseFloat(prev.outcome_pnl).toFixed(1)}%)`
            : prev.outcome || 'previous position';
          await db.execute(
            'UPDATE trading_journal SET outcome_notes = ? WHERE id = ?',
            [`Re-entry after ${prevOutcome}`, journalId]
          );
          reentryNote = `\n♻️ Re-entry after ${prevOutcome}`;
        }
      } catch (e) { /* ignore */ }
    }

    // Send Telegram notification asking for context
    const actionLabel = action === 'buy' ? 'BOUGHT' : action === 'sell' ? 'SOLD' : action.toUpperCase();
    const recLine = claudeRec ? `\n📊 Last Claude rec: ${claudeRec}` : '';
    const reentryLine = reentryNote || '';
    const msg =
      `📝 <b>TRADE DETECTED — ${symbol}</b>\n` +
      `Action: ${actionLabel} ~${absQty.toFixed(4)} tokens at $${price.toFixed(4)} ($${valueUsd.toFixed(2)})${pnlLine}${recLine}${reentryLine}\n\n` +
      `Quick questions while it's fresh:\n` +
      `1️⃣ Why did you make this trade?\n` +
      `2️⃣ Feeling: confident / uncertain / fomo / fearful / neutral\n\n` +
      `Reply: '<b>${coinBase.toLowerCase()} reason [why], [emotion]</b>'\n` +
      `Or: '<b>${coinBase.toLowerCase()} skip</b>' to log without details\n` +
      `Or: '<b>${coinBase.toLowerCase()} payment</b>' to log as a payment (excluded from stats)\n\n` +
      `⏰ Will auto-log in 30 minutes if no reply.`;
    await sendTelegram(msg);

    // Set 30-minute timeout to auto-complete
    const timeoutHandle = setTimeout(async () => {
      try {
        await db.execute(
          'UPDATE trading_journal SET reasoning = ?, emotion = ? WHERE id = ? AND reasoning = ?',
          ['no reason provided', 'neutral', journalId, 'auto-detected']
        );
        pendingTradeContext.delete(symbol);
        await sendTelegram(`⏰ <b>${symbol}</b> trade auto-logged without context.`);
        await updateLearningModel().catch(() => {});
      } catch (e) { /* ignore */ }
    }, 30 * 60 * 1000);

    pendingTradeContext.set(symbol, { journalId, detectedAt: Date.now(), timeoutHandle });
    console.log(`Auto-logged trade: ${symbol} ${action} ${absQty.toFixed(4)} @ $${price.toFixed(4)}`);
  } catch (e) {
    console.error('autoLogTrade error:', e.message);
  }
}

// ── Portfolio Rebalancing Analysis ───────────────────────────────────────────

async function buildPositions() {
  const balances = await revolutRequest('GET', '/balances');
  const tickerResponse = await revolutRequest('GET', '/tickers');
  const tickerList = Array.isArray(tickerResponse) ? tickerResponse : (tickerResponse.data || []);
  const priceMap = {};
  for (const t of tickerList) {
    if (t.symbol) {
      const p = parseFloat(t.last_price || t.mid || t.ask || t.bid);
      if (p) { priceMap[t.symbol] = p; priceMap[t.symbol.replace('/', '-')] = p; }
    }
  }
  const [entryRows] = await db.execute('SELECT symbol, entry_price FROM entry_prices');
  const entryMap = {};
  for (const r of entryRows) entryMap[r.symbol] = parseFloat(r.entry_price);

  const positions = [];
  let totalValue = 0, totalLoss = 0;

  for (const asset of balances) {
    if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
    const available = parseFloat(asset.available);
    if (available <= 0.0001) continue;
    const symbol = `${asset.currency}-USD`;
    const price = priceMap[symbol];
    if (!price) continue;
    const currentValue = available * price;
    totalValue += currentValue;
    const entryPrice = entryMap[symbol] || null;

    let unrealisedPnlPct = null, unrealisedPnlUsd = null, recoveryNeededPct = null, category = 'no_entry';
    if (entryPrice) {
      unrealisedPnlPct = ((price - entryPrice) / entryPrice) * 100;
      unrealisedPnlUsd = currentValue - (available * entryPrice);
      recoveryNeededPct = entryPrice > price ? ((entryPrice - price) / price) * 100 : 0;
      if (unrealisedPnlPct >= 0) category = 'winning';
      else if (unrealisedPnlPct > -20) category = 'small_loss';
      else if (unrealisedPnlPct > -50) category = 'moderate_loss';
      else category = 'severe_loss';
      if (unrealisedPnlUsd < 0) totalLoss += unrealisedPnlUsd;
    }
    positions.push({ symbol, coin: asset.currency, available, price, currentValue, entryPrice, unrealisedPnlPct, unrealisedPnlUsd, recoveryNeededPct, category });
  }

  positions.sort((a, b) => (a.unrealisedPnlPct ?? 0) - (b.unrealisedPnlPct ?? 0));
  return { positions, totalValue, totalLoss };
}

async function analyzePortfolioRebalancing(symbolFilter = null) {
  try {
    const { positions, totalValue, totalLoss } = await buildPositions();
    const analysisPositions = symbolFilter
      ? positions.filter(p => p.symbol === symbolFilter || p.coin.toUpperCase() === symbolFilter.toUpperCase())
      : positions;

    if (analysisPositions.length === 0) return { analysis: 'No matching positions with entry prices set.', positions, totalValue, totalLoss };

    const positionLines = analysisPositions.map(p => {
      const ep = p.entryPrice ? `Entry: $${p.entryPrice.toFixed(6)}` : 'Entry: not set';
      const pnl = p.unrealisedPnlPct != null ? ` | P&L: ${p.unrealisedPnlPct >= 0 ? '+' : ''}${p.unrealisedPnlPct.toFixed(1)}% ($${(p.unrealisedPnlUsd || 0).toFixed(2)})` : '';
      const rec = p.recoveryNeededPct > 0 ? ` | Needs ${p.recoveryNeededPct.toFixed(1)}% rise to break even` : '';
      return `• ${p.coin}: ${p.available.toFixed(4)} tokens @ $${p.price.toFixed(6)} = $${p.currentValue.toFixed(2)} | ${ep}${pnl}${rec} [${p.category}]`;
    }).join('\n');

    const isSingleCoin = symbolFilter != null;
    const prompt = isSingleCoin
      ? `Bryan is analysing whether to hold or cut his ${analysisPositions[0]?.coin} position.

Position details:
${positionLines}

Bryan's overall portfolio is ~50% down from highs. His primary goal is recovery.

Give a specific, honest recommendation for this position:
1. HOLD or CUT LOSS — be direct
2. Why — fundamentals, catalyst, recovery timeline
3. If CUT: where to redeploy the capital
4. If HOLD: what price target / catalyst to watch
5. Opportunity cost — is capital better elsewhere?

Be concise and actionable. No disclaimer needed.`
      : `Bryan is recovering from a bear market with ~50% portfolio loss.

His current portfolio with entry prices and unrealised P&L:
${positionLines}

Total portfolio value: $${totalValue.toFixed(2)}
Total unrealised loss: $${Math.abs(totalLoss).toFixed(2)} (${((Math.abs(totalLoss) / totalValue) * 100).toFixed(1)}% of portfolio)

Bryan's goal is portfolio recovery. Provide a clear rebalancing plan:

## HOLD — Worth holding for recovery
List coins with strong fundamentals and realistic recovery catalysts.

## CUT LOSS — Consider selling
List coins where capital is better deployed elsewhere. Be honest — some positions may not recover.

## REDEPLOY — Where to put freed capital
Consider Bryan's existing winners (CC, HYPE, LINK) and overall balance.

## REBALANCING PLAN — Specific steps
- Priority sells (what to sell first and why)
- Where to add (what to buy with freed capital)
- Target allocations after rebalancing
- Expected recovery timeline

## KEY INSIGHTS
- Any positions at risk of not recovering
- Tax consideration: selling at loss can offset future gains
- Most important action to take this week

Be honest, direct and actionable.`;

    const claudeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: isSingleCoin ? 1500 : 3500,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: 'user', content: prompt }]
    });

    const lastTextBlock = [...claudeResponse.content].reverse().find(b => b.type === 'text');
    const analysis = lastTextBlock ? lastTextBlock.text.trim() : 'Analysis unavailable.';

    if (!isSingleCoin) {
      await db.execute(
        'INSERT INTO rebalancing_history (analysis, symbol, total_value_usd, total_unrealised_loss_usd) VALUES (?, ?, ?, ?)',
        [analysis, null, totalValue, totalLoss]
      ).catch(() => {});
    }

    return { analysis, positions, totalValue, totalLoss };
  } catch (e) {
    console.error('analyzePortfolioRebalancing error:', e.message);
    throw e;
  }
}

async function checkPortfolio() {
  if (monitoringPaused) {
    console.log('Monitoring paused, skipping check.');
    return;
  }
  try {
    portfolioCheckCount++;
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

      // ── Auto trade detection ──────────────────────────────────────────────
      if (portfolioCheckCount > 1) { // skip first check (baseline establishment)
        const prevQty = previousBalances.get(symbol);
        if (prevQty !== undefined && prevQty > 0) {
          const qtyChange = available - prevQty;
          const changePct = (qtyChange / prevQty) * 100;
          if (Math.abs(changePct) >= 1) { // ignore dust < 1%
            const action = qtyChange > 0 ? 'buy' : 'sell';
            console.log(`Balance change detected: ${symbol} from ${prevQty} to ${available} action: ${action} (${changePct.toFixed(1)}%)`);
            autoLogTrade(symbol, action, currentPrice, qtyChange, available).catch(e => console.error('autoLogTrade failed:', e.message));
          }
        } else if (prevQty === undefined && available > 0) {
          // New coin appearing
          console.log(`Balance change detected: ${symbol} from 0 to ${available} action: buy (new position)`);
          autoLogTrade(symbol, 'buy', currentPrice, available, available).catch(e => console.error('autoLogTrade failed:', e.message));
        }
      }
      // Update snapshot
      previousBalances.set(symbol, available);
      await db.execute(
        'INSERT INTO balance_snapshots (symbol, quantity) VALUES (?, ?) ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)',
        [symbol, available]
      );
      // ─────────────────────────────────────────────────────────────────────

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

    // Detect full exits (coin was in previousBalances but not in current balances)
    if (portfolioCheckCount > 1) {
      const currentSymbols = new Set(
        balances
          .filter(a => a.currency && !SKIP_CURRENCIES.includes(a.currency) && parseFloat(a.available) > 0)
          .map(a => `${a.currency}-USD`)
      );
      for (const [sym, prevQty] of previousBalances) {
        if (!currentSymbols.has(sym) && prevQty > 0) {
          const exitPrice = priceMap[sym];
          if (exitPrice) {
            console.log(`Balance change detected: ${sym} from ${prevQty} to 0 action: sell (full exit)`);
            autoLogTrade(sym, 'sell', exitPrice, -prevQty, 0).catch(e => console.error('autoLogTrade failed:', e.message));
          }
          previousBalances.delete(sym);
          await db.execute('DELETE FROM balance_snapshots WHERE symbol = ?', [sym]).catch(() => {});
        }
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
        const autoReady = await getAutomationReadiness(symbol, 'buy');
        const autoLine = autoReady ? `\n\n⚡ AUTO-READY: This setup has worked ${autoReady.winRate}% of the time (${autoReady.sampleSize} trades). Could be automated.` : '';
        const alertMessage = `🎯 <b>${symbol} FIXED TARGET HIT!</b>\n\nAnchor: $${target.anchorPrice.toFixed(4)} → Now $${currentPrice.toFixed(4)} (+${changePct.toFixed(1)}%)${entryLine}\n\n⚡ RECOMMENDATION: ${aiRec}${replyMenu}${autoLine}`;
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
        const autoReady = await getAutomationReadiness(symbol, 'sell');
        const autoLine = autoReady ? `\n\n⚡ AUTO-READY: This setup has worked ${autoReady.winRate}% of the time (${autoReady.sampleSize} trades). Could be automated.` : '';
        const alertMessage = `📉 <b>${symbol} FIXED FLOOR HIT!</b>\n\nAnchor: $${target.anchorPrice.toFixed(4)} → Now $${currentPrice.toFixed(4)} (${changePct.toFixed(1)}%)${entryLine}\n\n⚡ RECOMMENDATION: ${aiRec}${replyMenu}${autoLine}`;
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

// Check macro news every 5 minutes — free RSS + keyword scan; Claude called at most once per 2h
cron.schedule('*/5 * * * *', checkMacroNews, { timezone: 'Europe/London' });

// Weekly rebalancing reminder — every Monday at 9:05 AM (after morning briefing)
cron.schedule('5 9 * * 1', async () => {
  try {
    const { positions } = await buildPositions();
    const severelyDown = positions.filter(p => p.category === 'severe_loss');
    if (severelyDown.length > 0) {
      const coinList = severelyDown.map(p => `${p.coin} (${p.unrealisedPnlPct.toFixed(0)}%)`).join(', ');
      await sendTelegram(
        `📊 <b>WEEKLY REBALANCING CHECK</b>\n\n` +
        `You have <b>${severelyDown.length}</b> position${severelyDown.length > 1 ? 's' : ''} down more than 50%:\n${coinList}\n\n` +
        `Reply <b>'rebalance'</b> for full analysis and recommendations.`
      );
    }
  } catch (e) {
    console.error('Weekly rebalancing check error:', e.message);
  }
}, { timezone: 'Europe/London' });

console.log('Cron jobs scheduled: midnight price recording + 9 AM morning briefing + every-2h macro news + Monday 9:05 rebalancing check (Europe/London)');

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

// GET /api/journal/stats — compute stats from trading_journal
app.get('/api/journal/stats', async (req, res) => {
  try {
    const [all] = await db.execute("SELECT * FROM trading_journal WHERE action != 'payment'");
    const completed = all.filter(t => t.outcome_pnl != null);
    const total_trades = all.length;
    const wins = completed.filter(t => parseFloat(t.outcome_pnl) > 0);
    const losses = completed.filter(t => parseFloat(t.outcome_pnl) <= 0);
    const win_rate = completed.length > 0 ? Math.round(wins.length / completed.length * 100) : 0;
    const avg_profit = wins.length > 0 ? (wins.reduce((s, t) => s + parseFloat(t.outcome_pnl), 0) / wins.length).toFixed(1) : 0;
    const avg_loss = losses.length > 0 ? (losses.reduce((s, t) => s + parseFloat(t.outcome_pnl), 0) / losses.length).toFixed(1) : 0;
    const best_trade = completed.length > 0 ? completed.reduce((a, b) => parseFloat(a.outcome_pnl) > parseFloat(b.outcome_pnl) ? a : b) : null;
    const worst_trade = completed.length > 0 ? completed.reduce((a, b) => parseFloat(a.outcome_pnl) < parseFloat(b.outcome_pnl) ? a : b) : null;
    const coinCounts = {};
    for (const t of all) { coinCounts[t.symbol] = (coinCounts[t.symbol] || 0) + 1; }
    const most_traded = Object.entries(coinCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const byEmotion = {};
    for (const t of completed) {
      if (!t.emotion) continue;
      if (!byEmotion[t.emotion]) byEmotion[t.emotion] = { wins: 0, total: 0 };
      byEmotion[t.emotion].total++;
      if (parseFloat(t.outcome_pnl) > 0) byEmotion[t.emotion].wins++;
    }
    const followed = completed.filter(t => t.followed_recommendation === 1);
    const ignored = completed.filter(t => t.followed_recommendation === 0);
    const followed_win_rate = followed.length > 0 ? Math.round(followed.filter(t => parseFloat(t.outcome_pnl) > 0).length / followed.length * 100) : null;
    const ignored_win_rate = ignored.length > 0 ? Math.round(ignored.filter(t => parseFloat(t.outcome_pnl) > 0).length / ignored.length * 100) : null;

    // Auto-detected outcomes count
    const auto_detected_outcomes = completed.filter(t => t.reasoning === 'auto-detected').length;

    // Payment count
    const [paymentRows] = await db.execute("SELECT COUNT(*) as cnt FROM trading_journal WHERE action = 'payment'");
    const payment_count = parseInt(paymentRows[0].cnt);

    // Average hold time (hours) for winners vs losers — based on created_at vs updated_at
    const holdHours = (t) => {
      const created = new Date(t.created_at).getTime();
      const updated = new Date(t.updated_at).getTime();
      return (updated - created) / (1000 * 60 * 60);
    };
    const winHours = wins.map(holdHours).filter(h => h > 0);
    const lossHours = losses.map(holdHours).filter(h => h > 0);
    const avg_hold_time_winners_hours = winHours.length > 0 ? Math.round(winHours.reduce((s, h) => s + h, 0) / winHours.length) : null;
    const avg_hold_time_losers_hours = lossHours.length > 0 ? Math.round(lossHours.reduce((s, h) => s + h, 0) / lossHours.length) : null;

    res.json({
      total_trades, win_rate, avg_profit: parseFloat(avg_profit), avg_loss: parseFloat(avg_loss),
      best_trade: best_trade ? { symbol: best_trade.symbol, pnl: parseFloat(best_trade.outcome_pnl) } : null,
      worst_trade: worst_trade ? { symbol: worst_trade.symbol, pnl: parseFloat(worst_trade.outcome_pnl) } : null,
      most_traded,
      emotion_stats: byEmotion,
      recommendation_accuracy: { followed_win_rate, ignored_win_rate, followed_count: followed.length, ignored_count: ignored.length },
      auto_detected_outcomes,
      payment_count,
      avg_hold_time_winners_hours,
      avg_hold_time_losers_hours
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/journal — newest first, limit 50
app.get('/api/journal', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM trading_journal ORDER BY created_at DESC LIMIT 50');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/journal/entry — add a new journal entry
app.post('/api/journal/entry', async (req, res) => {
  try {
    const { symbol, action, price, quantity, reasoning, emotion, claude_recommendation, followed_recommendation } = req.body;
    if (!symbol || !action) return res.status(400).json({ error: 'symbol and action required' });
    const sym = symbol.toUpperCase().includes('-USD') ? symbol.toUpperCase() : `${symbol.toUpperCase()}-USD`;
    const value_usd = price && quantity ? parseFloat(price) * parseFloat(quantity) : null;
    const [result] = await db.execute(
      'INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, claude_recommendation, followed_recommendation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [sym, action, price || null, quantity || null, value_usd, reasoning || null, emotion || null, claude_recommendation || null, followed_recommendation != null ? (followed_recommendation ? 1 : 0) : null]
    );
    const [rows] = await db.execute('SELECT * FROM trading_journal WHERE id = ?', [result.insertId]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/journal/:symbol — last 20 entries for that symbol (must be after /api/journal/stats and /api/journal)
app.get('/api/journal/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol.toUpperCase().includes('-USD') ? req.params.symbol.toUpperCase() : `${req.params.symbol.toUpperCase()}-USD`;
    const [rows] = await db.execute('SELECT * FROM trading_journal WHERE symbol = ? ORDER BY created_at DESC LIMIT 20', [sym]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/journal/:id/outcome — log outcome for a journal entry
app.post('/api/journal/:id/outcome', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { outcome_price, outcome, outcome_notes } = req.body;
    const [existing] = await db.execute('SELECT * FROM trading_journal WHERE id = ?', [id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Entry not found' });
    const entry = existing[0];
    let outcome_pnl = null;
    if (outcome_price && entry.price) {
      outcome_pnl = ((parseFloat(outcome_price) - parseFloat(entry.price)) / parseFloat(entry.price)) * 100;
      if (entry.action === 'sell') outcome_pnl = -outcome_pnl; // selling at lower = profit if short
    }
    const outcomeLabel = outcome || (outcome_pnl != null ? (outcome_pnl > 0 ? 'profit' : 'loss') : null);
    await db.execute(
      'UPDATE trading_journal SET outcome_price = ?, outcome_pnl = ?, outcome = ?, outcome_notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [outcome_price || null, outcome_pnl, outcomeLabel, outcome_notes || null, id]
    );
    await updateLearningModel().catch(() => {});
    const [rows] = await db.execute('SELECT * FROM trading_journal WHERE id = ?', [id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/profile — all trader profile preferences
app.get('/api/profile', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM trader_profile ORDER BY updated_at DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/profile — upsert a preference
app.post('/api/profile', async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || !value) return res.status(400).json({ error: 'key and value required' });
    await db.execute(
      'INSERT INTO trader_profile (preference_key, preference_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE preference_value = VALUES(preference_value), updated_at = CURRENT_TIMESTAMP',
      [key, value]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/learning — return the learning model cache
app.get('/api/learning', async (req, res) => {
  try {
    res.json({ summary: learningModelCache, updatedAt: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// GET /api/rebalancing/positions — live portfolio positions with P&L
app.get('/api/rebalancing/positions', async (req, res) => {
  try {
    const { positions, totalValue, totalLoss } = await buildPositions();
    const summary = {
      totalValue,
      totalLoss,
      totalLossPct: totalValue > 0 ? (Math.abs(totalLoss) / totalValue) * 100 : 0,
      categoryCount: {
        winning: positions.filter(p => p.category === 'winning').length,
        small_loss: positions.filter(p => p.category === 'small_loss').length,
        moderate_loss: positions.filter(p => p.category === 'moderate_loss').length,
        severe_loss: positions.filter(p => p.category === 'severe_loss').length,
        no_entry: positions.filter(p => p.category === 'no_entry').length,
      }
    };
    res.json({ positions, summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/rebalancing/latest — last stored analysis
app.get('/api/rebalancing/latest', async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT * FROM rebalancing_history WHERE symbol IS NULL ORDER BY created_at DESC LIMIT 1'
    );
    res.json(rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/rebalancing — trigger new full analysis
app.post('/api/rebalancing', async (req, res) => {
  try {
    const symbol = req.body?.symbol || null;
    const result = await analyzePortfolioRebalancing(symbol);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

    // --- Pending journal state handler (emotion / followed flow) ---
    const chatIdStr = chatId.toString();
    if (pendingJournalState.has(chatIdStr)) {
      const pendingState = pendingJournalState.get(chatIdStr);
      if (pendingState.step === 'emotion') {
        const emotionMatch = commandText.match(/^(confident|uncertain|fomo|fearful|neutral)$/);
        if (emotionMatch) {
          const emotion = emotionMatch[1];
          await db.execute('UPDATE trading_journal SET emotion = ? WHERE id = ?', [emotion, pendingState.journalId]);
          if (pendingState.hasClaudeRec) {
            pendingState.step = 'followed';
            pendingJournalState.set(chatIdStr, pendingState);
            await sendReply(`Did you follow Claude's <b>${pendingState.claudeRec}</b> recommendation? Reply: yes / no`);
          } else {
            pendingJournalState.delete(chatIdStr);
            await sendReply('✅ Journal entry complete.');
          }
          return res.status(200).json({ ok: true });
        }
      } else if (pendingState.step === 'followed') {
        const followedMatch = commandText.match(/^(yes|no)$/);
        if (followedMatch) {
          const followed = followedMatch[1] === 'yes' ? 1 : 0;
          await db.execute('UPDATE trading_journal SET followed_recommendation = ? WHERE id = ?', [followed, pendingState.journalId]);
          pendingJournalState.delete(chatIdStr);
          await sendReply('✅ Journal entry complete.');
          return res.status(200).json({ ok: true });
        }
      }
      // Non-matching reply — clear pending state and continue processing normally
      pendingJournalState.delete(chatIdStr);
    }

    // --- Auto-trade context: natural language replies when any trade is pending ---
    if (pendingTradeContext.size > 0) {
      const EMOTION_WORDS = ['confident', 'uncertain', 'fomo', 'fearful', 'neutral'];
      const lowerMsg = commandText.toLowerCase();

      // Find which pending coins are mentioned (or referenced) in this message
      const matchedPending = [];
      for (const [symbol, pending] of pendingTradeContext) {
        const coinBase = symbol.replace('-USD', '').toLowerCase();
        // Check explicit "[COIN] skip"
        if (lowerMsg === `${coinBase} skip` || lowerMsg === `skip ${coinBase}`) {
          matchedPending.push({ symbol, pending, skip: true });
        } else if (lowerMsg.includes(coinBase)) {
          matchedPending.push({ symbol, pending, skip: false });
        }
      }

      // If only one trade pending and message doesn't explicitly mention other coins,
      // treat ANY non-command message as context for that trade
      if (matchedPending.length === 0 && pendingTradeContext.size === 1) {
        const [[symbol, pending]] = pendingTradeContext;
        // Only intercept if message isn't a recognised command
        const isKnownCommand = /^(pause|resume|status|acknowledge|ack|sell|buy|entry|daily|target|journal|my stats|learning|holding|bought|sold|i prefer|rebalance|rebalancing)/i.test(commandText);
        if (!isKnownCommand) {
          matchedPending.push({ symbol, pending, skip: false });
        }
      }

      // --- Payment detection: "[coin] payment" ---
      const paymentMatch = matchedPending.find(m => lowerMsg.includes('payment'));
      if (paymentMatch) {
        const { symbol, pending } = paymentMatch;
        const coinBase = symbol.replace('-USD', '');
        clearTimeout(pending.timeoutHandle);
        pendingTradeContext.delete(symbol);
        await db.execute(
          'UPDATE trading_journal SET action = ?, reasoning = ?, emotion = ?, notes = ? WHERE id = ?',
          ['payment', 'Revolut payment made using this asset', 'neutral', 'excluded_from_stats', pending.journalId]
        );
        await updateLearningModel().catch(() => {});
        await sendReply(`✅ <b>${coinBase}</b> logged as payment — excluded from trading stats`);
        return res.status(200).json({ ok: true });
      }

      if (matchedPending.length > 0) {
        // Extract emotion from full message (first emotion word wins)
        const foundEmotion = EMOTION_WORDS.find(e => lowerMsg.includes(e)) || null;

        // Build reasoning: strip coin names and emotion words from message
        let reasoning = rawText;
        for (const { symbol } of matchedPending) {
          reasoning = reasoning.replace(new RegExp(symbol.replace('-USD', ''), 'gi'), '').trim();
        }
        for (const e of EMOTION_WORDS) {
          reasoning = reasoning.replace(new RegExp(`\\b${e}\\b`, 'gi'), '').trim();
        }
        reasoning = reasoning.replace(/[,\s]+$/, '').replace(/^[,\s]+/, '').trim() || 'no reason provided';

        const confirmLines = [];
        let anyUpdated = false;

        for (const { symbol, pending, skip } of matchedPending) {
          const coinBase = symbol.replace('-USD', '');
          clearTimeout(pending.timeoutHandle);
          pendingTradeContext.delete(symbol);

          if (skip) {
            confirmLines.push(`• ${coinBase}: logged without details`);
          } else if (!foundEmotion) {
            // Save reasoning but ask for emotion
            await db.execute('UPDATE trading_journal SET reasoning = ? WHERE id = ?', [reasoning, pending.journalId]);
            // Re-add to pending with step to collect emotion
            const newTimeout = setTimeout(async () => {
              await db.execute(
                'UPDATE trading_journal SET emotion = ? WHERE id = ? AND (emotion IS NULL OR emotion = ?)',
                ['neutral', pending.journalId, 'pending']
              );
              pendingTradeContext.delete(symbol);
              await sendTelegram(`⏰ <b>${coinBase}</b> trade auto-logged without emotion.`);
              await updateLearningModel().catch(() => {});
            }, 5 * 60 * 1000); // shorter 5-min timeout for just the emotion
            pendingTradeContext.set(symbol, { ...pending, timeoutHandle: newTimeout });
            confirmLines.push(`• ${coinBase}: reasoning saved — how are you feeling? confident / uncertain / fomo / fearful / neutral`);
            anyUpdated = true;
            continue;
          } else {
            await db.execute(
              'UPDATE trading_journal SET reasoning = ?, emotion = ? WHERE id = ?',
              [reasoning, foundEmotion, pending.journalId]
            );
            // Fetch action for confirmation line
            const [rows] = await db.execute('SELECT action, outcome_pnl FROM trading_journal WHERE id = ?', [pending.journalId]);
            const row = rows[0];
            const actionStr = row ? row.action : 'trade';
            const pnlStr = row && row.outcome_pnl != null
              ? ` (${parseFloat(row.outcome_pnl) >= 0 ? '+' : ''}${parseFloat(row.outcome_pnl).toFixed(1)}%)`
              : '';
            const resultEmoji = row && row.outcome_pnl != null ? (parseFloat(row.outcome_pnl) >= 0 ? '✅' : '❌') : '📝';
            confirmLines.push(`• ${coinBase}: ${actionStr}${pnlStr} — ${foundEmotion} ${resultEmoji}`);
            anyUpdated = true;
          }
        }

        if (anyUpdated) await updateLearningModel().catch(() => {});

        const needsEmotion = matchedPending.some(m => !m.skip && !foundEmotion);
        const confirmMsg = needsEmotion
          ? `📝 <b>Context saved:</b>\n${confirmLines.join('\n')}`
          : `✅ <b>Journal saved:</b>\n${confirmLines.join('\n')}${anyUpdated ? '\nLearning model updated 🧠' : ''}`;

        await sendReply(confirmMsg);
        return res.status(200).json({ ok: true });
      }
    }

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

    // --- Command: bought COIN PRICE [QTY] ---
    const boughtMatch = commandText.match(/^bought\s+([a-z]{2,10})\s+([\d.]+)(?:\s+([\d.]+))?$/i);
    if (boughtMatch) {
      const coinBase = boughtMatch[1].toUpperCase();
      const symbol = `${coinBase}-USD`;
      const price = parseFloat(boughtMatch[2]);
      const qty = boughtMatch[3] ? parseFloat(boughtMatch[3]) : null;
      const value_usd = qty ? price * qty : null;
      // Check analysis_history for recent rec (< 7 days)
      const [recentAna] = await db.execute(
        'SELECT recommendation, claude_summary FROM analysis_history WHERE symbol = ? AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY) ORDER BY created_at DESC LIMIT 1',
        [symbol]
      );
      const hasClaudeRec = recentAna.length > 0;
      const claudeRec = hasClaudeRec ? recentAna[0].recommendation : null;
      const [result] = await db.execute(
        'INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, claude_recommendation, claude_reasoning) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [symbol, 'buy', price, qty, value_usd, claudeRec, hasClaudeRec ? recentAna[0].claude_summary?.substring(0, 300) : null]
      );
      const journalId = result.insertId;
      pendingJournalState.set(chatIdStr, { journalId, step: 'emotion', hasClaudeRec, claudeRec, symbol });
      const qtyStr = qty ? `${qty} ` : '';
      const valStr = value_usd ? ` ($${value_usd.toFixed(2)})` : '';
      await sendReply(`📝 Logged: Bought ${qtyStr}${coinBase} at $${price}${valStr}.\n\nEmotion? Reply: confident / uncertain / fomo / fearful / neutral`);
      return res.status(200).json({ ok: true });
    }

    // --- Command: sold COIN PRICE [QTY] ---
    const soldMatch = commandText.match(/^sold\s+([a-z]{2,10})\s+([\d.]+)(?:\s+([\d.]+))?$/i);
    if (soldMatch) {
      const coinBase = soldMatch[1].toUpperCase();
      const symbol = `${coinBase}-USD`;
      const salePrice = parseFloat(soldMatch[2]);
      const qty = soldMatch[3] ? parseFloat(soldMatch[3]) : null;
      const value_usd = qty ? salePrice * qty : null;
      const [result] = await db.execute(
        'INSERT INTO trading_journal (symbol, action, price, quantity, value_usd) VALUES (?, ?, ?, ?, ?)',
        [symbol, 'sell', salePrice, qty, value_usd]
      );
      const journalId = result.insertId;
      // Find most recent buy for same symbol with no outcome
      const [recentBuy] = await db.execute(
        'SELECT id, price FROM trading_journal WHERE symbol = ? AND action = ? AND outcome IS NULL AND id != ? ORDER BY created_at DESC LIMIT 1',
        [symbol, 'buy', journalId]
      );
      let pnlLine = '';
      if (recentBuy.length > 0) {
        const buyEntry = recentBuy[0];
        const buyPrice = parseFloat(buyEntry.price);
        const pnl = ((salePrice - buyPrice) / buyPrice) * 100;
        const outcomeLabel = pnl > 0 ? 'profit' : 'loss';
        await db.execute(
          'UPDATE trading_journal SET outcome_price = ?, outcome_pnl = ?, outcome = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [salePrice, pnl, outcomeLabel, buyEntry.id]
        );
        await updateLearningModel().catch(() => {});
        pnlLine = `\nP&L vs last buy: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}% ${pnl >= 0 ? '✅' : '❌'}`;
      }
      pendingJournalState.set(chatIdStr, { journalId, step: 'emotion', hasClaudeRec: false, claudeRec: null, symbol });
      const qtyStr = qty ? `${qty} ` : '';
      await sendReply(`📝 Logged: Sold ${qtyStr}${coinBase} at $${salePrice}.${pnlLine}\n\nEmotion? Reply: confident / uncertain / fomo / fearful / neutral`);
      return res.status(200).json({ ok: true });
    }

    // --- Command: holding COIN ---
    const holdingMatch = commandText.match(/^holding\s+([a-z]{2,10})$/i);
    if (holdingMatch) {
      const coinBase = holdingMatch[1].toUpperCase();
      const symbol = `${coinBase}-USD`;
      const currentPrice = await getCurrentPrice(symbol);
      await db.execute(
        'INSERT INTO trading_journal (symbol, action, price) VALUES (?, ?, ?)',
        [symbol, 'hold', currentPrice]
      );
      const priceStr = currentPrice ? `$${currentPrice.toFixed(4)}` : 'unknown price';
      await sendReply(`📝 Hold logged for ${coinBase} at current price ${priceStr}`);
      return res.status(200).json({ ok: true });
    }

    // --- Command: journal [COIN] ---
    const journalMatch = commandText.match(/^journal(?:\s+([a-z]{2,10}))?$/i);
    if (journalMatch) {
      let rows;
      if (journalMatch[1]) {
        const coinBase = journalMatch[1].toUpperCase();
        const symbol = `${coinBase}-USD`;
        [rows] = await db.execute(
          'SELECT * FROM trading_journal WHERE symbol = ? ORDER BY created_at DESC LIMIT 5',
          [symbol]
        );
      } else {
        [rows] = await db.execute('SELECT * FROM trading_journal ORDER BY created_at DESC LIMIT 5');
      }
      if (rows.length === 0) {
        await sendReply('📓 No journal entries yet. Log trades with "bought COIN PRICE" or "sold COIN PRICE".');
      } else {
        const lines = rows.map(t => {
          const coin = t.symbol.replace('-USD', '');
          const emo = t.emotion || '—';
          const outcome = t.outcome_pnl != null ? `${parseFloat(t.outcome_pnl) >= 0 ? '+' : ''}${parseFloat(t.outcome_pnl).toFixed(1)}%` : 'pending';
          return `• ${t.action.toUpperCase()} ${coin} @ $${parseFloat(t.price || 0).toFixed(4)} | ${emo} | ${outcome}`;
        }).join('\n');
        await sendReply(`📓 <b>Recent Journal Entries:</b>\n${lines}`);
      }
      return res.status(200).json({ ok: true });
    }

    // --- Command: my stats ---
    if (commandText === 'my stats') {
      const [all] = await db.execute('SELECT * FROM trading_journal');
      const completed = all.filter(t => t.outcome_pnl != null);
      if (completed.length === 0) {
        await sendReply('📊 No completed trades yet. Log outcomes with the journal commands.');
        return res.status(200).json({ ok: true });
      }
      const wins = completed.filter(t => parseFloat(t.outcome_pnl) > 0);
      const losses = completed.filter(t => parseFloat(t.outcome_pnl) <= 0);
      const winRate = Math.round(wins.length / completed.length * 100);
      const avgProfit = wins.length > 0 ? (wins.reduce((s, t) => s + parseFloat(t.outcome_pnl), 0) / wins.length).toFixed(1) : 0;
      const avgLoss = losses.length > 0 ? (losses.reduce((s, t) => s + parseFloat(t.outcome_pnl), 0) / losses.length).toFixed(1) : 0;
      const best = completed.reduce((a, b) => parseFloat(a.outcome_pnl) > parseFloat(b.outcome_pnl) ? a : b);
      const worst = completed.reduce((a, b) => parseFloat(a.outcome_pnl) < parseFloat(b.outcome_pnl) ? a : b);
      const followed = completed.filter(t => t.followed_recommendation === 1);
      const ignored = completed.filter(t => t.followed_recommendation === 0);
      const followedWR = followed.length > 0 ? Math.round(followed.filter(t => parseFloat(t.outcome_pnl) > 0).length / followed.length * 100) : null;
      const ignoredWR = ignored.length > 0 ? Math.round(ignored.filter(t => parseFloat(t.outcome_pnl) > 0).length / ignored.length * 100) : null;
      let msg = `📊 <b>YOUR TRADING STATS</b>\nTotal trades: ${all.length}\nWin rate: ${winRate}%\nAvg profit: +${avgProfit}%\nAvg loss: ${avgLoss}%\nBest: +${parseFloat(best.outcome_pnl).toFixed(1)}% on ${best.symbol.replace('-USD','')}\nWorst: ${parseFloat(worst.outcome_pnl).toFixed(1)}% on ${worst.symbol.replace('-USD','')}`;
      if (followedWR !== null) msg += `\nFollowed Claude: ${followedWR}% win rate (${followed.length} trades)`;
      if (ignoredWR !== null) msg += `\nIgnored Claude: ${ignoredWR}% win rate (${ignored.length} trades)`;
      await sendReply(msg);
      return res.status(200).json({ ok: true });
    }

    // --- Command: learning ---
    if (commandText === 'learning') {
      if (learningModelCache) {
        await sendReply(`🧠 <b>Learning Model:</b>\n${learningModelCache}`);
      } else {
        await sendReply('No learning data yet — log some trades with outcomes first.');
      }
      return res.status(200).json({ ok: true });
    }

    // --- Command: rebalance [COIN] or "rebalancing analysis" ---
    const rebalanceSingleMatch = commandText.match(/^rebalance\s+([a-z0-9]{2,10})$/i);
    const rebalanceFullMatch = /^rebalanc(?:e|ing)(?:\s+analysis)?$/i.test(commandText);

    if (rebalanceSingleMatch || rebalanceFullMatch) {
      const coinArg = rebalanceSingleMatch ? rebalanceSingleMatch[1].toUpperCase() : null;
      await sendReply(coinArg
        ? `🔍 Analysing your <b>${coinArg}</b> position… give me a moment.`
        : '🔍 Running full portfolio rebalancing analysis… this may take 30-60 seconds.'
      );
      await new Promise(r => setTimeout(r, 2000));
      res.status(200).json({ ok: true });

      (async () => {
        try {
          const symbolFilter = coinArg ? `${coinArg}-USD` : null;
          const result = await analyzePortfolioRebalancing(symbolFilter);
          const header = coinArg
            ? `📊 <b>POSITION ANALYSIS — ${coinArg}</b>\n\n`
            : `📊 <b>PORTFOLIO REBALANCING ANALYSIS</b>\n💼 Total Value: $${result.totalValue.toFixed(0)} | Unrealised Loss: $${Math.abs(result.totalLoss).toFixed(0)}\n\n`;
          await sendTelegramChunked(header + result.analysis);
        } catch (e) {
          await sendReply('❌ Rebalancing analysis failed: ' + e.message);
        }
      })();
      return;
    }

    // --- Command: i prefer TEXT ---
    const preferMatch = commandText.match(/^i prefer\s+(.+)$/i);
    if (preferMatch) {
      const prefText = preferMatch[1].trim();
      const key = `pref_${Date.now()}`;
      await db.execute(
        'INSERT INTO trader_profile (preference_key, preference_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE preference_value = VALUES(preference_value)',
        [key, prefText]
      );
      await sendReply(`✅ Saved to your trader profile: '${prefText}'`);
      return res.status(200).json({ ok: true });
    }

    // --- Free-form message → Claude AI (async, fire-and-forget) ---

    // Capture user message for use inside the async closure
    const userMessage = rawText;

    // 1. Send acknowledgment then wait briefly so it arrives before Claude processing starts
    await sendReply('🔍 Researching... give me a moment.');
    await new Promise(r => setTimeout(r, 2000));

    // 2. Return 200 to Telegram
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

        const learningContext = await getLearningContext();

        // Build P&L context from entry prices for recovery-aware advice
        let recoveryContext = '';
        try {
          const [epRows] = await db.execute('SELECT symbol, entry_price FROM entry_prices');
          const epMap = {};
          for (const r of epRows) epMap[r.symbol] = parseFloat(r.entry_price);
          const pnlLines = holdings
            .filter(h => epMap[h.symbol])
            .map(h => {
              const ep = epMap[h.symbol];
              const pnlPct = ((h.price - ep) / ep * 100).toFixed(1);
              const needed = ep > h.price ? ((ep - h.price) / h.price * 100).toFixed(1) : '0';
              return `• ${h.symbol}: entry $${ep.toFixed(6)} → now $${h.price.toFixed(6)} = ${pnlPct >= 0 ? '+' : ''}${pnlPct}% (needs ${needed}% rise to break even)`;
            })
            .sort((a, b) => {
              const getN = s => parseFloat(s.match(/([-\d.]+)%/)?.[1] || '0');
              return getN(a) - getN(b);
            })
            .slice(0, 10);
          if (pnlLines.length > 0) {
            recoveryContext = `\n\nPORTFOLIO RECOVERY CONTEXT:\nBryan has many positions with significant unrealised losses from the bear market.\nPositions with entry prices set (sorted worst first):\n${pnlLines.join('\n')}\n\nWhen giving ANY recommendation, always consider:\n1. Does this help Bryan's overall recovery goal?\n2. Is the capital better deployed elsewhere?\n3. Is the recovery timeline realistic for this coin?\n4. What is the opportunity cost of holding vs redeploying?`;
          }
        } catch (e) { /* ignore — don't break Claude call */ }

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
- ALWAYS start your response with a 1-2 line plain-text summary of your key conclusion BEFORE any headers or bullet points
- Format the rest of the response clearly with headers and bullet points
- Be thorough and comprehensive
- Always consider macro conditions, Bitcoin dominance, and market sentiment
- Keep responses under 4000 characters total
- End with a one line disclaimer only

IMPORTANT TRADER CONTEXT:
- Bryan's portfolio is approximately 50% down from historical highs due to bear market conditions and past trading decisions
- Many individual positions are down 50-80% from entry
- Bryan's PRIMARY GOAL is portfolio recovery and becoming a more disciplined trader
- Bryan is learning to be a better swing trader — buying dips and selling pumps
- Some balance changes detected are Revolut payments (asset used to make purchases) not trading decisions
- When giving advice, always consider recovery strategy not just short term gains
- Encourage disciplined trading habits and risk management
- Be honest about positions that may not recover and suggest better opportunities
- Celebrate good trading decisions to reinforce positive patterns
- For positions down 50%+: acknowledge the loss honestly and advise whether to cut or hold for recovery
- For positions doing well (CC, HYPE, LINK): emphasise protecting and growing these gains
- Always consider overall portfolio recovery in recommendations
- Suggest position sizing that protects the recovering portfolio

${holdingsList}

Current baseline prices (set when monitoring started): ${JSON.stringify(basePrices)}
Active alerts (coins currently above threshold): ${Object.keys(activeAlerts).join(', ') || 'none'}${learningContext}${recoveryContext}`,
          messages,
        });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 110000)
        );

        // Send follow-up after 20 seconds if still processing
        stillResearchingTimer = setTimeout(async () => {
          try {
            await sendReply('⏳ Still researching, almost there...');
          } catch (e) { /* ignore */ }
        }, 20000);

        const response = await Promise.race([claudePromise, timeoutPromise]);
        clearTimeout(stillResearchingTimer);

        // Extract the last text block (web_search may produce tool_use blocks before the final text)
        const lastTextBlock = [...response.content].reverse().find(b => b.type === 'text');
        const reply = lastTextBlock ? lastTextBlock.text : '(no response)';

        // Extract recommendation from Claude's reply and save to analysis_history
        try {
          const recMatch = reply.match(/\*\*(HOLD|SELL|BUY MORE|BUY|REDUCE|ADD)\*\*/i) || reply.match(/^(HOLD|SELL|BUY MORE|BUY|REDUCE|ADD)\b/im);
          if (recMatch) {
            const rec = recMatch[1].toUpperCase();
            const coinInMsg = userMessage.match(/\b([A-Z]{2,10})\b/);
            const coinBase = coinInMsg ? coinInMsg[1] : null;
            const symbol = coinBase && !SKIP_WORDS.has(coinBase) ? `${coinBase}-USD` : null;
            if (symbol) {
              const priceNow = await getCurrentPrice(symbol).catch(() => null);
              const summary = reply.substring(0, 500);
              await db.execute(
                'INSERT INTO analysis_history (symbol, analysis_type, price_at_analysis, recommendation, claude_summary) VALUES (?, ?, ?, ?, ?)',
                [symbol, 'telegram_analysis', priceNow, rec, summary]
              ).catch(() => {});
            }
          }
        } catch (e) { /* ignore */ }

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

        // 3s gap after status message so chunks don't collide with it
        await new Promise(r => setTimeout(r, 3000));
        await sendTelegramChunked(reply + (actionTaken || ''));
      } catch (err) {
        console.error('Claude AI error:', err.message);
        clearTimeout(stillResearchingTimer);
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

// Seed default trader profile entries if not already set
const TRADER_PROFILE_DEFAULTS = [
  { key: 'goal',      value: 'Recover portfolio losses and become a disciplined profitable swing trader' },
  { key: 'situation', value: 'Portfolio approximately 50% down from historical highs' },
  { key: 'style',     value: 'Swing trader - buy dips sell pumps' },
  { key: 'weakness',  value: 'Past trading decisions led to significant losses - working to improve discipline' },
  { key: 'strength',  value: 'Good instincts on institutional plays like CC and LINK' },
];
(async () => {
  for (const { key, value } of TRADER_PROFILE_DEFAULTS) {
    await db.execute(
      'INSERT INTO trader_profile (preference_key, preference_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE preference_key = preference_key',
      [key, value]
    ).catch(() => {});
  }
  console.log('Trader profile defaults seeded.');
})();

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
