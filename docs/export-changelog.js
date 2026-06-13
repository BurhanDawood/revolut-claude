#!/usr/bin/env node
// docs/export-changelog.js
// Run from repo root: node docs/export-changelog.js
// Fetches the full dev_log export from the live server and writes
// docs/CHANGELOG-YYYY-MM-DD.md — no npm installs needed.

import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = 'revolut-claude-production.up.railway.app';
const body = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: {
    name: 'manage_trading',
    arguments: { action: 'export_dev_log' }
  }
});

console.log('[changelog] Fetching dev_log export from', HOST, '...');

const req = https.request(
  {
    hostname: HOST,
    path: '/mcp',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Content-Length': Buffer.byteLength(body),
    },
  },
  (res) => {
    let data = '';
    res.on('data', (chunk) => (data += chunk));
    res.on('end', () => {
      try {
        // MCP returns SSE format: "event: message\ndata: {...}\n\n"
        // Extract the JSON from the data: line
        const dataLine = data.split('\n').find(line => line.startsWith('data: '));
        if (!dataLine) throw new Error('No data line found in SSE response');
        const outer = JSON.parse(dataLine.slice(6)); // strip 'data: ' prefix
        const inner = JSON.parse(outer.result.content[0].text);

        if (!inner.ok || !inner.markdown) {
          console.error('[changelog] Export returned unexpected shape:', JSON.stringify(inner).slice(0, 200));
          process.exit(1);
        }

        const date = inner.export_date || new Date().toISOString().slice(0, 10);
        const outFile = path.join(__dirname, `CHANGELOG-${date}.md`);

        fs.mkdirSync(__dirname, { recursive: true });
        fs.writeFileSync(outFile, inner.markdown, 'utf8');

        console.log(`[changelog] Written: ${outFile}`);
        console.log(`[changelog]    Tickets: ${inner.ticket_count}`);
        console.log(`[changelog]    Date:    ${date}`);
        console.log(`[changelog]    Lines:   ${inner.markdown.split('\n').length}`);
        console.log('[changelog] Next: git add docs/CHANGELOG-' + date + '.md && git commit');
      } catch (e) {
        console.error('[changelog] Parse error:', e.message);
        console.error('[changelog] Raw response (first 500):', data.slice(0, 500));
        process.exit(1);
      }
    });
  }
);

req.on('error', (e) => {
  console.error('[changelog] Network error:', e.message);
  process.exit(1);
});

req.write(body);
req.end();
