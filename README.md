# revolut-claude — Revolut X AI Portfolio Manager

A personal, single-user automated crypto portfolio manager. It monitors holdings across Revolut X and Kraken, tracks tax lots, fires price/structure/macro alerts to Telegram, and surfaces AI analysis and live web research — all so the owner can make better, less rushed trading decisions. **It is an assistant and a safety net, not an autonomous trader: the owner is the sole decision-maker.**

## How it's operated — three working threads

- **PM thread** — portfolio manager: analysis, alerts, trade logging, strategy reviews. Reads/writes the database via MCP tools. Never edits code.
- **Dev thread** — lead developer/diagnostician: read-only diagnosis, writes prompts for Cowork, verifies, manages the `dev_log`. Never edits live code directly.
- **Cowork** — a separate PC agent that performs the actual file edits and runs `PUSH_NOW.bat` to commit/deploy.

Every change passes through a written prompt + a verified read-back before deploy.

## Stack

Node.js (v22) / Express, single `server.js` · MySQL on Railway · Telegram bot (alerts + trade approval) · MCP server (`/mcp`) exposing tools to Claude · web dashboard (`public/dashboard.js`). External: Revolut X, Kraken, Tangem (XRP cold storage), Anthropic API, Google Drive (backups).

## Where to look

- **How & why the system is built** → [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system overview, data-flow map, subsystem map, design decisions + rationale, conventions.
- **Live ticket board / open work** → the `dev_log`, queried via the MCP tool `get_trading_data` with `include=['dev_log']`. This is the authoritative source for current status — not this file.
- **Exact diffs / build history** → git commit history.

## Safety posture (non-negotiable)

- **Auto-execution is OFF by default.** The system analyses and notifies; the owner decides and approves. Any auto-exec is railed (caps, floors, manual-only symbols) and is the rare exception.
- **Telegram-gated execution.** Every trade requires explicit owner approval. API trade routes are token-protected and fail-closed.
- **No leverage, no stop-losses** — spot only; trailing stops protect gains.
- **Diagnose read-only before editing; one change at a time; `node --check` before every push.**

## Secrets

All credentials (exchange API keys, Anthropic key, Telegram token, Google OAuth set, `API_TOKEN`, `BRIDGE_TOKEN`) live in **Railway environment variables — never in the repo**. Credential bugs are diagnosed via length/character-code checks, never by echoing values.

---

*This README is the front door. For anything operational, the live `dev_log` and `get_context` (via MCP) are always more current than any file here.*
