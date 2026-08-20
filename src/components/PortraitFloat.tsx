/** Multi floating 3:4 portraits — drag, corner-resize (locked ratio), double-click resets size. */
import { useCallback, useEffect, useRef } from 'react';
import { useApp, type PortraitFloatItem } from '../store';
import {
  PORTRAIT_FRAME_H,
  PORTRAIT_FRAME_W,
  clampNoStack,
  sizeFromWidth,
} from '../lib/portraitFloat';
import { IconClose } from './Icons';

function FloatWindow({ item }: { item: PortraitFloatItem }) {
  const closePortrait = useApp((s) => s.closePortrait);
  const movePortrait = useApp((s) => s.movePortrait);
  const resizePortrait = useApp((s) => s.resizePortrait);
  const portraitFloats = useApp((s) => s.portraitFloats);

  const drag = useRef<{ ox: number; oy: number; sx: number; sy: number } | null>(null);
  const resize = useRef<{ ox: number; oy: number; sw: number } | null>(null);

  const w = item.w || PORTRAIT_FRAME_W;
  const h = item.h || PORTRAIT_FRAME_H;

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-close]')) return;
    if ((e.target as HTMLElement).closest('[data-resize]')) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { ox: e.clientX, oy: e.clientY, sx: item.x, sy: item.y };
  }, [item.x, item.y]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (resize.current) {
      const dx = e.clientX - resize.current.ox;
      const dy = e.clientY - resize.current.oy;
      // Prefer the larger of horizontal growth and vertical→width growth so the
      // corner feels natural while the frame stays locked to 3:4.
      const fromX = resize.current.sw + dx;
      const fromY = resize.current.sw + dy / (PORTRAIT_FRAME_H / PORTRAIT_FRAME_W);
      const next = sizeFromWidth(Math.max(fromX, fromY));
      if (next.w !== w || next.h !== h) resizePortrait(item.id, next.w, next.h);
      return;
    }
    if (!drag.current) return;
    const dx = e.clientX - drag.current.ox;
    const dy = e.clientY - drag.current.oy;
    const rawX = drag.current.sx + dx;
    const rawY = drag.current.sy + dy;
    const others = useApp.getState().portraitFloats;
    const next = clampNoStack(rawX, rawY, item.id, others, w, h);
    movePortrait(item.id, next.x, next.y);
  }, [h, item.id, movePortrait, resizePortrait, w]);

  const onPointerUp = useCallback(() => {
    drag.current = null;
    resize.current = null;
  }, []);

  const onResizeDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    resize.current = { ox: e.clientX, oy: e.clientY, sw: w };
  }, [w]);

  /** Double-click the photo → snap back to the default open size. */
  const onDoubleClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('[data-close]')) return;
    if ((e.target as HTMLElement).closest('[data-resize]')) return;
    e.preventDefault();
    e.stopPropagation();
    resizePortrait(item.id, PORTRAIT_FRAME_W, PORTRAIT_FRAME_H);
  }, [item.id, resizePortrait]);

  useEffect(() => {
    const onResize = () => {
      // Re-clamp size to the new viewport, then position.
      const sized = sizeFromWidth(w);
      if (sized.w !== w || sized.h !== h) {
        resizePortrait(item.id, sized.w, sized.h);
        return;
      }
      const others = useApp.getState().portraitFloats;
      const next = clampNoStack(item.x, item.y, item.id, others, w, h);
      if (next.x !== item.x || next.y !== item.y) movePortrait(item.id, next.x, next.y);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [h, item.id, item.x, item.y, movePortrait, resizePortrait, w]);

  // Nudge if peers land on the same slot after open
  useEffect(() => {
    const next = clampNoStack(item.x, item.y, item.id, portraitFloats, w, h);
    if (next.x !== item.x || next.y !== item.y) movePortrait(item.id, next.x, next.y);
    // only when count changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [portraitFloats.length]);

  return (
    <div
      className="portrait-float"
      style={{ left: item.x, top: item.y, width: w, height: h }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      role="dialog"
      aria-label={`${item.name} portrait — drag to move, corner to resize, double-click to reset size`}
      title="Drag to move · corner to resize · double-click to reset size"
    >
      <button
        data-close
        type="button"
        className="portrait-float-close"
        onClick={(e) => { e.stopPropagation(); closePortrait(item.id); }}
        aria-label="Close portrait"
        title="Close"
      >
        <IconClose size={16} />
      </button>
      <span className="portrait-float-chip">{item.name}</span>
      <div className="portrait-float-body">
        {item.src ? (
          <img src={item.src} alt={item.name} draggable={false} />
        ) : (
          <div className="portrait-float-empty t-heading">{item.name.slice(0, 1)}</div>
        )}
      </div>
      <div
        data-resize
        className="portrait-float-resize"
        onPointerDown={onResizeDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        title="Drag to resize (keeps 3:4)"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize portrait"
      />
    </div>
  );
}

export function PortraitFloat() {
  const portraitFloats = useApp((s) => s.portraitFloats);
  const closeAllPortraits = useApp((s) => s.closeAllPortraits);

  useEffect(() => {
    if (!portraitFloats.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const last = useApp.getState().portraitFloats.at(-1);
        if (last) useApp.getState().closePortrait(last.id);
        else closeAllPortraits();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [portraitFloats.length, closeAllPortraits]);

  if (!portraitFloats.length) return null;

  return (
    <>
      {portraitFloats.map((item) => (
        <FloatWindow key={item.id} item={item} />
      ))}
    </>
  );
}
