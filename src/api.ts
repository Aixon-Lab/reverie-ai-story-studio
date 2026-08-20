/** Typed API client + SSE generation stream. */
import type {
  AppSettings, CharacterCard, CharacterPhoto, ChatMessage, ChatMeta, ContextPreset, Group, InstructPreset,
  Lorebook, Persona, Preset, PromptItem, QuickReplySet, ReasoningPreset, SyspromptPreset,
  TimelineState, TimelineGraphNode,
} from '@shared/types';
import type { ChatSkillState, Skill } from '@shared/skills/types';
import { drainSseFrames, parseSseFrame } from '@shared/engine/sse';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function http<T>(
  method: string,
  url: string,
  body?: unknown,
  opts?: { signal?: AbortSignal },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${url}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: opts?.signal,
    });
  } catch (err: any) {
    // Caller pulled the plug (Stop) — not a failure worth reporting as one.
    if (err?.name === 'AbortError') throw new ApiError('Stopped.', 0, 'abort');
    // Browser network failure (offline / DNS) — not an HTTP status
    throw new ApiError(
      err?.message?.includes('Failed to fetch')
        ? 'Cannot reach the Reverie server. Run `npm run dev` (or Start.bat) so the API on port 6969 is up, then refresh.'
        : (err?.message || 'Network error talking to the server.'),
      0,
      'network',
    );
  }
  if (!res.ok) {
    if (res.status === 423) {
      notifyVaultLocked();
      throw new ApiError('Reverie is locked. Enter your password to continue.', 423, 'locked');
    }
    // Prefer real error body; never surface a bare "500" when the Vite proxy has no backend
    throw new ApiError(await readFetchError(res), res.status);
  }
  return res.json();
}

/** A brain is addressed by the conversation it lives in plus the character. */
function brainBase(chatId: string, characterId: string): string {
  return `/brains/${encodeURIComponent(chatId)}/${encodeURIComponent(characterId)}`;
}

export const api = {
  listCharacters: () => http<CharacterCard[]>('GET', '/characters'),
  importCharacter: (filename: string, dataBase64: string) => http<CharacterCard>('POST', '/characters/import', { filename, dataBase64 }),
  createCharacter: (card: Partial<CharacterCard>) => http<CharacterCard>('POST', '/characters', card),
  updateCharacter: (id: string, card: Partial<CharacterCard>) => http<CharacterCard>('PUT', `/characters/${id}`, card),
  deleteCharacter: (id: string) => http<{ ok: true }>('DELETE', `/characters/${id}`),
  setAvatar: (id: string, dataBase64: string) => http<CharacterCard>('POST', `/characters/${id}/avatar`, { dataBase64 }),

  // ---- portrait gallery (max MAX_CHARACTER_PHOTOS per character) ----
  listPhotos: (id: string) =>
    http<{ photos: CharacterPhoto[]; activePhotoId?: string; max: number }>('GET', `/characters/${id}/photos`),
  /** `select: false` uploads without changing which portrait is on display. */
  addPhoto: (id: string, dataBase64: string, opts?: { label?: string; select?: boolean }) =>
    http<CharacterCard>('POST', `/characters/${id}/photos`, { dataBase64, ...opts }),
  selectPhoto: (id: string, photoId: string) =>
    http<CharacterCard>('POST', `/characters/${id}/photos/${photoId}/select`),
  deletePhoto: (id: string, photoId: string) =>
    http<CharacterCard>('DELETE', `/characters/${id}/photos/${photoId}`),
  /** AI: full card + domain pack from gist (optional physical lock from vision) */
  generateCharacter: (body: {
    gist: string;
    setting?: string;
    nameHint?: string;
    physicalLock?: unknown;
    existingPartial?: Record<string, unknown>;
  }) => http<{
    name: string;
    description: string;
    personality: string;
    first_mes: string;
    mes_example: string;
    tags: string[];
    system_prompt: string;
    post_history_instructions: string;
    creator_notes: string;
    pack: unknown;
  }>('POST', '/characters/generate', body),
  /**
   * Vision: physical domain from portrait (confirm in UI first).
   * Runs on-device by default — `local` reports whether the image stayed here.
   */
  analyzeCharacterImage: (imageBase64: string, mime?: string) =>
    http<{ physical: unknown; analyzedAt: number; local: boolean; model?: string }>(
      'POST', '/characters/analyze-image', { imageBase64, mime },
    ),
  /** On-device model readiness + first-run download progress. Drives the scan UI. */
  localVisionStatus: () =>
    http<{
      available: boolean;
      model?: string;
      label?: string;
      engineReady?: boolean;
      weightsReady?: boolean;
      running?: boolean;
      approxDownloadMb?: number;
      approxRamMb?: number;
      progress?: {
        phase: 'idle' | 'engine' | 'weights' | 'ready' | 'error';
        file?: string;
        receivedMb?: number;
        totalMb?: number;
        error?: string;
      };
      error?: string;
      setup?: string;
      strict: boolean;
      enabled: boolean;
      maxEdge: number;
    }>('GET', '/local-vision/status'),
  /** Kick off the one-time weight download so the first scan is not the slow one. */
  localVisionWarmup: () =>
    http<{ started: true; model: string }>('POST', '/local-vision/warmup'),

  listChats: () => http<ChatMeta[]>('GET', '/chats'),
  createChat: (init: Partial<ChatMeta>) => http<ChatMeta>('POST', '/chats', init),
  getChat: (id: string) => http<{ meta: ChatMeta; messages: ChatMessage[] }>('GET', `/chats/${id}`),
  updateChat: (id: string, patch: Partial<ChatMeta>) => http<ChatMeta>('PUT', `/chats/${id}`, patch),
  deleteChat: (id: string) => http<{ ok: true }>('DELETE', `/chats/${id}`),
  saveMessages: (id: string, msgs: ChatMessage[]) => http<{ ok: true }>('PUT', `/chats/${id}/messages`, msgs),
  postMessage: (id: string, msg: Omit<ChatMessage, 'id' | 'ts'>) => http<ChatMessage>('POST', `/chats/${id}/messages`, msg),
  /** Add character to chat; promotes solo → group in place (messages kept). */
  addChatMember: (chatId: string, characterId: string) =>
    http<{ meta: ChatMeta; group: Group; promoted: boolean; added?: CharacterCard }>(
      'POST',
      `/chats/${chatId}/add-member`,
      { characterId },
    ),

  // ---- session terminal (in-memory on the server; wiped on restart) ----
  terminal: {
    read: (since = 0) =>
      http<{ epoch: number; entries: TerminalEntry[]; stats: TerminalStats }>(
        'GET', `/terminal?since=${since}`,
      ),
    clear: () => http<{ ok: boolean; stats: TerminalStats }>('DELETE', '/terminal'),
    /** Live tail. Returns an unsubscribe function. */
    stream: (since: number, onEntry: (e: TerminalEntry) => void, onInit?: (e: TerminalEntry[]) => void) => {
      const es = new EventSource(`/api/terminal/stream?since=${since}`);
      es.addEventListener('init', (ev) => {
        try { onInit?.(JSON.parse((ev as MessageEvent).data).entries ?? []); } catch { /* ignore */ }
      });
      es.addEventListener('entry', (ev) => {
        try { onEntry(JSON.parse((ev as MessageEvent).data)); } catch { /* ignore */ }
      });
      return () => es.close();
    },
  },

  listGroups: () => http<Group[]>('GET', '/groups'),
  createGroup: (g: Partial<Group>) => http<Group>('POST', '/groups', g),
  getGroup: (id: string) => http<Group>('GET', `/groups/${id}`),
  updateGroup: (id: string, patch: Partial<Group>) => http<Group>('PUT', `/groups/${id}`, patch),
  /** Removes the group and every chat that belonged to it, plus those chats' minds. */
  deleteGroup: (id: string) =>
    http<{ ok: boolean; removedChats?: number }>('DELETE', `/groups/${encodeURIComponent(id)}`),
  analyzeStyle: (groupId: string) => http<NonNullable<Group['styleProfile']>>('POST', `/groups/${groupId}/style-profile`),

  listPresets: () => http<Preset[]>('GET', '/presets'),
  importPreset: (filename: string, json: unknown) => http<Preset>('POST', '/presets/import', { filename, json }),
  updatePreset: (id: string, p: Preset) => http<Preset>('PUT', `/presets/${id}`, p),
  deletePreset: (id: string) => http<{ ok: true }>('DELETE', `/presets/${id}`),
  listInstruct: () => http<InstructPreset[]>('GET', '/instruct'),
  listContext: () => http<ContextPreset[]>('GET', '/context'),
  listSysprompt: () => http<SyspromptPreset[]>('GET', '/sysprompt'),
  listReasoning: () => http<ReasoningPreset[]>('GET', '/reasoning'),
  createInstruct: (p: Partial<InstructPreset>) => http<InstructPreset>('POST', '/instruct', p),
  createContext: (p: Partial<ContextPreset>) => http<ContextPreset>('POST', '/context', p),
  createSysprompt: (p: Partial<SyspromptPreset>) => http<SyspromptPreset>('POST', '/sysprompt', p),
  createReasoning: (p: Partial<ReasoningPreset>) => http<ReasoningPreset>('POST', '/reasoning', p),
  updateInstruct: (id: string, p: InstructPreset) => http<InstructPreset>('PUT', `/instruct/${id}`, p),
  updateContext: (id: string, p: ContextPreset) => http<ContextPreset>('PUT', `/context/${id}`, p),
  updateSysprompt: (id: string, p: SyspromptPreset) => http<SyspromptPreset>('PUT', `/sysprompt/${id}`, p),
  updateReasoning: (id: string, p: ReasoningPreset) => http<ReasoningPreset>('PUT', `/reasoning/${id}`, p),
  deleteInstruct: (id: string) => http<{ ok: true }>('DELETE', `/instruct/${id}`),
  deleteContext: (id: string) => http<{ ok: true }>('DELETE', `/context/${id}`),
  deleteSysprompt: (id: string) => http<{ ok: true }>('DELETE', `/sysprompt/${id}`),
  deleteReasoning: (id: string) => http<{ ok: true }>('DELETE', `/reasoning/${id}`),
  importInstruct: (filename: string, json: unknown) => http<InstructPreset>('POST', '/instruct/import', { filename, json }),
  importContext: (filename: string, json: unknown) => http<ContextPreset>('POST', '/context/import', { filename, json }),
  importSysprompt: (filename: string, json: unknown) => http<SyspromptPreset>('POST', '/sysprompt/import', { filename, json }),
  importReasoning: (filename: string, json: unknown) => http<ReasoningPreset>('POST', '/reasoning/import', { filename, json }),
  listLorebooks: () => http<Lorebook[]>('GET', '/lorebooks'),
  createLorebook: (b: Partial<Lorebook>) => http<Lorebook>('POST', '/lorebooks', b),
  updateLorebook: (id: string, b: Lorebook) => http<Lorebook>('PUT', `/lorebooks/${id}`, b),
  deleteLorebook: (id: string) => http<{ ok: true }>('DELETE', `/lorebooks/${id}`),
  importLorebook: (filename: string, json: unknown) => http<Lorebook>('POST', '/lorebooks/import', { filename, json }),
  listPersonas: () => http<Persona[]>('GET', '/personas'),
  savePersonas: (p: Persona[]) => http<Persona[]>('PUT', '/personas', p),
  getSettings: () => http<AppSettings>('GET', '/settings'),
  saveSettings: (s: Partial<AppSettings>) => http<AppSettings>('PUT', '/settings', s),
  listSecrets: () => http<{ keys: string[] }>('GET', '/secrets'),
  setSecret: (key: string, value: string) => http<{ ok: true }>('POST', '/secrets', { key, value }),
  listQuickReplies: () => http<QuickReplySet[]>('GET', '/quick-replies'),
  createQuickReplySet: (s: Partial<QuickReplySet>) => http<QuickReplySet>('POST', '/quick-replies', s),
  updateQuickReplySet: (id: string, s: QuickReplySet) => http<QuickReplySet>('PUT', `/quick-replies/${id}`, s),
  deleteQuickReplySet: (id: string) => http<{ ok: true }>('DELETE', `/quick-replies/${id}`),

  getTimeline: (chatId: string) =>
    http<{
      meta: ChatMeta;
      messages: ChatMessage[];
      timeline: TimelineState;
      graph: TimelineGraphNode[];
      warning?: string | null;
    }>('GET', `/chats/${chatId}/timeline`),
  timelineCheckpoint: (chatId: string, name?: string) =>
    http<{
      meta: ChatMeta;
      messages: ChatMessage[];
      timeline: TimelineState;
      graph: TimelineGraphNode[];
      createdForkId?: string;
      warnings: string[];
    }>('POST', `/chats/${chatId}/timeline/checkpoint`, { name }),
  timelineFork: (chatId: string, messageId: string, name?: string) =>
    http<{
      meta: ChatMeta;
      messages: ChatMessage[];
      timeline: TimelineState;
      graph: TimelineGraphNode[];
      createdForkId?: string;
      warnings: string[];
    }>('POST', `/chats/${chatId}/timeline/fork`, { messageId, name }),
  timelineRestore: (chatId: string, forkId: string) =>
    http<{
      meta: ChatMeta;
      messages: ChatMessage[];
      timeline: TimelineState;
      graph: TimelineGraphNode[];
      warnings: string[];
    }>('POST', `/chats/${chatId}/timeline/restore`, { forkId }),
  timelineRenameFork: (chatId: string, forkId: string, name: string) =>
    http<{ timeline: TimelineState; graph: TimelineGraphNode[] }>(
      'PATCH',
      `/chats/${chatId}/timeline/forks/${forkId}`,
      { name },
    ),
  timelineDeleteFork: (chatId: string, forkId: string) =>
    http<{ timeline: TimelineState; graph: TimelineGraphNode[] }>(
      'DELETE',
      `/chats/${chatId}/timeline/forks/${forkId}`,
    ),
  timelineDeepSwipe: (chatId: string, messageId: string, confirmed?: boolean, name?: string) =>
    http<{
      meta: ChatMeta;
      messages: ChatMessage[];
      timeline: TimelineState;
      graph: TimelineGraphNode[];
      createdForkId?: string;
      warnings: string[];
      readyMessageId: string;
      error?: string;
      code?: string;
    }>('POST', `/chats/${chatId}/timeline/deep-swipe`, { messageId, confirmed, name }),
  swipeMessage: (chatId: string, messageId: string, index: number, confirmed?: boolean) =>
    http<{
      meta: ChatMeta;
      messages: ChatMessage[];
      timeline: TimelineState;
      graph: TimelineGraphNode[];
      createdForkId?: string;
      warnings: string[];
      error?: string;
      code?: string;
    }>('POST', `/chats/${chatId}/messages/${messageId}/swipe`, { index, confirmed }),

  createBranch: (chatId: string, name?: string) => http<ChatMeta>('POST', `/chats/${chatId}/branches`, { name }),
  restoreBranch: (chatId: string, branchId: string) =>
    http<{ meta: ChatMeta; messages: ChatMessage[] }>('POST', `/chats/${chatId}/branches/${branchId}/restore`),

  /** Pass a signal so Stop can cut the Director off mid-decision. */
  turn: (chatId: string, opts?: { signal?: AbortSignal }) =>
    http<{ next: string; reason: string; urgency: string; speakerId: string | null; new_character_needed?: { hint: string } | null }>(
      'POST', '/turn', { chatId }, opts,
    ),
  /** Post an accepted Impersonate draft as that character's message. */
  commitImpersonation: (chatId: string, speakerId: string, text: string) =>
    http<ChatMessage>('POST', '/impersonate/commit', { chatId, speakerId, text }),
  /** Post an accepted Narrator draft as a narration beat. */
  commitNarration: (chatId: string, text: string) =>
    http<ChatMessage>('POST', '/narrate/commit', { chatId, text }),
  expandAuthorsNote: (chatId: string, seed: string, richness?: number) =>
    http<{ text: string; richness?: number; words?: number }>('POST', '/authors-note', { chatId, seed, richness }),
  /** Spelling/grammar repair of the user's own draft — never a rewrite. */
  proofread: (text: string, chatId?: string) =>
    http<{ text: string; changed: boolean }>('POST', '/proofread', { text, chatId }),
  genesisScan: (chatId: string) => http<{ needed: boolean; hint: string }>('POST', '/genesis/scan', { chatId }),
  genesis: (chatId: string, hint: string) =>
    http<{ card: CharacterCard; promptCard: string | null; styleProfile?: unknown }>('POST', '/genesis', { chatId, hint }),
  imageCatalog: () => http<Record<string, { label: string; models: string[] }>>('GET', '/images/catalog'),
  listModels: (opts: { provider: string; kind: 'text' | 'image'; q?: string; refresh?: boolean }) => {
    const q = new URLSearchParams({ provider: opts.provider, kind: opts.kind });
    if (opts.q?.trim()) q.set('q', opts.q.trim());
    if (opts.refresh) q.set('refresh', '1');
    return http<{ models: ModelInfo[]; source: 'live' | 'cache' | 'fallback'; error?: string }>('GET', `/models?${q}`);
  },
  generateImage: (body: { prompt?: string; aspect?: string; purpose?: string; characterId?: string; chatId?: string }) =>
    http<{ imageId: string | null; url: string | null; prompt: string; promptCard?: boolean }>('POST', '/images/generate', body),

  // ---- Character Brain (long-term memory, scoped to one conversation) ----
  brain: {
    list: () => http<BrainSummary[]>('GET', '/brains'),
    /** Every mind in one conversation, including characters who have none yet. */
    chat: (chatId: string) =>
      http<ChatMindOverview>('GET', `/brains/chat/${encodeURIComponent(chatId)}`),
    /** Set memory settings for the whole cast (and for minds born here later). */
    chatConfig: (chatId: string, patch: Partial<BrainConfigFields>) =>
      http<{ chatConfig: Partial<BrainConfigFields>; applied: number }>(
        'PATCH', `/brains/chat/${encodeURIComponent(chatId)}/config`, patch,
      ),
    /**
     * Start a consolidation run over the conversation. Returns straight away
     * with the job — reading a long scene takes minutes, so progress is polled.
     */
    chatConsolidate: (chatId: string, force = false, characterIds?: string[]) =>
      http<BrainJob>(
        'POST', `/brains/chat/${encodeURIComponent(chatId)}/consolidate`, { force, characterIds },
      ),
    job: (jobId: string) => http<BrainJob>('GET', `/brains/jobs/${encodeURIComponent(jobId)}`),
    /** The run in flight for a conversation, so a reload picks the bar back up. */
    activeJob: (chatId: string) =>
      http<BrainJob | null>('GET', `/brains/chat/${encodeURIComponent(chatId)}/job`),
    /**
     * What memory is doing for this conversation right now — including the
     * passes nobody asked for, which is most of them.
     */
    activity: (chatId: string, opts?: { signal?: AbortSignal }) =>
      http<BrainActivity>('GET', `/brains/chat/${encodeURIComponent(chatId)}/activity`, undefined, opts),
    cancelJob: (jobId: string) =>
      http<BrainJob>('POST', `/brains/jobs/${encodeURIComponent(jobId)}/cancel`),
    graph: (chatId: string, characterId: string) =>
      http<BrainGraph>('GET', `${brainBase(chatId, characterId)}/graph`),
    node: (chatId: string, characterId: string, nodeId: string) =>
      http<BrainNodeDetail>('GET', `${brainBase(chatId, characterId)}/nodes/${nodeId}`),
    init: (chatId: string, characterId: string, force?: boolean) =>
      http<BrainSummary>('POST', `${brainBase(chatId, characterId)}/init`, { force }),
    update: (chatId: string, characterId: string, force?: boolean) =>
      http<{ report: BrainReport | null; encoder: string; consumed: number; reason?: string; summary: BrainSummary }>(
        'POST', `${brainBase(chatId, characterId)}/update`, { force },
      ),
    recall: (
      chatId: string,
      characterId: string,
      body: { text?: string; actors?: string[]; place?: string; includeBelowThreshold?: boolean },
    ) =>
      http<{ hits: BrainRecallHit[]; competitors: string[] }>(
        'POST', `${brainBase(chatId, characterId)}/recall`, body,
      ),
    config: (chatId: string, characterId: string, patch: Record<string, unknown>) =>
      http<BrainGraph['config']>('PATCH', `${brainBase(chatId, characterId)}/config`, patch),
    patchNode: (chatId: string, characterId: string, nodeId: string, patch: Record<string, unknown>) =>
      http<unknown>('PATCH', `${brainBase(chatId, characterId)}/nodes/${nodeId}`, patch),
    audit: (chatId: string, characterId: string, limit = 80) =>
      http<BrainAuditEntry[]>('GET', `${brainBase(chatId, characterId)}/audit?limit=${limit}`),
    /**
     * Plant a steering directive on every mind in this conversation.
     * Biases what they reach for; does not script the reply.
     */
    steer: (
      chatId: string,
      body: { text: string; prefer?: string; ttl?: number; intensity?: number },
    ) =>
      http<{ applied: number; text: string; prefer?: string; ttl: number }>(
        'POST', `/brains/chat/${encodeURIComponent(chatId)}/steer`, body,
      ),
    wipe: (chatId: string, characterId: string) =>
      http<{ ok: true }>('DELETE', brainBase(chatId, characterId)),
    limits: (
      opts: {
        provider?: string; model?: string; share?: number; reservedOutput?: number;
        chatId?: string; characterId?: string;
      } = {},
    ) => {
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(opts)) if (v !== undefined) q.set(k, String(v));
      return http<ModelLimits>('GET', `/model-limits${q.toString() ? `?${q}` : ''}`);
    },
  },

  // ---- skills (global craft documents) ----
  listSkills: () => http<Skill[]>('GET', '/skills'),
  getSkill: (id: string) => http<Skill>('GET', `/skills/${id}`),
  createSkill: (s: Partial<Skill>) => http<Skill>('POST', '/skills', s),
  updateSkill: (id: string, s: Partial<Skill>) => http<Skill>('PUT', `/skills/${id}`, s),
  deleteSkill: (id: string) => http<{ ok: true }>('DELETE', `/skills/${id}`),
  importSkill: (payload: { filename?: string; text?: string; json?: unknown }) =>
    http<Skill>('POST', '/skills/import', payload),
  exportSkill: (id: string) => http<{ filename: string; text: string }>('GET', `/skills/${id}/export`),
  /** What one turn would advertise to the selector, and what that costs. */
  skillRoster: () => http<{ text: string; tokens: number }>('GET', '/skills/roster'),
  chatSkills: (chatId: string) => http<ChatSkillState>('GET', `/chats/${chatId}/skills`),
  pinChatSkill: (chatId: string, skillId: string, pin: 'force' | 'mute' | 'clear') =>
    http<ChatSkillState>('POST', `/chats/${chatId}/skills/pin`, { skillId, pin }),
  clearChatSkills: (chatId: string) => http<ChatSkillState>('POST', `/chats/${chatId}/skills/clear`),

  // ---- vault (at-rest encryption) — the only calls that work while locked ----
  vault: {
    status: () => http<VaultStatus>('GET', '/vault/status'),
    setup: (password: string, confirm: string) =>
      http<VaultStatus & { encrypted: number; failed: string[] }>('POST', '/vault/setup', { password, confirm }),
    unlock: (password: string) => http<VaultStatus & { encrypted: number }>('POST', '/vault/unlock', { password }),
    lock: () => http<VaultStatus>('POST', '/vault/lock'),
    changePassword: (current: string, next: string, confirm: string) =>
      http<VaultStatus>('POST', '/vault/change-password', { current, next, confirm }),
    setAutoLock: (minutes: number) => http<VaultStatus>('POST', '/vault/auto-lock', { minutes }),
    disable: (password: string) => http<VaultStatus & { decrypted: number }>('POST', '/vault/disable', { password }),
  },
};

// ---------- Character Brain view models ----------

export type BrainMemoryKind =
  | 'episodic' | 'semantic' | 'schema' | 'identity' | 'sensory' | 'relational' | 'procedural';
export type BrainMemoryStatus = 'active' | 'faded' | 'dormant';

export interface BrainGraphNode {
  id: string;
  kind: BrainMemoryKind;
  status: BrainMemoryStatus;
  gist: string;
  hasVerbatim: boolean;
  valence: number;
  arousal: number;
  dominance: number;
  emotion: string;
  /** Base-level activation minus suppression — the real strength right now. */
  strength: number;
  probability: number;
  vividness: number;
  confidence: number;
  fidelity: number;
  health: { label: string; tone: 'good' | 'warn' | 'bad' };
  intrusive: boolean;
  pinned: boolean;
  contextBinding: number;
  actors: string[];
  place?: string;
  tags: string[];
  chapterId?: string;
  encodedAt: number;
  lastRetrievedAt?: number;
  useCount: number;
  degree: number;
  sourceChatId?: string;
  drifted?: boolean;
  distortionCount?: number;
  perceivedAt?: number;
  primed?: boolean;
  fatigued?: boolean;
  forecast?: string;
}

export interface BrainGraphEdge {
  from: string;
  to: string;
  kind: string;
  weight: number;
  createdAt: number;
  note?: string;
}

export interface BrainRelation {
  key: string;
  displayName: string;
  trust: number;
  affection: number;
  fear: number;
  respect: number;
  resentment: number;
  debt: number;
  familiarity: number;
  model: string;
  interactions: number;
  firstMetAt: number;
  lastSeenAt: number;
}

export interface BrainAffect {
  valence: number;
  arousal: number;
  dominance: number;
  label: string;
}

export interface BrainGraph {
  chatId: string;
  chatTitle: string;
  characterId: string;
  characterName: string;
  nodes: BrainGraphNode[];
  edges: BrainGraphEdge[];
  chapters: { id: string; title: string; theme: string; startedAt: number; endedAt?: number; tone: BrainAffect; chatIds: string[] }[];
  people: BrainRelation[];
  traits: Record<string, number>;
  disposition: Record<string, number>;
  /** `none` = no baseline built yet; the temperament is meaningless until fixed. */
  dispositionSource: 'none' | 'lexicon' | 'model';
  mood: BrainAffect;
  workingSelf: {
    goals: { id: string; text: string; priority: number; status: string }[];
    selfImages: string[];
    concerns: string[];
  };
  intention?: {
    id: string;
    kind: string;
    target?: string;
    text: string;
    urgency: number;
    ttl: number;
    status: string;
    progress: number;
    rationale: string;
  } | null;
  steer?: { text: string; prefer?: string; setAt: number; ttl: number } | null;
  working?: { id: string; gist: string; actors: string[]; heldAt: number; salience: number }[];
  config: {
    enabled: boolean;
    updateEveryMessages: number;
    autoUpdate: boolean;
    shareOfContext: number;
    traumaEnabled: boolean;
    intrusionsEnabled: boolean;
    confabulation?: number;
    params: Record<string, number>;
  };
  stats: {
    totalEncoded: number; totalPruned: number; totalRecalls: number;
    updates: number; lastUpdateAt?: number; lastMaintenanceAt?: number;
    lastMentationAt?: number; mentationTicks?: number;
    cursor: Record<string, number>;
  };

  /**
   * The psyche layer (docs/research/psyche-architecture.md). Optional: a mind
   * saved before it existed has none until its next consolidation pass.
   */
  psyche?: {
    body: { energy: number; sleepDebt: number; pain: number; safety: number; nourishment: number };
    load: { level: number; sustainedScenes: number; scenesSinceRelief: number; peak: number };
    dynamics: { inertia: number; reactivity: number; instability: number; granularity: number };
    attribution: { internal: number; stable: number; global: number };
    defenseMaturity: number;
    attachment: { anxiety: number; avoidance: number };
    condition: {
      ptsd: { intrusion: number; avoidance: number; negativeAlterations: number; arousal: number; severity: number };
      dso: { affectDysregulation: number; negativeSelfConcept: number; relationalDisturbance: number; severity: number };
      depression: { hopelessness: number; anhedonia: number; brooding: number; overgeneralMemory: number; severity: number };
      anxiety: { threatExpectancy: number; hypervigilance: number; severity: number };
      dissociation: { acute: number; chronic: number };
      growth: { strength: number; relating: number; possibilities: number; appreciation: number; existential: number; severity: number };
    };
    scenes: number;
  };
  /** Plain-language read of the condition — behaviour, never diagnosis. */
  condition: string[];
  copingStyle: string;
  traumaStatus: {
    nodeId: string; gist: string; pathway: 'fear' | 'betrayal' | 'moral'; status: string;
    nowness: number; elaboration: number; intrusions: number; faced: number; pushedAway: number;
  }[];
  identity: {
    arcs: { chapterId: string; title: string; kind: string; slope: number; coherence: number; telling: string }[];
    lifeStory: string;
    selfConcept: string;
    negativity: number;
    images: { id: string; text: string; valence: number; conviction: number; counterEvidence: string[] }[];
  };
  bonds: {
    key: string; displayName: string; description: string; trust: number;
    expectancy: number; ruptures: number; repairs: number; transferredFrom?: string;
  }[];
  now: number;
}

export interface BrainSummary {
  chatId: string;
  /** Title of the conversation this mind belongs to. */
  chatTitle: string;
  characterId: string;
  characterName: string;
  updatedAt: number;
  createdAt: number;
  enabled: boolean;
  counts: Record<string, number>;
  mood: BrainAffect;
  stats: BrainGraph['stats'];
}

/** Memory settings a human can set, at any of the three layers. */
export interface BrainConfigFields {
  enabled: boolean;
  autoUpdate: boolean;
  updateEveryMessages: number;
  shareOfContext: number;
  traumaEnabled: boolean;
  intrusionsEnabled: boolean;
  confabulation?: number;
}

/** One character's memory standing inside one conversation. */
export interface ChatMindMember {
  characterId: string;
  name: string;
  avatar?: string;
  /** The card is gone from the library but the mind (or the seat) remains. */
  missingCard: boolean;
  muted: boolean;
  hasBrain: boolean;
  /** Messages waiting to be read by the next consolidation pass. */
  pending: number;
  cadence: number;
  config: BrainConfigFields | null;
  summary: BrainSummary | null;
}

/** The whole cast's memory, in one call — what the group memory screen renders. */
export interface ChatMindOverview {
  chatId: string;
  chatTitle: string;
  isGroup: boolean;
  messageCount: number;
  resolved: BrainConfigFields;
  chatConfig: Partial<BrainConfigFields>;
  /** Fields every existing mind agrees on; anything absent is "mixed". */
  shared: Partial<BrainConfigFields>;
  globalEnabled: boolean;
  autoCreate: boolean;
  members: ChatMindMember[];
}

/** One character's share of a consolidation run. */
export interface BrainJobMember {
  characterId: string;
  name: string;
  status: 'pending' | 'running' | 'done' | 'skipped' | 'error';
  chunks: number;
  chunksDone: number;
  messages: number;
  messagesRead: number;
  encoded: number;
  reason?: string;
  error?: string;
}

/** A background consolidation run, watched by the progress bar. */
export interface BrainJob {
  id: string;
  chatId: string;
  kind: 'update' | 'reread';
  status: 'planning' | 'running' | 'done' | 'cancelled' | 'error';
  startedAt: number;
  finishedAt?: number;
  chunks: number;
  chunksDone: number;
  currentCharacterId?: string;
  members: BrainJobMember[];
  error?: string;
}

/**
 * A live read-out of a conversation's memory.
 *
 * Covers both kinds of work: the run the user started (`job`), and the passes
 * that happen on their own after a turn or from the sweeper (`consolidating`).
 * The second kind was previously invisible everywhere in the app.
 */
export interface BrainActivity {
  job: BrainJob | null;
  consolidating: boolean;
  globalEnabled: boolean;
  members: {
    characterId: string;
    name: string;
    /** A pass is holding this brain right now. */
    consolidating: boolean;
    /** Messages this mind has not read yet. */
    pending: number;
    /** How many unread messages trigger the next pass. */
    cadence: number;
    enabled: boolean;
  }[];
}

export interface BrainNodeDetail {
  node: Record<string, unknown> & { id: string; gist: string; uses: number[] };
  strength: number;
  probability: number;
  health: { label: string; tone: string };
  forecast?: { fadeInMs: number | null; dormantInMs: number | null; daysToFade: number | null; daysToDormant: number | null; label: string };
  warrant?: string;
  edges: BrainGraphEdge[];
  neighbors: { id: string; gist: string; kind: string; edge: string; weight: number }[];
}

export interface BrainRecallHit {
  id: string;
  kind: BrainMemoryKind;
  gist: string;
  activation: number;
  probability: number;
  intrusion: boolean;
  status: BrainMemoryStatus;
  breakdown: {
    base: number; spreading: number; partialMatch: number; boost: number;
    suppression: number; moodCongruence: number; noise: number; total: number;
  };
}

export interface BrainReport {
  encoded: string[];
  skipped: number;
  reconsolidated: string[];
  reconsolidationBlocked: { nodeId: string; pe: number; required: number }[];
  semanticised: string[];
  schemasFormed: string[];
  faded: string[];
  dormant: string[];
  pruned: string[];
  traumaFormed: string[];
  traitDrift: Record<string, number>;
  moodBefore: BrainAffect;
  moodAfter: BrainAffect;
  peopleUpdated: string[];
  at: number;
}

export interface BrainAuditEntry {
  id: string;
  at: number;
  kind: string;
  chatId?: string;
  summary: string;
  detail?: unknown;
}

export interface ModelLimits {
  contextTokens: number;
  maxOutputTokens?: number;
  source: string;
  model: string;
  provider: string;
  maxShare: number;
  plan: {
    modelContext: number;
    reservedOutput: number;
    safetyMargin: number;
    usable: number;
    brainCap: number;
    brainBudget: number;
    historyBudget: number;
    effectiveShare: number;
    saturated: boolean;
  };
}

export interface VaultStatus {
  state: 'uninitialized' | 'locked' | 'unlocked';
  autoLockMinutes: number;
  /** Remaining brute-force lockout in ms. */
  lockoutUntil: number;
  failedAttempts: number;
}

/**
 * Any 423 means the server dropped its key (auto-lock, restart, manual lock).
 * The gate subscribes and throws the UI straight back to the lock screen so we
 * never render half-loaded state against a locked backend.
 */
const lockListeners = new Set<() => void>();

export function onVaultLocked(fn: () => void): () => void {
  lockListeners.add(fn);
  return () => lockListeners.delete(fn);
}

export function notifyVaultLocked(): void {
  for (const fn of lockListeners) fn();
}

/** Mirrors server/providers/models.ts — see there for where each field comes from. */
export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
  /** e.g. "$3 / $15 · 1M" or "Free" (when provider exposes pricing). */
  price?: string;
  pricePromptPerM?: number;
  priceCompletionPerM?: number;
  /** USD / 1M internal reasoning tokens, when billed apart from completion. */
  priceReasoningPerM?: number;
  contextTokens?: number;
  maxOutputTokens?: number;
  /** Artificial Analysis, via OpenRouter's `benchmarks`. Often absent. */
  intelligenceIndex?: number;
  codingIndex?: number;
  agenticIndex?: number;
  reasoning?: {
    mandatory?: boolean;
    defaultEnabled?: boolean;
    supportedEfforts?: string[];
    defaultEffort?: string;
  };
  baseId?: string;
  variant?: string;
  modality?: string;
}

export interface StreamCallbacks {
  onItemization?: (items: PromptItem[], totalTokens: number) => void;
  onDelta: (text: string) => void;
  /** Which craft documents this turn was actually given, and at what fidelity. */
  onSkills?: (skills: { id: string; name: string; level: string }[]) => void;
  onDone: (payload: { message?: ChatMessage; impersonated?: string }) => void;
  onError: (message: string) => void;
  /** Fired when the user (or client) cancels — not an error. */
  onAbort?: () => void;
}

const BACKEND_DOWN_MSG =
  'Reverie API server is not running (port 6969). Use Start.bat or `npm run dev` so both UI and server start, then refresh this page.';

/** Parse a failed API response into a human-readable reason (never bare "500"). */
async function readFetchError(res: Response): Promise<string> {
  const status = res.status;
  let body = '';
  try {
    body = await res.text();
  } catch {
    body = '';
  }
  const trimmed = body.trim();
  /**
   * A 404 on an /api route means the server is answering but does not know the
   * route — almost always a server process started before the code that added
   * it. Express's own "Cannot POST /api/…" says nothing about the fix, and the
   * fix is always the same.
   */
  // Not anchored: Express wraps it in an HTML page whose title ("Error") comes
  // first, so the phrase sits in the middle of the stripped text.
  if (status === 404 && /Cannot (?:GET|POST|PUT|DELETE|PATCH)\s+\/api\//i.test(trimmed)) {
    return 'The Reverie server does not have this endpoint — it is running an older build. '
      + 'Stop it and start it again (close the Reverie window, then run Start.bat), then retry.';
  }

  if (trimmed) {
    try {
      const j = JSON.parse(trimmed) as { error?: unknown; message?: unknown; code?: string };
      const err = j.error ?? j.message;
      if (typeof err === 'string' && err.trim()) {
        // Avoid "500" alone if server only echoed the code
        if (/^\d{3}$/.test(err.trim())) {
          return status >= 500 ? BACKEND_DOWN_MSG : `Request failed (HTTP ${status}). Try again.`;
        }
        return err.trim();
      }
      if (err && typeof err === 'object') return JSON.stringify(err).slice(0, 400);
    } catch {
      // HTML or plain text error page from a dead proxy
      const plain = trimmed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (plain && !/^\d{3}$/.test(plain)) return plain.slice(0, 400);
    }
  }
  // Empty body + 5xx is almost always Vite proxy → backend down
  if (status >= 500 && !trimmed) return BACKEND_DOWN_MSG;
  if (status === 401 || status === 403) {
    return `Auth failed (HTTP ${status}). Check your API key in Connections.`;
  }
  if (status === 429) {
    return 'Rate limited (HTTP 429). Wait a moment or switch model/provider.';
  }
  if (status >= 500) {
    return `Server error (HTTP ${status}). Check the terminal running Reverie and your Connections / model.`;
  }
  return `Request failed (HTTP ${status}). Try again.`;
}

export function streamGenerate(
  body: {
    chatId: string; speakerId?: string; generationType?: string; mode?: string; hint?: string;
    targetMessageId?: string;
    /** Draft length slider (1–5) — Write Me and Impersonate */
    draftLength?: number;
    /** Impersonate only: hold the text for review instead of posting it */
    draft?: boolean;
  },
  cb: StreamCallbacks,
): () => void {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let settled = false;

  const settleAbort = () => {
    if (settled) return;
    settled = true;
    cb.onAbort?.();
  };
  const settleError = (message: string) => {
    if (settled) return;
    settled = true;
    const msg = (message || '').trim();
    cb.onError(
      msg && !/^\d{3}$/.test(msg)
        ? msg
        : 'Generation failed. Check Connections / model and try again.',
    );
  };
  const settleDone = (payload: { message?: ChatMessage; impersonated?: string }) => {
    if (settled) return;
    settled = true;
    cb.onDone(payload);
  };

  (async () => {
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        settleAbort();
        return;
      }
      if (!res.ok) {
        if (res.status === 423) notifyVaultLocked();
        throw new Error(await readFetchError(res));
      }
      reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!controller.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = drainSseFrames(buffer, (frame) => dispatchSseFrame(frame, cb, {
          settled: () => settled, settleDone, settleError,
        }));
        if (settled) break;
      }
      if (controller.signal.aborted) {
        settleAbort();
        return;
      }
      // A final frame that arrived without its terminating blank line.
      if (!settled && buffer.trim()) {
        dispatchSseFrame(buffer, cb, { settled: () => settled, settleDone, settleError });
      }
      // Stream closed without done/error — never leave UI stuck on "Generating…"
      if (!settled) {
        if (controller.signal.aborted) settleAbort();
        else {
          settleError(
            'Generation ended without a complete reply (connection closed early). Try again — if this keeps happening, check the Reverie server terminal.',
          );
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError' || controller.signal.aborted) {
        settleAbort();
        return;
      }
      settleError(err?.message || 'Generation failed');
    } finally {
      try { reader?.releaseLock(); } catch { /* ignore */ }
    }
  })();

  // Instant cancel: abort fetch + cancel body reader + notify UI immediately
  return () => {
    /**
     * Abort the transport even if the callbacks have already fired.
     *
     * The early return used to come first, so a Stop that raced a settle left
     * the underlying request open — the provider kept generating (and billing)
     * into a connection nobody was reading.
     */
    try { reader?.cancel('user stopped'); } catch { /* ignore */ }
    controller.abort();
    if (!settled) settleAbort();
  };
}

/** One SSE frame → one callback. Framing and field parsing live in `shared/engine/sse`. */
function dispatchSseFrame(
  frame: string,
  cb: StreamCallbacks,
  ctl: { settled: () => boolean; settleDone: (d: any) => void; settleError: (m: string) => void },
): void {
  if (ctl.settled()) return;
  const parsedFrame = parseSseFrame(frame);
  if (!parsedFrame) return;

  let data: any;
  try {
    data = JSON.parse(parsedFrame.data);
  } catch {
    // Malformed JSON from the server is worth knowing about; it used to vanish.
    console.warn('[stream] discarded an unparseable SSE frame', parsedFrame.data.slice(0, 200));
    return;
  }
  const { event } = parsedFrame;
  if (event === 'delta') {
    if (data.text) cb.onDelta(data.text);
  } else if (event === 'done') ctl.settleDone(data);
  else if (event === 'error') ctl.settleError(data.message ?? 'Generation error');
  else if (event === 'itemization') cb.onItemization?.(data.items, data.totalTokens);
  else if (event === 'skills') cb.onSkills?.(data.skills ?? []);
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ---------- session terminal ----------

export interface TerminalMessage { role: string; content: string }

export interface TerminalEntry {
  id: string;
  at: number;
  seq: number;
  phase: 'request' | 'response' | 'error';
  /** Which feature made the call — `reply:Wren`, `brain.encoder`, `proofread`… */
  purpose: string;
  provider: string;
  model: string;
  requestId?: string;
  messages?: TerminalMessage[];
  params?: Record<string, unknown>;
  text?: string;
  error?: string;
  durationMs?: number;
  chars?: { prompt: number; completion: number };
  streamed?: boolean;
}

export interface TerminalStats {
  epoch: number;
  entries: number;
  max: number;
  bytes: number;
}

// ---------- skill authoring stream ----------

export interface SkillDraft {
  name: string;
  description: string;
  keywords: string[];
  tags: string[];
  body: string;
  source: 'ai';
}

/**
 * Stream a generated skill document into the editor.
 *
 * Its own small reader rather than a share of `streamGenerate`: that one is
 * built around chat messages and settles on a `ChatMessage`, and bending it to
 * also mean "a document draft" would make the chat path harder to read for the
 * sake of one screen.
 */
export function streamSkillDraft(
  body: { idea: string; depth?: 'brief' | 'standard' | 'deep' },
  cb: {
    onDelta: (text: string) => void;
    onDone: (draft: SkillDraft) => void;
    onError: (message: string) => void;
  },
): () => void {
  const controller = new AbortController();
  let settled = false;

  (async () => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      const res = await fetch('/api/skills/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(await readFetchError(res));
      if (!res.body) throw new Error('The server sent no response body.');

      reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = drainSseFrames(buffer, (frame) => {
          const parsed = parseSseFrame(frame);
          if (!parsed) return;
          let data: any;
          try { data = JSON.parse(parsed.data); } catch { return; }
          if (parsed.event === 'delta' && data.text) cb.onDelta(data.text);
          else if (parsed.event === 'done') { settled = true; cb.onDone(data.draft); }
          else if (parsed.event === 'error') { settled = true; cb.onError(data.message ?? 'Skill generation failed.'); }
        });
      }
      if (!settled) cb.onError('The skill generator closed before finishing. Try again.');
    } catch (err: any) {
      if (err?.name === 'AbortError' || controller.signal.aborted) return;
      if (!settled) cb.onError(err?.message ?? 'Skill generation failed.');
    } finally {
      try { reader?.releaseLock(); } catch { /* ignore */ }
    }
  })();

  return () => controller.abort();
}
