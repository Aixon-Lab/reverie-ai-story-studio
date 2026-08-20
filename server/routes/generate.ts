/** Generation routes: SSE chat generation, Turn Director, Genesis, images. */
import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AppSettings, CharacterCard, ChatMessage, Group, Persona, WIEntry } from '../../shared/types';
import { buildPrompt, type BuildInput } from '../../shared/engine/promptBuilder';
import { bookToEntries } from '../../shared/codec/lorebook';
import {
  narratorCard, storyDirectorInjection, turnDirectorPrompt, parseTurnDecision,
  genesisPrompt, genesisNeedScanPrompt, imageDirectorPrompt, summarizerPrompt, authorsNoteExpandPrompt,
  authorsNoteExpandRetryPrompt, authorsNoteNeedsRetry, authorsNoteWordCount, clampAuthorsNoteRichness,
  AUTHORS_NOTE_RICHNESS,
  authorsNoteDemetaPrompt, authorsNoteMetaLeak, stripAuthorsNoteMeta,
  clampDraftLength, DRAFT_LENGTH, DEFAULT_DRAFT_LENGTH,
  draftFidelityRetryPrompt, draftNeedsFidelityRetry, draftSeedCoverage,
  characterGistGeneratePrompt, characterVisionPhysicalPrompt, styleAnalystPrompt,
  physicalFromDescriptionPrompt, styleAnalystFromDescriptionsPrompt,
  proofreadPrompt,
  type TurnDirectorDecision,
} from '../../shared/engine/agents';
import {
  packToDescription, packToPersonality, type CharacterCreatorPack, type SettingKind,
} from '../../shared/engine/characterDomains';
import { generateText, generateTextComplete, generateOnce, generateOnceVision } from '../providers/text';
import {
  DEFAULT_LOCAL_VISION, VISION_MODEL, detectLocalVision, generateOnceLocalVision, warmupLocalVision,
  type LocalVisionConfig, type LocalVisionImage, type LocalVisionOpts,
} from '../providers/localVision';
import { generateImage, IMAGE_CATALOG } from '../providers/image';
import { listProviderModels, type ModelKind } from '../providers/models';
import { dirs, writeJsonAtomic, readJson, readBlob, writeBlob } from '../storage';
import { parseModelJson } from '../lib/parseModelJson';
import { loadSettings, loadPersonas, loadCharacter, loadPreset, loadLorebook } from './library';
import { loadChatMeta, loadMessages, loadGroup, saveChatMeta, appendMessage, newMessage, saveMessages } from './chats';
import { applyContinueText, applySwipeText, buildTimelineFromMessages } from '../../shared/engine/timeline';
import { loadTimelineForChat, saveTimeline } from './timelineStore';
import type { ContextPreset, InstructPreset, ReasoningPreset, SyspromptPreset } from '../../shared/types';
import { applyRegexScripts } from '../../shared/engine/regex';
import { humanSeatIds } from '../../shared/engine/identity';
import { sanitizeAiOutput, splitReasoningFromOutput, truncateAtForeignSpeaker } from '../../shared/engine/sanitizeOutput';
import {
  buildBrainContext, flushBrains, repairCursor, resolveCursor,
} from '../brain/service';
import { ensureBrain } from '../brain/provision';
import { loadBrainIfExists, tryWithBrainLock } from '../brain/store';
import { consolidateForChat } from './brain';
import { runWithPurpose } from '../lib/sessionLog';
import { estimateTokens } from '../../shared/engine/tokens';
import { createSkillTagFilter, extractSkillTag } from '../../shared/skills';
import {
  chatSkillState, decisionFromTag, prepareSkillTurn, scoutSkills, type SkillTurn,
} from '../skills/service';

export const generate = Router();

async function loadFormatting(settings: Awaited<ReturnType<typeof loadSettings>>) {
  const [instruct, context, sysprompt, reasoning] = await Promise.all([
    settings.instructEnabled
      ? readJson<InstructPreset | null>(path.join(dirs.instruct, `${settings.activeInstructId}.json`), null)
      : Promise.resolve(null),
    readJson<ContextPreset | null>(path.join(dirs.context, `${settings.activeContextId}.json`), null),
    settings.syspromptEnabled
      ? readJson<SyspromptPreset | null>(path.join(dirs.sysprompt, `${settings.activeSyspromptId}.json`), null)
      : Promise.resolve(null),
    readJson<ReasoningPreset | null>(path.join(dirs.reasoning, `${settings.activeReasoningId}.json`), null),
  ]);
  return { instruct, context, sysprompt, reasoning };
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

async function gatherContext(chatId: string, speakerId?: string) {
  const meta = await loadChatMeta(chatId);
  const settings = await loadSettings();
  const personas = await loadPersonas();
  // Active persona (drawer) wins over chat snapshot so "become X" applies immediately
  const persona: Persona = personas.find((p) => p.id === (settings.activePersonaId ?? meta.personaId)) ?? personas[0];
  const preset = await loadPreset(settings.activePresetId);
  const history = await loadMessages(chatId);

  let group: Group | undefined;
  let memberCards: CharacterCard[] = [];
  let card: CharacterCard;

  if (speakerId === '__narrator__') {
    card = narratorCard();
    if (meta.groupId) {
      group = await loadGroup(meta.groupId);
      memberCards = await Promise.all(group.members.map((m) => loadCharacter(m)));
    } else if (meta.characterId) {
      // Solo chats still need the cast name so stop-strings / cleanup never keep "Name:" lines
      try {
        memberCards = [await loadCharacter(meta.characterId)];
      } catch {
        memberCards = [];
      }
    }
  } else if (meta.groupId) {
    group = await loadGroup(meta.groupId);
    memberCards = await Promise.all(group.members.map((m) => loadCharacter(m)));
    if (speakerId) card = memberCards.find((c) => c.id === speakerId) ?? (await loadCharacter(speakerId));
    else card = memberCards[0];
  } else {
    card = await loadCharacter(speakerId ?? meta.characterId!);
  }

  // world info: global books + active character's embedded book + linked world
  const wiEntries: WIEntry[] = [];
  for (const bookId of settings.globalLorebooks) {
    const book = await loadLorebook(bookId);
    if (book) wiEntries.push(...book.entries);
  }
  const cardsForBooks = group ? memberCards : [card];
  for (const c of cardsForBooks) {
    if (c.character_book) wiEntries.push(...bookToEntries(c.character_book));
    const world = c.extensions.world;
    if (typeof world === 'string' && world) {
      const linked = await loadLorebook(world).catch(() => null);
      if (linked) wiEntries.push(...linked.entries);
    }
  }

  return { meta, settings, persona, preset, history, group, memberCards, card };
}

// ---------- main generation (SSE) ----------

generate.post('/generate', async (req, res) => {
  const { chatId, speakerId, generationType, mode, hint, targetMessageId, draftLength, draft } = req.body as {
    chatId: string;
    speakerId?: string;
    generationType?: 'normal' | 'continue' | 'impersonate' | 'suggest_user' | 'narrate';
    mode?: 'swipe';
    /** Composer seed for write-as-user, soft character steer, or narrator beat */
    hint?: string;
    /** Draft length slider (1–5) — Write Me, Impersonate, and the Narrator panel */
    draftLength?: number;
    /** Impersonate / Narrator: return the text for review instead of posting it */
    draft?: boolean;
    /** Swipe/continue target; defaults to last message. Must be tip after deep-swipe prepare. */
    targetMessageId?: string;
  };
  if (!chatId) {
    return res.status(400).json({ error: 'chatId is required.' });
  }
  const isNarrator = speakerId === '__narrator__' || generationType === 'narrate';

  let ctx: Awaited<ReturnType<typeof gatherContext>>;
  try {
    ctx = await gatherContext(chatId, speakerId);
  } catch (err: any) {
    console.error('gatherContext failed', err);
    return res.status(500).json({
      error: err?.message
        ? `Could not load chat context: ${err.message}`
        : 'Could not load chat context. Re-open the chat and try again.',
    });
  }
  const { meta, settings, persona, preset, group, memberCards, card } = ctx;
  if (!card) {
    return res.status(400).json({
      error: 'No character loaded for this chat. Open the chat again or pick a character.',
    });
  }

  // Exclusive control: the human's character is NEVER written by the AI.
  // "Human" is the play-as seat *and* whoever the active persona is — a persona
  // minted from a cast member is that cast member, and letting the AI voice them
  // is how a scene ends up with two of the same person talking to each other.
  // (suggest_user drafts the human's line — still not "as" that AI speaker card in chat)
  const humanSeats = group
    ? humanSeatIds({ members: memberCards, playAs: group.playAs, persona })
    : [];
  const aiWritingCharacter =
    !isNarrator &&
    generationType !== 'suggest_user' &&
    !!speakerId &&
    speakerId !== '__narrator__';
  if (aiWritingCharacter && speakerId && humanSeats.includes(speakerId)) {
    return res.status(400).json({
      error: 'That character is played by you — AI will not write their lines. Switch "As" or pick another speaker.',
    });
  }

  // swipe = regenerate alternative for tip (or targetMessageId tip): prompt without that message
  let history = ctx.history;
  if (mode === 'swipe') {
    if (targetMessageId) {
      const idx = ctx.history.findIndex((m) => m.id === targetMessageId);
      if (idx === -1) {
        return res.status(400).json({ error: 'targetMessageId not found in chat history' });
      }
      if (idx !== ctx.history.length - 1) {
        return res.status(400).json({
          error: 'Deep swipe target is not the tip. Call /timeline/deep-swipe first to fork and truncate.',
        });
      }
      history = ctx.history.slice(0, idx);
    } else {
      history = ctx.history.slice(0, -1);
    }
  }

  const wiEntries: WIEntry[] = [];
  {
    // recompute (gatherContext already built them but scoped); simpler: rebuild here
    for (const bookId of settings.globalLorebooks) {
      const book = await loadLorebook(bookId);
      if (book) wiEntries.push(...book.entries);
    }
    for (const c of group ? memberCards : [card]) {
      if (c.character_book) wiEntries.push(...bookToEntries(c.character_book));
      const world = c.extensions.world;
      if (typeof world === 'string' && world) {
        const linked = await loadLorebook(world).catch(() => null);
        if (linked) wiEntries.push(...linked.entries);
      }
    }
  }

  // The draft tools carry their own length slider, independent of the preset's
  // Max Tokens — that one is sized for in-scene character replies.
  /**
   * `null` means "the client sent no rail", which is different from "the client
   * sent Standard". Character drafts always have a rail on screen, so they fall
   * back to the default; narrator beats only get one when the Narrator panel
   * drove them, and automatic narration must keep the preset's own budget.
   */
  const sentDraftLength = draftLength == null ? null : clampDraftLength(draftLength);
  const draftLen = sentDraftLength ?? DEFAULT_DRAFT_LENGTH;
  const isWriteMe = generationType === 'suggest_user' && !isNarrator;
  const isImpersonate = generationType === 'impersonate' && !isNarrator;
  const isDraftTurn = isWriteMe || isImpersonate;
  const narratorLen = isNarrator ? sentDraftLength : null;
  /**
   * Impersonate posts straight to the transcript unless the client asked for a
   * draft. The flag is the client's, not the mode's, so an older client (or a
   * slash command) keeps the post-immediately behaviour it has always had.
   */
  const holdImpersonation = isImpersonate && draft === true;
  /**
   * Same contract for the narrator: the beat is held for review rather than
   * posted. Only the explicit Narrator button asks for this — the turn director,
   * swipe, and continue paths send no `draft` flag and still write straight to
   * the transcript, which is what keeps an automatic scene from stalling on a
   * panel nobody asked for.
   */
  const holdNarration = isNarrator && draft === true && mode !== 'swipe' && generationType !== 'continue';

  const playAsName = humanSeats.length
    ? memberCards.find((c) => c.id === humanSeats[0])?.name ?? null
    : null;
  const formatting = await loadFormatting(settings);

  const buildInputFor = (brainText?: string, skills?: { block?: string; selector?: string }): BuildInput => ({
    preset,
    card: isNarrator ? narratorCard() : card,
    persona,
    history: generationType === 'continue' ? history : history,
    wiEntries,
    group: group ? { memberCards, playAsName, narratorEnabled: group.narratorEnabled } : undefined,
    /** Cast names for narrator stop-strings (groups + solo character). */
    castNames: isNarrator ? memberCards.map((c) => c.name).filter(Boolean) : undefined,
    director: storyDirectorInjection(meta.director, history.length),
    directorState: meta.director,
    authorsNote: meta.authorsNote?.text
      ? { text: meta.authorsNote.text, depth: meta.authorsNote.depth, role: meta.authorsNote.role }
      : undefined,
    scenarioOverride: meta.scenarioOverride,
    summary: meta.summary,
    variables: meta.variables,
    model: settings.textConnection.model,
    chatIdHash: hashStr(chatId),
    generationType: isNarrator ? 'narrate' : (generationType ?? 'normal'),
    userHint: typeof hint === 'string' ? hint : undefined,
    // Narrator beats only carry a rail when one was actually sent — see `narratorLen`.
    draftLength: isNarrator ? (narratorLen ?? undefined) : draftLen,
    formatting,
    messageStyle: settings.messageStyle,
    brainContext: brainText,
    skillContext: skills?.block,
    skillSelector: skills?.selector,
    wiSettings: {
      scanDepth: settings.wiSettings.depth,
      budgetPercent: settings.wiSettings.budgetPercent,
      recursive: settings.wiSettings.recursive,
      caseSensitive: settings.wiSettings.caseSensitive,
      matchWholeWords: settings.wiSettings.matchWholeWords,
      maxRecursionSteps: settings.wiSettings.maxRecursionSteps,
    },
  });

  /**
   * Build twice: once to price the scaffolding, once for real.
   *
   * The brain block has to be *sized* before the prompt can be built, but how
   * much room it has depends on what the rest of the prompt costs — a heavy
   * system prompt, card, lorebook and writing contract can leave far less than
   * the third of the window memory would otherwise claim. The probe pass costs
   * a second local token estimate and no model call, and it is what lets memory
   * ask for what is actually free rather than being trimmed after the fact.
   */
  let plan;
  try {
    plan = buildPrompt(buildInputFor());
  } catch (err: any) {
    return res.status(500).json({ error: `Prompt build failed: ${err.message}` });
  }

  // ---- Character Brain: what this speaker actually carries in their head ----
  // Only the speaking character recalls; the narrator has no memory of its own.
  let brainBlock: Awaited<ReturnType<typeof buildBrainContext>> = null;
  if (settings.brain?.enabled !== false && !isNarrator && generationType !== 'suggest_user') {
    try {
      // Scoped to this conversation: what this character remembers *here*.
      const brain = await loadBrainIfExists(chatId, card.id);
      if (brain) {
        const cast = [
          persona.name,
          ...(group ? memberCards.map((c) => c.name) : [card.name]),
        ].filter((n, i, arr) => n && arr.indexOf(n) === i);
        brainBlock = await buildBrainContext({
          brains: [{ card, brain }],
          history,
          cast,
          conn: settings.textConnection,
          reservedOutput: preset.max_tokens,
          presetMaxContext: preset.max_context,
          fixedPromptTokens: plan.fixedTokens,
          director: meta.director,
        });
      }
    } catch (err) {
      // Memory is an enhancement, never a blocker: a broken brain must not stop a reply.
      console.error('[brain] recall failed, continuing without memory:', err);
    }
  }

  if (brainBlock?.text) {
    try {
      plan = buildPrompt(buildInputFor(brainBlock.text));
    } catch (err: any) {
      // The memory-free plan already built cleanly, so fall back to it rather
      // than failing the turn over an enhancement.
      console.error('[brain] prompt rebuild with memory failed, sending without it:', err);
    }
  }

  // Retrieval changes memory (traces, suppression, fidelity drift — §7.4).
  // Persist it off the critical path; a failed write costs one turn of bookkeeping.
  if (brainBlock?.dirty.length) {
    flushBrains(brainBlock.dirty).catch((e) => console.error('[brain] flush failed', e));
  }

  /**
   * ---- Skills: craft documents this scene has earned ----
   *
   * Two things happen here and they belong to different turns. The block being
   * injected now was decided at the *end of the previous turn*; the selector
   * appended now decides what the *next* one gets. That one-turn lag is the
   * whole reason the feature is free: the decision rides along on a reply the
   * model was writing anyway instead of costing a request of its own.
   *
   * `continue` is excluded from the selector because its output is spliced into
   * an existing message, so a routing tag would land mid-sentence rather than
   * after one.
   */
  const allowSelector =
    !isNarrator
    && generationType !== 'continue'
    && generationType !== 'suggest_user'
    && generationType !== 'impersonate';
  let skillTurn: SkillTurn | null = null;
  try {
    skillTurn = await prepareSkillTurn({
      settings,
      meta,
      history,
      characterName: card.name,
      fixedPromptTokens: plan.fixedTokens,
      brainTokens: estimateTokens(brainBlock?.text ?? ''),
      reservedOutput: preset.max_tokens,
      presetMaxContext: preset.max_context,
      allowSelector,
    });
  } catch (err) {
    // Same contract as memory: an enhancement never blocks a reply.
    console.error('[skills] preparation failed, continuing without skills:', err);
  }

  if (skillTurn && (skillTurn.block || skillTurn.selector)) {
    try {
      plan = buildPrompt(buildInputFor(brainBlock?.text, {
        block: skillTurn.block,
        selector: skillTurn.selector,
      }));
    } catch (err) {
      console.error('[skills] prompt rebuild with skills failed, sending without them:', err);
    }
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send('itemization', { items: plan.itemization, totalTokens: plan.totalTokens });
  if (skillTurn?.used.length) {
    const turn = skillTurn;
    send('skills', {
      phase: 'using',
      skills: turn.used.map((sk) => ({ id: sk.id, name: sk.name, level: turn.levels[sk.id] })),
    });
  }

  const stopExtra = [
    ...(meta.stopStrings ?? []),
    ...(preset.stop_strings ?? []),
  ].filter(Boolean);
  const stops = [...new Set([...plan.stops, ...stopExtra])].slice(0, 8);

  // Honor the user's Max Tokens slider exactly (UI min 16). Soft length guidance is also
  // injected into the prompt via buildOutputLengthCap so the model finishes under the cap.
  const outputCap = isDraftTurn
    ? DRAFT_LENGTH[draftLen].maxTokens
    : narratorLen
      ? DRAFT_LENGTH[narratorLen].maxTokens
      : Math.max(16, Math.min(16384, Math.floor(preset.max_tokens || 800)));
  const draftSeed = isDraftTurn && typeof hint === 'string' ? hint.trim() : '';
  const genParams = {
    /**
     * A scripted Write Me is transcription, not invention, and temperature is
     * where invention comes from. RP presets run hot (1.0+) so characters stay
     * surprising; that same heat is what turns "I take the gun and leave" into a
     * draft where the player reconsiders. Capped only when a script exists —
     * an unseeded draft is choosing a beat and should keep the preset's voice.
     */
    temperature: draftSeed ? Math.min(preset.temperature ?? 1, 0.6) : preset.temperature,
    top_p: preset.top_p,
    top_k: preset.top_k,
    min_p: preset.min_p,
    max_tokens: outputCap,
    frequency_penalty: preset.frequency_penalty,
    presence_penalty: preset.presence_penalty,
    repetition_penalty: preset.repetition_penalty,
    /**
     * Stop strings are speaker labels ("\nAlex:"), never prose, so they cannot
     * clip a legitimate draft — and on the draft turns they are the mechanism
     * that stops one speaker's message from continuing into everyone else's.
     */
    stops,
    stream: true as const,
  };

  let full = '';
  /**
   * The routing tag arrives at the end of the stream, one character at a time.
   * Anything already sent to the browser is on screen permanently, so deltas go
   * out through a filter that withholds any tail which could still become a tag.
   * `full` keeps the raw text — that is where the decision is read from.
   */
  const tagFilter = skillTurn?.selector ? createSkillTagFilter() : null;
  const emit = (delta: string) => {
    const visible = tagFilter ? tagFilter.push(delta) : delta;
    if (visible) send('delta', { text: visible });
  };
  let aborted = false;
  let streamHandle: Awaited<ReturnType<typeof generateText>> | null = null;
  const markAborted = () => {
    if (aborted) return;
    aborted = true;
    try { streamHandle?.abort(); } catch { /* ignore */ }
  };
  /**
   * Client Stop / tab close must cancel the provider stream.
   *
   * Do NOT use `req.on('close')` here: for POST bodies Express has already
   * finished reading the request stream, so `close`/`destroyed` fire as soon
   * as the JSON is parsed — before any tokens are generated. That left the UI
   * stuck on "Generating…" with an empty SSE response.
   *
   * Listen on the *response*: only treat as cancel when the client drops the
   * connection before we call res.end().
   */
  res.on('close', () => {
    if (!res.writableEnded) markAborted();
  });

  try {
    streamHandle = await runWithPurpose(
      `reply:${card?.name ?? 'character'}`,
      () => generateText(settings.textConnection, plan.messages, genParams),
    );
    if (aborted) {
      streamHandle.abort();
      if (!res.writableEnded) res.end();
      return;
    }
    for await (const delta of streamHandle.deltas) {
      if (aborted) {
        break;
      }
      full += delta;
      emit(delta);
    }
    if (tagFilter) {
      const tail = tagFilter.flush();
      if (tail) send('delta', { text: tail });
    }
  } catch (err: any) {
    if (aborted || err?.name === 'AbortError' || /aborted|abort/i.test(String(err?.message ?? ''))) {
      if (!res.writableEnded) res.end();
      return;
    }
    send('error', { message: err.message });
    return res.end();
  }

  // User cancelled — never save, never non-stream retry
  if (aborted) {
    if (!res.writableEnded) res.end();
    return;
  }

  // If stream produced nothing (common with some models), non-stream retry (same length cap)
  if (!full.trim()) {
    try {
      full = await generateTextComplete(settings.textConnection, plan.messages, {
        ...genParams,
        stream: false,
        max_tokens: genParams.max_tokens,
      });
      if (aborted) {
        if (!res.writableEnded) res.end();
        return;
      }
      if (full) send('delta', { text: extractSkillTag(full).text });
    } catch (err: any) {
      if (aborted || err?.name === 'AbortError') {
        if (!res.writableEnded) res.end();
        return;
      }
      send('error', { message: err.message || 'Generation returned empty' });
      return res.end();
    }
  }

  if (aborted) {
    if (!res.writableEnded) res.end();
    return;
  }

  /**
   * Read the routing decision, then remove it from the reply for good.
   *
   * Done before every other cleanup pass so no sanitizer, regex script or
   * name-prefix trimmer ever sees the tag — and so a model that put it in the
   * wrong place still gets its answer counted instead of having the brackets
   * quietly scrubbed by something further down the pipeline.
   */
  let skillDecision: { names: string[]; found: boolean } | null = null;
  if (skillTurn?.selector) {
    const tag = extractSkillTag(full);
    skillDecision = { names: tag.names, found: tag.found };
    if (tag.found) full = tag.text;
  }

  /**
   * Arm the next turn.
   *
   * The inline tag is the free path and it is tried first. When the model did
   * not produce one — plenty of models ignore trailing bookkeeping, and some
   * providers strip it — the scout runs *after* the reply has already been
   * delivered, so the fallback costs a cheap request that nobody waits for
   * rather than latency on every turn.
   */
  if (skillTurn && skillDecision?.found) {
    meta.skills = decisionFromTag(
      chatSkillState(meta), skillTurn.all, skillDecision.names, history.length, 'inline',
    );
  }
  const armSkillsInBackground = () => {
    if (!skillTurn || !allowSelector) return;
    if (skillDecision?.found) return;
    scoutAndArm({
      chatId,
      settings,
      turn: skillTurn,
      characterName: card.name,
      persona,
    }).catch((e) => console.error('[skills] arming failed', e));
  };

  // strip a leading self name-prefix the model may echo
  const speakCard = isNarrator ? narratorCard() : card;
  // Hide model CoT / INTERNAL THOUGHTS (store separately); keep in-character prose only
  const reasoningWrappers = formatting?.reasoning
    ? { prefix: formatting.reasoning.prefix, suffix: formatting.reasoning.suffix }
    : null;
  const autoParseReasoning = settings.reasoningSettings?.autoParse !== false;
  let hiddenReasoning = '';
  if (autoParseReasoning) {
    const split = splitReasoningFromOutput(full, reasoningWrappers);
    full = split.visible;
    hiddenReasoning = split.reasoning;
  }
  // Write Me speaks as the player, so the label to strip is the persona's.
  full = cleanAiReply(full, isWriteMe ? persona.name : speakCard.name, reasoningWrappers);

  /**
   * Never post another participant's lines. Stop strings are the first defence
   * but providers honour them inconsistently, so the reply is cut here too.
   * This matters most on out-of-turn replies, where the transcript ends on an
   * AI message and continuing with "{{user}}: …" is the model's natural move.
   *
   * Narrator: every cast name is "foreign" — also strip a leading Narrator: label.
   */
  if (isWriteMe) {
    /**
     * Same cut, mirrored: on a Write Me turn the characters are the foreign
     * speakers. A draft that runs on into "Maya: …" has started answering the
     * player's own line for them, so everything from that label on is dropped.
     */
    const foreignNames = [
      ...memberCards.map((c) => c.name),
      card.name,
      'Narrator',
    ];
    const trimmed = truncateAtForeignSpeaker(full, persona.name, foreignNames);
    if (trimmed !== full) {
      console.warn('[generate] Write Me draft started speaking as a character — trimmed');
      full = trimmed;
    }
  } else if (generationType !== 'suggest_user') {
    const foreignNames = isNarrator
      ? [
          persona.name,
          ...memberCards.map((c) => c.name),
          'Narrator',
        ]
      : [
          persona.name,
          ...(group ? memberCards.map((c) => c.name) : []),
        ];
    const selfForTrim = isNarrator ? '' : speakCard.name;
    const trimmed = truncateAtForeignSpeaker(full, selfForTrim, foreignNames);
    if (trimmed !== full) {
      console.warn(`[generate] trimmed a reply that began speaking as someone else (${speakCard.name})`);
      full = trimmed;
    }
  }
  if (isNarrator) {
    full = cleanNarratorReply(full, [
      persona.name,
      ...memberCards.map((c) => c.name),
      'Narrator',
    ]);
  }
  full = applyRegexScripts(full, settings.regexScripts ?? [], 'ai_output', { forDisplay: true });
  full = sanitizeAiOutput(full, reasoningWrappers);
  if (autoParseReasoning && !hiddenReasoning) {
    // Second pass may still catch patterns after name-prefix / regex cleanup
    const again = splitReasoningFromOutput(full, reasoningWrappers);
    if (again.reasoning) {
      hiddenReasoning = again.reasoning;
      full = sanitizeAiOutput(again.visible, reasoningWrappers);
    }
  }

  // Never paste the user's seed back as "generation" — that is a failure, not a reply
  const seed = typeof hint === 'string' ? hint.trim() : '';
  if (seed && full.trim().toLowerCase() === seed.toLowerCase()) {
    try {
      const retryMsgs = [
        ...plan.messages,
        {
          role: 'system' as const,
          content:
            generationType === 'suggest_user'
              ? `Your previous attempt only repeated the seed. Expand it into a FULL ${DRAFT_LENGTH[draftLen].sentences} reply as ${persona.name} (the human player) with "dialogue" and *actions*. Never write as ${card.name}. Never return only: "${seed}"`
              : isNarrator
                ? `Your previous attempt only repeated the seed. Write a FULL third-person NARRATION beat that delivers the intent of: "${seed}". No character dialogue. No "Name:" prefixes. NEVER paste the seed alone.`
                : `Your previous attempt only repeated the seed. Write a FULL first-person reply as {{char}} elaborating the idea "${seed}" with "dialogue" and *actions*. NEVER paste the seed verbatim.`,
        },
      ];
      full = await generateTextComplete(settings.textConnection, retryMsgs, {
        ...genParams,
        stream: false,
        max_tokens: genParams.max_tokens,
      });
      if (autoParseReasoning) {
        const split = splitReasoningFromOutput(full, reasoningWrappers);
        full = split.visible;
        if (split.reasoning) {
          hiddenReasoning = [hiddenReasoning, split.reasoning].filter(Boolean).join('\n\n');
        }
      }
      full = cleanAiReply(full, isWriteMe ? persona.name : speakCard.name, reasoningWrappers);
      if (isWriteMe) {
        full = truncateAtForeignSpeaker(full, persona.name, [
          ...memberCards.map((c) => c.name),
          card.name,
          'Narrator',
        ]);
      }
      if (isNarrator) {
        full = cleanNarratorReply(full, [
          persona.name,
          ...memberCards.map((c) => c.name),
          'Narrator',
        ]);
      }
    } catch {
      /* fall through */
    }
  }

  if (isNarrator && !full.trim()) {
    // Prefer a seed-aware fallback so empty/stripped model output still respects intent
    const seedBit = seed.replace(/^[*_]+|[*_]+$/g, '').trim().slice(0, 200);
    full = seedBit
      ? `*The scene leans into what was set in motion — ${seedBit} — as the world holds its breath around it.*`
      : '*The air holds for a moment. Somewhere beyond the last exchange, the world leans forward — waiting for what comes next.*';
  }

  // The whole reply was somebody else's dialogue. Say so rather than posting an
  // empty bubble in this character's name.
  if (!isNarrator && !full.trim() && generationType !== 'suggest_user' && generationType !== 'impersonate') {
    send('error', {
      message: `${speakCard.name} started writing ${persona.name}'s line instead of their own, so nothing was saved. Try again — if it keeps happening, the model is ignoring the turn rules.`,
    });
    return res.end();
  }

  /**
   * The whole draft was a character's line, so the trim above left nothing.
   * One non-streamed retry with the failure named explicitly — the alternative
   * is telling the user their model is broken when it merely picked the wrong
   * voice, and a second attempt usually lands.
   */
  if (isWriteMe && !full.trim()) {
    try {
      const retryMsgs = [
        ...plan.messages,
        {
          role: 'system' as const,
          content: [
            `Your previous attempt wrote a CHARACTER's line. That output was discarded.`,
            `Write ONLY ${persona.name}'s own message, first person (I/me/my).`,
            `Do not write dialogue, thoughts, or actions for ${[...new Set(memberCards.map((c) => c.name).concat(card.name))].join(', ')}.`,
            `No speaker labels. Output the message body only.`,
          ].join(' '),
        },
      ];
      const retryText = await generateTextComplete(settings.textConnection, retryMsgs, {
        ...genParams,
        stream: false,
      });
      let cleaned = cleanAiReply(retryText, persona.name, reasoningWrappers);
      cleaned = truncateAtForeignSpeaker(cleaned, persona.name, [
        ...memberCards.map((c) => c.name),
        card.name,
        'Narrator',
      ]);
      cleaned = sanitizeAiOutput(cleaned, reasoningWrappers);
      // No delta for the retry: whatever streamed earlier is already on screen,
      // and appending to it would show the user two drafts spliced together.
      // The client takes the final text from `done`.
      if (cleaned.trim()) full = cleaned;
    } catch {
      /* fall through to the error below */
    }
    if (!full.trim()) {
      send('error', {
        message: `Write Me kept writing as ${card.name} instead of ${persona.name}, so nothing was kept. Press Regen — if it keeps happening, the model is ignoring the POV rules.`,
      });
      return res.end();
    }
  }

  /**
   * The seed is the assignment, so a draft that wrote a different beat is a
   * failed generation — the same class of failure as a seed paste, just in the
   * other direction. One retry that names what went missing, and the better of
   * the two drafts is kept: a rewrite that scores worse would mean handing the
   * user something further from what they asked for than what we already had.
   */
  if (draftSeed && full.trim() && draftNeedsFidelityRetry(draftSeed, full)) {
    const before = draftSeedCoverage(draftSeed, full);
    // Whose message this is decides both the label to strip and who may not be voiced.
    const draftSpeaker = isWriteMe ? persona.name : speakCard.name;
    const draftForeign = [
      ...memberCards.map((c) => c.name),
      card.name,
      'Narrator',
      ...(isWriteMe ? [] : [persona.name]),
    ];
    console.warn(
      `[generate] ${isWriteMe ? 'Write Me' : 'Impersonate'} draft drifted from the seed (${
        Math.round(before.coverage * 100)
      }% kept) — retrying`,
    );
    try {
      const retryMsgs = [
        ...plan.messages,
        {
          role: 'system' as const,
          content: draftFidelityRetryPrompt({
            seed: draftSeed,
            missing: before.missing,
            speakerName: draftSpeaker,
            kind: isWriteMe ? 'user' : 'character',
          }),
        },
      ];
      const retryText = await generateTextComplete(settings.textConnection, retryMsgs, {
        ...genParams,
        stream: false,
      });
      let cleaned = cleanAiReply(retryText, draftSpeaker, reasoningWrappers);
      cleaned = truncateAtForeignSpeaker(cleaned, draftSpeaker, draftForeign);
      cleaned = sanitizeAiOutput(cleaned, reasoningWrappers);
      if (cleaned.trim() && draftSeedCoverage(draftSeed, cleaned).coverage > before.coverage) {
        full = cleaned;
      }
    } catch (err) {
      // The first draft is still a draft; the user can read it and press Regen.
      console.error('[generate] draft fidelity retry failed, keeping the first draft:', err);
    }
  }

  if ((generationType === 'suggest_user' || generationType === 'impersonate') && !full.trim()) {
    send('error', {
      message:
        generationType === 'suggest_user'
          ? 'Write Me got an empty model response. Check model/API key in Connections, then try again.'
          : 'Impersonate got an empty model response. Check model/API key in Connections, then try again.',
    });
    return res.end();
  }

  // Write Me — return draft text for composer Accept flow (never the raw seed paste)
  if (generationType === 'suggest_user') {
    send('done', { impersonated: full });
    return res.end();
  }

  /**
   * Impersonate in draft mode — the text goes back for review, not into the
   * transcript. Nothing is written here, so a declined draft leaves no trace:
   * the commit endpoint is what turns an accepted one into a message, with the
   * same timeline, summary, and memory bookkeeping a posted reply gets.
   */
  if (holdImpersonation) {
    send('done', { impersonated: full });
    return res.end();
  }

  /**
   * Narrator beat held for review — same deal, and it reuses the `impersonated`
   * field rather than inventing a second one: the client already knows which
   * panel it opened, and a parallel field would be one more thing to keep in
   * sync for no gain. An empty beat is reported as an error instead of an empty
   * panel, because the streaming path's own empty guard skips narrator turns.
   */
  if (holdNarration) {
    if (!full.trim()) {
      send('error', {
        message: 'The narrator returned nothing. Check model/API key in Connections, then press Regen.',
      });
      return res.end();
    }
    send('done', { impersonated: full });
    return res.end();
  }

  const modelExtra = {
    model: settings.textConnection.model,
    ...(hiddenReasoning ? { reasoning: hiddenReasoning } : {}),
  };

  if (generationType === 'continue' && history.length > 0) {
    const msgs = await loadMessages(chatId);
    const last = msgs.at(-1)!;
    const fullText = `${last.text} ${full}`.trim();
    const updated = applyContinueText(msgs, last.id, fullText);
    const tip = updated.at(-1)!;
    if (hiddenReasoning) {
      tip.extra = {
        ...(tip.extra ?? {}),
        ...modelExtra,
        reasoning: [tip.extra?.reasoning, hiddenReasoning].filter(Boolean).join('\n\n'),
      };
    } else {
      tip.extra = { ...(tip.extra ?? {}), model: modelExtra.model };
    }
    await saveMessages(chatId, updated);
    const loaded = await loadTimelineForChat(chatId, updated, meta);
    await saveTimeline(chatId, buildTimelineFromMessages(updated, loaded.timeline));
    // A generated reply means this conversation happened.
    meta.started = true;
    await saveChatMeta(meta);
    send('done', { message: tip });
    res.end();
    // A continued reply is still something that happened — a long scene built
    // entirely out of Continue used to form no memory at all.
    maybeConsolidateBrains(chatId).catch((e) => console.error('[brain] consolidation failed', e));
  armSkillsInBackground();
    return;
  }

  if (mode === 'swipe') {
    const msgs = await loadMessages(chatId);
    const last = msgs.at(-1);
    if (!last || last.controlledBy === 'human') {
      send('error', { message: 'Nothing to swipe — the last message is yours.' });
      return res.end();
    }
    if (targetMessageId && last.id !== targetMessageId) {
      send('error', { message: 'Swipe target is not the tip. Prepare deep swipe first.' });
      return res.end();
    }
    const updated = applySwipeText(msgs, last.id, full);
    const tip = updated.at(-1)!;
    tip.extra = { ...(tip.extra ?? {}), ...modelExtra };
    await saveMessages(chatId, updated);
    const loaded = await loadTimelineForChat(chatId, updated, meta);
    await saveTimeline(chatId, buildTimelineFromMessages(updated, loaded.timeline));
    // A generated reply means this conversation happened.
    meta.started = true;
    await saveChatMeta(meta);
    send('done', { message: tip });
    res.end();
    // Swiping does not add a message, so the cadence rarely fires here — but the
    // pass is still what heals a read position broken by a deep-swipe fork.
    maybeConsolidateBrains(chatId).catch((e) => console.error('[brain] consolidation failed', e));
  armSkillsInBackground();
    return;
  }

  const message: ChatMessage = newMessage({
    speaker: isNarrator || speakCard.id === '__narrator__'
      ? { type: 'narrator', displayName: 'Narrator' }
      : { type: 'character', characterId: speakCard.id, displayName: speakCard.name },
    controlledBy: 'ai',
    text: full,
    swipes: [full],
    swipeIndex: 0,
    extra: modelExtra,
  });
  await appendMessage(chatId, message);
  {
    const msgs = await loadMessages(chatId);
    const loaded = await loadTimelineForChat(chatId, msgs, meta);
    await saveTimeline(chatId, buildTimelineFromMessages(msgs, loaded.timeline));
  }
  meta.started = true;
  await saveChatMeta(meta);
  send('done', { message });
  res.end();

  // background: refresh summary when history grows long
  maybeSummarize(chatId).catch((e) => console.error('summarize failed', e));
  // background: let every character in the scene consolidate what just happened
  maybeConsolidateBrains(chatId).catch((e) => console.error('[brain] consolidation failed', e));
  armSkillsInBackground();
});

/**
 * Commit an accepted Impersonate draft.
 *
 * The draft never touched the transcript, so this is where it becomes a real
 * message — and it has to do the same bookkeeping the streaming path does, or a
 * scene built out of accepted impersonations would form no memory and never
 * summarise. Only the skill selector is left out: that decision belongs to a
 * turn that ran a prompt, and this endpoint runs none.
 */
generate.post('/impersonate/commit', async (req, res) => {
  const { chatId, speakerId, text } = req.body as {
    chatId?: string;
    speakerId?: string;
    text?: string;
  };
  if (!chatId || !speakerId || !text?.trim()) {
    return res.status(400).json({ error: 'chatId, speakerId and text are required.' });
  }
  try {
    const meta = await loadChatMeta(chatId);
    const settings = await loadSettings();
    const group = meta.groupId ? await loadGroup(meta.groupId) : null;
    // Same resolution as generation: the drawer's active persona wins over the
    // chat snapshot, so "who am I playing" means the same thing in both paths.
    const personas = await loadPersonas();
    const persona: Persona | null =
      personas.find((p) => p.id === (settings.activePersonaId ?? meta.personaId)) ?? personas[0] ?? null;
    const memberCards = group
      ? (await Promise.all(group.members.map((id) => loadCharacter(id).catch(() => null))))
          .filter((c): c is CharacterCard => !!c)
      : [];
    const card = group
      ? memberCards.find((c) => c.id === speakerId) ?? null
      : await loadCharacter(speakerId).catch(() => null);
    if (!card) {
      return res.status(400).json({ error: 'That character is not in this chat.' });
    }
    /**
     * The same seat rule the generation path enforces: the AI never speaks for
     * whoever the human is playing. Checked again here because an accepted
     * draft is a separate request, and "generated a while ago" is not proof the
     * seat is still free — the player may have switched to that character since.
     */
    if (group && persona) {
      const seats = humanSeatIds({ members: memberCards, playAs: group.playAs, persona });
      if (seats.includes(card.id)) {
        return res.status(400).json({
          error: `You are playing as ${card.name} now — that draft can no longer be posted in their name.`,
        });
      }
    }

    const message: ChatMessage = newMessage({
      speaker: { type: 'character', characterId: card.id, displayName: card.name },
      controlledBy: 'ai',
      text: text.trim(),
      swipes: [text.trim()],
      swipeIndex: 0,
      extra: { impersonated: true, model: settings.textConnection.model },
    });
    await appendMessage(chatId, message);
    const msgs = await loadMessages(chatId);
    const loaded = await loadTimelineForChat(chatId, msgs, meta);
    await saveTimeline(chatId, buildTimelineFromMessages(msgs, loaded.timeline));
    meta.started = true;
    await saveChatMeta(meta);
    res.json(message);

    maybeSummarize(chatId).catch((e) => console.error('summarize failed', e));
    maybeConsolidateBrains(chatId).catch((e) => console.error('[brain] consolidation failed', e));
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Could not post the impersonated message.' });
  }
});

/**
 * Commit an accepted Narrator draft.
 *
 * The Impersonate commit's sibling, and deliberately its own endpoint rather
 * than a `speakerId: '__narrator__'` special case on that one: the narrator has
 * no card, so every seat check in there is meaningless here, and the check that
 * matters — is this seat still free — has no narrator equivalent. Nobody can
 * take the narrator's seat, so an accepted beat is always postable.
 */
generate.post('/narrate/commit', async (req, res) => {
  const { chatId, text } = req.body as { chatId?: string; text?: string };
  if (!chatId || !text?.trim()) {
    return res.status(400).json({ error: 'chatId and text are required.' });
  }
  try {
    const meta = await loadChatMeta(chatId);
    const settings = await loadSettings();
    const message: ChatMessage = newMessage({
      speaker: { type: 'narrator', displayName: 'Narrator' },
      controlledBy: 'ai',
      text: text.trim(),
      swipes: [text.trim()],
      swipeIndex: 0,
      extra: { model: settings.textConnection.model },
    });
    await appendMessage(chatId, message);
    const msgs = await loadMessages(chatId);
    const loaded = await loadTimelineForChat(chatId, msgs, meta);
    await saveTimeline(chatId, buildTimelineFromMessages(msgs, loaded.timeline));
    meta.started = true;
    await saveChatMeta(meta);
    res.json(message);

    // Same bookkeeping a streamed narrator beat gets — a scene built entirely
    // out of accepted narration must still summarise and form memory.
    maybeSummarize(chatId).catch((e) => console.error('summarize failed', e));
    maybeConsolidateBrains(chatId).catch((e) => console.error('[brain] consolidation failed', e));
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Could not post the narration.' });
  }
});

/**
 * The scout path: decide the next turn's skills once this turn is already over.
 *
 * Reloads chat meta rather than reusing the caller's copy because the turn has
 * finished writing by now, and overwriting that copy would resurrect a stale
 * summary or director state alongside the skill decision.
 */
async function scoutAndArm(input: {
  chatId: string;
  settings: Awaited<ReturnType<typeof loadSettings>>;
  turn: SkillTurn;
  characterName: string;
  persona: Persona;
}): Promise<void> {
  const messages = await loadMessages(input.chatId);
  const names = await scoutSkills({
    settings: input.settings,
    turn: input.turn,
    history: messages,
    characterName: input.characterName,
    persona: input.persona,
  });
  if (!names) return;

  const meta = await loadChatMeta(input.chatId);
  meta.skills = decisionFromTag(chatSkillState(meta), input.turn.all, names, messages.length, 'scout');
  await saveChatMeta(meta);
}

/**
 * Post-turn memory maintenance.
 *
 * Runs one consolidation pass per participating character once enough new
 * messages have accumulated (`updateEveryMessages`). Sequential on purpose: two
 * passes on the same brain would race, and staggering the model calls keeps
 * rate limits happy. Every failure is swallowed — memory never breaks chat.
 */
/** Consolidation chunks one unattended turn may spend, per character. */
const AUTO_CHUNKS_PER_TURN = 3;

async function maybeConsolidateBrains(chatId: string): Promise<void> {
  const settings = await loadSettings();
  const cfg = settings.brain;
  if (cfg?.enabled === false || cfg?.autoUpdate === false) return;

  const meta = await loadChatMeta(chatId);
  const messages = await loadMessages(chatId);

  const characterIds: string[] = [];
  if (meta.groupId) {
    const group = await loadGroup(meta.groupId);
    characterIds.push(...group.members.filter((m) => !group.disabledMembers.includes(m)));
  } else if (meta.characterId) {
    characterIds.push(meta.characterId);
  }

  const conn = settings.utilityConnection ?? settings.textConnection;

  for (const characterId of characterIds) {
    try {
      let brain = await loadBrainIfExists(chatId, characterId);
      if (!brain) {
        if (cfg?.autoCreate === false) continue;
        // First contact in *this* conversation: give this character a baseline
        // before anything is encoded, so the very first appraisal already runs
        // through their own temperament.
        const card = await loadCharacter(characterId);
        brain = await ensureBrain(chatId, card, conn);
      }
      if (!brain.config.enabled) continue;
      // A mind (or a whole conversation) set to manual-only must stay manual:
      // this switch was previously read by nothing, so turning it off changed
      // the wording in the UI and nothing else.
      if (brain.config.autoUpdate === false) continue;

      const every = Math.max(1, brain.config.updateEveryMessages || cfg?.updateEveryMessages || 6);
      /**
       * Never gate on a raw message count: a rewritten history (swipe fork,
       * deleted message, branch restore) can leave the stored count past the end
       * of the transcript, and `length - count` then stays negative forever —
       * memory silently stops forming. `resolveCursor` heals that.
       */
      const cursor = resolveCursor(brain, chatId, messages);
      if (cursor.pending < every) {
        // Visible on demand: "why has nothing been encoded?" is answerable.
        console.log(
          `[brain] ${brain.characterName}: ${cursor.pending}/${every} new message(s) — waiting`
          + (cursor.repaired ? ` (read position repaired: ${cursor.note})` : ''),
        );
        // A repaired cursor must be written back even when the pass is skipped,
        // or the same bad number blocks the next turn too.
        if (cursor.repaired) {
          await repairCursor(chatId, characterId, brain.characterName, messages);
        }
        continue;
      }

      /**
       * Decline rather than queue. Consolidation makes a model call, so two
       * overlapping passes on one brain used to serialise — and a stalled call
       * froze every later pass for the whole conversation. The next turn retries.
       */
      const outcome = await tryWithBrainLock(chatId, characterId, () =>
        // Bounded: a backlog drains over the next few turns rather than firing a
        // dozen model calls behind a single reply.
        consolidateForChat(characterId, chatId, { maxChunks: AUTO_CHUNKS_PER_TURN }));
      if (!outcome.ran) {
        console.log(`[brain] ${brain.characterName}: a pass is still running — this turn skipped`);
      }
    } catch (err) {
      console.error(`[brain] ${characterId} consolidation skipped:`, err);
    }
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Name-prefix strip + full junk sanitizer (reasoning, HTML colors, time headers…). */
function cleanAiReply(
  text: string,
  speakerName: string,
  wrappers?: { prefix?: string; suffix?: string } | null,
): string {
  let full = (text ?? '').replace(new RegExp(`^\\s*${escapeRe(speakerName)}\\s*:\\s*`), '').trim();
  full = full.replace(/^\*+\s*\*+$/g, '').trim();
  return sanitizeAiOutput(full, wrappers);
}

/**
 * Narrator post-clean: drop leading speaker labels and cut if the model slipped into RP dialogue.
 * Keeps pure third-person prose; empty result lets the caller fall back.
 */
function cleanNarratorReply(text: string, castNames: string[]): string {
  let t = (text ?? '').trim();
  if (!t) return t;
  const names = [...new Set(castNames.map((n) => (n ?? '').trim()).filter(Boolean))];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const label = names.length
    ? new RegExp(
        `^[ \\t]*(?:\\*{1,2}|_{1,2}|#{1,6}[ \\t]*)?(?:${names.map(esc).join('|')})(?:\\*{1,2}|_{1,2})?[ \\t]*:[ \\t]*`,
        'i',
      )
    : null;

  // Strip one or more leading "Name:" lines (models often echo chat format)
  for (let i = 0; i < 6 && label; i++) {
    const next = t.replace(label, '').trim();
    if (next === t) break;
    t = next;
  }

  // If a cast label appears mid-body, keep only the prose before it
  if (label) {
    const mid = new RegExp(
      `[\\r\\n]+[ \\t]*(?:\\*{1,2}|_{1,2}|#{1,6}[ \\t]*)?(?:${names.map(esc).join('|')})(?:\\*{1,2}|_{1,2})?[ \\t]*:`,
      'i',
    );
    const m = mid.exec(t);
    if (m && m.index > 0) t = t.slice(0, m.index).trim();
  }

  // Pure quoted dialogue with no narrative prose → reject
  if (/^["'“][^"'”]+["'”]\s*$/.test(t)) return '';

  return t.trim();
}

async function maybeSummarize(chatId: string): Promise<void> {
  const meta = await loadChatMeta(chatId);
  const history = await loadMessages(chatId);
  if (history.length < 30 || history.length % 15 !== 0) return;
  const settings = await loadSettings();
  const conn = settings.utilityConnection ?? settings.textConnection;
  const p = summarizerPrompt(history, meta.summary);
  const summary = await generateOnce(conn, p.system, p.user, 500);
  if (summary.trim()) {
    meta.summary = summary.trim();
    await saveChatMeta(meta);
  }
}

// ---------- Author's Note expand (utility model) ----------

generate.post('/authors-note', async (req, res) => {
  const { chatId, seed, richness: richnessRaw } = req.body as {
    chatId: string;
    seed?: string;
    richness?: number;
  };
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  try {
    const ctx = await gatherContext(chatId);
    const { meta, settings, persona, history, group, memberCards, card } = ctx;
    const richness = clampAuthorsNoteRichness(richnessRaw);
    const spec = AUTHORS_NOTE_RICHNESS[richness];
    const seedText = typeof seed === 'string' ? seed : '';
    const toSlice = (c: { name: string; description: string; personality: string; scenario: string; creator_notes?: string }) => ({
      name: c.name,
      description: c.description,
      personality: c.personality,
      scenario: c.scenario,
      creator_notes: c.creator_notes,
    });
    const cast = group
      ? memberCards.map(toSlice)
      : card
        ? [toSlice(card)]
        : [];

    const prompt = authorsNoteExpandPrompt({
      seed: seedText,
      existingNote: meta.authorsNote?.text,
      cast,
      personaName: persona?.name,
      personaDescription: persona?.description,
      history,
      isGroup: !!group,
      richness,
      summary: meta.summary,
      scenarioOverride: meta.scenarioOverride,
      director: meta.director,
    });
    const conn = settings.utilityConnection ?? settings.textConnection;
    const strip = (raw: string) =>
      (raw || '').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();

    let text = strip(await generateOnce(conn, prompt.system, prompt.user, spec.maxTokens));
    if (text && authorsNoteNeedsRetry(text, seedText, richness)) {
      const retry = authorsNoteExpandRetryPrompt({ seed: seedText, draft: text, richness });
      const expanded = strip(await generateOnce(conn, retry.system, retry.user, spec.maxTokens));
      if (authorsNoteWordCount(expanded) > authorsNoteWordCount(text)) text = expanded;
    }
    /**
     * The note must not narrate its own sources. One rewrite, then a scrub —
     * "as the seed mentions…" is the exact tell users notice, and it survives
     * the system prompt often enough to need a check after the fact.
     */
    if (text && authorsNoteMetaLeak(text)) {
      try {
        const fix = authorsNoteDemetaPrompt({ draft: text, richness });
        const clean = strip(await generateOnce(conn, fix.system, fix.user, spec.maxTokens));
        if (clean && !authorsNoteMetaLeak(clean) && authorsNoteWordCount(clean) >= authorsNoteWordCount(text) * 0.6) {
          text = clean;
        }
      } catch {
        /* fall through to the local scrub */
      }
      if (authorsNoteMetaLeak(text)) text = stripAuthorsNoteMeta(text);
    }
    if (!text) return res.status(502).json({ error: 'Model returned an empty author\'s note. Try again.' });
    res.json({ text, richness, words: authorsNoteWordCount(text) });
  } catch (err: any) {
    res.status(502).json({ error: err.message ?? 'Author\'s note expand failed' });
  }
});

// ---------- Proofread ----------

/**
 * Fix the spelling and grammar of what the user typed, and nothing else.
 *
 * Deliberately not part of `/generate`: this must not stream into the composer,
 * must not touch the transcript, must not consume a turn, and must not use the
 * roleplay preset (whose temperature and penalties exist to make prose
 * *interesting* — the opposite of what a proofreader needs). It runs on the
 * utility model at near-zero temperature and returns one string.
 */
generate.post('/proofread', async (req, res) => {
  const { text, chatId } = req.body as { text?: string; chatId?: string };
  const source = typeof text === 'string' ? text : '';
  if (!source.trim()) return res.status(400).json({ error: 'Nothing to proofread — write something first.' });
  // Long enough for a very long roleplay post, short enough that a runaway
  // paste cannot turn into an expensive call.
  if (source.length > 6000) {
    return res.status(400).json({ error: 'That message is too long to proofread in one go (6000 characters max).' });
  }

  try {
    const settings = await loadSettings();
    let personaName: string | undefined;
    let cast: string[] = [];
    let history: ChatMessage[] = [];
    if (chatId) {
      // Best-effort: proofreading must still work outside a chat context.
      try {
        const ctx = await gatherContext(chatId);
        personaName = ctx.persona?.name;
        cast = [
          ...(ctx.group ? ctx.memberCards.map((c) => c.name) : ctx.card ? [ctx.card.name] : []),
          ...(ctx.persona?.name ? [ctx.persona.name] : []),
        ].filter((n, i, arr) => n && arr.indexOf(n) === i);
        history = ctx.history;
      } catch {
        /* no chat context — proofread the text on its own */
      }
    }

    const prompt = proofreadPrompt({ text: source, personaName, cast, history });
    const conn = settings.utilityConnection ?? settings.textConnection;
    // Headroom over the input: corrections and a closed clause, never an essay.
    const maxTokens = Math.min(2000, Math.max(200, Math.ceil(source.length / 2) + 200));
    const raw = await runWithPurpose('proofread', () =>
      generateOnce(conn, prompt.system, prompt.user, { maxTokens, temperature: 0.1 }));

    const cleaned = cleanProofread(raw, source);
    if (!cleaned) {
      return res.status(502).json({ error: 'The model returned nothing usable. Check the utility model in Connections.' });
    }
    res.json({ text: cleaned, changed: cleaned !== source });
  } catch (err: any) {
    res.status(502).json({ error: err.message ?? 'Proofread failed.' });
  }
});

/**
 * Strip the wrappers models add around a "return only the text" answer.
 *
 * The length guard at the end is the real protection: a model that ignored the
 * brief and continued the scene produces something far longer than the input,
 * and silently pasting that over the user's own words would be the worst
 * possible failure for this feature — so we return the original instead.
 */
export function cleanProofread(raw: string, original: string): string {
  let out = String(raw ?? '')
    .replace(/^\s*```[a-z]*\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  // Preambles: "Corrected message:", "Here is the corrected text:", "Sure! ..."
  out = out.replace(
    /^(?:sure[,!.]?\s*)?(?:here(?:'s| is| are)?\s+(?:the\s+)?)?(?:corrected|proofread|revised|fixed|polished)(?:\s+(?:message|text|version|line))?\s*:\s*/i,
    '',
  ).trim();

  /**
   * Un-quote only when the model wrapped the *whole* answer and the original was
   * not itself a single quoted line — roleplay dialogue is legitimately quoted,
   * and stripping a user's own quotation marks would break their formatting.
   */
  const wrapped = /^"[\s\S]*"$/.test(out) || /^'[\s\S]*'$/.test(out) || /^“[\s\S]*”$/.test(out);
  const originalWrapped = /^"[\s\S]*"$/.test(original.trim()) || /^“[\s\S]*”$/.test(original.trim());
  if (wrapped && !originalWrapped && !out.slice(1, -1).includes('"')) {
    out = out.slice(1, -1).trim();
  }

  if (!out) return '';
  // A proofread is a correction, not a rewrite: allow real headroom for closing an
  // unfinished thought, but reject a model that took over the turn.
  const ceiling = Math.max(original.trim().length * 1.8 + 80, 120);
  if (out.length > ceiling) return original;
  return out;
}

// ---------- Turn Director ----------

generate.post('/turn', async (req, res) => {
  const { chatId } = req.body as { chatId: string };
  const ctx = await gatherContext(chatId);
  const { meta, settings, persona, history, group, memberCards } = ctx;
  if (!group) return res.status(400).json({ error: 'Turn Director requires a group chat.' });

  const recentCounts = new Map<string, number>();
  for (const m of history.slice(-10)) {
    if (m.speaker.characterId) recentCounts.set(m.speaker.characterId, (recentCounts.get(m.speaker.characterId) ?? 0) + 1);
  }

  // Every seat the human occupies (play-as and/or the active persona's own card)
  const humanSeats = humanSeatIds({ members: memberCards, playAs: group.playAs, persona });
  const playAsCard = memberCards.find((c) => c.id === humanSeats[0]) ?? null;
  const aiEligible = memberCards.filter(
    (c) => !group.disabledMembers.includes(c.id) && !humanSeats.includes(c.id),
  );

  const prompt = turnDirectorPrompt({
    members: memberCards
      .filter((c) => !group.disabledMembers.includes(c.id))
      .map((c) => ({ card: c, playedByUser: humanSeats.includes(c.id), recentTurns: recentCounts.get(c.id) ?? 0 })),
    persona,
    history,
    narratorEnabled: group.narratorEnabled,
    genesisEnabled: group.genesisEnabled,
    director: meta.director,
    playAsName: playAsCard?.name ?? null,
  });

  const conn = settings.utilityConnection ?? settings.textConnection;
  let decision: TurnDirectorDecision | null = null;
  try {
    // Only AI-eligible names count as character picks (play-as is not a valid AI next)
    const raw = await generateOnce(conn, prompt.system, prompt.user, 300);
    decision = parseTurnDecision(raw, aiEligible.map((c) => c.name), {
      narratorEnabled: group.narratorEnabled,
      genesisEnabled: group.genesisEnabled,
    });
  } catch (err: any) {
    return res.status(502).json({ error: `Turn Director call failed: ${err.message}` });
  }
  if (!decision) {
    // deterministic fallback: least-recent AI-eligible speaker
    const fallback = aiEligible.sort((a, b) => (recentCounts.get(a.id) ?? 0) - (recentCounts.get(b.id) ?? 0))[0];
    decision = { next: fallback?.name ?? 'USER', reason: 'Fallback: model returned unparseable output.', urgency: 'reply', alternates: [] };
  }
  // Hard rule: human-controlled character → USER turn (never AI dual-control)
  const humanPick = memberCards.find(
    (c) => humanSeats.includes(c.id) && c.name.toLowerCase() === decision!.next.toLowerCase(),
  );
  if (humanPick) {
    decision = {
      ...decision,
      next: 'USER',
      reason: `${humanPick.name} is played by you — waiting on your line.`,
      urgency: 'await_user',
    };
  }
  const speakerCard = aiEligible.find((c) => c.name === decision!.next);
  res.json({
    ...decision,
    speakerId:
      decision.next === 'NARRATOR' ? '__narrator__'
        : decision.next === 'USER' ? null
          : speakerCard?.id ?? null,
  });
});

// ---------- Genesis ----------

/** Lightweight scan: does the scene need a brand-new character? */
generate.post('/genesis/scan', async (req, res) => {
  const { chatId } = req.body as { chatId: string };
  if (!chatId) return res.status(400).json({ error: 'chatId required' });
  try {
    const ctx = await gatherContext(chatId);
    const { settings, history, group, memberCards } = ctx;
    if (!group) return res.status(400).json({ error: 'Genesis scan requires a group chat.' });
    if (!group.genesisEnabled) return res.json({ needed: false, hint: '' });

    const conn = settings.utilityConnection ?? settings.textConnection;
    const p = genesisNeedScanPrompt({
      history,
      existingNames: memberCards.map((c) => c.name),
    });
    const raw = await generateOnce(conn, p.system, p.user, 200);
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : { needed: false, hint: '' };
    res.json({
      needed: !!parsed.needed,
      hint: String(parsed.hint ?? '').trim(),
    });
  } catch (err: any) {
    res.status(502).json({ error: err.message ?? 'Genesis scan failed' });
  }
});

generate.post('/genesis', async (req, res) => {
  const { chatId, hint } = req.body as { chatId: string; hint: string };
  const ctx = await gatherContext(chatId);
  const { settings, history, group, memberCards } = ctx;
  if (!group) return res.status(400).json({ error: 'Genesis requires a group chat.' });

  const conn = settings.utilityConnection ?? settings.textConnection;
  const p = genesisPrompt({
    hint: hint || 'The scene calls for someone new.',
    history,
    existingNames: memberCards.map((c) => c.name),
  });
  let draft: any;
  try {
    const raw = await generateOnce(conn, p.system, p.user, 1500);
    const m = raw.match(/\{[\s\S]*\}/);
    draft = m ? JSON.parse(m[0]) : null;
  } catch (err: any) {
    return res.status(502).json({ error: `Genesis draft failed: ${err.message}` });
  }
  if (!draft?.name) return res.status(502).json({ error: 'Genesis produced an invalid character draft. Try again.' });

  const id = `${String(draft.name).toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID().slice(0, 8)}`;
  const card: CharacterCard = {
    id,
    name: String(draft.name),
    description: String(draft.description ?? ''),
    personality: String(draft.personality ?? ''),
    scenario: '',
    first_mes: String(draft.first_mes ?? ''),
    mes_example: '',
    creator_notes: `Created by Genesis in scene. Reason: ${hint}`,
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: Array.isArray(draft.tags) ? draft.tags.map(String) : [],
    creator: 'Reverie Genesis',
    character_version: '1',
    extensions: {
      talkativeness: 0.5,
      genesis: true,
      genesisHint: hint,
    },
    createdAt: Date.now(),
  };

  // Match group art style: use existing styleProfile or analyze member avatars first
  let styleProfile = group.styleProfile;
  if (!styleProfile) {
    try {
      const withAvatars = memberCards.filter((c) => c.avatar);
      const images: { mime: string; b64: string }[] = [];
      for (const c of withAvatars.slice(0, 6)) {
        try {
          const buf = await readBlob(path.join(dirs.avatars, `${c.id}.png`));
          images.push({ mime: 'image/png', b64: buf.toString('base64') });
        } catch { /* skip */ }
      }
      if (images.length) {
        const sp = styleAnalystPrompt(withAvatars.map((c) => c.name));
        const styleScan = await visionScan(
          settings,
          sp,
          {
            instruction: PORTRAIT_CAPTION_INSTRUCTION,
            fromDescriptions: (d) => styleAnalystFromDescriptionsPrompt(withAvatars.map((c) => c.name), d),
          },
          images,
          { maxTokens: 400 },
        );
        const sm = styleScan.text.match(/\{[\s\S]*\}/);
        const parsed = sm ? JSON.parse(sm[0]) : null;
        if (parsed?.medium) {
          styleProfile = {
            medium: String(parsed.medium),
            keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String).slice(0, 8) : [],
            palette: parsed.palette ? String(parsed.palette) : undefined,
            confidence: Number(parsed.confidence) || 0.5,
            analyzedAt: Date.now(),
          };
          group.styleProfile = styleProfile;
          await writeJsonAtomic(path.join(dirs.groups, `${group.id}.json`), group);
        }
      }
    } catch {
      /* style optional */
    }
  }

  // avatar: image API or prompt card for manual gen + drop-in
  let promptCard: string | null = null;
  const sceneBit = [
    String(draft.appearance_summary ?? ''),
    history.slice(-3).map((m) => `${m.speaker.displayName}: ${m.text}`).join('\n').slice(0, 600),
  ].filter(Boolean).join('\n');
  const ip = imageDirectorPrompt({
    purpose: 'avatar',
    subjectCard: card,
    sceneExcerpt: sceneBit,
    styleProfile,
  });
  try {
    const rawPrompt = await generateOnce(conn, ip.system, ip.user, 400);
    const pm = rawPrompt.match(/\{[\s\S]*\}/);
    const parsed = pm ? JSON.parse(pm[0]) : { prompt: rawPrompt };
    const imagePrompt: string = String(parsed.prompt ?? rawPrompt).trim();
    try {
      const img = await generateImage(settings.imageConnection, {
        prompt: imagePrompt,
        negative: parsed.negative || undefined,
        aspect: '3:4',
      });
      await writeBlob(path.join(dirs.avatars, `${id}.png`), Buffer.from(img.b64, 'base64'));
      card.avatar = `/api/avatars/${id}.png?v=${Date.now()}`;
    } catch {
      // No image API / failure → store prompt for UI frame + copy + later drop
      promptCard = imagePrompt;
      card.extensions = {
        ...card.extensions,
        pendingImagePrompt: imagePrompt,
      };
    }
  } catch {
    promptCard = null;
  }

  await writeJsonAtomic(path.join(dirs.characters, `${id}.json`), card);
  res.json({ card, promptCard, styleProfile: styleProfile ?? null });
});

// ---------- Character Creator: gist expand + vision physical ----------

function clampAge(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 22;
  return Math.max(19, Math.min(120, v));
}

/** Normalize vision JSON that might wrap physical under pack / physical keys. */
function unwrapPhysical(parsed: any): any {
  if (!parsed || typeof parsed !== 'object') return parsed;
  if (parsed.physical && typeof parsed.physical === 'object') return parsed.physical;
  if (parsed.pack?.physical && typeof parsed.pack.physical === 'object') return parsed.pack.physical;
  return parsed;
}

generate.post('/characters/generate', async (req, res) => {
  const body = req.body as {
    gist?: string;
    setting?: SettingKind;
    nameHint?: string;
    physicalLock?: unknown;
    existingPartial?: Record<string, unknown>;
  };
  const gist = (body.gist ?? '').trim();
  if (!gist && !body.physicalLock) {
    return res.status(400).json({ error: 'Provide a character gist (or run image analysis first).' });
  }
  const setting = (body.setting ?? 'modern') as SettingKind;
  try {
    const settings = await loadSettings();
    const conn = settings.utilityConnection ?? settings.textConnection;
    const p = characterGistGeneratePrompt({
      gist: gist || 'Build a full character consistent with the physical lock and setting.',
      setting,
      nameHint: body.nameHint,
      physicalLock: body.physicalLock,
      existingPartial: body.existingPartial,
    });
    // High token budget + JSON mode: Gemini Flash often truncated mid-object at ~2k
    const raw = await generateOnce(conn, p.system, p.user, {
      maxTokens: 8192,
      temperature: 0.45,
      jsonMode: true,
    });
    let parsed = parseModelJson(raw, 'AI Fill');
    // Unwrap accidental { character: { ... } } or stringified fields
    if (parsed.character && typeof parsed.character === 'object') {
      parsed = { ...parsed.character, pack: parsed.pack ?? parsed.character.pack };
    }
    for (const key of ['description', 'personality', 'first_mes'] as const) {
      const v = parsed[key];
      if (typeof v === 'string' && v.trim().startsWith('{')) {
        try {
          const inner = parseModelJson(v, key);
          const src = inner.character || inner;
          if (src[key]) parsed[key] = src[key];
          else if (src.description && key === 'description') parsed[key] = src.description;
        } catch { /* keep */ }
      }
    }
    if (parsed.pack?.physical) {
      parsed.pack.physical.age = clampAge(parsed.pack.physical.age);
    }
    const pack = parsed.pack as CharacterCreatorPack | undefined;
    // Fill ST fields from pack if model skimped
    if (pack?.physical) {
      if (!parsed.description?.trim() || String(parsed.description).trim().startsWith('{')) {
        parsed.description = packToDescription(pack);
      }
      if (!parsed.personality?.trim() || String(parsed.personality).trim().startsWith('{')) {
        parsed.personality = packToPersonality(pack);
      }
    }
    res.json({
      name: String(parsed.name ?? body.nameHint ?? 'Unnamed').slice(0, 80),
      description: String(parsed.description ?? ''),
      personality: String(parsed.personality ?? ''),
      // No scenario — the card does not author one; the chat's Author's Note does.
      first_mes: String(parsed.first_mes ?? ''),
      mes_example: String(parsed.mes_example ?? ''),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String).slice(0, 12) : [],
      system_prompt: String(parsed.system_prompt ?? ''),
      post_history_instructions: String(parsed.post_history_instructions ?? ''),
      creator_notes: String(parsed.creator_notes ?? ''),
      pack: pack ?? null,
    });
  } catch (err: any) {
    res.status(502).json({ error: err.message ?? 'Character generation failed' });
  }
});

/**
 * What the on-device model is asked for. Deliberately a description, not a
 * schema: it is the one thing small VLMs do well, and everything downstream is
 * built from these words.
 */
const PORTRAIT_CAPTION_INSTRUCTION = [
  'Describe this person in exhaustive physical detail.',
  'Cover: apparent adult age, sex and gender presentation, ethnicity, build and body type,',
  'height impression, skin tone and marks, face shape, jaw, cheekbones, nose, lips,',
  'eye colour and shape, eyebrows, hair colour, length, texture and style,',
  'clothing and jewellery, and any distinguishing marks such as scars or tattoos.',
  'Also state the art style of the image (photo, anime, digital painting, 3D render).',
  'Describe only what you can actually see. Do not invent details.',
].join(' ');

/**
 * Vision entry point for every path that handles a user's own images.
 *
 * Local-first by design: the picture is described on-device and only the
 * resulting text is ever eligible to travel. Falling through to a cloud vision
 * model is still possible, but never silent — it takes an explicit opt-out of
 * strict mode, because a quiet fallback would break the one promise this path
 * makes.
 */
async function visionScan(
  settings: AppSettings,
  /** Used only when a cloud vision model is allowed to see the image itself. */
  cloud: { system: string; user: string },
  /**
   * The local route. A small on-device model writes what it sees, then the
   * already-configured text model turns those words into the structure the
   * caller wants. Splitting it this way is what keeps the image at home, and it
   * is also more accurate: small models describe far better than they emit JSON.
   */
  local: {
    instruction: string;
    fromDescriptions: (descriptions: string[]) => { system: string; user: string };
  },
  images: LocalVisionImage[],
  opts: LocalVisionOpts = {},
): Promise<{ text: string; local: boolean; model?: string; descriptions?: string[] }> {
  const cfg: LocalVisionConfig = { ...DEFAULT_LOCAL_VISION, ...(settings.localVision ?? {}) };
  const conn = settings.utilityConnection ?? settings.textConnection;

  if (cfg.enabled) {
    try {
      const descriptions: string[] = [];
      for (const img of images) {
        descriptions.push(await generateOnceLocalVision(cfg, '', local.instruction, [img], opts));
      }
      const p = local.fromDescriptions(descriptions);
      const text = await generateOnce(conn, p.system, p.user, {
        maxTokens: opts.maxTokens ?? 1200,
        temperature: opts.temperature ?? 0.25,
      });
      return { text, local: true, model: VISION_MODEL.id, descriptions };
    } catch (err: any) {
      // Strict mode is the whole guarantee: if the on-device pass could not do
      // it, the image stays here and the scan fails loudly.
      if (cfg.strict) {
        const e: any = new Error(`On-device image scan failed: ${err?.message ?? err}`);
        e.status = 503;
        throw e;
      }
    }
  }

  const text = await generateOnceVision(conn, cloud.system, cloud.user, images, {
    maxTokens: opts.maxTokens,
    temperature: opts.temperature,
    jsonMode: opts.jsonMode,
  });
  return { text, local: false };
}

/** Lets the UI tell the truth about where a scan will run, and show download progress. */
generate.get('/local-vision/status', async (_req, res) => {
  const settings = await loadSettings();
  const cfg: LocalVisionConfig = { ...DEFAULT_LOCAL_VISION, ...(settings.localVision ?? {}) };
  const status = await detectLocalVision(cfg);
  res.json({
    ...status,
    strict: cfg.strict,
    enabled: cfg.enabled,
    maxEdge: cfg.maxEdge,
  });
});

/** Fetch + load the weights now, so the first real scan is not the slow one. */
generate.post('/local-vision/warmup', async (_req, res) => {
  const settings = await loadSettings();
  const cfg: LocalVisionConfig = { ...DEFAULT_LOCAL_VISION, ...(settings.localVision ?? {}) };
  // Deliberately not awaited: the download can run for minutes and the client
  // polls /local-vision/status for progress instead of holding a request open.
  void warmupLocalVision(cfg).catch(() => { /* surfaced through loadState */ });
  res.json({ started: true, model: VISION_MODEL.id });
});

generate.post('/characters/analyze-image', async (req, res) => {
  const { imageBase64, mime } = req.body as { imageBase64?: string; mime?: string };
  if (!imageBase64?.trim()) {
    return res.status(400).json({ error: 'imageBase64 required' });
  }
  // strip data-url prefix if present
  let b64 = imageBase64.trim();
  let mediaType = mime || 'image/png';
  const dataUrl = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(b64);
  if (dataUrl) {
    mediaType = dataUrl[1];
    b64 = dataUrl[2];
  }
  try {
    const settings = await loadSettings();
    const scan = await visionScan(
      settings,
      characterVisionPhysicalPrompt(),
      {
        instruction: PORTRAIT_CAPTION_INSTRUCTION,
        fromDescriptions: (d) => physicalFromDescriptionPrompt(d[0] ?? ''),
      },
      [{ mime: mediaType, b64 }],
      { maxTokens: 4096, temperature: 0.25, jsonMode: true },
    );
    const physical = unwrapPhysical(parseModelJson(scan.text, 'AI Scan'));
    physical.age = clampAge(physical.age);
    res.json({
      physical,
      analyzedAt: Date.now(),
      local: scan.local,
      model: scan.model,
      // Handy for "why did it say that?" — the words the local model actually saw.
      description: scan.descriptions?.[0],
    });
  } catch (err: any) {
    res.status(err?.status ?? 502).json({ error: err.message ?? 'Image analysis failed', setup: err?.setup });
  }
});

// ---------- Style Analyst (vision over member avatars) ----------

generate.post('/groups/:id/style-profile', async (req, res) => {
  const group = await loadGroup(req.params.id);
  const settings = await loadSettings();
  const cards = await Promise.all(group.members.map((m) => loadCharacter(m).catch(() => null)));
  const withAvatars = cards.filter((c): c is CharacterCard => !!c?.avatar);
  if (!withAvatars.length) {
    return res.status(400).json({ error: 'No member has an avatar yet — add portraits first, then analyze.' });
  }
  const images = [];
  for (const c of withAvatars.slice(0, 6)) {
    try {
      const buf = await readBlob(path.join(dirs.avatars, `${c.id}.png`));
      images.push({ mime: 'image/png', b64: buf.toString('base64') });
    } catch { /* member without stored avatar file */ }
  }
  if (!images.length) return res.status(400).json({ error: 'Avatar files not found on disk.' });

  const p = styleAnalystPrompt(withAvatars.map((c) => c.name));
  let profile;
  try {
    const scan = await visionScan(settings, p, { instruction: PORTRAIT_CAPTION_INSTRUCTION, fromDescriptions: (d) => styleAnalystFromDescriptionsPrompt(withAvatars.map((c) => c.name), d) }, images, { maxTokens: 400 });
    const m = scan.text.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    if (!parsed?.medium) throw new Error('Model returned no parseable style profile.');
    profile = {
      medium: String(parsed.medium),
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String).slice(0, 8) : [],
      palette: parsed.palette ? String(parsed.palette) : undefined,
      confidence: Number(parsed.confidence) || 0.5,
      analyzedAt: Date.now(),
    };
  } catch (err: any) {
    return res.status(err?.status ?? 502).json({ error: `Style analysis failed: ${err.message}`, setup: err?.setup });
  }
  const { writeJsonAtomic: writeJson } = await import('../storage');
  const updated = { ...group, styleProfile: profile };
  await writeJson(path.join(dirs.groups, `${group.id}.json`), updated);
  res.json(profile);
});

// ---------- Model catalogs (live + searchable) ----------

generate.get('/models', async (req, res) => {
  const provider = String(req.query.provider ?? '');
  const kind = (String(req.query.kind ?? 'text') === 'image' ? 'image' : 'text') as ModelKind;
  const q = typeof req.query.q === 'string' ? req.query.q : undefined;
  const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
  if (!provider) return res.status(400).json({ error: 'provider required' });
  try {
    const result = await listProviderModels(provider, kind, q, { refresh });
    res.json(result);
  } catch (err: any) {
    res.status(502).json({ error: err.message ?? 'Failed to list models', models: [], source: 'fallback' });
  }
});

// ---------- Images ----------

generate.get('/images/catalog', (_req, res) => res.json(IMAGE_CATALOG));

generate.post('/images/generate', async (req, res) => {
  const { prompt, negative, aspect, purpose, characterId, chatId } = req.body as {
    prompt?: string; negative?: string; aspect?: '1:1' | '3:4' | '4:3' | '16:9' | '9:16';
    purpose?: 'avatar' | 'scene' | 'card_art'; characterId?: string; chatId?: string;
  };
  const settings = await loadSettings();
  const conn = settings.utilityConnection ?? settings.textConnection;

  let finalPrompt = prompt;
  let finalNegative = negative;
  if (!finalPrompt) {
    // compose via Image Director from context
    const subjectCard = characterId ? await loadCharacter(characterId) : undefined;
    let sceneExcerpt: string | undefined;
    let styleProfile;
    if (chatId) {
      const meta = await loadChatMeta(chatId);
      const history = await loadMessages(chatId);
      sceneExcerpt = history.slice(-6).map((m) => `${m.speaker.displayName}: ${m.text}`).join('\n');
      if (meta.groupId) styleProfile = (await loadGroup(meta.groupId)).styleProfile;
    }
    const ip = imageDirectorPrompt({ purpose: purpose ?? 'scene', subjectCard, sceneExcerpt, styleProfile });
    const raw = await generateOnce(conn, ip.system, ip.user, 400);
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : { prompt: raw };
    finalPrompt = parsed.prompt ?? raw;
    finalNegative = parsed.negative || undefined;
  }

  try {
    const img = await generateImage(settings.imageConnection, { prompt: finalPrompt!, negative: finalNegative, aspect: aspect ?? '1:1' });
    const imageId = randomUUID();
    await writeBlob(path.join(dirs.images, `${imageId}.png`), Buffer.from(img.b64, 'base64'));
    await writeJsonAtomic(path.join(dirs.images, `${imageId}.meta.json`), { prompt: finalPrompt, negative: finalNegative, model: img.model, ts: Date.now() });
    res.json({ imageId, url: `/api/images/${imageId}.png`, prompt: finalPrompt });
  } catch (err: any) {
    if (String(err.message).includes('NO_IMAGE_API')) {
      return res.json({ imageId: null, url: null, prompt: finalPrompt, promptCard: true });
    }
    res.status(502).json({ error: err.message, prompt: finalPrompt });
  }
});

generate.get('/images/:file', async (req, res) => {
  try {
    res.setHeader('Content-Type', 'image/png');
    res.send(await readBlob(path.join(dirs.images, req.params.file.replace(/[^a-zA-Z0-9.-]/g, ''))));
  } catch {
    res.status(404).end();
  }
});
