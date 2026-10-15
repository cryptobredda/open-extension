import { afterEach, describe, expect, it, vi } from 'vitest';
import { BROWSER_TOOLS } from '../../src/shared/browser-context';
import { OpenCode, redeemPairing } from '../../src/background/opencode';
import { DEFAULT_SETTINGS } from '../../src/shared/types';
import { pairingLink, localUrl } from '../../src/shared/validation';
import { structuredError, v2Message } from '../../src/shared/opencode-v2';
import { reduceConversation } from '../../src/shared/conversation';

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());
describe('real OpenCode 2 protocol selection', () => {
  it('uses /api/info and /openapi.json without touching the legacy health route', async () => {
    const fetch = vi.fn(async (request: Request) => {
      if (new URL(request.url).pathname === '/api/info')
        return json({
          version: '2.0.29',
          pid: 123,
          urls: ['http://127.0.0.1:49374'],
          paths: { tmp: '/tmp' },
        });
      if (new URL(request.url).pathname === '/openapi.json')
        return json({
          openapi: '3.1.0',
          paths: { '/api/info': {}, '/api/session': {}, '/api/event': {} },
        });
      throw new Error('Unexpected legacy endpoint');
    });
    vi.stubGlobal('fetch', fetch);
    const backend = new OpenCode(DEFAULT_SETTINGS);
    expect(await backend.inspect()).toMatchObject({ protocol: 'v2', version: '2.0.29' });
    expect(fetch.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([
      '/api/info',
      '/openapi.json',
    ]);
  });
  it('falls back to the legacy API only when the native identity API is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        const path = new URL(request.url).pathname;
        return path === '/api/info'
          ? new Response('<html>Legacy web UI</html>', { headers: { 'Content-Type': 'text/html' } })
          : path === '/global/health'
            ? json({ healthy: true, version: '1.19.0' })
            : json({ openapi: '3.1.0', paths: { '/session': {}, '/event': {}, '/mcp': {} } });
      }),
    );
    expect(await new OpenCode(DEFAULT_SETTINGS).inspect()).toMatchObject({
      protocol: 'v1',
      version: '1.19.0',
    });
  });
  it('exchanges a pairing link as JSON, without cookies or stored Basic Auth, and uses the returned credential', async () => {
    const fetch = vi.fn(async () => json({ token: 'native-session-credential' }));
    vi.stubGlobal('fetch', fetch);
    const settings = await redeemPairing(
      { ...DEFAULT_SETTINGS, password: 'previous-password' },
      'http://192.168.1.78:49374/auth/connect/fresh-pair-code',
    );
    expect(settings.serverUrl).toBe('http://192.168.1.78:49374');
    expect(settings.password).toBe('native-session-credential');
    const [, options] = fetch.mock.calls[0] as any;
    expect(options.headers).toEqual({ Accept: 'application/json' });
    expect(options.credentials).toBe('omit');
    expect(options.redirect).toBe('error');
  });
  it('gives an actionable error for consumed links and does not overwrite a good connection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'not found' }, 401)),
    );
    await expect(
      redeemPairing(DEFAULT_SETTINGS, 'http://127.0.0.1:49374/auth/connect/expired-pair-code'),
    ).rejects.toThrow('expired, already used');
    expect(DEFAULT_SETTINGS.password).toBe('');
  });
  it('accepts private LAN pairing addresses and rejects public or credential-bearing links', () => {
    expect(localUrl('http://192.168.1.78:49374')).toBe('http://192.168.1.78:49374');
    expect(localUrl('http://10.0.1.2:49374')).toBe('http://10.0.1.2:49374');
    expect(pairingLink('http://localhost:49374/auth/connect/fresh-pair-code').code).toBe(
      'fresh-pair-code',
    );
    expect(() => pairingLink('https://example.com/auth/connect/fresh-pair-code')).toThrow();
    expect(() =>
      pairingLink('http://opencode:secret@localhost:49374/auth/connect/fresh-pair-code'),
    ).toThrow();
  });
  it('uses native session pagination and instruction entries rather than v1 prompt fields', async () => {
    const requests: { path: string; body?: any }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        const url = new URL(request.url),
          path = url.pathname;
        const body = request.method === 'GET' ? undefined : await request.json();
        requests.push({ path: url.pathname + url.search, body });
        if (path === '/api/agent')
          return json({
            data: [{ id: 'agent-build', name: 'Build', mode: 'primary' }],
            location: { directory: '/test' },
          });
        const model = {
          id: 'native-model',
          providerID: 'native',
          name: 'Native model',
          enabled: true,
          capabilities: { tools: true },
        };
        if (path === '/api/model') return json({ data: [model] });
        if (path === '/api/model/default') return json({ data: model });
        if (path === '/api/provider')
          return json({ data: [{ id: 'native', name: 'Native provider' }] });
        if (path === '/api/session/ses_test' && request.method === 'GET')
          return json({ data: { id: 'ses_test', model } });
        if (path.endsWith('/message'))
          return json({
            data: [
              {
                id: url.searchParams.has('cursor') ? 'msg_second' : 'msg_first',
                time: { created: url.searchParams.has('cursor') ? 2 : 1 },
                type: 'user',
                text: 'Backend history',
              },
            ],
            cursor: { next: url.searchParams.has('cursor') ? null : 'next-page' },
          });
        if (path.endsWith('/prompt')) return json({ data: { id: 'msg_prompt' } });
        return new Response(null, { status: 204 });
      }),
    );
    const backend = new OpenCode(DEFAULT_SETTINGS, 'v2');
    const messages = (await backend.client.session.messages({ sessionID: 'ses_test' })).data!;
    expect(messages.map((message) => message.info.id)).toEqual(['msg_first', 'msg_second']);
    await backend.client.session.promptAsync({
      sessionID: 'ses_test',
      system: 'Browser instructions',
      agent: 'build',
      parts: [{ type: 'text', text: 'Change this page' }],
    });
    expect(requests).toContainEqual({
      path: '/api/session/ses_test',
      body: {
        permissions: [
          { action: '*', resource: '*', effect: 'deny' },
          { action: 'execute', resource: '*', effect: 'allow' },
          ...BROWSER_TOOLS.map((name) => ({
            action: `open-extension.dom.${name}`,
            resource: '*',
            effect: 'allow',
          })),
        ],
      },
    });
    expect(requests).toContainEqual({
      path: '/api/session/ses_test/agent',
      body: { agent: 'agent-build' },
    });
    expect(requests).toContainEqual({
      path: '/api/experimental/session/ses_test/instructions/entries/open-extension.browser',
      body: { value: 'Browser instructions' },
    });
    expect(requests.at(-1)).toEqual({
      path: '/api/session/ses_test/prompt',
      body: { text: 'Change this page' },
    });
  });
});

describe('native conversation records and events', () => {
  it('renders native reasoning, tool output, and real step completion from history', () => {
    const result = v2Message('ses_test', {
      id: 'msg_assistant',
      type: 'assistant',
      agent: 'build',
      model: { id: 'test', providerID: 'local' },
      time: { created: 1, completed: 8 },
      finish: 'stop',
      content: [
        { type: 'reasoning', text: 'Observed the DOM', time: { created: 2, completed: 3 } },
        {
          type: 'tool',
          id: 'call1',
          name: 'open_extension_browser_observe',
          time: { created: 4, ran: 5, completed: 6 },
          state: {
            status: 'completed',
            input: {},
            content: [{ type: 'text', text: '{"verified":true}' }],
          },
        },
        { type: 'text', text: 'Changes verified.' },
      ],
    });
    expect(result.parts.map((part) => part.type)).toEqual([
      'step-start',
      'reasoning',
      'tool',
      'text',
      'step-finish',
    ]);
    expect((result.parts[2] as any).state.output).toBe('{"verified":true}');
  });
  it('streams native ordinal-based text and tool state without v1 part IDs', () => {
    let messages: any[] = [];
    const apply = (type: string, p: any) =>
      (messages = reduceConversation(messages, {
        protocol: 'v2',
        type,
        created: 10,
        properties: { sessionID: 'ses_test', assistantMessageID: 'msg_assistant', ...p },
      }));
    apply('session.step.started', {
      agent: 'build',
      model: { id: 'test', providerID: 'local' },
      started: 1,
    });
    apply('session.reasoning.started', { ordinal: 0 });
    apply('session.reasoning.delta', { ordinal: 0, delta: 'First ' });
    apply('session.reasoning.delta', { ordinal: 0, delta: 'observe' });
    apply('session.reasoning.ended', { ordinal: 0, text: 'First observe' });
    apply('session.tool.input.started', { id: 'call1', name: 'open_extension_browser_css' });
    apply('session.tool.called', { id: 'call1', input: { css: 'body{color:red}' } });
    apply('session.tool.success', {
      id: 'call1',
      content: [{ type: 'text', text: 'Observed red text' }],
    });
    apply('session.text.started', { ordinal: 2 });
    apply('session.text.delta', { ordinal: 2, delta: 'Verified' });
    apply('session.text.ended', { ordinal: 2, text: 'Verified' });
    apply('session.step.ended', { finish: 'stop' });
    expect(messages).toHaveLength(1);
    expect(messages[0].parts.map((part: any) => part.type)).toEqual([
      'step-start',
      'reasoning',
      'tool',
      'text',
      'step-finish',
    ]);
    expect(messages[0].parts[1].text).toBe('First observe');
    expect(messages[0].parts[2].state.status).toBe('completed');
    expect(messages[0].parts[3].text).toBe('Verified');
  });
});

it('preserves provider free-tier rejection and distinguishes it from browser transport errors', () => {
  const error = structuredError({
    type: 'provider.auth',
    message:
      "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
  });
  expect(error).toContain("OpenCode's free tier");
  expect(error).toContain('Choose another connected model');
  expect(error).toContain('reconnecting browser tools will not resolve');
});
