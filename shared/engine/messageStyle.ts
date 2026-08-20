/** Message style rules: parse chat text for display + build LLM format instructions. */
import type { MessageStyleRule, MessageStyleRole, MessageStyleSettings } from '../types';

/**
 * Platform defaults (editable in Regex → Message Style):
 *   "dialogue"  → spoken lines
 *   *action*    → actions, body language, narration, inner thoughts
 *   _thought_   → optional dedicated inner-voice markers (display only by default)
 * Unmarked bare text is styled as action/narration.
 *
 * Whatever the user sets for open/close becomes the strict format rule
 * sent to the LLM every turn — no silent reversion to older habits.
 */
export const DEFAULT_MESSAGE_STYLE_RULES: MessageStyleRule[] = [
  {
    id: 'style-dialogue',
    name: 'Dialogue',
    role: 'dialogue',
    open: '"',
    close: '"',
    // Match straight or curly quotes so model output still styles correctly
    pattern: '["\\u201C]([^"\\u201D]*)["\\u201D]',
    enabled: true,
    hideWrappers: true,
    fontWeight: 500,
    fontStyle: 'normal',
    color: '#ffffff',
    defaultForBare: false,
    injectInPrompt: true,
  },
  {
    id: 'style-action',
    name: 'Action / narration / thought',
    role: 'action',
    open: '*',
    close: '*',
    pattern: '\\*([^*]+)\\*',
    enabled: true,
    hideWrappers: true,
    fontWeight: 400,
    fontStyle: 'italic',
    color: '#a3a3a3',
    defaultForBare: true,
    injectInPrompt: true,
  },
  {
    id: 'style-thought',
    name: 'Thought / inner voice',
    role: 'thought',
    open: '_',
    close: '_',
    pattern: '_([^_]+)_',
    enabled: true,
    hideWrappers: true,
    fontWeight: 400,
    fontStyle: 'italic',
    color: '#8a8a8a',
    defaultForBare: false,
    // Thoughts are covered by *action* in the LLM rule by default; keep _ for display only
    injectInPrompt: false,
  },
];

const CORE_IDS = new Set(DEFAULT_MESSAGE_STYLE_RULES.map((r) => r.id));

export function defaultMessageStyle(): MessageStyleSettings {
  return { rules: DEFAULT_MESSAGE_STYLE_RULES.map((r) => ({ ...r })) };
}

/** Escape a string for use inside a RegExp source. */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a capture-group pattern from open/close wrappers.
 * Used when the user edits wrappers in the Regex drawer.
 */
export function patternFromWrappers(open: string, close: string): string {
  const o = open ?? '';
  const c = close ?? '';
  if (!o && !c) return '([\\s\\S]*)';
  if (o === c) {
    if (o.length === 1) {
      const outer = escapeRe(o);
      // Inside a character class only ] \ - ^ need escaping
      const inClass = o.replace(/[\\\]^-]/g, '\\$&');
      return `${outer}([^${inClass}]*)${outer}`;
    }
    // multi-char same wrappers e.g. **text**
    const esc = escapeRe(o);
    return `${esc}([\\s\\S]*?)${esc}`;
  }
  return `${escapeRe(o)}([\\s\\S]*?)${escapeRe(c)}`;
}

function isBlank(s: string | undefined | null): boolean {
  return s == null || String(s).length === 0;
}

/**
 * Normalize message style: ensure core roles exist, heal empty wrappers,
 * but **preserve user open/close/pattern** when they customized them.
 * (Previously overwrote custom wrappers back to platform defaults every save.)
 */
export function ensureForcedMessageStyle(
  settings: MessageStyleSettings | undefined | null,
): MessageStyleSettings {
  const incoming = (settings?.rules ?? []).map((r) => ({
    ...r,
    hideWrappers: r.hideWrappers !== false,
  }));
  const byId = new Map(incoming.map((r) => [r.id, r]));
  const out: MessageStyleRule[] = [];

  for (const def of DEFAULT_MESSAGE_STYLE_RULES) {
    const existing = byId.get(def.id);
    if (existing) {
      const open = !isBlank(existing.open) ? existing.open : def.open;
      const close = !isBlank(existing.close) ? existing.close : def.close;
      // Heal empty pattern from wrappers; keep custom pattern when present
      let pattern = !isBlank(existing.pattern) ? existing.pattern : patternFromWrappers(open, close);
      // Special-case: keep curly-quote-friendly default dialogue pattern when still on "
      if (
        def.id === 'style-dialogue' &&
        open === '"' &&
        close === '"' &&
        (isBlank(existing.pattern) || existing.pattern === def.pattern || existing.pattern === '"([^"]*)"')
      ) {
        pattern = def.pattern;
      }
      const defaultForBare =
        typeof existing.defaultForBare === 'boolean'
          ? existing.defaultForBare
          : def.defaultForBare;
      const injectInPrompt =
        typeof existing.injectInPrompt === 'boolean'
          ? existing.injectInPrompt
          : def.injectInPrompt;
      out.push({
        ...def,
        ...existing,
        open,
        close,
        pattern,
        role: existing.role || def.role,
        enabled: existing.enabled !== false,
        hideWrappers: true,
        injectInPrompt,
        defaultForBare,
      });
      byId.delete(def.id);
    } else {
      const hasRole = incoming.some(
        (r) => r.role === def.role && !CORE_IDS.has(r.id),
      );
      if (!hasRole) out.push({ ...def });
    }
  }

  // Append remaining custom / unknown rules
  for (const r of byId.values()) {
    if (CORE_IDS.has(r.id)) continue;
    const open = r.open ?? '';
    const close = r.close ?? '';
    out.push({
      ...r,
      hideWrappers: r.hideWrappers !== false,
      pattern: !isBlank(r.pattern) ? r.pattern : patternFromWrappers(open, close),
      defaultForBare: out.some((x) => x.defaultForBare) ? false : !!r.defaultForBare,
    });
  }

  // Guarantee at least one defaultForBare (prefer action)
  if (!out.some((r) => r.defaultForBare && r.enabled !== false)) {
    const action = out.find((r) => r.role === 'action');
    if (action) action.defaultForBare = true;
  }

  // Guarantee dialogue + action roles exist even if user deleted everything
  if (!out.some((r) => r.role === 'dialogue')) out.unshift({ ...DEFAULT_MESSAGE_STYLE_RULES[0] });
  if (!out.some((r) => r.role === 'action')) {
    const di = out.findIndex((r) => r.role === 'dialogue');
    out.splice(di >= 0 ? di + 1 : 0, 0, { ...DEFAULT_MESSAGE_STYLE_RULES[1] });
  }

  // Deduplicate by id preserving first
  const seen = new Set<string>();
  const deduped: MessageStyleRule[] = [];
  for (const r of out) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    deduped.push(r);
  }

  return { rules: deduped };
}

export interface StyleSegment {
  text: string;
  role: MessageStyleRole;
  ruleId?: string;
  /** full match including wrappers when hideWrappers is false */
  raw: string;
}

function compileRule(rule: MessageStyleRule): RegExp | null {
  try {
    return new RegExp(rule.pattern, 'g');
  } catch {
    return null;
  }
}

/**
 * Split message text into styled segments according to enabled rules.
 * Longer / earlier-priority: dialogue and wrappers scanned left-to-right by earliest match.
 */
export function parseMessageStyles(text: string, settings: MessageStyleSettings | undefined | null): StyleSegment[] {
  if (!text) return [];
  const forced = ensureForcedMessageStyle(settings);
  const rules = forced.rules.filter((r) => r.enabled && r.pattern);
  if (!rules.length) return [{ text, role: 'plain', raw: text }];

  type Hit = { start: number; end: number; inner: string; rule: MessageStyleRule; raw: string };
  const hits: Hit[] = [];

  for (const rule of rules) {
    const re = compileRule(rule);
    if (!re) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const raw = m[0];
      const inner = m[1] ?? raw;
      const start = m.index;
      const end = start + raw.length;
      // skip zero-length
      if (end <= start) {
        re.lastIndex = start + 1;
        continue;
      }
      hits.push({ start, end, inner, rule, raw });
      if (!re.global) break;
    }
  }

  // resolve overlaps: keep earliest start, then longer match
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const chosen: Hit[] = [];
  let cursor = 0;
  for (const h of hits) {
    if (h.start < cursor) continue;
    chosen.push(h);
    cursor = h.end;
  }

  const bareRule = rules.find((r) => r.defaultForBare);
  const out: StyleSegment[] = [];
  let i = 0;
  for (const h of chosen) {
    if (h.start > i) {
      const plain = text.slice(i, h.start);
      out.push({
        text: plain,
        role: bareRule?.role ?? 'plain',
        ruleId: bareRule?.id,
        raw: plain,
      });
    }
    // UI never shows markers (", *, _, etc.) — wrappers stay in storage for the model only
    out.push({
      text: h.inner,
      role: h.rule.role,
      ruleId: h.rule.id,
      raw: h.raw,
    });
    i = h.end;
  }
  if (i < text.length) {
    const plain = text.slice(i);
    out.push({
      text: plain,
      role: bareRule?.role ?? 'plain',
      ruleId: bareRule?.id,
      raw: plain,
    });
  }
  return out.length ? out : [{ text, role: 'plain', raw: text }];
}

export function styleRuleCss(rule: MessageStyleRule | undefined, role: MessageStyleRole): Record<string, string | number> {
  if (rule) {
    return {
      fontWeight: rule.fontWeight,
      fontStyle: rule.fontStyle,
      color: rule.color,
    };
  }
  if (role === 'dialogue') return { fontWeight: 500, color: '#ffffff' };
  if (role === 'action') return { fontStyle: 'italic', color: '#a3a3a3' };
  if (role === 'thought') return { fontStyle: 'italic', color: '#8a8a8a' };
  return {};
}

function sampleFor(rule: MessageStyleRule): string {
  return `${rule.open}example${rule.close}`;
}

/**
 * Short mandatory format block for the LLM — built only from live style rules.
 * Sent every generation so the model follows exact wrappers from this point on,
 * regardless of earlier chat habits or preset prose.
 */
export function buildMessageStylePrompt(settings: MessageStyleSettings | undefined | null): string {
  const forced = ensureForcedMessageStyle(settings);
  const rules = forced.rules.filter((r) => r.enabled && r.injectInPrompt);

  const lines: string[] = [
    'FORMAT (strict — every reply from now on; ignore any older format habits):',
  ];

  if (!rules.length) {
    lines.push(
      '- Spoken dialogue in "double quotes" e.g. "Hello."',
      '- Actions, body language, narration, thoughts in *asterisks* e.g. *I glance away.*',
    );
  } else {
    for (const r of rules) {
      const sample = sampleFor(r);
      if (r.role === 'dialogue') {
        lines.push(`- Dialogue (spoken aloud): wrap in ${JSON.stringify(r.open)} … ${JSON.stringify(r.close)} e.g. ${sample}`);
      } else if (r.role === 'action') {
        lines.push(
          `- Actions / body / narration / thoughts: wrap in ${JSON.stringify(r.open)} … ${JSON.stringify(r.close)} e.g. ${sample} (first person)`,
        );
      } else if (r.role === 'thought') {
        lines.push(`- Inner thoughts: wrap in ${JSON.stringify(r.open)} … ${JSON.stringify(r.close)} e.g. ${sample}`);
      } else if (r.defaultForBare) {
        lines.push(`- Unmarked plain text = ${r.name}.`);
      } else {
        lines.push(`- ${r.name}: wrap in ${JSON.stringify(r.open)} … ${JSON.stringify(r.close)} e.g. ${sample}`);
      }
    }
  }

  lines.push(
    'Write in FIRST PERSON as the speaking character (I / me / my). Never third person about yourself.',
    'Use ONLY these wrappers for all in-world content. Never omit them on dialogue or action.',
    'In-character thoughts stay inside the action/thought wrappers above — woven into the prose.',
    'FORBIDDEN: meta, OOC, counters, stage/status lines, JSON, HTML, system notes.',
    'FORBIDDEN: "INTERNAL THOUGHTS", "🧠 INTERNAL THOUGHTS", "Thought process", "Name | Thoughts:", bullet thought trackers, or any out-of-character reasoning dump.',
    'Do not explain formatting. Output only the in-character message body.',
  );
  return lines.join('\n');
}

/**
 * Ultra-short tail reminder — same wrappers, for end-of-prompt enforcement every turn.
 */
export function buildMessageStyleTailReminder(settings: MessageStyleSettings | undefined | null): string {
  const forced = ensureForcedMessageStyle(settings);
  const rules = forced.rules.filter((r) => r.enabled && r.injectInPrompt);
  if (!rules.length) {
    return 'FORMAT CHECK: "dialogue" and *actions/thoughts* only. First person. No meta.';
  }
  const bits = rules.map((r) => {
    if (r.role === 'dialogue') return `${r.open}dialogue${r.close}`;
    if (r.role === 'action') return `${r.open}action/thought${r.close}`;
    if (r.role === 'thought') return `${r.open}thought${r.close}`;
    return `${r.open}${r.name}${r.close}`;
  });
  return `FORMAT CHECK (mandatory this turn): only ${bits.join(' + ')}. First person. No meta. No INTERNAL THOUGHTS blocks.`;
}

/** Wrap selection or insert pair at cursor for composer helpers. */
export function wrapWithRule(text: string, selectionStart: number, selectionEnd: number, rule: MessageStyleRule): {
  next: string;
  cursor: number;
} {
  const open = rule.open;
  const close = rule.close;
  const before = text.slice(0, selectionStart);
  const selected = text.slice(selectionStart, selectionEnd);
  const after = text.slice(selectionEnd);
  if (selected.length) {
    const next = `${before}${open}${selected}${close}${after}`;
    return { next, cursor: before.length + open.length + selected.length + close.length };
  }
  // empty selection: place cursor between wrappers
  const next = `${before}${open}${close}${after}`;
  return { next, cursor: before.length + open.length };
}
