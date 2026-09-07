import { describe, expect, it } from 'vitest';
import {
  defaultUndock,
  hitDock,
  ORB_FLOAT,
  placePopup,
  positionOnEdge,
  snapFromPoint,
  tOnEdge,
} from './assistantSnap';

const VW = 1280;
const VH = 800;
const S = ORB_FLOAT;

describe('snapFromPoint', () => {
  it('sends a slightly-left center point to the left edge, not the center', () => {
    const s = snapFromPoint(VW * 0.4, VH * 0.45, VW, VH, S);
    expect(s.edge).toBe('left');
    expect(s.x).toBe(10);
    expect(s.y).toBeGreaterThan(0);
    expect(s.y).toBeLessThan(VH - S);
  });

  it('sends a slightly-right center point to the right edge', () => {
    const s = snapFromPoint(VW * 0.7, VH * 0.4, VW, VH, S);
    expect(s.edge).toBe('right');
    expect(s.x).toBe(VW - S - 10);
  });

  it('sends a low point to the bottom and keeps the horizontal position', () => {
    const s = snapFromPoint(400, VH - 40, VW, VH, S);
    expect(s.edge).toBe('bottom');
    expect(s.y).toBe(VH - S - 10);
    expect(s.x).toBeGreaterThan(10);
    expect(s.x).toBeLessThan(VW - S);
  });

  it('never chooses a top-edge rest, even from the top-center of the screen', () => {
    const s = snapFromPoint(VW / 2, 20, VW, VH, S);
    expect(s.edge).not.toBe('top' as never);
    expect(['left', 'right', 'bottom']).toContain(s.edge);
    // Top-center is equally far from L/R and far from bottom → a side.
    expect(s.edge === 'left' || s.edge === 'right').toBe(true);
  });

  it('prefers bottom on a bottom-corner tie so a floor drag does not jump to a side', () => {
    const s = snapFromPoint(20, VH - 20, VW, VH, S);
    expect(s.edge).toBe('bottom');
  });
});

describe('positionOnEdge / tOnEdge', () => {
  it('round-trips t along the left edge', () => {
    const pos = positionOnEdge('left', 0.25, VW, VH, S);
    expect(pos.x).toBe(10);
    const t = tOnEdge('left', pos.x, pos.y, VW, VH, S);
    expect(t).toBeCloseTo(0.25, 3);
  });

  it('lets the bottom edge sit at any x', () => {
    const a = positionOnEdge('bottom', 0, VW, VH, S);
    const b = positionOnEdge('bottom', 1, VW, VH, S);
    expect(a.x).toBeLessThan(b.x);
    expect(a.y).toBe(b.y);
  });
});

describe('hitDock', () => {
  const dock = { left: 900, top: 10, width: 32, height: 32 };
  it('hits the slot and a small slop around it', () => {
    expect(hitDock(916, 26, dock)).toBe(true);
    expect(hitDock(900 - 15, 10, dock)).toBe(true);
    expect(hitDock(100, 400, dock)).toBe(false);
  });
});

describe('placePopup', () => {
  it('opens to the left of a right-edge orb and stays on screen', () => {
    const p = placePopup({
      edge: 'right',
      orbX: VW - S - 10,
      orbY: 200,
      orbSize: S,
      popW: 360,
      popH: 420,
      vw: VW,
      vh: VH,
    });
    expect(p.left + 360).toBeLessThanOrEqual(VW - S);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + 420).toBeLessThanOrEqual(VH);
    expect(p.originX).toBe('100%');
  });

  it('opens upward from a bottom orb', () => {
    const orbY = VH - S - 10;
    const p = placePopup({
      edge: 'bottom',
      orbX: 400,
      orbY,
      orbSize: S,
      popW: 360,
      popH: 420,
      vw: VW,
      vh: VH,
    });
    expect(p.top + 420).toBeLessThanOrEqual(orbY);
    expect(p.originY).toBe('100%');
  });
});

describe('defaultUndock', () => {
  it('lands on the right edge below the top bar', () => {
    const d = defaultUndock(VW, VH, S);
    expect(d.edge).toBe('right');
    expect(d.x).toBe(VW - S - 10);
    expect(d.y).toBeGreaterThan(40);
  });
});
