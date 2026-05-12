import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { createPrivateKey, sign } from 'crypto';

const API_KEY = process.env.REVOLUTX_API_KEY;
const PRIVATE_KEY = process.env.REVOLUTX_PRIVATE_KEY;
const BASE_URL = 'https://revx.revolut.com/api/1.0';

async function signRequest(method, path, body = '') {
  const timestamp = Date.now().toString();
  const message = `${timestamp}${method}${path}${body}`;
  const privateKeyPem = PRIVATE_KEY.replace(/\\n/g, '\n');
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(message), privateKey);
  return {
    'X-Revx-Api-Key': API_KEY,
    'X-Revx-Timestamp': timestamp,
    'X-Revx-Signature': signature.toString('base64'),
    'Content-Type': 'application/json'
  };
}

async function revolutRequest(method, path) {
  const headers = await signRequest(method, path);
  const response = await fetch(`${BASE_URL}${path}`, { method, headers });
  const text = await response.text();
  console.log('Revolut API response:', response.status, text);
  return JSON.parse(text);
}

function createServer() {
  const server = new McpServer({ name: 'revolut-x', version: '1.0.0' });

  server.tool('get_balances', 'Get your Revolut X account balances', {}, async () => {
    const data = await revolutRequest('GET', '/accounts');
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

const app = express();
const transports = {};

app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/message', res);
  transports[transport.sessionId] = transport;
  const server = createServer();
  await server.connect(transport);
  res.on('close', () => {
    delete transports[transport.sessionId];
  });
});

app.post('/message', express.raw({ type: '*/*' }), async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(404).send('Session not found');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Revolut Claude MCP server running on port ${PORT}`);
});
