/**
 * Message style (dialogue / action / thought) + advanced find/replace scripts.
 * Style rules drive UI rendering for all history and the LLM format instruction
 * (short FORMAT block + end-of-turn reminder every generation).
 */
import { useState } from 'react';
import type { MessageStyleRule, MessageStyleRole, RegexPlacement, RegexScript } from '@shared/types';
import { emptyRegexScript } from '@shared/engine/regex';
import {
  defaultMessageStyle,
  ensureForcedMessageStyle,
  patternFromWrappers,
} from '@shared/engine/messageStyle';
import { useApp } from '../../store';
import { DrawerHeader } from './DrawerHost';
import { useConfirm } from '../ConfirmDialog';

const PLACEMENTS: { id: RegexPlacement; label: string }[] = [
  { id: 'user_input', label: 'User input' },
  { id: 'ai_output', label: 'AI output' },
  { id: 'slash_command', label: 'Slash command' },
  { id: 'world_info', label: 'World info' },
  { id: 'prompt', label: 'Prompt' },
  { id: 'reasoning', label: 'Reasoning' },
];

const ROLES: MessageStyleRole[] = ['dialogue', 'action', 'thought', 'plain'];
const CORE_IDS = new Set(['style-dialogue', 'style-action', 'style-thought']);

export function RegexDrawer({ onClose }: { onClose: () => void }) {
  const confirm = useConfirm();
  const { settings, saveSettings } = useApp();
  const [tab, setTab] = useState<'style' | 'scripts'>('style');
  const scripts = settings?.regexScripts ?? [];
  const styleRules = ensureForcedMessageStyle(settings?.messageStyle).rules;
  const [idx, setIdx] = useState(0);
  const [styleIdx, setStyleIdx] = useState(0);
  const [status, setStatus] = useState('');
  if (!settings) return null;

  const script = scripts[idx] ?? null;
  const rule = styleRules[styleIdx] ?? null;

  function flash(msg: string) {
    setStatus(msg);
    setTimeout(() => setStatus(''), 1200);
  }

  function setScripts(next: RegexScript[]) {
    void saveSettings({ regexScripts: next }).then(() => flash('Saved'));
  }

  function setStyleRules(next: MessageStyleRule[]) {
    void saveSettings({ messageStyle: { rules: next } }).then(() => flash('Saved'));
  }

  function patchScript(p: Partial<RegexScript>) {
    if (!script) return;
    setScripts(scripts.map((s, i) => (i === idx ? { ...s, ...p } : s)));
  }

  function patchRule(p: Partial<MessageStyleRule>) {
    if (!rule) return;
    let next = styleRules.map((r, i) => (i === styleIdx ? { ...r, ...p } : r));
    // only one defaultForBare
    if (p.defaultForBare) {
      next = next.map((r, i) => (i === styleIdx ? r : { ...r, defaultForBare: false }));
    }
    // auto-sync match pattern whenever open/close change
    if (p.open != null || p.close != null) {
      const r = next[styleIdx];
      next[styleIdx] = {
        ...r,
        pattern: patternFromWrappers(r.open, r.close),
      };
    }
    setStyleRules(ensureForcedMessageStyle({ rules: next }).rules);
  }

  async function resetDefaults() {
    if (!await confirm({
      title: 'Reset message styles to defaults?',
      body: 'Restores " " for dialogue and * * for action/thought. Your custom rules are lost.',
      confirmLabel: 'Reset styles',
      danger: true,
    })) return;
    setStyleRules(defaultMessageStyle().rules);
    setStyleIdx(0);
  }

  return (
    <>
      <DrawerHeader title="Regex scripts" onClose={onClose} />
      <div className="drawer-body">
        <div className="rail-tabs" style={{ marginBottom: 14 }}>
          <button type="button" className="rail-tab" data-active={tab === 'style' || undefined} onClick={() => setTab('style')}>
            Message Style
          </button>
          <button type="button" className="rail-tab" data-active={tab === 'scripts' || undefined} onClick={() => setTab('scripts')}>
            Scripts
          </button>
        </div>
        {status && <p className="t-caption" style={{ color: 'var(--accent)', marginBottom: 10 }}>{status}</p>}

        {tab === 'style' && (
          <>
            <p className="t-caption" style={{ marginBottom: 12 }}>
              Defaults: <strong style={{ color: '#fff', fontWeight: 500 }}>&quot;dialogue&quot;</strong> white,
              {' '}<em style={{ color: '#a3a3a3' }}>*action / narration / thoughts*</em> grey italic.
              Change open/close wrappers anytime — that exact format becomes a short FORMAT rule
              sent to the model <strong>every turn</strong> (plus a closing reminder), so it must
              follow your wrappers from this point on. Markers stay in stored text for the model
              but are hidden in the chat view.
            </p>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  const open = '[';
                  const close = ']';
                  const r: MessageStyleRule = {
                    id: `style-${Date.now()}`,
                    name: 'Custom',
                    role: 'plain',
                    open,
                    close,
                    pattern: patternFromWrappers(open, close),
                    enabled: true,
                    hideWrappers: true,
                    fontWeight: 400,
                    fontStyle: 'normal',
                    color: '#bfbfbf',
                    defaultForBare: false,
                    injectInPrompt: true,
                  };
                  setStyleRules([...styleRules, r]);
                  setStyleIdx(styleRules.length);
                }}
              >
                Add Rule
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={resetDefaults}>Reset Defaults</button>
            </div>

            {styleRules.length > 0 && (
              <select className="input" value={styleIdx} onChange={(e) => setStyleIdx(Number(e.target.value))}>
                {styleRules.map((r, i) => (
                  <option key={r.id} value={i}>{r.name}{r.enabled ? '' : ' (off)'}</option>
                ))}
              </select>
            )}

            {rule && (
              <>
                <label className="field-label" style={{ marginTop: 12 }}>Name</label>
                <input className="input" value={rule.name} onChange={(e) => patchRule({ name: e.target.value })} />

                <label className="field-label" style={{ marginTop: 10 }}>Role</label>
                <select className="input" value={rule.role} onChange={(e) => patchRule({ role: e.target.value as MessageStyleRole })}>
                  {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                </select>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                  <div>
                    <label className="field-label">Open wrapper</label>
                    <input
                      className="input"
                      value={rule.open}
                      onChange={(e) => patchRule({ open: e.target.value })}
                      spellCheck={false}
                      placeholder='e.g. " or *'
                    />
                  </div>
                  <div>
                    <label className="field-label">Close wrapper</label>
                    <input
                      className="input"
                      value={rule.close}
                      onChange={(e) => patchRule({ close: e.target.value })}
                      spellCheck={false}
                      placeholder='e.g. " or *'
                    />
                  </div>
                </div>

                <label className="field-label" style={{ marginTop: 10 }}>Match pattern (regex, one capture group)</label>
                <input
                  className="input"
                  value={rule.pattern}
                  onChange={(e) => patchRule({ pattern: e.target.value })}
                  spellCheck={false}
                />
                <p className="t-caption" style={{ marginTop: 4 }}>
                  Auto-updates when you change open/close. Edit manually only if you need advanced matching.
                </p>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
                  <div>
                    <label className="field-label">Color</label>
                    <input className="input" type="color" value={rule.color.startsWith('#') ? rule.color : '#ffffff'}
                      onChange={(e) => patchRule({ color: e.target.value })} />
                  </div>
                  <div>
                    <label className="field-label">Weight</label>
                    <input className="input" type="number" min={300} max={700} step={100} value={rule.fontWeight}
                      onChange={(e) => patchRule({ fontWeight: Number(e.target.value) })} />
                  </div>
                </div>

                <label className="field-label" style={{ marginTop: 10 }}>Font style</label>
                <select className="input" value={rule.fontStyle} onChange={(e) => patchRule({ fontStyle: e.target.value as 'normal' | 'italic' })}>
                  <option value="normal">Normal</option>
                  <option value="italic">Italic</option>
                </select>

                <div className="fmt-checks" style={{ marginTop: 12 }}>
                  <label className="fmt-check">
                    <input type="checkbox" checked={rule.enabled} onChange={(e) => patchRule({ enabled: e.target.checked })} />
                    <span>Enabled</span>
                  </label>
                  <p className="t-caption" style={{ marginTop: 8 }}>
                    Markers (quotes, asterisks, etc.) never appear in the chat view — only styled text. They stay in the stored text for the model.
                  </p>
                  <label className="fmt-check">
                    <input type="checkbox" checked={rule.defaultForBare} onChange={(e) => patchRule({ defaultForBare: e.target.checked })} />
                    <span>Unmarked text uses this style</span>
                  </label>
                  <label className="fmt-check">
                    <input type="checkbox" checked={rule.injectInPrompt} onChange={(e) => patchRule({ injectInPrompt: e.target.checked })} />
                    <span>Teach model this rule (generation FORMAT)</span>
                  </label>
                </div>

                <p className="t-caption" style={{ marginTop: 14 }}>Preview</p>
                <div className="panel" style={{ padding: 12, marginTop: 6 }}>
                  <span style={{ fontWeight: rule.fontWeight, fontStyle: rule.fontStyle, color: rule.color }}>
                    Sample text
                  </span>
                  <span className="t-caption" style={{ display: 'block', marginTop: 6 }}>
                    Stored as: {rule.open}Sample text{rule.close}
                  </span>
                  {rule.injectInPrompt && rule.enabled && (
                    <span className="t-caption" style={{ display: 'block', marginTop: 4, color: 'var(--accent)' }}>
                      LLM FORMAT includes this wrapper every turn
                    </span>
                  )}
                </div>

                {CORE_IDS.has(rule.id) ? (
                  <p className="t-caption" style={{ marginTop: 12, color: 'var(--ink-muted)' }}>
                    Core role — edit wrappers freely; Reset Defaults restores &quot; dialogue and * action.
                    Deleting core roles is blocked (use Enabled off if you must hide one).
                  </p>
                ) : (
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm btn-danger"
                    style={{ marginTop: 12 }}
                    onClick={async () => {
                      if (!await confirm({
                        title: `Delete \u201c${rule.name}\u201d?`,
                        confirmLabel: 'Delete',
                        danger: true,
                      })) return;
                      const next = styleRules.filter((_, i) => i !== styleIdx);
                      setStyleRules(next);
                      setStyleIdx(Math.max(0, styleIdx - 1));
                    }}
                  >
                    Delete Rule
                  </button>
                )}
              </>
            )}
          </>
        )}

        {tab === 'scripts' && (
          <>
            <p className="t-caption" style={{ marginBottom: 12 }}>
              Advanced find/replace on input, output, and prompts. Message Style (other tab) is the usual path for dialogue formatting.
            </p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => {
                const s = emptyRegexScript({ scriptName: `Script ${scripts.length + 1}` });
                setScripts([...scripts, s]);
                setIdx(scripts.length);
              }}>New Script</button>
              {script && (
                <button type="button" className="btn btn-ghost btn-sm btn-danger" onClick={async () => {
                  if (!await confirm({
                    title: `Delete \u201c${script.scriptName}\u201d?`,
                    confirmLabel: 'Delete',
                    danger: true,
                  })) return;
                  setScripts(scripts.filter((_, i) => i !== idx));
                  setIdx(Math.max(0, idx - 1));
                }}>Delete</button>
              )}
            </div>

            {!scripts.length && <p className="t-caption">No scripts yet.</p>}
            {scripts.length > 0 && (
              <select className="input" value={idx} onChange={(e) => setIdx(Number(e.target.value))}>
                {scripts.map((s, i) => (
                  <option key={s.id} value={i}>{s.scriptName}{s.disabled ? ' (off)' : ''}</option>
                ))}
              </select>
            )}

            {script && (
              <>
                <label className="field-label" style={{ marginTop: 12 }}>Name</label>
                <input className="input" value={script.scriptName} onChange={(e) => patchScript({ scriptName: e.target.value })} />
                <label className="field-label" style={{ marginTop: 10 }}>Find</label>
                <input className="input" value={script.findRegex} onChange={(e) => patchScript({ findRegex: e.target.value })} spellCheck={false} />
                <label className="field-label" style={{ marginTop: 10 }}>Replace</label>
                <textarea className="textarea" rows={3} value={script.replaceString} onChange={(e) => patchScript({ replaceString: e.target.value })} spellCheck={false} />
                <p className="field-label" style={{ marginTop: 14 }}>Placement</p>
                <div className="fmt-checks">
                  {PLACEMENTS.map((p) => (
                    <label key={p.id} className="fmt-check">
                      <input
                        type="checkbox"
                        checked={script.placement.includes(p.id)}
                        onChange={(e) => {
                          const placement = e.target.checked
                            ? [...script.placement, p.id]
                            : script.placement.filter((x) => x !== p.id);
                          patchScript({ placement });
                        }}
                      />
                      <span>{p.label}</span>
                    </label>
                  ))}
                </div>
                <div className="fmt-checks" style={{ marginTop: 8 }}>
                  <label className="fmt-check">
                    <input type="checkbox" checked={script.disabled} onChange={(e) => patchScript({ disabled: e.target.checked })} />
                    <span>Disabled</span>
                  </label>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
