import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startBridge } from '../../bridge/server';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';

const token = 'e2e-bridge-pairing-token-at-least-32-characters';
const password = 'e2e-server-password';
const sid = 'ses_e2e123456';
const session = {
  id: sid,
  slug: 'e2e',
  projectID: 'global',
  directory: '/test/project',
  title: 'Browser integration',
  version: '1',
  time: { created: Date.now(), updated: Date.now() },
};

async function fixtureServer() {
  const streams = new Set<http.ServerResponse>();
  let prompt: any;
  let history: any[] = [];
  const emit = (type: string, properties: any) => {
    for (const stream of streams) stream.write(`data: ${JSON.stringify({ type, properties })}\n\n`);
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    if (
      url.pathname === '/page' ||
      url.pathname === '/route-two' ||
      url.pathname === '/path-match'
    ) {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'",
      });
      res.end(
        '<!doctype html><html><head><title>Test workspace</title><link rel="stylesheet" href="/style.css"></head><body><main><h1>Original title</h1><p>The page content</p><button id="button">Click me</button></main><aside class="promo">Promotion</aside><div id="dynamic"></div></body></html>',
      );
      return;
    }
    if (url.pathname === '/style.css') {
      res
        .writeHead(200, { 'Content-Type': 'text/css' })
        .end('body{background:rgb(240,240,240);color:rgb(20,20,20)}');
      return;
    }
    if (
      req.headers.authorization !==
      `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
    ) {
      res.writeHead(401).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/global/health') {
      res.end(JSON.stringify({ healthy: true, version: 'test-fixture' }));
      return;
    }
    if (url.pathname === '/doc') {
      res.end(
        JSON.stringify({
          openapi: '3.1.0',
          paths: { '/session': {}, '/event': {}, '/mcp': {} },
        }),
      );
      return;
    }
    if (url.pathname === '/event') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      streams.add(res);
      res.write('data: {"type":"server.connected","properties":{}}\n\n');
      req.on('close', () => streams.delete(res));
      return;
    }
    if (url.pathname === '/mcp') {
      res.end(JSON.stringify({ open_extension: { status: 'connected' } }));
      return;
    }
    if (url.pathname === '/permission' || url.pathname === '/question') {
      res.end('[]');
      return;
    }
    if (url.pathname === '/provider') {
      res.end('{"all":[],"connected":[],"default":{}}');
      return;
    }
    if (url.pathname === '/agent') {
      res.end(
        JSON.stringify([
          { name: 'build', mode: 'primary', description: 'Build with all configured tools' },
          { name: 'plan', mode: 'primary', description: 'Plan changes before executing' },
        ]),
      );
      return;
    }
    if (url.pathname === '/session/status') {
      res.end(JSON.stringify({ [sid]: { type: 'idle' } }));
      return;
    }
    if (url.pathname === '/session') {
      res.end(JSON.stringify(req.method === 'POST' ? session : [session]));
      return;
    }
    if (url.pathname === `/session/${sid}`) {
      res.end(JSON.stringify(session));
      return;
    }
    if (url.pathname === `/session/${sid}/message`) {
      res.end(JSON.stringify(history));
      return;
    }
    if (url.pathname === `/session/${sid}/prompt_async`) {
      let body = '';
      for await (const part of req) body += part;
      prompt = JSON.parse(body);
      const info = {
        id: `msg_user${Date.now()}`,
        role: 'user',
        sessionID: sid,
        time: { created: Date.now() },
      };
      const parts = [
        {
          id: `prt_user${Date.now()}`,
          messageID: info.id,
          sessionID: sid,
          type: 'text',
          text: prompt.parts[0].text,
        },
      ];
      history.push({ info, parts });
      emit('message.updated', { info });
      for (const part of parts) emit('message.part.updated', { part });
      res.writeHead(204).end();
      return;
    }
    if (url.pathname.endsWith('/abort')) {
      emit('session.idle', { sessionID: sid });
      res.end('true');
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    emit,
    getPrompt: () => prompt,
    complete: () => emit('session.idle', { sessionID: sid }),
    addMessage: (message: any) => {
      history.push(message);
      emit('message.updated', { info: message.info });
      for (const part of message.parts) emit('message.part.updated', { part });
    },
    close: async () => {
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function rpc(page: Page, method: string, args?: any) {
  const result = await page.evaluate(
    async ({ method, args }) => chrome.runtime.sendMessage({ type: 'rpc', method, args }),
    { method, args },
  );
  if (!result?.ok) throw new Error(result?.error || 'RPC failed');
  return result.data;
}

test('real MV3 worker, strict-CSP page tools, approval, persistence, SPA reinjection and active-tab guard', async ({}, testInfo) => {
  const fixture = await fixtureServer(),
    bridge = await startBridge({ port: 0, token });
  const profile = await mkdtemp(join(tmpdir(), 'open-extension-e2e-'));
  let context: BrowserContext | undefined;
  const agent = new Client({ name: 'opencode-test-agent', version: '1' });
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        '--no-sandbox',
        `--disable-extensions-except=${resolve('dist')}`,
        `--load-extension=${resolve('dist')}`,
      ],
      viewport: { width: 420, height: 900 },
    });
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    const id = worker.url().split('/')[2];
    const browserSettings = await context.newPage();
    await browserSettings.goto(`chrome://extensions/?id=${id}`);
    await browserSettings.evaluate(
      (extensionId) =>
        new Promise<void>((resolve) =>
          (chrome as any).developerPrivate.updateExtensionConfiguration(
            { extensionId, userScriptsAccess: true },
            resolve,
          ),
        ),
      id,
    );
    await browserSettings.close();
    const panel = await context.newPage();
    const errors: string[] = [];
    panel.on('pageerror', (error) => errors.push(error.message));
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);
    await expect(panel.getByRole('heading', { name: 'Open Extension' })).toBeVisible();
    await panel.screenshot({ path: testInfo.outputPath('welcome.png') });
    await rpc(panel, 'settings.save', {
      serverUrl: fixture.url,
      username: 'opencode',
      password,
      rememberPassword: false,
      bridgeUrl: `http://127.0.0.1:${bridge.port}`,
      bridgeToken: token,
    });
    await expect.poll(async () => (await rpc(panel, 'snapshot')).bridge.registered).toBe(true);
    await panel.getByRole('button', { name: 'Choose OpenCode agent' }).click();
    await panel.getByRole('menuitemradio', { name: /plan/ }).click();
    await expect.poll(async () => (await rpc(panel, 'snapshot')).settings.agent).toBe('plan');
    await panel.getByRole('button', { name: 'Choose OpenCode agent' }).click();
    await panel.getByRole('menuitemradio', { name: /build/ }).click();
    const behavior = await worker.evaluate(() => chrome.sidePanel.getPanelBehavior());
    expect(behavior.openPanelOnActionClick).toBe(true);
    await rpc(panel, 'session.attach', { id: sid });
    const target = await context.newPage();
    await target.goto(`${fixture.url}/page`);
    await target.bringToFront();
    await expect.poll(async () => (await rpc(panel, 'tab')).url).toBe(`${fixture.url}/page`);
    await rpc(panel, 'send', {
      id: sid,
      text: 'Remove the promotion and verify the new look.',
    });
    const capability = fixture.getPrompt().system.match(/THIS turn: ([\w-]+)/)[1];
    expect(fixture.getPrompt().agent).toBe('build');
    await agent.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${bridge.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    const call = async (name: string, args: any = {}) => {
      const result = await agent.callTool({
        name,
        arguments: { context: capability, ...args },
      });
      const text = (result.content as any[])[0].text;
      if (result.isError) throw new Error(text);
      return JSON.parse(text);
    };
    expect((await call('browser_observe', { html: true })).title).toBe('Test workspace');
    const code =
      'api.css("body{background:rgb(12,34,56)!important}.promo{display:none!important}"); api.watch(() => api.text("h1", "Custom workspace")); api.on(document.getElementById("button"), "click", () => api.attr("main", "data-clicked", "yes")); return {title:document.querySelector("h1").textContent,background:getComputedStyle(document.body).backgroundColor};';
    const live = await call('browser_execute', { code });
    expect(live.result.background).toBe('rgb(12, 34, 56)');
    expect(live.observation.text).toContain('Custom workspace');
    await expect(target.locator('.promo')).toBeHidden();
    await target.locator('#button').click();
    await expect(target.locator('main')).toHaveAttribute('data-clicked', 'yes');
    await call('site_script_propose', {
      name: 'Focused workspace',
      description: 'Hide promotions and use a calm dark theme.',
      matches: ['*://127.0.0.1/*'],
      code,
    });
    expect((await rpc(panel, 'snapshot')).scripts).toHaveLength(0);
    await expect(panel.getByText('Update site script?', { exact: true })).toBeVisible();
    // A genuine click is the approval boundary. Keep the target tab selected while clicking the separately rendered panel.
    await panel.getByRole('button', { name: 'Save site script', exact: true }).click();
    await expect.poll(async () => (await rpc(panel, 'snapshot')).scripts.length).toBe(1);
    let saved = (await rpc(panel, 'snapshot')).scripts[0];
    await expect(target.locator('h1')).toHaveText('Custom workspace');
    await rpc(panel, 'scripts.toggle', { id: saved.id, enabled: false });
    await expect(target.locator('h1')).toHaveText('Original title');
    await expect(target.locator('.promo')).toBeVisible();
    expect(await target.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
      'rgb(240, 240, 240)',
    );
    await target.locator('#button').click();
    await expect(target.locator('main')).not.toHaveAttribute('data-clicked', 'yes');
    await rpc(panel, 'scripts.toggle', { id: saved.id, enabled: true });
    await target.reload();
    await expect(target.locator('h1')).toHaveText('Custom workspace');
    await expect(target.locator('.promo')).toBeHidden();
    await target.evaluate(() => {
      history.pushState({}, '', '/route-two');
      document.querySelector('h1')!.textContent = 'SPA title';
    });
    await expect(target.locator('h1')).toHaveText('Custom workspace');
    await target.evaluate(() => {
      const h1 = document.createElement('h1');
      h1.textContent = 'Dynamic title';
      document.querySelector('h1')!.replaceWith(h1);
    });
    await expect(target.locator('h1')).toHaveText('Custom workspace');
    // A different foreground tab cannot reuse this turn's capability.
    const other = await context.newPage();
    await other.goto(`${fixture.url}/page`);
    await other.bringToFront();
    await expect(
      call('browser_execute', { code: 'document.body.dataset.wrong="yes"' }),
    ).rejects.toThrow(/not authorized|changed/);
    expect(await other.evaluate(() => document.body.dataset.wrong)).toBeUndefined();
    fixture.complete();
    const message = {
      info: {
        id: 'msg_assistant1',
        role: 'assistant',
        sessionID: sid,
        modelID: 'test-model',
        time: { created: Date.now() },
      },
      parts: [
        {
          id: 'prt_step',
          type: 'step-start',
          sessionID: sid,
          messageID: 'msg_assistant1',
        },
        {
          id: 'prt_reason',
          type: 'reasoning',
          text: 'Backend-provided reasoning from the integration fixture.',
          sessionID: sid,
          messageID: 'msg_assistant1',
          time: { start: 1, end: 2 },
        },
        {
          id: 'prt_text',
          type: 'text',
          text: 'Verified the new page title and computed background color.',
          sessionID: sid,
          messageID: 'msg_assistant1',
        },
      ],
    };
    fixture.addMessage(message);
    await expect(
      panel.getByText('Backend-provided reasoning from the integration fixture.'),
    ).toBeVisible();
    await expect(panel.getByText('Unit 1', { exact: true })).toBeVisible();
    await panel.screenshot({ path: testInfo.outputPath('conversation.png') });
    // Reconstruct the extension context from on-disk browser storage, including registrations.
    await agent.close();
    await context.close();
    context = undefined;
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        '--no-sandbox',
        `--disable-extensions-except=${resolve('dist')}`,
        `--load-extension=${resolve('dist')}`,
      ],
    });
    const persisted = await context.newPage();
    await persisted.goto(`${fixture.url}/page`);
    await expect(persisted.locator('.promo')).toBeHidden();
    const reopened = await context.newPage();
    await reopened.goto(`chrome-extension://${id}/sidepanel.html`);
    const snapshot = await rpc(reopened, 'snapshot');
    expect(snapshot.scripts[0].name).toBe('Focused workspace');
    expect(snapshot.settings.password).toBe('');
    await rpc(reopened, 'scripts.delete', { id: saved.id });
    await expect(persisted.locator('.promo')).toBeVisible();
    expect((await rpc(reopened, 'snapshot')).scripts).toHaveLength(0);
    expect(errors).toEqual([]);
  } finally {
    await agent.close().catch(() => {});
    await context?.close();
    await bridge.close();
    await fixture.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('optional live OpenCode contract: authentication, live spec, sessions, SSE and MCP registration', async () => {
  test.skip(
    !process.env.OPENCODE_TEST_URL,
    'Set OPENCODE_TEST_URL and OPENCODE_TEST_PASSWORD to run against an existing test server.',
  );
  const url = process.env.OPENCODE_TEST_URL!,
    serverPassword = process.env.OPENCODE_TEST_PASSWORD!;
  const headers = {
    Authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString('base64')}`,
  };
  const api = createOpencodeClient({
    baseUrl: url,
    headers,
    throwOnError: true,
  });
  const bridge = await startBridge({ port: 0, token });
  let id: string | undefined;
  try {
    expect((await api.global.health()).data?.healthy).toBe(true);
    const spec = await (await fetch(`${url}/doc`, { headers })).json();
    expect(spec.paths['/session/{sessionID}/prompt_async']).toBeDefined();
    expect(spec.paths['/event']).toBeDefined();
    const session = (await api.session.create({ title: 'Open Extension contract test' })).data!;
    id = session.id;
    expect((await api.session.get({ sessionID: id })).data?.id).toBe(id);
    expect((await api.session.messages({ sessionID: id })).data).toEqual([]);
    const controller = new AbortController();
    const response = await fetch(`${url}/event`, {
      headers,
      signal: controller.signal,
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('server.connected');
    controller.abort();
    const result = await api.mcp.add({
      name: 'open_extension_contract_test',
      config: {
        type: 'remote',
        url: `http://127.0.0.1:${bridge.port}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
        enabled: true,
        oauth: false,
      },
    });
    expect((result.data as any).open_extension_contract_test.status).toBe('connected');
    await api.mcp.disconnect({ name: 'open_extension_contract_test' });
  } finally {
    if (id) await api.session.delete({ sessionID: id });
    await bridge.close();
  }
});
