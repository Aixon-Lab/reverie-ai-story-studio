/**
 * Shared dot-matrix globe used by the loader and the AI mark.
 *
 * Compact (5-ring) for icons and inline waits. Full (7-ring) for page-level
 * loaders so the sphere still reads when it is large.
 */

export const GLOBE_VB = 32;

export type GlobeDot = {
  x: number;
  y: number;
  col: number;
  row: number;
};

function build(n: 5 | 7, spacing: number, maxR2: number): GlobeDot[] {
  const half = (n - 1) / 2;
  const c = GLOBE_VB / 2;
  const dots: GlobeDot[] = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const gx = col - half;
      const gy = row - half;
      if (gx * gx + gy * gy <= maxR2) {
        dots.push({ x: c + gx * spacing, y: c + gy * spacing, col, row });
      }
    }
  }
  return dots;
}

/** 5×5 circle — 21 dots. Reads at 13–16px. */
export const GLOBE_DOTS_COMPACT = build(5, 5.35, 5.1);
/** 7×7 circle — 37 dots. Page / hero loaders. */
export const GLOBE_DOTS_FULL = build(7, 3.82, 10.2);

export const GLOBE_R_COMPACT = 1.52;
export const GLOBE_R_FULL = 1.16;

/** Lit hemisphere from lower-left — matches the AI gradient direction. */
export function globeHemisphere(col: number, row: number, n: 5 | 7): number {
  const half = (n - 1) / 2;
  const nx = (col - half) / half;
  const ny = (row - half) / half;
  const d = Math.hypot(nx + 0.45, ny - 0.22);
  return 0.38 + 0.62 * Math.max(0, 1 - d * 0.72);
}
