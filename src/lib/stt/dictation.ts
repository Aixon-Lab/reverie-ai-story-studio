/**
 * Streaming dictation — words appear as you speak, entirely on this device.
 *
 * Engine order, best first:
 *   1. `device`    Chrome's on-device Web Speech pack. Native streaming, no
 *                  download, lowest latency and highest accuracy. Only used
 *                  when local processing is confirmed (see deviceSpeech.ts).
 *   2. `moonshine` Moonshine base via Transformers.js + WebGPU. Built for
 *                  streaming: cost scales with clip length, so re-transcribing
 *                  a growing utterance every ~400 ms is cheap. English only.
 *   3. `whisper`   Multilingual fallback. Pads to 30 s internally, so partials
 *                  run at a lazier cadence and mostly arrive per utterance.
 *
 * The model engines are driven by a small energy VAD: speech opens an
 * utterance, a pause closes it. Closing commits the text and clears the buffer,
 * which keeps every inference short and stops latency growing with session
 * length.
 */
import { probeDeviceSpeech, startDeviceSpeech, type DeviceSpeechHandle } from './deviceSpeech';

export type SttEngineId = 'device' | 'moonshine' | 'whisper';
export type SttPhase = 'idle' | 'loading' | 'ready' | 'recording' | 'transcribing' | 'error';

export interface SttProgress {
  phase: SttPhase;
  progress?: number;
  message?: string;
  engine?: SttEngineId;
}

export interface DictationCallbacks {
  /** Whole transcript so far, including the unstable tail. Replaces previous. */
  onLive(text: string): void;
  onProgress(p: SttProgress): void;
}

export interface DictationHandle {
  engine: SttEngineId;
  /** Finish and resolve with the final transcript. */
  stop(): Promise<string>;
  cancel(): void;
}

const MOONSHINE_MODEL = 'onnx-community/moonshine-base-ONNX';
const WHISPER_MODEL = 'onnx-community/whisper-base';
const SAMPLE_RATE = 16_000;

/** Re-transcribe the open utterance this often while the user is talking. */
const PARTIAL_MS = { moonshine: 400, whisper: 1_100 } as const;
/** Silence needed to consider an utterance finished. */
const SILENCE_MS = 700;
/** Ignore blips shorter than this — keystrokes, clicks, breaths. */
const MIN_SPEECH_MS = 220;
/** Force a commit on very long unbroken speech so latency cannot run away. */
const MAX_UTTERANCE_MS = 14_000;

// ---------------------------------------------------------------- worker glue

let worker: Worker | null = null;
let workerModel = '';
let reqId = 0;
const waiters = new Map<number, (text: string) => void>();
let statusSink: ((p: SttProgress) => void) | null = null;

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./sttWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (msg?.type === 'status') {
      statusSink?.({
        phase: msg.phase,
        progress: msg.progress,
        message: msg.message,
      });
    } else if (msg?.type === 'result') {
      waiters.get(msg.id)?.(msg.text ?? '');
      waiters.delete(msg.id);
    } else if (msg?.type === 'error') {
      waiters.get(msg.id)?.('');
      waiters.delete(msg.id);
    }
  };
  return worker;
}

function loadModel(model: string, onProgress: (p: SttProgress) => void): void {
  statusSink = onProgress;
  const w = ensureWorker();
  if (workerModel === model) return;
  workerModel = model;
  w.postMessage({
    type: 'load',
    model,
    dtype: model.includes('moonshine') ? 'q8' : 'q8',
    preferWebGpu: true,
  });
}

function transcribe(audio: Float32Array, final: boolean, language?: string): Promise<string> {
  const w = ensureWorker();
  const id = ++reqId;
  const copy = new Float32Array(audio); // transferred; caller keeps its buffer
  return new Promise<string>((resolve) => {
    waiters.set(id, resolve);
    w.postMessage({ type: 'run', id, audio: copy, final, language }, [copy.buffer]);
    // A dropped partial must not leak a pending promise forever.
    window.setTimeout(() => {
      if (waiters.has(id)) {
        waiters.delete(id);
        resolve('');
      }
    }, final ? 30_000 : 6_000);
  });
}

/** Warm the model in the background so the first click is not a cold start. */
export function preloadStt(language = 'en-US', onProgress?: (p: SttProgress) => void): void {
  const model = pickModel(language);
  loadModel(model, onProgress ?? (() => {}));
}

function pickModel(language: string): string {
  return language.toLowerCase().startsWith('en') ? MOONSHINE_MODEL : WHISPER_MODEL;
}

// ------------------------------------------------------------------ selection

export interface EngineChoice {
  engine: SttEngineId;
  reason: string;
}

/** Which engine will actually run, and why — surfaced in the UI tooltip. */
export async function chooseEngine(language: string, allowDevice = true): Promise<EngineChoice> {
  if (allowDevice) {
    const probe = await probeDeviceSpeech(language);
    if (probe.localReady) {
      return { engine: 'device', reason: 'Browser on-device recognition — instant, nothing downloaded' };
    }
    if (probe.availability === 'downloadable') {
      return {
        engine: language.toLowerCase().startsWith('en') ? 'moonshine' : 'whisper',
        reason: 'A faster on-device pack is available from your browser — install it in the mic menu',
      };
    }
  }
  return language.toLowerCase().startsWith('en')
    ? { engine: 'moonshine', reason: 'Moonshine, streaming, in-browser' }
    : { engine: 'whisper', reason: 'Whisper multilingual, in-browser' };
}

// ------------------------------------------------------------------- capture

interface Capture {
  close(): void;
  /** Called with each block of mono 16 kHz samples. */
  onFrame(cb: (frame: Float32Array) => void): void;
}

async function openMic(): Promise<Capture> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone is not available in this browser.');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const AudioCtx = window.AudioContext ?? (window as never as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx({ sampleRate: SAMPLE_RATE });
  await ctx.resume().catch(() => undefined);

  const source = ctx.createMediaStreamSource(stream);
  /**
   * ScriptProcessorNode is deprecated but universally supported and does no
   * real work here — it only copies floats; inference runs in the worker. An
   * AudioWorklet would need a separately served module for a marginal gain.
   */
  const node = ctx.createScriptProcessor(2048, 1, 1);
  // Must be connected to the graph to be pulled; a muted gain keeps it silent.
  const mute = ctx.createGain();
  mute.gain.value = 0;

  let handler: ((f: Float32Array) => void) | null = null;
  const needsResample = Math.abs(ctx.sampleRate - SAMPLE_RATE) > 1;

  node.onaudioprocess = (e) => {
    if (!handler) return;
    const input = e.inputBuffer.getChannelData(0);
    handler(needsResample ? resample(input, ctx.sampleRate, SAMPLE_RATE) : new Float32Array(input));
  };

  source.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);

  return {
    onFrame: (cb) => { handler = cb; },
    close: () => {
      handler = null;
      try { node.disconnect(); } catch { /* ignore */ }
      try { source.disconnect(); } catch { /* ignore */ }
      try { mute.disconnect(); } catch { /* ignore */ }
      for (const t of stream.getTracks()) t.stop();
      void ctx.close().catch(() => undefined);
    },
  };
}

function resample(input: Float32Array, from: number, to: number): Float32Array {
  const ratio = from / to;
  const out = new Float32Array(Math.max(1, Math.round(input.length / ratio)));
  for (let i = 0; i < out.length; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = src - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

function rms(frame: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

// ----------------------------------------------------------------- dictation

export interface DictationOptions {
  /** BCP-47 for the device engine; also selects Moonshine vs Whisper. */
  language?: string;
  /** Set false to skip the browser engine entirely. */
  allowDevice?: boolean;
}

export async function startDictation(
  opts: DictationOptions,
  cb: DictationCallbacks,
): Promise<DictationHandle> {
  const language = opts.language || 'en-US';
  const choice = await chooseEngine(language, opts.allowDevice !== false);

  if (choice.engine === 'device') {
    let handle: DeviceSpeechHandle;
    try {
      handle = await startDeviceSpeech(language, {
        onLive: cb.onLive,
        onError: (message) => cb.onProgress({ phase: 'error', message, engine: 'device' }),
      });
    } catch {
      // Pack vanished between probe and start — fall through to the model.
      return startModelDictation(language, cb);
    }
    cb.onProgress({ phase: 'recording', message: 'Listening — on-device', engine: 'device' });
    return { engine: 'device', stop: handle.stop, cancel: handle.cancel };
  }

  return startModelDictation(language, cb);
}

async function startModelDictation(
  language: string,
  cb: DictationCallbacks,
): Promise<DictationHandle> {
  const model = pickModel(language);
  const engine: SttEngineId = model === MOONSHINE_MODEL ? 'moonshine' : 'whisper';
  const partialEvery = PARTIAL_MS[engine === 'moonshine' ? 'moonshine' : 'whisper'];

  loadModel(model, (p) => cb.onProgress({ ...p, engine }));

  const mic = await openMic();
  cb.onProgress({ phase: 'recording', message: 'Listening…', engine });

  /** Text from utterances already closed. */
  let committed = '';
  /** Samples of the utterance currently open. */
  let buffer: Float32Array[] = [];
  let bufferLen = 0;
  let speaking = false;
  let silenceMs = 0;
  let speechMs = 0;
  let utteranceMs = 0;
  let sincePartial = 0;
  /** Adaptive noise floor so a hissy mic does not read as constant speech. */
  let noiseFloor = 0.004;
  let closed = false;
  let inFlight = false;
  let finalising: Promise<void> | null = null;

  const flat = (): Float32Array => {
    const out = new Float32Array(bufferLen);
    let off = 0;
    for (const c of buffer) { out.set(c, off); off += c.length; }
    return out;
  };

  const emit = (tail: string) => {
    cb.onLive(`${committed} ${tail}`.replace(/\s+/g, ' ').trim());
  };

  /** Close the open utterance: transcribe it in full and commit the text. */
  const finalise = async () => {
    if (!bufferLen) return;
    const audio = flat();
    buffer = [];
    bufferLen = 0;
    utteranceMs = 0;
    if (audio.length < SAMPLE_RATE * (MIN_SPEECH_MS / 1000)) return;
    const text = await transcribe(audio, true, language);
    if (text) {
      committed = `${committed} ${text}`.replace(/\s+/g, ' ').trim();
      cb.onLive(committed);
    }
  };

  mic.onFrame((frame) => {
    if (closed) return;
    const ms = (frame.length / SAMPLE_RATE) * 1000;
    const level = rms(frame);

    if (!speaking) {
      // Track the quiet floor slowly; never let it chase speech upward.
      noiseFloor = Math.min(0.05, noiseFloor * 0.97 + level * 0.03);
    }
    const threshold = Math.max(0.008, noiseFloor * 3.2);
    const isSpeech = level > threshold;

    if (isSpeech) {
      speechMs += ms;
      silenceMs = 0;
      if (!speaking && speechMs >= MIN_SPEECH_MS) speaking = true;
    } else {
      silenceMs += ms;
      if (!speaking) speechMs = 0;
    }

    // Keep a little pre-roll so the first phoneme is not clipped.
    if (speaking || speechMs > 0) {
      buffer.push(frame);
      bufferLen += frame.length;
      utteranceMs += ms;
      sincePartial += ms;
    }

    if (speaking && silenceMs >= SILENCE_MS) {
      speaking = false;
      speechMs = 0;
      sincePartial = 0;
      finalising = (finalising ?? Promise.resolve()).then(finalise);
      return;
    }

    if (speaking && utteranceMs >= MAX_UTTERANCE_MS) {
      speaking = false;
      speechMs = 0;
      sincePartial = 0;
      finalising = (finalising ?? Promise.resolve()).then(finalise);
      return;
    }

    // Live partial: re-read the open utterance. Skipped while one is in flight
    // so a slow device degrades to fewer updates rather than a growing backlog.
    if (speaking && sincePartial >= partialEvery && !inFlight && bufferLen > SAMPLE_RATE * 0.25) {
      sincePartial = 0;
      inFlight = true;
      const snapshot = flat();
      void transcribe(snapshot, false, language)
        .then((text) => { if (!closed && text) emit(text); })
        .finally(() => { inFlight = false; });
    }
  });

  return {
    engine,
    stop: async () => {
      if (closed) return committed;
      closed = true;
      mic.close();
      cb.onProgress({ phase: 'transcribing', message: 'Finishing…', engine });
      await (finalising ?? Promise.resolve());
      await finalise();
      cb.onProgress({ phase: 'ready', message: '', engine });
      return committed.trim();
    },
    cancel: () => {
      closed = true;
      mic.close();
      buffer = [];
      bufferLen = 0;
    },
  };
}
