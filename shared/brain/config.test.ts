import { describe, expect, it } from 'vitest';
import {
  clampCadence, clampShare, commonConfig, resolveBrainConfig, sanitizeConfigPatch,
} from './config';
import { DEFAULT_CONFIG, MAX_BRAIN_SHARE } from './defaults';

describe('brain config layering', () => {
  it('falls back to the shipped defaults when nobody has an opinion', () => {
    const c = resolveBrainConfig({});
    expect(c.updateEveryMessages).toBe(DEFAULT_CONFIG.updateEveryMessages);
    expect(c.shareOfContext).toBe(DEFAULT_CONFIG.shareOfContext);
    expect(c.autoUpdate).toBe(DEFAULT_CONFIG.autoUpdate);
  });

  it('lets the global defaults reach a new mind', () => {
    // The bug this exists to prevent: drawer says 20, new minds silently got 6.
    const c = resolveBrainConfig({ global: { updateEveryMessages: 20, traumaEnabled: false } });
    expect(c.updateEveryMessages).toBe(20);
    expect(c.traumaEnabled).toBe(false);
  });

  it('lets the conversation override the global defaults', () => {
    const c = resolveBrainConfig({
      global: { updateEveryMessages: 20, shareOfContext: 0.1, autoUpdate: false },
      chat: { updateEveryMessages: 2 },
    });
    expect(c.updateEveryMessages).toBe(2);
    // Untouched fields still come from the layer below.
    expect(c.shareOfContext).toBeCloseTo(0.1);
    expect(c.autoUpdate).toBe(false);
  });

  it('never inherits a global off-switch into a new mind', () => {
    // `enabled: false` globally means the feature is off right now, not that
    // every mind born meanwhile should stay dead after it is turned back on.
    expect(resolveBrainConfig({ global: { enabled: false } }).enabled).toBe(true);
    // A conversation switched off is a deliberate, local choice — that one sticks.
    expect(resolveBrainConfig({ chat: { enabled: false } }).enabled).toBe(false);
  });

  it('clamps values that would break the budget or the cadence', () => {
    const c = resolveBrainConfig({ chat: { updateEveryMessages: 0, shareOfContext: 0.9 } });
    expect(c.updateEveryMessages).toBe(1);
    expect(c.shareOfContext).toBe(MAX_BRAIN_SHARE);
    expect(clampCadence(1e9)).toBe(100);
    expect(clampCadence(4.7)).toBe(4);
    expect(clampCadence(NaN)).toBe(DEFAULT_CONFIG.updateEveryMessages);
    expect(clampShare(-1)).toBe(0);
    expect(clampShare('half')).toBe(DEFAULT_CONFIG.shareOfContext);
  });

  it('drops junk instead of storing it', () => {
    expect(sanitizeConfigPatch({ enabled: 'yes', updateEveryMessages: '6', nope: 1 })).toEqual({});
    expect(sanitizeConfigPatch(null)).toEqual({});
    expect(sanitizeConfigPatch({ autoUpdate: false, shareOfContext: 0.2 }))
      .toEqual({ autoUpdate: false, shareOfContext: 0.2 });
  });

  it('reports only what the whole cast agrees on', () => {
    const a = { updateEveryMessages: 6, autoUpdate: true, traumaEnabled: true };
    const b = { updateEveryMessages: 6, autoUpdate: false, traumaEnabled: true };
    const shared = commonConfig([a, b]);
    expect(shared.updateEveryMessages).toBe(6);
    expect(shared.traumaEnabled).toBe(true);
    // Disagreement is absence, so the UI can say "mixed" instead of picking one.
    expect(shared.autoUpdate).toBeUndefined();
    expect(commonConfig([])).toEqual({});
    expect(commonConfig([a])).toMatchObject(a);
  });
});
