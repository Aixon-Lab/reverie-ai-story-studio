/** ST-style group cast strip: member portraits + a trailing "+" to add more.
 *  Click + → searchable picker of platform characters not already in the cast.
 *  Always refreshes the character library when the picker opens. */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Plus, Search, X } from 'lucide-react';
import type { CharacterCard } from '@shared/types';
import { useApp } from '../store';
import { Avatar } from './Avatar';
import { GlobeLoader } from './GlobeLoader';

const EASE = [0.22, 1, 0.36, 1] as const;

export function GroupMemberStrip({
  members,
  pool,
  onAdd,
  onRemove,
  onOpen,
  size = 40,
  playAsId = null,
  mutedIds = [],
  canRemove = true,
  showNames = false,
  dense = false,
  /** Only render the + control (still uses `members` to exclude from picker) */
  addOnly = false,
  emptyHint = 'Add characters to this group',
  addLabel = 'Add member',
}: {
  members: CharacterCard[];
  /** Optional seed pool; live store list is always merged + refreshed on open */
  pool?: CharacterCard[];
  onAdd: (card: CharacterCard) => void | Promise<void>;
  onRemove?: (card: CharacterCard) => void | Promise<void>;
  onOpen?: (card: CharacterCard) => void;
  size?: number;
  playAsId?: string | null;
  mutedIds?: string[];
  canRemove?: boolean;
  showNames?: boolean;
  /** Tighter stack for headers */
  dense?: boolean;
  addOnly?: boolean;
  emptyHint?: string;
  addLabel?: string;
}) {
  const storeCharacters = useApp((s) => s.characters);
  const refreshCharacters = useApp((s) => s.refreshCharacters);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [loadingPool, setLoadingPool] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members]);

  /** Prefer live store, fall back to / merge with prop pool so imports always appear */
  const livePool = useMemo(() => {
    const byId = new Map<string, CharacterCard>();
    for (const c of pool ?? []) byId.set(c.id, c);
    for (const c of storeCharacters) byId.set(c.id, c);
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [pool, storeCharacters]);

  const available = useMemo(() => {
    const list = livePool.filter((c) => !memberIds.has(c.id));
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (c) =>
        c.name.toLowerCase().includes(needle) ||
        c.tags.some((t) => t.toLowerCase().includes(needle)),
    );
  }, [livePool, memberIds, q]);

  async function openPicker() {
    setOpen(true);
    setLoadingPool(true);
    try {
      await refreshCharacters();
    } catch {
      /* keep cached list */
    } finally {
      setLoadingPool(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    const t = requestAnimationFrame(() => searchRef.current?.focus());
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQ('');
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setQ('');
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(t);
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const overlap = dense ? -12 : -10;
  const addSize = size;

  return (
    <div className={`member-strip${dense ? ' is-dense' : ''}${addOnly ? ' is-add-only' : ''}`} ref={rootRef}>
      <div className="member-strip-row" role="list" aria-label="Group members">
        {!addOnly && members.length === 0 && emptyHint && (
          <span className="member-strip-empty t-caption">{emptyHint}</span>
        )}
        {!addOnly && members.map((m, i) => {
          const muted = mutedIds.includes(m.id);
          const isYou = playAsId === m.id;
          return (
            <div
              key={m.id}
              className={`member-strip-item${muted ? ' is-muted' : ''}${isYou ? ' is-you' : ''}`}
              style={{ marginLeft: i === 0 ? 0 : overlap, zIndex: members.length - i }}
              role="listitem"
            >
              <button
                type="button"
                className="member-strip-face"
                title={isYou ? `${m.name} · You` : m.name}
                onClick={() => onOpen?.(m)}
                style={{ width: size, height: size }}
              >
                <Avatar src={m.avatar} name={m.name} size={size} shape="square" interactive={false} />
                {isYou && <span className="member-strip-you-dot" aria-hidden />}
              </button>
              {showNames && (
                <span className="member-strip-name t-caption">{m.name}</span>
              )}
              {canRemove && onRemove && members.length > 1 && (
                <button
                  type="button"
                  className="member-strip-remove"
                  title={`Remove ${m.name}`}
                  aria-label={`Remove ${m.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void onRemove(m);
                  }}
                >
                  <X size={11} strokeWidth={2.5} />
                </button>
              )}
            </div>
          );
        })}

        <div
          className="member-strip-add-wrap"
          style={{ marginLeft: !addOnly && members.length ? (dense ? 4 : 6) : 0 }}
        >
          <button
            type="button"
            className={`member-strip-add${open ? ' is-open' : ''}`}
            style={{ width: addSize, height: addSize }}
            title={addLabel}
            aria-label={addLabel}
            aria-expanded={open}
            aria-haspopup="dialog"
            onClick={() => {
              if (open) {
                setOpen(false);
                setQ('');
              } else {
                void openPicker();
              }
            }}
          >
            <Plus size={Math.round(addSize * 0.42)} strokeWidth={2.25} />
          </button>

          <AnimatePresence>
            {open && (
              <motion.div
                className="member-add-popover"
                role="dialog"
                aria-label="Add group member"
                initial={{ opacity: 0, y: -8, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -6, scale: 0.98 }}
                transition={{ duration: 0.18, ease: EASE }}
              >
                <div className="member-add-search">
                  <Search size={14} className="member-add-search-icon" />
                  <input
                    ref={searchRef}
                    className="member-add-input"
                    placeholder="Search characters…"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                </div>
                <div className="member-add-list">
                  {loadingPool && available.length === 0 ? (
                    <p className="t-caption member-add-empty">
                      <GlobeLoader size={14} label="Refreshing library…" />
                    </p>
                  ) : available.length === 0 ? (
                    <p className="t-caption member-add-empty">
                      {livePool.length === 0
                        ? 'No characters on the platform yet. Import a card first.'
                        : livePool.length === memberIds.size
                          ? 'Every character is already in this group.'
                          : 'No matches.'}
                    </p>
                  ) : (
                    available.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        className="member-add-row"
                        onClick={() => {
                          void onAdd(c);
                          setOpen(false);
                          setQ('');
                        }}
                      >
                        <Avatar src={c.avatar} name={c.name} size={32} shape="square" interactive={false} />
                        <span className="member-add-meta">
                          <span className="member-add-name">{c.name}</span>
                          {c.tags.length > 0 && (
                            <span className="t-caption">{c.tags.slice(0, 3).join(' · ')}</span>
                          )}
                        </span>
                        <span className="member-add-plus" aria-hidden>
                          <Plus size={14} />
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
