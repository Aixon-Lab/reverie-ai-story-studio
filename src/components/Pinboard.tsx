import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { ClipboardPaste, FolderOpen, Pin, X } from 'lucide-react';
import '../pinboard.css';

type Frame = { x: number; y: number; w: number; h: number };
const BAR = 44;

function fit(frame: Frame): Frame {
  const w = Math.min(frame.w, Math.max(1, window.innerWidth - 16));
  const h = Math.min(frame.h, Math.max(1, window.innerHeight - 16));
  return { w, h, x: Math.max(8, Math.min(frame.x, window.innerWidth - w - 8)),
    y: Math.max(8, Math.min(frame.y, window.innerHeight - h - 8)) };
}

function Board({ onClose }: { onClose: () => void }) {
  const [frame, setFrame] = useState(() => fit({ x: window.innerWidth - 400, y: 80, w: 360, h: 280 }));
  const [picture, setPicture] = useState<{ src: string; name: string; ratio: number } | null>(null);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const urls = useRef(new Set<string>());
  const generation = useRef(0);
  const gesture = useRef<{ mode: 'move' | 'resize'; x: number; y: number; frame: Frame } | null>(null);

  useEffect(() => {
    root.current?.focus();
    const resize = () => setFrame(fit);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      generation.current++;
      urls.current.forEach(url => URL.revokeObjectURL(url));
      urls.current.clear();
    };
  }, []);

  async function openImage(file: Blob, name = 'Pinned image') {
    if (!file.type.startsWith('image/')) { setError('Choose an image file.'); return; }
    const request = ++generation.current;
    const src = URL.createObjectURL(file);
    urls.current.add(src);
    const img = new Image();
    img.src = src;
    try {
      await img.decode();
      if (request !== generation.current) return;
      const ratio = img.naturalWidth / img.naturalHeight;
      const w = Math.min(480, img.naturalWidth, window.innerWidth - 16,
        Math.max(1, window.innerHeight - BAR - 16) * ratio);
      setFrame(f => fit({ ...f, w: Math.max(240, w), h: Math.max(140, w / ratio) + BAR }));
      setPicture({ src, name, ratio });
      setError('');
      // Replacing an image releases the previous local preview.
      urls.current.forEach(url => { if (url !== src) { URL.revokeObjectURL(url); urls.current.delete(url); } });
    } catch {
      if (request === generation.current) setError('This image could not be opened. Try PNG, JPEG, WebP, or GIF.');
    } finally {
      if (request !== generation.current || !img.naturalWidth) {
        URL.revokeObjectURL(src); urls.current.delete(src);
      }
    }
  }

  async function paste() {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find(t => t.startsWith('image/'));
        if (type) { await openImage(await item.getType(type)); return; }
      }
      setError('Copy an image first, then paste it here.');
    } catch { setError('Click this board and press Ctrl+V (or ⌘V) to paste an image.'); }
  }

  function begin(e: PointerEvent<HTMLElement>, mode: 'move' | 'resize') {
    if (e.button !== 0 || (mode === 'move' && (e.target as HTMLElement).closest('button'))) return;
    e.preventDefault();
    root.current?.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = { mode, x: e.clientX, y: e.clientY, frame };
  }
  function move(e: PointerEvent<HTMLElement>) {
    const g = gesture.current;
    if (!g) return;
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (g.mode === 'move') setFrame(fit({ ...g.frame, x: g.frame.x + dx, y: g.frame.y + dy }));
    else {
      const ratio = picture?.ratio ?? g.frame.w / (g.frame.h - BAR);
      const delta = Math.abs(dx) > Math.abs(dy * ratio) ? dx : dy * ratio;
      const maxW = Math.min(window.innerWidth - g.frame.x - 8,
        Math.max(1, window.innerHeight - g.frame.y - BAR - 8) * ratio);
      const w = Math.min(maxW, Math.max(240, g.frame.w + delta));
      setFrame(fit({ ...g.frame, w: Math.max(240, w), h: Math.max(140, w / ratio) + BAR }));
    }
  }
  const end = () => { gesture.current = null; };

  return createPortal(<div ref={root} className={`portrait-float pinboard${dragOver ? ' is-drag-over' : ''}`}
    role="dialog" aria-label="Pinboard" tabIndex={-1}
    style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h }}
    onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    onPaste={e => {
      const file = Array.from(e.clipboardData.files).find(f => f.type.startsWith('image/'));
      if (file) { e.preventDefault(); e.stopPropagation(); void openImage(file, file.name); }
    }}
    onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDragOver(true); }}
    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
    onDrop={e => {
      e.preventDefault(); e.stopPropagation(); setDragOver(false);
      const file = Array.from(e.dataTransfer.files).find(f => f.type.startsWith('image/'));
      if (file) void openImage(file, file.name);
      else setError('Drop an image file here, or copy an image and paste it.');
    }}>
    <div className="pinboard-bar" onPointerDown={e => begin(e, 'move')}>
      <span><Pin size={14} /> Pinboard</span>
      <button className="icon-btn" aria-label="Browse for an image" title="Browse for an image" onClick={() => input.current?.click()}><FolderOpen size={16} /></button>
      <button className="icon-btn" aria-label="Paste image" title="Paste image" onClick={() => void paste()}><ClipboardPaste size={16} /></button>
      <button className="icon-btn" aria-label="Close pinboard" title="Close pinboard" onClick={onClose}><X size={16} /></button>
    </div>
    <input ref={input} type="file" accept="image/*" hidden onChange={e => {
      const file = e.target.files?.[0]; if (file) void openImage(file, file.name); e.target.value = '';
    }} />
    <div className="pinboard-image" onPointerDown={e => begin(e, 'move')}>
      {picture ? <img src={picture.src} alt={picture.name} draggable={false} /> : <div className="pinboard-empty">
        <Pin size={28} strokeWidth={1.3} />
        <p>Drop an image or paste it here</p>
        <button className="btn btn-secondary btn-sm" onClick={() => input.current?.click()}><FolderOpen size={14} /> Browse images</button>
        <p className="t-caption">Drag to move · corner to resize</p>
      </div>}
    </div>
    {error && <p className="pinboard-error" role="alert">{error}</p>}
    <button className="portrait-float-resize" aria-label="Resize pinboard" title="Drag to resize; arrow keys also resize"
      onPointerDown={e => begin(e, 'resize')} onKeyDown={e => {
        if (!['ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        const w = Math.max(240, frame.w + (['ArrowRight', 'ArrowUp'].includes(e.key) ? 20 : -20));
        setFrame(fit({ ...frame, w, h: Math.max(140, w / (picture?.ratio ?? 1.5)) + BAR }));
      }} />
  </div>, document.body);
}

export function Pinboard() {
  const [open, setOpen] = useState(false);
  return <>
    <button className="btn btn-secondary btn-sm pinboard-toggle" title="Open pinboard" aria-label="Open pinboard"
      aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><Pin size={16} /></button>
    {open && <Board onClose={() => setOpen(false)} />}
  </>;
}
