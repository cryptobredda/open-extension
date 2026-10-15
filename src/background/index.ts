import type {
  Settings,
  ConnectionState,
  BridgeState,
  Proposal,
  ToolCall,
  SiteScript,
  BackendEvent,
} from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';
import { validateSettings, errorText, localUrl, matchesUrl } from '../shared/validation';
import { browserInstructions } from '../shared/browser-context';
import { OpenCode, discover, redeemPairing } from './opencode';
import { ScriptStore, userScriptsAvailable } from './scripts';
import { BrowserTools, activeTab } from './browser';

const ports = new Set<chrome.runtime.Port>();
const scripts = new ScriptStore((message) => broadcast('notice', message));
let settings: Settings = DEFAULT_SETTINGS;
let backend: OpenCode;
let connection: ConnectionState = { state: 'disconnected' };
let bridgeState: BridgeState = { state: 'disconnected' };
let stream: AbortController | undefined;
let socket: WebSocket | undefined;
let bridgeRetry: ReturnType<typeof setTimeout> | undefined;
let bridgeHeartbeat: ReturnType<typeof setInterval> | undefined;
let activeSession = '';
let epoch = 0;
let registrationQueue: Promise<unknown> = Promise.resolve();
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
  settings = {
    ...DEFAULT_SETTINGS,
    ...stored,
    password: stored?.rememberPassword ? stored.password || '' : (session.password as string) || '',
  };
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
function setBridge(value: BridgeState) {
  bridgeState = value;
  broadcast('bridge', value);
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
    bridge: bridgeState,
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
  connectBridge();
  try {
    const health = await backend.inspect();
    if (generation !== epoch) return;
    setConnection({ state: 'connected', ...health });
    startStream(generation);
    if (bridgeState.state === 'connected')
      void registerMcp().catch((error) =>
        setBridge({ state: 'connected', registered: false, error: errorText(error) }),
      );
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
            void registerMcp().catch((error) =>
              setBridge({ state: 'connected', registered: false, error: errorText(error) }),
            );
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
            if (event.properties.sessionID === activeSession) browser.revoke();
          }
          if (
            event.type === 'session.model.selected' &&
            event.properties.sessionID === activeSession
          )
            broadcast('model.changed');
          broadcast('event', event);
        }
        if (!controller.signal.aborted) throw new Error('The event stream closed. Reconnecting…');
      } catch (error) {
        if (controller.signal.aborted || epoch !== generation) return;
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
function disconnectBridge() {
  clearTimeout(bridgeRetry);
  clearInterval(bridgeHeartbeat);
  const previous = socket;
  socket = undefined;
  if (previous) {
    previous.onclose = null;
    previous.close();
  }
  setBridge({ state: 'disconnected' });
  browser.revoke();
}
function connectBridge() {
  disconnectBridge();
  if (!ports.size || !settings.bridgeToken) return;
  const url = new URL('/extension', localUrl(settings.bridgeUrl));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url);
  socket = ws;
  setBridge({ state: 'connecting' });
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: settings.bridgeToken }));
  ws.onmessage = (event) => {
    if (socket !== ws) return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'ready') {
      setBridge({ state: 'connected' });
      bridgeHeartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 20_000);
      void registerMcp().catch((error) =>
        setBridge({
          state: 'connected',
          registered: false,
          error: errorText(error),
        }),
      );
    }
    if (message.type === 'tool') void runTool(ws, message);
  };
  ws.onerror = () => {
    /* onclose supplies a useful status and schedules reconnect. */
  };
  ws.onclose = (event) => {
    if (socket !== ws) return;
    socket = undefined;
    clearInterval(bridgeHeartbeat);
    browser.revoke();
    setBridge({
      state: 'disconnected',
      error:
        event.code === 4003
          ? 'Pairing token rejected. Check Connection settings.'
          : event.code === 4009
            ? 'Another browser is already paired to this bridge.'
            : 'Browser bridge is offline. Start npm run bridge on this machine.',
    });
    if (ports.size && ![4003, 4009].includes(event.code))
      bridgeRetry = setTimeout(connectBridge, 4000);
  };
}
function registerMcp(): Promise<void> {
  const generation = epoch,
    currentSocket = socket,
    client = backend.client,
    configuration = { ...settings };
  const work = registrationQueue.then(async () => {
    if (
      epoch !== generation ||
      socket !== currentSocket ||
      connection.state !== 'connected' ||
      bridgeState.state !== 'connected'
    )
      return;
    const result = await client.mcp.add({
      name: 'open_extension',
      config: {
        type: 'remote',
        url: `${configuration.bridgeUrl}/mcp`,
        headers: { Authorization: `Bearer ${configuration.bridgeToken}` },
        enabled: true,
        oauth: false,
        timeout: 60_000,
      },
    });
    if (
      epoch !== generation ||
      socket !== currentSocket ||
      currentSocket?.readyState !== WebSocket.OPEN
    )
      return;
    const status = (result.data as any)?.open_extension;
    if (status?.status !== 'connected')
      throw new Error(
        `OpenCode could not register browser tools${status?.error ? `: ${status.error}` : '. Check /mcp on your server.'}`,
      );
    setBridge({ state: 'connected', registered: true });
  });
  registrationQueue = work.catch(() => {});
  return work;
}
async function runTool(ws: WebSocket, call: ToolCall) {
  broadcast('tool', {
    id: call.id,
    name: call.name,
    at: Date.now(),
    status: 'running',
  });
  try {
    if (!ports.size) throw new Error('Open the side panel to authorize browser tools.');
    const data = await browser.call(call);
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'result', id: call.id, ok: true, data }));
    broadcast('tool', {
      id: call.id,
      name: call.name,
      at: Date.now(),
      status: 'completed',
      summary: 'Page observed and result returned to OpenCode.',
    });
  } catch (error) {
    const text = errorText(error);
    if (ws.readyState === WebSocket.OPEN)
      ws.send(JSON.stringify({ type: 'result', id: call.id, ok: false, error: text }));
    broadcast('tool', {
      id: call.id,
      name: call.name,
      at: Date.now(),
      status: 'error',
      summary: text,
    });
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
      await registerMcp();
    }
  }
  await backend.client.session.get({ sessionID: id });
  browser.revoke();
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
      if (!bridgeState.registered || socket?.readyState !== WebSocket.OPEN)
        throw new Error(
          'Browser tools are not connected. Pair the browser bridge in Connection settings before sending a website request.',
        );
      if (!(await userScriptsAvailable()))
        throw new Error(
          'Enable Allow User Scripts for Open Extension before editing this website.',
        );
      const currentTab = await activeTab();
      const saved = (await scripts.list()).filter((script) =>
        script.matches.some((pattern) => matchesUrl(pattern, currentTab.url)),
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
      disconnectBridge();
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
  void activeTab()
    .then((tab) => broadcast('tab', tab))
    .catch(() => {});
});
chrome.windows.onFocusChanged.addListener(() => {
  browser.revoke();
  void activeTab()
    .then((tab) => broadcast('tab', tab))
    .catch(() => {});
});
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.url || change.status === 'loading') browser.navigated(id);
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
    browser.navigated(details.tabId);
    void scripts.reconcileTab(details.tabId, details.url, true).catch(() => {});
  });
