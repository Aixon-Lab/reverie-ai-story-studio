/** 3:4 portrait crop with pan + zoom.
 *  offsetX/offsetY in -1..1 shift the crop window within the allowed range
 *  (0 = center). At any zoom, pan is clamped so the crop never leaves the image.
 *  zoom ≥ 1 tightens the crop (1 = max 3:4 coverage, higher = closer).
 */

const DEFAULT_W = 1080;
const DEFAULT_H = 1440; // 3:4
const TARGET_RATIO = 3 / 4;
const MIN_ZOOM = 1;
const MAX_ZOOM = 4;

export { MIN_ZOOM, MAX_ZOOM, TARGET_RATIO, DEFAULT_W, DEFAULT_H };

export function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

/** Largest 3:4 rectangle that fits in the source image (zoom = 1 base). */
export function basePortraitRect(srcW: number, srcH: number): { baseW: number; baseH: number } {
  const srcRatio = srcW / srcH;
  if (srcRatio > TARGET_RATIO) {
    // wider than 3:4 — height-limited
    return { baseH: srcH, baseW: Math.round(srcH * TARGET_RATIO) };
  }
  // taller or equal — width-limited
  return { baseW: srcW, baseH: Math.round(srcW / TARGET_RATIO) };
}

/** Crop size at a given zoom (still 3:4). */
export function cropSizeAtZoom(srcW: number, srcH: number, zoom: number): { sw: number; sh: number } {
  const { baseW, baseH } = basePortraitRect(srcW, srcH);
  const z = clamp(zoom || 1, MIN_ZOOM, MAX_ZOOM);
  let sw = Math.max(8, Math.round(baseW / z));
  let sh = Math.max(8, Math.round(baseH / z));
  // keep exact 3:4 after rounding
  if (sw / sh > TARGET_RATIO) sw = Math.round(sh * TARGET_RATIO);
  else sh = Math.round(sw / TARGET_RATIO);
  sw = Math.min(sw, srcW);
  sh = Math.min(sh, srcH);
  return { sw, sh };
}

/** Max source origin for the crop window (0 when no room to pan). */
export function panMax(srcW: number, srcH: number, zoom: number): { maxSx: number; maxSy: number; sw: number; sh: number } {
  const { sw, sh } = cropSizeAtZoom(srcW, srcH, zoom);
  return {
    sw,
    sh,
    maxSx: Math.max(0, srcW - sw),
    maxSy: Math.max(0, srcH - sh),
  };
}

/** Map normalized offset (-1..1) → source origin. */
export function originFromOffset(offset: number, maxOrigin: number): number {
  if (maxOrigin <= 0) return 0;
  return Math.round(maxOrigin * (0.5 + clamp(offset, -1, 1) * 0.5));
}

/** Map source origin → normalized offset (-1..1). */
export function offsetFromOrigin(origin: number, maxOrigin: number): number {
  if (maxOrigin <= 0) return 0;
  return clamp((origin / maxOrigin) * 2 - 1, -1, 1);
}

/** Source rect (sx,sy,sw,sh) for a 3:4 portrait crop with pan + zoom. */
export function computePortraitCropRect(
  srcW: number,
  srcH: number,
  offsetX = 0,
  offsetY = 0,
  zoom = 1,
): { sx: number; sy: number; sw: number; sh: number } {
  const { maxSx, maxSy, sw, sh } = panMax(srcW, srcH, zoom);
  const sx = clamp(originFromOffset(offsetX, maxSx), 0, maxSx);
  const sy = clamp(originFromOffset(offsetY, maxSy), 0, maxSy);
  return { sx, sy, sw, sh };
}

/**
 * Reclamp offsets after zoom changes so crop stays inside the image.
 * When an axis has no pan room, that offset is forced to 0.
 */
export function clampCropOffsets(
  srcW: number,
  srcH: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): { x: number; y: number } {
  const { maxSx, maxSy } = panMax(srcW, srcH, zoom);
  return {
    x: maxSx <= 0 ? 0 : clamp(offsetX, -1, 1),
    y: maxSy <= 0 ? 0 : clamp(offsetY, -1, 1),
  };
}

/**
 * WYSIWYG preview layout: place the full image inside a frame so the active
 * crop rectangle exactly fills the frame (same math as export).
 */
export function computeCropPreviewLayout(
  srcW: number,
  srcH: number,
  frameW: number,
  frameH: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
): {
  imgW: number;
  imgH: number;
  left: number;
  top: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  scale: number;
  maxSx: number;
  maxSy: number;
} {
  const { sx, sy, sw, sh } = computePortraitCropRect(srcW, srcH, offsetX, offsetY, zoom);
  const { maxSx, maxSy } = panMax(srcW, srcH, zoom);
  // Fill the 3:4 frame with the crop region
  const scale = frameW > 0 && frameH > 0
    ? Math.min(frameW / sw, frameH / sh)
    : 1;
  return {
    imgW: srcW * scale,
    imgH: srcH * scale,
    left: -sx * scale,
    top: -sy * scale,
    sx,
    sy,
    sw,
    sh,
    scale,
    maxSx,
    maxSy,
  };
}

/**
 * Convert a pointer drag (frame pixels) into a new offset.
 * Dragging the image right reveals content to the left (sx decreases).
 */
export function panOffsetsByDelta(
  srcW: number,
  srcH: number,
  offsetX: number,
  offsetY: number,
  zoom: number,
  deltaFrameX: number,
  deltaFrameY: number,
  scale: number,
): { x: number; y: number } {
  if (scale <= 0) return clampCropOffsets(srcW, srcH, offsetX, offsetY, zoom);
  const { maxSx, maxSy, sx, sy } = (() => {
    const r = computePortraitCropRect(srcW, srcH, offsetX, offsetY, zoom);
    const m = panMax(srcW, srcH, zoom);
    return { maxSx: m.maxSx, maxSy: m.maxSy, sx: r.sx, sy: r.sy };
  })();

  const nextSx = clamp(sx - deltaFrameX / scale, 0, maxSx);
  const nextSy = clamp(sy - deltaFrameY / scale, 0, maxSy);
  return {
    x: offsetFromOrigin(nextSx, maxSx),
    y: offsetFromOrigin(nextSy, maxSy),
  };
}

export async function cropToPortrait3x4(
  file: File | Blob,
  maxWidth = DEFAULT_W,
  maxHeight = DEFAULT_H,
  offsetX = 0,
  offsetY = 0,
  zoom = 1,
): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const { sx, sy, sw, sh } = computePortraitCropRect(
      bitmap.width,
      bitmap.height,
      offsetX,
      offsetY,
      zoom,
    );

    // scale down only if larger than max
    let outW = sw;
    let outH = sh;
    if (outW > maxWidth || outH > maxHeight) {
      const scale = Math.min(maxWidth / outW, maxHeight / outH);
      outW = Math.round(outW * scale);
      outH = Math.round(outH * scale);
    }
    // enforce exact 3:4 after rounding
    if (Math.abs(outW / outH - TARGET_RATIO) > 0.01) {
      outH = Math.round(outW / TARGET_RATIO);
    }

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas not available');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, outW, outH);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Failed to encode image'))),
        'image/png',
        0.95,
      );
    });
    return blob;
  } finally {
    bitmap.close();
  }
}

export async function fileToBase64Cropped(
  file: File,
  zoom = 1,
  offsetX = 0,
  offsetY = 0,
): Promise<string> {
  const blob = await cropToPortrait3x4(file, DEFAULT_W, DEFAULT_H, offsetX, offsetY, zoom);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Load natural pixel size for a blob/file/url. */
export function loadImageSize(src: string | Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = typeof src === 'string' ? src : URL.createObjectURL(src);
    const img = new Image();
    img.onload = () => {
      const width = img.naturalWidth || img.width;
      const height = img.naturalHeight || img.height;
      if (typeof src !== 'string') URL.revokeObjectURL(url);
      if (!width || !height) reject(new Error('Could not read image size'));
      else resolve({ width, height });
    };
    img.onerror = () => {
      if (typeof src !== 'string') URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };
    img.src = url;
  });
}
