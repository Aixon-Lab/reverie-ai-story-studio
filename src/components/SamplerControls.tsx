/** Sampler sliders bound to the active preset. Reused in the Tune popover, chat rail, and Presets page. */
import type { Preset } from '@shared/types';
import { useApp } from '../store';

export type SamplerKey =
  | 'temperature' | 'top_p' | 'top_k' | 'min_p'
  | 'frequency_penalty' | 'presence_penalty' | 'repetition_penalty'
  | 'max_context' | 'max_tokens';

export const SAMPLERS: { key: SamplerKey; label: string; min: number; max: number; step: number; hint: string }[] = [
  { key: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.01, hint: 'Creativity / randomness. ~0.7–1.2 typical for roleplay.' },
  { key: 'top_p', label: 'Top P', min: 0, max: 1, step: 0.01, hint: 'Nucleus sampling cutoff.' },
  { key: 'top_k', label: 'Top K', min: 0, max: 200, step: 1, hint: 'Keep only the K most likely tokens. 0 = off.' },
  { key: 'min_p', label: 'Min P', min: 0, max: 1, step: 0.01, hint: 'Drop tokens below this relative probability. 0 = off.' },
  { key: 'frequency_penalty', label: 'Frequency Penalty', min: -2, max: 2, step: 0.01, hint: 'Penalize frequent tokens.' },
  { key: 'presence_penalty', label: 'Presence Penalty', min: -2, max: 2, step: 0.01, hint: 'Encourage new topics.' },
  { key: 'repetition_penalty', label: 'Repetition Penalty', min: 0.5, max: 2, step: 0.01, hint: '1.0 = off.' },
  { key: 'max_context', label: 'Max Context', min: 1024, max: 200000, step: 256, hint: 'Prompt token budget.' },
  { key: 'max_tokens', label: 'Max Tokens', min: 16, max: 16384, step: 16, hint: 'Hard reply length cap (tokens ≈ words). Sent to the model as a finish-under budget; shorter is fine.' },
];

const QUICK: SamplerKey[] = ['temperature', 'top_p', 'max_tokens'];

export function SamplerControls({ compact = false }: { compact?: boolean }) {
  const preset = useApp((s) => s.activePreset());
  const patch = useApp((s) => s.patchActivePreset);
  const commit = useApp((s) => s.commitActivePreset);
  if (!preset) return <p className="t-caption">No preset loaded.</p>;

  const rows = compact ? SAMPLERS.filter((s) => QUICK.includes(s.key)) : SAMPLERS;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: compact ? 12 : 16 }}>
      {rows.map((s) => {
        const value = Number(preset[s.key as keyof Preset] ?? 0);
        return (
          <div key={s.key}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <label className="field-label" style={{ marginBottom: 0 }} title={s.hint}>{s.label}</label>
              <span className="slider-value">
                <input
                  value={value}
                  onChange={(e) => patch({ [s.key]: Number(e.target.value) } as Partial<Preset>)}
                  onBlur={() => commit()}
                />
              </span>
            </div>
            <div className="slider-row" style={{ gridTemplateColumns: '1fr' }}>
              <input
                type="range" min={s.min} max={s.max} step={s.step} value={value}
                onChange={(e) => patch({ [s.key]: Number(e.target.value) } as Partial<Preset>)}
                onMouseUp={() => commit()}
                onTouchEnd={() => commit()}
              />
            </div>
          </div>
        );
      })}
      {!compact && (
        <>
          <div>
            <label className="field-label">Stop strings (one per line)</label>
            <textarea
              className="textarea"
              rows={3}
              value={(preset.stop_strings ?? []).join('\n')}
              onChange={(e) =>
                patch({
                  stop_strings: e.target.value.split('\n').map((s) => s.trimEnd()).filter((s) => s.length > 0),
                })
              }
              onBlur={() => commit()}
              placeholder={"END\n###"}
              spellCheck={false}
            />
          </div>
          <div>
            <label className="field-label">Logit bias (token=bias, one per line)</label>
            <textarea
              className="textarea"
              rows={3}
              value={Object.entries(preset.logit_bias ?? {}).map(([k, v]) => `${k}=${v}`).join('\n')}
              onChange={(e) => {
                const logit_bias: Record<string, number> = {};
                for (const line of e.target.value.split('\n')) {
                  const m = line.trim().match(/^(.+?)\s*=\s*(-?\d+(?:\.\d+)?)$/);
                  if (m) logit_bias[m[1]] = Number(m[2]);
                }
                patch({ logit_bias });
              }}
              onBlur={() => commit()}
              placeholder={"the=-5"}
              spellCheck={false}
            />
          </div>
        </>
      )}
    </div>
  );
}
