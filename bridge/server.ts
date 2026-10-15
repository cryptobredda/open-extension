import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { definitions } from './tools';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';

export async function startBridge({ port = 49375, token }: { port?: number; token: string }) {
  if (token.length < 32) throw new Error('Bridge token must contain at least 32 characters.');
  let browser: WebSocket | undefined;
  const pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  const connections = new Set<WebSocket>();
  const equal = (value: string) => {
    const a = Buffer.from(value),
      b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const rejectPending = () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('The browser disconnected. Reopen Open Extension.'));
    }
    pending.clear();
  };
  const relay = (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<any> => {
    if (!browser || browser.readyState !== WebSocket.OPEN)
      return Promise.reject(
        new Error('Open Extension is not connected. Open the side panel and pair the bridge.'),
      );
    if (pending.size >= 8) return Promise.reject(new Error('Too many pending browser operations.'));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const cleanup = () => signal.removeEventListener('abort', abort);
      const abort = () => {
        const item = pending.get(id);
        if (item) {
          clearTimeout(item.timer);
          pending.delete(id);
          cleanup();
          reject(new Error('Tool request cancelled.'));
        }
      };
      const timer = setTimeout(() => {
        pending.delete(id);
        cleanup();
        reject(
          new Error(
            'Browser tool timed out after 45 seconds. Code may still be running; observe before retrying.',
          ),
        );
      }, 45_000);
      pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        timer,
      });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      browser!.send(JSON.stringify({ type: 'tool', id, name, args }));
    });
  };
  const server = http.createServer(async (req, res) => {
    const host = req.headers.host || '';
    if (!/^127\.0\.0\.1:\d+$/.test(host) && !/^localhost:\d+$/.test(host)) {
      res.writeHead(403).end();
      return;
    }
    const origin = req.headers.origin;
    if (origin && !/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
      res.writeHead(403).end();
      return;
    }
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname === '/health' && req.method === 'GET') {
      res
        .writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        })
        .end(
          JSON.stringify({
            name: 'open-extension-bridge',
            version: '1.2.0',
            connected: Boolean(browser),
          }),
        );
      return;
    }
    if (pathname !== '/mcp') {
      res.writeHead(404).end();
      return;
    }
    if (!equal((req.headers.authorization || '').replace(/^Bearer /, ''))) {
      res.writeHead(401).end();
      return;
    }
    // One stateless transport per request: no shared initialization state or leaked MCP sessions.
    const mcp = new McpServer({ name: 'open-extension', version: '1.2.0' });
    for (const definition of definitions) {
      mcp.registerTool(
        definition.name,
        { description: definition.description, inputSchema: definition.schema },
        async (
          args: Record<string, unknown>,
          extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
        ) => {
          try {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify(await relay(definition.name, args, extra.signal)),
                },
              ],
            };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: error instanceof Error ? error.message : 'Browser operation failed.',
                },
              ],
            };
          }
        },
      );
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2_000_000,
    perMessageDeflate: false,
  });
  server.on('upgrade', (req, socket, head) => {
    if (
      req.url !== '/extension' ||
      !/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '') ||
      !/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin || '')
    ) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (socket) => {
    connections.add(socket);
    let authenticated = false;
    const timeout = setTimeout(() => socket.close(4001, 'Pairing timed out'), 5000);
    socket.on('message', (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch {
        socket.close(4002, 'Invalid message');
        return;
      }
      if (!authenticated) {
        if (message.type !== 'auth' || !equal(String(message.token || ''))) {
          socket.close(4003, 'Pairing token rejected');
          return;
        }
        if (browser && browser !== socket) {
          socket.close(4009, 'Another browser is already paired');
          return;
        }
        authenticated = true;
        clearTimeout(timeout);
        browser = socket;
        socket.send(JSON.stringify({ type: 'ready' }));
        return;
      }
      if (message.type === 'ping') {
        socket.send(JSON.stringify({ type: 'pong' }));
        return;
      }
      if (message.type === 'result' && typeof message.id === 'string') {
        const item = pending.get(message.id);
        if (!item) return;
        clearTimeout(item.timer);
        pending.delete(message.id);
        if (message.ok === true) item.resolve(message.data);
        else item.reject(new Error(String(message.error || 'Browser operation failed.')));
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timeout);
      connections.delete(socket);
      if (browser === socket) {
        browser = undefined;
        rejectPending();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    port: (server.address() as import('node:net').AddressInfo).port,
    close: async () => {
      rejectPending();
      for (const socket of connections) socket.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
