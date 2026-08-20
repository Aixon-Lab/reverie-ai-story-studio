/** ST-compatible regex script runner. */
import type { RegexPlacement, RegexScript } from '../types';

function compileFind(find: string, substitute: (s: string) => string, doSub: boolean): RegExp | null {
  let src = find;
  let flags = 'g';
  const m = find.match(/^\/([\s\S]*)\/([gimsuy]*)$/);
  if (m) {
    src = m[1];
    flags = m[2].includes('g') ? m[2] : `${m[2]}g`;
  }
  if (doSub) src = substitute(src);
  try {
    return new RegExp(src, flags);
  } catch {
    return null;
  }
}

export function applyRegexScripts(
  text: string,
  scripts: RegexScript[],
  placement: RegexPlacement,
  opts?: {
    depth?: number;
    forDisplay?: boolean;
    forPrompt?: boolean;
    substitute?: (s: string) => string;
  },
): string {
  if (!text || !scripts?.length) return text;
  const depth = opts?.depth ?? 0;
  const sub = opts?.substitute ?? ((s: string) => s);
  let out = text;

  for (const script of scripts) {
    if (script.disabled) continue;
    if (!script.placement.includes(placement)) continue;
    if (opts?.forDisplay && script.promptOnly) continue;
    if (opts?.forPrompt && script.markdownOnly) continue;
    if (script.minDepth != null && depth < script.minDepth) continue;
    if (script.maxDepth != null && depth > script.maxDepth) continue;

    const re = compileFind(script.findRegex, sub, script.substituteRegex);
    if (!re) continue;

    let replace = script.replaceString ?? '';
    if (script.substituteRegex) replace = sub(replace);

    try {
      out = out.replace(re, (...args) => {
        // support $1 style and {{match}}
        let r = replace;
        const match = args[0] as string;
        const groups = args.slice(1, -2) as string[];
        r = r.replace(/\{\{match\}\}/gi, match);
        groups.forEach((g, i) => {
          r = r.replace(new RegExp(`\\$${i + 1}`, 'g'), g ?? '');
          r = r.split(`{{$${i + 1}}}`).join(g ?? '');
        });
        return r;
      });
    } catch {
      // skip broken scripts
    }

    for (const trim of script.trimStrings ?? []) {
      if (trim) out = out.split(trim).join('');
    }
  }
  return out;
}

export function emptyRegexScript(partial?: Partial<RegexScript>): RegexScript {
  return {
    id: partial?.id ?? `rx-${Date.now()}`,
    scriptName: partial?.scriptName ?? 'New Script',
    findRegex: partial?.findRegex ?? '',
    replaceString: partial?.replaceString ?? '',
    trimStrings: partial?.trimStrings ?? [],
    placement: partial?.placement ?? ['ai_output'],
    disabled: partial?.disabled ?? false,
    markdownOnly: partial?.markdownOnly ?? false,
    promptOnly: partial?.promptOnly ?? false,
    runOnEdit: partial?.runOnEdit ?? true,
    substituteRegex: partial?.substituteRegex ?? false,
    minDepth: partial?.minDepth ?? null,
    maxDepth: partial?.maxDepth ?? null,
  };
}
