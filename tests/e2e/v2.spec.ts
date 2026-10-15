import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import nativePlugin from '../../src/native/plugin';

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
  let rpcHandlers: Record<string, (input: any) => Promise<any>> = {};
  const nativeTools: any[] = [];
  const nativeStorage = new Map<string, any>();
  const cleanup = await nativePlugin.setup({
    location,
    session: { get: async () => session, update: async () => {} },
    storage: {
      get: async (key: string) => nativeStorage.get(key),
      set: async (key: string, value: any) => {
        nativeStorage.set(key, value);
      },
    },
    permission: { hook: async () => ({ dispose: async () => {} }) },
    rpc: {
      register: async (_definition: any, handlers: any) => {
        rpcHandlers = handlers;
        return {
          dispose: async () => {},
          events: {
            emit: async (name: string, data: any) =>
              emit(`rpc.open-extension.browser.${name}`, data),
          },
        };
      },
    },
    tool: {
      hook: async () => ({ dispose: async () => {} }),
      transform: async (edit: any) => {
        edit({ namespace: () => {}, add: (tool: any) => nativeTools.push(tool) });
        return { dispose: async () => {} };
      },
    },
  } as any);
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
    if (url.pathname.startsWith('/api/rpc/open-extension.browser/')) {
      let body = '';
      for await (const part of req) body += part;
      const method = decodeURIComponent(url.pathname.split('/').at(-1)!);
      try {
        json({ output: await rpcHandlers[method](JSON.parse(body).input) });
      } catch (error) {
        json({ _tag: 'RpcInternalError', message: (error as Error).message }, 500);
      }
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
    call: async (name: string, args: any) => {
      const tool = nativeTools.find((tool) => tool.name === name);
      if (!tool) throw new Error('Unknown browser tool');
      return (await tool.execute(args, { sessionID: sid, signal: new AbortController().signal }))
        .output;
    },
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
      await cleanup?.();
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

test('OpenCode 2 pairing, native RPC DOM workflow, event streaming and reversible scripts', async ({}, testInfo) => {
  const fixture = await nativeFixture(),
    profile = await mkdtemp(join(tmpdir(), 'open-extension-native-'));
  let context: BrowserContext | undefined;
  try {
    const launched = await launch(profile);
    context = launched.context;
    const panel = launched.panel;
    await panel
      .getByLabel('OpenCode pairing link', { exact: true })
      .fill(`${fixture.url}/auth/connect/fresh-native-test-code`);
    await panel.getByRole('button', { name: 'Pair & connect', exact: true }).click();
    await expect
      .poll(async () => (await rpc(panel, 'snapshot')).connection.state)
      .toBe('connected');
    await expect
      .poll(async () => (await rpc(panel, 'snapshot')).browserConnection.registered)
      .toBe(true);
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
    const call = async (name: string, args: any = {}) =>
      fixture.call(name, { context: contextToken, ...args });
    expect((await call('browser_observe')).title).toBe('Native test page');
    const live = await call('browser_execute', {
      code: 'api.text("h1", "Changed in Chrome"); api.on(document.querySelector("main"), "click", () => api.attr("main", "data-clicked", "yes")); return {title:document.querySelector("h1").textContent};',
    });
    expect(live.result.title).toBe('Changed in Chrome');
    await target.locator('main').click();
    await expect(target.locator('main')).toHaveAttribute('data-clicked', 'yes');
    await call('browser_reset');
    await expect(target.locator('h1')).toHaveText('Original');
    await expect(target.locator('main')).not.toHaveAttribute('data-clicked', 'yes');
    await call('browser_css', { css: '.promo{display:none!important}' });
    await expect(target.locator('.promo')).toBeHidden();
    await call('site_script_propose', {
      name: 'Native focus',
      description: 'Hide the promotional sidebar.',
      matches: ['*://127.0.0.1/*'],
      code: 'api.hide(".promo");',
    });
    await panel.getByRole('button', { name: 'Install', exact: true }).click();
    await expect.poll(async () => (await rpc(panel, 'snapshot')).scripts.length).toBe(1);
    const other = await context.newPage();
    await other.goto(`${fixture.url}/page`);
    await other.bringToFront();
    await expect(
      call('browser_execute', { code: 'document.body.dataset.wrong="yes"' }),
    ).rejects.toThrow(/not authorized|changed|no longer authorized/);
    expect(await other.evaluate(() => document.body.dataset.wrong)).toBeUndefined();
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
    await context?.close();
    await fixture.close();
    await rm(profile, { recursive: true, force: true });
  }
});

test('script library filters the current website, searches/sorts, edits and survives a browser restart', async ({}, testInfo) => {
  const fixture = await nativeFixture(),
    profile = await mkdtemp(join(tmpdir(), 'open-extension-library-'));
  let context: BrowserContext | undefined;
  try {
    const launched = await launch(profile);
    context = launched.context;
    const panel = launched.panel,
      id = panel.url().split('/')[2];
    await rpc(panel, 'settings.save', {
      serverUrl: fixture.url,
      password: servicePassword,
      rememberPassword: false,
    });
    await panel.getByRole('button', { name: 'Close settings' }).click();
    const target = await context.newPage();
    await target.goto(`${fixture.url}/page`);
    await target.bringToFront();
    const save = (name: string, matches: string[], code: string, enabled = true) =>
      rpc(panel, 'scripts.save', {
        id: name.toLowerCase().replaceAll(' ', '-'),
        name,
        description: `Saved behavior: ${name}`,
        matches,
        code,
        enabled,
        world: 'USER_SCRIPT',
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      });
    const focus = await save('Focus website', ['*://127.0.0.1/*'], 'api.hide(".promo");');
    await save('Another website', ['*://example.com/*'], 'api.css("aside{display:none}");');
    await save(
      'Alternate layout',
      ['*://127.0.0.1/another-route/*'],
      'api.hide(".another");',
      false,
    );
    await expect(target.locator('.promo')).toBeHidden();
    await panel.getByRole('tab', { name: /Scripts/ }).click();
    await expect(panel.getByRole('button', { name: /This site/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(panel.locator('.library-script')).toHaveCount(2);
    await expect(panel.locator('.library-script-title')).toHaveText([
      'Alternate layout',
      'Focus website',
    ]);
    await expect(panel.getByRole('button', { name: 'Another website', exact: true })).toHaveCount(
      0,
    );
    await panel.getByRole('button', { name: /All sites/ }).click();
    await expect(panel.locator('.library-script')).toHaveCount(3);
    await expect(panel.locator('.library-script-title')).toHaveText([
      'Alternate layout',
      'Focus website',
      'Another website',
    ]);
    await panel.getByRole('textbox', { name: 'Search site scripts' }).fill('example.com');
    await expect(panel.locator('.library-script')).toHaveCount(1);
    await panel.getByRole('button', { name: 'Clear script search' }).click();
    await panel.getByRole('combobox', { name: 'Sort site scripts' }).selectOption('name');
    await expect(panel.locator('.library-script-title')).toHaveText([
      'Alternate layout',
      'Another website',
      'Focus website',
    ]);
    await panel.getByRole('combobox', { name: 'Filter script status' }).selectOption('disabled');
    await expect(panel.locator('.library-script-title')).toHaveText('Alternate layout');
    await panel.getByRole('combobox', { name: 'Filter script status' }).selectOption('all');
    await panel.getByRole('button', { name: /This site/ }).click();
    await panel.screenshot({ path: testInfo.outputPath('site-scripts-library.png') });
    await panel.getByRole('switch', { name: 'Enable Focus website' }).click();
    await expect(target.locator('.promo')).toBeVisible();
    await panel.getByRole('switch', { name: 'Enable Focus website' }).click();
    await expect(target.locator('.promo')).toBeHidden();
    const prefs = await panel.evaluate(() => chrome.storage.local.get('scriptLibraryPreferences'));
    expect(prefs.scriptLibraryPreferences).toEqual({ sort: 'name', status: 'all' });
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
      viewport: { width: 360, height: 850 },
    });
    const persisted = await context.newPage();
    await persisted.goto(`${fixture.url}/page`);
    await expect(persisted.locator('.promo')).toBeHidden();
    const reopened = await context.newPage();
    await reopened.goto(`chrome-extension://${id}/sidepanel.html`);
    await persisted.bringToFront();
    const snapshot = await rpc(reopened, 'snapshot');
    expect(snapshot.settings.password).toBe('');
    expect(snapshot.scripts).toHaveLength(3);
    await reopened.getByRole('tab', { name: /Scripts/ }).click();
    await expect(reopened.getByRole('combobox', { name: 'Sort site scripts' })).toHaveValue('name');
    await reopened.getByRole('button', { name: 'Delete Focus website', exact: true }).click();
    await reopened.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(persisted.locator('.promo')).toBeVisible();
    await expect
      .poll(async () =>
        (await rpc(reopened, 'snapshot')).scripts.some((s: any) => s.id === focus.id),
      )
      .toBe(false);
    expect(
      await reopened.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  } finally {
    await context?.close();
    await fixture.close();
    await rm(profile, { recursive: true, force: true });
  }
});
