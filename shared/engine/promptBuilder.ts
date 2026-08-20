/**
 * PromptPlan builder — assembles the chat-completion messages array from
 * preset (prompts + prompt_order), character(s), persona, world info, history,
 * group identity locks, and director injections. ST-semantics compatible,
 * fully itemized for the prompt inspector.
 */
import type {
  BuiltMessage, CharacterCard, ChatMessage, ContextPreset, DirectorState, InstructPreset,
  MessageStyleSettings, Persona, Preset, PromptItem, PromptPlan, ReasoningPreset, SyspromptPreset, WIEntry,
} from '../types';
import { buildMessageStylePrompt, buildMessageStyleTailReminder } from './messageStyle';
import { substituteMacros, type MacroEnv } from './macros';
import { scanWorldInfo, type WIScanResult } from './worldinfo';
import { estimateTokens } from './tokens';
import {
  narratorBeatInstruction, narratorFinalUserNudge,
  clampDraftLength, DRAFT_LENGTH, seedScriptContract, type DraftLength,
} from './agents';
import { DEFAULT_WRITING_CONTRACT } from '../codec/preset';
import { isJunkFormatPrompt, sanitizeAiOutput } from './sanitizeOutput';

/** Message-style block for narrator turns — third person, no character voice. */
export function buildNarratorStylePrompt(): string {
  return [
    'FORMAT (NARRATOR ONLY — override any first-person character format above):',
    '- Write omniscient third-person present narration (the camera / world voice).',
    '- Prefer *italic action/narration* wrappers for prose, e.g. *Rain needles the glass.*',
    '- Do NOT write spoken dialogue in quotation marks.',
    '- Do NOT write first person as a character (no I / me / my for cast members).',
    '- Do NOT prefix the reply with "Narrator:", a character name, or "{{user}}:".',
    '- Output only the narration body. No meta, OOC, counters, or stage headers.',
  ].join('\n');
}

export interface GroupContext {
  memberCards: CharacterCard[];
  /** name of character the human currently plays, if any */
  playAsName?: string | null;
  narratorEnabled?: boolean;
}

export interface DirectorInjection {
  preAuthority?: string;
  sceneWeave?: string;
  closingMandate?: string;
}

export interface FormattingStack {
  instruct?: InstructPreset | null;
  context?: ContextPreset | null;
  sysprompt?: SyspromptPreset | null;
  reasoning?: ReasoningPreset | null;
}

export interface BuildInput {
  preset: Preset;
  card: CharacterCard; // active speaker card (in groups: the drafted character; for narrator: narrator card)
  persona: Persona;
  history: ChatMessage[];
  wiEntries: WIEntry[]; // merged global + character book entries
  group?: GroupContext;
  director?: DirectorInjection;
  authorsNote?: { text: string; depth: number; role: 'system' | 'user' | 'assistant' };
  scenarioOverride?: string;
  summary?: string;
  variables?: Record<string, string>;
  globals?: Record<string, string>;
  model: string;
  chatIdHash?: number;
  /** e.g. impersonation / continue */
  generationType?: 'normal' | 'continue' | 'impersonate' | 'suggest_user' | 'narrate'
  /** Optional seed/hint from the composer (impersonate / suggest_user / soft char steer). */
  userHint?: string;
  /** Draft length slider (1–5). Read for `suggest_user` and `impersonate`. */
  draftLength?: DraftLength | number;
  directorState?: DirectorState;
  wiSettings: { scanDepth: number; budgetPercent: number; recursive: boolean; caseSensitive: boolean; matchWholeWords: boolean; maxRecursionSteps: number };
  formatting?: FormattingStack;
  messageStyle?: MessageStyleSettings | null;
  /**
   * Composed Character Brain block (docs/brain-system.md). Already budgeted to
   * at most 1/3 of the model context by the caller; inserted as its own itemised
   * slot so the prompt inspector shows exactly what memory cost.
   */
  brainContext?: string;
  /**
   * Composed ACTIVE SKILLS block (docs/skills-system.md).
   *
   * Craft documents the character may draw on this turn. Sized by the caller
   * against whatever memory left free, and inserted as its own itemised slot so
   * the inspector shows exactly what a skill cost.
   */
  skillContext?: string;
  /**
   * Selector tail for the inline skill router — the roster the model picks the
   * *next* turn's skills from. Sits at the very end of the prompt because it is
   * bookkeeping, and bookkeeping must never come between the story and the reply.
   */
  skillSelector?: string;
  /**
   * Scene cast names for narrator turns (solo character and/or group members).
   * Used for stop strings and POV forbid lists when `card` is the narrator stub.
   */
  castNames?: string[];
}

const HISTORY_RESERVE_MIN = 512; // never let fixed prompts starve history entirely

/**
 * Cut a block to a token ceiling on a line boundary.
 *
 * Used for the memory block, whose lines are whole memories: cutting mid-line
 * would hand the model half a sentence and call it a recollection. The note is
 * for the prompt inspector — a silently shortened memory block is how "why does
 * she not remember that?" becomes unanswerable.
 */
function trimBlockToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateTokens(text) <= maxTokens) return text;
  const note = '(memory truncated to leave room for the conversation)';
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = estimateTokens(note) + 1;
  for (const line of lines) {
    const t = estimateTokens(line) + 1;
    if (used + t > maxTokens) break;
    kept.push(line);
    used += t;
  }
  // A header with nothing under it is worse than no block at all.
  if (kept.filter((l) => l.trim()).length < 2) return '';
  return `${kept.join('\n')}\n${note}`;
}

/**
 * Drop whole skill documents until the block fits.
 *
 * Documents are already ordered by priority, so this cuts from the bottom —
 * the least important reference is the first to go, and whatever survives
 * survives intact.
 */
function trimSkillBlockToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateTokens(text) <= maxTokens) return text;
  const parts = text.split(/\n(?=### SKILL: )/);
  const header = parts.shift() ?? '';
  let used = estimateTokens(header);
  const kept: string[] = [];
  for (const part of parts) {
    const t = estimateTokens(part) + 1;
    if (used + t > maxTokens) break;
    kept.push(part);
    used += t;
  }
  // A header announcing skills the model was never given is a lie in the prompt.
  if (!kept.length) return '';
  return [header, ...kept].join('\n');
}

function renderMessageText(m: ChatMessage): string {
  return `${m.speaker.displayName}: ${m.text}`;
}

/**
 * Soft length guidance from the preset Max Tokens slider.
 * API max_tokens is the hard cut; this teaches the model to plan and finish under the budget
 * so replies don't get truncated mid-sentence. Shorter is always allowed.
 */
export function buildOutputLengthCap(maxTokens: number): string {
  const cap = Math.max(1, Math.floor(Number(maxTokens) || 800));
  // English ~0.75 words/token — user-facing approx so "tokens" reads as length, not jargon only
  const words = Math.max(1, Math.round(cap * 0.75));
  return [
    `LENGTH CAP (hard upper bound for this reply):`,
    `Finish under ${cap} tokens (~${words} words).`,
    `Shorter is always fine — even a single word when natural.`,
    `Never exceed this cap. End on a complete beat/sentence; do not trail off mid-thought.`,
    `This cap overrides any conflicting "write longer / 2–8 sentences / expand massively" guidance.`,
  ].join(' ');
}

export function buildPrompt(input: BuildInput): PromptPlan {
  const { preset, card, persona, history, group } = input;
  const isGroup = !!group && group.memberCards.length > 0;
  const isNarratorTurn = input.generationType === 'narrate' || card.id === '__narrator__';

  const memberNames = isGroup ? group!.memberCards.map((c) => c.name) : [card.name];
  const castForNarrator = [
    ...new Set(
      [
        ...(input.castNames ?? []),
        ...(isGroup ? memberNames : []),
        persona.name,
      ]
        .map((n) => (n ?? '').trim())
        .filter((n) => n && n.toLowerCase() !== 'narrator'),
    ),
  ];
  const env: MacroEnv = {
    char: card.name,
    user: persona.name,
    group: memberNames.join(', '),
    model: input.model,
    persona: persona.description,
    description: card.description,
    personality: card.personality,
    scenario: input.scenarioOverride || card.scenario,
    mesExamples: card.mes_example,
    charPrompt: card.system_prompt,
    charInstruction: card.post_history_instructions,
    charVersion: card.character_version,
    lastMessage: history.at(-1)?.text ?? '',
    lastUserMessage: [...history].reverse().find((m) => m.speaker.type === 'user')?.text ?? '',
    lastCharMessage: [...history].reverse().find((m) => m.speaker.type === 'character')?.text ?? '',
    chatIdHash: input.chatIdHash,
    variables: input.variables,
    globals: input.globals,
  };
  const sub = (t: string | undefined) => substituteMacros(t ?? '', env);

  // ---- world info ----
  const visibleHistory = history.filter((m) => !m.hiddenFromPrompt);
  const budgetTokens = Math.floor((preset.max_context * input.wiSettings.budgetPercent) / 100);
  const wi: WIScanResult = scanWorldInfo({
    entries: input.wiEntries,
    messages: visibleHistory.map(renderMessageText),
    extraScanText: `${card.description}\n${persona.description}`,
    settings: {
      scanDepth: input.wiSettings.scanDepth,
      recursive: input.wiSettings.recursive,
      caseSensitive: input.wiSettings.caseSensitive,
      matchWholeWords: input.wiSettings.matchWholeWords,
      budgetTokens,
      maxRecursionSteps: input.wiSettings.maxRecursionSteps,
    },
    countTokens: estimateTokens,
  });
  const wiText = (entries: WIEntry[]) => entries.map((e) => sub(preset.utility_prompts.wi_format.replace('{0}', e.content))).join('\n');

  // ---- marker content ----
  const markers: Record<string, { role: BuiltMessage['role']; content: string } | null> = {
    charDescription: card.description ? { role: 'system', content: sub(card.description) } : null,
    charPersonality: card.personality
      ? { role: 'system', content: sub(preset.utility_prompts.personality_format) || sub(card.personality) }
      : null,
    scenario: env.scenario ? { role: 'system', content: sub(preset.utility_prompts.scenario_format) || sub(env.scenario) } : null,
    personaDescription: persona.description ? { role: 'system', content: sub(persona.description) } : null,
    worldInfoBefore: wi.before.length ? { role: 'system', content: wiText(wi.before) } : null,
    worldInfoAfter: wi.after.length ? { role: 'system', content: wiText(wi.after) } : null,
  };

  // ---- fixed (non-history) messages, in prompt_order ----
  interface Slot { source: string; msg: BuiltMessage }
  const pre: Slot[] = [];
  const post: Slot[] = [];
  let seenChatHistory = false;
  let includeExamples = false;

  // Identity: character lock in groups; separate narrator lock when narrating
  const isWriteMe = input.generationType === 'suggest_user' && !isNarratorTurn;
  /**
   * A seeded Write Me answers to the player alone.
   *
   * The director's injections are standing orders for what the next beat should
   * do ("push the confrontation", "cut to the alley"), which is exactly the
   * kind of authority that talks a model out of the line the player just wrote.
   * With no seed they are useful — the model is choosing the beat and should
   * choose the steered one — so they are dropped only when a script exists.
   */
  const isImpersonate = input.generationType === 'impersonate' && !isNarratorTurn;
  /** Both review-before-post drafts: they share a length slider and a seed contract. */
  const isDraftTurn = isWriteMe || isImpersonate;
  /**
   * The narrator's length rail, when there is one.
   *
   * A narrator beat is *not* a draft turn — nobody's voice is being locked, and
   * the seed-script contract at the end of the prompt is written for a person.
   * But the Narrator panel carries the same 1–5 rail, so the beat honours it
   * when the client sent one. Automatic narration — the turn director picking
   * NARRATOR, a swipe, a continue — sends none and keeps the preset's budget,
   * which is why this is gated on the value arriving rather than on the turn
   * being a narrator turn.
   */
  const narratorLength = isNarratorTurn && input.draftLength != null
    ? clampDraftLength(input.draftLength)
    : undefined;
  const draftScripted = isDraftTurn && !!input.userHint?.trim();
  /**
   * Write Me is the one turn where the *user* is the speaker.
   *
   * Everything downstream of here — the card, the sysprompt pack, the group
   * identity lock — is written on the assumption that the model is playing
   * {{char}}, so without an explicit counter-lock at the top the most natural
   * continuation is a character reply. This is the same defence the narrator
   * turn gets, pointed the other way.
   */
  if (isWriteMe) {
    pre.push({
      source: 'identityLock',
      msg: { role: 'system', content: userIdentityLock(persona, memberNames) },
    });
  } else if (isNarratorTurn) {
    pre.push({
      source: 'identityLock',
      msg: { role: 'system', content: narratorIdentityLock(persona, castForNarrator) },
    });
  } else if (isGroup) {
    pre.push({ source: 'identityLock', msg: { role: 'system', content: identityLock(card, group!, persona) } });
  }
  if (input.director?.preAuthority && !draftScripted) {
    pre.push({ source: 'director.preAuthority', msg: { role: 'system', content: input.director.preAuthority } });
  }

  // Sysprompt pack
  const sys = input.formatting?.sysprompt;
  if (sys?.content?.trim() && !isNarratorTurn && !isWriteMe) {
    // Packs usually assume a speaking character; skip for narrator and Write Me
    // so first-person RP packs ("you are {{char}}, always stay in character")
    // don't fight the POV those turns are built around.
    pre.push({ source: 'sysprompt', msg: { role: 'system', content: sub(sys.content) } });
  }
  // Live message style — character first-person for RP; dedicated third-person for narrator
  const styleInstr = buildMessageStylePrompt(input.messageStyle);
  if (isNarratorTurn) {
    pre.push({
      source: 'messageStyleNarrator',
      msg: { role: 'system', content: buildNarratorStylePrompt() },
    });
  } else if (input.generationType === 'suggest_user') {
    pre.push({
      source: 'messageStyleUser',
      msg: {
        role: 'system',
        content: [
          `You are drafting the next message as {{user}} (the human player), NOT as {{char}}.`,
          `First person as {{user}} (I/me/my). No meta, counters, or stage notes.`,
          styleInstr,
        ].filter(Boolean).join('\n'),
      },
    });
  } else if (styleInstr) {
    pre.push({ source: 'messageStyle', msg: { role: 'system', content: styleInstr } });
  }
  if (
    !isNarratorTurn &&
    input.generationType !== 'suggest_user'
  ) {
    pre.push({
      source: 'writingContract',
      msg: { role: 'system', content: sub(DEFAULT_WRITING_CONTRACT) },
    });
  }

  for (const orderEntry of preset.prompt_order) {
    if (!orderEntry.enabled) continue;
    const p = preset.prompts.find((x) => x.identifier === orderEntry.identifier);
    if (!p) continue;
    const bucket = seenChatHistory ? post : pre;

    if (p.marker) {
      if (p.identifier === 'chatHistory') { seenChatHistory = true; continue; }
      if (p.identifier === 'dialogueExamples') { includeExamples = true; continue; }
      const m = markers[p.identifier];
      if (m && m.content.trim()) bucket.push({ source: p.identifier, msg: m });
      continue;
    }
    // Drop novelty ST modules that force HTML colors, status headers, X-feeds, plot XML
    if (isJunkFormatPrompt(p.name ?? '', p.content ?? '')) continue;

    // char card system prompt overrides `main` when present (ST behavior, {{original}} passthrough)
    let content = p.content ?? '';
    if (p.identifier === 'main' && card.system_prompt) {
      env.original = sub(p.content);
      content = card.system_prompt;
    } else if (p.identifier === 'jailbreak') {
      // The card's post-history block is the strongest "stay in character, never
      // write for the user" push in the prompt, and it sits near the end where
      // models weight it most. On a Write Me turn that is exactly backwards.
      if (isWriteMe) continue;
      const parts = [
        card.post_history_instructions,
        sys?.post_history,
      ].filter((x) => x?.trim());
      if (parts.length) {
        env.original = sub(p.content);
        content = parts.join('\n');
      }
    }
    const rendered = substituteMacros(content, env);
    env.original = undefined;
    if (!rendered.trim()) continue;
    // Second pass: content after macros still looks like junk protocol
    if (isJunkFormatPrompt(p.name ?? '', rendered)) continue;
    bucket.push({ source: p.identifier, msg: { role: p.role ?? 'system', content: rendered } });
  }

  // director weave sits with scenario-adjacent content
  if (input.director?.sceneWeave && !draftScripted) {
    pre.push({ source: 'director.sceneWeave', msg: { role: 'system', content: input.director.sceneWeave } });
  }
  if (input.summary) {
    pre.push({ source: 'summary', msg: { role: 'system', content: `[Story so far]\n${input.summary}` } });
  }
  // Character Brain: long-term memory, mood, beliefs and relationships. Sits
  // after the story summary (which is *what happened*) because this is *what
  // they carry from it* — the model should read the summary as fact and this as
  // the character's own, fallible recollection.
  if (input.brainContext?.trim()) {
    pre.push({ source: 'brain', msg: { role: 'system', content: input.brainContext.trim() } });
  }
  // Skills sit after memory: what the character *carries* outranks what they
  // happen to be good at, and when the window is tight this is the block that
  // should give way first.
  if (input.skillContext?.trim()) {
    pre.push({ source: 'skills', msg: { role: 'system', content: input.skillContext.trim() } });
  }

  // ---- example dialogues ----
  const exampleMsgs: Slot[] = [];
  if (includeExamples && card.mes_example.trim()) {
    const blocks = sub(card.mes_example).split(/<START>/i).map((b) => b.trim()).filter(Boolean);
    for (const block of blocks) {
      exampleMsgs.push({ source: 'dialogueExamples', msg: { role: 'system', content: `${sub(preset.utility_prompts.new_example_chat_prompt)}\n${block}` } });
    }
  }

  // ---- chat history with injections ----
  const chatStartPrompt = isGroup ? preset.utility_prompts.new_group_chat_prompt : preset.utility_prompts.new_chat_prompt;
  const historySlots: Slot[] = visibleHistory.map((m, i) => {
    const isUser = m.speaker.type === 'user' || m.controlledBy === 'human';
    const useNamePrefix = isGroup || preset.names_behavior === 2;
    // Scrub past AI junk so models don't re-imitate font tags / status headers
    const base = isUser ? m.text : sanitizeAiOutput(m.text);
    const content = useNamePrefix
      ? (isUser ? renderMessageText({ ...m, text: base }) : renderMessageText({ ...m, text: base }))
      : base;
    return {
      source: `chatHistory[${i}]`,
      msg: { role: isUser ? 'user' : 'assistant', content } as BuiltMessage,
    };
  });

  // depth-based injections (counted from bottom): WI atDepth, author's note, char depth prompt
  const injections: { depth: number; role: BuiltMessage['role']; content: string; source: string }[] = [];
  for (const d of wi.atDepth) {
    injections.push({ depth: d.depth, role: (['system', 'user', 'assistant'] as const)[d.role], content: sub(d.entry.content), source: `worldInfo@${d.depth}` });
  }
  if (input.authorsNote?.text.trim()) {
    const anParts = [wiText(wi.anTop), sub(input.authorsNote.text), wiText(wi.anBottom)].filter(Boolean);
    injections.push({ depth: input.authorsNote.depth, role: input.authorsNote.role, content: anParts.join('\n'), source: 'authorsNote' });
  }
  const depthPrompt = card.extensions.depth_prompt;
  if (depthPrompt?.prompt) {
    injections.push({ depth: depthPrompt.depth ?? 4, role: depthPrompt.role ?? 'system', content: sub(depthPrompt.prompt), source: 'charDepthPrompt' });
  }
  injections.sort((a, b) => b.depth - a.depth);
  for (const inj of injections) {
    const idx = Math.max(0, historySlots.length - inj.depth);
    historySlots.splice(idx, 0, { source: inj.source, msg: { role: inj.role, content: inj.content } });
  }

  // ---- trailing nudges ----
  const tail: Slot[] = [];
  if (isNarratorTurn) {
    const recent = visibleHistory
      .slice(-6)
      .map((m) => `${m.speaker.displayName}: ${m.text}`)
      .join('\n');
    tail.push({
      source: 'narratorBeat',
      msg: {
        role: 'system',
        content: narratorBeatInstruction({
          composerSeed: input.userHint,
          director: input.directorState,
          authorsNote: input.authorsNote?.text,
          recentExcerpt: recent,
          castNames: castForNarrator,
          length: narratorLength,
        }),
      },
    });
    // Final user-role instruction sits after history so models honor seed + POV
    tail.push({
      source: 'narratorFinal',
      msg: {
        role: 'user',
        content: narratorFinalUserNudge({
          composerSeed: input.userHint,
          castNames: castForNarrator,
          length: narratorLength,
        }),
      },
    });
  } else if (input.generationType === 'suggest_user') {
    // Write Me — elaborate the player's intent into a full user reply
    const hint = input.userHint?.trim();
    const otherNames = memberNames
      .map((n) => (n ?? '').trim())
      .filter((n) => n && n.toLowerCase() !== persona.name.trim().toLowerCase());
    const lenSpec = DRAFT_LENGTH[clampDraftLength(input.draftLength)];
    tail.push({
      source: 'suggestUserFinal',
      msg: {
        role: 'user',
        content: [
          `TASK: Write {{user}}'s (${persona.name}) NEXT full roleplay message.`,
          `You are NOT {{char}}. Do not write as the character.`,
          otherNames.length
            ? `HARD RULE: ${otherNames.join(', ')} ${otherNames.length > 1 ? 'are' : 'is'} NOT you. Write nothing in their voice — no dialogue, no thoughts, no reply from them after your line. If you catch yourself writing what ${otherNames[0]} says or feels, stop and write what ${persona.name} does instead.`
            : 'HARD RULE: write only your own side of the exchange.',
          `LENGTH: ${lenSpec.sentences} (~${lenSpec.targetWords} words, ${lenSpec.label.toLowerCase()}). Write to that length — do not stop short and do not run past it.${
            hint ? ' Reach it by describing what the script already says in richer detail — NEVER by adding events of your own.' : ''
          }`,
          `RULES: first person (I/me/my). Follow FORMAT wrappers exactly. No name prefix. No meta.`,
          hint
            ? seedScriptContract({ seed: hint, speakerName: persona.name, otherNames, kind: 'user' })
            : [
                `No seed was given. Decide the best next {{user}} line yourself from the full scene:`,
                `chat so far, scenario, summary, lore, stage direction, author's note, and any standing goals.`,
                `Write something that feels natural for {{user}}, advances the story, and answers what the moment demands — not filler, not meta.`,
              ].join(' '),
          `Reply with ONLY the finished message body.`,
        ].join('\n\n'),
      },
    });
  } else if (input.generationType === 'impersonate') {
    /**
     * Impersonate — the chosen character's next message, drafted for review.
     *
     * Same contract as Write Me with the speaker swapped: with a seed the user
     * is scripting this character's beat and the model renders it; with none the
     * model chooses the beat from full context.
     */
    const seed = input.userHint?.trim();
    const lenSpec = DRAFT_LENGTH[clampDraftLength(input.draftLength)];
    const castOthers = [
      ...memberNames.filter((n) => (n ?? '').trim() && n !== card.name),
      persona.name,
    ].map((n) => (n ?? '').trim()).filter(Boolean);
    tail.push({
      source: 'charImpersonate',
      msg: {
        role: 'user',
        content: [
          `TASK: Write ${card.name}'s NEXT full roleplay message in FIRST PERSON (I/me/my).`,
          `You are ${card.name} for this message and nobody else — not another cast member, not the narrator.`,
          castOthers.length
            ? `HARD RULE: never write as, speak for, or narrate the thoughts of ${castOthers.join(', ')}. They may only appear as ${card.name} sees and hears them. End before anyone replies.`
            : `HARD RULE: write only ${card.name}'s side of the exchange.`,
          `LENGTH: ${lenSpec.sentences} (~${lenSpec.targetWords} words, ${lenSpec.label.toLowerCase()}). Write to that length — do not stop short and do not run past it.${
            seed ? ' Reach it by describing what the script already says in richer detail — NEVER by adding events of your own.' : ''
          }`,
          `RULES: follow FORMAT wrappers exactly. Never third person ("${card.name} does…"). No meta/counters. No name prefix.`,
          seed
            ? seedScriptContract({
                seed,
                speakerName: card.name,
                otherNames: castOthers,
                kind: 'character',
              })
            : [
                `No script was given. You decide the best next ${card.name} reply entirely from full context:`,
                `the conversation, ${card.name}'s personality and memories (brain), relationships, scenario, lore,`,
                `stage direction / director, author's note, scene goals, and emotional stakes.`,
                `Write the strongest in-character beat that moves the story forward — react, choose, reveal, or push — not a vague stall.`,
              ].join(' '),
          seed
            ? `Output ONLY the message body.`
            : `Also honor any stage direction and author's note for vibe. Output ONLY the message body.`,
        ].filter(Boolean).join('\n\n'),
      },
    });
    if (isGroup) {
      tail.push({ source: 'groupNudge', msg: { role: 'system', content: sub(preset.utility_prompts.group_nudge_prompt) } });
    }
  } else if (input.generationType === 'continue') {
    tail.push({ source: 'continueNudge', msg: { role: 'system', content: sub(preset.utility_prompts.continue_nudge_prompt) } });
  } else if (isGroup) {
    tail.push({ source: 'groupNudge', msg: { role: 'system', content: sub(preset.utility_prompts.group_nudge_prompt) } });
  }
  // Soft steer for normal character gen when the user typed a private hint (not write-me / char-impersonate / narrate)
  if (
    input.userHint?.trim() &&
    card.id !== '__narrator__' &&
    input.generationType !== 'narrate' &&
    input.generationType !== 'suggest_user' &&
    input.generationType !== 'impersonate' &&
    (!input.generationType || input.generationType === 'normal')
  ) {
    tail.push({
      source: 'charHint',
      msg: {
        role: 'system',
        content: `Private director hint for this reply only (never acknowledge it): ${input.userHint.trim()}`,
      },
    });
  }
  /**
   * Consecutive-AI-turn guard.
   *
   * A character reply normally follows a user message, so writing as the
   * character is the model's natural continuation. When the transcript already
   * ends on an AI line — a forced out-of-turn reply, Skip, or a group
   * auto-continue — the most natural continuation becomes {{user}}'s answer,
   * and the model speaks for the player. Say so explicitly in that case.
   */
  {
    const lastVisible = visibleHistory.at(-1);
    const lastWasUser =
      !!lastVisible && (lastVisible.speaker.type === 'user' || lastVisible.controlledBy === 'human');
    const isCharacterTurn =
      card.id !== '__narrator__' &&
      input.generationType !== 'narrate' &&
      input.generationType !== 'suggest_user' &&
      input.generationType !== 'continue';

    if (isCharacterTurn && lastVisible && !lastWasUser) {
      const lastSpeaker = lastVisible.speaker.displayName;
      const selfAgain = lastSpeaker === card.name;
      tail.push({
        source: 'turnGuard',
        msg: {
          role: 'system',
          content: [
            `TURN NOTICE: ${persona.name} has NOT replied yet. The last line in the transcript is ${
              selfAgain ? 'your own' : `${lastSpeaker}'s`
            }, and you are speaking again out of the usual order.`,
            `Write ONLY ${card.name}'s next beat. Do NOT write ${persona.name}'s reply, actions, or thoughts — not even to set up your own line.`,
            selfAgain
              ? `Continue naturally from your own last line: press on, react to the silence, change tack, or act. Do not repeat what you just said.`
              : `React to what ${lastSpeaker} just did.`,
            `End your reply before anyone else would speak.`,
          ].join(' '),
        },
      });
    }
  }
  if (input.director?.closingMandate && !isNarratorTurn && !draftScripted) {
    tail.push({ source: 'director.closingMandate', msg: { role: 'system', content: input.director.closingMandate } });
  }
  // End-of-prompt FORMAT reminder every turn so model cannot drift back to old wrappers
  if (!isNarratorTurn) {
    const formatTail = buildMessageStyleTailReminder(input.messageStyle);
    if (formatTail) {
      tail.push({ source: 'messageStyle.tail', msg: { role: 'system', content: formatTail } });
    }
  }
  // Max Tokens slider → always tell the model the soft length budget (API max_tokens is the hard cut)
  {
    /**
     * Write Me answers to its own slider, not the preset's reply budget: this
     * block explicitly overrides "write longer" guidance, so leaving the preset
     * number here would cap a Max draft at whatever character replies are set to.
     */
    const lengthCap = buildOutputLengthCap(
      isDraftTurn
        ? DRAFT_LENGTH[clampDraftLength(input.draftLength)].maxTokens
        : narratorLength
          ? DRAFT_LENGTH[narratorLength].maxTokens
          : preset.max_tokens,
    );
    if (lengthCap) {
      tail.push({ source: 'outputLengthCap', msg: { role: 'system', content: lengthCap } });
    }
  }
  /**
   * The draft's last word.
   *
   * The FORMAT reminder and length cap above are generic, so the final thing the
   * model reads would otherwise be boilerplate. This puts the two things that
   * actually go wrong — who is speaking, and whether the script is optional —
   * in the position models weight hardest.
   */
  if (isDraftTurn) {
    const speakerName = isWriteMe ? persona.name : card.name;
    const otherNames = (isWriteMe ? memberNames : [...memberNames, persona.name])
      .map((n) => (n ?? '').trim())
      .filter((n) => n && n.toLowerCase() !== speakerName.trim().toLowerCase());
    tail.push({
      source: 'draftAnchor',
      msg: {
        role: 'system',
        content: [
          isWriteMe
            ? `FINAL CHECK — you are writing as ${persona.name} (the human player), in first person.`
            : `FINAL CHECK — you are writing as ${card.name}, in first person, and as nobody else.`,
          otherNames.length
            ? `Not as ${otherNames.join(' or ')}. Their reply is not yours to write; end your message before anyone answers.`
            : 'End your message before anyone answers it.',
          input.userHint?.trim()
            ? `The player's script is canon: every action and outcome in it happens exactly as written, nothing is reversed or second-guessed, and nothing beyond it is invented.`
            : '',
          'No speaker labels. Output the message body only.',
        ].filter(Boolean).join(' '),
      },
    });
  }
  // Absolute last: the model must finish the story before it does paperwork.
  if (input.skillSelector?.trim()) {
    tail.push({ source: 'skillSelector', msg: { role: 'system', content: input.skillSelector.trim() } });
  }
  const reasoning = input.formatting?.reasoning;
  if (reasoning?.prefix?.trim() || reasoning?.suffix?.trim()) {
    tail.push({
      source: 'reasoning',
      msg: {
        role: 'system',
        content: [
          reasoning.prefix?.trim() ? `Reasoning prefix: ${reasoning.prefix}` : '',
          reasoning.suffix?.trim() ? `Reasoning suffix: ${reasoning.suffix}` : '',
        ].filter(Boolean).join(reasoning.separator || '\n'),
      },
    });
  }

  // context template can override the new-chat separator
  const ctxPreset = input.formatting?.context;
  const effectiveChatStart = ctxPreset?.chat_start?.trim()
    ? ctxPreset.chat_start
    : chatStartPrompt;

  // ---- token budgeting: fixed parts first, then history newest-first ----
  const budget = preset.max_context - preset.max_tokens;
  /**
   * Memory is the one "fixed" block that may be cut.
   *
   * Everything else in `pre`/`post`/`tail` is the contract the model is working
   * under — the system prompt, the card, the identity lock — and shortening any
   * of it changes the rules mid-scene. The brain block is different: it is a
   * *budgeted* block that was sized against the model's whole window, while this
   * budget is the user's own (usually smaller) context slider. Left in `fixed`
   * it could consume the entire budget and the history loop below would keep
   * exactly zero messages, sending a full memory dump with no conversation
   * attached — the model then has nothing to reply to.
   */
  const brainSlot = pre.find((s) => s.source === 'brain') ?? null;
  /**
   * Skills are trimmable for the same reason memory is, only more so.
   *
   * Memory is who this character is; a skill is craft reference they can do
   * without. So it is budgeted last, cut first, and — unlike the contract
   * blocks — allowed to disappear entirely rather than squeeze the transcript.
   */
  const skillSlot = pre.find((s) => s.source === 'skills') ?? null;
  const preFixed = pre.filter((s) => s !== brainSlot && s !== skillSlot);
  const fixed = [...preFixed, ...post, ...tail];
  let used = fixed.reduce((s, x) => s + estimateTokens(x.msg.content) + 4, 0);
  used += estimateTokens(sub(effectiveChatStart)) + 4;
  /**
   * What the scaffolding costs before memory, examples or transcript.
   *
   * Reported so the caller can size the brain block against the room that
   * actually exists. Without it `planContext` is handed `fixedPromptTokens: 0`,
   * its history guard is inert, and the brain asks for a third of the window on
   * top of a system prompt that was never counted.
   */
  const fixedTokens = used;

  let keptBrain: Slot | null = null;
  if (brainSlot) {
    const room = budget - used - HISTORY_RESERVE_MIN;
    const cost = estimateTokens(brainSlot.msg.content) + 4;
    if (cost <= room) {
      keptBrain = brainSlot;
      used += cost;
    } else {
      const trimmed = trimBlockToTokens(brainSlot.msg.content, room - 4);
      if (trimmed) {
        keptBrain = { source: 'brain', msg: { role: brainSlot.msg.role, content: trimmed } };
        used += estimateTokens(trimmed) + 4;
      }
    }
  }
  let keptSkills: Slot | null = null;
  if (skillSlot) {
    const room = budget - used - HISTORY_RESERVE_MIN;
    const cost = estimateTokens(skillSlot.msg.content) + 4;
    if (cost <= room) {
      keptSkills = skillSlot;
      used += cost;
    } else {
      /**
       * Cut whole sections, never sentences.
       *
       * A skill block is a stack of `### SKILL:` documents; half a technique
       * reads as authoritative and is not, which is worse than the model
       * improvising with no reference at all.
       */
      const trimmed = trimSkillBlockToTokens(skillSlot.msg.content, room - 4);
      if (trimmed) {
        keptSkills = { source: 'skills', msg: { role: skillSlot.msg.role, content: trimmed } };
        used += estimateTokens(trimmed) + 4;
      }
    }
  }

  const preWithBrain = pre.flatMap((s) => {
    if (s === brainSlot) return keptBrain ? [keptBrain] : [];
    if (s === skillSlot) return keptSkills ? [keptSkills] : [];
    return [s];
  });

  const keptExamples: Slot[] = [];
  for (const ex of exampleMsgs) {
    const t = estimateTokens(ex.msg.content) + 4;
    if (used + t + HISTORY_RESERVE_MIN <= budget) { keptExamples.push(ex); used += t; }
  }

  const keptHistory: Slot[] = [];
  for (let i = historySlots.length - 1; i >= 0; i--) {
    const t = estimateTokens(historySlots[i].msg.content) + 4;
    if (used + t > budget) break;
    keptHistory.unshift(historySlots[i]);
    used += t;
  }

  // ---- final assembly ----
  const slots: Slot[] = [
    ...preWithBrain,
    ...keptExamples,
    { source: 'newChat', msg: { role: 'system', content: sub(effectiveChatStart) } },
    ...keptHistory,
    ...post,
    ...tail,
  ];

  let messages = slots.map((s) => s.msg).filter((m) => m.content.trim().length > 0);
  if (preset.squash_system_messages) {
    messages = squashSystem(messages);
  }

  const itemization: PromptItem[] = slots.map((s) => ({
    source: s.source,
    role: s.msg.role,
    tokens: estimateTokens(s.msg.content),
    preview: s.msg.content.length > 160 ? s.msg.content.slice(0, 157) + '…' : s.msg.content,
  }));

  /**
   * Hard identity backstop: stop the moment the model starts another speaker's
   * line. This must apply in solo chats too — the model writing "{{user}}: …"
   * and answering on the player's behalf is the single most common failure, and
   * it is *most* likely when the transcript ends on an AI message (a forced
   * out-of-turn reply, Skip, or a group auto-continue).
   */
  const stops: string[] = [];
  {
    /**
     * Write Me is the mirror case: the foreign speakers are the characters, and
     * the one name that must NOT stop the stream is the player's. Leaving this
     * turn with no stops at all (as it once had) is what let a draft roll on
     * into "Maya: …" and answer the player's own line for them.
     */
    const others = isWriteMe
      ? [...memberNames, ...(input.castNames ?? []), 'Narrator']
      : isNarratorTurn
        ? [...castForNarrator, 'Narrator']
        : isGroup
          ? [...memberNames, persona.name]
          : [persona.name];
    const selfName = isWriteMe ? persona.name : card.name;
    for (const name of others) {
      const n = (name ?? '').trim();
      if (!n) continue;
      if (!isNarratorTurn && n.toLowerCase() === selfName.trim().toLowerCase()) continue;
      stops.push(`\n${n}:`);
    }
  }
  const instruct = input.formatting?.instruct;
  if (instruct?.stop_sequence?.trim() && instruct.sequences_as_stop_strings) {
    stops.push(instruct.stop_sequence);
  }
  for (const s of preset.stop_strings ?? []) {
    if (s?.trim()) stops.push(s);
  }

  return {
    messages, itemization, totalTokens: used, fixedTokens, stops: [...new Set(stops)].slice(0, 8),
  };
}

function squashSystem(messages: BuiltMessage[]): BuiltMessage[] {
  const out: BuiltMessage[] = [];
  for (const m of messages) {
    const last = out.at(-1);
    if (last && last.role === 'system' && m.role === 'system' && !last.name && !m.name) {
      last.content += '\n' + m.content;
    } else {
      out.push({ ...m });
    }
  }
  return out;
}

/** Identity lock header — the core defense against character confusion in groups. */
function identityLock(card: CharacterCard, group: GroupContext, persona: Persona): string {
  const others = group.memberCards
    .filter((c) => c.id !== card.id)
    .map((c) => (group.playAsName === c.name ? `${c.name} (played by the human user — NEVER write their lines)` : `${c.name} (AI)`));
  const roster = [
    `${persona.name} (the human user)`,
    ...others,
  ].join(', ');
  return [
    `You are ${card.name} — and only ${card.name}.`,
    `Write in FIRST PERSON as ${card.name} (I / me / my). Never " ${card.name} does…" — write "I do…".`,
    `Other participants in this scene: ${roster}.`,
    `Every line of the transcript is labeled with its speaker. Only lines labeled "${card.name}:" were spoken by you. You are not "the assistant" behind other characters' earlier messages.`,
    `Never write dialogue, actions, or thoughts for any other participant. End your reply before another character would speak.`,
    `Output only in-world prose using the FORMAT wrappers. No meta, counters, stages, or OOC.`,
  ].join('\n');
}

/** Narrator identity — never first-person cast voice. */
/**
 * Write Me identity lock — the player is the speaker for this one turn.
 *
 * Names every AI character explicitly: "do not write as the character" is easy
 * for a model to satisfy in spirit while still answering as Maya, whereas a
 * roster it is forbidden to voice is checkable.
 */
function userIdentityLock(persona: Persona, castNames: string[]): string {
  const others = [...new Set(castNames.map((n) => (n ?? '').trim()).filter(Boolean))]
    .filter((n) => n.toLowerCase() !== persona.name.trim().toLowerCase());
  return [
    `OVERRIDE — THIS TURN ONLY: you are ${persona.name}, the human player. You are NOT any AI character in this scene.`,
    `Every instruction below about playing a character, staying in character, or writing as {{char}} is SUSPENDED for this turn. It describes the character you are replying TO, not who you are.`,
    `Write in FIRST PERSON as ${persona.name} (I / me / my).`,
    others.length
      ? `NEVER write as, speak for, or narrate the inner thoughts of: ${others.join(', ')}. They are the other side of this conversation — you are answering them, not voicing them.`
      : 'NEVER write the other side of the conversation.',
    others.length
      ? `Do not continue their turn, do not add their reply after yours, and never label a line "${others[0]}:".`
      : 'Do not write anyone else\'s reply after yours.',
    `Other characters may only appear as ${persona.name} perceives them from outside — what they can be seen or heard doing. No dialogue for them, no interiority.`,
    `Never prefix the output with a name (not "${persona.name}:", not a character name). Output only the message body.`,
  ].join('\n');
}

function narratorIdentityLock(persona: Persona, castNames: string[]): string {
  const roster = [...new Set(castNames.map((n) => n.trim()).filter(Boolean))].join(', ')
    || persona.name;
  return [
    'You are the Narrator — the omniscient voice of the world, not a person in the scene.',
    'Write in THIRD PERSON present (camera / atmosphere / consequence). Never first person as cast.',
    `Scene participants (never speak as them, never label lines with their names): ${roster}.`,
    'Transcript lines are labeled with speakers for context only — you do not continue any of those voices.',
    'Never output dialogue in quotation marks. Never open with "Narrator:" or "Name:".',
    'Output only narrator prose. No meta, counters, stages, or OOC.',
  ].join('\n');
}
