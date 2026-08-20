/**
 * On-device Web Speech recognition (Chrome 139+).
 *
 * When the browser has a local language pack installed, `processLocally = true`
 * keeps audio on the machine and streams interim results with no model download
 * and near-zero latency — by a wide margin the best dictation available here.
 *
 * Privacy rule for this app: we only ever use this engine when local processing
 * is *confirmed*. `processLocally` is never set to false and we never fall back
 * to server-side recognition, because that would silently ship the user's
 * microphone audio to Google/Microsoft in an app that promises local-only.
 * If local is unavailable, the caller drops to the in-browser model instead.
 */

type Availability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

interface SpeechRecognitionCtor {
  new (): SpeechRecognitionLike;
  available?(opts: { langs: string[]; processLocally: boolean }): Promise<Availability | boolean>;
  install?(opts: { langs: string[]; processLocally: boolean }): Promise<boolean>;
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  processLocally?: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string; message?: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<
    ArrayLike<{ transcript: string; confidence: number }> & { isFinal: boolean }
  >;
}

function ctor(): SpeechRecognitionCtor | null {
  const w = window as unknown as Record<string, SpeechRecognitionCtor | undefined>;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function normalize(v: Availability | boolean | undefined): Availability {
  if (v === true) return 'available';
  if (v === false || v == null) return 'unavailable';
  return v;
}

export interface DeviceSpeechSupport {
  supported: boolean;
  availability: Availability;
  /** True only when we can run without sending audio anywhere. */
  localReady: boolean;
}

/**
 * Can we dictate locally for this language right now?
 * Never triggers a download — call `installDeviceSpeech` for that.
 */
export async function probeDeviceSpeech(lang: string): Promise<DeviceSpeechSupport> {
  const SR = ctor();
  if (!SR) return { supported: false, availability: 'unavailable', localReady: false };
  // Older Chrome has SpeechRecognition but no availability API — that build can
  // only do server-side recognition, so it is unusable for us.
  if (typeof SR.available !== 'function') {
    return { supported: true, availability: 'unavailable', localReady: false };
  }
  try {
    const availability = normalize(await SR.available({ langs: [lang], processLocally: true }));
    return { supported: true, availability, localReady: availability === 'available' };
  } catch {
    return { supported: true, availability: 'unavailable', localReady: false };
  }
}

/** Ask the browser to fetch the local language pack. Requires a user gesture. */
export async function installDeviceSpeech(lang: string): Promise<boolean> {
  const SR = ctor();
  if (!SR || typeof SR.install !== 'function') return false;
  try {
    return await SR.install({ langs: [lang], processLocally: true });
  } catch {
    return false;
  }
}

export interface DeviceSpeechHandle {
  /** Stop and resolve with the final transcript. */
  stop(): Promise<string>;
  cancel(): void;
}

export interface DeviceSpeechCallbacks {
  /** Full transcript so far, including the unstable tail. */
  onLive(text: string): void;
  onError(message: string): void;
}

/**
 * Start local streaming dictation. Throws if local processing is not available,
 * so the caller can fall back to the in-browser model.
 */
export async function startDeviceSpeech(
  lang: string,
  cb: DeviceSpeechCallbacks,
): Promise<DeviceSpeechHandle> {
  const SR = ctor();
  if (!SR) throw new Error('Speech recognition is not available in this browser.');

  const probe = await probeDeviceSpeech(lang);
  if (!probe.localReady) throw new Error('On-device speech pack is not installed.');

  const rec = new SR();
  rec.lang = lang;
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.processLocally = true;

  /** Everything the engine has marked final; the tail is rebuilt each event. */
  let committed = '';
  let live = '';
  let ended = false;
  let resolveStop: ((text: string) => void) | null = null;
  /**
   * Chrome ends a `continuous` session on its own after a pause. Restart until
   * the user actually stops, or a long dictation dies mid-sentence.
   */
  let wantRunning = true;

  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      const alt = res[0];
      if (!alt) continue;
      if (res.isFinal) committed = `${committed} ${alt.transcript}`.trim();
      else interim = `${interim} ${alt.transcript}`.trim();
    }
    live = `${committed} ${interim}`.replace(/\s+/g, ' ').trim();
    cb.onLive(live);
  };

  rec.onerror = (e) => {
    const code = e?.error ?? '';
    // `no-speech` and `aborted` are routine, not failures worth surfacing.
    if (code === 'no-speech' || code === 'aborted') return;
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      wantRunning = false;
      cb.onError('Microphone permission denied.');
      return;
    }
    cb.onError(e?.message || `Speech recognition error: ${code || 'unknown'}`);
  };

  rec.onend = () => {
    if (wantRunning && !ended) {
      try {
        rec.start();
        return;
      } catch {
        /* fall through to settle */
      }
    }
    ended = true;
    resolveStop?.(live.trim());
  };

  rec.start();

  return {
    stop: () =>
      new Promise<string>((resolve) => {
        wantRunning = false;
        if (ended) return resolve(live.trim());
        resolveStop = resolve;
        try {
          rec.stop();
        } catch {
          resolve(live.trim());
        }
        // Never hang the UI if `onend` does not arrive.
        window.setTimeout(() => {
          if (!ended) {
            ended = true;
            resolve(live.trim());
          }
        }, 1500);
      }),
    cancel: () => {
      wantRunning = false;
      ended = true;
      try {
        rec.abort();
      } catch {
        /* ignore */
      }
    },
  };
}
