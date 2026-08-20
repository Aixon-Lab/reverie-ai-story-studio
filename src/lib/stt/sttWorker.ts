/**
 * Speech-to-text inference worker.
 *
 * Runs Transformers.js off the main thread so partial transcripts can be
 * produced every few hundred milliseconds without janking the composer.
 *
 * Two models, picked by the orchestrator:
 *   Moonshine  — English, purpose-built for streaming. Its cost scales with the
 *                length of the audio, so re-transcribing a growing 1-8s buffer
 *                is cheap. This is what makes words appear as you speak.
 *   Whisper    — multilingual fallback. Pads every clip to 30s internally, so
 *                it is far slower on short buffers and is used at a lazier
 *                cadence.
 *
 * Only the newest pending request survives: if speech outruns inference we drop
 * the stale one rather than queueing lag.
 */
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

env.allowLocalModels = false;
env.useBrowserCache = true;

type LoadMsg = { type: 'load'; model: string; dtype: string; preferWebGpu: boolean };
type RunMsg = { type: 'run'; id: number; audio: Float32Array; language?: string; final: boolean };
type InMsg = LoadMsg | RunMsg | { type: 'dispose' };

let asr: AutomaticSpeechRecognitionPipeline | null = null;
let loading: Promise<void> | null = null;
let modelId = '';
let busy = false;
/** Newest queued request; older ones are discarded on purpose. */
let pending: RunMsg | null = null;

function post(msg: unknown, transfer?: Transferable[]) {
  (self as unknown as Worker).postMessage(msg, (transfer ?? []) as never);
}

async function detectDevice(preferWebGpu: boolean): Promise<'webgpu' | 'wasm'> {
  if (!preferWebGpu) return 'wasm';
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (gpu && (await gpu.requestAdapter())) return 'webgpu';
  } catch {
    /* fall through */
  }
  return 'wasm';
}

async function load(msg: LoadMsg): Promise<void> {
  if (asr && modelId === msg.model) return;
  if (loading && modelId === msg.model) return loading;

  modelId = msg.model;
  loading = (async () => {
    const device = await detectDevice(msg.preferWebGpu);
    post({ type: 'status', phase: 'loading', message: `Loading ${shortName(msg.model)} (${device})…`, progress: 0 });
    asr = (await pipeline('automatic-speech-recognition', msg.model, {
      dtype: msg.dtype,
      device,
      progress_callback: (e: unknown) => {
        const p = e as { status?: string; progress?: number; file?: string };
        if (p?.status === 'progress' && typeof p.progress === 'number') {
          const raw = p.progress > 1 ? p.progress / 100 : p.progress;
          post({
            type: 'status',
            phase: 'loading',
            progress: Math.min(1, Math.max(0, raw)),
            message: p.file ? `Downloading ${String(p.file).split('/').pop()}` : 'Downloading model…',
          });
        }
      },
    } as never)) as AutomaticSpeechRecognitionPipeline;
    post({ type: 'status', phase: 'ready', progress: 1, message: `${shortName(msg.model)} ready · ${device}`, device });
  })();

  try {
    await loading;
  } catch (err) {
    asr = null;
    loading = null;
    modelId = '';
    post({ type: 'status', phase: 'error', message: (err as Error)?.message ?? 'Model failed to load' });
    throw err;
  }
  loading = null;
}

function shortName(id: string): string {
  return id.split('/').pop()?.replace(/-ONNX$/i, '') ?? id;
}

async function drain(): Promise<void> {
  if (busy) return;
  const job = pending;
  pending = null;
  if (!job || !asr) return;

  busy = true;
  try {
    const isWhisper = /whisper/i.test(modelId);
    const opts: Record<string, unknown> = isWhisper
      ? {
          task: 'transcribe',
          // Only pin the language when the caller is sure; auto-detect handles
          // accented and code-switched speech better.
          ...(job.language && job.language !== 'auto' ? { language: job.language } : {}),
          return_timestamps: false,
        }
      : {};

    const out = (await asr(job.audio, opts as never)) as { text?: string } | string;
    const text = (typeof out === 'string' ? out : out?.text ?? '').replace(/\s+/g, ' ').trim();
    post({ type: 'result', id: job.id, text, final: job.final });
  } catch (err) {
    post({ type: 'error', id: job.id, message: (err as Error)?.message ?? 'Transcription failed' });
  } finally {
    busy = false;
    // Something arrived while we were working — take the newest.
    if (pending) void drain();
  }
}

self.onmessage = async (e: MessageEvent<InMsg>) => {
  const msg = e.data;
  if (msg.type === 'load') {
    try {
      await load(msg);
    } catch {
      /* already reported */
    }
    return;
  }
  if (msg.type === 'run') {
    // A final request must never be dropped in favour of a newer partial.
    if (pending?.final && !msg.final) return;
    pending = msg;
    if (!asr) {
      // Model still loading; the request waits and drain() runs once ready.
      if (loading) await loading.catch(() => undefined);
    }
    void drain();
    return;
  }
  if (msg.type === 'dispose') {
    asr = null;
    modelId = '';
    pending = null;
  }
};
