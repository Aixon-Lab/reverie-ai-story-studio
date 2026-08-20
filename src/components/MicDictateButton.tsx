/**
 * Dictation button — streaming, on-device.
 *
 * Click to start; words land in the composer as you speak; click again to stop.
 * The engine is chosen automatically (see lib/stt/dictation.ts) and shown in the
 * tooltip. When the browser offers a faster local pack than our in-page model,
 * a small prompt offers to install it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, Mic, MicOff, Square } from 'lucide-react';
import { GlobeLoader } from './GlobeLoader';
import {
  chooseEngine, preloadStt, startDictation,
  type DictationHandle, type SttEngineId, type SttPhase, type SttProgress,
} from '../lib/stt/dictation';
import { installDeviceSpeech, probeDeviceSpeech } from '../lib/stt/deviceSpeech';

type Props = {
  disabled?: boolean;
  /** Final text for the session — inserted at the caret. */
  onText: (text: string) => void;
  /** Live transcript while speaking; replaces the previous live value. */
  onLiveText?: (text: string) => void;
  onStatus?: (msg: string) => void;
  /** BCP-47. Defaults to the browser's language. */
  language?: string;
};

const ENGINE_LABEL: Record<SttEngineId, string> = {
  device: 'browser on-device recognition',
  moonshine: 'Moonshine (in-browser, streaming)',
  whisper: 'Whisper multilingual (in-browser)',
};

export function MicDictateButton({ disabled, onText, onLiveText, onStatus, language }: Props) {
  const lang = language || navigator.language || 'en-US';
  const [phase, setPhase] = useState<SttPhase>('idle');
  const [progress, setProgress] = useState(0);
  const [hint, setHint] = useState('');
  const [engine, setEngine] = useState<SttEngineId>('moonshine');
  const [engineReason, setEngineReason] = useState('');
  const [canInstall, setCanInstall] = useState(false);
  const [installing, setInstalling] = useState(false);
  const handleRef = useRef<DictationHandle | null>(null);
  const busyRef = useRef(false);

  const report = useCallback((p: SttProgress) => {
    if (p.phase) setPhase(p.phase);
    if (typeof p.progress === 'number') setProgress(p.progress);
    if (p.engine) setEngine(p.engine);
    if (p.message !== undefined) {
      setHint(p.message);
      if (p.message) onStatus?.(p.message);
    }
  }, [onStatus]);

  // Work out which engine will run, and warm the model if it is ours.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const choice = await chooseEngine(lang);
      if (cancelled) return;
      setEngine(choice.engine);
      setEngineReason(choice.reason);
      const probe = await probeDeviceSpeech(lang);
      if (!cancelled) setCanInstall(probe.availability === 'downloadable');
      // Only pay the download for an in-page model if we will actually use it.
      if (!cancelled && choice.engine !== 'device') {
        window.setTimeout(() => {
          if (!cancelled) preloadStt(lang, (p) => { if (p.phase === 'loading') setProgress(p.progress ?? 0); });
        }, 1500);
      }
    })();
    return () => {
      cancelled = true;
      handleRef.current?.cancel();
      handleRef.current = null;
    };
  }, [lang]);

  async function start() {
    if (busyRef.current || disabled) return;
    busyRef.current = true;
    try {
      const handle = await startDictation({ language: lang }, {
        onLive: (text) => onLiveText?.(text),
        onProgress: report,
      });
      handleRef.current = handle;
      setEngine(handle.engine);
      setPhase('recording');
    } catch (e: unknown) {
      const msg = (e as Error)?.message ?? 'Could not access the microphone';
      report({ phase: 'error', message: msg });
      setPhase('idle');
    } finally {
      busyRef.current = false;
    }
  }

  async function stop() {
    if (busyRef.current) return;
    const handle = handleRef.current;
    if (!handle) return;
    busyRef.current = true;
    handleRef.current = null;
    try {
      const text = await handle.stop();
      onLiveText?.('');
      if (text) {
        onText(text);
        setHint('');
        setPhase('ready');
      } else {
        report({ phase: 'ready', message: 'No speech detected — try again' });
      }
    } catch (e: unknown) {
      report({ phase: 'error', message: (e as Error)?.message ?? 'Dictation failed' });
      setPhase('idle');
    } finally {
      busyRef.current = false;
    }
  }

  async function install() {
    setInstalling(true);
    onStatus?.('Installing the browser speech pack…');
    const ok = await installDeviceSpeech(lang);
    setInstalling(false);
    setCanInstall(!ok);
    if (ok) {
      const choice = await chooseEngine(lang);
      setEngine(choice.engine);
      setEngineReason(choice.reason);
      onStatus?.('On-device speech ready — dictation is now instant.');
    } else {
      onStatus?.('The browser could not install a local speech pack for this language.');
    }
  }

  const isRecording = phase === 'recording';
  const isBusy = phase === 'loading' || phase === 'transcribing' || installing;
  const title = isRecording
    ? 'Stop dictation'
    : isBusy
      ? hint || 'Working…'
      : `Dictate — ${ENGINE_LABEL[engine]}. Everything stays on this device.${engineReason ? `\n${engineReason}` : ''}`;

  return (
    <span className="composer-mic-wrap">
      <button
        type="button"
        className={[
          'icon-btn composer-wrap-btn composer-mic-btn',
          isRecording ? 'is-recording' : '',
          isBusy ? 'is-busy' : '',
          phase === 'error' ? 'is-error' : '',
        ].filter(Boolean).join(' ')}
        title={title}
        aria-label={isRecording ? 'Stop dictation' : 'Start dictation'}
        aria-pressed={isRecording}
        disabled={disabled || isBusy}
        onClick={() => void (isRecording ? stop() : start())}
      >
        {isBusy ? (
          <GlobeLoader size={16} title="Working" />
        ) : isRecording ? (
          <Square size={14} fill="currentColor" />
        ) : phase === 'error' ? (
          <MicOff size={16} />
        ) : (
          <Mic size={16} />
        )}
        {phase === 'loading' && progress > 0 && progress < 1 && (
          <span className="composer-mic-pct" aria-hidden>{Math.round(progress * 100)}</span>
        )}
      </button>

      {canInstall && !isRecording && (
        <button
          type="button"
          className="composer-mic-install"
          title={`Install your browser's on-device speech pack for ${lang} — instant dictation, no model download, still fully local`}
          onClick={() => void install()}
          disabled={installing}
        >
          <Download size={11} />
        </button>
      )}
    </span>
  );
}
