/**
 * Portrait photo adjustments — Snapseed-style global tools (no brushes).
 * Same pipeline for live preview and final export so Apply matches what you see.
 */

import {
  clamp,
  computePortraitCropRect,
  DEFAULT_H,
  DEFAULT_W,
  TARGET_RATIO,
} from './imageCrop';

// ---------- Types ----------

/** All values typically -100..100 unless noted. */
export interface ImageAdjustments {
  brightness: number;
  contrast: number;
  exposure: number;
  highlights: number;
  shadows: number;
  /** Soft global lift of darks (0..100) */
  ambiance: number;
  saturation: number;
  vibrance: number;
  /** Temperature: cool ↔ warm */
  warmth: number;
  /** Green ↔ magenta */
  tint: number;
  /** Lift blacks toward gray (0..100) */
  fade: number;
  /** Unsharp amount (0..100) */
  sharpness: number;
  /** Midtone local contrast (-100..100) */
  clarity: number;
  /** Edge darkening (0..100) */
  vignette: number;
  /** Film grain (0..100) */
  grain: number;
}

export type RotateDeg = 0 | 90 | 180 | 270;

export interface ImageTransform {
  rotate: RotateDeg;
  flipH: boolean;
  flipV: boolean;
}

export interface CropState {
  offsetX: number;
  offsetY: number;
  zoom: number;
}

export interface PortraitEditState {
  crop: CropState;
  transform: ImageTransform;
  adjust: ImageAdjustments;
  /** Active named filter id, or null */
  filterId: string | null;
}

export const DEFAULT_ADJUSTMENTS: ImageAdjustments = {
  brightness: 0,
  contrast: 0,
  exposure: 0,
  highlights: 0,
  shadows: 0,
  ambiance: 0,
  saturation: 0,
  vibrance: 0,
  warmth: 0,
  tint: 0,
  fade: 0,
  sharpness: 0,
  clarity: 0,
  vignette: 0,
  grain: 0,
};

export const DEFAULT_TRANSFORM: ImageTransform = {
  rotate: 0,
  flipH: false,
  flipV: false,
};

export const DEFAULT_CROP: CropState = {
  offsetX: 0,
  offsetY: 0,
  zoom: 1,
};

export function defaultPortraitEdit(): PortraitEditState {
  return {
    crop: { ...DEFAULT_CROP },
    transform: { ...DEFAULT_TRANSFORM },
    adjust: { ...DEFAULT_ADJUSTMENTS },
    filterId: null,
  };
}

export function adjustmentsAreDefault(a: ImageAdjustments): boolean {
  return (Object.keys(DEFAULT_ADJUSTMENTS) as (keyof ImageAdjustments)[]).every(
    (k) => (a[k] ?? 0) === DEFAULT_ADJUSTMENTS[k],
  );
}

// ---------- Filter presets ----------

export interface FilterPreset {
  id: string;
  name: string;
  /** Partial adjust overlay (merged onto defaults) */
  adjust: Partial<ImageAdjustments>;
}

/** Snapseed-ish look presets */
export const FILTER_PRESETS: FilterPreset[] = [
  { id: 'none', name: 'Original', adjust: {} },
  { id: 'vivid', name: 'Vivid', adjust: { saturation: 28, vibrance: 22, contrast: 12, clarity: 10 } },
  { id: 'punch', name: 'Punch', adjust: { contrast: 28, clarity: 22, saturation: 12, shadows: -8 } },
  { id: 'drama', name: 'Drama', adjust: { contrast: 35, clarity: 30, highlights: -18, shadows: 12, warmth: -8 } },
  { id: 'soft', name: 'Soft', adjust: { contrast: -12, brightness: 8, fade: 18, clarity: -15, vignette: 12 } },
  { id: 'warm', name: 'Warm', adjust: { warmth: 35, tint: 6, brightness: 4, saturation: 8 } },
  { id: 'cool', name: 'Cool', adjust: { warmth: -32, tint: -4, contrast: 8, highlights: 6 } },
  { id: 'film', name: 'Film', adjust: { fade: 22, contrast: 6, grain: 28, vignette: 25, warmth: 10, saturation: -6 } },
  { id: 'noir', name: 'Noir', adjust: { saturation: -100, contrast: 40, clarity: 25, vignette: 45, grain: 18 } },
  { id: 'mono', name: 'Mono', adjust: { saturation: -100, contrast: 12, brightness: 4, grain: 8 } },
  { id: 'fade_rose', name: 'Rose', adjust: { fade: 20, warmth: 18, tint: 14, saturation: 10, contrast: -6 } },
  { id: 'golden', name: 'Golden', adjust: { warmth: 42, exposure: 8, highlights: -10, ambiance: 15, vignette: 18 } },
  { id: 'teal', name: 'Teal', adjust: { warmth: -22, tint: -18, contrast: 14, saturation: 10, shadows: 8 } },
  { id: 'portrait', name: 'Portrait', adjust: { brightness: 6, saturation: 10, warmth: 12, clarity: -8, vignette: 15, highlights: -6 } },
  { id: 'crisp', name: 'Crisp', adjust: { sharpness: 45, clarity: 20, contrast: 14, shadows: -6 } },
  { id: 'matte', name: 'Matte', adjust: { fade: 32, contrast: -10, ambiance: 18, saturation: -8, vignette: 10 } },
];

export function applyFilterPreset(id: string | null): { filterId: string | null; adjust: ImageAdjustments } {
  if (!id || id === 'none') {
    return { filterId: null, adjust: { ...DEFAULT_ADJUSTMENTS } };
  }
  const preset = FILTER_PRESETS.find((p) => p.id === id);
  if (!preset) return { filterId: null, adjust: { ...DEFAULT_ADJUSTMENTS } };
  return {
    filterId: id,
    adjust: { ...DEFAULT_ADJUSTMENTS, ...preset.adjust },
  };
}

// ---------- Pixel math ----------

function clampByte(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Deterministic grain (stable across frames / export). */
function grainNoise(x: number, y: number, seed: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233 + seed * 43.758) * 43758.5453;
  return n - Math.floor(n);
}

/**
 * Apply tonal + color adjustments to ImageData in place (except sharpness/clarity which need neighbors).
 */
export function applyAdjustmentsToImageData(data: ImageData, adj: ImageAdjustments, seed = 1): void {
  const d = data.data;
  const w = data.width;
  const h = data.height;
  const n = w * h;

  const brightness = adj.brightness / 100; // -1..1 → add
  const contrast = adj.contrast / 100;
  const exposure = Math.pow(2, adj.exposure / 50); // EV-ish
  const highlights = adj.highlights / 100;
  const shadows = adj.shadows / 100;
  const ambiance = adj.ambiance / 100;
  const sat = adj.saturation / 100;
  const vib = adj.vibrance / 100;
  const warmth = adj.warmth / 100;
  const tint = adj.tint / 100;
  const fade = clamp(adj.fade, 0, 100) / 100;
  const grainAmt = clamp(adj.grain, 0, 100) / 100;
  const vignetteAmt = clamp(adj.vignette, 0, 100) / 100;

  const contrastFactor = (259 * (contrast * 255 * 0.5 + 255)) / (255 * (259 - contrast * 255 * 0.5));

  // First pass: point operations
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    let r = d[o];
    let g = d[o + 1];
    let b = d[o + 2];

    // Exposure
    r *= exposure;
    g *= exposure;
    b *= exposure;

    // Brightness
    r += brightness * 40;
    g += brightness * 40;
    b += brightness * 40;

    // Contrast around mid gray
    r = contrastFactor * (r - 128) + 128;
    g = contrastFactor * (g - 128) + 128;
    b = contrastFactor * (b - 128) + 128;

    // Luma for shadows/highlights/ambiance
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const yn = y / 255;

    // Shadows: lift/crush darks
    if (shadows !== 0 && yn < 0.5) {
      const wgt = (1 - yn * 2) * shadows * 50;
      r += wgt;
      g += wgt;
      b += wgt;
      y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
    // Highlights: pull/push brights
    if (highlights !== 0 && yn > 0.45) {
      const wgt = ((yn - 0.45) / 0.55) * highlights * 45;
      r += wgt;
      g += wgt;
      b += wgt;
      y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    // Ambiance — soft fill light in mid-darks
    if (ambiance > 0) {
      const wgt = Math.sin(Math.min(1, yn * 1.6) * Math.PI) * ambiance * 28;
      r += wgt;
      g += wgt;
      b += wgt;
      y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }

    // White balance: warmth (blue↔orange) + tint (green↔magenta)
    if (warmth !== 0 || tint !== 0) {
      r += warmth * 28 - tint * 10;
      g += tint * 18;
      b -= warmth * 28 + tint * 8;
    }

    // Saturation
    if (sat !== 0) {
      const gy = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = gy + (r - gy) * (1 + sat);
      g = gy + (g - gy) * (1 + sat);
      b = gy + (b - gy) * (1 + sat);
    }

    // Vibrance — boost less-saturated pixels more
    if (vib !== 0) {
      const maxc = Math.max(r, g, b);
      const minc = Math.min(r, g, b);
      const satNow = maxc <= 1e-6 ? 0 : (maxc - minc) / maxc;
      const amount = vib * (1 - satNow);
      const gy = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = gy + (r - gy) * (1 + amount);
      g = gy + (g - gy) * (1 + amount);
      b = gy + (b - gy) * (1 + amount);
    }

    // Fade — lift blacks
    if (fade > 0) {
      r = lerp(r, lerp(r, 255, 0.15), fade * 0.55) + fade * 18;
      g = lerp(g, lerp(g, 255, 0.15), fade * 0.55) + fade * 18;
      b = lerp(b, lerp(b, 255, 0.18), fade * 0.55) + fade * 22;
    }

    d[o] = clampByte(r);
    d[o + 1] = clampByte(g);
    d[o + 2] = clampByte(b);
  }

  // Clarity (midtone local contrast) + sharpness via convolution-ish pass
  if (adj.clarity !== 0 || adj.sharpness > 0) {
    applyDetailPass(data, adj.clarity / 100, adj.sharpness / 100);
  }

  // Vignette + grain (final)
  if (vignetteAmt > 0 || grainAmt > 0) {
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    const maxD = Math.sqrt(cx * cx + cy * cy) || 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        if (vignetteAmt > 0) {
          const dx = (x - cx) / maxD;
          const dy = (y - cy) / maxD;
          const dist = Math.sqrt(dx * dx + dy * dy);
          // smooth darken from ~0.35 radius outward
          const t = clamp((dist - 0.35) / 0.75, 0, 1);
          const dark = 1 - t * t * vignetteAmt * 0.85;
          d[o] = clampByte(d[o] * dark);
          d[o + 1] = clampByte(d[o + 1] * dark);
          d[o + 2] = clampByte(d[o + 2] * dark);
        }
        if (grainAmt > 0) {
          const nse = (grainNoise(x, y, seed) - 0.5) * grainAmt * 48;
          d[o] = clampByte(d[o] + nse);
          d[o + 1] = clampByte(d[o + 1] + nse);
          d[o + 2] = clampByte(d[o + 2] + nse);
        }
      }
    }
  }
}

/** Separable-ish 3x3 local contrast + unsharp. */
function applyDetailPass(data: ImageData, clarity: number, sharp: number): void {
  if (clarity === 0 && sharp === 0) return;
  const w = data.width;
  const h = data.height;
  const src = new Uint8ClampedArray(data.data);
  const d = data.data;
  const amount = sharp * 1.4 + Math.abs(clarity) * 0.9;
  const claritySign = clarity >= 0 ? 1 : -1;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        // 3x3 box blur sample
        let sum = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) {
            sum += src[((y + ky) * w + (x + kx)) * 4 + c];
          }
        }
        const blur = sum / 9;
        const center = src[o + c];
        const high = center - blur;
        // sharpness always boosts high-freq; clarity only midtones
        const luma = (src[o] + src[o + 1] + src[o + 2]) / 3 / 255;
        const midW = 1 - Math.abs(luma - 0.5) * 2;
        const delta = high * (sharp * 1.2 + claritySign * Math.abs(clarity) * midW * 1.1);
        d[o + c] = clampByte(center + delta * Math.min(1.6, amount + 0.3));
      }
    }
  }
}

// ---------- Render pipeline ----------

export function transformedSize(
  srcW: number,
  srcH: number,
  transform: ImageTransform,
): { w: number; h: number } {
  const rot = transform.rotate % 180 === 90;
  return rot ? { w: srcH, h: srcW } : { w: srcW, h: srcH };
}

/** Draw source into ctx with rotate/flip, filling tw×th. */
export function drawTransformed(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  transform: ImageTransform,
): void {
  const { w: tw, h: th } = transformedSize(srcW, srcH, transform);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, tw, th);
  ctx.translate(tw / 2, th / 2);
  ctx.rotate((transform.rotate * Math.PI) / 180);
  ctx.scale(transform.flipH ? -1 : 1, transform.flipV ? -1 : 1);
  // After rotation, drawable space for the unrotated image is srcW×srcH
  ctx.drawImage(source, -srcW / 2, -srcH / 2, srcW, srcH);
  ctx.restore();
}

export interface RenderPortraitOptions {
  maxWidth?: number;
  maxHeight?: number;
  /** Preview quality: skip heavy passes when true (still applies all, just smaller canvas) */
  preview?: boolean;
}

/**
 * Full pipeline: transform → 3:4 crop/pan/zoom → adjustments → PNG blob (or canvas for preview).
 */
export async function renderPortraitEdit(
  source: CanvasImageSource & { width: number; height: number },
  state: PortraitEditState,
  opts: RenderPortraitOptions = {},
): Promise<{ canvas: HTMLCanvasElement; blob?: Blob }> {
  const srcW = source.width;
  const srcH = source.height;
  const { w: tw, h: th } = transformedSize(srcW, srcH, state.transform);

  // 1) Transformed intermediate
  const tCanvas = document.createElement('canvas');
  tCanvas.width = tw;
  tCanvas.height = th;
  const tCtx = tCanvas.getContext('2d');
  if (!tCtx) throw new Error('Canvas not available');
  tCtx.imageSmoothingEnabled = true;
  tCtx.imageSmoothingQuality = 'high';
  drawTransformed(tCtx, source, srcW, srcH, state.transform);

  // 2) Crop rect in transformed space
  const { sx, sy, sw, sh } = computePortraitCropRect(
    tw,
    th,
    state.crop.offsetX,
    state.crop.offsetY,
    state.crop.zoom,
  );

  // 3) Output size
  const maxW = opts.maxWidth ?? DEFAULT_W;
  const maxH = opts.maxHeight ?? DEFAULT_H;
  let outW = sw;
  let outH = sh;
  if (outW > maxW || outH > maxH) {
    const scale = Math.min(maxW / outW, maxH / outH);
    outW = Math.round(outW * scale);
    outH = Math.round(outH * scale);
  }
  if (Math.abs(outW / outH - TARGET_RATIO) > 0.01) {
    outH = Math.round(outW / TARGET_RATIO);
  }
  outW = Math.max(1, outW);
  outH = Math.max(1, outH);

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas not available');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(tCanvas, sx, sy, sw, sh, 0, 0, outW, outH);

  // 4) Adjustments
  if (!adjustmentsAreDefault(state.adjust)) {
    const img = ctx.getImageData(0, 0, outW, outH);
    applyAdjustmentsToImageData(img, state.adjust, 7);
    ctx.putImageData(img, 0, 0);
  }

  if (opts.preview) {
    return { canvas };
  }

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Failed to encode image'))),
      'image/png',
      0.95,
    );
  });
  return { canvas, blob };
}

/** Load HTMLImageElement from URL. */
export function loadHtmlImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = url;
  });
}
