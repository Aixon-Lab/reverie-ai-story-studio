/** Reverie desk — dockable edge-snapping orb + story-aware assistant popup. */
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { Send, Square } from 'lucide-react';
import { IconAi, IconClose } from './Icons';
import { streamAssistant } from '../api';
import {
  clampDrag,
  defaultUndock,
  dockedOrigin,
  DRAG_THRESHOLD,
  hitDock,
  ORB_DOCKED,
  ORB_FLOAT,
  placePopup,
  positionOnEdge,
  snapFromPoint,
  type SnapEdge,
} from '../lib/assistantSnap';
import {
  loadDesk, saveDesk, threadKey, type DeskChrome, type DeskMessage,
} from '../lib/assistantPersist';

const POP_W = 360;
const POP_H = 468;
const SPRING = { type: 'spring' as const, stiffness: 420, damping: 32, mass: 0.7 };

const SUGGEST_CHAT = [
  'What is going on?',
  'What am I wearing?',
  'Recap the last scene.',
];
const SUGGEST_IDLE = [
  'Who am I playing as?',
  'What can you see from the desk?',
];

function newId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function chatIdFromPath(pathname: string): string | undefined {
  if (!pathname.startsWith('/chat/')) return undefined;
  try {
    return decodeURIComponent(pathname.slice(6).split('/')[0] || '') || undefined;
  } catch {
    return pathname.slice(6).split('/')[0] || undefined;
  }
}

export function ReverieOrb() {
  const location = useLocation();
  const chatId = chatIdFromPath(location.pathname);
  const reduced = useReducedMotion();

  const [chrome, setChrome] = useState<DeskChrome>(() => loadDesk().chrome);
  const [threads, setThreads] = useState<Record<string, DeskMessage[]>>(() => loadDesk().threads);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [overDock, setOverDock] = useState(false);
  const [dockRect, setDockRect] = useState<DOMRect | null>(null);
  const [vw, setVw] = useState(() => window.innerWidth);
  const [vh, setVh] = useState(() => window.innerHeight);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const drag = useRef<{
    pointerId: number;
    ox: number;
    oy: number;
    sx: number;
    sy: number;
    moved: boolean;
    fromDock: boolean;
  } | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const orbRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const key = threadKey(chatId);
  const messages = threads[key] ?? [];
  const size = chrome.docked && !dragging ? ORB_DOCKED : ORB_FLOAT;

  const measureDock = useCallback(() => {
    const el = document.getElementById('reverie-dock');
    if (!el) return;
    setDockRect(el.getBoundingClientRect());
  }, []);

  useLayoutEffect(() => {
    measureDock();
    const el = document.getElementById('reverie-dock');
    if (!el) return;
    const ro = new ResizeObserver(() => measureDock());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measureDock]);

  useEffect(() => {
    const onResize = () => {
      setVw(window.innerWidth);
      setVh(window.innerHeight);
      measureDock();
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [measureDock]);

  useEffect(() => {
    saveDesk({ chrome, threads });
  }, [chrome, threads]);

  useEffect(() => {
    const el = document.getElementById('reverie-dock');
    if (!el) return;
    el.classList.toggle('is-occupied', chrome.docked && !dragging);
    el.classList.toggle('is-hot', overDock);
    el.classList.toggle('is-empty', !chrome.docked || dragging);
  }, [chrome.docked, dragging, overDock]);

  const restPos = useMemo(() => {
    if (chrome.docked && dockRect) return dockedOrigin(dockRect, size);
    return positionOnEdge(chrome.edge, chrome.t, vw, vh, size);
  }, [chrome.docked, chrome.edge, chrome.t, dockRect, size, vw, vh]);

  const pos = dragging && dragPos ? dragPos : restPos;

  const preview = useMemo(() => {
    if (!dragging || !dragPos) return null;
    if (overDock && dockRect) return dockedOrigin(dockRect, ORB_DOCKED);
    return snapFromPoint(dragPos.x + size / 2, dragPos.y + size / 2, vw, vh, ORB_FLOAT);
  }, [dragging, dragPos, overDock, dockRect, size, vw, vh]);

  const popPlace = useMemo(() => {
    const edge: SnapEdge = chrome.docked ? 'right' : chrome.edge;
    return placePopup({
      edge,
      orbX: pos.x,
      orbY: pos.y,
      orbSize: size,
      popW: POP_W,
      popH: Math.min(POP_H, vh - 24),
      vw,
      vh,
    });
  }, [chrome.docked, chrome.edge, pos.x, pos.y, size, vw, vh]);

  useEffect(() => {
    if (!open) return;
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [open, messages, stream, err]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 180);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (busy) {
        stopRef.current?.();
        return;
      }
      setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (orbRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, busy]);

  const undockTo = useCallback((edge: SnapEdge, t: number) => {
    setChrome({ docked: false, edge, t });
  }, []);

  const finishDrag = useCallback((clientX: number, clientY: number) => {
    const session = drag.current;
    drag.current = null;
    setDragging(false);
    setDragPos(null);
    setOverDock(false);
    if (!session) return;

    // A click is not a dock drop — otherwise tapping the parked orb would
    // immediately re-dock and never open.
    if (session.moved && dockRect && hitDock(clientX, clientY, dockRect)) {
      setChrome((c) => ({ ...c, docked: true }));
      setOpen(false);
      return;
    }
    if (!session.moved && session.fromDock) {
      const d = defaultUndock(vw, vh, ORB_FLOAT);
      undockTo(d.edge, d.t);
      setOpen(true);
      return;
    }
    if (!session.moved) {
      setOpen((v) => !v);
      return;
    }
    const snap = snapFromPoint(clientX, clientY, vw, vh, ORB_FLOAT);
    undockTo(snap.edge, snap.t);
  }, [dockRect, undockTo, vw, vh]);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      pointerId: e.pointerId,
      ox: e.clientX,
      oy: e.clientY,
      sx: pos.x,
      sy: pos.y,
      moved: false,
      fromDock: chrome.docked,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const session = drag.current;
    if (!session || e.pointerId !== session.pointerId) return;
    const dx = e.clientX - session.ox;
    const dy = e.clientY - session.oy;
    if (!session.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    session.moved = true;
    if (open) setOpen(false);
    setDragging(true);
    const next = clampDrag(session.sx + dx, session.sy + dy, vw, vh, ORB_FLOAT);
    setDragPos(next);
    setOverDock(!!dockRect && hitDock(e.clientX, e.clientY, dockRect));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (drag.current && e.pointerId !== drag.current.pointerId) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    finishDrag(e.clientX, e.clientY);
  };

  const onPointerCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
    finishDrag(e.clientX, e.clientY);
  };

  const stop = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
  }, []);

  const send = useCallback((text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setInput('');
    setErr(null);
    setStream('');
    const userMsg: DeskMessage = { id: newId(), role: 'user', text: q };
    const prior = (threads[key] ?? []).map((m) => ({
      role: m.role,
      content: m.text,
    }));
    setThreads((t) => ({ ...t, [key]: [...(t[key] ?? []), userMsg] }));
    setBusy(true);
    setOpen(true);

    let acc = '';
    const abort = streamAssistant(
      { question: q, chatId, history: prior },
      {
        onDelta: (d) => {
          acc += d;
          setStream(acc);
        },
        onDone: (full) => {
          const textOut = (full || acc).trim();
          setStream('');
          setBusy(false);
          stopRef.current = null;
          if (textOut) {
            setThreads((t) => ({
              ...t,
              [key]: [...(t[key] ?? []), { id: newId(), role: 'assistant', text: textOut }],
            }));
          }
        },
        onError: (message) => {
          setBusy(false);
          stopRef.current = null;
          if (acc.trim()) {
            setThreads((t) => ({
              ...t,
              [key]: [...(t[key] ?? []), { id: newId(), role: 'assistant', text: acc.trim() }],
            }));
            setStream('');
          }
          setErr(message);
        },
        onAbort: () => {
          setBusy(false);
          stopRef.current = null;
          if (acc.trim()) {
            setThreads((t) => ({
              ...t,
              [key]: [...(t[key] ?? []), { id: newId(), role: 'assistant', text: acc.trim() }],
            }));
          }
          setStream('');
        },
      },
    );
    stopRef.current = abort;
  }, [busy, chatId, key, threads]);

  useEffect(() => () => stopRef.current?.(), []);

  const instant = dragging || reduced;
  const suggestions = chatId ? SUGGEST_CHAT : SUGGEST_IDLE;
  const empty = messages.length === 0 && !stream && !busy;

  const orb = (
    <>
      {dragging && preview && (
        <div
          className="reverie-orb-ghost"
          style={{
            left: preview.x,
            top: preview.y,
            width: overDock ? ORB_DOCKED : ORB_FLOAT,
            height: overDock ? ORB_DOCKED : ORB_FLOAT,
          }}
          aria-hidden
        />
      )}
      <motion.button
        ref={orbRef}
        type="button"
        className={`reverie-orb${chrome.docked && !dragging ? ' is-docked' : ''}${open ? ' is-open' : ''}${busy ? ' is-live' : ''}${dragging ? ' is-dragging' : ''}`}
        aria-label={chrome.docked ? 'Ask Reverie' : 'Reverie desk'}
        title={chrome.docked ? 'Ask Reverie' : 'Reverie — drag to an edge, drop on the dock to put away'}
        aria-expanded={open}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        initial={false}
        animate={{
          left: pos.x,
          top: pos.y,
          width: size,
          height: size,
        }}
        transition={instant ? { duration: 0 } : SPRING}
      >
        <span className="reverie-orb-ring" />
        <span className="reverie-orb-face">
          <IconAi size={chrome.docked && !dragging ? 15 : 22} />
        </span>
      </motion.button>
    </>
  );

  const popup = (
    <AnimatePresence>
      {open && !dragging && (
        <motion.div
          ref={popRef}
          className="reverie-desk glass-float"
          role="dialog"
          aria-label="Reverie desk"
          style={{
            left: popPlace.left,
            top: popPlace.top,
            width: POP_W,
            maxHeight: Math.min(POP_H, vh - 24),
            transformOrigin: `${popPlace.originX} ${popPlace.originY}`,
          }}
          initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.92, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 6 }}
          transition={reduced ? { duration: 0.12 } : { duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        >
          <header className="reverie-desk-head">
            <span className="reverie-desk-mark"><IconAi size={16} /></span>
            <span className="reverie-desk-titles">
              <span className="reverie-desk-kicker">Desk</span>
              <span className="reverie-desk-name">Reverie</span>
            </span>
            <button
              type="button"
              className="icon-btn reverie-desk-close"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              <IconClose size={16} />
            </button>
          </header>

          <div className="reverie-desk-log" ref={listRef}>
            {empty && (
              <div className="reverie-desk-empty">
                <p>Ask anything about the story on the desk — notes, the chat, memory, lore.</p>
                <div className="reverie-desk-chips">
                  {suggestions.map((s) => (
                    <button key={s} type="button" className="reverie-chip" onClick={() => send(s)}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <div key={m.id} className={`reverie-msg reverie-msg-${m.role}`}>
                {m.role === 'assistant' && <span className="reverie-msg-mark"><IconAi size={12} /></span>}
                <div className="reverie-msg-body">{m.text}</div>
              </div>
            ))}
            {busy && (
              <div className="reverie-msg reverie-msg-assistant">
                <span className="reverie-msg-mark"><IconAi size={12} /></span>
                <div className="reverie-msg-body">
                  {stream || <span className="reverie-caret">Listening to the desk…</span>}
                  {stream && <span className="reverie-caret-blink" />}
                </div>
              </div>
            )}
            {err && !busy && (
              <div className="reverie-msg reverie-msg-error">{err}</div>
            )}
          </div>

          <form
            className="reverie-desk-composer"
            onSubmit={(e) => {
              e.preventDefault();
              send(input);
            }}
          >
            <textarea
              ref={inputRef}
              className="reverie-desk-input"
              rows={1}
              value={input}
              placeholder={chatId ? 'Ask about the scene…' : 'Ask Reverie…'}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              disabled={busy}
            />
            {busy ? (
              <button type="button" className="reverie-send is-stop" onClick={stop} aria-label="Stop">
                <Square size={12} fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                className="reverie-send"
                disabled={!input.trim()}
                aria-label="Send"
              >
                <Send size={14} />
              </button>
            )}
          </form>
        </motion.div>
      )}
    </AnimatePresence>
  );

  if (typeof document === 'undefined') return null;
  if (chrome.docked && !dockRect && !dragging) {
    return createPortal(popup, document.body);
  }

  return createPortal(
    <div className="reverie-layer">
      {orb}
      {popup}
    </div>,
    document.body,
  );
}
