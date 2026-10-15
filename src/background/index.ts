import type {
  Settings,
  ConnectionState,
  BrowserConnectionState,
  Proposal,
  ToolCall,
  SiteScript,
  BackendEvent,
} from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';
import { validateSettings, errorText } from '../shared/validation';
import { browserInstructions } from '../shared/browser-context';
import { scriptMatchesSite } from '../shared/script-library';
import { OpenCode, discover, redeemPairing } from './opencode';
import { ScriptStore, userScriptsAvailable } from './scripts';
import { BrowserTools, activeTab } from './browser';
import { NativeTools } from './native-tools';

const ports = new Set<chrome.runtime.Port>();
const scripts = new ScriptStore((message) => broadcast('notice', message));
let settings: Settings = DEFAULT_SETTINGS;
let backend: OpenCode;
let connection: ConnectionState = { state: 'disconnected' };
let browserState: BrowserConnectionState = { state: 'disconnected' };
let stream: AbortController | undefined;
let nativeTools: NativeTools | undefined;
let activeSession = '';
let epoch = 0;
let proposals: Proposal[] = [];
const browser = new BrowserTools(scripts, async (proposal) => {
  proposals = [...proposals.filter((item) => item.sessionID !== proposal.sessionID), proposal];
  await chrome.storage.session.set({ proposals });
  broadcast('proposals', proposals);
});
const ready = (async () => {
  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  ]);
  const [local, session] = await Promise.all([
    chrome.storage.local.get(['settings', 'activeSession']),
    chrome.storage.session.get(['password', 'proposals']),
  ]);
  const stored = local.settings as Partial<Settings> | undefined;
  settings = validateSettings({
    ...DEFAULT_SETTINGS,
    ...stored,
    password: stored?.rememberPassword ? stored.password || '' : (session.password as string) || '',
  });
  if (stored && ('bridgeToken' in stored || 'bridgeUrl' in stored)) {
    await chrome.storage.local.set({
      settings: { ...settings, password: settings.rememberPassword ? settings.password : '' },
    });
  }
  activeSession = (local.activeSession as string) || '';
  proposals = (session.proposals as Proposal[]) || [];
  backend = new OpenCode(settings);
  await scripts.restore().catch((error) => broadcast('notice', errorText(error)));
})();

function broadcast(type: string, data?: unknown) {
  for (const port of ports) {
    try {
      port.postMessage({ type, data });
    } catch {
      ports.delete(port);
    }
  }
}
function setConnection(value: ConnectionState) {
  connection = value;
  broadcast('connection', value);
}
function setBrowserConnection(value: BrowserConnectionState) {
  browserState = value;
  broadcast('browserConnection', value);
}
async function persistSettings(value: Settings) {
  settings = validateSettings(value);
  await chrome.storage.local.set({
    settings: {
      ...settings,
      password: settings.rememberPassword ? settings.password : '',
    },
  });
  await chrome.storage.session.set({
    password: settings.rememberPassword ? '' : settings.password,
  });
  broadcast('settings', settings);
}
async function snapshot() {
  return {
    settings,
    connection,
    browserConnection: browserState,
    activeSession,
    scripts: await scripts.list(),
    proposals,
    tab: await activeTab().catch(() => null),
    userScripts: await userScriptsAvailable(),
  };
}
async function connect() {
  await ready;
  const generation = ++epoch;
  stream?.abort();
  browser.revoke();
  backend = new OpenCode(settings);
  setConnection({ state: 'connecting' });
  nativeTools?.close();
  nativeTools = new NativeTools(backend, runTool, setBrowserConnection, () => browser.revoke());
  try {
    const health = await backend.inspect();
    if (generation !== epoch) return;
    setConnection({ state: 'connected', ...health });
    startStream(generation);
    await nativeTools.check();
    return health;
  } catch (error) {
    if (generation === epoch) setConnection({ state: 'disconnected', error: errorText(error) });
    throw error;
  }
}
function startStream(generation: number) {
  stream?.abort();
  const controller = new AbortController();
  stream = controller;
  void (async () => {
    let delay = 1000;
    while (!controller.signal.aborted && ports.size && epoch === generation) {
      try {
        for await (const event of backend.events(controller.signal)) {
          if (controller.signal.aborted || epoch !== generation) return;
          if (connection.state !== 'connected') {
            setConnection({
              ...connection,
              state: 'connected',
              error: undefined,
            });
            broadcast('resync');
          }
          delay = 1000;
          if (event.type === 'server.connected') {
            broadcast('resync');
            void nativeTools?.check();
          }
          if (
            [
              'session.idle',
              'session.execution.succeeded',
              'session.execution.failed',
              'session.execution.interrupted',
            ].includes(event.type) ||
            (event.type === 'session.status' && event.properties.status?.type === 'idle')
          ) {
            if (event.properties.sessionID === activeSession) {
              browser.revoke();
              nativeTools?.close();
            }
          }
          if (
            event.type === 'session.model.selected' &&
            event.properties.sessionID === activeSession
          )
            broadcast('model.changed');
          nativeTools?.handle(event);
          broadcast('event', event);
        }
        if (!controller.signal.aborted) throw new Error('The event stream closed. Reconnecting…');
      } catch (error) {
        if (controller.signal.aborted || epoch !== generation) return;
        browser.revoke();
        nativeTools?.close();
        setConnection({
          ...connection,
          state: 'reconnecting',
          error: errorText(error),
        });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, delay);
          function done() {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', done);
            resolve();
          }
          controller.signal.addEventListener('abort', done, { once: true });
        });
        delay = Math.min(15_000, delay * 2);
      }
    }
  })();
}
async function runTool(call: ToolCall) {
  broadcast('tool', { id: call.id, name: call.name, at: Date.now(), status: 'running' });
  try {
    if (!ports.size) throw new Error('Open the side panel to authorize browser tools.');
    const data = await browser.call(call);
    broadcast('tool', {
      id: call.id,
      name: call.name,
      at: Date.now(),
      status: 'completed',
      summary: 'Page observed and result returned to OpenCode.',
    });
    return data;
  } catch (error) {
    broadcast('tool', {
      id: call.id,
      name: call.name,
      at: Date.now(),
      status: 'error',
      summary: errorText(error),
    });
    throw error;
  }
}
function sessionId(value: unknown) {
  if (typeof value !== 'string' || !/^ses_[a-zA-Z0-9]+$/.test(value))
    throw new Error('Invalid OpenCode session ID.');
  return value;
}
async function useSession(id: string) {
  const sessions = (await backend.client.session.list()).data || [];
  const session = sessions.find((item) => item.id === id);
  if (session?.directory && settings.directory !== session.directory) {
    await persistSettings({ ...settings, directory: session.directory });
    backend = new OpenCode(settings, backend.protocol);
    if (connection.state === 'connected') {
      startStream(epoch);
      nativeTools?.close();
      nativeTools = new NativeTools(backend, runTool, setBrowserConnection, () => browser.revoke());
      await nativeTools.check();
    }
  }
  await backend.client.session.get({ sessionID: id });
  browser.revoke();
  nativeTools?.close();
  activeSession = id;
  await chrome.storage.local.set({ activeSession });
  broadcast('session', id);
}
async function rpc(method: string, args: any = {}) {
  await ready;
  switch (method) {
    case 'ping':
      return true;
    case 'snapshot':
      return snapshot();
    case 'connect':
      return connect();
    case 'settings.save': {
      const next = validateSettings({ ...settings, ...args });
      const modelChanged = next.model !== settings.model;
      if (
        modelChanged &&
        activeSession &&
        connection.state === 'connected' &&
        next.serverUrl === settings.serverUrl &&
        next.directory === settings.directory
      ) {
        const status = (await backend.client.session.status()).data?.[activeSession];
        if (status && status.type !== 'idle')
          throw new Error('Wait for the current turn before changing models.');
      }
      if (next.serverUrl !== settings.serverUrl || next.directory !== settings.directory) {
        activeSession = '';
        await chrome.storage.local.set({ activeSession });
        broadcast('session', '');
      }
      await persistSettings(next);
      browser.revoke();
      const health = await connect();
      if (modelChanged) {
        await backend.selectModel(next.model, activeSession || undefined);
        broadcast('model.changed');
      }
      return health;
    }
    case 'pair.connect': {
      const proposed = validateSettings({ ...settings, ...args.settings });
      const paired = await redeemPairing(proposed, args.link);
      await new OpenCode(paired).inspect();
      if (paired.serverUrl !== settings.serverUrl || paired.directory !== settings.directory) {
        activeSession = '';
        await chrome.storage.local.set({ activeSession });
        broadcast('session', '');
      }
      await persistSettings(paired);
      browser.revoke();
      return connect();
    }
    case 'native.install': {
      if (connection.state !== 'connected' || !nativeTools)
        throw new Error('Connect to OpenCode first.');
      const path = await nativeTools.install();
      startStream(epoch);
      return path;
    }
    case 'discover':
      return discover({ ...settings, ...args });
    case 'tab':
      return activeTab();
    case 'sessions':
      return (await backend.client.session.list()).data;
    case 'session.create': {
      const session = (await backend.client.session.create({ title: 'Open Extension' })).data!;
      await useSession(session.id);
      await backend.restrictToBrowser(session.id);
      if (settings.model) await backend.selectModel(settings.model, session.id);
      broadcast('model.changed');
      return session;
    }
    case 'session.attach':
      await useSession(sessionId(args.id));
      return activeSession;
    case 'messages':
      return (await backend.client.session.messages({ sessionID: sessionId(args.id) })).data;
    case 'status':
      return (await backend.client.session.status()).data;
    case 'models':
      return backend.models(activeSession || undefined);
    case 'preferences.model': {
      if (typeof args.model !== 'string') throw new Error('Select an OpenCode model.');
      const status = activeSession
        ? (await backend.client.session.status()).data?.[activeSession]
        : undefined;
      if (status && status.type !== 'idle')
        throw new Error('Wait for the current turn before changing models.');
      await backend.selectModel(args.model, activeSession || undefined);
      await persistSettings({ ...settings, model: args.model });
      broadcast('model.changed');
      return backend.models(activeSession || undefined);
    }
    case 'agents':
      return (await backend.client.app.agents()).data;
    case 'preferences.agent': {
      const agents = (await backend.client.app.agents()).data || [];
      if (
        !agents.some(
          (agent) => agent.name === args.agent && agent.mode !== 'subagent' && !agent.hidden,
        )
      )
        throw new Error('Choose an available primary OpenCode agent.');
      await persistSettings({ ...settings, agent: args.agent });
      return true;
    }
    case 'pending': {
      const [permissions, questions, forms] = await Promise.allSettled([
        backend.client.permission.list(),
        backend.client.question.list(),
        backend.forms(),
      ]);
      return {
        permissions: permissions.status === 'fulfilled' ? permissions.value.data : [],
        questions: questions.status === 'fulfilled' ? questions.value.data : [],
        forms: forms.status === 'fulfilled' ? forms.value : [],
      };
    }
    case 'form.reply':
    case 'form.cancel': {
      if (backend.protocol !== 'v2') throw new Error('This server does not support v2 forms.');
      const form = (await backend.forms()).find(
        (item) => item.id === args.id && item.sessionID === activeSession,
      );
      if (!form) throw new Error('This form is no longer pending in the current session.');
      if (method === 'form.reply')
        await backend.native.session.form.reply({
          sessionID: form.sessionID,
          formID: form.id,
          answer: args.answer,
        });
      else await backend.native.session.form.cancel({ sessionID: form.sessionID, formID: form.id });
      return true;
    }
    case 'send': {
      const id = sessionId(args.id);
      if (id !== activeSession) throw new Error('The selected session changed. Send again.');
      if (typeof args.text !== 'string' || !args.text.trim() || args.text.length > 100_000)
        throw new Error('Enter a message under 100,000 characters.');
      const status = (await backend.client.session.status()).data?.[id];
      if (status && status.type !== 'idle')
        throw new Error('This OpenCode session is busy. Wait or stop the current turn.');
      if (!nativeTools || !browserState.registered)
        throw new Error(
          'Enable native browser tools in Connection settings before sending a website request.',
        );
      if (!(await userScriptsAvailable()))
        throw new Error(
          'Enable Allow User Scripts for Open Extension before editing this website.',
        );
      const currentTab = await activeTab();
      const saved = (await scripts.list()).filter((script) =>
        scriptMatchesSite(script, currentTab.url),
      );
      const updating = args.scriptId
        ? saved.find((script) => script.id === args.scriptId)
        : undefined;
      if (args.scriptId && !updating)
        throw new Error('The script to update must belong to the current website.');
      const authorization = await browser.authorize(id, updating?.id);
      let model: { providerID: string; modelID: string } | undefined;
      if (settings.model && backend.protocol !== 'v2') {
        const index = settings.model.indexOf('/');
        if (index > 0)
          model = {
            providerID: settings.model.slice(0, index),
            modelID: settings.model.slice(index + 1),
          };
      }
      try {
        const observation = await browser.observe(authorization.tab, { html: true, limit: 16000 });
        await browser.guard(authorization.token);
        const system = browserInstructions(
          authorization.token,
          authorization.tab,
          observation,
          saved.map(({ code, ...script }) => ({ ...script, code: '' })),
          updating,
        );
        await nativeTools.attach(id, authorization.token);
        if (backend.protocol !== 'v2') await backend.restrictToBrowser(id);
        await backend.client.session.promptAsync({
          sessionID: id,
          parts: [{ type: 'text', text: args.text.trim() }],
          system,
          agent: settings.agent || 'build',
          ...(model ? { model } : {}),
        });
      } catch (error) {
        browser.revoke();
        throw error;
      }
      return true;
    }
    case 'abort':
      browser.revoke();
      nativeTools?.close();
      return (await backend.client.session.abort({ sessionID: sessionId(args.id) })).data;
    case 'permission.reply': {
      const list = (await backend.client.permission.list()).data || [];
      if (!list.some((item) => item.id === args.id && item.sessionID === activeSession))
        throw new Error('This permission request is no longer pending in the current session.');
      if (!['once', 'always', 'reject'].includes(args.reply))
        throw new Error('Invalid permission reply.');
      return (
        await backend.client.permission.reply({
          requestID: args.id,
          reply: args.reply,
        })
      ).data;
    }
    case 'question.reply':
    case 'question.reject': {
      const list = (await backend.client.question.list()).data || [];
      if (!list.some((item) => item.id === args.id && item.sessionID === activeSession))
        throw new Error('This question is no longer pending.');
      return method === 'question.reply'
        ? (
            await backend.client.question.reply({
              requestID: args.id,
              answers: args.answers,
            })
          ).data
        : (await backend.client.question.reject({ requestID: args.id })).data;
    }
    case 'scripts.save': {
      const result = await scripts.save(args as SiteScript);
      broadcast('scripts', await scripts.list());
      return result;
    }
    case 'scripts.toggle': {
      const script = (await scripts.list()).find((item) => item.id === args.id);
      if (!script) throw new Error('Script not found.');
      await scripts.save({ ...script, enabled: Boolean(args.enabled) });
      broadcast('scripts', await scripts.list());
      return true;
    }
    case 'scripts.delete':
      await scripts.remove(args.id);
      broadcast('scripts', await scripts.list());
      return true;
    case 'proposal.approve': {
      const proposal = proposals.find((item) => item.id === args.id);
      if (!proposal) throw new Error('This proposal is no longer available.');
      const now = Date.now();
      const script = await scripts.save(
        {
          id: proposal.scriptId || crypto.randomUUID(),
          name: proposal.name,
          description: proposal.description,
          matches: proposal.matches,
          code: proposal.code,
          world: proposal.world,
          enabled: true,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        },
        proposal,
      );
      proposals = proposals.filter((item) => item.id !== proposal.id);
      await chrome.storage.session.set({ proposals });
      broadcast('proposals', proposals);
      broadcast('scripts', await scripts.list());
      return script;
    }
    case 'proposal.dismiss':
      proposals = proposals.filter((item) => item.id !== args.id);
      await chrome.storage.session.set({ proposals });
      broadcast('proposals', proposals);
      return true;
    case 'experiments.reset': {
      const tab = await activeTab();
      await browser.resetExperiments(tab.id);
      return true;
    }
    case 'page.reload': {
      const tab = await activeTab();
      await chrome.tabs.reload(tab.id);
      return true;
    }
    case 'fast.open':
      await chrome.tabs.create({ url: settings.serverUrl });
      return true;
    case 'extensions.open':
      await chrome.tabs.create({
        url: `chrome://extensions/?id=${chrome.runtime.id}`,
      });
      return true;
    default:
      throw new Error('Unknown extension operation.');
  }
}
function trusted(sender: chrome.runtime.MessageSender) {
  return (
    sender.id === chrome.runtime.id &&
    sender.url?.split(/[?#]/)[0] === chrome.runtime.getURL('sidepanel.html')
  );
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!trusted(sender) || message?.type !== 'rpc') return;
  void rpc(message.method, message.args)
    .then((data) => reply({ ok: true, data }))
    .catch((error) => reply({ ok: false, error: errorText(error) }));
  return true;
});
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel' || !port.sender || !trusted(port.sender)) {
    port.disconnect();
    return;
  }
  ports.add(port);
  void ready.then(async () => {
    port.postMessage({ type: 'snapshot', data: await snapshot() });
    if (ports.size === 1) await connect().catch(() => {});
  });
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (!ports.size) {
      stream?.abort();
      nativeTools?.close();
      setBrowserConnection({ state: 'disconnected' });
      browser.revoke();
    }
  });
});
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void ready.then(() => scripts.restore()).catch(() => {});
  void chrome.alarms.create('restore-scripts', { periodInMinutes: 1 });
});
chrome.runtime.onStartup.addListener(() => {
  void ready.then(() => scripts.restore()).catch(() => {});
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'restore-scripts') void ready.then(() => scripts.restore()).catch(() => {});
});
chrome.tabs.onActivated.addListener(() => {
  browser.revoke();
  nativeTools?.close();
  void activeTab()
    .then((tab) => broadcast('tab', tab))
    .catch(() => {});
});
chrome.windows.onFocusChanged.addListener(() => {
  browser.revoke();
  nativeTools?.close();
  void activeTab()
    .then((tab) => broadcast('tab', tab))
    .catch(() => {});
});
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.url || change.status === 'loading') {
    if (browser.lease?.tabId === id) nativeTools?.close();
    browser.navigated(id);
  }
  if (change.url && tab.active)
    void activeTab()
      .then((info) => broadcast('tab', info))
      .catch(() => {});
  if (change.status === 'complete' && tab.url)
    void scripts.reconcileTab(id, tab.url).catch(() => {});
});
for (const event of [
  chrome.webNavigation.onHistoryStateUpdated,
  chrome.webNavigation.onReferenceFragmentUpdated,
])
  event.addListener((details) => {
    if (details.frameId !== 0) return;
    if (browser.lease?.tabId === details.tabId) nativeTools?.close();
    browser.navigated(details.tabId);
    void scripts.reconcileTab(details.tabId, details.url, true).catch(() => {});
  });
