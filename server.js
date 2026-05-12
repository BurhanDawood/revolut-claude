import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { createPrivateKey, sign } from 'crypto';

const API_KEY = process.env.REVOLUTX_API_KEY;
const PRIVATE_KEY = process.env.REVOLUTX_PRIVATE_KEY;
const BASE_URL = 'https://revx.revolut.com/api/1.0';

async function revolutRequest(method, path) {
  const timestamp = Date.now().toString();
  const message = `${timestamp}${method}${path}`;
  const privateKeyPem = PRIVATE_KEY.replace(/\\n/g, '\n');
  const privateKey = createPrivateKey(privateKeyPem);
  const signature = sign(null, Buffer.from(message), privateKey);
  const headers = {
    'X-Revx-Api-Key': API_KEY,
    'X-Revx-Timestamp': timestamp,
    'X-Revx-Signature': signature.toString('base64'),
    'Content-Type': 'application/json'
  };
  console.log('Calling Revolut:', method, path);
  const response = await fetch(`${BASE_URL}${path}`, { method, headers });
  const text = await response.text();
  console.log('Revolut response:', response.status, text);
  return JSON.parse(text);
}

const app = express();

app.use((req, res, next) => {
  console.log('Request:', req.method, req.url);
  next();
});

const sessions = {};

app.get('/sse', async (req, res) => {
  console.log('New SSE connection');
  const server = new McpServer({ name: 'revolut-x', version: '1.0.0' });

  server.tool('get_balances', 'Get Revolut X account balances', {}, async () => {
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

  const transport = new SSEServerTransport('/message', res);
  sessions[transport.sessionId] = transport;
  console.log('Session created:', transport.sessionId);

  res.on('close', () => {
    console.log('Session closed:', transport.sessionId);
    delete sessions[transport.sessionId];
  });

  await server.connect(transport);
});

app.post('/message', express.raw({ type: '*/*' }), async (req, res) => {
  const sessionId = req.query.sessionId;
  console.log('Message for session:', sessionId);
  const transport = sessions[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    console.log('Session not found:', sessionId);
    res.status(404).send('Session not found');
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
