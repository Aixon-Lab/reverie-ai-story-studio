/** Popover primitive — closes on outside click and Esc; anchors below its trigger. */
import { useEffect, useRef, type ReactNode } from 'react';

export function Popover({ open, onClose, trigger, children, width = 320, align = 'right' }: {
  open: boolean;
  onClose: () => void;
  trigger: ReactNode;
  children: ReactNode;
  width?: number;
  align?: 'left' | 'right';
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      {trigger}
      {open && (
        <div
          className="glass-float"
          style={{
            position: 'absolute', top: 'calc(100% + 8px)', [align]: 0,
            width, padding: 18, zIndex: 60,
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}
