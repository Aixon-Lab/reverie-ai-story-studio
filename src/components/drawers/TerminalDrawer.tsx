/**
 * Terminal — every model call this session, as it happens.
 *
 * Shows what a terminal shows: the call, the full assembled prompt (system,
 * memory, persona, history — exactly the bytes that went over the wire), the
 * reply, timings and sizes. It is the answer to "what did the model actually
 * see", which is otherwise unanswerable from inside the app.
 *
 * Session-only by design. The buffer lives in the server process, so closing the
 * app is a wipe; nothing is written to disk and nothing enters the vault.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Download, Trash2 } from 'lucide-react';
import { GlobeLoader } from '../GlobeLoader';
import { DrawerHeader } from './DrawerHost';
import { api, type TerminalEntry } from '../../api';
import { useConfirm } from '../ConfirmDialog';

type Filter = 'all' | 'reply' | 'brain' | 'errors';

export function TerminalDrawer({ onClose }: { onClose: () => void }) {
  const confirm = useConfirm();
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [live, setLive] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stop: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const initial = await api.terminal.read(0);
        if (cancelled) return;
        setEntries(initial.entries);
        // Tail from the newest sequence we already have, so the stream's own
        // backlog cannot duplicate what the initial read returned.
        const since = initial.entries.at(-1)?.seq ?? 0;
        stop = api.terminal.stream(
          since,
          (e) => setEntries((prev) => (prev.some((x) => x.id === e.id) ? prev : [...prev, e].slice(-400))),
          (backlog) => setEntries((prev) => {
            const seen = new Set(prev.map((x) => x.id));
            return [...prev, ...backlog.filter((b) => !seen.has(b.id))].slice(-400);
          }),
        );
        setLive(true);
      } catch {
        setLive(false);
      }
    })();
    return () => { cancelled = true; stop?.(); setLive(false); };
  }, []);

  // Follow the tail only while the user is already at the bottom — scrolling up
  // to read a prompt must not be yanked away by the next call landing.
  useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries, follow]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (filter === 'errors' && e.phase !== 'error') return false;
      if (filter === 'reply' && !e.purpose.startsWith('reply')) return false;
      if (filter === 'brain' && !e.purpose.startsWith('brain')) return false;
      if (!q) return true;
      return (
        e.purpose.toLowerCase().includes(q)
        || e.model.toLowerCase().includes(q)
        || (e.text ?? '').toLowerCase().includes(q)
        || (e.error ?? '').toLowerCase().includes(q)
        || (e.messages ?? []).some((m) => m.content.toLowerCase().includes(q))
      );
    });
  }, [entries, filter, query]);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  async function clearAll() {
    if (!await confirm({
      title: 'Clear the terminal?',
      body: 'Only clears this session log. Nothing else is affected.',
      confirmLabel: 'Clear',
      danger: true,
    })) return;
    await api.terminal.clear().catch(() => undefined);
    setEntries([]);
  }

  /** Plain-text dump, for pasting into a bug report. */
  function download() {
    const text = filtered.map(formatEntry).join('\n\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `reverie-session-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <DrawerHeader title="Terminal" onClose={onClose} />
      <div className="drawer-body term-body">
        <p className="t-caption">
          Every model call this session — the full prompt that was sent, what came back, and how long
          it took. <b>Not saved anywhere</b>: this lives in the server's memory and is gone when it restarts.
        </p>

        <div className="term-controls">
          <div className="sec-chips">
            {(['all', 'reply', 'brain', 'errors'] as Filter[]).map((f) => (
              <button
                key={f}
                type="button"
                className={`chip${filter === f ? ' active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f === 'all' ? 'All' : f === 'reply' ? 'Replies' : f === 'brain' ? 'Memory' : 'Errors'}
              </button>
            ))}
          </div>
          <input
            className="input"
            placeholder="Search prompts and replies…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="term-actions">
            <span className={`term-live${live ? ' is-on' : ''}`}>
              {live ? <>● live</> : <><GlobeLoader size={12} /> connecting</>}
            </span>
            <span className="t-caption">{filtered.length} of {entries.length}</span>
            <button className="btn btn-ghost btn-sm" onClick={download} disabled={!filtered.length}>
              <Download size={13} /> Export
            </button>
            <button className="btn btn-ghost btn-sm btn-danger" onClick={() => void clearAll()}>
              <Trash2 size={13} /> Clear
            </button>
          </div>
        </div>

        <div
          className="term-scroll"
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
          }}
        >
          {!filtered.length && (
            <p className="t-caption term-empty">
              {entries.length
                ? 'Nothing matches that filter.'
                : 'Nothing yet. Send a message and the calls will appear here as they happen.'}
            </p>
          )}
          {filtered.map((e) => (
            <TerminalRow
              key={e.id}
              entry={e}
              open={expanded.has(e.id)}
              onToggle={() => toggle(e.id)}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function TerminalRow({
  entry, open, onToggle,
}: { entry: TerminalEntry; open: boolean; onToggle: () => void }) {
  const time = new Date(entry.at).toLocaleTimeString(undefined, { hour12: false });
  const ms = entry.at % 1000;

  return (
    <div className={`term-row is-${entry.phase}`}>
      <button type="button" className="term-head" onClick={onToggle} aria-expanded={open}>
        <ChevronRight size={13} className={`term-caret${open ? ' is-open' : ''}`} />
        <span className="term-time">{time}.{String(ms).padStart(3, '0')}</span>
        <span className={`term-phase is-${entry.phase}`}>
          {entry.phase === 'request' ? '→' : entry.phase === 'response' ? '←' : '✕'}
        </span>
        <span className="term-purpose">{entry.purpose}</span>
        <span className="term-model">{entry.provider}/{entry.model}</span>
        <span className="term-meta">
          {entry.durationMs !== undefined && `${(entry.durationMs / 1000).toFixed(2)}s`}
          {entry.chars?.prompt ? ` · ${fmt(entry.chars.prompt)} in` : ''}
          {entry.chars?.completion ? ` · ${fmt(entry.chars.completion)} out` : ''}
          {entry.streamed && entry.phase === 'request' ? ' · stream' : ''}
        </span>
      </button>

      {open && (
        <div className="term-detail">
          {entry.params && (
            <pre className="term-pre term-params">{JSON.stringify(entry.params, null, 1)}</pre>
          )}
          {entry.messages?.map((m, i) => (
            <div key={i} className="term-msg">
              <div className="term-msg-role">{m.role}</div>
              <pre className="term-pre">{m.content}</pre>
            </div>
          ))}
          {entry.text !== undefined && <pre className="term-pre term-out">{entry.text || '(empty)'}</pre>}
          {entry.error && <pre className="term-pre term-err">{entry.error}</pre>}
        </div>
      )}
    </div>
  );
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatEntry(e: TerminalEntry): string {
  const head = `[${new Date(e.at).toISOString()}] ${e.phase.toUpperCase()} ${e.purpose} `
    + `${e.provider}/${e.model}${e.durationMs !== undefined ? ` ${e.durationMs}ms` : ''}`;
  const body = [
    e.params ? `params: ${JSON.stringify(e.params)}` : '',
    ...(e.messages ?? []).map((m) => `--- ${m.role} ---\n${m.content}`),
    e.text !== undefined ? `--- output ---\n${e.text}` : '',
    e.error ? `--- error ---\n${e.error}` : '',
  ].filter(Boolean).join('\n');
  return `${head}\n${body}`;
}
