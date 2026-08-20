/** Appearance — fine-tune chat area look (background color, etc.). */
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../store';
import { DrawerHeader } from './DrawerHost';
import { Paintbrush, RotateCcw } from 'lucide-react';

const DEFAULT_CHAT_BG = '#000000';

/** Curated dark presets that stay readable with white message text. */
const PRESETS: { label: string; color: string }[] = [
  { label: 'Black', color: '#000000' },
  { label: 'Charcoal', color: '#0a0a0a' },
  { label: 'Ink', color: '#111111' },
  { label: 'Slate', color: '#12151a' },
  { label: 'Navy', color: '#0b1220' },
  { label: 'Forest', color: '#0c1410' },
  { label: 'Wine', color: '#140c10' },
  { label: 'Warm', color: '#14100c' },
  { label: 'Plum', color: '#120f18' },
  { label: 'Graphite', color: '#1a1a1a' },
];

function normalizeHex(raw: string): string | null {
  const t = raw.trim();
  if (!t) return '';
  const withHash = t.startsWith('#') ? t : `#${t}`;
  // #rgb → #rrggbb
  if (/^#[0-9a-fA-F]{3}$/.test(withHash)) {
    const r = withHash[1];
    const g = withHash[2];
    const b = withHash[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  if (/^#[0-9a-fA-F]{6}$/.test(withHash)) return withHash.toLowerCase();
  if (/^#[0-9a-fA-F]{8}$/.test(withHash)) return withHash.slice(0, 7).toLowerCase();
  return null;
}

function toColorInputValue(hex: string | undefined): string {
  const n = normalizeHex(hex || DEFAULT_CHAT_BG);
  if (n === '' || n === null) return DEFAULT_CHAT_BG;
  return n;
}

export function AppearanceDrawer({ onClose }: { onClose: () => void }) {
  const { settings, saveSettings } = useApp();
  const saved = settings?.appearance?.chatBackground ?? '';
  const [hexDraft, setHexDraft] = useState(saved || DEFAULT_CHAT_BG);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setHexDraft(saved || DEFAULT_CHAT_BG);
  }, [saved]);

  const effective = useMemo(() => toColorInputValue(hexDraft), [hexDraft]);
  const isDefault = !saved || normalizeHex(saved) === DEFAULT_CHAT_BG;

  async function commit(next: string) {
    if (!settings) return;
    const normalized = normalizeHex(next);
    if (normalized === null) {
      setStatus('Use a hex color like #0a0a0a');
      setTimeout(() => setStatus(''), 2200);
      return;
    }
    setSaving(true);
    setStatus('');
    try {
      // Empty string or pure black default both store as '' so theme CSS can fall back cleanly
      const chatBackground = !normalized || normalized === DEFAULT_CHAT_BG ? '' : normalized;
      await saveSettings({
        appearance: {
          ...(settings.appearance ?? {}),
          chatBackground,
        },
      });
      setHexDraft(chatBackground || DEFAULT_CHAT_BG);
      setStatus(chatBackground ? 'Saved' : 'Reset to default');
      setTimeout(() => setStatus(''), 1600);
    } catch (err: any) {
      setStatus(err?.message ?? 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return null;

  return (
    <>
      <DrawerHeader title="Appearance" onClose={onClose} />
      <div className="drawer-body">
        <p className="t-caption" style={{ marginBottom: 16 }}>
          Fine-tune the chat messages background. Pick a preset, use the color picker, or type any hex.
        </p>

        <section className="appearance-section">
          <div className="appearance-section-head">
            <Paintbrush size={15} strokeWidth={1.8} />
            <h3 className="t-section" style={{ margin: 0 }}>Chat background</h3>
          </div>

          <div
            className="appearance-preview"
            style={{ background: effective }}
            aria-hidden
          >
            <div className="appearance-preview-card">
              <span className="t-caption" style={{ color: 'var(--ink-muted)' }}>Sample message</span>
              <p className="t-body-lg" style={{ marginTop: 6, color: '#fff', fontSize: 14 }}>
                &quot;The room settles into this color.&quot;
              </p>
              <p className="t-caption" style={{ marginTop: 8, fontStyle: 'italic', color: '#a3a3a3' }}>
                *preview of your chat area*
              </p>
            </div>
          </div>

          <div className="appearance-controls">
            <label className="field-label" htmlFor="chat-bg-color">Color</label>
            <div className="appearance-color-row">
              <input
                id="chat-bg-color"
                className="appearance-color-swatch"
                type="color"
                value={effective}
                disabled={saving}
                onChange={(e) => {
                  setHexDraft(e.target.value);
                  void commit(e.target.value);
                }}
                title="Pick a color"
                aria-label="Chat background color"
              />
              <input
                className="input appearance-hex-input"
                value={hexDraft}
                spellCheck={false}
                disabled={saving}
                placeholder="#000000"
                aria-label="Chat background hex"
                onChange={(e) => setHexDraft(e.target.value)}
                onBlur={() => {
                  const n = normalizeHex(hexDraft);
                  if (n === null) {
                    setHexDraft(saved || DEFAULT_CHAT_BG);
                    return;
                  }
                  if (n !== normalizeHex(saved || DEFAULT_CHAT_BG)) void commit(n);
                  else setHexDraft(n || DEFAULT_CHAT_BG);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
              />
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={saving || isDefault}
                title="Reset to default black"
                onClick={() => void commit('')}
              >
                <RotateCcw size={14} />
                Reset
              </button>
            </div>
          </div>

          <p className="field-label" style={{ marginTop: 14 }}>Presets</p>
          <div className="appearance-presets" role="list">
            {PRESETS.map((p) => {
              const active = effective === p.color.toLowerCase();
              return (
                <button
                  key={p.color}
                  type="button"
                  role="listitem"
                  className={`appearance-preset${active ? ' is-active' : ''}`}
                  style={{ background: p.color }}
                  title={`${p.label} · ${p.color}`}
                  aria-label={`${p.label} ${p.color}`}
                  aria-pressed={active}
                  disabled={saving}
                  onClick={() => {
                    setHexDraft(p.color);
                    void commit(p.color);
                  }}
                />
              );
            })}
          </div>

          {status && (
            <p className="t-caption" style={{ marginTop: 12, color: 'var(--accent)' }}>{status}</p>
          )}
        </section>
      </div>
    </>
  );
}
