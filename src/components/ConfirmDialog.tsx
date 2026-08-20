/**
 * In-app confirmation dialog.
 *
 * Replaces `window.confirm`, which renders as a browser chrome popup ("127.0.0.1
 * says…"), ignores the app's typography and theme, blocks the JS thread, and
 * cannot show a destructive action as destructive.
 *
 *   if (!await confirm({ title: 'Delete?', body: '…' })) return;
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';

export interface ConfirmOptions {
  /** The question. Short, and phrased so the primary button is unambiguous. */
  title: string;
  /** Consequences worth spelling out — what is lost, what is not. */
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Irreversible? Renders the action red and shows a warning glyph. */
  danger?: boolean;
}

type Resolver = (ok: boolean) => void;

const ConfirmContext = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

function resolveCopy(opts: ConfirmOptions): Required<Pick<ConfirmOptions, 'title' | 'body' | 'confirmLabel' | 'cancelLabel' | 'danger'>> {
  const danger = !!opts.danger;
  const title = (opts.title ?? '').trim() || (danger ? 'Are you sure?' : 'Confirm');
  const body = (opts.body ?? '').trim()
    || (danger
      ? 'This cannot be undone.'
      : 'Please confirm to continue.');
  return {
    title,
    body,
    danger,
    confirmLabel: (opts.confirmLabel ?? '').trim() || (danger ? 'Delete' : 'Confirm'),
    cancelLabel: (opts.cancelLabel ?? '').trim() || 'Cancel',
  };
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ReturnType<typeof resolveCopy> | null>(null);
  const resolver = useRef<Resolver | null>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const confirm = useCallback((opts: ConfirmOptions) => new Promise<boolean>((resolve) => {
    // A second request while one is open answers the first as cancelled rather
    // than dropping its promise on the floor and hanging the caller forever.
    resolver.current?.(false);
    resolver.current = resolve;
    setState(resolveCopy(opts));
  }), []);

  const close = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setState(null);
  }, []);

  // Focus the primary action so Enter confirms and Escape cancels.
  useEffect(() => {
    if (!state) return;
    const t = window.setTimeout(() => confirmBtn.current?.focus(), 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close(false);
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [state, close]);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {state && createPortal(
        <div
          className="confirm-backdrop"
          role="presentation"
          onMouseDown={(e) => {
            // Only a press that starts on the backdrop dismisses — not a drag off the dialog.
            if (e.target === e.currentTarget) close(false);
          }}
        >
          <div
            ref={dialogRef}
            className={`confirm-modal${state.danger ? ' is-danger' : ''}`}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-body"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="confirm-head">
              {state.danger && (
                <span className="confirm-icon-wrap" aria-hidden>
                  <AlertTriangle size={18} strokeWidth={2.25} />
                </span>
              )}
              <div className="confirm-copy">
                <p id="confirm-title" className="confirm-title">{state.title}</p>
                <p id="confirm-body" className="confirm-body">{state.body}</p>
              </div>
            </div>
            <div className="confirm-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => close(false)}
              >
                {state.cancelLabel}
              </button>
              <button
                ref={confirmBtn}
                type="button"
                className={`btn btn-sm ${state.danger ? 'btn-danger-solid' : 'btn-primary'}`}
                onClick={() => close(true)}
              >
                {state.confirmLabel}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </ConfirmContext.Provider>
  );
}

/**
 * Ask the user to confirm. Resolves `true` only on the primary action —
 * backdrop click, Cancel and Escape all resolve `false`.
 */
export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error('useConfirm must be used inside <ConfirmProvider>');
  }
  return ctx;
}
