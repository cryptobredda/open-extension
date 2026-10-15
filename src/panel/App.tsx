import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Square,
  Settings as SettingsIcon,
  Plus,
  History,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Globe2,
  Code2,
  X,
  Check,
  Loader2,
  Terminal,
  Sparkles,
  Trash2,
  Pencil,
  Undo2,
  Plug,
  Search,
  Copy,
  FileCode2,
  ArrowRight,
  Monitor,
  AlertCircle,
} from 'lucide-react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type {
  Settings,
  Session,
  SiteScript,
  Proposal,
  ConversationMessage,
  Part,
  BackendEvent,
  ConnectionState,
  BridgeState,
  TabInfo,
  PermissionRequest,
  QuestionRequest,
  PendingForm,
} from '../shared/types';
import { DEFAULT_SETTINGS } from '../shared/types';
import { reduceConversation } from '../shared/conversation';
import { rpc } from './api';
import { ModelPicker } from './ModelPicker';
import { matchesUrl } from '../shared/validation';

function Logo({ small = false }: { small?: boolean }) {
  return (
    <span className={`logo ${small ? 'small' : ''}`} aria-hidden="true">
      <span />
      <span />
      <i />
    </span>
  );
}
function Markdown({ text }: { text: string }) {
  const html = DOMPurify.sanitize(marked.parse(text, { async: false, breaks: true }) as string, {
    FORBID_TAGS: ['img', 'video', 'audio', 'iframe', 'form', 'input', 'button', 'style'],
    FORBID_ATTR: ['style', 'id', 'name'],
    ALLOW_DATA_ATTR: false,
  });
  return (
    <div
      className="markdown"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(event) => {
        const link = (event.target as Element).closest('a');
        if (link) {
          event.preventDefault();
          if (/^https?:\/\//i.test(link.href)) void chrome.tabs.create({ url: link.href });
        }
      }}
    />
  );
}
function PartView({ part, unit, reasoning }: { part: Part; unit: number; reasoning: boolean }) {
  const p = part as any;
  if (part.type === 'text') return <Markdown text={part.text} />;
  if (part.type === 'reasoning')
    return reasoning ? (
      <details className="reasoning" open>
        <summary>
          <Sparkles size={12} /> Reasoning <span>{p.time?.end ? 'Complete' : 'Thinking'}</span>
        </summary>
        <Markdown text={part.text} />
      </details>
    ) : null;
  if (part.type === 'step-start')
    return (
      <div className="execution-marker">
        <span className="unit-dot">
          <Terminal size={10} />
        </span>
        <strong>Unit {unit}</strong>
        <span>Execute</span>
      </div>
    );
  if (part.type === 'step-finish')
    return (
      <div className="step-finish">
        <Check size={12} />
        <span>Step complete</span>
        <span>
          {p.reason}
          {p.tokens?.output ? ` · ${p.tokens.output.toLocaleString()} tokens` : ''}
        </span>
      </div>
    );
  if (part.type === 'tool')
    return (
      <details className={`tool-call ${part.state.status}`}>
        <summary>
          {['running', 'pending'].includes(part.state.status) ? (
            <Loader2 size={13} className="spin" />
          ) : part.state.status === 'error' ? (
            <AlertCircle size={13} />
          ) : (
            <Check size={13} />
          )}
          <span>
            {('title' in part.state && part.state.title) ||
              part.tool.replace(/^open_extension_/, '').replaceAll('_', ' ')}
          </span>
          <small>{part.state.status}</small>
          <ChevronDown size={12} />
        </summary>
        <div className="tool-detail">
          <div className="eyebrow">{part.tool}</div>
          <pre>
            {JSON.stringify(
              part.state.input,
              (key, value) => (key === 'context' ? '[turn capability]' : value),
              2,
            )}
          </pre>
          {'output' in part.state && (
            <>
              <div className="eyebrow">Result & verification</div>
              <pre>{part.state.output}</pre>
            </>
          )}
          {'error' in part.state && <pre className="error-text">{part.state.error}</pre>}
        </div>
      </details>
    );
  if (part.type === 'agent')
    return (
      <div className="context-marker">
        <Check size={12} /> Instructions updated <span>{p.name}</span>
      </div>
    );
  if (part.type === 'compaction')
    return (
      <div className="context-marker">
        <History size={12} /> Conversation compacted
      </div>
    );
  if (part.type === 'file')
    return (
      <div className="context-marker">
        <FileCode2 size={13} />
        {part.filename || part.mime}
      </div>
    );
  if (['snapshot', 'patch', 'retry', 'subtask'].includes(part.type))
    return (
      <details className="tool-call">
        <summary>
          <Code2 size={12} />
          {part.type === 'retry'
            ? 'Retrying request'
            : part.type === 'subtask'
              ? p.description
              : 'Context updated'}
          <ChevronDown size={12} />
        </summary>
        <pre>{JSON.stringify(p, null, 2)}</pre>
      </details>
    );
  return (
    <details className="tool-call">
      <summary>
        {part.type}
        <ChevronDown size={12} />
      </summary>
      <pre>{JSON.stringify(p, null, 2)}</pre>
    </details>
  );
}
function MessageView({
  message,
  reasoning,
  offset,
}: {
  message: ConversationMessage;
  reasoning: boolean;
  offset: number;
}) {
  const user = message.info.role === 'user';
  let unit = offset;
  return (
    <article className={`message ${user ? 'user' : 'assistant'}`}>
      <div className="message-heading">
        {user ? <span className="user-avatar">Y</span> : <Logo small />}
        <strong>{user ? 'You' : 'OpenCode'}</strong>
        {!user && 'modelID' in message.info && (
          <span className="model-label">{message.info.modelID}</span>
        )}
        <time>
          {new Date(message.info.time.created).toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          })}
        </time>
      </div>
      <div className="message-content">
        {message.parts.map((part) => {
          if (part.type === 'step-start') unit++;
          if ((message.info as any).browserContext && part.type === 'text')
            return (
              <details className="tool-call browser-context-detail" key={part.id}>
                <summary>
                  <Globe2 size={12} /> Browser context <ChevronDown size={12} />
                </summary>
                <div className="tool-detail">
                  <Markdown text={part.text} />
                </div>
              </details>
            );
          return <PartView key={part.id} part={part} unit={unit} reasoning={reasoning} />;
        })}
        {'error' in message.info && message.info.error && (
          <div className="inline-error">
            {(message.info.error as any).data?.message || message.info.error.name}
          </div>
        )}
      </div>
    </article>
  );
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [connection, setConnection] = useState<ConnectionState>({
    state: 'disconnected',
  });
  const [bridge, setBridge] = useState<BridgeState>({ state: 'disconnected' });
  const [tab, setTab] = useState<TabInfo | null>(null);
  const [scripts, setScripts] = useState<SiteScript[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [session, setSession] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [editingScriptId, setEditingScriptId] = useState('');
  const [modelRevision, setModelRevision] = useState(0);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [view, setView] = useState<'settings' | 'sessions' | null>(
    location.hash === '#settings' ? 'settings' : null,
  );
  const [editor, setEditor] = useState<SiteScript | null>(null);
  const [scriptsOpen, setScriptsOpen] = useState(true);
  const [userScripts, setUserScripts] = useState(true);
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [questions, setQuestions] = useState<QuestionRequest[]>([]);
  const [forms, setForms] = useState<PendingForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [latestTool, setLatestTool] = useState('');
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const events = useRef<BackendEvent[]>([]);
  const loadingRef = useRef(false);
  const generation = useRef(0);
  const scroll = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);
  const composer = useRef<HTMLTextAreaElement>(null);
  const notice = useCallback((text: string) => {
    setToast(text);
  }, []);
  const perform = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    try {
      setError('');
      return await action();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const refreshPending = useCallback(async () => {
    const pending = await rpc('pending');
    setPermissions(pending.permissions || []);
    setQuestions(pending.questions || []);
    setForms(pending.forms || []);
  }, []);
  const hydrate = useCallback(
    async (id: string) => {
      const current = ++generation.current;
      loadingRef.current = true;
      events.current = [];
      try {
        const [history, statuses] = await Promise.all([
          rpc<ConversationMessage[]>('messages', { id }),
          rpc('status'),
        ]);
        if (current !== generation.current || sessionRef.current !== id) return;
        // Replay events observed while loading. Full part updates and server IDs make this idempotent.
        setMessages(events.current.reduce(reduceConversation, history || []));
        setBusy(Boolean(statuses?.[id] && statuses[id].type !== 'idle'));
        await refreshPending();
      } finally {
        if (current === generation.current) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [refreshPending],
  );
  useEffect(() => {
    let disposed = false,
      retry: ReturnType<typeof setTimeout>;
    const open = () => {
      const port = chrome.runtime.connect({ name: 'panel' });
      port.onMessage.addListener((message) => {
        const data = message.data;
        if (message.type === 'snapshot') {
          setSettings(data.settings);
          setConnection(data.connection);
          setBridge(data.bridge);
          setScripts(data.scripts);
          setProposals(data.proposals);
          setTab(data.tab);
          setUserScripts(data.userScripts);
          setSession(data.activeSession);
          sessionRef.current = data.activeSession;
          if (!data.activeSession) setLoading(false);
        }
        if (message.type === 'connection') {
          setConnection(data);
          if (data.state === 'connected') {
            setModelRevision((value) => value + 1);
            void rpc<Session[]>('sessions')
              .then(setSessions)
              .catch(() => {});
            if (sessionRef.current)
              void hydrate(sessionRef.current).catch((e) => setError(e.message));
            else setLoading(false);
          }
        }
        if (message.type === 'bridge') setBridge(data);
        if (message.type === 'tab') setTab(data);
        if (message.type === 'scripts') setScripts(data);
        if (message.type === 'proposals') setProposals(data);
        if (message.type === 'settings') setSettings(data);
        if (message.type === 'model.changed') setModelRevision((value) => value + 1);
        if (message.type === 'session') {
          setSession(data);
          sessionRef.current = data;
          if (!data) {
            setMessages([]);
            setBusy(false);
            setLoading(false);
          }
        }
        if (message.type === 'notice') setError(String(data));
        if (message.type === 'tool')
          setLatestTool(data.status === 'running' ? data.name.replaceAll('_', ' ') : '');
        if (message.type === 'resync' && sessionRef.current)
          void hydrate(sessionRef.current).catch((e) => setError(e.message));
        if (message.type === 'event') {
          const event = data as BackendEvent,
            p = event.properties;
          const eventSession = p.sessionID || p.info?.sessionID || p.part?.sessionID;
          if (
            [
              'session.created',
              'session.updated',
              'session.renamed',
              'session.deleted',
              'session.moved',
              'session.execution.succeeded',
              'session.execution.failed',
            ].includes(event.type)
          )
            void rpc<Session[]>('sessions')
              .then(setSessions)
              .catch(() => {});
          if (eventSession && eventSession !== sessionRef.current) return;
          if (loadingRef.current) events.current.push(event);
          setMessages((old) => reduceConversation(old, event));
          if (event.type === 'session.status') setBusy(p.status.type !== 'idle');
          if (
            [
              'session.idle',
              'session.execution.succeeded',
              'session.execution.failed',
              'session.execution.interrupted',
            ].includes(event.type) ||
            (event.type === 'session.status' && p.status?.type === 'idle')
          ) {
            setBusy(false);
            setLatestTool('');
            if (sessionRef.current)
              void hydrate(sessionRef.current).catch((e) => setError(e.message));
          }
          if (event.type === 'session.error' || event.type === 'session.execution.failed') {
            setBusy(false);
            setError(
              p.error?.data?.message || p.error?.message || 'OpenCode reported a session error.',
            );
          }
          if (
            event.type.startsWith('permission.') ||
            event.type.startsWith('question.') ||
            event.type.startsWith('form.')
          )
            void refreshPending().catch(() => {});
        }
      });
      port.onDisconnect.addListener(() => {
        if (!disposed)
          retry = setTimeout(() => {
            portRef = open();
          }, 1000);
      });
      return port;
    };
    let portRef = open();
    const heartbeat = setInterval(() => {
      void rpc('ping').catch(() => {});
    }, 20_000);
    return () => {
      disposed = true;
      clearTimeout(retry);
      clearInterval(heartbeat);
      portRef.disconnect();
    };
  }, [hydrate, refreshPending]);
  useEffect(() => {
    const refresh = () => {
      void rpc('snapshot')
        .then((data) => setUserScripts(data.userScripts))
        .catch(() => {});
    };
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  useEffect(() => {
    if (session && connection.state === 'connected') {
      setLoading(true);
      void hydrate(session).catch((e) => setError(e.message));
    }
  }, [session, hydrate]);
  useEffect(() => {
    if (autoScroll.current && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, proposals, busy]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(timer);
  }, [toast]);
  const send = async (text = input) => {
    if (!text.trim() || busy || sending || connection.state !== 'connected') return;
    await perform(async () => {
      setSending(true);
      try {
        let id = sessionRef.current;
        if (!id) {
          const created = await rpc<Session>('session.create');
          id = created.id;
          setSession(id);
          sessionRef.current = id;
        }
        setBusy(true);
        await rpc('send', { id, text, scriptId: editingScriptId || undefined });
        setEditingScriptId('');
        setInput('');
        autoScroll.current = true;
      } catch (error) {
        setBusy(false);
        throw error;
      } finally {
        setSending(false);
      }
    });
  };
  const selectSession = async (id: string) =>
    perform(async () => {
      await rpc('session.attach', { id });
      setMessages([]);
      setSession(id);
      sessionRef.current = id;
      setView(null);
      autoScroll.current = true;
      await hydrate(id);
    });
  const newSession = async () =>
    perform(async () => {
      const created = await rpc<Session>('session.create');
      setMessages([]);
      setSession(created.id);
      sessionRef.current = created.id;
      setView(null);
      setBusy(false);
      await hydrate(created.id);
      composer.current?.focus();
    });
  const hostname = (() => {
    try {
      return tab?.supported ? new URL(tab.url).hostname : 'Choose a website';
    } catch {
      return 'Choose a website';
    }
  })();
  const title = sessions.find((item) => item.id === session)?.title || 'New conversation';
  let unitOffset = 0;
  const currentProposals = proposals.filter((item) => item.sessionID === session);
  const connected = connection.state === 'connected';
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <Logo small />
          <h1>Open Extension</h1>
          <span className="beta-tag">LOCAL</span>
        </div>
        <div className="header-actions">
          <button
            className="icon-button"
            title="New conversation"
            aria-label="New conversation"
            disabled={!connected}
            onClick={newSession}
          >
            <Plus size={17} />
          </button>
          <button
            className={`icon-button ${view === 'sessions' ? 'selected' : ''}`}
            title="OpenCode sessions"
            aria-label="OpenCode sessions"
            onClick={() => setView(view === 'sessions' ? null : 'sessions')}
          >
            <History size={16} />
          </button>
          <button
            className={`icon-button ${view === 'settings' ? 'selected' : ''}`}
            title="Connection settings"
            aria-label="Connection settings"
            onClick={() => setView(view === 'settings' ? null : 'settings')}
          >
            <SettingsIcon size={16} />
          </button>
        </div>
      </header>
      <div className="session-bar">
        <span className="session-title" title={title}>
          {title}
        </span>
        <button
          className={`connection-pill ${connection.state}`}
          onClick={() => setView('settings')}
        >
          <i />
          {connected
            ? `OpenCode ${connection.version || ''}`
            : connection.state === 'connecting'
              ? 'Connecting'
              : connection.state === 'reconnecting'
                ? 'Reconnecting'
                : 'Not connected'}
        </button>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          <AlertCircle size={14} />
          <span>{error}</span>
          <button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}>
            <X size={14} />
          </button>
        </div>
      )}
      {view === 'settings' ? (
        <ConnectionSettings
          settings={settings}
          connection={connection}
          bridge={bridge}
          userScripts={userScripts}
          onClose={() => setView(null)}
          onSaved={(value) => {
            setSettings(value);
            void rpc('snapshot').then((data) => setUserScripts(data.userScripts));
          }}
          onError={setError}
        />
      ) : view === 'sessions' ? (
        <div className="overlay-view">
          <div className="section-heading">
            <div>
              <span className="eyebrow">SHARED WITH OPENCODE</span>
              <h2>Conversations</h2>
            </div>
            <button
              className="icon-button"
              aria-label="Close conversations"
              onClick={() => setView(null)}
            >
              <X size={17} />
            </button>
          </div>
          <button className="secondary-button full" disabled={!connected} onClick={newSession}>
            <Plus size={15} /> New conversation
          </button>
          {!sessions.length && (
            <div className="empty-inline">Connect to your local server to see its sessions.</div>
          )}
          <div className="session-list">
            {sessions.map((item) => (
              <button
                className={`session-item ${item.id === session ? 'active' : ''}`}
                key={item.id}
                onClick={() => selectSession(item.id)}
              >
                <Terminal size={15} />
                <span>
                  <strong>{item.title}</strong>
                  <small>{item.directory || 'OpenCode session'}</small>
                </span>
                <time>
                  {new Date(item.time.updated).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}
                </time>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <main
            className="conversation"
            ref={scroll}
            onScroll={() => {
              const el = scroll.current!;
              autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            {loading && connected && !messages.length ? (
              <div className="loading-state">
                <Loader2 size={20} className="spin" />
                Loading OpenCode history…
              </div>
            ) : !messages.length ? (
              <div className="welcome">
                <div className="welcome-symbol">
                  <Logo />
                </div>
                <span className="eyebrow">YOUR BROWSER. YOUR OPENCODE.</span>
                <h2>
                  A little more control.
                  <br />
                  <span>A lot more possibility.</span>
                </h2>
                <p>
                  Make the web work your way.
                  <br />
                  Describe a change. Watch it happen. Keep what works.
                </p>
                <div className="suggestions">
                  {[
                    {
                      icon: <Sparkles size={16} />,
                      title: 'Give this page a new look',
                      text: 'Restyle this page with a clean, readable dark theme. Apply the change, verify it, and propose a reversible site script.',
                    },
                    {
                      icon: <Code2 size={16} />,
                      title: 'Remove the distractions',
                      text: 'Observe this page and hide distracting sidebars and promotional elements. Keep the main content. Verify the changes and propose a reversible site script.',
                    },
                    {
                      icon: <Search size={16} />,
                      title: 'Understand this page',
                      text: 'Observe the active tab and summarize its content and interactive elements without modifying the page.',
                    },
                  ].map((item) => (
                    <button
                      key={item.title}
                      disabled={!connected || sending}
                      onClick={() => send(item.text)}
                    >
                      {item.icon}
                      <span>{item.title}</span>
                      <ArrowRight size={13} />
                    </button>
                  ))}
                </div>
                {!connected && (
                  <button className="connect-cta" onClick={() => setView('settings')}>
                    <Plug size={14} /> Connect your local OpenCode <ArrowRight size={13} />
                  </button>
                )}
                {connected && !bridge.registered && (
                  <button className="connect-cta" onClick={() => setView('settings')}>
                    <Plug size={14} /> Pair browser tools <ArrowRight size={13} />
                  </button>
                )}
                <div className="privacy-note">
                  <i />
                  Models, tools, and history stay on your OpenCode backend.
                </div>
              </div>
            ) : (
              <div className="messages">
                {messages.map((message) => {
                  const offset = unitOffset;
                  unitOffset += message.parts.filter((part) => part.type === 'step-start').length;
                  return (
                    <MessageView
                      key={message.info.id}
                      message={message}
                      offset={offset}
                      reasoning={settings.showReasoning}
                    />
                  );
                })}
              </div>
            )}
            {permissions
              .filter((item) => item.sessionID === session)
              .map((item) => (
                <div className="approval-card" key={item.id}>
                  <div className="approval-heading">
                    <AlertCircle size={15} />
                    <strong>OpenCode needs permission</strong>
                  </div>
                  <p>{item.permission}</p>
                  <pre>{item.patterns.join('\n')}</pre>
                  <div className="button-row">
                    <button
                      className="primary-button"
                      onClick={() =>
                        perform(() =>
                          rpc('permission.reply', {
                            id: item.id,
                            reply: 'once',
                          }).then(refreshPending),
                        )
                      }
                    >
                      Allow once
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() =>
                        perform(() =>
                          rpc('permission.reply', {
                            id: item.id,
                            reply: 'always',
                          }).then(refreshPending),
                        )
                      }
                    >
                      Always allow
                    </button>
                    <button
                      className="text-button"
                      onClick={() =>
                        perform(() =>
                          rpc('permission.reply', {
                            id: item.id,
                            reply: 'reject',
                          }).then(refreshPending),
                        )
                      }
                    >
                      Deny
                    </button>
                  </div>
                </div>
              ))}
            {questions
              .filter((item) => item.sessionID === session)
              .map((item) => (
                <QuestionCard
                  key={item.id}
                  request={item}
                  onError={setError}
                  onDone={refreshPending}
                />
              ))}
            {forms
              .filter((item) => item.sessionID === session)
              .map((form) => (
                <FormCard key={form.id} form={form} onDone={refreshPending} onError={setError} />
              ))}
            {currentProposals.map((proposal) => (
              <div className="approval-card site-proposal" key={proposal.id}>
                <div className="approval-heading">
                  <FileCode2 size={16} />
                  <strong>Update site script?</strong>
                  <span className="verified-label">
                    <Check size={11} /> Observed
                  </span>
                </div>
                <h3>{proposal.name}</h3>
                <p>{proposal.description}</p>
                <div className="domain-tags">
                  {proposal.matches.map((pattern) => (
                    <code key={pattern}>{pattern}</code>
                  ))}
                </div>
                <details>
                  <summary>
                    Review code <ChevronDown size={12} />
                  </summary>
                  <pre>{proposal.code}</pre>
                </details>
                <div className="button-row">
                  <button
                    className="primary-button"
                    onClick={() =>
                      perform(async () => {
                        await rpc('proposal.approve', { id: proposal.id });
                        notice('Site script saved and enabled.');
                      })
                    }
                  >
                    <Check size={13} />
                    {proposal.scriptId ? 'Update script' : 'Save site script'}
                  </button>
                  <button
                    className="text-button"
                    onClick={() => perform(() => rpc('proposal.dismiss', { id: proposal.id }))}
                  >
                    Keep temporary
                  </button>
                </div>
              </div>
            ))}
            {busy && (
              <div className="working-indicator">
                <span className="working-dots">
                  <i />
                  <i />
                  <i />
                </span>
                <span>{latestTool || 'OpenCode is working'}</span>
              </div>
            )}
            {!autoScroll.current && messages.length > 2 && (
              <button
                className="scroll-bottom"
                onClick={() => {
                  autoScroll.current = true;
                  scroll.current?.scrollTo({
                    top: scroll.current.scrollHeight,
                    behavior: 'smooth',
                  });
                }}
              >
                <ChevronDown size={14} />
                Latest
              </button>
            )}
          </main>
          <section className={`scripts-section ${scriptsOpen ? 'expanded' : ''}`}>
            <div className="scripts-heading">
              <button
                className="section-toggle"
                onClick={() => setScriptsOpen(!scriptsOpen)}
                aria-expanded={scriptsOpen}
              >
                <ChevronRight size={13} className={scriptsOpen ? 'rotated' : ''} />
                <FileCode2 size={13} />
                <span>Site scripts</span>
                <span className="count-badge">{scripts.length}</span>
              </button>
              <div>
                <button
                  className="icon-button"
                  aria-label="Undo temporary changes"
                  title="Undo temporary changes made with cleanup helpers"
                  onClick={() =>
                    perform(async () => {
                      await rpc('experiments.reset');
                      notice('Temporary changes cleaned up. Reload to clear untracked JavaScript.');
                    })
                  }
                >
                  <Undo2 size={13} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Add site script"
                  title="Add site script"
                  onClick={() =>
                    setEditor({
                      id: crypto.randomUUID(),
                      name: '',
                      description: '',
                      matches: [`*://${hostname.includes('.') ? hostname : 'example.com'}/*`],
                      code: '// Changes made with api are undone when this script is disabled.\napi.css(`\n  /* Your CSS here */\n`);',
                      enabled: true,
                      world: 'USER_SCRIPT',
                      revision: 1,
                      createdAt: Date.now(),
                      updatedAt: Date.now(),
                    })
                  }
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>
            {scriptsOpen && (
              <div className="scripts-list">
                {!scripts.length ? (
                  <div className="empty-scripts">
                    <span>No saved scripts yet.</span>
                    <span>Keep a change after OpenCode verifies it.</span>
                  </div>
                ) : (
                  scripts.map((script) => (
                    <div
                      className={`script-item ${script.enabled ? '' : 'disabled'}`}
                      key={script.id}
                    >
                      <span className="script-icon">
                        <Code2 size={15} />
                      </span>
                      <button
                        className="script-description"
                        onClick={() => setEditor(script)}
                        title="Review or edit script"
                      >
                        <strong>{script.name}</strong>
                        <span className="script-domains">
                          {script.matches
                            .map((pattern) => pattern.replace(/^\*:\/\//, '').replace(/\/\*$/, ''))
                            .join(', ')}
                        </span>
                        <small>{script.description}</small>
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Update ${script.name} with OpenCode`}
                        title="Teach this script another page layout"
                        disabled={
                          !connected ||
                          !tab?.supported ||
                          !script.matches.some((pattern) => matchesUrl(pattern, tab.url))
                        }
                        onClick={() => {
                          setEditingScriptId(script.id);
                          composer.current?.focus();
                        }}
                      >
                        <Sparkles size={13} />
                      </button>
                      <button
                        className={`toggle ${script.enabled ? 'on' : ''}`}
                        role="switch"
                        aria-checked={script.enabled}
                        aria-label={`Enable ${script.name}`}
                        onClick={() =>
                          perform(() =>
                            rpc('scripts.toggle', {
                              id: script.id,
                              enabled: !script.enabled,
                            }),
                          )
                        }
                      >
                        <i />
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </section>
          <div className="composer-area">
            <div className={`composer ${!connected ? 'inactive' : ''}`}>
              {editingScriptId && (
                <div className="script-context">
                  <FileCode2 size={12} />
                  <span>
                    Update{' '}
                    {scripts.find((script) => script.id === editingScriptId)?.name || 'site script'}
                  </span>
                  <button
                    className="icon-button"
                    aria-label="Cancel script update"
                    onClick={() => setEditingScriptId('')}
                  >
                    <X size={12} />
                  </button>
                </div>
              )}
              {connected && (
                <div className="model-row">
                  <ModelPicker
                    session={session}
                    revision={modelRevision}
                    preference={settings.model}
                    disabled={busy || sending}
                    onError={setError}
                  />
                  <span
                    className="browser-mode"
                    title="Only this website’s DOM tools are available to the agent"
                  >
                    Browser only
                  </span>
                </div>
              )}
              <textarea
                ref={composer}
                aria-label="Message OpenCode"
                placeholder={
                  connected
                    ? editingScriptId
                      ? 'What should this script also change on this page?'
                      : 'What would you like to change on this website?'
                    : 'Connect OpenCode to get started…'
                }
                value={input}
                disabled={!connected}
                rows={2}
                onChange={(event) => {
                  setInput(event.target.value);
                  event.target.style.height = 'auto';
                  event.target.style.height = `${Math.min(160, event.target.scrollHeight)}px`;
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="composer-tools">
                <span
                  className={`tab-context ${tab?.supported ? '' : 'unsupported'}`}
                  title={tab?.url || 'Select a website'}
                >
                  <Globe2 size={12} />
                  <span>{hostname}</span>
                </span>
                <div className="composer-right">
                  <span className="key-hint">↵</span>
                  {busy ? (
                    <button
                      className="send-button stop"
                      aria-label="Stop OpenCode"
                      onClick={() =>
                        perform(() => rpc('abort', { id: session }).then(() => setBusy(false)))
                      }
                    >
                      <Square size={12} fill="currentColor" />
                    </button>
                  ) : (
                    <button
                      className="send-button"
                      aria-label="Send message"
                      disabled={!connected || !input.trim() || sending}
                      onClick={() => send()}
                    >
                      {sending ? <Loader2 size={15} className="spin" /> : <ArrowUp size={17} />}
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="bottom-bar">
              <span className="this-tab" title={tab?.title}>
                <Monitor size={12} />
                This tab
                <span className={`tiny-dot ${tab?.supported ? 'green' : ''}`} />
              </span>
              <div>
                <AgentPicker
                  value={settings.agent || 'build'}
                  disabled={!connected || busy}
                  onChange={(agent) => perform(() => rpc('preferences.agent', { agent }))}
                  onError={setError}
                />
                <button
                  className="fast-open"
                  title="Open the local OpenCode web client"
                  onClick={() => perform(() => rpc('fast.open'))}
                >
                  Fast Open
                  <ExternalLink size={11} />
                </button>
              </div>
            </div>
          </div>
        </>
      )}
      {editor && (
        <ScriptEditor
          script={editor}
          onClose={() => setEditor(null)}
          onError={setError}
          onSaved={() => {
            setEditor(null);
            notice('Site script updated.');
          }}
        />
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={14} />
          {toast}
        </div>
      )}
    </div>
  );
}

function AgentPicker({
  value,
  disabled,
  onChange,
  onError,
}: {
  value: string;
  disabled: boolean;
  onChange: (agent: string) => Promise<unknown>;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [agents, setAgents] = useState<{ name: string; displayName?: string; description?: string }[]>(
      [],
    );
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  return (
    <div className="agent-picker" ref={container}>
      <button
        className="mode-button"
        aria-label="Choose OpenCode agent"
        aria-expanded={open}
        disabled={disabled}
        title="Choose an agent from your OpenCode backend"
        onClick={async () => {
          if (open) {
            setOpen(false);
            return;
          }
          try {
            const available = await rpc('agents');
            setAgents(available.filter((agent: any) => agent.mode !== 'subagent' && !agent.hidden));
            setOpen(true);
          } catch (error) {
            onError((error as Error).message);
          }
        }}
      >
        <Terminal size={12} />
        {value.charAt(0).toUpperCase() + value.slice(1)}
        <ChevronDown size={10} />
      </button>
      {open && (
        <div className="agent-menu" role="menu" aria-label="OpenCode agents">
          {agents.map((agent) => (
            <button
              key={agent.name}
              role="menuitemradio"
              aria-checked={value === agent.name}
              onClick={async () => {
                await onChange(agent.name);
                setOpen(false);
              }}
            >
              <span>
                <strong>{agent.displayName || agent.name}</strong>
                {agent.description && <small>{agent.description}</small>}
              </span>
              {value === agent.name && <Check size={12} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ConnectionSettings({
  settings,
  connection,
  bridge,
  userScripts,
  onClose,
  onSaved,
  onError,
}: {
  settings: Settings;
  connection: ConnectionState;
  bridge: BridgeState;
  userScripts: boolean;
  onClose: () => void;
  onSaved: (value: Settings) => void;
  onError: (message: string) => void;
}) {
  const [form, setForm] = useState(settings),
    [pairLink, setPairLink] = useState(''),
    [saving, setSaving] = useState(false),
    [finding, setFinding] = useState(false),
    [found, setFound] = useState<any[]>([]),
    [models, setModels] = useState<{ value: string; label: string }[]>([]);
  const change = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setForm((old) => ({ ...old, [key]: value }));
  useEffect(() => {
    if (connection.state !== 'connected') return;
    void rpc('models')
      .then((data) => {
        setModels(
          data.models
            .filter((model: any) => model.tools)
            .map((model: any) => ({
              value: model.value,
              label: `${model.name} · ${model.provider}`,
            })),
        );
      })
      .catch(() => {});
  }, [connection.state]);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    onError('');
    try {
      if (pairLink.trim()) await rpc('pair.connect', { settings: form, link: pairLink.trim() });
      else await rpc('settings.save', form);
      const current = await rpc('snapshot');
      setForm(current.settings);
      onSaved(current.settings);
      setPairLink('');
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="overlay-view settings-view" onSubmit={save}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">LOCAL FIRST. ALWAYS.</span>
          <h2>Connection</h2>
        </div>
        <button type="button" className="icon-button" aria-label="Close settings" onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      <p className="view-description">
        Connect to the OpenCode service already running on your machine.
      </p>
      <div className="permission-setup">
        <strong>Connect OpenCode 2</strong>
        <p>
          Run <code>opencode pair</code>, then paste a fresh link below without opening it in the
          browser. The extension exchanges it for its own session credential.
        </p>
        <label>
          OpenCode pairing link
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={pairLink}
            onChange={(event) => setPairLink(event.target.value)}
            placeholder="http://127.0.0.1:49374/auth/connect/…"
          />
        </label>
        <small className="field-note">
          Or enter the service URL and its actual password below. The browser bridge token is
          separate.
        </small>
      </div>
      <label>
        Server URL
        <div className="input-with-button">
          <input
            autoComplete="url"
            value={form.serverUrl}
            onChange={(event) => change('serverUrl', event.target.value)}
            placeholder="http://127.0.0.1:49374"
            required
          />
          <button
            type="button"
            className="secondary-button"
            disabled={finding}
            onClick={async () => {
              setFinding(true);
              try {
                setFound(await rpc('discover', form));
              } catch (e) {
                onError((e as Error).message);
              } finally {
                setFinding(false);
              }
            }}
          >
            {finding ? <Loader2 size={13} className="spin" /> : <Search size={13} />}
            Discover
          </button>
        </div>
      </label>
      {finding && (
        <small className="field-note">Checking configured URL and common localhost ports…</small>
      )}
      {found.length > 0 && (
        <div className="discovered">
          {found.map((item) => (
            <button type="button" key={item.url} onClick={() => change('serverUrl', item.url)}>
              <span>{item.url}</span>
              <small>
                {item.authRequired
                  ? 'Auth required · verify on connect'
                  : `OpenCode ${item.version}`}
              </small>
            </button>
          ))}
        </div>
      )}
      <small className="field-note">
        Common ports: 49374 (OpenCode 2 on macOS/Linux), 45278 (Windows), 4096 (legacy). A
        configured .local hostname also works through your system resolver.
      </small>
      <div className="two-columns">
        <label>
          Username
          <input
            autoComplete="username"
            value={form.username}
            onChange={(event) => change('username', event.target.value)}
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete="current-password"
            value={form.password}
            onChange={(event) => change('password', event.target.value)}
            placeholder="Server password"
          />
        </label>
      </div>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={form.rememberPassword}
          onChange={(event) => change('rememberPassword', event.target.checked)}
        />
        Remember password on this device
      </label>
      <small className="field-note">
        Otherwise held only for this browser session. Chrome local storage is not an encrypted
        credential vault.
      </small>
      <label>
        Project directory <span className="optional">optional</span>
        <input
          value={form.directory}
          onChange={(event) => change('directory', event.target.value)}
          placeholder="Use the server’s current project"
        />
      </label>
      <label>
        Model
        <select value={form.model} onChange={(event) => change('model', event.target.value)}>
          <option value="">OpenCode default</option>
          {models.map((model) => (
            <option key={model.value} value={model.value}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
      <div className="settings-divider" />
      <div className="subsection-heading">
        <h3>Browser tools</h3>
        <span className={`status-label ${bridge.registered ? 'good' : ''}`}>
          <i />
          {bridge.registered
            ? 'Ready in OpenCode'
            : bridge.state === 'connected'
              ? 'Paired · waiting for OpenCode'
              : bridge.state === 'connecting'
                ? 'Connecting bridge'
                : 'Bridge offline'}
        </span>
      </div>
      <p className="view-description">
        The local bridge makes this tab available as real MCP tools inside OpenCode.
      </p>
      <div className="setup-command">
        <code>npm run bridge</code>
        <button
          type="button"
          className="icon-button"
          aria-label="Copy bridge command"
          onClick={() => void navigator.clipboard.writeText('npm run bridge')}
        >
          <Copy size={13} />
        </button>
      </div>
      <small className="field-note">
        Run from the Open Extension project folder. Paste the pairing token printed in that
        terminal.
      </small>
      <label>
        Bridge URL
        <input
          value={form.bridgeUrl}
          onChange={(event) => change('bridgeUrl', event.target.value)}
          placeholder="http://127.0.0.1:49375"
        />
      </label>
      <label>
        Browser bridge token
        <input
          type="password"
          autoComplete="off"
          value={form.bridgeToken}
          onChange={(event) => change('bridgeToken', event.target.value)}
          placeholder="Token from the bridge terminal"
        />
      </label>
      {bridge.error && <p className="field-note error-text">{bridge.error}</p>}
      <div className={`permission-setup ${userScripts ? 'ready' : ''}`}>
        <div>
          <Code2 size={15} />
          <strong>Chrome user scripts</strong>
          <span>{userScripts ? 'Enabled' : 'Enable to execute code'}</span>
        </div>
        <p>
          In the extension’s Details, turn on <b>Allow User Scripts</b>. This lets OpenCode apply
          and save page code.
        </p>
        <button type="button" className="text-button" onClick={() => void rpc('extensions.open')}>
          Open extension details <ExternalLink size={12} />
        </button>
      </div>
      <label className="checkbox-label">
        <input
          type="checkbox"
          checked={form.showReasoning}
          onChange={(event) => change('showReasoning', event.target.checked)}
        />
        Show reasoning provided by OpenCode
      </label>
      <div className="connection-details">
        <span className={`tiny-dot ${connection.state === 'connected' ? 'green' : ''}`} />
        {connection.state === 'connected'
          ? `OpenCode ${connection.version} · authenticated`
          : connection.error || 'Waiting for a local server'}
        {connection.spec && <small>{connection.spec}</small>}
      </div>
      <button className="primary-button full" type="submit" disabled={saving}>
        {saving ? <Loader2 size={14} className="spin" /> : <Plug size={14} />}
        {saving ? 'Connecting…' : pairLink.trim() ? 'Pair & connect' : 'Save & connect'}
      </button>
    </form>
  );
}
function FormCard({
  form,
  onDone,
  onError,
}: {
  form: PendingForm;
  onDone: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [answer, setAnswer] = useState<Record<string, string | number | boolean | string[]>>(() =>
    Object.fromEntries(
      form.fields
        .filter(
          (field) =>
            field.type === 'boolean' ||
            (field.type !== 'external' && 'default' in field && field.default !== undefined),
        )
        .map((field) => [field.key, (field as any).default ?? false]),
    ),
  );
  const [submitting, setSubmitting] = useState(false);
  const visible = form.fields.filter(
    (field) =>
      !('hidden' in field && field.hidden) &&
      (!('when' in field) ||
        !field.when ||
        field.when.every((condition) =>
          condition.op === 'eq'
            ? answer[condition.key] === condition.value
            : answer[condition.key] !== condition.value,
        )),
  );
  const update = (key: string, value: string | number | boolean | string[]) =>
    setAnswer((old) => ({ ...old, [key]: value }));
  return (
    <form
      className="approval-card question-card"
      onSubmit={async (event) => {
        event.preventDefault();
        setSubmitting(true);
        try {
          const keys = new Set(visible.map((field) => field.key));
          await rpc('form.reply', {
            id: form.id,
            answer: Object.fromEntries(Object.entries(answer).filter(([key]) => keys.has(key))),
          });
          await onDone();
        } catch (error) {
          onError((error as Error).message);
        } finally {
          setSubmitting(false);
        }
      }}
    >
      <div className="approval-heading">
        <Terminal size={14} />
        <strong>{form.title}</strong>
      </div>
      {visible.map((field) => (
        <fieldset key={field.key}>
          <legend>{field.title || field.key}</legend>
          {field.description && <p>{field.description}</p>}
          {field.type === 'external' ? (
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                if (/^https?:\/\//.test(field.url)) void chrome.tabs.create({ url: field.url });
              }}
            >
              Open requested page <ExternalLink size={12} />
            </button>
          ) : field.type === 'boolean' ? (
            <label className="question-option">
              <input
                type="checkbox"
                checked={Boolean(answer[field.key])}
                onChange={(event) => update(field.key, event.target.checked)}
              />
              <span>{field.title || 'Yes'}</span>
            </label>
          ) : field.type === 'multiselect' ? (
            <>
              {field.options.map((option) => (
                <label className="question-option" key={option.value}>
                  <input
                    type="checkbox"
                    checked={
                      Array.isArray(answer[field.key]) &&
                      (answer[field.key] as string[]).includes(option.value)
                    }
                    onChange={(event) => {
                      const old = Array.isArray(answer[field.key])
                        ? (answer[field.key] as string[])
                        : [];
                      update(
                        field.key,
                        event.target.checked
                          ? [...old, option.value]
                          : old.filter((value) => value !== option.value),
                      );
                    }}
                  />
                  <span>
                    {option.label}
                    {option.description && <small>{option.description}</small>}
                  </span>
                </label>
              ))}
            </>
          ) : field.type === 'string' && field.options?.length && !field.custom ? (
            <select
              aria-label={field.title || field.key}
              required={field.required}
              value={String(answer[field.key] ?? '')}
              onChange={(event) => update(field.key, event.target.value)}
            >
              <option value="">Choose…</option>
              {field.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-label={field.title || field.key}
              type={
                field.type === 'number' || field.type === 'integer'
                  ? 'number'
                  : field.type === 'string' && field.format === 'email'
                    ? 'email'
                    : 'text'
              }
              required={field.required}
              value={String(answer[field.key] ?? '')}
              step={field.type === 'integer' ? 1 : 'any'}
              min={'minimum' in field ? field.minimum : undefined}
              max={'maximum' in field ? field.maximum : undefined}
              placeholder={'placeholder' in field ? field.placeholder : undefined}
              minLength={'minLength' in field ? field.minLength : undefined}
              maxLength={'maxLength' in field ? field.maxLength : undefined}
              pattern={'pattern' in field ? field.pattern : undefined}
              onChange={(event) =>
                update(
                  field.key,
                  field.type === 'number' || field.type === 'integer'
                    ? Number(event.target.value)
                    : event.target.value,
                )
              }
            />
          )}
        </fieldset>
      ))}
      <div className="button-row">
        <button className="primary-button" disabled={submitting}>
          {submitting ? 'Sending…' : 'Send answers'}
        </button>
        <button
          className="text-button"
          type="button"
          disabled={submitting}
          onClick={async () => {
            try {
              await rpc('form.cancel', { id: form.id });
              await onDone();
            } catch (error) {
              onError((error as Error).message);
            }
          }}
        >
          Dismiss
        </button>
      </div>
    </form>
  );
}

function ScriptEditor({
  script,
  onClose,
  onSaved,
  onError,
}: {
  script: SiteScript;
  onClose: () => void;
  onSaved: () => void;
  onError: (text: string) => void;
}) {
  const [form, setForm] = useState(script),
    [patterns, setPatterns] = useState(script.matches.join('\n')),
    [saving, setSaving] = useState(false),
    [deleting, setDeleting] = useState(false);
  return (
    <div className="modal-backdrop">
      <form
        className="script-editor"
        onSubmit={async (event) => {
          event.preventDefault();
          setSaving(true);
          try {
            await rpc('scripts.save', {
              ...form,
              matches: patterns
                .split(/[\n,]/)
                .map((item) => item.trim())
                .filter(Boolean),
            });
            onSaved();
          } catch (e) {
            onError((e as Error).message);
          } finally {
            setSaving(false);
          }
        }}
      >
        <div className="section-heading">
          <div>
            <span className="eyebrow">PERSISTENT & REVERSIBLE</span>
            <h2>Site script</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close script editor"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </div>
        <label>
          Name
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            maxLength={100}
            required
          />
        </label>
        <label>
          Description
          <input
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            maxLength={500}
          />
        </label>
        <label>
          Domain matchers
          <textarea
            rows={2}
            value={patterns}
            onChange={(e) => setPatterns(e.target.value)}
            spellCheck={false}
            required
          />
        </label>
        <label>
          Execution context
          <select
            value={form.world}
            onChange={(e) => setForm({ ...form, world: e.target.value as SiteScript['world'] })}
          >
            <option value="USER_SCRIPT">Isolated user script · DOM access</option>
            <option value="MAIN">Page context · DOM and page globals</option>
          </select>
        </label>
        <label className="code-label">
          JavaScript <span className="optional">async function body · api available</span>
          <textarea
            className="code-editor"
            value={form.code}
            onChange={(e) => setForm({ ...form, code: e.target.value })}
            spellCheck={false}
            required
          />
        </label>
        <details className="api-help">
          <summary>
            Reversible scripting API <ChevronDown size={12} />
          </summary>
          <p>
            Use <code>api.css</code>, <code>hide</code>, <code>remove</code>, <code>text</code>,{' '}
            <code>attr</code>, <code>append</code>, <code>on</code>, <code>watch</code>,{' '}
            <code>interval</code>, <code>timeout</code> and <code>onCleanup</code>. Scripts run
            again after SPA URL changes. Keep callbacks idempotent. A toggle immediately undoes
            tracked effects. Reload to clear arbitrary untracked page state; clicks and network
            effects cannot be undone.
          </p>
          <pre>
            {
              'api.css(".promo { display: none !important }");\napi.watch(() => {\n  api.text(".page-title", "My workspace");\n});'
            }
          </pre>
        </details>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          Enabled on matching pages
        </label>
        <div className="button-row editor-footer">
          {deleting ? (
            <>
              <span>Delete this script?</span>
              <button
                type="button"
                className="danger-button"
                onClick={async () => {
                  try {
                    await rpc('scripts.delete', { id: script.id });
                    onSaved();
                  } catch (e) {
                    onError((e as Error).message);
                  }
                }}
              >
                Delete
              </button>
              <button type="button" className="text-button" onClick={() => setDeleting(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button
              className="icon-button danger"
              type="button"
              title="Delete script"
              aria-label="Delete script"
              onClick={() => setDeleting(true)}
            >
              <Trash2 size={15} />
            </button>
          )}
          <button className="primary-button" type="submit" disabled={saving}>
            {saving ? <Loader2 size={13} className="spin" /> : <Check size={13} />}
            Save script
          </button>
        </div>
      </form>
    </div>
  );
}
function QuestionCard({
  request,
  onError,
  onDone,
}: {
  request: QuestionRequest;
  onError: (text: string) => void;
  onDone: () => Promise<void>;
}) {
  const [answers, setAnswers] = useState<string[][]>(request.questions.map(() => []));
  return (
    <form
      className="approval-card question-card"
      onSubmit={async (event) => {
        event.preventDefault();
        try {
          await rpc('question.reply', { id: request.id, answers });
          await onDone();
        } catch (e) {
          onError((e as Error).message);
        }
      }}
    >
      {request.questions.map((question, index) => (
        <fieldset key={index}>
          <legend>{question.question}</legend>
          {question.options.map((option) => (
            <label className="question-option" key={option.label}>
              <input
                type={question.multiple ? 'checkbox' : 'radio'}
                name={`question-${request.id}-${index}`}
                checked={answers[index].includes(option.label)}
                onChange={() =>
                  setAnswers((old) =>
                    old.map((answer, i) =>
                      i !== index
                        ? answer
                        : question.multiple
                          ? answer.includes(option.label)
                            ? answer.filter((value) => value !== option.label)
                            : [...answer, option.label]
                          : [option.label],
                    ),
                  )
                }
              />
              <span>
                {option.label}
                <small>{option.description}</small>
              </span>
            </label>
          ))}
          <input
            aria-label={`Custom answer to ${question.question}`}
            placeholder="Or write an answer…"
            onChange={(event) =>
              setAnswers((old) =>
                old.map((answer, i) => (i === index ? [event.target.value] : answer)),
              )
            }
          />
        </fieldset>
      ))}
      <div className="button-row">
        <button
          className="primary-button"
          disabled={answers.some((answer) => !answer.length || !answer[0].trim())}
        >
          Send answers
        </button>
        <button
          type="button"
          className="text-button"
          onClick={async () => {
            try {
              await rpc('question.reject', { id: request.id });
              await onDone();
            } catch (e) {
              onError((e as Error).message);
            }
          }}
        >
          Dismiss
        </button>
      </div>
    </form>
  );
}
