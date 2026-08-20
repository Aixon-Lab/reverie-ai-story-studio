/**
 * Agent prompt factories — small structured-output LLM calls.
 * See docs/agents.md for the design doctrine.
 */
import type { CharacterCard, ChatMessage, DirectorState, Persona, StyleProfile } from '../types';
import type { DirectorInjection } from './promptBuilder';
import { domainSchemaHints, type SettingKind } from './characterDomains';

function transcript(history: ChatMessage[], take: number): string {
  return history
    .filter((m) => !m.hiddenFromPrompt)
    .slice(-take)
    .map((m) => `${m.speaker.displayName}: ${m.text}`)
    .join('\n');
}

// ---------- Turn Director ----------

export interface TurnDirectorDecision {
  next: string; // character name | 'USER' | 'NARRATOR'
  reason: string;
  urgency: 'reply' | 'beat' | 'await_user';
  alternates: string[];
  new_character_needed?: { hint: string } | null;
}

export function turnDirectorPrompt(opts: {
  members: { card: CharacterCard; playedByUser: boolean; recentTurns: number }[];
  persona: Persona;
  history: ChatMessage[];
  narratorEnabled: boolean;
  genesisEnabled: boolean;
  director?: DirectorState;
  /** Character currently embodied by the human — NEVER pick them; use USER instead */
  playAsName?: string | null;
}): { system: string; user: string } {
  const roster = opts.members
    .map((m) => `- ${m.card.name}${m.playedByUser ? ' — PLAYED BY THE HUMAN (NEVER pick as next AI speaker — use USER)' : ' (AI)'}: ${firstSentence(m.card.description) || firstSentence(m.card.personality) || 'no summary'}`)
    .join('\n');
  const lastIsUser = (() => {
    const last = opts.history.at(-1);
    return !!last && (last.speaker.type === 'user' || last.controlledBy === 'human');
  })();
  const playAs = opts.playAsName?.trim();

  const system = [
    'You are the Turn Director of a group roleplay scene. Decide who should speak next based purely on narrative intelligence: who was addressed (explicitly or implicitly), whose emotional stake is highest, who would realistically interject, and what pacing the scene needs.',
    'A name being mentioned is a strong signal but NOT decisive — someone can be talked ABOUT without being talked TO.',
    opts.narratorEnabled ? 'You may pick NARRATOR for scene transitions, time passage, atmosphere, or consequences no character would voice.' : '',
    'You may pick USER when the scene naturally waits on the human (a question aimed at them, a decision only they can make, or after 2-3 AI turns when their input would keep them engaged).',
    playAs
      ? `CRITICAL: "${playAs}" is currently PLAYED BY THE HUMAN. Never set next to "${playAs}". If the scene waits on them, set next to USER. Only other AI-controlled characters may be chosen by name.`
      : '',
    lastIsUser
      ? 'The human just spoke. Usually a character should respond now, but if the message clearly addresses no one and a narration beat serves better, NARRATOR is allowed. Do not pick USER.'
      : 'The last speaker was not the human; consider whether the scene is waiting on them.',
    'Do not pick the previous speaker again unless they were directly addressed or dramatically compelled.',
    opts.genesisEnabled ? 'If the scene genuinely calls for a character who does not exist yet (someone knocks, a stranger arrives, a role must be filled), set new_character_needed with a short hint. Use this sparingly.' : '',
    'Respond with ONLY minified JSON: {"next":"<name|USER|NARRATOR>","reason":"<one sentence>","urgency":"reply|beat|await_user","alternates":["<name>"...]' + (opts.genesisEnabled ? ',"new_character_needed":{"hint":"..."}|null' : '') + '}',
  ].filter(Boolean).join('\n');

  const user = [
    `PARTICIPANTS:\n${roster}\n- ${opts.persona.name}: the human user (USER)${playAs ? ` — currently speaking in-world as ${playAs}` : ''}`,
    playAs ? `HUMAN CONTROLS: ${playAs} (pick USER when they should act; never pick ${playAs} as an AI speaker)` : '',
    opts.director?.sceneGoal?.status === 'active' ? `ACTIVE SCENE GOAL: ${opts.director.sceneGoal.text}` : '',
    `RECENT TRANSCRIPT:\n${transcript(opts.history, 20) || '(scene is just beginning)'}`,
    'Who speaks next?',
  ].filter(Boolean).join('\n\n');

  return { system, user };
}

/**
 * Read the director's pick, and honour only what this scene can actually do.
 *
 * The options the group has switched off are not options. `NARRATOR` used to be
 * accepted unconditionally, so a group with the narrator disabled could be told
 * the narrator speaks next — the client then found no speaker and ended the
 * turn in silence, which reads exactly like the scene dying on its own. Genesis
 * was the same: a model that volunteered `new_character_needed` on a group with
 * it turned off had that forwarded to the UI verbatim.
 */
export function parseTurnDecision(
  raw: string,
  validNames: string[],
  opts: { narratorEnabled?: boolean; genesisEnabled?: boolean } = {},
): TurnDirectorDecision | null {
  try {
    const obj = parseFirstJsonObject(raw);
    if (!obj) return null;
    const next = String(obj.next ?? '').trim();
    const valid = ['USER', ...(opts.narratorEnabled === false ? [] : ['NARRATOR']), ...validNames];
    const resolved = valid.find((v) => v.toLowerCase() === next.toLowerCase());
    if (!resolved) return null;
    // Alternates are shown to the user and must not name somebody who cannot speak.
    const alternates = Array.isArray(obj.alternates)
      ? obj.alternates
        .map(String)
        .filter((a: string) => validNames.some((v) => v.toLowerCase() === a.trim().toLowerCase()))
        .slice(0, 3)
      : [];
    return {
      next: resolved,
      reason: String(obj.reason ?? ''),
      urgency: ['reply', 'beat', 'await_user'].includes(obj.urgency) ? obj.urgency : 'reply',
      alternates,
      new_character_needed: opts.genesisEnabled !== false && obj.new_character_needed?.hint
        ? { hint: String(obj.new_character_needed.hint) }
        : null,
    };
  } catch {
    return null;
  }
}

/**
 * The first balanced `{…}` in a model response.
 *
 * A greedy `/\{[\s\S]*\}/` spans from the first brace to the *last* one, so a
 * reasoning model that thinks in one object and answers in another produced a
 * single unparseable blob and the whole decision was thrown away — every time.
 * Scanning for a balanced object finds the answer instead.
 */
function parseFirstJsonObject(raw: string): Record<string, any> | null {
  const text = String(raw ?? '');
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          // Keep looking: an earlier object may be the model's scratch work.
          if (parsed && typeof parsed === 'object' && 'next' in parsed) return parsed;
        } catch { /* not this one */ }
        break;
      }
    }
  }
  return null;
}

// ---------- Story Director (evolved triple lock) ----------

export function storyDirectorInjection(state: DirectorState | undefined, currentMessageIndex: number): DirectorInjection {
  const nudge = state?.nudge;
  const cutTo = state?.cutTo;
  const goal = state?.sceneGoal?.status === 'active' ? state.sceneGoal.text : undefined;
  if (!nudge?.text && !cutTo && !goal) return {};

  const intensity = nudge?.intensity ?? 3;
  const parts: DirectorInjection = {};

  const antiLeak = 'These are hidden stage directions. The characters have no awareness of them. Never mention direction, fate, destiny, "forces", instructions, or any meta concept. The development must emerge from believable in-world causes.';

  if (nudge?.text) {
    const blending =
      intensity <= 2 ? 'Let this surface subtly over the next few messages — a seed, not an event. If the current beat resists it, wait.'
      : intensity <= 4 ? 'Weave this into the scene within the next one or two messages through natural cause and effect.'
      : 'This happens NOW, in this very reply — but still through an in-world cause, never announced.';
    parts.sceneWeave = `[Stage direction: ${nudge.text}]\n${blending}\n${antiLeak}`;
    if (intensity >= 4) {
      parts.preAuthority = `A hidden story direction is in effect for this scene. It overrides the scene's inertia but must be realized invisibly, through the world and the characters' own motives. ${antiLeak}`;
      parts.closingMandate = `[Before finishing: confirm your reply advances the hidden stage direction ("${nudge.text}") through natural in-world events, without ever naming or hinting at any direction.]`;
    }
  }
  if (cutTo) {
    parts.sceneWeave = `${parts.sceneWeave ? parts.sceneWeave + '\n' : ''}[Scene cut: the story now moves to — ${cutTo}. Bridge the transition in one graceful beat.]`;
  }
  if (goal) {
    parts.sceneWeave = `${parts.sceneWeave ? parts.sceneWeave + '\n' : ''}[Standing scene goal: ${goal}. Nudge events toward it whenever natural.]`;
  }
  return parts;
}

// ---------- Narrator ----------

export function narratorCard(): CharacterCard {
  return {
    id: '__narrator__',
    name: 'Narrator',
    description: 'The omniscient narrator of this story. Not a character in the scene — the voice of the world itself.',
    personality: 'Evocative, economical, cinematic. Present tense. Third person. Shows rather than tells.',
    scenario: '',
    first_mes: '',
    mes_example: '',
    creator_notes: '',
    system_prompt: [
      'You are the NARRATOR — an omniscient story voice, NOT a character in the scene.',
      'Write vivid third-person present narration (2–6 sentences): atmosphere, time, place, sensory detail, consequences, soft camera moves.',
      'POV is always the narrator looking at the world — never first person as a cast member, never "I" unless quoting the world itself.',
      'NEVER write spoken dialogue for any character. NEVER open with a name prefix like "Name:" or "Narrator:".',
      'Do not take over {{user}} or the cast as if you control their will — describe the world around them.',
      'Prefer *italic action/narration* wrapping when format rules allow. Never leave the reply empty.',
    ].join(' '),
    post_history_instructions: '',
    alternate_greetings: [],
    tags: [],
    creator: 'Reverie',
    character_version: '1',
    extensions: {},
  };
}

/**
 * Build the final narrator instruction block.
 * Priority: composer seed → director → author's note (vibe) → free advance from recent theme.
 */
export function narratorBeatInstruction(opts: {
  composerSeed?: string;
  director?: DirectorState;
  authorsNote?: string;
  recentExcerpt?: string;
  castNames?: string[];
  /** Set only when the Narrator panel's rail drove this beat. */
  length?: DraftLength;
}): string {
  const cast = (opts.castNames ?? []).map((n) => n.trim()).filter(Boolean);
  const lines: string[] = [
    'NARRATOR BEAT — output ONLY the narration body from the Narrator\'s omniscient POV.',
    'Hard rules (non-negotiable):',
    '- Third person present. Cinematic prose. You are NOT a character.',
    '- Do NOT start with "Narrator:", any cast name, or "{{user}}:" — no speaker labels at all.',
    '- Do NOT write character dialogue in quotation marks. Do NOT write first-person "I/me/my" as a cast member.',
    '- Do NOT continue the chat as if you were the last speaker. Narrate the world; do not roleplay a person.',
    cast.length
      ? `- Forbidden speaker labels / first-person voices for: ${cast.join(', ')}.`
      : '',
    /**
     * The narrator card's own system prompt asks for "2–6 sentences". When the
     * rail is driving, it has to say so louder than that line does, or Brief and
     * Max both come back as the card's default paragraph.
     */
    opts.length ? narratorLengthClause(opts.length) : '',
    'Produce real prose (at least two full sentences). Empty output is not allowed.',
  ].filter(Boolean);

  const seed = opts.composerSeed?.trim();
  const nudge = opts.director?.nudge?.text?.trim();
  const cut = opts.director?.cutTo?.trim();
  const goal = opts.director?.sceneGoal?.text?.trim();
  const an = opts.authorsNote?.trim();

  if (seed) {
    lines.push(
      `PRIMARY STEER (from the human's composer — this is law for the beat, including swipe variants):\n"""${seed}"""`,
      [
        'You MUST narrate that intent from the Narrator POV.',
        'Elaborate and ground it in the scene (sensory detail, atmosphere, consequence) — never ignore it, never replace it with unrelated character banter.',
        'If the seed names events or mood, those events/moods land in the prose. Still no dialogue lines and no "Name:" prefixes.',
      ].join(' '),
    );
  }
  if (nudge) {
    lines.push(
      `STAGE DIRECTION (blend in; do not announce it as a stage direction): ${nudge}` +
        (opts.director?.nudge?.intensity
          ? ` [intensity ${opts.director.nudge.intensity}/5]`
          : ''),
    );
  }
  if (cut) {
    lines.push(`CUT TO / LOCATION SHIFT: ${cut}`);
  }
  if (goal) {
    lines.push(`STANDING SCENE GOAL (nudge the world toward it): ${goal}`);
  }
  if (an) {
    lines.push(
      `AUTHOR'S NOTE — highest-level vibe for tone, pacing, and theme:\n"""${an}"""`,
    );
  }
  if (!seed && !nudge && !cut && !goal) {
    lines.push(
      'No composer steer was given. Decide the beat from the chat so far, story context, summary, lore, and established tone: raise tension, settle dust, shift time/place, or reveal a world consequence.',
    );
  }
  if (opts.recentExcerpt?.trim()) {
    lines.push(`Recent context (do not copy or continue as dialogue):\n${opts.recentExcerpt.trim().slice(0, 1200)}`);
  }
  lines.push(
    'Output only narrator prose (optional *asterisk* wrapping). No dialogue. No name prefixes. No meta.',
  );
  return lines.join('\n\n');
}

/**
 * The narrator's half of the draft length rail.
 *
 * Worded like the Write Me and Impersonate LENGTH clauses on purpose — one
 * slider, one contract, so a beat asked for at Standard comes back the same
 * size whoever is speaking. The seeded caveat is the same too: reaching the
 * target by inventing extra events is how a scripted beat gets overwritten.
 */
function narratorLengthClause(length: DraftLength, scripted = false): string {
  const spec = DRAFT_LENGTH[length];
  return (
    `LENGTH (overrides any other sentence count above): ${spec.sentences} `
    + `(~${spec.targetWords} words, ${spec.label.toLowerCase()}). Write to that length — `
    + `do not stop short and do not run past it.`
    + (scripted
      ? ' Reach it by rendering what the steer already says in richer sensory detail — NEVER by adding events of your own.'
      : '')
  );
}

/** Final user-turn nudge so the seed and POV sit at the end of the prompt. */
export function narratorFinalUserNudge(opts: {
  composerSeed?: string;
  castNames?: string[];
  length?: DraftLength;
}): string {
  const seed = opts.composerSeed?.trim();
  const cast = (opts.castNames ?? []).map((n) => n.trim()).filter(Boolean);
  const forbid = cast.length
    ? ` Never write lines for: ${cast.join(', ')}.`
    : '';
  const len = opts.length ? narratorLengthClause(opts.length, !!seed) : '';
  if (seed) {
    return [
      'Write the next NARRATION beat only (third person, Narrator POV).',
      `Deliver this intent in prose — do not quote it raw, do not ignore it:\n"""${seed}"""`,
      len,
      `No "Name:" prefixes, no character dialogue, no first-person as cast.${forbid}`,
      'Output only the narration body.',
    ].filter(Boolean).join('\n');
  }
  return [
    'Write the next NARRATION beat only (third person, Narrator POV) from the scene so far.',
    len,
    `No "Name:" prefixes, no character dialogue, no first-person as cast.${forbid}`,
    'Output only the narration body.',
  ].filter(Boolean).join('\n');
}

// ---------- Image Director ----------

export function imageDirectorPrompt(opts: {
  purpose: 'avatar' | 'scene' | 'card_art';
  subjectCard?: CharacterCard;
  sceneExcerpt?: string;
  styleProfile?: StyleProfile;
}): { system: string; user: string } {
  const system = [
    'You are an expert image prompt engineer. Compose ONE image generation prompt of 60-120 words as flowing descriptive text (not keyword soup), covering in order: subject with concrete physical details, action/pose and expression, setting, composition and framing (portrait/bust/full body, lens feel), lighting, and finally the style anchor.',
    'The style anchor must EXACTLY follow the provided style profile so the image matches the group\'s existing art. Never contradict the character\'s canonical appearance.',
    'Respond with ONLY minified JSON: {"prompt":"...","negative":"...or empty string"}',
  ].join('\n');
  const user = [
    `PURPOSE: ${opts.purpose === 'avatar' ? 'character profile portrait (head and shoulders emphasis, character-defining)' : opts.purpose === 'scene' ? 'illustration of the current scene moment' : 'full character card art'}`,
    opts.subjectCard ? `CHARACTER:\n${opts.subjectCard.name}\n${opts.subjectCard.description.slice(0, 1200)}` : '',
    opts.sceneExcerpt ? `SCENE CONTEXT:\n${opts.sceneExcerpt.slice(0, 800)}` : '',
    opts.styleProfile
      ? `STYLE PROFILE (mandatory): medium=${opts.styleProfile.medium}; keywords=${opts.styleProfile.keywords.join(', ')}${opts.styleProfile.palette ? `; palette=${opts.styleProfile.palette}` : ''}`
      : 'STYLE PROFILE: none — choose a fitting style from the character\'s world and state it explicitly.',
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

// ---------- Style Analyst ----------

export function styleAnalystPrompt(memberNames: string[]): { system: string; user: string } {
  return {
    system:
      'You are a visual style analyst. You will receive character portrait images from a roleplay group. Identify the shared visual style so future images can match it. Respond with ONLY minified JSON: {"medium":"anime|photorealistic|digital painting|3d render|comic|watercolor|other","keywords":["4-8 rendering keywords"],"palette":"short palette description","confidence":0.0-1.0}',
    user: `These portraits belong to: ${memberNames.join(', ')}. Determine the group's common art style.`,
  };
}

/** Style analysis from local descriptions of the portraits, so the art never leaves the machine. */
export function styleAnalystFromDescriptionsPrompt(
  memberNames: string[],
  descriptions: string[],
): { system: string; user: string } {
  const v = styleAnalystPrompt(memberNames);
  return {
    system: `${v.system} You are reading written descriptions of the portraits rather than the images.`,
    user: [
      `These portraits belong to: ${memberNames.join(', ')}.`,
      ...descriptions.map((d, i) => `Portrait ${i + 1}: ${d.trim()}`),
      "Determine the group's common art style.",
    ].join('\n'),
  };
}

// ---------- Genesis ----------

/** Detect whether the latest beats require a character not yet on the roster. */
export function genesisNeedScanPrompt(opts: {
  history: ChatMessage[];
  existingNames: string[];
}): { system: string; user: string } {
  return {
    system: [
      'You scan a roleplay transcript for a NEW named or clearly distinct person who is about to enter, act, or be engaged — someone NOT already in the roster.',
      'Triggers: someone unseen arrives/enters, a named stranger is addressed as present, a role must be filled (bartender who speaks, guard who stops them), "I saw him walk in", etc.',
      'Do NOT invent people for mere mentions-in-passing about absent figures with no imminent appearance.',
      'Respond ONLY minified JSON: {"needed":true|false,"hint":"short reason + who they seem to be if needed, else empty string"}',
    ].join(' '),
    user: [
      `ROSTER (already exist — do not recreate): ${opts.existingNames.join(', ') || '(none)'}`,
      `RECENT TRANSCRIPT:\n${transcript(opts.history, 12) || '(empty)'}`,
      'Does the scene need a brand-new character right now?',
    ].join('\n\n'),
  };
}

export function genesisPrompt(opts: {
  hint: string;
  history: ChatMessage[];
  existingNames: string[];
  worldNotes?: string;
}): { system: string; user: string } {
  const system = [
    'You create a complete new roleplay character who is entering an ongoing scene. Ground every detail in the scene\'s established world, tone, and the reason the character is needed. The character must feel inevitable, not random.',
    'Age of any character must be 19+ (adult). Never create minors.',
    'Respond with ONLY minified JSON matching exactly:',
    '{"name":"...","description":"rich physical + background description, 120-250 words","personality":"traits, flaws, motivations, speech style, 60-120 words","scenario":"","first_mes":"their entrance: a first message that arrives IN the current scene naturally, with action and voice, 60-150 words","mes_example":"","tags":["3-6 tags"],"appearance_summary":"one dense sentence of visual traits for portrait generation: age band 19+, body, face, hair, eyes, clothes, vibe"}',
    `Do not reuse these existing names: ${opts.existingNames.join(', ')}.`,
  ].join('\n');
  const user = [
    `WHY THE SCENE NEEDS THEM: ${opts.hint}`,
    opts.worldNotes ? `WORLD NOTES:\n${opts.worldNotes}` : '',
    `CURRENT SCENE:\n${transcript(opts.history, 15)}`,
  ].filter(Boolean).join('\n\n');
  return { system, user };
}

// ---------- Summarizer ----------

export function summarizerPrompt(history: ChatMessage[], previousSummary?: string): { system: string; user: string } {
  return {
    system:
      'Maintain a compact running memory of a roleplay story. Update the summary with the new events. Keep: hard facts, relationship states, promises, injuries, secrets, open threads, current location/time. Drop style, keep substance. 250 words maximum. Respond with the summary text only.',
    user: [
      previousSummary ? `PREVIOUS SUMMARY:\n${previousSummary}` : '',
      `NEW MESSAGES:\n${transcript(history, 40)}`,
    ].filter(Boolean).join('\n\n'),
  };
}

// ---------- Drafts (Write Me / Impersonate) ----------

/**
 * How long a drafted message should be.
 *
 * Shared by Write Me and Impersonate: the two tools differ in *who* speaks, not
 * in how a length rail should behave, and a player who learns one slider has
 * learned both. Same 1–5 shape as the Author's Note slider so all three read as
 * one system: `label` is the tick caption, `targetWords` the number shown next
 * to it, `hint` the caption under the rail.
 */
export type DraftLength = 1 | 2 | 3 | 4 | 5;

export const DRAFT_LENGTH = {
  1: {
    label: 'Brief',
    hint: 'A quick beat — one or two lines',
    sentences: '1–2 sentences',
    minWords: 15,
    targetWords: 35,
    maxTokens: 220,
  },
  2: {
    label: 'Short',
    hint: 'A compact reply with a little action',
    sentences: '2–4 sentences',
    minWords: 35,
    targetWords: 70,
    maxTokens: 380,
  },
  3: {
    label: 'Standard',
    hint: 'A full reply — dialogue and action',
    sentences: '4–7 sentences',
    minWords: 70,
    targetWords: 130,
    maxTokens: 700,
  },
  4: {
    label: 'Detailed',
    hint: 'Longer beat with texture and interiority',
    sentences: '7–11 sentences',
    minWords: 130,
    targetWords: 220,
    maxTokens: 1100,
  },
  5: {
    label: 'Max',
    hint: 'A long, cinematic turn',
    sentences: '12–18 sentences',
    minWords: 220,
    targetWords: 360,
    maxTokens: 1800,
  },
} as const;

export const DEFAULT_DRAFT_LENGTH: DraftLength = 3;

export function clampDraftLength(value: unknown): DraftLength {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_DRAFT_LENGTH;
  return Math.min(5, Math.max(1, Math.round(n))) as DraftLength;
}

/**
 * The seed is script, not suggestion.
 *
 * A seeded draft is the user telling the model what is about to happen. Left to
 * "expand the intent", models treat it as a starting point and write the beat
 * *they* would have chosen — the player says "I take the gun and leave" and gets
 * back a draft where they hesitate, reconsider, and stay. That is not a length
 * problem or a POV problem; it is the model exercising judgement it was never
 * asked for. Everything below removes that judgement: the seed's events, order,
 * and outcomes are fixed, and the model's entire job is to render them at the
 * requested length.
 *
 * Identical for both tools. Whether the speaker is the player (Write Me) or a
 * character (Impersonate) changes who the sentences are about, not who decides
 * what happens — and a character's own personality is explicitly *not* grounds
 * to overrule the script, since "she wouldn't do that" is the single most
 * common way an impersonation quietly rewrites the user's instruction.
 */
export function seedScriptContract(opts: {
  seed: string;
  /** Whose message this is — the player's persona, or the character's name. */
  speakerName: string;
  /** Everyone this draft must not speak for. */
  otherNames: string[];
  /** First person for Write Me; a character speaking as themselves for Impersonate. */
  kind: 'user' | 'character';
}): string {
  const { seed, speakerName, kind } = opts;
  const other = opts.otherNames[0];
  const owner = kind === 'user' ? "THE PLAYER'S SCRIPT" : `THE PLAYER'S SCRIPT FOR ${speakerName.toUpperCase()}`;
  const restate = kind === 'user'
    ? `("I decide to…", "I plan on…")`
    : `("${speakerName} considers…", "she is about to…")`;
  return [
    `${owner} FOR THIS MESSAGE — THIS IS CANON, NOT A SUGGESTION:`,
    `"""${seed.trim()}"""`,
    '',
    `Your job is to RENDER this, not to decide what happens. ${speakerName} does exactly what the script says, in the order it says, with the outcome it says.`,
    `MANDATORY: every action, statement, decision, and target named in the script must appear in your output, unchanged in meaning and in the same order.`,
    `FORBIDDEN — these are the ways models break this, and each one makes the draft wrong:`,
    `- Do NOT add a decision, action, or line of dialogue that is not in the script.`,
    `- Do NOT reverse, soften, delay, qualify, or add second thoughts to anything in it. No "but I hesitate", no "then I reconsider", no asking permission that the script did not ask for.`,
    `- Do NOT change who or what is targeted, where it happens, or how it ends.`,
    kind === 'character'
      ? `- Do NOT overrule the script with characterisation. "${speakerName} wouldn't do that", "that's out of character", "she would hesitate first" are NOT reasons to change it. The script defines what ${speakerName} does here; the card only defines how it looks and sounds when they do it.`
      : `- Do NOT substitute a "better", safer, more in-character, or more dramatic choice.`,
    `- If the script contradicts the scene, the mood, established personality, or what ${other ?? 'anyone else'} would expect — the script still wins.`,
    `- Do NOT continue past the script's last beat, resolve it, or narrate its consequences.`,
    `- Do NOT summarize or restate it as intention ${restate}. It HAPPENS.`,
    `ALLOWED — this is the entire freedom you have, and it is where the length comes from: sensory detail, body language, tone of voice, ${speakerName}'s interiority, physical description of the surroundings, and the exact wording of dialogue the script says is spoken. All of it must serve what the script already says.`,
    `Use the chat history only for continuity of place, names, and tone — never to override or "correct" the script.`,
    `Write it out in full prose at the required length. Do not return the script's own words alone.`,
  ].join('\n');
}

const DRAFT_SEED_STOPWORDS = new Set([
  'the', 'and', 'but', 'for', 'with', 'that', 'this', 'from', 'into', 'onto', 'then', 'than',
  'have', 'has', 'had', 'was', 'were', 'are', 'been', 'being', 'will', 'would', 'should',
  'could', 'can', 'not', 'you', 'your', 'him', 'her', 'his', 'hers', 'they', 'them', 'their',
  'she', 'him', 'its', 'our', 'out', 'off', 'all', 'any', 'get', 'got', 'just', 'about',
  'over', 'when', 'what', 'who', 'how', 'why', 'where', 'there', 'here', 'some', 'very',
  'like', 'want', 'wants', 'wanted', 'say', 'says', 'said', 'tell', 'tells', 'told',
]);

/** Distinctive words from the seed — what the draft has to actually contain. */
export function draftSeedWords(seed: string): string[] {
  const words = (seed.toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? [])
    .filter((w) => !DRAFT_SEED_STOPWORDS.has(w));
  return [...new Set(words)];
}

/**
 * How much of the seed survived into the draft.
 *
 * Deliberately crude — a prefix match on the first five characters, so "flies"
 * covers "fly" and "running" covers "run". It cannot tell a faithful rewording
 * from a rewrite, and it is not asked to: it only has to notice when most of
 * what the player wrote is simply *gone*, which is what a model substituting
 * its own beat looks like.
 */
export function draftSeedCoverage(seed: string, draft: string): {
  words: string[];
  missing: string[];
  coverage: number;
} {
  const words = draftSeedWords(seed);
  if (!words.length) return { words, missing: [], coverage: 1 };
  const hay = draft.toLowerCase();
  const missing = words.filter((w) => {
    const stem = w.slice(0, Math.min(5, w.length));
    return !hay.includes(stem);
  });
  return { words, missing, coverage: (words.length - missing.length) / words.length };
}

/**
 * True when the draft looks like a different beat than the one the player wrote.
 *
 * Thresholds are conservative on purpose: short seeds ("i fly") legitimately
 * survive as pure paraphrase, so only a substantive seed is checked, and only a
 * majority loss counts. A false negative costs nothing; a false positive costs
 * the user an extra model call.
 */
export function draftNeedsFidelityRetry(seed: string, draft: string): boolean {
  const s = seed.trim();
  const d = draft.trim();
  if (!s || !d) return false;
  const { words, coverage } = draftSeedCoverage(s, d);
  if (words.length < 4) return false;
  return coverage < 0.45;
}

/** Second pass when the first draft wandered off the player's script. */
export function draftFidelityRetryPrompt(opts: {
  seed: string;
  missing: string[];
  speakerName: string;
  kind: 'user' | 'character';
}): string {
  const missing = opts.missing.slice(0, 12).join(', ');
  return [
    `Your previous draft did not follow the player's script. It was discarded.`,
    `SCRIPT (canon — every part of it must happen, in this order):`,
    `"""${opts.seed.trim()}"""`,
    missing ? `Your draft dropped or replaced: ${missing}.` : '',
    opts.kind === 'user'
      ? `Rewrite it as ${opts.speakerName}'s message in first person. Keep every action, statement, and outcome from the script exactly as written.`
      : `Rewrite it as ${opts.speakerName}'s message in first person. Keep every action, statement, and outcome from the script exactly as written — ${opts.speakerName}'s personality governs how it looks and sounds, never whether it happens.`,
    `Add only sensory detail, body language, interiority, and dialogue wording that support it. Invent no new decisions, no hesitation, no reversal, no consequences beyond the script's last beat.`,
    `Output the message body only.`,
  ].filter(Boolean).join('\n');
}

/** How long and specific an Author's Note expansion should be. */
export type AuthorsNoteRichness = 1 | 2 | 3 | 4 | 5;

export const AUTHORS_NOTE_RICHNESS = {
  1: {
    label: 'Brief',
    hint: 'A tight steer — a few pointed sentences',
    minWords: 90,
    targetWords: 130,
    maxTokens: 600,
    descChars: 500,
    persChars: 250,
    scenChars: 220,
    notesChars: 0,
    historyTake: 16,
    messageChars: 240,
    summaryChars: 500,
  },
  2: {
    label: 'Standard',
    hint: 'Scene-aware note, a short cluster of directives',
    minWords: 200,
    targetWords: 280,
    maxTokens: 1000,
    descChars: 800,
    persChars: 400,
    scenChars: 350,
    notesChars: 250,
    historyTake: 24,
    messageChars: 320,
    summaryChars: 800,
  },
  3: {
    label: 'Detailed',
    hint: 'Cast, stakes, and how to play the next beats',
    minWords: 380,
    targetWords: 500,
    maxTokens: 1700,
    descChars: 1300,
    persChars: 650,
    scenChars: 550,
    notesChars: 450,
    historyTake: 36,
    messageChars: 420,
    summaryChars: 1200,
  },
  4: {
    label: 'Rich',
    hint: 'Long, specific guidance grounded in the transcript',
    minWords: 600,
    targetWords: 780,
    maxTokens: 2600,
    descChars: 2200,
    persChars: 1000,
    scenChars: 850,
    notesChars: 750,
    historyTake: 50,
    messageChars: 520,
    summaryChars: 1800,
  },
  5: {
    label: 'Max',
    hint: 'Exhaustive scene bible — as long as it stays useful',
    minWords: 900,
    targetWords: 1200,
    maxTokens: 4000,
    descChars: 3500,
    persChars: 1600,
    scenChars: 1300,
    notesChars: 1100,
    historyTake: 64,
    messageChars: 640,
    summaryChars: 2500,
  },
} as const;

export const DEFAULT_AUTHORS_NOTE_RICHNESS: AuthorsNoteRichness = 4;

export function clampAuthorsNoteRichness(value: unknown): AuthorsNoteRichness {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_AUTHORS_NOTE_RICHNESS;
  return Math.min(5, Math.max(1, Math.round(n))) as AuthorsNoteRichness;
}

export function authorsNoteWordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * True when the draft is shorter than the seed, or well under the slider target.
 * Used to trigger one expand-again pass so the slider is not a suggestion.
 */
export function authorsNoteNeedsRetry(
  draft: string,
  seed: string,
  richness: AuthorsNoteRichness,
): boolean {
  const spec = AUTHORS_NOTE_RICHNESS[richness];
  const words = authorsNoteWordCount(draft);
  if (words < 12) return true;
  const seedWords = authorsNoteWordCount(seed);
  // Slider is the length authority. Only refuse a shorter-than-seed draft when
  // the seed itself is below this richness floor (i.e. we asked the model to grow it).
  if (seedWords >= 12 && seedWords < spec.minWords && words <= seedWords) return true;
  return words < Math.round(spec.minWords * 0.7);
}

/**
 * The note is guidance, not a report on its own construction.
 *
 * Left unsaid, models narrate their inputs — "as the seed indicates", "per the
 * user's brief" — which reads as machinery inside a block that is supposed to
 * sound like a story editor's standing instructions. The content still comes
 * from the seed; only the pointing at it is banned.
 */
const AUTHORS_NOTE_NO_META_RULES = [
  'NEVER refer to your own inputs. Do not mention or allude to "the seed", "the prompt", "the brief", "the instruction", "the request", "the user\'s note", "the summary", "the transcript", "the card", or "the context" — no phrases like "as the seed mentions", "based on the provided material", "per the instructions", "the user wants".',
  'Absorb the seed and state its content directly as scene guidance. If the seed says "she is hiding a knife", write "Nadia keeps the knife hidden…" — never "the seed says she hides a knife".',
  'The finished note must read as standing editorial direction for the story, with no trace that it was generated from anything.',
];

/**
 * Matched against the finished note, so these have to be constructions rather
 * than bare nouns: a story may legitimately contain a seed vault or a prompt to
 * speak, and only "as the seed mentions" is the failure being caught.
 */
const META_NOUN = 'seed|prompt|brief|instruction|instructions|request|input|context|transcript|summary|character cards?|note';
const META_VERB =
  'says?|said|mentions?|mentioned|states?|stated|indicates?|indicated|notes?|noted|specifies|specified|asks?|asked|wants?|wanted|requires?|required|calls for|called for|suggests?|suggested|describes?|described|establishes?|established|implies|implied|provides?|provided|tells us|told us';

const AUTHORS_NOTE_META_PATTERNS: RegExp[] = [
  new RegExp(`\\b(?:as|per|according to|based on|following)\\s+(?:the|this|your|our|their|user'?s?|human'?s?|provided|given|original)?\\s*(?:${META_NOUN})\\b`, 'i'),
  new RegExp(`\\b(?:the|this|that|your|user'?s?|human'?s?|provided|given|original)\\s+(?:${META_NOUN})\\s+(?:${META_VERB})\\b`, 'i'),
  /\bbased on (?:the )?(?:provided|given|above|foregoing)\b/i,
  /\bthe (?:user|human|player|writer) (?:wants|wanted|asked|asks|requested|requests|specified|specifies|indicated|indicates)\b/i,
  /\b(?:as|per) (?:requested|instructed|specified|described above|outlined above|provided)\b/i,
];

/** True when the draft points at its own inputs instead of just using them. */
export function authorsNoteMetaLeak(text: string): boolean {
  return AUTHORS_NOTE_META_PATTERNS.some((re) => re.test(text));
}

/**
 * Last-resort scrub: drop the sentences that name the inputs, keep the rest.
 * Refuses if that would gut the note — a short clean note is worse than a long
 * one with one clumsy sentence, and the caller has already tried a rewrite.
 */
export function stripAuthorsNoteMeta(text: string): string {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept = sentences.filter((s) => !authorsNoteMetaLeak(s));
  const out = kept.join(' ').replace(/\s{2,}/g, ' ').trim();
  if (!out) return text;
  if (authorsNoteWordCount(out) < authorsNoteWordCount(text) * 0.6) return text;
  return out;
}

/** Rewrite pass for a draft that narrated its own inputs. */
export function authorsNoteDemetaPrompt(opts: {
  draft: string;
  richness?: AuthorsNoteRichness | number;
}): { system: string; user: string } {
  const richness = clampAuthorsNoteRichness(opts.richness);
  const spec = AUTHORS_NOTE_RICHNESS[richness];
  return {
    system: [
      "You rewrite an Author's Note so it stops describing where its content came from.",
      'Keep every directive, name, and concrete detail. Change only the framing.',
      ...AUTHORS_NOTE_NO_META_RULES,
      `Keep the length: at least ${spec.minWords} words. Output the rewritten note only — no commentary.`,
    ].join(' '),
    user: `NOTE TO REWRITE:\n"""${opts.draft.trim()}"""\n\nRewrite it as direct story guidance with no reference to any seed, prompt, instruction, summary, card, or user request.`,
  };
}

export type AuthorsNoteCastSlice = {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  creator_notes?: string;
};

function sliceField(value: string | undefined, cap: number): string {
  const t = (value ?? '').trim();
  if (!t || cap <= 0) return '';
  return t.length > cap ? `${t.slice(0, cap)}…` : t;
}

function transcriptForNote(history: ChatMessage[], take: number, eachCap: number): string {
  return history
    .filter((m) => !m.hiddenFromPrompt)
    .slice(-take)
    .map((m) => {
      const t = (m.text ?? '').trim();
      const cut = t.length > eachCap ? `${t.slice(0, eachCap)}…` : t;
      return `${m.speaker.displayName}: ${cut}`;
    })
    .join('\n');
}

function formatDirectorForNote(director?: DirectorState): string {
  if (!director) return '';
  const lines: string[] = [];
  const nudge = director.nudge?.text?.trim();
  if (nudge) {
    lines.push(
      `Stage direction: ${nudge}` +
        (director.nudge?.intensity ? ` [intensity ${director.nudge.intensity}/5]` : ''),
    );
  }
  const goal = director.sceneGoal?.text?.trim();
  if (goal && director.sceneGoal?.status !== 'done') {
    lines.push(`Standing scene goal: ${goal}`);
  }
  const cut = director.cutTo?.trim();
  if (cut) lines.push(`Cut to: ${cut}`);
  const prefer = director.prefer;
  if (prefer) lines.push(`Dramatic bias: ${prefer}`);
  return lines.join('\n');
}

/**
 * Expand a human seed into a full Author's Note for the scene.
 * Uses the seed, cast cards, running summary, director, and recent transcript.
 * `richness` is the slider: it sets length, descriptiveness, and how much context is sent.
 */
export function authorsNoteExpandPrompt(opts: {
  seed: string;
  existingNote?: string;
  cast: AuthorsNoteCastSlice[];
  personaName?: string;
  personaDescription?: string;
  history: ChatMessage[];
  isGroup: boolean;
  richness?: AuthorsNoteRichness | number;
  summary?: string;
  scenarioOverride?: string;
  director?: DirectorState;
}): { system: string; user: string } {
  const richness = clampAuthorsNoteRichness(opts.richness);
  const spec = AUTHORS_NOTE_RICHNESS[richness];
  const seed = opts.seed.trim();
  const seedWords = authorsNoteWordCount(seed);

  const castBlock = opts.cast
    .map((c) => {
      const bits = [
        sliceField(c.description, spec.descChars) && `Description: ${sliceField(c.description, spec.descChars)}`,
        sliceField(c.personality, spec.persChars) && `Personality: ${sliceField(c.personality, spec.persChars)}`,
        sliceField(c.scenario, spec.scenChars) && `Scenario: ${sliceField(c.scenario, spec.scenChars)}`,
        sliceField(c.creator_notes, spec.notesChars) && `Creator notes: ${sliceField(c.creator_notes, spec.notesChars)}`,
      ].filter(Boolean);
      return `### ${c.name}\n${bits.join('\n') || '(no card text)'}`;
    })
    .join('\n\n');

  const mustOutgrowSeed = seedWords >= 8 && seedWords < spec.minWords;
  const lengthRules = [
    `Length contract (non-negotiable): write AT LEAST ${spec.minWords} words. Aim for about ${spec.targetWords} words (${spec.label.toLowerCase()} density).`,
    'Count words in the finished note. Do not stop early. Honour the slider density — Brief stays tight, Max stays exhaustive.',
    mustOutgrowSeed
      ? `The finished note MUST be longer than the human seed (${seedWords} words). Do not return a shorter paraphrase.`
      : seedWords >= 8
        ? `The human seed is ${seedWords} words. Keep its intent and make it ${spec.label.toLowerCase()} — add scene-specific directives from the cards and story rather than shrinking it into generic advice.`
        : 'The finished note must be a real block of guidance, not a one-liner.',
    richness >= 4
      ? 'Be lush and specific: name people, places, objects, tensions, and the next few beats. Quote or echo concrete details from the transcript and cards. Cover tone, pacing, secrets, what to lean into, what to avoid, and how the seed should land in-scene.'
      : richness >= 3
        ? 'Be concrete: who is present, what just happened, what the seed wants next, and how each relevant character should play. Include tone, stakes, and open threads.'
        : 'Stay tight but still scene-specific. Every sentence must refer to this cast or this story — no generic roleplay advice.',
  ];

  return {
    system: [
      "You write Author's Notes for roleplay chats. The note is injected into the model as OOC guidance (tone, stakes, secrets, pacing, continuity, what happens next) — not spoken dialogue and not a story chapter.",
      ...lengthRules,
      'Ground every sentence in the provided context: the human seed (primary intent), the character cards, the running story summary, the director (if any), and the recent transcript. Invent nothing that contradicts those sources. If the scene is just starting, lean on the cards and seed.',
      ...AUTHORS_NOTE_NO_META_RULES,
      'Write as directives to the model (present tense or imperative). Use the characters\' names. Do not wrap in quotes. Do not prefix with "Author\'s Note:". No markdown headings unless essential. Output the note text only.',
      opts.isGroup
        ? 'This is a GROUP scene — address multiple characters and how they should interact when relevant.'
        : 'This is a solo scene — focus on the active character and the human user.',
    ].join(' '),
    user: [
      opts.personaName
        ? `USER PERSONA: ${opts.personaName}${
            sliceField(opts.personaDescription, Math.min(600, spec.descChars))
              ? `\n${sliceField(opts.personaDescription, Math.min(600, spec.descChars))}`
              : ''
          }`
        : '',
      `CAST (${opts.isGroup ? 'group' : 'solo'}):\n${castBlock || '(none)'}`,
      opts.scenarioOverride?.trim()
        ? `CHAT SCENARIO OVERRIDE:\n${opts.scenarioOverride.trim().slice(0, spec.scenChars)}`
        : '',
      formatDirectorForNote(opts.director)
        ? `STORY DIRECTOR (active steer):\n${formatDirectorForNote(opts.director)}`
        : '',
      sliceField(opts.summary, spec.summaryChars)
        ? `STORY SO FAR (running summary — treat as canon for earlier events):\n${sliceField(opts.summary, spec.summaryChars)}`
        : '',
      opts.existingNote?.trim() && opts.existingNote.trim() !== seed
        ? `CURRENT AUTHOR'S NOTE (may revise or replace):\n${opts.existingNote.trim()}`
        : '',
      `RECENT TRANSCRIPT (what is happening now):\n${
        transcriptForNote(opts.history, spec.historyTake, spec.messageChars) || '(scene just starting — use cards, seed, and summary)'
      }`,
      `HUMAN SEED / INTENT (this is the assignment — expand it, do not shrink it):\n"""${
        seed || "Write a useful author's note for the current scene based on cast, summary, and transcript."
      }"""`,
      `Write the full Author's Note now. Minimum ${spec.minWords} words, target ~${spec.targetWords}. Output the note text only.`,
    ].filter(Boolean).join('\n\n'),
  };
}

/** Second pass when the first draft ignored the length contract. */
export function authorsNoteExpandRetryPrompt(opts: {
  seed: string;
  draft: string;
  richness?: AuthorsNoteRichness | number;
}): { system: string; user: string } {
  const richness = clampAuthorsNoteRichness(opts.richness);
  const spec = AUTHORS_NOTE_RICHNESS[richness];
  const draftWords = authorsNoteWordCount(opts.draft);
  const seedWords = authorsNoteWordCount(opts.seed);
  const mustOutgrowSeed = seedWords >= 8 && seedWords < spec.minWords;
  return {
    system: [
      "You expand an Author's Note that came out too short. Keep every usable directive from the draft. Add scene-specific detail until the length contract is met.",
      `Write AT LEAST ${spec.minWords} words (target ~${spec.targetWords}).`,
      mustOutgrowSeed
        ? `The result MUST be longer than the human seed (${seedWords} words).`
        : '',
      'Stay in OOC directive voice. Do not turn this into a story chapter. Output the full replacement note only — not a delta, not commentary.',
      ...AUTHORS_NOTE_NO_META_RULES,
    ].filter(Boolean).join(' '),
    user: [
      `HUMAN SEED:\n"""${opts.seed.trim() || '(none)'}"""`,
      `TOO-SHORT DRAFT (${draftWords} words):\n"""${opts.draft.trim()}"""`,
      `Rewrite the full Author's Note. Minimum ${spec.minWords} words. Keep the draft's intent, then add concrete guidance about the cast, current situation, tone, secrets, pacing, and how the seed should land.`,
    ].join('\n\n'),
  };
}

/**
 * Proofreader — fix the writing, never author it.
 *
 * The distinction this prompt exists to hold: the user has already decided what
 * their character does. Spelling, grammar, punctuation and a half-finished
 * clause are mechanical failures of typing, and those may be repaired. Anything
 * that adds an action, a line of dialogue, a gesture or a feeling the user did
 * not put there is the model taking their turn away from them — which is what
 * Write Me and Impersonate are for, and what this must never do.
 *
 * The scene is supplied only as an aid to disambiguation (names, spellings, who
 * is present, which "her" is which), explicitly not as material to continue.
 */
export function proofreadPrompt(opts: {
  text: string;
  personaName?: string;
  cast: string[];
  history: ChatMessage[];
}): { system: string; user: string } {
  return {
    system: [
      'You are a proofreader for a roleplay message. You repair the writing. You do NOT write the message.',
      '',
      'DO:',
      '- Fix spelling, typos, capitalization, punctuation, verb tense and agreement, word order, and obvious wrong-word slips ("their/there", "you\'re/your", "loose/lose").',
      '- Correct the spelling of names to match the cast list.',
      '- Complete a sentence the writer clearly left unfinished, using the fewest words that close the thought they had already started. If the intent is genuinely unclear, punctuate what is there and stop.',
      '- Keep the roleplay markup exactly as it is used: "quoted dialogue" stays quoted, *asterisk action* stays asterisked. Fix a missing closing quote or asterisk.',
      '- Preserve the writer\'s voice, register, slang, profanity, pet names, sentence rhythm and paragraph breaks. A blunt line stays blunt. A crude line stays crude.',
      '',
      'DO NOT:',
      '- Add any action, dialogue, gesture, sensation, thought or detail the writer did not already put in the text.',
      '- Continue the scene, answer the other character, or write past the end of what they wrote.',
      '- Improve the prose: no upgraded vocabulary, no added imagery, no restructuring for flow, no expanding a short line into a long one.',
      '- Soften, censor, moralise, or make the tone politer, safer or more literary.',
      '- Reply to the text, comment on it, explain your changes, or add quotes around the whole thing.',
      '',
      'Output ONLY the corrected message, ready to send. If it is already correct, output it back unchanged.',
    ].join('\n'),
    user: [
      opts.personaName ? `THE WRITER IS PLAYING: ${opts.personaName}` : '',
      opts.cast.length ? `NAMES THAT MAY APPEAR (use these spellings): ${opts.cast.join(', ')}` : '',
      // Context for disambiguation only — the guard against "continue the scene"
      // has to sit right next to the transcript, where the temptation is.
      opts.history.length
        ? `SCENE SO FAR — for resolving pronouns and spellings ONLY. Do not continue it, do not reply to it:\n${transcript(opts.history, 6)}`
        : '',
      `MESSAGE TO PROOFREAD:\n"""\n${opts.text}\n"""`,
      'Output the corrected message only.',
    ].filter(Boolean).join('\n\n'),
  };
}

function firstSentence(text: string): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  const end = clean.search(/[.!?]\s/);
  return (end > 10 ? clean.slice(0, end + 1) : clean.slice(0, 140)).trim();
}

/**
 * Full character card + domain pack from a human gist (optional physical lock from vision).
 *
 * `existingPartial` is the editor's *current* content, not a record of the last
 * generation. Re-running AI Fill after editing the description has to follow the
 * edit, so the prompt states plainly that this block outranks the gist — without
 * that, the model reproduced its previous answer and the button looked inert.
 */
export function characterGistGeneratePrompt(opts: {
  gist: string;
  setting: SettingKind;
  nameHint?: string;
  physicalLock?: unknown;
  existingPartial?: Record<string, unknown>;
}): { system: string; user: string } {
  const hasDraft = !!opts.existingPartial && Object.keys(opts.existingPartial).length > 0;
  return {
    system: [
      'You are a character-card factory for roleplay (SillyTavern-compatible).',
      'Age MUST be an integer >= 19. Never invent underage characters.',
      'Respond with a single valid JSON object only. No markdown fences, no prose outside JSON.',
      'Escape all quotes and newlines inside string values (\\n, \\"). Prefer short pack array items (2–6 words).',
      'Keep description/personality/first_mes under ~600 chars each so the JSON stays complete.',
      'Do NOT write a scenario — meeting context comes from the chat Author\'s Note, not the card.',
      domainSchemaHints(opts.setting),
      hasDraft
        ? 'The user is REGENERATING an existing draft. CURRENT_CARD is their latest wording and outranks GIST wherever the two disagree — rebuild every field to agree with it. Do not echo CURRENT_CARD back verbatim: expand, sharpen and complete it, and revise pack details (including physical ones) that its new wording contradicts.'
        : '',
      opts.physicalLock
        ? 'PHYSICAL LOCK: pack.physical came from analysing the actual portrait — keep it accurate; refine wording only if needed; do not contradict measurements or colors.'
        : 'Invent clear physical detail consistent with the brief (complete pack.physical).',
    ].filter(Boolean).join(' '),
    user: [
      `SETTING: ${opts.setting}`,
      opts.nameHint ? `NAME HINT: ${opts.nameHint}` : '',
      `GIST:\n"""${opts.gist.trim()}"""`,
      opts.physicalLock ? `PHYSICAL_JSON:\n${JSON.stringify(opts.physicalLock)}` : '',
      hasDraft
        ? `CURRENT_CARD — the user's live editor content, authoritative over GIST:\n${JSON.stringify(opts.existingPartial).slice(0, 4000)}`
        : '',
      'Return one complete JSON object now.',
    ].filter(Boolean).join('\n\n'),
  };
}

/** Vision: extract every visible physical trait into pack.physical JSON only. */
export function characterVisionPhysicalPrompt(): { system: string; user: string } {
  return {
    system: [
      'You are a forensic visual character analyst for adult roleplay cards.',
      'The subject is always treated as age 19 or older (estimate adult age only, never under 19).',
      'Describe ONLY what is visually supportable or a careful best-estimate from the image.',
      'Respond with a single valid JSON object only (no markdown). Either the physical object itself or {"physical":{...}}.',
      'Required keys on the physical object:',
      'age,sex,genderPresentation,ethnicityAncestry,heightCm,weightKg,bodyType,build,measurements{bustCm,waistCm,hipsCm,chestCm,shouldersCm,cupSize,notes},skin{tone,undertone,marks,texture},face{shape,jaw,cheekbones,nose,lips,freckles,makeup},eyes{color,shape,lashes,brows},hair{color,length,texture,style,highlights},handsFeet,postureGait,voice{pitch,accent,timbre},scent,distinguishingMarks[],clothingDefault,visualKeywords[]',
      'Be specific on visible traits: hair, eyes, skin, face, body type, clothing, jewelry, marks.',
      'Estimate heightCm/weightKg/measurements as realistic adults. cupSize only if applicable.',
      'visualKeywords: 8-16 short tags. Escape quotes in strings. Keep values compact so JSON is complete.',
    ].join(' '),
    user: 'Analyze the attached portrait image. Return complete physical JSON only.',
  };
}

/**
 * Same output contract as the vision prompt, but reading a written description
 * instead of pixels.
 *
 * This is what lets image understanding stay on the user's machine: a small
 * local model looks at the portrait and writes what it sees, and only that text
 * travels. Small models describe far better than they emit schemas, so the
 * structuring is left to the text model that is already configured.
 */
export function physicalFromDescriptionPrompt(description: string): { system: string; user: string } {
  const v = characterVisionPhysicalPrompt();
  return {
    system: [
      v.system,
      'You are working from a written description of the portrait, not the image itself.',
      'Where the description is silent, infer a plausible, internally consistent adult value rather than leaving blanks.',
      'Do not contradict anything the description states explicitly.',
    ].join(' '),
    user: `Portrait description:\n"""\n${description.trim()}\n"""\n\nReturn complete physical JSON only.`,
  };
}
