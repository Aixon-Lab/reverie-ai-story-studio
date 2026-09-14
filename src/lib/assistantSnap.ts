/** Geometry for the Reverie desk orb — edge snap, no center rest, no top edge. */

export const ORB_FLOAT = 44;
export const ORB_DOCKED = 34;
export const EDGE_PAD = 10;
export const DRAG_THRESHOLD = 7;

export type SnapEdge = 'left' | 'right' | 'bottom';

export interface SnapPos {
  edge: SnapEdge;
  x: number;
  y: number;
  t: number;
}

export interface DockRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clamp(n: number, min: number, max: number) {
  if (max < min) return min;
  return Math.min(max, Math.max(min, n));
}

/** Vertical range along left/right: full height, padded. Never a top-edge rest. */
function yRange(vh: number, size: number) {
  const min = EDGE_PAD;
  const max = Math.max(min, vh - size - EDGE_PAD);
  return { min, max };
}

function xRange(vw: number, size: number) {
  const min = EDGE_PAD;
  const max = Math.max(min, vw - size - EDGE_PAD);
  return { min, max };
}

export function tOnEdge(
  edge: SnapEdge,
  x: number,
  y: number,
  vw: number,
  vh: number,
  size = ORB_FLOAT,
): number {
  if (edge === 'bottom') {
    const { min, max } = xRange(vw, size);
    return max === min ? 0.5 : clamp((x - min) / (max - min), 0, 1);
  }
  const { min, max } = yRange(vh, size);
  return max === min ? 0.5 : clamp((y - min) / (max - min), 0, 1);
}

export function positionOnEdge(
  edge: SnapEdge,
  t: number,
  vw: number,
  vh: number,
  size = ORB_FLOAT,
): { x: number; y: number } {
  const tt = clamp(t, 0, 1);
  if (edge === 'bottom') {
    const { min, max } = xRange(vw, size);
    return { x: min + tt * (max - min), y: Math.max(EDGE_PAD, vh - size - EDGE_PAD) };
  }
  const { min, max } = yRange(vh, size);
  const y = min + tt * (max - min);
  if (edge === 'left') return { x: EDGE_PAD, y };
  return { x: Math.max(EDGE_PAD, vw - size - EDGE_PAD), y };
}

/**
 * Resting place from the orb's center. Never the top, never the middle.
 *
 * The lower third of the screen is the bottom rail (any x). Everywhere else
 * is left vs right by which half you are in, so "slightly left of center"
 * goes left instead of falling to the floor on a wide monitor.
 */
export function snapFromPoint(
  cx: number,
  cy: number,
  vw: number,
  vh: number,
  size = ORB_FLOAT,
): SnapPos {
  let edge: SnapEdge;
  if (cy >= vh * 0.66) edge = 'bottom';
  else if (cx < vw / 2) edge = 'left';
  else edge = 'right';

  const raw = {
    x: cx - size / 2,
    y: cy - size / 2,
  };
  const t = tOnEdge(edge, raw.x, raw.y, vw, vh, size);
  const pos = positionOnEdge(edge, t, vw, vh, size);
  return { edge, t, x: pos.x, y: pos.y };
}

export function defaultUndock(vw: number, vh: number, size = ORB_FLOAT): SnapPos {
  const t = 0.38;
  const pos = positionOnEdge('right', t, vw, vh, size);
  return { edge: 'right', t, x: pos.x, y: pos.y };
}

export function hitDock(px: number, py: number, dock: DockRect, slop = 20): boolean {
  return (
    px >= dock.left - slop &&
    px <= dock.left + dock.width + slop &&
    py >= dock.top - slop &&
    py <= dock.top + dock.height + slop
  );
}

export function dockedOrigin(dock: DockRect, size = ORB_DOCKED): { x: number; y: number } {
  return {
    x: dock.left + (dock.width - size) / 2,
    y: dock.top + (dock.height - size) / 2,
  };
}

export function clampDrag(x: number, y: number, vw: number, vh: number, size = ORB_FLOAT) {
  return {
    x: clamp(x, 4, Math.max(4, vw - size - 4)),
    y: clamp(y, 4, Math.max(4, vh - size - 4)),
  };
}

export function placePopup(opts: {
  edge: SnapEdge;
  orbX: number;
  orbY: number;
  orbSize: number;
  popW: number;
  popH: number;
  vw: number;
  vh: number;
}): { left: number; top: number; originX: string; originY: string } {
  const gap = 12;
  const { edge, orbX, orbY, orbSize, popW, popH, vw, vh } = opts;
  const maxLeft = Math.max(8, vw - popW - 8);
  const maxTop = Math.max(8, vh - popH - 8);

  if (edge === 'left') {
    return {
      left: clamp(orbX + orbSize + gap, 8, maxLeft),
      top: clamp(orbY + orbSize / 2 - popH / 2, 8, maxTop),
      originX: '0%',
      originY: '50%',
    };
  }
  if (edge === 'right') {
    return {
      left: clamp(orbX - gap - popW, 8, maxLeft),
      top: clamp(orbY + orbSize / 2 - popH / 2, 8, maxTop),
      originX: '100%',
      originY: '50%',
    };
  }
  return {
    left: clamp(orbX + orbSize / 2 - popW / 2, 8, maxLeft),
    top: clamp(orbY - gap - popH, 8, maxTop),
    originX: '50%',
    originY: '100%',
  };
}
