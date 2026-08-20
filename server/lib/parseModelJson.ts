/**
 * Extract + parse a JSON object from messy model output.
 * Handles markdown fences, leading prose, trailing junk, trailing commas,
 * smart quotes, and (best-effort) truncated brace streams.
 */

export function parseModelJson(raw: string, label = 'Model'): any {
  const text = String(raw ?? '').trim();
  if (!text) {
    throw new Error(
      `${label} returned empty text (safety filter, wrong model for vision, or truncated). Try another model or re-crop a smaller portrait.`,
    );
  }

  const candidates = collectJsonCandidates(text);
  let lastErr: Error | null = null;

  for (const candidate of candidates) {
    for (const variant of [candidate, repairJson(candidate)]) {
      try {
        return JSON.parse(variant);
      } catch (e: any) {
        lastErr = e instanceof Error ? e : new Error(String(e));
      }
    }
  }

  const preview = text.replace(/\s+/g, ' ').slice(0, 220);
  const detail = lastErr?.message ? ` (${lastErr.message})` : '';
  throw new Error(`${label} returned invalid JSON${detail}. Preview: ${preview}`);
}

function collectJsonCandidates(text: string): string[] {
  const out: string[] = [];
  const push = (s: string | null | undefined) => {
    const t = (s ?? '').trim();
    if (t && !out.includes(t)) out.push(t);
  };

  // ```json ... ```
  const fenceRe = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(text))) push(fm[1]);

  // strip a single outer fence if whole response is fenced
  push(text.replace(/^```(?:json|JSON)?\s*/i, '').replace(/\s*```$/i, ''));

  push(text);
  push(extractBalancedObject(text));
  push(extractBalancedObject(normalizeQuotes(text)));

  // greedy fallback (old behavior)
  const greedy = text.match(/\{[\s\S]*\}/);
  if (greedy) push(greedy[0]);

  // A top-level array is a shape models reach for when asked for a list. Tried
  // last so an object response is never mis-read as one.
  const arr = text.match(/\[[\s\S]*\]/);
  if (arr) push(arr[0]);

  return out.map(normalizeQuotes);
}

/** Brace-matching object extractor (string-aware). Closes open braces if truncated. */
export function extractBalancedObject(s: string): string | null {
  const start = s.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }

  // Truncated mid-object: close open string + braces so parse may still recover partial data
  if (depth > 0) {
    let partial = s.slice(start);
    if (inStr) partial += '"';
    // drop trailing incomplete key/value if ends with comma or colon
    partial = partial.replace(/,\s*$/, '').replace(/:\s*$/, ': null');
    partial += '}'.repeat(depth);
    return partial;
  }
  return null;
}

function normalizeQuotes(s: string): string {
  return s
    .replace(/[\u201C\u201D\u00AB\u00BB]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\uFEFF/g, '');
}

/** Safe syntactic cleanups that rarely break real string content. */
export function repairJson(s: string): string {
  return s
    // trailing commas before } or ]
    .replace(/,\s*(?=[}\]])/g, '')
    // JS-style unquoted keys → quoted (simple identifiers only)
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    // bare newlines inside strings are rare after models; leave them
    ;
}
