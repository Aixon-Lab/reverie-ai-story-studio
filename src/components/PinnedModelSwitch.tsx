/**
 * Pinned-model switcher — the model you are talking to, one click from change.
 *
 * Lives in the chat header because that is where you notice a model is wrong:
 * mid-scene, on a reply that came out flat or cost more than it was worth.
 * Pins are chosen in Connections; this only switches between them.
 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check, ChevronDown } from 'lucide-react';
import type { PinnedModel } from '@shared/types';
import { useApp } from '../store';

const EASE = [0.22, 0.61, 0.36, 1] as const;

/** `anthropic/claude-opus-4.5` → `claude-opus-4.5`; keeps chips readable. */
export function shortModelName(model: string, label?: string): string {
  if (label?.trim()) return label.trim();
  const slug = model.split('/').pop() ?? model;
  return slug.replace(/^models\//, '');
}

function samePin(a: PinnedModel, provider: string, model: string): boolean {
  return a.provider === provider && a.model === model;
}

export function PinnedModelSwitch({ disabled }: { disabled?: boolean }) {
  const { settings, saveSettings } = useApp();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!settings) return null;
  const pins = settings.pinnedModels ?? [];
  // With nothing pinned the chip would be a label, not a control — so it stays
  // out of the header until the user has actually pinned something.
  if (!pins.length) return null;

  const current = settings.textConnection;
  const activePin = pins.find((p) => samePin(p, current.provider, current.model));

  async function switchTo(pin: PinnedModel) {
    setOpen(false);
    await saveSettings({
      textConnection: {
        ...settings!.textConnection,
        provider: pin.provider,
        model: pin.model,
        // Effort travels with the pin: a model pinned at high is a different
        // thing from the same model at default, and that is usually the point.
        reasoningEffort: pin.reasoningEffort ?? null,
      },
    });
  }

  return (
    <div className="model-switch" ref={ref}>
      <button
        type="button"
        className={`model-switch-trigger${open ? ' is-open' : ''}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Model: ${current.model}${current.reasoningEffort ? ` · ${current.reasoningEffort}` : ''}\nClick to switch between pinned models`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="model-switch-label">
          {shortModelName(current.model, activePin?.label)}
        </span>
        {current.reasoningEffort && (
          <span className="model-switch-effort">{current.reasoningEffort}</span>
        )}
        <ChevronDown size={13} className={`model-switch-chevron${open ? ' is-open' : ''}`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.ul
            className="model-switch-menu"
            role="listbox"
            initial={{ opacity: 0, y: -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.16, ease: EASE }}
          >
            {pins.map((pin) => {
              const selected = samePin(pin, current.provider, current.model);
              return (
                <li key={`${pin.provider}:${pin.model}:${pin.reasoningEffort ?? ''}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    className={`model-switch-option${selected ? ' is-selected' : ''}`}
                    onClick={() => void switchTo(pin)}
                  >
                    <span className="model-switch-option-text">
                      <span className="model-switch-option-label">
                        {shortModelName(pin.model, pin.label)}
                        {pin.reasoningEffort && (
                          <span className="model-switch-effort">{pin.reasoningEffort}</span>
                        )}
                      </span>
                      <span className="model-switch-option-hint">{pin.provider} · {pin.model}</span>
                    </span>
                    {selected && <Check size={13} />}
                  </button>
                </li>
              );
            })}
            {!pins.some((p) => samePin(p, current.provider, current.model)) && (
              <li className="model-switch-note t-caption">
                Now: {current.model} (not pinned)
              </li>
            )}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
