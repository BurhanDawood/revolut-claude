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

// Split text into chunks at \n\n boundaries, never exceeding maxLen characters.
async function sendTelegramChunked(text) {
  console.log('CHUNKING FUNCTION CALLED: text length:', (text || '').length);
  const maxLen = 2500;
  const chunks = [];
  let remaining = (text || '').trim();

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Find best split point — prefer paragraph break, fall back to line break, then hard cut
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt < 500) splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < 500) splitAt = maxLen;

    chunks.push(remaining.substring(0, splitAt).trim());
    remaining = remaining.substring(splitAt).trim();
  }

  console.log('CHUNKING: total length', text.length, 'split into', chunks.length, 'chunks');

  for (let i = 0; i < chunks.length; i++) {
    const prefix = i > 0
      ? `📄 (Part ${i + 1} of ${chunks.length})\n\n`
      : `📊 (Part ${i + 1} of ${chunks.length})\n\n`;
    const message = prefix + chunks[i];

    console.log('Sending part', i + 1, 'of', chunks.length, '- length:', chunks[i].length, '- starts:', chunks[i].substring(0, 80).replace(/\n/g, ' '));

    await sendTelegram(message);

    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 4000));
    }
  }

  console.log('All', chunks.length, 'parts sent successfully');
}

const basePrices = {};
// Single source of truth for alert state
const alertState = {
  active: new Map(),       // symbol -> intervalId (daily pump alerts)
  acknowledged: new Set(), // symbols currently acknowledged — suppress re-alerts for 15 min
};
const activeFixedAlerts = new Map(); // symbol -> intervalId for fixed price target alerts (up)
const activeDropAlerts  = new Map(); // symbol -> intervalId for fixed floor/drop alerts (down)
const activeSecondaryAlerts = {}; // `${symbol}:${price}` -> true — fired secondary rec-based alerts
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
const lastRecommendationContext = new Map(); // chatId -> { coins, action, prices, timestamp }
const lastSwingAlertContext = new Map();     // symbol -> { direction: 'pump'|'dip', price, timestamp }
let mostRecentSwingAlert = null;             // { symbol, coinBase, direction, price, timestamp } — for 👍 / natural language
let totalInvestedCapital = 20600; // loaded from DB on startup

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
  if (alertState.active.has(symbol)) {
    clearInterval(alertState.active.get(symbol));
    alertState.active.delete(symbol);
    console.log('[alert] Cleared pump interval for', symbol, 'on threshold change');
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

await db.execute(`CREATE TABLE IF NOT EXISTS price_ranges (
  symbol VARCHAR(50) PRIMARY KEY,
  price_7d_high DECIMAL(20,10),
  price_7d_low DECIMAL(20,10),
  price_7d_avg DECIMAL(20,10),
  price_7d_stddev DECIMAL(20,10),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS intention_tracking (
  id INT AUTO_INCREMENT PRIMARY KEY,
  symbols VARCHAR(200) NOT NULL,
  recommendation VARCHAR(50) NOT NULL,
  prices_at_intention TEXT NOT NULL,
  intention_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  check_date_1 TIMESTAMP NULL,
  check_date_2 TIMESTAMP NULL,
  outcome_1 TEXT NULL,
  outcome_2 TEXT NULL,
  overall_outcome VARCHAR(20) NULL,
  pnl_result DECIMAL(20,6) NULL,
  INDEX idx_intention_date (intention_date),
  INDEX idx_outcomes (check_date_1, check_date_2)
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS invested_capital (
  id INT AUTO_INCREMENT PRIMARY KEY,
  total_invested DECIMAL(20,10) NOT NULL,
  note VARCHAR(200),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`);

// Add direction column to price_targets if it doesn't exist
try {
  await db.execute(`ALTER TABLE price_targets ADD COLUMN direction VARCHAR(4) NOT NULL DEFAULT 'up'`);
  console.log('Added direction column to price_targets');
} catch (e) { /* already exists */ }

// Add note column (stores JSON context for auto-set alerts)
try {
  await db.execute(`ALTER TABLE price_targets ADD COLUMN note TEXT`);
  console.log('Added note column to price_targets');
} catch (e) { /* already exists */ }

// Add acknowledged_until column to custom_thresholds (persists ack status across restarts)
try {
  await db.execute(`ALTER TABLE custom_thresholds ADD COLUMN acknowledged_until TIMESTAMP NULL DEFAULT NULL`);
  console.log('Added acknowledged_until column to custom_thresholds');
} catch (e) { /* already exists */ }

// Load currently acknowledged coins from DB (acknowledged_until > NOW())
try {
  const [ackRows] = await db.execute(`SELECT symbol, acknowledged_until FROM custom_thresholds WHERE acknowledged_until > NOW()`);
  for (const row of ackRows) {
    alertState.acknowledged.add(row.symbol);
    const msLeft = new Date(row.acknowledged_until).getTime() - Date.now();
    if (msLeft > 0) setTimeout(() => {
      alertState.acknowledged.delete(row.symbol);
      console.log('[ack] Acknowledge expired (from DB) for:', row.symbol);
    }, msLeft);
  }
  if (ackRows.length > 0) console.log(`[ack] Loaded ${ackRows.length} acknowledged coin(s) from DB:`, ackRows.map(r => r.symbol).join(', '));
} catch (e) { console.warn('[ack] Could not load acknowledged coins:', e.message); }

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

const [ptRows] = await db.execute('SELECT symbol, anchor_price, threshold_pct, target_price, entry_price, direction, note FROM price_targets');
for (const row of ptRows) {
  priceTargets.set(row.symbol, {
    anchorPrice: parseFloat(row.anchor_price),
    thresholdPct: parseFloat(row.threshold_pct),
    targetPrice: parseFloat(row.target_price),
    entryPrice: row.entry_price ? parseFloat(row.entry_price) : null,
    direction: row.direction || 'up',
    note: row.note || null
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

// Load invested capital — insert initial record on first run
try {
  const [capRows] = await db.execute('SELECT total_invested FROM invested_capital ORDER BY id DESC LIMIT 1');
  if (capRows.length > 0) {
    totalInvestedCapital = parseFloat(capRows[0].total_invested);
    console.log(`Loaded invested capital: $${totalInvestedCapital}`);
  } else {
    await db.execute('INSERT INTO invested_capital (total_invested, note) VALUES (?, ?)', [20600, 'Initial figure set May 2026']);
    totalInvestedCapital = 20600;
    console.log('Inserted initial invested capital: $20600');
  }
} catch (e) {
  console.error('Failed to load invested capital:', e.message);
}

updateLearningModel().catch(() => {});

// ── Invested Capital Helpers ──────────────────────────────────────────────────

function getCapitalSummary(portfolioValue) {
  const invested = totalInvestedCapital;
  const pnl = portfolioValue - invested;
  const pnlPct = invested > 0 ? (pnl / invested * 100) : 0;
  const breakEvenPct = portfolioValue > 0 && pnl < 0 ? ((invested - portfolioValue) / portfolioValue * 100) : 0;
  return { invested, portfolioValue, pnl, pnlPct, breakEvenPct };
}

async function updateInvestedCapital(newTotal, note) {
  totalInvestedCapital = newTotal;
  await db.execute('INSERT INTO invested_capital (total_invested, note) VALUES (?, ?)', [newTotal, note || null]);
}

function fmtCapitalConfirm(cap, portfolioValue) {
  const pnlSign = cap.pnl >= 0 ? '+' : '';
  const breakEvenStr = cap.pnl < 0
    ? `\n📈 Need +${cap.breakEvenPct.toFixed(1)}% to break even`
    : `\n✅ Portfolio is +${Math.abs(cap.pnlPct).toFixed(1)}% above cost basis`;
  return `✅ Invested capital updated:\n` +
    `💰 Total Invested: $${cap.invested.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n` +
    `📊 Current Portfolio: $${portfolioValue.toFixed(0)}\n` +
    `📉 P&L: ${pnlSign}$${Math.abs(cap.pnl).toFixed(0)} (${pnlSign}${cap.pnlPct.toFixed(1)}%)` +
    breakEvenStr;
}

async function getCurrentPortfolioValue() {
  try {
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
    let total = 0;
    for (const asset of balances) {
      if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
      const qty = parseFloat(asset.available);
      if (qty <= 0) continue;
      const price = priceMap[`${asset.currency}-USD`];
      if (price) total += qty * price;
    }
    return total;
  } catch (e) { return 0; }
}

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

async function setFixedTarget(symbol, thresholdPct, direction = 'up', note = null) {
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
  const targetPrice = direction === 'down'
    ? anchorPrice * (1 - thresholdPct / 100)
    : anchorPrice * (1 + thresholdPct / 100);
  await db.execute(
    'INSERT INTO price_targets (symbol, anchor_price, threshold_pct, target_price, direction, note) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE anchor_price=VALUES(anchor_price), threshold_pct=VALUES(threshold_pct), target_price=VALUES(target_price), direction=VALUES(direction), note=VALUES(note), updated_at=CURRENT_TIMESTAMP',
    [symbol, anchorPrice, thresholdPct, targetPrice, direction, note]
  );
  const existing = priceTargets.get(symbol) || {};
  priceTargets.set(symbol, { ...existing, anchorPrice, thresholdPct, targetPrice, direction, note });
  return { anchorPrice, thresholdPct, targetPrice, direction };
}

// Set a price target using an absolute dollar level rather than a % threshold
async function setAbsolutePriceTarget(symbol, absoluteTargetPrice, direction = 'down', note = null) {
  const currentPrice = await getCurrentPrice(symbol);
  if (!currentPrice) throw new Error(`No price for ${symbol}`);
  const thresholdPct = Math.abs((absoluteTargetPrice - currentPrice) / currentPrice * 100);
  await db.execute(
    'INSERT INTO price_targets (symbol, anchor_price, threshold_pct, target_price, direction, note) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE anchor_price=VALUES(anchor_price), threshold_pct=VALUES(threshold_pct), target_price=VALUES(target_price), direction=VALUES(direction), note=VALUES(note), updated_at=CURRENT_TIMESTAMP',
    [symbol, currentPrice, thresholdPct, absoluteTargetPrice, direction, note]
  );
  const existing = priceTargets.get(symbol) || {};
  priceTargets.set(symbol, { ...existing, anchorPrice: currentPrice, thresholdPct, targetPrice: absoluteTargetPrice, direction, note });
  return { anchorPrice: currentPrice, thresholdPct, targetPrice: absoluteTargetPrice, direction };
}

// Extract recommended price levels from a Claude reply.
// Returns [{price, type: 'buy'|'sell'|'neutral', snippet}]
function extractRecommendedPriceLevels(text) {
  if (!text) return [];
  const results = [];
  const seen = new Set();

  const addPrice = (raw, raw2, type, re) => {
    for (const r of [raw, raw2]) {
      if (!r) continue;
      const p = parseFloat(r.replace(/,/g, ''));
      if (p > 0 && p < 10_000_000 && !seen.has(p)) {
        seen.add(p);
        results.push({ price: p, type });
      }
    }
  };

  // Each entry: [regex, type]. Group 1 = price, optional group 2 = range end.
  const patterns = [
    // ── BUY-side ─────────────────────────────────────────────────────────────
    [/(?:buy|add|accumulate|load(?:ing)?|pick(?:ing)?\s+up)\s+(?:more\s+)?(?:at|around|near|below|under|if\s+(?:it\s+)?dips?\s+to)\s+\$?([\d,]+(?:\.\d+)?)\s*(?:-|to)\s*\$?([\d,]+(?:\.\d+)?)/gi, 'buy'],
    [/(?:buy|add|accumulate|load(?:ing)?|pick(?:ing)?\s+up)\s+(?:more\s+)?(?:at|around|near|below|under|if\s+(?:it\s+)?dips?\s+to)\s+\$?([\d,]+(?:\.\d+)?)/gi, 'buy'],
    [/good\s+(?:add|buy|entry|accumulation)\s+(?:point\s+)?(?:at|around|near|below)?\s*\$?([\d,]+(?:\.\d+)?)\s*(?:-|to)\s*\$?([\d,]+(?:\.\d+)?)/gi, 'buy'],
    [/good\s+(?:add|buy|entry|accumulation)\s+(?:point\s+)?(?:at|around|near|below)?\s*\$?([\d,]+(?:\.\d+)?)/gi, 'buy'],
    [/(?:support|floor|key\s+(?:support|level))\s+(?:at|around|near)?\s*\$?([\d,]+(?:\.\d+)?)/gi, 'buy'],
    [/\$?([\d,]+(?:\.\d+)?)\s+(?:support|floor|add\s+zone|buy\s+zone)/gi, 'buy'],
    [/(?:dip\s+to|retrace\s+to|pullback\s+to)\s+\$?([\d,]+(?:\.\d+)?)\s*(?:-|to)?\s*\$?([\d,]+(?:\.\d+)?)/gi, 'buy'],
    // ── SELL-side ─────────────────────────────────────────────────────────────
    [/(?:take\s+profits?|taking\s+profits?)\s+(?:at|around|near|above|if\s+it\s+reaches?)\s+\$?([\d,]+(?:\.\d+)?)\s*(?:-|to)\s*\$?([\d,]+(?:\.\d+)?)/gi, 'sell'],
    [/(?:take\s+profits?|taking\s+profits?)\s+(?:at|around|near|above|if\s+it\s+reaches?)\s+\$?([\d,]+(?:\.\d+)?)/gi, 'sell'],
    [/(?:sell|exit|unload)\s+(?:at|around|near|above|if\s+it\s+(?:hits?|reaches?))\s+\$?([\d,]+(?:\.\d+)?)\s*(?:-|to)\s*\$?([\d,]+(?:\.\d+)?)/gi, 'sell'],
    [/(?:sell|exit|unload)\s+(?:at|around|near|above|if\s+it\s+(?:hits?|reaches?))\s+\$?([\d,]+(?:\.\d+)?)/gi, 'sell'],
    [/consider\s+(?:selling|taking\s+profits?|exiting)\s+(?:at|around|near|if\s+it\s+(?:hits?|reaches?))?\s+\$?([\d,]+(?:\.\d+)?)\s*(?:-|to)\s*\$?([\d,]+(?:\.\d+)?)/gi, 'sell'],
    [/consider\s+(?:selling|taking\s+profits?|exiting)\s+(?:at|around|near|if\s+it\s+(?:hits?|reaches?))?\s+\$?([\d,]+(?:\.\d+)?)/gi, 'sell'],
    [/(?:resistance|profit\s+(?:zone|target|level)|sell\s+zone)\s+(?:at|around|near)?\s*\$?([\d,]+(?:\.\d+)?)\s*(?:-|to)\s*\$?([\d,]+(?:\.\d+)?)/gi, 'sell'],
    [/(?:resistance|profit\s+(?:zone|target|level)|sell\s+zone)\s+(?:at|around|near)?\s*\$?([\d,]+(?:\.\d+)?)/gi, 'sell'],
    [/\$?([\d,]+(?:\.\d+)?)\s+(?:resistance|profit\s+zone|sell\s+zone|exit\s+(?:zone|point|level))/gi, 'sell'],
    [/(?:price\s+)?target\s+(?:of\s+|at\s+)?\$?([\d,]+(?:\.\d+)?)\s*(?:-|to)\s*\$?([\d,]+(?:\.\d+)?)/gi, 'sell'],
    [/(?:price\s+)?target\s+(?:of\s+|at\s+)?\$?([\d,]+(?:\.\d+)?)/gi, 'sell'],
    // ── NEUTRAL (type inferred from price vs current later) ───────────────────
    [/(?:set\s+)?(?:an?\s+)?alert\s+(?:at|if\s+(?:it\s+)?(?:drops?\s+to|reaches?))\s+\$?([\d,]+(?:\.\d+)?)\s*(?:-|to)\s*\$?([\d,]+(?:\.\d+)?)/gi, 'neutral'],
    [/(?:set\s+)?(?:an?\s+)?alert\s+(?:at|if\s+(?:it\s+)?(?:drops?\s+to|reaches?))\s+\$?([\d,]+(?:\.\d+)?)/gi, 'neutral'],
    [/watch\s+(?:(?:the\s+)?(?:level|price|for)\s+)?\$?([\d,]+(?:\.\d+)?)/gi, 'neutral'],
  ];

  for (const [re, type] of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) addPrice(m[1], m[2], type);
  }
  return results.sort((a, b) => a.price - b.price);
}

// Single acknowledge function — used by BOTH Telegram command and dashboard API
// Clears ALL interval types for the symbol and suppresses re-alerts for 15 minutes
async function acknowledgeAlert(symbol) {
  console.log('[ack] Acknowledging:', symbol);

  // Mark as acknowledged — blocks all new alerts for this symbol
  alertState.acknowledged.add(symbol);

  // Clear pump alert interval
  if (alertState.active.has(symbol)) {
    clearInterval(alertState.active.get(symbol));
    alertState.active.delete(symbol);
    console.log('[ack] Cleared pump interval for:', symbol);
  }

  // Clear drop alert interval
  if (activeDropAlerts.has(symbol)) {
    clearInterval(activeDropAlerts.get(symbol));
    activeDropAlerts.delete(symbol);
    console.log('[ack] Cleared drop interval for:', symbol);
  }

  // Clear fixed target/floor interval
  if (activeFixedAlerts.has(symbol)) {
    clearInterval(activeFixedAlerts.get(symbol));
    activeFixedAlerts.delete(symbol);
    console.log('[ack] Cleared fixed target interval for:', symbol);
  }

  // Persist acknowledged_until to DB so it survives restarts
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  try {
    await db.execute(
      `INSERT INTO custom_thresholds (symbol, threshold, acknowledged_until) VALUES (?, 0.05, ?)
       ON DUPLICATE KEY UPDATE acknowledged_until = VALUES(acknowledged_until)`,
      [symbol, expiresAt]
    );
  } catch (e) { console.warn('[ack] DB persist failed for', symbol, ':', e.message); }

  // Auto-expire after 15 minutes
  setTimeout(() => {
    alertState.acknowledged.delete(symbol);
    console.log('[ack] Acknowledge expired for:', symbol);
  }, 15 * 60 * 1000);

  console.log('[ack] Complete for:', symbol,
    '| Active pump:', alertState.active.size,
    '| Active drop:', activeDropAlerts.size,
    '| Active fixed:', activeFixedAlerts.size);
}

// Quick price formatter for alert messages
function fmtPriceShort(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1)    return '$' + n.toFixed(4);
  return '$' + n.toPrecision(4);
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

    const dateStr = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });

    // ── Format helpers ──────────────────────────────────────────────────────
    const fmtAmt  = (n) => '$' + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
    const fmtPrc  = (n) => n >= 1 ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '$' + n.toPrecision(4);

    // ── Capital P&L lines ───────────────────────────────────────────────────
    let capitalLine = '';
    let breakEvenLine = '';
    try {
      const cap = getCapitalSummary(totalUSD);
      const pnlSign = cap.pnl >= 0 ? '+' : '-';
      capitalLine = `\n💰 Invested: ${fmtAmt(cap.invested)} | P&L: ${pnlSign}${fmtAmt(cap.pnl)} (${pnlSign}${Math.abs(cap.pnlPct).toFixed(1)}%)`;
      breakEvenLine = cap.pnl < 0
        ? `\n📈 Need +${cap.breakEvenPct.toFixed(1)}% to break even`
        : `\n✅ Portfolio in profit`;
    } catch (e) { /* ignore */ }

    // ── Top 5 holdings ──────────────────────────────────────────────────────
    const BRIEFING_MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    const topHoldings = holdings.slice(0, 5).map((h, i) => {
      const pct = ((h.valueUSD / totalUSD) * 100).toFixed(0);
      const overnightStr = h.overnightChange !== null
        ? ` ${h.overnightChange >= 0 ? '+' : ''}${h.overnightChange.toFixed(1)}%`
        : '';
      return `${BRIEFING_MEDALS[i]} ${h.coin} ${fmtPrc(h.price)} — ${fmtAmt(h.valueUSD)} (${pct}%)${overnightStr}`;
    }).join('\n');

    // ── Alerts to watch ─────────────────────────────────────────────────────
    const alertsToWatch = [];
    for (const h of holdings) {
      const threshold = customThresholds[h.symbol] !== undefined ? customThresholds[h.symbol] : PUMP_THRESHOLD;
      if (basePrices[h.symbol]) {
        const change = (h.price - basePrices[h.symbol]) / basePrices[h.symbol];
        const pctOfThreshold = change / threshold;
        if (pctOfThreshold >= 0.7 && !alertState.active.has(h.symbol)) {
          alertsToWatch.push(`${h.coin}: ${(change * 100).toFixed(1)}% move (alert at ${(threshold * 100).toFixed(0)}%)`);
        }
      }
      const target = priceTargets.get(h.symbol);
      if (target) {
        const distPct = Math.abs((h.price - target.targetPrice) / target.targetPrice) * 100;
        if (distPct <= 5) {
          const dir = target.direction === 'down' ? 'floor' : 'target';
          alertsToWatch.push(`${h.coin}: within ${distPct.toFixed(1)}% of fixed ${dir} ${fmtPrc(target.targetPrice)}`);
        }
      }
    }
    const alertsBlock = alertsToWatch.length > 0 ? alertsToWatch.join('\n') : 'All clear ✅';

    // ── Recent outcomes + weekly stats ──────────────────────────────────────
    let recentOutcomesBlock = '';
    let weeklyPnlBlock = '';
    try {
      const [recentOutcomes] = await db.execute(
        "SELECT symbol, outcome, outcome_pnl FROM trading_journal WHERE outcome IS NOT NULL AND action != 'payment' AND updated_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) ORDER BY updated_at DESC LIMIT 5"
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

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // MESSAGE 1 — PORTFOLIO SNAPSHOT (no Claude API, instant)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const msg1 =
      `🌅 <b>GOOD MORNING BRYAN!</b>\n` +
      `📅 ${dateStr} | Portfolio: <b>${fmtAmt(totalUSD)}</b>` +
      capitalLine + breakEvenLine + `\n\n` +
      `📊 <b>TOP HOLDINGS:</b>\n${topHoldings}\n\n` +
      `🚨 <b>ALERTS:</b> ${alertsBlock}` +
      recentOutcomesBlock + weeklyPnlBlock;

    await sendTelegram(msg1);
    console.log('Morning snapshot sent. Length:', msg1.length);

    // ── 5-second delay before market intelligence ───────────────────────────
    await new Promise(resolve => setTimeout(resolve, 5000));

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // MESSAGE 2 — MARKET INTELLIGENCE (Claude + web search)
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const portfolioContext = holdings.slice(0, 5).map(h => {
      const overnight = h.overnightChange !== null ? ` overnight:${h.overnightChange.toFixed(1)}%` : '';
      const pl = h.plPct !== null ? ` P&L:${h.plPct.toFixed(1)}%` : '';
      return `${h.coin} ${fmtPrc(h.price)} ${fmtAmt(h.valueUSD)}${overnight}${pl}`;
    }).join(', ');

    const claudeResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role: 'user',
        content: `Generate a concise morning market intelligence briefing.
Today is ${dateStr}. Search for latest crypto news.
Bryan's top holdings: ${portfolioContext}. Total portfolio: ${fmtAmt(totalUSD)}.

Format EXACTLY like this:
📰 MARKET BRIEFING — ${dateStr}

🌍 MACRO:
- BTC: $[price] — [1 sentence on trend]
- Market: [1 sentence on overall sentiment]
- Key level: [most important level to watch]

📰 TOP NEWS:
- [headline 1 — 1 line]
- [headline 2 — 1 line]
- [headline 3 — 1 line]

⚡ TODAY'S PLAN:
1. [Specific action for Bryan's portfolio]
2. [Specific action]
3. [Key thing to watch]

🎯 FOCUS: [One coin from Bryan's holdings to pay most attention to today and why — 2 sentences max]

Keep total under 3000 characters. No long paragraphs. Be concise.`
      }]
    });

    const lastTextBlock = [...claudeResponse.content].reverse().find(b => b.type === 'text');
    const msg2 = lastTextBlock ? lastTextBlock.text.trim() : '📰 Market intelligence unavailable — check crypto news manually.';

    await sendTelegram(msg2);
    console.log('Market intelligence sent. Length:', msg2.length);

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

    // Intention tracking accuracy
    try {
      const [allIntentions] = await db.execute('SELECT * FROM intention_tracking');
      const completed = allIntentions.filter(i => i.pnl_result != null);
      if (allIntentions.length > 0) {
        summary += `- Commitments logged: ${allIntentions.length} (${completed.length} with outcomes)\n`;
        if (completed.length > 0) {
          const profitable = completed.filter(i => parseFloat(i.pnl_result) > 0);
          const intentionAccuracy = Math.round(profitable.length / completed.length * 100);
          const avgPnl = (completed.reduce((s, i) => s + parseFloat(i.pnl_result), 0) / completed.length).toFixed(1);
          summary += `- Advice accuracy when followed: ${intentionAccuracy}% profitable | Avg P&L: ${avgPnl >= 0 ? '+' : ''}${avgPnl}%\n`;
        }
      }
    } catch (e) { /* ignore */ }

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

    // Recent trading intentions
    const [intentions] = await db.execute(
      'SELECT * FROM intention_tracking ORDER BY intention_date DESC LIMIT 5'
    );
    if (intentions.length > 0) {
      context += 'Recent trading intentions Bryan committed to:\n';
      for (const intent of intentions) {
        const prices = JSON.parse(intent.prices_at_intention || '{}');
        const priceStr = Object.entries(prices).map(([c, p]) => `${c} $${parseFloat(p).toFixed(4)}`).join(', ');
        const statusStr = intent.overall_outcome ? `— outcome: ${intent.overall_outcome}` :
          intent.check_date_1 ? '— 7-day checked, 30-day pending' : '— 7-day check pending';
        const dateStr = new Date(intent.intention_date).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
        context += `• ${dateStr}: Decided to ${intent.recommendation} ${intent.symbols} (${priceStr}) ${statusStr}\n`;
      }
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

// ── Intention Tracking ───────────────────────────────────────────────────────

function detectIntention(text) {
  const trimmed = text.trim();
  return (
    /[\u{1F44D}\u{1F44E}\u{1F44D}\u{1F44D}\u{1F44D}\u{1F44D}]/u.test(text) ||  // 👍 any skin tone variant
    /\u{1F919}/u.test(text) ||  // 🤙
    /✅/.test(text) ||
    /^(?:yes|agreed|ok will do|sounds good|perfect|great|makes sense)\.?$/i.test(trimmed) ||
    /\bi'?(?:ll|m going to|m gonna)\s+(?:hold|buy|sell|follow|keep|add|reduce|stay)/i.test(text) ||
    /\bwill\s+(?:hold|buy|sell|follow|keep|add|reduce|stay)/i.test(text) ||
    /\bgood\s+advice\b/i.test(text) ||
    /\bmakes?\s+sense\b/i.test(text) ||
    /\bi\s+agree\b/i.test(text) ||
    /\bgoing\s+to\s+follow\b/i.test(text) ||
    /\bfollowing\s+(?:your|that|this|claude'?s?)\s+advice\b/i.test(text) ||
    /\bholding\s+(?:both|all|it|them)\b/i.test(text) ||
    /\bwill\s+follow\s+(?:that|this|your)\b/i.test(text)
  );
}

function extractIntentionDetails(text) {
  let action = 'HOLD';
  if (/\b(?:sell|selling)\b/i.test(text)) action = 'SELL';
  else if (/\b(?:buy|buying|add|adding)\b/i.test(text)) action = 'BUY';
  else if (/\b(?:reduce|reducing)\b/i.test(text)) action = 'REDUCE';

  const coins = [];
  for (const m of text.matchAll(/\b([A-Z]{2,10})\b/g)) {
    if (!SKIP_WORDS.has(m[1]) && !['USD', 'USDT', 'USDC', 'EUR', 'GBP'].includes(m[1])) {
      coins.push(m[1]);
    }
  }
  return { action, coins: [...new Set(coins)] };
}

async function checkIntentionOutcomes() {
  try {
    const now = new Date();

    // 7-day check
    const [sevenDay] = await db.execute(
      'SELECT * FROM intention_tracking WHERE check_date_1 IS NULL AND intention_date < DATE_SUB(NOW(), INTERVAL 7 DAY)'
    );
    for (const intent of sevenDay) {
      try {
        const coins = intent.symbols.split(',').map(s => s.trim());
        const prices = JSON.parse(intent.prices_at_intention);
        const lines = [];
        let totalPnl = 0, count = 0;

        for (const coin of coins) {
          const currentPrice = await getCurrentPrice(`${coin}-USD`).catch(() => null);
          if (!currentPrice || !prices[coin]) continue;
          const pnlPct = ((currentPrice - prices[coin]) / prices[coin]) * 100;
          totalPnl += pnlPct;
          count++;
          const emoji = pnlPct >= 0 ? '✅' : '❌';
          lines.push(`${coin}: $${parseFloat(prices[coin]).toFixed(4)} → $${currentPrice.toFixed(4)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%) ${emoji}`);
        }

        const avgPnl = count > 0 ? totalPnl / count : 0;
        const outcomeText = lines.join('\n');
        const wasGood = avgPnl > 0;

        await db.execute(
          'UPDATE intention_tracking SET check_date_1 = NOW(), outcome_1 = ?, pnl_result = ? WHERE id = ?',
          [outcomeText, avgPnl.toFixed(4), intent.id]
        );

        const tailMsg = wasGood
          ? `Following Claude's advice was the right call! 🎉\nLearning model updated.`
          : `This one didn't play out as hoped. Learning model updated — every data point helps.`;

        await sendTelegram(
          `📊 <b>ADVICE FOLLOW-UP — 7 days ago you decided to ${intent.recommendation} ${coins.join(' & ')}</b>\n` +
          `${outcomeText}\n\n${tailMsg}`
        );
        await updateLearningModel().catch(() => {});
      } catch (e) { console.error('7-day intention check error:', e.message); }
    }

    // 30-day check
    const [thirtyDay] = await db.execute(
      'SELECT * FROM intention_tracking WHERE check_date_2 IS NULL AND check_date_1 IS NOT NULL AND intention_date < DATE_SUB(NOW(), INTERVAL 30 DAY)'
    );
    for (const intent of thirtyDay) {
      try {
        const coins = intent.symbols.split(',').map(s => s.trim());
        const prices = JSON.parse(intent.prices_at_intention);
        const lines = [];
        let totalPnl = 0, count = 0;

        for (const coin of coins) {
          const currentPrice = await getCurrentPrice(`${coin}-USD`).catch(() => null);
          if (!currentPrice || !prices[coin]) continue;
          const pnlPct = ((currentPrice - prices[coin]) / prices[coin]) * 100;
          totalPnl += pnlPct;
          count++;
          const emoji = pnlPct >= 0 ? '✅' : '❌';
          lines.push(`${coin}: $${parseFloat(prices[coin]).toFixed(4)} → $${currentPrice.toFixed(4)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%) ${emoji}`);
        }

        const avgPnl = count > 0 ? totalPnl / count : 0;
        const outcomeText = lines.join('\n');
        const overallOutcome = avgPnl > 2 ? 'profit' : avgPnl < -2 ? 'loss' : 'breakeven';

        await db.execute(
          'UPDATE intention_tracking SET check_date_2 = NOW(), outcome_2 = ?, overall_outcome = ? WHERE id = ?',
          [outcomeText, overallOutcome, intent.id]
        );

        await sendTelegram(
          `📊 <b>30-DAY FOLLOW-UP — ${intent.recommendation} ${coins.join(' & ')}</b>\n` +
          `${outcomeText}\n\n` +
          `Overall: <b>${overallOutcome.toUpperCase()}</b> (avg ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(1)}%)\n` +
          `Learning model updated 🧠`
        );
        await updateLearningModel().catch(() => {});
      } catch (e) { console.error('30-day intention check error:', e.message); }
    }
  } catch (e) {
    console.error('checkIntentionOutcomes error:', e.message);
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
      if (alertState.active.has(symbol) && lastBalances[symbol] && available < lastBalances[symbol] * 0.9) {
        console.log('[alert] Position reduced for', symbol, '— stopping pump alert');
        clearInterval(alertState.active.get(symbol));
        alertState.active.delete(symbol);
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
      if (change >= threshold && !alertState.active.has(symbol) && !alertState.acknowledged.has(symbol)) {
        const pct = (change * 100).toFixed(1);
        const coinBase = asset.currency;
        const aiRec = await getQuickAiRecommendation(symbol, change * 100, currentPrice, 'up');
        const replyMenu = `\n\nReply:\n'sell ${coinBase}' - get sell advice\n'buy more ${coinBase}' - get buy advice\n'analyse ${coinBase}' - full analysis\n'acknowledge ${coinBase}' - stop alerts`;
        const swingPumpHint = `\n\n⚡ SWING SIGNAL: This pump may be your sell opportunity!\nCheck if this is outside normal range — if so, consider taking profits and setting a buy-back alert at ${fmtPriceShort(currentPrice * 0.85)} (-15%)`;
        const alertMessage = `📈 <b>${symbol} DAILY PUMP ALERT</b>\n\nBaseline: $${basePrices[symbol].toFixed(4)} → Now $${currentPrice.toFixed(4)} (+${pct}%)\nYou hold: ${available} ${coinBase}\n\n⚡ RECOMMENDATION: ${aiRec}${swingPumpHint}${replyMenu}`;
        await sendTelegram(alertMessage);

        alertState.active.set(symbol, setInterval(async () => {
          if (alertState.acknowledged.has(symbol)) {
            console.log('[alert] Pump reminder skipped — recently acknowledged:', symbol);
            clearInterval(alertState.active.get(symbol));
            alertState.active.delete(symbol);
            return;
          }
          console.log('[alert] Sending pump reminder for:', symbol);
          await sendTelegram(`⚠️ <b>REMINDER: ${symbol} DAILY PUMP ALERT still active!</b>\n\nStill up ${pct}% from baseline\nReply 'acknowledge ${coinBase}' to stop`);
        }, ALERT_INTERVAL_MS));
      }

      // Trigger baseline drop alert
      if (change <= -threshold && !activeDropAlerts.has(symbol) && !alertState.acknowledged.has(symbol)) {
        const pct = (Math.abs(change) * 100).toFixed(1);
        const coinBase = asset.currency;
        const aiRec = await getQuickAiRecommendation(symbol, change * 100, currentPrice, 'down');
        const replyMenu = `\n\nReply:\n'buy more ${coinBase}' - get buy the dip advice\n'sell ${coinBase}' - get sell advice\n'analyse ${coinBase}' - full analysis\n'acknowledge ${coinBase}' - stop alerts`;
        const swingDropHint = `\n\n⚡ SWING SIGNAL: This drop may be your buy opportunity!\nCheck if this is outside normal range — if so, consider buying the dip and setting a sell alert at ${fmtPriceShort(currentPrice * 1.20)} (+20%)`;
        const alertMessage = `📉 <b>${symbol} DROP ALERT!</b>\n\nBaseline: $${basePrices[symbol].toFixed(4)} → Now $${currentPrice.toFixed(4)} (-${pct}%)\nYou hold: ${available} ${coinBase}\n\n⚡ RECOMMENDATION: ${aiRec}${swingDropHint}${replyMenu}`;
        await sendTelegram(alertMessage);

        activeDropAlerts.set(symbol, setInterval(async () => {
          if (alertState.acknowledged.has(symbol)) {
            console.log('[alert] Drop reminder skipped — recently acknowledged:', symbol);
            clearInterval(activeDropAlerts.get(symbol));
            activeDropAlerts.delete(symbol);
            return;
          }
          console.log('[alert] Sending drop reminder for:', symbol);
          await sendTelegram(`⚠️ <b>REMINDER: ${symbol} DROP ALERT still active!</b>\n\nStill down ${pct}% from baseline\nReply 'acknowledge ${coinBase}' to stop`);
        }, ALERT_INTERVAL_MS));
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

      if (direction === 'up' && currentPrice >= target.targetPrice && !activeFixedAlerts.has(symbol) && !alertState.acknowledged.has(symbol)) {
        const changePct = ((currentPrice - target.anchorPrice) / target.anchorPrice) * 100;
        const coinBase = symbol.replace('-USD', '');

        // Check if this is a dust coin (balance < $5)
        const assetBalance = balances.find(a => a.currency === coinBase);
        const assetQty = assetBalance ? parseFloat(assetBalance.available) : 0;
        const assetValueUSD = assetQty * currentPrice;
        const isDustCoin = assetValueUSD > 0 && assetValueUSD < 5;

        const aiRec = await getQuickAiRecommendation(symbol, changePct, currentPrice, 'up');
        const priceStr = currentPrice < 0.001 ? currentPrice.toFixed(8) : currentPrice.toFixed(4);
        const anchorStr = target.anchorPrice < 0.001 ? target.anchorPrice.toFixed(8) : target.anchorPrice.toFixed(4);
        const entryPrice = entryPrices.get(symbol) || target.entryPrice;
        const entryLine = entryPrice && !isDustCoin
          ? `\nEntry: $${entryPrice.toFixed(4)} | P&L: +${((currentPrice - entryPrice) / entryPrice * 100).toFixed(1)}%`
          : '';

        let alertMessage;
        // Check if this was auto-set from a Claude sell recommendation
        let upNoteData = null;
        try { if (target.note) upNoteData = JSON.parse(target.note); } catch (e) {}

        if (isDustCoin) {
          const newValueStr = `$${assetValueUSD.toFixed(2)}`;
          alertMessage =
            `🔍 <b>DUST COIN ALERT — ${coinBase}</b>\n` +
            `Up ${changePct.toFixed(1)}% from your watch price!\n` +
            `Current: $${priceStr} | Watch set at: $${anchorStr}\n` +
            `You hold: ${assetQty.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${coinBase} = ${newValueStr} at current price\n\n` +
            `💡 Worth buying more? Reply 'analyse ${coinBase}' for full research`;
        } else if (upNoteData && upNoteData.source === 'claude_rec') {
          // Enhanced sell alert — this level was set by thumbs-up on a Claude recommendation
          const positionLine = entryPrice && assetQty > 0
            ? `Your position: ${assetQty.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${coinBase} @ $${entryPrice.toFixed(4)} entry\nUnrealised profit: +${((currentPrice - entryPrice) / entryPrice * 100).toFixed(1)}% (+$${Math.abs((currentPrice - entryPrice) * assetQty).toFixed(2)})`
            : (assetQty > 0 ? `You hold ${assetQty.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${coinBase}` : '');
          alertMessage =
            `🎯 <b>${coinBase} HIT YOUR PROFIT TARGET!</b>\n\n` +
            `Price: $${priceStr} (your Claude-recommended sell zone)\n` +
            `Original advice: '<i>${upNoteData.snippet}</i>'\n` +
            (positionLine ? positionLine + '\n' : '') +
            `\n⚡ <b>RECOMMENDATION:</b> This is your planned profit zone.\n` +
            `Take action? Reply:\n` +
            `'sold ${coinBase} [price] [qty]' — log the sale\n` +
            `'analyse ${coinBase}' — get fresh analysis before deciding\n` +
            `'hold ${coinBase}' — log decision to hold through this level`;
        } else {
          const replyMenu = `\n\nReply:\n'sell ${coinBase}' - get sell advice\n'buy more ${coinBase}' - get buy advice\n'analyse ${coinBase}' - full analysis\n'acknowledge ${coinBase}' - stop alerts\n'threshold ${coinBase} 15%' - change threshold`;
          const autoReady = await getAutomationReadiness(symbol, 'buy');
          const autoLine = autoReady ? `\n\n⚡ AUTO-READY: This setup has worked ${autoReady.winRate}% of the time (${autoReady.sampleSize} trades). Could be automated.` : '';
          alertMessage = `🎯 <b>${symbol} FIXED TARGET HIT!</b>\n\nAnchor: $${anchorStr} → Now $${priceStr} (+${changePct.toFixed(1)}%)${entryLine}\n\n⚡ RECOMMENDATION: ${aiRec}${replyMenu}${autoLine}`;
        }
        await sendTelegram(alertMessage);

        activeFixedAlerts.set(symbol, setInterval(async () => {
          if (alertState.acknowledged.has(symbol)) {
            console.log('[alert] Fixed-target reminder skipped — recently acknowledged:', symbol);
            clearInterval(activeFixedAlerts.get(symbol));
            activeFixedAlerts.delete(symbol);
            return;
          }
          console.log('[alert] Sending fixed-target reminder for:', symbol);
          await sendTelegram(`⚠️ <b>REMINDER: ${symbol} FIXED TARGET STILL ACTIVE!</b>\n\nTarget: $${target.targetPrice.toFixed(4)} | Now: $${currentPrice.toFixed(4)}\nReply 'acknowledge ${coinBase}' to stop`);
        }, ALERT_INTERVAL_MS));
      }

      if (direction === 'down' && currentPrice <= target.targetPrice && !activeFixedAlerts.has(symbol) && !alertState.acknowledged.has(symbol)) {
        const changePct = ((currentPrice - target.anchorPrice) / target.anchorPrice) * 100;
        const coinBase = symbol.replace('-USD', '');
        const entryPrice = entryPrices.get(symbol) || target.entryPrice;
        const plPct = entryPrice ? ((currentPrice - entryPrice) / entryPrice * 100).toFixed(1) : null;
        const replyMenu = `\n\nReply:\n'buy more ${coinBase}' - get buy the dip advice\n'sell ${coinBase}' - get sell advice\n'analyse ${coinBase}' - full analysis\n'acknowledge ${coinBase}' - stop alerts`;

        let alertMessage;
        let noteData = null;
        try { if (target.note) noteData = JSON.parse(target.note); } catch (e) {}

        if (noteData && noteData.source === 'claude_rec') {
          // Enhanced message: this was auto-set from Bryan's thumbs-up on a recommendation
          const assetBalance = balances.find(a => a.currency === coinBase);
          const qty = assetBalance ? parseFloat(assetBalance.available) : 0;
          const positionLine = entryPrice && qty > 0
            ? `Your current position: ${qty.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${coinBase} @ $${entryPrice.toFixed(4)} entry (P&L: ${plPct}%)`
            : (qty > 0 ? `You hold: ${qty.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${coinBase}` : '');
          alertMessage =
            `📊 <b>${coinBase} HIT YOUR BUY LEVEL!</b>\n\n` +
            `Price: $${currentPrice.toFixed(4)} (your Claude-recommended buy zone)\n` +
            `Original advice: '<i>${noteData.snippet}</i>'\n` +
            (positionLine ? positionLine + '\n' : '') +
            `\n⚡ <b>RECOMMENDATION:</b> This is your planned buy zone.\n` +
            `Ready to add? Reply 'bought ${coinBase} [price] [qty]' to log the trade.` +
            replyMenu;
        } else {
          const aiRec = await getQuickAiRecommendation(symbol, changePct, currentPrice, 'down');
          const entryLine = plPct !== null ? `\nEntry: $${entryPrice.toFixed(4)} | P&L: ${plPct}%` : '';
          const autoReady = await getAutomationReadiness(symbol, 'sell');
          const autoLine = autoReady ? `\n\n⚡ AUTO-READY: This setup has worked ${autoReady.winRate}% of the time (${autoReady.sampleSize} trades). Could be automated.` : '';
          alertMessage = `📉 <b>${symbol} FIXED FLOOR HIT!</b>\n\nAnchor: $${target.anchorPrice.toFixed(4)} → Now $${currentPrice.toFixed(4)} (${changePct.toFixed(1)}%)${entryLine}\n\n⚡ RECOMMENDATION: ${aiRec}${replyMenu}${autoLine}`;
        }
        await sendTelegram(alertMessage);

        activeFixedAlerts.set(symbol, setInterval(async () => {
          if (alertState.acknowledged.has(symbol)) {
            console.log('[alert] Fixed-floor reminder skipped — recently acknowledged:', symbol);
            clearInterval(activeFixedAlerts.get(symbol));
            activeFixedAlerts.delete(symbol);
            return;
          }
          console.log('[alert] Sending fixed-floor reminder for:', symbol);
          await sendTelegram(`⚠️ <b>REMINDER: ${symbol} FIXED FLOOR STILL ACTIVE!</b>\n\nFloor: $${target.targetPrice.toFixed(4)} | Now: $${currentPrice.toFixed(4)}\nReply 'acknowledge ${coinBase}' to stop`);
        }, ALERT_INTERVAL_MS));
      }
    }
    // ── Extreme move detection (swing trade signals) ──────────────────────────
    // Update 7-day price ranges and flag extreme moves outside normal trading range
    const extremeMoveThreshold = 0.15; // 15% outside 7-day average = extreme
    const extremeAlertsSent = {};
    try {
      for (const asset of balances) {
        if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
        const symbol = `${asset.currency}-USD`;
        const currentPrice = priceMap[symbol];
        if (!currentPrice) continue;

        // Get 7-day price history
        const [histRows] = await db.execute(
          'SELECT price, recorded_at FROM price_history WHERE symbol = ? AND recorded_at >= DATE_SUB(NOW(), INTERVAL 7 DAY) ORDER BY recorded_at ASC',
          [symbol]
        ).catch(() => [[]]);
        if (histRows.length < 3) continue; // need enough data

        const prices7d = histRows.map(r => parseFloat(r.price));
        const avg = prices7d.reduce((s, p) => s + p, 0) / prices7d.length;
        const high = Math.max(...prices7d);
        const low  = Math.min(...prices7d);
        const variance = prices7d.reduce((s, p) => s + Math.pow(p - avg, 2), 0) / prices7d.length;
        const stddev = Math.sqrt(variance);

        // Update price_ranges table
        await db.execute(
          'INSERT INTO price_ranges (symbol, price_7d_high, price_7d_low, price_7d_avg, price_7d_stddev) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE price_7d_high=VALUES(price_7d_high), price_7d_low=VALUES(price_7d_low), price_7d_avg=VALUES(price_7d_avg), price_7d_stddev=VALUES(price_7d_stddev), updated_at=CURRENT_TIMESTAMP',
          [symbol, high, low, avg, stddev]
        ).catch(() => {});

        // Detect extreme moves (only fire once per symbol per run to avoid spam)
        if (extremeAlertsSent[symbol]) continue;
        const devFromAvg = (currentPrice - avg) / avg;
        const isExtremeDip  = devFromAvg <= -extremeMoveThreshold && !activeDropAlerts.has(symbol) && !alertState.acknowledged.has(symbol);
        const isExtremePump = devFromAvg >=  extremeMoveThreshold && !alertState.active.has(symbol) && !alertState.acknowledged.has(symbol);

        if (!isExtremeDip && !isExtremePump) continue;

        // Check we haven't sent this extreme alert recently (use basePrices as proxy)
        const coinBase = asset.currency;
        const available = parseFloat(asset.available);
        const entryPrice = entryPrices.get(symbol);

        if (isExtremeDip) {
          extremeAlertsSent[symbol] = true;
          const dropPct = (Math.abs(devFromAvg) * 100).toFixed(1);
          const buyBackSell = fmtPriceShort(currentPrice * 1.20);
          const entryLine = entryPrice
            ? `Entry: ${fmtPriceShort(entryPrice)} | P&L: ${((currentPrice - entryPrice) / entryPrice * 100).toFixed(1)}%\n`
            : '';
          const swingMsg =
            `🎯 <b>SWING TRADE SIGNAL — ${symbol}</b>\n` +
            `⬇️ <b>EXTREME DIP DETECTED</b>\n\n` +
            `Current: ${fmtPriceShort(currentPrice)} | 7-day avg: ${fmtPriceShort(avg)} | Drop: -${dropPct}%\n` +
            `7-day range: ${fmtPriceShort(low)} – ${fmtPriceShort(high)}\n` +
            `This is OUTSIDE normal trading range!\n\n` +
            `📊 Bryan's buy signal criteria:\n` +
            `• Outside normal range: ✅ (-${dropPct}% from avg)\n` +
            `• RSI likely oversold at this level ✅\n\n` +
            entryLine +
            `⚡ <b>RECOMMENDATION:</b> Strong buy signal based on your swing strategy.\n` +
            `Consider buying here and setting sell alert at ${buyBackSell} (+20%)\n\n` +
            `Reply:\n` +
            `'buy ${coinBase}' - get buy advice + auto-set buy and sell alerts\n` +
            `'hold ${coinBase}' - already holding, set recovery alerts\n` +
            `'dust ${coinBase}' - dust position, watch for further drop\n` +
            `'acknowledge ${coinBase}' - dismiss this alert`;
          await sendTelegram(swingMsg);
          // Store context so webhook replies can respond intelligently
          lastSwingAlertContext.set(symbol, { direction: 'dip', price: currentPrice, timestamp: Date.now() });
          mostRecentSwingAlert = { symbol, coinBase, direction: 'dip', price: currentPrice, timestamp: Date.now() };
          console.log(`Extreme dip signal sent for ${symbol}: ${dropPct}% below 7d avg`);
        }

        if (isExtremePump) {
          extremeAlertsSent[symbol] = true;
          const pumpPct = (devFromAvg * 100).toFixed(1);
          const buyBackPrice = fmtPriceShort(currentPrice * 0.85);
          const entryLine = entryPrice
            ? `Entry: ${fmtPriceShort(entryPrice)} | Profit: +${((currentPrice - entryPrice) / entryPrice * 100).toFixed(1)}%\n`
            : '';
          const swingMsg =
            `🎯 <b>SWING TRADE SIGNAL — ${symbol}</b>\n` +
            `⬆️ <b>EXTREME PUMP DETECTED</b>\n\n` +
            `Current: ${fmtPriceShort(currentPrice)} | 7-day avg: ${fmtPriceShort(avg)} | Pump: +${pumpPct}%\n` +
            `7-day range: ${fmtPriceShort(low)} – ${fmtPriceShort(high)}\n` +
            `This is OUTSIDE normal trading range!\n\n` +
            `📊 Bryan's sell signal criteria:\n` +
            `• Outside normal range: ✅ (+${pumpPct}% from avg)\n` +
            `• RSI likely overbought at this level ✅\n\n` +
            entryLine +
            `⚡ <b>RECOMMENDATION:</b> Sell signal based on your swing strategy.\n` +
            `Consider taking profits and setting buy-back alert at ${buyBackPrice} (-15%)\n\n` +
            `Reply:\n` +
            `'sell ${coinBase}' - get sell advice + auto-set profit targets\n` +
            `'hold ${coinBase}' - I'm holding, set sell alert at next resistance\n` +
            `'dust ${coinBase}' - dust position, set retrace buy alert\n` +
            `'acknowledge ${coinBase}' - dismiss this alert`;
          await sendTelegram(swingMsg);
          // Store context so webhook replies can respond intelligently
          lastSwingAlertContext.set(symbol, { direction: 'pump', price: currentPrice, timestamp: Date.now() });
          mostRecentSwingAlert = { symbol, coinBase, direction: 'pump', price: currentPrice, timestamp: Date.now() };
          console.log(`Extreme pump signal sent for ${symbol}: ${pumpPct}% above 7d avg`);
        }
      }
    } catch (e) {
      console.log('Extreme move detection error:', e.message);
    }

    // ── Secondary alert check: sell levels stored in note JSON ──────────────
    // These are sell/profit levels from a recommendation where a buy alert is the primary target.
    // We check them here so both buy and sell levels fire automatically.
    for (const [symbol, target] of priceTargets) {
      if (target.direction !== 'down') continue; // only check buy-primary entries for secondary sell levels
      let noteData = null;
      try { if (target.note) noteData = JSON.parse(target.note); } catch (e) {}
      if (!noteData || noteData.source !== 'claude_rec' || !noteData.sellLevels || noteData.sellLevels.length === 0) continue;

      const currentPrice = priceMap[symbol];
      if (!currentPrice) continue;
      const coinBase = symbol.replace('-USD', '');
      const entryPrice = entryPrices.get(symbol) || target.entryPrice;

      for (const sl of noteData.sellLevels) {
        const key = `${symbol}:sell:${sl.price}`;
        if (currentPrice >= sl.price && !activeSecondaryAlerts[key]) {
          activeSecondaryAlerts[key] = true;
          const assetBalance = balances.find(a => a.currency === coinBase);
          const qty = assetBalance ? parseFloat(assetBalance.available) : 0;
          const plPct = entryPrice && qty > 0 ? ((currentPrice - entryPrice) / entryPrice * 100) : null;
          const plUsd = entryPrice && qty > 0 ? ((currentPrice - entryPrice) * qty) : null;
          const positionLine = entryPrice && qty > 0
            ? `Your position: ${qty.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${coinBase} @ $${entryPrice.toFixed(4)} entry\nUnrealised profit: +${plPct.toFixed(1)}% (+$${Math.abs(plUsd).toFixed(2)})`
            : (qty > 0 ? `You hold ${qty.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${coinBase}` : '');
          const sellAlertMsg =
            `🎯 <b>${coinBase} HIT YOUR PROFIT TARGET!</b>\n\n` +
            `Price: $${currentPrice.toFixed(4)} (your Claude-recommended sell zone)\n` +
            `Original advice: '<i>${sl.snippet || `take profits at $${sl.price}`}</i>'\n` +
            (positionLine ? positionLine + '\n' : '') +
            `\n⚡ <b>RECOMMENDATION:</b> This is your planned profit zone.\n` +
            `Take action? Reply:\n` +
            `'sold ${coinBase} [price] [qty]' — log the sale\n` +
            `'analyse ${coinBase}' — get fresh analysis before deciding\n` +
            `'hold ${coinBase}' — log decision to hold through this level`;
          await sendTelegram(sellAlertMsg);
          console.log(`Secondary sell alert fired for ${symbol} at $${sl.price} (current: $${currentPrice})`);
        }
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

// Daily intention outcome checks — 10 AM, checks for 7-day and 30-day pending follow-ups
cron.schedule('0 10 * * *', checkIntentionOutcomes, { timezone: 'Europe/London' });

console.log('Cron jobs scheduled: midnight price recording + 9 AM morning briefing + every-2h macro news + Monday 9:05 rebalancing check + 10 AM intention outcomes (Europe/London)');

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
  for (const symbol of alertState.active.keys()) {
    alerts[symbol] = { alerting: true };
  }
  res.json({
    paused: monitoringPaused,
    activeAlerts: alerts,
    acknowledged: [...alertState.acknowledged],
    basePrices,
    customThresholds,
    defaultThreshold: PUMP_THRESHOLD
  });
});

// GET /api/balances — balances with prices, overnight change, and total portfolio value
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

    // Load most recent price_history record per symbol for overnight change
    let histMap = {};
    try {
      const [histRows] = await db.execute(
        'SELECT symbol, price FROM (SELECT symbol, price, ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY recorded_at DESC) rn FROM price_history) ranked WHERE rn = 1'
      );
      for (const r of histRows) histMap[r.symbol] = parseFloat(r.price);
    } catch (e) { /* ignore — overnight change optional */ }

    let totalUSD = 0;
    const result = [];
    for (const asset of balances) {
      const available = parseFloat(asset.available);
      if (!asset.currency || available <= 0) continue;
      const symbol = `${asset.currency}-USD`;
      const price = SKIP_CURRENCIES.includes(asset.currency) ? 1 : (priceMap[symbol] || null);
      const valueUSD = price ? available * price : null;
      if (valueUSD) totalUSD += valueUSD;
      const prevPrice = histMap[symbol] || null;
      const overnightChangePct = (price && prevPrice) ? ((price - prevPrice) / prevPrice * 100) : null;
      const entryPrice = (!SKIP_CURRENCIES.includes(asset.currency)) ? (entryPrices.get(symbol) || null) : null;
      const unrealisedPnlPct = (entryPrice && price) ? ((price - entryPrice) / entryPrice * 100) : null;
      const unrealisedPnlUsd = (entryPrice && price) ? ((price - entryPrice) * available) : null;
      result.push({ currency: asset.currency, available, price, valueUSD, symbol, overnightChangePct, entryPrice, unrealisedPnlPct, unrealisedPnlUsd });
    }
    res.json({ balances: result, totalUSD });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/acknowledge/:symbol — stop alerts for a coin
app.post('/api/acknowledge/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  console.log('[dashboard] Acknowledge request for:', symbol);
  await acknowledgeAlert(symbol);
  await sendTelegram(`🔕 Alerts acknowledged for ${symbol} via dashboard. Re-alerts suppressed for 15 minutes.`);
  res.json({ ok: true, symbol, message: `Acknowledged ${symbol} — all intervals cleared, suppressed 15 min` });
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
      if (activeFixedAlerts.has(symbol)) { clearInterval(activeFixedAlerts.get(symbol)); activeFixedAlerts.delete(symbol); }
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
      if (activeFixedAlerts.has(symbol)) { clearInterval(activeFixedAlerts.get(symbol)); activeFixedAlerts.delete(symbol); }
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
  if (activeFixedAlerts.has(symbol)) { clearInterval(activeFixedAlerts.get(symbol)); activeFixedAlerts.delete(symbol); }
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

// POST /api/research-dust — trigger Claude analysis of a dust coin via Telegram
app.post('/api/research-dust', async (req, res) => {
  const coin = (req.body?.coin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!coin) return res.status(400).json({ error: 'coin required' });
  res.json({ ok: true });
  (async () => {
    try {
      await sendTelegram(`🔍 Researching dust coin <b>${coin}</b>...`);
      const price = await getCurrentPrice(`${coin}-USD`).catch(() => null);
      const priceStr = price ? `current price $${price.toFixed(8)}` : 'price not available';
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-5',
        max_tokens: 600,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: `Research ${coin} crypto (${priceStr}). Bryan holds a small dust position. Search for: current project status, recent news, team activity, any upcoming catalysts. Give a clear verdict: ACCUMULATE / HOLD / DUMP. Under 400 words.` }]
      });
      const textBlock = [...response.content].reverse().find(b => b.type === 'text');
      const dustReply = `🔍 <b>DUST RESEARCH — ${coin}</b>\n\n${textBlock ? textBlock.text : 'Research unavailable.'}`;
      console.log('ABOUT TO CHUNK: dust research length:', dustReply.length);
      await sendTelegramChunked(dustReply);
    } catch (e) {
      await sendTelegram(`❌ Research failed for ${coin}: ${e.message}`);
    }
  })();
});

// GET /api/capital — current invested capital and P&L summary
app.get('/api/capital', async (req, res) => {
  try {
    const portfolioValue = await getCurrentPortfolioValue();
    const cap = getCapitalSummary(portfolioValue);
    res.json({ ...cap, success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/capital — update invested capital
app.post('/api/capital', async (req, res) => {
  try {
    const { amount, type, note } = req.body;
    if (!amount || !type) return res.status(400).json({ error: 'amount and type required' });
    let newTotal;
    if (type === 'deposit') newTotal = totalInvestedCapital + parseFloat(amount);
    else if (type === 'withdrawal') newTotal = totalInvestedCapital - parseFloat(amount);
    else if (type === 'set') newTotal = parseFloat(amount);
    else return res.status(400).json({ error: 'type must be deposit, withdrawal, or set' });
    await updateInvestedCapital(newTotal, note || `${type} $${amount}`);
    const portfolioValue = await getCurrentPortfolioValue();
    const cap = getCapitalSummary(portfolioValue);
    res.json({ ...cap, success: true });
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
    console.log('WEBHOOK: message received:', rawText.substring(0, 50));
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

      // --- Payment detection: "[coin] payment" or plain English phrases ---
      const isPaymentMsg = lowerMsg.includes('payment') ||
        /that was a payment|used for payment|revolut payment/i.test(lowerMsg);
      const paymentMatch = isPaymentMsg
        ? (matchedPending.find(m => lowerMsg.includes(m.symbol.replace('-USD', '').toLowerCase())) || matchedPending[0])
        : null;
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

        // Deduct payment value from invested capital
        try {
          const [jRows] = await db.execute('SELECT value_usd FROM trading_journal WHERE id = ?', [pending.journalId]);
          const paymentValueUsd = jRows[0]?.value_usd ? Math.abs(parseFloat(jRows[0].value_usd)) : null;
          if (paymentValueUsd && paymentValueUsd > 0) {
            const prevInvested = totalInvestedCapital;
            const newTotal = totalInvestedCapital - paymentValueUsd;
            await updateInvestedCapital(newTotal, `Payment deduction: ${coinBase} -$${paymentValueUsd.toFixed(2)}`);
            const portfolioValue = await getCurrentPortfolioValue();
            const cap = getCapitalSummary(portfolioValue);
            const pnlSign = cap.pnl >= 0 ? '+' : '';
            await sendReply(
              `✅ <b>${coinBase}</b> payment logged — $${paymentValueUsd.toFixed(2)} deducted from invested capital\n` +
              `💰 Previous invested: $${prevInvested.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n` +
              `💰 Updated invested: $${newTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n` +
              `📊 Current portfolio: $${portfolioValue.toFixed(0)}\n` +
              `📉 P&L: ${pnlSign}$${Math.abs(cap.pnl).toFixed(0)} (${pnlSign}${cap.pnlPct.toFixed(1)}%)`
            );
          } else {
            await sendReply(`✅ <b>${coinBase}</b> logged as payment — excluded from trading stats`);
          }
        } catch (e) {
          await sendReply(`✅ <b>${coinBase}</b> logged as payment — excluded from trading stats`);
        }
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

    // --- Commands: invested capital tracking ---
    const depositMatch = commandText.match(/^(?:i )?deposited?\s+\$?([\d,]+(?:\.\d+)?)/i);
    const withdrawalMatch = commandText.match(/^(?:i )?withdrew?\s+\$?([\d,]+(?:\.\d+)?)/i);
    const setCapitalMatch = commandText.match(/^(?:total invested(?:\s+(?:is|=))?\s+|invested capital(?:\s+(?:is|=))?\s+)\$?([\d,]+(?:\.\d+)?)/i);

    if (depositMatch || withdrawalMatch || setCapitalMatch) {
      try {
        let newTotal, note, changeAmt;
        if (depositMatch) {
          changeAmt = parseFloat(depositMatch[1].replace(/,/g, ''));
          newTotal = totalInvestedCapital + changeAmt;
          note = `Deposit +$${changeAmt}`;
        } else if (withdrawalMatch) {
          changeAmt = parseFloat(withdrawalMatch[1].replace(/,/g, ''));
          newTotal = totalInvestedCapital - changeAmt;
          note = `Withdrawal -$${changeAmt}`;
        } else {
          newTotal = parseFloat(setCapitalMatch[1].replace(/,/g, ''));
          note = `Manual set to $${newTotal}`;
        }
        await updateInvestedCapital(newTotal, note);
        const portfolioValue = await getCurrentPortfolioValue();
        const cap = getCapitalSummary(portfolioValue);
        await sendReply(fmtCapitalConfirm(cap, portfolioValue));
        return res.status(200).json({ ok: true });
      } catch (e) {
        await sendReply(`❌ Failed to update capital: ${e.message}`);
        return res.status(200).json({ ok: true });
      }
    }

    // --- Command: acknowledge [COIN] or acknowledge/ack (generic) ---
    const ackMatch = commandText.match(/^(?:acknowledge|ack)(?:\s+([a-z0-9]{2,10}))?$/);
    if (ackMatch) {
      if (ackMatch[1]) {
        // Specific coin
        const coinBase = ackMatch[1].toUpperCase();
        const symbol = `${coinBase}-USD`;
        console.log('[telegram] Acknowledge command for:', symbol);
        await acknowledgeAlert(symbol);
        await sendReply(`✅ Acknowledged ${symbol} — all alerts stopped, suppressing re-alerts for 15 minutes 🔕`);
      } else {
        // Generic ack — clear the first active alert found across all types
        const symbol =
          [...alertState.active.keys()][0] ||
          [...activeDropAlerts.keys()][0]  ||
          [...activeFixedAlerts.keys()][0];
        if (symbol) {
          console.log('[telegram] Generic acknowledge — targeting:', symbol);
          await acknowledgeAlert(symbol);
          await sendReply(`✅ Acknowledged ${symbol} — all alerts stopped, suppressing re-alerts for 15 minutes 🔕`);
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
      const alertedSymbols = [...alertState.active.keys()];
      const dropSymbols    = [...activeDropAlerts.keys()];
      const fixedSymbols   = [...activeFixedAlerts.keys()];
      const ackedSymbols   = [...alertState.acknowledged];
      const statusMsg =
        `<b>Monitor Status</b>\n` +
        `Paused: ${monitoringPaused ? 'Yes' : 'No'}\n` +
        `Pump alerts: ${alertedSymbols.length ? alertedSymbols.join(', ') : 'none'}\n` +
        `Drop alerts: ${dropSymbols.length ? dropSymbols.join(', ') : 'none'}\n` +
        `Fixed alerts: ${fixedSymbols.length ? fixedSymbols.join(', ') : 'none'}\n` +
        (ackedSymbols.length ? `🔕 Acknowledged (15 min): ${ackedSymbols.join(', ')}` : '');
      await sendReply(statusMsg);
      return res.status(200).json({ ok: true });
    }

    // --- Swing alert reply handler ---
    // Intercepts 'buy COIN', 'hold COIN', 'dust COIN', 'sell COIN', 👍, and natural language
    // when there is a recent swing trade signal (within 30 min) for that coin.
    {
      const SWING_TTL = 30 * 60 * 1000;

      // Detect coin-specific swing commands
      const swingBuyMatch  = commandText.match(/^buy\s+([a-z0-9]{2,12})$/i);  // 'buy HONEY' (not 'buy more')
      const swingHoldMatch = commandText.match(/^hold\s+([a-z0-9]{2,12})$/i);
      const swingDustMatch = commandText.match(/^dust\s+([a-z0-9]{2,12})$/i);
      const swingSellMatch = commandText.match(/^sell\s+([a-z0-9]{2,12})$/i);  // also caught below if no context

      // Detect 👍 and natural language (fall back to mostRecentSwingAlert)
      const isSwingThumbsUp = /👍/.test(rawText) || /[\u{1F44D}]/u.test(rawText);
      const isSwingHolding  = /^(holding|will hold|i.m holding|gonna hold)$/i.test(commandText);
      const isSwingWillSell = /^(i will sell|will sell|selling now|selling)$/i.test(commandText);
      const isSwingWillBuy  = /^(i will buy|will buy|buying now|buying)$/i.test(commandText);
      const isSwingDust     = /^(just dust|dust|nothing to sell|small position)$/i.test(commandText);
      const isSwingDismiss  = /^(ignore|dismiss|not interested|skip)$/i.test(commandText);

      // Resolve which coin + context we're replying to
      let swCoinBase = null, swSymbol = null, swCtx = null;

      if (swingBuyMatch || swingHoldMatch || swingDustMatch || swingSellMatch) {
        const raw = (swingBuyMatch || swingHoldMatch || swingDustMatch || swingSellMatch)[1].toUpperCase();
        swCoinBase = raw;
        swSymbol   = `${raw}-USD`;
        const c = lastSwingAlertContext.get(swSymbol);
        if (c && Date.now() - c.timestamp < SWING_TTL) swCtx = c;
      } else if (isSwingThumbsUp || isSwingHolding || isSwingWillSell || isSwingWillBuy || isSwingDust || isSwingDismiss) {
        if (mostRecentSwingAlert && Date.now() - mostRecentSwingAlert.timestamp < SWING_TTL) {
          swCoinBase = mostRecentSwingAlert.coinBase;
          swSymbol   = mostRecentSwingAlert.symbol;
          const c = lastSwingAlertContext.get(swSymbol);
          if (c && Date.now() - c.timestamp < SWING_TTL) swCtx = c;
        }
      }

      if (swCtx && swCoinBase && swSymbol) {
        // Determine effective action
        const swAction =
          (swingSellMatch  || isSwingWillSell) ? 'sell' :
          (swingBuyMatch   || isSwingWillBuy)  ? 'buy'  :
          (swingHoldMatch  || isSwingHolding || isSwingThumbsUp) ? 'hold' :
          (swingDustMatch  || isSwingDust)     ? 'dust' :
          isSwingDismiss                        ? 'ack'  : null;

        if (swAction) {
          console.log(`[swing] Reply '${swAction}' for ${swSymbol} (direction: ${swCtx.direction})`);

          // Stop the swing alert and clear context
          await acknowledgeAlert(swSymbol);
          lastSwingAlertContext.delete(swSymbol);
          if (mostRecentSwingAlert?.symbol === swSymbol) mostRecentSwingAlert = null;

          const isPump = swCtx.direction === 'pump';
          const currentPrice = await getCurrentPrice(swSymbol).catch(() => swCtx.price);

          if (swAction === 'ack') {
            await sendReply(`🔕 <b>${swCoinBase}</b> alerts paused for 15 minutes.`);
            return res.status(200).json({ ok: true });
          }

          if (swAction === 'hold') {
            if (isPump) {
              // Holding through pump → sell alert at +15%
              const sellTarget = currentPrice * 1.15;
              await setAbsolutePriceTarget(swSymbol, sellTarget, 'up',
                JSON.stringify({ source: 'swing_hold', direction: 'up' })).catch(() => {});
              await sendReply(
                `✅ Holding <b>${swCoinBase}</b> logged.\n` +
                `🎯 Sell alert set at ${fmtPriceShort(sellTarget)} (+15% from here)\n` +
                `I'll notify you when it hits your target!`
              );
            } else {
              // Holding through dip → recovery alert at entry or +20%
              const entryP = entryPrices.get(swSymbol);
              const recoverTarget = (entryP && entryP > currentPrice) ? entryP : currentPrice * 1.20;
              const label = (entryP && entryP > currentPrice) ? 'entry price' : '+20% from here';
              await setAbsolutePriceTarget(swSymbol, recoverTarget, 'up',
                JSON.stringify({ source: 'swing_hold', direction: 'up' })).catch(() => {});
              await sendReply(
                `✅ Holding <b>${swCoinBase}</b> logged.\n` +
                `🎯 Recovery alert set at ${fmtPriceShort(recoverTarget)} (${label})\n` +
                `I'll notify you when it recovers!`
              );
            }
            return res.status(200).json({ ok: true });
          }

          if (swAction === 'dust') {
            if (isPump) {
              // Dust in pump → retrace buy alert at -20%
              const buyBackTarget = currentPrice * 0.80;
              await setAbsolutePriceTarget(swSymbol, buyBackTarget, 'down',
                JSON.stringify({ source: 'swing_dust', direction: 'down' })).catch(() => {});
              await sendReply(
                `✅ Noted — dust position in <b>${swCoinBase}</b>.\n` +
                `🎯 Retrace buy alert set at ${fmtPriceShort(buyBackTarget)} (-20%)\n` +
                `I'll alert you if it retraces for a better entry!`
              );
            } else {
              // Dust in dip → recovery watch at +20%
              const watchTarget = currentPrice * 1.20;
              await setAbsolutePriceTarget(swSymbol, watchTarget, 'up',
                JSON.stringify({ source: 'swing_dust', direction: 'up' })).catch(() => {});
              await sendReply(
                `✅ Noted — dust position in <b>${swCoinBase}</b>.\n` +
                `🎯 Recovery watch set at ${fmtPriceShort(watchTarget)} (+20%)\n` +
                `I'll alert you if it recovers!`
              );
            }
            return res.status(200).json({ ok: true });
          }

          // For 'sell' and 'buy' — call Claude async, set alert, chunk response
          await sendReply(swAction === 'sell'
            ? `🔍 Getting sell advice for <b>${swCoinBase}</b>...`
            : `🔍 Getting buy advice for <b>${swCoinBase}</b>...`
          );
          res.status(200).json({ ok: true });

          (async () => {
            try {
              if (swAction === 'sell') {
                const r = await anthropic.messages.create({
                  model: 'claude-sonnet-4-5',
                  max_tokens: 600,
                  tools: [{ type: 'web_search_20250305', name: 'web_search' }],
                  messages: [{ role: 'user', content: `Sell advice for ${swSymbol}. Current price: ${fmtPriceShort(currentPrice)}. Extreme pump signal — ${((swCtx.price > 0 ? (currentPrice - swCtx.price) / swCtx.price * 100 : 0)).toFixed(1)}% above baseline. Take profits now or wait? Give specific sell price levels and a buy-back level for re-entry after retrace. Under 250 words.` }]
                });
                const blk = [...r.content].reverse().find(b => b.type === 'text');
                const buyBackTarget = currentPrice * 0.85;
                await setAbsolutePriceTarget(swSymbol, buyBackTarget, 'down',
                  JSON.stringify({ source: 'swing_sell', direction: 'down' })).catch(() => {});
                const msg =
                  `📈 <b>SELL ADVICE — ${swCoinBase}</b>\n\n` +
                  (blk ? blk.text : 'Sell advice unavailable.') +
                  `\n\n🎯 <b>Buy-back alert set at ${fmtPriceShort(buyBackTarget)} (-15%)</b>\n` +
                  `I'll alert you when ${swCoinBase} retraces for re-entry!`;
                await sendTelegramChunked(msg);

              } else { // buy
                const r = await anthropic.messages.create({
                  model: 'claude-sonnet-4-5',
                  max_tokens: 600,
                  tools: [{ type: 'web_search_20250305', name: 'web_search' }],
                  messages: [{ role: 'user', content: `Buy advice for ${swSymbol}. Current price: ${fmtPriceShort(currentPrice)}. Extreme dip signal — ${((swCtx.price > 0 ? (swCtx.price - currentPrice) / swCtx.price * 100 : 0)).toFixed(1)}% below baseline. Good buy opportunity? Give specific entry levels and a profit-taking target. Under 250 words.` }]
                });
                const blk = [...r.content].reverse().find(b => b.type === 'text');
                const sellTarget = currentPrice * 1.20;
                await setAbsolutePriceTarget(swSymbol, sellTarget, 'up',
                  JSON.stringify({ source: 'swing_buy', direction: 'up' })).catch(() => {});
                const msg =
                  `📉 <b>BUY ADVICE — ${swCoinBase}</b>\n\n` +
                  (blk ? blk.text : 'Buy advice unavailable.') +
                  `\n\n🎯 <b>Sell alert set at ${fmtPriceShort(sellTarget)} (+20%)</b>\n` +
                  `I'll alert you when ${swCoinBase} hits your profit target!`;
                await sendTelegramChunked(msg);
              }
            } catch (e) {
              console.error('[swing] Reply handler error:', e.message);
              await sendReply(`❌ Error: ${e.message}`);
            }
          })();
          return;
        }
      }
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
          const sellReply = textBlock ? textBlock.text : 'Unable to generate sell advice.';
          console.log('ABOUT TO CHUNK: sell advice length:', sellReply.length);
          await sendTelegramChunked(sellReply);
        } catch (e) {
          await sendReply('❌ Error getting sell advice: ' + e.message);
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
          const buyReply = textBlock ? textBlock.text : 'Unable to generate buy advice.';
          console.log('ABOUT TO CHUNK: buy advice length:', buyReply.length);
          await sendTelegramChunked(buyReply);
        } catch (e) {
          await sendReply('❌ Error getting buy advice: ' + e.message);
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
        if (activeFixedAlerts.has(symbol)) { clearInterval(activeFixedAlerts.get(symbol)); activeFixedAlerts.delete(symbol); }
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

    // --- Command: watch COIN X% — set dust coin alert ---
    const watchMatch = commandText.match(/^watch\s+([a-z0-9]{2,12})\s+([\d.]+)%?$/i);
    if (watchMatch) {
      const coinBase = watchMatch[1].toUpperCase();
      const pct = parseFloat(watchMatch[2]);
      const symbol = `${coinBase}-USD`;
      try {
        const { anchorPrice, targetPrice } = await setFixedTarget(symbol, pct, 'up');
        await sendReply(
          `✅ Alert set for <b>${coinBase}</b> — will notify when up ${pct}% from current price\n` +
          `📍 Watch price: ${anchorPrice < 0.001 ? anchorPrice.toFixed(8) : anchorPrice.toFixed(4)}\n` +
          `🎯 Target: ${targetPrice < 0.001 ? targetPrice.toFixed(8) : targetPrice.toFixed(4)}`
        );
      } catch (e) {
        await sendReply(`❌ Failed to set watch for ${coinBase}: ${e.message}`);
      }
      return res.status(200).json({ ok: true });
    }

    // --- Command: research COIN — Claude analysis of any coin ---
    const researchMatch = commandText.match(/^research\s+([a-z0-9]{2,12})$/i);
    if (researchMatch) {
      const coinBase = researchMatch[1].toUpperCase();
      const symbol = `${coinBase}-USD`;
      await sendReply(`🔍 Researching <b>${coinBase}</b>... give me a moment.`);
      await new Promise(r => setTimeout(r, 1500));
      res.status(200).json({ ok: true });
      (async () => {
        try {
          const price = await getCurrentPrice(symbol).catch(() => null);
          const priceStr = price ? `current price $${price < 0.001 ? price.toFixed(8) : price.toFixed(4)}` : '';
          const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-5',
            max_tokens: 700,
            tools: [{ type: 'web_search_20250305', name: 'web_search' }],
            messages: [{ role: 'user', content: `Research ${coinBase} crypto ${priceStr}. Bryan may hold a dust position. Search for: project fundamentals, team, recent news, tokenomics, upcoming catalysts, any red flags. Give a clear verdict: ACCUMULATE / HOLD / DUMP with reasoning. Under 450 words.` }]
          });
          const textBlock = [...response.content].reverse().find(b => b.type === 'text');
          const researchReply = `🔍 <b>RESEARCH — ${coinBase}</b>\n\n${textBlock ? textBlock.text : 'Research unavailable.'}`;
          console.log('ABOUT TO CHUNK: research reply length:', researchReply.length);
          await sendTelegramChunked(researchReply);
        } catch (e) {
          await sendReply(`❌ Research failed for ${coinBase}: ${e.message}`);
        }
      })();
      return;
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

    // --- Intention detection: user commits to following advice ---
    if (detectIntention(rawText)) {
      const { action, coins } = extractIntentionDetails(rawText);

      // Fall back to last recommendation context if no coins in message
      let targetCoins = coins;
      const lastRec = lastRecommendationContext.get(chatIdStr);
      if (targetCoins.length === 0 && lastRec && (Date.now() - lastRec.timestamp) < 30 * 60 * 1000) {
        targetCoins = lastRec.coins;
      }

      if (targetCoins.length > 0) {
        try {
          const prices = {};
          for (const coin of targetCoins) {
            const p = await getCurrentPrice(`${coin}-USD`).catch(() => null);
            if (p) prices[coin] = p;
          }

          await db.execute(
            'INSERT INTO intention_tracking (symbols, recommendation, prices_at_intention) VALUES (?, ?, ?)',
            [targetCoins.join(','), action, JSON.stringify(prices)]
          ).catch(() => {});

          for (const coin of targetCoins) {
            if (prices[coin]) {
              await db.execute(
                'INSERT INTO analysis_history (symbol, analysis_type, price_at_analysis, recommendation, user_action_taken) VALUES (?, ?, ?, ?, ?)',
                [`${coin}-USD`, 'intention_logged', prices[coin], action, 'intends_to_follow']
              ).catch(() => {});
            }
          }

          // ── Auto-set recommended price alerts ──────────────────────────────
          const recText   = lastRec ? (lastRec.rawReply || '') : '';
          const recAction = lastRec ? (lastRec.action || 'HOLD') : action;
          const buyAlertsSet  = []; // { coin, targetPrice, allLevels }
          const sellAlertsSet = []; // { coin, targetPrice, allLevels }

          if (recText) {
            const levels = extractRecommendedPriceLevels(recText);

            for (const coin of targetCoins) {
              const sym          = `${coin}-USD`;
              const currentPrice = prices[coin];
              if (!currentPrice || levels.length === 0) continue;

              // Classify levels: buy if below current or type='buy', sell if above or type='sell'
              // Neutral levels are classified by price relative to current
              const buyLevels = levels.filter(l =>
                l.type === 'buy' ? l.price < currentPrice
                : l.type === 'sell' ? false
                : l.price < currentPrice           // neutral → below = buy
              );
              const sellLevels = levels.filter(l =>
                l.type === 'sell' ? l.price > currentPrice
                : l.type === 'buy' ? false
                : l.price > currentPrice           // neutral → above = sell
              );

              // ── Primary alert: BUY side (nearest dip level) ───────────────
              if (buyLevels.length > 0) {
                const primary = buyLevels.reduce((best, l) => l.price > best.price ? l : best);
                const snippetRe = new RegExp(`[^.!?\\n]{0,60}\\$?${primary.price.toString().replace('.', '\\.')}[^.!?\\n]{0,60}`, 'i');
                const snip = (recText.match(snippetRe) || [''])[0].trim().replace(/\*\*/g, '').substring(0, 100) || `buy at $${primary.price}`;
                const allPrices   = buyLevels.map(l => l.price);
                const sellPrices  = sellLevels.map(l => {
                  const sr = new RegExp(`[^.!?\\n]{0,60}\\$?${l.price.toString().replace('.', '\\.')}[^.!?\\n]{0,60}`, 'i');
                  const ss = (recText.match(sr) || [''])[0].trim().replace(/\*\*/g, '').substring(0, 80) || `take profits at $${l.price}`;
                  return { price: l.price, snippet: ss };
                });
                const noteJson = JSON.stringify({ source: 'claude_rec', snippet: snip, allLevels: allPrices, recAction, sellLevels: sellPrices });
                try {
                  await setAbsolutePriceTarget(sym, primary.price, 'down', noteJson);
                  buyAlertsSet.push({ coin, targetPrice: primary.price, allLevels: allPrices });
                  console.log(`Auto-set down alert for ${sym} at $${primary.price}`);
                } catch (e) { console.error(`Buy auto-alert failed for ${sym}:`, e.message); }
              }

              // ── Secondary alert: SELL side (nearest profit level) ─────────
              // Stored separately as an 'up' target only if no buy alert already owns the symbol
              if (sellLevels.length > 0 && buyLevels.length === 0) {
                // Pure sell recommendation — set 'up' as primary
                const primary = sellLevels.reduce((best, l) => l.price < best.price ? l : best);
                const snippetRe = new RegExp(`[^.!?\\n]{0,60}\\$?${primary.price.toString().replace('.', '\\.')}[^.!?\\n]{0,60}`, 'i');
                const snip = (recText.match(snippetRe) || [''])[0].trim().replace(/\*\*/g, '').substring(0, 100) || `take profits at $${primary.price}`;
                const allPrices = sellLevels.map(l => l.price);
                const noteJson  = JSON.stringify({ source: 'claude_rec', snippet: snip, allLevels: allPrices, recAction, sellLevels: sellLevels.map(l => ({ price: l.price, snippet: snip })) });
                try {
                  await setAbsolutePriceTarget(sym, primary.price, 'up', noteJson);
                  sellAlertsSet.push({ coin, targetPrice: primary.price, allLevels: allPrices });
                  console.log(`Auto-set up alert for ${sym} at $${primary.price}`);
                } catch (e) { console.error(`Sell auto-alert failed for ${sym}:`, e.message); }
              } else if (sellLevels.length > 0) {
                // Both buy and sell levels — sell levels are stored in the note JSON of the buy target
                // They'll be checked by the secondary alert monitor in checkPortfolio
                sellAlertsSet.push({ coin, targetPrice: sellLevels[0].price, allLevels: sellLevels.map(l => l.price) });
              }
            }
          }

          // ── Build confirmation message ─────────────────────────────────────
          const bulletPrices  = Object.entries(prices).map(([c, p]) => `• ${c}: $${p.toFixed(4)}`).join('\n');
          const anyAlerts     = buyAlertsSet.length > 0 || sellAlertsSet.length > 0;
          const actionVerb    = recAction === 'HOLD' ? 'holding' : recAction === 'BUY' ? 'buying' : recAction === 'SELL' ? 'selling' : recAction.toLowerCase() + 'ing';
          const coinStr       = targetCoins.join(' & ');

          let confirmMsg;
          if (anyAlerts) {
            let buyBlock = '';
            if (buyAlertsSet.length > 0) {
              const lines = buyAlertsSet.flatMap(a => {
                const sorted = [...a.allLevels].sort((x, y) => y - x); // highest first (triggers first on dip)
                return sorted.map((lvl, i) => `• $${lvl.toFixed(2)} → ${i === 0 ? 'Good add zone 📊' : 'Strong buy zone 📊'}`);
              });
              buyBlock = `\n\n🔔 <b>BUY ALERTS (when price drops):</b>\n${lines.join('\n')}`;
            }
            let sellBlock = '';
            if (sellAlertsSet.length > 0) {
              const lines = sellAlertsSet.flatMap(a => {
                const sorted = [...a.allLevels].sort((x, y) => x - y); // lowest first (triggers first on rise)
                return sorted.map((lvl, i) => `• $${lvl.toFixed(2)} → ${i === 0 ? 'Consider taking profits 💰' : i === sorted.length - 1 ? 'Major exit zone 🚀' : 'Strong sell zone 💰'}`);
              });
              sellBlock = `\n\n🎯 <b>SELL/PROFIT ALERTS (when price rises):</b>\n${lines.join('\n')}`;
            }
            const currentLines = targetCoins.map(c => `Current ${c}: $${(prices[c] || 0).toFixed(4)}`).join('\n');
            confirmMsg =
              `✅ <b>Intention logged & alerts set for ${coinStr}!</b>` +
              buyBlock + sellBlock + `\n\n` +
              currentLines + `\n` +
              `Full alert framework set — I'll notify you at every key level! 💪`;
          } else {
            confirmMsg =
              `✅ Got it Bryan — logged that you're ${actionVerb} ${coinStr}.\n` +
              `Prices locked in:\n${bulletPrices}\n` +
              `I'll check back in 7 days to see how it plays out 📊`;
          }

          await sendReply(confirmMsg);
          return res.status(200).json({ ok: true });
        } catch (e) {
          console.error('Intention logging error:', e.message);
          // Fall through to Claude if logging fails
        }
      }
    }

    // --- Command: my pnl — unrealised P&L summary ---
    if (/^my pnl$/i.test(commandText)) {
      try {
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
        const winners = [], losers = [], noEntry = [];
        let totalPnlUsd = 0;
        for (const asset of balances) {
          if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
          const qty = parseFloat(asset.available);
          if (qty <= 0) continue;
          const sym = `${asset.currency}-USD`;
          const price = priceMap[sym];
          if (!price) continue;
          const entry = entryPrices.get(sym);
          if (!entry) { noEntry.push(asset.currency); continue; }
          const pnlPct = ((price - entry) / entry * 100);
          const pnlUsd = (price - entry) * qty;
          totalPnlUsd += pnlUsd;
          const sign = pnlPct >= 0 ? '+' : '';
          const line = `• ${asset.currency}: ${sign}${pnlPct.toFixed(1)}% (${pnlUsd >= 0 ? '+' : ''}$${Math.abs(pnlUsd).toFixed(2)})`;
          (pnlPct >= 0 ? winners : losers).push({ line, pnlPct });
        }
        winners.sort((a, b) => b.pnlPct - a.pnlPct);
        losers.sort((a, b) => a.pnlPct - b.pnlPct);
        const totalSign = totalPnlUsd >= 0 ? '+' : '';
        const pnlMsg =
          `📊 <b>UNREALISED P&L SUMMARY</b>\n\n` +
          (winners.length ? `🟢 <b>In profit (${winners.length}):</b>\n${winners.map(w => w.line).join('\n')}\n\n` : '') +
          (losers.length ? `🔴 <b>In loss (${losers.length}):</b>\n${losers.map(l => l.line).join('\n')}\n\n` : '') +
          `⚪ No entry set: ${noEntry.length} coins\n` +
          `💰 Total unrealised (tracked): ${totalSign}$${Math.abs(totalPnlUsd).toFixed(2)}`;
        await sendReply(pnlMsg);
      } catch (e) {
        await sendReply(`❌ Failed to get P&L: ${e.message}`);
      }
      return res.status(200).json({ ok: true });
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

    // FIX 4: Detect broad questions that need extra time and context
    const broadQuestionPatterns = [
      /smartest\s+buy/i, /best\s+coin/i, /which\s+(?:coin|should|would)/i,
      /what\s+would\s+you\s+(?:do|buy|sell|recommend)/i, /analyze\s+(?:my\s+)?portfolio/i,
      /what.s\s+the\s+best/i, /top\s+(?:pick|choice|coin)/i,
      /all\s+(?:my\s+)?(?:coins?|holdings?|assets?)/i, /my\s+(?:whole|entire|full)\s+portfolio/i,
      /overall\s+(?:portfolio|advice|assessment|analysis)/i
    ];
    const isBroadQuestion = broadQuestionPatterns.some(p => p.test(userMessage));

    // 1. Send acknowledgment then wait briefly so it arrives before Claude processing starts
    await sendReply(isBroadQuestion
      ? '🔍 Researching all your assets — this may take a moment...'
      : '🔍 Researching... give me a moment.');
    await new Promise(r => setTimeout(r, 2000));

    // 2. Return 200 to Telegram
    res.status(200).json({ ok: true });

    // 3. Continue processing the Claude API call asynchronously AFTER responding
    // Non-blocking — runs after response is sent
    (async () => {
      let stillResearchingTimer, stillResearchingTimer2;
      let holdingsList = '';
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

        // Compute total USD value for capital context
        const totalUSD = holdings.reduce((s, h) => s + h.valueUSD, 0);

        // Format as numbered list
        holdingsList = holdings.length
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
          `Active alerts (coins currently above threshold): ${[...alertState.active.keys()].join(', ') || 'none'}\n\n` +
          `Answer the user's questions about their portfolio, crypto market conditions, and trading decisions. Be concise since this is a Telegram message.`;

        const chatIdStr = chatId.toString();
        const history = conversationHistory.get(chatIdStr) || [];

        // Build messages array: history + current user message
        // FIX 4: For broad questions, instruct Claude to be concise and focused
        const messages = [
          ...history,
          { role: 'user', content: isBroadQuestion
            ? userMessage + '\n\nNote: Please answer concisely in under 2000 characters total. Focus on top 3 options only.'
            : userMessage }
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
- Bryan's total invested capital: $${totalInvestedCapital.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
- Current portfolio value: $${totalUSD > 0 ? totalUSD.toFixed(2) : 'see holdings above'}
- Real P&L: $${(totalUSD - totalInvestedCapital).toFixed(2)} (${totalUSD > 0 ? (((totalUSD - totalInvestedCapital) / totalInvestedCapital) * 100).toFixed(1) : '?'}%)
- Recovery target: +${totalUSD > 0 && totalUSD < totalInvestedCapital ? (((totalInvestedCapital - totalUSD) / totalUSD) * 100).toFixed(1) : '0'}% needed to break even
- This context is CRITICAL for all recommendations — always reference real P&L not just price movements
- Bryan's portfolio is approximately 50% down from historical highs due to bear market conditions and past trading decisions
- Many individual positions are down 50-80% from entry
- Bryan's PRIMARY GOAL is portfolio recovery and becoming a more disciplined trader
- Some balance changes detected are Revolut payments (asset used to make purchases) not trading decisions
- When giving advice, always consider recovery strategy not just short term gains
- Encourage disciplined trading habits and risk management
- Be honest about positions that may not recover and suggest better opportunities
- Celebrate good trading decisions to reinforce positive patterns
- For positions down 50%+: acknowledge the loss honestly and advise whether to cut or hold for recovery
- For positions doing well (CC, HYPE, LINK): emphasise protecting and growing these gains
- Always consider overall portfolio recovery in recommendations
- Suggest position sizing that protects the recovering portfolio

BRYAN'S CORE TRADING STRATEGY:
Bryan is a swing trader who specifically targets EXTREME price movements outside normal patterns:

BUY SIGNALS Bryan looks for:
• Sudden sharp DROP outside coin's normal trading range
• Extreme oversold conditions (RSI < 30)
• Price significantly below recent support
• Fear/panic selling creating opportunity
• The bigger and more sudden the drop, the more interesting

SELL SIGNALS Bryan looks for:
• Sudden sharp PUMP outside coin's normal trading range
• Extreme overbought conditions (RSI > 70)
• Price significantly above recent resistance
• Euphoria/FOMO buying creating exit opportunity
• The bigger and more sudden the pump, the more interesting

RETRACE STRATEGY:
• After selling a pump, Bryan waits for retrace
• Buys back at lower price to repeat the cycle
• Goal: capture profit on the move, buy back cheaper

LOSS PROTECTION:
• Will cut losses if coin drops with no recovery catalyst
• Prefers to redeploy capital into better opportunities
• Does not hold indefinitely hoping for recovery on weak coins

WHEN GIVING RECOMMENDATIONS:
• Always identify if current price is an extreme move outside normal range
• Flag if coin is in buy zone (extreme dip) or sell zone (extreme pump)
• Suggest specific buy-back prices after recommending sells
• Suggest profit-taking levels after recommending buys
• Reference Bryan's swing trading strategy explicitly in advice
• Example: 'This 15% sudden drop is exactly your buy signal — outside normal range, RSI oversold'
• Example: 'This 20% pump is your sell signal — take profits here and watch for retrace to $X to buy back'

ALERT CONTEXT:
• Daily pump alerts = potential SELL signal (extreme move up)
• Daily drop alerts = potential BUY signal (extreme move down)
• Always frame alerts in context of Bryan's swing strategy

${holdingsList}

Current baseline prices (set when monitoring started): ${JSON.stringify(basePrices)}
Active alerts (coins currently above threshold): ${[...alertState.active.keys()].join(', ') || 'none'}${learningContext}${recoveryContext}`,
          messages,
        });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 110000)
        );

        // FIX 2: Send follow-up messages at 30s and 60s if still processing
        stillResearchingTimer = setTimeout(async () => {
          try {
            await sendReply('🔍 Still researching deeply... complex question needs more time.');
          } catch (e) { /* ignore */ }
        }, 30000);
        stillResearchingTimer2 = setTimeout(async () => {
          try {
            await sendReply('⏳ Almost there — pulling together the analysis now...');
          } catch (e) { /* ignore */ }
        }, 60000);

        const response = await Promise.race([claudePromise, timeoutPromise]);
        clearTimeout(stillResearchingTimer);
        clearTimeout(stillResearchingTimer2);

        // Extract the last text block (web_search may produce tool_use blocks before the final text)
        const lastTextBlock = [...response.content].reverse().find(b => b.type === 'text');
        const reply = lastTextBlock ? lastTextBlock.text : '(no response)';

        // Update last recommendation context for intention tracking
        try {
          const recCoins = holdings.filter(h => reply.toUpperCase().includes(h.symbol.replace('-USD', ''))).map(h => h.symbol.replace('-USD', ''));
          const recActionMatch = reply.match(/\*\*(HOLD|SELL|BUY MORE|BUY|REDUCE|ADD)\*\*/i) || reply.match(/\b(HOLD|SELL|BUY|REDUCE|ADD)\b/i);
          lastRecommendationContext.set(chatIdStr, {
            coins: recCoins.length > 0 ? recCoins : [],
            action: recActionMatch ? recActionMatch[1].toUpperCase() : 'HOLD',
            rawReply: reply,
            timestamp: Date.now()
          });
        } catch (e) { /* ignore */ }

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

        // FIX 5: Log response length before sending
        const fullReply = reply + (actionTaken || '');
        console.log('Claude response length:', fullReply.length, 'characters');
        console.log('Sending in', Math.ceil(fullReply.length / 2500), 'message(s)');
        console.log('ABOUT TO CHUNK: response length:', fullReply.length);

        // 3s gap after status message so chunks don't collide with it
        await new Promise(r => setTimeout(r, 3000));
        await sendTelegramChunked(fullReply);
      } catch (err) {
        console.error('Claude AI error:', err.message);
        clearTimeout(stillResearchingTimer);
        clearTimeout(stillResearchingTimer2);
        if (err.message === 'timeout') {
          // FIX 3: Fallback simpler Claude call — no web search, max 30s, max_tokens 500
          try {
            const fallbackPromise = anthropic.messages.create({
              model: 'claude-sonnet-4-5',
              max_tokens: 500,
              system: `You are a crypto advisor. Here are the user's current holdings:\n${holdingsList || 'Portfolio data unavailable'}\nAnswer the user's question briefly in 2-3 sentences. Be direct and actionable.`,
              messages: [{ role: 'user', content: userMessage }],
            });
            const fallbackTimeout = new Promise((_, reject) =>
              setTimeout(() => reject(new Error('fallback_timeout')), 30000)
            );
            const fallbackResponse = await Promise.race([fallbackPromise, fallbackTimeout]);
            const fallbackBlock = [...fallbackResponse.content].reverse().find(b => b.type === 'text');
            const fallbackText = fallbackBlock ? fallbackBlock.text : null;
            if (fallbackText) {
              await sendReply(`⚡ <b>Quick take</b> (full analysis timed out):\n\n${fallbackText}\n\n<i>Tip: Ask about one specific coin at a time for deeper analysis.</i>`);
            } else {
              await sendReply('⏱️ Analysis timed out. Try asking about one specific coin at a time.');
            }
          } catch (fallbackErr) {
            await sendReply('⏱️ Analysis timed out. Try asking about one specific coin at a time.');
          }
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
  { key: 'goal',             value: 'Recover portfolio losses and become a disciplined profitable swing trader' },
  { key: 'situation',        value: 'Portfolio approximately 50% down from historical highs' },
  { key: 'style',            value: 'Swing trader - buy dips sell pumps' },
  { key: 'weakness',         value: 'Past trading decisions led to significant losses - working to improve discipline' },
  { key: 'strength',         value: 'Good instincts on institutional plays like CC and LINK' },
  { key: 'core_strategy',    value: 'Swing trader focused on extreme price movements. Buys sudden sharp dips outside normal price pattern. Sells sudden sharp pumps outside normal price pattern. Always looking to capture profit on big moves and buy back on retraces.' },
  { key: 'buy_signals',      value: 'Sudden extreme drop outside normal trading range — potential dip buy opportunity' },
  { key: 'sell_signals',     value: 'Sudden extreme pump outside normal trading range — potential profit taking opportunity' },
  { key: 'retrace_strategy', value: 'After selling a pump, waits for retrace and buys back at lower price to repeat the cycle' },
  { key: 'loss_protection',  value: 'Will sell to protect against further losses if coin drops significantly with no recovery catalyst' },
  { key: 'profit_capture',   value: 'Takes profits on substantial rises then looks to buy back on retrace' },
  { key: 'trading_goal',     value: 'Portfolio recovery from 50% down — building back through disciplined swing trading' },
  { key: 'risk_approach',    value: 'Protects downside while capturing upside on extreme moves' },
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
