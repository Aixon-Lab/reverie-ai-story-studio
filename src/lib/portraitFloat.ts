/** Geometry helpers for multi floating portraits — no stacking, viewport clamp. */

export const PORTRAIT_FRAME_W = 280;
export const PORTRAIT_FRAME_H = Math.round(PORTRAIT_FRAME_W * (4 / 3)); // 3:4
/** height / width — keep every float locked to this ratio. */
export const PORTRAIT_ASPECT = PORTRAIT_FRAME_H / PORTRAIT_FRAME_W;
export const PORTRAIT_PAD = 8;
export const PORTRAIT_GAP = 6;
/** Smallest readable float — still 3:4. */
export const PORTRAIT_MIN_W = 160;
/** Cap so a float cannot swallow the whole screen. */
export const PORTRAIT_MAX_W_RATIO = 0.72;

export interface PortraitRect {
  id?: string;
  x: number;
  y: number;
  /** Frame width; defaults to PORTRAIT_FRAME_W when omitted. */
  w?: number;
  /** Frame height; defaults to PORTRAIT_FRAME_H when omitted. */
  h?: number;
}

export function portraitSize(r: PortraitRect): { w: number; h: number } {
  return { w: r.w ?? PORTRAIT_FRAME_W, h: r.h ?? PORTRAIT_FRAME_H };
}

/** Clamp a proposed width to min/max and force exact 3:4 height. */
export function sizeFromWidth(width: number): { w: number; h: number } {
  const maxByViewport = Math.floor(window.innerWidth * PORTRAIT_MAX_W_RATIO);
  const maxByHeight = Math.floor((window.innerHeight - PORTRAIT_PAD * 2) / PORTRAIT_ASPECT);
  const w = Math.round(
    Math.min(maxByViewport, maxByHeight, Math.max(PORTRAIT_MIN_W, width)),
  );
  return { w, h: Math.round(w * PORTRAIT_ASPECT) };
}

export function clampToViewport(x: number, y: number, w = PORTRAIT_FRAME_W, h = PORTRAIT_FRAME_H) {
  const maxX = Math.max(PORTRAIT_PAD, window.innerWidth - w - PORTRAIT_PAD);
  const maxY = Math.max(PORTRAIT_PAD, window.innerHeight - h - PORTRAIT_PAD);
  return {
    x: Math.min(maxX, Math.max(PORTRAIT_PAD, x)),
    y: Math.min(maxY, Math.max(PORTRAIT_PAD, y)),
  };
}

export function rectsOverlap(
  a: PortraitRect,
  b: PortraitRect,
  gap = PORTRAIT_GAP,
): boolean {
  const as = portraitSize(a);
  const bs = portraitSize(b);
  return !(
    a.x + as.w + gap <= b.x ||
    b.x + bs.w + gap <= a.x ||
    a.y + as.h + gap <= b.y ||
    b.y + bs.h + gap <= a.y
  );
}

/** Push `pos` out of other frames the same way we clamp off-screen edges. */
export function clampNoStack(
  x: number,
  y: number,
  selfId: string,
  others: PortraitRect[],
  selfW = PORTRAIT_FRAME_W,
  selfH = PORTRAIT_FRAME_H,
): { x: number; y: number } {
  let pos: PortraitRect = {
    ...clampToViewport(x, y, selfW, selfH),
    w: selfW,
    h: selfH,
  };

  for (let pass = 0; pass < 8; pass++) {
    let moved = false;
    for (const o of others) {
      if (o.id === selfId) continue;
      if (!rectsOverlap(pos, o)) continue;

      const os = portraitSize(o);
      const ox = o.x + os.w / 2;
      const oy = o.y + os.h / 2;
      const cx = pos.x + selfW / 2;
      const cy = pos.y + selfH / 2;
      const dx = cx - ox;
      const dy = cy - oy;
      const overlapX = (selfW + os.w) / 2 + PORTRAIT_GAP - Math.abs(dx);
      const overlapY = (selfH + os.h) / 2 + PORTRAIT_GAP - Math.abs(dy);
      if (overlapX <= 0 || overlapY <= 0) continue;

      if (overlapX < overlapY) {
        const dir = dx === 0 ? (pos.x >= o.x ? 1 : -1) : Math.sign(dx) || 1;
        const nx = dir > 0 ? o.x + os.w + PORTRAIT_GAP : o.x - selfW - PORTRAIT_GAP;
        pos = { ...pos, ...clampToViewport(nx, pos.y, selfW, selfH), w: selfW, h: selfH };
      } else {
        const dir = dy === 0 ? (pos.y >= o.y ? 1 : -1) : Math.sign(dy) || 1;
        const ny = dir > 0 ? o.y + os.h + PORTRAIT_GAP : o.y - selfH - PORTRAIT_GAP;
        pos = { ...pos, ...clampToViewport(pos.x, ny, selfW, selfH), w: selfW, h: selfH };
      }
      moved = true;
    }
    if (!moved) break;
  }
  return { x: pos.x, y: pos.y };
}

/** Find a free slot near center for a newly opened portrait (default size). */
export function findFreePortraitSlot(existing: PortraitRect[]): { x: number; y: number } {
  const cx = Math.round(window.innerWidth / 2 - PORTRAIT_FRAME_W / 2);
  const cy = Math.round(window.innerHeight / 2 - PORTRAIT_FRAME_H / 2);
  const candidates: { x: number; y: number }[] = [{ x: cx, y: cy }];
  const step = PORTRAIT_FRAME_W + PORTRAIT_GAP + 8;
  for (let ring = 1; ring <= 6; ring++) {
    for (let i = -ring; i <= ring; i++) {
      candidates.push(
        { x: cx + i * step, y: cy - ring * (PORTRAIT_FRAME_H + PORTRAIT_GAP) },
        { x: cx + i * step, y: cy + ring * (PORTRAIT_FRAME_H + PORTRAIT_GAP) },
        { x: cx - ring * step, y: cy + i * (PORTRAIT_FRAME_H + PORTRAIT_GAP) },
        { x: cx + ring * step, y: cy + i * (PORTRAIT_FRAME_H + PORTRAIT_GAP) },
      );
    }
  }
  for (const c of candidates) {
    const pos: PortraitRect = {
      ...clampToViewport(c.x, c.y),
      w: PORTRAIT_FRAME_W,
      h: PORTRAIT_FRAME_H,
    };
    if (!existing.some((o) => rectsOverlap(pos, o))) return { x: pos.x, y: pos.y };
  }
  return clampToViewport(PORTRAIT_PAD + existing.length * 24, PORTRAIT_PAD + existing.length * 24);
}
