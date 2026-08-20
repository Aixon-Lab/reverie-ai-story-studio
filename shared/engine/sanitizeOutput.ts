/**
 * Clean AI output before save / display:
 * - Hide model reasoning / chain-of-thought (like product UIs hide "thinking")
 * - Strip junk RP formats (HTML colors, time headers, feed modules, …)
 *
 * In-character thoughts written as *action* / _thought_ stay visible.
 * Meta blocks (🧠 INTERNAL THOUGHTS, <think>, …) are removed from chat text.
 * Extracted reasoning is optional for storage (`extra.reasoning`) — not shown by default.
 */

export type ReasoningWrappers = {
  /** Active reasoning preset open tag / prefix, e.g. `<think>` */
  prefix?: string;
  /** Active reasoning preset close tag / suffix, e.g. `</think>` */
  suffix?: string;
};

export type SplitReasoningResult = {
  /** User-visible message body */
  visible: string;
  /** Hidden model thinking (may be empty) */
  reasoning: string;
};

/** XML / special tags whose inner content is model CoT, never chat prose. */
const THINK_TAG_NAMES = [
  'think',
  'thinking',
  'reasoning',
  'thought',
  'redacted_reasoning',
  'reflection',
  'scratchpad',
  'analysis',
];

/** Headers that open a meta "internal thoughts" section (stripped to end or next IC block). */
const INTERNAL_THOUGHT_HEADER =
  /^(?:[#>*_\s`]|\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F|\u200D)*\s*(?:internal\s+thoughts?|inner\s+thoughts?|character\s+thoughts?|private\s+thoughts?|hidden\s+thoughts?|thought\s+process|chain\s+of\s+thought|\bcot\b|reasoning(?:\s+process)?|model\s+thoughts?)\s*[:：]?\s*$/iu;

/** Bullet / line forms: `Elin | Thoughts: …` or `Thoughts: …` */
const THOUGHT_META_LINE =
  /^(?:[-*•]\s*)?(?:[\w][\w .'-]{0,40}\s*[|–—:]\s*)?(?:thoughts?|thinking|internal|reasoning)\s*[:：]/i;

/** Preset / injection content that must never reach the model. */
export function isJunkFormatPrompt(name: string, content: string): boolean {
  const n = `${name}\n${content}`.toLowerCase();
  if (/colored_dialogue_protocol|<font\s+color=|header_protocol|must_start_every_response/.test(n)) return true;
  if (/x_feed_module|gfx_start|twitter x feed|trending/.test(n) && /html/.test(n)) return true;
  if (/plot_tracking_module|plot momentum|npc_agenda/.test(n) && /<\/?details|next_path/.test(n)) return true;
  if (/time and place|⏰\s*time/.test(n) && /location/.test(n) && /weather/.test(n)) return true;
  return false;
}

/**
 * Split model chain-of-thought from the visible reply.
 * Safe to call mid-stream (open think blocks without close → strip to end).
 */
export function splitReasoningFromOutput(
  raw: string,
  wrappers?: ReasoningWrappers | null,
): SplitReasoningResult {
  if (!raw) return { visible: '', reasoning: '' };

  let text = raw;
  const chunks: string[] = [];

  const take = (block: string) => {
    const t = block.trim();
    if (t) chunks.push(t);
  };

  // 1) Active reasoning preset wrappers (if configured)
  if (wrappers?.prefix?.trim()) {
    const open = wrappers.prefix;
    const close = wrappers.suffix?.trim() ? wrappers.suffix : null;
    const result = stripDelimited(text, open, close);
    text = result.text;
    for (const c of result.captured) take(c);
  }

  // 2) Common think / reasoning XML tags (complete + incomplete)
  for (const name of THINK_TAG_NAMES) {
    const result = stripXmlTag(text, name);
    text = result.text;
    for (const c of result.captured) take(c);
  }

  // 3) Special-token style: <|think|>…<|/think|>, [THINK]…[/THINK]
  {
    const result = stripRegexBlocks(
      text,
      /<\|?\s*think\s*\|?>[\s\S]*?(?:<\|?\s*\/\s*think\s*\|?>|$)/gi,
      /\[\s*think(?:ing)?\s*\][\s\S]*?(?:\[\s*\/\s*think(?:ing)?\s*\]|$)/gi,
    );
    text = result.text;
    for (const c of result.captured) take(c);
  }

  // 4) Markdown / emoji "INTERNAL THOUGHTS" sections + meta thought lines
  {
    const result = stripInternalThoughtSections(text);
    text = result.text;
    for (const c of result.captured) take(c);
  }

  return {
    visible: text,
    reasoning: chunks.join('\n\n').trim(),
  };
}

/**
 * Clean a finished AI (or historical) message for Reverie display.
 * Keeps dialogue/action prose; removes reasoning, meta chrome, and HTML.
 */
export function sanitizeAiOutput(
  raw: string,
  wrappers?: ReasoningWrappers | null,
): string {
  if (!raw) return raw;

  // Reasoning first — before HTML strip would leave CoT body as plain text
  let text = splitReasoningFromOutput(raw, wrappers).visible;

  // 1) Whole junk blocks
  text = text.replace(/<!--\s*GFX_START\s*-->[\s\S]*?<!--\s*GFX_END\s*-->/gi, '');
  text = text.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, '');
  text = text.replace(/<div\b[^>]*>[\s\S]*?<\/div>/gi, '');

  // 2) HTML tags — keep inner text for font/span/b/i/etc.
  text = text.replace(/<\/?font\b[^>]*>/gi, '');
  text = text.replace(/<\/?span\b[^>]*>/gi, '');
  text = text.replace(/<\/?p\b[^>]*>/gi, '\n');
  text = text.replace(/<\/?br\s*\/?>/gi, '\n');
  text = text.replace(/<\/?(?:b|i|em|strong|u|code|pre|small|big|center|h[1-6])\b[^>]*>/gi, '');
  text = text.replace(/<\/?[a-zA-Z][^>]*>/g, '');
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');

  // 3) Line-level meta filters
  const lines = text.split(/\r?\n/);
  const cleaned = lines.filter((line) => {
    const t = line.trim();
    if (!t) return true;

    if (isStatusHeaderLine(t)) return false;
    if (INTERNAL_THOUGHT_HEADER.test(t)) return false;
    if (THOUGHT_META_LINE.test(t) && t.length < 280) return false;

    // classic OOC / tracker leaks
    if (/^(counter|stage|turn|status|ooc|meta|system|debug|flags?|vars?)\s*[:=]/i.test(t)) return false;
    if (/^(counter|stage|turn)\s*\d+/i.test(t)) return false;
    if (/^stage\s*:\s*\d+\s*[-–>]+\s*\d+/i.test(t)) return false;
    if (/^\[?\s*(ooc|system|meta)\s*\]?/i.test(t) && t.length < 100) return false;

    // Plot momentum leftovers as plain lines
    if (/^(NPC_Agenda|Physics|Scene_Pacing|Selected_Path|Strategy_Reason|Env_State|NPC_Branches)\s*:/i.test(t)) {
      return false;
    }
    if (/^Path_[A-D]\b/i.test(t)) return false;

    return true;
  });

  text = cleaned.join('\n');

  // 4) Inline remnants of font tags
  text = text.replace(/color\s*=\s*["']?#[0-9A-Fa-f]{3,8}["']?/g, '');

  // 5) Collapse excess blank lines
  text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
  return text;
}

// ---------- internals ----------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripDelimited(
  text: string,
  open: string,
  close: string | null,
): { text: string; captured: string[] } {
  const captured: string[] = [];
  if (!open) return { text, captured };

  if (close) {
    const re = new RegExp(
      `${escapeRe(open)}([\\s\\S]*?)${escapeRe(close)}`,
      'gi',
    );
    text = text.replace(re, (_m, inner: string) => {
      captured.push(String(inner ?? ''));
      return '\n';
    });
    // incomplete open → end
    const openRe = new RegExp(`${escapeRe(open)}([\\s\\S]*)$`, 'i');
    text = text.replace(openRe, (_m, inner: string) => {
      captured.push(String(inner ?? ''));
      return '';
    });
  } else {
    const idx = text.toLowerCase().indexOf(open.toLowerCase());
    if (idx >= 0) {
      captured.push(text.slice(idx + open.length));
      text = text.slice(0, idx);
    }
  }
  return { text, captured };
}

function stripXmlTag(text: string, name: string): { text: string; captured: string[] } {
  const captured: string[] = [];
  const closed = new RegExp(
    `<\\s*${name}\\b[^>]*>([\\s\\S]*?)<\\s*\\/\\s*${name}\\s*>`,
    'gi',
  );
  text = text.replace(closed, (_m, inner: string) => {
    captured.push(String(inner ?? ''));
    return '\n';
  });
  // unclosed (streaming / truncated)
  const open = new RegExp(`<\\s*${name}\\b[^>]*>([\\s\\S]*)$`, 'i');
  text = text.replace(open, (_m, inner: string) => {
    captured.push(String(inner ?? ''));
    return '';
  });
  return { text, captured };
}

function stripRegexBlocks(
  text: string,
  ...patterns: RegExp[]
): { text: string; captured: string[] } {
  const captured: string[] = [];
  for (const re of patterns) {
    text = text.replace(re, (m) => {
      captured.push(m);
      return '\n';
    });
  }
  return { text, captured };
}

/**
 * Remove INTERNAL THOUGHTS-style sections.
 * Header line → drop following meta bullets until blank line + IC prose, or EOS.
 */
function stripInternalThoughtSections(text: string): { text: string; captured: string[] } {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  const captured: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed && INTERNAL_THOUGHT_HEADER.test(trimmed)) {
      const block: string[] = [line];
      i += 1;
      while (i < lines.length) {
        const next = lines[i];
        const nt = next.trim();
        // Stop if we clearly resume in-character prose (quoted dialogue or *action*)
        if (nt && isLikelyInCharacterResume(nt) && !THOUGHT_META_LINE.test(nt)) {
          break;
        }
        // Stop after a blank line followed by IC content (peek)
        if (!nt) {
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j += 1;
          if (j < lines.length && isLikelyInCharacterResume(lines[j].trim())) {
            break;
          }
        }
        block.push(next);
        i += 1;
        // Prefer cutting at end: many models put thoughts last — keep gobbling meta lines
        if (nt && !THOUGHT_META_LINE.test(nt) && !isMetaThoughtContinuation(nt) && isLikelyInCharacterResume(nt)) {
          // put back this line
          block.pop();
          i -= 1;
          break;
        }
      }
      captured.push(block.join('\n'));
      continue;
    }

    // Standalone meta thought bullets without a header
    if (trimmed && THOUGHT_META_LINE.test(trimmed) && looksLikeMetaThoughtBody(trimmed)) {
      const block: string[] = [line];
      i += 1;
      while (i < lines.length) {
        const next = lines[i];
        const nt = next.trim();
        if (!nt) {
          block.push(next);
          i += 1;
          continue;
        }
        if (THOUGHT_META_LINE.test(nt) || isMetaThoughtContinuation(nt)) {
          block.push(next);
          i += 1;
          continue;
        }
        break;
      }
      captured.push(block.join('\n'));
      continue;
    }

    out.push(line);
    i += 1;
  }

  return { text: out.join('\n'), captured };
}

function isLikelyInCharacterResume(t: string): boolean {
  if (!t) return false;
  // dialogue
  if (/^["“«]/.test(t)) return true;
  // *action* or full-line action open
  if (/^\*/.test(t)) return true;
  // italic underscore thought used as IC style (not a meta header)
  if (/^_[^_]+_/.test(t)) return true;
  // narrative paragraph without meta markers
  if (
    t.length > 40
    && !THOUGHT_META_LINE.test(t)
    && !INTERNAL_THOUGHT_HEADER.test(t)
    && !/^(ooc|system|meta|debug)\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

function isMetaThoughtContinuation(t: string): boolean {
  // indented continuation, bullets, name|field lines
  if (/^[-*•]/.test(t)) return true;
  if (/^\s{2,}\S/.test(t)) return true;
  if (/^[\w][\w .'-]{0,40}\s*[|–—]\s*/.test(t) && t.length < 300) return true;
  return false;
}

function looksLikeMetaThoughtBody(t: string): boolean {
  // `Name | Thoughts: …` or bare `Thoughts: don't panic`
  if (/\|\s*(?:thoughts?|thinking|internal|reasoning)\s*[:：]/i.test(t)) return true;
  if (/^(?:[-*•]\s*)?(?:thoughts?|thinking|internal\s+thoughts?|reasoning)\s*[:：]/i.test(t)) return true;
  if (/^[A-Z][\w .'-]{0,40}\s*[|–—]\s*Thoughts?\s*[:：]/i.test(t)) return true;
  return false;
}

/** `[ 🕰️ Time … | 📍 Location … | weather ]` and similar one-liners */
function isStatusHeaderLine(t: string): boolean {
  if (
    /^\[/.test(t)
    && t.includes('|')
    && (
      /time\b/i.test(t)
      || /location\b/i.test(t)
      || /[📍🕰️🗓️📅⏰]|weather|fog|rain|°[FC]|AM\/PM|AM\b|PM\b/i.test(t)
    )
  ) {
    return true;
  }
  if (
    /^(?:time|location)\s*[:=]/i.test(t)
    && (t.length < 160)
  ) {
    return true;
  }
  if (
    /[📍🕰️🗓️📅⏰]/.test(t)
    && /\|/.test(t)
    && t.length < 220
    && /time|location|weather|fog|°/i.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * Cut a reply at the point the model starts speaking as somebody else.
 *
 * Stop strings are the first line of defence, but providers honour them
 * inconsistently (and several cap how many they accept), so the same guard runs
 * on the returned text. Matches a speaker label at the start of a line —
 * `Name:`, `**Name:**`, `*Name:*` — for any participant other than the speaker.
 *
 * Returns the text up to that point, trimmed. If the very first line is a
 * foreign label the result is empty, which the caller treats as a failed
 * generation rather than silently posting someone else's dialogue.
 */
export function truncateAtForeignSpeaker(
  text: string,
  selfName: string,
  otherNames: string[],
): string {
  const raw = text ?? '';
  const others = otherNames
    .map((n) => (n ?? '').trim())
    .filter((n) => n && n.toLowerCase() !== (selfName ?? '').trim().toLowerCase());
  if (!others.length || !raw.trim()) return raw;

  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Optional bold/italic/heading wrapper, the name, optional wrapper, a colon.
  const pattern = new RegExp(
    `^[ \\t]*(?:\\*{1,2}|_{1,2}|#{1,6}[ \\t]*)?(?:${others.map(esc).join('|')})(?:\\*{1,2}|_{1,2})?[ \\t]*:`,
    'im',
  );

  const match = pattern.exec(raw);
  if (!match) return raw;
  return raw.slice(0, match.index).trim();
}
