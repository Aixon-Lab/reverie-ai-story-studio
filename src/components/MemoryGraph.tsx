/**
 * Memory network visualiser.
 *
 * A dependency-free force-directed graph rendered to canvas, in 2D or rotating
 * 3D. Every visual channel is bound to a real quantity from the engine — nothing
 * here is decorative:
 *
 *   radius     → activation strength (how available the memory is right now)
 *   fill       → affective valence (cold blue = painful, warm amber = good)
 *   ring       → arousal (how charged it is)
 *   opacity    → status (active / faded / dormant ghost)
 *   halo       → identity or pinned (permanent)
 *   pulse      → intrusive trauma trace
 *   edge hue   → relation type
 *   edge alpha → association weight
 *
 * The layout is a grid-accelerated spring system: O(n·k) per frame, so it stays
 * smooth into the thousands of nodes on a local machine.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BrainGraphEdge, BrainGraphNode } from '../api';

export interface MemoryGraphProps {
  nodes: BrainGraphNode[];
  edges: BrainGraphEdge[];
  mode: '2d' | '3d';
  selectedId?: string | null;
  highlightIds?: string[];
  onSelect?: (id: string | null) => void;
  /** Show dormant nodes as ghosts rather than hiding them. */
  showForgotten?: boolean;
  className?: string;
}

const EDGE_COLORS: Record<string, string> = {
  caused: '#f0a63a',
  led_to: '#f0a63a',
  contradicts: '#e2506a',
  reminds_of: '#7b8ba3',
  about_person: '#57b0e8',
  at_place: '#5fc2a4',
  during: '#8d7bd6',
  instance_of: '#b98cf0',
  co_occurred: '#6b7686',
  resolved: '#5fc2a4',
  broke_promise: '#e2506a',
  kept_promise: '#5fc2a4',
  derived_from: '#b98cf0',
  motivated_by: '#8d7bd6',
  supports: '#5fc2a4',
  chose_over: '#f0a63a',
};

interface Sim {
  ids: string[];
  index: Map<string, number>;
  x: Float32Array; y: Float32Array; z: Float32Array;
  vx: Float32Array; vy: Float32Array; vz: Float32Array;
  /** Node draw radius in world units. */
  r: Float32Array;
  links: { a: number; b: number; w: number; kind: string }[];
  alpha: number;
}

/** Deterministic pseudo-random so a graph lays out the same way each visit. */
function hashUnit(s: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function buildSim(nodes: BrainGraphNode[], edges: BrainGraphEdge[], mode: '2d' | '3d'): Sim {
  const ids = nodes.map((n) => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const sim: Sim = {
    ids,
    index,
    x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n),
    vx: new Float32Array(n), vy: new Float32Array(n), vz: new Float32Array(n),
    r: new Float32Array(n),
    links: [],
    alpha: 1,
  };

  nodes.forEach((node, i) => {
    // Seed on a sphere/disc so the initial unfold is even, not a random blob.
    const a = hashUnit(node.id, 1) * Math.PI * 2;
    const b = hashUnit(node.id, 2) * Math.PI;
    const rad = 120 + hashUnit(node.id, 3) * 260;
    sim.x[i] = Math.cos(a) * Math.sin(b) * rad;
    sim.y[i] = Math.cos(b) * rad;
    sim.z[i] = mode === '3d' ? Math.sin(a) * Math.sin(b) * rad : 0;
    sim.r[i] = radiusFor(node);
  });

  for (const e of edges) {
    const a = index.get(e.from);
    const b = index.get(e.to);
    if (a === undefined || b === undefined) continue;
    sim.links.push({ a, b, w: e.weight, kind: e.kind });
  }
  return sim;
}

function radiusFor(n: BrainGraphNode): number {
  // Strength is log-scaled activation; map a wide range onto a readable size.
  const s = Math.max(-4, Math.min(6, n.strength));
  const base = 3.2 + (s + 4) * 1.15;
  const kindBoost = n.kind === 'identity' ? 3.5 : n.kind === 'schema' ? 2.5 : n.kind === 'sensory' ? 2 : n.kind === 'semantic' ? 1.4 : 0;
  return Math.max(3, base + kindBoost);
}

function fillFor(n: BrainGraphNode): string {
  // Valence → hue: painful memories read cold/red, good ones warm/amber.
  const v = Math.max(-1, Math.min(1, n.valence));
  const hue = v < 0 ? 352 + v * 14 : 38 + v * 22;
  const sat = 20 + Math.abs(v) * 55;
  const light = 44 + Math.abs(v) * 12;
  if (Math.abs(v) < 0.08) return `hsl(220 8% 58%)`;
  return `hsl(${hue.toFixed(0)} ${sat.toFixed(0)}% ${light.toFixed(0)}%)`;
}

function alphaFor(n: BrainGraphNode): number {
  if (n.status === 'dormant') return 0.16;
  if (n.status === 'faded') return 0.48;
  return 0.92;
}

const GRID_CELL = 70;
const REPULSION = 900;
const CENTER_PULL = 0.0022;

function step(sim: Sim, mode: '2d' | '3d'): void {
  const n = sim.ids.length;
  if (!n) return;
  const dim = mode === '3d' ? 3 : 2;
  const damp = 0.86;

  // --- grid-accelerated repulsion: only compare against nearby cells ---
  const cells = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const key = `${Math.floor(sim.x[i] / GRID_CELL)},${Math.floor(sim.y[i] / GRID_CELL)},${dim === 3 ? Math.floor(sim.z[i] / GRID_CELL) : 0}`;
    const list = cells.get(key);
    if (list) list.push(i);
    else cells.set(key, [i]);
  }

  for (let i = 0; i < n; i++) {
    const cx = Math.floor(sim.x[i] / GRID_CELL);
    const cy = Math.floor(sim.y[i] / GRID_CELL);
    const cz = dim === 3 ? Math.floor(sim.z[i] / GRID_CELL) : 0;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = dim === 3 ? -1 : 0; dz <= (dim === 3 ? 1 : 0); dz++) {
          const list = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!list) continue;
          for (const j of list) {
            if (j === i) continue;
            let ddx = sim.x[i] - sim.x[j];
            let ddy = sim.y[i] - sim.y[j];
            let ddz = dim === 3 ? sim.z[i] - sim.z[j] : 0;
            let d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            if (d2 < 0.01) {
              // Perfectly coincident: nudge deterministically so they separate.
              ddx = (i % 7) - 3; ddy = (j % 5) - 2; ddz = dim === 3 ? (i % 3) - 1 : 0;
              d2 = ddx * ddx + ddy * ddy + ddz * ddz + 0.01;
            }
            if (d2 > GRID_CELL * GRID_CELL * 4) continue;
            const minDist = sim.r[i] + sim.r[j] + 8;
            const force = (REPULSION + minDist * minDist * 0.6) / d2;
            const d = Math.sqrt(d2);
            sim.vx[i] += (ddx / d) * force * sim.alpha * 0.02;
            sim.vy[i] += (ddy / d) * force * sim.alpha * 0.02;
            if (dim === 3) sim.vz[i] += (ddz / d) * force * sim.alpha * 0.02;
          }
        }
      }
    }
  }

  // --- springs: stronger associations pull harder and sit closer ---
  for (const l of sim.links) {
    const ddx = sim.x[l.b] - sim.x[l.a];
    const ddy = sim.y[l.b] - sim.y[l.a];
    const ddz = dim === 3 ? sim.z[l.b] - sim.z[l.a] : 0;
    const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz) || 0.01;
    const rest = 70 + (1 - l.w) * 90 + sim.r[l.a] + sim.r[l.b];
    const k = 0.012 * (0.3 + l.w);
    const f = (d - rest) * k * sim.alpha;
    const fx = (ddx / d) * f, fy = (ddy / d) * f, fz = (ddz / d) * f;
    sim.vx[l.a] += fx; sim.vy[l.a] += fy;
    sim.vx[l.b] -= fx; sim.vy[l.b] -= fy;
    if (dim === 3) { sim.vz[l.a] += fz; sim.vz[l.b] -= fz; }
  }

  // --- gentle centring so the network never drifts off screen ---
  for (let i = 0; i < n; i++) {
    sim.vx[i] -= sim.x[i] * CENTER_PULL;
    sim.vy[i] -= sim.y[i] * CENTER_PULL;
    if (dim === 3) sim.vz[i] -= sim.z[i] * CENTER_PULL;
    else { sim.z[i] *= 0.85; sim.vz[i] = 0; }

    sim.vx[i] *= damp; sim.vy[i] *= damp; sim.vz[i] *= damp;
    // Cap velocity — a single frame must never fling a node across the canvas.
    const speed = Math.hypot(sim.vx[i], sim.vy[i], sim.vz[i]);
    if (speed > 12) {
      const s = 12 / speed;
      sim.vx[i] *= s; sim.vy[i] *= s; sim.vz[i] *= s;
    }
    sim.x[i] += sim.vx[i];
    sim.y[i] += sim.vy[i];
    if (dim === 3) sim.z[i] += sim.vz[i];
  }

  sim.alpha = Math.max(0.06, sim.alpha * 0.994);
}

export function MemoryGraph({
  nodes, edges, mode, selectedId, highlightIds, onSelect, showForgotten = true, className,
}: MemoryGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const simRef = useRef<Sim | null>(null);
  const rafRef = useRef<number>(0);
  const viewRef = useRef({ zoom: 1, panX: 0, panY: 0, yaw: 0.4, pitch: -0.2, spin: true });
  const dragRef = useRef<{ x: number; y: number; button: number } | null>(null);
  const [hover, setHover] = useState<{ node: BrainGraphNode; x: number; y: number } | null>(null);
  const projectedRef = useRef<{ id: string; sx: number; sy: number; sr: number; depth: number }[]>([]);

  const visible = useMemo(
    () => (showForgotten ? nodes : nodes.filter((n) => n.status !== 'dormant')),
    [nodes, showForgotten],
  );
  const byId = useMemo(() => new Map(visible.map((n) => [n.id, n])), [visible]);
  const highlight = useMemo(() => new Set(highlightIds ?? []), [highlightIds]);

  const neighborIds = useMemo(() => {
    if (!selectedId) return new Set<string>();
    const out = new Set<string>();
    for (const e of edges) {
      if (e.from === selectedId) out.add(e.to);
      else if (e.to === selectedId) out.add(e.from);
    }
    return out;
  }, [edges, selectedId]);

  // Rebuild the simulation only when the node/edge set actually changes.
  const topologyKey = useMemo(
    () => `${mode}:${visible.map((n) => n.id).join(',')}|${edges.length}`,
    [mode, visible, edges.length],
  );
  useEffect(() => {
    const prev = simRef.current;
    const next = buildSim(visible, edges.filter((e) => byId.has(e.from) && byId.has(e.to)), mode);
    // Carry over positions for nodes that already existed, so adding a memory
    // does not scramble the whole map the user was reading.
    if (prev) {
      next.ids.forEach((id, i) => {
        const j = prev.index.get(id);
        if (j === undefined) return;
        next.x[i] = prev.x[j]; next.y[i] = prev.y[j]; next.z[i] = prev.z[j];
      });
      next.alpha = 0.6;
    }
    simRef.current = next;
  }, [topologyKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const sim = simRef.current;
    if (!canvas || !sim) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const view = viewRef.current;
    if (mode === '3d' && view.spin && !dragRef.current) view.yaw += 0.0022;

    const cx = w / 2 + view.panX;
    const cy = h / 2 + view.panY;
    const cosY = Math.cos(view.yaw), sinY = Math.sin(view.yaw);
    const cosP = Math.cos(view.pitch), sinP = Math.sin(view.pitch);
    const focal = 900;

    const project = (i: number) => {
      let x = sim.x[i], y = sim.y[i], z = sim.z[i];
      if (mode === '3d') {
        const x1 = x * cosY + z * sinY;
        const z1 = -x * sinY + z * cosY;
        const y1 = y * cosP - z1 * sinP;
        const z2 = y * sinP + z1 * cosP;
        x = x1; y = y1; z = z2;
      } else {
        z = 0;
      }
      const scale = mode === '3d' ? (focal / (focal + z + 400)) * view.zoom : view.zoom;
      return { sx: cx + x * scale, sy: cy + y * scale, scale, depth: z };
    };

    // --- edges, painted behind and back-to-front ---
    const drawn: { id: string; sx: number; sy: number; sr: number; depth: number }[] = [];
    ctx.lineCap = 'round';
    for (const l of sim.links) {
      const a = project(l.a), b = project(l.b);
      const nodeA = byId.get(sim.ids[l.a]);
      const nodeB = byId.get(sim.ids[l.b]);
      if (!nodeA || !nodeB) continue;
      const dim = (nodeA.status === 'dormant' ? 0.3 : 1) * (nodeB.status === 'dormant' ? 0.3 : 1);
      const focused = !selectedId
        || sim.ids[l.a] === selectedId || sim.ids[l.b] === selectedId;
      const alpha = (0.10 + l.w * 0.32) * dim * (focused ? 1 : 0.18);
      if (alpha < 0.02) continue;
      ctx.strokeStyle = hexWithAlpha(EDGE_COLORS[l.kind] ?? '#6b7686', alpha);
      ctx.lineWidth = Math.max(0.5, l.w * 1.9 * ((a.scale + b.scale) / 2));
      ctx.beginPath();
      ctx.moveTo(a.sx, a.sy);
      ctx.lineTo(b.sx, b.sy);
      ctx.stroke();
    }

    // --- nodes, sorted far→near so 3D reads correctly ---
    const order = sim.ids.map((_, i) => i);
    if (mode === '3d') order.sort((i, j) => project(j).depth - project(i).depth);

    const t = performance.now() / 1000;
    for (const i of order) {
      const node = byId.get(sim.ids[i]);
      if (!node) continue;
      const p = project(i);
      const r = Math.max(1.6, sim.r[i] * p.scale);
      drawn.push({ id: node.id, sx: p.sx, sy: p.sy, sr: r, depth: p.depth });

      const isSelected = node.id === selectedId;
      const isNeighbor = neighborIds.has(node.id);
      const isHighlighted = highlight.has(node.id);
      const dimmed = !!selectedId && !isSelected && !isNeighbor;
      let alpha = alphaFor(node) * (dimmed ? 0.2 : 1);
      if (mode === '3d') alpha *= 0.55 + 0.45 * Math.max(0, Math.min(1, p.scale));

      // Permanent memories carry a halo — identity and pins never fade.
      if ((node.kind === 'identity' || node.pinned) && !dimmed) {
        const g = ctx.createRadialGradient(p.sx, p.sy, r * 0.6, p.sx, p.sy, r * 3.2);
        g.addColorStop(0, hexWithAlpha('#f5c451', 0.30 * alpha));
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r * 3.2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Trauma pulses — it is never quite at rest.
      if (node.intrusive && !dimmed) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 2.4 + i);
        const g = ctx.createRadialGradient(p.sx, p.sy, r * 0.4, p.sx, p.sy, r * (2.6 + pulse * 1.6));
        g.addColorStop(0, hexWithAlpha('#e2506a', (0.22 + pulse * 0.20) * alpha));
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r * (2.6 + pulse * 1.6), 0, Math.PI * 2);
        ctx.fill();
      }

      if (isHighlighted && !dimmed) {
        ctx.strokeStyle = hexWithAlpha('#7ee0c0', 0.85);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r + 5, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Arousal ring.
      if (node.arousal > 0.18 && !dimmed) {
        ctx.strokeStyle = hexWithAlpha(fillFor(node), 0.20 + node.arousal * 0.55);
        ctx.lineWidth = Math.max(0.8, node.arousal * 3 * p.scale);
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r + 2.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.fillStyle = hexWithAlpha(fillFor(node), alpha);
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
      ctx.fill();

      // Beliefs are drawn as squares — they are not events.
      if (node.kind === 'schema' && !dimmed) {
        ctx.strokeStyle = hexWithAlpha('#b98cf0', 0.8 * alpha);
        ctx.lineWidth = 1.4;
        ctx.strokeRect(p.sx - r - 3, p.sy - r - 3, (r + 3) * 2, (r + 3) * 2);
      }

      if (isSelected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, r + 6, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Label the ones worth reading at a glance.
      const labelWorthy = r > 11 || isSelected || isNeighbor || node.kind === 'identity' || node.kind === 'schema';
      if (labelWorthy && !dimmed && p.scale > 0.45) {
        ctx.font = `${Math.max(10, Math.min(13, 9 + r * 0.25))}px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = hexWithAlpha('#e8ecf2', Math.min(0.92, alpha + 0.15));
        ctx.textAlign = 'center';
        ctx.fillText(clip(node.gist, 34), p.sx, p.sy + r + 13);
      }
    }

    projectedRef.current = drawn;
  }, [byId, highlight, mode, neighborIds, selectedId]);

  // Animation loop.
  useEffect(() => {
    let stopped = false;
    const loop = () => {
      if (stopped) return;
      const sim = simRef.current;
      if (sim) {
        // A few integration steps per frame while hot, one while settled.
        const iters = sim.alpha > 0.35 ? 3 : 1;
        for (let i = 0; i < iters; i++) step(sim, mode);
      }
      draw();
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => { stopped = true; cancelAnimationFrame(rafRef.current); };
  }, [draw, mode]);

  const pick = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left, y = clientY - rect.top;
    let best: { id: string; d: number } | null = null;
    for (const p of projectedRef.current) {
      const d = Math.hypot(p.sx - x, p.sy - y);
      if (d <= p.sr + 6 && (!best || d < best.d)) best = { id: p.id, d };
    }
    return best?.id ?? null;
  }, []);

  return (
    <div className={`memgraph${className ? ` ${className}` : ''}`}>
      <canvas
        ref={canvasRef}
        className="memgraph-canvas"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          dragRef.current = { x: e.clientX, y: e.clientY, button: e.button };
        }}
        onPointerUp={(e) => {
          const drag = dragRef.current;
          dragRef.current = null;
          if (!drag) return;
          const moved = Math.hypot(e.clientX - drag.x, e.clientY - drag.y);
          if (moved < 4) onSelect?.(pick(e.clientX, e.clientY));
        }}
        onPointerMove={(e) => {
          const drag = dragRef.current;
          if (drag) {
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            dragRef.current = { ...drag, x: e.clientX, y: e.clientY };
            const view = viewRef.current;
            // 3D: left-drag orbits, right/middle pans. 2D: any drag pans.
            if (mode === '3d' && drag.button === 0) {
              view.yaw += dx * 0.006;
              view.pitch = Math.max(-1.3, Math.min(1.3, view.pitch + dy * 0.005));
              view.spin = false;
            } else {
              view.panX += dx;
              view.panY += dy;
            }
            setHover(null);
            return;
          }
          const id = pick(e.clientX, e.clientY);
          const node = id ? byId.get(id) : null;
          if (!node) { setHover(null); return; }
          const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
          setHover({ node, x: e.clientX - rect.left, y: e.clientY - rect.top });
        }}
        onPointerLeave={() => { dragRef.current = null; setHover(null); }}
        onWheel={(e) => {
          const view = viewRef.current;
          view.zoom = Math.max(0.2, Math.min(4, view.zoom * (e.deltaY > 0 ? 0.92 : 1.08)));
        }}
        onContextMenu={(e) => e.preventDefault()}
      />
      {hover && (
        <div
          className="memgraph-tip"
          style={{
            left: Math.min(hover.x + 14, (canvasRef.current?.clientWidth ?? 400) - 260),
            top: Math.max(8, hover.y - 10),
          }}
        >
          <div className="memgraph-tip-kind">
            {hover.node.kind}
            {hover.node.intrusive && ' · intrusive'}
            {hover.node.status !== 'active' && ` · ${hover.node.status}`}
          </div>
          <div className="memgraph-tip-gist">{clip(hover.node.gist, 180)}</div>
          <div className="memgraph-tip-meta">
            {hover.node.emotion} · recall {(hover.node.probability * 100).toFixed(0)}% · {hover.node.health.label}
          </div>
        </div>
      )}
      <div className="memgraph-hint">
        {mode === '3d' ? 'Drag to orbit · right-drag to pan · scroll to zoom' : 'Drag to pan · scroll to zoom'}
      </div>
    </div>
  );
}

function hexWithAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  if (color.startsWith('hsl')) return color.replace(')', ` / ${a.toFixed(3)})`).replace('hsl(', 'hsl(');
  const hex = color.replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

function clip(s: string, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export const MEMORY_EDGE_COLORS = EDGE_COLORS;
