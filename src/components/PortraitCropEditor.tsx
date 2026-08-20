/**
 * Full portrait photo editor (Snapseed-style, no brushes).
 * Crop/zoom/pan + light/color/detail/effects/filters + rotate/flip.
 * Preview canvas uses the same pipeline as Apply.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Aperture,
  ArrowLeftRight,
  ArrowUpDown,
  Check,
  CircleDot,
  Contrast,
  Droplets,
  Eclipse,
  FlipHorizontal2,
  FlipVertical2,
  Focus,
  Lightbulb,
  Maximize2,
  Moon,
  Palette,
  RotateCcw,
  RotateCw,
  Sparkles,
  Sun,
  SunMedium,
  Thermometer,
  Waves,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { GlobeLoader } from './GlobeLoader';
import {
  clamp,
  clampCropOffsets,
  loadImageSize,
  MAX_ZOOM,
  MIN_ZOOM,
  panMax,
  panOffsetsByDelta,
  computePortraitCropRect,
} from '../lib/imageCrop';
import {
  type ImageAdjustments,
  type PortraitEditState,
  type RotateDeg,
  FILTER_PRESETS,
  adjustmentsAreDefault,
  applyFilterPreset,
  defaultPortraitEdit,
  loadHtmlImage,
  renderPortraitEdit,
  transformedSize,
} from '../lib/imageAdjust';

export interface PortraitCropEditorProps {
  file: File | Blob;
  imageUrl: string;
  onCancel: () => void;
  onApply: (blob: Blob) => void | Promise<void>;
  title?: string;
  applyLabel?: string;
}

type ToolId = 'crop' | 'light' | 'color' | 'detail' | 'effects' | 'filters' | 'rotate';

const TOOLS: { id: ToolId; label: string; Icon: typeof SunMedium }[] = [
  { id: 'crop', label: 'Crop', Icon: Aperture },
  { id: 'light', label: 'Light', Icon: Lightbulb },
  { id: 'color', label: 'Color', Icon: Palette },
  { id: 'detail', label: 'Detail', Icon: Focus },
  { id: 'effects', label: 'Effects', Icon: Eclipse },
  { id: 'filters', label: 'Looks', Icon: Sparkles },
  { id: 'rotate', label: 'Turn', Icon: RotateCw },
];

interface SliderDef {
  key: keyof ImageAdjustments;
  label: string;
  min?: number;
  max?: number;
  Icon: typeof Sun;
}

const LIGHT_SLIDERS: SliderDef[] = [
  { key: 'brightness', label: 'Brightness', Icon: Sun },
  { key: 'contrast', label: 'Contrast', Icon: Contrast },
  { key: 'exposure', label: 'Exposure', Icon: SunMedium },
  { key: 'highlights', label: 'Highlights', Icon: Maximize2 },
  { key: 'shadows', label: 'Shadows', Icon: Moon },
  { key: 'ambiance', label: 'Ambiance', Icon: Lightbulb },
];

const COLOR_SLIDERS: SliderDef[] = [
  { key: 'saturation', label: 'Saturation', Icon: Droplets },
  { key: 'vibrance', label: 'Vibrance', Icon: Waves },
  { key: 'warmth', label: 'Warmth', Icon: Thermometer },
  { key: 'tint', label: 'Tint', Icon: Palette },
];

const DETAIL_SLIDERS: SliderDef[] = [
  { key: 'sharpness', label: 'Sharpness', min: 0, max: 100, Icon: Focus },
  { key: 'clarity', label: 'Clarity', Icon: CircleDot },
];

const EFFECT_SLIDERS: SliderDef[] = [
  { key: 'fade', label: 'Fade', min: 0, max: 100, Icon: Waves },
  { key: 'vignette', label: 'Vignette', min: 0, max: 100, Icon: Eclipse },
  { key: 'grain', label: 'Grain', min: 0, max: 100, Icon: Sparkles },
];

export function PortraitCropEditor({
  file,
  imageUrl,
  onCancel,
  onApply,
  title = 'Edit portrait',
  applyLabel = 'Apply',
}: PortraitCropEditorProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const rafRef = useRef(0);
  const dragRef = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null);

  const [srcSize, setSrcSize] = useState<{ w: number; h: number } | null>(null);
  const [frameSize, setFrameSize] = useState({ w: 260, h: 347 });
  const [edit, setEdit] = useState<PortraitEditState>(() => defaultPortraitEdit());
  const [tool, setTool] = useState<ToolId>('crop');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [ready, setReady] = useState(false);

  // Load image
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setEdit(defaultPortraitEdit());
    setTool('crop');
    setError('');
    void (async () => {
      try {
        const [size, img] = await Promise.all([loadImageSize(imageUrl), loadHtmlImage(imageUrl)]);
        if (cancelled) return;
        imgRef.current = img;
        setSrcSize({ w: size.width, h: size.height });
        setReady(true);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Failed to load image');
      }
    })();
    return () => {
      cancelled = true;
      imgRef.current = null;
    };
  }, [imageUrl]);

  // Measure frame
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cr = entries[0]?.contentRect;
      if (!cr) return;
      setFrameSize({
        w: Math.max(1, Math.round(cr.width)),
        h: Math.max(1, Math.round(cr.height)),
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const workSize = useMemo(() => {
    if (!srcSize) return null;
    return transformedSize(srcSize.w, srcSize.h, edit.transform);
  }, [srcSize, edit.transform]);

  const limits = useMemo(() => {
    if (!workSize) return { maxSx: 0, maxSy: 0 };
    return panMax(workSize.w, workSize.h, edit.crop.zoom);
  }, [workSize, edit.crop.zoom]);

  // Live preview render
  const schedulePreview = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      void paintPreview();
    });

    async function paintPreview() {
      const img = imgRef.current;
      const canvas = canvasRef.current;
      if (!img || !canvas || !srcSize || !ready) return;
      try {
        const maxEdge = Math.max(frameSize.w, frameSize.h) * (window.devicePixelRatio || 1);
        const maxW = Math.min(540, Math.round(maxEdge));
        const maxH = Math.round(maxW / (3 / 4));
        const { canvas: rendered } = await renderPortraitEdit(img, edit, {
          maxWidth: maxW,
          maxHeight: maxH,
          preview: true,
        });
        canvas.width = rendered.width;
        canvas.height = rendered.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(rendered, 0, 0);
      } catch {
        /* ignore mid-drag races */
      }
    }
  }, [edit, frameSize, ready, srcSize]);

  useEffect(() => {
    schedulePreview();
    return () => cancelAnimationFrame(rafRef.current);
  }, [schedulePreview]);

  function patchCrop(partial: Partial<PortraitEditState['crop']>) {
    setEdit((e) => {
      if (!workSize) return { ...e, crop: { ...e.crop, ...partial } };
      const crop = { ...e.crop, ...partial };
      const clamped = clampCropOffsets(workSize.w, workSize.h, crop.offsetX, crop.offsetY, crop.zoom);
      return { ...e, crop: { ...crop, offsetX: clamped.x, offsetY: clamped.y }, filterId: e.filterId };
    });
  }

  function patchAdjust(key: keyof ImageAdjustments, value: number) {
    setEdit((e) => ({
      ...e,
      filterId: null, // manual tweak clears named filter badge (values remain)
      adjust: { ...e.adjust, [key]: value },
    }));
  }

  const workSizeRef = useRef(workSize);
  workSizeRef.current = workSize;
  const toolRef = useRef(tool);
  toolRef.current = tool;

  function setZoomClamped(nextZoom: number) {
    const z = Math.round(clamp(nextZoom, MIN_ZOOM, MAX_ZOOM) * 100) / 100;
    setEdit((e) => {
      const ws = workSizeRef.current;
      if (!ws) return { ...e, crop: { ...e.crop, zoom: z } };
      const clamped = clampCropOffsets(ws.w, ws.h, e.crop.offsetX, e.crop.offsetY, z);
      return { ...e, crop: { zoom: z, offsetX: clamped.x, offsetY: clamped.y } };
    });
  }

  // Wheel zoom on frame (crop tool only)
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      if (toolRef.current !== 'crop') return;
      ev.preventDefault();
      const step = ev.deltaY > 0 ? -0.1 : 0.1;
      setEdit((e) => {
        const z = Math.round(clamp(e.crop.zoom + step, MIN_ZOOM, MAX_ZOOM) * 100) / 100;
        const ws = workSizeRef.current;
        if (!ws) return { ...e, crop: { ...e.crop, zoom: z } };
        const clamped = clampCropOffsets(ws.w, ws.h, e.crop.offsetX, e.crop.offsetY, z);
        return { ...e, crop: { zoom: z, offsetX: clamped.x, offsetY: clamped.y } };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ready]);

  function onPointerDown(e: React.PointerEvent) {
    if (tool !== 'crop' || !workSize) return;
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
    setDragging(true);
  }

  function onPointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId || !workSize) return;
    e.preventDefault();
    const dx = e.clientX - drag.lastX;
    const dy = e.clientY - drag.lastY;
    drag.lastX = e.clientX;
    drag.lastY = e.clientY;
    if (!dx && !dy) return;

    // Map frame drag → source pan using same scale as crop→frame
    const { sw } = computePortraitCropRect(
      workSize.w,
      workSize.h,
      edit.crop.offsetX,
      edit.crop.offsetY,
      edit.crop.zoom,
    );
    const scale = frameSize.w / Math.max(1, sw);
    setEdit((st) => {
      const next = panOffsetsByDelta(
        workSize.w,
        workSize.h,
        st.crop.offsetX,
        st.crop.offsetY,
        st.crop.zoom,
        dx,
        dy,
        scale,
      );
      return { ...st, crop: { ...st.crop, offsetX: next.x, offsetY: next.y } };
    });
  }

  function endDrag(e: React.PointerEvent) {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null;
      setDragging(false);
    }
  }

  function rotateBy(delta: 90 | -90) {
    setEdit((e) => {
      const next = ((((e.transform.rotate + delta) % 360) + 360) % 360) as RotateDeg;
      // Reset pan after rotate — axes change
      return {
        ...e,
        transform: { ...e.transform, rotate: next },
        crop: { ...e.crop, offsetX: 0, offsetY: 0 },
      };
    });
  }

  function toggleFlip(axis: 'h' | 'v') {
    setEdit((e) => ({
      ...e,
      transform: {
        ...e.transform,
        flipH: axis === 'h' ? !e.transform.flipH : e.transform.flipH,
        flipV: axis === 'v' ? !e.transform.flipV : e.transform.flipV,
      },
    }));
  }

  function pickFilter(id: string) {
    const { filterId, adjust } = applyFilterPreset(id === 'none' ? null : id);
    setEdit((e) => ({ ...e, filterId, adjust }));
  }

  function resetAll() {
    setEdit(defaultPortraitEdit());
    setTool('crop');
  }

  function resetTool() {
    if (tool === 'crop') {
      patchCrop({ offsetX: 0, offsetY: 0, zoom: 1 });
    } else if (tool === 'rotate') {
      setEdit((e) => ({ ...e, transform: { rotate: 0, flipH: false, flipV: false }, crop: { ...e.crop, offsetX: 0, offsetY: 0 } }));
    } else if (tool === 'filters') {
      pickFilter('none');
    } else if (tool === 'light') {
      setEdit((e) => ({
        ...e,
        filterId: null,
        adjust: {
          ...e.adjust,
          brightness: 0,
          contrast: 0,
          exposure: 0,
          highlights: 0,
          shadows: 0,
          ambiance: 0,
        },
      }));
    } else if (tool === 'color') {
      setEdit((e) => ({
        ...e,
        filterId: null,
        adjust: { ...e.adjust, saturation: 0, vibrance: 0, warmth: 0, tint: 0 },
      }));
    } else if (tool === 'detail') {
      setEdit((e) => ({
        ...e,
        filterId: null,
        adjust: { ...e.adjust, sharpness: 0, clarity: 0 },
      }));
    } else if (tool === 'effects') {
      setEdit((e) => ({
        ...e,
        filterId: null,
        adjust: { ...e.adjust, fade: 0, vignette: 0, grain: 0 },
      }));
    }
  }

  async function handleApply() {
    const img = imgRef.current;
    if (!img || !srcSize) return;
    setBusy(true);
    setError('');
    try {
      // Ensure crop offsets valid for final transform size
      const { w, h } = transformedSize(srcSize.w, srcSize.h, edit.transform);
      const clamped = clampCropOffsets(w, h, edit.crop.offsetX, edit.crop.offsetY, edit.crop.zoom);
      const state: PortraitEditState = {
        ...edit,
        crop: { ...edit.crop, offsetX: clamped.x, offsetY: clamped.y },
      };
      const { blob } = await renderPortraitEdit(img, state, {
        maxWidth: 1080,
        maxHeight: 1440,
      });
      if (!blob) throw new Error('Encode failed');
      await onApply(blob);
    } catch (err: any) {
      setError(err?.message ?? 'Export failed');
    } finally {
      setBusy(false);
    }
  }

  // silence unused file warning — kept for API parity / future EXIF
  void file;

  const canPanX = limits.maxSx > 0;
  const canPanY = limits.maxSy > 0;
  const cropCursor = tool === 'crop' ? (dragging ? 'grabbing' : 'grab') : 'default';

  return (
    <div className="creator-modal-backdrop photo-editor-backdrop" role="dialog" aria-label={title}>
      <div className="creator-modal photo-editor-modal">
        <div className="photo-editor-header">
          <h2 className="t-heading">{title}</h2>
          <p className="t-caption">
            Crop, light, color, detail, filters — same look on Apply. Drag to pan when Crop is selected.
          </p>
        </div>

        <div
          ref={frameRef}
          className={`creator-crop-frame photo-editor-frame${dragging ? ' is-dragging' : ''}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          style={{ touchAction: 'none', cursor: cropCursor }}
        >
          <canvas ref={canvasRef} className="photo-editor-canvas" />
          {!ready && (
            <div className="creator-crop-loading t-caption">
              <GlobeLoader size={22} label="Loading image…" />
            </div>
          )}
          {tool === 'crop' && (
            <div className="creator-crop-guides" aria-hidden>
              <span /><span /><span /><span />
            </div>
          )}
        </div>

        {/* Tool rail — raised white “bulbs” when active */}
        <div className="photo-editor-tools" role="tablist" aria-label="Edit tools">
          {TOOLS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tool === id}
              className={`photo-editor-tool${tool === id ? ' is-active' : ''}`}
              onClick={() => setTool(id)}
            >
              <span className="photo-editor-tool-bulb" aria-hidden>
                <Icon size={18} strokeWidth={1.75} />
              </span>
              <span>{label}</span>
            </button>
          ))}
        </div>

        {/* Tool panel */}
        <div className="photo-editor-panel">
          {tool === 'crop' && (
            <>
              <div className="creator-crop-zoom-row">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Zoom out"
                  disabled={edit.crop.zoom <= MIN_ZOOM}
                  onClick={() => setZoomClamped(edit.crop.zoom - 0.15)}
                >
                  <ZoomOut size={16} strokeWidth={1.75} />
                </button>
                <div style={{ flex: 1 }}>
                  <NwFader
                    label="Zoom"
                    icon={<Maximize2 strokeWidth={1.75} />}
                    min={MIN_ZOOM}
                    max={MAX_ZOOM}
                    step={0.05}
                    value={edit.crop.zoom}
                    display={`${edit.crop.zoom.toFixed(2)}×`}
                    onChange={setZoomClamped}
                  />
                </div>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Zoom in"
                  disabled={edit.crop.zoom >= MAX_ZOOM}
                  onClick={() => setZoomClamped(edit.crop.zoom + 0.15)}
                >
                  <ZoomIn size={16} strokeWidth={1.75} />
                </button>
              </div>
              <NwFader
                label="Left — Right"
                hint={canPanX ? 'drag frame or slide' : 'at edge'}
                icon={<ArrowLeftRight strokeWidth={1.75} />}
                min={-1}
                max={1}
                step={0.01}
                value={canPanX ? edit.crop.offsetX : 0}
                disabled={!canPanX}
                display={canPanX ? formatSigned(edit.crop.offsetX * 100, 0) : '—'}
                onChange={(v) => patchCrop({ offsetX: v })}
              />
              <NwFader
                label="Up — Down"
                hint={canPanY ? 'drag frame or slide' : 'at edge'}
                icon={<ArrowUpDown strokeWidth={1.75} />}
                min={-1}
                max={1}
                step={0.01}
                value={canPanY ? edit.crop.offsetY : 0}
                disabled={!canPanY}
                display={canPanY ? formatSigned(edit.crop.offsetY * 100, 0) : '—'}
                onChange={(v) => patchCrop({ offsetY: v })}
              />
            </>
          )}

          {tool === 'light' && (
            <div className="photo-editor-sliders">
              {LIGHT_SLIDERS.map((s) => (
                <AdjustSlider key={s.key} def={s} value={edit.adjust[s.key]} onChange={patchAdjust} />
              ))}
            </div>
          )}

          {tool === 'color' && (
            <div className="photo-editor-sliders">
              {COLOR_SLIDERS.map((s) => (
                <AdjustSlider key={s.key} def={s} value={edit.adjust[s.key]} onChange={patchAdjust} />
              ))}
            </div>
          )}

          {tool === 'detail' && (
            <div className="photo-editor-sliders">
              {DETAIL_SLIDERS.map((s) => (
                <AdjustSlider key={s.key} def={s} value={edit.adjust[s.key]} onChange={patchAdjust} />
              ))}
            </div>
          )}

          {tool === 'effects' && (
            <div className="photo-editor-sliders">
              {EFFECT_SLIDERS.map((s) => (
                <AdjustSlider key={s.key} def={s} value={edit.adjust[s.key]} onChange={patchAdjust} />
              ))}
            </div>
          )}

          {tool === 'filters' && (
            <div className="photo-editor-filters">
              {FILTER_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`photo-editor-filter${(edit.filterId ?? 'none') === p.id || (p.id === 'none' && !edit.filterId && adjustmentsAreDefault(edit.adjust)) ? ' is-active' : ''}`}
                  onClick={() => pickFilter(p.id)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}

          {tool === 'rotate' && (
            <div className="photo-editor-rotate">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => rotateBy(-90)}>
                <RotateCcw size={16} strokeWidth={1.75} /> 90° left
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => rotateBy(90)}>
                <RotateCw size={16} strokeWidth={1.75} /> 90° right
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => toggleFlip('h')}>
                <FlipHorizontal2 size={16} strokeWidth={1.75} /> Flip H{edit.transform.flipH ? ' ✓' : ''}
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => toggleFlip('v')}>
                <FlipVertical2 size={16} strokeWidth={1.75} /> Flip V{edit.transform.flipV ? ' ✓' : ''}
              </button>
              <p className="t-caption" style={{ gridColumn: '1 / -1' }}>
                Rotation: {edit.transform.rotate}°
                {edit.transform.flipH ? ' · flipped H' : ''}
                {edit.transform.flipV ? ' · flipped V' : ''}
              </p>
            </div>
          )}
        </div>

        {error && (
          <p className="t-caption" style={{ color: 'var(--danger)', marginTop: 8 }}>{error}</p>
        )}

        <div className="btn-row photo-editor-actions">
          <div className="btn-row" style={{ gap: 6 }}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={resetTool} title="Reset current tool">
              Reset tool
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={resetAll} title="Reset everything">
              <RotateCcw size={14} /> All
            </button>
          </div>
          <div className="btn-row">
            <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={busy}>
              <X size={16} /> Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void handleApply()}
              disabled={busy || !ready}
            >
              {busy ? <GlobeLoader size={16} /> : <Check size={16} />} {busy ? 'Applying…' : applyLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatSigned(n: number, digits = 0): string {
  const v = digits > 0 ? n.toFixed(digits) : String(Math.round(n));
  const num = Number(v);
  if (num > 0) return `+${v}`;
  return v;
}

function pctFromValue(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return Math.round(((value - min) / (max - min)) * 1000) / 10;
}

/** Analogue Noir monochrome fader — white fill/thumb, hairline rail, bulb icon. */
function NwFader({
  label,
  hint,
  icon,
  min,
  max,
  step,
  value,
  display,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  min: number;
  max: number;
  step: number;
  value: number;
  display?: string;
  disabled?: boolean;
  onChange: (v: number) => void;
}) {
  const pct = pctFromValue(value, min, max);
  return (
    <div className="nw-fader" style={disabled ? { opacity: 0.45 } : undefined}>
      <div className="nw-fader-head">
        {icon != null && <span className="nw-fader-icon">{icon}</span>}
        <span className="nw-fader-label">{label}</span>
        {hint && <span className="nw-fader-hint">{hint}</span>}
        <span className="nw-fader-value">{display ?? formatSigned(value)}</span>
      </div>
      <div className="nw-fader-track">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ ['--pct' as string]: `${pct}%` }}
          aria-label={label}
        />
      </div>
    </div>
  );
}

function AdjustSlider({
  def,
  value,
  onChange,
}: {
  def: SliderDef;
  value: number;
  onChange: (key: keyof ImageAdjustments, v: number) => void;
}) {
  const min = def.min ?? -100;
  const max = def.max ?? 100;
  const Icon = def.Icon;
  return (
    <NwFader
      label={def.label}
      icon={<Icon strokeWidth={1.75} />}
      min={min}
      max={max}
      step={1}
      value={value}
      display={formatSigned(value)}
      onChange={(v) => onChange(def.key, v)}
    />
  );
}
