import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Code2,
  FileCode2,
  Globe2,
  Plus,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type { SiteScript, TabInfo } from '../shared/types';
import {
  filterScripts,
  scriptMatchesSite,
  scriptWebsites,
  siteHostname,
  type ScriptSort,
} from '../shared/script-library';

type Preferences = { sort: ScriptSort; status: 'all' | 'enabled' | 'disabled' };
export function ScriptsView({
  scripts,
  tab,
  connected,
  onClose,
  onAdd,
  onEdit,
  onUpdate,
  onToggle,
  onDelete,
}: {
  scripts: SiteScript[];
  tab: TabInfo | null;
  connected: boolean;
  onClose: () => void;
  onAdd: () => void;
  onEdit: (script: SiteScript) => void;
  onUpdate: (script: SiteScript) => void;
  onToggle: (script: SiteScript) => void;
  onDelete: (script: SiteScript) => Promise<void>;
}) {
  const host = siteHostname(tab?.url);
  const [scope, setScope] = useState<'site' | 'all'>(host ? 'site' : 'all');
  const [query, setQuery] = useState('');
  const [prefs, setPrefs] = useState<Preferences>({ sort: 'website', status: 'all' });
  const [deleting, setDeleting] = useState('');
  const [confirmDelete, setConfirmDelete] = useState('');
  useEffect(() => {
    void chrome.storage.local.get('scriptLibraryPreferences').then((value) => {
      const stored = value.scriptLibraryPreferences as Partial<Preferences> | undefined;
      if (
        stored &&
        ['website', 'name', 'updated'].includes(stored.sort || '') &&
        ['all', 'enabled', 'disabled'].includes(stored.status || '')
      )
        setPrefs(stored as Preferences);
    });
  }, []);
  const preference = (value: Partial<Preferences>) => {
    const next = { ...prefs, ...value };
    setPrefs(next);
    void chrome.storage.local.set({ scriptLibraryPreferences: next });
  };
  const filtered = filterScripts(scripts, {
    ...prefs,
    query,
    ...(scope === 'site' && host ? { site: tab!.url } : {}),
  });
  const siteCount = scripts.filter((script) => scriptMatchesSite(script, tab?.url)).length;
  return (
    <section className="scripts-view" aria-label="Site scripts library">
      <div className="library-heading">
        <button className="icon-button" aria-label="Back to chat" onClick={onClose}>
          <ArrowLeft size={17} />
        </button>
        <h2>Site scripts</h2>
        <span className="library-count">{scripts.length}</span>
        <button
          className="icon-button"
          aria-label="Add site script"
          title="Add site script"
          onClick={onAdd}
        >
          <Plus size={17} />
        </button>
      </div>
      <div className="library-controls">
        <div className="scope-tabs" role="group" aria-label="Script website filter">
          <button aria-pressed={scope === 'site'} disabled={!host} onClick={() => setScope('site')}>
            <Globe2 size={12} />
            This site <span>{siteCount}</span>
          </button>
          <button aria-pressed={scope === 'all' || !host} onClick={() => setScope('all')}>
            All sites <span>{scripts.length}</span>
          </button>
        </div>
        <div className="library-site-label">
          {scope === 'site' && host ? host : 'Scripts across your websites'}
        </div>
        <div className="library-search">
          <Search size={14} />
          <input
            aria-label="Search site scripts"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search scripts or websites…"
          />
          {query && (
            <button
              className="icon-button"
              aria-label="Clear script search"
              onClick={() => setQuery('')}
            >
              <X size={12} />
            </button>
          )}
        </div>
        <div className="library-sort">
          <label>
            Sort{' '}
            <select
              aria-label="Sort site scripts"
              value={prefs.sort}
              onChange={(event) => preference({ sort: event.target.value as ScriptSort })}
            >
              <option value="website">Website</option>
              <option value="name">Name</option>
              <option value="updated">Recently updated</option>
            </select>
          </label>
          <select
            aria-label="Filter script status"
            value={prefs.status}
            onChange={(event) =>
              preference({ status: event.target.value as Preferences['status'] })
            }
          >
            <option value="all">Any status</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>
      </div>
      <div className="library-list">
        {!filtered.length && (
          <div className="library-empty">
            <FileCode2 size={24} />
            <strong>{scripts.length ? 'No matching scripts' : 'Make this website yours'}</strong>
            <p>
              {scripts.length
                ? 'Try All sites or change your filters.'
                : 'Ask the agent to change a page, then approve its site script to keep the change.'}
            </p>
            {scope === 'site' && scripts.length > 0 && (
              <button
                className="text-button"
                onClick={() => {
                  setScope('all');
                  setQuery('');
                  preference({ status: 'all' });
                }}
              >
                Show all scripts
              </button>
            )}
          </div>
        )}
        {filtered.map((script) => (
          <article className={`library-script ${script.enabled ? '' : 'disabled'}`} key={script.id}>
            <div className="library-script-top">
              <button
                className="library-script-title"
                onClick={() => onEdit(script)}
                title="Review or edit script"
              >
                {script.name}
              </button>
              <button
                className={`toggle ${script.enabled ? 'on' : ''}`}
                role="switch"
                aria-checked={script.enabled}
                aria-label={`Enable ${script.name}`}
                onClick={() => onToggle(script)}
              >
                <i />
              </button>
              <button
                className="icon-button"
                aria-label={`Delete ${script.name}`}
                onClick={() => setConfirmDelete(confirmDelete === script.id ? '' : script.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="library-domains">
              {scriptWebsites(script)
                .map((domain) => (domain === '*' ? 'All websites' : domain))
                .join(', ')}
            </div>
            <p>{script.description}</p>
            <div className="library-script-actions">
              <button className="text-button" onClick={() => onEdit(script)}>
                <Code2 size={12} />
                Edit code
              </button>
              <button
                className="text-button"
                aria-label={`Update ${script.name} with OpenCode`}
                disabled={!connected || !tab?.supported || !scriptMatchesSite(script, tab?.url)}
                onClick={() => onUpdate(script)}
              >
                <Sparkles size={12} />
                Update with agent
              </button>
            </div>
            {confirmDelete === script.id && (
              <div className="library-delete" role="alert">
                <span>Delete this script and undo its changes?</span>
                <button
                  className="text-button"
                  disabled={!!deleting}
                  onClick={() => setConfirmDelete('')}
                >
                  Cancel
                </button>
                <button
                  className="danger-button"
                  disabled={!!deleting}
                  onClick={async () => {
                    setDeleting(script.id);
                    try {
                      await onDelete(script);
                      setConfirmDelete('');
                    } finally {
                      setDeleting('');
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
