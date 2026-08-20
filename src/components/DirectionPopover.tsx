/** Direction popup — steer the next beat with intensity (charactus-style, Analogue chrome). */
import { useEffect, useRef, useState } from 'react';
import type { DirectorState } from '@shared/types';
import { GlobeLoader } from './GlobeLoader';

const PREFER: { id: NonNullable<DirectorState['prefer']>; label: string }[] = [
  { id: 'pursue', label: 'Pursue' },
  { id: 'repair', label: 'Repair' },
  { id: 'confront', label: 'Confront' },
  { id: 'conceal', label: 'Conceal' },
  { id: 'withdraw', label: 'Withdraw' },
  { id: 'test', label: 'Test' },
  { id: 'endure', label: 'Endure' },
  { id: 'enjoy', label: 'Enjoy' },
];

export function DirectionPopover({
  open,
  onClose,
  initial,
  onApply,
  initialPrefer,
  anchorRef,
}: {
  open: boolean;
  onClose: () => void;
  initial?: DirectorState['nudge'];
  onApply: (nudge: {
    text: string;
    intensity: 1 | 2 | 3 | 4 | 5;
    prefer?: DirectorState['prefer'];
  }) => Promise<void>;
  initialPrefer?: DirectorState['prefer'];
  anchorRef?: React.RefObject<HTMLElement | null>;
}) {
  const [text, setText] = useState(initial?.text ?? '');
  const [intensity, setIntensity] = useState<1 | 2 | 3 | 4 | 5>(initial?.intensity ?? 3);
  const [prefer, setPrefer] = useState<DirectorState['prefer']>(initialPrefer);
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setText(initial?.text ?? '');
      setIntensity(initial?.intensity ?? 3);
      setPrefer(initialPrefer);
    }
  }, [open, initial?.text, initial?.intensity, initialPrefer]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      if (anchorRef?.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return (
    <div className="direction-pop glass-float" ref={panelRef} role="dialog" aria-label="Story direction">
      <p className="field-label" style={{ marginBottom: 8 }}>Where should the story go?</p>
      <textarea
        className="textarea"
        rows={3}
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="e.g. She notices the letter under the door — don't ignore it"
      />
      <div className="director-intensity" style={{ marginTop: 12 }}>
        <span className="t-caption">Intensity</span>
        {([1, 2, 3, 4, 5] as const).map((i) => (
          <button
            key={i}
            type="button"
            className="intensity-dot"
            data-on={i <= intensity || undefined}
            onClick={() => setIntensity(i)}
            aria-label={`Intensity ${i}`}
          />
        ))}
        <span className="t-caption">
          {intensity <= 2 ? 'Soft nudge' : intensity <= 4 ? 'Push soon' : 'Force now'}
        </span>
      </div>
      <p className="field-label" style={{ marginTop: 12 }}>Reach for (optional)</p>
      <div className="director-prefer">
        {PREFER.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`chip${prefer === p.id ? ' active' : ''}`}
            onClick={() => setPrefer(prefer === p.id ? undefined : p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 14, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!text.trim() || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onApply({ text: text.trim(), intensity, prefer });
              onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <><GlobeLoader size={13} /> Applying…</> : 'Apply Direction'}
        </button>
      </div>
    </div>
  );
}
