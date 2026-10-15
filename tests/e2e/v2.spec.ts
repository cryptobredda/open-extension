import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OpenCode as NativeOpenCode } from '@opencode/client';
import { startBridge } from '../../bridge/server';

const bridgeToken = 'native-v2-test-bridge-token-at-least-32-chars';
const servicePassword = 'native-v2-test-server-password';
const sid = 'ses_v2test12345';
const location = { directory: '/test/project' };
async function nativeFixture() {
  const streams = new Set<http.ServerResponse>(),
    requests: string[] = [];
  let prompt: any,
    instructions = '',
    paired = false;
  const history: any[] = [];
  const model = {
    id: 'fixture-model',
    providerID: 'fixture',
    name: 'Fixture model',
    enabled: true,
    capabilities: { tools: true },
  };
  const session = {
    id: sid,
    projectID: 'test',
    title: 'Native v2 conversation',
    location,
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), updated: Date.now() },
  };
  const emit = (type: string, data: any) => {
    for (const stream of streams)
      stream.write(
        `data: ${JSON.stringify({ id: `evt_${Date.now()}`, type, created: Date.now(), data })}\n\n`,
      );
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    requests.push(`${req.method} ${url.pathname}`);
    const json = (data: unknown, status = 200) =>
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    if (url.pathname === '/page') {
      res
        .writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Security-Policy': "default-src 'self'; style-src 'none'; script-src 'none'",
        })
        .end(
          '<!doctype html><title>Native test page</title><main><h1>Original</h1><p>Content</p></main><aside class="promo">Promotion</aside>',
        );
      return;
    }
    if (url.pathname === '/auth/connect/fresh-native-test-code') {
      if (paired || req.headers.accept !== 'application/json') {
        json({}, 401);
        return;
      }
      paired = true;
      json({ token: servicePassword });
      return;
    }
    if (
      req.headers.authorization !==
      `Basic ${Buffer.from(`opencode:${servicePassword}`).toString('base64')}`
    ) {
      json({}, 401);
      return;
    }
    if (url.pathname === '/api/info') {
      json({ version: '2.0.29', pid: 123, urls: [url.origin], paths: { tmp: '/tmp' } });
      return;
    }
    if (url.pathname === '/openapi.json') {
      json({ openapi: '3.1.0', paths: { '/api/info': {}, '/api/session': {}, '/api/event': {} } });
      return;
    }
    if (url.pathname === '/api/event') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      streams.add(res);
      res.write('data: {"id":"evt_connected","type":"server.connected","data":{}}\n\n');
      req.on('close', () => streams.delete(res));
      return;
    }
    if (url.pathname === '/api/agent') {
      json({
        location,
        data: [
          {
            id: 'build',
            name: 'Build',
            mode: 'primary',
            hidden: false,
            permissions: [],
            request: {},
          },
        ],
      });
      return;
    }
    if (url.pathname === '/api/provider') {
      json({ location, data: [] });
      return;
    }
    if (url.pathname === '/api/model') {
      json({ location, data: [model] });
      return;
    }
    if (url.pathname === '/api/model/default') {
      json({ location, data: model });
      return;
    }
    if (
      url.pathname === '/api/model' ||
      url.pathname === '/api/form' ||
      url.pathname === '/api/permission/request'
    ) {
      json({ location, data: [] });
      return;
    }
    if (url.pathname === '/api/experimental/mcp/open_extension') {
      let body = '';
      for await (const part of req) body += part;
      const parsed = JSON.parse(body);
      if (
        parsed.config.disabled !== false ||
        parsed.config.codemode !== false ||
        typeof parsed.config.timeout?.execution !== 'number' ||
        'enabled' in parsed.config
      ) {
        json({ error: 'Wrong MCP config generation' }, 400);
        return;
      }
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === '/api/mcp') {
      json({ location, data: [{ name: 'open_extension', status: { status: 'connected' } }] });
      return;
    }
    if (url.pathname === '/api/session') {
      json(req.method === 'POST' ? { data: session } : { data: [session], cursor: {} });
      return;
    }
    if (url.pathname === '/api/session/active') {
      json({ data: {} });
      return;
    }
    if (url.pathname === `/api/session/${sid}`) {
      if (req.method === 'PATCH') {
        res.writeHead(204).end();
        return;
      }
      json({ data: session });
      return;
    }
    if (url.pathname === `/api/session/${sid}/message`) {
      json({ data: history, cursor: {} });
      return;
    }
    if (url.pathname === `/api/session/${sid}/agent`) {
      res.writeHead(204).end();
      return;
    }
    if (
      url.pathname ===
      `/api/experimental/session/${sid}/instructions/entries/open-extension.browser`
    ) {
      let body = '';
      for await (const part of req) body += part;
      instructions = JSON.parse(body).value;
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === `/api/session/${sid}/prompt`) {
      let body = '';
      for await (const part of req) body += part;
      prompt = JSON.parse(body);
      if ('system' in prompt || 'parts' in prompt) {
        json({ error: 'Legacy prompt body' }, 400);
        return;
      }
      history.push({
        id: 'msg_nativeUser',
        type: 'user',
        text: prompt.text,
        time: { created: Date.now() },
      });
      emit('session.inbox.enqueued', {
        sessionID: sid,
        inboxID: 'msg_nativeUser',
        item: { type: 'user', payload: { text: prompt.text }, delivery: 'queue' },
      });
      json({
        data: {
          id: 'msg_nativeUser',
          sessionID: sid,
          type: 'user',
          time: { created: Date.now() },
          payload: { text: prompt.text },
          delivery: 'queue',
        },
      });
      return;
    }
    json({}, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  return {
    url,
    requests,
    instructions: () => instructions,
    prompt: () => prompt,
    complete: () => {
      const id = 'msg_nativeAssistant',
        created = Date.now();
      history.push({
        id,
        type: 'assistant',
        agent: 'build',
        model: { id: 'test', providerID: 'local' },
        time: { created, completed: created + 5 },
        finish: 'stop',
        content: [
          {
            type: 'reasoning',
            text: 'Backend native v2 reasoning.',
            time: { created, completed: created + 1 },
          },
          { type: 'text', text: 'Verified the current page changes.' },
        ],
      });
      emit('session.step.started', {
        sessionID: sid,
        assistantMessageID: id,
        agent: 'build',
        model: { id: 'test', providerID: 'local' },
        started: created,
      });
      emit('session.reasoning.started', { sessionID: sid, assistantMessageID: id, ordinal: 0 });
      emit('session.reasoning.delta', {
        sessionID: sid,
        assistantMessageID: id,
        ordinal: 0,
        delta: 'Backend native v2 reasoning.',
      });
      emit('session.reasoning.ended', {
        sessionID: sid,
        assistantMessageID: id,
        ordinal: 0,
        text: 'Backend native v2 reasoning.',
      });
      emit('session.text.started', { sessionID: sid, assistantMessageID: id, ordinal: 1 });
      emit('session.text.delta', {
        sessionID: sid,
        assistantMessageID: id,
        ordinal: 1,
        delta: 'Verified the current page changes.',
      });
      emit('session.text.ended', {
        sessionID: sid,
        assistantMessageID: id,
        ordinal: 1,
        text: 'Verified the current page changes.',
      });
      emit('session.step.ended', {
        sessionID: sid,
        assistantMessageID: id,
        finish: 'stop',
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      });
      emit('session.idle', { sessionID: sid });
    },
    close: async () => {
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function launch(profile: string) {
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--no-sandbox',
      `--disable-extensions-except=${resolve('dist')}`,
      `--load-extension=${resolve('dist')}`,
    ],
    viewport: { width: 430, height: 950 },
  });
  const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const id = worker.url().split('/')[2],
    details = await context.newPage();
  await details.goto(`chrome://extensions/?id=${id}`);
  await details.evaluate(
    (extensionId) =>
      new Promise<void>((resolve) =>
        (chrome as any).developerPrivate.updateExtensionConfiguration(
          { extensionId, userScriptsAccess: true },
          resolve,
        ),
      ),
    id,
  );
  await details.close();
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.getByRole('button', { name: 'Connection settings' }).click();
  return { context, panel };
}
async function rpc(page: Page, method: string, args?: unknown) {
  const result = await page.evaluate(
    ({ method, args }) => chrome.runtime.sendMessage({ type: 'rpc', method, args }),
    { method, args },
  );
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

test('OpenCode 2 pairing UI, native prompt/instructions/events and real browser MCP workflow', async ({}, testInfo) => {
  const fixture = await nativeFixture(),
    bridge = await startBridge({ port: 0, token: bridgeToken }),
    profile = await mkdtemp(join(tmpdir(), 'open-extension-native-'));
  let context: BrowserContext | undefined;
  const agent = new Client({ name: 'native-opencode-agent-fixture', version: '2' });
  try {
    const launched = await launch(profile);
    context = launched.context;
    const panel = launched.panel;
    await panel
      .getByLabel('OpenCode pairing link', { exact: true })
      .fill(`${fixture.url}/auth/connect/fresh-native-test-code`);
    await panel.getByLabel('Bridge URL', { exact: true }).fill(`http://127.0.0.1:${bridge.port}`);
    await panel.getByLabel('Browser bridge token', { exact: true }).fill(bridgeToken);
    await panel.getByRole('button', { name: 'Pair & connect', exact: true }).click();
    await expect
      .poll(async () => (await rpc(panel, 'snapshot')).connection.state)
      .toBe('connected');
    await expect.poll(async () => (await rpc(panel, 'snapshot')).bridge.registered).toBe(true);
    expect((await rpc(panel, 'snapshot')).connection.protocol).toBe('v2');
    await panel.screenshot({ path: testInfo.outputPath('v2-connected.png') });
    await panel.getByRole('button', { name: 'Close settings' }).click();
    await rpc(panel, 'session.attach', { id: sid });
    const target = await context.newPage();
    await target.goto(`${fixture.url}/page`);
    await target.bringToFront();
    await rpc(panel, 'send', { id: sid, text: 'Hide the promotion and verify the change.' });
    expect(fixture.prompt()).toEqual({ text: 'Hide the promotion and verify the change.' });
    const contextToken = fixture.instructions().match(/THIS turn: ([\w-]+)/)![1];
    await agent.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${bridge.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${bridgeToken}` } },
      }),
    );
    const call = async (name: string, args: any = {}) => {
      const result = await agent.callTool({ name, arguments: { context: contextToken, ...args } });
      const text = (result.content as any[])[0].text;
      if (result.isError) throw new Error(text);
      return JSON.parse(text);
    };
    expect((await call('browser_observe')).title).toBe('Native test page');
    await call('browser_css', { css: '.promo{display:none!important}' });
    await expect(target.locator('.promo')).toBeHidden();
    await call('site_script_propose', {
      name: 'Native focus',
      description: 'Hide the promotional sidebar.',
      matches: ['*://127.0.0.1/*'],
      code: 'api.hide(".promo");',
    });
    await panel.getByRole('button', { name: 'Save site script', exact: true }).click();
    await expect.poll(async () => (await rpc(panel, 'snapshot')).scripts.length).toBe(1);
    fixture.complete();
    await expect(panel.getByText('Backend native v2 reasoning.', { exact: true })).toBeVisible();
    await expect(panel.getByText('Unit 1', { exact: true })).toBeVisible();
    const script = (await rpc(panel, 'snapshot')).scripts[0];
    await rpc(panel, 'scripts.toggle', { id: script.id, enabled: false });
    await expect(target.locator('.promo')).toBeVisible();
    expect(
      fixture.requests.some(
        (path) => /\/(global\/health|doc|session\/)/.test(path) && !path.includes('/api/'),
      ),
    ).toBe(false);
    await panel.screenshot({ path: testInfo.outputPath('v2-conversation.png') });
    await expect(
      rpc(panel, 'pair.connect', {
        settings: (await rpc(panel, 'snapshot')).settings,
        link: `${fixture.url}/auth/connect/fresh-native-test-code`,
      }),
    ).rejects.toThrow('expired, already used');
    expect((await rpc(panel, 'snapshot')).connection.state).toBe('connected');
  } finally {
    await agent.close().catch(() => {});
    await context?.close();
    await fixture.close();
    await bridge.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('actual OpenCode 2.0.29: pair through the extension, attach sessions, register MCP, manage native instructions and forms', async ({}, testInfo) => {
  test.skip(
    !process.env.OPENCODE2_TEST_URL,
    'Set OPENCODE2_TEST_URL and OPENCODE2_TEST_PASSWORD for a native v2 test server.',
  );
  const url = process.env.OPENCODE2_TEST_URL!,
    password = process.env.OPENCODE2_TEST_PASSWORD!;
  const api = NativeOpenCode.make({
    baseUrl: url,
    headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
  });
  const bridge = await startBridge({ port: 0, token: bridgeToken }),
    profile = await mkdtemp(join(tmpdir(), 'open-extension-real-v2-'));
  let context: BrowserContext | undefined, id: string | undefined;
  try {
    const pair = await api.server.pair(),
      launched = await launch(profile);
    context = launched.context;
    const panel = launched.panel;
    await panel
      .getByLabel('OpenCode pairing link', { exact: true })
      .fill(`${url}/auth/connect/${pair.code}`);
    await panel.getByLabel('Bridge URL', { exact: true }).fill(`http://127.0.0.1:${bridge.port}`);
    await panel.getByLabel('Browser bridge token', { exact: true }).fill(bridgeToken);
    await panel.getByRole('button', { name: 'Pair & connect', exact: true }).click();
    await expect
      .poll(async () => (await rpc(panel, 'snapshot')).connection.state)
      .toBe('connected');
    await expect.poll(async () => (await rpc(panel, 'snapshot')).bridge.registered).toBe(true);
    const snapshot = await rpc(panel, 'snapshot');
    expect(snapshot.connection.version).toBe('2.0.29');
    expect(snapshot.connection.spec).toContain('/openapi.json');
    expect(snapshot.settings.password.length).toBeGreaterThan(0);
    await panel.getByRole('button', { name: 'Close settings' }).click();
    const session = await rpc(panel, 'session.create');
    id = session.id;
    expect((await api.session.get({ sessionID: id! })).id).toBe(id);
    await api.session.instructions.entry.put({
      sessionID: id!,
      key: 'open-extension-test',
      value: 'Inspect this session using the native v2 API.',
    });
    expect(
      (await api.session.instructions.entry.list({ sessionID: id! })).some(
        (entry) => entry.key === 'open-extension-test',
      ),
    ).toBe(true);
    expect(await rpc(panel, 'messages', { id })).toEqual([]);
    expect(
      (await api.mcp.list({ location: { directory: session.directory } })).data.find(
        (server) => server.name === 'open_extension',
      )?.status.status,
    ).toBe('connected');
    const form = await api.session.form.create({
      sessionID: id!,
      title: 'Native v2 test question',
      fields: [
        { key: 'confirm', type: 'string', title: 'Confirm the v2 integration', required: true },
        {
          key: 'optionalChoice',
          type: 'boolean',
          title: 'Use the optional choice',
          required: true,
        },
      ],
    });
    await expect(panel.getByText('Native v2 test question', { exact: true })).toBeVisible();
    await panel.getByLabel('Confirm the v2 integration', { exact: true }).fill('Confirmed');
    await panel.getByRole('button', { name: 'Send answers', exact: true }).click();
    await expect
      .poll(
        async () => (await api.session.form.get({ sessionID: id!, formID: form.id })).state.status,
      )
      .toBe('answered');
    await panel.screenshot({ path: testInfo.outputPath('actual-opencode-2.0.29.png') });
  } finally {
    if (id) await api.session.remove({ sessionID: id }).catch(() => {});
    await api.mcp.remove({ server: 'open_extension' }).catch(() => {});
    await context?.close();
    await bridge.close();
    await rm(profile, { recursive: true, force: true });
  }
});
