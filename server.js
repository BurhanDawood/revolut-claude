import express from 'express';
import cors from 'cors';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { createPrivateKey, sign, createHash, createHmac, randomUUID } from 'crypto';
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
const KRAKEN_API_URL = 'https://api.kraken.com';
const TANGEM_XRP_ADDRESS = 'r4E3rtCa4FT4HxTQV2iw3yQHRTrAHMYS3v';
const TANGEM_XRP_ENTRY   = 2.65; // average entry price for Tangem XRP position
const XRPL_API = 'https://xrplcluster.com';
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
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
let lastClaudeCallTime = 0;
let learningModelCache = ''; // updated by updateLearningModel()
const pendingJournalState = new Map(); // chatId -> { journalId, step: 'emotion'|'followed', hasClaudeRec, claudeRec, symbol }
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
const lastAlertContext = new Map();          // chatId -> { symbol, coinBase, alertType } — powers numbered reply shortcuts
const ruleApproachAlerted = new Map();       // ruleId -> timestamp — tracks 2% approach alerts so they don't spam
let mostRecentSwingAlert = null;             // { symbol, coinBase, direction, price, timestamp } — for 👍 / natural language
const alertRecommendations = new Map();      // symbol -> { rec, timestamp } — reused in reminders, no repeat API calls
const responseCache = new Map();             // 'type:symbol' -> { response, timestamp } — 30-min cache for sell/buy advice
const trailingStops = new Map();             // symbol -> { trailPct, peakPrice, stopPrice, entryPrice }
const trailingStopAlerted = new Map();       // symbol -> timestamp — tracks recently-triggered trailing stops for hold reply
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

await db.execute(`CREATE TABLE IF NOT EXISTS ignored_coins (
  symbol VARCHAR(50) PRIMARY KEY,
  ignored_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`);

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
await safeAddColumn('custom_thresholds','acknowledged_until','TIMESTAMP NULL DEFAULT NULL');

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
  const [ignoredRows] = await db.execute('SELECT symbol FROM ignored_coins');
  for (const row of ignoredRows) ignoredCoins.add(row.symbol);
  if (ignoredRows.length > 0) console.log(`[ignore] Loaded ${ignoredRows.length} ignored coin(s):`, [...ignoredCoins].join(', '));
} catch (e) { console.warn('[ignore] Could not load ignored coins:', e.message); }
// Note: acknowledged coins are session-only — server restart resets them (baselines also reset)

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

// Startup cross-check: remove price_targets that are already covered by an active auto rule
// e.g. if SOL-USD has a sell rule at $150 and a 'up' price target at $150 — target is redundant
try {
  const [activeRules] = await db.execute(
    "SELECT symbol, order_type, trigger_price FROM auto_trade_rules WHERE active = 1"
  );
  let removedCount = 0;
  for (const [symbol, target] of priceTargets) {
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
      console.log(`[startup] Removing redundant price target for ${symbol} — already covered by auto rule`);
      priceTargets.delete(symbol);
      await db.execute('DELETE FROM price_targets WHERE symbol = ?', [symbol]).catch(e => console.error('[startup] Delete target failed:', e.message));
      removedCount++;
    }
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
  await db.execute(
    'INSERT INTO system_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)',
    ['system_capabilities', JSON.stringify({
      last_updated: new Date().toISOString(),
      total_mcp_tools: 11,
      tools: [
        'get_portfolio_summary', 'get_portfolio_data', 'get_trading_data',
        'get_context', 'manage_alerts', 'manage_trading',
        'set_entry_price', 'execute_kraken_trade',
        'set_auto_trade_rule', 'get_auto_rules', 'get_prices'
      ],
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
        'MCP tools consolidated to 11',
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
} catch (e) {
  console.error('[config] Failed to seed project_description:', e.message);
}

// Seed AI auto-execute config (ON CONFLICT DO NOTHING — preserves user settings)
try {
  await db.execute(
    'INSERT INTO system_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_key = config_key',
    ['ai_auto_execute', JSON.stringify({
      enabled: false,
      max_sell_pct: 25,
      max_buy_usd: 100,
      allowed_triggers: ['trailing_stop', 'fixed_target', 'pump_alert'],
      require_confidence: 'High',
      cooldown_minutes: 60
    })]
  );
  console.log('[config] AI auto-execute config seeded');
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

      // Fix 3: force-enable if still at seeded default (disabled)
      if (!cfg.enabled) {
        cfg.enabled = true;
        cfg.max_sell_pct = cfg.max_sell_pct || 25;
        cfg.require_confidence = cfg.require_confidence || 'High';
        cfg.cooldown_minutes = cfg.cooldown_minutes || 60;
        cfg.updated_at = new Date().toISOString();
        await db.execute(
          "INSERT INTO system_config (config_key, config_value) VALUES ('ai_auto_execute', ?) ON DUPLICATE KEY UPDATE config_value = VALUES(config_value)",
          [JSON.stringify(cfg)]
        );
        console.log('[auto-exec] Enabled via startup patch:', JSON.stringify(cfg));
      }

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
        'SELECT quantity FROM balance_snapshots WHERE symbol = ? ORDER BY created_at DESC LIMIT 1',
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

    // Send reminder
    const minsLeft = ((maxReminders - reminderCount) * 2.5).toFixed(0);
    await sendTelegram(
      `🔔 <b>TRADE APPROVAL REMINDER ${reminderCount}/${maxReminders}</b>\n\n` +
      `Exchange: ${exchangeLabel}\n` +
      `Action: <b>${current.side.toUpperCase()} ${qtyDisplay} ${coinBase}</b>\n` +
      `Price: ${current.price ? formatPrice(current.price) : 'market'}\n` +
      `Value: ~${current.valueUSD ? '$' + current.valueUSD.toFixed(2) : 'unknown'}\n\n` +
      `Reply <b>'approve trade'</b> or 👍 to execute\n` +
      `Reply <b>'cancel trade'</b> or 👎 to abort\n\n` +
      `⚠️ Auto-cancels in ${minsLeft} min if no response`
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
      return null;
    }
    console.error('Tangem XRP fetch error:', e.message);
    return null;
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

// FIX 3: Dust rule — skip API for positions worth < $5
function getDustRecommendation(direction) {
  return direction === 'down'
    ? '💡 Dust position — consider watching for further drop before adding'
    : '💡 Dust position — consider setting a retrace buy alert if this pumps further';
}

async function getQuickAiRecommendation(symbol, changePct, currentPrice, direction = 'up', reason = 'alert') {
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
    // FIX 7: Log API call cost
    console.log('CLAUDE API CALL:', {
      reason,
      symbol,
      inputTokens:   response.usage?.input_tokens  || 0,
      outputTokens:  response.usage?.output_tokens || 0,
      estimatedCost: (((response.usage?.input_tokens || 0) * 0.000003) + ((response.usage?.output_tokens || 0) * 0.000015)).toFixed(6)
    });
    const textBlock = response.content.find(b => b.type === 'text');
    return textBlock ? textBlock.text : 'HOLD - Monitor the situation closely.';
  } catch (e) {
    console.error('Quick AI recommendation error:', e.message);
    return 'HOLD - Monitor the situation closely.';
  }
}

// FIX 2: Batch recommendations for multiple simultaneous alerts — one API call instead of N
async function batchGetRecommendations(alerts) {
  if (alerts.length === 0) return;
  try {
    const lines = alerts.map(a =>
      `- ${a.symbol}: ${a.direction === 'up' ? 'UP' : 'DOWN'} ${Math.abs(a.changePct).toFixed(1)}% to ${fmtPriceShort(a.currentPrice)} (holding value ~$${a.valueUSD.toFixed(0)})`
    ).join('\n');
    const format = alerts.map(a => `${a.coinBase}: [recommendation]`).join('\n');
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: Math.min(80 * alerts.length, 400),
      messages: [{ role: 'user', content: `Quick trading recommendations for these alerts:\n${lines}\n\nFor each give ONE short line — HOLD/SELL/BUY + brief reason.\nFormat exactly:\n${format}` }]
    });
    // FIX 7: cost log
    console.log('CLAUDE API CALL:', {
      reason: `batch alert recommendations (${alerts.length} coins)`,
      inputTokens:   response.usage?.input_tokens  || 0,
      outputTokens:  response.usage?.output_tokens || 0,
      estimatedCost: (((response.usage?.input_tokens || 0) * 0.000003) + ((response.usage?.output_tokens || 0) * 0.000015)).toFixed(6)
    });
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
  // Setting a new alert clears acknowledged so the new target can fire
  alertState.acknowledged.delete(symbol);
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
    await db.execute('INSERT INTO ignored_coins (symbol) VALUES (?) ON DUPLICATE KEY UPDATE ignored_at = CURRENT_TIMESTAMP', [symbol]);
    console.log('[ignore] Permanently ignored:', symbol);
  } catch (e) { console.warn('[ignore] DB persist failed for', symbol, ':', e.message); }
}

// Re-enable alerts for a coin — removes from ignored and acknowledged
async function resumeAlerts(symbol) {
  ignoredCoins.delete(symbol);
  alertState.acknowledged.delete(symbol);
  try {
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
      model: 'claude-sonnet-4-5',
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
    // FIX 7: Log morning briefing API cost
    console.log('CLAUDE API CALL:', {
      reason: 'morning briefing message 2',
      inputTokens:   claudeResponse.usage?.input_tokens  || 0,
      outputTokens:  claudeResponse.usage?.output_tokens || 0,
      estimatedCost: (((claudeResponse.usage?.input_tokens || 0) * 0.000003) + ((claudeResponse.usage?.output_tokens || 0) * 0.000015)).toFixed(6)
    });

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

    // STEP 4: Call Claude API for impact analysis (only reached if keywords found, max once per 4 hours — FIX 5)
    if (Date.now() - lastClaudeCallTime < 4 * 60 * 60 * 1000) {
      console.log('Macro check:', new Date().toISOString(), '- Keywords found: true - Claude rate limited (last call', Math.round((Date.now() - lastClaudeCallTime) / 60000), 'min ago, limit: 240 min)');
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
    // FIX 7: Log macro news API cost
    console.log('CLAUDE API CALL:', {
      reason: 'macro news analysis',
      inputTokens:   claudeResponse.usage?.input_tokens  || 0,
      outputTokens:  claudeResponse.usage?.output_tokens || 0,
      estimatedCost: (((claudeResponse.usage?.input_tokens || 0) * 0.000003) + ((claudeResponse.usage?.output_tokens || 0) * 0.000015)).toFixed(6)
    });
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

    // Auto-handle USDT buys/sells — always internal sweeps or conversions, never trading decisions
    if (coinBase === 'USDT') {
      const usdtReasoning = action === 'sell'
        ? 'USDT conversion — auto-logged as payment'
        : 'USDT sweep — auto-converted from sell proceeds';
      const usdtAction  = action === 'sell' ? 'payment' : 'buy';
      const usdtSource  = action === 'sell' ? 'auto_detected' : 'auto_rule';
      await db.execute(
        'INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ['USDT', usdtAction, price, absQty, valueUsd, usdtReasoning, 'neutral', usdtSource]
      ).catch(e => console.error('[autoLog] USDT journal insert error:', e.message));
      console.log(`[autoLog] USDT ${action} auto-logged as ${usdtAction} — suppressing Telegram`);
      return;
    }

    // Debounce: if same symbol detected within 10 minutes, skip
    const existing = pendingTradeContext.get(symbol);
    if (existing && (Date.now() - existing.detectedAt) < 10 * 60 * 1000) {
      console.log(`Trade detection debounced for ${symbol} (within 10 min window)`);
      return;
    }

    // Suppress if trade was already logged by Claude MCP or an auto rule within the last 5 minutes
    try {
      const [recentSourced] = await db.execute(
        `SELECT id, source FROM trading_journal
         WHERE symbol = ?
         AND action = ?
         AND source IN ('claude_mcp', 'auto_rule')
         AND ABS(CAST(price AS DECIMAL(20,10)) - ?) < (? * 0.01 + 0.000001)
         AND created_at > DATE_SUB(NOW(), INTERVAL 5 MINUTE)
         LIMIT 1`,
        [coinBase, action, price, price]
      );
      if (recentSourced.length > 0) {
        console.log(`[autoLog] Suppressing — trade already logged (source=${recentSourced[0].source}, id=${recentSourced[0].id})`);
        return;
      }
    } catch (e) { console.error('[autoLog] Source suppression check error:', e.message); }

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

    // Insert journal entry
    const [result] = await db.execute(
      'INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, claude_recommendation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [symbol, action, price, absQty, valueUsd, reasoning, 'pending', claudeRec]
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

    // If buy: recalculate weighted average entry price
    let avgEntryLine = '';
    if (action === 'buy') {
      try {
        const prevQty = previousBalances.get(symbol) || 0;
        const existingEntry = entryPrices.get(symbol);
        if (existingEntry && prevQty > 0) {
          const newQty = prevQty + absQty;
          const newAvgEntry = ((prevQty * existingEntry) + (absQty * price)) / newQty;
          entryPrices.set(symbol, newAvgEntry);
          await db.execute(
            'INSERT INTO entry_prices (symbol, entry_price) VALUES (?, ?) ON DUPLICATE KEY UPDATE entry_price = VALUES(entry_price)',
            [symbol, newAvgEntry]
          );
          console.log(`[entry] ${symbol} avg entry updated: $${existingEntry.toFixed(6)} → $${newAvgEntry.toFixed(6)}`);
          avgEntryLine = `\n📊 Avg entry updated: ${formatPrice(existingEntry)} → ${formatPrice(newAvgEntry)}`;
        } else if (!existingEntry && price > 0) {
          entryPrices.set(symbol, price);
          await db.execute(
            'INSERT INTO entry_prices (symbol, entry_price) VALUES (?, ?) ON DUPLICATE KEY UPDATE entry_price = VALUES(entry_price)',
            [symbol, price]
          );
          avgEntryLine = `\n📊 Entry price set: ${formatPrice(price)}`;
          console.log(`[entry] ${symbol} first entry set: $${price.toFixed(6)}`);
        }
      } catch (e) {
        console.error('[entry] avg entry update error:', e.message);
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

// Cancel price targets that are now obsolete after an auto trade execution.
// e.g. a sell rule fired at $2.00 — any 'up' target at or below $2.00 is now moot.
// e.g. a buy rule fired at $1.80 — any 'down' target at or above $1.80 is now moot.
async function cancelObsoleteTargets(symbol, executedPrice, action) {
  try {
    const target = priceTargets.get(symbol);
    if (!target) return;

    const tPrice = target.targetPrice;
    const dir    = target.direction || 'up';

    let isObsolete = false;
    if (action === 'sell' && dir === 'up' && tPrice <= executedPrice) {
      isObsolete = true; // sell happened at or above the 'up' target — target is already passed
    } else if (action === 'buy' && dir === 'down' && tPrice >= executedPrice) {
      isObsolete = true; // buy happened at or below the 'down' target — target is already passed
    }

    if (!isObsolete) return;

    console.log(`[targets] Cancelling obsolete ${dir} target for ${symbol} — target ${tPrice}, exec ${executedPrice}, action ${action}`);
    priceTargets.delete(symbol);
    targetReminderCount.delete(symbol);

    // Clear any active interval
    if (activeFixedAlerts.has(symbol)) {
      clearInterval(activeFixedAlerts.get(symbol));
      activeFixedAlerts.delete(symbol);
    }

    // Remove from DB
    await db.execute('DELETE FROM price_targets WHERE symbol = ?', [symbol]).catch(e => console.error('[targets] Delete failed:', e.message));

    const coinBase = symbol.replace('-USD', '');
    await sendTelegram(`🗑️ <b>Target auto-cancelled: ${coinBase}</b>\nObsolete after ${action} executed at ${formatPrice(executedPrice)} — target was ${formatPrice(tPrice)} (${dir})`).catch(() => {});
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

// ── Claude Auto-Analysis on Alerts ───────────────────────────────────────────

async function analyseTrailingStopAlert(symbol, currentPrice, peakPrice, trailPct, stopPrice, exchange = 'revolut') {
  const ONE_HOUR = 60 * 60 * 1000;
  const lastAnalysis = analysisRateLimit.get(symbol);
  if (lastAnalysis && Date.now() - lastAnalysis < ONE_HOUR) {
    console.log(`[analysis] Rate limited — ${symbol} analysed ${Math.round((Date.now()-lastAnalysis)/60000)}min ago`);
    return;
  }
  analysisRateLimit.set(symbol, Date.now());

  try {
    const coinBase = symbol.replace('-USD', '');
    const entryPrice = entryPrices.get(symbol);
    const plPct = entryPrice ? ((currentPrice - entryPrice) / entryPrice * 100) : null;
    const dropFromPeak = ((peakPrice - currentPrice) / peakPrice * 100);

    const [recentTrades] = await db.execute(
      `SELECT action, price, reasoning, created_at FROM trading_journal WHERE symbol = ? ORDER BY created_at DESC LIMIT 5`,
      [coinBase]
    );
    const [autoRules] = await db.execute(
      `SELECT rule_type, trigger_price, order_type, volume FROM auto_trade_rules WHERE symbol = ? AND active = 1`,
      [symbol]
    );
    const [profile] = await db.execute(`SELECT preference_key, preference_value FROM trader_profile LIMIT 20`);
    const profileStr = profile.map(p => `${p.preference_key}: ${p.preference_value}`).join('\n');

    const prompt = `You are analysing a trailing stop alert for a crypto portfolio.

TRAILING STOP ALERT: ${coinBase}
- Exchange: ${exchange === 'kraken' ? 'Kraken' : 'Revolut X'}
- Current price: $${currentPrice.toFixed(6)}
- Peak price: $${peakPrice.toFixed(6)}
- Drop from peak: -${dropFromPeak.toFixed(1)}%
- Trailing stop: ${trailPct}%
- Stop price: $${stopPrice.toFixed(6)}
- Entry price: ${entryPrice ? '$' + entryPrice.toFixed(6) : 'unknown'}
- P&L from entry: ${plPct !== null ? (plPct > 0 ? '+' : '') + plPct.toFixed(1) + '%' : 'unknown'}

RECENT TRADE HISTORY:
${recentTrades.map(t => `${t.action.toUpperCase()} @ $${parseFloat(t.price).toFixed(6)} — ${t.reasoning || 'no reason'}`).join('\n') || 'No recent trades'}

ACTIVE AUTO RULES:
${autoRules.map(r => `${r.rule_type}: ${r.order_type} @ $${parseFloat(r.trigger_price).toFixed(6)}`).join('\n') || 'None'}

TRADER PROFILE:
${profileStr}

Analyse this trailing stop alert. Be concise — max 4 lines:
RECOMMENDATION: [SELL NOW / HOLD AND RESET / WAIT AND WATCH]
REASON: [one sentence]
WATCH: [price level to confirm your view]
CONFIDENCE: [High/Medium/Low]`;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    });
    const analysis = msg.content?.[0]?.text || 'Analysis unavailable';
    console.log(`[analysis] ${coinBase} trailing stop: ${msg.usage?.input_tokens}in ${msg.usage?.output_tokens}out`);

    const recMatch = analysis.match(/RECOMMENDATION:\s*(.+)/i);
    const recommendation = recMatch ? recMatch[1].trim().toUpperCase() : 'REVIEW NEEDED';
    const confMatch = analysis.match(/CONFIDENCE:\s*(High|Medium|Low)/i);
    const confidence = confMatch ? confMatch[1] : 'Low';

    // Check auto-execute config — reads from system_config only
    const [autoExecRows] = await db.execute(
      "SELECT config_value FROM system_config WHERE config_key = 'ai_auto_execute'"
    );
    const autoExec = autoExecRows.length ? JSON.parse(autoExecRows[0].config_value) : { enabled: false };
    console.log('[auto-exec] Config loaded:', JSON.stringify(autoExec));

    const shouldAutoExecute =
      autoExec.enabled &&
      autoExec.allowed_triggers.includes('trailing_stop') &&
      confidence === autoExec.require_confidence &&
      (recommendation.includes('SELL') || recommendation.includes('HOLD'));

    if (shouldAutoExecute) {
      const lastExec = analysisRateLimit.get(symbol + '_executed');
      const cooldownMs = (autoExec.cooldown_minutes || 60) * 60 * 1000;
      if (lastExec && Date.now() - lastExec < cooldownMs) {
        await sendTelegram(
          `🤖 <b>AUTO-EXEC COOLDOWN — ${coinBase}</b>\n` +
          `Last execution ${Math.round((Date.now()-lastExec)/60000)}min ago\n` +
          `Waiting ${autoExec.cooldown_minutes}min between executions\n\n` +
          `${analysis}`
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
      // Not auto-executing — show options menu as normal
      pendingAnalysis.set(symbol, { type: 'trailing_stop', recommendation, analysis, price: currentPrice, timestamp: Date.now() });
      lastAlertContext.set(TELEGRAM_CHAT_ID, { symbol, coinBase, alertType: 'claude_analysis_trailing' });
      await sendTelegram(
        `🧠 <b>CLAUDE ANALYSIS — ${coinBase}</b>\n\n` +
        `${analysis}\n\n` +
        `─────────────────\n` +
        `1️⃣ Sell now — take profits\n` +
        `2️⃣ Hold — reset trailing stop\n` +
        `3️⃣ Wait — monitor next candle\n` +
        `4️⃣ Buy more — add to position\n` +
        `5️⃣ Ignore — dismiss alert`
      );
    }
  } catch (e) {
    console.error('[analysis] analyseTrailingStopAlert error:', e.message);
  }
}

async function analyseFixedTargetAlert(symbol, currentPrice, target) {
  const ONE_HOUR = 60 * 60 * 1000;
  const lastAnalysis = analysisRateLimit.get(symbol);
  if (lastAnalysis && Date.now() - lastAnalysis < ONE_HOUR) {
    console.log(`[analysis] Rate limited — ${symbol} analysed ${Math.round((Date.now()-lastAnalysis)/60000)}min ago`);
    return;
  }
  analysisRateLimit.set(symbol, Date.now());

  try {
    const coinBase = symbol.replace('-USD', '');
    const entryPrice = entryPrices.get(symbol) || target.entryPrice;

    const prompt = `Price target hit for ${coinBase}.
Target: $${parseFloat(target.targetPrice).toFixed(6)}
Current: $${currentPrice.toFixed(6)}
Entry: ${entryPrice ? '$' + entryPrice.toFixed(6) : 'unknown'}
Direction: ${target.direction}

Should Bryan take profits now, hold for more, or ladder out partially?
Be concise — 3 lines max:
RECOMMENDATION: [SELL/HOLD/LADDER]
REASON: [one sentence]
NEXT TARGET: [price if holding]`;

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    });
    const analysis = msg.content?.[0]?.text || 'Analysis unavailable';
    console.log(`[analysis] ${coinBase} fixed target: ${msg.usage?.input_tokens}in ${msg.usage?.output_tokens}out`);

    pendingAnalysis.set(symbol, { type: 'fixed_target', analysis, price: currentPrice, timestamp: Date.now() });
    lastAlertContext.set(TELEGRAM_CHAT_ID, { symbol, coinBase, alertType: 'claude_analysis_target' });

    await sendTelegram(
      `🧠 <b>CLAUDE ANALYSIS — ${coinBase} TARGET HIT</b>\n\n` +
      `${analysis}\n\n` +
      `─────────────────\n` +
      `1️⃣ Sell — take profits\n` +
      `2️⃣ Hold — wait for more\n` +
      `3️⃣ Ladder — sell 25% only\n` +
      `4️⃣ Set new target\n` +
      `5️⃣ Dismiss`
    );
  } catch (e) {
    console.error('[analysis] analyseFixedTargetAlert error:', e.message);
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

    await sendTelegram(
      `🤖 <b>AI AUTO-EXECUTED — ${coinBase}</b>\n\n` +
      `✅ SELL ${sellQty.toFixed(4)} ${coinBase}\n` +
      `@ $${currentPrice.toFixed(4)} = $${valueUSD.toFixed(2)}\n\n` +
      `Confidence: ${confidence}\n` +
      `${analysis.split('\n')[0]}\n\n` +
      `Reply UNDO within 2 min to reverse ⏪`
    );
    console.log(`[auto-exec] SELL ${sellQty.toFixed(4)} ${coinBase} @ $${currentPrice.toFixed(4)}`);
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

  const alertMsg =
    `⚠️ <b>TRAILING STOP TRIGGERED — ${coinBase}</b>\n\n` +
    `Exchange: ${exchLabel}\n` +
    `📉 Drop: ${dropFromPeak}% from peak\n` +
    `Peak: ${fmtPriceShort(ts.peakPrice)} | Current: ${fmtPriceShort(currentPrice)}\n` +
    `Trail: ${ts.trailPct}% | Stop level: ${fmtPriceShort(ts.stopPrice)}\n` +
    (entryLine ? entryLine + '\n' : '') +
    `\n🧠 Running AI analysis...`;

  await sendTelegram(alertMsg);
  lastAlertContext.set(TELEGRAM_CHAT_ID, { symbol, coinBase, alertType: 'trailing_stop' });
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

    await sendTelegram(
      `🤖 <b>AI AUTO-EXECUTED — ${coinBase} (Kraken)</b>\n\n` +
      `✅ SELL ${sellQty.toFixed(4)} ${coinBase}\n` +
      `@ $${currentPrice.toFixed(4)} = $${valueUSD.toFixed(2)}\n\n` +
      `Confidence: ${confidence}\n` +
      `${analysis.split('\n')[0]}\n\n` +
      `Reply UNDO within 2 min to reverse ⏪`
    );
    console.log(`[auto-exec] Kraken SELL ${sellQty.toFixed(4)} ${coinBase} @ $${currentPrice.toFixed(4)}`);
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
          await sendTelegram(
            `${tradeIcon} ${actionTag} ${formatTradeQty(resolvedVolume)} ${coinBase} @ ${formatPrice(currentPrice)} = $${valueUsd.toFixed(2)} ${exchIcon}${cashSuffix}`
          );

          // Part 3: Low cash warning — once per day per exchange after any trade
          if (remainingUSD !== null && remainingUSD < 20) {
            const today = new Date().toDateString();
            const lastLowCashAlert = lowCashAlerted.get(exchange);
            if (lastLowCashAlert !== today) {
              lowCashAlerted.set(exchange, today);
              await sendTelegram(
                `💸 <b>LOW CASH WARNING — ${exchangeLabel}</b>\n\n` +
                `${exchangeLabel} cash: $${remainingUSD.toFixed(2)}\n\n` +
                `Buy-back rules may not execute if cash runs out. Consider:\n` +
                `• Enabling USDT sweep on more coins\n` +
                `• Selling a position to free up cash\n` +
                `• Depositing additional funds\n\n` +
                `Current USDT sweep: ${sweepEnabled ? `ON ✅ (${sweepPct}%)` : 'OFF ❌'}`
              ).catch(() => {});
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

    // ── USDT balance change detection — debit card payments vs dry powder ────
    if (portfolioCheckCount === 2) {
      // Debug log on second check to confirm USDT is visible in balances
      const usdtDebug = balances.find(b => b.currency === 'USDT' || b.currency === 'USD');
      console.log('[usdt] Balance check:', JSON.stringify(usdtDebug));
    }
    if (portfolioCheckCount > 1) {
      try {
        const usdtAsset = balances.find(b => b.currency === 'USDT');
        const currentUSDT = usdtAsset ? parseFloat(usdtAsset.available) : 0;
        const prevUSDT    = previousBalances.get('USDT-USD') ?? null;

        if (prevUSDT !== null) {
          const usdtDecrease = prevUSDT - currentUSDT;
          const usdtIncrease = currentUSDT - prevUSDT;

          if (usdtDecrease > 0.50) {
            // Debit card payment — auto-log and deduct capital
            console.log(`[usdt] USDT decreased by $${usdtDecrease.toFixed(2)} — checking if swap or real payment`);

            // Swap guard: if a crypto balance increased by ~same USD value in this cycle,
            // it's a USDT→crypto internal swap — not a card payment
            let isCryptoSwap = false;
            for (const asset of balances) {
              if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
              const sym = `${asset.currency}-USD`;
              const prevQty = previousBalances.get(sym) || 0;
              const currQty = parseFloat(asset.available || 0);
              const increase = currQty - prevQty;
              if (increase <= 0) continue;
              const coinPrice = priceMap[sym] || 0;
              const increaseUSD = increase * coinPrice;
              if (increaseUSD > 0 && Math.abs(increaseUSD - usdtDecrease) / usdtDecrease < 0.10) {
                isCryptoSwap = true;
                console.log(`[usdt] USDT decrease matched ${sym} increase of $${increaseUSD.toFixed(2)} — internal swap, not payment`);
                break;
              }
            }

            if (isCryptoSwap) {
              // Just update the snapshot — the crypto buy will be logged by autoLogTrade
              previousBalances.set('USDT-USD', currentUSDT);
              await db.execute(
                'INSERT INTO balance_snapshots (symbol, quantity) VALUES (?, ?) ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)',
                ['USDT-USD', currentUSDT]
              ).catch(() => {});
            } else {

            // Dedup guard: don't double-log if already recorded in last 10 min
            const [recentLog] = await db.execute(
              `SELECT id FROM trading_journal
               WHERE symbol = 'USDT' AND action = 'payment'
               AND source IN ('auto_payment', 'revolut_card')
               AND created_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)
               LIMIT 1`
            );
            if (recentLog.length > 0) {
              console.log('[usdt] Payment already logged in last 10 min — skipping duplicate');
              previousBalances.set('USDT-USD', currentUSDT);
            } else {

            await db.execute(
              `INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, source)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              ['USDT', 'payment', 1.00, usdtDecrease, usdtDecrease,
               'Revolut debit card payment — USDT spent', 'neutral', 'auto_payment']
            );
            const prevCapital = totalInvestedCapital;
            const newCapital  = totalInvestedCapital - usdtDecrease;
            await updateInvestedCapital(newCapital, `Auto-deducted: USDT debit card payment $${usdtDecrease.toFixed(2)}`);
            previousBalances.set('USDT-USD', currentUSDT);
            await db.execute(
              'INSERT INTO balance_snapshots (symbol, quantity) VALUES (?, ?) ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)',
              ['USDT-USD', currentUSDT]
            );
            await sendTelegram(`💳 PAYMENT $${usdtDecrease.toFixed(2)} — capital updated`);
            console.log(`[usdt] Payment auto-logged — capital $${prevCapital.toFixed(2)} → $${newCapital.toFixed(2)}`);
            } // end dedup guard else
            } // end swap guard else
          } else if (usdtIncrease > 0.50) {
            // USDT increased (sweep deposit or manual top-up) — just update snapshot silently
            console.log(`[usdt] USDT increased by $${usdtIncrease.toFixed(2)} — dry powder reserve updated (no journal entry)`);
            previousBalances.set('USDT-USD', currentUSDT);
            await db.execute(
              'INSERT INTO balance_snapshots (symbol, quantity) VALUES (?, ?) ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)',
              ['USDT-USD', currentUSDT]
            );
          }
        } else {
          // First time seeing USDT — just record the baseline
          previousBalances.set('USDT-USD', currentUSDT);
          await db.execute(
            'INSERT INTO balance_snapshots (symbol, quantity) VALUES (?, ?) ON DUPLICATE KEY UPDATE quantity = VALUES(quantity)',
            ['USDT-USD', currentUSDT]
          ).catch(() => {});
        }
      } catch (e) {
        console.error('[usdt] Payment detection error:', e.message);
      }
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
        const change = (currentPrice - basePrices[symbol]) / basePrices[symbol];
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

      // Dust position check — suppress pump/drop alerts for positions worth less than $1
      const positionValueUsd = available * currentPrice;
      if (positionValueUsd > 0 && positionValueUsd < 1.00) {
        console.log(`[dust] Skipping ${symbol} — position value $${positionValueUsd.toFixed(4)} below $1 minimum`);
        continue;
      }

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
              `Still up ${pct}% from baseline today.\n` +
              `This is the final reminder.\n\n` +
              `1️⃣ Hold\n2️⃣ Sell advice\n3️⃣ Buy more\n4️⃣ Analyse\n5️⃣ Acknowledge — stop alerts`
            );
          }
          // else: within 10 min window — stay silent
          continue;
        }

        // First time firing for this move
        alertFirstSent.set(symbol, now);
        alertState.active.set(symbol, true); // signal to other parts of the code that pump alert is live
        const aiRec = alertRecommendations.get(symbol)?.rec || 'HOLD - Monitor the situation closely.';
        const replyMenu = `\n\n1️⃣ Hold — acknowledge & set sell target\n2️⃣ Sell — get sell advice\n3️⃣ Buy more — get buy advice\n4️⃣ Analyse — full analysis\n5️⃣ Ignore — never alert again`;
        const swingPumpHint = `\n\n⚡ SWING SIGNAL: This pump may be your sell opportunity!\nCheck if this is outside normal range — if so, consider taking profits and setting a buy-back alert at ${fmtPriceShort(currentPrice * 0.85)} (-15%)`;
        const trailReminderPump = trailingStops.has(symbol)
          ? `\n\n📈 TREND IS YOUR FRIEND — Trailing stop is protecting your profits. Let it run unless structure breaks!`
          : '';
        const alertMessage =
          `📈 <b>${symbol} DAILY PUMP ALERT</b>\n\n` +
          `Baseline: ${formatPrice(basePrices[symbol])} → Now ${formatPrice(currentPrice)} (+${pct}%)\n` +
          `You hold: ${available} ${coinBase}\n\n` +
          `⚡ RECOMMENDATION: ${aiRec}${swingPumpHint}${trailReminderPump}${replyMenu}\n\n` +
          `⏰ One reminder in 10 min if no response`;
        await sendTelegram(alertMessage);
        lastAlertContext.set(TELEGRAM_CHAT_ID, { symbol, coinBase, alertType: 'pump' });
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
              `Still down ${pct}% from baseline today.\n` +
              `This is the final reminder.\n\n` +
              `1️⃣ Hold\n2️⃣ Buy more\n3️⃣ Sell advice\n4️⃣ Analyse\n5️⃣ Acknowledge — stop alerts`
            );
          }
          // else: within 10 min window — stay silent
          continue;
        }

        // First time firing for this move
        alertFirstSent.set(symbol, now);
        activeDropAlerts.set(symbol, true); // signal to other parts of the code that drop alert is live
        const aiRec = alertRecommendations.get(symbol)?.rec || 'HOLD - Monitor the situation closely.';
        const replyMenu = `\n\n1️⃣ Hold — acknowledge & set buy target\n2️⃣ Buy more — get buy the dip advice\n3️⃣ Sell — get sell advice\n4️⃣ Analyse — full analysis\n5️⃣ Ignore — never alert again`;
        const swingDropHint = `\n\n⚡ SWING SIGNAL: This drop may be your buy opportunity!\nCheck if this is outside normal range — if so, consider buying the dip and setting a sell alert at ${fmtPriceShort(currentPrice * 1.20)} (+20%)`;
        const alertMessage =
          `📉 <b>${symbol} DROP ALERT!</b>\n\n` +
          `Baseline: ${formatPrice(basePrices[symbol])} → Now ${formatPrice(currentPrice)} (-${pct}%)\n` +
          `You hold: ${available} ${coinBase}\n\n` +
          `⚡ RECOMMENDATION: ${aiRec}${swingDropHint}${replyMenu}\n\n` +
          `⏰ One reminder in 10 min if no response`;
        await sendTelegram(alertMessage);
        lastAlertContext.set(TELEGRAM_CHAT_ID, { symbol, coinBase, alertType: 'drop' });
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
    for (const [symbol, target] of priceTargets) {
      const currentPrice = priceMap[symbol];
      if (!currentPrice) continue;

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

      if (direction === 'up' && currentPrice >= target.targetPrice && !activeFixedAlerts.has(symbol) && !alertState.acknowledged.has(symbol) && !ignoredCoins.has(symbol)) {
        const changePct = ((currentPrice - target.anchorPrice) / target.anchorPrice) * 100;
        const coinBase = symbol.replace('-USD', '');

        // Max-2-reminders: if already sent 2+ reminders, auto-acknowledge and delete target
        const remindersSent = targetReminderCount.get(symbol) || 0;
        if (remindersSent >= 2) {
          console.log(`[targets] Auto-acknowledging ${symbol} — ${remindersSent} reminders already sent`);
          priceTargets.delete(symbol);
          targetReminderCount.delete(symbol);
          await db.execute('DELETE FROM price_targets WHERE symbol = ?', [symbol]).catch(() => {});
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
            `Price: $${priceStr} (your Claude-recommended sell zone)\n` +
            `Original advice: '<i>${upNoteData.snippet}</i>'\n` +
            (positionLine ? positionLine + '\n' : '') +
            `\n⚡ <b>RECOMMENDATION:</b> This is your planned profit zone.\n` +
            `Take action? Reply:\n` +
            `'sold ${coinBase} [price] [qty]' — log the sale\n` +
            `'analyse ${coinBase}' — get fresh analysis before deciding\n` +
            `'hold ${coinBase}' — log decision to hold through this level`;
        } else {
          const replyMenu = `\n\n1️⃣ Sell — get sell advice\n2️⃣ Hold — keep holding\n3️⃣ Analyse — full analysis\n4️⃣ Acknowledge — dismiss alert`;
          const autoReady = await getAutomationReadiness(symbol, 'buy');
          const autoLine = autoReady ? `\n\n⚡ AUTO-READY: This setup has worked ${autoReady.winRate}% of the time (${autoReady.sampleSize} trades). Could be automated.` : '';
          alertMessage = `🎯 <b>${symbol} FIXED TARGET HIT!</b>\n\nAnchor: $${anchorStr} → Now $${priceStr} (+${changePct.toFixed(1)}%)${entryLine}\n\n⚡ RECOMMENDATION: ${aiRec}${replyMenu}${autoLine}`;
        }
        await sendTelegram(alertMessage);
        lastAlertContext.set(TELEGRAM_CHAT_ID, { symbol, coinBase, alertType: 'fixed_target_up' });
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

      if (direction === 'down' && currentPrice <= target.targetPrice && !activeFixedAlerts.has(symbol) && !alertState.acknowledged.has(symbol) && !ignoredCoins.has(symbol)) {
        const changePct = ((currentPrice - target.anchorPrice) / target.anchorPrice) * 100;
        const coinBase = symbol.replace('-USD', '');

        // Max-2-reminders: if already sent 2+ reminders, auto-acknowledge and delete target
        const remindersSentDown = targetReminderCount.get(symbol) || 0;
        if (remindersSentDown >= 2) {
          console.log(`[targets] Auto-acknowledging ${symbol} (down) — ${remindersSentDown} reminders already sent`);
          priceTargets.delete(symbol);
          targetReminderCount.delete(symbol);
          await db.execute('DELETE FROM price_targets WHERE symbol = ?', [symbol]).catch(() => {});
          await sendTelegram(`🔕 <b>Target auto-dismissed: ${coinBase}</b>\nNo response after 2 reminders — target removed. Set a new one when ready.`).catch(() => {});
          continue;
        }

        const entryPrice = entryPrices.get(symbol) || target.entryPrice;
        const plPct = entryPrice ? ((currentPrice - entryPrice) / entryPrice * 100).toFixed(1) : null;
        const replyMenu = `\n\n1️⃣ Buy more — get buy the dip advice\n2️⃣ Hold — keep holding\n3️⃣ Sell — get sell advice\n4️⃣ Acknowledge — dismiss alert`;

        let alertMessage;
        let noteData = null;
        try { if (target.note) noteData = JSON.parse(target.note); } catch (e) {}

        if (noteData && noteData.source === 'claude_rec') {
          // Enhanced message: this was auto-set from Bryan's thumbs-up on a recommendation
          const assetBalance = balances.find(a => a.currency === coinBase);
          const qty = assetBalance ? parseFloat(assetBalance.available) : 0;
          const positionLine = entryPrice && qty > 0
            ? `Your current position: ${qty.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${coinBase} @ ${formatPrice(entryPrice)} entry (P&L: ${plPct}%)`
            : (qty > 0 ? `You hold: ${qty.toLocaleString('en-US', { maximumFractionDigits: 6 })} ${coinBase}` : '');
          alertMessage =
            `📊 <b>${coinBase} HIT YOUR BUY LEVEL!</b>\n\n` +
            `Price: ${formatPrice(currentPrice)} (your Claude-recommended buy zone)\n` +
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
          alertMessage = `📉 <b>${symbol} FIXED FLOOR HIT!</b>\n\nAnchor: ${formatPrice(target.anchorPrice)} → Now ${formatPrice(currentPrice)} (${changePct.toFixed(1)}%)${entryLine}\n\n⚡ RECOMMENDATION: ${aiRec}${replyMenu}${autoLine}`;
        }
        await sendTelegram(alertMessage);
        lastAlertContext.set(TELEGRAM_CHAT_ID, { symbol, coinBase, alertType: 'fixed_target_down' });

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
        const swingPositionValue = parseFloat(asset.available) * currentPrice;
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
        const available = parseFloat(asset.available);
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
          await sendTelegram(
            `📈 <b>${symbol} DAILY PUMP ALERT (Kraken)</b>\n\n` +
            `Baseline: ${fmtPriceShort(basePrices[symbol])} → Now ${fmtPriceShort(asset.price)} (+${pct}%)\n` +
            `You hold: ${asset.quantity.toFixed(4)} ${coinBase} on Kraken\n\n` +
            `⚡ RECOMMENDATION: ${aiRec}` + trailReminderKraken + `\n\n` +
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
}, 5000);

// Record prices at midnight every day (UK time)
cron.schedule('0 0 * * *', recordDailyPrices, { timezone: 'Europe/London' });

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

// Daily cleanup — 2 AM: delete expired unmatched trade intentions
cron.schedule('0 2 * * *', async () => {
  try {
    const [r] = await db.execute('DELETE FROM trade_intentions WHERE expires_at < NOW() AND matched_at IS NULL');
    if (r.affectedRows > 0) console.log(`[intentions] Cleaned up ${r.affectedRows} expired unmatched intention(s)`);
  } catch (e) { console.error('[intentions] cleanup error:', e.message); }
}, { timezone: 'Europe/London' });

// Daily rebalancing outcome checks — 10:05 AM (7-day + 30-day)
cron.schedule('5 10 * * *', checkRebalancingOutcomes, { timezone: 'Europe/London' });

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
  } catch (e) {
    console.error('[config] Weekly snapshot error:', e.message);
  }
}, { timezone: 'Europe/London' });

console.log('Cron jobs scheduled: midnight price recording + 9 AM morning briefing + every-2h macro news + Monday 9:05 rebalancing check + 10 AM intention outcomes + 10:02 AM rebalance checks (Europe/London)');

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

  server.tool('get_prices', 'Get current crypto prices',
    { symbol: z.string().describe('Trading pair e.g. BTC-USD') },
    async ({ symbol }) => {
      const data = await revolutRequest('GET', '/market/tickers');
      const ticker = Array.isArray(data) ? data.find(t => t.symbol === symbol) : data;
      return { content: [{ type: 'text', text: JSON.stringify(ticker || data, null, 2) }] };
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
          for (const asset of balances) {
            if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
            const qty = parseFloat(asset.available);
            if (qty <= 0) continue;
            const sym = `${asset.currency}-USD`;
            const price = priceMap[sym] || null;
            const valueUsd = price ? qty * price : null;
            if (valueUsd) totalValue += valueUsd;
            const entry = entryPrices.get(sym) || null;
            const plPct = entry && price ? ((price - entry) / entry * 100).toFixed(2) : null;
            positions.push({ symbol: sym, currency: asset.currency, quantity: qty, price, value_usd: valueUsd?.toFixed(2), entry_price: entry, pl_pct: plPct });
          }
          positions.sort((a, b) => (parseFloat(b.value_usd) || 0) - (parseFloat(a.value_usd) || 0));
          const cap = getCapitalSummary(totalValue);
          result.revolut = { total_value_usd: totalValue.toFixed(2), invested: cap.invested, pl_usd: cap.pnl.toFixed(2), pl_pct: cap.pnlPct.toFixed(2), positions };
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
    'Get trading journal entries, active alerts, trader context/profile, and rebalancing history',
    {
      include: z.array(z.enum(['journal', 'alerts', 'context', 'rebalancing', 'all'])).optional()
        .describe('What data to fetch — defaults to all'),
      symbol: z.string().optional().describe('Filter journal by coin e.g. NEAR'),
      limit:  z.number().optional().describe('Max journal entries to return, default 10'),
    },
    async ({ include, symbol, limit } = {}) => {
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

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Tool: manage_alerts ────────────────────────────────────────────────────
  server.tool('manage_alerts',
    'Set or manage all alert types — fixed price targets, daily thresholds, trailing stops, acknowledge or ignore coins',
    {
      action:        z.enum(['set_target', 'set_threshold', 'set_trailing', 'acknowledge', 'ignore', 'remove_trailing']).describe('What alert action to perform'),
      symbol:        z.string().describe('Trading pair e.g. NEAR-USD or NEAR'),
      direction:     z.enum(['up', 'down']).optional().describe('Alert direction for set_target'),
      threshold_pct: z.number().optional().describe('Percentage for set_target or set_threshold'),
      anchor_price:  z.number().optional().describe('Anchor price for set_target'),
      trail_pct:     z.number().optional().describe('Trailing percentage e.g. 10 for 10%'),
      current_price: z.number().optional().describe('Manual price override for set_trailing — useful for Kraken-only coins if auto-fetch fails'),
    },
    async ({ action, symbol, direction, threshold_pct, anchor_price, trail_pct, current_price }) => {
      const sym      = symbol.includes('-USD') ? symbol.toUpperCase() : `${symbol.toUpperCase()}-USD`;
      const coinBase = sym.replace('-USD', '');
      let result = {};

      if (action === 'set_target') {
        const dir = direction || 'up';
        let r;
        if (anchor_price) {
          const targetPrice = dir === 'down'
            ? anchor_price * (1 - threshold_pct / 100)
            : anchor_price * (1 + threshold_pct / 100);
          await db.execute(
            'INSERT INTO price_targets (symbol, anchor_price, threshold_pct, target_price, direction) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE anchor_price=VALUES(anchor_price), threshold_pct=VALUES(threshold_pct), target_price=VALUES(target_price), direction=VALUES(direction), updated_at=CURRENT_TIMESTAMP',
            [sym, anchor_price, threshold_pct, targetPrice, dir]
          );
          priceTargets.set(sym, { anchorPrice: anchor_price, thresholdPct: threshold_pct, targetPrice, direction: dir, note: null });
          alertState.acknowledged.delete(sym);
          r = { anchorPrice: anchor_price, targetPrice, direction: dir };
        } else {
          r = await setFixedTarget(sym, threshold_pct, dir);
        }
        result = { ok: true, action: 'set_target', symbol: sym, ...r, message: `Alert set — fires when ${sym} ${dir === 'down' ? 'drops to' : 'hits'} $${r.targetPrice?.toFixed(6)}` };

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

      } else if (action === 'remove_trailing') {
        await removeTrailingStop(sym);
        result = { ok: true, action: 'remove_trailing', symbol: sym, message: `Trailing stop removed for ${coinBase}` };
      }

      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Tool: manage_trading ───────────────────────────────────────────────────
  server.tool('manage_trading',
    'Log journal entries, trade intentions, trader preferences, update invested capital, or configure USDT sweep',
    {
      action:                 z.enum(['log_journal', 'log_intention', 'save_preference', 'update_capital', 'configure_sweep', 'configure_auto_execute']).describe('What trading action to perform'),
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
    },
    async ({ action, symbol, trade_action, price, quantity, reasoning, emotion, followed_recommendation, expires_hours, key, value, amount, capital_type, note, enabled, sweep_pct, min_trade_value_usd, excluded_symbols, max_sell_pct, max_buy_usd, allowed_triggers, require_confidence, cooldown_minutes }) => {

      if (action === 'log_journal') {
        const sym      = symbol?.includes('-USD') ? symbol.toUpperCase() : `${symbol?.toUpperCase()}-USD`;
        const coinBase = sym.replace('-USD', '');
        const valueUsd = quantity && price ? quantity * price : null;
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
        const config = {
          enabled: enabled ?? false,
          max_sell_pct: max_sell_pct || 25,
          max_buy_usd: max_buy_usd || 100,
          allowed_triggers: allowed_triggers || ['trailing_stop', 'fixed_target', 'pump_alert'],
          require_confidence: require_confidence || 'High',
          cooldown_minutes: cooldown_minutes || 60,
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
          `Triggers: ${config.allowed_triggers.join(', ')}`
        );
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, config, saved_to: 'system_config' }) }] };
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
      entryPrices.set(sym, entry_price);
      await db.execute(
        'INSERT INTO entry_prices (symbol, entry_price) VALUES (?, ?) ON DUPLICATE KEY UPDATE entry_price = VALUES(entry_price)',
        [sym, entry_price]
      );
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
      for (const asset of balances) {
        if (!asset.currency || SKIP_CURRENCIES.includes(asset.currency)) continue;
        const qty = parseFloat(asset.available);
        if (qty <= 0) continue;
        const sym = `${asset.currency}-USD`;
        const price = priceMap[sym] || priceMap[`${asset.currency}/USD`] || null;
        const valueUsd = price ? qty * price : null;
        if (valueUsd) totalValue += valueUsd;
        const entry = entryPrices.get(sym) || null;
        const plPct = entry && price ? ((price - entry) / entry * 100).toFixed(2) : null;
        const plUsd = entry && price && qty ? ((price - entry) * qty).toFixed(2) : null;
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
      const cap = getCapitalSummary(totalValue);

      // Filter: remove dust (<$1) and ignored coins
      const ignoredCount = positions.filter(p => ignoredCoins.has(p.symbol)).length;
      const dustCount    = positions.filter(p => !ignoredCoins.has(p.symbol) && parseFloat(p.value_usd || 0) > 0 && parseFloat(p.value_usd || 0) < 1.00).length;
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

      if (exchange === 'revolut') {
        pendingRevolutTrade = { symbol: sym, side, orderType: order_type, baseSize: volume || 0, valueUsd: value_usd || null, price: livePrice, valueUSD: tradeValueUSD, timestamp: Date.now(), source: 'claude_mcp' };
      } else {
        pendingKrakenTrade = { symbol: sym, side, orderType: order_type, volume: volume || 0, price: livePrice, valueUSD: tradeValueUSD, timestamp: Date.now(), source: 'claude_mcp' };
      }

      await sendTelegram(
        `🔔 <b>TRADE APPROVAL REQUIRED</b>\n\n` +
        `Exchange: ${exchangeLabel}\n` +
        `Action: <b>${side.toUpperCase()} ${displayQty}${value_usd ? ` of ${coinBase}` : ''}</b>\n` +
        `Type: ${order_type}\n` +
        `Price: ${livePrice ? formatPrice(livePrice) : 'market'}\n` +
        `Value: ~${tradeValueUSD ? '$' + tradeValueUSD.toFixed(2) : 'unknown'}\n\n` +
        `Reply <b>'approve trade'</b> or 👍 to execute\n` +
        `Reply <b>'cancel trade'</b> or 👎 to abort\n\n` +
        `⏱ Auto-cancels in ~12 minutes if no response`
      );

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

// GET /api/auto-rules
app.get('/api/auto-rules', async (req, res) => {
  try {
    const [rules] = await db.execute('SELECT * FROM auto_trade_rules ORDER BY created_at DESC');
    res.json(rules);
  } catch (e) { res.status(500).json({ error: e.message }); }
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

    // --- Numbered reply shortcuts ---
    const chatIdStr = chatId.toString();
    const numberReply = commandText.match(/^[1-5]$/);

    // --- Claude Analysis numbered responses (1️⃣–5️⃣ after auto-analysis message) ---
    if (numberReply && lastAlertContext.has(TELEGRAM_CHAT_ID)) {
      const ctx = lastAlertContext.get(TELEGRAM_CHAT_ID);
      if (ctx.alertType === 'claude_analysis_trailing' || ctx.alertType === 'claude_analysis_target') {
        const { symbol, coinBase } = ctx;
        const pending = pendingAnalysis.get(symbol);
        const choice = parseInt(numberReply[0]);
        pendingAnalysis.delete(symbol);
        lastAlertContext.delete(TELEGRAM_CHAT_ID);

        if (choice === 1) {
          // SELL NOW — set up 25% ladder sell pending approval
          const currentPrice = await getCurrentPrice(symbol).catch(() => null);
          if (!currentPrice) { await sendReply(`⚠️ Could not fetch ${coinBase} price`); return res.status(200).json({ ok: true }); }
          const balancesNow = await revolutRequest('GET', '/balances').catch(() => []);
          const asset = balancesNow.find(b => b.currency === coinBase);
          const currentQty = parseFloat(asset?.available || 0);
          if (currentQty <= 0) {
            await sendReply(`⚠️ No ${coinBase} balance found — nothing to sell`);
            return res.status(200).json({ ok: true });
          }
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
          // HOLD — reset trailing stop from current price
          const currentPrice = await getCurrentPrice(symbol).catch(() => null);
          if (currentPrice && trailingStops.has(symbol)) {
            await setTrailingStop(symbol, trailingStops.get(symbol).trailPct, currentPrice, entryPrices.get(symbol));
            await sendReply(`✅ Trailing stop reset for ${coinBase}\nNew peak: ${fmtPriceShort(currentPrice)} | Stop: ${fmtPriceShort(trailingStops.get(symbol)?.stopPrice)}`);
          } else {
            await sendReply(`✅ ${coinBase} — holding noted`);
          }

        } else if (choice === 3) {
          if (pending?.type === 'fixed_target') {
            // LADDER SELL 25% for fixed target context
            const currentPrice = await getCurrentPrice(symbol).catch(() => null);
            if (!currentPrice) { await sendReply(`⚠️ Could not fetch ${coinBase} price`); return res.status(200).json({ ok: true }); }
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
            // WAIT 30 min for trailing stop context
            alertState.acknowledged.set(symbol, Date.now());
            setTimeout(() => { alertState.acknowledged.delete(symbol); }, 30 * 60 * 1000);
            await sendReply(`⏳ ${coinBase} — watching for 30 min, then alert resumes`);
          }

        } else if (choice === 4) {
          // BUY MORE — check USD, set up pending buy
          const currentPrice = await getCurrentPrice(symbol).catch(() => null);
          if (!currentPrice) { await sendReply(`⚠️ Could not fetch ${coinBase} price`); return res.status(200).json({ ok: true }); }
          const balancesNow = await revolutRequest('GET', '/balances').catch(() => []);
          const usdAsset = balancesNow.find(b => b.currency === 'USD' || b.currency === 'USDT');
          const availableUSD = parseFloat(usdAsset?.available || 0);
          if (availableUSD < 10) {
            await sendReply(`⚠️ Insufficient USD to buy ${coinBase}\nAvailable: $${availableUSD.toFixed(2)} (min $10)`);
            return res.status(200).json({ ok: true });
          }
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
          // IGNORE — dismiss alert
          await acknowledgeAlert(symbol);
          await sendReply(`🔕 ${coinBase} alert dismissed`);
        }

        return res.status(200).json({ ok: true });
      }
    }

    if (numberReply && lastAlertContext.has(TELEGRAM_CHAT_ID)) {
      const ctx = lastAlertContext.get(TELEGRAM_CHAT_ID);
      const { symbol, coinBase, alertType } = ctx;
      const num = numberReply[0];

      // Map number to action based on alert type
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

      if (action) {
        console.log(`[alert] Number reply ${num} → '${action} ${coinBase}' (alertType: ${alertType})`);
        // Rewrite commandText to simulate coin-prefixed command and fall through
        // We do this by delegating directly to the right handler
        if (action === 'ignore') {
          ignoredCoins.add(symbol);
          await sendReply(`🔕 ${coinBase} added to ignore list — no more alerts.`);
          lastAlertContext.delete(TELEGRAM_CHAT_ID);
          return res.status(200).json({ ok: true });
        }
        if (action === 'acknowledge') {
          alertState.acknowledged.set(symbol, Date.now());
          await sendReply(`✅ ${coinBase} alert acknowledged.`);
          lastAlertContext.delete(TELEGRAM_CHAT_ID);
          return res.status(200).json({ ok: true });
        }
        if (action === 'hold' && alertType === 'trailing_stop') {
          // Reset trailing stop from current price
          const ts = trailingStops.get(symbol);
          if (ts) {
            const currentPrice = await getCurrentPrice(symbol).catch(() => null);
            if (currentPrice) {
              ts.peakPrice = currentPrice;
              ts.stopPrice = currentPrice * (1 - ts.trailPct / 100);
              trailingStops.set(symbol, ts);
              await sendReply(`📈 ${coinBase} trailing stop reset from ${fmtPriceShort(currentPrice)} — stop now at ${fmtPriceShort(ts.stopPrice)}`);
            } else {
              await sendReply(`✅ ${coinBase} hold noted — trail continues.`);
            }
          }
          lastAlertContext.delete(TELEGRAM_CHAT_ID);
          return res.status(200).json({ ok: true });
        }
        if (action === 'hold') {
          alertState.acknowledged.set(symbol, Date.now());
          await sendReply(`✅ ${coinBase} — holding noted. Alert acknowledged.`);
          lastAlertContext.delete(TELEGRAM_CHAT_ID);
          return res.status(200).json({ ok: true });
        }
        // For sell / buy / analyse: synthesise the coin command and let the main handler process it
        const syntheticCmd = action === 'buy' ? `buy more ${coinBase.toLowerCase()}` : `${action} ${coinBase.toLowerCase()}`;
        // Reprocess as if the user typed the coin command
        // Directly handle rather than re-routing to avoid webhook complexity
        if (action === 'sell') {
          await sendReply(`📊 Getting sell advice for <b>${coinBase}</b>…`);
          const currentPrice = await getCurrentPrice(symbol).catch(() => null);
          const changePct = currentPrice && basePrices[symbol] ? ((currentPrice - basePrices[symbol]) / basePrices[symbol] * 100) : 0;
          const advice = await getQuickAiRecommendation(symbol, changePct, currentPrice, 'up', 'user requested sell advice via number shortcut');
          await sendReply(`💡 <b>${coinBase} Sell Advice</b>\n\n${advice}`);
          lastAlertContext.delete(TELEGRAM_CHAT_ID);
          return res.status(200).json({ ok: true });
        }
        if (action === 'buy') {
          await sendReply(`📊 Getting buy advice for <b>${coinBase}</b>…`);
          const currentPrice = await getCurrentPrice(symbol).catch(() => null);
          const changePct = currentPrice && basePrices[symbol] ? ((currentPrice - basePrices[symbol]) / basePrices[symbol] * 100) : 0;
          const advice = await getQuickAiRecommendation(symbol, changePct, currentPrice, 'down', 'user requested buy advice via number shortcut');
          await sendReply(`💡 <b>${coinBase} Buy Advice</b>\n\n${advice}`);
          lastAlertContext.delete(TELEGRAM_CHAT_ID);
          return res.status(200).json({ ok: true });
        }
        if (action === 'analyse') {
          await sendReply(`🔍 Running full analysis for <b>${coinBase}</b>…`);
          const currentPrice = await getCurrentPrice(symbol).catch(() => null);
          const changePct = currentPrice && basePrices[symbol] ? ((currentPrice - basePrices[symbol]) / basePrices[symbol] * 100) : 0;
          const analysis = await getQuickAiRecommendation(symbol, changePct, currentPrice, 'up', 'full analysis requested via number shortcut');
          await sendReply(`📊 <b>${coinBase} Full Analysis</b>\n\n${analysis}`);
          lastAlertContext.delete(TELEGRAM_CHAT_ID);
          return res.status(200).json({ ok: true });
        }
      }
      // Unknown number for this alert type — fall through
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
      const buildAckOptions = (coinBase) =>
        `\nWhat would you like to do next?\n` +
        `• 'sell target ${coinBase} 0.05' — alert when price hits a level\n` +
        `• 'buy target ${coinBase} 0.04' — alert when price drops to a level\n` +
        `• 'watch ${coinBase} 20%' — alert on next 20% move\n` +
        `• 'ignore ${coinBase}' — no more alerts on this coin (permanent)\n` +
        `• Nothing — alerts stay silent until you restart or set a new alert`;

      if (ackMatch[1]) {
        // Specific coin
        const coinBase = ackMatch[1].toUpperCase();
        const symbol = `${coinBase}-USD`;
        console.log('[telegram] Acknowledge command for:', symbol);
        await acknowledgeAlert(symbol);
        await sendReply(`✅ <b>${coinBase} alerts stopped.</b>\n${buildAckOptions(coinBase)}`);
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
          await sendReply(`✅ <b>${coinBase} alerts stopped.</b>\n${buildAckOptions(coinBase)}`);
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

    // --- Command: ignore [COIN] — permanently stop all alerts for a coin ---
    const ignoreMatch = commandText.match(/^ignore\s+([a-z0-9]{2,10})$/);
    if (ignoreMatch) {
      const coinBase = ignoreMatch[1].toUpperCase();
      const symbol = `${coinBase}-USD`;
      console.log('[telegram] Ignore command for:', symbol);
      await ignoreCoin(symbol);
      await sendReply(
        `🚫 <b>${coinBase} ignored</b> — no more alerts on this coin.\n\n` +
        `This survives restarts. Send 'watch ${coinBase}' to re-enable anytime.`
      );
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
            await db.execute(
              'INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [coinBase, t.side, t.price, t.volume, t.valueUSD, 'Kraken trade approved via Telegram', 'confident', krakenSource]
            ).catch(e => console.error('[kraken] Journal insert failed:', e.message));

            // Tranche tracking
            if (t.side.toLowerCase() === 'buy') {
              await db.execute(
                `INSERT INTO position_tranches (symbol, exchange, quantity, entry_price, entry_date, remaining_quantity, is_legacy, notes)
                 VALUES (?, 'kraken', ?, ?, NOW(), ?, 0, ?)`,
                [coinBase, parseFloat(t.volume), t.price, parseFloat(t.volume), `Buy via Claude approval — Kraken`]
              ).catch(e => console.error('[tranches] Insert failed:', e.message));
            } else if (t.side.toLowerCase() === 'sell') {
              await reduceTranches(coinBase, 'kraken', parseFloat(t.volume))
                .catch(e => console.error('[tranches] Reduce failed:', e.message));
            }

            await sendTelegram(`${t.side === 'sell' ? '✅' : '🟢'} MCP ${t.side.toUpperCase()} ${formatTradeQty(t.volume)} ${coinBase} @ ${formatPrice(t.price)} = $${t.valueUSD?.toFixed(2)} 🦑 ✓`);
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
            const valueUSD = executedPrice * parseFloat(t.baseSize);

            // Check for matching trade intention
            const matchedIntention = await findMatchingIntention(t.symbol, t.side);
            const reasoning = matchedIntention ? matchedIntention.reasoning : 'Revolut X trade approved via Telegram';

            const revolutSource = t.source === 'claude_mcp' ? 'claude_mcp' : 'manual';
            await db.execute(
              'INSERT INTO trading_journal (symbol, action, price, quantity, value_usd, reasoning, emotion, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
              [coinBase, t.side, executedPrice, t.baseSize, valueUSD, reasoning, 'confident', revolutSource]
            ).catch(e => console.error('[revolut] Journal insert failed:', e.message));

            if (matchedIntention) {
              await db.execute('UPDATE trade_intentions SET matched_at = NOW() WHERE id = ?', [matchedIntention.id]).catch(() => {});
            }

            // Update avg entry price on buy
            if (t.side.toLowerCase() === 'buy') {
              const prevQty = previousBalances.get(t.symbol) || 0;
              const existingEntry = entryPrices.get(t.symbol);
              if (existingEntry && prevQty > 0) {
                const newQty = prevQty + parseFloat(t.baseSize);
                const newAvgEntry = ((prevQty * existingEntry) + (parseFloat(t.baseSize) * executedPrice)) / newQty;
                entryPrices.set(t.symbol, newAvgEntry);
                await db.execute('INSERT INTO entry_prices (symbol, entry_price) VALUES (?, ?) ON DUPLICATE KEY UPDATE entry_price = VALUES(entry_price)', [t.symbol, newAvgEntry]).catch(() => {});
              }
            }

            // Tranche tracking
            if (t.side.toLowerCase() === 'buy') {
              await db.execute(
                `INSERT INTO position_tranches (symbol, exchange, quantity, entry_price, entry_date, remaining_quantity, is_legacy, notes)
                 VALUES (?, 'revolut', ?, ?, NOW(), ?, 0, ?)`,
                [coinBase, parseFloat(t.baseSize), executedPrice, parseFloat(t.baseSize),
                 `Buy via Claude approval — Order ${result?.client_order_id || 'unknown'}`]
              ).catch(e => console.error('[tranches] Insert failed:', e.message));
            } else if (t.side.toLowerCase() === 'sell') {
              await reduceTranches(coinBase, 'revolut', parseFloat(t.baseSize))
                .catch(e => console.error('[tranches] Reduce failed:', e.message));
            }

            await sendTelegram(`${t.side === 'sell' ? '✅' : '🟢'} MCP ${t.side.toUpperCase()} ${formatTradeQty(t.baseSize)} ${coinBase} @ ${formatPrice(executedPrice)} = $${valueUSD.toFixed(2)} 🔄 ✓`);

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
            await sendReply(
              `✅ <b>${swCoinBase} alerts stopped.</b>\n\n` +
              `What would you like to do next?\n` +
              `• 'watch ${swCoinBase} 20%' — alert on next 20% move\n` +
              `• 'ignore ${swCoinBase}' — no more alerts on this coin\n` +
              `• Nothing — silent until you restart or set a new alert`
            );
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
            model: 'claude-sonnet-4-5',
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
            model: 'claude-sonnet-4-5',
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

// GET /api/activity — paginated trade feed with optional action filter
app.get('/api/activity', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const filter = req.query.filter || 'all';
    const params = [limit];
    const where  = filter !== 'all' ? 'WHERE action = ?' : '';
    if (filter !== 'all') params.unshift(filter);
    const [trades] = await db.execute(
      `SELECT id, symbol, action, price, quantity, value_usd,
              reasoning, emotion, outcome_pnl,
              created_at
       FROM trading_journal
       ${where}
       ORDER BY created_at DESC
       LIMIT ?`,
      params
    );
    res.json({ ok: true, trades, total: trades.length });
  } catch (e) {
    console.error('[activity] endpoint error:', e.message);
    res.status(500).json({ error: e.message, hint: 'Check Railway logs for details' });
  }
});

// PATCH /api/activity/:id — edit trade action and/or reasoning
app.patch('/api/activity/:id', async (req, res) => {
  try {
    const id        = parseInt(req.params.id);
    const { action, reasoning, emotion } = req.body;
    if (!id || !action) return res.status(400).json({ error: 'id and action required' });

    await db.execute(
      `UPDATE trading_journal
       SET action = ?, reasoning = ?, emotion = COALESCE(?, emotion), updated_at = NOW()
       WHERE id = ?`,
      [action, reasoning || null, emotion || null, id]
    );

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
