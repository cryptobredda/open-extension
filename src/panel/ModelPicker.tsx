import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Cpu, Loader2, RefreshCw, Search } from 'lucide-react';
import type { ModelCatalog } from '../shared/types';
import { rpc } from './api';

export function ModelPicker({
  session,
  revision,
  preference,
  disabled,
  onError,
}: {
  session: string;
  revision: number;
  preference: string;
  disabled: boolean;
  onError: (message: string) => void;
}) {
  const [catalog, setCatalog] = useState<ModelCatalog>({ models: [], selected: '', default: '' });
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false);
  const container = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const request = useRef(0);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  const refresh = async () => {
    const current = ++request.current;
    setLoading(true);
    try {
      const result = await rpc<ModelCatalog>('models');
      if (current === request.current) setCatalog(result);
    } catch (error) {
      if (current === request.current) onError((error as Error).message);
    } finally {
      if (current === request.current) setLoading(false);
    }
  };
  useEffect(() => {
    void refresh();
    return () => {
      request.current++;
    };
  }, [session, revision]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  const selectedValue = session ? catalog.selected : preference || catalog.default;
  const selected = catalog.models.find((model) => model.value === selectedValue);
  const choose = async (value: string) => {
    setSaving(true);
    try {
      setCatalog(await rpc<ModelCatalog>('preferences.model', { model: value }));
      setOpen(false);
      trigger.current?.focus();
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const filtered = catalog.models
    .filter((model) =>
      `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(query.toLowerCase()),
    )
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
  return (
    <div className="model-picker" ref={container}>
      <button
        ref={trigger}
        className="model-trigger"
        aria-label="Choose OpenCode model"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled || saving}
        title={
          selected ? `${selected.name} · ${selected.provider}` : 'Select a connected OpenCode model'
        }
        onClick={() => {
          setOpen(!open);
          setQuery('');
          if (!open) void refresh();
        }}
      >
        {saving ? <Loader2 size={12} className="spin" /> : <Cpu size={12} />}
        <span>{selected?.name || (loading ? 'Loading models…' : 'Select model')}</span>
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className="model-menu">
          <div className="model-search">
            <Search size={13} />
            <input
              autoFocus
              aria-label="Search OpenCode models"
              placeholder="Search connected models…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  container.current
                    ?.querySelector<HTMLButtonElement>('[role="option"]:not(:disabled)')
                    ?.focus();
                }
              }}
            />
            <button
              className="icon-button"
              aria-label="Refresh connected models"
              disabled={loading}
              onClick={() => void refresh()}
            >
              <RefreshCw size={12} className={loading ? 'spin' : ''} />
            </button>
          </div>
          <div
            className="model-options"
            role="listbox"
            aria-label="Connected OpenCode models"
            onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const options = Array.from(
                event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
              );
              const index = options.indexOf(document.activeElement as HTMLButtonElement);
              options[
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? options.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) %
                      options.length
              ]?.focus();
            }}
          >
            {!query && (
              <button
                role="option"
                aria-selected={!preference && selectedValue === catalog.default}
                disabled={saving || !catalog.default}
                onClick={() => void choose('')}
              >
                <span>
                  <strong>OpenCode default</strong>
                  <small>
                    {catalog.models.find((model) => model.value === catalog.default)?.name ||
                      'Configure a default in OpenCode'}
                  </small>
                </span>
                {!preference && selectedValue === catalog.default && <Check size={13} />}
              </button>
            )}
            {filtered.map((model) => (
              <button
                key={model.value}
                role="option"
                aria-selected={selectedValue === model.value}
                disabled={saving || !model.tools}
                onClick={() => void choose(model.value)}
              >
                <span>
                  <strong>{model.name}</strong>
                  <small>
                    {model.provider}
                    {!model.tools ? ' · No browser tool support' : ''}
                  </small>
                </span>
                {selectedValue === model.value && <Check size={13} />}
              </button>
            ))}
            {!filtered.length && (
              <p className="model-empty">
                {loading
                  ? 'Loading from OpenCode…'
                  : query
                    ? 'No matching models.'
                    : 'No connected models. Connect a provider in OpenCode, then refresh.'}
              </p>
            )}
          </div>
          <div className="model-menu-note">
            Models and credentials come from your OpenCode server.
          </div>
        </div>
      )}
    </div>
  );
}
