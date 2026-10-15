import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';
import { startBridge } from '../../bridge/server';

describe('real MCP bridge transport', () => {
  it('authenticates, exposes tools, relays to a paired extension and rejects hostile web origins', async () => {
    const token = 'integration-test-token-at-least-32-chars';
    const bridge = await startBridge({ port: 0, token });
    const url = `http://127.0.0.1:${bridge.port}`;
    const client = new Client({ name: 'test-opencode', version: '1' });
    let socket: WebSocket | undefined;
    try {
      expect((await fetch(`${url}/mcp`, { method: 'POST' })).status).toBe(401);
      expect(
        (
          await fetch(`${url}/health`, {
            headers: { Origin: 'https://evil.example' },
          })
        ).status,
      ).toBe(403);
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${url}/mcp?codemode=false`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
        'site_script_propose',
      );
      socket = new WebSocket(url.replace('http:', 'ws:') + '/extension', {
        origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      });
      await new Promise<void>((resolve, reject) => {
        socket!.once('open', () => socket!.send(JSON.stringify({ type: 'auth', token })));
        socket!.on('error', reject);
        socket!.on('message', (data) => {
          const message = JSON.parse(data.toString());
          if (message.type === 'ready') resolve();
          if (message.type === 'tool')
            socket!.send(
              JSON.stringify({
                type: 'result',
                id: message.id,
                ok: true,
                data: { title: 'Real page', context: message.args.context },
              }),
            );
        });
      });
      const result = await client.callTool({
        name: 'browser_observe',
        arguments: { context: 'current-turn' },
      });
      expect(JSON.parse((result.content as any)[0].text)).toEqual({
        title: 'Real page',
        context: 'current-turn',
      });
    } finally {
      socket?.terminate();
      await client.close();
      await bridge.close();
    }
  });
});
