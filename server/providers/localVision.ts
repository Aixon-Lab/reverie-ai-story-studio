/**
 * On-device image understanding.
 *
 * The privacy contract: image bytes never leave this machine. Portraits are
 * described by a small vision-language model running on this computer, and only
 * the resulting *text* is ever eligible to reach a cloud API.
 *
 * Self-contained: there is nothing for the user to install. On first use the
 * app fetches a ~46 MB llama.cpp CPU engine and the model weights into its own
 * folder — the same shape as the Whisper weights the app already downloads —
 * and runs them itself on 127.0.0.1. No Ollama, no system packages, no PATH.
 *
 * Why llama.cpp and not ONNX: this started on transformers.js, which is already
 * a dependency and needs no binary at all. It was benchmarked and rejected.
 * Its CPU path is 10-50x off the pace — Qwen3-VL-2B managed 0.30 tok/s and
 * Florence-2-base 1.54 tok/s on a 12-core laptop, i.e. a minute per portrait.
 * llama.cpp's quantized CPU kernels are what make an accurate model answer in
 * seconds, so the binary is worth the provisioning cost.
 *
 * Model of record: MiniCPM-V 4.6 (1.3B — SigLIP2-400M vision encoder +
 * Qwen3.5-0.8B backbone, Apache-2.0), Q4_K_M. It is the accuracy/size frontier
 * for CPU laptops: ~1.5 GB on disk, ~2 GB resident, and Qwen3.5-2B-level scores
 * on OpenCompass and HallusionBench. HallusionBench is the one that matters
 * here — a captioner that invents a scar is worse than useless on a character
 * card, which is exactly how the sub-1B models failed in testing.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RawImage } from '@huggingface/transformers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Everything the feature needs lives beside the app, so the folder stays portable. */
export const MODELS_DIR = path.join(ROOT, 'models');
export const RUNTIME_DIR = path.join(ROOT, 'runtime', 'llama');

/** Pinned so a silent upstream change cannot break a working install. */
const LLAMA_BUILD = 'b10448';

export interface LocalVisionImage { mime: string; b64: string }

export interface LocalVisionOpts {
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
}

export const VISION_MODEL = {
  id: 'openbmb/MiniCPM-V-4.6-gguf',
  label: 'MiniCPM-V 4.6 (1.3B)',
  weights: 'MiniCPM-V-4_6-Q4_K_M.gguf',
  mmproj: 'mmproj-model-f16.gguf',
  approxDownloadMb: 1610,
  approxRamMb: 2100,
} as const;

export interface LocalVisionConfig {
  /** Master switch. When off, callers may fall back to a cloud vision model. */
  enabled: boolean;
  /**
   * When true (the default) a local failure is a hard error rather than a
   * silent fallback to a cloud vision API. This is what makes "no image ever
   * leaves the machine" a guarantee instead of a hope.
   */
  strict: boolean;
  /** Longest image edge sent to the encoder. Bigger is slower, rarely better. */
  maxEdge: number;
  /** Drop the model from RAM after this long idle. 0 keeps it resident. */
  idleUnloadMs: number;
}

export const DEFAULT_LOCAL_VISION: LocalVisionConfig = {
  enabled: true,
  strict: true,
  // 448 is not arbitrary. MiniCPM-V slices an image into ~448px tiles and
  // encodes each one, so cost scales with area: the same portrait at 970x1455
  // became 19 slices and took ~100s to encode, versus 3 slices and ~4.5s here.
  // Larger inputs cost minutes and add no facial detail worth having.
  maxEdge: 448,
  idleUnloadMs: 10 * 60_000,
};

// ---------- platform assets ----------

interface PlatformAsset { asset: string; exe: string }

/** Which llama.cpp release archive fits this machine. */
export function platformAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): PlatformAsset | null {
  const exe = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  if (platform === 'win32' && arch === 'x64') {
    return { asset: `llama-${LLAMA_BUILD}-bin-win-cpu-x64.zip`, exe };
  }
  if (platform === 'darwin') {
    return { asset: `llama-${LLAMA_BUILD}-bin-macos-${arch === 'arm64' ? 'arm64' : 'x64'}.zip`, exe };
  }
  if (platform === 'linux' && arch === 'x64') {
    return { asset: `llama-${LLAMA_BUILD}-bin-ubuntu-x64.zip`, exe };
  }
  return null;
}

function assetUrl(asset: string): string {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${asset}`;
}

function weightUrl(file: string): string {
  return `https://huggingface.co/${VISION_MODEL.id}/resolve/main/${file}`;
}

async function exists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

/** The engine binary, wherever the archive happened to put it. */
async function findServerExe(): Promise<string | null> {
  const plat = platformAsset();
  if (!plat) return null;
  for (const rel of [plat.exe, path.join('build', 'bin', plat.exe), path.join('bin', plat.exe)]) {
    const p = path.join(RUNTIME_DIR, rel);
    if (await exists(p)) return p;
  }
  return null;
}

// ---------- provisioning ----------

export interface ProvisionProgress {
  phase: 'idle' | 'engine' | 'weights' | 'ready' | 'error';
  file?: string;
  receivedMb?: number;
  totalMb?: number;
  error?: string;
}

let provision: ProvisionProgress = { phase: 'idle' };
let provisioning: Promise<void> | null = null;

export function provisionProgress(): ProvisionProgress {
  return provision;
}

/** Stream a download to disk, reporting progress, via a .part file so a killed
 *  download can never masquerade as a complete one. */
async function download(url: string, dest: string, phase: 'engine' | 'weights'): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed ${res.status}: ${url}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const part = `${dest}.part`;
  await fs.mkdir(path.dirname(dest), { recursive: true });

  const handle = await fs.open(part, 'w');
  try {
    let received = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      await handle.write(chunk);
      received += chunk.byteLength;
      provision = {
        phase,
        file: path.basename(dest),
        receivedMb: Math.round(received / 1048576),
        totalMb: total ? Math.round(total / 1048576) : undefined,
      };
    }
  } finally {
    await handle.close();
  }
  await fs.rename(part, dest);
}

/** Windows and macOS ship a zip-capable tar; most Linux boxes need unzip. */
async function unzip(zip: string, into: string): Promise<void> {
  await fs.mkdir(into, { recursive: true });
  const attempts: [string, string[]][] = [
    ['tar', ['-xf', zip, '-C', into]],
    ['unzip', ['-o', '-q', zip, '-d', into]],
  ];
  let lastErr = '';
  for (const [cmd, args] of attempts) {
    const ok = await new Promise<boolean>((resolve) => {
      const p = spawn(cmd, args, { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('exit', (code) => resolve(code === 0));
    });
    if (ok) return;
    lastErr = cmd;
  }
  throw new Error(`Could not extract ${path.basename(zip)} (tried tar and unzip; last: ${lastErr}).`);
}

/**
 * Fetch the engine and weights if they are not already here. Safe to call
 * repeatedly — concurrent callers share one run rather than racing on the same
 * files.
 */
export function ensureProvisioned(): Promise<void> {
  if (provisioning) return provisioning;
  provisioning = (async () => {
    const plat = platformAsset();
    if (!plat) {
      throw new Error(
        `On-device scanning has no prebuilt engine for ${process.platform}/${process.arch}.`,
      );
    }

    if (!(await findServerExe())) {
      provision = { phase: 'engine' };
      const zip = path.join(RUNTIME_DIR, plat.asset);
      await download(assetUrl(plat.asset), zip, 'engine');
      await unzip(zip, RUNTIME_DIR);
      await fs.rm(zip, { force: true });
      if (!(await findServerExe())) throw new Error('Engine archive did not contain llama-server.');
      if (process.platform !== 'win32') {
        await fs.chmod((await findServerExe())!, 0o755).catch(() => {});
      }
    }

    for (const file of [VISION_MODEL.weights, VISION_MODEL.mmproj]) {
      const dest = path.join(MODELS_DIR, file);
      if (!(await exists(dest))) {
        provision = { phase: 'weights', file };
        await download(weightUrl(file), dest, 'weights');
      }
    }

    provision = { phase: 'ready' };
  })().catch((err) => {
    provision = { phase: 'error', error: String(err?.message ?? err) };
    throw err;
  }).finally(() => {
    provisioning = null;
  });
  return provisioning;
}

// ---------- engine process ----------

let child: ChildProcess | null = null;
let baseUrl = '';
let starting: Promise<string> | null = null;
let idleTimer: NodeJS.Timeout | null = null;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitHealthy(url: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (child?.exitCode != null) throw new Error(`Vision engine exited (code ${child.exitCode}).`);
    try {
      const r = await fetch(`${url}/health`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('Vision engine did not become ready in time.');
}

function armIdleUnload(cfg: LocalVisionConfig) {
  if (idleTimer) clearTimeout(idleTimer);
  if (!cfg.idleUnloadMs) return;
  // Holding ~2 GB forever on a 4 GB laptop is hostile; give it back when idle.
  idleTimer = setTimeout(() => { void stopEngine(); }, cfg.idleUnloadMs);
  idleTimer.unref?.();
}

async function startEngine(cfg: LocalVisionConfig): Promise<string> {
  if (baseUrl && child && child.exitCode == null) return baseUrl;
  if (starting) return starting;

  starting = (async () => {
    await ensureProvisioned();
    const exe = await findServerExe();
    if (!exe) throw new Error('Vision engine binary missing after provisioning.');

    const port = await freePort();
    // Bound to loopback with no API surface beyond what we call: this process
    // is an implementation detail, not a service anyone else should reach.
    const args = [
      '--model', path.join(MODELS_DIR, VISION_MODEL.weights),
      '--mmproj', path.join(MODELS_DIR, VISION_MODEL.mmproj),
      '--host', '127.0.0.1',
      '--port', String(port),
      '--ctx-size', '4096',
      '--threads', String(Math.max(2, Math.min(os.cpus().length, 8))),
      // MiniCPM-V 4.6 has a Qwen3.5 backbone and thinks by default: left on, it
      // spends the whole token budget in `reasoning_content` and returns empty
      // `content`. Off is both correct and faster.
      '--reasoning', 'off',
    ];

    child = spawn(exe, args, { stdio: 'ignore', windowsHide: true });
    child.on('exit', () => { child = null; baseUrl = ''; });

    const url = `http://127.0.0.1:${port}`;
    await waitHealthy(url, 180_000);
    baseUrl = url;
    armIdleUnload(cfg);
    return url;
  })().finally(() => { starting = null; });

  return starting;
}

export async function stopEngine(): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const c = child;
  child = null;
  baseUrl = '';
  if (c && c.exitCode == null) c.kill();
}

// Never leave an orphaned engine holding 2 GB after the app goes away.
for (const sig of ['exit', 'SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { void stopEngine(); });
}

// ---------- status ----------

export interface LocalVisionStatus {
  available: boolean;
  model?: string;
  label?: string;
  /** Engine binary present. */
  engineReady?: boolean;
  /** Both GGUF files present. */
  weightsReady?: boolean;
  /** Engine process currently loaded and warm. */
  running?: boolean;
  approxDownloadMb?: number;
  approxRamMb?: number;
  progress?: ProvisionProgress;
  error?: string;
  setup?: string;
}

export async function detectLocalVision(cfg: LocalVisionConfig): Promise<LocalVisionStatus> {
  if (!cfg.enabled) {
    return { available: false, error: 'On-device image scanning is turned off in settings.' };
  }
  const plat = platformAsset();
  if (!plat) {
    return {
      available: false,
      error: `No prebuilt on-device engine for ${process.platform}/${process.arch}.`,
    };
  }

  const engineReady = !!(await findServerExe());
  const weightsReady = (await exists(path.join(MODELS_DIR, VISION_MODEL.weights)))
    && (await exists(path.join(MODELS_DIR, VISION_MODEL.mmproj)));

  return {
    available: true,
    model: VISION_MODEL.id,
    label: VISION_MODEL.label,
    engineReady,
    weightsReady,
    running: !!baseUrl,
    approxDownloadMb: VISION_MODEL.approxDownloadMb,
    approxRamMb: VISION_MODEL.approxRamMb,
    progress: provision,
    setup: engineReady && weightsReady
      ? undefined
      : `First run downloads the engine and ${VISION_MODEL.label} (~${VISION_MODEL.approxDownloadMb} MB) `
        + 'into the Reverie folder. That happens once; afterwards it works offline.',
  };
}

/** Download and load ahead of time, so the first real scan is not the slow one. */
export async function warmupLocalVision(cfg: LocalVisionConfig): Promise<void> {
  await startEngine(cfg);
}

// ---------- inference ----------

/**
 * Shrink a portrait to the encoder's working size before it costs anything.
 *
 * This is the difference between a 6-second scan and a two-minute one, so a
 * resize failure must not be fatal — falling back to the original is slow but
 * still correct, and still local.
 */
export async function downscale(img: LocalVisionImage, maxEdge: number): Promise<LocalVisionImage> {
  try {
    const raw = await RawImage.fromBlob(new Blob([Buffer.from(img.b64, 'base64')]));
    const longest = Math.max(raw.width, raw.height);
    if (longest <= maxEdge) return img;

    const s = maxEdge / longest;
    const small = await raw.resize(Math.round(raw.width * s), Math.round(raw.height * s));
    // toBlob() is browser-only; sharp is the Node encoder transformers.js ships.
    const out = await small.toSharp().png().toBuffer();
    return { mime: 'image/png', b64: Buffer.from(out).toString('base64') };
  } catch {
    return img;
  }
}

/**
 * One-shot local multimodal call.
 *
 * Talks the OpenAI-compatible surface llama-server exposes, which is the same
 * dialect the cloud path already speaks, so prompts need no reshaping.
 */
export async function generateOnceLocalVision(
  cfg: LocalVisionConfig,
  system: string,
  user: string,
  images: LocalVisionImage[],
  opts: LocalVisionOpts = {},
): Promise<string> {
  const url = await startEngine(cfg);
  armIdleUnload(cfg);

  const shrunk = await Promise.all(images.map((img) => downscale(img, cfg.maxEdge)));

  const messages: Record<string, unknown>[] = [];
  if (system.trim()) messages.push({ role: 'system', content: system });
  messages.push({
    role: 'user',
    content: [
      ...shrunk.map((img) => ({
        type: 'image_url',
        image_url: { url: `data:${img.mime};base64,${img.b64}` },
      })),
      { type: 'text', text: user },
    ],
  });

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 180_000);
  let res: Response;
  try {
    res = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        max_tokens: opts.maxTokens ?? 512,
        temperature: opts.temperature ?? 0.2,
        stream: false,
      }),
      signal: ac.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') throw new Error('The on-device vision model timed out.');
    throw new Error(`Could not reach the on-device vision engine: ${err?.message ?? err}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`On-device vision error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json: any = await res.json();
  const text = String(json?.choices?.[0]?.message?.content ?? '').trim();
  if (!text) throw new Error('The on-device vision model returned empty text.');
  return text;
}
