import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createPrivateKey, sign, createHash, createHmac, randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import mysql from 'mysql2/promise';
import Anthropic from '@anthropic-ai/sdk';
import cron from 'node-cron';
import { gzipSync } from 'zlib';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// FIX 3: Verify API key present at startup
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('[startup] WARNING: ANTHROPIC_API_KEY not set — Claude analysis will fail silently');
} else {
  console.log('[startup] ANTHROPIC_API_KEY present ✅');
  console.log(process.env.GOOGLE_OAUTH_REFRESH_TOKEN && process.env.GDRIVE_BACKUP_FOLDER_ID ? '[backup] Google Drive backup configured ✅' : '[backup] Google Drive backup NOT configured (env vars missing) — backups disabled');
}

const API_KEY = process.env.REVOLUTX_API_KEY;
const PRIVATE_KEY = process.env.REVOLUTX_PRIVATE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BASE_URL = 'https://revx.revolut.com/api/1.0';
const KRAKEN_API_URL = 'https://api.kraken.com';
const TANGEM_XRP_ADDRESS = 'r4E3rtCa4FT4HxTQV2iw3yQHRTrAHMYS3v';
const TANGEM_XRP_ENTRY   = 2.65; // average entry price for Tangem XRP position
const XRPL_API = 'https://xrplcluster.com';
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const CAPTURE_INTERVAL_MS = 2 * 60 * 1000;   // #50: intraday price capture cadence (decoupled from alert loop)
const FAST_SCAN_INTERVAL_MS = 30 * 1000;      // #94: fast-cadence trailing-stop scan for volatile meme/lotto coins (30s)
const ALERT_INTERVAL_MS = 60 * 1000;
const PUMP_THRESHOLD = 0.20;
const SKIP_CURRENCIES = ['USD', 'USDT', 'USDC', 'EUR', 'GBP'];

// Coins held on Kraken — not in Revolut X tickers, need separate price fetch
const KRAKEN_MONITORED_COINS = ['GHIBLI-USD', 'ZK-USD', 'XPL-USD', 'TAO-USD'];

// Explicit Kraken pair names — avoids guessing for non-standard pairs
const KRAKEN_PAIR_MAP = {
  'GHIBLI-USD': 'GHIBLIUSD',
  'ZK-USD':     'ZKUSD',
  'XPL-USD':    'XPLUSD',
  'TAO-USD':    'TAOUSD',
  'SOL-USD':    'SOLUSD',
  'BTC-USD':    'XBTUSD',
  'ETH-USD':    'XETHZUSD',
};
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

// ── Coin context helper — resolves project name + trading role for AI prompts ──
// Used by getQuickAiRecommendation and batchGetRecommendations (A1 / dev_log #35 + #31)
async function getCoinContext(coinBase) {
  const narrative = COIN_NARRATIVES[coinBase] || null;
  let role = 'normal';
  try {
    const [aeRows] = await db.execute(
      "SELECT config_value FROM system_config WHERE config_key = 'ai_auto_execute'"
    );
    if (aeRows.length) {
      const ae = JSON.parse(aeRows[0].config_value);
      if ((ae.hodl_symbols || []).includes(coinBase)) role = 'hodl';
      else if ((ae.manual_only_symbols || []).includes(coinBase)) role = 'manual_only';
    }
  } catch (e) { /* ignore — default role 'normal' */ }
  return { narrative, role };
}

async function revolutRequest(method, path, body = null) {
  const timestamp = Date.now().toString();
  // For POST requests include minified JSON body in signature — critical for match
  const bodyString = body ? JSON.stringify(body) : '';
  const message = `${timestamp}${method}/api/1.0${path}${bodyString}`;
  const privateKeyPem = PRIVATE_KEY.replace(/\\n/g, '\n');
  const pk = createPrivateKey({ key: privateKeyPem, format: 'pem', type: 'pkcs8' });
  const signature = sign(null, Buffer.from(message, 'utf8'), { key: pk, dsaEncoding: 'ieee-p1363' });
  const headers = {
    'X-Revx-API-Key': API_KEY,
    'X-Revx-Timestamp': timestamp,
    'X-Revx-Signature': signature.toString('base64'),
    'Content-Type': 'application/json'
  };
  const fetchOptions = { method, headers };
  if (body) fetchOptions.body = bodyString;
  if (method === 'POST') {
    console.log('[revolut] Request URL:', `${BASE_URL}${path}`);
    console.log('[revolut] Signature message (first 120):', message.substring(0, 120));
  }
  const response = await fetch(`${BASE_URL}${path}`, fetchOptions);
  const text = await response.text();
  if (method === 'POST') {
    console.log('[revolut] Response status:', response.status);
    console.log('[revolut] Response body:', text);
  }
  return JSON.parse(text);
}

async function placeRevolutOrder(symbol, side, orderType, baseSize, price = null, valueUsd = null) {
  const clientOrderId = randomUUID();

  // Orders API uses dash format (LINK-USD), tickers API uses slash (LINK/USD)
  const revolutSymbol = symbol.includes('-USD') ? symbol.toUpperCase() : `${symbol.toUpperCase()}-USD`;
  console.log(`[revolut] Using order symbol: ${revolutSymbol}`);

  const orderConfig = orderType === 'limit' && price
    ? { limit: { base_size: baseSize.toString(), price: price.toString() } }
    : valueUsd
      ? { market: { quote_size: valueUsd.toString() } }
      : { market: { base_size: baseSize.toString() } };
  const body = {
    client_order_id: clientOrderId,
    symbol: revolutSymbol,
    side: side.toUpperCase(),
    order_configuration: orderConfig,
  };
  console.log('[revolut] Placing order:', JSON.stringify(body));
  const result = await revolutRequest('POST', '/orders', body);
  console.log('[revolut] Full order response:', JSON.stringify(result));
  if (result.message || result.error || result.errors) {
    throw new Error(result.message || JSON.stringify(result.error || result.errors));
  }
  return { ...result, client_order_id: clientOrderId };
}

async function sweepToUSDT(proceedsUsd, sourceSymbol) {
  try {
    const [configRows] = await db.execute(
      "SELECT config_value FROM system_config WHERE config_key = 'usdt_sweep_config'"
    );
    if (!configRows.length) return;

    const config = JSON.parse(configRows[0].config_value);
    if (!config.enabled) return;
    if (proceedsUsd < config.min_trade_value_usd) return;

    // Check exclusions against both bare coin name (BONK) and full symbol (BONK-USD)
    if (config.excluded_symbols && config.excluded_symbols.length > 0) {
      const coinBase = sourceSymbol.replace('-USD', '');
      if (config.excluded_symbols.includes(coinBase) || config.excluded_symbols.includes(sourceSymbol)) {
        console.log(`[sweep] ${coinBase} excluded from USDT sweep — skipping`);
        return;
      }
    }

    const sweepAmountUsd = proceedsUsd * (config.sweep_pct / 100);

    // Get current USDT balance for the confirmation message
    const balances = await revolutRequest('GET', '/balances');
    const usdtBalance = balances.find(b => b.currency === 'USDT');
    const currentUSDT = parseFloat(usdtBalance?.available || 0);

    console.log(`[sweep] Sweeping $${sweepAmountUsd.toFixed(2)} to USDT after ${sourceSymbol} sell`);

    await placeRevolutOrder('USDT-USD', 'buy', 'market', null, null, sweepAmountUsd);

    const approxNewUSDT = currentUSDT + sweepAmountUsd;

    await sendTelegram(
      `💰 <b>USDT SWEEP EXECUTED</b>\n\n` +
      `After selling ${sourceSymbol.replace('-USD', '')}\n` +
      `Swept: $${sweepAmountUsd.toFixed(2)} → USDT\n` +
      `Config: ${config.sweep_pct}% of proceeds\n` +
      `USDT reserve: ~$${approxNewUSDT.toFixed(2)}\n\n` +
      `💡 Ready for next dip buy!`
    );

    await db.execute(
      'INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['USDT', 'buy', 1, sweepAmountUsd, sweepAmountUsd,
       `Auto-sweep: ${config.sweep_pct}% of ${sourceSymbol} sell proceeds`, 'neutral']
    ).catch(() => {});

  } catch (e) {
    console.error('[sweep] USDT sweep error:', e.message);
    await sendTelegram(`⚠️ USDT sweep failed after ${sourceSymbol} sell: ${e.message}`).catch(() => {});
  }
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
  console.log('FIRST CHUNK CONTENT:', (chunks[0] || '').substring(0, 200).replace(/\n/g, '|'));

  for (let i = 0; i < chunks.length; i++) {
    // Extra 2s before first chunk so the "thinking..." status message fully clears
    if (i === 0) await new Promise(r => setTimeout(r, 2000));

    const prefix = i > 0
      ? `📄 (Part ${i + 1} of ${chunks.length})\n\n`
      : `📊 (Part ${i + 1} of ${chunks.length})\n\n`;
    const message = prefix + chunks[i];

    console.log('Sending part', i + 1, 'of', chunks.length, '- length:', chunks[i].length, '- starts:', chunks[i].substring(0, 80).replace(/\n/g, ' '));

    await sendTelegram(message);

    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  console.log('All', chunks.length, 'parts sent successfully');
}

const basePrices = {};
// Single source of truth for alert state
const alertState = {
  active: new Map(),       // symbol -> intervalId (daily pump alerts)
  acknowledged: new Set(), // symbols acknowledged — silent until new alert set, 'watch COIN', or restart
};
const ignoredCoins = new Set(); // permanently ignored coins — survives restarts via DB
const activeFixedAlerts = new Map(); // symbol -> intervalId for fixed price target alerts (up)
const activeDropAlerts  = new Map(); // symbol -> intervalId for fixed floor/drop alerts (down)
const targetReminderCount = new Map(); // symbol -> number of reminders sent (resets on acknowledge)
const alertFirstSent = new Map();    // symbol -> timestamp when first pump/drop/swing alert was sent
const alertReminderSent = new Map(); // symbol -> timestamp when single follow-up reminder was sent
const activeSecondaryAlerts = {}; // `${symbol}:${price}` -> true — fired secondary rec-based alerts
const lastBalances = {};
const customThresholds = {};
const priceTargets = new Map(); // symbol -> { anchorPrice, thresholdPct, targetPrice, entryPrice }
const entryPrices = new Map(); // symbol -> number (DB-backed, persists across restarts)
let monitoringPaused = false;
let briefingInProgress = false;
let lastMacroNewsCallTime = 0; // separate rate-limit for macro news Claude calls (1 hour)
let learningModelCache = ''; // updated by updateLearningModel()
const pendingJournalState = new Map(); // chatId -> { journalId, step: 'emotion'|'followed', hasClaudeRec, claudeRec, symbol }
let pendingJournalDelete = null; // { id, summary, expiresAt } — admin two-step delete guard
const pendingTradeContext = new Map(); // symbol -> { journalId, detectedAt, timeoutHandle, action, price, valueUsd, qty }
const pendingRebalanceConfirm = new Map(); // chatId -> { sellSymbol, sellJournalId, sellPrice, sellValueUsd, buySymbol, buyJournalId, buyPrice, buyValueUsd }
const previousBalances = new Map(); // symbol -> quantity (DB-backed)
let portfolioCheckCount = 0; // skip trade detection on first check (baseline establishment)
let monitoringInterval = null;
const conversationHistory = new Map(); // chatId -> [{role, content}]
const lastRecommendationContext = new Map(); // chatId -> { coins, action, prices, timestamp }
const lastSwingAlertContext = new Map();     // symbol -> { direction: 'pump'|'dip', price, timestamp }
const swingAlertCooldown = new Map();        // symbol -> timestamp — prevents repeated swing signals (4h cooldown, 6h after reply)
const autoSkipAlerted = new Map();           // symbol -> timestamp — throttles "auto buy skipped" Telegram messages (1h cooldown)
const lowCashAlerted = new Map();            // exchange -> date string — throttles low-cash warnings to once per day per exchange
const alertContextBySymbol = new Map();      // coinBase.toLowerCase() -> { symbol, coinBase, alertType, timestamp } — powers numbered reply shortcuts
let lastAlertCoin = null;                    // most recently fired alert coin (lowercase) — used for plain number replies
let lastKnownUSDT  = null;                   // USDT at start of current cycle — set once on startup from live balance
let lastKnownUSD   = null;                   // USD at start of current cycle — used to detect USDT→USD conversions
let previousBTCPrice = null;                 // BTC price from last checkPortfolio cycle — used for key-level crossing alerts
const ruleApproachAlerted = new Map();       // ruleId -> timestamp — tracks 2% approach alerts so they don't spam
let mostRecentSwingAlert = null;             // { symbol, coinBase, direction, price, timestamp } — for 👍 / natural language
const alertRecommendations = new Map();      // symbol -> { rec, timestamp } — reused in reminders, no repeat API calls
const responseCache = new Map();             // 'type:symbol' -> { response, timestamp } — 30-min cache for sell/buy advice
const trailingStops = new Map();             // symbol -> { trailPct, peakPrice, stopPrice, entryPrice }
const targetExtremes = new Map();            // symbol -> { high, low } — high-water/low-water per target across polls (resets on fire/ack/remove)
const trailingStopAlerted = new Map();       // symbol -> timestamp — tracks recently-triggered trailing stops for hold reply
const fastScanLastPrice  = new Map();         // #94: symbol -> last price seen by fast scan (dedup — skip if unchanged)
const pendingAnalysis = new Map();           // symbol -> { type, recommendation, analysis, price, timestamp }
const analysisRateLimit = new Map();         // symbol -> timestamp of last Claude analysis (rate-limit: 1/hr)
const pendingUndo = new Map();               // symbol -> { action, qty, price, timestamp } — 2-min undo window after AI auto-exec
let pendingKrakenTrade = null;               // { symbol, side, orderType, volume, price, valueUSD } — awaiting Telegram approval
let pendingRevolutTrade = null;             // { symbol, side, orderType, baseSize, price, valueUSD } — awaiting Telegram approval
let pendingKrakenTradeReminder = null;      // setInterval handle for Kraken approval reminders
let pendingRevolutTradeReminder = null;     // setInterval handle for Revolut X approval reminders
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

await db.execute(`CREATE TABLE IF NOT EXISTS dev_bridge (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(32) NOT NULL,
  ref_devlog_id INT DEFAULT NULL,
  payload LONGTEXT NOT NULL,
  consumed TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  consumed_at TIMESTAMP NULL DEFAULT NULL
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

await db.execute(`CREATE TABLE IF NOT EXISTS price_intraday (
  id INT AUTO_INCREMENT PRIMARY KEY,
  symbol VARCHAR(50) NOT NULL,
  price DECIMAL(20,10) NOT NULL,
  recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_intraday_symbol_time (symbol, recorded_at)
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

// #48 v1: forward-outcome columns (idempotent)
for (const [col, ddl] of [
  ['outcome_7d_pct', 'ADD COLUMN outcome_7d_pct DECIMAL(10,4) NULL'],
  ['outcome_30d_pct', 'ADD COLUMN outcome_30d_pct DECIMAL(10,4) NULL'],
  ['outcome_grade_source', "ADD COLUMN outcome_grade_source VARCHAR(20) NULL"],
]) {
  try {
    const [rows] = await db.execute(
      `SELECT COUNT(*) AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_journal' AND COLUMN_NAME = ?`, [col]);
    if (rows[0].c === 0) {
      await db.execute(`ALTER TABLE trading_journal ${ddl}`);
      console.log(`[migrate] #48 added column ${col}`);
    }
  } catch (e) { console.warn(`[migrate] #48 ${col}:`, e.message); }
}

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

await db.execute(`CREATE TABLE IF NOT EXISTS ignored_coins (
  symbol VARCHAR(50) PRIMARY KEY,
  ignored_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ignore_type VARCHAR(20) DEFAULT 'permanent',
  expires_at TIMESTAMP NULL
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS alert_reminders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  symbol VARCHAR(50) NOT NULL,
  alert_date DATE NOT NULL,
  count INT DEFAULT 0,
  UNIQUE KEY unique_symbol_date (symbol, alert_date)
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS coin_cash_flows (
  id INT AUTO_INCREMENT PRIMARY KEY,
  symbol VARCHAR(50) NOT NULL,
  flow_type ENUM('buy','sell') NOT NULL,
  cash_amount DECIMAL(20,8) NOT NULL,
  token_quantity DECIMAL(20,8) NOT NULL,
  price DECIMAL(20,10) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  journal_id INT NULL,
  UNIQUE KEY unique_journal (journal_id, flow_type)
)`);
await db.execute(`CREATE INDEX IF NOT EXISTS idx_cash_flows_symbol ON coin_cash_flows(symbol)`).catch(() => {});

await db.execute(`CREATE TABLE IF NOT EXISTS session_state (
  id INT PRIMARY KEY AUTO_INCREMENT,
  active_workstream TEXT,
  progress JSON,
  open_threads JSON,
  next_action TEXT,
  recent_decisions JSON,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`).catch(e => console.error('[migration] session_state:', e.message));

await db.execute(`CREATE TABLE IF NOT EXISTS session_history (
  id INT PRIMARY KEY AUTO_INCREMENT,
  snapshot JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).catch(e => console.error('[migration] session_history:', e.message));

// Seed exactly one current row if none exists
await db.execute(
  `INSERT INTO session_state (id, active_workstream, progress, open_threads, next_action, recent_decisions)
   SELECT 1, NULL, NULL, NULL, NULL, NULL
   WHERE NOT EXISTS (SELECT 1 FROM session_state WHERE id = 1)`
).catch(e => console.error('[migration] session_state seed:', e.message));

await db.execute(`CREATE TABLE IF NOT EXISTS dev_log (
  id INT PRIMARY KEY AUTO_INCREMENT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  source VARCHAR(32) DEFAULT 'bryan',
  category VARCHAR(32) DEFAULT 'note',
  status VARCHAR(20) DEFAULT 'open',
  title VARCHAR(255) NOT NULL,
  detail TEXT,
  related_symbol VARCHAR(20),
  resolved_at TIMESTAMP NULL
)`).catch(e => console.error('[migration] dev_log:', e.message));

  await db.execute(`CREATE TABLE IF NOT EXISTS research_history (
    id INT PRIMARY KEY AUTO_INCREMENT,
    symbol VARCHAR(20) NOT NULL,
    researched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    triggered_by VARCHAR(20) DEFAULT 'manual',
    live_price DECIMAL(20,8),
    thesis_status VARCHAR(20),
    drift_verdict TEXT,
    catalysts_summary TEXT,
    report_text MEDIUMTEXT,
    had_plan BOOLEAN DEFAULT FALSE,
    INDEX idx_research_symbol_time (symbol, researched_at)
  )`).catch(e => console.error('[migration] research_history:', e.message));

await db.execute(`CREATE TABLE IF NOT EXISTS coin_strategy (
  symbol VARCHAR(20) PRIMARY KEY,
  status VARCHAR(20),
  role VARCHAR(20),
  theme VARCHAR(100),
  strategy_md TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by VARCHAR(40)
)`).catch(e => console.error('[migration] coin_strategy:', e.message));

await db.execute(`CREATE TABLE IF NOT EXISTS session_state (
  id INT PRIMARY KEY AUTO_INCREMENT,
  active_workstream TEXT,
  progress JSON,
  open_threads JSON,
  next_action TEXT,
  recent_decisions JSON,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`).catch(e => console.error('[migration] session_state:', e.message));

await db.execute(`CREATE TABLE IF NOT EXISTS session_history (
  id INT PRIMARY KEY AUTO_INCREMENT,
  snapshot JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).catch(e => console.error('[migration] session_history:', e.message));

// Seed exactly one current row if none exists
await db.execute(
  `INSERT INTO session_state (id, active_workstream, progress, open_threads, next_action, recent_decisions)
   SELECT 1, NULL, NULL, NULL, NULL, NULL
   WHERE NOT EXISTS (SELECT 1 FROM session_state WHERE id = 1)`
).catch(e => console.error('[migration] session_state seed:', e.message));

await db.execute(`CREATE TABLE IF NOT EXISTS swing_cooldowns (
  symbol VARCHAR(50) PRIMARY KEY,
  last_alert_at TIMESTAMP NOT NULL,
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

await db.execute(`CREATE TABLE IF NOT EXISTS trailing_stops (
  symbol VARCHAR(50) PRIMARY KEY,
  trail_pct DECIMAL(10,4) NOT NULL,
  peak_price DECIMAL(20,10) NOT NULL,
  stop_price DECIMAL(20,10) NOT NULL,
  entry_price DECIMAL(20,10),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`);
await db.execute(`CREATE TABLE IF NOT EXISTS pump_armed_rules (
  symbol VARCHAR(50) PRIMARY KEY,
  arm_pump_pct DECIMAL(10,4) NOT NULL,
  arm_window_min INT NOT NULL DEFAULT 60,
  trail_pct DECIMAL(10,4) NOT NULL,
  sell_pct DECIMAL(10,4) NOT NULL DEFAULT 50,
  entry_floor DECIMAL(20,10),
  armed TINYINT(1) NOT NULL DEFAULT 0,
  baseline_price DECIMAL(20,10),
  baseline_at BIGINT,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS pm_decisions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  decision TEXT NOT NULL,
  reasoning TEXT,
  principle_tag VARCHAR(80),
  related_symbol VARCHAR(50),
  conviction ENUM('high','medium','low'),
  captured_by VARCHAR(50) NOT NULL DEFAULT 'manual',
  status ENUM('active','superseded') NOT NULL DEFAULT 'active',
  supersedes_id INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS dev_decisions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  decision TEXT NOT NULL,
  reasoning TEXT,
  principle_tag VARCHAR(80),
  cross_thread TINYINT(1) NOT NULL DEFAULT 0,
  alternatives_rejected TEXT,
  related_dev_log VARCHAR(60),
  status ENUM('active','superseded','revisited') NOT NULL DEFAULT 'active',
  supersedes_id INT,
  captured_by VARCHAR(50) NOT NULL DEFAULT 'manual',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`).catch(e => console.error('[migration] dev_decisions:', e.message));

await db.execute(`CREATE TABLE IF NOT EXISTS auto_trade_rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  symbol VARCHAR(50) NOT NULL,
  rule_type VARCHAR(20) NOT NULL,
  trigger_price DECIMAL(20,10) NOT NULL,
  direction VARCHAR(10) NOT NULL,
  order_type VARCHAR(10) DEFAULT 'market',
  volume DECIMAL(20,10) NOT NULL,
  max_position_usd DECIMAL(20,4),
  active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_triggered TIMESTAMP NULL,
  source VARCHAR(20) DEFAULT 'manual',
  INDEX idx_active (active)
)`);

// Safe migrations — ER_DUP_FIELDNAME (1060) means column exists, any other error is logged
const safeAddColumn = (table, col, def) =>
  db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`)
    .then(() => console.log(`[migration] ${table}.${col} added`))
    .catch(e => e.code === 'ER_DUP_FIELDNAME' || e.errno === 1060
      ? console.log(`[migration] ${table}.${col} already exists — skipping`)
      : console.error(`[migration] ${table}.${col} error:`, e.message));

await safeAddColumn('auto_trade_rules', 'source',          "VARCHAR(20) DEFAULT 'manual'");
await safeAddColumn('auto_trade_rules', 'volume_type',     "VARCHAR(10) DEFAULT 'fixed'");
await safeAddColumn('auto_trade_rules', 'exchange',        "VARCHAR(20) DEFAULT 'kraken'");
await db.execute("UPDATE auto_trade_rules SET exchange = 'kraken' WHERE exchange IS NULL").catch(() => {});
await safeAddColumn('auto_trade_rules', 'cascade_count',   'INT DEFAULT 0');
await safeAddColumn('auto_trade_rules', 'max_cascades',    'INT DEFAULT 3');
await safeAddColumn('auto_trade_rules', 'cascade_parent_id', 'INT NULL');
await safeAddColumn('auto_trade_rules', 'proceeds_reserved', 'DECIMAL(12,2) NULL');
await safeAddColumn('trading_journal',  'source',          "VARCHAR(20) DEFAULT 'auto_detected'");
await safeAddColumn('trading_journal',  'updated_at',      'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
  await db.execute("ALTER TABLE research_history MODIFY COLUMN drift_verdict TEXT")
    .then(() => console.log('[migration] research_history.drift_verdict widened to TEXT'))
    .catch(e => console.error('[migration] research_history.drift_verdict:', e.message));

// One-time data corrections
try {
  // Fix journal ID 96: was auto-detected as buy, was actually a transfer-in from Kraken
  await db.execute(
    "UPDATE trading_journal SET action = 'transfer', reasoning = 'Transfer in from Kraken — SOL consolidated to Revolut X for auto trading. Auto-detected incorrectly as buy.', claude_recommendation = NULL, claude_reasoning = NULL, followed_recommendation = NULL WHERE id = 96"
  );
  // Remove duplicate correction entry
  await db.execute("DELETE FROM trading_journal WHERE id = 99");
  // Expire old SOL sell intention (ID 3) so it never matches future trades
  await db.execute("UPDATE trade_intentions SET expires_at = NOW(), matched_at = NOW() WHERE id = 3 AND matched_at IS NULL");
  console.log('[migration] One-time data corrections applied (journal 96, delete 99, expire intention 3)');
} catch (e) {
  console.log('[migration] One-time corrections skipped or already applied:', e.message);
}

await db.execute(`CREATE TABLE IF NOT EXISTS rebalancing_tracker (
  id INT AUTO_INCREMENT PRIMARY KEY,
  out_symbol VARCHAR(50) NOT NULL,
  out_price DECIMAL(20,10) NOT NULL,
  out_quantity DECIMAL(20,10),
  out_value_usd DECIMAL(20,4),
  in_symbol VARCHAR(50) NOT NULL,
  in_price DECIMAL(20,10) NOT NULL,
  in_quantity DECIMAL(20,10),
  in_value_usd DECIMAL(20,4),
  rebalance_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  check_date_7 TIMESTAMP NULL,
  check_date_30 TIMESTAMP NULL,
  out_price_7d DECIMAL(20,10) NULL,
  in_price_7d DECIMAL(20,10) NULL,
  out_price_30d DECIMAL(20,10) NULL,
  in_price_30d DECIMAL(20,10) NULL,
  pnl_7d DECIMAL(10,4) NULL,
  pnl_30d DECIMAL(10,4) NULL,
  outcome VARCHAR(20) NULL,
  notes TEXT NULL,
  INDEX idx_rebalance_date (rebalance_date),
  INDEX idx_outcome (outcome)
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS rebalance_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  out_symbol VARCHAR(20) NOT NULL,
  out_price DECIMAL(20,10) NOT NULL,
  out_journal_id INT,
  in_symbol VARCHAR(20),
  in_price DECIMAL(20,10),
  in_journal_id INT,
  value_usd DECIMAL(20,2),
  rebalance_date DATE NOT NULL,
  checked_at TIMESTAMP NULL,
  out_price_at_check DECIMAL(20,10),
  in_price_at_check DECIMAL(20,10),
  verdict TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_rebalance_date (rebalance_date),
  INDEX idx_checked (checked_at)
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS trade_intentions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  symbol VARCHAR(50) NOT NULL,
  action VARCHAR(10) NOT NULL,
  reasoning TEXT NOT NULL,
  emotion VARCHAR(20) DEFAULT 'confident',
  stated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  matched_journal_id INT NULL,
  matched_at TIMESTAMP NULL,
  expires_at TIMESTAMP NOT NULL,
  INDEX idx_symbol_action (symbol, action),
  INDEX idx_expires (expires_at)
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS system_config (
  id INT AUTO_INCREMENT PRIMARY KEY,
  config_key VARCHAR(100) UNIQUE NOT NULL,
  config_value LONGTEXT NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS position_tranches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  symbol VARCHAR(20) NOT NULL,
  exchange VARCHAR(20) NOT NULL DEFAULT 'revolut',
  quantity DECIMAL(20,8) NOT NULL,
  entry_price DECIMAL(20,8) NOT NULL,
  entry_date DATETIME NOT NULL,
  cost_basis DECIMAL(20,8) GENERATED ALWAYS AS (quantity * entry_price) STORED,
  remaining_quantity DECIMAL(20,8) NOT NULL,
  is_legacy TINYINT(1) DEFAULT 0,
  notes VARCHAR(255),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`);
try {
  await db.execute(`CREATE INDEX idx_tranches_symbol ON position_tranches(symbol)`);
} catch (e) { /* index already exists */ }

await db.execute(`CREATE TABLE IF NOT EXISTS reconciliation_log (
  id INT AUTO_INCREMENT PRIMARY KEY,
  run_date DATETIME DEFAULT CURRENT_TIMESTAMP,
  symbol VARCHAR(20) NOT NULL,
  exchange VARCHAR(20) NOT NULL DEFAULT 'revolut',
  exchange_qty DECIMAL(20,8),
  system_qty DECIMAL(20,8),
  tranche_sum DECIMAL(20,8),
  drift_pct DECIMAL(10,4),
  drift_type VARCHAR(40),
  acknowledged TINYINT(1) DEFAULT 0
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS tax_lots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  symbol VARCHAR(50) NOT NULL,
  exchange VARCHAR(20) DEFAULT 'revolut',
  quantity DECIMAL(20,10) NOT NULL,
  cost_basis_usd DECIMAL(20,10) NOT NULL,
  cost_per_unit DECIMAL(20,10) NOT NULL,
  acquired_at TIMESTAMP NOT NULL,
  disposed_at TIMESTAMP NULL,
  disposed_quantity DECIMAL(20,10) NULL,
  disposal_price DECIMAL(20,10) NULL,
  disposal_value_usd DECIMAL(20,10) NULL,
  gain_loss_usd DECIMAL(20,10) NULL,
  holding_days INT NULL,
  is_long_term TINYINT(1) NULL,
  lot_status VARCHAR(20) DEFAULT 'open',
  journal_id INT NULL,
  notes TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_tax_symbol (symbol),
  INDEX idx_tax_status (lot_status),
  INDEX idx_tax_acquired (acquired_at)
)`);

await db.execute(`CREATE TABLE IF NOT EXISTS uk_s104_pool (
  id INT AUTO_INCREMENT PRIMARY KEY,
  symbol VARCHAR(50) UNIQUE NOT NULL,
  total_quantity DECIMAL(20,10) NOT NULL DEFAULT 0,
  total_cost_gbp DECIMAL(20,10) NOT NULL DEFAULT 0,
  average_cost_gbp DECIMAL(20,10) NOT NULL DEFAULT 0,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
)`);

await safeAddColumn('price_targets',    'direction',       "VARCHAR(4) NOT NULL DEFAULT 'up'");
await safeAddColumn('price_targets',    'note',            'TEXT');

// ── dev_log #38 Part 1 — price_targets multi-target schema migration ──────────
// Idempotent: checks for 'id' column before running. Safe to repeat on every boot.
try {
  const [idColRows] = await db.execute(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME   = 'price_targets'
      AND COLUMN_NAME  = 'id'
  `);
  if (idColRows.length > 0) {
    console.log('[migration] price_targets multi-target PK already applied — skipping');
  } else {
    // Single ALTER: DROP symbol PK + ADD id column + ADD id PK — table never without a PK
    await db.execute(`
      ALTER TABLE price_targets
        DROP PRIMARY KEY,
        ADD COLUMN id BIGINT NOT NULL AUTO_INCREMENT FIRST,
        ADD PRIMARY KEY (id)
    `);
    // Separate ALTER: add unique constraint on (symbol, direction, target_price)
    // 21 existing rows are each unique on this triple — no collision risk
    await db.execute(`
      ALTER TABLE price_targets
        ADD UNIQUE KEY uq_target (symbol, direction, target_price)
    `);
    console.log('[migration] price_targets migrated to multi-target (id PK + unique symbol/direction/target_price)');
  }
} catch (e) {
  console.error('[migration] price_targets multi-target FAILED:', e.message);
}

await safeAddColumn('custom_thresholds','acknowledged_until','TIMESTAMP NULL DEFAULT NULL');

// Track Claude API usage and costs
await db.execute(`CREATE TABLE IF NOT EXISTS claude_api_calls (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  reason         VARCHAR(100) NOT NULL,
  model          VARCHAR(60) NOT NULL,
  input_tokens   INT DEFAULT 0,
  output_tokens  INT DEFAULT 0,
  cache_read_tokens INT DEFAULT 0,
  estimated_cost DECIMAL(10,6) DEFAULT 0,
  created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).catch(e => console.error('[migration] claude_api_calls:', e.message));

// Track manually deleted auto-rules so seeding logic never recreates them
await db.execute(`CREATE TABLE IF NOT EXISTS deleted_rules_log (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  rule_id     INT NOT NULL,
  symbol      VARCHAR(20) NOT NULL,
  exchange    VARCHAR(20),
  rule_type   VARCHAR(50),
  order_type  VARCHAR(10),
  direction   VARCHAR(10),
  trigger_price DECIMAL(12,4),
  volume      DECIMAL(12,4),
  deleted_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`).catch(e => console.error('[migration] deleted_rules_log:', e.message));

await safeAddColumn('macro_alerts_sent', 'message',    'TEXT');
await safeAddColumn('macro_alerts_sent', 'symbol',     'VARCHAR(50) NULL');
await safeAddColumn('macro_alerts_sent', 'alert_type', "VARCHAR(30) DEFAULT 'macro'");
await safeAddColumn('ignored_coins',     'ignore_type', "VARCHAR(20) DEFAULT 'permanent'");
await safeAddColumn('ignored_coins',     'expires_at',  'TIMESTAMP NULL');

// Cost basis tracking — preserve original entry price across sell→buyback cycles
await safeAddColumn('entry_prices', 'original_entry_price', 'DECIMAL(20,10) NULL');
await safeAddColumn('entry_prices', 'last_sold_price',     'DECIMAL(20,10) NULL');
await safeAddColumn('entry_prices', 'last_sold_at',        'TIMESTAMP NULL');
await safeAddColumn('entry_prices', 'original_entry_date',  'TIMESTAMP NULL');
await safeAddColumn('entry_prices', 'cycle_count',          'INT DEFAULT 0');
await safeAddColumn('entry_prices', 'created_at',           'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');

// Backfill: preserve current entry prices as original for all existing positions
await db.execute(`
  UPDATE entry_prices
  SET original_entry_price = entry_price,
      original_entry_date  = COALESCE(updated_at, NOW())
  WHERE original_entry_price IS NULL
`).catch(e => console.warn('[migration] entry_prices backfill:', e.message));

// One-time cleanup: remove ghost symbols created by parser errors (words mistaken for coin names)
try {
  const ghostSymbols = ['RISES-USD', 'RAISE-USD', 'TRADE-USD'];
  const placeholders = ghostSymbols.map(() => '?').join(', ');
  const [r1] = await db.execute(`DELETE FROM custom_thresholds WHERE symbol IN (${placeholders})`, ghostSymbols);
  const [r2] = await db.execute(`DELETE FROM price_targets WHERE symbol IN (${placeholders})`, ghostSymbols);
  if (r1.affectedRows > 0 || r2.affectedRows > 0) {
    console.log(`[cleanup] Removed ghost symbols — custom_thresholds: ${r1.affectedRows} row(s), price_targets: ${r2.affectedRows} row(s)`);
  }
} catch (e) { console.warn('[cleanup] Ghost symbol cleanup failed:', e.message); }

// Seed Tangem XRP entry price if not already set
try {
  await db.execute(
    'INSERT INTO entry_prices (symbol, entry_price) VALUES (?, ?) ON DUPLICATE KEY UPDATE entry_price = entry_price',
    ['XRP-USD', TANGEM_XRP_ENTRY]
  );
  if (!entryPrices.has('XRP-USD')) entryPrices.set('XRP-USD', TANGEM_XRP_ENTRY);
} catch (e) { console.warn('[tangem] Failed to seed XRP entry price:', e.message); }

// Load permanently ignored coins from DB
try {
  const [ignoredRows] = await db.execute("SELECT symbol FROM ignored_coins WHERE ignore_type = 'permanent' OR ignore_type IS NULL");
  for (const row of ignoredRows) ignoredCoins.add(row.symbol);
  if (ignoredRows.length > 0) console.log(`[ignore] Loaded ${ignoredRows.length} ignored coin(s):`, [...ignoredCoins].join(', '));
} catch (e) { console.warn('[ignore] Could not load ignored coins:', e.message); }

// Restore session-acknowledged coins from DB (24h window — survives redeploy)
try {
  const [ackedRows] = await db.execute(
    "SELECT symbol FROM ignored_coins WHERE ignore_type = 'session' AND expires_at > NOW()"
  );
  for (const row of ackedRows) alertState.acknowledged.add(row.symbol);
  if (ackedRows.length > 0) console.log(`[ack] Restored ${ackedRows.length} acknowledged coin(s) from DB:`, ackedRows.map(r => r.symbol).join(', '));
} catch (e) { console.warn('[ack] Could not restore acknowledged coins:', e.message); }

// Restore recently acknowledged fixed-target alerts (4h window)
try {
  const [targetAckRows] = await db.execute(
    "SELECT symbol FROM macro_alerts_sent WHERE alert_type = 'target_acknowledged' AND sent_at > DATE_SUB(NOW(), INTERVAL 4 HOUR) AND symbol IS NOT NULL"
  );
  for (const row of targetAckRows) {
    alertState.acknowledged.add(row.symbol);
    console.log(`[ack] Restored target ack: ${row.symbol}`);
  }
} catch (e) { console.warn('[ack] Could not restore target acks:', e.message); }

// Restore today's alert reminder counts (pump/drop) so redeploy doesn't double-remind
try {
  const [reminderRows] = await db.execute(
    'SELECT symbol, count FROM alert_reminders WHERE alert_date = CURDATE()'
  );
  for (const row of reminderRows) {
    if (parseInt(row.count) >= 1) alertReminderSent.set(row.symbol, Date.now());
    if (parseInt(row.count) >= 1) alertFirstSent.set(row.symbol, Date.now() - 15 * 60 * 1000); // set as if sent 15 min ago
  }
  if (reminderRows.length > 0) console.log(`[reminder] Restored ${reminderRows.length} reminder state(s) from DB`);
} catch (e) { console.warn('[reminder] Could not restore reminder counts:', e.message); }

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

const [ptRows] = await db.execute('SELECT id, symbol, anchor_price, threshold_pct, target_price, entry_price, direction, note FROM price_targets');
for (const row of ptRows) {
  const t = {
    id: row.id,
    anchorPrice: parseFloat(row.anchor_price),
    thresholdPct: parseFloat(row.threshold_pct),
    targetPrice: parseFloat(row.target_price),
    entryPrice: row.entry_price ? parseFloat(row.entry_price) : null,
    direction: row.direction || 'up',
    note: row.note || null
  };
  const arr = priceTargets.get(row.symbol) || [];
  arr.push(t);
  priceTargets.set(row.symbol, arr);
}
const totalTargets = [...priceTargets.values()].reduce((s, arr) => s + arr.length, 0);
console.log(`Loaded ${totalTargets} price targets from database (${priceTargets.size} symbol(s))`);

// Startup cross-check: remove price_targets that are already covered by an active auto rule
// e.g. if SOL-USD has a sell rule at $150 and a 'up' price target at $150 — target is redundant
try {
  const [activeRules] = await db.execute(
    "SELECT symbol, order_type, trigger_price FROM auto_trade_rules WHERE active = 1"
  );
  let removedCount = 0;
  for (const [symbol, targetArr] of priceTargets) {
    for (const target of [...targetArr]) { // #38 B1: iterate each element; copy so in-loop deletes are safe
    const dir = target.direction || 'up';
    const tPrice = target.targetPrice;
    // Check if any active rule makes this target redundant
    const redundant = activeRules.some(r => {
      if (r.symbol !== symbol) return false;
      if (dir === 'up' && r.order_type === 'sell') {
        // Sell rule at or below target means the auto rule will fire first
        return parseFloat(r.trigger_price) <= tPrice;
      }
      if (dir === 'down' && r.order_type === 'buy') {
        // Buy rule at or above target means the auto rule will fire first
        return parseFloat(r.trigger_price) >= tPrice;
      }
      return false;
    });
    if (redundant) {
      console.log(`[startup] Removing redundant price target for ${symbol} id=${target.id} — already covered by auto rule`);
      const arr38cc = priceTargets.get(symbol) || [];
      const filtered38cc = arr38cc.filter(t => t.id !== target.id);
      if (filtered38cc.length) priceTargets.set(symbol, filtered38cc);
      else priceTargets.delete(symbol);
      await db.execute('DELETE FROM price_targets WHERE id = ?', [target.id]).catch(e => console.error('[startup] Delete target failed:', e.message));
      removedCount++;
    }
    } // end inner target loop — #38 B1
  }
  if (removedCount > 0) console.log(`[startup] Removed ${removedCount} redundant price target(s)`);
} catch (e) {
  console.warn('[startup] Price target cross-check failed:', e.message);
}

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

// Load USDT/USD baseline — DB first (survives redeployments), live balance as fallback
try {
  const [baseRows] = await db.execute(
    "SELECT config_key, config_value FROM system_config WHERE config_key IN ('last_known_usdt','last_known_usd')"
  );
  for (const row of baseRows) {
    if (row.config_key === 'last_known_usdt') { lastKnownUSDT = parseFloat(row.config_value); console.log(`[usdt] Loaded USDT baseline from DB: ${lastKnownUSDT}`); }
    if (row.config_key === 'last_known_usd')  { lastKnownUSD  = parseFloat(row.config_value); console.log(`[usdt] Loaded USD baseline from DB: ${lastKnownUSD}`); }
  }
  if (lastKnownUSDT === null || lastKnownUSD === null) {
    const startupBals = await revolutRequest('GET', '/balances');
    if (lastKnownUSDT === null) { const a = startupBals.find(b => b.currency === 'USDT'); lastKnownUSDT = parseFloat(a?.available || 0); console.log(`[usdt] USDT baseline from live: ${lastKnownUSDT}`); }
    if (lastKnownUSD  === null) { const a = startupBals.find(b => b.currency === 'USD');  lastKnownUSD  = parseFloat(a?.available || 0); console.log(`[usdt] USD baseline from live: ${lastKnownUSD}`); }
  }
} catch (e) {
  console.error('[usdt] Baseline load error:', e.message);
}

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

// Load trailing stops from DB
try {
  const [tsRows] = await db.execute('SELECT * FROM trailing_stops');
  for (const row of tsRows) {
    trailingStops.set(row.symbol, {
      trailPct:   parseFloat(row.trail_pct),
      peakPrice:  parseFloat(row.peak_price),
      stopPrice:  parseFloat(row.stop_price),
      entryPrice: row.entry_price ? parseFloat(row.entry_price) : null
    });
  }
  console.log(`Loaded ${tsRows.length} trailing stops from database`);
} catch (e) {
  console.error('Failed to load trailing stops:', e.message);
}

// Load swing cooldowns from DB
try {
  const [cooldownRows] = await db.execute('SELECT symbol, last_alert_at FROM swing_cooldowns');
  for (const row of cooldownRows) {
    swingAlertCooldown.set(row.symbol, new Date(row.last_alert_at).getTime());
  }
  console.log(`Loaded ${cooldownRows.length} swing cooldowns from database`);
} catch (e) {
  console.error('Failed to load swing cooldowns:', e.message);
}

// One-time cleanup: remove any lingering SOL Kraken auto-rules that were recreated by the old seed block
try {
  const [deleted] = await db.execute(
    "DELETE FROM auto_trade_rules WHERE symbol = 'SOL-USD' AND exchange = 'kraken'"
  );
  if (deleted.affectedRows > 0) {
    console.log(`[cleanup] Removed ${deleted.affectedRows} stale SOL Kraken auto-rules from DB`);
  }
} catch (e) {
  console.warn('[cleanup] SOL Kraken rule cleanup failed:', e.message);
}

// Cleanup: remove USDT false-positive entries (auto_detected conversions + old revolut_card)
// NOTE: auto_internal rows are intentional (#82 Fix B — trade-funding classification) — do NOT delete them
try {
  const [c1] = await db.execute(`
    DELETE FROM trading_journal
    WHERE symbol = 'USDT'
    AND source = 'auto_detected'
    AND reasoning LIKE 'USDT conversion%'
  `);
  // c3 (revolut_card deletion) REMOVED 2026-06-16: it had no upper date bound and deleted every
  // legitimate card payment on every boot, undermining the auto-log payment feature. Card payments must persist.
  const total = (c1.affectedRows || 0);
  if (total > 0) console.log(`[cleanup] Removed ${total} USDT false-positive entries (auto_detected:${c1.affectedRows})`);
  const [remaining] = await db.execute(`SELECT COUNT(*) as cnt FROM trading_journal WHERE symbol = 'USDT'`);
  console.log(`[cleanup] USDT entries remaining: ${remaining[0].cnt}`);
} catch (e) {
  console.warn('[cleanup] USDT cleanup error:', e.message);
}

// Cleanup: remove '-USD' suffixed duplicates where a better-reasoned non-USD entry exists
try {
  const [symDupes] = await db.execute(`
    DELETE t1 FROM trading_journal t1
    INNER JOIN trading_journal t2 ON (
      REPLACE(t1.symbol, '-USD', '') = REPLACE(t2.symbol, '-USD', '')
      AND t1.action = t2.action
      AND ABS(CAST(t1.quantity AS DECIMAL(20,8)) - CAST(t2.quantity AS DECIMAL(20,8))) < 0.01
      AND ABS(TIMESTAMPDIFF(SECOND, t1.created_at, t2.created_at)) < 300
      AND t1.id > t2.id
    )
    WHERE t1.symbol LIKE '%-USD'
    AND (t1.reasoning IS NULL OR t1.reasoning = '' OR t1.reasoning = 'no reason provided' OR t1.reasoning = 'auto-detected')
    AND t2.reasoning IS NOT NULL AND LENGTH(t2.reasoning) > 5
    AND t1.created_at > '2026-05-01 00:00:00'
  `);
  if (symDupes.affectedRows > 0) {
    console.log(`[cleanup] Removed ${symDupes.affectedRows} symbol-suffix duplicate journal entries`);
  }
} catch (e) {
  console.warn('[cleanup] Symbol dedup cleanup error:', e.message);
}

// Seed XLM sold history if last_sold_at is not set (one-time backfill for known sell on 2026-06-02)
try {
  await db.execute(`
    UPDATE entry_prices
    SET last_sold_price       = COALESCE(last_sold_price, 0.2341),
        last_sold_at          = COALESCE(last_sold_at,    '2026-06-02 02:07:18'),
        cycle_count           = GREATEST(COALESCE(cycle_count, 0), 1),
        original_entry_price  = COALESCE(original_entry_price, 0.386)
    WHERE symbol = 'XLM-USD'
    AND last_sold_at IS NULL
  `);
} catch (e) { console.warn('[seed] XLM sold history seed:', e.message); }

// Backfill coin_cash_flows from existing trading_journal (idempotent — ON DUPLICATE KEY ignores already-loaded rows)
try {
  const [bfResult] = await db.execute(`
    INSERT IGNORE INTO coin_cash_flows
      (symbol, flow_type, cash_amount, token_quantity, price, journal_id, created_at)
    SELECT
      symbol,
      action,
      ABS(CAST(value_usd AS DECIMAL(20,8))),
      ABS(CAST(quantity AS DECIMAL(20,8))),
      ABS(CAST(price AS DECIMAL(20,10))),
      id,
      created_at
    FROM trading_journal
    WHERE action IN ('buy','sell')
      AND symbol NOT IN ('USDT','USD','USDT-USD','USD-USD')
      AND value_usd IS NOT NULL
      AND quantity IS NOT NULL
      AND price IS NOT NULL
      AND price > 0
  `);
  if (bfResult.affectedRows > 0) console.log(`[cash-flows] Backfilled ${bfResult.affectedRows} rows from trading_journal`);
} catch (e) { console.warn('[cash-flows] Backfill error:', e.message); }

// Seed system config — always keep project description current
try {
  await db.execute(
    'INSERT INTO system_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)',
    ['project_description', `## REVOLUT X AI PORTFOLIO MANAGER

### INFRASTRUCTURE
- Railway server: https://revolut-claude-production.up.railway.app
- GitHub: https://github.com/BurhanDawood/revolut-claude
- Local code: C:\\Users\\owner\\revolut-claude\\server.js
- Database: MySQL on Railway
- Stack: Node.js/Express, MySQL, Anthropic API, Telegram Bot API
- Revolut X API: REVOLUTX_API_KEY + REVOLUTX_PRIVATE_KEY in Railway env vars
- Kraken API: KRAKEN_API_KEY + KRAKEN_PRIVATE_KEY in Railway env vars

### MCP TOOLS (11 active)
get_context, get_portfolio_summary, get_portfolio_data,
get_trading_data, manage_alerts, manage_trading,
set_entry_price, execute_kraken_trade,
set_auto_trade_rule, get_auto_rules, get_prices

### ROADMAP
1. Kraken monitoring and trade execution DONE
2. Tangem XRP wallet integration DONE
3. SOL fully automated trading DONE
4. Trade intention system DONE
5. MCP tools consolidated to 11 DONE
6. Revolut X trade execution DONE
7. Tax lot tracking US HIFO and UK S104 DONE
8. Native mobile app PENDING
9. Portfolio rebalancing automation PENDING
10. Auto compound profits PENDING`]
  );
  const MCP_TOOL_NAMES = [
    'get_portfolio_summary', 'get_portfolio_data', 'get_trading_data',
    'get_context', 'manage_alerts', 'manage_trading',
    'set_entry_price', 'execute_kraken_trade',
    'set_auto_trade_rule', 'get_auto_rules', 'get_prices',
    'get_tranches', 'manage_auto_rules', 'research_asset'
  ];
  await db.execute(
    'INSERT INTO system_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)',
    ['system_capabilities', JSON.stringify({
      last_updated: new Date().toISOString(),
      total_mcp_tools: MCP_TOOL_NAMES.length,
      tools: MCP_TOOL_NAMES,
      trade_execution: {
        revolut_x: true,
        kraken: true,
        symbol_format: 'LINK-USD dash format for orders',
        supports_quote_size: true,
        supports_base_size: true
      },
      tax_tracking: {
        us_hifo: true,
        uk_s104: true,
        csv_export: true,
        dual_jurisdiction: true
      },
      roadmap_completed: [
        'Kraken monitoring and trade execution',
        'Tangem XRP wallet integration',
        'SOL fully automated trading with cascading rules',
        'Trade intention system',
        'MCP tools consolidated (14 active incl. research_asset)',
        'Revolut X trade execution',
        'Tax lot tracking US HIFO and UK S104'
      ],
      roadmap_pending: [
        'Native mobile app',
        'Portfolio rebalancing automation',
        'Auto compound profits into winners'
      ]
    }, null, 2)]
  );
  console.log('[config] Project description seeded to system_config');
  const [csCount] = await db.execute('SELECT COUNT(*) AS n FROM coin_strategy');
  if (csCount[0].n === 0) {
    const [csPrefs] = await db.execute(
      "SELECT preference_key, preference_value FROM trader_profile WHERE preference_key LIKE 'coin_strategy_%' AND preference_key != 'coin_strategy_INDEX'"
    );
    for (const p of csPrefs) {
      const csSym = p.preference_key.replace('coin_strategy_', '').toUpperCase();
      await db.execute(
        'INSERT IGNORE INTO coin_strategy (symbol, strategy_md, updated_by) VALUES (?, ?, ?)',
        [csSym, p.preference_value, 'seed_migration']
      );
    }
    console.log(`[config] coin_strategy seeded: ${csPrefs.length} rows from preferences`);
  }
} catch (e) {
  console.error('[config] Failed to seed project_description:', e.message);
}

// Seed AI auto-execute config — preserve existing settings but add hodl_symbols / manual_only_symbols if missing
try {
  const [existingAE] = await db.execute(
    "SELECT config_value FROM system_config WHERE config_key = 'ai_auto_execute'"
  );
  const defaultHodl       = ['ENA','JTO','RENDER','INJ','FET','ALGO','AVAX','ADA','HBAR','ILV','PYTH','SUPER','SEI','MOG','HFT','CRO','FLR','POL','XLM','BONK'];
  const defaultManualOnly = ['CC','XRP','NEAR'];
  if (existingAE.length > 0) {
    // Patch hodl_symbols and manual_only_symbols into existing config without touching other settings
    const existing = JSON.parse(existingAE[0].config_value);
    let changed = false;
    if (!existing.hodl_symbols) {
      existing.hodl_symbols = defaultHodl;
      changed = true;
      console.log('[config] hodl_symbols patched into existing ai_auto_execute config');
    }
    if (!existing.manual_only_symbols) {
      existing.manual_only_symbols = defaultManualOnly;
      changed = true;
      console.log('[config] manual_only_symbols patched into existing ai_auto_execute config');
    }
    if (changed) {
      await db.execute(
        "UPDATE system_config SET config_value = ? WHERE config_key = 'ai_auto_execute'",
        [JSON.stringify(existing)]
      );
    }
  } else {
    await db.execute(
      'INSERT INTO system_config (config_key, config_value) VALUES (?, ?)',
      ['ai_auto_execute', JSON.stringify({
        enabled: false, max_sell_pct: 25, max_buy_usd: 100,
        allowed_triggers: ['trailing_stop', 'fixed_target', 'pump_alert'],
        require_confidence: 'High', cooldown_minutes: 60,
        hodl_symbols: defaultHodl,
        manual_only_symbols: defaultManualOnly
      })]
    );
    console.log('[config] AI auto-execute config seeded with hodl_symbols and manual_only_symbols');
  }
} catch (e) {
  console.error('[config] Failed to seed ai_auto_execute:', e.message);
}

// Seed default USDT sweep config (ON CONFLICT DO NOTHING — preserves user settings)
try {
  await db.execute(
    'INSERT INTO system_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_key = config_key',
    ['usdt_sweep_config', JSON.stringify({
      enabled: false,
      sweep_pct: 20,
      min_trade_value_usd: 50,
      applies_to: 'all',
      excluded_symbols: [],
      created_at: new Date().toISOString()
    })]
  );
  console.log('[config] USDT sweep config seeded');
} catch (e) {
  console.error('[config] Failed to seed usdt_sweep_config:', e.message);
}

seedLegacyTranches().catch(e => console.error('[tranches] Startup seed failed:', e.message));

// ── Auto-execute: enable in DB + startup status log ──────────────────────────
(async () => {
  try {
    const [rows] = await db.execute(
      "SELECT config_value FROM system_config WHERE config_key = 'ai_auto_execute'"
    );
    if (rows.length) {
      const cfg = JSON.parse(rows[0].config_value);


      // Fix 4: status log every startup
      const reloaded = JSON.parse((await db.execute(
        "SELECT config_value FROM system_config WHERE config_key = 'ai_auto_execute'"
      ))[0][0]?.config_value || '{}');
      console.log(
        `[auto-exec] Status on startup: ${reloaded.enabled ? 'ENABLED ✅' : 'DISABLED ❌'} | ` +
        `Max sell: ${reloaded.max_sell_pct}% | ` +
        `Confidence: ${reloaded.require_confidence} | ` +
        `Cooldown: ${reloaded.cooldown_minutes}min`
      );
    } else {
      console.log('[auto-exec] No config found in system_config — using defaults (disabled)');
    }
  } catch (e) {
    console.error('[auto-exec] Startup check failed:', e.message);
  }
})();
// ─────────────────────────────────────────────────────────────────────────────

// Generate learning model on startup if missing or never generated
(async () => {
  try {
    const [lmCheck] = await db.execute(
      "SELECT config_value FROM system_config WHERE config_key = 'learning_model'"
    );
    if (!lmCheck.length || !lmCheck[0].config_value || lmCheck[0].config_value === 'Not yet generated') {
      console.log('[learning] No model cached — generating initial model on startup...');
      await updateLearningModel().catch(e => console.error('[learning] Initial generation failed:', e.message));
    } else {
      console.log('[learning] Existing model found — skipping startup regeneration');
    }
  } catch (e) {
    // system_config may not have a learning_model row — just run it
    console.log('[learning] Could not check model cache — running updateLearningModel()');
    await updateLearningModel().catch(() => {});
  }
})();

// ── Tranche Helpers ───────────────────────────────────────────────────────────

async function seedLegacyTranches() {
  try {
    const [existing] = await db.execute('SELECT COUNT(*) as count FROM position_tranches WHERE is_legacy = 1');
    if (existing[0].count > 0) {
      console.log('[tranches] Legacy tranches already seeded — skipping');
      return;
    }
    const [entries] = await db.execute('SELECT symbol, entry_price FROM entry_prices WHERE entry_price IS NOT NULL AND entry_price > 0');
    for (const row of entries) {
      const coinBase = row.symbol.replace('-USD', '');
      const [balRow] = await db.execute(
        'SELECT quantity FROM balance_snapshots WHERE symbol = ? ORDER BY recorded_at DESC LIMIT 1',
        [row.symbol]
      );
      const qty = parseFloat(balRow[0]?.quantity || 0);
      if (qty <= 0) continue;
      await db.execute(
        `INSERT INTO position_tranches (symbol, exchange, quantity, entry_price, entry_date, remaining_quantity, is_legacy, notes)
         VALUES (?, 'revolut', ?, ?, NOW(), ?, 1, 'Legacy tranche — seeded from avg entry price')`,
        [coinBase, qty, row.entry_price, qty]
      );
      console.log(`[tranches] Seeded legacy tranche: ${coinBase} qty=${qty} entry=${row.entry_price}`);
    }
    console.log('[tranches] Legacy tranche seeding complete');
  } catch (e) {
    console.error('[tranches] seedLegacyTranches failed:', e.message);
  }
}

async function reduceTranches(symbol, exchange, qtySold) {
  try {
    const coinBase = symbol.replace('-USD', '');
    const [tranches] = await db.execute(
      `SELECT id, remaining_quantity, entry_price FROM position_tranches
       WHERE symbol = ? AND exchange = ? AND remaining_quantity > 0
       ORDER BY entry_price DESC`,
      [coinBase, exchange]
    );
    let remaining = parseFloat(qtySold);
    for (const tranche of tranches) {
      if (remaining <= 0) break;
      const available = parseFloat(tranche.remaining_quantity);
      const toReduce = Math.min(available, remaining);
      const newQty = available - toReduce;
      await db.execute(
        'UPDATE position_tranches SET remaining_quantity = ?, updated_at = NOW() WHERE id = ?',
        [newQty, tranche.id]
      );
      remaining -= toReduce;
      console.log(`[tranches] Reduced tranche ${tranche.id} (entry $${tranche.entry_price}) by ${toReduce} — remaining: ${newQty}`);
    }
  } catch (e) {
    console.error('[tranches] reduceTranches failed:', e.message);
  }
}

// ── Do-Not-Disturb Helper ─────────────────────────────────────────────────────

function hasAgreedStrategy(symbol) {
  return (
    priceTargets.has(symbol) ||    // fixed target/alert set
    trailingStops.has(symbol) ||   // trailing stop active
    ignoredCoins.has(symbol)       // permanently silenced
  );
}

// ── Trade Approval Reminder + Auto-Cancel ────────────────────────────────────

function startTradeApprovalReminder(exchange) {
  const t = exchange === 'revolut' ? pendingRevolutTrade : pendingKrakenTrade;
  if (!t) return;

  let reminderCount = 0;
  const maxReminders = 5;
  const reminderInterval = 2.5 * 60 * 1000; // 2.5 minutes

  const intervalId = setInterval(async () => {
    reminderCount++;

    const current = exchange === 'revolut' ? pendingRevolutTrade : pendingKrakenTrade;
    if (!current) {
      // Trade was approved or cancelled — stop reminders
      clearInterval(intervalId);
      if (exchange === 'revolut') pendingRevolutTradeReminder = null;
      else pendingKrakenTradeReminder = null;
      return;
    }

    const coinBase = current.symbol.replace('-USD', '');
    const exchangeLabel = exchange === 'revolut' ? 'Revolut X' : 'Kraken';
    const qtyDisplay = formatTradeQty(current.volume || current.baseSize);

    if (reminderCount >= maxReminders) {
      // Auto-cancel after 5 reminders (~12.5 minutes total)
      clearInterval(intervalId);
      if (exchange === 'revolut') {
        pendingRevolutTrade = null;
        pendingRevolutTradeReminder = null;
      } else {
        pendingKrakenTrade = null;
        pendingKrakenTradeReminder = null;
      }
      await sendTelegram(
        `⚠️ <b>TRADE AUTO-CANCELLED — ${coinBase}</b>\n\n` +
        `No response received within 12 minutes.\n` +
        `${current.side.toUpperCase()} ${qtyDisplay} ${coinBase} on ${exchangeLabel} was NOT executed.\n\n` +
        `Safety auto-cancel — request again when ready.`
      ).catch(e => console.error('[trade reminder] auto-cancel telegram failed:', e.message));
      console.log(`[trade] Auto-cancelled ${exchange} trade for ${coinBase} after ${maxReminders} reminders`);
      return;
    }

    // Send reminder using standard approval format
    await sendTelegram(
      formatApprovalRequest(coinBase, current.side, current.volume || current.baseSize, current.price, current.valueUSD, exchange) +
      `\n\n⏰ Reminder ${reminderCount}/${maxReminders} — auto-cancels in ${((maxReminders - reminderCount) * 2.5).toFixed(0)} min`
    ).catch(e => console.error('[trade reminder] telegram failed:', e.message));
    console.log(`[trade] Reminder ${reminderCount}/${maxReminders} sent for ${exchange} ${coinBase}`);
  }, reminderInterval);

  if (exchange === 'revolut') pendingRevolutTradeReminder = intervalId;
  else pendingKrakenTradeReminder = intervalId;
}

// ── Tax Lot Helpers (US HIFO + UK S104) ──────────────────────────────────────

async function addTaxLot(symbol, exchange, quantity, costPerUnit, acquiredAt, journalId, notes = null) {
  try {
    const costBasis = quantity * costPerUnit;
    await db.execute(
      `INSERT INTO tax_lots (symbol, exchange, quantity, cost_basis_usd, cost_per_unit, acquired_at, journal_id, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [symbol, exchange, quantity, costBasis, costPerUnit, acquiredAt, journalId, notes]
    );
    console.log(`[tax] Lot added: ${quantity} ${symbol} @ $${costPerUnit}`);
  } catch (e) {
    console.error('[tax] addTaxLot error:', e.message);
  }
}

async function disposeTaxLotsHIFO(symbol, quantity, disposalPrice, disposedAt, journalId) {
  try {
    const [openLots] = await db.execute(
      `SELECT * FROM tax_lots WHERE symbol = ? AND lot_status = 'open'
       ORDER BY cost_per_unit DESC, acquired_at ASC`,
      [symbol]
    );

    let remainingQty = quantity;
    const disposals = [];

    for (const lot of openLots) {
      if (remainingQty <= 0) break;

      const lotQty = parseFloat(lot.quantity);
      const qtyFromThisLot = Math.min(remainingQty, lotQty);
      const costPerUnit = parseFloat(lot.cost_per_unit);
      const gainLoss = (disposalPrice - costPerUnit) * qtyFromThisLot;
      const holdingDays = Math.floor(
        (new Date(disposedAt) - new Date(lot.acquired_at)) / (1000 * 60 * 60 * 24)
      );
      const isLongTerm = holdingDays >= 365;

      if (qtyFromThisLot >= lotQty) {
        await db.execute(
          `UPDATE tax_lots SET lot_status = 'closed', disposed_at = ?, disposed_quantity = ?,
           disposal_price = ?, disposal_value_usd = ?, gain_loss_usd = ?,
           holding_days = ?, is_long_term = ? WHERE id = ?`,
          [disposedAt, qtyFromThisLot, disposalPrice, disposalPrice * qtyFromThisLot,
           gainLoss, holdingDays, isLongTerm ? 1 : 0, lot.id]
        );
      } else {
        // Partial lot — mark original then create remainder
        await db.execute(
          `UPDATE tax_lots SET lot_status = 'partial', disposed_quantity = ?,
           disposal_price = ?, disposal_value_usd = ?, gain_loss_usd = ?,
           holding_days = ?, is_long_term = ? WHERE id = ?`,
          [qtyFromThisLot, disposalPrice, disposalPrice * qtyFromThisLot,
           gainLoss, holdingDays, isLongTerm ? 1 : 0, lot.id]
        );
        await db.execute(
          `INSERT INTO tax_lots (symbol, exchange, quantity, cost_basis_usd, cost_per_unit, acquired_at, lot_status, notes)
           VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
          [symbol, lot.exchange, lotQty - qtyFromThisLot,
           (lotQty - qtyFromThisLot) * costPerUnit, costPerUnit, lot.acquired_at,
           `Remainder after partial disposal on ${disposedAt}`]
        );
      }

      disposals.push({
        lot_id: lot.id, quantity: qtyFromThisLot, cost_per_unit: costPerUnit,
        disposal_price: disposalPrice, gain_loss_usd: gainLoss,
        holding_days: holdingDays, is_long_term: isLongTerm,
        term: isLongTerm ? 'long-term' : 'short-term'
      });
      remainingQty -= qtyFromThisLot;
    }

    const totalGL = disposals.reduce((s, d) => s + d.gain_loss_usd, 0);
    console.log(`[tax] HIFO disposal: ${quantity} ${symbol} @ $${disposalPrice}`);
    console.log(`[tax] Lots used: ${disposals.length}, Total gain/loss: $${totalGL.toFixed(2)}`);
    return disposals;
  } catch (e) {
    console.error('[tax] disposeTaxLotsHIFO error:', e.message);
    return [];
  }
}

async function updateS104Pool(symbol, action, quantity, priceGbp) {
  try {
    const [pool] = await db.execute('SELECT * FROM uk_s104_pool WHERE symbol = ?', [symbol]);

    if (action === 'buy') {
      if (pool.length === 0) {
        await db.execute(
          `INSERT INTO uk_s104_pool (symbol, total_quantity, total_cost_gbp, average_cost_gbp)
           VALUES (?, ?, ?, ?)`,
          [symbol, quantity, quantity * priceGbp, priceGbp]
        );
      } else {
        const newQty  = parseFloat(pool[0].total_quantity) + quantity;
        const newCost = parseFloat(pool[0].total_cost_gbp) + (quantity * priceGbp);
        await db.execute(
          `UPDATE uk_s104_pool SET total_quantity = ?, total_cost_gbp = ?, average_cost_gbp = ? WHERE symbol = ?`,
          [newQty, newCost, newCost / newQty, symbol]
        );
      }
    } else if (action === 'sell' && pool.length > 0) {
      const avgCost = parseFloat(pool[0].average_cost_gbp);
      const newQty  = parseFloat(pool[0].total_quantity) - quantity;
      const newCost = newQty * avgCost;
      if (newQty <= 0) {
        await db.execute('DELETE FROM uk_s104_pool WHERE symbol = ?', [symbol]);
      } else {
        await db.execute(
          `UPDATE uk_s104_pool SET total_quantity = ?, total_cost_gbp = ? WHERE symbol = ?`,
          [newQty, newCost, symbol]
        );
      }
    }
    console.log(`[tax] UK S104 pool updated for ${symbol}`);
  } catch (e) {
    console.error('[tax] updateS104Pool error:', e.message);
  }
}

// ── Invested Capital Helpers ──────────────────────────────────────────────────

function getCapitalSummary(portfolioValue) {
  const invested = totalInvestedCapital;
  const pnl = portfolioValue - invested;
  const pnlPct = invested > 0 ? (pnl / invested * 100) : 0;
  const breakEvenPct = portfolioValue > 0 && pnl < 0 ? ((invested - portfolioValue) / portfolioValue * 100) : 0;
  return { invested, portfolioValue, pnl, pnlPct, breakEvenPct };
}

async function updateInvestedCapital(newTotal, note) {
  const change = newTotal - totalInvestedCapital;
  // Block suspicious single-cycle drops > $200 — real payments are rarely this large
  if (change < -200) {
    console.error(`[capital] SUSPICIOUS DROP BLOCKED: $${totalInvestedCapital.toFixed(2)} → $${newTotal.toFixed(2)} (-$${Math.abs(change).toFixed(2)}) | reason: ${note}`);
    await sendTelegram(
      `⚠️ <b>CAPITAL CHANGE BLOCKED</b>\n\n` +
      `Old: $${totalInvestedCapital.toFixed(2)}\n` +
      `New: $${newTotal.toFixed(2)}\n` +
      `Change: -$${Math.abs(change).toFixed(2)}\n` +
      `Reason: ${note || 'unknown'}\n\n` +
      `Reply '<b>confirm capital ${newTotal.toFixed(2)}</b>' to approve\n` +
      `Or '<b>skip capital</b>' to cancel`
    ).catch(() => {});
    return; // Block the change — do not update DB or in-memory value
  }
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
      const qty = parseFloat(asset.available || 0) + parseFloat(asset.reserved || 0); // #71: total = free + reserved-in-orders
      if (qty <= 0) continue;
      const price = priceMap[`${asset.currency}-USD`];
      if (price) total += qty * price;
    }
    // Include Tangem XRP self-custody wallet
    const xrpBalance = await getTangemXRPBalance();
    if (xrpBalance) {
      const xrpPrice = priceMap['XRP-USD'] || await getCurrentPrice('XRP-USD');
      if (xrpPrice) total += xrpBalance * xrpPrice;
    }
    // Include Kraken exchange
    const krakenData = await getKrakenBalances().catch(() => ({ totalUSD: 0 }));
    total += krakenData.totalUSD || 0;
    return total;
  } catch (e) { return 0; }
}

// Fetch XRP balance from Tangem self-custody wallet via public XRPL API
async function getTangemXRPBalance() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(XRPL_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'account_info',
        params: [{ account: TANGEM_XRP_ADDRESS, ledger_index: 'current' }]
      }),
      signal: controller.signal
    });
    clearTimeout(timeout);
    const data = await response.json();
    if (data.result && data.result.account_data) {
      // XRP balance is in drops (1 XRP = 1,000,000 drops)
      const drops = parseInt(data.result.account_data.Balance);
      const balance = drops / 1_000_000;
      // Cache the last known balance
      await db.execute(
        "INSERT INTO system_config (config_key, config_value) VALUES ('tangem_last_balance', ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)",
        [JSON.stringify({ balance, cached_at: new Date().toISOString() })]
      ).catch(() => {});
      return balance;
    }
    return null;
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError') {
      console.log('[tangem] XRPScan timeout — using cached value');
      try {
        const [cached] = await db.execute(
          "SELECT config_value FROM system_config WHERE config_key = 'tangem_last_balance'"
        );
        if (cached.length) {
          const parsed = JSON.parse(cached[0].config_value);
          console.log(`[tangem] Returning cached balance ${parsed.balance} from ${parsed.cached_at}`);
          return parsed.balance;
        }
      } catch (dbErr) { /* ignore */ }
      console.log('[tangem] No cache — falling back to known balance 1008.43');
      return 1008.43;
    }
    console.error('Tangem XRP fetch error:', e.message);
    // On any error, try cache then hardcoded fallback
    try {
      const [cached] = await db.execute(
        "SELECT config_value FROM system_config WHERE config_key = 'tangem_last_balance'"
      );
      if (cached.length) {
        const parsed = JSON.parse(cached[0].config_value);
        return parsed.balance;
      }
    } catch (dbErr2) { /* ignore */ }
    return 1008.43;
  }
}

// ── Kraken Exchange Integration ───────────────────────────────────────────────

async function krakenRequest(path, data = {}) {
  const apiKey     = process.env.KRAKEN_API_KEY;
  const privateKey = process.env.KRAKEN_PRIVATE_KEY;

  if (!apiKey || !privateKey) {
    throw new Error('Kraken API credentials not configured. Add KRAKEN_API_KEY and KRAKEN_PRIVATE_KEY to Railway environment variables.');
  }

  try {
    const nonce    = Date.now().toString();
    const postData = new URLSearchParams({ nonce, ...data }).toString();

    // Kraken signing: HMAC-SHA512(path + SHA256(nonce + postData), base64-decoded secret)
    const hashDigest = createHash('sha256').update(nonce + postData).digest();
    const hmac       = createHmac('sha512', Buffer.from(privateKey, 'base64'));
    hmac.update(path);
    hmac.update(hashDigest);
    const signature = hmac.digest('base64');

    console.log('[kraken] API request to:', path);

    const response = await fetch(`${KRAKEN_API_URL}${path}`, {
      method: 'POST',
      headers: {
        'API-Key': apiKey,
        'API-Sign': signature,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: postData
    });
    const result = await response.json();
    if (result.error && result.error.length > 0) throw new Error(result.error.join(', '));
    return result.result;
  } catch (e) {
    console.error('[kraken] API error:', e.message);
    throw e;
  }
}

// Map Kraken asset codes → standard ticker symbols
const KRAKEN_TO_STANDARD = {
  'XXBT': 'BTC', 'XETH': 'ETH', 'XXRP': 'XRP',
  'XLTC': 'LTC', 'XXLM': 'XLM', 'XADA': 'ADA',
  'XXDG': 'DOGE', 'XZEC': 'ZEC', 'XXMR': 'XMR',
  'XBT':  'BTC', 'ETH':  'ETH', 'XRP':  'XRP',
  'ZUSD': 'USD', 'ZGBP': 'GBP', 'ZEUR': 'EUR',
};

function krakenAssetToStandard(asset) {
  return KRAKEN_TO_STANDARD[asset] || asset;
}

async function getKrakenBalances() {
  try {
    const balances = await krakenRequest('/0/private/Balance');

    // Capture USD/stable cash before filtering it out
    const KRAKEN_CASH_ASSETS = ['ZUSD', 'ZEUR', 'ZGBP', 'USDT', 'USDC', 'USD'];
    const usdCash = Object.entries(balances)
      .filter(([asset]) => KRAKEN_CASH_ASSETS.includes(asset))
      .reduce((sum, [, amount]) => sum + parseFloat(amount || 0), 0);

    const nonZeroAssets = Object.entries(balances)
      .filter(([, amount]) => parseFloat(amount) > 0.00001)
      .filter(([asset]) => !KRAKEN_CASH_ASSETS.includes(asset));

    if (nonZeroAssets.length === 0) return { balances: [], totalUSD: 0 };

    // Build comma-separated pairs for public ticker
    const pairNames = nonZeroAssets.map(([asset]) => {
      const standard = krakenAssetToStandard(asset);
      // Kraken public ticker uses XBTUSD, ETHUSD etc.
      const krakenBase = standard === 'BTC' ? 'XBT' : standard;
      return `${krakenBase}USD`;
    }).join(',');

    let priceMap = {};
    try {
      const tickerRes = await fetch(`${KRAKEN_API_URL}/0/public/Ticker?pair=${pairNames}`).then(r => r.json());
      if (tickerRes.result) {
        for (const [pair, data] of Object.entries(tickerRes.result)) {
          priceMap[pair] = parseFloat(data.c[0]); // last trade price
        }
      }
    } catch (e) { console.error('[kraken] Ticker error:', e.message); }

    let totalUSD = 0;
    const result = [];

    for (const [asset, amount] of nonZeroAssets) {
      const qty      = parseFloat(amount);
      const standard = krakenAssetToStandard(asset);
      const symbol   = `${standard}-USD`;
      const krakenBase = standard === 'BTC' ? 'XBT' : standard;

      // Try several pair name formats Kraken might return
      const price =
        priceMap[`${krakenBase}USD`] ||
        priceMap[`X${krakenBase}ZUSD`] ||
        priceMap[`${krakenBase}ZUSD`] || null;

      const valueUSD   = price ? qty * price : null;
      if (valueUSD) totalUSD += valueUSD;

      const entryPrice = entryPrices.get(symbol) || null;
      const unrealisedPnlPct = entryPrice && price
        ? ((price - entryPrice) / entryPrice * 100) : null;

      result.push({ asset, standard, symbol, quantity: qty, price, valueUSD, entryPrice, unrealisedPnlPct, source: 'Kraken' });
    }

    result.sort((a, b) => (b.valueUSD || 0) - (a.valueUSD || 0));
    return { balances: result, totalUSD, usdCash };
  } catch (e) {
    console.error('[kraken] getKrakenBalances error:', e.message);
    return { balances: [], totalUSD: 0, usdCash: 0 };
  }
}

async function executeKrakenTrade(symbol, side, orderType, volume, price = null) {
  const standard    = symbol.replace('-USD', '');
  const krakenBase  = standard === 'BTC' ? 'XBT' : standard;
  const pair        = `${krakenBase}USD`;

  const orderData = {
    pair,
    type:      side,       // 'buy' or 'sell'
    ordertype: orderType,  // 'market' or 'limit'
    volume:    volume.toString()
  };
  if (orderType === 'limit' && price) orderData.price = price.toString();

  const result = await krakenRequest('/0/private/AddOrder', orderData);
  return result;
}

// Fetch live price for a single coin from Kraken public API
// Uses explicit pair map first, then falls back to common naming patterns
async function getKrakenPriceForSymbol(symbol) {
  const coinBase = symbol.replace('-USD', '');
  const krakenBase = coinBase === 'BTC' ? 'XBT' : coinBase;

  // Use known pair name first, then fallback guesses
  const knownPair = KRAKEN_PAIR_MAP[symbol];
  const pairs = knownPair
    ? [knownPair, `${krakenBase}USD`, `${krakenBase}ZUSD`]
    : [`${krakenBase}USD`, `${krakenBase}ZUSD`, `X${krakenBase}ZUSD`];

  for (const pair of pairs) {
    try {
      const res = await fetch(`${KRAKEN_API_URL}/0/public/Ticker?pair=${encodeURIComponent(pair)}`);
      const data = await res.json();
      if (data.result) {
        const entry = Object.values(data.result)[0];
        const price = parseFloat(entry?.c?.[0]);
        if (price > 0) {
          console.log(`[kraken] ${symbol} = $${price} (pair: ${pair})`);
          return price;
        }
      }
    } catch (_) { /* try next format */ }
  }
  console.warn(`[kraken] No price found for ${symbol}`);
  return null;
}

// ── Claude API cost logger ──────────────────────────────────────────────────
// Pricing (per million tokens): Sonnet $3 in / $15 out; Haiku $0.80 in / $4 out; cache read ~10% of input price
function claudeCost(model, inputTokens, outputTokens, cacheReadTokens = 0) {
  const isHaiku   = model.includes('haiku');
  const inPrice   = isHaiku ? 0.0000008  : 0.000003;
  const outPrice  = isHaiku ? 0.000004   : 0.000015;
  const cachePrice = isHaiku ? 0.00000008 : 0.0000003;
  return inputTokens * inPrice + outputTokens * outPrice + cacheReadTokens * cachePrice;
}

async function logClaudeCall(reason, model, usage) {
  const inputTokens      = usage?.input_tokens                || 0;
  const outputTokens     = usage?.output_tokens               || 0;
  const cacheReadTokens  = usage?.cache_read_input_tokens     || 0;
  const cacheWriteTokens = usage?.cache_creation_input_tokens || 0;
  const cost             = claudeCost(model, inputTokens, outputTokens, cacheReadTokens);
  console.log('CLAUDE API CALL:', { reason, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, estimatedCost: cost.toFixed(6) });
  await db.execute(
    'INSERT INTO claude_api_calls (reason, model, input_tokens, output_tokens, cache_read_tokens, estimated_cost) VALUES (?, ?, ?, ?, ?, ?)',
    [reason, model, inputTokens, outputTokens, cacheReadTokens, cost.toFixed(6)]
  ).catch(e => console.warn('[claude_log]', e.message));
}

/*
 * TELEGRAM MESSAGE TYPE RULES — DO NOT VIOLATE
 *
 * TYPE 1 — AI AUTO-EXECUTED 🤖
 *   formatAutoExecuteMessage() — UNDO only, no numbered options
 *
 * TYPE 2 — SYSTEM ALERTS ⚠️
 *   formatSystemAlert() — informational only, no numbered options, no response needed
 *
 * TYPE 3 — APPROVAL REQUIRED 🔔
 *   formatApprovalRequest() — 👍/👎 only, auto-cancels after 12 min
 *
 * EXCEPTION — AI ANALYSIS 🧠
 *   Numbered 1-5 options ONLY here — the ONE place that requests Bryan's decision
 */

function formatAutoExecuteMessage(coinBase, side, qty, price, valueUsd, reason, confidence) {
  return (
    `🤖 <b>AI EXECUTED — ${coinBase}</b>\n\n` +
    `${side.toUpperCase()} ${formatTradeQty(qty)} ${coinBase} @ ${formatPrice(price)}\n` +
    `Value: $${parseFloat(valueUsd).toFixed(2)}\n\n` +
    `Reason: ${reason}\n` +
    `Confidence: ${confidence}\n\n` +
    `⏪ Reply <b>UNDO</b> within 2 min to reverse`
  );
}

function formatSystemAlert(alertType, coinBase, details) {
  return `⚠️ <b>${alertType} — ${coinBase}</b>\n\n${details}`;
}

function formatApprovalRequest(coinBase, side, qty, price, valueUsd, exchange) {
  const exchangeLabel = exchange === 'revolut' ? 'Revolut X' : 'Kraken';
  const qtyStr = qty ? `${formatTradeQty(qty)} ${coinBase}` : coinBase;
  return (
    `🔔 <b>APPROVAL NEEDED — ${coinBase}</b>\n\n` +
    `Action: <b>${side.toUpperCase()} ${qtyStr}</b>\n` +
    `Price: ~${price ? formatPrice(price) : 'market'}\n` +
    `Value: ~$${valueUsd ? parseFloat(valueUsd).toFixed(2) : '?'}\n` +
    `Exchange: ${exchangeLabel}\n\n` +
    `👍 Execute  👎 Cancel\n` +
    `⏰ Auto-cancels in 12 min if no response`
  );
}

// FIX 3: Dust rule — skip API for positions worth < $5
function getDustRecommendation(direction) {
  return direction === 'down'
    ? '💡 Dust position — consider watching for further drop before adding'
    : '💡 Dust position — consider setting a retrace buy alert if this pumps further';
}

async function getQuickAiRecommendation(symbol, changePct, currentPrice, direction = 'up', reason = 'alert') {
  try {
    const coinBase = symbol.replace('-USD', '');
    // A1 (dev_log #35 + #31): inject project name + role so model doesn't guess
    const { narrative, role } = await getCoinContext(coinBase);
    // #36/S3 — plan-aware: saved strategy is the PRIMARY consideration
    let planClause = ' No saved plan exists for this coin — give generic price-action analysis and explicitly say "no saved plan — generic analysis".';
    try {
      const [csRows] = await db.execute('SELECT strategy_md FROM coin_strategy WHERE symbol = ?', [coinBase]);
      if (csRows.length && csRows[0].strategy_md) {
        const planText = csRows[0].strategy_md.length > 900 ? csRows[0].strategy_md.slice(0, 900) + '…' : csRows[0].strategy_md;
        planClause = ` The user has a SAVED PLAN for this coin — it is the PRIMARY consideration; generic TA is secondary. If the current price maps to a level named in the plan, name that level and quote the planned action. NEVER recommend an action that contradicts the plan or the coin's role. SAVED PLAN: """${planText}"""`;
      }
    } catch (e) { /* plan read failed — proceed without */ }
    const projectLabel = narrative
      ? `${symbol} (${narrative})`
      : `${symbol} (project unknown — do not guess the project; give a price-action-only view)`;
    const dirText = direction === 'down'
      ? `down ${Math.abs(changePct).toFixed(1)}% to $${currentPrice.toFixed(4)}`
      : `up ${changePct.toFixed(1)}% to $${currentPrice.toFixed(4)}`;
    let roleInstruction;
    let startInstruction;
    if (role === 'hodl') {
      roleInstruction = 'This is a HOLD-only anchor/long-term hold. DO NOT recommend buying or selling. Frame as HOLD and what to watch.';
      startInstruction = 'Start with HOLD in bold.';
    } else if (role === 'manual_only') {
      roleInstruction = 'This is a manual-decision anchor. DO NOT give a directive BUY or SELL — present it as HOLD/analysis for the user to decide.';
      startInstruction = 'Start with HOLD in bold.';
    } else {
      roleInstruction = '';
      startInstruction = direction === 'down'
        ? 'Start with HOLD, BUY THE DIP, or SELL in bold.'
        : 'Start with HOLD, SELL, or BUY MORE in bold.';
    }
    const roleClause = roleInstruction ? ` ${roleInstruction}` : '';
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 220,
      messages: [{
        role: 'user',
        content: `In 2-3 sentences max, give a quick trading recommendation for ${projectLabel} which is ${dirText}. Consider current market conditions.${roleClause}${planClause} Never invent or guess product names, partnerships, or technical specifics — only reference facts present in the saved plan. ${startInstruction}`
      }]
    });
    await logClaudeCall(reason, response.model || 'claude-sonnet-4-6', response.usage);
    const textBlock = response.content.find(b => b.type === 'text');
    return textBlock ? textBlock.text : 'HOLD - Monitor the situation closely.';
  } catch (e) {
    console.error('Quick AI recommendation error:', e.message);
    return 'HOLD - Monitor the situation closely.';
  }
}

// ── #36 v1: plan-aware swing-signal gate (LOCAL only — no API; aiRec above already handles the plan-aware API rec) ──
// Returns { mode, text }. mode 'KEEP_DEEPLOSS' = caller keeps its own deep-loss swingSignal branch unchanged.
async function buildPlanAwareSwingSignal({ coinBase, direction, isDeepLoss, currentPrice = 0 }) {
  if (isDeepLoss) return { mode: 'KEEP_DEEPLOSS', text: null };
  let role = 'normal';
  let strategyMd = '';
  try {
    const [csRows] = await db.execute('SELECT role, strategy_md FROM coin_strategy WHERE symbol = ? LIMIT 1', [coinBase]);
    if (csRows.length) {
      role = (csRows[0].role || 'normal').toLowerCase();
      strategyMd = (csRows[0].strategy_md || '');
    }
  } catch (e) { console.error('[swingGate] coin_strategy read failed:', e.message); }
  let configHodl = false, configManual = false;
  try {
    const ctx = await getCoinContext(coinBase);
    if (ctx.role === 'hodl') configHodl = true;
    else if (ctx.role === 'manual_only') configManual = true;
  } catch (e) { /* ignore */ }
  const NO_TRIM_ROLES = ['hodl','anchor','dead_bag','lotto','radar','watch_entry'];
  const md = strategyMd.toLowerCase();
  const planSaysNoTrim = /never sell below|no trim|do not round-trip|ignore daily pump|hold through pumps|never auto-sell|no upside rung/.test(md);
  const isStructuralNoTrim = NO_TRIM_ROLES.includes(role) || configHodl || configManual;
  if (isStructuralNoTrim) {
    return direction === 'up'
      ? { mode: 'SUPPRESS_TRIM', text: `\n\n📋 Plan posture: ${role} — no upside trim rungs; holding per saved plan.` }
      : { mode: 'SUPPRESS_DIP',  text: `\n\n📋 Plan posture: ${role} — adds only at named plan levels, not generic dips.` };
  }
  // #36 v2: rung-surfacing for swing coins — read priceTargets Map (already in memory, no extra DB query)
  const symbol = coinBase + '-USD';
  const targets = priceTargets.get(symbol) || [];
  const relevant = targets.filter(t => t.direction === direction);
  let nearestRung = null;
  if (direction === 'up') {
    const above = relevant.filter(t => t.targetPrice > currentPrice).sort((a, b) => a.targetPrice - b.targetPrice);
    nearestRung = above[0] || null;
  } else {
    const below = relevant.filter(t => t.targetPrice < currentPrice).sort((a, b) => b.targetPrice - a.targetPrice);
    nearestRung = below[0] || null;
  }
  function buildRungLine(rung) {
    if (!rung) return null;
    const pct = Math.abs((rung.targetPrice - currentPrice) / currentPrice * 100).toFixed(1);
    const arrow = direction === 'up' ? '📈' : '📉';
    const dirStr = direction === 'up' ? `+${pct}%` : `-${pct}%`;
    const label = (rung.note || '').slice(0, 80);
    return `\n\n${arrow} Next plan level: $${rung.targetPrice.toFixed(4)} (${dirStr})${label ? ` — ${label}` : ''}`;
  }
  if (planSaysNoTrim) {
    const rungLine = buildRungLine(nearestRung);
    return direction === 'up'
      ? { mode: 'SWING_NOTRIM_NOW', text: rungLine || `\n\n📋 Swing coin — plan says no trim/add at current level; check your named rung before acting.` }
      : { mode: 'SWING_NEUTRAL_DOWN', text: rungLine || `\n\n📋 Swing coin — adds only at named plan levels; check before averaging.` };
  }
  const rungLine = buildRungLine(nearestRung);
  return direction === 'up'
    ? { mode: 'SWING_NEUTRAL', text: rungLine || `\n\n📋 Swing coin — let your saved plan rungs govern; no generic trim applied.` }
    : { mode: 'SWING_NEUTRAL_DOWN', text: rungLine || `\n\n📋 Swing coin — adds only at named plan levels; check before averaging.` };
}

// FIX 2: Batch recommendations for multiple simultaneous alerts — one API call instead of N
// A1 (dev_log #35 + #31): one config read for the whole batch, then per-coin project name + role tag
async function batchGetRecommendations(alerts) {
  if (alerts.length === 0) return;
  try {
    // One DB read for the batch — avoids N hits per coin
    let aeConfig = { hodl_symbols: [], manual_only_symbols: [] };
    try {
      const [aeRows] = await db.execute(
        "SELECT config_value FROM system_config WHERE config_key = 'ai_auto_execute'"
      );
      if (aeRows.length) aeConfig = JSON.parse(aeRows[0].config_value);
    } catch (e) { /* ignore — default empty role lists */ }

    // #36/S3 — one plan read for the whole batch
    const csMap = new Map();
    try {
      const symList = alerts.map(a => a.coinBase);
      if (symList.length) {
        const placeholders = symList.map(() => '?').join(',');
        const [csRows] = await db.execute(`SELECT symbol, strategy_md FROM coin_strategy WHERE symbol IN (${placeholders})`, symList);
        for (const r of csRows) csMap.set(r.symbol, r.strategy_md || '');
      }
    } catch (e) { /* ignore — proceed without plans */ }

    const lines = alerts.map(a => {
      const narrative = COIN_NARRATIVES[a.coinBase] || null;
      const projectLabel = narrative
        ? `${a.coinBase} (${narrative})`
        : `${a.coinBase} (project unknown — no guess)`;
      let roleTag = '';
      if ((aeConfig.hodl_symbols || []).includes(a.coinBase)) roleTag = ' [HODL]';
      else if ((aeConfig.manual_only_symbols || []).includes(a.coinBase)) roleTag = ' [MANUAL]';
      const csPlan = csMap.get(a.coinBase);
      const planTag = csPlan ? ` | PLAN: ${csPlan.slice(0, 300).replace(/\n/g, ' ')}${csPlan.length > 300 ? '…' : ''}` : ' | (no saved plan)';
      return `- ${projectLabel}${roleTag}: ${a.direction === 'up' ? 'UP' : 'DOWN'} ${Math.abs(a.changePct).toFixed(1)}% to ${fmtPriceShort(a.currentPrice)} (holding value ~$${a.valueUSD.toFixed(0)})${planTag}`;
    }).join('\n');
    const format = alerts.map(a => `${a.coinBase}: [recommendation]`).join('\n');
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: Math.min(100 * alerts.length, 600),
      system: [{
        type: 'text',
        text: 'You are a concise crypto trading assistant. For each alert give ONE short line — HOLD/SELL/BUY + brief reason. Use the exact format provided by the user. For any coin tagged [HODL] or [MANUAL], do NOT say BUY or SELL — say HOLD/monitor only. Never invent project fundamentals, product names, or specifics; if a project name is given use it, otherwise comment on price action only. When a PLAN is provided for a coin, the recommendation MUST follow the plan — name the matching plan level if one applies and never contradict it. For coins marked (no saved plan), say "no saved plan".',
        cache_control: { type: 'ephemeral' }
      }],
      messages: [{ role: 'user', content: `Quick trading recommendations for these alerts:\n${lines}\n\nFormat exactly:\n${format}` }]
    });
    await logClaudeCall(`batch alert recommendations (${alerts.length} coins)`, response.model || 'claude-sonnet-4-6', response.usage);
    const text = response.content.find(b => b.type === 'text')?.text || '';
    for (const a of alerts) {
      const match = text.match(new RegExp(`${a.coinBase}:\\s*([^\\n]+)`, 'i'));
      const rec = match ? match[1].trim() : 'HOLD - Monitor the situation closely.';
      alertRecommendations.set(a.symbol, { rec, timestamp: Date.now() });
      console.log(`[batch rec] ${a.symbol}: ${rec.substring(0, 80)}`);
    }
  } catch (e) {
    console.error('Batch recommendations error:', e.message);
    for (const a of alerts) {
      alertRecommendations.set(a.symbol, { rec: 'HOLD - Monitor the situation closely.', timestamp: Date.now() });
    }
  }
}

// #38 B2 — array-aware upsert for priceTargets Map (symbol → array of target objects)
// Match key mirrors DB uq_target: direction + targetPrice. If found, update in-place (preserving id).
// If not found, append. All 6 setters call this instead of priceTargets.set(symbol, {...}).
function upsertPriceTarget(symbol, newTarget) {
  const arr = priceTargets.get(symbol) || [];
  const idx = arr.findIndex(function(t) {
    return t.direction === newTarget.direction &&
      Math.abs(t.targetPrice - newTarget.targetPrice) < 1e-12;
  });
  if (idx >= 0) {
    arr[idx] = Object.assign({}, arr[idx], newTarget); // update in place, preserve existing id
  } else {
    arr.push(newTarget);
  }
  priceTargets.set(symbol, arr);
  return arr[idx >= 0 ? idx : arr.length - 1];
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
  const impliedDirF = targetPrice >= anchorPrice ? 'up' : 'down';
  if (direction !== impliedDirF) {
    console.log(`[targets] ${symbol} direction auto-corrected ${direction} -> ${impliedDirF} (target ${targetPrice} vs anchor ${anchorPrice})`);
    direction = impliedDirF;
  }
  await db.execute(
    'INSERT INTO price_targets (symbol, anchor_price, threshold_pct, target_price, direction, note) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE anchor_price=VALUES(anchor_price), threshold_pct=VALUES(threshold_pct), target_price=VALUES(target_price), direction=VALUES(direction), note=VALUES(note), updated_at=CURRENT_TIMESTAMP',
    [symbol, anchorPrice, thresholdPct, targetPrice, direction, note]
  );
  upsertPriceTarget(symbol, { anchorPrice, thresholdPct, targetPrice, direction, note }); // #38 B2
  // Setting a new alert clears acknowledged so the new target can fire
  alertState.acknowledged.delete(symbol);
  return { anchorPrice, thresholdPct, targetPrice, direction };
}

// Set a price target using an absolute dollar level rather than a % threshold
async function setAbsolutePriceTarget(symbol, absoluteTargetPrice, direction = 'down', note = null) {
  const currentPrice = await getCurrentPrice(symbol);
  if (!currentPrice) throw new Error(`No price for ${symbol}`);
  const impliedDirA = absoluteTargetPrice >= currentPrice ? 'up' : 'down';
  if (direction !== impliedDirA) {
    console.log(`[targets] ${symbol} direction auto-corrected ${direction} -> ${impliedDirA} (target ${absoluteTargetPrice} vs current ${currentPrice})`);
    direction = impliedDirA;
  }
  const thresholdPct = Math.abs((absoluteTargetPrice - currentPrice) / currentPrice * 100);
  await db.execute(
    'INSERT INTO price_targets (symbol, anchor_price, threshold_pct, target_price, direction, note) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE anchor_price=VALUES(anchor_price), threshold_pct=VALUES(threshold_pct), target_price=VALUES(target_price), direction=VALUES(direction), note=VALUES(note), updated_at=CURRENT_TIMESTAMP',
    [symbol, currentPrice, thresholdPct, absoluteTargetPrice, direction, note]
  );
  upsertPriceTarget(symbol, { anchorPrice: currentPrice, thresholdPct, targetPrice: absoluteTargetPrice, direction, note }); // #38 B2
  // Setting a new alert re-enables this coin (clears acknowledged)
  alertState.acknowledged.delete(symbol);
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
// Clears ALL interval types for the symbol and silences it for the rest of the session.
// Session-only — server restart naturally resets (baselines reset anyway).
// To make permanent use: ignoreCoin(). To re-enable use: resumeAlerts().
async function acknowledgeAlert(symbol) {
  console.log('[ack] Acknowledging:', symbol);

  // Mark as acknowledged — blocks all new alerts for this symbol this session
  alertState.acknowledged.add(symbol);

  // Persist to DB with 24h expiry so redeploy doesn't re-fire dismissed alerts
  await db.execute(
    `INSERT INTO ignored_coins (symbol, ignore_type, expires_at)
     VALUES (?, 'session', DATE_ADD(NOW(), INTERVAL 24 HOUR))
     ON DUPLICATE KEY UPDATE ignore_type = 'session', expires_at = DATE_ADD(NOW(), INTERVAL 24 HOUR)`,
    [symbol]
  ).catch(e => console.error('[ack] DB persist error:', e.message));

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

  // Reset reminder counter so a re-fired target gets fresh 2 reminders
  if (targetReminderCount.has(symbol)) {
    targetReminderCount.delete(symbol);
    console.log('[ack] Reset reminder count for:', symbol);
  }

  // Clear pump/drop/swing alert timing so they can fire fresh if the move recurs
  alertFirstSent.delete(symbol);
  alertReminderSent.delete(symbol);

  // Reset the between-poll extremes accumulator so a stale high/low can't re-fire after ack
  targetExtremes.delete(symbol);

  // Log target acknowledgement for fixed-target cooldown recovery across restarts
  await db.execute(
    "INSERT INTO macro_alerts_sent (symbol, alert_type, alert_hash, message) VALUES (?, 'target_acknowledged', ?, 'User acknowledged')",
    [symbol, `target_ack_${symbol}_${Date.now()}`]
  ).catch(() => {});

  console.log('[ack] Complete for:', symbol,
    '| Active pump:', alertState.active.size,
    '| Active drop:', activeDropAlerts.size,
    '| Active fixed:', activeFixedAlerts.size,
    '| Total acknowledged this session:', alertState.acknowledged.size);
}

// Permanently ignore a coin — persisted to DB, survives restarts
async function ignoreCoin(symbol) {
  ignoredCoins.add(symbol);
  alertState.acknowledged.add(symbol); // also silence this session
  // Clear any active intervals
  if (alertState.active.has(symbol)) { clearInterval(alertState.active.get(symbol)); alertState.active.delete(symbol); }
  if (activeDropAlerts.has(symbol)) { clearInterval(activeDropAlerts.get(symbol)); activeDropAlerts.delete(symbol); }
  if (activeFixedAlerts.has(symbol)) { clearInterval(activeFixedAlerts.get(symbol)); activeFixedAlerts.delete(symbol); }
  targetReminderCount.delete(symbol); // reset reminder count on ignore
  alertFirstSent.delete(symbol);
  alertReminderSent.delete(symbol);
  try {
    await db.execute(
      "INSERT INTO ignored_coins (symbol, ignore_type, expires_at) VALUES (?, 'permanent', NULL) ON DUPLICATE KEY UPDATE ignore_type = 'permanent', expires_at = NULL, ignored_at = CURRENT_TIMESTAMP",
      [symbol]
    );
    console.log('[ignore] Permanently ignored:', symbol);
  } catch (e) { console.warn('[ignore] DB persist failed for', symbol, ':', e.message); }
}

// Re-enable alerts for a coin — removes from ignored and acknowledged
async function resumeAlerts(symbol) {
  ignoredCoins.delete(symbol);
  alertState.acknowledged.delete(symbol);
  try {
    // Delete both permanent and session entries so the coin fires fresh
    await db.execute('DELETE FROM ignored_coins WHERE symbol = ?', [symbol]);
    console.log('[watch] Resumed alerts for:', symbol);
  } catch (e) { console.warn('[watch] DB delete failed for', symbol, ':', e.message); }
}

// ── Trailing Stop Functions ───────────────────────────────────────────────────

async function setTrailingStop(symbol, trailPct, currentPrice, entryPrice = null) {
  const stopPrice = currentPrice * (1 - trailPct / 100);
  const ts = { trailPct, peakPrice: currentPrice, stopPrice, entryPrice };
  trailingStops.set(symbol, ts);
  await db.execute(
    'INSERT INTO trailing_stops (symbol, trail_pct, peak_price, stop_price, entry_price) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE trail_pct=VALUES(trail_pct), peak_price=VALUES(peak_price), stop_price=VALUES(stop_price), entry_price=VALUES(entry_price), updated_at=CURRENT_TIMESTAMP',
    [symbol, trailPct, currentPrice, stopPrice, entryPrice]
  );
  alertState.acknowledged.delete(symbol); // Setting new trail re-enables coin
  return { trailPct, peakPrice: currentPrice, stopPrice };
}

async function removeTrailingStop(symbol) {
  trailingStops.delete(symbol);
  trailingStopAlerted.delete(symbol);
  await db.execute('DELETE FROM trailing_stops WHERE symbol = ?', [symbol]);
}

async function removeFixedTarget(symbol, targetPrice = null) {
  // #38 B3 — if targetPrice given, remove only that rung; else whole symbol
  if (targetPrice !== null && targetPrice !== undefined) {
    const arr = priceTargets.get(symbol) || [];
    const match = arr.find(t => Math.abs(t.targetPrice - targetPrice) < 1e-9);
    if (!match) {
      await db.execute('DELETE FROM price_targets WHERE symbol = ? AND ABS(target_price - ?) < 0.000000001', [symbol, targetPrice]);
      return false;
    }
    const remaining = arr.filter(t => !(Math.abs(t.targetPrice - targetPrice) < 1e-9));
    if (remaining.length > 0) {
      priceTargets.set(symbol, remaining);
    } else {
      priceTargets.delete(symbol);
    }
    if (match.id !== undefined && match.id !== null) {
      await db.execute('DELETE FROM price_targets WHERE id = ?', [match.id]);
    } else {
      await db.execute('DELETE FROM price_targets WHERE symbol = ? AND ABS(target_price - ?) < 0.000000001', [symbol, targetPrice]);
    }
    if (remaining.length === 0) {
      targetReminderCount.delete(symbol);
      targetExtremes.delete(symbol);
      alertFirstSent.delete(symbol);
      alertReminderSent.delete(symbol);
      if (activeFixedAlerts.has(symbol)) {
        clearInterval(activeFixedAlerts.get(symbol));
        activeFixedAlerts.delete(symbol);
      }
    }
    return true;
  }
  // whole-symbol delete (original behaviour)
  priceTargets.delete(symbol);
  targetReminderCount.delete(symbol);
  targetExtremes.delete(symbol);
  alertFirstSent.delete(symbol);
  alertReminderSent.delete(symbol);
  if (activeFixedAlerts.has(symbol)) {
    clearInterval(activeFixedAlerts.get(symbol));
    activeFixedAlerts.delete(symbol);
  }
  await db.execute('DELETE FROM price_targets WHERE symbol = ?', [symbol]);
}

async function removeThreshold(symbol) {
  delete customThresholds[symbol];
  await db.execute('DELETE FROM custom_thresholds WHERE symbol = ?', [symbol]);
}

async function updateTrailingStop(symbol, currentPrice) {
  const ts = trailingStops.get(symbol);
  if (!ts) return null;

  // If price rose above peak, update peak and stop
  if (currentPrice > ts.peakPrice) {
    ts.peakPrice = currentPrice;
    ts.stopPrice = currentPrice * (1 - ts.trailPct / 100);
    trailingStops.set(symbol, ts);
    await db.execute(
      'UPDATE trailing_stops SET peak_price = ?, stop_price = ?, updated_at = CURRENT_TIMESTAMP WHERE symbol = ?',
      [ts.peakPrice, ts.stopPrice, symbol]
    );
    console.log(`[trailing] ${symbol} new peak ${fmtPriceShort(currentPrice)} → stop now ${fmtPriceShort(ts.stopPrice)}`);
  }

  // Check if stop triggered
  if (currentPrice <= ts.stopPrice && !alertState.acknowledged.has(symbol) && !ignoredCoins.has(symbol)) {
    return { triggered: true, ts };
  }
  return { triggered: false, ts };
}

// Quick price formatter for alert messages
function fmtPriceShort(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1)    return '$' + n.toFixed(4);
  return '$' + n.toPrecision(4);
}

// Token quantity formatter — handles micro-price coins with millions of tokens
function formatTradeQty(quantity) {
  const qty = parseFloat(quantity);
  if (!qty || isNaN(qty)) return String(quantity);
  if (qty >= 1_000_000) return (qty / 1_000_000).toFixed(2) + 'M';
  if (qty >= 1_000)     return (qty / 1_000).toFixed(2) + 'K';
  if (qty < 0.001)      return qty.toExponential(4);
  return qty.toFixed(4);
}

// Price formatter — smart decimal places based on magnitude (handles SHIB/PEPE tier through normal coins)
function formatPrice(price) {
  const p = parseFloat(price);
  if (!p || isNaN(p)) return '$0';
  if (p < 0.000001)   return '$' + p.toFixed(10);  // SHIB/PEPE tier
  else if (p < 0.0001) return '$' + p.toFixed(8);  // micro price
  else if (p < 0.01)   return '$' + p.toFixed(6);  // small price
  else if (p < 1)      return '$' + p.toFixed(4);  // sub-dollar
  else                 return '$' + p.toFixed(2);   // normal price
}

async function getCurrentPrice(symbol) {
  const sym = symbol.includes('-USD') ? symbol : `${symbol}-USD`;

  // 1. Check Revolut X tickers
  try {
    const tickerResponse = await revolutRequest('GET', '/tickers');
    const tickerList = Array.isArray(tickerResponse) ? tickerResponse : (tickerResponse.data || []);
    for (const ticker of tickerList) {
      if (!ticker.symbol) continue;
      const price = parseFloat(ticker.last_price || ticker.mid || ticker.ask || ticker.bid);
      if (price && (ticker.symbol === sym || ticker.symbol.replace('/', '-') === sym)) return price;
    }
  } catch (e) { /* ignore */ }

  // 2. Fallback: Kraken public API (covers GHIBLI, ZK, XPL, TAO, etc.)
  try {
    const krakenPrice = await getKrakenPriceForSymbol(sym);
    if (krakenPrice && krakenPrice > 0) {
      console.log(`[price] ${sym} fetched from Kraken: $${krakenPrice}`);
      return krakenPrice;
    }
  } catch (e) {
    console.error(`[price] Kraken fallback failed for ${sym}:`, e.message);
  }

  console.warn(`[price] No price found for ${sym} on Revolut X or Kraken`);
  return null;
}

async function runReconciliation() {
  try {
    const TOL = 0.5; // % tolerance for fees/dust
    const drifts = [];
    let checked = 0;

    // --- gather system positions from Revolut /balances (available + reserved = total holdings) --- #71
    const revBals = await revolutRequest('GET', '/balances').catch(() => []);
    const revMap = new Map();
    for (const b of (revBals || [])) {
      if (['USD','USDT','USDC','GBP','EUR'].includes(b.currency)) continue;
      revMap.set(`${b.currency}-USD`, parseFloat(b.available || 0) + parseFloat(b.reserved || 0)); // #71: total holdings
    }

    // --- Kraken positions ---
    const kData = await getKrakenBalances().catch(() => ({ balances: [] }));
    const kMap = new Map();
    for (const k of (kData.balances || [])) kMap.set(k.symbol, parseFloat(k.quantity || 0));

    // --- non-legacy tranche sums (symbol stored as coinBase) ---
    const [trSums] = await db.execute(
      `SELECT symbol, exchange, SUM(remaining_quantity) AS tranche_sum
       FROM position_tranches WHERE is_legacy = 0 GROUP BY symbol, exchange`
    );
    const trMap = new Map();
    for (const t of trSums) trMap.set(`${t.symbol}-USD::${t.exchange}`, parseFloat(t.tranche_sum || 0));

    // --- build the union of symbols to check, per exchange ---
    const checks = [];
    for (const [sym, qty] of revMap) checks.push({ sym, exchange: 'revolut', exchangeQty: qty });
    for (const [sym, qty] of kMap)   checks.push({ sym, exchange: 'kraken',  exchangeQty: qty });

    for (const c of checks) {
      checked++;
      const trancheSum = trMap.get(`${c.sym}::${c.exchange}`) ?? null;
      // system "position" reference = tranche sum when present, else exchange qty
      const systemQty = trancheSum;
      if (systemQty === null) continue; // no tranche record to compare -- skip (dust/untracked)
      const base = c.exchangeQty || 0.00000001;
      const driftPct = ((systemQty - c.exchangeQty) / base) * 100;
      if (Math.abs(driftPct) <= TOL) continue;

      // tag possible open-order reservation (Revolut available reads low when reserved)
      const driftType = (c.exchange === 'revolut' && systemQty > c.exchangeQty)
        ? 'system_high_maybe_open_order'
        : (systemQty > c.exchangeQty ? 'system_high' : 'exchange_high');

      // suppress repeats: skip if an unacknowledged row for this sym+exchange already exists from a prior run
      const [[prior]] = await db.execute(
        `SELECT COUNT(*) AS n FROM reconciliation_log
         WHERE symbol = ? AND exchange = ? AND acknowledged = 0
         AND run_date > DATE_SUB(NOW(), INTERVAL 7 DAY)`,
        [c.sym, c.exchange]
      );
      await db.execute(
        `INSERT INTO reconciliation_log (symbol, exchange, exchange_qty, system_qty, tranche_sum, drift_pct, drift_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [c.sym, c.exchange, c.exchangeQty, systemQty, trancheSum, driftPct.toFixed(4), driftType]
      );
      if (prior.n === 0) {
        const tag = driftType === 'system_high_maybe_open_order' ? ' (may be open order)' : '';
        drifts.push(`${c.sym} ${c.exchange}: sys ${systemQty.toFixed(4)} vs exch ${c.exchangeQty.toFixed(4)} (${driftPct > 0 ? '+' : ''}${driftPct.toFixed(1)}%)${tag}`);
      }
    }

    if (drifts.length) {
      await sendTelegram(`⚠️ <b>RECONCILIATION — ${drifts.length} new drift(s)</b>\n\n${drifts.join('\n')}\n\n<i>Checked ${checked} positions. Reply to investigate.</i>`).catch(() => {});
    } else {
      console.log(`[reconciliation] Clean — ${checked} positions checked, no new drift`);
    }
    console.log(`[reconciliation] Run complete: ${checked} checked, ${drifts.length} new drift(s)`);
  } catch (e) {
    console.error('[reconciliation] error:', e.message);
  }
}

async function captureIntradayPrices() {
  try {
    const tickerResponse = await revolutRequest('GET', '/tickers');
    const tickerList = Array.isArray(tickerResponse) ? tickerResponse : (tickerResponse.data || []);
    const priceMap = {};
    for (const ticker of tickerList) {
      if (!ticker.symbol) continue;
      const price = parseFloat(ticker.last_price || ticker.mid || ticker.ask || ticker.bid);
      if (price) { priceMap[ticker.symbol] = price; priceMap[ticker.symbol.replace('/', '-')] = price; }
    }
    const [csRows] = await db.execute("SELECT symbol FROM coin_strategy WHERE symbol NOT IN ('DEAD_BAGS','EXITED')");
    const values = [];
    for (const r of csRows) {
      const sym = `${r.symbol}-USD`;
      const price = priceMap[sym];
      if (price) values.push(sym, price);
    }
    if (values.length) {
      const rows = values.length / 2;
      const placeholders = Array(rows).fill('(?, ?)').join(', ');
      await db.execute(`INSERT INTO price_intraday (symbol, price) VALUES ${placeholders}`, values);
      console.log(`[intraday] Captured ${rows} prices`);
    } else {
      console.log('[intraday] Captured 0 prices (no ticker matches)');
    }
  } catch (e) {
    console.error('[intraday] capture error:', e.message);
  }
}
// ── #94: fast-cadence trailing-stop scan for volatile meme/lotto coins ────────
// Runs every 30s (decoupled from the 5-min alert loop). Only evaluates coins in
// FAST_SCAN_SYMBOLS that have an armed trailing stop — silent otherwise.
// Reuses updateTrailingStop (peak-ratchet + breach detection + analyseTrailingStopAlert).
// getCurrentPrice() handles exchange routing: Revolut X first, Kraken fallback.
const FAST_SCAN_SYMBOLS = ['GHIBLI-USD', 'FLOKI-USD', 'BOBA-USD'];


// ── #95 Stage 1: pump-arm detector — arms a dormant trailing stop when a coin pumps. SELLS NOTHING. ──
async function checkPumpArm(symbol, currentPrice) {
  try {
    const [rows] = await db.execute('SELECT * FROM pump_armed_rules WHERE symbol = ? AND active = 1 AND armed = 0 LIMIT 1', [symbol]);
    if (!rows.length) return;
    const rule = rows[0];
    const now = Date.now();
    const windowMs = (rule.arm_window_min || 60) * 60 * 1000;

    // No baseline yet, or window expired → (re)set baseline
    if (!rule.baseline_price || !rule.baseline_at || (now - Number(rule.baseline_at)) > windowMs) {
      await db.execute('UPDATE pump_armed_rules SET baseline_price = ?, baseline_at = ? WHERE symbol = ?', [currentPrice, now, symbol]);
      console.log(`[pump-arm] ${symbol} baseline set ${fmtPriceShort(currentPrice)}`);
      return;
    }

    // Pump check
    const pumpPct = ((currentPrice - parseFloat(rule.baseline_price)) / parseFloat(rule.baseline_price)) * 100;
    if (pumpPct >= parseFloat(rule.arm_pump_pct)) {
      // ARM — set a trailing stop, mark armed. NO SELL (Stage 1).
      const entryFloor = rule.entry_floor != null ? parseFloat(rule.entry_floor) : null;
      await setTrailingStop(symbol, parseFloat(rule.trail_pct), currentPrice, entryFloor);
      await db.execute('UPDATE pump_armed_rules SET armed = 1 WHERE symbol = ?', [symbol]);
      console.log(`[pump-arm] ${symbol} ARMED — pumped +${pumpPct.toFixed(1)}% to ${fmtPriceShort(currentPrice)}, trailing stop set ${rule.trail_pct}%`);
      await sendTelegram(
        `🎯 <b>PUMP-ARMED — ${symbol.replace('-USD','')}</b>\n\n` +
        `Pumped +${pumpPct.toFixed(1)}% to ${fmtPriceShort(currentPrice)}\n` +
        `Trailing stop now ACTIVE at ${rule.trail_pct}% below peak\n` +
        `${entryFloor ? `Floor: never sell below ${fmtPriceShort(entryFloor)}\n` : ''}` +
        `\n⚠️ Stage 1 — monitoring only, no auto-sell yet. You'll be alerted if the trail breaches.`
      ).catch(() => {});
    } else {
      console.log(`[pump-arm] ${symbol} watching — +${pumpPct.toFixed(1)}% of ${rule.arm_pump_pct}% needed`);
    }
  } catch (e) {
    console.error('[pump-arm] error:', e.message);
  }
}

async function runFastScan() {
  try {
    for (const symbol of FAST_SCAN_SYMBOLS) {
      // #95 Stage 1: check pump-arm rules FIRST (these are dormant — no trailing stop yet)
      {
        const armPrice = await getCurrentPrice(symbol).catch(() => null);
        if (armPrice) await checkPumpArm(symbol, armPrice);
      }
      // Only run trailing-stop logic if a trailing stop is armed — silent if not
      if (!trailingStops.has(symbol)) continue;
      // Skip if already acknowledged or ignored this cycle
      if (alertState.acknowledged.has(symbol) || ignoredCoins.has(symbol)) continue;

      // Fetch current price (tries Revolut X first, falls back to Kraken)
      const price = await getCurrentPrice(symbol).catch(() => null);
      if (!price) continue;

      // Dedup: skip if price hasn't changed since last fast-scan cycle
      if (fastScanLastPrice.get(symbol) === price) continue;
      fastScanLastPrice.set(symbol, price);

      console.log(`[fast-scan] ${symbol} @ ${fmtPriceShort(price)} — evaluating trailing stop`);
      await updateTrailingStop(symbol, price);
    }
  } catch (e) {
    console.error('[fast-scan] error:', e.message);
  }
}


// ── #12: Nightly DB backup to Google Drive (service-account JWT, no deps) ────
function bkBase64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function getGoogleAccessToken() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) throw new Error('Google OAuth env vars not set');
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!resp.ok) throw new Error(`token refresh failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.access_token;
}

async function dumpDatabase() {
  const dbName = process.env.DB_NAME;
  const [tables] = await db.execute(
    'SELECT TABLE_NAME as t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = ?',
    [dbName, 'BASE TABLE']
  );
  let out = `-- Revolut X DB backup\n-- Generated: ${new Date().toISOString()}\n-- Database: ${dbName}\n-- Tables: ${tables.length}\n\nSET FOREIGN_KEY_CHECKS=0;\n\n`;
  for (const { t } of tables) {
    const [rows] = await db.query('SELECT * FROM `' + t + '`');
    out += `\n-- ${t}: ${rows.length} rows\n`;
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    const colList = cols.map(c => '`' + c + '`').join(', ');
    for (const row of rows) {
      const vals = cols.map(c => {
        const v = row[c];
        if (v === null || v === undefined) return 'NULL';
        if (v instanceof Date) return mysql.escape(v.toISOString().slice(0, 19).replace('T', ' '));
        if (Buffer.isBuffer(v)) return mysql.escape(v.toString());
        return mysql.escape(v);
      });
      out += `INSERT INTO \`${t}\` (${colList}) VALUES (${vals.join(', ')});\n`;
    }
  }
  out += `\nSET FOREIGN_KEY_CHECKS=1;\n`;
  return out;
}


// ── Automated nightly server.js snapshot → revolut-claude-backups on Google Drive ──────────────
async function backupServerJsToDrive() {
  if (!process.env.GOOGLE_OAUTH_REFRESH_TOKEN) {
    console.log('[server-backup] disabled — GOOGLE_OAUTH_REFRESH_TOKEN missing');
    return;
  }
  const SNAPSHOTS_FOLDER_ID = '1q7QrDkDXWJmaKyeOuId9TeG2f6t8-MIJ'; // revolut-claude-backups on Drive
  try {
    console.log('[server-backup] starting server.js snapshot...');
    const token = await getGoogleAccessToken();

    // Step 1: create a dated subfolder (YYYY-MM-DD-auto)
    const date = new Date().toISOString().slice(0, 10);
    const folderName = `${date}-auto`;
    const folderResp = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [SNAPSHOTS_FOLDER_ID] }),
    });
    if (!folderResp.ok) throw new Error(`folder create failed: ${folderResp.status} ${await folderResp.text()}`);
    const { id: newFolderId } = await folderResp.json();
    console.log(`[server-backup] created folder ${folderName} (${newFolderId})`);

    // Step 2: upload server.js into the new folder
    const serverPath = join(dirname(fileURLToPath(import.meta.url)), 'server.js');
    const fileContent = readFileSync(serverPath);
    const boundary = 'srv_boundary_' + Date.now();
    const meta = JSON.stringify({ name: 'server.js', parents: [newFolderId] });
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: text/javascript\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    const body = Buffer.concat([Buffer.from(head, 'utf8'), fileContent, Buffer.from(tail, 'utf8')]);
    const upResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!upResp.ok) throw new Error(`upload failed: ${upResp.status} ${await upResp.text()}`);
    const uploaded = await upResp.json();
    console.log(`[server-backup] uploaded server.js (${(fileContent.length / 1024).toFixed(1)} KB) id=${uploaded.id}`);

    // Step 3: retention — keep newest 14 snapshot folders, delete older
    const listResp = await fetch(
      `https://www.googleapis.com/drive/v3/files?q='${SNAPSHOTS_FOLDER_ID}'+in+parents+and+trashed=false+and+mimeType='application/vnd.google-apps.folder'&orderBy=createdTime+desc&fields=files(id,name,createdTime)&pageSize=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (listResp.ok) {
      const { files } = await listResp.json();
      const old = (files || []).slice(14);
      for (const f of old) {
        await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
        console.log(`[server-backup] pruned old snapshot: ${f.name}`);
      }
    }

    await sendTelegram(`✅ <b>server.js snapshot</b>\n${folderName}/server.js (${(fileContent.length / 1024).toFixed(1)} KB) → Google Drive`).catch(() => {});
  } catch (e) {
    console.error('[server-backup] FAILED:', e.message);
    await sendTelegram(`⚠️ <b>server.js snapshot FAILED</b>\n${e.message}`).catch(() => {});
  }
}

async function backupDatabaseToDrive() {
  if (!process.env.GOOGLE_OAUTH_REFRESH_TOKEN || !process.env.GDRIVE_BACKUP_FOLDER_ID) {
    console.log('[backup] disabled — env vars missing');
    return;
  }
  const folderId = process.env.GDRIVE_BACKUP_FOLDER_ID;
  try {
    console.log('[backup] starting DB dump...');
    const sqlText = await dumpDatabase();
    const gz = gzipSync(Buffer.from(sqlText, 'utf8'));
    const now = new Date();
    const stamp = now.toISOString().slice(0, 16).replace('T', '-').replace(/:/g, '');
    const filename = `revolut-db-${stamp}.sql.gz`;

    const token = await getGoogleAccessToken();
    const boundary = 'bk_boundary_' + Date.now();
    const metadata = { name: filename, parents: [folderId] };
    const head = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`;
    const tail = `\r\n--${boundary}--`;
    const body = Buffer.concat([Buffer.from(head, 'utf8'), gz, Buffer.from(tail, 'utf8')]);

    const upResp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    if (!upResp.ok) throw new Error(`upload failed: ${upResp.status} ${await upResp.text()}`);
    const uploaded = await upResp.json();
    console.log(`[backup] uploaded ${filename} (${(gz.length / 1024).toFixed(1)} KB) id=${uploaded.id}`);

    // Retention: keep newest 14, delete older
    const listResp = await fetch(
      `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+trashed=false&orderBy=createdTime+desc&fields=files(id,name,createdTime)&pageSize=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (listResp.ok) {
      const { files } = await listResp.json();
      const old = (files || []).slice(14);
      for (const f of old) {
        await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
      }
      if (old.length) console.log(`[backup] pruned ${old.length} old backup(s)`);
    }

    await sendTelegram(`✅ <b>DB backup complete</b>\n${filename} (${(gz.length / 1024).toFixed(1)} KB) → Google Drive`).catch(() => {});
  } catch (e) {
    console.error('[backup] FAILED:', e.message);
    await sendTelegram(`⚠️ <b>DB backup FAILED</b>\n${e.message}`).catch(() => {});
  }
}

// ── #72: Researcher primitive — deep web research on one asset, evaluated vs its live plan ──
// ── #72 Build 2 helpers: parse research output + diff vs prior ─────────────
function extractThesisStatus(report) {
  if (!report) return 'INTACT';
  // Format-tolerant: find THESIS/FUNDAMENTALS section, scan its content for a status keyword.
  // Tolerates markdown headers, bold, "1)"/"1."/":" numbering, and content on same or next line.
  const secMatch = report.match(/(?:THESIS|FUNDAMENTALS)[^\n]*([\s\S]{0,300})/i);
  const scope = secMatch ? secMatch[0] : report.slice(0, 500);
  if (/\bSTRENGTHENING\b/i.test(scope)) return 'STRENGTHENING';
  if (/\bBROKEN\b/i.test(scope)) return 'BROKEN';
  if (/\bWEAKENING\b/i.test(scope)) return 'WEAKENING';
  if (/\bINTACT\b/i.test(scope)) return 'INTACT';
  const head = report.slice(0, 500);
  if (/strengthening/i.test(head)) return 'STRENGTHENING';
  if (/broken/i.test(head)) return 'BROKEN';
  if (/weakening/i.test(head)) return 'WEAKENING';
  return 'INTACT';
}

function extractDriftVerdict(report) {
  if (!report) return 'unknown';
  // Prefer explicit "PLAN-DRIFT VERDICT" heading; fall back to a line-anchored "VERDICT".
  // Captures content inline OR on the following line(s); strips markdown/leading punctuation.
  let m = report.match(/PLAN[-\s]?DRIFT\s+VERDICT\b\s*[:\-—–]?\s*([\s\S]{0,300})/i)
       || report.match(/(?:^|\n)[^\n]*?\bVERDICT\b\s*[:\-—–]?\s*([\s\S]{0,300})/i);
  if (!m) return 'unknown';
  let v = m[1]
    .replace(/^[\s>*#_:\-—–]+/, '')
    .split(/\n\s*\n/)[0]
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!v) return 'unknown';
  if (/\bplan intact\b/i.test(v)) return 'plan intact';
  return v.slice(0, 120);
}

function buildResearchDiff(prev, curr) {
  const lines = [];
  if (prev.thesis_status && prev.thesis_status !== curr.thesisStatus)
    lines.push(`Thesis: ${prev.thesis_status} → ${curr.thesisStatus}`);
  if (prev.drift_verdict === 'plan intact' && curr.driftVerdict && curr.driftVerdict !== 'plan intact')
    lines.push(`New drift: ${curr.driftVerdict.slice(0, 80)}`);
  if (prev.live_price && curr.livePrice) {
    const delta = ((curr.livePrice - parseFloat(prev.live_price)) / parseFloat(prev.live_price) * 100);
    if (Math.abs(delta) > 10)
      lines.push(`Price ${delta > 0 ? '+' : ''}${delta.toFixed(1)}% since last research ($${parseFloat(prev.live_price)} → $${curr.livePrice})`);
  }
  return lines.length ? lines.join('; ') : null;
}

async function researchAsset(symbol, triggeredBy = 'manual') {
  const base = symbol.toUpperCase().replace('-USD', '');
  const pair = base + '-USD';
  let plan = null;
  try {
    const [csRows] = await db.execute('SELECT * FROM coin_strategy WHERE symbol = ? LIMIT 1', [base]);
    plan = csRows[0] || null;
  } catch (e) { /* plan optional */ }
  let livePrice = null;
  try {
    const tickerResponse = await revolutRequest('GET', '/tickers');
    const tickerList = Array.isArray(tickerResponse) ? tickerResponse : (tickerResponse.data || []);
    for (const t of tickerList) {
      if (t.symbol && t.symbol.replace('/', '-').toUpperCase() === pair) {
        livePrice = parseFloat(t.last_price || t.mid || t.ask || t.bid); break;
      }
    }
    if (livePrice === null) livePrice = await getCurrentPrice(pair).catch(() => null);
  } catch (e) { /* price optional */ }

  const planBlock = plan
    ? `CURRENT SAVED PLAN for ${base}:\n- Status: ${plan.status || 'n/a'}\n- Role: ${plan.role || 'n/a'}\n- Theme: ${plan.theme || 'n/a'}\n- Strategy notes: ${(plan.strategy_md || '').slice(0, 1200)}`
    : `No saved plan on record for ${base}.`;
  const priceBlock = livePrice !== null ? `LIVE PRICE (just fetched): $${livePrice}` : 'Live price unavailable.';

  const prompt = `You are a crypto research analyst for Bryan, a disciplined swing trader in portfolio-recovery mode (no leverage, never sell below entry on anchors, ladder out on MSS, 25% moon bags). Research ${base} and evaluate reality AGAINST his saved plan below.\n\n${planBlock}\n\n${priceBlock}\n\nSearch the web for CURRENT information and produce a concise structured report:\n\n1) FUNDAMENTALS / THESIS — is the original thesis intact, strengthening, or broken?\n2) CATALYSTS — upcoming dated events (give DATE + expected impact + priced-in / sell-the-news risk). Flag any that already hit/missed/delayed.\n3) MATERIAL NEWS — only genuinely material items from the last ~2 weeks.\n4) PRICE vs THESIS — does current price action align with or diverge from the plan?\n5) PLAN-DRIFT VERDICT — has anything shifted enough to warrant a strategy adjustment? If yes, state the specific suggested adjustment (re-ladder / role change / cap change / exit-or-add thesis change). If no, say "plan intact".\n\nRULES: cite SOURCE + DATE for every factual claim. TAG any promotional/affiliate/leverage/influencer-pumped content and discount it. Reality-check every price/figure against the live price above — never relay a stale number as fact. You RECOMMEND only — never suggest auto-execution. Be concise; this is a notify/decision aid, not an essay.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
    messages: [{ role: 'user', content: prompt }],
  });
  await logClaudeCall(`research_asset ${base}`, 'claude-sonnet-4-6', response.usage);

  const textOut = (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  const thesisStatus = extractThesisStatus(textOut);
  const driftVerdict = extractDriftVerdict(textOut);

  let priorRow = null, diff = null;
  try {
    const [priorRows] = await db.execute(
      'SELECT * FROM research_history WHERE symbol = ? ORDER BY researched_at DESC LIMIT 1', [base]
    );
    if (priorRows.length) {
      priorRow = priorRows[0];
      diff = buildResearchDiff(priorRow, { thesisStatus, driftVerdict, livePrice });
    }
  } catch (e) { /* diff optional */ }

  try {
    await db.execute(
      `INSERT INTO research_history (symbol, triggered_by, live_price, thesis_status, drift_verdict, report_text, had_plan)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [base, triggeredBy, livePrice, thesisStatus, driftVerdict, textOut, !!plan]
    );
  } catch (e) { console.error('[research] store failed:', e.message); }

  return {
    symbol: base, pair, livePrice, hadPlan: !!plan,
    thesisStatus, driftVerdict, diff,
    priorResearchedAt: priorRow ? priorRow.researched_at : null,
    report: textOut || '(no text returned)'
  };
}

// ── #72 Build 2: weekly automated research sweep ──────────────────────────
async function weeklyResearchSweep() {
  const WEEKLY_COINS = ['CC', 'ENA', 'NEAR', 'JTO', 'TON', 'AERO', 'LINK', 'XLM', 'XRP', 'HYPE', 'RSC'];
  console.log(`[research-sweep] Starting weekly sweep for ${WEEKLY_COINS.length} coins...`);
  const results = [];
  for (const sym of WEEKLY_COINS) {
    try {
      console.log(`[research-sweep] Researching ${sym}...`);
      const r = await researchAsset(sym, 'weekly_sweep');
      results.push({ symbol: sym, thesisStatus: r.thesisStatus, driftVerdict: r.driftVerdict, diff: r.diff });
    } catch (e) {
      console.error(`[research-sweep] ${sym} failed:`, e.message);
      results.push({ symbol: sym, error: e.message });
    }
    // 30s spacing between calls — rate-limit friendly + spreads cost
    await new Promise(res => setTimeout(res, 30000));
  }
  const drifted = results.filter(r => !r.error && r.driftVerdict && r.driftVerdict !== 'plan intact');
  const changed = results.filter(r => !r.error && r.diff);
  const errors  = results.filter(r => r.error);
  let msg = `📊 <b>Weekly research sweep complete</b>\n${WEEKLY_COINS.length} coins checked`;
  if (drifted.length) {
    msg += `\n\n⚠️ <b>Plan drift detected (${drifted.length}):</b>`;
    for (const r of drifted) msg += `\n• <b>${r.symbol}</b> [${r.thesisStatus}] — ${String(r.driftVerdict).slice(0, 80)}`;
  }
  if (changed.length) {
    msg += `\n\n🔄 <b>Changes vs last research (${changed.length}):</b>`;
    for (const r of changed) msg += `\n• <b>${r.symbol}</b>: ${String(r.diff).slice(0, 80)}`;
  }
  if (!drifted.length && !changed.length) msg += `\n\n✅ All plans intact — no material changes vs last research.`;
  if (errors.length) msg += `\n\n❌ Failed: ${errors.map(r => r.symbol).join(', ')}`;
  msg += `\n\nReview flagged coins in the PM thread.`;
  try { await sendTelegram(msg); } catch (e) { console.error('[research-sweep] telegram failed:', e.message); }
  console.log(`[research-sweep] Done. Drifted: ${drifted.length}, changed: ${changed.length}, errors: ${errors.length}`);
}

async function recordDailyPrices() {
  try {
    console.log('Recording daily prices for price_history...');
    // Reset daily alert tracking so each new day gets a fresh first-alert + reminder cycle
    alertFirstSent.clear();
    alertReminderSent.clear();
    console.log('[alert] Daily alert tracking reset at midnight');
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

    // Save capital snapshot so corrupted values can be recovered
    try {
      const portfolioValue = await getCurrentPortfolioValue().catch(() => 0);
      await db.execute(
        `INSERT INTO system_config (config_key, config_value) VALUES ('capital_daily_snapshot', ?)
         ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
        [JSON.stringify({ amount: totalInvestedCapital, date: new Date().toISOString(), portfolio_value: portfolioValue })]
      );
      console.log(`[capital] Daily snapshot saved: $${totalInvestedCapital.toFixed(2)}`);
    } catch (e) { console.warn('[capital] Snapshot save error:', e.message); }
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

    // ── Kraken exchange ─────────────────────────────────────────────────────
    let krakenBriefingLine = '';
    try {
      const kData = await getKrakenBalances();
      if (kData.totalUSD > 0) {
        totalUSD += kData.totalUSD;
        const krakenTop = kData.balances.slice(0, 3)
          .map(a => `${a.standard}: $${a.valueUSD?.toFixed(0) || '?'}`)
          .join(', ');
        krakenBriefingLine = `\n🦑 Kraken: $${kData.totalUSD.toFixed(0)} (${krakenTop})`;
      }
    } catch (e) { console.warn('[briefing] Kraken fetch failed:', e.message); }

    // ── Tangem XRP wallet ───────────────────────────────────────────────────
    let tangemValue = 0;
    let tangemLine  = '';
    try {
      const xrpBalance = await getTangemXRPBalance();
      if (xrpBalance) {
        const xrpPrice = priceMap['XRP-USD'] || null;
        if (xrpPrice) {
          tangemValue = xrpBalance * xrpPrice;
          totalUSD   += tangemValue;
          const xrpPnlPct = ((xrpPrice - TANGEM_XRP_ENTRY) / TANGEM_XRP_ENTRY * 100);
          const xrpPnlEmoji = xrpPnlPct >= 0 ? '🟢' : '🔴';
          tangemLine = `\n🔐 Tangem: ${xrpBalance.toFixed(2)} XRP = $${tangemValue.toFixed(0)} | Entry $${TANGEM_XRP_ENTRY} | P&L: ${xrpPnlPct.toFixed(1)}% ${xrpPnlEmoji}`;
        }
      }
    } catch (e) { console.warn('[briefing] Tangem XRP fetch failed:', e.message); }

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
        "SELECT symbol, outcome, outcome_pnl FROM trading_journal WHERE outcome IS NOT NULL AND action NOT IN ('payment', 'transfer') AND updated_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) ORDER BY updated_at DESC LIMIT 5"
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
        "SELECT outcome_pnl FROM trading_journal WHERE outcome IS NOT NULL AND outcome_pnl IS NOT NULL AND action NOT IN ('payment', 'transfer') AND updated_at > DATE_SUB(NOW(), INTERVAL 7 DAY)"
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
      (krakenBriefingLine ? krakenBriefingLine : '') +
      (tangemLine ? tangemLine : '') +
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
      model: 'claude-sonnet-4-6',
      max_tokens: 800,  // FIX 6: reduced from 1000
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role: 'user',
        content: `Generate a concise morning market intelligence briefing.
Today is ${dateStr}. Search for latest crypto news.
Bryan's top holdings: ${portfolioContext}. Total portfolio: ${fmtAmt(totalUSD)}.

Maximum 800 tokens. Ultra concise. 3 bullet points max per section.

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

Keep total under 2000 characters. No long paragraphs. Be concise.`
      }]
    });
    await logClaudeCall('morning briefing', claudeResponse.model || 'claude-sonnet-4-6', claudeResponse.usage);

    const lastTextBlock = [...claudeResponse.content].reverse().find(b => b.type === 'text');
    const msg2 = lastTextBlock ? lastTextBlock.text.trim() : '📰 Market intelligence unavailable — check crypto news manually.';

    await sendTelegram(msg2);
    console.log('Market intelligence sent. Length:', msg2.length);

    // Cascade activity report — warn about any runaway downside buying overnight
    try {
      const [cascadeActivity] = await db.execute(
        `SELECT symbol, cascade_count, max_cascades
         FROM auto_trade_rules
         WHERE cascade_count > 0
           AND rule_type IN ('buy_retrace', 'buy_dip')
           AND active = 1
         ORDER BY cascade_count DESC`
      );
      if (cascadeActivity.length > 0) {
        const cascadeMsg = cascadeActivity
          .map(r => `${r.symbol.replace('-USD', '')}: ${r.cascade_count}/${r.max_cascades || 3} cascade buys`)
          .join('\n');
        await sendTelegram(
          `📊 <b>CASCADE ACTIVITY OVERNIGHT</b>\n\n` +
          cascadeMsg + '\n\n' +
          `Review these positions — multiple buys\n` +
          `without sells may indicate downtrend.`
        );
      }
    } catch (e) {
      console.log('[cascade] Overnight report skipped:', e.message);
    }

  } catch (e) {
    console.error('sendMorningBriefing error:', e.message);
    await sendTelegram(`❌ Morning briefing failed: ${e.message}`);
  } finally {
    briefingInProgress = false;
  }
}

async function updateLearningModel() {
  try {
    // ── 1. All journal entries (not just completed) ───────────────────────────
    const [allTrades] = await db.execute(
      "SELECT * FROM trading_journal WHERE action NOT IN ('payment', 'transfer') ORDER BY created_at DESC LIMIT 500"
    );
    const completedTrades = allTrades.filter(t => t.outcome_pnl != null);

    // Need at least a few entries to say anything useful
    if (allTrades.length < 3) {
      learningModelCache = '';
      return '';
    }

    // ── 2. Win-rate stats (completed trades only) ─────────────────────────────
    let winRateSection = '';
    if (completedTrades.length >= 3) {
      const wins = completedTrades.filter(t => parseFloat(t.outcome_pnl) > 0).length;
      const overallWinRate = Math.round((wins / completedTrades.length) * 100);

      const byAction = {};
      for (const t of completedTrades) {
        const a = t.action;
        if (!byAction[a]) byAction[a] = { wins: 0, total: 0 };
        byAction[a].total++;
        if (parseFloat(t.outcome_pnl) > 0) byAction[a].wins++;
      }
      const actionLines = Object.entries(byAction).map(([action, s]) =>
        `- ${action.toUpperCase()} trades: ${Math.round(s.wins / s.total * 100)}% win rate (${s.wins}/${s.total})`
      );

      const categories = {
        institutional: ['CC', 'LINK'],
        defi: ['HYPE', 'ENA', 'AAVE'],
        layer1: ['SOL', 'AVAX', 'NEAR', 'ADA'],
        meme: ['MOG', 'BONK', 'TURBO'],
      };
      const catLines = [];
      for (const [cat, coins] of Object.entries(categories)) {
        const catTrades = completedTrades.filter(t => coins.some(c => t.symbol.startsWith(c)));
        if (catTrades.length === 0) continue;
        const catWins = catTrades.filter(t => parseFloat(t.outcome_pnl) > 0).length;
        catLines.push(`- ${cat.charAt(0).toUpperCase() + cat.slice(1)} coins: ${Math.round(catWins / catTrades.length * 100)}% win rate`);
      }

      const byEmotion = {};
      for (const t of completedTrades) {
        if (!t.emotion || t.emotion === 'pending' || t.emotion === 'neutral') continue;
        if (!byEmotion[t.emotion]) byEmotion[t.emotion] = { wins: 0, total: 0 };
        byEmotion[t.emotion].total++;
        if (parseFloat(t.outcome_pnl) > 0) byEmotion[t.emotion].wins++;
      }
      const emotionLines = Object.entries(byEmotion).map(([emo, s]) =>
        `- Trading when ${emo}: ${Math.round(s.wins / s.total * 100)}% win rate (${s.total} trades)`
      );

      const followed = completedTrades.filter(t => t.followed_recommendation === 1);
      const ignored  = completedTrades.filter(t => t.followed_recommendation === 0);
      const followedWR = followed.length > 0 ? Math.round(followed.filter(t => parseFloat(t.outcome_pnl) > 0).length / followed.length * 100) : null;
      const ignoredWR  = ignored.length  > 0 ? Math.round(ignored.filter(t => parseFloat(t.outcome_pnl) > 0).length  / ignored.length  * 100) : null;

      winRateSection =
        `WIN RATES (${completedTrades.length} completed of ${allTrades.length} total, ${overallWinRate}% win rate):\n` +
        actionLines.join('\n') + '\n' +
        (catLines.length ? catLines.join('\n') + '\n' : '') +
        (emotionLines.length ? emotionLines.join('\n') + '\n' : '') +
        (followedWR !== null ? `- Followed Claude's advice: ${followedWR}% win rate (${followed.length} trades)\n` : '') +
        (ignoredWR  !== null ? `- Ignored  Claude's advice: ${ignoredWR}% win rate (${ignored.length} trades)\n` : '');
    } else {
      winRateSection = `JOURNAL ENTRIES: ${allTrades.length} logged (${completedTrades.length} with P&L outcomes so far — win rates available once outcomes are recorded)\n`;
    }

    // ── 3. Recent activity (last 10 entries regardless of outcome) ────────────
    const recent = allTrades.slice(0, 10);
    const recentLines = recent.map(t => {
      const date = new Date(t.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
      const pnl = t.outcome_pnl != null ? ` | P&L: ${parseFloat(t.outcome_pnl) >= 0 ? '+' : ''}${parseFloat(t.outcome_pnl).toFixed(1)}%` : '';
      const emotion = t.emotion && t.emotion !== 'pending' ? ` [${t.emotion}]` : '';
      return `- ${date}: ${t.action.toUpperCase()} ${t.symbol.replace('-USD','')} @ $${parseFloat(t.price).toFixed(4)}${emotion}${pnl}`;
    });
    const recentSection = `RECENT TRADES (last ${recent.length}):\n` + recentLines.join('\n') + '\n';

    // ── 4. Active portfolio positions ─────────────────────────────────────────
    let portfolioSection = '';
    try {
      const [snapshots] = await db.execute('SELECT symbol, quantity FROM balance_snapshots');
      const [entryRows] = await db.execute('SELECT symbol, entry_price FROM entry_prices');
      const entryMap = Object.fromEntries(entryRows.map(r => [r.symbol, parseFloat(r.entry_price)]));
      if (snapshots.length > 0) {
        const posLines = snapshots
          .filter(s => parseFloat(s.quantity) > 0)
          .map(s => {
            const ep = entryMap[s.symbol];
            return ep
              ? `- ${s.symbol.replace('-USD','')}: ${parseFloat(s.quantity).toFixed(4)} tokens @ $${ep.toFixed(4)} entry`
              : `- ${s.symbol.replace('-USD','')}: ${parseFloat(s.quantity).toFixed(4)} tokens`;
          });
        if (posLines.length > 0) portfolioSection = `CURRENT POSITIONS (${posLines.length}):\n` + posLines.join('\n') + '\n';
      }
    } catch (e) { /* ignore */ }

    // ── 5. Active auto rules ──────────────────────────────────────────────────
    let rulesSection = '';
    try {
      const [autoRules] = await db.execute('SELECT * FROM auto_trade_rules WHERE active = 1 ORDER BY symbol');
      if (autoRules.length > 0) {
        const ruleLines = autoRules.map(r =>
          `- [${r.id}] ${r.rule_type}: ${r.order_type.toUpperCase()} ${r.volume}${r.volume_type === 'pct' ? '%' : ''} ${r.symbol.replace('-USD','')} when ${r.direction} $${parseFloat(r.trigger_price).toFixed(4)} [${(r.exchange || 'kraken').toUpperCase()}]`
        );
        rulesSection = `ACTIVE AUTO RULES (${autoRules.length}):\n` + ruleLines.join('\n') + '\n';
      }
    } catch (e) { /* ignore */ }

    // ── 6. Recent trade intentions ────────────────────────────────────────────
    let intentionsSection = '';
    try {
      const [intentions] = await db.execute(
        "SELECT * FROM trade_intentions WHERE stated_at > DATE_SUB(NOW(), INTERVAL 7 DAY) ORDER BY stated_at DESC LIMIT 20"
      );
      if (intentions.length > 0) {
        const matched = intentions.filter(i => i.matched_at != null).length;
        const intentLines = intentions.map(i => {
          const status = i.matched_at ? '✅ matched' : i.expires_at < new Date() ? '⏰ expired' : '⏳ pending';
          return `- ${i.symbol.replace('-USD','')}: ${i.action} — ${status}`;
        });
        intentionsSection =
          `RECENT INTENTIONS (7d): ${matched}/${intentions.length} matched to trades\n` +
          intentLines.join('\n') + '\n';
      }
    } catch (e) { /* ignore */ }

    // ── 7. Intention tracking accuracy ───────────────────────────────────────
    let intentionAccSection = '';
    try {
      const [allIntentions] = await db.execute('SELECT * FROM intention_tracking');
      const completed = allIntentions.filter(i => i.pnl_result != null);
      if (allIntentions.length > 0) {
        intentionAccSection += `- Commitments logged: ${allIntentions.length} (${completed.length} with outcomes)\n`;
        if (completed.length > 0) {
          const profitable = completed.filter(i => parseFloat(i.pnl_result) > 0);
          const acc = Math.round(profitable.length / completed.length * 100);
          const avgPnl = (completed.reduce((s, i) => s + parseFloat(i.pnl_result), 0) / completed.length).toFixed(1);
          intentionAccSection += `- Advice accuracy when followed: ${acc}% profitable | Avg P&L: ${avgPnl >= 0 ? '+' : ''}${avgPnl}%\n`;
        }
      }
    } catch (e) { /* ignore */ }

    // ── 8. Rebalancing accuracy ───────────────────────────────────────────────
    let rebalanceSection = '';
    try {
      const [rebalances] = await db.execute('SELECT * FROM rebalancing_tracker WHERE outcome IS NOT NULL');
      if (rebalances.length >= 3) {
        const good = rebalances.filter(r => r.outcome === 'good');
        const acc = Math.round(good.length / rebalances.length * 100);
        const avgPnl = rebalances.reduce((s, r) => s + parseFloat(r.pnl_7d || 0), 0) / rebalances.length;
        rebalanceSection =
          `- Rebalancing accuracy: ${acc}% (${good.length}/${rebalances.length} correct)\n` +
          `- Average rebalancing gain: ${avgPnl >= 0 ? '+' : ''}${avgPnl.toFixed(1)}%\n`;
      }
    } catch (e) { /* ignore */ }

    // ── Assemble final summary ────────────────────────────────────────────────
    const summary = [
      winRateSection,
      recentSection,
      portfolioSection,
      rulesSection,
      intentionsSection,
      intentionAccSection,
      rebalanceSection,
    ].filter(Boolean).join('\n').trim();

    learningModelCache = summary;

    // Persist to system_config so startup check can detect it
    await db.execute(
      "INSERT INTO system_config (config_key, config_value) VALUES ('learning_model', ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)",
      [summary.substring(0, 8000)] // cap at 8KB to stay within config field limits
    ).catch(() => {});

    console.log(`[learning] Model updated — ${allTrades.length} total entries, ${completedTrades.length} with outcomes`);
    return learningModelCache;
  } catch (e) {
    console.error('updateLearningModel error:', e.message);
    return '';
  }
}

async function getLearningContext() {
  try {
    const [recentTrades] = await db.execute(
      "SELECT * FROM trading_journal WHERE action NOT IN ('payment', 'transfer') ORDER BY created_at DESC LIMIT 10"
    );
    const [profileRows] = await db.execute('SELECT preference_key, preference_value FROM trader_profile');
    const [completedTrades] = await db.execute(
      "SELECT outcome_pnl FROM trading_journal WHERE outcome_pnl IS NOT NULL AND action NOT IN ('payment', 'transfer')"
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
    console.log('[macro] Starting news check:', new Date().toISOString());

    // STEP 1: Identify holdings (>$50 USD — low threshold so we don't miss context)
    let significantHoldings = [];
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
      for (const asset of balances) {
        if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
        const available = parseFloat(asset.available);
        if (available <= 0) continue;
        const symbol = `${asset.currency}-USD`;
        const price = priceMap[symbol];
        if (!price) continue;
        const valueUSD = available * price;
        if (valueUSD < 50) continue;
        const narrative = COIN_NARRATIVES[asset.currency] || `${asset.currency} cryptocurrency`;
        significantHoldings.push({ coin: asset.currency, symbol, available, price, valueUSD, narrative });
      }
      significantHoldings.sort((a, b) => b.valueUSD - a.valueUSD);
    } catch (e) {
      console.warn('[macro] Could not load holdings, proceeding with static list:', e.message);
    }

    // Always check for major coins even if API fails
    const ALL_WATCHED_COINS = ['BTC', 'ETH', 'SOL', 'LINK', 'NEAR', 'CC', 'ENA', 'JTO', 'PEPE', 'INJ', 'FET', 'RENDER', 'AVAX', 'ALGO', 'BONK', 'WIF', 'SHIB', 'XRP', 'GHIBLI', 'ZK', 'TAO'];

    // STEP 2: Fetch RSS from multiple sources
    const RSS_FEEDS = [
      // Crypto news
      'https://cointelegraph.com/rss',
      'https://www.coindesk.com/arc/outboundfeeds/rss/',
      'https://decrypt.co/feed',
      'https://cryptoslate.com/feed/',
      'https://cryptobriefing.com/feed/',
      'https://bitcoinmagazine.com/.rss/full/',
      // Macro / financial
      'https://feeds.reuters.com/reuters/businessNews',
      'https://www.cnbc.com/id/10000664/device/rss/rss.html',
      // Geopolitical
      'https://feeds.bbci.co.uk/news/world/rss.xml',
      'https://rss.cnn.com/rss/cnn_world.rss',
    ];
    let allTitles = [];
    let rawNewsText = '';
    for (const url of RSS_FEEDS) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (response.ok) {
          const xml = await response.text();
          const extract = (tag) => [...xml.matchAll(new RegExp(`<${tag}>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*?))</${tag}>`, 'g'))]
            .map(m => (m[1] || m[2] || '').trim()).filter(Boolean);
          const titles = extract('title');
          const descs  = extract('description');
          allTitles.push(...titles);
          rawNewsText += titles.join(' ') + ' ' + descs.join(' ') + ' ';
          console.log(`[macro] Feed ${url.split('/')[2]}: ${titles.length} titles`);
        } else {
          console.log(`[macro] Feed failed (${response.status}):`, url);
        }
      } catch (e) {
        console.log('[macro] RSS fetch failed for', url, '-', e.message);
      }
    }

    console.log('[macro] Total titles fetched:', allTitles.length);
    console.log('[macro] Sample headlines:', allTitles.slice(0, 5));

    if (!rawNewsText.trim()) {
      console.log('[macro] No news fetched — aborting');
      return;
    }

    // STEP 3: Broad keyword check (free, no Claude API cost)
    const MACRO_KEYWORDS = [
      // BTC price levels
      'bitcoin', 'btc', '$70,000', '$70k', '$69k', '$68k', '$65k', '$60k',
      '70000', '68000', '65000', 'all-time high', 'ath', 'support', 'resistance',
      // Market structure
      'etf', 'outflow', 'inflow', 'institutional', 'microstrategy', 'blackrock',
      'liquidat', 'leverage', 'fear and greed', 'fear greed', 'open interest',
      // Macro economic
      'federal reserve', 'fed rate', 'inflation', 'cpi', 'fomc', 'interest rate',
      'recession', 'gdp', 'unemployment', 'dollar', 'dxy', 'rate hike', 'rate cut',
      // Geopolitical — critical
      'iran', 'strait of hormuz', 'hormuz', 'oil', 'crude', 'opec', 'energy crisis',
      'sanctions', 'war', 'conflict', 'nuclear', 'invasion', 'military', 'strike',
      'trade war', 'tariff', 'china', 'russia', 'middle east', 'ukraine',
      // Regulatory
      'sec', 'cftc', 'regulation', 'ban', 'illegal', 'legal', 'congress', 'senate',
      'ruling', 'court', 'clarity', 'compliance', 'enforcement', 'legislation',
      // Security
      'hack', 'exploit', 'stolen', 'breach', 'attack', 'vulnerability', 'drain',
      // Market events
      'crash', 'surge', 'liquidat', 'rally', 'dump', 'pump', 'volatile',
      'collapse', 'bankrupt', 'insolvency', 'billion', 'meltdown', 'panic',
      // Exchanges
      'binance', 'coinbase', 'kraken', 'ftx', 'bybit', 'okx',
      // Specific coins watched
      'chainlink', 'near protocol', 'canton network', 'dtcc', 'injective',
      'render', 'fetch.ai', 'ethena', 'algorand', 'floki', 'stellar', 'boba',
    ];
    const holdingKeywords = significantHoldings.map(h => h.coin.toLowerCase());
    const watchedKeywords = ALL_WATCHED_COINS.map(c => c.toLowerCase());
    const allKeywords = [...MACRO_KEYWORDS, ...holdingKeywords, ...watchedKeywords];
    const lowerNews = rawNewsText.toLowerCase();
    const foundKeywords = [...new Set(allKeywords.filter(kw => lowerNews.includes(kw)))];
    keywordsFound = foundKeywords.length > 0;

    console.log('[macro] Keywords matched:', foundKeywords.length, '—', foundKeywords.slice(0, 10).join(', '));

    if (!keywordsFound) {
      console.log('[macro] No keywords matched — skipping Claude call');
      return;
    }

    // STEP 4: Rate limit Claude to 1 hour between macro news calls
    const timeSinceLastCall = Date.now() - lastMacroNewsCallTime;
    if (timeSinceLastCall < 60 * 60 * 1000) {
      console.log('[macro] Claude rate limited — last call', Math.round(timeSinceLastCall / 60000), 'min ago (limit: 60 min)');
      return;
    }

    const holdingsList = significantHoldings.length > 0
      ? significantHoldings.map(h => `${h.coin} ($${h.valueUSD.toFixed(0)})`).join(', ')
      : ALL_WATCHED_COINS.join(', ');
    const headlines = allTitles.slice(0, 35).join('\n');
    const totalValue = significantHoldings.reduce((s, h) => s + h.valueUSD, 0);

    const claudeResponse = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: [{
        type: 'text',
        text: `You are monitoring financial and geopolitical news for a crypto swing trader named Bryan. Flag ANYTHING that could significantly move crypto markets in the next 24-72 hours.

Coins Bryan holds: LINK/Chainlink, NEAR Protocol, CC/Canton Network, ENA/Ethena, JTO, INJ/Injective, RENDER, FET/Fetch.ai, ALGO/Algorand, FLOKI, BOBA, XLM/Stellar, GHIBLI, BTC, ETH, SOL, XRP, AVAX, ADA

ALWAYS alert on:
- BTC price approaching or breaking key levels ($70K, $65K, $60K support)
- ETF inflows/outflows exceeding $500M
- Federal Reserve news, FOMC decisions, CPI prints, rate changes
- Major geopolitical escalation — wars, oil supply threats (Strait of Hormuz), nuclear threats, major sanctions
- Crypto exchange hacks or failures (any major exchange)
- Major regulatory decisions (SEC, CFTC, EU, UK FCA)
- Institutional buying/selling signals (Microstrategy, BlackRock ETF flows)
- S&P 500 vs BTC unusual divergence
- Oil price spikes >5% (affects risk appetite)
- Dollar strength spikes (DXY moves affect BTC)
- Market-wide liquidations >$100M
- Stablecoin de-peg or major protocol failure
- News about any of Bryan's specific coins above

URGENCY LEVELS:
- high: Imminent market impact (geopolitical escalation, major hack, BTC near key support, large liquidations)
- medium: Important but not immediate (regulatory updates, ETF flow data, macro prints)
- low: Interesting context (sentiment shifts, minor regulatory commentary)

Do NOT alert on: price predictions, technical analysis opinions, vague market sentiment.

Respond with JSON only — no extra text:
{
  "alert": true,
  "urgency": "high",
  "headline": "one line summary under 15 words",
  "message": "2-3 sentences — what happened and why it matters for crypto",
  "coins_affected": ["BTC", "LINK"],
  "action_needed": "what the trader should consider doing"
}
or:
{ "alert": false }`,
        cache_control: { type: 'ephemeral' }
      }],
      messages: [{
        role: 'user',
        content: `Holdings: ${holdingsList}${totalValue > 0 ? ` (total ~$${totalValue.toFixed(0)})` : ''}\nKeywords triggering this scan: ${foundKeywords.slice(0, 10).join(', ')}\n\nNews headlines to analyse:\n${headlines}`
      }]
    });

    lastMacroNewsCallTime = Date.now();
    await logClaudeCall('macro news analysis', claudeResponse.model || 'claude-haiku-4-5-20251001', claudeResponse.usage);

    const textBlock = [...claudeResponse.content].reverse().find(b => b.type === 'text');
    const responseText = textBlock?.text?.trim() || '{}';
    console.log('[macro] Claude raw response:', responseText.substring(0, 400));

    // Parse JSON — with fallback for any stray text wrapping
    let parsed = { alert: false };
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn('[macro] JSON parse failed, falling back to text detection:', e.message);
      // Fallback: treat as alert if Claude used the old emoji format
      if (responseText.includes('🚨') || responseText.toLowerCase().includes('macro alert')) {
        parsed = { alert: true, urgency: 'medium', message: responseText };
      }
    }

    console.log('[macro] Alert decision:', parsed.alert, '| Urgency:', parsed.urgency || 'n/a', '| Coins:', (parsed.coins_affected || []).join(', '));

    if (!parsed.alert) {
      console.log('[macro] No alert — Claude found nothing significant');
      return;
    }

    const alertMessage = parsed.message || 'Significant market event detected.';
    console.log('[macro] ALERT FIRED:', alertMessage.substring(0, 200));

    // Dedup 1 — exact hash match within 6 hours
    const alertHash = createHash('sha256').update(alertMessage.substring(0, 200)).digest('hex');
    const [existingRows] = await db.execute(
      'SELECT id FROM macro_alerts_sent WHERE alert_hash = ? AND sent_at > DATE_SUB(NOW(), INTERVAL 6 HOUR)',
      [alertHash]
    );
    if (existingRows.length > 0) {
      console.log('[macro] Duplicate suppressed — exact hash match (', alertHash.substring(0, 8) + ')');
      return;
    }

    // Dedup 2 — word-similarity check against last 5 alerts in past 2 hours
    const [recentAlerts] = await db.execute(
      'SELECT message FROM macro_alerts_sent WHERE sent_at > DATE_SUB(NOW(), INTERVAL 2 HOUR) AND message IS NOT NULL ORDER BY sent_at DESC LIMIT 5'
    ).catch(() => [[]]);
    const newWords = new Set(alertMessage.toLowerCase().split(/\s+/).filter(w => w.length > 4));
    for (const recent of recentAlerts) {
      if (!recent.message) continue;
      const recentWords = recent.message.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      const matches = recentWords.filter(w => newWords.has(w)).length;
      const similarity = recentWords.length > 0 ? matches / recentWords.length : 0;
      if (similarity > 0.5) {
        console.log(`[macro] Duplicate suppressed — ${(similarity * 100).toFixed(0)}% similar to recent alert`);
        return;
      }
    }

    // Build affected holdings section
    const affectedCoins = parsed.coins_affected || [];
    const affectedLines = significantHoldings
      .filter(h => affectedCoins.some(c => c.toUpperCase() === h.coin.toUpperCase()) || affectedCoins.length === 0)
      .slice(0, 5)
      .map(h => `• ${h.coin}: $${h.valueUSD.toFixed(0)}`);
    const affectedSection = affectedLines.length > 0
      ? `\n\n💼 <b>Your affected holdings:</b>\n${affectedLines.join('\n')}`
      : '';
    const headline = parsed.headline || '';
    const actionNeeded = parsed.action_needed || '';

    let telegramMessage;
    if (parsed.urgency === 'high') {
      telegramMessage =
        `🚨 <b>URGENT MACRO ALERT</b>\n\n` +
        (headline ? `<b>${headline}</b>\n\n` : '') +
        `${alertMessage}` +
        (affectedCoins.length ? `\n\n⚠️ Affected: ${affectedCoins.join(', ')}` : '') +
        affectedSection +
        (actionNeeded ? `\n\n💡 Consider: ${actionNeeded}` : '');
    } else if (parsed.urgency === 'medium') {
      telegramMessage =
        `⚠️ <b>MACRO UPDATE</b>\n\n` +
        (headline ? `${headline}\n\n` : '') +
        `${alertMessage}` +
        affectedSection;
    } else {
      telegramMessage =
        `📰 <b>MARKET NEWS</b>\n\n` +
        (headline || alertMessage);
    }
    await sendTelegram(telegramMessage);
    await db.execute('INSERT INTO macro_alerts_sent (alert_hash, message) VALUES (?, ?)', [alertHash, alertMessage.substring(0, 500)]);
    alertSent = true;

  } catch (e) {
    console.error('[macro] checkMacroNews error:', e.message, e.stack?.split('\n')[1]);
  }
  console.log('[macro] Done — keywords found:', keywordsFound, '| alert sent:', alertSent);
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

async function logRebalancePair({ sellSymbol, sellJournalId, sellPrice, sellValueUsd, sellQty, buySymbol, buyJournalId, buyPrice, buyValueUsd, buyQty }) {
  // Update both journal entries as transfers
  await db.execute(
    'UPDATE trading_journal SET action = ?, reasoning = ?, emotion = ? WHERE id = ?',
    ['transfer', `Rebalance exit — rotating into ${buySymbol || 'another position'}`, 'neutral', sellJournalId]
  );
  if (buyJournalId) {
    await db.execute(
      'UPDATE trading_journal SET action = ?, reasoning = ?, emotion = ? WHERE id = ?',
      ['transfer', `Rebalance entry — rotated from ${sellSymbol}`, 'neutral', buyJournalId]
    );
  }
  // Insert into rebalancing_tracker (primary) and rebalance_log (legacy)
  if (buySymbol && buyPrice) {
    await db.execute(
      `INSERT INTO rebalancing_tracker (out_symbol, out_price, out_quantity, out_value_usd, in_symbol, in_price, in_quantity, in_value_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sellSymbol, sellPrice || 0, sellQty || null, sellValueUsd || null, buySymbol, buyPrice, buyQty || null, buyValueUsd || null]
    );
  }
  await db.execute(
    `INSERT INTO rebalance_log (out_symbol, out_price, out_journal_id, in_symbol, in_price, in_journal_id, value_usd, rebalance_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURDATE())`,
    [sellSymbol, sellPrice, sellJournalId, buySymbol || null, buyPrice || null, buyJournalId || null, sellValueUsd || null]
  );
  await updateLearningModel().catch(() => {});
}

async function checkForRebalancePair(newSymbol, newAction, newJournalId, newPrice, newQty, newValueUsd, newExchange = 'revolut', reasoning = null) {
  try {
    const oppositeAction = newAction === 'sell' ? 'buy' : newAction === 'buy' ? 'sell' : null;
    if (!oppositeAction) return;

    // Check 4: skip if this is a test trade
    if (reasoning && reasoning.toLowerCase().includes('test')) {
      console.log('[rebalance] Skipping — test trade detected');
      return;
    }

    // Check 2: skip if current trade is too small to be a rebalance
    if ((newValueUsd || 0) < 10) {
      console.log('[rebalance] Skipping — trade too small for rebalance:', (newValueUsd || 0).toFixed(2));
      return;
    }

    const fifteenMinAgo = Date.now() - 15 * 60 * 1000;
    // Look for a complementary trade in pendingTradeContext within 15 minutes
    for (const [sym, pending] of pendingTradeContext) {
      if (sym === newSymbol) continue;
      if (pending.action !== oppositeAction) continue;
      if (pending.detectedAt < fifteenMinAgo) continue;

      // Check 3: same exchange only
      if ((pending.exchange || 'revolut') !== newExchange) {
        console.log('[rebalance] Skipping — different exchanges:', pending.exchange, 'vs', newExchange);
        continue;
      }

      // Check 2: counterpart trade also must meet minimum size
      if ((pending.valueUsd || 0) < 10) {
        console.log('[rebalance] Skipping — counterpart trade too small:', (pending.valueUsd || 0).toFixed(2));
        continue;
      }

      // Check 1: values must be within 50% of each other
      const sellValue = newAction === 'sell' ? (newValueUsd || 0) : (pending.valueUsd || 0);
      const buyValue  = newAction === 'buy'  ? (newValueUsd || 0) : (pending.valueUsd || 0);
      const larger    = Math.max(sellValue, buyValue);
      const smaller   = Math.min(sellValue, buyValue);
      const similarity = larger > 0 ? smaller / larger : 0;
      if (similarity < 0.5) {
        console.log('[rebalance] Skipping — values too different:', sellValue.toFixed(2), 'vs', buyValue.toFixed(2));
        continue;
      }

      // Passed all checks — Found a valid pair
      const sellSymbol = newAction === 'sell' ? newSymbol.replace('-USD', '') : sym.replace('-USD', '');
      const sellJournalId = newAction === 'sell' ? newJournalId : pending.journalId;
      const sellPrice = newAction === 'sell' ? newPrice : pending.price;
      const sellValueUsd = newAction === 'sell' ? newValueUsd : pending.valueUsd;
      const sellQty = newAction === 'sell' ? newQty : pending.qty;
      const buySymbol = newAction === 'buy' ? newSymbol.replace('-USD', '') : sym.replace('-USD', '');
      const buyJournalId = newAction === 'buy' ? newJournalId : pending.journalId;
      const buyPrice = newAction === 'buy' ? newPrice : pending.price;
      const buyValueUsd = newAction === 'buy' ? newValueUsd : pending.valueUsd;
      const buyQty = newAction === 'buy' ? newQty : pending.qty;
      // Store as pending rebalance confirmation (keyed by a stable string — use a fixed key since single user)
      pendingRebalanceConfirm.set('main', { sellSymbol, sellJournalId, sellPrice, sellValueUsd, sellQty, buySymbol, buyJournalId, buyPrice, buyValueUsd, buyQty });
      await sendTelegram(
        `🔄 <b>REBALANCING DETECTED</b>\n\n` +
        `📤 Sold ${sellSymbol}: ${sellQty?.toFixed(4)} tokens @ $${sellPrice?.toFixed(4)} ($${sellValueUsd?.toFixed(2)})\n` +
        `📥 Bought ${buySymbol}: ${buyQty?.toFixed(4)} tokens @ $${buyPrice?.toFixed(4)} ($${buyValueUsd?.toFixed(2)})\n\n` +
        `Is this a rebalancing or separate trades?\n` +
        `Reply:\n` +
        `<b>yes</b> — log as rebalance, track 7-day performance\n` +
        `<b>no</b> — log as separate trades (will ask for details)`
      );
      return; // Only fire once per pair
    }
  } catch (e) {
    console.error('[checkForRebalancePair] error:', e.message);
  }
}

async function findMatchingIntention(symbol, action) {
  try {
    // Strict action mapping — never cross-match sell↔buy or transfer↔buy
    const normalizedAction =
      action === 'sell'     ? ['sell', 'reduce'] :
      action === 'buy'      ? ['buy', 'add'] :
      action === 'transfer' ? ['transfer'] :
      [action];
    const placeholders = normalizedAction.map(() => '?').join(',');
    const [rows] = await db.execute(
      `SELECT * FROM trade_intentions
       WHERE symbol = ?
       AND action IN (${placeholders})
       AND matched_at IS NULL
       AND expires_at > NOW()
       AND stated_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
       ORDER BY stated_at DESC
       LIMIT 1`,
      [symbol, ...normalizedAction]
    );
    return rows.length > 0 ? rows[0] : null;
  } catch (e) {
    console.error('[intention] findMatchingIntention error:', e.message);
    return null;
  }
}

async function autoLogTrade(symbol, action, price, qtyChange, currentQty) {
  try {
    const coinBase = symbol.replace('-USD', '');
    const absQty = Math.abs(qtyChange);
    const valueUsd = absQty * price;

    // USDT is handled exclusively by the payment detector in checkPortfolio()
    // USD is a trading currency — changes are tracked differently
    // Neither should ever generate a Telegram context question
    if (coinBase === 'USDT' || coinBase === 'USD') {
      console.log(`[autoLog] ${coinBase} — skipping, handled by payment detector`);
      return;
    }

    // Debounce: if same symbol detected within 10 minutes, skip
    const existing = pendingTradeContext.get(symbol);
    if (existing && (Date.now() - existing.detectedAt) < 10 * 60 * 1000) {
      console.log(`Trade detection debounced for ${symbol} (within 10 min window)`);
      return;
    }

    // ── Deduplication: three-stage check before logging ──────────────────────

    // CHECK 1: Already logged by intention match (symbol stored without -USD)?
    try {
      const [intentionLog] = await db.execute(
        `SELECT id FROM trading_journal
         WHERE symbol = ?
         AND action = ?
         AND ABS(CAST(price AS DECIMAL(20,10)) - ?) < (? * 0.01 + 0.000001)
         AND created_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)
         LIMIT 1`,
        [coinBase, action, price, price]
      );
      if (intentionLog.length > 0) {
        console.log(`[autoLog] ${coinBase} already logged by intention match (id=${intentionLog[0].id}) — skipping`);
        return;
      }
    } catch (e) { console.error('[autoLog] Intention dedup check error:', e.message); }

    // CHECK 2: Already logged by Claude MCP / auto rule?
    try {
      const [recentSourced] = await db.execute(
        `SELECT id, source FROM trading_journal
         WHERE symbol IN (?, ?)
         AND action = ?
         AND source IN ('claude_mcp', 'auto_rule', 'ai_auto')
         AND created_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)
         LIMIT 1`,
        [coinBase, symbol, action]
      );
      if (recentSourced.length > 0) {
        console.log(`[autoLog] Suppressing — trade already logged (source=${recentSourced[0].source}, id=${recentSourced[0].id}). No Telegram sent — balance change may be a limit-order reservation, not a fill (#47).`);
        return;
      }
    } catch (e) { console.error('[autoLog] Source suppression check error:', e.message); }

    // CHECK 3: Quantity match against all three symbol formats within 10 minutes
    try {
      const [anyLog] = await db.execute(
        `SELECT id FROM trading_journal
         WHERE (symbol = ? OR symbol = ? OR symbol = ?)
         AND action = ?
         AND ABS(CAST(quantity AS DECIMAL(20,8)) - ?) < 0.01
         AND created_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)
         LIMIT 1`,
        [coinBase, symbol, coinBase + '-USD', action, parseFloat(absQty)]
      );
      if (anyLog.length > 0) {
        console.log(`[autoLog] ${coinBase} quantity-match duplicate (id=${anyLog[0].id}) — skipping`);
        return;
      }
    } catch (e) { console.error('[autoLog] Quantity dedup check error:', e.message); }
    // ──────────────────────────────────────────────────────────────────────────

    // Look up most recent Claude recommendation for this coin
    let claudeRec = null;
    try {
      const [recRows] = await db.execute(
        'SELECT recommendation FROM analysis_history WHERE symbol = ? AND created_at > DATE_SUB(NOW(), INTERVAL 7 DAY) ORDER BY created_at DESC LIMIT 1',
        [symbol]
      );
      if (recRows.length > 0) claudeRec = recRows[0].recommendation;
    } catch (e) { /* ignore */ }

    // Reclassify incoming buy as transfer if a transfer intention exists
    // (prevents transfers-in from Kraken being logged as buys)
    let reasoning = 'auto-detected';
    if (action === 'buy') {
      try {
        const transferIntention = await findMatchingIntention(symbol, 'transfer');
        if (transferIntention) {
          console.log(`[intention] Transfer intention matched for ${symbol} — reclassifying buy as transfer`);
          action = 'transfer';
          reasoning = transferIntention.reasoning || 'Transfer in — matched to stated intention';
          await db.execute('UPDATE trade_intentions SET matched_at = NOW() WHERE id = ?', [transferIntention.id]).catch(() => {});
        }
      } catch (e) {
        console.error('[intention] Transfer reclassification error:', e.message);
      }
    }

    // Insert journal entry — always use coinBase (no -USD suffix) to match intention-logged entries
    const [result] = await db.execute(
      'INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, claude_recommendation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [coinBase, action, price, absQty, valueUsd, reasoning, 'pending', claudeRec]
    );
    const journalId = result.insertId;

    // Regenerate learning model every 10th journal entry
    try {
      const [countRows] = await db.execute('SELECT COUNT(*) as total FROM trading_journal');
      const totalEntries = countRows[0].total;
      if (totalEntries % 10 === 0) {
        console.log(`[learning] ${totalEntries} journal entries — regenerating model`);
        updateLearningModel().catch(() => {});
      }
    } catch (e) { /* non-critical — ignore */ }

    // Record cash flow for historical cost basis tracking
    if ((action === 'buy' || action === 'sell') && valueUsd > 0 && absQty > 0) {
      await db.execute(
        `INSERT IGNORE INTO coin_cash_flows (symbol, flow_type, cash_amount, token_quantity, price, journal_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [coinBase, action, valueUsd, absQty, price, journalId]
      ).catch(e => console.warn('[cash-flows] Insert error:', e.message));
    }

    // Tax lot tracking — US HIFO disposal / buy lot recording
    if (action === 'buy') {
      await addTaxLot(
        symbol.replace('-USD', ''), 'revolut', absQty, price,
        new Date(), journalId, 'Buy detected via auto-log'
      );
    }
    if (action === 'sell') {
      const disposals = await disposeTaxLotsHIFO(
        symbol.replace('-USD', ''), absQty, price, new Date(), journalId
      );
      if (disposals.length > 0) {
        const totalGL = disposals.reduce((s, d) => s + d.gain_loss_usd, 0);
        const hasLong = disposals.some(d => d.is_long_term);
        const hasShort = disposals.some(d => !d.is_long_term);
        const termLabel = hasLong && hasShort ? 'mixed' : hasLong ? 'long-term' : 'short-term';
        console.log(`[tax] US HIFO: ${totalGL >= 0 ? 'Gain' : 'Loss'} $${Math.abs(totalGL).toFixed(2)} (${termLabel})`);
      }
    }
    if (action === 'payment') {
      // Spending crypto is a taxable disposal under both HMRC and IRS rules
      const disposals = await disposeTaxLotsHIFO(
        symbol.replace('-USD', ''), absQty, price, new Date(), journalId
      ).catch(e => { console.error('[tax] Payment disposal error:', e.message); return []; });
      if (disposals.length > 0) {
        const totalGL = disposals.reduce((s, d) => s + d.gain_loss_usd, 0);
        const hasLong = disposals.some(d => d.is_long_term);
        const hasShort = disposals.some(d => !d.is_long_term);
        const termLabel = hasLong && hasShort ? 'mixed' : hasLong ? 'long-term' : 'short-term';
        console.log(`[tax] Payment disposal — US HIFO: ${totalGL >= 0 ? 'Gain' : 'Loss'} $${Math.abs(totalGL).toFixed(2)} (${termLabel})`);
      }

      // Calculate P&L against entry price and update journal
      const payEntryPrice = entryPrices.get(symbol);
      const salePrice = parseFloat(price);
      const saleQty = parseFloat(absQty);

      if (payEntryPrice && salePrice && saleQty) {
        const gainLoss = (salePrice - payEntryPrice) * saleQty;
        const gainLossPct = ((salePrice - payEntryPrice) / payEntryPrice * 100);
        const isGain = gainLoss > 0;

        await db.execute(
          `UPDATE trading_journal SET outcome_pnl = ?, outcome_notes = ? WHERE id = ?`,
          [gainLoss,
           `Payment disposal: ${isGain ? 'GAIN' : 'LOSS'} of $${Math.abs(gainLoss).toFixed(2)} (${gainLossPct.toFixed(1)}%) — taxable event`,
           journalId]
        ).catch(e => console.error('[payment] P&L update error:', e.message));

        await sendTelegram(
          `✅ <b>PAYMENT LOGGED — ${coinBase}</b>\n\n` +
          `Amount: ${formatTradeQty(saleQty)} ${coinBase}\n` +
          `Sale price: ${formatPrice(salePrice)}\n` +
          `Value: $${(salePrice * saleQty).toFixed(2)}\n\n` +
          `📊 <b>Tax Disposal:</b>\n` +
          `Entry price: ${formatPrice(payEntryPrice)}\n` +
          `${isGain ? '✅ Gain' : '⚠️ Loss'}: ${isGain ? '+' : ''}$${gainLoss.toFixed(2)} (${gainLossPct.toFixed(1)}%)\n\n` +
          `⚠️ This is a taxable disposal event\n` +
          `Excluded from trading performance stats\n` +
          `Recorded in tax lot tracking`
        ).catch(() => {});
      } else {
        // No entry price — basic confirmation
        await sendTelegram(
          `✅ <b>PAYMENT LOGGED — ${coinBase}</b>\n` +
          `${formatTradeQty(absQty)} ${coinBase} @ ${formatPrice(price)} ($${valueUsd.toFixed(2)})\n` +
          `Excluded from trading stats.\n` +
          `⚠️ Taxable disposal — no entry price on record`
        ).catch(() => {});
      }

      return; // Skip the TRADE DETECTED question — payment is fully handled above
    }

    // If sell: calculate and store realised P&L immediately
    let pnlLine = '';
    if (action === 'sell') {
      // Legacy outcome recording (kept for any downstream consumers)
      await recordTradeOutcome(symbol, price, absQty, currentQty).catch(() => {});

      try {
        const sellEntryPrice = entryPrices.get(symbol);
        const salePrice      = parseFloat(price);
        const saleQty        = parseFloat(absQty);

        if (sellEntryPrice && salePrice && saleQty) {
          const realisedPnl    = (salePrice - sellEntryPrice) * saleQty;
          const realisedPnlPct = ((salePrice - sellEntryPrice) / sellEntryPrice * 100);
          const isGain         = realisedPnl > 0;

          // Persist to journal
          await db.execute(
            `UPDATE trading_journal SET outcome_pnl = ?, outcome_notes = ? WHERE id = ?`,
            [realisedPnl,
             `Realised ${isGain ? 'gain' : 'loss'}: ${isGain ? '+' : ''}$${realisedPnl.toFixed(2)} ` +
             `(${realisedPnlPct.toFixed(1)}%) | ` +
             `Entry: ${formatPrice(sellEntryPrice)} | Sale: ${formatPrice(salePrice)} | Method: US HIFO`,
             journalId]
          );

          // Running total realised P&L for this coin
          const [runningRows] = await db.execute(
            `SELECT SUM(outcome_pnl) as total_pnl, COUNT(*) as total_sells
             FROM trading_journal
             WHERE symbol = ? AND action = 'sell' AND outcome_pnl IS NOT NULL`,
            [coinBase]
          );
          const totalPnl   = parseFloat(runningRows[0]?.total_pnl || 0);
          const totalSells = runningRows[0]?.total_sells || 0;

          pnlLine =
            `\n${isGain ? '✅' : '⚠️'} Realised: ${isGain ? '+' : ''}$${realisedPnl.toFixed(2)} (${realisedPnlPct.toFixed(1)}%)\n` +
            `📊 Total ${coinBase} P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} across ${totalSells} sells`;

          console.log(`[pnl] ${coinBase} sell: ${isGain ? 'GAIN' : 'LOSS'} $${realisedPnl.toFixed(2)} (${realisedPnlPct.toFixed(1)}%) | running total: $${totalPnl.toFixed(2)}`);
        }
      } catch (e) {
        console.error('[pnl] P&L calculation error:', e.message);
      }
    }

    // If full sell: preserve cost basis with last_sold_price / last_sold_at
    if (action === 'sell') {
      try {
        const currentEntry = entryPrices.get(symbol);
        if (currentEntry) {
          // Check remaining balance after this sell
          const freshBals = await revolutRequest('GET', '/balances').catch(() => []);
          const asset = freshBals.find(b => b.currency === coinBase);
          const remainingQty = parseFloat(asset?.available || 0);
          if (remainingQty < 0.001) {
            await db.execute(
              `UPDATE entry_prices SET last_sold_price = ?, last_sold_at = NOW() WHERE symbol = ?`,
              [currentEntry, symbol]
            ).catch(() => {});
            console.log(`[entry] ${coinBase} fully sold — cost basis $${currentEntry.toFixed(6)} preserved`);
          }
        }
      } catch (e) { console.warn('[entry] Full-sell preservation error:', e.message); }
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

    // If buy: set entry from internal calculation first, then attempt exchange sync
    let avgEntryLine = '';
    if (action === 'buy') {
      try {
        const prevQty = previousBalances.get(symbol) || 0;
        const existingEntry = entryPrices.get(symbol);
        const isCycleBuyback = prevQty === 0 && existingEntry != null;
        if (existingEntry && prevQty > 0) {
          const newQty = prevQty + absQty;
          const newAvgEntry = ((prevQty * existingEntry) + (absQty * price)) / newQty;
          await updateEntryPrice(symbol, newAvgEntry, false);
          avgEntryLine = `\n📊 Avg entry: ${formatPrice(newAvgEntry)} (internal)`;
        } else if (!existingEntry && price > 0) {
          await updateEntryPrice(symbol, price, false);
          avgEntryLine = `\n📊 Entry price set: ${formatPrice(price)}`;
        } else if (isCycleBuyback) {
          await updateEntryPrice(symbol, price, true);
          // Clear last_sold_at so this coin is no longer shown as "sold"
          await db.execute(
            'UPDATE entry_prices SET last_sold_at = NULL WHERE symbol = ?', [symbol]
          ).catch(() => {});
          avgEntryLine = `\n🔄 Cycle buyback entry: ${formatPrice(price)}`;
        }
      } catch (e) {
        console.error('[entry] avg entry update error:', e.message);
      }

      // Attempt live sync from the exchange — overwrites internal estimate if exchange has data
      try {
        const isKraken = KRAKEN_MONITORED_COINS.includes(symbol);
        const syncedPrice = isKraken
          ? await syncEntryPriceFromKraken(symbol)
          : await syncEntryPriceFromRevolutX(symbol);
        if (syncedPrice) {
          avgEntryLine = `\n📊 Avg entry synced from exchange: ${formatPrice(syncedPrice)}`;
          console.log(`[entry-sync] ✅ ${symbol} entry synced: $${syncedPrice}`);
        }
      } catch (e) {
        console.warn('[entry-sync] Sync failed, keeping internal estimate:', e.message);
      }
    }

    // Update balance snapshot immediately so position quantities stay accurate
    // without waiting for the next scheduled portfolio check
    previousBalances.set(symbol, currentQty);
    await db.execute(
      'INSERT INTO balance_snapshots (symbol, quantity) VALUES (?, ?) ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)',
      [symbol, currentQty]
    ).catch(e => console.error('[balance] snapshot update failed:', e.message));
    console.log(`[balance] ${symbol} quantity updated to ${currentQty} after ${action}`);

    // Check if Bryan stated his intention for this trade beforehand
    const matchedIntention = await findMatchingIntention(symbol, action);

    if (matchedIntention) {
      // Auto-log with stored reasoning — no questions needed
      await db.execute(
        'UPDATE trading_journal SET reasoning = ?, emotion = ? WHERE id = ?',
        [matchedIntention.reasoning, matchedIntention.emotion, journalId]
      );
      await db.execute(
        'UPDATE trade_intentions SET matched_journal_id = ?, matched_at = NOW() WHERE id = ?',
        [journalId, matchedIntention.id]
      );

      await sendTelegram(`${action === 'sell' ? '✅' : '🟢'} ${action.toUpperCase()} ${formatTradeQty(absQty)} ${coinBase} @ ${formatPrice(price)} = $${valueUsd.toFixed(2)} 🎯`);
      await updateLearningModel().catch(() => {});
      console.log(`[intention] Match found for ${symbol} — suppressing Telegram question`);
      return; // EXIT: skip pendingTradeContext, journal question, and 30-min timeout
    }

    // No intention matched — only ask for context if truly manual (not transfer/payment/USDT)
    if (action === 'transfer' || action === 'payment' || coinBase === 'USDT') {
      console.log(`[autoLog] ${symbol} ${action} — non-manual source, skipping context question`);
      return;
    }

    // ── USDT/USD sweep auto-detection ──────────────────────────────────────────
    // If a sell is detected and USDT or USD balance increased by a similar amount
    // in the same cycle, auto-classify as an internal cash conversion — no question.
    if (action === 'sell') {
      try {
        const freshBalances = await revolutRequest('GET', '/balances').catch(() => []);
        const usdtAsset = freshBalances.find(b => b.currency === 'USDT');
        const usdAsset  = freshBalances.find(b => b.currency === 'USD');
        const currentUSDT = parseFloat(usdtAsset?.available || 0);
        const currentUSD  = parseFloat(usdAsset?.available  || 0);
        // Use lastKnownUSDT (set at start of cycle) so the delta is correct
        const prevUSDT    = lastKnownUSDT ?? currentUSDT;
        const prevUSD     = previousBalances.get('USD-USD') ?? currentUSD;
        const usdtIncrease = Math.max(0, currentUSDT - prevUSDT);
        const usdIncrease  = Math.max(0, currentUSD  - prevUSD);
        const cashIncrease = Math.max(usdtIncrease, usdIncrease);
        const cashType     = usdtIncrease >= usdIncrease ? 'USDT' : 'USD';
        const similarity   = valueUsd > 0 ? Math.abs(cashIncrease - valueUsd) / valueUsd : 1;
        console.log(`[sweep] ${coinBase} sell $${valueUsd.toFixed(2)} | USDT: ${prevUSDT}→${currentUSDT} (+${usdtIncrease.toFixed(2)}) | USD: ${prevUSD}→${currentUSD} (+${usdIncrease.toFixed(2)}) | sim=${similarity.toFixed(3)}`);

        if (cashIncrease > 0.50 && similarity < 0.10) {
          console.log(`[autoLog] ${coinBase} sell → ${cashType} +$${cashIncrease.toFixed(2)} detected — auto-classifying as sweep`);
          await db.execute(
            'UPDATE trading_journal SET reasoning = ?, emotion = ? WHERE id = ?',
            [`Auto-detected: ${coinBase} converted to ${cashType} reserve. Value: $${valueUsd.toFixed(2)}`, 'neutral', journalId]
          );
          if (cashType === 'USDT') previousBalances.set('USDT-USD', currentUSDT);
          else                     previousBalances.set('USD-USD',  currentUSD);
          await sendTelegram(
            `✅ <b>AUTO-LOGGED — ${coinBase} → ${cashType}</b>\n\n` +
            `SELL ${formatTradeQty(absQty)} ${coinBase} @ ${formatPrice(price)}\n` +
            `Value: $${valueUsd.toFixed(2)}\n` +
            `${cashType} reserve: +$${cashIncrease.toFixed(2)}\n\n` +
            `📝 Logged as ${cashType} sweep — no action needed`
          );
          await updateLearningModel().catch(() => {});
          return; // Skip the Telegram question entirely
        }
      } catch (e) {
        console.warn('[autoLog] Cash sweep detection error:', e.message);
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    const actionLabel = action === 'buy' ? 'BOUGHT' : action === 'sell' ? 'SOLD' : action.toUpperCase();

    // Check if a trailing stop recently triggered for this symbol (within 2 hours)
    const recentTrailAlert = trailingStopAlerted.get(symbol);
    const trailTriggered = recentTrailAlert && (Date.now() - recentTrailAlert) < 2 * 60 * 60 * 1000;

    // Check journal for recent trailing stop / MSS context
    let recentJournalContext = null;
    try {
      const [recentJournal] = await db.execute(
        `SELECT reasoning FROM trading_journal
         WHERE symbol = ?
         AND created_at > DATE_SUB(NOW(), INTERVAL 2 HOUR)
         AND (reasoning LIKE '%trailing stop%' OR reasoning LIKE '%MSS%' OR reasoning LIKE '%market structure%')
         ORDER BY created_at DESC LIMIT 1`,
        [coinBase]
      );
      if (recentJournal.length > 0) recentJournalContext = recentJournal[0].reasoning;
    } catch (e) { /* ignore */ }

    // Build recommendation line — trailing stop context takes priority over stale rec
    let recLine = '';
    if (trailTriggered && action === 'sell') {
      recLine = `\n📊 Last Claude rec: SELL — trailing stop triggered`;
    } else if (recentJournalContext && action === 'sell') {
      recLine = `\n📊 Context: ${recentJournalContext.substring(0, 80)}...`;
    } else if (claudeRec) {
      recLine = `\n📊 Last Claude rec: ${claudeRec}`;
    }

    const reentryLine = reentryNote || '';
    const msg =
      `📝 <b>TRADE DETECTED — ${symbol}</b>\n` +
      `Action: ${actionLabel} ~${formatTradeQty(absQty)} tokens at ${formatPrice(price)} ($${valueUsd.toFixed(2)})${pnlLine}${avgEntryLine}${recLine}${reentryLine}\n\n` +
      `Just reply:\n` +
      `'<b>taking profits, confident</b>' — reason + emotion, done\n` +
      `'<b>rebalance [coin]</b>' — bought with proceeds from selling [coin]\n` +
      `'<b>payment</b>' — Revolut payment (excluded from stats)\n` +
      `'<b>transfer</b>' — internal transfer (excluded from stats)\n` +
      `'<b>skip</b>' — log without details\n\n` +
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

    pendingTradeContext.set(symbol, { journalId, detectedAt: Date.now(), timeoutHandle, action, price, valueUsd, qty: absQty, exchange: 'revolut' });
    console.log(`Auto-logged trade: ${symbol} ${action} ${absQty.toFixed(4)} @ $${price.toFixed(4)}`);

    // Check if this forms a rebalancing pair with another recent trade
    await checkForRebalancePair(symbol, action, journalId, price, absQty, valueUsd, 'revolut', null);
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

async function checkRebalancingOutcomes() {
  try {
    // 7-day check
    const [sevenDay] = await db.execute(
      'SELECT * FROM rebalancing_tracker WHERE check_date_7 IS NULL AND rebalance_date < DATE_SUB(NOW(), INTERVAL 7 DAY)'
    );
    for (const row of sevenDay) {
      try {
        const outSym = `${row.out_symbol}-USD`;
        const inSym  = `${row.in_symbol}-USD`;
        const [outData, inData] = await Promise.all([fetchPrices([outSym]), fetchPrices([inSym])]);
        const outNow = outData?.[outSym]?.price;
        const inNow  = inData?.[inSym]?.price;
        if (!outNow || !inNow) continue;
        const outPct = ((outNow - parseFloat(row.out_price)) / parseFloat(row.out_price)) * 100;
        const inPct  = ((inNow  - parseFloat(row.in_price))  / parseFloat(row.in_price))  * 100;
        const pnl7d  = inPct - outPct;
        const good   = pnl7d > 0;
        const outcome = good ? 'good' : 'bad';
        await db.execute(
          'UPDATE rebalancing_tracker SET check_date_7 = NOW(), out_price_7d = ?, in_price_7d = ?, pnl_7d = ?, outcome = ? WHERE id = ?',
          [outNow, inNow, pnl7d.toFixed(4), outcome, row.id]
        );
        // Also mark legacy rebalance_log
        await db.execute(
          "UPDATE rebalance_log SET checked_at = NOW(), out_price_at_check = ?, in_price_at_check = ?, verdict = ? WHERE out_symbol = ? AND in_symbol = ? AND checked_at IS NULL ORDER BY id DESC LIMIT 1",
          [outNow, inNow, outcome, row.out_symbol, row.in_symbol]
        ).catch(() => {});
        await updateLearningModel().catch(() => {});
        const rebalDate = new Date(row.rebalance_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        if (good) {
          await sendTelegram(
            `📊 <b>REBALANCING CHECK — 7 days ago</b>\n\n` +
            `📤 Sold ${row.out_symbol} @ $${parseFloat(row.out_price).toFixed(4)} → Now $${outNow.toFixed(4)} (${outPct >= 0 ? '+' : ''}${outPct.toFixed(1)}%)\n` +
            `📥 Bought ${row.in_symbol} @ $${parseFloat(row.in_price).toFixed(4)} → Now $${inNow.toFixed(4)} (${inPct >= 0 ? '+' : ''}${inPct.toFixed(1)}%)\n\n` +
            `✅ <b>GOOD REBALANCE</b> — ${row.in_symbol} outperformed ${row.out_symbol} by +${Math.abs(pnl7d).toFixed(1)}%\n` +
            `Your instinct to switch was correct! 🎉\n🧠 Learning model updated`
          );
        } else {
          await sendTelegram(
            `📊 <b>REBALANCING CHECK — 7 days ago</b>\n\n` +
            `📤 Sold ${row.out_symbol} @ $${parseFloat(row.out_price).toFixed(4)} → Now $${outNow.toFixed(4)} (${outPct >= 0 ? '+' : ''}${outPct.toFixed(1)}%)\n` +
            `📥 Bought ${row.in_symbol} @ $${parseFloat(row.in_price).toFixed(4)} → Now $${inNow.toFixed(4)} (${inPct >= 0 ? '+' : ''}${inPct.toFixed(1)}%)\n\n` +
            `❌ ${row.out_symbol} outperformed ${row.in_symbol} by ${Math.abs(pnl7d).toFixed(1)}%\n` +
            `Holding ${row.out_symbol} would have been better this time.\n🧠 Learning model updated — every data point helps`
          );
        }
      } catch (e) { console.error('[rebalance 7d] row error:', e.message); }
    }

    // 30-day check
    const [thirtyDay] = await db.execute(
      'SELECT * FROM rebalancing_tracker WHERE check_date_30 IS NULL AND rebalance_date < DATE_SUB(NOW(), INTERVAL 30 DAY)'
    );
    for (const row of thirtyDay) {
      try {
        const outSym = `${row.out_symbol}-USD`;
        const inSym  = `${row.in_symbol}-USD`;
        const [outData, inData] = await Promise.all([fetchPrices([outSym]), fetchPrices([inSym])]);
        const outNow = outData?.[outSym]?.price;
        const inNow  = inData?.[inSym]?.price;
        if (!outNow || !inNow) continue;
        const outPct = ((outNow - parseFloat(row.out_price)) / parseFloat(row.out_price)) * 100;
        const inPct  = ((inNow  - parseFloat(row.in_price))  / parseFloat(row.in_price))  * 100;
        const pnl30d = inPct - outPct;
        const good   = pnl30d > 0;
        await db.execute(
          'UPDATE rebalancing_tracker SET check_date_30 = NOW(), out_price_30d = ?, in_price_30d = ?, pnl_30d = ? WHERE id = ?',
          [outNow, inNow, pnl30d.toFixed(4), row.id]
        );
        await updateLearningModel().catch(() => {});
        if (good) {
          await sendTelegram(
            `📊 <b>REBALANCING CHECK — 30 days ago</b>\n\n` +
            `📤 Sold ${row.out_symbol} @ $${parseFloat(row.out_price).toFixed(4)} → Now $${outNow.toFixed(4)} (${outPct >= 0 ? '+' : ''}${outPct.toFixed(1)}%)\n` +
            `📥 Bought ${row.in_symbol} @ $${parseFloat(row.in_price).toFixed(4)} → Now $${inNow.toFixed(4)} (${inPct >= 0 ? '+' : ''}${inPct.toFixed(1)}%)\n\n` +
            `✅ <b>GOOD REBALANCE</b> — ${row.in_symbol} outperformed ${row.out_symbol} by +${Math.abs(pnl30d).toFixed(1)}% over 30 days 🎉`
          );
        } else {
          await sendTelegram(
            `📊 <b>REBALANCING CHECK — 30 days ago</b>\n\n` +
            `📤 Sold ${row.out_symbol} @ $${parseFloat(row.out_price).toFixed(4)} → Now $${outNow.toFixed(4)} (${outPct >= 0 ? '+' : ''}${outPct.toFixed(1)}%)\n` +
            `📥 Bought ${row.in_symbol} @ $${parseFloat(row.in_price).toFixed(4)} → Now $${inNow.toFixed(4)} (${inPct >= 0 ? '+' : ''}${inPct.toFixed(1)}%)\n\n` +
            `❌ ${row.out_symbol} outperformed ${row.in_symbol} by ${Math.abs(pnl30d).toFixed(1)}% over 30 days\nHolding ${row.out_symbol} would have been better.`
          );
        }
      } catch (e) { console.error('[rebalance 30d] row error:', e.message); }
    }
  } catch (e) {
    console.error('[checkRebalancingOutcomes] error:', e.message);
  }
}

// Keep old name as alias for backward compat
const checkRebalanceOutcomes = checkRebalancingOutcomes;

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

// #48 v1: forward trade-outcome grader (writes only new columns)
async function gradeTradeOutcomes() {
  try {
    let priceMap = {};
    try {
      const tr = await revolutRequest('GET', '/tickers');
      const list = Array.isArray(tr) ? tr : (tr.data || []);
      for (const t of list) {
        if (!t.symbol) continue;
        const p = parseFloat(t.last_price || t.mid || t.ask || t.bid);
        if (p) { priceMap[t.symbol] = p; priceMap[t.symbol.replace('/', '-')] = p; }
      }
    } catch (e) { console.warn('[grade] ticker prefetch failed:', e.message); }

    const priceFor = async (symbol) => {
      const sym = symbol.includes('-USD') ? symbol : `${symbol}-USD`;
      if (priceMap[sym]) return priceMap[sym];
      return await getCurrentPrice(sym).catch(() => null);
    };
    const gradeRow = (action, entry, now) => {
      const rawMove = ((now - entry) / entry) * 100;
      const a = (action || '').toLowerCase();
      return (a === 'sell' || a === 'reduce') ? -rawMove : rawMove; // sells inverse: price down after = good exit
    };

    const [d7] = await db.execute(
      `SELECT id, symbol, action, price FROM trading_journal
       WHERE action IN ('buy','sell','add','reduce') AND price > 0 AND outcome_7d_pct IS NULL
         AND created_at <  DATE_SUB(NOW(), INTERVAL 7 DAY)
         AND created_at >= DATE_SUB(NOW(), INTERVAL 9 DAY)`);
    let g7 = 0;
    for (const r of d7) {
      const now = await priceFor(r.symbol); const entry = parseFloat(r.price);
      if (!now || !entry) continue;
      await db.execute(
        `UPDATE trading_journal SET outcome_7d_pct = ?, outcome_grade_source = 'forward_live' WHERE id = ?`,
        [gradeRow(r.action, entry, now).toFixed(4), r.id]); g7++;
    }

    const [d30] = await db.execute(
      `SELECT id, symbol, action, price FROM trading_journal
       WHERE action IN ('buy','sell','add','reduce') AND price > 0 AND outcome_30d_pct IS NULL
         AND created_at <  DATE_SUB(NOW(), INTERVAL 30 DAY)
         AND created_at >= DATE_SUB(NOW(), INTERVAL 32 DAY)`);
    let g30 = 0;
    for (const r of d30) {
      const now = await priceFor(r.symbol); const entry = parseFloat(r.price);
      if (!now || !entry) continue;
      await db.execute(
        `UPDATE trading_journal SET outcome_30d_pct = ?, outcome_grade_source = COALESCE(outcome_grade_source,'forward_live') WHERE id = ?`,
        [gradeRow(r.action, entry, now).toFixed(4), r.id]); g30++;
    }
    console.log(`[grade] #48 forward grader: ${g7} @7d, ${g30} @30d`);
  } catch (e) { console.error('[grade] gradeTradeOutcomes error:', e.message); }
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
      model: 'claude-sonnet-4-6',
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

// Cancel price targets that are now obsolete after an auto trade execution.
// e.g. a sell rule fired at $2.00 — any 'up' target at or below $2.00 is now moot.
// e.g. a buy rule fired at $1.80 — any 'down' target at or above $1.80 is now moot.
async function cancelObsoleteTargets(symbol, executedPrice, action) {
  try {
    const arr = priceTargets.get(symbol);
    if (!arr || !Array.isArray(arr) || arr.length === 0) return;

    const obsolete = arr.filter(t => {
      const dir = t.direction || 'up';
      if (action === 'sell' && dir === 'up' && t.targetPrice <= executedPrice) return true;
      if (action === 'buy'  && dir === 'down' && t.targetPrice >= executedPrice) return true;
      return false;
    });
    if (obsolete.length === 0) return;

    const remaining = arr.filter(t => !obsolete.includes(t));
    if (remaining.length > 0) {
      priceTargets.set(symbol, remaining);
    } else {
      priceTargets.delete(symbol);
      targetReminderCount.delete(symbol);
      if (activeFixedAlerts.has(symbol)) {
        clearInterval(activeFixedAlerts.get(symbol));
        activeFixedAlerts.delete(symbol);
      }
    }

    const coinBase = symbol.replace('-USD', '');
    for (const t of obsolete) {
      const dir = t.direction || 'up';
      console.log(`[targets] Cancelling obsolete ${dir} target for ${symbol} — target ${t.targetPrice}, exec ${executedPrice}, action ${action}`);
      if (t.id !== undefined && t.id !== null) {
        await db.execute('DELETE FROM price_targets WHERE id = ?', [t.id]).catch(e => console.error('[targets] Delete failed:', e.message));
      } else {
        await db.execute('DELETE FROM price_targets WHERE symbol = ? AND ABS(target_price - ?) < 0.000000001', [symbol, t.targetPrice]).catch(e => console.error('[targets] Delete failed:', e.message));
      }
      await sendTelegram(`🗑️ <b>Target auto-cancelled: ${coinBase}</b>\nObsolete after ${action} executed at ${formatPrice(executedPrice)} — target was ${formatPrice(t.targetPrice)} (${dir})`).catch(() => {});
    }
  } catch (e) {
    console.error('[targets] cancelObsoleteTargets error:', e.message);
  }
}

async function cascadeRulesAfterTrade(rule, executedPrice) {
  try {
    const symbol   = rule.symbol;
    const coinBase = symbol.replace('-USD', '');
    const MAX_SELL = 3;
    const MAX_BUY  = 3;
    const PROX_PCT = 0.02; // 2% proximity — skip if similar rule exists

    const isSell = rule.order_type === 'sell' && rule.rule_type !== 'stop_loss';
    const isBuy  = rule.order_type === 'buy';
    if (!isSell && !isBuy) return; // never cascade stop_loss

    let newSellPrice, newBuyPrice, cascadeMsg;

    if (isSell) {
      newSellPrice = executedPrice * 1.10; // 10% higher — ride the trend
      newBuyPrice  = executedPrice * 0.92; // 8% retrace — buy back on dip
      cascadeMsg = `🔁 CASCADE — ${coinBase}\nNext sell: ${formatPrice(newSellPrice)} / Buy-back: ${formatPrice(newBuyPrice)}`;
    } else {
      newBuyPrice  = executedPrice * 0.95; // 5% deeper — add on continued dip
      newSellPrice = executedPrice * 1.08; // 8% bounce — sell the recovery
      cascadeMsg = `🔁 CASCADE — ${coinBase}\nNext sell: ${formatPrice(newSellPrice)} / Buy-back: ${formatPrice(newBuyPrice)}`;
    }

    // Fetch current active rules for this symbol
    const [allRules] = await db.execute('SELECT * FROM auto_trade_rules WHERE symbol = ? AND active = 1', [symbol]);
    let sellRules = allRules.filter(r => r.order_type === 'sell' && r.rule_type !== 'stop_loss');
    let buyRules  = allRules.filter(r => r.order_type === 'buy');

    // Check proximity: true if a rule already exists within PROX_PCT of target
    const nearExists = (ruleSet, targetPrice) =>
      ruleSet.some(r => Math.abs(parseFloat(r.trigger_price) - targetPrice) / targetPrice < PROX_PCT);

    // Enforce max: if at limit, remove the oldest rule to make room
    const enforceMax = async (ruleSet, maxCount, label) => {
      if (ruleSet.length >= maxCount) {
        const oldest = ruleSet.reduce((a, b) => a.id < b.id ? a : b);
        await db.execute('DELETE FROM auto_trade_rules WHERE id = ?', [oldest.id]);
        console.log(`[cascade] Removed oldest ${label} rule id=${oldest.id} to stay within max ${maxCount}`);
        return ruleSet.filter(r => r.id !== oldest.id);
      }
      return ruleSet;
    };

    let created = false;

    // Inherit volume, volume_type, exchange, and cascade tracking from triggering rule
    const cascadeVol          = rule.volume;
    const cascadeVolType      = rule.volume_type || 'fixed';
    const cascadeExchange     = rule.exchange || 'kraken';
    const parentCascadeCount  = parseInt(rule.cascade_count || 0);
    const maxCascades         = parseInt(rule.max_cascades  || 3);

    // When a sell fires — reset cascade count on all downstream rules (price went up, ladder worked)
    if (isSell) {
      await db.execute(
        'UPDATE auto_trade_rules SET cascade_count = 0 WHERE cascade_parent_id = ?',
        [rule.id]
      ).catch(() => {});
    }

    // Create cascaded sell rule
    if (!nearExists(sellRules, newSellPrice)) {
      sellRules = await enforceMax(sellRules, MAX_SELL, 'sell');
      await db.execute(
        'INSERT INTO auto_trade_rules (symbol, rule_type, trigger_price, direction, order_type, volume, volume_type, source, exchange, cascade_count, max_cascades, cascade_parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [symbol, 'sell_pump', newSellPrice, 'above', 'sell', cascadeVol, cascadeVolType, 'cascade', cascadeExchange, 0, maxCascades, rule.id]
      );
      console.log(`[cascade] Created sell_pump @ $${newSellPrice.toFixed(6)} for ${symbol}`);
      created = true;
    } else {
      console.log(`[cascade] Sell rule near $${newSellPrice.toFixed(6)} already exists — skipped`);
    }

    // Create cascaded buy-back rule (sell path: ringfenced proceeds + cascade limit + entry price guard)
    if (isSell) {
      // Calculate ringfenced proceeds — subtract any USDT sweep so we don't double-count
      let sweepEnabled = false;
      let sweepPct = 0;
      try {
        const [sweepRows] = await db.execute("SELECT config_value FROM system_config WHERE config_key = 'usdt_sweep_config'");
        if (sweepRows.length) {
          const cfg = JSON.parse(sweepRows[0].config_value);
          sweepEnabled = cfg.enabled === true;
          sweepPct = cfg.sweep_pct || 0;
        }
      } catch (e) { /* ignore — default false */ }

      const sellProceeds = executedPrice * parseFloat(cascadeVol);
      const sweepDeduction = sweepEnabled ? sellProceeds * (sweepPct / 100) : 0;
      const availableForBuyback = sellProceeds - sweepDeduction;

      if (nearExists(buyRules, newBuyPrice)) {
        console.log(`[cascade] Buy rule near $${newBuyPrice.toFixed(6)} already exists — skipped`);
      } else {
        // Guard: don't buy back below 95% of entry price
        const entryPrice = entryPrices.get(symbol);
        if (entryPrice && newBuyPrice < entryPrice * 0.95) {
          console.log(`[cascade] Buy-back at $${newBuyPrice.toFixed(6)} is below entry $${entryPrice.toFixed(6)} — skipping to avoid buying below cost`);
          await sendTelegram(
            `⚠️ <b>CASCADE BUY SKIPPED — ${coinBase}</b>\n\n` +
            `Buy-back at $${newBuyPrice.toFixed(6)} is below\n` +
            `your entry price $${entryPrice.toFixed(6)}.\n` +
            `Not buying below cost basis.\n` +
            `Stop loss still protecting position.`
          ).catch(() => {});
        } else {
          buyRules = await enforceMax(buyRules, MAX_BUY, 'buy');
          await db.execute(
            'INSERT INTO auto_trade_rules (symbol, rule_type, trigger_price, direction, order_type, volume, volume_type, source, exchange, cascade_count, max_cascades, cascade_parent_id, proceeds_reserved) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [symbol, 'buy_retrace', newBuyPrice, 'below', 'buy', cascadeVol, cascadeVolType, 'cascade', cascadeExchange, 0, maxCascades, rule.id, availableForBuyback]
          );
          console.log(`[cascade] Buy-back created @ $${newBuyPrice.toFixed(6)} with $${availableForBuyback.toFixed(2)} ringfenced from sell proceeds`);
          created = true;
        }
      }

    } else if (isBuy) {
      // After a buy fires: cascade deeper — but respect the cascade limit
      if (parentCascadeCount >= maxCascades) {
        console.log(`[cascade] Max cascade buys (${maxCascades}) reached for ${symbol} — stopping runaway downside buying`);
        await sendTelegram(
          `⚠️ <b>CASCADE LIMIT REACHED — ${coinBase}</b>\n\n` +
          `${maxCascades} consecutive buy-backs fired without a sell.\n` +
          `Stopping cascade buys — stop loss still active.\n` +
          `Review position manually.`
        ).catch(() => {});
      } else if (!nearExists(buyRules, newBuyPrice)) {
        // Entry price guard for deeper dip buys too
        const entryPrice = entryPrices.get(symbol);
        if (entryPrice && newBuyPrice < entryPrice * 0.95) {
          console.log(`[cascade] Deeper dip buy at $${newBuyPrice.toFixed(6)} is below entry $${entryPrice.toFixed(6)} — skipping`);
          await sendTelegram(
            `⚠️ <b>CASCADE BUY SKIPPED — ${coinBase}</b>\n\n` +
            `Deeper dip buy at $${newBuyPrice.toFixed(6)} is below\n` +
            `your entry price $${entryPrice.toFixed(6)}.\n` +
            `Not buying below cost basis.`
          ).catch(() => {});
        } else {
          buyRules = await enforceMax(buyRules, MAX_BUY, 'buy');
          const newCascadeCount = parentCascadeCount + 1;
          await db.execute(
            'INSERT INTO auto_trade_rules (symbol, rule_type, trigger_price, direction, order_type, volume, volume_type, source, exchange, cascade_count, max_cascades, cascade_parent_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [symbol, 'buy_dip', newBuyPrice, 'below', 'buy', cascadeVol, cascadeVolType, 'cascade', cascadeExchange, newCascadeCount, maxCascades, rule.id]
          );
          console.log(`[cascade] Created buy_dip @ $${newBuyPrice.toFixed(6)} for ${symbol} (cascade ${newCascadeCount}/${maxCascades})`);
          created = true;
        }
      } else {
        console.log(`[cascade] Buy rule near $${newBuyPrice.toFixed(6)} already exists — skipped`);
      }
    }

    if (created) await sendTelegram(cascadeMsg);

  } catch (e) {
    console.error('[cascade] cascadeRulesAfterTrade error:', e.message);
  }
}

// Returns available USD/USDT cash on a given exchange
async function getAvailableUSD(exchange) {
  try {
    if (exchange === 'revolut') {
      const balances = await revolutRequest('GET', '/balances');
      const usd = balances.find(b => b.currency === 'USD' || b.currency === 'USDT');
      return parseFloat(usd?.available || 0);
    } else {
      const krakenData = await getKrakenBalances();
      return krakenData.usdCash || 0;
    }
  } catch (e) {
    console.error('[cash] getAvailableUSD error:', e.message);
    return 0;
  }
}

// ── Historical cost basis (cash-flow method) ──────────────────────────────────
// Formula: (total cash ever put in − cash received back) / current tokens held
// Unlike simple average entry, this survives full sells and buybacks correctly.
async function getHistoricalCostBasis(symbol) {
  try {
    const coinBase = symbol.replace('-USD', '');
    const [flows] = await db.execute(
      `SELECT flow_type, SUM(cash_amount) as total_cash, SUM(token_quantity) as total_tokens
       FROM coin_cash_flows WHERE symbol = ? GROUP BY flow_type`,
      [coinBase]
    );
    let totalCashIn = 0, totalCashOut = 0;
    for (const f of flows) {
      if (f.flow_type === 'buy')  totalCashIn  = parseFloat(f.total_cash);
      if (f.flow_type === 'sell') totalCashOut = parseFloat(f.total_cash);
    }
    if (totalCashIn <= 0) return null;
    const currentQty = parseFloat(previousBalances.get(symbol) || 0);
    if (currentQty <= 0) return null;
    const netDeployed = totalCashIn - totalCashOut;
    const historicalBasis = netDeployed / currentQty;
    return { historical_basis: historicalBasis, total_cash_in: totalCashIn, total_cash_out: totalCashOut, net_deployed: netDeployed, current_qty: currentQty };
  } catch (e) {
    console.error('[basis] getHistoricalCostBasis error:', e.message);
    return null;
  }
}

// ── Entry price + cost basis tracker ─────────────────────────────────────────
// Preserves the original cost basis (original_entry_price) across sell→buyback cycles.
// isCycleBuyback=true increments cycle_count and sends a Telegram cycle summary.
async function updateEntryPrice(symbol, newPrice, isCycleBuyback = false) {
  try {
    const coinBase = symbol.replace('-USD', '');
    const [existing] = await db.execute(
      'SELECT entry_price, original_entry_price, cycle_count FROM entry_prices WHERE symbol = ?',
      [symbol]
    );

    if (existing.length === 0) {
      // First time — set both current and original
      await db.execute(
        `INSERT INTO entry_prices (symbol, entry_price, original_entry_price, original_entry_date, cycle_count)
         VALUES (?, ?, ?, NOW(), 0)`,
        [symbol, newPrice, newPrice]
      );
      entryPrices.set(symbol, newPrice);
      console.log(`[entry] ${symbol} first entry set: $${newPrice} (original & cycle both = $${newPrice})`);
      return;
    }

    const row = existing[0];
    const originalEntry = parseFloat(row.original_entry_price || row.entry_price);
    const newCycleCount = isCycleBuyback
      ? (parseInt(row.cycle_count) || 0) + 1
      : (parseInt(row.cycle_count) || 0);

    await db.execute(
      `UPDATE entry_prices SET
         entry_price          = ?,
         original_entry_price = COALESCE(original_entry_price, ?),
         cycle_count          = ?
       WHERE symbol = ?`,
      [newPrice, originalEntry, newCycleCount, symbol]
    );
    entryPrices.set(symbol, newPrice);

    console.log(`[entry] ${symbol} updated: cycle=$${newPrice.toFixed(6)} | original=$${originalEntry.toFixed(6)} | cycles=${newCycleCount}`);

    if (isCycleBuyback) {
      const recoveryNeeded = ((originalEntry / newPrice - 1) * 100).toFixed(1);
      const nextSellTarget  = (newPrice * 1.055).toFixed(6);
      await sendTelegram(
        `🔄 <b>CYCLE COMPLETE — ${coinBase}</b>\n\n` +
        `Cycles completed: ${newCycleCount}\n` +
        `New cycle entry: $${newPrice.toFixed(6)}\n` +
        `Cost basis: $${originalEntry.toFixed(6)}\n` +
        `Recovery needed: ${recoveryNeeded}%\n\n` +
        `Next sell target: $${nextSellTarget}`
      ).catch(() => {});
    }
  } catch (e) {
    console.error('[entry] updateEntryPrice error:', e.message);
    // Fallback: at minimum update in-memory cache so alerts keep working
    entryPrices.set(symbol, newPrice);
  }
}

// ── Exchange entry-price sync ─────────────────────────────────────────────────
// Queries the exchange for actual cost basis data and stores it.
// Returns the verified price, or null if the exchange has no data.

async function syncEntryPriceFromRevolutX(symbol) {
  try {
    const coinBase = symbol.replace('-USD', '');
    const positions = await revolutRequest('GET', '/balances');
    const asset = positions.find(b => b.currency === coinBase);
    if (!asset) {
      console.log(`[entry-sync] ${coinBase} not found in Revolut X balances`);
      return null;
    }

    // Check every field Revolut X might expose for cost basis
    const avgCost = asset.average_cost || asset.avg_cost ||
                    asset.cost_basis   || asset.average_entry ||
                    asset.avg_entry    || asset.average_buy_price;

    if (avgCost && parseFloat(avgCost) > 0) {
      const price = parseFloat(avgCost);
      console.log(`[entry-sync] ${coinBase} avg entry from Revolut X API: $${price}`);
      await updateEntryPrice(symbol, price, false);
      return price;
    }

    // Fallback: derive from total_cost / quantity if available
    const qty       = parseFloat(asset.available || 0);
    const totalCost = parseFloat(asset.total_cost || asset.book_cost || 0);
    if (qty > 0 && totalCost > 0) {
      const calculatedAvg = totalCost / qty;
      console.log(`[entry-sync] ${coinBase} calculated avg from cost/qty: $${calculatedAvg.toFixed(6)}`);
      await updateEntryPrice(symbol, calculatedAvg, false);
      return calculatedAvg;
    }

    console.log(`[entry-sync] ${coinBase} — Revolut X has no cost basis fields`);
    return null;
  } catch (e) {
    console.error('[entry-sync] Revolut X sync error:', e.message);
    return null;
  }
}

async function syncEntryPriceFromKraken(symbol) {
  try {
    const coinBase = symbol.replace('-USD', '');
    const tradesHistory = await krakenRequest('/0/private/TradesHistory', {});
    if (tradesHistory.error?.length > 0) {
      console.error('[entry-sync] Kraken TradesHistory error:', tradesHistory.error);
      return null;
    }

    const trades = Object.values(tradesHistory.result?.trades || {});
    const assetTrades = trades.filter(t => {
      const pair = (t.pair || '').toUpperCase();
      return pair.includes(coinBase.toUpperCase()) || pair.includes(coinBase.toUpperCase() + 'USD');
    });

    if (assetTrades.length === 0) {
      console.log(`[entry-sync] No Kraken trades found for ${coinBase}`);
      return null;
    }

    // Weighted-average FIFO from trade history
    let totalQty = 0, totalCost = 0;
    assetTrades.sort((a, b) => a.time - b.time);
    for (const trade of assetTrades) {
      const qty   = parseFloat(trade.vol);
      const price = parseFloat(trade.price);
      if (trade.type === 'buy') {
        totalCost += qty * price;
        totalQty  += qty;
      } else if (trade.type === 'sell' && totalQty > 0) {
        const avgCost = totalCost / totalQty;
        totalCost -= qty * avgCost;
        totalQty  -= qty;
        if (totalQty < 0) { totalCost = 0; totalQty = 0; }
      }
    }

    if (totalQty > 0) {
      const avgEntry = totalCost / totalQty;
      console.log(`[entry-sync] ${coinBase} avg entry from Kraken history: $${avgEntry.toFixed(6)}`);
      await updateEntryPrice(symbol, avgEntry, false);
      return avgEntry;
    }

    return null;
  } catch (e) {
    console.error('[entry-sync] Kraken sync error:', e.message);
    return null;
  }
}

// ── Claude Auto-Analysis on Alerts ───────────────────────────────────────────

async function analyseTrailingStopAlert(symbol, currentPrice, peakPrice, trailPct, stopPrice, exchange = 'revolut') {
  const coinBase = symbol.replace('-USD', '');
  const ONE_HOUR = 60 * 60 * 1000;

  // FIX 4: Check global API rate-limit cooldown (set when a 429 is received)
  const apiRateLimited = analysisRateLimit.get('api_rate_limited');
  if (apiRateLimited && Date.now() - apiRateLimited < 60 * 1000) {
    console.log(`[analysis] Global API rate-limit cooldown active — skipping ${coinBase}`);
    await sendTelegram(
      `⚠️ <b>ANALYSIS SKIPPED — ${coinBase}</b>\n` +
      `Claude API rate-limit cooldown active (60s).\nCheck position manually.`
    ).catch(() => {});
    return;
  }

  const lastAnalysis = analysisRateLimit.get(symbol);
  if (lastAnalysis && Date.now() - lastAnalysis < ONE_HOUR) {
    console.log(`[analysis] Rate limited — ${symbol} analysed ${Math.round((Date.now()-lastAnalysis)/60000)}min ago`);
    return;
  }
  analysisRateLimit.set(symbol, Date.now());

  console.log(`[analysis] Starting Claude analysis for ${coinBase}`);
  console.log(`[analysis] Price: $${currentPrice}, Peak: $${peakPrice}, Drop: -${((peakPrice-currentPrice)/peakPrice*100).toFixed(1)}%, Exchange: ${exchange}`);

  try {
    const entryPrice = entryPrices.get(symbol);
    const plPct = entryPrice ? ((currentPrice - entryPrice) / entryPrice * 100) : null;
    const dropFromPeak = ((peakPrice - currentPrice) / peakPrice * 100);

    const [recentTrades] = await db.execute(
      `SELECT action, price, quantity, value_usd, reasoning, emotion, outcome_pnl, created_at
       FROM trading_journal
       WHERE symbol = ? AND action NOT IN ('payment','transfer')
       ORDER BY created_at DESC LIMIT 5`,
      [coinBase]
    ).catch(e => { console.error('[analysis] recentTrades query failed:', e.message); return [[]]; });

    const [activeRules] = await db.execute(
      `SELECT rule_type, trigger_price, order_type, volume, volume_type
       FROM auto_trade_rules WHERE symbol = ? AND active = 1`,
      [symbol]
    ).catch(e => { console.error('[analysis] activeRules query failed:', e.message); return [[]]; });

    const [traderPrefs] = await db.execute(
      `SELECT preference_key, preference_value FROM trader_profile
       WHERE preference_key IN ('trading_strategy','core_principles','mss_definition','moon_bag_rule','risk_tolerance')`
    ).catch(e => { console.error('[analysis] traderPrefs query failed:', e.message); return [[]]; });

    const journalContext = recentTrades.length > 0
      ? recentTrades.map(t => {
          const date = new Date(t.created_at).toLocaleDateString('en-GB');
          const pnl = t.outcome_pnl ? ` | P&L: ${parseFloat(t.outcome_pnl) > 0 ? '+' : ''}$${parseFloat(t.outcome_pnl).toFixed(2)}` : '';
          return `${date}: ${t.action.toUpperCase()} @ $${parseFloat(t.price).toFixed(6)}${t.quantity ? ' (' + parseFloat(t.quantity).toFixed(2) + ' tokens)' : ''}${pnl}\n  Reason: ${t.reasoning || 'none'} | Emotion: ${t.emotion || 'unknown'}`;
        }).join('\n')
      : 'No recent trades';

    const rulesContext = activeRules.length > 0
      ? activeRules.map(r => `${r.rule_type}: ${r.order_type} ${r.volume}${r.volume_type === 'pct' ? '%' : ''} @ $${parseFloat(r.trigger_price).toFixed(6)}`).join('\n')
      : 'No active rules';

    const prefsContext = traderPrefs.map(p => `${p.preference_key}: ${p.preference_value}`).join('\n');

    const staticSystemPrompt =
`You are a disciplined swing trader's AI assistant, analysing trailing stop alerts.

## TRADING STRATEGY (STATIC)
Strategy: Extreme move swing trader — buys dips, sells pumps on macro moves
Principles: Trend is friend, trailing stops protect gains, ladder out on MSS, never sell 100%
MSS definition: Price breaks previous Higher Low after failing to make new Higher High
Moon bag rule: Always keep 25% of position — never sell everything

## YOUR ANALYSIS TASK
1. Is this a genuine Market Structure Shift or normal consolidation/pullback?
2. Does the trade history suggest this coin is in a profitable trend worth holding?
3. What does the drop size tell you — panic selling or healthy retracement?
4. Considering the active auto rules, what manual action if any is needed?

Respond in exactly this format:
RECOMMENDATION: [SELL 25% / HOLD / RESET STOP / BUY MORE / SELL ALL]
REASON: [one clear sentence referencing the trade history]
WATCH: [$price — what to monitor next]
CONFIDENCE: [High/Medium/Low]
CONTEXT: [one sentence on what the journal history tells you]`;

    const dynamicUserMessage =
`## TRADER PROFILE (from DB)
${prefsContext || 'No preferences stored — use strategy defaults above'}

## CURRENT ALERT — ${coinBase}
Exchange: ${exchange === 'kraken' ? 'Kraken' : 'Revolut X'}
Current price: $${currentPrice.toFixed(6)}
Peak price: $${peakPrice.toFixed(6)}
Drop from peak: -${dropFromPeak.toFixed(1)}%
Trailing stop: ${trailPct}%
Stop level: $${stopPrice.toFixed(6)}
Entry price: ${entryPrice ? '$' + entryPrice.toFixed(6) : 'unknown'}
P&L from entry: ${plPct !== null ? (plPct > 0 ? '+' : '') + plPct.toFixed(1) + '%' : 'unknown'}

## LAST 5 TRADES FOR ${coinBase}
${journalContext}

## ACTIVE AUTO RULES FOR ${coinBase}
${rulesContext}`;

    console.log(`[analysis] Calling Claude API (30s timeout)...`);

    // 30-second timeout via Promise.race
    const claudeCall = anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 400,
      system: [{ type: 'text', text: staticSystemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: dynamicUserMessage }]
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Claude API timeout after 30s')), 30000)
    );
    const msg = await Promise.race([claudeCall, timeoutPromise]);

    console.log(`[analysis] Claude API responded — usage: in=${msg.usage?.input_tokens} out=${msg.usage?.output_tokens} cache_read=${msg.usage?.cache_read_input_tokens || 0} cache_write=${msg.usage?.cache_creation_input_tokens || 0}`);
    console.log(`[cache] trailing stop (${coinBase}): read=${msg.usage?.cache_read_input_tokens || 0} write=${msg.usage?.cache_creation_input_tokens || 0} uncached=${msg.usage?.input_tokens || 0}`);
    await logClaudeCall(`trailing stop analysis (${coinBase})`, msg.model || 'claude-sonnet-4-6', msg.usage);

    const analysis = msg.content?.[0]?.text;
    if (!analysis) throw new Error(`Claude returned empty content: ${JSON.stringify(msg.content)}`);
    console.log(`[analysis] Analysis received: ${analysis.substring(0, 120)}`);

    const recMatch = analysis.match(/RECOMMENDATION:\s*(.+)/i);
    const recommendation = recMatch ? recMatch[1].trim().toUpperCase() : 'REVIEW NEEDED';
    const confMatch = analysis.match(/CONFIDENCE:\s*(High|Medium|Low)/i);
    const confidence = confMatch ? confMatch[1] : 'Low';

    // Check auto-execute config
    const [autoExecRows] = await db.execute(
      "SELECT config_value FROM system_config WHERE config_key = 'ai_auto_execute'"
    ).catch(() => [[]]);
    const autoExec = autoExecRows.length ? JSON.parse(autoExecRows[0].config_value) : { enabled: false };
    console.log('[auto-exec] Config loaded:', JSON.stringify(autoExec));

    // HODL check — these coins always go to manual review regardless of confidence
    const isHodlCoin = (autoExec.hodl_symbols || []).includes(coinBase);
    if (isHodlCoin) {
      console.log(`[auto-exec] ${coinBase} is a HODL coin — analysis only, no auto-execute`);
      pendingAnalysis.set(symbol, { type: 'trailing_stop', recommendation, analysis, price: currentPrice, timestamp: Date.now() });
      alertContextBySymbol.set(coinBase.toLowerCase(), { symbol, coinBase, alertType: 'claude_analysis_trailing', timestamp: Date.now() });
      lastAlertCoin = coinBase.toLowerCase();
      await sendTelegram(
        `🧠 <b>AI ANALYSIS — ${coinBase}</b>\n\n` +
        `${analysis}\n\n` +
        `⚠️ HODL position — your decision only\n\n` +
        `─────────────────\n` +
        `<b>1</b> Sell  <b>2</b> Hold  <b>3</b> Wait  <b>4</b> Buy  <b>5</b> Dismiss\n` +
        `💬 Reply number or '<b>${coinBase.toLowerCase()} 2</b>' to target this coin`
      );
      return;
    }

    // Manual-only check — these coins run analysis but NEVER auto-execute; always go to Telegram
    const isManualOnly = (autoExec.manual_only_symbols || []).includes(coinBase);
    if (isManualOnly) {
      console.log(`[auto-exec] ${coinBase} is manual-only — sending analysis to Telegram, skipping auto-execute`);
      pendingAnalysis.set(symbol, { type: 'trailing_stop', recommendation, analysis, price: currentPrice, timestamp: Date.now() });
      alertContextBySymbol.set(coinBase.toLowerCase(), { symbol, coinBase, alertType: 'claude_analysis_trailing', timestamp: Date.now() });
      lastAlertCoin = coinBase.toLowerCase();
      await sendTelegram(
        `🧠 <b>AI ANALYSIS — ${coinBase}</b>\n\n` +
        `${analysis}\n\n` +
        `⚠️ Manual-only position — your decision only\n\n` +
        `─────────────────\n` +
        `<b>1</b> Sell  <b>2</b> Hold  <b>3</b> Wait  <b>4</b> Buy  <b>5</b> Dismiss\n` +
        `💬 Reply number or '<b>${coinBase.toLowerCase()} 2</b>' to target this coin`
      );
      return;
    }

    const shouldAutoExecute =
      autoExec.enabled &&
      autoExec.allowed_triggers?.includes('trailing_stop') &&
      confidence === autoExec.require_confidence &&
      (recommendation.includes('SELL') || recommendation.includes('HOLD'));

    if (shouldAutoExecute) {
      const lastExec = analysisRateLimit.get(symbol + '_executed');
      const cooldownMs = (autoExec.cooldown_minutes || 60) * 60 * 1000;
      if (lastExec && Date.now() - lastExec < cooldownMs) {
        await sendTelegram(
          `🤖 <b>AUTO-EXEC COOLDOWN — ${coinBase}</b>\n` +
          `Last execution ${Math.round((Date.now()-lastExec)/60000)}min ago\n` +
          `Waiting ${autoExec.cooldown_minutes}min between executions\n\n${analysis}`
        );
      } else {
        analysisRateLimit.set(symbol + '_executed', Date.now());
        if (recommendation.includes('SELL')) {
          if (exchange === 'kraken') {
            await autoExecuteKrakenSell(symbol, autoExec.max_sell_pct || 25, analysis, confidence);
          } else {
            await autoExecuteSell(symbol, autoExec.max_sell_pct || 25, analysis, confidence);
          }
        } else {
          await autoResetTrailingStop(symbol);
        }
      }
    } else {
      pendingAnalysis.set(symbol, { type: 'trailing_stop', recommendation, analysis, price: currentPrice, timestamp: Date.now() });
      alertContextBySymbol.set(coinBase.toLowerCase(), { symbol, coinBase, alertType: 'claude_analysis_trailing', timestamp: Date.now() });
      lastAlertCoin = coinBase.toLowerCase();
      await sendTelegram(
        `🧠 <b>AI ANALYSIS — ${coinBase}</b>\n\n` +
        `${analysis}\n\n` +
        `─────────────────\n` +
        `<b>1</b> Sell  <b>2</b> Hold  <b>3</b> Wait  <b>4</b> Buy  <b>5</b> Dismiss\n` +
        `💬 Reply number or '<b>${coinBase.toLowerCase()} 2</b>' to target this coin`
      );
      console.log(`[analysis] Analysis sent to Telegram for ${coinBase} ✅`);
    }

  } catch (e) {
    // FIX 4: flag 429s so subsequent calls back off
    if (e.status === 429 || e.message?.includes('429')) {
      analysisRateLimit.set('api_rate_limited', Date.now());
      console.error(`[analysis] Claude API rate limit (429) — 60s cooldown set`);
    }
    console.error(`[analysis] FAILED for ${coinBase}: ${e.message}`);
    console.error(`[analysis] Stack: ${e.stack?.split('\n').slice(0,3).join(' | ')}`);

    // Never silent-fail — always notify via Telegram
    try {
      await sendTelegram(
        `⚠️ <b>ANALYSIS FAILED — ${coinBase}</b>\n\n` +
        `Trailing stop triggered but Claude analysis could not complete.\n\n` +
        `Error: ${e.message.substring(0, 120)}\n\n` +
        `Manual review recommended.\n\n` +
        `1️⃣ Sell now (manual)\n` +
        `2️⃣ Hold — reset stop\n` +
        `5️⃣ Dismiss`
      );
    } catch (tgErr) {
      console.error('[analysis] Telegram fallback also failed:', tgErr.message);
    }
  }
}

async function analyseFixedTargetAlert(symbol, currentPrice, target) {
  const coinBase = symbol.replace('-USD', '');
  const ONE_HOUR = 60 * 60 * 1000;

  // FIX 4: Check global API rate-limit cooldown
  const apiRateLimited = analysisRateLimit.get('api_rate_limited');
  if (apiRateLimited && Date.now() - apiRateLimited < 60 * 1000) {
    console.log(`[analysis] Global API rate-limit cooldown active — skipping ${coinBase} target`);
    await sendTelegram(
      `⚠️ <b>ANALYSIS SKIPPED — ${coinBase}</b>\n` +
      `Claude API rate-limit cooldown active (60s).\nCheck position manually.`
    ).catch(() => {});
    return;
  }

  const lastAnalysis = analysisRateLimit.get(symbol);
  if (lastAnalysis && Date.now() - lastAnalysis < ONE_HOUR) {
    console.log(`[analysis] Rate limited — ${symbol} analysed ${Math.round((Date.now()-lastAnalysis)/60000)}min ago`);
    return;
  }
  analysisRateLimit.set(symbol, Date.now());

  console.log(`[analysis] Starting fixed target analysis for ${coinBase} — target $${parseFloat(target.targetPrice).toFixed(6)}, current $${currentPrice}`);

  try {
    const entryPrice = entryPrices.get(symbol) || target.entryPrice;

    const [recentTrades] = await db.execute(
      `SELECT action, price, quantity, value_usd, reasoning, emotion, outcome_pnl, created_at
       FROM trading_journal
       WHERE symbol = ? AND action NOT IN ('payment','transfer')
       ORDER BY created_at DESC LIMIT 5`,
      [coinBase]
    ).catch(e => { console.error('[analysis] recentTrades query failed:', e.message); return [[]]; });

    const [traderPrefs] = await db.execute(
      `SELECT preference_key, preference_value FROM trader_profile
       WHERE preference_key IN ('trading_strategy','core_principles','mss_definition','moon_bag_rule','risk_tolerance')`
    ).catch(e => { console.error('[analysis] traderPrefs query failed:', e.message); return [[]]; });

    const journalContext = recentTrades.length > 0
      ? recentTrades.map(t => {
          const date = new Date(t.created_at).toLocaleDateString('en-GB');
          const pnl = t.outcome_pnl ? ` | P&L: ${parseFloat(t.outcome_pnl) > 0 ? '+' : ''}$${parseFloat(t.outcome_pnl).toFixed(2)}` : '';
          return `${date}: ${t.action.toUpperCase()} @ $${parseFloat(t.price).toFixed(6)}${t.quantity ? ' (' + parseFloat(t.quantity).toFixed(2) + ' tokens)' : ''}${pnl}\n  Reason: ${t.reasoning || 'none'} | Emotion: ${t.emotion || 'unknown'}`;
        }).join('\n')
      : 'No recent trades';

    const prefsContext = traderPrefs.map(p => `${p.preference_key}: ${p.preference_value}`).join('\n');

    // #36 A3 — plan-aware: load the coin's SAVED PLAN + role so the rec respects increase/hodl posture
    const { role: csRole } = await getCoinContext(coinBase);
    let planContext = 'No saved plan exists for this coin.';
    let planRoleLine = '';
    try {
      const [csRows] = await db.execute('SELECT status, role, theme, strategy_md FROM coin_strategy WHERE symbol = ? LIMIT 1', [coinBase]);
      if (csRows.length) {
        const cs = csRows[0];
        const md = (cs.strategy_md || '').length > 1200 ? cs.strategy_md.slice(0, 1200) + '\u2026' : (cs.strategy_md || '');
        planContext = `Status: ${cs.status || 'n/a'} | Role: ${cs.role || 'n/a'} | Theme: ${cs.theme || 'n/a'}\nStrategy notes:\n${md || 'none'}`;
        planRoleLine = `${cs.role || ''}`.toLowerCase();
      }
    } catch (e) { console.error('[analysis] coin_strategy read failed:', e.message); }
    // Role gate: increase/accumulation/hodl/anchor/watch coins must NEVER get a SELL/LADDER rec
    const noTrimRole = /increase|accumulat|hodl|anchor|watch|dead|radar/.test(planRoleLine) || csRole === 'hodl' || csRole === 'manual_only';

    // #36 A3 — the SAVED PLAN is the primary authority; generic swing heuristics are secondary and must never override it
    const recMenu = noTrimRole ? '[HOLD / ADD]' : '[SELL / HOLD / LADDER / ADD]';
    const roleGuardrail = noTrimRole
      ? 'This coin is in an INCREASE/HODL/WATCH posture per its saved plan \u2014 it has NO upside trim rungs. NEVER recommend SELL or LADDER on this coin. The only valid recommendations are HOLD or (on a genuine dip to a named add level) ADD.'
      : 'Honour the saved plan: only recommend SELL/LADDER if the current price is at or above a trim/harvest level NAMED in the plan. If no named trim level is in play, default to HOLD.';
    const staticTargetSystemPrompt =
`You are a disciplined swing trader's AI assistant, analysing a price-target alert.

## DECISION RULES (in priority order)
1. The SAVED PLAN for this coin (provided in the user message) is the PRIMARY authority. If the current price maps to a level named in the plan, name that level and quote the planned action.
2. ${roleGuardrail}
3. Suppress action on noise: if the move is small and price is not at a named plan level, recommend HOLD.
4. NEVER invent project fundamentals, partnerships, catalysts, or price levels not present in the saved plan or trade history.
5. Generic swing heuristics ('ladder out on pumps', 'keep 25% moon bag') apply ONLY to coins in a harvest/trim posture \u2014 do NOT apply them to increase/hodl/watch coins.

Respond in exactly this format:
RECOMMENDATION: ${recMenu}
REASON: [one clear sentence grounded in the saved plan and trade history]
NEXT TARGET: [$price from the plan if holding/adding, or 'n/a']
CONFIDENCE: [High/Medium/Low]`;

    const dynamicTargetMessage =
`## SAVED PLAN for ${coinBase} (PRIMARY AUTHORITY)
${planContext}

## TRADER PROFILE (from DB)
${prefsContext || 'No preferences stored — use strategy defaults above'}

## TARGET HIT — ${coinBase}
Direction: ${target.direction}
Target price: $${parseFloat(target.targetPrice).toFixed(6)}
Current price: $${currentPrice.toFixed(6)}
Entry price: ${entryPrice ? '$' + entryPrice.toFixed(6) : 'unknown'}
P&L from entry: ${entryPrice ? ((currentPrice - entryPrice) / entryPrice * 100).toFixed(1) + '%' : 'unknown'}
${target.note ? 'Note: ' + target.note : ''}

## LAST 5 TRADES FOR ${coinBase}
${journalContext}`;

    console.log(`[analysis] Calling Claude API (30s timeout)...`);
    const claudeCall = anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: [{ type: 'text', text: staticTargetSystemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: dynamicTargetMessage }]
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Claude API timeout after 30s')), 30000)
    );
    const msg = await Promise.race([claudeCall, timeoutPromise]);

    console.log(`[analysis] Claude API responded — usage: in=${msg.usage?.input_tokens} out=${msg.usage?.output_tokens} cache_read=${msg.usage?.cache_read_input_tokens || 0} cache_write=${msg.usage?.cache_creation_input_tokens || 0}`);
    console.log(`[cache] fixed target (${coinBase}): read=${msg.usage?.cache_read_input_tokens || 0} write=${msg.usage?.cache_creation_input_tokens || 0} uncached=${msg.usage?.input_tokens || 0}`);
    await logClaudeCall(`fixed target analysis (${coinBase})`, msg.model || 'claude-sonnet-4-6', msg.usage);

    const analysis = msg.content?.[0]?.text;
    if (!analysis) throw new Error(`Claude returned empty content: ${JSON.stringify(msg.content)}`);
    console.log(`[analysis] Fixed target analysis received: ${analysis.substring(0, 120)}`);

    pendingAnalysis.set(symbol, { type: 'fixed_target', analysis, price: currentPrice, timestamp: Date.now() });
    alertContextBySymbol.set(coinBase.toLowerCase(), { symbol, coinBase, alertType: 'claude_analysis_target', timestamp: Date.now() });
    lastAlertCoin = coinBase.toLowerCase();

    await sendTelegram(
      `🧠 <b>AI ANALYSIS — ${coinBase} TARGET HIT</b>\n\n` +
      `${analysis}\n\n` +
      `─────────────────\n` +
      `<b>1</b> Sell  <b>2</b> Hold  <b>3</b> Ladder  <b>4</b> New target  <b>5</b> Dismiss\n` +
      `💬 Reply number or '<b>${coinBase.toLowerCase()} 1</b>' to target this coin`
    );
    console.log(`[analysis] Fixed target analysis sent to Telegram for ${coinBase} ✅`);

  } catch (e) {
    if (e.status === 429 || e.message?.includes('429')) {
      analysisRateLimit.set('api_rate_limited', Date.now());
      console.error(`[analysis] Claude API rate limit (429) — 60s cooldown set`);
    }
    console.error(`[analysis] FAILED for ${coinBase} (fixed target): ${e.message}`);
    console.error(`[analysis] Stack: ${e.stack?.split('\n').slice(0,3).join(' | ')}`);

    try {
      await sendTelegram(
        `⚠️ <b>ANALYSIS FAILED — ${coinBase} TARGET HIT</b>\n\n` +
        `Price target triggered but Claude analysis could not complete.\n\n` +
        `Error: ${e.message.substring(0, 120)}\n\n` +
        `Manual review recommended.\n\n` +
        `1️⃣ Sell now (manual)\n` +
        `5️⃣ Dismiss`
      );
    } catch (tgErr) {
      console.error('[analysis] Telegram fallback also failed:', tgErr.message);
    }
  }
}

async function autoExecuteSell(symbol, maxPct, analysis, confidence) {
  const coinBase = symbol.replace('-USD', '');
  try {
    const currentPrice = await getCurrentPrice(symbol);
    const balancesNow = await revolutRequest('GET', '/balances');
    const asset = balancesNow.find(b => b.currency === coinBase);
    const currentQty = parseFloat(asset?.available || 0);

    if (currentQty <= 0) {
      await sendTelegram(`⚠️ AUTO-EXEC: No ${coinBase} to sell`);
      return;
    }

    const sellQty = currentQty * (maxPct / 100);
    const valueUSD = sellQty * currentPrice;

    // Dust guard: skip if the sell is negligible
    if (sellQty <= 0 || !isFinite(sellQty) || valueUSD < 1) {
      await sendTelegram('⚠️ AUTO-EXEC skipped: ' + coinBase + ' position is dust (qty ' + currentQty + ', sell value $' + (valueUSD || 0).toFixed(4) + '). Nothing to sell.');
      return;
    }

    // #95 Stage 2: HARD ENTRY-FLOOR GUARD — never auto-sell below a pump-armed rule's entry_floor.
    // Governed by dev_decision #3 (never-sell-below-entry). Authoritative source = pump_armed_rules table.
    try {
      const [floorRows] = await db.execute('SELECT entry_floor FROM pump_armed_rules WHERE symbol = ? AND active = 1 LIMIT 1', [symbol]);
      const entryFloor = floorRows.length && floorRows[0].entry_floor != null ? parseFloat(floorRows[0].entry_floor) : null;
      if (entryFloor !== null && currentPrice <= entryFloor) {
        await sendTelegram(
          `🛑 <b>AUTO-SELL BLOCKED — ${coinBase}</b>\n` +
          `Price ${fmtPriceShort(currentPrice)} is at/below entry floor ${fmtPriceShort(entryFloor)}.\n` +
          `Never-sell-below-entry guard held. Position untouched — your call.`
        ).catch(() => {});
        console.log(`[auto-exec] FLOOR GUARD blocked ${coinBase} sell: price ${currentPrice} <= floor ${entryFloor}`);
        return;
      }
    } catch (e) { console.error('[auto-exec] floor guard error (failing safe — blocking sell):', e.message); 
      await sendTelegram(`🛑 AUTO-SELL BLOCKED — ${coinBase}: floor-guard check errored, failing safe (no sell). Manual review.`).catch(() => {});
      return;
    }

    await db.execute(
      `INSERT INTO trade_intentions (symbol, action, reasoning, emotion, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
      [symbol, 'sell', `AI auto-execution [${confidence}]: ${analysis.substring(0, 150)}`, 'confident']
    ).catch(() => {});

    await placeRevolutOrder(symbol, 'sell', 'market', sellQty);

    await db.execute(
      `INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [coinBase, 'sell', currentPrice, sellQty, valueUSD,
       `AI auto-executed [${confidence} confidence]: ${analysis.substring(0, 200)}`,
       'confident', 'ai_auto']
    ).catch(e => console.error('[auto-exec] journal insert:', e.message));

    pendingUndo.set(symbol, { action: 'sell', qty: sellQty, price: currentPrice, timestamp: Date.now() });
    setTimeout(() => pendingUndo.delete(symbol), 2 * 60 * 1000);

    const reasonMatch = analysis.match(/REASON:\s*(.+)/i);
    const reason = reasonMatch ? reasonMatch[1].trim() : 'Trailing stop triggered';
    await sendTelegram(formatAutoExecuteMessage(coinBase, 'sell', sellQty, currentPrice, valueUSD, reason, confidence));
    console.log(`[auto-exec] SELL ${sellQty.toFixed(4)} ${coinBase} @ $${currentPrice.toFixed(4)}`);

    // #95 Stage 3: pump-armed sell → spawn ONE buyback rung (no deeper averaging-down).
    // A buy only ever exists as the back-half of a completed sell. max_cascades:0 stops the rebuy from cascading deeper.
    try {
      const [parRows] = await db.execute('SELECT * FROM pump_armed_rules WHERE symbol = ? AND active = 1 LIMIT 1', [symbol]);
      if (parRows.length) {
        const syntheticRule = {
          id: null,
          symbol,
          order_type: 'sell',
          rule_type: 'sell_pump',
          volume: sellQty,            // buy back the exact quantity just sold
          volume_type: 'fixed',
          exchange: 'revolut',
          cascade_count: 0,
          max_cascades: 0,            // single rebuy only — no deeper cascade buys
        };
        await cascadeRulesAfterTrade(syntheticRule, currentPrice);
        console.log(`[auto-exec] Stage 3 single-rebuy cascade spawned for pump-armed ${coinBase} after sell`);
      }
    } catch (e) { console.error('[auto-exec] Stage 3 cascade error (non-fatal):', e.message); }
  } catch (e) {
    console.error('[auto-exec] sell error:', e.message);
    await sendTelegram(`❌ AUTO-EXEC FAILED — ${coinBase}\nError: ${e.message}\nManual review needed`);
  }
}

async function autoResetTrailingStop(symbol) {
  const coinBase = symbol.replace('-USD', '');
  try {
    const currentPrice = await getCurrentPrice(symbol);
    const ts = trailingStops.get(symbol);
    if (!ts) return;
    await setTrailingStop(symbol, ts.trailPct, currentPrice, ts.entryPrice);
    await sendTelegram(
      `🤖 <b>AI AUTO-RESET — ${coinBase}</b>\n\n` +
      `Trailing stop reset to current price\n` +
      `New peak: $${currentPrice.toFixed(4)}\n` +
      `Stop level: $${(currentPrice * (1 - ts.trailPct / 100)).toFixed(4)}`
    );
    console.log(`[auto-exec] RESET trailing stop ${coinBase} @ $${currentPrice.toFixed(4)}`);
  } catch (e) {
    console.error('[auto-exec] reset trailing stop error:', e.message);
  }
}

// Reusable trailing stop alert handler — works for both Revolut X and Kraken coins
async function handleTrailingStopAlert(symbol, currentPrice, ts, exchange = 'revolut') {
  const coinBase = symbol.replace('-USD', '');
  const dropFromPeak = ((ts.peakPrice - currentPrice) / ts.peakPrice * 100).toFixed(1);
  const entryPrice = ts.entryPrice || entryPrices.get(symbol) || null;
  const plPct = entryPrice ? ((currentPrice - entryPrice) / entryPrice * 100).toFixed(1) : null;
  const stillUp = entryPrice && currentPrice > entryPrice;
  const entryLine = plPct !== null
    ? `Entry: ${fmtPriceShort(entryPrice)} | ${stillUp ? 'Still up: +' + plPct + '% from entry 🟢' : 'P&L: ' + plPct + '% 🔴'}`
    : '';
  const exchLabel = exchange === 'kraken' ? '🦑 Kraken' : '🔄 Revolut X';

  const alertMsg = formatSystemAlert(
    'TRAILING STOP TRIGGERED', coinBase,
    `Exchange: ${exchLabel}\n` +
    `📉 Drop: ${dropFromPeak}% from peak\n` +
    `Peak: ${fmtPriceShort(ts.peakPrice)} → Current: ${fmtPriceShort(currentPrice)}\n` +
    `Trail: ${ts.trailPct}% | Stop: ${fmtPriceShort(ts.stopPrice)}\n` +
    (entryLine ? entryLine + '\n' : '') +
    `\n🧠 Running AI analysis...`
  );

  await sendTelegram(alertMsg);
  alertContextBySymbol.set(coinBase.toLowerCase(), { symbol, coinBase, alertType: 'trailing_stop', timestamp: Date.now() });
  lastAlertCoin = coinBase.toLowerCase();
  await acknowledgeAlert(symbol);
  trailingStopAlerted.set(symbol, Date.now());
  console.log(`[trailing] Stop triggered for ${symbol} @ ${fmtPriceShort(currentPrice)} on ${exchange}`);

  analyseTrailingStopAlert(symbol, currentPrice, ts.peakPrice, ts.trailPct, ts.stopPrice, exchange)
    .catch(e => console.error('[analysis] trailing stop:', e.message));
}

async function autoExecuteKrakenSell(symbol, maxPct, analysis, confidence) {
  const coinBase = symbol.replace('-USD', '');
  try {
    const currentPrice = await getKrakenPriceForSymbol(symbol);
    if (!currentPrice) throw new Error('Could not fetch Kraken price');

    const krakenData = await getKrakenBalances();
    const asset = krakenData.balances.find(b => b.symbol === symbol || b.standard === coinBase);
    const currentQty = parseFloat(asset?.quantity || 0);

    if (currentQty <= 0) {
      await sendTelegram(`⚠️ AUTO-EXEC: No ${coinBase} on Kraken to sell`);
      return;
    }

    const sellQty = currentQty * (maxPct / 100);
    const valueUSD = sellQty * currentPrice;

    // Dust guard: skip if the sell is negligible
    if (sellQty <= 0 || !isFinite(sellQty) || valueUSD < 1) {
      await sendTelegram('⚠️ AUTO-EXEC skipped: ' + coinBase + ' Kraken position is dust (qty ' + currentQty + ', sell value $' + (valueUSD || 0).toFixed(4) + '). Nothing to sell.');
      return;
    }

    // #95 Stage 2: HARD ENTRY-FLOOR GUARD (Kraken path) — never auto-sell below entry_floor.
    // Governed by dev_decision #3 (never-sell-below-entry). Authoritative source = pump_armed_rules table.
    try {
      const [floorRows] = await db.execute('SELECT entry_floor FROM pump_armed_rules WHERE symbol = ? AND active = 1 LIMIT 1', [symbol]);
      const entryFloor = floorRows.length && floorRows[0].entry_floor != null ? parseFloat(floorRows[0].entry_floor) : null;
      if (entryFloor !== null && currentPrice <= entryFloor) {
        await sendTelegram(
          `🛑 <b>AUTO-SELL BLOCKED — ${coinBase} (Kraken)</b>\n` +
          `Price ${fmtPriceShort(currentPrice)} is at/below entry floor ${fmtPriceShort(entryFloor)}.\n` +
          `Never-sell-below-entry guard held. Position untouched — your call.`
        ).catch(() => {});
        console.log(`[auto-exec] FLOOR GUARD blocked Kraken ${coinBase} sell: price ${currentPrice} <= floor ${entryFloor}`);
        return;
      }
    } catch (e) { console.error('[auto-exec] Kraken floor guard error (failing safe — blocking sell):', e.message);
      await sendTelegram(`🛑 AUTO-SELL BLOCKED — Kraken ${coinBase}: floor-guard check errored, failing safe (no sell). Manual review.`).catch(() => {});
      return;
    }

    await db.execute(
      `INSERT INTO trade_intentions (symbol, action, reasoning, emotion, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
      [symbol, 'sell', `AI auto-execution on Kraken [${confidence}]: ${analysis.substring(0, 150)}`, 'confident']
    ).catch(() => {});

    await executeKrakenTrade(symbol, 'sell', 'market', sellQty);

    await db.execute(
      `INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [coinBase, 'sell', currentPrice, sellQty, valueUSD,
       `AI auto-executed on Kraken [${confidence}]: ${analysis.substring(0, 200)}`,
       'confident', 'ai_auto']
    ).catch(e => console.error('[auto-exec] Kraken journal insert:', e.message));

    pendingUndo.set(symbol, { action: 'sell', qty: sellQty, price: currentPrice, exchange: 'kraken', timestamp: Date.now() });
    setTimeout(() => pendingUndo.delete(symbol), 2 * 60 * 1000);

    const reasonMatch = analysis.match(/REASON:\s*(.+)/i);
    const reason = reasonMatch ? reasonMatch[1].trim() : 'Trailing stop triggered (Kraken)';
    await sendTelegram(formatAutoExecuteMessage(coinBase, 'sell', sellQty, currentPrice, valueUSD, reason, confidence));
    console.log(`[auto-exec] Kraken SELL ${sellQty.toFixed(4)} ${coinBase} @ $${currentPrice.toFixed(4)}`);

    // #95 Stage 3: pump-armed Kraken sell → spawn ONE buyback rung (no deeper averaging-down). max_cascades:0.
    try {
      const [parRows] = await db.execute('SELECT * FROM pump_armed_rules WHERE symbol = ? AND active = 1 LIMIT 1', [symbol]);
      if (parRows.length) {
        const syntheticRule = {
          id: null,
          symbol,
          order_type: 'sell',
          rule_type: 'sell_pump',
          volume: sellQty,
          volume_type: 'fixed',
          exchange: 'kraken',
          cascade_count: 0,
          max_cascades: 0,
        };
        await cascadeRulesAfterTrade(syntheticRule, currentPrice);
        console.log(`[auto-exec] Stage 3 single-rebuy cascade spawned for pump-armed ${coinBase} after Kraken sell`);
      }
    } catch (e) { console.error('[auto-exec] Stage 3 Kraken cascade error (non-fatal):', e.message); }
  } catch (e) {
    console.error('[auto-exec] Kraken sell error:', e.message);
    await sendTelegram(`❌ AUTO-EXEC FAILED — Kraken ${coinBase}\nError: ${e.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function checkAutoTradeRules(priceMap) {
  try {
    const [rules] = await db.execute('SELECT * FROM auto_trade_rules WHERE active = 1');
    for (const rule of rules) {
      try {
        // Resolve current price from priceMap or live fetch
        const currentPrice = priceMap[rule.symbol] ||
          priceMap[rule.symbol.replace('-USD', 'USD')] ||
          await getCurrentPrice(rule.symbol).catch(() => null);
        if (!currentPrice) continue;

        // 1-hour cooldown between triggers
        if (rule.last_triggered) {
          const lastTrigger = new Date(rule.last_triggered).getTime();
          if (Date.now() - lastTrigger < 60 * 60 * 1000) continue;
        }

        // Moon bag rules are markers only — never auto-execute
        if (rule.rule_type === 'moon_bag') continue;

        // ── Approach alert: notify when within 2% of trigger ─────────────────
        const triggerPrice = parseFloat(rule.trigger_price);
        const priceDiff = Math.abs(currentPrice - triggerPrice) / triggerPrice;
        const approachAlerted = ruleApproachAlerted.get(rule.id);
        const coinBaseApproach = rule.symbol.replace('-USD', '');

        if (priceDiff < 0.02 && !approachAlerted) {
          ruleApproachAlerted.set(rule.id, Date.now());
          await sendTelegram(
            `⚠️ <b>AUTO RULE APPROACHING — ${coinBaseApproach}</b>\n\n` +
            `Rule: ${rule.rule_type}\n` +
            `Trigger: ${rule.direction} $${triggerPrice.toFixed(6)}\n` +
            `Current: $${currentPrice.toFixed(6)}\n` +
            `Distance: ${(priceDiff * 100).toFixed(2)}% away\n\n` +
            `🤖 Will execute automatically when triggered`
          ).catch(() => {});
        }
        // Reset approach alert when price moves back out beyond 5%
        if (priceDiff > 0.05 && approachAlerted) {
          ruleApproachAlerted.delete(rule.id);
        }
        // ─────────────────────────────────────────────────────────────────────

        const shouldTrigger =
          (rule.direction === 'below' && currentPrice <= rule.trigger_price) ||
          (rule.direction === 'above' && currentPrice >= rule.trigger_price);
        if (!shouldTrigger) continue;

        // Resolve exchange — default to kraken for backward compatibility
        const exchange = (rule.exchange || 'kraken').toLowerCase();

        // Resolve volume — fixed token amount or percentage of current position
        let resolvedVolume = parseFloat(rule.volume);
        if (rule.volume_type === 'pct') {
          try {
            if (exchange === 'revolut') {
              // Revolut: fetch from /balances
              const rBalances = await revolutRequest('GET', '/balances');
              const coinBase_ = rule.symbol.replace('-USD', '');
              const asset = rBalances.find(b => b.currency === coinBase_);
              const currentQty = parseFloat(asset?.available || 0);
              resolvedVolume = currentQty * (parseFloat(rule.volume) / 100);
              console.log(`[auto] ${rule.symbol} (revolut) pct volume: ${rule.volume}% of ${currentQty} = ${resolvedVolume.toFixed(6)}`);
            } else {
              const krakenData = await getKrakenBalances();
              const asset = krakenData.balances.find(
                b => b.symbol === rule.symbol || b.standard === rule.symbol.replace('-USD', '')
              );
              const currentQty = parseFloat(asset?.quantity || asset?.balance || 0);
              resolvedVolume = currentQty * (parseFloat(rule.volume) / 100);
              console.log(`[auto] ${rule.symbol} pct volume: ${rule.volume}% of ${currentQty} = ${resolvedVolume.toFixed(6)}`);
            }
            if (resolvedVolume <= 0) {
              console.log(`[auto] Skipping ${rule.symbol} pct rule — resolved volume is 0`);
              continue;
            }
          } catch (e) {
            console.error('[auto] Pct volume resolution failed:', e.message);
            continue;
          }
        }

        // Max position safety check for buys
        if (rule.order_type === 'buy' && rule.max_position_usd) {
          try {
            if (exchange === 'revolut') {
              const rBalances = await revolutRequest('GET', '/balances');
              const coinBase_ = rule.symbol.replace('-USD', '');
              const asset = rBalances.find(b => b.currency === coinBase_);
              const currentPositionUSD = parseFloat(asset?.available || 0) * currentPrice;
              if (currentPositionUSD >= rule.max_position_usd) {
                console.log(`[auto] Skipping revolut buy — max position reached for ${rule.symbol} ($${currentPositionUSD.toFixed(2)} >= $${rule.max_position_usd})`);
                continue;
              }
            } else {
              const krakenData = await getKrakenBalances();
              const existing = krakenData.balances.find(b => b.symbol === rule.symbol || b.standard === rule.symbol.replace('-USD', ''));
              const currentPositionUSD = existing?.valueUSD || 0;
              if (currentPositionUSD >= rule.max_position_usd) {
                console.log(`[auto] Skipping buy — max position reached for ${rule.symbol} ($${currentPositionUSD.toFixed(2)} >= $${rule.max_position_usd})`);
                continue;
              }
            }
          } catch (e) { console.error('[auto] Max position check error:', e.message); continue; }
        }

        // USD balance check for buys — covers both ringfenced and general paths
        if (rule.order_type === 'buy') {
          const ringfencedUsd = rule.proceeds_reserved ? parseFloat(rule.proceeds_reserved) : 0;
          const coinBase_ = rule.symbol.replace('-USD', '');
          const exchangeLabel_ = exchange === 'revolut' ? 'Revolut X' : 'Kraken';

          if (ringfencedUsd > 0) {
            // Ringfenced path — verify the cash actually exists before committing
            const availableUSD = await getAvailableUSD(exchange);
            const requiredUSD = ringfencedUsd;
            if (availableUSD < requiredUSD) {
              const shortfall = requiredUSD - availableUSD;
              const lastSkipAlert = autoSkipAlerted.get(rule.symbol);
              const oneHour = 60 * 60 * 1000;
              if (availableUSD < 1) {
                console.log(`[cash] ${coinBase_} ringfenced buy-back skipped — zero USD on ${exchangeLabel_}`);
              } else if (!lastSkipAlert || Date.now() - lastSkipAlert > oneHour) {
                autoSkipAlerted.set(rule.symbol, Date.now());
                await sendTelegram(
                  `⚠️ <b>BUY-BACK SKIPPED — ${coinBase_}</b>\n\n` +
                  `Exchange: ${exchangeLabel_}\n` +
                  `Rule: ${rule.rule_type} @ ${formatPrice(parseFloat(rule.trigger_price))}\n` +
                  `Required: $${requiredUSD.toFixed(2)} (ringfenced)\n` +
                  `Available: $${availableUSD.toFixed(2)}\n` +
                  `Shortfall: $${shortfall.toFixed(2)}\n\n` +
                  `💡 Options:\n` +
                  `• Sell another position to free cash\n` +
                  `• Deposit funds to ${exchangeLabel_}\n` +
                  `• Remove rule if no longer needed\n\n` +
                  `Rule ID: ${rule.id} — use 'remove auto rule ${rule.id}' to delete`
                );
              }
              continue;
            }
            resolvedVolume = ringfencedUsd / currentPrice;
            console.log(`[cascade] Using ringfenced $${ringfencedUsd.toFixed(2)} for buy-back of ${rule.symbol} — ${resolvedVolume.toFixed(6)} tokens @ ${formatPrice(currentPrice)}`);
          } else {
            // General balance path
            try {
              const availableUSD = await getAvailableUSD(exchange);
              const requiredUSD = resolvedVolume * currentPrice;
              if (availableUSD < requiredUSD) {
                const shortfall = requiredUSD - availableUSD;
                if (availableUSD < 1) {
                  console.log(`[cash] ${coinBase_} buy skipped — zero USD on ${exchangeLabel_} (silent)`);
                } else {
                  const lastSkipAlert = autoSkipAlerted.get(rule.symbol);
                  const oneHour = 60 * 60 * 1000;
                  if (!lastSkipAlert || Date.now() - lastSkipAlert > oneHour) {
                    autoSkipAlerted.set(rule.symbol, Date.now());
                    await sendTelegram(
                      `⚠️ <b>BUY-BACK SKIPPED — ${coinBase_}</b>\n\n` +
                      `Exchange: ${exchangeLabel_}\n` +
                      `Rule: ${rule.rule_type} @ ${formatPrice(parseFloat(rule.trigger_price))}\n` +
                      `Required: $${requiredUSD.toFixed(2)}\n` +
                      `Available: $${availableUSD.toFixed(2)}\n` +
                      `Shortfall: $${shortfall.toFixed(2)}\n\n` +
                      `💡 Options:\n` +
                      `• Sell another position to free cash\n` +
                      `• Deposit funds to ${exchangeLabel_}\n` +
                      `• Remove rule if no longer needed\n\n` +
                      `Rule ID: ${rule.id} — use 'remove auto rule ${rule.id}' to delete`
                    );
                  } else {
                    console.log(`[cash] Buy skipped (USD low) — alert suppressed, sent ${Math.round((Date.now() - lastSkipAlert) / 60000)}min ago`);
                  }
                }
                continue;
              }
              console.log(`[cash] ${coinBase_} buy: $${availableUSD.toFixed(2)} available, $${requiredUSD.toFixed(2)} required ✅`);
            } catch (e) {
              console.error('[auto] USD balance check error:', e.message);
              continue;
            }
          }
        }

        console.log(`[auto] Executing ${rule.order_type} rule for ${rule.symbol} at $${currentPrice} via ${exchange} (trigger: ${rule.direction} $${rule.trigger_price}, vol: ${resolvedVolume})`);
        const coinBase = rule.symbol.replace('-USD', '');

        try {
          let result, orderId;
          if (exchange === 'revolut') {
            result = await placeRevolutOrder(rule.symbol, rule.order_type, 'market', resolvedVolume, null, null);
            orderId = result?.id || 'unknown';
          } else {
            result = await executeKrakenTrade(rule.symbol, rule.order_type, 'market', resolvedVolume);
            orderId = result?.txid?.[0] || 'unknown';
          }

          await db.execute('UPDATE auto_trade_rules SET last_triggered = NOW() WHERE id = ?', [rule.id]);

          await db.execute(
            'INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            [coinBase, rule.order_type, currentPrice, resolvedVolume, currentPrice * resolvedVolume,
             `Auto-executed: ${rule.rule_type} rule triggered at $${currentPrice}${rule.volume_type === 'pct' ? ` (${rule.volume}% of position)` : ''} via ${exchange}`, 'neutral', 'auto_rule']
          );

          // Fetch USDT sweep config for notification
          let sweepEnabled = false;
          let sweepPct = 0;
          try {
            const [sweepRows] = await db.execute("SELECT config_value FROM system_config WHERE config_key = 'usdt_sweep_config'");
            if (sweepRows.length) {
              const cfg = JSON.parse(sweepRows[0].config_value);
              sweepEnabled = cfg.enabled === true;
              sweepPct = cfg.sweep_pct || 0;
            }
          } catch (e) { /* ignore */ }

          const valueUsd = currentPrice * resolvedVolume;
          const volLabel = rule.volume_type === 'pct' ? ` (${rule.volume}% of position)` : '';
          const sweepLine = (rule.order_type === 'sell' && exchange === 'kraken')
            ? `💰 USDT sweep: ${sweepEnabled ? `${sweepPct}% of proceeds ($${(valueUsd * sweepPct / 100).toFixed(2)})` : 'disabled'}\n`
            : '';

          // Clear approach alert now that rule has fired
          ruleApproachAlerted.delete(rule.id);

          // Fetch remaining cash for post-execution report
          const remainingUSD = await getAvailableUSD(exchange).catch(() => null);
          const exchangeLabel = exchange === 'revolut' ? 'Revolut X' : 'Kraken';
          const cashLine = remainingUSD !== null
            ? `\n💵 Remaining cash: $${remainingUSD.toFixed(2)}${remainingUSD < 20 ? '\n⚠️ Cash running low — consider topping up' : ''}`
            : '';

          // Clear ringfenced reservation if applicable
          const isRingfenced = rule.order_type === 'buy' && rule.proceeds_reserved > 0;
          if (isRingfenced) {
            await db.execute('UPDATE auto_trade_rules SET proceeds_reserved = NULL WHERE id = ?', [rule.id]);
          }

          // One-line execution confirmation
          const exchIcon  = exchange === 'revolut' ? '🔄' : '🦑';
          const tradeIcon = rule.rule_type === 'stop_loss' ? '🛑' : rule.order_type === 'sell' ? '✅' : '🟢';
          const actionTag = rule.rule_type === 'stop_loss'
            ? `STOP LOSS`
            : `AUTO ${rule.order_type.toUpperCase()}`;
          const cashSuffix = remainingUSD !== null && remainingUSD < 20
            ? ` ⚠️ $${remainingUSD.toFixed(0)} cash left`
            : '';
          await sendTelegram(formatSystemAlert(actionTag, coinBase,
            `${tradeIcon} ${formatTradeQty(resolvedVolume)} ${coinBase} @ ${formatPrice(currentPrice)} = $${valueUsd.toFixed(2)} ${exchIcon}\n` +
            `Rule: ${rule.rule_type}${volLabel}${cashSuffix ? '\n' + cashSuffix : ''}`
          ));

          // Part 3: Low cash warning — once per day per exchange after any trade
          if (remainingUSD !== null && remainingUSD < 20) {
            const today = new Date().toDateString();
            const lastLowCashAlert = lowCashAlerted.get(exchange);
            if (lastLowCashAlert !== today) {
              lowCashAlerted.set(exchange, today);
              await sendTelegram(formatSystemAlert('LOW CASH WARNING', exchangeLabel,
                `Balance: $${remainingUSD.toFixed(2)}\n` +
                `Buy-back rules may not execute.\n` +
                `USDT sweep: ${sweepEnabled ? `ON ✅ (${sweepPct}%)` : 'OFF ❌'}`
              )).catch(() => {});
            }
          }

          // Cascade: generate next set of rules based on executed price
          await cascadeRulesAfterTrade(rule, currentPrice);

          // Real-time target cancellation: after a sell fires, wipe 'up' targets at or below executed price
          if (rule.order_type === 'sell') {
            try {
              const [staleTargets] = await db.execute(
                `SELECT * FROM price_targets WHERE symbol = ? AND direction = 'up' AND target_price <= ?`,
                [rule.symbol, currentPrice]
              );
              for (const staleTarget of staleTargets) {
                priceTargets.delete(rule.symbol);
                alertState.acknowledged.add(rule.symbol);
                targetReminderCount.delete(rule.symbol);
                if (activeFixedAlerts.has(rule.symbol)) {
                  clearInterval(activeFixedAlerts.get(rule.symbol));
                  activeFixedAlerts.delete(rule.symbol);
                }
                await db.execute('DELETE FROM price_targets WHERE id = ?', [staleTarget.id]);
                console.log(`[target] Real-time cancel: ${rule.symbol} target $${staleTarget.target_price} — auto rule already fired at $${currentPrice}`);
              }
            } catch (e) { console.error('[target] Real-time sell target cancel failed:', e.message); }
          }

          // Also cancel drop targets if a stop loss fired
          if (rule.rule_type === 'stop_loss') {
            try {
              const [dropTargets] = await db.execute(
                `SELECT * FROM price_targets WHERE symbol = ? AND direction = 'down' AND target_price >= ?`,
                [rule.symbol, currentPrice]
              );
              for (const dropTarget of dropTargets) {
                priceTargets.delete(rule.symbol);
                targetReminderCount.delete(rule.symbol);
                if (activeFixedAlerts.has(rule.symbol)) {
                  clearInterval(activeFixedAlerts.get(rule.symbol));
                  activeFixedAlerts.delete(rule.symbol);
                }
                await db.execute('DELETE FROM price_targets WHERE id = ?', [dropTarget.id]);
                console.log(`[target] Stop loss fired — cancelled drop target for ${rule.symbol}`);
              }
            } catch (e) { console.error('[target] Stop loss drop target cancel failed:', e.message); }
          }

          // USDT sweep after qualifying sells (Kraken only — Revolut handles its own treasury)
          if (rule.order_type === 'sell' && exchange === 'kraken') {
            const proceeds = currentPrice * resolvedVolume;
            await sweepToUSDT(proceeds, rule.symbol).catch(() => {});
          }

        } catch (e) {
          console.error(`[auto] Trade execution failed for ${rule.symbol}:`, e.message);
          await sendTelegram(`❌ Auto trade failed for ${coinBase}: ${e.message}`);
        }
      } catch (e) {
        console.error(`[auto] Rule processing error (id=${rule.id}):`, e.message);
      }
    }
  } catch (e) {
    console.error('[auto] checkAutoTradeRules error:', e.message);
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

    // ── High-water / low-water accumulator for fixed-target wicks ────────────
    // Mirrors trailing-stop peakPrice pattern. Only symbols with active targets
    // need tracking, but it's cheap to update all priceMap entries and let
    // targetExtremes grow no larger than the priceMap itself.
    for (const sym in priceMap) {
      const p = priceMap[sym];
      if (!p || !isFinite(p)) continue;
      const ex = targetExtremes.get(sym) || { high: p, low: p };
      if (p > ex.high) ex.high = p;
      if (p < ex.low)  ex.low  = p;
      targetExtremes.set(sym, ex);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── 24h baseline map — prices recorded at midnight (22-26h window) ────────
    // Used instead of the 7-day rolling average stored in basePrices/baselines.
    // Ensures alerts fire on genuine 24h moves, not week-old drift.
    const baseline24hMap = {};
    try {
      const [ph24Rows] = await db.execute(`
        SELECT symbol, MAX(recorded_at) as ts, SUBSTRING_INDEX(GROUP_CONCAT(price ORDER BY recorded_at DESC), ',', 1) as price
        FROM price_history
        WHERE recorded_at >= DATE_SUB(NOW(), INTERVAL 28 HOUR)
        GROUP BY symbol
      `);
      for (const r of ph24Rows) {
        if (r.price) baseline24hMap[r.symbol] = parseFloat(r.price);
      }
      console.log(`[baseline24h] Loaded ${Object.keys(baseline24hMap).length} 24h prices from price_history`);
    } catch (e) {
      console.warn('[baseline24h] Failed to load 24h prices:', e.message);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── Pre-load Kraken-only coin prices into priceMap ────────────────────────
    for (const kSym of KRAKEN_MONITORED_COINS) {
      if (priceMap[kSym]) continue; // Revolut X already has it
      const kPrice = await getKrakenPriceForSymbol(kSym).catch(() => null);
      if (kPrice) {
        priceMap[kSym] = kPrice;
        console.log(`[kraken] Pre-loaded ${kSym}: $${kPrice}`);
      }
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── USDT card payment detection ───────────────────────────────────────────
    // Rule: USDT decrease + USD stays same = card payment
    //       USDT decrease + USD increases by ~same = USDT→USD conversion (dry powder)
    try {
      const usdtAsset   = balances.find(b => b.currency === 'USDT');
      const usdAsset    = balances.find(b => b.currency === 'USD');
      const currentUSDT = parseFloat(usdtAsset?.available || 0);
      const currentUSD  = parseFloat(usdAsset?.available  || 0);

      console.log(`[usdt] Check: USDT ${lastKnownUSDT ?? 'unset'}→${currentUSDT} | USD ${lastKnownUSD ?? 'unset'}→${currentUSD}`);

      if (lastKnownUSDT === null) {
        lastKnownUSDT = currentUSDT;
        lastKnownUSD  = currentUSD;
        console.log(`[usdt] Baseline set: ${currentUSDT} USDT | ${currentUSD} USD`);
      } else {
        const decrease    = lastKnownUSDT - currentUSDT;
        const usdIncrease = currentUSD - (lastKnownUSD ?? currentUSD);

        if (decrease > 0.10) {
          console.log(`[usdt] USDT -$${decrease.toFixed(2)} | USD ${usdIncrease >= 0 ? '+' : ''}$${usdIncrease.toFixed(2)}`);

          // Guard 1: USDT→USD conversion (dry powder) — check BEFORE the >$100 cap
          // so large conversions are never mis-flagged as suspected card payments
          const isUSDConversion = usdIncrease > 0 &&
            Math.abs(usdIncrease - decrease) / decrease < 0.02;

          // Guard 2: USDT→crypto swap — also checked before the cap
          let isCryptoPurchase = false;
          let swapCoin = '';
          if (!isUSDConversion) {
            for (const asset of balances) {
              if (SKIP_CURRENCIES.includes(asset.currency)) continue;
              const sym      = `${asset.currency}-USD`;
              const currQty  = parseFloat(asset.available || 0);
              const prevQty  = previousBalances.get(sym) || 0;
              const increase = currQty - prevQty;
              if (increase <= 0) continue;
              const coinPrice   = priceMap[sym] || priceMap[`${asset.currency}/USD`] || 0;
              const increaseUSD = increase * coinPrice;
              if (increaseUSD > 0 && Math.abs(increaseUSD - decrease) / decrease < 0.03) {
                isCryptoPurchase = true;
                swapCoin = asset.currency;
                console.log(`[usdt] USDT→${asset.currency} swap detected: $${decrease.toFixed(2)} USDT → ${increase.toFixed(4)} ${asset.currency} (+$${increaseUSD.toFixed(2)}) — NOT a card payment`);
                break;
              }
            }
          }

          if (isUSDConversion) {
            // Confirmed conversion — auto-classify regardless of amount
            console.log(`[usdt] USDT→USD conversion $${decrease.toFixed(2)} — dry powder, no capital change`);
            await db.execute(
              `INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              ['USDT', 'transfer', 1.00, decrease, decrease,
               `USDT→USD conversion — dry powder for trading`, 'neutral', 'auto_internal']
            ).catch(() => {});
            await sendTelegram(`🔄 USDT→USD $${decrease.toFixed(2)}\nDry powder ready ✅\nCapital unchanged`).catch(() => {});

          } else if (isCryptoPurchase) {
            // Confirmed crypto swap — auto-classify regardless of amount
            console.log(`[usdt] USDT→${swapCoin} crypto purchase — capital unchanged`);
            await db.execute(
              `INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              ['USDT', 'transfer', 1.00, decrease, decrease,
               `USDT→${swapCoin} swap — internal rebalancing`, 'neutral', 'auto_internal']
            ).catch(() => {});

          } else {
            // Unexplained USDT decrease (no matching USD/crypto increase) — could be a card payment or trade-funding.
            // Fix B (#82): if a crypto trade happened in last 10 min, this is trade-funding, not a payment.
            const [recentTrade] = await db.execute(
              `SELECT id FROM trading_journal
               WHERE action IN ('buy', 'add')
               AND source IN ('claude_mcp', 'auto_detected', 'manual')
               AND created_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)
               LIMIT 1`
            ).catch(() => [[]]);

            if (recentTrade.length > 0) {
              console.log(`[usdt] USDT decrease $${decrease.toFixed(2)} — recent trade detected, treating as trade-funding (no capital change)`);
              await db.execute(
                `INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, source)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                ['USDT', 'transfer', 1.00, decrease, decrease,
                 `USDT used for trade funding — no capital change (#82 fix B)`, 'neutral', 'auto_internal']
              ).catch(() => {});
            } else {
              // No offsetting increase, no recent trade = card payment. AUTO-LOG it (all amounts), decrement capital, notify.
              // Reversible: Bryan taps 'skip payment X' to undo. Dupe-guard first to avoid double-logging on repeated detection.
              const [dupe] = await db.execute(
                `SELECT id FROM trading_journal
                 WHERE symbol = 'USDT' AND action = 'payment'
                 AND ABS(quantity - ?) < 0.05
                 AND created_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE)
                 LIMIT 1`,
                [decrease]
              ).catch(() => [[]]);

              if (dupe.length > 0) {
                console.log('[usdt] Duplicate payment check — skipping auto-log');
              } else {
                console.log(`[usdt] Auto-logging card payment $${decrease.toFixed(2)} (no offsetting increase, no recent trade)`);
                await db.execute(
                  `INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, source)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                  ['USDT', 'payment', 1.00, decrease, decrease,
                   `Auto-logged card payment — $${decrease.toFixed(2)} USDT (no offsetting balance increase)`, 'neutral', 'revolut_card']
                ).catch(() => {});
                const prevCap = totalInvestedCapital;
                const newCap  = totalInvestedCapital - decrease;
                await updateInvestedCapital(newCap, `Card payment auto-logged: -$${decrease.toFixed(2)}`);
                await sendTelegram(
                  `💳 PAYMENT $${decrease.toFixed(2)} USDT\n` +
                  `Capital: $${prevCap.toFixed(2)} → $${newCap.toFixed(2)}\n\n` +
                  `Tap '<b>skip payment ${decrease.toFixed(2)}</b>' if not a payment.`
                ).catch(() => {});
              }
              lastKnownUSDT = currentUSDT;
              lastKnownUSD  = currentUSD;
              await db.execute(
                `INSERT INTO system_config (config_key, config_value) VALUES ('last_known_usdt', ?), ('last_known_usd', ?)
                 ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
                [currentUSDT.toString(), currentUSD.toString()]
              ).catch(() => {});
            }
          }
        } else if (currentUSDT - lastKnownUSDT > 0.10) {
          console.log(`[usdt] USDT +$${(currentUSDT - lastKnownUSDT).toFixed(2)} — sweep or deposit`);
        }

        // ── USD→USDT conversion detection ──────────────────────────────────
        const usdDecrease  = (lastKnownUSD ?? currentUSD) - currentUSD;
        const usdtIncrease = currentUSDT - (lastKnownUSDT ?? currentUSDT);
        if (usdDecrease > 0.50 && usdtIncrease > 0.50) {
          const sim = Math.abs(usdDecrease - usdtIncrease) / usdDecrease;
          if (sim < 0.02) {
            console.log(`[usdt] USD→USDT conversion detected: $${usdDecrease.toFixed(2)}`);
            await db.execute(
              `INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              ['USDT', 'transfer', 1.00, usdtIncrease, usdtIncrease, 'USD converted to USDT — dry powder reserve', 'neutral', 'auto_internal']
            ).catch(() => {});
            await sendTelegram(`🔄 USD→USDT $${usdDecrease.toFixed(2)}\nDry powder ready. Capital unchanged.`).catch(() => {});
          }
        }

        // ── #86: crypto→personal USD withdrawal detection (notify-only, never auto-deducts) ──
        // USD dropped, NOT absorbed by a USDT conversion, and no recent crypto buy to fund.
        // That residual = money likely left to a personal/external account. Flag for Bryan's tap.
        const usdtAbsorbed = usdtIncrease > 0 && Math.abs(usdDecrease - usdtIncrease) / usdDecrease < 0.10;
        if (usdDecrease > 5.00 && !usdtAbsorbed) {
          const [recentBuy86] = await db.execute(
            `SELECT id FROM trading_journal
             WHERE action IN ('buy', 'add')
             AND source IN ('claude_mcp', 'auto_detected', 'manual')
             AND created_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)
             LIMIT 1`
          ).catch(() => [[]]);
          if (recentBuy86.length > 0) {
            console.log(`[withdrawal] USD -$${usdDecrease.toFixed(2)} — recent buy detected, treating as trade-funding (no flag)`);
          } else {
            const [dupe86] = await db.execute(
              `SELECT id FROM trading_journal
               WHERE action IN ('payment','transfer')
               AND ABS(value_usd - ?) < 0.05
               AND created_at > DATE_SUB(NOW(), INTERVAL 15 MINUTE)
               LIMIT 1`,
              [usdDecrease]
            ).catch(() => [[]]);
            if (dupe86.length > 0) {
              console.log('[withdrawal] Duplicate/handled cash move — skipping flag');
            } else {
              console.warn(`[withdrawal] Unexplained USD decrease $${usdDecrease.toFixed(2)} — possible crypto→personal withdrawal (notify-only, no auto-deduct)`);
              await sendTelegram(
                `⚠️ <b>USD left the account: $${usdDecrease.toFixed(2)}</b>\n` +
                `No USDT conversion and no recent buy — looks like a withdrawal to a personal/external account.\n\n` +
                `If you withdrew it, reply '<b>withdrew ${usdDecrease.toFixed(2)}</b>' to deduct it from invested capital.\n` +
                `Or reply '<b>skip payment</b>' to dismiss (capital unchanged).`
              ).catch(() => {});
            }
          }
        }
        // ──────────────────────────────────────────────────────────────────

        // Always update for next cycle and persist to DB so redeployments don't reset
        lastKnownUSDT = currentUSDT;
        lastKnownUSD  = currentUSD;
        await db.execute(
          `INSERT INTO system_config (config_key, config_value) VALUES ('last_known_usdt', ?), ('last_known_usd', ?)
           ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
          [currentUSDT.toString(), currentUSD.toString()]
        ).catch(() => {});
      }
    } catch (e) {
      console.error('[usdt] Detection error:', e.message);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // ── BTC key-level crossing alert ─────────────────────────────────────────
    try {
      const btcPrice = priceMap['BTC-USD'] || priceMap['BTC/USD'];
      if (btcPrice && previousBTCPrice) {
        const BTC_KEY_LEVELS = [90000, 85000, 80000, 75000, 72000, 70000, 68000, 65000, 60000];
        for (const level of BTC_KEY_LEVELS) {
          const crossedBelow = previousBTCPrice > level && btcPrice <= level;
          const crossedAbove = previousBTCPrice < level && btcPrice >= level;
          if (crossedBelow || crossedAbove) {
            const dir = crossedBelow ? 'below' : 'above';
            const [recentBTCAlert] = await db.execute(
              `SELECT id FROM macro_alerts_sent WHERE alert_hash LIKE ? AND sent_at > DATE_SUB(NOW(), INTERVAL 4 HOUR) LIMIT 1`,
              [`btc_level_${level}_%`]
            ).catch(() => [[]]);
            if (recentBTCAlert.length === 0) {
              const hash = `btc_level_${level}_${dir}_${Date.now()}`;
              await db.execute('INSERT INTO macro_alerts_sent (alert_hash, message) VALUES (?, ?)',
                [hash, `BTC crossed ${dir} $${level.toLocaleString()}`]).catch(() => {});
              if (crossedBelow) {
                await sendTelegram(
                  `🚨 <b>BTC KEY LEVEL BROKEN — $${level.toLocaleString()}</b>\n\n` +
                  `Bitcoin just fell below $${level.toLocaleString()}\n` +
                  `Current: $${Math.round(btcPrice).toLocaleString()}\n\n` +
                  `⚠️ Monitor your trailing stops — altcoins typically follow with 2-4h lag.\n` +
                  `AI is watching your positions.`
                );
              } else if (level >= 70000) {
                await sendTelegram(
                  `✅ <b>BTC RECLAIMED $${level.toLocaleString()}</b>\n\n` +
                  `Bitcoin back above key level. Current: $${Math.round(btcPrice).toLocaleString()}\n` +
                  `Positive signal for altcoin recovery.`
                );
              }
              console.log(`[btc] Key level alert: ${dir} $${level.toLocaleString()} (prev $${Math.round(previousBTCPrice).toLocaleString()} → now $${Math.round(btcPrice).toLocaleString()})`);
            }
            break; // Only fire one level per cycle
          }
        }
      }
      previousBTCPrice = btcPrice || previousBTCPrice;
    } catch (e) {
      console.error('[btc] Key level check error:', e.message);
    }
    // ─────────────────────────────────────────────────────────────────────────

    // Reset autoSkipAlerted for coins whose price moved >3% since last skip alert
    for (const [symbol, lastAlert] of autoSkipAlerted) {
      const currentPrice = priceMap[symbol];
      const basePrice = basePrices[symbol];
      if (currentPrice && basePrice) {
        const move = Math.abs((currentPrice - basePrice) / basePrice);
        if (move > 0.03) {
          autoSkipAlerted.delete(symbol);
          console.log(`[auto] Reset skip alert for ${symbol} — price moved ${(move * 100).toFixed(1)}%`);
        }
      }
    }

    // FIX 2+3: Pre-pass — find all alerts that would fire, handle dust rule-based, batch-call Claude for the rest
    {
      const pending = [];
      for (const asset of balances) {
        if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
        const available = parseFloat(asset.available);
        if (available <= 0) continue;
        const symbol = `${asset.currency}-USD`;
        const currentPrice = priceMap[symbol];
        if (!currentPrice || !basePrices[symbol]) continue;
        // Use 24h midnight price if available, else fall back to rolling baseline
        const effectiveBaseline = baseline24hMap[symbol] || basePrices[symbol];
        const change = (currentPrice - effectiveBaseline) / effectiveBaseline;
        const threshold = customThresholds[symbol] !== undefined ? customThresholds[symbol] : PUMP_THRESHOLD;
        const valueUSD = available * currentPrice;
        const isDust = valueUSD > 0 && valueUSD < 5;
        const alreadyCached = alertRecommendations.has(symbol) && (Date.now() - alertRecommendations.get(symbol).timestamp < 60 * 60 * 1000);

        const needsPump = change >= threshold  && !alertState.active.has(symbol)  && !alertState.acknowledged.has(symbol) && !ignoredCoins.has(symbol);
        const needsDrop = change <= -threshold && !activeDropAlerts.has(symbol) && !alertState.acknowledged.has(symbol) && !ignoredCoins.has(symbol);

        if ((needsPump || needsDrop) && !alreadyCached) {
          if (isDust) {
            alertRecommendations.set(symbol, { rec: getDustRecommendation(needsPump ? 'up' : 'down'), timestamp: Date.now() });
          } else {
            pending.push({ symbol, coinBase: asset.currency, changePct: change * 100, currentPrice, direction: needsPump ? 'up' : 'down', valueUSD });
          }
        }
      }
      // One batch call if multiple alerts; single call if just one
      if (pending.length === 1) {
        const a = pending[0];
        const rec = await getQuickAiRecommendation(a.symbol, a.changePct, a.currentPrice, a.direction, 'single alert');
        alertRecommendations.set(a.symbol, { rec, timestamp: Date.now() });
      } else if (pending.length > 1) {
        console.log(`[batch] ${pending.length} alerts pending — using batch API call`);
        await batchGetRecommendations(pending);
      }
    }

    for (const asset of balances) {
      if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
      const available = parseFloat(asset.available || 0) + parseFloat(asset.reserved || 0); // #71: total holdings
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
        if (prevQty !== undefined) {
          const qtyChange = available - prevQty;
          // Log all meaningful qty changes for debugging
          if (Math.abs(qtyChange) > 0.0001) {
            const changePct = prevQty > 0 ? (qtyChange / prevQty) * 100 : 100;
            console.log(`[balance] ${symbol}: ${prevQty} → ${available} (${qtyChange > 0 ? '+' : ''}${qtyChange.toFixed(6)}, ${changePct.toFixed(1)}%)`);
          }
          if (prevQty > 0 && Math.abs(qtyChange) > 0.0001) {
            const valueUsd = Math.abs(qtyChange) * currentPrice;
            if (valueUsd >= 0.10) { // minimum $0.10 to avoid fee-dust noise
              const action = qtyChange > 0 ? 'buy' : 'sell';
              console.log(`[detect] ${symbol} ${action}: ${prevQty} → ${available} ($${valueUsd.toFixed(2)})`);
              autoLogTrade(symbol, action, currentPrice, qtyChange, available).catch(e => console.error('autoLogTrade failed:', e.message));
            } else {
              console.log(`[balance] ${symbol} change $${(Math.abs(qtyChange) * currentPrice).toFixed(4)} below $0.10 threshold — skipping`);
            }
          } else if (prevQty === 0 && available > 0) {
            // Coin reappeared (bought back after full exit)
            const valueUsd = available * currentPrice;
            if (valueUsd >= 0.10) {
              console.log(`[detect] ${symbol} buy (re-entry): 0 → ${available} ($${valueUsd.toFixed(2)})`);
              autoLogTrade(symbol, 'buy', currentPrice, available, available).catch(e => console.error('autoLogTrade failed:', e.message));
            }
          }
        } else if (prevQty === undefined && available > 0) {
          // New coin appearing for the first time this session
          console.log(`[detect] ${symbol} buy (new position): 0 → ${available}`);
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

      // Use 24h midnight price if available, else fall back to rolling baseline
      const effectiveBaseline = baseline24hMap[symbol] || basePrices[symbol];
      const change = (currentPrice - effectiveBaseline) / effectiveBaseline;
      const baselineLabel = baseline24hMap[symbol] ? '24h' : 'baseline';
      console.log(`${symbol}: $${currentPrice} (${(change * 100).toFixed(1)}% from ${baselineLabel} $${effectiveBaseline.toFixed(6)})`);

      // Dust position check — suppress pump/drop alerts for positions worth less than $1
      const positionValueUsd = available * currentPrice;
      if (positionValueUsd > 0 && positionValueUsd < 1.00) {
        console.log(`[dust] Skipping ${symbol} — position value $${positionValueUsd.toFixed(4)} below $1 minimum`);
        continue;
      }

      // Entry price context — used in both pump and drop alerts
      const entryPrice = entryPrices.get(symbol);
      const plFromEntry = entryPrice ? ((currentPrice - entryPrice) / entryPrice * 100) : null;
      const isDeepLoss     = plFromEntry !== null && plFromEntry < -50;
      const isModerateLoss = plFromEntry !== null && plFromEntry < -25;
      const entryLine = entryPrice
        ? `Your entry: ${formatPrice(entryPrice)} (${plFromEntry > 0 ? '+' : ''}${plFromEntry.toFixed(1)}%)\n`
        : '';

      // Trigger baseline alert if pumping
      const threshold = customThresholds[symbol] !== undefined ? customThresholds[symbol] : PUMP_THRESHOLD;
      if (change >= threshold && !alertState.acknowledged.has(symbol) && !ignoredCoins.has(symbol)) {
        if (hasAgreedStrategy(symbol)) {
          console.log(`[alert] ${symbol} has agreed strategy — suppressing daily pump alert`);
        } else {
        const pct = (change * 100).toFixed(1);
        const coinBase = asset.currency;
        const now = Date.now();
        const firstSent = alertFirstSent.get(symbol);
        const reminderSent = alertReminderSent.get(symbol);
        const tenMinutes = 10 * 60 * 1000;

        // Reminder already sent — auto-acknowledge and stop
        if (reminderSent) {
          console.log(`[alert] ${symbol} pump — reminder already sent, auto-acknowledging`);
          await acknowledgeAlert(symbol);
          alertFirstSent.delete(symbol);
          alertReminderSent.delete(symbol);
          continue;
        }

        // First alert already sent — check if 10 minutes have passed
        if (firstSent) {
          if (now - firstSent >= tenMinutes) {
            alertReminderSent.set(symbol, now);
            console.log('[alert] Sending final pump reminder for:', symbol);
            await sendTelegram(
              `🔔 <b>REMINDER — ${coinBase} PUMP ALERT</b>\n\n` +
              `Still up ${pct}% in 24h.\n` +
              `This is the final reminder.\n\n` +
              `1️⃣ Hold\n2️⃣ Sell advice\n3️⃣ Buy more\n4️⃣ Analyse\n5️⃣ Acknowledge — stop alerts`
            );
            await db.execute(
              'INSERT INTO alert_reminders (symbol, alert_date, count) VALUES (?, CURDATE(), 1) ON DUPLICATE KEY UPDATE count = count + 1',
              [symbol]
            ).catch(() => {});
          }
          continue;
        }

        // First time firing for this move — build entry-aware recommendation
        alertFirstSent.set(symbol, now);
        alertState.active.set(symbol, true);
        await db.execute(
          'INSERT INTO alert_reminders (symbol, alert_date, count) VALUES (?, CURDATE(), 0) ON DUPLICATE KEY UPDATE count = count',
          [symbol]
        ).catch(() => {});
        let aiRec = alertRecommendations.get(symbol)?.rec || 'HOLD - Monitor the situation closely.';
        const replyMenu = `\n\n1️⃣ Hold  2️⃣ Sell  3️⃣ Buy more  4️⃣ Analyse  5️⃣ Ignore\n💬 Reply number or '<b>${coinBase.toLowerCase()} 2</b>' to target this coin`;
        let swingSignal;
        if (isDeepLoss) {
          // Pumping but still deeply underwater — don't celebrate, auto rules handle exit
          aiRec = `HOLD — Pump to ${formatPrice(currentPrice)} still ${plFromEntry.toFixed(0)}% from entry. Auto sell rules handle exit.`;
          swingSignal = `\n\n⚠️ Deep loss position — auto rules will sell when price targets are reached.`;
        } else {
          // #36 v1: plan-aware gate replaces the old generic "take profits" lines
          const gate = await buildPlanAwareSwingSignal({ coinBase, direction: 'up', isDeepLoss: false, currentPrice });
          swingSignal = gate.text || '';
          console.log(`[swingGate] ${coinBase} pump → ${gate.mode}`);
        }
        const trailReminder = trailingStops.has(symbol)
          ? `\n\n📈 TREND IS YOUR FRIEND — Trailing stop is protecting your profits. Let it run unless structure breaks!`
          : '';
        const alertMessage =
          `📈 <b>${coinBase} DAILY PUMP ALERT</b>\n\n` +
          `24h move: +${pct}%\n` +
          `Current: ${formatPrice(currentPrice)}\n` +
          entryLine +
          `You hold: ${available.toFixed(4)} ${coinBase}\n\n` +
          `⚡ RECOMMENDATION: ${aiRec}${swingSignal}${trailReminder}${replyMenu}\n\n` +
          `⏰ One reminder in 10 min if no response`;
        await sendTelegram(alertMessage);
        alertContextBySymbol.set(coinBase.toLowerCase(), { symbol, coinBase, alertType: 'pump', timestamp: Date.now() });
        lastAlertCoin = coinBase.toLowerCase();
        } // end else (hasAgreedStrategy pump suppression)
      }

      // Trigger baseline drop alert
      if (change <= -threshold && !alertState.acknowledged.has(symbol) && !ignoredCoins.has(symbol)) {
        if (hasAgreedStrategy(symbol)) {
          console.log(`[alert] ${symbol} has agreed strategy — suppressing daily drop alert`);
        } else {
        const pct = (Math.abs(change) * 100).toFixed(1);
        const coinBase = asset.currency;
        const now = Date.now();
        const firstSent = alertFirstSent.get(symbol);
        const reminderSent = alertReminderSent.get(symbol);
        const tenMinutes = 10 * 60 * 1000;

        // Reminder already sent — auto-acknowledge and stop
        if (reminderSent) {
          console.log(`[alert] ${symbol} drop — reminder already sent, auto-acknowledging`);
          await acknowledgeAlert(symbol);
          alertFirstSent.delete(symbol);
          alertReminderSent.delete(symbol);
          continue;
        }

        // First alert already sent — check if 10 minutes have passed
        if (firstSent) {
          if (now - firstSent >= tenMinutes) {
            alertReminderSent.set(symbol, now);
            console.log('[alert] Sending final drop reminder for:', symbol);
            await sendTelegram(
              `🔔 <b>REMINDER — ${coinBase} DROP ALERT</b>\n\n` +
              `Still down ${pct}% in 24h.\n` +
              `This is the final reminder.\n\n` +
              `1️⃣ Hold\n2️⃣ Buy more\n3️⃣ Sell advice\n4️⃣ Analyse\n5️⃣ Acknowledge — stop alerts`
            );
            await db.execute(
              'INSERT INTO alert_reminders (symbol, alert_date, count) VALUES (?, CURDATE(), 1) ON DUPLICATE KEY UPDATE count = count + 1',
              [symbol]
            ).catch(() => {});
          }
          continue;
        }

        // First time firing for this move — build entry-aware recommendation
        alertFirstSent.set(symbol, now);
        activeDropAlerts.set(symbol, true);
        await db.execute(
          'INSERT INTO alert_reminders (symbol, alert_date, count) VALUES (?, CURDATE(), 0) ON DUPLICATE KEY UPDATE count = count',
          [symbol]
        ).catch(() => {});
        let aiRec = alertRecommendations.get(symbol)?.rec || 'HOLD - Monitor the situation closely.';
        const replyMenu = `\n\n1️⃣ Hold  2️⃣ Buy more  3️⃣ Sell  4️⃣ Analyse  5️⃣ Ignore\n💬 Reply number or '<b>${coinBase.toLowerCase()} 2</b>' to target this coin`;
        let swingSignal;
        if (isDeepLoss) {
          // Deeply underwater — NEVER suggest buying
          aiRec = `HOLD — Already ${plFromEntry.toFixed(0)}% from entry at ${formatPrice(entryPrice)}. This drop is noise — auto rules handle ${coinBase} automatically.`;
          swingSignal = `\n\n⚠️ Deep loss position — do not average down without a clear macro catalyst.`;
        } else if (isModerateLoss) {
          aiRec = `HOLD — Down ${Math.abs(plFromEntry).toFixed(0)}% from entry. Wait for trend reversal before adding.`;
          swingSignal = `\n\n👀 Watch for MSS (Market Structure Shift) before considering adding to position.`;
        } else {
          // #36 v2: plan-aware gate replaces the old generic "buy the dip at +20%" lines
          const gate = await buildPlanAwareSwingSignal({ coinBase, direction: 'down', isDeepLoss: false, currentPrice });
          swingSignal = gate.text || '';
          console.log(`[swingGate] ${coinBase} drop → ${gate.mode}`);
        }
        const alertMessage =
          `📉 <b>${coinBase} DROP ALERT</b>\n\n` +
          `24h move: -${pct}%\n` +
          `Current: ${formatPrice(currentPrice)}\n` +
          entryLine +
          `You hold: ${available.toFixed(4)} ${coinBase}\n\n` +
          `⚡ RECOMMENDATION: ${aiRec}${swingSignal}${replyMenu}\n\n` +
          `⏰ One reminder in 10 min if no response`;
        await sendTelegram(alertMessage);
        alertContextBySymbol.set(coinBase.toLowerCase(), { symbol, coinBase, alertType: 'drop', timestamp: Date.now() });
        lastAlertCoin = coinBase.toLowerCase();
        } // end else (hasAgreedStrategy drop suppression)
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
    for (const [symbol, targetArr] of priceTargets) {
      const currentPrice = priceMap[symbol];
      if (!currentPrice) continue;
      for (const target of [...targetArr]) { // #38 B1: iterate each element; copy so in-loop deletes are safe

      // Dust check — suppress fixed target alerts for positions < $1
      // (but allow through if no position held — might be a watch for buy entry)
      {
        const coinBase_ = symbol.replace('-USD', '');
        const assetB = balances.find(a => a.currency === coinBase_);
        const ftPositionValue = assetB ? parseFloat(assetB.available) * currentPrice : 0;
        if (ftPositionValue > 0 && ftPositionValue < 1.00) {
          console.log(`[dust] Skipping fixed target for ${symbol} — $${ftPositionValue.toFixed(4)} below $1`);
          continue;
        }
      }

      const direction = target.direction || 'up';

      // Use accumulated high/low so fast wicks between polls can still trigger
      const ex = targetExtremes.get(symbol) || { high: currentPrice, low: currentPrice };
      const effHigh = Math.max(currentPrice, ex.high);
      const effLow  = Math.min(currentPrice, ex.low);

      if (direction === 'up' && effHigh >= target.targetPrice && !activeFixedAlerts.has(symbol) && !alertState.acknowledged.has(symbol) && !ignoredCoins.has(symbol)) {
        const changePct = ((currentPrice - target.anchorPrice) / target.anchorPrice) * 100;
        const coinBase = symbol.replace('-USD', '');

        // #70: 24h window matches ignored_coins expiry — covers redeployments within 24h of ack
        const [recentTargetRows] = await db.execute(
          "SELECT id FROM macro_alerts_sent WHERE symbol = ? AND alert_type IN ('target','target_acknowledged') AND sent_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) LIMIT 1",
          [symbol]
        ).catch(() => [[]]);
        if (recentTargetRows.length > 0) {
          console.log(`[target] ${symbol} — alert sent/acked within 24h, skipping`);
          alertState.acknowledged.add(symbol); // restore in-memory ack silently
          continue;
        }

        // Max-2-reminders: if already sent 2+ reminders, auto-acknowledge and delete target
        const remindersSent = targetReminderCount.get(symbol) || 0;
        if (remindersSent >= 2) {
          console.log(`[targets] Auto-acknowledging ${symbol} id=${target.id} — ${remindersSent} reminders already sent`);
          const arr38up = priceTargets.get(symbol) || [];
          const filtered38up = arr38up.filter(t => t.id !== target.id);
          if (filtered38up.length) priceTargets.set(symbol, filtered38up);
          else priceTargets.delete(symbol);
          targetReminderCount.delete(symbol);
          targetExtremes.delete(symbol); // reset accumulator — target gone
          await db.execute('DELETE FROM price_targets WHERE id = ?', [target.id]).catch(() => {});
          await sendTelegram(`🔕 <b>Target auto-dismissed: ${coinBase}</b>\nNo response after 2 reminders — target removed. Set a new one when ready.`).catch(() => {});
          continue;
        }

        // Check if this is a dust coin (balance < $5)
        const assetBalance = balances.find(a => a.currency === coinBase);
        const assetQty = assetBalance ? parseFloat(assetBalance.available) : 0;
        const assetValueUSD = assetQty * currentPrice;
        const isDustCoin = assetValueUSD > 0 && assetValueUSD < 5;

        // FIX 3: Skip API for dust coins; FIX 7: pass reason for cost logging
        const aiRec = isDustCoin ? getDustRecommendation('up') : await getQuickAiRecommendation(symbol, changePct, currentPrice, 'up', 'fixed target hit');
        const priceStr = formatPrice(currentPrice).replace('$', '');
        const anchorStr = formatPrice(target.anchorPrice).replace('$', '');
        const entryPrice = entryPrices.get(symbol) || target.entryPrice;
        const entryLine = entryPrice && !isDustCoin
          ? `\nEntry: ${formatPrice(entryPrice)} | P&L: +${((currentPrice - entryPrice) / entryPrice * 100).toFixed(1)}%`
          : '';

        let alertMessage;
        // Check if this was auto-set from a Claude sell recommendation
        let upNoteData = null;
        try { if (target.note) upNoteData = JSON.parse(target.note); } catch (e) {}
        const upDescLine = (target.note && !upNoteData) ? `\n📝 <i>${target.note}</i>` : '';
        const upWickLine = (currentPrice < target.targetPrice) ? `\n⚡ Wick trigger: high ${formatPrice(effHigh)} touched your level between checks — price now back below it` : '';

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
            ? `Your position: ${assetQty.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${coinBase} @ ${formatPrice(entryPrice)} entry\nUnrealised profit: +${((currentPrice - entryPrice) / entryPrice * 100).toFixed(1)}% (+$${Math.abs((currentPrice - entryPrice) * assetQty).toFixed(2)})`
            : (assetQty > 0 ? `You hold ${assetQty.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${coinBase}` : '');
          alertMessage =
            `🎯 <b>${coinBase} HIT YOUR PROFIT TARGET!</b>\n\n` +
            `Price: $${priceStr} (your Claude-recommended sell zone)${upWickLine}\n` +
            `Original advice: '<i>${upNoteData.snippet}</i>'\n` +
            (positionLine ? positionLine + '\n' : '') +
            `\n⚡ <b>RECOMMENDATION:</b> This is your planned profit zone.\n` +
            `Take action? Reply:\n` +
            `'sold ${coinBase} [price] [qty]' — log the sale\n` +
            `'analyse ${coinBase}' — get fresh analysis before deciding\n` +
            `'hold ${coinBase}' — log decision to hold through this level`;
        } else {
          const replyMenu = `\n\n1️⃣ Sell  2️⃣ Hold  3️⃣ Analyse  4️⃣ Acknowledge\n💬 Reply number or '<b>${coinBase.toLowerCase()} 1</b>' to target this coin`;
          const autoReady = await getAutomationReadiness(symbol, 'buy');
          const autoLine = autoReady ? `\n\n⚡ AUTO-READY: This setup has worked ${autoReady.winRate}% of the time (${autoReady.sampleSize} trades). Could be automated.` : '';
          alertMessage = `🎯 <b>${symbol} FIXED TARGET HIT!</b>\n\nAnchor: $${anchorStr} → Now $${priceStr} (+${changePct.toFixed(1)}%)${entryLine}${upDescLine}${upWickLine}\n\n⚡ RECOMMENDATION: ${aiRec}${replyMenu}${autoLine}`;
        }
        await sendTelegram(alertMessage);
        targetExtremes.delete(symbol); // reset accumulator — target fired
        // Log send to macro_alerts_sent for cooldown tracking across restarts
        await db.execute(
          "INSERT INTO macro_alerts_sent (symbol, alert_type, alert_hash, message) VALUES (?, 'target', ?, ?)",
          [symbol, `target_up_${symbol}_${Date.now()}`, `Fixed target hit @ ${currentPrice}`]
        ).catch(() => {});
        alertContextBySymbol.set(coinBase.toLowerCase(), { symbol, coinBase, alertType: 'fixed_target_up', timestamp: Date.now() });
        lastAlertCoin = coinBase.toLowerCase();
        // Auto-trigger Claude analysis for non-dust, non-claude_rec alerts
        if (!isDustCoin && !(upNoteData && upNoteData.source === 'claude_rec')) {
          analyseFixedTargetAlert(symbol, currentPrice, target)
            .catch(e => console.error('[analysis] fixed target up:', e.message));
        }

        targetReminderCount.set(symbol, 0); // reset counter when first alert fires
        activeFixedAlerts.set(symbol, setInterval(async () => {
          if (alertState.acknowledged.has(symbol)) {
            console.log('[alert] Fixed-target reminder skipped — recently acknowledged:', symbol);
            clearInterval(activeFixedAlerts.get(symbol));
            activeFixedAlerts.delete(symbol);
            return;
          }
          const count = (targetReminderCount.get(symbol) || 0) + 1;
          targetReminderCount.set(symbol, count);
          const reminderSuffix = ` (Reminder ${count}/2)`;
          console.log('[alert] Sending fixed-target reminder for:', symbol, `(${count}/2)`);
          if (count >= 2) {
            // Final reminder — next cycle will auto-dismiss
            clearInterval(activeFixedAlerts.get(symbol));
            activeFixedAlerts.delete(symbol);
          }
          await sendTelegram(`⚠️ <b>REMINDER: ${symbol} FIXED TARGET STILL ACTIVE!</b>${reminderSuffix}\n\nTarget: ${formatPrice(target.targetPrice)} | Now: ${formatPrice(currentPrice)}\nReply 'acknowledge ${coinBase}' to stop`);
        }, ALERT_INTERVAL_MS));
      }

      if (direction === 'down' && effLow <= target.targetPrice && !activeFixedAlerts.has(symbol) && !alertState.acknowledged.has(symbol) && !ignoredCoins.has(symbol)) {
        const changePct = ((currentPrice - target.anchorPrice) / target.anchorPrice) * 100;
        const coinBase = symbol.replace('-USD', '');

        // #70: 24h window matches ignored_coins expiry — covers redeployments within 24h of ack
        const [recentTargetRowsDown] = await db.execute(
          "SELECT id FROM macro_alerts_sent WHERE symbol = ? AND alert_type IN ('target','target_acknowledged') AND sent_at > DATE_SUB(NOW(), INTERVAL 24 HOUR) LIMIT 1",
          [symbol]
        ).catch(() => [[]]);
        if (recentTargetRowsDown.length > 0) {
          console.log(`[target] ${symbol} — floor alert sent/acked within 24h, skipping`);
          alertState.acknowledged.add(symbol);
          continue;
        }

        // Max-2-reminders: if already sent 2+ reminders, auto-acknowledge and delete target
        const remindersSentDown = targetReminderCount.get(symbol) || 0;
        if (remindersSentDown >= 2) {
          console.log(`[targets] Auto-acknowledging ${symbol} (down) id=${target.id} — ${remindersSentDown} reminders already sent`);
          const arr38dn = priceTargets.get(symbol) || [];
          const filtered38dn = arr38dn.filter(t => t.id !== target.id);
          if (filtered38dn.length) priceTargets.set(symbol, filtered38dn);
          else priceTargets.delete(symbol);
          targetReminderCount.delete(symbol);
          targetExtremes.delete(symbol); // reset accumulator — target gone
          await db.execute('DELETE FROM price_targets WHERE id = ?', [target.id]).catch(() => {});
          await sendTelegram(`🔕 <b>Target auto-dismissed: ${coinBase}</b>\nNo response after 2 reminders — target removed. Set a new one when ready.`).catch(() => {});
          continue;
        }

        const entryPrice = entryPrices.get(symbol) || target.entryPrice;
        const plPct = entryPrice ? ((currentPrice - entryPrice) / entryPrice * 100).toFixed(1) : null;
        const replyMenu = `\n\n1️⃣ Buy more  2️⃣ Hold  3️⃣ Sell  4️⃣ Acknowledge\n💬 Reply number or '<b>${coinBase.toLowerCase()} 1</b>' to target this coin`;

        let alertMessage;
        let noteData = null;
        try { if (target.note) noteData = JSON.parse(target.note); } catch (e) {}
        const dnDescLine = (target.note && !noteData) ? `\n📝 <i>${target.note}</i>` : '';
        const dnWickLine = (currentPrice > target.targetPrice) ? `\n⚡ Wick trigger: low ${formatPrice(effLow)} touched your floor between checks — price has bounced since` : '';

        if (noteData && noteData.source === 'claude_rec') {
          // Enhanced message: this was auto-set from Bryan's thumbs-up on a recommendation
          const assetBalance = balances.find(a => a.currency === coinBase);
          const qty = assetBalance ? parseFloat(assetBalance.available) : 0;
          const positionLine = entryPrice && qty > 0
            ? `Your current position: ${qty.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${coinBase} @ ${formatPrice(entryPrice)} entry (P&L: ${plPct}%)`
            : (qty > 0 ? `You hold: ${qty.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${coinBase}` : '');
          alertMessage =
            `📊 <b>${coinBase} HIT YOUR BUY LEVEL!</b>\n\n` +
            `Price: ${formatPrice(currentPrice)} (your Claude-recommended buy zone)${dnWickLine}\n` +
            `Original advice: '<i>${noteData.snippet}</i>'\n` +
            (positionLine ? positionLine + '\n' : '') +
            `\n⚡ <b>RECOMMENDATION:</b> This is your planned buy zone.\n` +
            `Ready to add? Reply 'bought ${coinBase} [price] [qty]' to log the trade.` +
            replyMenu;
        } else {
          // FIX 7: pass reason for cost logging
          const aiRec = await getQuickAiRecommendation(symbol, changePct, currentPrice, 'down', 'fixed floor hit');
          const entryLine = plPct !== null ? `\nEntry: ${formatPrice(entryPrice)} | P&L: ${plPct}%` : '';
          const autoReady = await getAutomationReadiness(symbol, 'sell');
          const autoLine = autoReady ? `\n\n⚡ AUTO-READY: This setup has worked ${autoReady.winRate}% of the time (${autoReady.sampleSize} trades). Could be automated.` : '';
          alertMessage = `📉 <b>${symbol} FIXED FLOOR HIT!</b>\n\nAnchor: ${formatPrice(target.anchorPrice)} → Now ${formatPrice(currentPrice)} (${changePct.toFixed(1)}%)${entryLine}${dnDescLine}${dnWickLine}\n\n⚡ RECOMMENDATION: ${aiRec}${replyMenu}${autoLine}`;
        }
        await sendTelegram(alertMessage);
        targetExtremes.delete(symbol); // reset accumulator — floor fired
        // Log send for cooldown tracking across restarts
        await db.execute(
          "INSERT INTO macro_alerts_sent (symbol, alert_type, alert_hash, message) VALUES (?, 'target', ?, ?)",
          [symbol, `target_down_${symbol}_${Date.now()}`, `Fixed floor hit @ ${currentPrice}`]
        ).catch(() => {});
        alertContextBySymbol.set(coinBase.toLowerCase(), { symbol, coinBase, alertType: 'fixed_target_down', timestamp: Date.now() });
        lastAlertCoin = coinBase.toLowerCase();

        targetReminderCount.set(symbol, 0); // reset counter when first alert fires
        activeFixedAlerts.set(symbol, setInterval(async () => {
          if (alertState.acknowledged.has(symbol)) {
            console.log('[alert] Fixed-floor reminder skipped — recently acknowledged:', symbol);
            clearInterval(activeFixedAlerts.get(symbol));
            activeFixedAlerts.delete(symbol);
            return;
          }
          const count = (targetReminderCount.get(symbol) || 0) + 1;
          targetReminderCount.set(symbol, count);
          const reminderSuffix = ` (Reminder ${count}/2)`;
          console.log('[alert] Sending fixed-floor reminder for:', symbol, `(${count}/2)`);
          if (count >= 2) {
            // Final reminder — next cycle will auto-dismiss
            clearInterval(activeFixedAlerts.get(symbol));
            activeFixedAlerts.delete(symbol);
          }
          await sendTelegram(`⚠️ <b>REMINDER: ${symbol} FIXED FLOOR STILL ACTIVE!</b>${reminderSuffix}\n\nFloor: ${formatPrice(target.targetPrice)} | Now: ${formatPrice(currentPrice)}\nReply 'acknowledge ${coinBase}' to stop`);
        }, ALERT_INTERVAL_MS));
      }
      } // end inner target loop — #38 B1
    }
    // ── Trailing stop checks ──────────────────────────────────────────────────
    for (const [symbol, ts] of trailingStops) {
      const currentPrice = priceMap[symbol];
      if (!currentPrice) continue;
      if (alertState.acknowledged.has(symbol)) continue;
      if (ignoredCoins.has(symbol)) continue;

      // Dust check with exception: trailing stops fire even on dust if explicitly set by Claude
      // Since all entries in trailingStops were explicitly set, hasExplicitTrailingStop is always true —
      // meaning this effectively allows trailing stops to always fire regardless of position size.
      {
        const hasExplicitTrailingStop = trailingStops.has(symbol);
        const assetB = balances.find(a => a.currency === symbol.replace('-USD', ''));
        const tsPositionValue = assetB ? parseFloat(assetB.available) * currentPrice : 0;
        if (tsPositionValue > 0 && tsPositionValue < 1.00 && !hasExplicitTrailingStop) {
          console.log(`[dust] Skipping trailing stop for ${symbol} — $${tsPositionValue.toFixed(4)} below $1`);
          continue;
        }
      }

      const result = await updateTrailingStop(symbol, currentPrice);
      if (!result || !result.triggered) continue;

      await handleTrailingStopAlert(symbol, currentPrice, ts, 'revolut');
    }

    // ── Trailing stop checks — Kraken coins ──────────────────────────────────
    // Coins held on Kraken are not in the Revolut X priceMap, so checked separately
    for (const [symbol, ts] of trailingStops) {
      if (priceMap[symbol]) continue; // already handled above by Revolut X loop
      if (alertState.acknowledged.has(symbol)) continue;
      if (ignoredCoins.has(symbol)) continue;

      const krakenPrice = await getKrakenPriceForSymbol(symbol).catch(() => null);
      if (!krakenPrice) continue;

      priceMap[symbol] = krakenPrice; // make available for rest of cycle

      // Update peak if price is higher
      if (krakenPrice > ts.peakPrice) {
        ts.peakPrice = krakenPrice;
        ts.stopPrice = krakenPrice * (1 - ts.trailPct / 100);
        trailingStops.set(symbol, ts);
        await db.execute(
          'UPDATE trailing_stops SET peak_price = ?, stop_price = ?, updated_at = CURRENT_TIMESTAMP WHERE symbol = ?',
          [ts.peakPrice, ts.stopPrice, symbol]
        ).catch(() => {});
        console.log(`[trailing] Kraken ${symbol} new peak ${fmtPriceShort(krakenPrice)} → stop ${fmtPriceShort(ts.stopPrice)}`);
      }

      if (krakenPrice <= ts.stopPrice) {
        await handleTrailingStopAlert(symbol, krakenPrice, ts, 'kraken');
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

        // Dust check — skip swing signals for positions < $1
        const swingPositionValue = (parseFloat(asset.available || 0) + parseFloat(asset.reserved || 0)) * currentPrice; // #71
        if (swingPositionValue > 0 && swingPositionValue < 1.00) {
          console.log(`[dust] Skipping swing signal for ${symbol} — $${swingPositionValue.toFixed(4)} below $1`);
          continue;
        }

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
        const isExtremeDip  = devFromAvg <= -extremeMoveThreshold && !activeDropAlerts.has(symbol) && !alertState.acknowledged.has(symbol) && !ignoredCoins.has(symbol);
        const isExtremePump = devFromAvg >=  extremeMoveThreshold && !alertState.active.has(symbol) && !alertState.acknowledged.has(symbol) && !ignoredCoins.has(symbol);

        if (!isExtremeDip && !isExtremePump) continue;

        // Cooldown: skip if a swing signal was sent within the last 4 hours
        const lastSwing = swingAlertCooldown.get(symbol);
        if (lastSwing && (Date.now() - lastSwing) < 4 * 60 * 60 * 1000) {
          const minsAgo = Math.round((Date.now() - lastSwing) / 60000);
          const minsLeft = Math.round((4 * 60 * 60 * 1000 - (Date.now() - lastSwing)) / 60000);
          console.log('[swing] Cooldown active for', symbol, `- skipping (sent ${minsAgo}min ago, ${minsLeft}min remaining)`);
          continue;
        }

        // Skip swing signal if coin already has a custom alert plan in place
        const hasCustomPlan =
          priceTargets.has(symbol) ||          // fixed target set
          trailingStops.has(symbol) ||          // trailing stop active
          alertState.acknowledged.has(symbol);  // recently acknowledged
        if (hasCustomPlan) {
          console.log(`[swing] Skipping ${symbol} — custom alert plan already in place`);
          continue;
        }

        // Check we haven't sent this extreme alert recently (use basePrices as proxy)
        const coinBase = asset.currency;
        const available = parseFloat(asset.available || 0) + parseFloat(asset.reserved || 0); // #71: total holdings
        const entryPrice = entryPrices.get(symbol);

        // Swing: check one-alert + one-reminder logic (shared Maps with pump/drop alerts)
        {
          const swNow = Date.now();
          const swFirstSent = alertFirstSent.get(symbol);
          const swReminderSent = alertReminderSent.get(symbol);
          const tenMin = 10 * 60 * 1000;
          if (swReminderSent) {
            console.log(`[swing] ${symbol} — reminder already sent, auto-acknowledging`);
            await acknowledgeAlert(symbol);
            alertFirstSent.delete(symbol);
            alertReminderSent.delete(symbol);
            continue;
          }
          if (swFirstSent) {
            if (swNow - swFirstSent >= tenMin && !swReminderSent) {
              alertReminderSent.set(symbol, swNow);
              const swDir = isExtremePump ? 'PUMP' : 'DIP';
              const swPct = isExtremePump
                ? (devFromAvg * 100).toFixed(1)
                : (Math.abs(devFromAvg) * 100).toFixed(1);
              const coinBase = asset.currency;
              await sendTelegram(
                `🔔 <b>REMINDER — ${coinBase} SWING ${swDir} SIGNAL</b>\n\n` +
                `Still ${swPct}% outside 7-day average.\n` +
                `This is the final reminder.\n\n` +
                `Reply 'acknowledge ${coinBase}' to stop alerts`
              );
            }
            continue; // already alerted this cycle — skip re-send
          }
          // First time — record timestamp, let the normal send proceed below
          alertFirstSent.set(symbol, swNow);
        }

        if (isExtremeDip) {
          extremeAlertsSent[symbol] = true;
          const dropPct = (Math.abs(devFromAvg) * 100).toFixed(1);
          const buyBackSell = fmtPriceShort(currentPrice * 1.20);
          const entryLine = entryPrice
            ? `Entry: ${fmtPriceShort(entryPrice)} | P&L: ${((currentPrice - entryPrice) / entryPrice * 100).toFixed(1)}%\n`
            : '';
          // A2 (dev_log #31): role-aware rec — hodl/manual_only coins are not dip-buy candidates
          const { narrative: dipNarrative, role: dipRole } = await getCoinContext(coinBase);
          let dipRecLine;
          if (dipRole === 'hodl' || dipRole === 'manual_only') {
            dipRecLine =
              `⚡ This is a HOLD position (${dipNarrative || coinBase}). Per your strategy this is NOT a buy-the-dip candidate — it's a hold/exit bag. Watch for strength to trim into, not a dip to add. No action suggested.`;
          } else {
            dipRecLine =
              `⚡ <b>RECOMMENDATION:</b> Strong buy signal based on your swing strategy.\n` +
              `Consider buying here and setting sell alert at ${buyBackSell} (+20%)`;
          }
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
            dipRecLine + `\n\n` +
            `Reply:\n` +
            `'buy ${coinBase}' - get buy advice + auto-set buy and sell alerts\n` +
            `'hold ${coinBase}' - already holding, set recovery alerts\n` +
            `'dust ${coinBase}' - dust position, watch for further drop\n` +
            `'acknowledge ${coinBase}' - dismiss this alert`;
          await sendTelegram(swingMsg);
          // Store context so webhook replies can respond intelligently
          lastSwingAlertContext.set(symbol, { direction: 'dip', price: currentPrice, timestamp: Date.now() });
          mostRecentSwingAlert = { symbol, coinBase, direction: 'dip', price: currentPrice, timestamp: Date.now() };
          swingAlertCooldown.set(symbol, Date.now()); // start 4h cooldown
          await db.execute(
            'INSERT INTO swing_cooldowns (symbol, last_alert_at) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE last_alert_at = NOW(), updated_at = CURRENT_TIMESTAMP',
            [symbol]
          ).catch(e => console.error('Failed to persist swing cooldown:', e.message));
          console.log(`Extreme dip signal sent for ${symbol}: ${dropPct}% below 7d avg`);
        }

        if (isExtremePump) {
          extremeAlertsSent[symbol] = true;
          const pumpPct = (devFromAvg * 100).toFixed(1);
          const buyBackPrice = fmtPriceShort(currentPrice * 0.85);
          const entryLine = entryPrice
            ? `Entry: ${fmtPriceShort(entryPrice)} | Profit: +${((currentPrice - entryPrice) / entryPrice * 100).toFixed(1)}%\n`
            : '';
          const tsForSymbol = trailingStops.get(symbol);
          const pumpRecLine = tsForSymbol
            ? `Trailing stop active at ${fmtPriceShort(tsForSymbol.stopPrice)} — trend is your friend! Only sell if market structure shifts.`
            : `Consider taking profits and setting buy-back alert at ${buyBackPrice} (-15%)`;
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
            pumpRecLine + `\n\n` +
            `Reply:\n` +
            `'sell ${coinBase}' - get sell advice + auto-set profit targets\n` +
            `'hold ${coinBase}' - I'm holding, set sell alert at next resistance\n` +
            `'dust ${coinBase}' - dust position, set retrace buy alert\n` +
            `'acknowledge ${coinBase}' - dismiss this alert`;
          await sendTelegram(swingMsg);
          // Store context so webhook replies can respond intelligently
          lastSwingAlertContext.set(symbol, { direction: 'pump', price: currentPrice, timestamp: Date.now() });
          mostRecentSwingAlert = { symbol, coinBase, direction: 'pump', price: currentPrice, timestamp: Date.now() };
          swingAlertCooldown.set(symbol, Date.now()); // start 4h cooldown
          await db.execute(
            'INSERT INTO swing_cooldowns (symbol, last_alert_at) VALUES (?, NOW()) ON DUPLICATE KEY UPDATE last_alert_at = NOW(), updated_at = CURRENT_TIMESTAMP',
            [symbol]
          ).catch(e => console.error('Failed to persist swing cooldown:', e.message));
          console.log(`Extreme pump signal sent for ${symbol}: ${pumpPct}% above 7d avg`);
        }
      }
    } catch (e) {
      console.log('Extreme move detection error:', e.message);
    }

    // ── Secondary alert check: sell levels stored in note JSON ──────────────
    // These are sell/profit levels from a recommendation where a buy alert is the primary target.
    // We check them here so both buy and sell levels fire automatically.
    for (const [symbol, targetArr] of priceTargets) {
      for (const target of [...targetArr]) { // #38 B1: iterate each element
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
      } // end inner target loop — #38 B1
    }

    // ── Kraken exchange monitoring ────────────────────────────────────────────
    try {
      const krakenData = await getKrakenBalances();
      if (krakenData.totalUSD > 0) {
        console.log(`[kraken] Portfolio: $${krakenData.totalUSD.toFixed(2)} across ${krakenData.balances.length} asset(s)`);
      }
      for (const asset of krakenData.balances) {
        if (!asset.price || !asset.valueUSD) continue;
        const symbol   = asset.symbol;
        const coinBase = asset.standard;

        // Set baseline if not yet set
        if (!basePrices[symbol]) {
          basePrices[symbol] = asset.price;
          console.log(`[kraken] Baseline set for ${symbol}: $${asset.price}`);
          continue;
        }

        const change    = (asset.price - basePrices[symbol]) / basePrices[symbol];
        const threshold = customThresholds[symbol] !== undefined ? customThresholds[symbol] : PUMP_THRESHOLD;

        // Pump alert
        if (change >= threshold && !alertState.active.has(symbol) && !alertState.acknowledged.has(symbol) && !ignoredCoins.has(symbol)) {
          const pct   = (change * 100).toFixed(1);
          const aiRec = alertRecommendations.get(symbol)?.rec || 'HOLD - Monitor closely.';
          const trailReminderKraken = trailingStops.has(symbol)
            ? `\n\n📈 TREND IS YOUR FRIEND — Trailing stop active at ${fmtPriceShort(trailingStops.get(symbol).stopPrice)}.`
            : '';
          const krakenGate = await buildPlanAwareSwingSignal({ coinBase, direction: 'up', isDeepLoss: false, currentPrice: asset.price });
          console.log(`[swingGate] ${coinBase} kraken pump → ${krakenGate.mode}`);
          await sendTelegram(
            `📈 <b>${symbol} DAILY PUMP ALERT (Kraken)</b>\n\n` +
            `Baseline: ${fmtPriceShort(basePrices[symbol])} → Now ${fmtPriceShort(asset.price)} (+${pct}%)\n` +
            `You hold: ${asset.quantity.toFixed(4)} ${coinBase} on Kraken\n\n` +
            `⚡ RECOMMENDATION: ${aiRec}${krakenGate.text || ''}` + trailReminderKraken + `\n\n` +
            `Reply 'acknowledge ${coinBase}' to stop alerts`
          );
        }

        // Trailing stop check for Kraken assets
        if (trailingStops.has(symbol) && !alertState.acknowledged.has(symbol) && !ignoredCoins.has(symbol)) {
          const result = await updateTrailingStop(symbol, asset.price);
          if (result && result.triggered) {
            await sendTelegram(
              `⚠️ <b>TRAILING STOP TRIGGERED — ${coinBase} (Kraken)</b>\n\n` +
              `Peak: ${fmtPriceShort(result.ts.peakPrice)} | Current: ${fmtPriceShort(asset.price)}\n` +
              `Trail: ${result.ts.trailPct}% | Stop: ${fmtPriceShort(result.ts.stopPrice)}\n\n` +
              `💡 Come to Claude to evaluate before deciding!\n\n` +
              `Reply 'acknowledge ${coinBase}' to dismiss`
            );
            await acknowledgeAlert(symbol);
            trailingStopAlerted.set(symbol, Date.now());
          }
        }
      }
    } catch (e) {
      console.error('[kraken] Monitoring error:', e.message);
    }

    // ── Auto trade rules ──────────────────────────────────────────────────────
    await checkAutoTradeRules(priceMap);

  } catch (e) {
    console.log('Portfolio check error:', e.message, e.stack);
  }
}

// Start monitoring loop
setTimeout(async () => {
  await sendTelegram('🤖 Revolut X monitor started! Checking your portfolio every 5 minutes.');
  await checkPortfolio();
  monitoringInterval = setInterval(checkPortfolio, CHECK_INTERVAL_MS);
  captureIntradayPrices();
  setInterval(captureIntradayPrices, CAPTURE_INTERVAL_MS);
  runFastScan();
  setInterval(runFastScan, FAST_SCAN_INTERVAL_MS);
}, 5000);

// Record prices at midnight every day (UK time)
cron.schedule('0 0 * * *', recordDailyPrices, { timezone: 'Europe/London' });
cron.schedule('0 3 * * *', runReconciliation, { timezone: 'Europe/London' });
cron.schedule('55 2 * * *', backupServerJsToDrive, { timezone: 'Europe/London' }); // nightly server.js snapshot → revolut-claude-backups
cron.schedule('30 3 * * *', backupDatabaseToDrive, { timezone: 'Europe/London' }); // #12 nightly DB backup

// Morning briefing disabled — sendMorningBriefing() kept for manual use
// cron.schedule('5 9 * * *', async () => {
//   try {
//     await sendMorningBriefing();
//   } catch (e) {
//     console.error('Morning briefing failed, retrying in 2 minutes:', e.message);
//     setTimeout(async () => {
//       try {
//         await sendMorningBriefing();
//       } catch (e2) {
//         console.error('Morning briefing retry also failed:', e2.message);
//         await sendTelegram('❌ Morning briefing failed twice — check Railway logs.');
//       }
//     }, 2 * 60 * 1000);
//   }
// }, { timezone: 'Europe/London' });

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

// #50: prune intraday prices older than 30 days
cron.schedule('15 2 * * *', async () => {
  try {
    const [r] = await db.execute('DELETE FROM price_intraday WHERE recorded_at < DATE_SUB(NOW(), INTERVAL 30 DAY)');
    if (r.affectedRows > 0) console.log(`[intraday] Pruned ${r.affectedRows} row(s) older than 30d`);
  } catch (e) { console.error('[intraday] prune error:', e.message); }
}, { timezone: 'Europe/London' });

// Daily cleanup — 2 AM: delete expired unmatched trade intentions
cron.schedule('0 2 * * *', async () => {
  try {
    const [r] = await db.execute('DELETE FROM trade_intentions WHERE expires_at < NOW() AND matched_at IS NULL');
    if (r.affectedRows > 0) console.log(`[intentions] Cleaned up ${r.affectedRows} expired unmatched intention(s)`);
  } catch (e) { console.error('[intentions] cleanup error:', e.message); }
}, { timezone: 'Europe/London' });

// Daily rebalancing outcome checks — 10:05 AM (7-day + 30-day)
cron.schedule('5 10 * * *', checkRebalancingOutcomes, { timezone: 'Europe/London' });
cron.schedule('10 10 * * *', gradeTradeOutcomes, { timezone: 'Europe/London' });

// Weekly snapshot — every Monday 9:10 AM, saves portfolio state to system_config
cron.schedule('10 9 * * 1', async () => {
  try {
    const portfolioValue = await getCurrentPortfolioValue();
    const cap = getCapitalSummary(portfolioValue);
    const [rules]   = await db.execute('SELECT * FROM auto_trade_rules WHERE active = 1');
    const [trails]  = await db.execute('SELECT * FROM trailing_stops');
    const [targets] = await db.execute('SELECT * FROM price_targets');
    const weeklySnapshot = {
      date: new Date().toISOString(),
      portfolio_value: portfolioValue.toFixed(2),
      invested: cap.invested,
      pl_usd: cap.pnl.toFixed(2),
      pl_pct: cap.pnlPct.toFixed(2),
      active_auto_rules: rules.length,
      trailing_stops: trails.map(t => ({ symbol: t.symbol, trail_pct: t.trail_pct, peak_price: t.peak_price })),
      price_targets:  targets.map(t => ({ symbol: t.symbol, target: t.target_price, direction: t.direction })),
    };
    await db.execute(
      'INSERT INTO system_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)',
      ['weekly_snapshot', JSON.stringify(weeklySnapshot, null, 2)]
    );
    console.log('[config] Weekly snapshot saved to system_config');

    // Weekly entry price sync — refresh cost basis from exchanges
    try {
      console.log('[entry-sync] Weekly entry price sync starting…');
      const rvBals = await revolutRequest('GET', '/balances');
      let syncCount = 0;
      for (const asset of rvBals) {
        if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
        const qty = parseFloat(asset.available || 0);
        if (qty < 0.001) continue;
        const sym = `${asset.currency}-USD`;
        const synced = await syncEntryPriceFromRevolutX(sym).catch(() => null);
        if (synced) syncCount++;
      }
      console.log(`[entry-sync] Weekly sync complete — ${syncCount} Revolut X positions refreshed`);
    } catch (e) {
      console.error('[entry-sync] Weekly sync error:', e.message);
    }
  } catch (e) {
    console.error('[config] Weekly snapshot error:', e.message);
  }
}, { timezone: 'Europe/London' });

cron.schedule('15 9 * * 1', weeklyResearchSweep, { timezone: 'Europe/London' }); // #72 Build 2: weekly research sweep, Mondays 9:15 AM

console.log('Cron jobs scheduled: midnight price recording + 9 AM morning briefing + every-2h macro news + Monday 9:05 rebalancing check + 9:15 AM research sweep + 10 AM intention outcomes + 10:02 AM rebalance checks (Europe/London)');

const app = express();
app.use(cors());
app.use(express.json());

// #43 — auth gate on state-changing API routes.
// GETs stay open (dashboard reads). Fail-closed if
// API_TOKEN unset. /mcp + /telegram-webhook unaffected
// (different path prefix). /api/bridge exempt (own
// BRIDGE_TOKEN check).
const API_WRITE_EXEMPT = ['/api/pause', '/api/resume', '/api/sweep/config', '/api/bridge'];
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (API_WRITE_EXEMPT.includes(req.path)) return next();
  if (!process.env.API_TOKEN || req.headers['x-api-token'] !== process.env.API_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return next();
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
app.use(express.static(join(__dirname, 'public')));

// Clean URL for usage monitor
app.get('/usage', (req, res) => res.sendFile(join(__dirname, 'public', 'claude-usage-monitor.html')));

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

// GET /api/health — lightweight liveness check (no DB, no external calls)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString(), uptime: Math.round(process.uptime()) });
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
      result.push({ currency: asset.currency, available, price, valueUSD, symbol, overnightChangePct, entryPrice, unrealisedPnlPct, unrealisedPnlUsd, ignored: ignoredCoins.has(symbol) });
    }
    res.json({ balances: result, totalUSD });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/acknowledge/:symbol — stop alerts for a coin (session-only)
app.post('/api/acknowledge/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const coinBase = symbol.replace('-USD', '');
  console.log('[dashboard] Acknowledge request for:', symbol);
  await acknowledgeAlert(symbol);
  await sendTelegram(`🔕 <b>${coinBase} alerts stopped via dashboard.</b>\nSilent until you set a new alert or restart.\nSend 'watch ${coinBase}' to re-enable, or 'ignore ${coinBase}' for permanent silence.`);
  res.json({ ok: true, symbol, message: `Acknowledged ${symbol} — all intervals cleared, silent for session` });
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
      upsertPriceTarget(symbol, { anchorPrice: anchor_price, thresholdPct: threshold_pct, targetPrice, direction: 'up', note: null }); // #38 B2
      if (activeFixedAlerts.has(symbol)) { clearInterval(activeFixedAlerts.get(symbol)); activeFixedAlerts.delete(symbol); }
      return res.json({ ok: true, symbol, anchorPrice: anchor_price, targetPrice, thresholdPct: threshold_pct });
    } else if (priceTargets.has(symbol)) {
      // Use existing anchor, update threshold — #38 B2: read anchor from array[0]
      const existingArr38b2 = priceTargets.get(symbol) || [];
      const anchorSrc38b2 = existingArr38b2[0] || {};
      const targetPrice = (anchorSrc38b2.anchorPrice || 0) * (1 + threshold_pct / 100);
      await db.execute(
        'INSERT INTO price_targets (symbol, anchor_price, threshold_pct, target_price) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE threshold_pct = VALUES(threshold_pct), target_price = VALUES(target_price), updated_at = CURRENT_TIMESTAMP',
        [symbol, anchorSrc38b2.anchorPrice, threshold_pct, targetPrice]
      );
      upsertPriceTarget(symbol, { anchorPrice: anchorSrc38b2.anchorPrice, thresholdPct: threshold_pct, targetPrice, direction: anchorSrc38b2.direction || 'up', note: anchorSrc38b2.note || null }); // #38 B2
      if (activeFixedAlerts.has(symbol)) { clearInterval(activeFixedAlerts.get(symbol)); activeFixedAlerts.delete(symbol); }
      return res.json({ ok: true, symbol, anchorPrice: anchorSrc38b2.anchorPrice, targetPrice, thresholdPct: threshold_pct });
    } else {
      // No anchor — fetch current price
      const { anchorPrice, targetPrice } = await setFixedTarget(symbol, threshold_pct);
      return res.json({ ok: true, symbol, anchorPrice, targetPrice, thresholdPct: threshold_pct });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/bridge — dev_bridge ingestion (Claude→Railway). Token-protected.
app.post('/api/bridge', async (req, res) => {
  // AUTH — required, unlike the other open routes
  if (req.headers['x-bridge-token'] !== process.env.BRIDGE_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const { type, payload, ref_devlog_id } = req.body;
  if (!type || !payload) {
    return res.status(400).json({ error: 'type and payload required' });
  }
  // size guard — reject absurdly large payloads
  if (typeof payload !== 'string' || payload.length > 500000) {
    return res.status(400).json({ error: 'payload must be a string under 500k chars' });
  }
  try {
    const [r] = await db.execute(
      'INSERT INTO dev_bridge (type, ref_devlog_id, payload) VALUES (?, ?, ?)',
      [String(type).slice(0, 32), ref_devlog_id || null, payload]
    );
    return res.json({ ok: true, id: r.insertId, type, bytes: payload.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
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

// GET /api/rebalancing-tracker — rebalancing history + accuracy stats
app.get('/api/rebalancing-tracker', async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT * FROM rebalancing_tracker ORDER BY rebalance_date DESC LIMIT 50');
    const [stats] = await db.execute(
      `SELECT COUNT(*) as total, SUM(CASE WHEN outcome = 'good' THEN 1 ELSE 0 END) as good, AVG(pnl_7d) as avg_pnl_7d
       FROM rebalancing_tracker WHERE outcome IS NOT NULL`
    );
    const s = stats[0];
    res.json({
      history: rows,
      accuracy: s.total > 0 ? Math.round(s.good / s.total * 100) : null,
      total: parseInt(s.total) || 0,
      good: parseInt(s.good) || 0,
      avg_pnl_7d: s.avg_pnl_7d ? parseFloat(s.avg_pnl_7d).toFixed(1) : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/journal/stats — compute stats from trading_journal
app.get('/api/journal/stats', async (req, res) => {
  try {
    const [all] = await db.execute("SELECT * FROM trading_journal WHERE action NOT IN ('payment', 'transfer')");
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

    // Payment / transfer counts
    const [paymentRows] = await db.execute("SELECT COUNT(*) as cnt FROM trading_journal WHERE action = 'payment'");
    const payment_count = parseInt(paymentRows[0].cnt);
    const [transferRows] = await db.execute("SELECT COUNT(*) as cnt FROM trading_journal WHERE action = 'transfer'");
    const transfer_count = parseInt(transferRows[0].cnt);

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
      transfer_count,
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
    const sym = req.params.symbol.toUpperCase().replace('-USD', '');
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

// GET /api/entryprices — all average entry prices (simple map for legacy consumers)
app.get('/api/entryprices', (req, res) => {
  const out = {};
  for (const [sym, price] of entryPrices) out[sym] = price;
  res.json(out);
});

// DELETE /api/entry-prices/:symbol — remove sold coin history (only coins with zero live balance)
app.delete('/api/entry-prices/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase().replace('_', '-');
    await db.execute('DELETE FROM entry_prices  WHERE symbol = ?', [symbol]);
    await db.execute('DELETE FROM price_targets WHERE symbol = ?', [symbol]);
    await db.execute('DELETE FROM trailing_stops WHERE symbol = ?', [symbol]).catch(() => {});
    entryPrices.delete(symbol);
    console.log(`[entry] Deleted history for ${symbol}`);
    res.json({ ok: true, deleted: symbol });
  } catch (e) {
    console.error('[entry] Delete error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/historical-basis — cash-flow cost basis for all coins with trade history
app.get('/api/historical-basis', async (req, res) => {
  try {
    const [flows] = await db.execute(
      `SELECT symbol, flow_type, SUM(cash_amount) as total_cash, SUM(token_quantity) as total_tokens
       FROM coin_cash_flows GROUP BY symbol, flow_type`
    );
    const bySymbol = {};
    for (const f of flows) {
      if (!bySymbol[f.symbol]) bySymbol[f.symbol] = { buy: 0, sell: 0 };
      bySymbol[f.symbol][f.flow_type] = parseFloat(f.total_cash);
    }
    const out = {};
    for (const [sym, data] of Object.entries(bySymbol)) {
      const symbol  = sym + '-USD';
      const qty     = parseFloat(previousBalances.get(symbol) || 0);
      const netDep  = data.buy - data.sell;
      const basis   = qty > 0 ? netDep / qty : null;
      if (basis !== null && basis > 0) {
        out[sym] = { historical_basis: parseFloat(basis.toFixed(6)), net_deployed: parseFloat(netDep.toFixed(2)), total_cash_in: parseFloat(data.buy.toFixed(2)), total_cash_out: parseFloat(data.sell.toFixed(2)) };
      }
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/entryprices/detail — full cost basis data including original entry and cycle count
app.get('/api/entryprices/detail', async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT symbol, entry_price, original_entry_price, original_entry_date, cycle_count, last_sold_price, last_sold_at, updated_at FROM entry_prices'
    );
    const out = {};
    for (const r of rows) {
      out[r.symbol] = {
        entry_price:           parseFloat(r.entry_price),
        original_entry_price:  r.original_entry_price ? parseFloat(r.original_entry_price) : parseFloat(r.entry_price),
        original_entry_date:   r.original_entry_date,
        cycle_count:           parseInt(r.cycle_count || 0),
        last_sold_price:       r.last_sold_price ? parseFloat(r.last_sold_price) : null,
        last_sold_at:          r.last_sold_at || null,
        updated_at:            r.updated_at,
      };
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/claude-usage — Claude API call history and cost summary
app.get('/api/claude-usage', async (req, res) => {
  const [rows] = await db.execute(
    `SELECT reason, model, input_tokens as inputTokens,
     output_tokens as outputTokens, cache_read_tokens as cacheReadTokens,
     estimated_cost, created_at FROM claude_api_calls
     ORDER BY created_at DESC LIMIT 50`
  ).catch(() => [[]]);

  const today = new Date().toDateString();
  const todayCalls = rows.filter(r => new Date(r.created_at).toDateString() === today);

  res.json({
    recent_calls: rows,
    calls_today: todayCalls.length,
    today_cost:  todayCalls.reduce((s, r) => s + parseFloat(r.estimated_cost || 0), 0),
    month_cost:  rows.reduce((s, r) => s + parseFloat(r.estimated_cost || 0), 0),
  });
});

// POST /api/entryprices/:symbol — set average entry price (manual override, never cycle)
app.post('/api/entryprices/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const { entry_price } = req.body;
  if (!entry_price || entry_price <= 0) return res.status(400).json({ error: 'entry_price must be > 0' });
  await updateEntryPrice(symbol, parseFloat(entry_price), false);
  res.json({ ok: true, symbol, entry_price });
});

// GET /api/sweep/config — USDT sweep configuration for dashboard
app.get('/api/sweep/config', async (req, res) => {
  try {
    const [rows] = await db.execute("SELECT config_value FROM system_config WHERE config_key = 'usdt_sweep_config'");
    const cfg = rows.length ? JSON.parse(rows[0].config_value) : { enabled: false, sweep_pct: 25, min_trade_value_usd: 10 };
    // Add current USDT balance as usdt_reserve so dashboard can show it
    const usdtBal = lastKnownUSDT || 0;
    res.json({ ...cfg, usdt_reserve: usdtBal });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sweep/config — save USDT sweep configuration
app.post('/api/sweep/config', async (req, res) => {
  try {
    const { enabled, sweep_pct, min_trade_value_usd, excluded_symbols } = req.body;
    const [existing] = await db.execute("SELECT config_value FROM system_config WHERE config_key = 'usdt_sweep_config'");
    const current = existing.length ? JSON.parse(existing[0].config_value) : {};
    const updated = { ...current, enabled: enabled !== false, sweep_pct: sweep_pct || 25, min_trade_value_usd: min_trade_value_usd || 10, excluded_symbols: excluded_symbols || current.excluded_symbols || [] };
    await db.execute("INSERT INTO system_config (config_key, config_value) VALUES ('usdt_sweep_config', ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)", [JSON.stringify(updated)]);
    res.json({ ok: true, config: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/thresholds — all custom daily thresholds
app.get('/api/thresholds', (req, res) => {
  res.json({ customThresholds, defaultThreshold: PUMP_THRESHOLD });
});

// GET /api/activity — trading journal feed for dashboard activity tab
// NOTE: LIMIT uses template literal, NOT a bound parameter — MySQL2 throws
// ER_WRONG_ARGUMENTS when an integer is passed as a bound param to LIMIT.
app.get('/api/activity', async (req, res) => {
  try {
    const filter = req.query.filter || 'all';
    const limit  = Math.min(parseInt(req.query.limit) || 50, 100);
    const validFilters = ['buy','sell','payment','transfer','sweep','rebalance'];

    let query;
    const params = [];

    if (filter !== 'all' && validFilters.includes(filter)) {
      query = `
        SELECT id, symbol, action, price, quantity, value_usd,
               reasoning, emotion, claude_recommendation,
               outcome_pnl, outcome_notes, source, created_at
        FROM trading_journal
        WHERE action = ?
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
      params.push(filter);
    } else {
      query = `
        SELECT id, symbol, action, price, quantity, value_usd,
               reasoning, emotion, claude_recommendation,
               outcome_pnl, outcome_notes, source, created_at
        FROM trading_journal
        ORDER BY created_at DESC
        LIMIT ${limit}
      `;
    }

    const [trades] = await db.execute(query, params);
    console.log(`[activity] Returning ${trades.length} trades (filter=${filter})`);
    res.json({ ok: true, trades: trades || [], total: trades?.length || 0 });
  } catch (e) {
    console.error('[activity] Error:', e.code, e.message);
    res.status(500).json({ ok: false, error: e.message, code: e.code });
  }
});

// GET /api/ping-activity — dead-simple liveness check for activity endpoint
app.get('/api/ping-activity', (req, res) => {
  res.json({ ok: true, message: 'activity endpoint alive' });
});

// GET /api/debug/usdt-payments — show all USDT/USD journal entries for debugging
app.get('/api/debug/usdt-payments', async (req, res) => {
  try {
    const [rows] = await db.execute(
      `SELECT id, symbol, action, quantity, value_usd, source, reasoning, created_at
       FROM trading_journal
       WHERE symbol IN ('USDT','USD','USDT-USD','USD-USD')
       ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ ok: true, count: rows.length, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/activity-debug — step-by-step DB diagnostics for activity feed failures
app.get('/api/activity-debug', async (req, res) => {
  const results = {};
  try {
    await db.execute('SELECT 1 as ok');
    results.db_connection = 'ok';
  } catch (e) { results.db_connection = e.message; return res.json(results); }
  try {
    const [tables] = await db.execute(
      `SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_journal'`
    );
    results.table_exists = tables.length > 0;
  } catch (e) { results.table_check = e.message; }
  try {
    const [cols] = await db.execute(
      `SELECT COLUMN_NAME, DATA_TYPE FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trading_journal'
       ORDER BY ORDINAL_POSITION`
    );
    results.columns = cols.map(c => `${c.COLUMN_NAME} (${c.DATA_TYPE})`);
  } catch (e) { results.columns_check = e.message; }
  try {
    const [count] = await db.execute('SELECT COUNT(*) as total FROM trading_journal');
    results.row_count = count[0].total;
  } catch (e) { results.count_check = e.message; }
  try {
    const [one] = await db.execute('SELECT * FROM trading_journal LIMIT 1');
    results.sample_row = one[0] ? Object.keys(one[0]) : 'no rows';
  } catch (e) { results.sample_check = e.message; }
  res.json(results);
});

// GET /api/debug/balance-check — show current vs cached balances to debug detection gaps
app.get('/api/debug/balance-check', async (req, res) => {
  try {
    const balances = await revolutRequest('GET', '/balances');
    const result = [];
    for (const asset of balances) {
      const sym = `${asset.currency}-USD`;
      const currentQty = parseFloat(asset.available || 0);
      const prevQty    = previousBalances.get(sym) ?? null;
      const change     = prevQty !== null ? currentQty - prevQty : null;
      const price      = SKIP_CURRENCIES.includes(asset.currency) ? 1 : (basePrices[sym] || null);
      const valueUsd   = change !== null && price ? Math.abs(change) * price : null;
      result.push({
        symbol:        sym,
        current:       currentQty,
        previous:      prevQty,
        change:        change,
        value_usd:     valueUsd ? parseFloat(valueUsd.toFixed(2)) : null,
        would_detect:  change !== null && Math.abs(change) > 0.0001 && (valueUsd === null || valueUsd >= 0.10),
        in_skip_list:  SKIP_CURRENCIES.includes(asset.currency),
      });
    }
    res.json({
      ok:        true,
      timestamp: new Date().toISOString(),
      check_count: portfolioCheckCount,
      all_balances: result,
      changed:   result.filter(r => r.change !== null && Math.abs(r.change) > 0.0001),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

  // ── Tool: research_asset (#72) ──────────────────────────────────────────────
  server.tool('research_asset', 'Deep web research on one asset evaluated against its saved plan — fundamentals, catalysts, news, price-vs-thesis, and a plan-drift verdict. Recommends only, never executes. On-demand (costs an API web-search call).',
    {
      symbol: z.string().describe('Asset to research, e.g. NEAR or NEAR-USD'),
    },
    async ({ symbol } = {}) => {
      if (!symbol) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Provide symbol' }) }] };
      try {
        const result = await researchAsset(symbol);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }] };
      }
    }
  );

  server.tool('get_prices', 'Get current crypto price(s). Pass symbol for one, or symbols[] for many in a single call.',
    {
      symbol:  z.string().optional().describe('Single trading pair e.g. BTC-USD'),
      symbols: z.array(z.string()).optional().describe('Multiple trading pairs e.g. ["BTC-USD","ENA-USD"] — batched in one call'),
    },
    async ({ symbol, symbols } = {}) => {
      const raw = (symbols && symbols.length) ? symbols : (symbol ? [symbol] : []);
      if (!raw.length) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Provide symbol or symbols[]' }) }] };
      }
      const norm = raw.map(s => s.toUpperCase().includes('-USD') ? s.toUpperCase() : s.toUpperCase() + '-USD');

      // Fetch the full Revolut ticker list ONCE, map all requested symbols against it
      const priceMap = {};
      try {
        const tickerResponse = await revolutRequest('GET', '/tickers');
        const tickerList = Array.isArray(tickerResponse) ? tickerResponse : (tickerResponse.data || []);
        for (const t of tickerList) {
          if (!t.symbol) continue;
          const p = parseFloat(t.last_price || t.mid || t.ask || t.bid);
          if (p) priceMap[t.symbol.replace('/', '-').toUpperCase()] = p;
        }
      } catch (e) { /* fall through to per-symbol */ }

      const results = {};
      for (const sym of norm) {
        let price = priceMap[sym] || null;
        if (price === null) {
          // Kraken fallback for symbols not on Revolut (GHIBLI, XPL, TAO, etc.)
          price = await getCurrentPrice(sym).catch(() => null);
        }
        results[sym] = price !== null && price !== undefined
          ? { price, source: priceMap[sym] ? 'revolut' : 'kraken' }
          : { error: 'unavailable' };
      }

      // Single-symbol call: preserve the original flat response shape
      if (norm.length === 1 && !(symbols && symbols.length)) {
        const only = results[norm[0]];
        return { content: [{ type: 'text', text: JSON.stringify(
          only.error ? { symbol: norm[0], error: 'Price unavailable from Revolut X or Kraken' }
                     : { symbol: norm[0], price: only.price, source: 'live' }
        ) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify({ prices: results }) }] };
    }
  );

  // ── Tool: get_portfolio_data ──────────────────────────────────────────────
  server.tool('get_portfolio_data',
    'Get complete portfolio data across all accounts — Revolut X balances and P&L, Kraken balances, and Tangem XRP wallet',
    {
      accounts: z.array(z.enum(['revolut', 'kraken', 'tangem', 'all'])).optional()
        .describe('Which accounts to fetch — defaults to all'),
    },
    async ({ accounts } = {}) => {
      const fetch = accounts || ['all'];
      const fetchAll = fetch.includes('all');
      const result = {};

      if (fetchAll || fetch.includes('revolut')) {
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
          let totalValue = 0;
          const positions = [];
          const [epDetailRows] = await db.execute(
            'SELECT symbol, entry_price, original_entry_price, cycle_count, original_entry_date FROM entry_prices'
          ).catch(() => [[]]);
          const epDetail = {};
          for (const r of epDetailRows) epDetail[r.symbol] = r;
          for (const asset of balances) {
            if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
            const qty = parseFloat(asset.available);
            if (qty <= 0) continue;
            const sym = `${asset.currency}-USD`;
            const price = priceMap[sym] || null;
            const valueUsd = price ? qty * price : null;
            if (valueUsd) totalValue += valueUsd;
            const entry = entryPrices.get(sym) || null;
            const ep = epDetail[sym];
            const originalEntry = ep?.original_entry_price ? parseFloat(ep.original_entry_price) : entry;
            const cycleCount = parseInt(ep?.cycle_count || 0);
            const plPct = entry && price ? ((price - entry) / entry * 100).toFixed(2) : null;
            const historicalPlPct = originalEntry && price ? ((price - originalEntry) / originalEntry * 100).toFixed(2) : null;
            positions.push({
              symbol: sym, currency: asset.currency, quantity: qty, price,
              value_usd: valueUsd?.toFixed(2),
              entry_price: entry, pl_pct: plPct,
              original_entry_price: originalEntry, historical_pl_pct: historicalPlPct,
              cycle_count: cycleCount
            });
          }
          positions.sort((a, b) => (parseFloat(b.value_usd) || 0) - (parseFloat(a.value_usd) || 0));

          // Surface USDT/USD cash without adding to crypto positions[]
          var revolutUsdt = 0, revolutUsd = 0;
          for (var i = 0; i < balances.length; i++) {
            var cashCurrency = balances[i].currency;
            var cashAmt = parseFloat(balances[i].available || 0);
            if (cashCurrency === 'USDT' || cashCurrency === 'USDC') revolutUsdt += cashAmt;
            else if (cashCurrency === 'USD') revolutUsd += cashAmt;
          }
          var revolutCash = revolutUsdt + revolutUsd;

          const cap = getCapitalSummary(totalValue);
          result.revolut = {
            total_value_usd: totalValue.toFixed(2),        // crypto-only (backward-compat)
            usdt_balance: revolutUsdt.toFixed(2),
            usd_balance: revolutUsd.toFixed(2),
            cash_balance: revolutCash.toFixed(2),
            total_with_cash_usd: (totalValue + revolutCash).toFixed(2),
            invested: cap.invested,
            pl_usd: cap.pnl.toFixed(2),
            pl_pct: cap.pnlPct.toFixed(2),
            positions
          };
        } catch (e) { result.revolut = { error: e.message }; }
      }

      if (fetchAll || fetch.includes('kraken')) {
        try {
          result.kraken = await getKrakenBalances();
        } catch (e) { result.kraken = { error: e.message }; }
      }

      if (fetchAll || fetch.includes('tangem')) {
        try {
          const xrpBalance = await getTangemXRPBalance();
          const xrpPrice   = await getCurrentPrice('XRP-USD');
          const valueUSD   = xrpBalance && xrpPrice ? xrpBalance * xrpPrice : null;
          const unrealisedPnlPct = xrpPrice ? ((xrpPrice - TANGEM_XRP_ENTRY) / TANGEM_XRP_ENTRY * 100) : null;
          result.tangem = { address: TANGEM_XRP_ADDRESS, asset: 'XRP', balance: xrpBalance, price: xrpPrice, valueUSD: valueUSD?.toFixed(2), entryPrice: TANGEM_XRP_ENTRY, unrealisedPnlPct: unrealisedPnlPct?.toFixed(2) };
        } catch (e) { result.tangem = { error: e.message }; }
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Tool: get_trading_data ─────────────────────────────────────────────────
  server.tool('get_trading_data',
    'Get trading journal entries, active alerts, trader context/profile, rebalancing history, and dev_bridge messages',
    {
      include: z.array(z.enum(['journal', 'alerts', 'context', 'rebalancing', 'dev_log', 'dev_bridge', 'coin_strategy', 'reconciliation', 'all'])).optional()
        .describe('What data to fetch — defaults to all. dev_bridge, coin_strategy and reconciliation are never included in all; request them explicitly'),
      symbol:           z.string().optional().describe('Filter journal by coin e.g. NEAR'),
      limit:            z.number().optional().describe('Max journal entries to return, default 10'),
      bridge_id:        z.number().optional().describe('Fetch a specific dev_bridge row by id'),
      ref_devlog_id:    z.number().optional().describe('Filter dev_bridge by referenced dev_log id'),
      include_consumed: z.boolean().optional().describe('Include consumed dev_bridge rows (default false)'),
      mark_consumed:    z.boolean().optional().describe('Mark returned dev_bridge rows consumed (default false)'),
    },
    async ({ include, symbol, limit, bridge_id, ref_devlog_id, include_consumed, mark_consumed } = {}) => {
      const fetch = include || ['all'];
      const fetchAll = fetch.includes('all');
      const limitInt = parseInt(limit) || 10;
      const result = {};

      if (fetchAll || fetch.includes('journal')) {
        try {
          let rows;
          if (symbol) {
            const coinBase = symbol.replace('-USD', '').toUpperCase();
            [rows] = await db.execute(
              'SELECT * FROM trading_journal WHERE symbol = ? ORDER BY created_at DESC LIMIT ' + limitInt,
              [coinBase]
            );
          } else {
            [rows] = await db.execute('SELECT * FROM trading_journal ORDER BY created_at DESC LIMIT ' + limitInt);
          }
          result.journal = rows;
        } catch (e) { result.journal = { error: e.message }; }
      }

      if (fetchAll || fetch.includes('alerts')) {
        result.alerts = {
          daily_thresholds:    Object.entries(customThresholds).map(([sym, thr]) => ({ symbol: sym, threshold_pct: (thr * 100).toFixed(1) })),
          fixed_price_targets: [...priceTargets.entries()].map(([sym, t]) => ({ symbol: sym, direction: t.direction, anchor: t.anchorPrice, target: t.targetPrice, threshold_pct: t.thresholdPct })),
          trailing_stops:      [...trailingStops.entries()].map(([sym, ts]) => ({ symbol: sym, trail_pct: ts.trailPct, peak_price: ts.peakPrice, stop_price: ts.stopPrice, entry_price: ts.entryPrice })),
          active_pump_alerts:  [...alertState.active.keys()],
          active_drop_alerts:  [...activeDropAlerts.keys()],
          acknowledged:        [...alertState.acknowledged].filter(s => !ignoredCoins.has(s)),
          permanently_ignored: [...ignoredCoins],
        };
      }

      if (fetchAll || fetch.includes('context')) {
        try {
          const [profileRows]   = await db.execute('SELECT preference_key, preference_value FROM trader_profile');
          const [recentTrades]  = await db.execute('SELECT * FROM trading_journal ORDER BY created_at DESC LIMIT 5');
          const [intentionRows] = await db.execute('SELECT * FROM intention_tracking ORDER BY intention_date DESC LIMIT 3');
          const [tradeIntentions] = await db.execute('SELECT * FROM trade_intentions WHERE matched_at IS NULL AND expires_at > NOW() ORDER BY stated_at DESC LIMIT 5');
          const [statsRows]     = await db.execute(
            'SELECT COUNT(*) AS total_completed, SUM(CASE WHEN outcome_pnl > 0 THEN 1 ELSE 0 END) AS wins FROM trading_journal WHERE outcome_pnl IS NOT NULL'
          );
          const stats = statsRows[0] || {};
          const totalCompleted = parseInt(stats.total_completed || 0);
          const wins = parseInt(stats.wins || 0);
          const winRate = totalCompleted > 0 ? ((wins / totalCompleted) * 100).toFixed(1) + '%' : 'n/a';
          result.context = { traderProfile: profileRows, recentTrades, learningModel: learningModelCache || 'Not yet generated', investedCapital: totalInvestedCapital, recentIntentions: intentionRows, pendingTradeIntentions: tradeIntentions, tradingStats: { totalCompleted, winRate } };
        } catch (e) { result.context = { error: e.message }; }
      }

      if (fetchAll || fetch.includes('rebalancing')) {
        try {
          const [rows]  = await db.execute('SELECT * FROM rebalancing_tracker ORDER BY rebalance_date DESC LIMIT ' + limitInt);
          const [stats] = await db.execute(`SELECT COUNT(*) as total, SUM(CASE WHEN outcome = 'good' THEN 1 ELSE 0 END) as good, AVG(pnl_7d) as avg_pnl_7d FROM rebalancing_tracker WHERE outcome IS NOT NULL`);
          const s = stats[0];
          result.rebalancing = { history: rows, accuracy: s.total > 0 ? Math.round(s.good / s.total * 100) + '%' : 'No completed rebalances yet', stats: s };
        } catch (e) { result.rebalancing = { error: e.message }; }
      }

      if (fetchAll || fetch.includes('dev_log')) {
        try {
          // #84 fix: always return ALL open/in_progress + last 20 resolved — no artificial cap on live board
          const [openRows] = await db.execute(
            `SELECT id, created_at, updated_at, source, category, status, title, detail, related_symbol, resolved_at
             FROM dev_log
             WHERE status IN ('open', 'in_progress')
             ORDER BY created_at DESC`
          );
          const [resolvedRows] = await db.execute(
            `SELECT id, created_at, updated_at, source, category, status, title, detail, related_symbol, resolved_at
             FROM dev_log
             WHERE status = 'resolved'
             ORDER BY resolved_at DESC, updated_at DESC
             LIMIT 20`
          );
          result.dev_log = [
            ...openRows,
            ...resolvedRows
          ];
        } catch (e) { result.dev_log = { error: e.message }; }

        // #105 Dev-side: decision-memory layer + "since last session" digest (mirrors pm_decisions)
        try {
          const [devDecRows] = await db.execute(
            "SELECT id, created_at, decision, reasoning, principle_tag, cross_thread, alternatives_rejected, related_dev_log, status, supersedes_id, captured_by FROM dev_decisions WHERE status IN ('active','revisited') ORDER BY created_at DESC LIMIT 25"
          );
          let devDecLastSeen = null;
          try {
            const [lsRows] = await db.execute("SELECT config_value FROM system_config WHERE config_key = 'dev_decisions_last_seen'");
            if (lsRows.length) devDecLastSeen = lsRows[0].config_value;
          } catch (e) { /* first run */ }
          const devDecisionsSinceLastSession = devDecLastSeen
            ? devDecRows.filter(r => new Date(r.created_at) > new Date(devDecLastSeen))
            : devDecRows.filter(r => r.captured_by === 'auto');
          await db.execute(
            "INSERT INTO system_config (config_key, config_value) VALUES ('dev_decisions_last_seen', ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)",
            [new Date().toISOString()]
          ).catch(() => {});
          result.dev_decisions = devDecRows;
          result.dev_decisions_digest = devDecisionsSinceLastSession;
        } catch (e) { result.dev_decisions = { error: e.message }; }
      }

      // dev_bridge — explicitly excluded from fetchAll; must be requested by name
      if (fetch.includes('dev_bridge')) {
        try {
          const bridgeLim = 20; // small fixed cap; bridge payloads can be large
          const where = [];
          const params = [];
          if (bridge_id)     { where.push('id = ?');            params.push(bridge_id); }
          if (ref_devlog_id) { where.push('ref_devlog_id = ?'); params.push(ref_devlog_id); }
          if (!include_consumed && !bridge_id) { where.push('consumed = 0'); }
          const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
          // LIMIT uses template literal — MySQL rejects bound LIMIT params (ER_WRONG_ARGUMENTS)
          const [bridgeRows] = await db.execute(
            `SELECT id, type, ref_devlog_id, payload, consumed, created_at FROM dev_bridge ${whereClause} ORDER BY id DESC LIMIT ${bridgeLim}`,
            params
          );
          if (mark_consumed && bridgeRows.length) {
            const ids = bridgeRows.map(r => r.id);
            await db.execute(
              `UPDATE dev_bridge SET consumed = 1, consumed_at = CURRENT_TIMESTAMP WHERE id IN (${ids.map(() => '?').join(',')})`,
              ids
            );
          }
          result.dev_bridge = { count: bridgeRows.length, rows: bridgeRows };
        } catch (e) { result.dev_bridge = { error: e.message }; }
      }

      // coin_strategy -- explicitly excluded from fetchAll; must be requested by name
      if (fetch.includes('coin_strategy')) {
        try {
          const csQ = symbol
            ? ['SELECT * FROM coin_strategy WHERE symbol = ?', [symbol.toUpperCase().replace('-USD','')]]
            : ['SELECT * FROM coin_strategy ORDER BY symbol', []];
          const [csRows] = await db.execute(csQ[0], csQ[1]);
          result.coin_strategy = csRows;
        } catch (e) { result.coin_strategy = { error: e.message }; }
      }

      // reconciliation -- explicitly excluded from fetchAll; must be requested by name
      if (fetch.includes('reconciliation')) {
        try {
          const [recRows] = await db.execute(
            `SELECT symbol, exchange, exchange_qty, system_qty, drift_pct, drift_type, acknowledged, run_date
             FROM reconciliation_log ORDER BY run_date DESC LIMIT 50`
          );
          result.reconciliation = recRows;
        } catch (e) { result.reconciliation = { error: e.message }; }
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Tool: manage_alerts ────────────────────────────────────────────────────
  server.tool('manage_alerts',
    'Set or manage all alert types — fixed price targets, daily thresholds, trailing stops, acknowledge, ignore or unignore coins',
    {
      action:        z.enum(['set_target', 'set_threshold', 'set_trailing', 'acknowledge', 'ignore', 'unignore', 'remove_trailing', 'remove_target', 'remove_threshold']).describe('What alert action to perform'),
      symbol:        z.string().describe('Trading pair e.g. NEAR-USD or NEAR'),
      direction:     z.enum(['up', 'down']).optional().describe('Alert direction for set_target'),
      threshold_pct: z.number().optional().describe('Percentage for set_target or set_threshold'),
      anchor_price:  z.number().optional().describe('Anchor price for set_target'),
      trail_pct:     z.number().optional().describe('Trailing percentage e.g. 10 for 10%'),
      current_price: z.number().optional().describe('Manual price override for set_trailing — useful for Kraken-only coins if auto-fetch fails'),
      target_price:  z.number().optional().describe('For remove_target — remove only the rung at this exact target price; omit to remove ALL targets for the symbol'),
      description:   z.string().optional().describe('For set_target -- human note stored on the rung, surfaced when the alert fires'),
    },
    async ({ action, symbol, direction, threshold_pct, anchor_price, trail_pct, current_price, target_price, description }) => {
      const sym      = symbol.includes('-USD') ? symbol.toUpperCase() : `${symbol.toUpperCase()}-USD`;
      const coinBase = sym.replace('-USD', '');
      let result = {};

      if (action === 'set_target') {
        let dir = direction || 'up';
        let r;
        if (anchor_price) {
          const targetPrice = dir === 'down'
            ? anchor_price * (1 - threshold_pct / 100)
            : anchor_price * (1 + threshold_pct / 100);
          const impliedDirM = targetPrice >= anchor_price ? 'up' : 'down';
          if (dir !== impliedDirM) {
            console.log(`[targets] ${sym} direction auto-corrected ${dir} -> ${impliedDirM} (target ${targetPrice} vs anchor ${anchor_price})`);
            dir = impliedDirM;
          }
          await db.execute(
            'INSERT INTO price_targets (symbol, anchor_price, threshold_pct, target_price, direction, note) VALUES (?, ?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE anchor_price=VALUES(anchor_price), threshold_pct=VALUES(threshold_pct), target_price=VALUES(target_price), direction=VALUES(direction), note=VALUES(note), updated_at=CURRENT_TIMESTAMP',
            [sym, anchor_price, threshold_pct, targetPrice, dir, description ?? null]
          );
          upsertPriceTarget(sym, { anchorPrice: anchor_price, thresholdPct: threshold_pct, targetPrice, direction: dir, note: description ?? null }); // #38 B2
          alertState.acknowledged.delete(sym);
          r = { anchorPrice: anchor_price, targetPrice, direction: dir };
        } else {
          r = await setFixedTarget(sym, threshold_pct, dir, description ?? null);
        }
        result = { ok: true, action: 'set_target', symbol: sym, ...r, description: description ?? null, message: `Alert set — fires when ${sym} ${dir === 'down' ? 'drops to' : 'hits'} $${r.targetPrice?.toFixed(6)}` };

      } else if (action === 'set_threshold') {
        const { oldThreshold, newThreshold } = await setThreshold(sym, threshold_pct / 100);
        result = { ok: true, action: 'set_threshold', symbol: sym, old_threshold_pct: (oldThreshold * 100).toFixed(1), new_threshold_pct: (newThreshold * 100).toFixed(1) };

      } else if (action === 'set_trailing') {
        // Use manual override first, then Revolut X, then Kraken fallback
        let resolvedPrice = current_price || await getCurrentPrice(sym);
        if (!resolvedPrice) {
          return { content: [{ type: 'text', text: JSON.stringify({
            ok: false,
            error: `No price found for ${sym} on Revolut X or Kraken`,
            hint: 'Pass current_price parameter manually to override (e.g. current_price: 0.0012)'
          }) }] };
        }
        const entryPrice = entryPrices.get(sym) || null;
        const r = await setTrailingStop(sym, trail_pct, resolvedPrice, entryPrice);
        result = { ok: true, action: 'set_trailing', symbol: sym, trail_pct, peak_price: r.peakPrice, stop_price: r.stopPrice, current_price: resolvedPrice, message: `Trailing stop set — alerts if ${sym} drops ${trail_pct}% from any peak` };

      } else if (action === 'acknowledge') {
        await acknowledgeAlert(sym);
        result = { ok: true, action: 'acknowledge', symbol: sym, message: `All alerts stopped for ${coinBase} this session` };

      } else if (action === 'ignore') {
        await ignoreCoin(sym);
        result = { ok: true, action: 'ignore', symbol: sym, message: `${coinBase} permanently ignored` };

      } else if (action === 'unignore') {
        await resumeAlerts(sym);
        result = { ok: true, action: 'unignore', symbol: sym, message: `${coinBase} alerts re-enabled — removed from ignored list` };

      } else if (action === 'remove_trailing') {
        await removeTrailingStop(sym);
        result = { ok: true, action: 'remove_trailing', symbol: sym, message: `Trailing stop removed for ${coinBase}` };

      } else if (action === 'remove_target') {
        const hadTarget = priceTargets.has(sym);
        const removedOne = await removeFixedTarget(sym, target_price);
        let msg;
        if (target_price !== undefined && target_price !== null) {
          msg = removedOne ? `Removed ${coinBase} target at ${target_price}` : `No ${coinBase} target found at ${target_price} — nothing removed`;
        } else {
          msg = hadTarget ? `All price targets removed for ${coinBase}` : `No active target for ${coinBase} — any DB row cleared`;
        }
        result = { ok: true, action: 'remove_target', symbol: sym, message: msg };

      } else if (action === 'remove_threshold') {
        const hadThreshold = customThresholds[sym] !== undefined;
        await removeThreshold(sym);
        result = { ok: true, action: 'remove_threshold', symbol: sym, message: hadThreshold ? `Custom threshold removed for ${coinBase} — reverts to default` : `No custom threshold for ${coinBase} — any DB row cleared` };
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Tool: manage_trading ───────────────────────────────────────────────────
  server.tool('manage_trading',
    'Log journal entries, trade intentions, trader preferences, update invested capital, or configure USDT sweep',
    {
      action:                 z.enum(['log_journal', 'log_intention', 'save_preference', 'update_capital', 'configure_sweep', 'configure_auto_execute', 'log_dev_issue', 'update_session_state', 'upsert_coin_strategy', 'export_dev_log', 'log_research', 'log_pm_decision', 'log_dev_decision']).describe('What trading action to perform'),
      symbol:                 z.string().optional().describe('Coin e.g. NEAR-USD or NEAR'),
      trade_action:           z.enum(['buy', 'sell', 'hold', 'add', 'reduce', 'payment', 'transfer']).optional().describe('Trade action for log_journal or log_intention'),
      price:                  z.number().optional().describe('Price for log_journal'),
      quantity:               z.number().optional().describe('Quantity for log_journal'),
      reasoning:              z.string().optional().describe('Why the trade was or will be made'),
      emotion:                z.enum(['confident', 'uncertain', 'fomo', 'fearful', 'neutral']).optional().describe('Emotional state'),
      followed_recommendation: z.boolean().optional().describe('Whether Claude recommendation was followed'),
      expires_hours:          z.number().optional().describe('Hours until intention expires, default 24'),
      key:                    z.string().optional().describe('Preference key for save_preference'),
      value:                  z.string().optional().describe('Preference value for save_preference'),
      amount:                 z.number().optional().describe('Amount in USD for update_capital'),
      capital_type:           z.enum(['deposit', 'withdrawal', 'set']).optional().describe('Capital update type'),
      note:                   z.string().optional().describe('Optional note for update_capital'),
      enabled:                z.boolean().optional().describe('Enable or disable USDT sweep (configure_sweep)'),
      sweep_pct:              z.number().optional().describe('Percentage of sell proceeds to sweep to USDT (configure_sweep)'),
      min_trade_value_usd:    z.number().optional().describe('Minimum sell value in USD to trigger sweep (configure_sweep)'),
      excluded_symbols:       z.array(z.string()).optional().describe('Symbols to exclude from sweep e.g. ["USDT-USD"] (configure_sweep)'),
      max_sell_pct:           z.number().optional().describe('Max % of position to sell per auto-exec trade (configure_auto_execute)'),
      max_buy_usd:            z.number().optional().describe('Max USD to spend per auto-exec buy (configure_auto_execute)'),
      allowed_triggers:       z.array(z.string()).optional().describe('Alert types that can trigger auto-exec: trailing_stop, fixed_target, pump_alert'),
      require_confidence:     z.enum(['High', 'Medium', 'Low']).optional().describe('Minimum Claude confidence level to auto-execute'),
      cooldown_minutes:       z.number().optional().describe('Minutes to wait between auto-executions for same coin'),
      hodl_symbols:           z.array(z.string()).optional().describe('Coins where AI analyses only and never auto-executes — Bryan decides. e.g. ["ENA","INJ","ALGO"]'),
      title:                  z.string().optional().describe('Title for log_dev_issue (required when creating)'),
      detail:                 z.string().optional().describe('Detail/description for log_dev_issue'),
      category:               z.string().optional().describe('Category for log_dev_issue e.g. bug, feature, note'),
      status:                 z.string().optional().describe('Status for log_dev_issue: open, in_progress, resolved'),
      source:                 z.string().optional().describe('Source author for log_dev_issue, defaults to developer'),
      related_symbol:         z.string().optional().describe('Related coin symbol for log_dev_issue e.g. NEAR'),
      dev_log_id:             z.number().optional().describe('Dev log row id to update (omit to create new)'),
      active_workstream:      z.string().optional().describe('Current active workstream for update_session_state'),
      progress:               z.any().optional().describe('Progress object for update_session_state'),
      open_threads:           z.any().optional().describe('Open threads array for update_session_state'),
      next_action:            z.string().optional().describe('Next recommended action for update_session_state'),
      recent_decision:        z.string().optional().describe('Single new decision to prepend to recent_decisions list (update_session_state)'),
      recent_decisions:       z.array(z.string()).optional().describe('Full recent_decisions array replacement, capped at 5 (update_session_state)'),
      cs_status:            z.string().optional().describe('upsert_coin_strategy: active_holding|dust|watchlist|exited|radar'),
      cs_role:              z.string().optional().describe('upsert_coin_strategy: anchor|swing|hodl|lotto|watch_entry|radar|dead_bag'),
      cs_theme:             z.string().optional().describe('upsert_coin_strategy: theme tags e.g. DTCC,L1,DeFi'),
      cs_strategy_md:       z.string().optional().describe('upsert_coin_strategy: freeform strategy notes'),
      pm_decision:          z.string().optional().describe('log_pm_decision: the decision text to record'),
      pm_principle_tag:     z.string().optional().describe('log_pm_decision: short tag e.g. position-sizing / risk-management'),
      pm_conviction:        z.enum(['high','medium','low']).optional().describe('log_pm_decision: conviction level'),
      pm_captured_by:       z.string().optional().describe('log_pm_decision: who captured this — claude / manual'),
      pm_supersedes_id:     z.number().optional().describe('log_pm_decision: id of an older decision this replaces'),
      dev_decision:         z.string().optional().describe('log_dev_decision: the design decision/call made'),
      dev_principle_tag:    z.string().optional().describe('log_dev_decision: durable tag e.g. safety / phased-builds / never-sell-below-entry'),
      dev_cross_thread:     z.boolean().optional().describe('log_dev_decision: true if this principle spans PM+Dev'),
      dev_alternatives:     z.string().optional().describe('log_dev_decision: alternatives considered + rejected + why'),
      dev_related_log:      z.string().optional().describe('log_dev_decision: dev_log ticket(s) it governs e.g. "#95,#45"'),
      dev_supersedes_id:    z.number().optional().describe('log_dev_decision: id of an older decision this replaces'),
    },
    async ({ action, symbol, trade_action, price, quantity, reasoning, emotion, followed_recommendation, expires_hours, key, value, amount, capital_type, note, enabled, sweep_pct, min_trade_value_usd, excluded_symbols, max_sell_pct, max_buy_usd, allowed_triggers, require_confidence, cooldown_minutes, hodl_symbols: hodlSymbolsParam, title, detail, category, status: devStatus, source: devSource, related_symbol: relSymbol, dev_log_id, active_workstream, progress, open_threads, next_action, recent_decision, recent_decisions, cs_status, cs_role, cs_theme, cs_strategy_md, pm_decision, pm_principle_tag, pm_conviction, pm_captured_by, pm_supersedes_id, dev_decision, dev_principle_tag, dev_cross_thread, dev_alternatives, dev_related_log, dev_supersedes_id }) => {
      // Make hodl_symbols accessible in configure_auto_execute via params object
      const params = { hodl_symbols: hodlSymbolsParam };

      if (action === 'log_journal') {
        const sym      = symbol?.includes('-USD') ? symbol.toUpperCase() : `${symbol?.toUpperCase()}-USD`;
        const coinBase = sym.replace('-USD', '');
        const valueUsd = quantity && price ? quantity * price : null;

        // Dedup guard: did autoLogTrade (or anything) already log this same trade recently?
        let existingId = null;
        try {
          const [dupe] = await db.execute(
            `SELECT id FROM trading_journal
             WHERE symbol IN (?, ?)
             AND action = ?
             AND ? IS NOT NULL
             AND ABS(CAST(quantity AS DECIMAL(20,8)) - ?) < 0.0001
             AND created_at > DATE_SUB(NOW(), INTERVAL 6 HOUR)
             ORDER BY created_at DESC
             LIMIT 1`,
            [coinBase, sym, trade_action,
             quantity ?? null, quantity ?? null]
          );
          if (dupe.length > 0) existingId = dupe[0].id;
        } catch (e) {
          console.error('[log_journal] dedup check error:', e.message);
          // on error, fall through to normal INSERT (fail open — never lose a trade)
        }

        if (existingId) {
          // Enrich the existing row instead of inserting a duplicate
          await db.execute(
            `UPDATE trading_journal
             SET reasoning = COALESCE(?, reasoning),
                 emotion = COALESCE(?, emotion),
                 followed_recommendation = COALESCE(?, followed_recommendation)
             WHERE id = ?`,
            [reasoning ?? null, emotion ?? null, followed_recommendation ?? null, existingId]
          );
          console.log('[log_journal] Enriched existing row ' + existingId + ' instead of inserting duplicate');
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, journal_id: existingId, enriched: true }) }] };
        }

        const [result] = await db.execute(
          'INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, followed_recommendation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [coinBase, trade_action, price, quantity ?? null, valueUsd, reasoning, emotion, followed_recommendation ?? null]
        );
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, journal_id: result.insertId, symbol: coinBase, action: trade_action, price }) }] };

      } else if (action === 'log_intention') {
        const sym         = symbol?.includes('-USD') ? symbol.toUpperCase() : `${symbol?.toUpperCase()}-USD`;
        const expiresHours = expires_hours || 24;
        await db.execute(
          'INSERT INTO trade_intentions (symbol, action, reasoning, emotion, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))',
          [sym, trade_action, reasoning, emotion || 'confident', expiresHours]
        );
        await sendTelegram(
          `🎯 <b>TRADE INTENTION LOGGED — ${sym.replace('-USD', '')}</b>\n\n` +
          `Action: ${trade_action?.toUpperCase()}\n` +
          `Reason: ${reasoning}\n` +
          `Emotion: ${emotion || 'confident'}\n` +
          `Expires: ${expiresHours}h\n\n` +
          `When you execute this trade it will auto-log without asking! ✅`
        );
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, symbol: sym, action: trade_action, reasoning, expires_hours: expiresHours, message: `Intention logged — will auto-match when trade executes within ${expiresHours}h` }) }] };

      } else if (action === 'save_preference') {
        await db.execute(
          'INSERT INTO trader_profile (preference_key, preference_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE preference_value = VALUES(preference_value), updated_at = CURRENT_TIMESTAMP',
          [key, value]
        );
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, key, value }) }] };

      } else if (action === 'update_capital') {
        const previous = totalInvestedCapital;
        let newTotal;
        if (capital_type === 'deposit')        newTotal = previous + amount;
        else if (capital_type === 'withdrawal') newTotal = previous - amount;
        else                                    newTotal = amount;
        await updateInvestedCapital(newTotal, note || `${capital_type}: $${amount}`);
        const portfolioValue = await getCurrentPortfolioValue();
        const cap = getCapitalSummary(portfolioValue);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, capital_type, previous_total: previous, new_total: newTotal, portfolio_value: portfolioValue.toFixed(2), pl_usd: cap.pnl.toFixed(2), pl_pct: cap.pnlPct.toFixed(2) }) }] };

      } else if (action === 'configure_sweep') {
        const sweepConfig = {
          enabled: enabled ?? true,
          sweep_pct: sweep_pct || 20,
          min_trade_value_usd: min_trade_value_usd || 50,
          applies_to: 'all',
          excluded_symbols: excluded_symbols || [],
          updated_at: new Date().toISOString(),
        };
        await db.execute(
          'INSERT INTO system_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)',
          ['usdt_sweep_config', JSON.stringify(sweepConfig)]
        );
        const excludedLine = sweepConfig.excluded_symbols.length > 0
          ? `\nExcluded: ${sweepConfig.excluded_symbols.join(', ')}`
          : '';
        await sendTelegram(
          `💰 <b>USDT SWEEP ${sweepConfig.enabled ? 'ENABLED' : 'DISABLED'}</b>\n\n` +
          `Sweep: ${sweepConfig.sweep_pct}% of sell proceeds\n` +
          `Min trade size: $${sweepConfig.min_trade_value_usd}\n` +
          `Applies to: all qualifying sells${excludedLine}`
        );
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, config: sweepConfig }) }] };

      } else if (action === 'configure_auto_execute') {
        // Preserve hodl_symbols from existing config if not provided in this call
        const [existingCfgRows] = await db.execute(
          "SELECT config_value FROM system_config WHERE config_key = 'ai_auto_execute'"
        ).catch(() => [[]]);
        const existingCfg = existingCfgRows.length ? JSON.parse(existingCfgRows[0].config_value) : {};

        const defaultHodl = ['ENA','JTO','RENDER','INJ','FET','ALGO','AVAX','ADA','HBAR','ILV','PYTH','SUPER','SEI','MOG','HFT','CRO','FLR','POL','XLM','BONK'];
        const config = {
          enabled: enabled ?? existingCfg.enabled ?? false,
          max_sell_pct: max_sell_pct || existingCfg.max_sell_pct || 25,
          max_buy_usd: max_buy_usd || existingCfg.max_buy_usd || 100,
          allowed_triggers: allowed_triggers || existingCfg.allowed_triggers || ['trailing_stop', 'fixed_target', 'pump_alert'],
          require_confidence: require_confidence || existingCfg.require_confidence || 'High',
          cooldown_minutes: cooldown_minutes || existingCfg.cooldown_minutes || 60,
          hodl_symbols: params?.hodl_symbols ?? existingCfg.hodl_symbols ?? defaultHodl,
          updated_at: new Date().toISOString()
        };
        // Always saves to system_config — NOT trader_profile
        await db.execute(
          `INSERT INTO system_config (config_key, config_value) VALUES ('ai_auto_execute', ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)`,
          [JSON.stringify(config)]
        );
        console.log('[auto-exec] Config saved to system_config:', JSON.stringify(config));
        await sendTelegram(
          `🤖 <b>AI AUTO-EXECUTE ${config.enabled ? 'ENABLED ✅' : 'DISABLED ❌'}</b>\n\n` +
          `Max sell: ${config.max_sell_pct}% per trade\n` +
          `Max buy: $${config.max_buy_usd}\n` +
          `Confidence required: ${config.require_confidence}\n` +
          `Cooldown: ${config.cooldown_minutes} min\n` +
          `Triggers: ${config.allowed_triggers.join(', ')}\n` +
          `HODL (analysis-only): ${(config.hodl_symbols || []).join(', ')}`
        );
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, config, saved_to: 'system_config' }) }] };

      } else if (action === 'sync_entry_prices') {
        const results = [];

        // Sync all Revolut X positions
        const rvBalances = await revolutRequest('GET', '/balances');
        for (const asset of rvBalances) {
          if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
          const qty = parseFloat(asset.available || 0);
          if (qty < 0.001) continue;
          const sym = `${asset.currency}-USD`;
          const synced = await syncEntryPriceFromRevolutX(sym);
          results.push({ symbol: sym, synced, source: 'revolut' });
        }

        // Sync Kraken positions
        const krakenData = await getKrakenBalances();
        for (const asset of (krakenData.balances || [])) {
          if (!asset.symbol) continue;
          const synced = await syncEntryPriceFromKraken(asset.symbol);
          results.push({ symbol: asset.symbol, synced, source: 'kraken' });
        }

        const synced  = results.filter(r => r.synced);
        const failed  = results.filter(r => !r.synced);

        const syncLines = synced.map(r => `${r.symbol.replace('-USD','')}: ${formatPrice(r.synced)}`).join('\n');
        await sendTelegram(
          `🔄 <b>ENTRY PRICES SYNCED</b>\n\n` +
          `✅ Synced: ${synced.length} coins\n` +
          `⚠️ Fallback: ${failed.length} coins\n\n` +
          (syncLines || 'No exchange data available')
        ).catch(() => {});

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, synced: synced.length, failed: failed.length, results }) }] };

      } else if (action === 'log_dev_issue') {
        if (dev_log_id) {
          // UPDATE existing row
          const sets = [];
          const vals = [];
          if (devStatus !== undefined) { sets.push('status = ?'); vals.push(devStatus); }
          if (detail    !== undefined) { sets.push('detail = ?'); vals.push(detail); }
          if (category  !== undefined) { sets.push('category = ?'); vals.push(category); }
          if (relSymbol !== undefined) { sets.push('related_symbol = ?'); vals.push(relSymbol); }
          if (devStatus === 'resolved') { sets.push('resolved_at = NOW()'); }
          if (!sets.length) return { content: [{ type: 'text', text: JSON.stringify({ error: 'Nothing to update — provide status or detail' }) }] };
          vals.push(dev_log_id);
          await db.execute(`UPDATE dev_log SET ${sets.join(', ')} WHERE id = ?`, vals);
          const [updated] = await db.execute('SELECT * FROM dev_log WHERE id = ?', [dev_log_id]);
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, dev_log_id, action: 'updated', row: updated[0] }) }] };
        } else {
          // INSERT new row
          if (!title) return { content: [{ type: 'text', text: JSON.stringify({ error: 'title is required to create a dev log entry' }) }] };
          const [res] = await db.execute(
            `INSERT INTO dev_log (title, detail, category, status, source, related_symbol)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [title, detail || null, category || 'note', devStatus || 'open', devSource || 'developer', relSymbol || null]
          );
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, dev_log_id: res.insertId, action: 'created', title }) }] };
        }

      } else if (action === 'export_dev_log') {
          // #79: dump full dev_log to markdown — on-demand, read-only, no schema change
          const [rows] = await db.execute(
            'SELECT * FROM dev_log ORDER BY id ASC'
          );
          const now = new Date().toISOString().slice(0, 10);
          let md = `# dev_log export — ${now}\n\n`;
          md += `> Generated: ${new Date().toISOString()} | Total tickets: ${rows.length}\n\n---\n\n`;
          for (const r of rows) {
            const status = r.status === 'resolved' ? '\u2705 resolved' : r.status === 'open' ? '\ud83d\udd35 open' : r.status;
            md += `## #${r.id} \u2014 ${r.title}\n\n`;
            md += `**Status:** ${status} | **Category:** ${r.category || 'note'} | **Source:** ${r.source || 'developer'}\n\n`;
            md += `**Created:** ${r.created_at ? new Date(r.created_at).toISOString().slice(0, 10) : 'n/a'}`;
            if (r.resolved_at) md += ` | **Resolved:** ${new Date(r.resolved_at).toISOString().slice(0, 10)}`;
            if (r.related_symbol) md += ` | **Symbol:** ${r.related_symbol}`;
            md += `\n\n`;
            if (r.detail) md += `${r.detail}\n\n`;
            md += `---\n\n`;
          }
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, ticket_count: rows.length, export_date: now, markdown: md }) }] };
      } else if (action === 'log_pm_decision') {
        if (!pm_decision) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'pm_decision text is required' }) }] };
        const pmSym = relSymbol ? (relSymbol.includes('-USD') ? relSymbol.toUpperCase() : `${relSymbol.toUpperCase()}-USD`) : (symbol ? (symbol.includes('-USD') ? symbol.toUpperCase() : `${symbol.toUpperCase()}-USD`) : null);
        const [pmRes] = await db.execute(
          `INSERT INTO pm_decisions (decision, reasoning, principle_tag, related_symbol, conviction, captured_by, supersedes_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [pm_decision, reasoning || null, pm_principle_tag || null, pmSym, pm_conviction || null, pm_captured_by || 'manual', pm_supersedes_id || null]
        );
        // If this supersedes an earlier decision, mark the old one
        if (pm_supersedes_id) {
          await db.execute(`UPDATE pm_decisions SET status = 'superseded' WHERE id = ?`, [pm_supersedes_id]).catch(() => {});
        }
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, pm_decision_id: pmRes.insertId, captured_by: pm_captured_by || 'manual', supersedes: pm_supersedes_id || null }) }] };
      } else if (action === 'log_dev_decision') {
        if (!dev_decision) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'dev_decision text is required' }) }] };
        const [devDecRes] = await db.execute(
          `INSERT INTO dev_decisions (decision, reasoning, principle_tag, cross_thread, alternatives_rejected, related_dev_log, status, supersedes_id, captured_by)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
          [dev_decision, reasoning || null, dev_principle_tag || null, dev_cross_thread ? 1 : 0, dev_alternatives || null, dev_related_log || null, dev_supersedes_id || null, pm_captured_by || 'manual']
        );
        if (dev_supersedes_id) {
          await db.execute(`UPDATE dev_decisions SET status = 'superseded' WHERE id = ?`, [dev_supersedes_id]).catch(() => {});
        }
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, dev_decision_id: devDecRes.insertId, cross_thread: dev_cross_thread ? 1 : 0, supersedes: dev_supersedes_id || null }) }] };
      } else if (action === 'log_research') {
        // #72 Build 2: store a chat-based research snapshot + return diff vs prior
        const rBase = (symbol || '').toUpperCase().replace('-USD', '');
        if (!rBase) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'symbol required' }) }] };
        const rThesis = (value || 'INTACT').toUpperCase();
        const rDrift = note || 'plan intact';
        const rReport = reasoning || '';
        const rPrice = (typeof price === 'number') ? price : null;
        let rPrior = null, rDiff = null;
        try {
          const [pr] = await db.execute('SELECT * FROM research_history WHERE symbol = ? ORDER BY researched_at DESC LIMIT 1', [rBase]);
          if (pr.length) { rPrior = pr[0]; rDiff = buildResearchDiff(rPrior, { thesisStatus: rThesis, driftVerdict: rDrift, livePrice: rPrice }); }
        } catch (e) { /* diff optional */ }
        try {
          await db.execute(
            `INSERT INTO research_history (symbol, triggered_by, live_price, thesis_status, drift_verdict, report_text, had_plan)
             VALUES (?, 'chat', ?, ?, ?, ?, FALSE)`,
            [rBase, rPrice, rThesis, rDrift, rReport]
          );
        } catch (e) { return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }] }; }
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, symbol: rBase, stored: true, thesis_status: rThesis, drift_verdict: rDrift, diff_vs_prior: rDiff, prior_researched_at: rPrior ? rPrior.researched_at : null }) }] };
      } else if (action === 'update_session_state') {
        const [curRows] = await db.execute('SELECT * FROM session_state WHERE id = 1');
        const cur = curRows[0] || {};

        function parseJ(v, fallback) {
          if (v === null || v === undefined) return fallback;
          try { return typeof v === 'string' ? JSON.parse(v) : v; } catch (e) { return fallback; }
        }

        const newWorkstream   = (active_workstream !== undefined && active_workstream !== null) ? active_workstream : cur.active_workstream;
        const newProgress     = (progress     !== undefined && progress     !== null) ? progress     : parseJ(cur.progress,     null);
        const newOpenThreads  = (open_threads !== undefined && open_threads !== null) ? open_threads : parseJ(cur.open_threads, null);
        const newNextAction   = (next_action  !== undefined && next_action  !== null) ? next_action  : cur.next_action;

        let decisions = parseJ(cur.recent_decisions, []);
        if (!Array.isArray(decisions)) decisions = [];
        if (recent_decision) {
          decisions.unshift(recent_decision);
          decisions = decisions.slice(0, 5);
        } else if (recent_decisions !== undefined && recent_decisions !== null) {
          decisions = Array.isArray(recent_decisions) ? recent_decisions.slice(0, 5) : decisions;
        }

        await db.execute(
          `UPDATE session_state SET active_workstream = ?, progress = ?, open_threads = ?, next_action = ?, recent_decisions = ? WHERE id = 1`,
          [newWorkstream,
           newProgress     !== null ? JSON.stringify(newProgress)    : null,
           newOpenThreads  !== null ? JSON.stringify(newOpenThreads) : null,
           newNextAction,
           JSON.stringify(decisions)]
        );

        const [snapRows] = await db.execute('SELECT * FROM session_state WHERE id = 1');
        await db.execute('INSERT INTO session_history (snapshot) VALUES (?)', [JSON.stringify(snapRows[0] || {})]);

        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, action: 'update_session_state', updated: snapRows[0] || {} }) }] };
      } else if (action === 'upsert_coin_strategy') {
        const csSym = (symbol || '').toUpperCase().replace('-USD','');
        if (!csSym) return { content: [{ type:'text', text: JSON.stringify({ ok:false, error:'symbol required' }) }] };
        await db.execute(
          `INSERT INTO coin_strategy (symbol, status, role, theme, strategy_md, updated_by)
           VALUES (?, ?, ?, ?, ?, 'claude_mcp')
           ON DUPLICATE KEY UPDATE
             status = COALESCE(VALUES(status), status),
             role = COALESCE(VALUES(role), role),
             theme = COALESCE(VALUES(theme), theme),
             strategy_md = COALESCE(VALUES(strategy_md), strategy_md),
             updated_by = 'claude_mcp'`,
          [csSym, cs_status ?? null, cs_role ?? null, cs_theme ?? null, cs_strategy_md ?? null]
        );
        return { content: [{ type:'text', text: JSON.stringify({ ok:true, action:'upsert_coin_strategy', symbol: csSym }) }] };
      }
    }
  );

  // ── Tool: set_entry_price ─────────────────────────────────────────────────
  server.tool('set_entry_price',
    'Set average entry price for a coin',
    {
      symbol:      z.string().describe('Trading pair e.g. LINK-USD'),
      entry_price: z.number().describe('Average entry price in USD'),
    },
    async ({ symbol, entry_price }) => {
      const sym = symbol.includes('-USD') ? symbol : `${symbol}-USD`;
      await updateEntryPrice(sym, entry_price, false);
      const currentPrice = await getCurrentPrice(sym).catch(() => null);
      const plPct = currentPrice ? ((currentPrice - entry_price) / entry_price * 100).toFixed(2) : null;
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, symbol: sym, entry_price, current_price: currentPrice, pl_pct: plPct }) }] };
    }
  );

  // ── Tool: get_portfolio_summary ───────────────────────────────────────────
  server.tool('get_portfolio_summary',
    'Get full portfolio with prices, P&L and alert status',
    {},
    async () => {
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

      // Validate live quantities against cache — sync any stale values
      for (const asset of balances) {
        if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
        const symbol = `${asset.currency}-USD`;
        const liveQty = parseFloat(asset.available);
        const cachedQty = previousBalances.get(symbol);
        if (cachedQty !== undefined && liveQty > 0 && Math.abs(liveQty - cachedQty) / Math.max(cachedQty, 0.000001) > 0.05) {
          console.log(`[qty mismatch] ${symbol}: live=${liveQty} cached=${cachedQty} — updating cache`);
          previousBalances.set(symbol, liveQty);
          await db.execute(
            'INSERT INTO balance_snapshots (symbol, quantity) VALUES (?, ?) ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)',
            [symbol, liveQty]
          ).catch(() => {}); // table may not exist — safe to ignore
        }
      }

      let totalValue = 0;
      const positions = [];
      const [epSummaryRows] = await db.execute(
        'SELECT symbol, entry_price, original_entry_price, cycle_count, original_entry_date FROM entry_prices'
      ).catch(() => [[]]);
      const epSummary = {};
      for (const r of epSummaryRows) epSummary[r.symbol] = r;
      for (const asset of balances) {
        if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
        const qty = parseFloat(asset.available);
        if (qty <= 0) continue;
        const sym = `${asset.currency}-USD`;
        const price = priceMap[sym] || priceMap[`${asset.currency}/USD`] || null;
        const valueUsd = price ? qty * price : null;
        if (valueUsd) totalValue += valueUsd;
        const entry = entryPrices.get(sym) || null;
        const ep = epSummary[sym];
        const originalEntry = ep?.original_entry_price ? parseFloat(ep.original_entry_price) : entry;
        const cycleCount = parseInt(ep?.cycle_count || 0);
        const plPct = entry && price ? ((price - entry) / entry * 100).toFixed(2) : null;
        const plUsd = entry && price && qty ? ((price - entry) * qty).toFixed(2) : null;
        const historicalPlPct = originalEntry && price ? ((price - originalEntry) / originalEntry * 100).toFixed(2) : null;
        const threshold = customThresholds[sym] !== undefined ? customThresholds[sym] : PUMP_THRESHOLD;
        const basePrice = basePrices[sym] || null;
        const changeFromBase = basePrice && price ? ((price - basePrice) / basePrice * 100).toFixed(2) : null;
        const [trancheRows] = await db.execute(
          `SELECT entry_price, remaining_quantity, is_legacy, entry_date
           FROM position_tranches
           WHERE symbol = ? AND remaining_quantity > 0
           ORDER BY entry_price DESC`,
          [asset.currency]
        ).catch(() => [[]]);

        positions.push({
          symbol: sym, currency: asset.currency, quantity: qty, price, value_usd: valueUsd ? valueUsd.toFixed(2) : null,
          entry_price: entry, pl_pct: plPct, pl_usd: plUsd,
          original_entry_price: originalEntry, historical_pl_pct: historicalPlPct,
          cycle_count: cycleCount,
          baseline_price: basePrice, change_from_baseline_pct: changeFromBase,
          alert_threshold_pct: (threshold * 100).toFixed(1),
          pump_alert_active: alertState.active.has(sym),
          drop_alert_active: activeDropAlerts.has(sym),
          fixed_alert_active: activeFixedAlerts.has(sym),
          acknowledged: alertState.acknowledged.has(sym),
          ignored: ignoredCoins.has(sym),
          fixed_target: priceTargets.has(sym) ? priceTargets.get(sym) : null,
          tranches: trancheRows.map(t => ({
            entry_price: parseFloat(t.entry_price),
            quantity: parseFloat(t.remaining_quantity),
            is_legacy: t.is_legacy === 1,
            entry_date: t.entry_date
          })),
        });
      }
      positions.sort((a, b) => (parseFloat(b.value_usd) || 0) - (parseFloat(a.value_usd) || 0));

      // Append sold coins (last_sold_at set, no live balance) — last 30 days
      try {
        const [soldCoins] = await db.execute(
          `SELECT symbol, entry_price, original_entry_price, cycle_count, last_sold_price, last_sold_at
           FROM entry_prices WHERE last_sold_at IS NOT NULL AND last_sold_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
           ORDER BY last_sold_at DESC`
        );
        console.log('[portfolio] Sold coins found:', soldCoins.map(c => c.symbol).join(', ') || 'none');
        for (const sold of soldCoins) {
          if (positions.find(p => p.symbol === sold.symbol)) continue; // already in live positions
          const coinBase    = sold.symbol.replace('-USD', '');
          const currentPrice = priceMap[sold.symbol] || priceMap[`${coinBase}/USD`] || null;
          const origEntry   = sold.original_entry_price ? parseFloat(sold.original_entry_price) : parseFloat(sold.entry_price);
          const plPct       = origEntry && currentPrice ? ((currentPrice - origEntry) / origEntry * 100).toFixed(2) : null;
          positions.push({
            symbol: sold.symbol, currency: coinBase, quantity: 0, price: currentPrice,
            value_usd: '0.00', entry_price: parseFloat(sold.entry_price),
            original_entry_price: origEntry, historical_pl_pct: plPct,
            cycle_count: parseInt(sold.cycle_count || 0),
            last_sold_price: sold.last_sold_price ? parseFloat(sold.last_sold_price) : null,
            last_sold_at: sold.last_sold_at, status: 'sold',
          });
        }
      } catch (e) { console.warn('[portfolio] Sold coins fetch error:', e.message); }

      const cap = getCapitalSummary(totalValue);

      // Filter: remove dust (<$1) and ignored coins
      const ignoredCount = positions.filter(p => ignoredCoins.has(p.symbol)).length;
      const dustCount    = positions.filter(p => !ignoredCoins.has(p.symbol) && parseFloat(p.value_usd || 0) > 0 && parseFloat(p.value_usd || 0) < 1.00).length;
      // Enrich positions with historical cost basis
      for (const pos of positions) {
        try {
          const basis = await getHistoricalCostBasis(pos.symbol);
          if (basis && basis.historical_basis > 0) {
            const curPrice = parseFloat(pos.price || 0);
            pos.historical_basis     = parseFloat(basis.historical_basis.toFixed(6));
            pos.historical_pl_pct    = curPrice > 0 ? parseFloat(((curPrice - basis.historical_basis) / basis.historical_basis * 100).toFixed(2)) : null;
            pos.net_cash_deployed    = parseFloat(basis.net_deployed.toFixed(2));
            pos.total_cash_in        = parseFloat(basis.total_cash_in.toFixed(2));
            pos.has_cycle_history    = true;
          }
        } catch (e) { /* non-critical */ }
      }

      const cleanPositions = positions.filter(p =>
        !ignoredCoins.has(p.symbol) && parseFloat(p.value_usd || 0) >= 1.00
      );

      // Live cash balances — always included so Portfolio Manager can size trades without a separate call
      let revolutUsdBalance = 0, krakenUsdBalance = 0;
      try {
        const usdAsset = balances.find(b => b.currency === 'USD');
        revolutUsdBalance = parseFloat(usdAsset?.available || 0);
      } catch (e) { /* ignore */ }
      try {
        const krakenRaw = await krakenRequest('/0/private/Balance').catch(() => ({}));
        krakenUsdBalance = parseFloat(krakenRaw['ZUSD'] || krakenRaw['USD'] || 0);
      } catch (e) { /* ignore */ }

      const cash_available = {
        revolut_usd: parseFloat(revolutUsdBalance.toFixed(2)),
        kraken_usd:  parseFloat(krakenUsdBalance.toFixed(2)),
        total_usd:   parseFloat((revolutUsdBalance + krakenUsdBalance).toFixed(2)),
        note: 'Live balance — use this for trade sizing'
      };

      return { content: [{ type: 'text', text: JSON.stringify({
        total_value_usd: totalValue.toFixed(2),
        invested: cap.invested,
        pl_usd: cap.pnl.toFixed(2),
        pl_pct: cap.pnlPct.toFixed(2),
        positions: cleanPositions,
        dust_positions: dustCount,
        ignored_positions: ignoredCount,
        cash_available
      }, null, 2) }] };
    }
  );

  // ── Tool: set_auto_trade_rule ─────────────────────────────────────────────
  server.tool('set_auto_trade_rule',
    'Set an automatic trade rule for Kraken or Revolut X — executes automatically when price condition is met. Use rule_type moon_bag to mark a portion as never-sell.',
    {
      symbol:           z.string().describe('Trading pair e.g. SOL-USD'),
      rule_type:        z.string().describe('Label: buy_dip, sell_pump, stop_loss, buy_retrace, moon_bag'),
      trigger_price:    z.number().describe('Price that triggers the trade (use 0 for moon_bag markers)'),
      direction:        z.enum(['above', 'below']).describe('Trigger when price goes above or below trigger_price'),
      order_type:       z.enum(['buy', 'sell']).describe('Buy or sell when triggered'),
      volume:           z.number().describe('Token amount (fixed) or percentage (pct) of position to trade'),
      volume_type:      z.enum(['fixed', 'pct']).optional().describe('fixed = token count, pct = % of current position (default: fixed)'),
      max_position_usd: z.number().optional().describe('Max position size in USD — skips buy if already holding this much'),
      exchange:         z.enum(['kraken', 'revolut']).optional().describe('Exchange to execute on: kraken (default) or revolut'),
      max_cascades:     z.number().optional().describe('Max cascade buy-backs before stopping runaway downside buying — default 3'),
    },
    async ({ symbol, rule_type, trigger_price, direction, order_type, volume, volume_type, max_position_usd, exchange, max_cascades }) => {
      try {
        const sym         = symbol.includes('-USD') ? symbol : `${symbol}-USD`;
        const volType     = volume_type || 'fixed';
        const exch        = exchange || 'kraken';
        const maxCascades = max_cascades ?? 3;
        const [result] = await db.execute(
          'INSERT INTO auto_trade_rules (symbol, rule_type, trigger_price, direction, order_type, volume, volume_type, max_position_usd, exchange, max_cascades) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [sym, rule_type, trigger_price, direction, order_type, volume, volType, max_position_usd || null, exch, maxCascades]
        );
        const volLabel = volType === 'pct' ? `${volume}% of position` : `${volume} tokens`;
        const moonNote = rule_type === 'moon_bag' ? '\n🌙 Moon bag — marker only, never auto-sold' : '';
        await sendTelegram(
          `🤖 <b>AUTO TRADE RULE SET</b>\n\n` +
          `${order_type.toUpperCase()} ${volLabel} ${sym.replace('-USD', '')} when price goes ${direction} $${trigger_price}\n` +
          `Rule type: ${rule_type}\n` +
          `Exchange: ${exch.toUpperCase()}\n` +
          `Max cascades: ${maxCascades}\n` +
          `Max position: ${max_position_usd ? '$' + max_position_usd : 'unlimited'}${moonNote}`
        );
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, rule_id: result.insertId, symbol: sym, rule_type, trigger_price, direction, order_type, volume, volume_type: volType, exchange: exch, max_cascades: maxCascades }) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }] };
      }
    }
  );

  // ── Tool: get_auto_rules ──────────────────────────────────────────────────
  server.tool('get_auto_rules',
    'Get all automatic trade rules (active and inactive)',
    {},
    async () => {
      try {
        const [rules] = await db.execute('SELECT * FROM auto_trade_rules ORDER BY created_at DESC');
        const active = rules.filter(r => r.active);
        return { content: [{ type: 'text', text: JSON.stringify({ rules, active_count: active.length, total: rules.length }, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }] };
      }
    }
  );

  // ── Tool: manage_auto_rules ───────────────────────────────────────────────
  server.tool('manage_auto_rules',
    'Manage automatic trade rules — list, remove, disable or enable a rule by ID',
    {
      action:  z.enum(['list', 'remove', 'disable', 'enable']).describe('Action to perform'),
      rule_id: z.number().optional().describe('Rule ID to remove, disable or enable'),
    },
    async ({ action, rule_id }) => {
      try {
        if (action === 'list') {
          const [rules] = await db.execute('SELECT * FROM auto_trade_rules ORDER BY created_at DESC');
          return { content: [{ type: 'text', text: JSON.stringify({ rules, active: rules.filter(r => r.active) }, null, 2) }] };
        }
        if (action === 'remove' && rule_id) {
          const [existing] = await db.execute('SELECT * FROM auto_trade_rules WHERE id = ?', [rule_id]);
          if (existing.length === 0) throw new Error(`Rule ${rule_id} not found`);
          const rule = existing[0];
          await db.execute('DELETE FROM auto_trade_rules WHERE id = ?', [rule_id]);
          // Log deletion so seeding logic never recreates this rule
          await db.execute(
            `INSERT INTO deleted_rules_log (rule_id, symbol, exchange, rule_type, order_type, direction, trigger_price, volume)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [rule_id, rule.symbol, rule.exchange || 'kraken', rule.rule_type, rule.order_type, rule.direction, rule.trigger_price, rule.volume]
          ).catch(e => console.warn('[rules] Failed to log deletion:', e.message));
          // No in-memory rule cache exists — checkAutoTradeRules always reads DB fresh.
          // Clear any related target-reminder state for this symbol just in case.
          if (rule.symbol) {
            targetReminderCount.delete(rule.symbol);
          }
          console.log(`[rules] Rule ${rule_id} (${rule.symbol} ${rule.rule_type}) removed and logged to deleted_rules_log`);
          await sendTelegram(
            `🗑 Auto rule [${rule_id}] removed:\n` +
            `${rule.order_type.toUpperCase()} ` +
            `${rule.volume} ${rule.symbol.replace('-USD', '')} ` +
            `${rule.direction} $${parseFloat(rule.trigger_price).toFixed(2)}`
          );
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, removed: rule_id, rule }) }] };
        }
        if (action === 'disable' && rule_id) {
          await db.execute('UPDATE auto_trade_rules SET active = 0 WHERE id = ?', [rule_id]);
          console.log(`[rules] Rule ${rule_id} disabled — will be skipped on next checkAutoTradeRules cycle`);
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, disabled: rule_id }) }] };
        }
        if (action === 'enable' && rule_id) {
          await db.execute('UPDATE auto_trade_rules SET active = 1 WHERE id = ?', [rule_id]);
          return { content: [{ type: 'text', text: JSON.stringify({ ok: true, enabled: rule_id }) }] };
        }
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'rule_id required for remove/disable/enable' }) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }] };
      }
    }
  );

  // ── Tool: get_context ──────────────────────────────────────────────────────
  server.tool('get_context',
    "Get Bryan's trader profile, preferences, recent journal entries and learning model summary for Claude context",
    {},
    async () => {
      const [profileRows]    = await db.execute('SELECT preference_key, preference_value FROM trader_profile');
      const [recentTrades]   = await db.execute('SELECT * FROM trading_journal ORDER BY created_at DESC LIMIT 5');
      const [intentionRows]  = await db.execute('SELECT * FROM intention_tracking ORDER BY intention_date DESC LIMIT 3');
      const [configRows]     = await db.execute('SELECT config_key, config_value FROM system_config');
      const [sessionRows]    = await db.execute('SELECT * FROM session_state WHERE id = 1');
      const sessionState     = sessionRows[0] || null;
      // #105 PM Build 1: decision memory + "since last session" digest
      const [pmDecRows] = await db.execute("SELECT id, created_at, decision, reasoning, principle_tag, related_symbol, conviction, captured_by, status, supersedes_id FROM pm_decisions WHERE status = 'active' ORDER BY created_at DESC LIMIT 25").catch(() => [[]]);
      let pmDecLastSeen = null;
      try {
        const [lsRows] = await db.execute("SELECT config_value FROM system_config WHERE config_key = 'pm_decisions_last_seen'");
        if (lsRows.length) pmDecLastSeen = lsRows[0].config_value;
      } catch (e) { /* first run */ }
      const pmDecisionsSinceLastSession = pmDecLastSeen
        ? pmDecRows.filter(r => new Date(r.created_at) > new Date(pmDecLastSeen))
        : pmDecRows.filter(r => r.captured_by === 'auto');
      // Update the last-seen marker to now (so next session's digest is fresh)
      await db.execute(
        "INSERT INTO system_config (config_key, config_value) VALUES ('pm_decisions_last_seen', ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)",
        [new Date().toISOString()]
      ).catch(() => {});

      // #105 PM Build 2: recommendation engine — held positions + research + principles
      let pmRecommendations = [];
      try {
        // Pull held positions with entry price (non-dust, non-exited)
        const [epRows] = await db.execute(
          `SELECT ep.symbol, ep.entry_price, ep.available_qty, ep.gain_loss
           FROM entry_prices ep
           WHERE ep.available_qty > 0
           ORDER BY ep.symbol ASC`
        );
        // Pull most-recent research per symbol
        const [rhRows] = await db.execute(
          `SELECT r1.symbol, r1.thesis_status, r1.drift_verdict, r1.live_price, r1.researched_at
           FROM research_history r1
           INNER JOIN (
             SELECT symbol, MAX(researched_at) AS latest FROM research_history GROUP BY symbol
           ) r2 ON r1.symbol = r2.symbol AND r1.researched_at = r2.latest`
        );
        const researchMap = {};
        for (const r of rhRows) researchMap[r.symbol] = r;
        // Pull win rates by category from trading_journal
        const [catRows] = await db.execute(
          `SELECT
             CASE
               WHEN symbol IN ('CC-USD','LINK-USD','XLM-USD','XRP-USD') THEN 'institutional'
               WHEN symbol IN ('NEAR-USD','TON-USD','ALGO-USD','ADA-USD','JTO-USD') THEN 'layer1'
               WHEN symbol IN ('ENA-USD','AERO-USD','HYPE-USD') THEN 'defi'
               WHEN symbol IN ('GHIBLI-USD','BONK-USD','FLOKI-USD','MOG-USD') THEN 'meme'
               ELSE 'other'
             END AS category,
             COUNT(*) AS total,
             SUM(CASE WHEN outcome_pnl > 0 THEN 1 ELSE 0 END) AS wins
           FROM trading_journal
           WHERE outcome_pnl IS NOT NULL
           GROUP BY category`
        );
        const winRateMap = {};
        for (const c of catRows) {
          winRateMap[c.category] = c.total > 0 ? Math.round((c.wins / c.total) * 100) : null;
        }
        // Load active pm_decisions principles
        const principles = (pmDecRows || []).map(d => d.principle_tag).filter(Boolean);
        // Build recommendations per position
        for (const ep of epRows) {
          const sym = ep.symbol.includes('-USD') ? ep.symbol : ep.symbol + '-USD';
          const base = sym.replace('-USD', '');
          const entry = parseFloat(ep.entry_price || 0);
          const qty = parseFloat(ep.available_qty || 0);
          const gainLoss = parseFloat(ep.gain_loss || 0);
          if (!entry || qty < 0.0001) continue;
          const research = researchMap[base] || null;
          const recs = [];
          // TRIM candidate: unrealized gain significant + research STRENGTHENING or INTACT
          if (gainLoss > 15 && research && ['STRENGTHENING', 'INTACT'].includes((research.thesis_status || '').toUpperCase())) {
            recs.push({
              type: 'trim_candidate',
              reason: `+${gainLoss.toFixed(1)}% unrealized gain, thesis ${research.thesis_status}. Per trim-into-strength principle: consider laddered limit sells into strength, retain 25% moon bag. Research: ${(research.drift_verdict || '').slice(0, 120)}`,
              principle: 'trim-into-strength',
              research_date: research.researched_at,
            });
          }
          // HOLD confirmation: thesis STRENGTHENING but still below entry
          if (gainLoss < 0 && research && (research.thesis_status || '').toUpperCase() === 'STRENGTHENING') {
            recs.push({
              type: 'hold_confirmation',
              reason: `${gainLoss.toFixed(1)}% below entry but thesis STRENGTHENING — plan supports hold, not cut. Research: ${(research.drift_verdict || '').slice(0, 120)}`,
              principle: 'thesis-driven-hold',
              research_date: research.researched_at,
            });
          }
          // WEAKENING flag: thesis weakening or broken → review
          if (research && ['WEAKENING', 'BROKEN'].includes((research.thesis_status || '').toUpperCase())) {
            recs.push({
              type: 'thesis_risk',
              reason: `Thesis ${research.thesis_status} as of ${research.researched_at ? new Date(research.researched_at).toISOString().slice(0,10) : 'unknown'}. Review exit plan. Research: ${(research.drift_verdict || '').slice(0, 120)}`,
              principle: 'cut-weakening-thesis',
              research_date: research.researched_at,
            });
          }
          // ROTATION candidate: STRENGTHENING thesis on watchlist/small position
          if (qty < 1 && research && (research.thesis_status || '').toUpperCase() === 'STRENGTHENING') {
            recs.push({
              type: 'rotation_candidate',
              reason: `Dust/tiny position but thesis STRENGTHENING — potential rotation target if trim proceeds free capital. Research: ${(research.drift_verdict || '').slice(0, 120)}`,
              principle: 'rotate-to-researched-dips',
              research_date: research.researched_at,
            });
          }
          if (recs.length > 0) {
            pmRecommendations.push({ symbol: sym, unrealized_pct: gainLoss, entry_price: entry, recommendations: recs });
          }
        }
        // Sort: thesis_risk first, then trim_candidate, then rotation, then hold_confirmation
        const typeOrder = { thesis_risk: 0, trim_candidate: 1, rotation_candidate: 2, hold_confirmation: 3 };
        pmRecommendations.sort((a, b) => {
          const aMin = Math.min(...a.recommendations.map(r => typeOrder[r.type] ?? 9));
          const bMin = Math.min(...b.recommendations.map(r => typeOrder[r.type] ?? 9));
          return aMin - bMin;
        });
      } catch (e) {
        console.error('[pm-recs] recommendation engine error:', e.message);
        pmRecommendations = [];
      }

      const [statsRows]      = await db.execute(
        `SELECT
           COUNT(*) AS total_completed,
           SUM(CASE WHEN outcome_pnl > 0 THEN 1 ELSE 0 END) AS wins
         FROM trading_journal
         WHERE outcome_pnl IS NOT NULL`
      );
      const stats = statsRows[0] || {};
      const totalCompleted = parseInt(stats.total_completed || 0);
      const wins = parseInt(stats.wins || 0);
      const winRate = totalCompleted > 0 ? ((wins / totalCompleted) * 100).toFixed(1) : null;
      const result = {
        traderProfile:     profileRows,
        recentTrades,
        learningModel:     learningModelCache || 'Not yet generated',
        investedCapital:   totalInvestedCapital,
        recentIntentions:  intentionRows,
        tradingStats: { totalCompleted, winRate: winRate ? `${winRate}%` : 'n/a' },
        systemConfig:      configRows,
        working_notes_unverified: sessionState,
        pmDecisions:       pmDecRows || [],
        pmDecisionsDigest: pmDecisionsSinceLastSession || [],
        pmRecommendations: pmRecommendations,
      };
      console.log('[mcp] get_context called');
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Tool: execute_kraken_trade (unified — handles Kraken + Revolut X) ─────
  server.tool('execute_kraken_trade',
    'Request Telegram approval to execute a trade on Kraken or Revolut X. Sends details to Telegram — user must reply "approve trade" to confirm.',
    {
      exchange:   z.enum(['kraken', 'revolut']).describe('Which exchange to trade on'),
      symbol:     z.string().describe('Trading pair e.g. SOL-USD or LINK-USD'),
      side:       z.enum(['buy', 'sell']).describe('Buy or sell'),
      order_type: z.enum(['market', 'limit']).describe('Market or limit order'),
      volume:     z.number().optional().describe('Amount of base currency to trade e.g. 1.3 for 1.3 NEAR — use value_usd instead for Revolut market orders'),
      value_usd:  z.number().optional().describe('USD value to trade — Revolut calculates tokens automatically. Use instead of volume for cleaner execution e.g. 3 for $3 of NEAR'),
      price:      z.number().optional().describe('Limit price — required for limit orders'),
    },
    async ({ exchange, symbol, side, order_type, volume, value_usd, price }) => {
      const sym           = symbol.includes('-USD') ? symbol.toUpperCase() : `${symbol.toUpperCase()}-USD`;
      const coinBase      = sym.replace('-USD', '');
      const livePrice     = price || await getCurrentPrice(sym).catch(() => null);
      const tradeValueUSD = value_usd || (livePrice && volume ? livePrice * volume : null);
      const exchangeLabel = exchange === 'revolut' ? 'Revolut X' : 'Kraken';
      const displayQty    = value_usd ? `$${value_usd}` : `${formatTradeQty(volume)} ${coinBase}`;

      // When only value_usd is given, estimate token quantity for display/journal purposes
      const estBaseSize = volume || (value_usd && livePrice ? value_usd / livePrice : 0);
      if (exchange === 'revolut') {
        pendingRevolutTrade = { symbol: sym, side, orderType: order_type, baseSize: estBaseSize, valueUsd: value_usd || null, price: livePrice, valueUSD: tradeValueUSD, timestamp: Date.now(), source: 'claude_mcp', qtyEstimated: !volume && !!value_usd };
      } else {
        pendingKrakenTrade = { symbol: sym, side, orderType: order_type, volume: estBaseSize, price: livePrice, valueUSD: tradeValueUSD, timestamp: Date.now(), source: 'claude_mcp', qtyEstimated: !volume && !!value_usd };
      }

      await sendTelegram(formatApprovalRequest(coinBase, side, volume || null, livePrice, tradeValueUSD, exchange));

      // Start reminder cycle — first reminder after 2.5 minutes
      setTimeout(() => startTradeApprovalReminder(exchange), 2.5 * 60 * 1000);

      return { content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        status: 'pending_approval',
        exchange,
        message: `Approval request sent to Telegram. Reply "approve trade" to execute ${side} ${displayQty}${value_usd ? ` of ${coinBase}` : ''} on ${exchangeLabel}.`,
        symbol: sym, side, order_type, volume, value_usd, price: livePrice, valueUSD: tradeValueUSD,
      }) }] };
    }
  );

  // ── Tool: get_tranches ────────────────────────────────────────────────────
  server.tool('set_pump_armed_rule',
    'Set a pump-armed trailing stop rule (#95 Stage 1). Dormant until the coin pumps arm_pump_pct within arm_window_min, then arms a trailing stop. Stage 1 only arms + alerts — does NOT auto-sell.',
    {
      symbol:         z.string().describe('Trading pair e.g. GHIBLI-USD'),
      arm_pump_pct:   z.number().describe('Pump %% that arms the trailing stop (e.g. 25 = +25%)'),
      trail_pct:      z.number().describe('Trailing stop %% below peak once armed (e.g. 8)'),
      sell_pct:       z.number().optional().describe('%% of position to sell when trail breaches (Stage 2 — stored now, default 50)'),
      entry_floor:    z.number().optional().describe('Never sell below this price (the hard floor; Stage 2)'),
      arm_window_min: z.number().optional().describe('Window in minutes for the pump to count (default 60)'),
    },
    async ({ symbol, arm_pump_pct, trail_pct, sell_pct, entry_floor, arm_window_min }) => {
      try {
        const sym = symbol.includes('-USD') ? symbol.toUpperCase() : `${symbol.toUpperCase()}-USD`;
        await db.execute(
          `INSERT INTO pump_armed_rules (symbol, arm_pump_pct, arm_window_min, trail_pct, sell_pct, entry_floor, armed, baseline_price, baseline_at, active)
           VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, 1)
           ON DUPLICATE KEY UPDATE arm_pump_pct=VALUES(arm_pump_pct), arm_window_min=VALUES(arm_window_min), trail_pct=VALUES(trail_pct), sell_pct=VALUES(sell_pct), entry_floor=VALUES(entry_floor), armed=0, baseline_price=NULL, baseline_at=NULL, active=1, updated_at=CURRENT_TIMESTAMP`,
          [sym, arm_pump_pct, arm_window_min || 60, trail_pct, sell_pct ?? 50, entry_floor ?? null]
        );
        await sendTelegram(
          `🎯 <b>PUMP-ARM RULE SET — ${sym.replace('-USD','')}</b>\n\n` +
          `Arms when +${arm_pump_pct}% within ${arm_window_min || 60}min\n` +
          `Then trails ${trail_pct}% below peak\n` +
          `${entry_floor ? `Floor: ${entry_floor}\n` : ''}` +
          `Sell %% (Stage 2): ${sell_pct ?? 50}%\n\n` +
          `⚠️ Stage 1 active — arms + alerts only, no auto-sell yet.`
        ).catch(() => {});
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, symbol: sym, arm_pump_pct, trail_pct, arm_window_min: arm_window_min || 60, sell_pct: sell_pct ?? 50, entry_floor: entry_floor ?? null, note: 'Stage 1 — arms trailing stop on pump, no auto-sell' }) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }] };
      }
    }
  );

  server.tool('get_tranches',
    'Get tranche breakdown for one or all positions. Shows each buy lot separately with entry price, quantity, cost basis and P&L per tranche.',
    {
      symbol: z.string().optional().describe('Coin symbol e.g. LINK — omit to get all positions'),
    },
    async ({ symbol }) => {
      try {
        const coinBase = symbol ? symbol.replace('-USD', '').toUpperCase() : null;
        const where = coinBase ? `WHERE symbol = ? AND remaining_quantity > 0` : `WHERE remaining_quantity > 0`;
        const params = coinBase ? [coinBase] : [];

        const [tranches] = await db.execute(
          `SELECT symbol, exchange, quantity, entry_price, remaining_quantity, is_legacy, entry_date, notes,
                  (remaining_quantity * entry_price) as cost_basis
           FROM position_tranches
           ${where}
           ORDER BY symbol, entry_price DESC`,
          params
        );

        // Group by symbol
        const grouped = {};
        for (const t of tranches) {
          if (!grouped[t.symbol]) grouped[t.symbol] = [];
          grouped[t.symbol].push(t);
        }

        // Fetch current prices for P&L
        const symbols = Object.keys(grouped);
        const priceMap = {};
        for (const sym of symbols) {
          try {
            const ticker = await revolutRequest('GET', `/tickers/${sym}/USD`);
            priceMap[sym] = parseFloat(ticker?.ask_price || ticker?.last_price || 0);
          } catch { priceMap[sym] = 0; }
        }

        const result = symbols.map(sym => {
          const lots = grouped[sym];
          const currentPrice = priceMap[sym] || 0;
          return {
            symbol: sym,
            current_price: currentPrice,
            tranches: lots.map(lot => ({
              entry_price: parseFloat(lot.entry_price),
              quantity: parseFloat(lot.remaining_quantity),
              cost_basis: parseFloat(lot.remaining_quantity) * parseFloat(lot.entry_price),
              current_value: currentPrice > 0 ? parseFloat(lot.remaining_quantity) * currentPrice : null,
              pl_usd: currentPrice > 0
                ? (currentPrice - parseFloat(lot.entry_price)) * parseFloat(lot.remaining_quantity)
                : null,
              pl_pct: currentPrice > 0
                ? ((currentPrice - parseFloat(lot.entry_price)) / parseFloat(lot.entry_price)) * 100
                : null,
              entry_date: lot.entry_date,
              is_legacy: lot.is_legacy === 1,
              notes: lot.notes
            }))
          };
        });

        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }] };
      }
    }
  );

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
        model: 'claude-sonnet-4-6',
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

// GET /api/tangem — Tangem self-custody XRP wallet balance and P&L
app.get('/api/tangem', async (req, res) => {
  try {
    const xrpBalance = await getTangemXRPBalance();
    const xrpPrice   = await getCurrentPrice('XRP-USD');
    const valueUSD   = xrpBalance != null && xrpPrice ? xrpBalance * xrpPrice : null;
    const entryPrice = TANGEM_XRP_ENTRY;
    const unrealisedPnlPct = xrpPrice ? ((xrpPrice - entryPrice) / entryPrice * 100) : null;
    const unrealisedPnlUsd = xrpPrice && xrpBalance ? (xrpPrice - entryPrice) * xrpBalance : null;
    res.json({
      address: TANGEM_XRP_ADDRESS,
      asset: 'XRP',
      balance: xrpBalance,
      price: xrpPrice,
      valueUSD,
      entryPrice,
      unrealisedPnlPct,
      unrealisedPnlUsd,
      source: 'Tangem Self-Custody'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/capital — current invested capital and P&L summary
// GET /portfolio/summary — combined portfolio data for dashboard.js
app.get('/portfolio/summary', async (req, res) => {
  try {
    const balancesRaw = await revolutRequest('GET', '/balances');
    const tickerResponse = await revolutRequest('GET', '/tickers');
    const tickerList = Array.isArray(tickerResponse) ? tickerResponse : (tickerResponse.data || []);
    const priceMap = {};
    for (const t of tickerList) {
      if (t.symbol) {
        const p = parseFloat(t.last_price || t.mid || t.ask || t.bid);
        if (p) { priceMap[t.symbol] = p; priceMap[t.symbol.replace('/', '-')] = p; }
      }
    }
    let totalValue = 0;
    const positions = [];
    for (const asset of balancesRaw) {
      if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
      const qty = parseFloat(asset.available);
      if (qty <= 0) continue;
      const sym = `${asset.currency}-USD`;
      const price = priceMap[sym] || null;
      const valueUsd = price ? qty * price : null;
      if (valueUsd) totalValue += valueUsd;
      const entry = entryPrices.get(sym) || null;
      const plPct = entry && price ? ((price - entry) / entry * 100).toFixed(2) : null;
      positions.push({
        symbol: sym, currency: asset.currency,
        quantity: qty, current_price: price,
        value_usd: valueUsd ? valueUsd.toFixed(2) : '0.00',
        entry_price: entry, pl_pct: plPct
      });
    }
    positions.sort((a, b) => parseFloat(b.value_usd) - parseFloat(a.value_usd));

    // Enrich with Kraken, Tangem, USD/USDT cash for full grand total
    let krakenTotal = 0, tangemValue = 0, cashUSD = 0, cashUSDT = 0;
    let tangemObj = null;
    try { const kd = await getKrakenBalances(); krakenTotal = kd.totalUSD || 0; } catch (e) { /* ignore */ }
    try {
      const xrpBal = await getTangemXRPBalance();
      const xrpPx  = priceMap['XRP-USD'] || priceMap['XRP/USD'] || 0;
      if (xrpBal && xrpPx) {
        tangemValue = xrpBal * xrpPx;
        const plPct = ((xrpPx - TANGEM_XRP_ENTRY) / TANGEM_XRP_ENTRY * 100);
        const plUsd = (xrpPx - TANGEM_XRP_ENTRY) * xrpBal;
        // structured tangem object for dashboard.js data.tangem.* access
        tangemObj = { balance: xrpBal, price: xrpPx, valueUSD: tangemValue, entryPrice: TANGEM_XRP_ENTRY, unrealisedPnlPct: plPct, unrealisedPnlUsd: plUsd, address: TANGEM_XRP_ADDRESS };
      }
    } catch (e) { /* ignore */ }
    const usdAsset  = balancesRaw.find(b => b.currency === 'USD');
    const usdtAsset = balancesRaw.find(b => b.currency === 'USDT');
    cashUSD  = parseFloat(usdAsset?.available  || 0);
    cashUSDT = parseFloat(usdtAsset?.available || 0);
    const grandTotal = totalValue + krakenTotal + tangemValue + cashUSD + cashUSDT;
    const cap = getCapitalSummary(grandTotal);

    res.json({
      total_value_usd: totalValue.toFixed(2),
      grand_total_usd: grandTotal.toFixed(2),
      kraken_total_usd: krakenTotal.toFixed(2),
      tangem_value_usd: tangemValue.toFixed(2),
      tangem: tangemObj,    // structured object with balance/valueUSD/entryPrice for dashboard
      cash_usd: cashUSD.toFixed(2),
      cash_usdt: cashUSDT.toFixed(2),
      invested: cap.invested,
      pl_usd: cap.pnl.toFixed(2),
      pl_pct: cap.pnlPct.toFixed(2),
      break_even_pct: cap.breakEvenPct > 0 ? cap.breakEvenPct.toFixed(1) : null,
      positions
    });
  } catch (e) {
    console.error('[portfolio/summary] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

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

// GET /api/trailing-stops — all active trailing stops
app.get('/api/trailing-stops', (req, res) => {
  const out = {};
  for (const [sym, ts] of trailingStops) {
    out[sym] = { trailPct: ts.trailPct, peakPrice: ts.peakPrice, stopPrice: ts.stopPrice, entryPrice: ts.entryPrice };
  }
  res.json(out);
});

// POST /api/trailing-stops/:symbol — set trailing stop
app.post('/api/trailing-stops/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const { trail_pct } = req.body;
  if (!trail_pct || trail_pct <= 0 || trail_pct > 99) return res.status(400).json({ error: 'trail_pct must be 0.1–99' });
  try {
    const currentPrice = await getCurrentPrice(symbol);
    if (!currentPrice) return res.status(404).json({ error: `No price for ${symbol}` });
    const entryPrice = entryPrices.get(symbol) || null;
    const result = await setTrailingStop(symbol, parseFloat(trail_pct), currentPrice, entryPrice);
    res.json({ ok: true, symbol, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/trailing-stops/:symbol — remove trailing stop
app.delete('/api/trailing-stops/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  await removeTrailingStop(symbol);
  res.json({ ok: true, symbol });
});

// #57 S4: expose coin_strategy to the dashboard (read-only)
app.get('/api/coin-strategy', async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT symbol, status, role, theme, strategy_md, updated_at FROM coin_strategy ORDER BY symbol'
    );
    res.json({ strategies: rows });
  } catch (e) {
    console.error('[api] /api/coin-strategy error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// #57 S4: per-coin tranche/lot breakdown for the card (read-only)
app.get('/api/tranches/:symbol', async (req, res) => {
  try {
    const base = req.params.symbol.toUpperCase().replace('-USD', '');
    const [rows] = await db.execute(
      'SELECT symbol, exchange, remaining_quantity, entry_price, cost_basis, entry_date, is_legacy, notes FROM position_tranches WHERE symbol = ? AND remaining_quantity > 0 ORDER BY entry_date DESC',
      [base]
    );
    res.json({ symbol: base, tranches: rows });
  } catch (e) {
    console.error('[api] /api/tranches error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/auto-rules
app.get('/api/auto-rules', async (req, res) => {
  try {
    const [rules] = await db.execute('SELECT * FROM auto_trade_rules ORDER BY created_at DESC');
    res.json(rules);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/test/macro-news — manually trigger a macro news check (deploy & debug)
app.get('/api/test/macro-news', async (req, res) => {
  try {
    console.log('[macro-test] Manual trigger via API');
    // Reset rate limit so the test always fires Claude
    lastMacroNewsCallTime = 0;
    await checkMacroNews();
    res.json({ ok: true, message: 'Macro news check triggered — check Telegram and Railway logs' });
  } catch (e) {
    console.error('[macro-test] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/auto-rules
app.post('/api/auto-rules', async (req, res) => {
  try {
    const { symbol, rule_type, trigger_price, direction, order_type, volume, max_position_usd } = req.body;
    if (!symbol || !rule_type || !trigger_price || !direction || !order_type || !volume) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const sym = symbol.includes('-USD') ? symbol : `${symbol}-USD`;
    const [result] = await db.execute(
      'INSERT INTO auto_trade_rules (symbol, rule_type, trigger_price, direction, order_type, volume, max_position_usd) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [sym, rule_type, trigger_price, direction, order_type, volume, max_position_usd || null]
    );
    res.json({ ok: true, id: result.insertId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/auto-rules/:id
app.delete('/api/auto-rules/:id', async (req, res) => {
  try {
    await db.execute('DELETE FROM auto_trade_rules WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/auto-rules/:id/toggle
app.put('/api/auto-rules/:id/toggle', async (req, res) => {
  try {
    await db.execute('UPDATE auto_trade_rules SET active = NOT active WHERE id = ?', [req.params.id]);
    const [rows] = await db.execute('SELECT active FROM auto_trade_rules WHERE id = ?', [req.params.id]);
    res.json({ ok: true, active: rows[0]?.active });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Tax Lot API Endpoints ─────────────────────────────────────────────────────

// GET /api/tax/lots — all tax lots (optionally filter by symbol and/or status)
app.get('/api/tax/lots', async (req, res) => {
  try {
    const { symbol, status } = req.query;
    let query = 'SELECT * FROM tax_lots WHERE 1=1';
    const params = [];
    if (symbol) { query += ' AND symbol = ?'; params.push(symbol.toUpperCase()); }
    if (status) { query += ' AND lot_status = ?'; params.push(status); }
    query += ' ORDER BY acquired_at DESC';
    const [rows] = await db.execute(query, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/tax/summary — current-year gain/loss summary (US HIFO + UK S104)
app.get('/api/tax/summary', async (req, res) => {
  try {
    const [closedLots] = await db.execute(
      `SELECT symbol,
        SUM(gain_loss_usd) as total_gain_loss,
        SUM(CASE WHEN is_long_term = 1 THEN gain_loss_usd ELSE 0 END) as long_term_gain_loss,
        SUM(CASE WHEN is_long_term = 0 THEN gain_loss_usd ELSE 0 END) as short_term_gain_loss,
        COUNT(*) as disposals
       FROM tax_lots
       WHERE lot_status IN ('closed', 'partial') AND YEAR(disposed_at) = YEAR(NOW())
       GROUP BY symbol ORDER BY total_gain_loss DESC`
    );

    const totalGL    = closedLots.reduce((s, r) => s + parseFloat(r.total_gain_loss   || 0), 0);
    const longTermGL = closedLots.reduce((s, r) => s + parseFloat(r.long_term_gain_loss  || 0), 0);
    const shortTermGL = closedLots.reduce((s, r) => s + parseFloat(r.short_term_gain_loss || 0), 0);

    const [s104] = await db.execute('SELECT * FROM uk_s104_pool ORDER BY symbol');

    res.json({
      us_hifo: {
        total_gain_loss_usd: totalGL.toFixed(2),
        long_term_gain_loss_usd: longTermGL.toFixed(2),
        short_term_gain_loss_usd: shortTermGL.toFixed(2),
        by_symbol: closedLots
      },
      uk_s104: {
        pools: s104,
        note: 'S104 average cost pool — used for UK CGT calculation'
      },
      tax_year: new Date().getFullYear(),
      disclaimer: 'For informational purposes only. Consult a qualified tax advisor for US and UK filing.'
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/tax/export — CSV export for tax software
app.get('/api/tax/export', async (req, res) => {
  try {
    const [lots] = await db.execute(
      `SELECT * FROM tax_lots WHERE lot_status IN ('closed', 'partial') ORDER BY disposed_at ASC`
    );

    const csv = [
      'Symbol,Exchange,Quantity,Cost Per Unit,Cost Basis USD,Acquired Date,Disposed Date,Disposal Price,Disposal Value USD,Gain Loss USD,Holding Days,Term',
      ...lots.map(l => [
        l.symbol, l.exchange, l.quantity, l.cost_per_unit, l.cost_basis_usd,
        l.acquired_at, l.disposed_at, l.disposal_price, l.disposal_value_usd,
        l.gain_loss_usd, l.holding_days,
        l.is_long_term ? 'long-term' : 'short-term'
      ].join(','))
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="crypto-tax-lots.csv"');
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/tax/backfill — manually add a historical tax lot
app.post('/api/tax/backfill', async (req, res) => {
  try {
    const { symbol, exchange, quantity, cost_per_unit, acquired_at, notes } = req.body;
    if (!symbol || !quantity || !cost_per_unit || !acquired_at) {
      return res.status(400).json({ error: 'symbol, quantity, cost_per_unit, acquired_at required' });
    }
    await addTaxLot(
      symbol.toUpperCase(), exchange || 'revolut',
      parseFloat(quantity), parseFloat(cost_per_unit),
      new Date(acquired_at), null, notes || 'Backfilled historical position'
    );
    res.json({ ok: true, symbol: symbol.toUpperCase(), quantity, cost_per_unit, acquired_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/kraken/balances
app.get('/api/kraken/balances', async (req, res) => {
  try {
    const data = await getKrakenBalances();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/kraken/trade — execute a Kraken trade (requires approved: true)
app.post('/api/kraken/trade', async (req, res) => {
  try {
    const { symbol, side, orderType, volume, price, approved } = req.body;
    if (!approved) return res.status(400).json({ error: 'Trade requires approved: true explicitly set' });
    if (!symbol || !side || !orderType || !volume) return res.status(400).json({ error: 'Missing required fields: symbol, side, orderType, volume' });
    const result = await executeKrakenTrade(symbol, side, orderType, parseFloat(volume), price ? parseFloat(price) : null);
    const currentPrice = price ? parseFloat(price) : (await getCurrentPrice(symbol) || 0);
    const valueUSD = currentPrice * parseFloat(volume);
    const coinBase = symbol.replace('-USD', '');
    await db.execute(
      'INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [coinBase, side, currentPrice, parseFloat(volume), valueUSD, 'Kraken executed trade via dashboard', 'confident']
    ).catch(e => console.error('[kraken] Journal insert failed:', e.message));
    await sendTelegram(
      `✅ <b>KRAKEN TRADE EXECUTED</b>\n\n` +
      `${side.toUpperCase()} ${volume} ${coinBase} @ ${fmtPriceShort(currentPrice)}\n` +
      `Value: $${valueUSD.toFixed(2)}\n` +
      `Order ID: ${result?.txid?.[0] || 'unknown'}\n\n` +
      `📝 Journal entry logged automatically`
    );
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── processAlertChoice — handles numbered responses for any alert type ────────
// Called from both coin-prefixed ('xlm 1') and plain number ('1') handlers.
// ctx = { symbol, coinBase, alertType }   choice = integer 1–5
async function processAlertChoice(ctx, choice, sendReply) {
  const { symbol, coinBase, alertType } = ctx;

  // ── Claude analysis responses (trailing stop or fixed target) ─────────────
  if (alertType === 'claude_analysis_trailing' || alertType === 'claude_analysis_target') {
    const pending = pendingAnalysis.get(symbol);
    pendingAnalysis.delete(symbol);

    if (choice === 1) {
      const currentPrice = await getCurrentPrice(symbol).catch(() => null);
      if (!currentPrice) { await sendReply(`⚠️ Could not fetch ${coinBase} price`); return; }
      const balancesNow = await revolutRequest('GET', '/balances').catch(() => []);
      const asset = balancesNow.find(b => b.currency === coinBase);
      const currentQty = parseFloat(asset?.available || 0);
      if (currentQty <= 0) { await sendReply(`⚠️ No ${coinBase} balance found — nothing to sell`); return; }
      const sellQty = currentQty * 0.25;
      const valueUSD = sellQty * currentPrice;
      pendingRevolutTrade = { symbol, side: 'sell', orderType: 'market', baseSize: sellQty, price: currentPrice, valueUSD, timestamp: Date.now(), source: 'claude_analysis' };
      await db.execute(
        `INSERT INTO trade_intentions (symbol, action, reasoning, emotion, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
        [symbol, 'sell', `Claude analysis: SELL after trailing stop alert — ladder 25% out`, 'confident']
      ).catch(() => {});
      await sendReply(
        `🔔 <b>SELL REQUEST — ${coinBase}</b>\n\n` +
        `Selling 25% = ${sellQty.toFixed(4)} ${coinBase}\n` +
        `@ ~$${currentPrice.toFixed(4)} = ~$${valueUSD.toFixed(2)}\n\n` +
        `👍 approve  👎 cancel\n` +
        `Auto-cancels in 12.5 min if no response`
      );
      setTimeout(() => startTradeApprovalReminder('revolut'), 2.5 * 60 * 1000);

    } else if (choice === 2) {
      const currentPrice = await getCurrentPrice(symbol).catch(() => null);
      if (currentPrice && trailingStops.has(symbol)) {
        await setTrailingStop(symbol, trailingStops.get(symbol).trailPct, currentPrice, entryPrices.get(symbol));
        await sendReply(`✅ Trailing stop reset for ${coinBase}\nNew peak: ${fmtPriceShort(currentPrice)} | Stop: ${fmtPriceShort(trailingStops.get(symbol)?.stopPrice)}`);
      } else {
        await sendReply(`✅ ${coinBase} — holding noted`);
      }

    } else if (choice === 3) {
      if (pending?.type === 'fixed_target') {
        const currentPrice = await getCurrentPrice(symbol).catch(() => null);
        if (!currentPrice) { await sendReply(`⚠️ Could not fetch ${coinBase} price`); return; }
        const balancesNow = await revolutRequest('GET', '/balances').catch(() => []);
        const asset = balancesNow.find(b => b.currency === coinBase);
        const currentQty = parseFloat(asset?.available || 0);
        const sellQty = currentQty * 0.25;
        const valueUSD = sellQty * currentPrice;
        pendingRevolutTrade = { symbol, side: 'sell', orderType: 'market', baseSize: sellQty, price: currentPrice, valueUSD, timestamp: Date.now(), source: 'claude_analysis' };
        await sendReply(
          `🔔 <b>LADDER SELL — ${coinBase}</b>\n\n` +
          `Selling 25% = ${sellQty.toFixed(4)} ${coinBase}\n` +
          `@ ~$${currentPrice.toFixed(4)} = ~$${valueUSD.toFixed(2)}\n\n` +
          `👍 approve  👎 cancel`
        );
        setTimeout(() => startTradeApprovalReminder('revolut'), 2.5 * 60 * 1000);
      } else {
        alertState.acknowledged.set(symbol, Date.now());
        setTimeout(() => { alertState.acknowledged.delete(symbol); }, 30 * 60 * 1000);
        await sendReply(`⏳ ${coinBase} — watching for 30 min, then alert resumes`);
      }

    } else if (choice === 4) {
      const currentPrice = await getCurrentPrice(symbol).catch(() => null);
      if (!currentPrice) { await sendReply(`⚠️ Could not fetch ${coinBase} price`); return; }
      const balancesNow = await revolutRequest('GET', '/balances').catch(() => []);
      const usdAsset = balancesNow.find(b => b.currency === 'USD' || b.currency === 'USDT');
      const availableUSD = parseFloat(usdAsset?.available || 0);
      if (availableUSD < 10) { await sendReply(`⚠️ Insufficient USD to buy ${coinBase}\nAvailable: $${availableUSD.toFixed(2)} (min $10)`); return; }
      const buyUSD = Math.min(availableUSD * 0.50, availableUSD - 5);
      const buyQty = buyUSD / currentPrice;
      pendingRevolutTrade = { symbol, side: 'buy', orderType: 'market', baseSize: buyQty, price: currentPrice, valueUSD: buyUSD, timestamp: Date.now(), source: 'claude_analysis' };
      await db.execute(
        `INSERT INTO trade_intentions (symbol, action, reasoning, emotion, expires_at) VALUES (?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
        [symbol, 'buy', `Claude analysis: adding to ${coinBase} after trailing stop consolidation signal`, 'confident']
      ).catch(() => {});
      await sendReply(
        `🔔 <b>BUY REQUEST — ${coinBase}</b>\n\n` +
        `Buying $${buyUSD.toFixed(2)} worth = ${buyQty.toFixed(4)} ${coinBase}\n` +
        `@ ~$${currentPrice.toFixed(4)}\n` +
        `Available USD: $${availableUSD.toFixed(2)}\n\n` +
        `👍 approve  👎 cancel\n` +
        `Auto-cancels in 12.5 min if no response`
      );
      setTimeout(() => startTradeApprovalReminder('revolut'), 2.5 * 60 * 1000);

    } else if (choice === 5) {
      await acknowledgeAlert(symbol);
      await sendReply(`🔕 ${coinBase} alert dismissed`);
    }
    return;
  }

  // ── Pump / drop / trailing_stop / fixed_target alerts ─────────────────────
  const num = choice.toString();
  let action = null;
  if (alertType === 'pump') {
    action = { '1': 'hold', '2': 'sell', '3': 'buy', '4': 'analyse', '5': 'ignore' }[num];
  } else if (alertType === 'drop') {
    action = { '1': 'hold', '2': 'buy', '3': 'sell', '4': 'analyse', '5': 'ignore' }[num];
  } else if (alertType === 'trailing_stop') {
    action = { '1': 'hold', '2': 'sell', '3': 'acknowledge' }[num];
  } else if (alertType === 'fixed_target_up') {
    action = { '1': 'sell', '2': 'hold', '3': 'analyse', '4': 'acknowledge' }[num];
  } else if (alertType === 'fixed_target_down') {
    action = { '1': 'buy', '2': 'hold', '3': 'sell', '4': 'acknowledge' }[num];
  }

  if (!action) {
    await sendReply(`⚠️ Option ${choice} not valid for this ${coinBase} ${alertType} alert`);
    return;
  }

  console.log(`[alert] choice ${num} → '${action} ${coinBase}' (alertType: ${alertType})`);

  // Fetch price once for use in confirmations below
  const currentPriceForConfirm = await getCurrentPrice(symbol).catch(() => null);
  const priceStr = currentPriceForConfirm ? formatPrice(currentPriceForConfirm) : 'unknown';

  if (action === 'ignore') {
    await ignoreCoin(symbol);
    await sendReply(`🔕 ${coinBase} permanently ignored.`);
    return;
  }
  if (action === 'acknowledge') {
    await acknowledgeAlert(symbol);
    await sendReply(`✅ ${coinBase} alerts stopped.`);
    return;
  }
  if (action === 'hold' && alertType === 'trailing_stop') {
    const ts = trailingStops.get(symbol);
    if (ts && currentPriceForConfirm) {
      ts.peakPrice = currentPriceForConfirm;
      ts.stopPrice = currentPriceForConfirm * (1 - ts.trailPct / 100);
      trailingStops.set(symbol, ts);
      await sendReply(
        `✅ <b>HOLD — ${coinBase}</b>\n` +
        `Trailing stop reset @ ${priceStr}\n` +
        `New stop: ${fmtPriceShort(ts.stopPrice)} (-${ts.trailPct}%)`
      );
    } else {
      await sendReply(`✅ <b>HOLD — ${coinBase}</b>\nTrail continues — monitoring silently.`);
    }
    return;
  }
  if (action === 'hold') {
    await acknowledgeAlert(symbol);
    await sendReply(
      `✅ <b>HOLD — ${coinBase}</b>\n` +
      `Acknowledged @ ${priceStr}\n` +
      `Monitoring continues silently.`
    );
    return;
  }
  if (action === 'sell') {
    await sendReply(`📊 <b>SELL ADVICE — ${coinBase}</b>\nFetching analysis @ ${priceStr}…`);
    const changePct = currentPriceForConfirm && basePrices[symbol] ? ((currentPriceForConfirm - basePrices[symbol]) / basePrices[symbol] * 100) : 0;
    const advice = await getQuickAiRecommendation(symbol, changePct, currentPriceForConfirm, 'up', 'user requested sell advice via number shortcut');
    await sendReply(`💡 <b>${coinBase} Sell Advice</b>\n\n${advice}`);
    return;
  }
  if (action === 'buy') {
    await sendReply(`📊 <b>BUY ADVICE — ${coinBase}</b>\nFetching analysis @ ${priceStr}…`);
    const changePct = currentPriceForConfirm && basePrices[symbol] ? ((currentPriceForConfirm - basePrices[symbol]) / basePrices[symbol] * 100) : 0;
    const advice = await getQuickAiRecommendation(symbol, changePct, currentPriceForConfirm, 'down', 'user requested buy advice via number shortcut');
    await sendReply(`💡 <b>${coinBase} Buy Advice</b>\n\n${advice}`);
    return;
  }
  if (action === 'analyse') {
    await sendReply(`🧠 <b>ANALYSING — ${coinBase}</b>\nRunning full AI analysis @ ${priceStr}…`);
    const changePct = currentPriceForConfirm && basePrices[symbol] ? ((currentPriceForConfirm - basePrices[symbol]) / basePrices[symbol] * 100) : 0;
    const analysis = await getQuickAiRecommendation(symbol, changePct, currentPriceForConfirm, 'up', 'full analysis requested via number shortcut');
    await sendReply(`📊 <b>${coinBase} Full Analysis</b>\n\n${analysis}`);
    return;
  }
}

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

    // ── Admin journal delete — two-step guarded command ───────────────────────
    // Authorized chat only: TELEGRAM_CHAT_ID (same constant the bot always uses)
    const isAuthorizedAdmin = chatId.toString() === TELEGRAM_CHAT_ID.toString();

    // Step 4: implicit cancel — if a delete is armed and this message is NOT the
    // confirmation, cancel it BEFORE normal routing so other commands still work.
    if (pendingJournalDelete && isAuthorizedAdmin) {
      if (commandText !== 'admin confirm delete') {
        const cancelledId = pendingJournalDelete.id;
        pendingJournalDelete = null;
        await sendReply(`Delete cancelled (row ${cancelledId} is safe).`);
        // fall through — do not return; let the actual command still execute below
      }
    }

    // Step 2: arm — "admin del journal <id>"
    const adminDelMatch = commandText.match(/^admin\s+del\s+journal\s+(\d+)$/i);
    if (adminDelMatch) {
      if (!isAuthorizedAdmin) { await sendReply('Unauthorized'); return res.status(200).json({ ok: true }); }
      const rowId = parseInt(adminDelMatch[1], 10);
      if (!Number.isInteger(rowId) || rowId <= 0) {
        await sendReply('Usage: admin del journal &lt;id&gt;');
        return res.status(200).json({ ok: true });
      }
      try {
        const [rows] = await db.execute(
          'SELECT id, symbol, action, price, quantity, value_usd, reasoning, created_at FROM trading_journal WHERE id = ? LIMIT 1',
          [rowId]
        );
        if (!rows.length) {
          pendingJournalDelete = null;
          await sendReply(`No journal row with id ${rowId}.`);
          return res.status(200).json({ ok: true });
        }
        const r = rows[0];
        const summary = `${r.action} ${r.symbol} qty=${r.quantity} price=${r.price} val=$${r.value_usd} @ ${r.created_at}`;
        pendingJournalDelete = { id: rowId, summary, expiresAt: Date.now() + 60000 };
        await sendReply(
          `<b>Journal row ${rowId}:</b>\n` +
          `Action: ${r.action} | Symbol: ${r.symbol}\n` +
          `Price: ${r.price} | Qty: ${r.quantity} | Value: $${r.value_usd}\n` +
          `Reasoning: ${r.reasoning || '—'}\n` +
          `Created: ${r.created_at}\n\n` +
          `Reply '<b>admin confirm delete</b>' within 60s to permanently delete this row. Reply anything else to cancel.`
        );
      } catch (e) {
        console.error('[admin] del journal lookup error:', e.message);
        await sendReply('Error fetching row: ' + e.message);
      }
      return res.status(200).json({ ok: true });
    }

    // Step 3: confirm — "admin confirm delete"
    if (commandText === 'admin confirm delete') {
      if (!isAuthorizedAdmin) { await sendReply('Unauthorized'); return res.status(200).json({ ok: true }); }
      if (!pendingJournalDelete || Date.now() > pendingJournalDelete.expiresAt) {
        pendingJournalDelete = null;
        await sendReply('No pending delete (expired or none armed).');
        return res.status(200).json({ ok: true });
      }
      const { id: deleteId, summary: deleteSummary } = pendingJournalDelete;
      pendingJournalDelete = null;
      try {
        const [result] = await db.execute('DELETE FROM trading_journal WHERE id = ?', [deleteId]);
        console.log(`[admin] journal row deleted id=${deleteId} affectedRows=${result.affectedRows}`);
        await sendReply(`Deleted journal row ${deleteId} (${deleteSummary}). affectedRows=${result.affectedRows}`);
      } catch (e) {
        console.error('[admin] del journal execute error:', e.message);
        await sendReply('Delete failed: ' + e.message);
      }
      return res.status(200).json({ ok: true });
    }
    // ─────────────────────────────────────────────────────────────────────────

    // --- Alert reply shortcuts: coin-prefixed ('xlm 1') or plain number ('1') ---
    const chatIdStr = chatId.toString();

    // Coin-prefixed reply: 'xlm 1', 'near 2', 'hft 5' etc.
    const coinPrefixMatch = commandText.match(/^([a-z]+)\s+([1-5])$/);
    if (coinPrefixMatch) {
      const targetCoin = coinPrefixMatch[1].toLowerCase();
      const choice = parseInt(coinPrefixMatch[2]);
      const ctx = alertContextBySymbol.get(targetCoin);
      if (!ctx) {
        const available = [...alertContextBySymbol.keys()].map(c => c.toUpperCase()).join(', ') || 'none';
        await sendReply(`⚠️ No active alert for <b>${targetCoin.toUpperCase()}</b>\nActive alerts: ${available}`);
        return res.status(200).json({ ok: true });
      }
      alertContextBySymbol.delete(targetCoin);
      if (lastAlertCoin === targetCoin) lastAlertCoin = null;
      await processAlertChoice(ctx, choice, sendReply);
      return res.status(200).json({ ok: true });
    }

    // Plain number reply — targets the OLDEST pending alert (most natural sequential order)
    const numberReply = commandText.match(/^[1-5]$/);
    if (numberReply && alertContextBySymbol.size > 0) {
      const oldestEntry = [...alertContextBySymbol.entries()]
        .sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
      if (oldestEntry) {
        const [oldestCoin, ctx] = oldestEntry;
        const choice = parseInt(numberReply[0]);
        alertContextBySymbol.delete(oldestCoin);
        if (lastAlertCoin === oldestCoin) lastAlertCoin = null;
        await processAlertChoice(ctx, choice, sendReply);
        return res.status(200).json({ ok: true });
      }
    }

    // --- Pending journal state handler (emotion / followed flow) ---
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

    // --- Pending rebalance confirmation: 'yes' / 'no' reply ---
    if (pendingRebalanceConfirm.has('main')) {
      const lowerMsg2 = commandText.toLowerCase().trim();
      const isYes = /^(yes|y|rebalance|yes rebalance|rebalancing)$/i.test(lowerMsg2);
      const isNo  = /^(no|n|separate|no separate)$/i.test(lowerMsg2);
      if (isYes || isNo) {
        const conf = pendingRebalanceConfirm.get('main');
        pendingRebalanceConfirm.delete('main');
        if (isYes) {
          // Clear both from pendingTradeContext
          const sellKey = [...pendingTradeContext.keys()].find(k => k.replace('-USD','') === conf.sellSymbol);
          const buyKey  = [...pendingTradeContext.keys()].find(k => k.replace('-USD','') === conf.buySymbol);
          if (sellKey) { clearTimeout(pendingTradeContext.get(sellKey).timeoutHandle); pendingTradeContext.delete(sellKey); }
          if (buyKey)  { clearTimeout(pendingTradeContext.get(buyKey).timeoutHandle);  pendingTradeContext.delete(buyKey);  }
          await logRebalancePair(conf);
          const rebalDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          await sendReply(
            `✅ Rebalancing logged!\n` +
            `📤 OUT: ${conf.sellSymbol} @ $${conf.sellPrice?.toFixed(4)}\n` +
            `📥 IN: ${conf.buySymbol} @ $${conf.buyPrice?.toFixed(4)}\n\n` +
            `I'll check back in 7 days — did ${conf.buySymbol} outperform ${conf.sellSymbol}? 📊`
          );
        } else {
          // User wants separate trade logging — individual context messages already sent, nothing more to do
          await sendReply(`OK, logging as separate trades. Reply to each trade prompt for details.`);
        }
        return res.status(200).json({ ok: true });
      }
    }

    // --- Auto-trade context: natural language replies when any trade is pending ---
    if (pendingTradeContext.size > 0) {
      const EMOTION_WORDS = ['confident', 'uncertain', 'fomo', 'fearful', 'neutral'];
      const lowerMsg = commandText.toLowerCase();

      // Find which pending coins are mentioned (or referenced) in this message
      const matchedPending = [];
      for (const [symbol, pending] of pendingTradeContext) {
        const coinBase = symbol.replace('-USD', '').toLowerCase();
        // Check explicit "[COIN] skip" or bare "skip" with one pending
        if (
          lowerMsg === `${coinBase} skip` ||
          lowerMsg === `skip ${coinBase}` ||
          (lowerMsg.trim() === 'skip' && pendingTradeContext.size === 1)
        ) {
          matchedPending.push({ symbol, pending, skip: true });
        } else if (lowerMsg.includes(coinBase)) {
          matchedPending.push({ symbol, pending, skip: false });
        }
      }

      // If only one trade pending and message doesn't explicitly mention other coins,
      // treat ANY non-command message as context for that trade
      if (matchedPending.length === 0 && pendingTradeContext.size === 1) {
        const [[symbol, pending]] = pendingTradeContext;
        const trimmed = lowerMsg.trim();

        // Single-word shortcuts always route to the pending trade — do NOT treat as unknown commands
        const singleWordShortcuts = ['payment', 'transfer', 'skip', 'rebalance'];
        if (singleWordShortcuts.includes(trimmed)) {
          matchedPending.push({ symbol, pending, skip: trimmed === 'skip' });
        } else {
          // For everything else, only intercept if it isn't a recognised system command
          const isKnownCommand = /^(pause|resume|status|acknowledge|ack|ignore|watch|sell|buy|entry|daily|target|journal|my stats|learning|holding|bought|sold|i prefer|trail|trailing|approve|cancel)/i.test(commandText);
          if (!isKnownCommand) {
            matchedPending.push({ symbol, pending, skip: false });
          }
        }
      }

      // --- Simple rebalance reply: 'rebalance [SOLD_COIN]' ---
      // When one trade is pending and user names the coin they sold to fund it.
      // e.g. pending BUY of NEAR, user types 'rebalance CC' → bought NEAR with CC proceeds.
      const simpleRebalanceMatch = rawText.match(/^rebalance\s+([A-Za-z0-9]{2,10})$/i);
      if (simpleRebalanceMatch && pendingTradeContext.size === 1) {
        const fromCoin = simpleRebalanceMatch[1].toUpperCase();
        const [[symbol, pending]] = pendingTradeContext;
        const coinBase = symbol.replace('-USD', '');
        clearTimeout(pending.timeoutHandle);
        pendingTradeContext.delete(symbol);
        const reasoning = `Rebalancing — bought ${coinBase} with proceeds from selling ${fromCoin}`;
        await db.execute(
          'UPDATE trading_journal SET reasoning = ?, emotion = ? WHERE id = ?',
          [reasoning, 'confident', pending.journalId]
        );
        // Try to find and pair the matching sell entry
        const [fromRows] = await db.execute(
          "SELECT id, price, value_usd, quantity FROM trading_journal WHERE symbol = ? AND action = 'sell' AND created_at > DATE_SUB(NOW(), INTERVAL 4 HOUR) ORDER BY created_at DESC LIMIT 1",
          [`${fromCoin}-USD`]
        ).catch(() => [[]]);
        if (fromRows.length > 0) {
          const fr = fromRows[0];
          await logRebalancePair({
            sellSymbol: fromCoin, sellJournalId: fr.id, sellPrice: parseFloat(fr.price),
            sellValueUsd: Math.abs(parseFloat(fr.value_usd || 0)), sellQty: parseFloat(fr.quantity || 0),
            buySymbol: coinBase, buyJournalId: pending.journalId, buyPrice: pending.price,
            buyValueUsd: pending.valueUsd, buyQty: pending.qty,
          }).catch(() => {});
        }
        await updateLearningModel().catch(() => {});
        await sendReply(
          `✅ <b>REBALANCE LOGGED — ${coinBase}</b>\n\n` +
          `📤 OUT: ${fromCoin} → 📥 IN: ${coinBase}\n` +
          `📝 Journal: "${reasoning}"\n` +
          `🧠 Learning model updated`
        );
        return res.status(200).json({ ok: true });
      }

      // --- Coin-prefixed rebalance: '[BOUGHT_COIN] rebalance [SOLD_COIN]' ---
      // e.g. 'near rebalance cc' — bought NEAR using CC proceeds.
      const coinRebalanceMatch = rawText.match(/^([A-Za-z0-9]{2,10})\s+rebalance\s+([A-Za-z0-9]{2,10})$/i);
      if (coinRebalanceMatch) {
        const boughtCoin = coinRebalanceMatch[1].toUpperCase();
        const soldCoin   = coinRebalanceMatch[2].toUpperCase();
        const buySymbol  = `${boughtCoin}-USD`;
        const pending    = pendingTradeContext.get(buySymbol);
        if (pending) {
          clearTimeout(pending.timeoutHandle);
          pendingTradeContext.delete(buySymbol);
          const reasoning = `Rebalancing — bought ${boughtCoin} with proceeds from selling ${soldCoin}`;
          await db.execute(
            'UPDATE trading_journal SET reasoning = ?, emotion = ? WHERE id = ?',
            [reasoning, 'confident', pending.journalId]
          );
          const [fromRows2] = await db.execute(
            "SELECT id, price, value_usd, quantity FROM trading_journal WHERE symbol = ? AND action = 'sell' AND created_at > DATE_SUB(NOW(), INTERVAL 4 HOUR) ORDER BY created_at DESC LIMIT 1",
            [`${soldCoin}-USD`]
          ).catch(() => [[]]);
          if (fromRows2.length > 0) {
            const fr2 = fromRows2[0];
            await logRebalancePair({
              sellSymbol: soldCoin, sellJournalId: fr2.id, sellPrice: parseFloat(fr2.price),
              sellValueUsd: Math.abs(parseFloat(fr2.value_usd || 0)), sellQty: parseFloat(fr2.quantity || 0),
              buySymbol: boughtCoin, buyJournalId: pending.journalId, buyPrice: pending.price,
              buyValueUsd: pending.valueUsd, buyQty: pending.qty,
            }).catch(() => {});
          }
          await updateLearningModel().catch(() => {});
          await sendReply(
            `✅ <b>REBALANCE LOGGED — ${boughtCoin}</b>\n\n` +
            `📤 OUT: ${soldCoin} → 📥 IN: ${boughtCoin}\n` +
            `📝 Journal: "${reasoning}"\n` +
            `🧠 Learning model updated`
          );
          return res.status(200).json({ ok: true });
        }
      }

      // --- Smart rebalance detection ---
      // Detect: "near hype rebalance", "rebalanced near into hype", "swapped near for hype", "near into hype", "moved near to hype"
      const isRebalanceIntent = lowerMsg.includes('rebalance') || lowerMsg.includes('rebalancing') ||
        /\binto\b|\bswapped\b|\bmoved\b/.test(lowerMsg);

      if (isRebalanceIntent) {
        // Find all pending coins mentioned in the message
        const pendingCoinsInMsg = [];
        for (const [symbol, pending] of pendingTradeContext) {
          if (lowerMsg.includes(symbol.replace('-USD', '').toLowerCase())) {
            pendingCoinsInMsg.push({ symbol, pending });
          }
        }

        // Also check recent journal entries (last 2 hours) for coins mentioned but past 30min window
        const recentJournalMatches = [];
        const allWords = lowerMsg.split(/\s+/).map(w => w.replace(/[^a-z]/g, '').toUpperCase()).filter(w => w.length >= 2);
        if (pendingCoinsInMsg.length < 2) {
          try {
            const [recentRows] = await db.execute(
              "SELECT id, symbol, action, price, value_usd, quantity FROM trading_journal WHERE created_at > DATE_SUB(NOW(), INTERVAL 2 HOUR) AND action IN ('buy','sell','transfer') ORDER BY created_at DESC LIMIT 20"
            );
            for (const row of recentRows) {
              const sym = row.symbol.replace('-USD','');
              if (allWords.includes(sym) && !pendingCoinsInMsg.find(p => p.symbol.replace('-USD','') === sym)) {
                recentJournalMatches.push({ symbol: row.symbol, journalId: row.id, action: row.action, price: parseFloat(row.price), valueUsd: Math.abs(parseFloat(row.value_usd || 0)), qty: parseFloat(row.quantity || 0) });
              }
            }
          } catch (e) { /* ignore */ }
        }

        // Build full candidate list
        const candidates = [
          ...pendingCoinsInMsg.map(p => ({ symbol: p.symbol, pending: p.pending, journalId: p.pending.journalId, action: p.pending.action, price: p.pending.price, valueUsd: p.pending.valueUsd, qty: p.pending.qty, fromPending: true })),
          ...recentJournalMatches.map(r => ({ symbol: r.symbol, journalId: r.journalId, action: r.action, price: r.price, valueUsd: r.valueUsd, qty: r.qty, fromPending: false })),
        ];

        const sellCandidate = candidates.find(c => c.action === 'sell');
        const buyCandidate  = candidates.find(c => c.action === 'buy' || c.action === 'transfer');

        if (candidates.length >= 2 && sellCandidate && buyCandidate && sellCandidate.symbol !== buyCandidate.symbol) {
          // Clear both from pendingTradeContext if they're there
          if (sellCandidate.fromPending) { clearTimeout(sellCandidate.pending?.timeoutHandle); pendingTradeContext.delete(sellCandidate.symbol); }
          if (buyCandidate.fromPending)  { clearTimeout(buyCandidate.pending?.timeoutHandle);  pendingTradeContext.delete(buyCandidate.symbol);  }

          const sellSym = sellCandidate.symbol.replace('-USD', '');
          const buySym  = buyCandidate.symbol.replace('-USD', '');

          await logRebalancePair({
            sellSymbol: sellSym, sellJournalId: sellCandidate.journalId, sellPrice: sellCandidate.price, sellValueUsd: sellCandidate.valueUsd, sellQty: sellCandidate.qty,
            buySymbol:  buySym,  buyJournalId:  buyCandidate.journalId,  buyPrice:  buyCandidate.price,  buyValueUsd:  buyCandidate.valueUsd,  buyQty:  buyCandidate.qty,
          });

          const rebalDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
          await sendReply(
            `✅ Rebalancing logged!\n` +
            `📤 OUT: ${sellSym} @ $${sellCandidate.price?.toFixed(4)} ($${sellCandidate.valueUsd?.toFixed(2)})\n` +
            `📥 IN: ${buySym} @ $${buyCandidate.price?.toFixed(4)} ($${buyCandidate.valueUsd?.toFixed(2)})\n\n` +
            `I'll check back in 7 days — did ${buySym} outperform ${sellSym}? 📊`
          );
          return res.status(200).json({ ok: true });
        }

        // Single coin with rebalance keyword — log that coin as transfer, look for in-coin in message or recent buys
        if (candidates.length >= 1) {
          const outCandidate = sellCandidate || candidates[0];
          const outSym = outCandidate.symbol.replace('-USD', '');
          if (outCandidate.fromPending) { clearTimeout(outCandidate.pending?.timeoutHandle); pendingTradeContext.delete(outCandidate.symbol); }

          // Try to find in-coin from message words (not already in candidates)
          const inCoinFromMsg = allWords.find(w => w.length >= 2 && w !== outSym && w !== 'REBALANCE' && w !== 'INTO' && w !== 'SWAP' && w !== 'MOVE' && w !== 'FROM' && w !== 'FOR');

          // Look for any recent BUY in journal if no pending buy found
          let inPrice = null, inJournalId = null, inSym = inCoinFromMsg || null;
          if (!buyCandidate && inSym) {
            try {
              const [inRows] = await db.execute(
                "SELECT id, price FROM trading_journal WHERE symbol = ? AND action = 'buy' AND created_at > DATE_SUB(NOW(), INTERVAL 2 HOUR) ORDER BY created_at DESC LIMIT 1",
                [inSym]
              );
              if (inRows.length > 0) { inPrice = parseFloat(inRows[0].price); inJournalId = inRows[0].id; }
            } catch (e) { /* ignore */ }
          } else if (buyCandidate) {
            inSym = buyCandidate.symbol.replace('-USD', '');
            inPrice = buyCandidate.price;
            inJournalId = buyCandidate.journalId;
            if (buyCandidate.fromPending) { clearTimeout(buyCandidate.pending?.timeoutHandle); pendingTradeContext.delete(buyCandidate.symbol); }
          }

          await logRebalancePair({
            sellSymbol: outSym, sellJournalId: outCandidate.journalId, sellPrice: outCandidate.price, sellValueUsd: outCandidate.valueUsd, sellQty: outCandidate.qty,
            buySymbol: inSym, buyJournalId: inJournalId, buyPrice: inPrice, buyValueUsd: null, buyQty: null,
          });

          const inLine = inSym ? `📥 IN: ${inSym}${inPrice ? ` @ $${inPrice.toFixed(4)}` : ' (price TBC)'}` : '📥 IN: (not specified)';
          await sendReply(
            `✅ Rebalancing logged!\n` +
            `📤 OUT: ${outSym} @ $${outCandidate.price?.toFixed(4)} ($${outCandidate.valueUsd?.toFixed(2)})\n` +
            `${inLine}\n\n` +
            `I'll check back in 7 days — did ${inSym || 'the new position'} outperform ${outSym}? 📊`
          );
          return res.status(200).json({ ok: true });
        }
      }

      // --- Transfer detection: "[coin] transfer" ---
      const isTransferMsg = lowerMsg.includes('transfer') ||
        /internal transfer|rebalancing|moved to kraken|moved between/i.test(lowerMsg);
      const transferMatch = isTransferMsg
        ? (matchedPending.find(m => lowerMsg.includes(m.symbol.replace('-USD', '').toLowerCase())) || matchedPending[0])
        : null;
      if (transferMatch) {
        const { symbol, pending } = transferMatch;
        const coinBase = symbol.replace('-USD', '');
        clearTimeout(pending.timeoutHandle);
        pendingTradeContext.delete(symbol);
        await db.execute(
          'UPDATE trading_journal SET action = ?, reasoning = ?, emotion = ? WHERE id = ?',
          ['transfer', 'Internal transfer — capital rebalanced within portfolio, invested capital unchanged', 'neutral', pending.journalId]
        );
        await updateLearningModel().catch(() => {});
        await sendReply(
          `✅ <b>${coinBase}</b> logged as internal transfer\n` +
          `💼 Invested capital unchanged — funds rebalanced within portfolio\n` +
          `📊 Excluded from trading stats`
        );
        return res.status(200).json({ ok: true });
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

        // AUTO-DEDUCT FROM INVESTED CAPITAL
        try {
          const [jRows] = await db.execute(
            'SELECT value_usd FROM trading_journal WHERE id = ?',
            [pending.journalId]
          );
          const paymentValueUsd = jRows[0]?.value_usd
            ? Math.abs(parseFloat(jRows[0].value_usd))
            : null;

          if (paymentValueUsd && paymentValueUsd > 0) {
            const prevInvested = totalInvestedCapital;
            const newTotal = totalInvestedCapital - paymentValueUsd;
            await updateInvestedCapital(
              newTotal,
              `Auto-deducted: ${coinBase} payment -$${paymentValueUsd.toFixed(2)}`
            );

            await sendReply(
              `✅ <b>${coinBase}</b> logged as payment\n` +
              `💸 $${paymentValueUsd.toFixed(2)} auto-deducted from invested capital\n` +
              `💰 Previous: $${prevInvested.toFixed(2)}\n` +
              `💰 Updated: $${newTotal.toFixed(2)}\n` +
              `📊 Excluded from trading stats`
            );
          } else {
            await sendReply(
              `✅ <b>${coinBase}</b> logged as payment — excluded from stats`
            );
          }
        } catch (e) {
          console.error('[payment] Capital auto-deduct error:', e.message);
          await sendReply(
            `✅ <b>${coinBase}</b> logged as payment — excluded from stats\n` +
            `⚠️ Could not auto-update capital — update manually`
          );
        }

        await updateLearningModel().catch(() => {});
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

    // --- Commands: capital recovery from daily snapshot ---
    if (/^restore capital$/i.test(commandText)) {
      try {
        const [snap] = await db.execute("SELECT config_value FROM system_config WHERE config_key = 'capital_daily_snapshot'");
        if (snap.length > 0) {
          const data = JSON.parse(snap[0].config_value);
          await sendReply(
            `📊 <b>Last capital snapshot:</b>\n\n` +
            `Amount: $${parseFloat(data.amount).toFixed(2)}\n` +
            `Saved: ${new Date(data.date).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })}\n` +
            `Portfolio at time: $${parseFloat(data.portfolio_value || 0).toFixed(2)}\n\n` +
            `Reply '<b>confirm restore capital</b>' to restore`
          );
        } else {
          await sendReply('No capital snapshot found — snapshot saves daily at midnight.');
        }
      } catch (e) { await sendReply('Error fetching snapshot: ' + e.message); }
      return res.status(200).json({ ok: true });
    }

    if (/^confirm restore capital$/i.test(commandText)) {
      try {
        const [snap] = await db.execute("SELECT config_value FROM system_config WHERE config_key = 'capital_daily_snapshot'");
        if (snap.length > 0) {
          const data = JSON.parse(snap[0].config_value);
          totalInvestedCapital = parseFloat(data.amount);
          await db.execute('INSERT INTO invested_capital (total_invested, note) VALUES (?, ?)', [totalInvestedCapital, 'Restored from daily snapshot']);
          await sendReply(`✅ Capital restored to <b>$${totalInvestedCapital.toFixed(2)}</b>\nFrom snapshot dated ${new Date(data.date).toLocaleDateString('en-GB')}`);
        } else {
          await sendReply('No snapshot to restore from.');
        }
      } catch (e) { await sendReply('Restore error: ' + e.message); }
      return res.status(200).json({ ok: true });
    }

    // Handle 'confirm capital X.XX' — approve a blocked large capital change
    const confirmCapitalMatch = commandText.match(/^confirm capital\s+([\d.]+)$/i);
    if (confirmCapitalMatch) {
      const newAmt = parseFloat(confirmCapitalMatch[1]);
      if (!isNaN(newAmt)) {
        totalInvestedCapital = newAmt;
        await db.execute('INSERT INTO invested_capital (total_invested, note) VALUES (?, ?)', [newAmt, 'Manually confirmed via Telegram']);
        await sendReply(`✅ Capital updated to <b>$${newAmt.toFixed(2)}</b>`);
      }
      return res.status(200).json({ ok: true });
    }

    if (/^skip capital$/i.test(commandText)) {
      await sendReply('✅ Capital change cancelled — no update made.');
      return res.status(200).json({ ok: true });
    }

    // Handle 'confirm payment X.XX' — approve a blocked large USDT payment
    const confirmPaymentMatch = commandText.match(/^confirm payment\s+([\d.]+)$/i);
    if (confirmPaymentMatch) {
      const payAmt = parseFloat(confirmPaymentMatch[1]);
      if (!isNaN(payAmt)) {
        await db.execute(
          `INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ['USDT', 'payment', 1.00, payAmt, payAmt, `Revolut debit card payment — $${payAmt.toFixed(2)} USDT (manually confirmed)`, 'neutral', 'revolut_card']
        );
        const prevCap = totalInvestedCapital;
        const newCap  = totalInvestedCapital - payAmt;
        await updateInvestedCapital(newCap, `Card payment confirmed: -$${payAmt.toFixed(2)}`);
        await sendReply(`✅ Payment $${payAmt.toFixed(2)} logged\nCapital: $${prevCap.toFixed(2)} → $${newCap.toFixed(2)}`);
      }
      return res.status(200).json({ ok: true });
    }

    // 'skip payment X' reverses an auto-logged payment (re-credits capital + deletes the row). 'skip payment' alone reverses the most recent.
    const skipPaymentMatch = commandText.match(/^skip payment(?:\s+([\d.]+))?$/i);
    if (skipPaymentMatch) {
      const skipAmt = skipPaymentMatch[1] ? parseFloat(skipPaymentMatch[1]) : null;
      let rows;
      if (skipAmt !== null && !isNaN(skipAmt)) {
        [rows] = await db.execute(
          `SELECT id, quantity FROM trading_journal
           WHERE symbol = 'USDT' AND action = 'payment' AND source = 'revolut_card'
           AND ABS(quantity - ?) < 0.05
           ORDER BY created_at DESC LIMIT 1`,
          [skipAmt]
        ).catch(() => [[]]);
      } else {
        [rows] = await db.execute(
          `SELECT id, quantity FROM trading_journal
           WHERE symbol = 'USDT' AND action = 'payment' AND source = 'revolut_card'
           AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
           ORDER BY created_at DESC LIMIT 1`
        ).catch(() => [[]]);
      }
      if (rows && rows.length > 0) {
        const row = rows[0];
        const amt = parseFloat(row.quantity);
        const prevCap = totalInvestedCapital;
        const newCap  = totalInvestedCapital + amt;
        await updateInvestedCapital(newCap, `Payment skipped/reversed: +$${amt.toFixed(2)}`);
        await db.execute(`DELETE FROM trading_journal WHERE id = ?`, [row.id]).catch(() => {});
        await sendReply(`✅ Payment $${amt.toFixed(2)} reversed.\nCapital: $${prevCap.toFixed(2)} → $${newCap.toFixed(2)}`);
      } else {
        await sendReply('⚠️ No matching payment found to skip.');
      }
      return res.status(200).json({ ok: true });
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
        await sendReply(`✅ ${coinBase} alerts stopped.`);
      } else {
        // Generic ack — clear the first active alert found across all types
        const symbol =
          [...alertState.active.keys()][0] ||
          [...activeDropAlerts.keys()][0]  ||
          [...activeFixedAlerts.keys()][0];
        if (symbol) {
          const coinBase = symbol.replace('-USD', '');
          console.log('[telegram] Generic acknowledge — targeting:', symbol);
          await acknowledgeAlert(symbol);
          await sendReply(`✅ ${coinBase} alerts stopped.`);
        } else {
          await sendReply('✅ No active alerts to acknowledge.');
        }
      }
      return res.status(200).json({ ok: true });
    }

    // --- Command: undo — reverse last AI auto-executed trade ---
    if (/^undo$/i.test(commandText)) {
      const recent = [...pendingUndo.entries()].sort((a, b) => b[1].timestamp - a[1].timestamp)[0];
      if (!recent) {
        await sendReply('No recent auto-exec to undo (2-min window expired)');
        return res.status(200).json({ ok: true });
      }
      const [sym, undo] = recent;
      pendingUndo.delete(sym);
      const coinBase = sym.replace('-USD', '');
      if (undo.action === 'sell') {
        pendingRevolutTrade = {
          symbol: sym, side: 'buy', orderType: 'market',
          baseSize: undo.qty, price: undo.price,
          valueUSD: undo.qty * undo.price,
          timestamp: Date.now(), source: 'undo'
        };
        await sendReply(
          `⏪ <b>UNDO — ${coinBase}</b>\n\n` +
          `Buying back ${undo.qty.toFixed(4)} ${coinBase}\n` +
          `👍 confirm undo  👎 keep as is`
        );
      }
      return res.status(200).json({ ok: true });
    }

    // --- Command: alerts — list all active alert contexts waiting for a reply ---
    if (commandText === 'alerts') {
      if (alertContextBySymbol.size === 0) {
        await sendReply('📋 No active alerts waiting for a response.');
      } else {
        const list = [...alertContextBySymbol.entries()]
          .sort((a, b) => b[1].timestamp - a[1].timestamp)
          .map(([coin, ctx]) => {
            const age = Math.round((Date.now() - ctx.timestamp) / 60000);
            return `• <b>${coin.toUpperCase()}</b> — ${ctx.alertType} (${age}min ago)`;
          }).join('\n');
        await sendReply(
          `📋 <b>Active alerts waiting for response:</b>\n\n${list}\n\n` +
          `Reply with number (uses most recent) or '<b>coin number</b>' e.g. 'xlm 2'`
        );
      }
      return res.status(200).json({ ok: true });
    }

    // --- Command: ignore [COIN] — permanently stop all alerts for a coin ---
    const ignoreMatch = commandText.match(/^ignore\s+([a-z0-9]{2,10})$/);
    if (ignoreMatch) {
      const coinBase = ignoreMatch[1].toUpperCase();
      const symbol = `${coinBase}-USD`;
      console.log('[telegram] Ignore command for:', symbol);
      await ignoreCoin(symbol);
      await sendReply(`🔕 ${coinBase} permanently ignored.`);
      return res.status(200).json({ ok: true });
    }

    // --- Command: watch [COIN] [pct%] — re-enable alerts for a coin ---
    const watchMatch = commandText.match(/^watch\s+([a-z0-9]{2,10})(?:\s+([\d.]+)%?)?$/);
    if (watchMatch) {
      const coinBase = watchMatch[1].toUpperCase();
      const symbol = `${coinBase}-USD`;
      const customPct = watchMatch[2] ? parseFloat(watchMatch[2]) : null;
      console.log('[telegram] Watch command for:', symbol, customPct ? `at ${customPct}%` : '(default threshold)');
      await resumeAlerts(symbol);
      // Clear any stale cached advice
      responseCache.delete(`sell:${symbol}`);
      responseCache.delete(`buy:${symbol}`);
      let reply = `✅ <b>${coinBase} alerts re-enabled.</b>`;
      if (customPct && customPct > 0 && customPct <= 100) {
        const threshold = customPct / 100;
        await setThreshold(symbol, threshold);
        reply += `\n🎯 Alert threshold set to ${customPct}% — I'll notify you on the next ${customPct}% move.`;
      } else {
        reply += `\n📡 Using default threshold — I'll alert you on the next significant move.`;
      }
      await sendReply(reply);
      return res.status(200).json({ ok: true });
    }

    // --- Command: trailing stop COIN X% / trail COIN X% — set trailing stop ---
    const trailSetMatch = commandText.match(/^(?:trailing\s+stop|trail)\s+([a-z0-9]{2,10})\s+([\d.]+)%?$/i);
    if (trailSetMatch) {
      const coinBase   = trailSetMatch[1].toUpperCase();
      const symbol     = `${coinBase}-USD`;
      const trailPct   = parseFloat(trailSetMatch[2]);
      if (trailPct <= 0 || trailPct > 99) {
        await sendReply(`❌ Trail % must be between 0.1 and 99. Example: 'trail HYPE 12%'`);
        return res.status(200).json({ ok: true });
      }
      const currentPrice = await getCurrentPrice(symbol);
      if (!currentPrice) {
        await sendReply(`❌ Couldn't get price for ${symbol}. Is it listed on Revolut X?`);
        return res.status(200).json({ ok: true });
      }
      const entryPrice = entryPrices.get(symbol) || null;
      const result = await setTrailingStop(symbol, trailPct, currentPrice, entryPrice);
      await sendReply(
        `✅ <b>Trailing stop set on ${coinBase}</b>\n\n` +
        `Current/Peak: ${fmtPriceShort(result.peakPrice)}\n` +
        `Trail: ${trailPct}%\n` +
        `Stop level: ${fmtPriceShort(result.stopPrice)}\n\n` +
        `I'll notify you if ${coinBase} drops ${trailPct}% from any new peak!`
      );
      return res.status(200).json({ ok: true });
    }

    // --- Command: remove trailing stop COIN / cancel trail COIN ---
    const trailRemoveMatch = commandText.match(/^(?:remove\s+trailing\s+stop|cancel\s+trail(?:ing\s+stop)?)\s+([a-z0-9]{2,10})$/i);
    if (trailRemoveMatch) {
      const coinBase = trailRemoveMatch[1].toUpperCase();
      const symbol   = `${coinBase}-USD`;
      if (!trailingStops.has(symbol)) {
        await sendReply(`ℹ️ No trailing stop set for ${coinBase}.`);
        return res.status(200).json({ ok: true });
      }
      await removeTrailingStop(symbol);
      await sendReply(`✅ Trailing stop removed for <b>${coinBase}</b>.`);
      return res.status(200).json({ ok: true });
    }

    // --- Command: trailing stops / my trails — list all active trailing stops ---
    if (/^(?:trailing\s+stops?|my\s+trails?)$/i.test(commandText)) {
      if (trailingStops.size === 0) {
        await sendReply(`📊 No active trailing stops.\n\nSet one with: 'trail HYPE 12%'`);
        return res.status(200).json({ ok: true });
      }
      const lines = [...trailingStops.entries()].map(([sym, ts]) => {
        const cb = sym.replace('-USD', '');
        return `• <b>${cb}</b>: ${ts.trailPct}% trail | Peak ${fmtPriceShort(ts.peakPrice)} | Stop ${fmtPriceShort(ts.stopPrice)}`;
      });
      await sendReply(`📊 <b>ACTIVE TRAILING STOPS:</b>\n\n${lines.join('\n')}`);
      return res.status(200).json({ ok: true });
    }

    // --- Command: approve trade / cancel trade ---
    if (/^approve\s+trade$/i.test(commandText) ||
        rawText.trim() === '👍' ||
        /^\u{1F44D}/u.test(rawText.trim())) {
      console.log('[approve] pendingKrakenTrade:', pendingKrakenTrade ? JSON.stringify(pendingKrakenTrade) : 'null');
      console.log('[approve] pendingRevolutTrade:', pendingRevolutTrade ? JSON.stringify(pendingRevolutTrade) : 'null');

      // Determine which pending trade to execute
      // If both are set, use the most recently created one (by timestamp)
      let routeToKraken = false;
      let routeToRevolut = false;
      if (pendingKrakenTrade && pendingRevolutTrade) {
        if (pendingRevolutTrade.timestamp >= pendingKrakenTrade.timestamp) {
          routeToRevolut = true;
        } else {
          routeToKraken = true;
        }
      } else if (pendingKrakenTrade) {
        routeToKraken = true;
      } else if (pendingRevolutTrade) {
        routeToRevolut = true;
      }
      console.log('[approve] routing to:', routeToRevolut ? 'Revolut X' : routeToKraken ? 'Kraken' : 'none');

      if (routeToKraken) {
        const t = pendingKrakenTrade;
        pendingKrakenTrade = null;
        if (pendingKrakenTradeReminder) { clearInterval(pendingKrakenTradeReminder); pendingKrakenTradeReminder = null; }
        await sendReply(`⏳ Executing ${t.side.toUpperCase()} ${t.volume} ${t.symbol.replace('-USD','')} on Kraken…`);
        res.status(200).json({ ok: true });
        (async () => {
          try {
            const result = await executeKrakenTrade(t.symbol, t.side, t.orderType, t.volume, t.price);
            const coinBase = t.symbol.replace('-USD', '');
            const krakenSource = t.source === 'claude_mcp' ? 'claude_mcp' : 'manual';
            // Prefer explicit valueUSD; derive qty when volume was estimated from value_usd
            const kQtyForJournal = parseFloat(t.volume) || (t.valueUSD && t.price ? t.valueUSD / t.price : 0);
            const kValueUSD = t.valueUSD ? parseFloat(t.valueUSD) : (t.price * kQtyForJournal);
            const kReasoning = 'Kraken trade approved via Telegram' + (t.qtyEstimated ? ' [qty estimated from value_usd]' : '');
            await db.execute(
              'INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [coinBase, t.side, t.price, kQtyForJournal, kValueUSD, kReasoning, 'confident', krakenSource]
            ).catch(e => console.error('[kraken] Journal insert failed:', e.message));

            // Tranche tracking
            if (t.side.toLowerCase() === 'buy') {
              await db.execute(
                `INSERT INTO position_tranches (symbol, exchange, quantity, entry_price, entry_date, remaining_quantity, is_legacy, notes)
                 VALUES (?, 'kraken', ?, ?, NOW(), ?, 0, ?)`,
                [coinBase, kQtyForJournal, t.price, kQtyForJournal, `Buy via Claude approval — Kraken`]
              ).catch(e => console.error('[tranches] Insert failed:', e.message));
            } else if (t.side.toLowerCase() === 'sell') {
              await reduceTranches(coinBase, 'kraken', kQtyForJournal)
                .catch(e => console.error('[tranches] Reduce failed:', e.message));
            }

            await sendTelegram(`${t.side === 'sell' ? '✅' : '🟢'} MCP ${t.side.toUpperCase()} ${formatTradeQty(kQtyForJournal)} ${coinBase} @ ${formatPrice(t.price)} = $${kValueUSD?.toFixed(2)} 🦑 ✓${t.qtyEstimated ? ' (qty est)' : ''}`);
          } catch (e) {
            await sendTelegram(`❌ Kraken trade failed: ${e.message}`);
          }
        })();
        return;
      }

      if (routeToRevolut) {
        const t = pendingRevolutTrade;
        pendingRevolutTrade = null;
        if (pendingRevolutTradeReminder) { clearInterval(pendingRevolutTradeReminder); pendingRevolutTradeReminder = null; }
        await sendReply(`⏳ Executing ${t.side.toUpperCase()} ${formatTradeQty(t.baseSize)} ${t.symbol.replace('-USD','')} on Revolut X…`);
        res.status(200).json({ ok: true });
        (async () => {
          try {
            const result = await placeRevolutOrder(t.symbol, t.side, t.orderType, t.baseSize, t.price, t.valueUsd);
            const coinBase = t.symbol.replace('-USD', '');
            const executedPrice = t.price || await getCurrentPrice(t.symbol).catch(() => 0) || 0;
            // Prefer explicit value_usd for value; derive quantity from it when baseSize was estimated
            const qtyForJournal = parseFloat(t.baseSize) || (t.valueUsd && executedPrice ? t.valueUsd / executedPrice : 0);
            const valueUSD = t.valueUsd ? parseFloat(t.valueUsd) : (executedPrice * qtyForJournal);

            // Check for matching trade intention
            const matchedIntention = await findMatchingIntention(t.symbol, t.side);
            const baseReasoning = matchedIntention ? matchedIntention.reasoning : 'Revolut X trade approved via Telegram';
            const reasoning = t.qtyEstimated ? baseReasoning + ' [qty estimated from value_usd]' : baseReasoning;

            const revolutSource = t.source === 'claude_mcp' ? 'claude_mcp' : 'manual';
            await db.execute(
              'INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [coinBase, t.side, executedPrice, qtyForJournal, valueUSD, reasoning, 'confident', revolutSource]
            ).catch(e => console.error('[revolut] Journal insert failed:', e.message));

            if (matchedIntention) {
              await db.execute('UPDATE trade_intentions SET matched_at = NOW() WHERE id = ?', [matchedIntention.id]).catch(() => {});
            }

            // Update avg entry price on buy (respecting cost basis)
            if (t.side.toLowerCase() === 'buy') {
              const prevQty = previousBalances.get(t.symbol) || 0;
              const existingEntry = entryPrices.get(t.symbol);
              const isCycleBuyback = prevQty === 0 && existingEntry != null;
              if (existingEntry && prevQty > 0) {
                const newQty = prevQty + qtyForJournal;
                const newAvgEntry = ((prevQty * existingEntry) + (qtyForJournal * executedPrice)) / newQty;
                await updateEntryPrice(t.symbol, newAvgEntry, false);
              } else if (isCycleBuyback) {
                await updateEntryPrice(t.symbol, executedPrice, true);
              } else if (!existingEntry) {
                await updateEntryPrice(t.symbol, executedPrice, false);
              }
            }

            // Tranche tracking
            if (t.side.toLowerCase() === 'buy') {
              await db.execute(
                `INSERT INTO position_tranches (symbol, exchange, quantity, entry_price, entry_date, remaining_quantity, is_legacy, notes)
                 VALUES (?, 'revolut', ?, ?, NOW(), ?, 0, ?)`,
                [coinBase, qtyForJournal, executedPrice, qtyForJournal,
                 `Buy via Claude approval — Order ${result?.client_order_id || 'unknown'}`]
              ).catch(e => console.error('[tranches] Insert failed:', e.message));
            } else if (t.side.toLowerCase() === 'sell') {
              await reduceTranches(coinBase, 'revolut', qtyForJournal)
                .catch(e => console.error('[tranches] Reduce failed:', e.message));
            }

            await sendTelegram(`${t.side === 'sell' ? '✅' : '🟢'} MCP ${t.side.toUpperCase()} ${formatTradeQty(qtyForJournal)} ${coinBase} @ ${formatPrice(executedPrice)} = $${valueUSD.toFixed(2)} 🔄 ✓${t.qtyEstimated ? ' (qty est)' : ''}`);

            // USDT sweep — convert a % of sell proceeds to USDT for dry-powder reserves
            if (t.side.toLowerCase() === 'sell') {
              const proceeds = executedPrice * parseFloat(t.baseSize);
              await sweepToUSDT(proceeds, t.symbol).catch(() => {});
            }
          } catch (e) {
            console.error('[revolut] Trade execution failed:', e.message);
            await sendTelegram(`❌ Revolut X trade failed: ${e.message}`);
          }
        })();
        return;
      }

      if (!routeToKraken && !routeToRevolut) {
        await sendReply('ℹ️ No pending trade to approve.');
        return res.status(200).json({ ok: true });
      }
    }

    if (/^cancel\s+trade$/i.test(commandText) ||
        rawText.trim() === '👎' ||
        /^\u{1F44E}/u.test(rawText.trim())) {
      if (pendingKrakenTrade) {
        const t = pendingKrakenTrade;
        pendingKrakenTrade = null;
        if (pendingKrakenTradeReminder) { clearInterval(pendingKrakenTradeReminder); pendingKrakenTradeReminder = null; }
        await sendReply(`✅ Kraken trade cancelled — ${t.side.toUpperCase()} ${t.volume} ${t.symbol.replace('-USD','')} was not executed.`);
      } else if (pendingRevolutTrade) {
        const t = pendingRevolutTrade;
        pendingRevolutTrade = null;
        if (pendingRevolutTradeReminder) { clearInterval(pendingRevolutTradeReminder); pendingRevolutTradeReminder = null; }
        await sendReply(`✅ Revolut X trade cancelled — ${t.side.toUpperCase()} ${formatTradeQty(t.baseSize)} ${t.symbol.replace('-USD','')} was not executed.`);
      } else {
        await sendReply('ℹ️ No pending trade to cancel.');
      }
      return res.status(200).json({ ok: true });
    }

    // --- Command: auto rules ---
    if (commandText === 'auto rules') {
      const [rules] = await db.execute('SELECT * FROM auto_trade_rules ORDER BY symbol, order_type DESC, trigger_price ASC');
      if (rules.length === 0) {
        await sendReply('📋 No auto trade rules set.');
      } else {
        const lines = rules.map(r => {
          const sourceTag  = r.source === 'cascade' ? ' 🔄' : ' ✍️';
          const exchTag    = `[${(r.exchange || 'kraken').toUpperCase()}]`;
          const lastTag    = r.last_triggered
            ? ` | fired: ${new Date(r.last_triggered).toLocaleDateString('en-GB', { day:'numeric', month:'short' })}`
            : ' | never fired';
          const icon = r.rule_type === 'moon_bag' ? '🌙' : r.rule_type === 'stop_loss' ? '🛑' : r.order_type === 'buy' ? '📉' : '📈';
          const volDisplay = r.volume_type === 'pct' ? `${r.volume}% of pos` : `${formatTradeQty(r.volume)}`;
          return `${r.active ? '✅' : '⏸'} ${icon} [${r.id}] ${r.rule_type}${sourceTag} ${exchTag}\n` +
                 `   ${r.order_type.toUpperCase()} ${volDisplay} ${r.symbol.replace('-USD','')} ${r.direction} $${parseFloat(r.trigger_price).toFixed(6)}` +
                 (r.max_position_usd ? ` (max $${r.max_position_usd})` : '') +
                 lastTag;
        }).join('\n');
        await sendReply(`📋 <b>Auto Trade Rules</b>\n\n${lines}\n\n✍️ = manual  🔄 = cascade\nReply 'remove auto rule [id]' to delete`);
      }
      return res.status(200).json({ ok: true });
    }

    // --- Command: auto moonbag COIN VOLUME[pct] ---
    {
      const moonbagMatch = commandText.match(/^auto\s+moonbag\s+([a-z0-9]+)\s+([\d.]+)(pct)?$/i);
      if (moonbagMatch) {
        const [, coinRaw, volRaw, isPct] = moonbagMatch;
        const coin     = coinRaw.toUpperCase();
        const sym      = coin.includes('-USD') ? coin : `${coin}-USD`;
        const vol      = parseFloat(volRaw);
        const volType  = isPct ? 'pct' : 'fixed';
        const volLabel = isPct ? `${vol}% of position` : `${vol} tokens`;

        const [result] = await db.execute(
          'INSERT INTO auto_trade_rules (symbol, rule_type, trigger_price, direction, order_type, volume, volume_type, source, exchange) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [sym, 'moon_bag', 0, 'above', 'sell', vol, volType, 'manual', 'kraken']
        );
        await sendReply(
          `🌙 Moon bag set [ID: ${result.insertId}]\n` +
          `${coin}: ${volLabel} marked as long-term hold — never auto-sold\n` +
          `Appears in auto rules list for reference only`
        );
        return res.status(200).json({ ok: true });
      }
    }

    // --- Command: auto buy/sell/stop COIN PRICE VOLUME[pct] [maxUSD] [kraken|revolut] ---
    {
      const autoMatch = commandText.match(/^auto\s+(buy|sell|stop)\s+([a-z0-9]+)\s+([\d.]+)\s+([\d.]+)(pct)?(?:\s+([\d.]+))?(?:\s+(kraken|revolut))?$/i);
      if (autoMatch) {
        const [, cmdType, coinRaw, triggerPrice, volRaw, isPct, maxPos, exchangeRaw] = autoMatch;
        const coin     = coinRaw.toUpperCase();
        const sym      = coin.includes('-USD') ? coin : `${coin}-USD`;
        const trigger  = parseFloat(triggerPrice);
        const vol      = parseFloat(volRaw);
        const volType  = isPct ? 'pct' : 'fixed';
        const maxUsd   = maxPos ? parseFloat(maxPos) : null;
        const exchVal  = (exchangeRaw || 'kraken').toLowerCase();
        const volLabel = isPct ? `${vol}% of position` : `${vol} ${coin}`;

        let direction, orderType, ruleType;
        if (cmdType.toLowerCase() === 'buy') {
          direction = 'below';
          orderType = 'buy';
          ruleType  = 'buy_dip';
        } else if (cmdType.toLowerCase() === 'stop') {
          direction = 'below';
          orderType = 'sell';
          ruleType  = 'stop_loss';
        } else {
          const currentPrice = await getCurrentPrice(sym).catch(() => null);
          if (currentPrice && trigger < currentPrice) {
            direction = 'below';
            ruleType  = 'stop_loss';
          } else {
            direction = 'above';
            ruleType  = 'sell_pump';
          }
          orderType = 'sell';
        }

        const [result] = await db.execute(
          'INSERT INTO auto_trade_rules (symbol, rule_type, trigger_price, direction, order_type, volume, volume_type, max_position_usd, exchange) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [sym, ruleType, trigger, direction, orderType, vol, volType, maxUsd, exchVal]
        );
        const label = ruleType === 'stop_loss' ? '🛑 Stop loss' : ruleType === 'buy_dip' ? '📉 Buy dip' : '📈 Take profit';
        await sendReply(
          `✅ Auto rule set [ID: ${result.insertId}]\n` +
          `${label}: ${orderType.toUpperCase()} ${volLabel} when price goes ${direction} $${trigger.toFixed(6)}` +
          (maxUsd ? `\nMax position: $${maxUsd}` : '') +
          `\nExchange: ${exchVal.toUpperCase()}`
        );
        return res.status(200).json({ ok: true });
      }
    }

    // --- Command: remove auto rule [id] ---
    {
      const removeAutoMatch = commandText.match(/^remove auto rule\s+(\d+)$/i);
      if (removeAutoMatch) {
        const ruleId = parseInt(removeAutoMatch[1]);
        const [existing] = await db.execute('SELECT * FROM auto_trade_rules WHERE id = ?', [ruleId]);
        if (existing.length === 0) {
          await sendReply(`❌ No rule found with ID ${ruleId}`);
        } else {
          const r = existing[0];
          await db.execute('DELETE FROM auto_trade_rules WHERE id = ?', [ruleId]);
          await sendReply(`🗑 Rule [${ruleId}] deleted: ${r.order_type.toUpperCase()} ${r.volume} ${r.symbol.replace('-USD','')} @ $${parseFloat(r.trigger_price).toFixed(2)}`);
        }
        return res.status(200).json({ ok: true });
      }
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
      const ackedSymbols   = [...alertState.acknowledged].filter(s => !ignoredCoins.has(s));
      const ignoredList    = [...ignoredCoins];
      const trailLines     = [...trailingStops.entries()].map(([sym, ts]) =>
        `  ${sym.replace('-USD', '')}: ${ts.trailPct}% | Peak ${fmtPriceShort(ts.peakPrice)} | Stop ${fmtPriceShort(ts.stopPrice)}`
      );
      const statusMsg =
        `<b>Monitor Status</b>\n` +
        `Paused: ${monitoringPaused ? 'Yes' : 'No'}\n` +
        `Pump alerts: ${alertedSymbols.length ? alertedSymbols.join(', ') : 'none'}\n` +
        `Drop alerts: ${dropSymbols.length ? dropSymbols.join(', ') : 'none'}\n` +
        `Fixed alerts: ${fixedSymbols.length ? fixedSymbols.join(', ') : 'none'}\n` +
        (trailLines.length ? `🎯 Trailing stops (${trailLines.length}):\n${trailLines.join('\n')}\n` : '') +
        (ackedSymbols.length ? `🔕 Acknowledged (silent until restart): ${ackedSymbols.join(', ')}\n` : '') +
        (ignoredList.length ? `🚫 Permanently ignored: ${ignoredList.join(', ')}` : '');
      await sendReply(statusMsg);
      return res.status(200).json({ ok: true });
    }

    // --- Trailing stop: intercept 'hold COIN' reply to reset trail from current price ---
    {
      const trailHoldMatch = commandText.match(/^hold\s+([a-z0-9]{2,12})$/i);
      if (trailHoldMatch) {
        const holdCoinBase = trailHoldMatch[1].toUpperCase();
        const holdSymbol   = `${holdCoinBase}-USD`;
        const recentAlert  = trailingStopAlerted.get(holdSymbol);
        // Only intercept if a trailing stop fired within last 2 hours AND the coin still has a trail
        if (recentAlert && (Date.now() - recentAlert) < 2 * 60 * 60 * 1000 && trailingStops.has(holdSymbol)) {
          const currentPrice = await getCurrentPrice(holdSymbol).catch(() => null);
          if (currentPrice) {
            const ts = trailingStops.get(holdSymbol);
            const newStop = currentPrice * (1 - ts.trailPct / 100);
            await setTrailingStop(holdSymbol, ts.trailPct, currentPrice, ts.entryPrice);
            trailingStopAlerted.delete(holdSymbol);
            await sendReply(
              `✅ Holding <b>${holdCoinBase}</b> — trailing stop reset from current price ${fmtPriceShort(currentPrice)}.\n` +
              `New stop: ${fmtPriceShort(newStop)} (${ts.trailPct}% trail)\n` +
              `I'll alert you again if it drops ${ts.trailPct}% from any new peak!`
            );
            return res.status(200).json({ ok: true });
          }
        }
      }
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
          // Backdate cooldown by 2h so 4h remaining window = 6h total from now
          swingAlertCooldown.set(swSymbol, Date.now() - (2 * 60 * 60 * 1000));
          await db.execute(
            'INSERT INTO swing_cooldowns (symbol, last_alert_at) VALUES (?, DATE_SUB(NOW(), INTERVAL 2 HOUR)) ON DUPLICATE KEY UPDATE last_alert_at = DATE_SUB(NOW(), INTERVAL 2 HOUR), updated_at = CURRENT_TIMESTAMP',
            [swSymbol]
          ).catch(e => console.error('Failed to persist swing cooldown:', e.message));
          console.log('[swing] Cooldown extended (4h remaining) for', swSymbol, 'after user reply:', swAction);

          const isPump = swCtx.direction === 'pump';
          const currentPrice = await getCurrentPrice(swSymbol).catch(() => swCtx.price);

          if (swAction === 'ack') {
            await sendReply(`✅ ${swCoinBase} alerts stopped.`);
            return res.status(200).json({ ok: true });
          }

          if (swAction === 'hold') {
            if (isPump) {
              // Holding through pump → sell alert at +15% (only if no existing target)
              const existing = priceTargets.get(swSymbol);
              if (existing && existing.direction === 'up') {
                await sendReply(
                  `✅ Holding <b>${swCoinBase}</b> logged.\n` +
                  `📌 You already have a sell target at ${fmtPriceShort(existing.targetPrice)} — keeping that.`
                );
              } else {
                const sellTarget = currentPrice * 1.15;
                await setAbsolutePriceTarget(swSymbol, sellTarget, 'up',
                  JSON.stringify({ source: 'swing_hold', direction: 'up' })).catch(() => {});
                await sendReply(
                  `✅ Holding <b>${swCoinBase}</b> logged.\n` +
                  `🎯 Sell alert set at ${fmtPriceShort(sellTarget)} (+15% from here)\n` +
                  `I'll notify you when it hits your target!`
                );
              }
            } else {
              // Holding through dip → recovery alert at entry or +20% (only if no existing target)
              const existing = priceTargets.get(swSymbol);
              if (existing && existing.direction === 'up') {
                await sendReply(
                  `✅ Holding <b>${swCoinBase}</b> logged.\n` +
                  `📌 You already have a recovery target at ${fmtPriceShort(existing.targetPrice)} — keeping that.`
                );
              } else {
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
                  model: 'claude-sonnet-4-6',
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
                  model: 'claude-sonnet-4-6',
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
      const cacheKey = `sell:${symbol}`;
      const cached = responseCache.get(cacheKey);
      const CACHE_TTL = 30 * 60 * 1000; // 30 min
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        const minsAgo = Math.round((Date.now() - cached.timestamp) / 60000);
        await sendReply(`📋 <b>Recent sell analysis for ${coinBase}</b> (${minsAgo} min ago — prices may have changed slightly):\n\n${cached.response}`);
        return res.status(200).json({ ok: true });
      }
      await sendReply('🔍 Getting sell advice...');
      res.status(200).json({ ok: true });
      (async () => {
        try {
          const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 600,
            tools: [{ type: "web_search_20250305", name: "web_search" }],
            messages: [{ role: 'user', content: `Give specific, actionable sell advice for ${symbol}. Search for current price and market conditions. Should I sell now or wait? Give a clear recommendation with 1-2 price levels to target. Under 300 words.` }]
          });
          const textBlock = [...response.content].reverse().find(b => b.type === 'text');
          const sellReply = textBlock ? textBlock.text : 'Unable to generate sell advice.';
          // FIX 4: Cache response for 30 min
          responseCache.set(cacheKey, { response: sellReply, timestamp: Date.now() });
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
      const cacheKey = `buy:${symbol}`;
      const cached = responseCache.get(cacheKey);
      const CACHE_TTL = 30 * 60 * 1000; // 30 min
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        const minsAgo = Math.round((Date.now() - cached.timestamp) / 60000);
        await sendReply(`📋 <b>Recent buy analysis for ${coinBase}</b> (${minsAgo} min ago — prices may have changed slightly):\n\n${cached.response}`);
        return res.status(200).json({ ok: true });
      }
      await sendReply('🔍 Getting buy advice...');
      res.status(200).json({ ok: true });
      (async () => {
        try {
          const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 600,
            tools: [{ type: "web_search_20250305", name: "web_search" }],
            messages: [{ role: 'user', content: `Give specific, actionable advice on buying more ${symbol}. Search for current price and market conditions. Is now a good DCA entry? What's the risk/reward? Under 300 words.` }]
          });
          const textBlock = [...response.content].reverse().find(b => b.type === 'text');
          const buyReply = textBlock ? textBlock.text : 'Unable to generate buy advice.';
          // FIX 4: Cache response for 30 min
          responseCache.set(cacheKey, { response: buyReply, timestamp: Date.now() });
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
      await updateEntryPrice(symbol, price, false);
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
      const existingArr38b2 = priceTargets.get(symbol) || []; // #38 B2
      const anchorSrc38b2 = existingArr38b2[0] || null;
      if (anchorSrc38b2) {
        // Update threshold from same anchor — #38 B2: read anchor from array[0]
        const newTargetPrice = anchorSrc38b2.anchorPrice * (1 + thresholdPct / 100);
        if (activeFixedAlerts.has(symbol)) { clearInterval(activeFixedAlerts.get(symbol)); activeFixedAlerts.delete(symbol); }
        await db.execute(
          'INSERT INTO price_targets (symbol, anchor_price, threshold_pct, target_price) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE threshold_pct = VALUES(threshold_pct), target_price = VALUES(target_price), updated_at = CURRENT_TIMESTAMP',
          [symbol, anchorSrc38b2.anchorPrice, thresholdPct, newTargetPrice]
        );
        upsertPriceTarget(symbol, { anchorPrice: anchorSrc38b2.anchorPrice, thresholdPct, targetPrice: newTargetPrice, direction: anchorSrc38b2.direction || 'up', note: anchorSrc38b2.note || null }); // #38 B2
        await sendReply(`✅ ${symbol} fixed target updated to ${thresholdPct}%. New target: $${newTargetPrice.toFixed(4)} from anchor $${anchorSrc38b2.anchorPrice.toFixed(4)}`);
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
            model: 'claude-sonnet-4-6',
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
          model: 'claude-sonnet-4-6',
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
        console.log('FULL REPLY STARTS WITH:', fullReply.substring(0, 200).replace(/\n/g, '|'));
        console.log('CHUNK 1 WILL START WITH:', fullReply.substring(0, 100).replace(/\n/g, '|'));

        // 5s gap after status message so chunks don't collide with it
        await new Promise(r => setTimeout(r, 5000));
        await sendTelegramChunked(fullReply);
      } catch (err) {
        console.error('Claude AI error:', err.message);
        clearTimeout(stillResearchingTimer);
        clearTimeout(stillResearchingTimer2);
        if (err.message === 'timeout') {
          // FIX 3: Fallback simpler Claude call — no web search, max 30s, max_tokens 500
          try {
            const fallbackPromise = anthropic.messages.create({
              model: 'claude-sonnet-4-6',
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

// GET /api/system/config — read all system config values
app.get('/api/system/config', async (req, res) => {
  try {
    const [rows] = await db.execute(
      'SELECT config_key, config_value, updated_at FROM system_config ORDER BY config_key'
    );
    res.json({ ok: true, config: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/system/config — upsert a config key/value
app.post('/api/system/config', async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || !value) return res.status(400).json({ error: 'key and value required' });
    await db.execute(
      'INSERT INTO system_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)',
      [key, value]
    );
    res.json({ ok: true, key, updated_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/revolut/trade — execute a Revolut X trade directly (requires approved: true)
app.post('/api/revolut/trade', async (req, res) => {
  try {
    const { symbol, side, orderType, baseSize, price, approved } = req.body;
    if (!approved) return res.status(400).json({ error: 'Trade requires approved: true explicitly set' });
    if (!symbol || !side || !orderType || !baseSize) return res.status(400).json({ error: 'Missing required fields: symbol, side, orderType, baseSize' });
    const result = await placeRevolutOrder(symbol, side, orderType, parseFloat(baseSize), price ? parseFloat(price) : null);
    const coinBase = symbol.replace('-USD', '');
    const executedPrice = price || await getCurrentPrice(symbol).catch(() => 0) || 0;
    const valueUSD = executedPrice * parseFloat(baseSize);
    await db.execute(
      'INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [coinBase, side, executedPrice, baseSize, valueUSD, 'Revolut X trade via dashboard', 'confident']
    ).catch(e => console.error('[revolut] Journal insert failed:', e.message));
    await sendTelegram(
      `✅ <b>REVOLUT X TRADE EXECUTED</b>\n\n` +
      `${side.toUpperCase()} ${baseSize} ${coinBase} @ ${fmtPriceShort(executedPrice)}\n` +
      `Value: $${valueUSD.toFixed(2)}\n` +
      `Order ID: ${result?.client_order_id || 'unknown'}\n\n` +
      `📝 Journal entry logged automatically`
    );
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/debug/link-pairs — temporary diagnostic: all LINK trading pairs on Revolut X
app.get('/api/debug/link-pairs', async (req, res) => {
  try {
    const tickerResponse = await revolutRequest('GET', '/tickers');
    const tickerList = Array.isArray(tickerResponse) ? tickerResponse : (tickerResponse.data || []);
    const linkPairs = tickerList.filter(t => t.symbol?.includes('LINK'));
    res.json({ total_tickers: tickerList.length, link_pairs: linkPairs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/cleanup/trade-intentions — one-time cleanup of unmatched intentions
app.delete('/api/cleanup/trade-intentions', async (req, res) => {
  try {
    const [result] = await db.execute(
      'DELETE FROM trade_intentions WHERE matched_at IS NULL'
    );
    res.json({ ok: true, deleted: result.affectedRows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── One-time backfill: sell P&L ──────────────────────────────────────────────
// POST /api/fix/sell-pnl — calculates realised P&L on existing sell entries missing outcome_pnl
app.post('/api/fix/sell-pnl', async (req, res) => {
  try {
    const [sells] = await db.execute(
      `SELECT id, symbol, price, quantity
       FROM trading_journal
       WHERE action = 'sell'
       AND outcome_pnl IS NULL
       AND price IS NOT NULL
       AND quantity IS NOT NULL`
    );

    const results = [];

    for (const sell of sells) {
      const coinBase = sell.symbol.replace('-USD', '');
      const [entryRows] = await db.execute(
        'SELECT entry_price FROM entry_prices WHERE symbol = ?',
        [`${coinBase}-USD`]
      );

      if (!entryRows.length) {
        results.push({ id: sell.id, symbol: coinBase, status: 'skipped — no entry price' });
        continue;
      }

      const entryPrice    = parseFloat(entryRows[0].entry_price);
      const salePrice     = parseFloat(sell.price);
      const qty           = parseFloat(sell.quantity);
      const realisedPnl   = (salePrice - entryPrice) * qty;
      const realisedPnlPct = ((salePrice - entryPrice) / entryPrice * 100);
      const isGain        = realisedPnl > 0;

      await db.execute(
        `UPDATE trading_journal SET outcome_pnl = ?, outcome_notes = ? WHERE id = ?`,
        [realisedPnl,
         `Realised ${isGain ? 'gain' : 'loss'}: ${isGain ? '+' : ''}$${realisedPnl.toFixed(2)} ` +
         `(${realisedPnlPct.toFixed(1)}%) | Entry: $${entryPrice} | Sale: $${salePrice} | Method: US HIFO`,
         sell.id]
      );

      results.push({
        id: sell.id,
        symbol: coinBase,
        entry: entryPrice,
        sale: salePrice,
        qty,
        realised_pnl: realisedPnl.toFixed(2),
        pnl_pct: realisedPnlPct.toFixed(1),
        status: isGain ? 'GAIN' : 'LOSS'
      });
    }

    const totalGainLoss = results
      .reduce((s, r) => s + parseFloat(r.realised_pnl || 0), 0)
      .toFixed(2);

    res.json({ ok: true, processed: results.length, total_gain_loss: totalGainLoss, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── One-time backfill: payment P&L ───────────────────────────────────────────
// POST /api/fix/payment-pnl — calculates P&L on existing payment entries missing outcome_pnl
app.post('/api/fix/payment-pnl', async (req, res) => {
  try {
    const [payments] = await db.execute(
      `SELECT id, symbol, price, quantity, value_usd
       FROM trading_journal
       WHERE action = 'payment'
       AND outcome_pnl IS NULL`
    );

    const results = [];

    for (const payment of payments) {
      const coinBase = payment.symbol.replace('-USD', '');
      const [entryRows] = await db.execute(
        'SELECT entry_price FROM entry_prices WHERE symbol = ?',
        [`${coinBase}-USD`]
      );

      if (!entryRows.length) {
        results.push({ id: payment.id, symbol: coinBase, status: 'skipped — no entry price' });
        continue;
      }

      const entryPrice = parseFloat(entryRows[0].entry_price);
      const salePrice  = parseFloat(payment.price);
      const qty        = parseFloat(payment.quantity);

      if (!entryPrice || !salePrice || !qty) {
        results.push({ id: payment.id, symbol: coinBase, status: 'skipped — missing data' });
        continue;
      }

      const gainLoss    = (salePrice - entryPrice) * qty;
      const gainLossPct = ((salePrice - entryPrice) / entryPrice * 100);
      const isGain      = gainLoss > 0;

      await db.execute(
        `UPDATE trading_journal SET outcome_pnl = ?, outcome_notes = ? WHERE id = ?`,
        [gainLoss,
         `Payment disposal: ${isGain ? 'GAIN' : 'LOSS'} of $${Math.abs(gainLoss).toFixed(2)} (${gainLossPct.toFixed(1)}%) — taxable event`,
         payment.id]
      );

      results.push({
        id: payment.id,
        symbol: coinBase,
        entry: entryPrice,
        sale: salePrice,
        qty,
        gain_loss: gainLoss.toFixed(2),
        gain_loss_pct: gainLossPct.toFixed(1),
        status: isGain ? 'GAIN' : 'LOSS'
      });
    }

    res.json({ ok: true, processed: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// PATCH /api/activity/:id — edit trade action and/or reasoning
app.patch('/api/activity/:id', async (req, res) => {
  try {
    const id        = parseInt(req.params.id);
    const { action, reasoning, emotion } = req.body;
       // If corrected to 'payment' — deduct from invested capital
    if (action === 'payment') {
      const [[trade]] = await db.execute('SELECT value_usd FROM trading_journal WHERE id = ?', [id]);
      if (trade?.value_usd) {
        const amount   = Math.abs(parseFloat(trade.value_usd));
        const newTotal = totalInvestedCapital - amount;
        await updateInvestedCapital(newTotal, `Payment correction — journal ID ${id}`).catch(e => console.error('[activity] capital update failed:', e.message));
      }
    }

    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
