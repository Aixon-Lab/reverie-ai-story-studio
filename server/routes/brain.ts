/**
 * Character Brain API — see docs/brain-system.md §6.
 *
 * Every brain is addressed by the pair `(chatId, characterId)`: a mind belongs
 * to one conversation. The same character in another chat has a separate,
 * independent memory.
 */
import { Router } from 'express';
import { baseLevel, recallProbability } from '../../shared/brain/activation';
import { buildIndex } from '../../shared/brain/graph';
import { cueFromContext, recall } from '../../shared/brain/retrieval';
import { brainDemandTokens, memoryHealth } from '../../shared/brain/compose';
import { forecastDecay, stpTerm } from '../../shared/brain/synapse';
import { setSteer, ttlFromIntensity, type IntentionKind } from '../../shared/brain/volition';
import { liveWorking } from '../../shared/brain/working';
import { describeWarrant } from '../../shared/brain/warrant';
import { planContext, estimateBrainTokens } from '../../shared/brain/budget';
import { planChunks, transcriptBudget } from '../../shared/brain/chunking';
import { estimateTokens } from '../../shared/engine/tokens';
import { DEFAULT_PARAMS, MAX_BRAIN_SHARE } from '../../shared/brain/defaults';
import type { BrainState, MemoryNode } from '../../shared/brain/types';
import type { ChatMeta } from '../../shared/types';
import {
  clampCadence, commonConfig, resolveBrainConfig, sanitizeConfigPatch, type BrainConfigFields,
} from '../../shared/brain/config';
import { resolveContextLimit } from '../providers/contextLimits';
import { loadCharacter, loadSettings } from './library';
import { loadChatMeta, loadGroup, loadMessages, saveChatMeta } from './chats';
import {
  appendAudit, brainBusy, deleteBrain, listBrainRefs, loadBrain, loadBrainIfExists, readAudit, saveBrain,
  withBrainLock,
} from '../brain/store';
import { resolveCursor, runConsolidation } from '../brain/service';
import { ensureBrain } from '../brain/provision';
import { activeBrainJob, cancelBrainJob, getBrainJob, startBrainJob } from '../brain/jobs';
import { route } from '../providers/router';
import { readIdentity } from '../brain/psycheStep';
import {
  describeBond, describeCondition, describeCopingStyle, describeLifeStory,
  describeSelfConcept, traumaStatus,
} from '../../shared/psyche';

export const brainRoutes = Router();

/**
 * Messages one pass may read, whatever the token budget allows. A chunk is meant
 * to be a scene the encoder can hold in mind at once; a hundred short lines is
 * not that, however cheap they are.
 */
const MAX_MESSAGES_PER_CHUNK = 40;
/** A trailing stub smaller than this rides along with the pass before it. */
const MIN_TAIL_MESSAGES = 6;

// ---------- listing ----------

/** Every mind on disk, newest first, tagged with the chat it belongs to. */
brainRoutes.get('/brains', async (_req, res) => {
  const refs = await listBrainRefs();
  const out = [];
  for (const ref of refs) {
    const brain = await loadBrainIfExists(ref.chatId, ref.characterId);
    if (!brain) continue;
    let chatTitle = '';
    try {
      chatTitle = (await loadChatMeta(ref.chatId)).title;
    } catch {
      // Chat is gone but its brain file lingered — surface it so it can be cleaned up.
      chatTitle = '(deleted conversation)';
    }
    out.push({ ...summary(brain), chatTitle });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  res.json(out);
});

/** The human-settable half of a brain's config (no `params`). */
function configFields(brain: BrainState): BrainConfigFields {
  const c = brain.config;
  return {
    enabled: c.enabled,
    autoUpdate: c.autoUpdate,
    updateEveryMessages: c.updateEveryMessages,
    shareOfContext: c.shareOfContext,
    traumaEnabled: c.traumaEnabled,
    intrusionsEnabled: c.intrusionsEnabled,
    confabulation: c.confabulation,
  };
}

function summary(brain: BrainState) {
  const nodes = Object.values(brain.nodes);
  return {
    chatId: brain.chatId,
    characterId: brain.characterId,
    characterName: brain.characterName,
    updatedAt: brain.updatedAt,
    createdAt: brain.createdAt,
    enabled: brain.config.enabled,
    counts: {
      total: nodes.length,
      active: nodes.filter((n) => n.status === 'active').length,
      faded: nodes.filter((n) => n.status === 'faded').length,
      dormant: nodes.filter((n) => n.status === 'dormant').length,
      identity: nodes.filter((n) => n.kind === 'identity').length,
      schema: nodes.filter((n) => n.kind === 'schema').length,
      semantic: nodes.filter((n) => n.kind === 'semantic').length,
      traumatic: nodes.filter((n) => n.kind === 'sensory').length,
      edges: brain.edges.length,
      people: Object.keys(brain.people).length,
    },
    mood: brain.mood,
    stats: brain.stats,
  };
}

// ---------- one conversation's whole cast ----------

/** Every character in a chat, whether or not they have started remembering. */
async function castOf(chatId: string): Promise<{ meta: ChatMeta; ids: string[]; mutedIds: string[] }> {
  const meta = await loadChatMeta(chatId);
  if (meta.groupId) {
    const group = await loadGroup(meta.groupId);
    return { meta, ids: [...group.members], mutedIds: [...group.disabledMembers] };
  }
  return { meta, ids: meta.characterId ? [meta.characterId] : [], mutedIds: [] };
}

/**
 * Group memory overview.
 *
 * One call answers everything the screen needs: who is in the scene, what each
 * of them remembers, how far each is from its next consolidation, and which
 * settings the cast agrees on. Characters with no brain yet are included — "not
 * started" is a state the user needs to see, not an absence to hide.
 */
brainRoutes.get('/brains/chat/:chatId', async (req, res) => {
  const { chatId } = req.params;
  try {
    const { meta, ids, mutedIds } = await castOf(chatId);
    const settings = await loadSettings();
    const messages = await loadMessages(chatId).catch(() => []);

    const members = [];
    for (const characterId of ids) {
      const card = await loadCharacter(characterId).catch(() => null);
      const brain = await loadBrainIfExists(chatId, characterId);
      const cadence = brain
        ? Math.max(1, brain.config.updateEveryMessages)
        : clampCadence(meta.brain?.updateEveryMessages ?? settings.brain?.updateEveryMessages);
      const cursor = brain ? resolveCursor(brain, chatId, messages) : { start: 0, pending: messages.length };
      members.push({
        characterId,
        name: card?.name ?? brain?.characterName ?? characterId,
        avatar: card?.avatar,
        missingCard: !card,
        muted: mutedIds.includes(characterId),
        hasBrain: !!brain,
        /** Messages read so far vs. what is waiting — "why has nothing formed?" answered. */
        pending: Math.max(0, cursor.pending),
        cadence,
        config: brain ? configFields(brain) : null,
        summary: brain ? summary(brain) : null,
      });
    }

    const present = members.filter((m) => m.config).map((m) => m.config!) as Partial<BrainConfigFields>[];
    res.json({
      chatId,
      chatTitle: meta.title,
      isGroup: !!meta.groupId,
      messageCount: messages.length,
      /** What the conversation itself asks for, layered over the app defaults. */
      resolved: resolveBrainConfig({ global: settings.brain ?? null, chat: meta.brain ?? null }),
      chatConfig: meta.brain ?? {},
      /** Fields the whole cast agrees on; anything missing is "mixed". */
      shared: commonConfig(present),
      globalEnabled: settings.brain?.enabled !== false,
      autoCreate: settings.brain?.autoCreate !== false,
      members,
    });
  } catch (err: any) {
    res.status(404).json({ error: err?.message ?? 'Conversation not found.' });
  }
});

/**
 * Set memory settings for the whole conversation.
 *
 * Writes the chat layer (so minds born later inherit it) *and* pushes onto every
 * mind that already exists — a group dial that only affected future characters
 * would be a dial that appears to do nothing.
 */
brainRoutes.patch('/brains/chat/:chatId/config', async (req, res) => {
  const { chatId } = req.params;
  try {
    const patch = sanitizeConfigPatch(req.body);
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change.' });

    const { meta, ids } = await castOf(chatId);
    meta.brain = { ...(meta.brain ?? {}), ...patch };
    await saveChatMeta(meta);

    let applied = 0;
    for (const characterId of ids) {
      if (!(await loadBrainIfExists(chatId, characterId))) continue;
      try {
        await withBrainLock(chatId, characterId, async () => {
          const b = await loadBrain(chatId, characterId, characterId);
          Object.assign(b.config, patch);
          await saveBrain(b);
        });
        applied++;
      } catch {
        /* one stuck mind must not block the rest of the cast */
      }
    }
    res.json({ chatConfig: meta.brain, applied });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Could not save memory settings.' });
  }
});

const INTENTION_KINDS = new Set([
  'pursue', 'repair', 'confront', 'conceal', 'withdraw', 'test', 'endure', 'enjoy',
]);

/**
 * Plant a steering directive on every mind in this conversation.
 *
 * The director drawer is what writes this. It biases which intention forms;
 * it does not script the reply. Minds that do not exist yet pick the
 * directive up on the next generation from the saved director state.
 */
brainRoutes.post('/brains/chat/:chatId/steer', async (req, res) => {
  const { chatId } = req.params;
  const text = String(req.body?.text ?? '').trim().slice(0, 900);
  if (!text) return res.status(400).json({ error: 'Nothing to steer toward.' });
  const prefer = INTENTION_KINDS.has(req.body?.prefer) ? req.body.prefer as IntentionKind : undefined;
  const ttl = Number.isFinite(req.body?.ttl)
    ? Math.max(1, Math.min(24, Math.round(req.body.ttl)))
    : ttlFromIntensity(req.body?.intensity);
  const now = Date.now();

  try {
    const { ids } = await castOf(chatId);
    let applied = 0;
    for (const characterId of ids) {
      const existing = await loadBrainIfExists(chatId, characterId);
      if (!existing) continue;
      try {
        await withBrainLock(chatId, characterId, async () => {
          const card = await loadCharacter(characterId).catch(() => null);
          const b = await loadBrain(chatId, characterId, card?.name ?? existing.characterName);
          setSteer(b, { text, prefer, now, ttl });
          await saveBrain(b);
        });
        await appendAudit(chatId, characterId, {
          kind: 'config',
          chatId,
          summary: `Steered toward “${text.slice(0, 80)}”${prefer ? ` (${prefer})` : ''} for ${ttl} turns.`,
        });
        applied++;
      } catch {
        /* one stuck mind must not block the rest */
      }
    }
    res.json({ applied, text, prefer, ttl });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Could not steer these minds.' });
  }
});

/**
 * Consolidate the conversation — every character, or one of them.
 *
 * Starts a background run and answers immediately with its job, because reading
 * a long scene is minutes of model calls and an HTTP request is the wrong place
 * to spend them. Poll `/brains/jobs/:id` for progress.
 */
brainRoutes.post('/brains/chat/:chatId/consolidate', async (req, res) => {
  const { chatId } = req.params;
  try {
    const characterIds = Array.isArray(req.body?.characterIds)
      ? (req.body.characterIds as unknown[]).map(String)
      : undefined;
    const job = await startBrainJob({ chatId, force: req.body?.force === true, characterIds });
    res.status(202).json(job);
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? 'Could not consolidate this conversation.' });
  }
});

/** Progress of a run. 404 once it has been forgotten — the work is still on disk. */
brainRoutes.get('/brains/jobs/:jobId', (req, res) => {
  const job = getBrainJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'That run has finished and been cleared.' });
  res.json(job);
});

/** The run in flight for a conversation, so a reload can pick the bar back up. */
brainRoutes.get('/brains/chat/:chatId/job', (req, res) => {
  res.json(activeBrainJob(req.params.chatId));
});

/**
 * Is this conversation's memory doing anything right now?
 *
 * The job registry only knows about runs the user *asked* for. Most memory
 * forms on its own — after a turn, or from the sweeper — and that work was
 * completely invisible: no bar, no spinner, nothing in the chat to say a mind
 * was reading. "Is it broken or is it thinking?" was unanswerable without
 * opening the server terminal. This is the cheap answer: who holds a brain lock
 * right now, and how far each mind is from its next pass.
 */
brainRoutes.get('/brains/chat/:chatId/activity', async (req, res) => {
  const { chatId } = req.params;
  try {
    const { ids } = await castOf(chatId);
    const messages = await loadMessages(chatId).catch(() => []);
    const settings = await loadSettings().catch(() => null);

    const members = [];
    for (const characterId of ids) {
      const brain = await loadBrainIfExists(chatId, characterId);
      if (!brain) continue;
      const cursor = resolveCursor(brain, chatId, messages);
      members.push({
        characterId,
        name: brain.characterName,
        consolidating: brainBusy(chatId, characterId),
        pending: Math.max(0, cursor.pending),
        cadence: Math.max(1, brain.config.updateEveryMessages),
        enabled: brain.config.enabled,
      });
    }

    res.json({
      job: activeBrainJob(chatId),
      members,
      consolidating: members.some((m) => m.consolidating),
      globalEnabled: settings?.brain?.enabled !== false,
    });
  } catch (err: any) {
    res.status(404).json({ error: err?.message ?? 'Conversation not found.' });
  }
});

brainRoutes.post('/brains/jobs/:jobId/cancel', (req, res) => {
  const job = cancelBrainJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'That run is already gone.' });
  res.json(job);
});

// ---------- full state ----------

brainRoutes.get('/brains/:chatId/:characterId', async (req, res) => {
  const { chatId, characterId } = req.params;
  const card = await loadCharacter(characterId).catch(() => null);
  res.json(await loadBrain(chatId, characterId, card?.name ?? characterId));
});

/**
 * Graph view-model for the visualiser: every node with its *current* activation
 * and recall probability, so the UI can size, colour and dim by real strength
 * rather than by an arbitrary score.
 */
brainRoutes.get('/brains/:chatId/:characterId/graph', async (req, res) => {
  const { chatId, characterId } = req.params;
  const card = await loadCharacter(characterId).catch(() => null);
  const brain = await loadBrain(chatId, characterId, card?.name ?? characterId);
  const now = Date.now();
  const p = brain.config.params;
  const index = buildIndex(brain);

  let chatTitle = '';
  try {
    chatTitle = (await loadChatMeta(chatId)).title;
  } catch {
    chatTitle = '';
  }

  const nodes = Object.values(brain.nodes).map((n) => {
    const strength = baseLevel(n, now, p) - (n.suppressed ?? 0);
    return {
      id: n.id,
      kind: n.kind,
      status: n.status,
      gist: n.gist,
      hasVerbatim: !!n.verbatim,
      valence: n.affect.valence,
      arousal: n.affect.arousal,
      dominance: n.affect.dominance,
      emotion: n.affect.label,
      strength,
      probability: recallProbability(strength, p),
      vividness: n.vividness,
      confidence: n.confidence,
      fidelity: n.fidelity,
      health: memoryHealth(n),
      intrusive: !!n.intrusive,
      pinned: !!n.pinned,
      contextBinding: n.contextBinding,
      actors: n.actors,
      place: n.place,
      tags: n.tags,
      chapterId: n.chapterId,
      encodedAt: n.encodedAt,
      lastRetrievedAt: n.lastRetrievedAt,
      useCount: n.useCount,
      degree: (index.adjacency.get(n.id) ?? []).length,
      sourceChatId: n.sourceChatId,
      drifted: !!(n.distortions && n.distortions.length),
      distortionCount: n.distortions?.length ?? 0,
      perceivedAt: n.perceivedAt,
      primed: stpTerm(n, now) > 0.08,
      fatigued: stpTerm(n, now) < -0.08,
      forecast: forecastDecay(n, now, p).label,
    };
  });

  res.json({
    chatId: brain.chatId,
    chatTitle,
    characterId: brain.characterId,
    characterName: brain.characterName,
    nodes,
    edges: brain.edges,
    chapters: brain.chapters,
    people: Object.values(brain.people),
    traits: brain.traits,
    disposition: brain.disposition,
    dispositionSource: brain.dispositionSource,
    mood: brain.mood,
    workingSelf: brain.workingSelf,
    intention: brain.intention && brain.intention.status === 'active' ? brain.intention : null,
    steer: brain.steer && brain.steer.ttl > 0 ? brain.steer : null,
    working: liveWorking(brain, now),
    /**
     * The psyche, plus the two read-outs the UI cannot compute for itself:
     * how the character's condition reads in plain language, and how their life
     * story and self-concept currently stand.
     */
    psyche: brain.psyche,
    condition: brain.psyche ? describeCondition(brain.psyche.condition) : [],
    copingStyle: brain.psyche ? describeCopingStyle(brain.psyche) : '',
    traumaStatus: brain.psyche
      ? brain.psyche.traumas.map((t) => ({
        nodeId: t.nodeId,
        gist: brain.nodes[t.nodeId]?.gist ?? '(memory gone)',
        pathway: t.pathway,
        status: traumaStatus(t),
        nowness: t.nowness,
        elaboration: t.elaboration,
        intrusions: t.intrusionCount,
        faced: t.approachCount,
        pushedAway: t.avoidanceCount,
      }))
      : [],
    identity: (() => {
      const id = readIdentity(brain, now);
      return {
        arcs: id.arcs,
        lifeStory: describeLifeStory(id.arcs),
        selfConcept: describeSelfConcept(id.self, brain.characterName),
        negativity: id.self.negativity,
        images: id.self.images.slice(0, 8),
      };
    })(),
    bonds: Object.values(brain.people).map((r) => ({
      key: r.key,
      displayName: r.displayName,
      description: brain.psyche ? describeBond(r, brain.psyche) : '',
      trust: r.trust,
      expectancy: (r as { expectancy?: number }).expectancy ?? r.trust * 0.8,
      ruptures: (r as { ruptures?: number }).ruptures ?? 0,
      repairs: (r as { repairs?: number }).repairs ?? 0,
      transferredFrom: (r as { transferredFrom?: string }).transferredFrom,
    })),
    config: brain.config,
    stats: brain.stats,
    now,
  });
});

/** Single node with its full trace history and neighbours. */
brainRoutes.get('/brains/:chatId/:characterId/nodes/:nodeId', async (req, res) => {
  const { chatId, characterId, nodeId } = req.params;
  const brain = await loadBrain(chatId, characterId, characterId);
  const node = brain.nodes[nodeId];
  if (!node) return res.status(404).json({ error: 'Memory not found' });
  const now = Date.now();
  const strength = baseLevel(node, now, brain.config.params);
  const edges = brain.edges.filter((e) => e.from === node.id || e.to === node.id);
  res.json({
    node,
    strength,
    probability: recallProbability(strength - (node.suppressed ?? 0), brain.config.params),
    health: memoryHealth(node),
    forecast: forecastDecay(node, now, brain.config.params),
    warrant: node.warrant ? describeWarrant(node) : '',
    edges,
    neighbors: edges.map((e) => {
      const otherId = e.from === node.id ? e.to : e.from;
      const other = brain.nodes[otherId];
      return other ? { id: other.id, gist: other.gist, kind: other.kind, edge: e.kind, weight: e.weight } : null;
    }).filter(Boolean),
  });
});

// ---------- init ----------

brainRoutes.post('/brains/:chatId/:characterId/init', async (req, res) => {
  const { chatId, characterId } = req.params;
  try {
    const card = await loadCharacter(characterId);
    const settings = await loadSettings();
    const conn = settings.utilityConnection ?? settings.textConnection;
    const brain = await ensureBrain(chatId, card, conn, { force: req.body?.force === true });
    res.json(summary(brain));
  } catch (err: any) {
    res.status(502).json({ error: err.message ?? 'Could not build the baseline for this character.' });
  }
});

// ---------- consolidation ----------

/**
 * Consolidate one mind and wait for the answer.
 *
 * Still synchronous because a single character's unread tail is normally one or
 * two chunks. Re-reading a long conversation is not — that goes through a job so
 * it can report progress and be stopped (`/brains/chat/:chatId/consolidate` with
 * `characterIds`).
 */
brainRoutes.post('/brains/:chatId/:characterId/update', async (req, res) => {
  const { chatId, characterId } = req.params;
  try {
    const outcome = await consolidateForChat(characterId, chatId, { force: req.body?.force === true });
    res.json({
      report: outcome.report,
      encoder: outcome.encoder,
      consumed: outcome.consumed,
      chunks: outcome.chunks,
      encoded: outcome.encoded,
      reason: outcome.reason,
      summary: summary(outcome.brain),
    });
  } catch (err: any) {
    res.status(502).json({ error: err.message ?? 'Consolidation failed.' });
  }
});

/** Progress of a chunked consolidation, chunk by chunk. */
export interface ConsolidateProgress {
  chunkIndex: number;
  chunkCount: number;
  /** Messages read so far in this run. */
  messagesRead: number;
  messagesTotal: number;
  /** Memories kept so far in this run. */
  encoded: number;
}

export interface ConsolidateRunOptions {
  force?: boolean;
  /** Called before the first chunk with the plan, then after each chunk. */
  onProgress?: (p: ConsolidateProgress) => void;
  /** Checked between chunks — a stopped run keeps everything already encoded. */
  shouldStop?: () => boolean;
  /**
   * Chunks this run may read before stopping for now.
   *
   * The background paths use a small cap so a large backlog drains over several
   * turns instead of firing a dozen unattended model calls at once; the cursor
   * advances per chunk, so the next pass simply continues. A run the user asked
   * for and can watch is uncapped.
   */
  maxChunks?: number;
}

/**
 * Shared by the route and by the post-generation background trigger, so manual
 * and automatic passes cannot diverge.
 *
 * Reads in chunks. A pass used to hand the encoder every unread message at once,
 * which on a long scene meant a prompt no model could hold, an answer capped far
 * below what the stretch contained, and a wait with nothing to show. Each chunk
 * is a bounded call against the *same* brain, so the graph accumulates exactly
 * as before — later chunks see, extend and contradict what earlier ones encoded.
 */
export async function consolidateForChat(
  characterId: string,
  chatId: string,
  opts: ConsolidateRunOptions = {},
) {
  const card = await loadCharacter(characterId);
  const settings = await loadSettings();
  // Structured extraction: try the cheap model first, escalate on a bad shape.
  const routed = route(settings, 'extract');
  const conn = routed.primary;
  const meta = await loadChatMeta(chatId);
  const messages = await loadMessages(chatId);

  /**
   * Always establish the temperament before encoding anything.
   *
   * Without this, a brain created by a manual "Consolidate" would be saved with
   * an all-zero disposition, and the auto path — which only initialises when no
   * brain file exists — would never repair it. `initBrain` is a no-op once a
   * model-derived anchor is in place, so this is cheap on every later pass.
   */
  await ensureBrain(chatId, card, conn).catch(() => undefined);

  let cast = [card.name];
  let isGroup = false;
  if (meta.groupId) {
    isGroup = true;
    const group = await loadGroup(meta.groupId);
    const members = await Promise.all(group.members.map((m) => loadCharacter(m).catch(() => null)));
    cast = members.filter(Boolean).map((c) => c!.name);
  }
  for (const m of messages.slice(-40)) {
    if (!cast.includes(m.speaker.displayName)) cast.push(m.speaker.displayName);
  }

  // The active footprint cap comes from the same 1/3 rule the prompt uses.
  const brain = await loadBrain(chatId, characterId, card.name);
  const limit = await resolveContextLimit(settings.textConnection);
  const plan = planContext({
    modelContext: limit.contextTokens,
    reservedOutput: 1024,
    share: brain.config.shareOfContext,
  });

  // ---- plan the reading ----
  const cursor = resolveCursor(brain, chatId, messages);
  const from = opts.force ? 0 : cursor.start;
  const window = messages.slice(from);
  const encoderLimit = await resolveContextLimit(conn).catch(() => limit);
  const chunks = planChunks({
    weights: window.map((m) => (
      m.hiddenFromPrompt || !m.text?.trim()
        ? 0
        : estimateTokens(`${m.speaker.displayName}: ${m.text}`)
    )),
    offset: from,
    maxTokens: transcriptBudget({ contextTokens: encoderLimit.contextTokens }),
    maxMessages: MAX_MESSAGES_PER_CHUNK,
    minTailMessages: MIN_TAIL_MESSAGES,
  });

  const base = {
    chatId,
    messages,
    card,
    conn,
    escalationConn: routed.escalation ?? undefined,
    cast,
    isGroup,
    activeTokenCap: plan.brainCap,
  };

  if (!chunks.length) {
    // Nothing unread: one no-op pass so a repaired cursor is still written back.
    return { ...(await runConsolidation({ ...base, force: opts.force })), chunks: 0, encoded: 0 };
  }

  const budgeted = opts.maxChunks && opts.maxChunks > 0
    ? chunks.slice(0, opts.maxChunks)
    : chunks;

  let encoded = 0;
  let messagesRead = 0;
  let last: Awaited<ReturnType<typeof runConsolidation>> | null = null;
  const messagesTotal = budgeted.reduce((s, c) => s + c.messages, 0);
  opts.onProgress?.({
    chunkIndex: 0, chunkCount: budgeted.length, messagesRead: 0, messagesTotal, encoded: 0,
  });

  for (let i = 0; i < budgeted.length; i++) {
    if (opts.shouldStop?.()) break;
    const chunk = budgeted[i];
    last = await runConsolidation({ ...base, window: { start: chunk.start, end: chunk.end } });
    // "Kept" is what the graph gained: new traces plus updates to existing ones.
    encoded += (last.report?.encoded.length ?? 0) + (last.report?.reconsolidated.length ?? 0);
    messagesRead += chunk.messages;
    opts.onProgress?.({
      chunkIndex: i + 1, chunkCount: budgeted.length, messagesRead, messagesTotal, encoded,
    });
  }

  return {
    ...(last ?? await runConsolidation({ ...base, window: { start: from, end: from } })),
    chunks: budgeted.length,
    /** Chunks left for the next pass when a cap cut this run short. */
    remaining: chunks.length - budgeted.length,
    encoded,
  };
}

// ---------- debug recall ----------

brainRoutes.post('/brains/:chatId/:characterId/recall', async (req, res) => {
  const { chatId, characterId } = req.params;
  const { text, actors, place, includeBelowThreshold } = (req.body ?? {}) as {
    text?: string; actors?: string[]; place?: string; includeBelowThreshold?: boolean;
  };
  const brain = await loadBrain(chatId, characterId, characterId);
  const cue = cueFromContext({
    recentText: text ?? '',
    actors: actors ?? [],
    place,
    brain,
  });
  // Never mutate on a debug recall — inspecting a mind should not change it.
  const result = recall(brain, cue, { limit: 40, includeBelowThreshold: !!includeBelowThreshold });
  res.json({
    cue,
    hits: result.hits.map((h) => ({
      id: h.node.id,
      kind: h.node.kind,
      gist: h.node.gist,
      activation: h.activation,
      probability: h.probability,
      intrusion: h.intrusion,
      breakdown: h.breakdown,
      status: h.node.status,
    })),
    competitors: result.competitors,
  });
});

// ---------- config & manual edits ----------

brainRoutes.patch('/brains/:chatId/:characterId/config', async (req, res) => {
  const { chatId, characterId } = req.params;
  const brain = await withBrainLock(chatId, characterId, async () => {
    const b = await loadBrain(chatId, characterId, characterId);
    const patch = (req.body ?? {}) as Record<string, unknown>;
    if (typeof patch.enabled === 'boolean') b.config.enabled = patch.enabled;
    if (typeof patch.autoUpdate === 'boolean') b.config.autoUpdate = patch.autoUpdate;
    if (typeof patch.traumaEnabled === 'boolean') b.config.traumaEnabled = patch.traumaEnabled;
    if (typeof patch.intrusionsEnabled === 'boolean') b.config.intrusionsEnabled = patch.intrusionsEnabled;
    if (Number.isFinite(patch.updateEveryMessages as number)) {
      b.config.updateEveryMessages = Math.max(1, Math.min(100, Math.floor(patch.updateEveryMessages as number)));
    }
    if (Number.isFinite(patch.shareOfContext as number)) {
      // The one-third ceiling is enforced here, not in the UI.
      b.config.shareOfContext = Math.max(0, Math.min(MAX_BRAIN_SHARE, patch.shareOfContext as number));
    }
    if (patch.params && typeof patch.params === 'object') {
      const incoming = patch.params as Record<string, unknown>;
      for (const key of Object.keys(DEFAULT_PARAMS) as (keyof typeof DEFAULT_PARAMS)[]) {
        const v = incoming[key];
        if (Number.isFinite(v as number)) b.config.params[key] = v as number;
      }
    }
    await saveBrain(b);
    return b;
  });
  res.json(brain.config);
});

brainRoutes.patch('/brains/:chatId/:characterId/nodes/:nodeId', async (req, res) => {
  const { chatId, characterId, nodeId } = req.params;
  try {
    const node = await withBrainLock(chatId, characterId, async () => {
      const brain = await loadBrain(chatId, characterId, characterId);
      const n: MemoryNode | undefined = brain.nodes[nodeId];
      if (!n) throw Object.assign(new Error('Memory not found'), { status: 404 });
      const patch = (req.body ?? {}) as Record<string, unknown>;
      if (typeof patch.gist === 'string' && patch.gist.trim()) n.gist = patch.gist.trim().slice(0, 800);
      if (typeof patch.pinned === 'boolean') {
        n.pinned = patch.pinned;
        if (patch.pinned) n.status = 'active';
      }
      // "Forget this" is a deliberate suppression, not a delete — the trace stays
      // in the graph as a ghost, exactly as the model of forgetting requires.
      if (patch.forget === true) {
        n.status = 'dormant';
        n.suppressed = Math.max(n.suppressed ?? 0, 2.5);
        n.pinned = false;
      }
      if (patch.restore === true) {
        n.status = 'active';
        n.suppressed = 0;
        n.uses.push(Date.now());
        n.useCount++;
      }
      if (patch.delete === true) {
        delete brain.nodes[n.id];
        brain.edges = brain.edges.filter((e) => e.from !== n.id && e.to !== n.id);
      }
      await saveBrain(brain);
      return n;
    });
    res.json(node);
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message ?? 'Could not update that memory.' });
  }
});

brainRoutes.get('/brains/:chatId/:characterId/audit', async (req, res) => {
  const { chatId, characterId } = req.params;
  res.json(await readAudit(chatId, characterId, Number(req.query.limit) || 80));
});

brainRoutes.delete('/brains/:chatId/:characterId', async (req, res) => {
  const { chatId, characterId } = req.params;
  await withBrainLock(chatId, characterId, () => deleteBrain(chatId, characterId));
  res.json({ ok: true });
});

// ---------- model context limits ----------

brainRoutes.get('/model-limits', async (req, res) => {
  const settings = await loadSettings();
  const provider = String(req.query.provider ?? settings.textConnection.provider);
  const model = String(req.query.model ?? settings.textConnection.model);
  const limit = await resolveContextLimit({
    provider: provider as any,
    model,
    baseUrl: settings.textConnection.baseUrl,
  });

  // Show the caller exactly how the budget falls out for the current setup.
  const share = req.query.share !== undefined
    ? Math.max(0, Math.min(MAX_BRAIN_SHARE, Number(req.query.share)))
    : MAX_BRAIN_SHARE;
  const reservedOutput = Number(req.query.reservedOutput) || 1024;
  const chatId = req.query.chatId ? String(req.query.chatId) : '';
  const characterId = req.query.characterId ? String(req.query.characterId) : '';
  const brainDemand = chatId && characterId
    ? brainDemandTokens(await loadBrain(chatId, characterId, characterId), estimateBrainTokens)
    : undefined;

  res.json({
    ...limit,
    maxShare: MAX_BRAIN_SHARE,
    plan: planContext({ modelContext: limit.contextTokens, reservedOutput, share, brainDemand }),
  });
});
