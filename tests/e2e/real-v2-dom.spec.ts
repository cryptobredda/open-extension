import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { OpenCode as NativeOpenCode } from '@opencode/client';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { BROWSER_TOOLS } from '../../src/shared/browser-context';

const password = 'isolated-opencode-dom-test-password';
// Different containers/selectors on different routes; no hardcoded page classes in the script.
const initialCode = `api.watch(() => {
  for (const heading of document.querySelectorAll('h2, [role="heading"]')) {
    if (heading.textContent.trim().toLowerCase() === 'relevant people') {
      const section = heading.closest('aside, section, [role="region"]');
      if (section) api.remove(section);
    }
  }
});`;
const updatedCode = initialCode.replace('\'h2, [role="heading"]\'', '\'h2, h3, [role="heading"]\'');
async function rpc(page: Page, method: string, args?: unknown) {
  const result = await page.evaluate(
    ({ method, args }) => chrome.runtime.sendMessage({ type: 'rpc', method, args }),
    { method, args },
  );
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test('real OpenCode 2 routes only browser tools, selects connected models, removes DOM and updates domain-wide SPA scripts', async ({}, testInfo) => {
  test.skip(
    !process.env.OPENCODE2_BINARY,
    'Set OPENCODE2_BINARY to run an isolated real OpenCode server with a local deterministic provider.',
  );
  test.setTimeout(120000);
  const root = await mkdtemp(join(tmpdir(), 'open-extension-dom-'));
  let context: BrowserContext | undefined, child: ChildProcess | undefined;
  const requests: any[] = [],
    errors: string[] = [],
    plans = new Map<string, number>();
  const provider = http.createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname;
    if (path.startsWith('/page')) {
      const variant = path.endsWith('/alternate');
      const section = variant
        ? '<section class="new-layout" data-section="people"><h3>Relevant people</h3><p>Account suggestions</p></section>'
        : '<aside class="changed-on-every-route" data-section="people"><h2>Relevant people</h2><p>Account suggestions</p></aside>';
      res
        .writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Security-Policy': "default-src 'self'; script-src 'none'; style-src 'none'",
        })
        .end(
          `<!doctype html><title>Website DOM test</title><main><h1>Post</h1><p>Keep this content</p></main>${section}<aside data-section="trends"><h2>What’s happening</h2><p>Keep the trends</p></aside>`,
        );
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    try {
      let raw = '';
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      const names = (body.tools || []).map((tool: any) => tool.function?.name || tool.name);
      let message: any = { role: 'assistant', content: 'Website DOM changes' };
      if (names.length) {
        requests.push(body);
        expect(names).toEqual(['execute']);
        const text = JSON.stringify(body.messages);
        expect(text).toContain('browser-only session');
        for (const name of BROWSER_TOOLS) expect(text).toContain(name);
        expect(text).not.toContain('tools.opencode.read');
        expect(text).not.toContain('tools.opencode.shell');
        expect(text).toContain('relevant people');
        expect(text).toContain('untrusted_page_observation');
        expect(text).toContain('/page');
        const token = [...text.matchAll(/THIS turn: ([\w-]+)/g)].at(-1)?.[1];
        expect(token).toBeTruthy();
        const index = plans.get(token!) || 0;
        plans.set(token!, index + 1);
        const updating = text.includes('UPDATE THIS EXISTING SCRIPT');
        const scriptId = text.match(/scriptId=([\w-]+)/)?.[1];
        const code = updating ? updatedCode : initialCode;
        const steps = [
          { name: 'browser_observe', args: { html: true } },
          { name: 'browser_execute', args: { code, html: true } },
          {
            name: 'browser_execute',
            args: {
              code: 'return {removed: !document.querySelector("[data-section=people]"), main: !!document.querySelector("main"), trends: !!document.querySelector("[data-section=trends]")};',
            },
          },
          {
            name: 'site_script_propose',
            args: {
              name: 'Hide relevant people',
              description:
                'Remove Relevant people across this website, including content loaded after navigation.',
              code,
              ...(updating ? { scriptId } : {}),
            },
          },
        ];
        if (index === 3) {
          const tool = body.messages.filter((message: any) => message.role === 'tool').at(-1);
          expect(tool?.content).toMatch(/"removed"\s*:\s*true/);
          expect(tool?.content).toMatch(/"main"\s*:\s*true/);
          expect(tool?.content).toMatch(/"trends"\s*:\s*true/);
        }
        if (index < steps.length) {
          const step = steps[index];
          message = {
            role: 'assistant',
            content: null,
            reasoning_content:
              'I will modify the current website DOM with browser tools and verify the result.',
            tool_calls: [
              {
                id: `call_${token}_${index}`,
                type: 'function',
                function: {
                  name: 'execute',
                  arguments: JSON.stringify({
                    code: `return await tools.open_extension.${step.name}(${JSON.stringify({ context: token, ...step.args })});`,
                  }),
                },
              },
            ],
          };
        } else
          message = {
            role: 'assistant',
            content:
              'Verified: Relevant people is removed from the current page. Main content and trends remain. Review the site script to keep this change on every page of this website.',
          };
      }
      const finish = message.tool_calls ? 'tool_calls' : 'stop';
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (delta: any, finish_reason: string | null = null) =>
          res.write(
            `data: ${JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          );
        chunk(message);
        chunk({}, finish);
        res.end('data: [DONE]\n\n');
      } else
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(
          JSON.stringify({
            id: 'chatcmpl_test',
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [{ index: 0, message, finish_reason: finish }],
            usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
          }),
        );
    } catch (error) {
      errors.push(String(error));
      res.writeHead(500).end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const site = `http://127.0.0.1:${(provider.address() as net.AddressInfo).port}`;
  try {
    for (const name of ['config', 'data', 'state', 'project', 'chrome'])
      await mkdir(join(root, name));
    const config = {
      agents: {
        build: { mode: 'primary', permissions: [{ action: '*', resource: '*', effect: 'allow' }] },
      },
      providers: {
        browser_test: {
          name: 'Local test provider',
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: `${site}/v1`, apiKey: 'local-fixture-key' },
          models: {
            'dom-agent': {
              name: 'DOM agent',
              capabilities: { tools: true, input: ['text'], output: ['text'] },
              limit: { context: 128000, output: 4096 },
            },
            'another-model': {
              name: 'Another connected model',
              capabilities: { tools: true, input: ['text'], output: ['text'] },
              limit: { context: 128000, output: 4096 },
            },
          },
        },
      },
      model: 'browser_test/dom-agent',
    };
    const port = await freePort(),
      url = `http://127.0.0.1:${port}`;
    let log = '';
    child = spawn(
      process.env.OPENCODE2_BINARY!,
      ['serve', '--hostname', '127.0.0.1', '--port', String(port)],
      {
        cwd: join(root, 'project'),
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(root, 'config'),
          XDG_DATA_HOME: join(root, 'data'),
          XDG_STATE_HOME: join(root, 'state'),
          OPENCODE_SERVER_PASSWORD: password,
          OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout?.on('data', (data) => {
      log += data.toString();
    });
    child.stderr?.on('data', (data) => {
      log += data.toString();
    });
    const api = NativeOpenCode.make({
      baseUrl: url,
      headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` },
    });
    await expect
      .poll(
        async () => {
          try {
            return (await api.agent.list()).data.some((agent) => agent.id === 'build');
          } catch {
            return false;
          }
        },
        { timeout: 30000 },
      )
      .toBe(true);
    context = await chromium.launchPersistentContext(join(root, 'chrome'), {
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
    context.setDefaultTimeout(15000);
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
    await rpc(panel, 'settings.save', {
      serverUrl: url,
      password,
      rememberPassword: true,
    });
    await panel.getByRole('button', { name: 'Enable native browser tools', exact: true }).click();
    await expect
      .poll(async () => (await rpc(panel, 'snapshot')).browserConnection.registered)
      .toBe(true);
    const nativePlugin = (await api.plugin.list()).data.find(
      (p) => p.id === 'open-extension.native',
    );
    expect(nativePlugin?.state.status).toBe('active');
    await panel.getByRole('button', { name: 'Close settings' }).click();
    await panel.getByRole('button', { name: 'Choose OpenCode model' }).click();
    await panel
      .getByRole('option', { name: 'Another connected model Local test provider' })
      .click();
    await expect(panel.getByRole('button', { name: 'Choose OpenCode model' })).toContainText(
      'Another connected model',
    );
    await expect(panel.getByRole('button', { name: 'Choose OpenCode model' })).toBeEnabled();
    const session = await rpc(panel, 'session.create');
    await expect
      .poll(async () => (await api.session.get({ sessionID: session.id })).model?.id)
      .toBe('another-model');
    expect((await api.session.get({ sessionID: session.id })).permissions).toContainEqual({
      action: '*',
      resource: '*',
      effect: 'deny',
    });
    await panel.getByRole('button', { name: 'Choose OpenCode model' }).click();
    await panel.getByRole('option', { name: 'DOM agent Local test provider', exact: true }).click();
    await expect
      .poll(async () => (await api.session.get({ sessionID: session.id })).model?.id)
      .toBe('dom-agent');
    await panel.getByRole('button', { name: 'Choose OpenCode model' }).click();
    await panel.screenshot({ path: testInfo.outputPath('opencode-model-picker.png') });
    await panel.keyboard.press('Escape');
    const target = await context.newPage();
    await target.goto(`${site}/page/post`);
    await target.bringToFront();
    await rpc(panel, 'send', { id: session.id, text: 'remove the "relevant people" section' });
    await expect(target.locator('[data-section=people]')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Install', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    await expect(panel.getByText('OpenCode turn finished.', { exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Install', exact: true }).click();
    const saved = (await rpc(panel, 'snapshot')).scripts[0];
    expect(saved.matches).toEqual(['*://127.0.0.1/*']);
    await target.reload();
    await expect(target.locator('[data-section=people]')).toHaveCount(0);
    await target.goto(`${site}/page/profile`);
    await expect(target.locator('[data-section=people]')).toHaveCount(0);
    await target.evaluate(() => {
      history.pushState({}, '', '/page/spa');
      document.body.insertAdjacentHTML(
        'beforeend',
        '<section data-section="people"><h2>Relevant people</h2><p>SPA suggestions</p></section>',
      );
    });
    await expect(target.locator('[data-section=people]')).toHaveCount(0);
    await rpc(panel, 'scripts.toggle', { id: saved.id, enabled: false });
    await expect(target.locator('[data-section=people]')).toHaveCount(2);
    await target.goto(`${site}/page/alternate`);
    await expect(target.locator('[data-section=people]')).toBeVisible();
    await panel.getByRole('tab', { name: /Scripts/ }).click();
    await expect(panel.getByRole('button', { name: /This site/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await panel.getByRole('button', { name: 'Update Hide relevant people with OpenCode' }).click();
    await panel
      .getByRole('textbox', { name: 'Message OpenCode' })
      .fill('Remove this layout too and preserve the previous pages.');
    // The visible side panel does not change Chrome's active tab; this tab-based harness does.
    await target.bringToFront();
    await panel.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Update script', exact: true })).toBeVisible();
    await panel.getByRole('button', { name: 'Update script', exact: true }).click();
    await expect
      .poll(async () => (await rpc(panel, 'snapshot')).scripts[0].revision)
      .toBe(saved.revision + 2);
    expect((await rpc(panel, 'snapshot')).scripts).toHaveLength(1);
    await expect(target.locator('[data-section=people]')).toHaveCount(0);
    await target.reload();
    await expect(target.locator('[data-section=people]')).toHaveCount(0);
    await target.goto(`${site}/page/original`);
    await expect(target.locator('[data-section=people]')).toHaveCount(0);
    await expect(target.locator('main')).toHaveText('PostKeep this content');
    await expect(target.locator('[data-section=trends]')).toBeVisible();
    await panel.screenshot({ path: testInfo.outputPath('verified-domain-script.png') });
    expect(errors).toEqual([]);
    expect(requests.length).toBeGreaterThanOrEqual(10);
    expect(requests.every((request) => request.model === 'dom-agent')).toBe(true);
    // Other clients' model changes are reflected in the picker and respected on the next turn.
    await api.session.switchModel({
      sessionID: session.id,
      model: { providerID: 'browser_test', id: 'another-model' },
    });
    await expect(panel.getByRole('button', { name: 'Choose OpenCode model' })).toContainText(
      'Another connected model',
    );
    await rpc(panel, 'scripts.toggle', { id: saved.id, enabled: false });
    await expect(target.locator('[data-section=people]')).toBeVisible();
  } catch (error) {
    console.error('Local provider errors:', errors);
    console.error('Browser model requests:', requests.length);
    throw error;
  } finally {
    await context?.close();
    child?.kill('SIGTERM');
    if (child && child.exitCode === null)
      await new Promise<void>((resolve) => {
        child!.once('exit', () => resolve());
        setTimeout(() => {
          child?.kill('SIGKILL');
          resolve();
        }, 3000).unref();
      });
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
