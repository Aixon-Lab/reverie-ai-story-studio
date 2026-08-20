/**
 * Memory — global Character Brain defaults.
 *
 * These are the values a newly born mind inherits, plus the master switch.
 * Each mind can then be tuned individually from its own page (`/mind`), and
 * "Apply to every existing mind" pushes these down to all of them at once.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, ExternalLink } from 'lucide-react';
import { GlobeLoader } from '../GlobeLoader';
import { DrawerHeader } from './DrawerHost';
import { useNavigate } from 'react-router-dom';
import type { BrainSettings } from '@shared/types';
import { api, type BrainSummary, type ModelLimits } from '../../api';
import { useApp } from '../../store';

const MAX_SHARE = 1 / 3;

const DEFAULTS: BrainSettings = {
  enabled: true,
  updateEveryMessages: 6,
  autoUpdate: true,
  shareOfContext: MAX_SHARE,
  traumaEnabled: true,
  intrusionsEnabled: true,
  autoCreate: true,
};

/** Presets for the frequency dial, so the common intents are one click. */
const CADENCE: { label: string; value: number; hint: string }[] = [
  { label: 'Every message', value: 1, hint: 'Most responsive. One model call per message — expensive.' },
  { label: 'Every 2', value: 2, hint: 'Very responsive, still fairly cheap.' },
  { label: 'Every 4', value: 4, hint: 'Balanced.' },
  { label: 'Every 6', value: 6, hint: 'Default — roughly one exchange-and-a-half.' },
  { label: 'Every 10', value: 10, hint: 'Cheap; memory lags the scene a little.' },
  { label: 'Every 20', value: 20, hint: 'Very cheap; good for long, fast scenes.' },
];

export function BrainDrawer({ onClose }: { onClose: () => void }) {
  const { settings, saveSettings } = useApp();
  const nav = useNavigate();
  const [minds, setMinds] = useState<BrainSummary[]>([]);
  const [limits, setLimits] = useState<ModelLimits | null>(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(0);
  const [error, setError] = useState('');

  const brain: BrainSettings = { ...DEFAULTS, ...(settings?.brain ?? {}) };

  useEffect(() => {
    api.brain.list().then(setMinds).catch(() => setMinds([]));
    api.brain.limits({ share: brain.shareOfContext, reservedOutput: 1024 })
      .then(setLimits)
      .catch(() => setLimits(null));
    // Re-fetch the budget preview whenever the share changes.
  }, [brain.shareOfContext]);

  async function patch(next: Partial<BrainSettings>) {
    setApplied(0);
    setError('');
    try {
      await saveSettings({ brain: { ...brain, ...next } });
    } catch (err: any) {
      setError(err?.message ?? 'Could not save.');
    }
  }

  /**
   * Sliders write when you stop moving them, not on every pixel.
   *
   * `saveSettings` is a full round trip that replaces the whole settings object,
   * and the thumb renders from the *response*. Firing one per `onChange` meant a
   * single drag issued dozens of concurrent writes whose replies arrived out of
   * order — the thumb jumped backwards under the cursor and the value that
   * stuck was whichever response happened to land last, not the one you chose.
   */
  const [draft, setDraft] = useState<Partial<BrainSettings>>({});
  const draftTimer = useRef<number | null>(null);
  function patchLater(next: Partial<BrainSettings>) {
    setDraft((d) => ({ ...d, ...next }));
    if (draftTimer.current) window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => {
      draftTimer.current = null;
      setDraft({});
      void patch(next);
    }, 260);
  }
  useEffect(() => () => { if (draftTimer.current) window.clearTimeout(draftTimer.current); }, []);

  /** What the controls show: the pending drag if there is one, else the saved value. */
  const shown: BrainSettings = { ...brain, ...draft };

  /** Push the current defaults onto every mind that already exists. */
  async function applyToAll() {
    setApplying(true);
    setError('');
    let ok = 0;
    for (const m of minds) {
      try {
        await api.brain.config(m.chatId, m.characterId, {
          enabled: brain.enabled,
          autoUpdate: brain.autoUpdate,
          updateEveryMessages: brain.updateEveryMessages,
          shareOfContext: brain.shareOfContext,
          traumaEnabled: brain.traumaEnabled,
          intrusionsEnabled: brain.intrusionsEnabled,
        });
        ok++;
      } catch {
        /* keep going — one bad mind must not abort the rest */
      }
    }
    setApplied(ok);
    setApplying(false);
    if (ok < minds.length) setError(`${minds.length - ok} mind(s) could not be updated.`);
  }

  const totalMemories = minds.reduce((s, m) => s + (m.counts.total ?? 0), 0);

  return (
    <>
      <DrawerHeader title="Memory" onClose={onClose} />
      <div className="drawer-body">
      <p className="t-caption">
        Characters build a real memory as you play — inside each conversation separately.
        These are the defaults a new mind starts with; every mind can be tuned on its own page.
      </p>

      {error && <p className="sec-note" style={{ color: 'var(--danger)' }}>{error}</p>}

      <section className="sec-section">
        <h3 className="sec-h">Memory active</h3>
        <label className="mind-switch">
          <input
            type="checkbox"
            checked={brain.enabled}
            onChange={(e) => void patch({ enabled: e.target.checked })}
          />
          <span>
            <b>Characters remember</b>
            <em>Off = the app behaves exactly as it did before minds existed. Nothing is deleted.</em>
          </span>
        </label>
        <label className="mind-switch">
          <input
            type="checkbox"
            checked={brain.autoCreate}
            onChange={(e) => void patch({ autoCreate: e.target.checked })}
          />
          <span>
            <b>Start a mind automatically</b>
            <em>Give a character a memory the first time they speak in a conversation.</em>
          </span>
        </label>
      </section>

      <section className="sec-section">
        <h3 className="sec-h">How often memory forms</h3>
        <p className="t-caption">
          Memory consolidates offline in batches — like sleep — not on every word. This is how many
          new messages accumulate before a character sits down and works out what they will keep.
          Each pass costs one call to your utility model.
        </p>

        <div className="sec-chips">
          {CADENCE.map((c) => (
            <button
              key={c.value}
              type="button"
              className={`chip${brain.updateEveryMessages === c.value ? ' active' : ''}`}
              title={c.hint}
              onClick={() => void patch({ updateEveryMessages: c.value })}
            >
              {c.label}
            </button>
          ))}
        </div>

        <label className="mind-slider">
          <span>
            Consolidate every <b>{shown.updateEveryMessages}</b>{' '}
            {shown.updateEveryMessages === 1 ? 'message' : 'messages'}
          </span>
          <input
            type="range"
            min={1}
            max={40}
            value={shown.updateEveryMessages}
            onChange={(e) => patchLater({ updateEveryMessages: Number(e.target.value) })}
          />
        </label>

        <label className="mind-switch">
          <input
            type="checkbox"
            checked={brain.autoUpdate}
            onChange={(e) => void patch({ autoUpdate: e.target.checked })}
          />
          <span>
            <b>Run in the background</b>
            <em>
              Off = memory only forms when you press Consolidate on a mind's page. Useful if you want
              to control exactly when model calls happen.
            </em>
          </span>
        </label>
      </section>

      <section className="sec-section">
        <h3 className="sec-h">Share of the model's context</h3>
        {limits && (
          <p className="t-caption">
            {limits.model} · {limits.contextTokens.toLocaleString()} token window
            {limits.plan && (
              <> · memory up to {limits.plan.brainCap.toLocaleString()} tokens</>
            )}
          </p>
        )}
        <label className="mind-slider">
          <span>
            Memory may use <b>{Math.round(shown.shareOfContext * 100)}%</b>{' '}
            <em>hard maximum {Math.round(MAX_SHARE * 100)}%</em>
          </span>
          <input
            type="range"
            min={0}
            max={Math.round(MAX_SHARE * 100)}
            value={Math.round(shown.shareOfContext * 100)}
            onChange={(e) => patchLater({ shareOfContext: Number(e.target.value) / 100 })}
          />
        </label>
        {shown.shareOfContext === 0 && (
          <p className="t-caption" style={{ color: 'var(--danger)' }}>
            At 0% no memory reaches the model at all — characters keep everything they have
            learned, they are simply never told any of it.
          </p>
        )}
        <p className="t-caption">
          Memory can never take more than a third of the window — the rest is always the
          conversation. Until a mind is big enough to fill its share it takes only what it needs.
          Switch model and this refits automatically.
        </p>
      </section>

      <section className="sec-section">
        <h3 className="sec-h">Hard experiences</h3>
        <label className="mind-switch">
          <input
            type="checkbox"
            checked={brain.traumaEnabled}
            onChange={(e) => void patch({ traumaEnabled: e.target.checked })}
          />
          <span>
            <b>Allow trauma encoding</b>
            <em>
              Extreme, uncontrollable events lay down a separate sensory trace that resists
              forgetting, alongside a weaker account of what actually happened.
            </em>
          </span>
        </label>
        <label className="mind-switch">
          <input
            type="checkbox"
            checked={brain.intrusionsEnabled}
            onChange={(e) => void patch({ intrusionsEnabled: e.target.checked })}
          />
          <span>
            <b>Allow intrusions</b>
            <em>
              Those traces can surface unbidden when something in the scene matches them. Turn off
              for a lighter tone.
            </em>
          </span>
        </label>
      </section>

      <section className="sec-section">
        <h3 className="sec-h">Existing minds</h3>
        <p className="t-caption">
          {minds.length
            ? `${minds.length} mind${minds.length === 1 ? '' : 's'} across your conversations · ${totalMemories} memories in total.`
            : 'No minds yet — they appear as you chat.'}
        </p>
        <div className="btn-row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <button
            className="btn btn-secondary btn-sm"
            disabled={!minds.length || applying}
            onClick={() => void applyToAll()}
          >
            {applying
              ? <><GlobeLoader size={13} /> Applying…</>
              : applied
                ? <><Check size={13} /> Applied to {applied}</>
                : 'Apply to every existing mind'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => { onClose(); nav('/mind'); }}
          >
            <ExternalLink size={13} /> Open Minds
          </button>
        </div>
        <p className="t-caption" style={{ marginTop: 6 }}>
          <b>Characters remember</b> and <b>Run in the background</b> take effect everywhere the
          moment you change them — they are master switches, not defaults, and turning either off
          stops memory forming in every conversation at once. Everything else here is what a
          <i> new</i> mind starts with; apply it to push those onto minds that already exist.
          A single conversation can override all of this for its whole cast — open the brain icon
          in a group chat.
        </p>
      </section>
      </div>
    </>
  );
}
