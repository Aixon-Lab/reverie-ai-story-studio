/**
 * Skill parsing: documents in, and the selector tag back out.
 *
 * Two directions live here because they are two halves of one contract — what
 * a skill file looks like on disk / on the clipboard, and how the model reports
 * which skills the next turn needs.
 */
import { estimateTokens } from '../engine/tokens';
import type { Skill, SkillSection } from './types';

// ---------------------------------------------------------------- documents

export interface ParsedSkillDoc {
  name: string;
  description: string;
  keywords: string[];
  tags: string[];
  body: string;
}

const FRONT_MATTER = /^\s*(?:---\s*\n)?((?:[A-Za-z_][\w -]*:[^\n]*\n)+)(?:---\s*\n)/;

/**
 * Read a pasted / uploaded skill.
 *
 * Accepts a light front-matter header (`name:`, `description:`, `keywords:`,
 * `tags:`) followed by the markdown body, and degrades gracefully when it is
 * absent: the first `# heading` (or the filename) becomes the name and the
 * first prose line becomes the description. Someone pasting a raw document
 * should never have to learn a format first.
 */
export function parseSkillDoc(raw: string, fallbackName = 'Untitled skill'): ParsedSkillDoc {
  const text = stripCodeFence(String(raw ?? '').replace(/\r\n/g, '\n').trim());
  const out: ParsedSkillDoc = {
    name: '', description: '', keywords: [], tags: [], body: text,
  };

  const fm = text.match(FRONT_MATTER);
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^([A-Za-z_][\w -]*)\s*:\s*(.*)$/);
      if (!m) continue;
      const key = m[1].trim().toLowerCase();
      const value = m[2].trim().replace(/^["']|["']$/g, '');
      if (key === 'name' || key === 'title') out.name = value;
      else if (key === 'description' || key === 'summary') out.description = value;
      else if (key === 'keywords' || key === 'triggers') out.keywords = splitList(value);
      else if (key === 'tags') out.tags = splitList(value);
    }
    out.body = text.slice(fm[0].length).trim();
  }

  const lines = out.body.split('\n');
  if (!out.name) {
    const heading = lines.find((l) => /^#{1,3}\s+\S/.test(l));
    if (heading) {
      out.name = heading.replace(/^#{1,3}\s+/, '').trim();
      // A title line that only titles the document is noise once it is a field.
      if (lines[0] === heading) out.body = lines.slice(1).join('\n').trim();
    }
  }
  if (!out.name) out.name = fallbackName;

  if (!out.description) {
    const first = out.body
      .split('\n')
      .find((l) => l.trim() && !/^[#>\-*`|]/.test(l.trim()));
    out.description = first ? oneLine(first, 180) : `Craft guidance for ${out.name.toLowerCase()}.`;
  }

  out.name = oneLine(out.name, 80);
  out.description = oneLine(out.description, 200);
  return out;
}

/** Serialize a skill back to a portable markdown file. */
export function exportSkillDoc(skill: Skill): string {
  const head = [
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    skill.keywords.length ? `keywords: ${skill.keywords.join(', ')}` : '',
    skill.tags.length ? `tags: ${skill.tags.join(', ')}` : '',
  ].filter(Boolean).join('\n');
  return `---\n${head}\n---\n\n${skill.body.trim()}\n`;
}

/**
 * Split a body on markdown headings.
 *
 * Sections are the unit of graded trimming: when a skill will not fit whole,
 * whole sections are dropped from the bottom rather than the text being cut
 * mid-sentence. Half a technique description is worse than none — the model
 * fills the gap with invention and calls it craft.
 */
export function splitSections(body: string): SkillSection[] {
  const text = String(body ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return [];
  const lines = text.split('\n');
  const out: SkillSection[] = [];
  let heading = '';
  let buf: string[] = [];

  const flush = () => {
    const chunk = buf.join('\n').trim();
    if (!chunk && !heading) return;
    out.push({ heading, body: chunk, tokens: estimateTokens(`${heading}\n${chunk}`) });
    buf = [];
  };

  for (const line of lines) {
    if (/^#{1,4}\s+\S/.test(line)) {
      flush();
      heading = line.replace(/^#{1,4}\s+/, '').trim();
    } else {
      buf.push(line);
    }
  }
  flush();
  return out.filter((s) => s.heading || s.body);
}

/**
 * Build the fallback digest — what survives when the full body will not fit.
 *
 * Prefers the author's own opening (usually the principles) and the section
 * headings, which together still tell the model *what kind* of expertise it
 * has even when the detail is gone.
 */
export function deriveDigest(body: string, sections: SkillSection[], maxTokens = 140): string {
  const opening = String(body ?? '')
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !/^#{1,4}\s/.test(p) && !/^[-*]\s/.test(p)) ?? '';

  const headings = sections.map((s) => s.heading).filter(Boolean);
  const parts: string[] = [];
  let used = 0;
  const push = (s: string) => {
    const t = estimateTokens(s);
    if (used + t > maxTokens) return false;
    parts.push(s);
    used += t;
    return true;
  };

  if (opening) push(oneLine(opening, 600));
  if (headings.length) push(`Covers: ${headings.join('; ')}.`);
  return parts.join('\n').trim();
}

/**
 * Recompute every derived field. The single place a skill becomes consistent.
 *
 * The digest is always re-derived rather than trusted from the input. Keeping a
 * supplied one looked harmless, but the editor round-trips the whole skill on
 * save: rewriting the document left yesterday's digest attached to it, and the
 * digest is precisely what the model gets when context is tight — so the one
 * moment it mattered was the one moment it was wrong.
 */
export function hydrateSkill<T extends { body: string; digest?: string }>(skill: T): T & {
  sections: SkillSection[]; tokens: number; digest: string;
} {
  const sections = splitSections(skill.body);
  return {
    ...skill,
    sections,
    tokens: estimateTokens(skill.body),
    digest: deriveDigest(skill.body, sections),
  };
}

// ------------------------------------------------------------ selector tag

/**
 * The machine tag the model appends to a reply.
 *
 * Deliberately ugly and bracketed: it must never occur in roleplay prose, and
 * it must be strippable with certainty. Matched anywhere in the text (not just
 * at the end) because models like to explain themselves before complying.
 */
export const SKILL_TAG_OPEN = '[[SKILLS:';
const TAG_RE = /\[\[\s*SKILLS?\s*:([^\]\n]*)\]\]/gi;

export interface SkillTagResult {
  /** The reply with every tag removed. */
  text: string;
  /** Names/ids the model asked for, lowercased and trimmed. Empty = none. */
  names: string[];
  /** Whether a tag was present at all — absence is what triggers the scout. */
  found: boolean;
}

export function extractSkillTag(raw: string): SkillTagResult {
  const text = String(raw ?? '');
  let found = false;
  let names: string[] = [];

  for (const m of text.matchAll(TAG_RE)) {
    found = true;
    // Last tag wins: if the model corrects itself, believe the correction.
    names = splitList(m[1])
      .map((n) => n.replace(/^["'`]|["'`]$/g, '').trim().toLowerCase())
      .filter((n) => n && n !== 'none' && n !== 'null' && n !== 'n/a' && n !== '-');
  }

  const stripped = text
    .replace(TAG_RE, '')
    // A tag on its own line leaves a hole; close it rather than leave a gap.
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { text: stripped, names: [...new Set(names)], found };
}

/**
 * Streaming guard for the tag.
 *
 * The tag arrives token by token at the very end of a reply, and anything
 * already sent to the UI is on screen for good. So any tail that *could* still
 * become a tag is withheld until it either completes (and is dropped) or is
 * proven innocent by the next delta. The cost is that the last few characters
 * of a reply land one delta late; the alternative is `[[SKILLS:` flickering in
 * the middle of a love scene.
 */
export function createSkillTagFilter() {
  let held = '';
  let sawTag = false;

  /** Longest suffix of `s` that is a proper prefix of the tag opener. */
  const partialOpenLen = (s: string): number => {
    const upper = s.toUpperCase();
    const max = Math.min(upper.length, SKILL_TAG_OPEN.length - 1);
    for (let n = max; n > 0; n--) {
      if (SKILL_TAG_OPEN.startsWith(upper.slice(upper.length - n))) return n;
    }
    return 0;
  };

  /** Could this run still grow into a tag? (Completed tags are already gone.) */
  const stillForming = (s: string): boolean => {
    const upper = s.toUpperCase();
    return SKILL_TAG_OPEN.startsWith(upper) || upper.startsWith(SKILL_TAG_OPEN);
  };

  return {
    push(delta: string): string {
      held += delta ?? '';
      // Anything already complete is a decision, not text: drop it outright.
      const stripped = held.replace(TAG_RE, '');
      if (stripped !== held) sawTag = true;
      held = stripped;

      const cuts: number[] = [];
      const open = held.lastIndexOf('[[');
      if (open !== -1 && stillForming(held.slice(open))) cuts.push(open);
      const partial = partialOpenLen(held);
      if (partial > 0) cuts.push(held.length - partial);

      let cut = cuts.length ? Math.min(...cuts) : held.length;
      // Hold trailing whitespace back too. A tag arrives on its own line, so
      // releasing the newline before it leaves a blank gap at the end of every
      // reply — visible, permanent, and impossible to take back.
      while (cut > 0 && /\s/.test(held[cut - 1])) cut--;

      const emit = held.slice(0, cut);
      held = held.slice(cut);
      return emit;
    },
    /**
     * Whatever is still held once the stream ends, tag-free.
     *
     * Not trimmed: this is a continuation of a string the caller is still
     * assembling, and trimming here would eat a space the prose needed.
     */
    flush(): string {
      const hadTag = sawTag || new RegExp(TAG_RE.source, 'i').test(held);
      const out = held.replace(TAG_RE, '');
      held = '';
      sawTag = false;
      // Only when a tag was actually removed is the whitespace before it dead
      // space rather than the end of a sentence.
      return hadTag ? out.replace(/\s+$/, '') : out;
    },
  };
}

// ------------------------------------------------------------------ helpers

export function splitList(value: string): string[] {
  return String(value ?? '')
    .split(/[,\n;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Unwrap a document that arrived inside a code fence.
 *
 * Models asked for markdown often hand back ```markdown … ```, which puts a
 * fence line exactly where the front matter should be. The header then parses
 * as body text and the skill lands with no description — the one field routing
 * actually depends on. Only a fence wrapping the *whole* document is removed;
 * fenced examples inside a skill body are left alone.
 */
function stripCodeFence(text: string): string {
  const m = /^```[\w-]*[ \t]*\n([\s\S]*?)\n?```$/.exec(text.trim());
  return m ? m[1].trim() : text;
}

function oneLine(s: string, max: number): string {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}
