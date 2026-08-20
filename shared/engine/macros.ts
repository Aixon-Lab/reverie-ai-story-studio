/**
 * Macro engine: ST-compatible {{...}} substitution.
 * Covers the core macros presets/cards rely on. Variable macros persist via env.variables.
 */

export interface MacroEnv {
  char?: string;
  user?: string;
  group?: string; // comma-joined member names
  model?: string;
  persona?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  mesExamples?: string;
  charPrompt?: string;
  charInstruction?: string;
  charVersion?: string;
  lastMessage?: string;
  lastUserMessage?: string;
  lastCharMessage?: string;
  original?: string; // for preset-override passthrough
  chatIdHash?: number; // stable seed for {{pick}}
  variables?: Record<string, string>;
  globals?: Record<string, string>;
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function splitArgs(body: string): string[] {
  // supports both {{random:a,b,c}} and {{random::a::b}}
  if (body.includes('::')) return body.split('::');
  return body.split(',');
}

function rollDice(spec: string): string {
  const m = /^(\d*)d(\d+)([+-]\d+)?$/i.exec(spec.trim());
  if (!m) return '';
  const count = Math.min(Number(m[1] || 1), 100);
  const sides = Math.min(Number(m[2]), 10000);
  const mod = Number(m[3] || 0);
  let total = mod;
  for (let i = 0; i < count; i++) total += 1 + Math.floor(Math.random() * sides);
  return String(total);
}

const TIME_MACROS: Record<string, () => string> = {
  time: () => new Date().toLocaleTimeString(),
  date: () => new Date().toLocaleDateString(),
  weekday: () => new Date().toLocaleDateString(undefined, { weekday: 'long' }),
  isotime: () => new Date().toISOString().substring(11, 19),
  isodate: () => new Date().toISOString().substring(0, 10),
};

/** Substitute all macros in a template. Unknown macros are left intact (ST behavior for extensions). */
export function substituteMacros(template: string, env: MacroEnv): string {
  if (!template || !template.includes('{{')) return template ?? '';
  const vars = env.variables ?? {};
  const globals = env.globals ?? {};

  return template.replace(/{{([^{}]+)}}/g, (full, inner: string) => {
    const body = inner.trim();
    const lower = body.toLowerCase();

    // simple identity/env macros
    switch (lower) {
      case 'char': return env.char ?? '';
      case 'user': return env.user ?? '';
      case 'group': case 'charifnotgroup': return env.group ?? env.char ?? '';
      case 'model': return env.model ?? '';
      case 'persona': return env.persona ?? '';
      case 'description': return env.description ?? '';
      case 'personality': return env.personality ?? '';
      case 'scenario': return env.scenario ?? '';
      case 'mesexamples': return env.mesExamples ?? '';
      case 'charprompt': return env.charPrompt ?? '';
      case 'charinstruction': case 'charjailbreak': return env.charInstruction ?? '';
      case 'char_version': return env.charVersion ?? '';
      case 'lastmessage': return env.lastMessage ?? '';
      case 'lastusermessage': return env.lastUserMessage ?? '';
      case 'lastcharmessage': return env.lastCharMessage ?? '';
      case 'original': return env.original ?? '';
      case 'newline': return '\n';
      case 'trim': return ''; // handled post-pass below
      case 'noop': return '';
    }

    if (lower in TIME_MACROS) return TIME_MACROS[lower]();

    // parameterized macros
    if (lower.startsWith('random:') || lower.startsWith('random::')) {
      const items = splitArgs(body.substring(body.indexOf(':') + 1).replace(/^:/, '')).filter((s) => s.length);
      return items.length ? items[Math.floor(Math.random() * items.length)].trim() : '';
    }
    if (lower.startsWith('pick:') || lower.startsWith('pick::')) {
      const items = splitArgs(body.substring(body.indexOf(':') + 1).replace(/^:/, '')).filter((s) => s.length);
      if (!items.length) return '';
      const seed = (env.chatIdHash ?? 0) ^ hashStr(full);
      return items[Math.floor(mulberry32(seed)() * items.length)].trim();
    }
    if (lower.startsWith('roll:') || lower.startsWith('roll::')) {
      return rollDice(body.substring(body.indexOf(':') + 1).replace(/^:/, ''));
    }
    if (lower.startsWith('getvar::')) return vars[body.substring(8)] ?? '';
    if (lower.startsWith('setvar::')) {
      const parts = body.substring(8).split('::');
      if (parts.length >= 2) vars[parts[0]] = parts.slice(1).join('::');
      return '';
    }
    if (lower.startsWith('addvar::')) {
      const parts = body.substring(8).split('::');
      if (parts.length >= 2) vars[parts[0]] = String((Number(vars[parts[0]]) || 0) + (Number(parts[1]) || 0));
      return '';
    }
    if (lower.startsWith('incvar::')) {
      const k = body.substring(8);
      vars[k] = String((Number(vars[k]) || 0) + 1);
      return vars[k];
    }
    if (lower.startsWith('decvar::')) {
      const k = body.substring(8);
      vars[k] = String((Number(vars[k]) || 0) - 1);
      return vars[k];
    }
    if (lower.startsWith('getglobalvar::')) return globals[body.substring(14)] ?? '';
    if (lower.startsWith('setglobalvar::')) {
      const parts = body.substring(14).split('::');
      if (parts.length >= 2) globals[parts[0]] = parts.slice(1).join('::');
      return '';
    }
    if (lower.startsWith('datetimeformat')) {
      return new Date().toLocaleString();
    }
    if (lower.startsWith('banned ')) return ''; // sampler-level; stripped from text

    return full; // unknown macro: leave for downstream/extensions
  }).replace(/\s*{{trim}}\s*/gi, '');
}
