/** Core shared types for Reverie. ST-compatible where it matters. */
import type { ChatSkillState, SkillsSettings } from './skills/types';

export type { ChatSkillState, SkillsSettings };

// ---------- Characters ----------

export interface CharacterBookEntry {
  id: number;
  keys: string[];
  secondary_keys: string[];
  comment: string;
  content: string;
  constant: boolean;
  selective: boolean;
  insertion_order: number;
  enabled: boolean;
  position: 'before_char' | 'after_char';
  extensions: Record<string, unknown>;
}

export interface CharacterBook {
  name?: string;
  entries: CharacterBookEntry[];
  extensions?: Record<string, unknown>;
}

/** Normalized internal card — superset of V2, carries V3 extras in `v3`. */
export interface CharacterCard {
  id: string; // filename-based unique id (like ST's avatar key)
  name: string;
  description: string;
  personality: string;
  scenario: string;
  first_mes: string;
  mes_example: string;
  creator_notes: string;
  system_prompt: string;
  post_history_instructions: string;
  alternate_greetings: string[];
  tags: string[];
  creator: string;
  character_version: string;
  character_book?: CharacterBook;
  extensions: Record<string, unknown> & {
    talkativeness?: number | string;
    fav?: boolean;
    world?: string;
    depth_prompt?: { depth: number; prompt: string; role: 'system' | 'user' | 'assistant' };
  };
  v3?: {
    nickname?: string;
    assets?: unknown[];
    creator_notes_multilingual?: Record<string, string>;
    source?: string[];
    group_only_greetings?: string[];
    creation_date?: number;
    modification_date?: number;
  };
  /**
   * Portrait gallery. The *selected* photo is mirrored onto `{id}.png`, so
   * `avatar` below stays the single source of truth for everything that renders
   * a character — chat bubbles, group strips, the card list, ST export. Adding
   * photos therefore changes nothing downstream.
   */
  photos?: CharacterPhoto[];
  /** Which photo is currently being shown. Falls back to the first. */
  activePhotoId?: string;
  /** avatar image url (served by our api) */
  avatar?: string;
  createdAt?: number;
}

/** Hard ceiling on gallery size, enforced server-side. */
export const MAX_CHARACTER_PHOTOS = 30;

export interface CharacterPhoto {
  id: string;
  /** Served URL for this specific photo, independent of which is selected. */
  url: string;
  addedAt: number;
  /** Optional user label ("armoured", "before the ruins"). */
  label?: string;
}

// ---------- Personas ----------

export interface Persona {
  id: string;
  name: string;
  description: string;
  avatar?: string;
}

// ---------- Chat ----------

export type SpeakerType = 'user' | 'character' | 'narrator' | 'system';

export interface ChatMessage {
  id: string;
  ts: number;
  speaker: { type: SpeakerType; characterId?: string; displayName: string };
  controlledBy: 'human' | 'ai';
  text: string;
  swipes?: string[];
  swipeIndex?: number;
  /**
   * Bumped every time this message's text is rewritten in place — a new swipe, a
   * Continue, a manual edit, or switching to a different swipe.
   *
   * The id stays stable across all of those (deliberately: the timeline is built
   * on it), which meant anything reading the transcript by id could not tell
   * that the text under a message it had already processed had changed. The
   * Character Brain's read cursor is the case that mattered — see
   * `BrainStats.cursorRevision`.
   */
  revision?: number;
  hiddenFromPrompt?: boolean;
  extra?: {
    model?: string;
    reasoning?: string;
    imageId?: string;
    promptCard?: string; // image prompt awaiting external generation
    genesis?: boolean;
    directorNote?: string;
    /** Posted from an accepted Impersonate draft rather than a live turn. */
    impersonated?: boolean;
  };
}

export interface ChatBranch {
  id: string;
  name: string;
  createdAt: number;
  /** Snapshot of messages at branch point */
  messages: ChatMessage[];
  parentMessageId?: string;
}

/** Why a fork/checkpoint was created. */
export type TimelineForkReason =
  | 'checkpoint'
  | 'swipe_switch'
  | 'deep_swipe'
  | 'manual_fork'
  | 'before_restore'
  | 'before_truncate'
  | 'before_delete';

/** Mid-history swipe / deep-swipe policy when active path has descendants. */
export type TimelineMidHistoryPolicy = 'preserve' | 'confirm' | 'block';

/** Parent/child edge for one message on the active path. */
export interface TimelineNodeMeta {
  id: string;
  parentId: string | null;
  /** Index of parent's swipe this child continues from (if known). */
  fromParentSwipe?: number;
}

/**
 * A frozen linear path (checkpoint or alternate future).
 * Active path stays in \{chatId}.jsonl\; forks live in timeline storage.
 */
export interface TimelineFork {
  id: string;
  name: string;
  createdAt: number;
  reason: TimelineForkReason;
  tipMessageId?: string;
  /** Message at which this path diverges / was truncated (if known). */
  forkMessageId?: string;
  messages: ChatMessage[];
  /** Chat-scoped state frozen with the path */
  snapshot?: {
    summary?: string;
    variables?: Record<string, string>;
    director?: DirectorState;
  };
}

export interface TimelineState {
  version: 1;
  nodes: Record<string, TimelineNodeMeta>;
  tipId: string | null;
  forks: TimelineFork[];
  /** UI: which fork is highlighted (null = live active path). */
  viewingForkId?: string | null;
}

/** Lightweight graph row for the Timeline panel. */
export interface TimelineGraphNode {
  id: string;
  parentId: string | null;
  index: number;
  speakerName: string;
  speakerType: SpeakerType;
  controlledBy: 'human' | 'ai';
  preview: string;
  swipeCount: number;
  swipeIndex: number;
  hiddenFromPrompt?: boolean;
  isTip: boolean;
  canDeepSwipe: boolean;
}

export interface ChatMeta {
  id: string;
  title: string;
  characterId?: string; // solo chat
  groupId?: string; // group chat
  personaId?: string;
  createdAt: number;
  updatedAt: number;
  scenarioOverride?: string;
  authorsNote?: { text: string; depth: number; interval: number; role: 'system' | 'user' | 'assistant' };
  director?: DirectorState;
  variables?: Record<string, string>;
  summary?: string;
  /**
   * Legacy named checkpoints (full message dumps).
   * Prefer TimelineState.forks in chat timeline.json; migrated on load.
   */
  branches?: ChatBranch[];
  /** Extra stop strings for this chat */
  stopStrings?: string[];
  /**
   * Memory settings for *this conversation* — the whole cast at once.
   *
   * Sits between the global defaults and each mind's own config: it seeds every
   * new mind born here, and the group memory screen can push it onto the minds
   * that already exist.
   */
  brain?: Partial<Omit<BrainSettings, 'autoCreate'>>;
  /**
   * Has anything actually happened here?
   *
   * Opening a character seeds a chat with their greeting so there is something on
   * screen. That is not a conversation, and listing it in history fills the rail
   * with rows the user never wrote a word in. A chat becomes started the moment a
   * human message is sent or a reply is generated, and only started chats are
   * listed.
   */
  started?: boolean;
  /**
   * Which global skills are armed for this conversation.
   *
   * The selector writes here at the end of a turn and the next turn reads it,
   * which is why a skill takes effect one beat after the scene calls for it.
   * User pins (`forced` / `muted`) live here too — they are a property of this
   * story, not of the skill.
   */
  skills?: ChatSkillState;
}

export interface DirectorState {
  nudge?: { text: string; intensity: 1 | 2 | 3 | 4 | 5; setAtMessage: number };
  sceneGoal?: { text: string; status: 'active' | 'done' };
  cutTo?: string;
  /**
   * Optional dramatic objective to bias the character toward.
   * Planted on `brain.steer` when direction is applied — a bias, not a script.
   */
  prefer?: 'pursue' | 'repair' | 'confront' | 'conceal' | 'withdraw' | 'test' | 'endure' | 'enjoy';
}

// ---------- Groups ----------

export type TurnMode = 'director' | 'natural' | 'list' | 'pooled' | 'manual';

/** ST generation_mode: 0 SWAP, 1 APPEND, 2 APPEND_DISABLED */
export type GenerationMode = 'swap' | 'append' | 'append_disabled';

export interface Group {
  id: string;
  name: string;
  members: string[]; // character ids
  disabledMembers: string[];
  avatar?: string;
  turnMode: TurnMode;
  allowSelfResponses: boolean;
  /** character id currently embodied by the human user (besides their persona), or null */
  playAs: string | null;
  narratorEnabled: boolean;
  genesisEnabled: boolean;
  autoImages: boolean;
  /** ST auto_mode_delay (seconds); 0 = off */
  autoModeDelay: number;
  /** ST generation_mode */
  generationMode: GenerationMode;
  generationModeJoinPrefix: string;
  generationModeJoinSuffix: string;
  /** Round-robin cursor for list mode */
  listIndex?: number;
  /** Speaker ids who already spoke since last user message (pooled) */
  pooledSpoken?: string[];
  styleProfile?: StyleProfile;
  chats: string[];
  createdAt: number;
}

export interface StyleProfile {
  medium: string;
  keywords: string[];
  palette?: string;
  notes?: string;
  confidence: number;
  analyzedAt: number;
}

// ---------- Presets (ST chat-completion compatible) ----------

export interface PresetPrompt {
  identifier: string;
  name: string;
  role?: 'system' | 'user' | 'assistant';
  content?: string;
  system_prompt?: boolean;
  marker?: boolean;
  injection_position?: number; // 0 relative, 1 in-chat
  injection_depth?: number;
  injection_order?: number;
  forbid_overrides?: boolean;
}

export interface PromptOrderEntry {
  identifier: string;
  enabled: boolean;
}

export interface Preset {
  id: string;
  name: string;
  temperature: number;
  frequency_penalty: number;
  presence_penalty: number;
  top_p: number;
  top_k: number;
  min_p: number;
  repetition_penalty: number;
  max_context: number;
  max_tokens: number;
  stream: boolean;
  names_behavior: number; // -1 none, 0 default, 1 completion, 2 content
  squash_system_messages: boolean;
  wrap_in_quotes: boolean;
  utility_prompts: {
    impersonation_prompt: string;
    new_chat_prompt: string;
    new_group_chat_prompt: string;
    new_example_chat_prompt: string;
    continue_nudge_prompt: string;
    group_nudge_prompt: string;
    wi_format: string;
    scenario_format: string;
    personality_format: string;
    send_if_empty: string;
  };
  prompts: PresetPrompt[];
  prompt_order: PromptOrderEntry[];
  /** Global stop strings (ST-compatible) */
  stop_strings: string[];
  /** Simple logit bias map token→bias (-100..100) */
  logit_bias: Record<string, number>;
  /** untouched original ST json for lossless export */
  raw?: Record<string, unknown>;
}

// ---------- Regex (find/replace scripts) ----------

export type RegexPlacement =
  | 'user_input'
  | 'ai_output'
  | 'slash_command'
  | 'world_info'
  | 'reasoning'
  | 'prompt';

export interface RegexScript {
  id: string;
  scriptName: string;
  findRegex: string;
  replaceString: string;
  trimStrings: string[];
  placement: RegexPlacement[];
  disabled: boolean;
  markdownOnly: boolean;
  promptOnly: boolean;
  runOnEdit: boolean;
  substituteRegex: boolean;
  minDepth: number | null;
  maxDepth: number | null;
}

// ---------- Message style (dialogue / action / thought display + LLM rules) ----------

export type MessageStyleRole = 'dialogue' | 'action' | 'thought' | 'plain';

/** How a segment of chat text is styled and what wrappers mean for the model. */
export interface MessageStyleRule {
  id: string;
  name: string;
  role: MessageStyleRole;
  /** Insert-button open wrapper, e.g. `"` or `*` */
  open: string;
  /** Insert-button close wrapper */
  close: string;
  /**
   * Regex with one capture group for the inner text.
   * Example dialogue: "\"([\\s\\S]*?)\""  action: "\\*([^*]+)\\*"
   */
  pattern: string;
  enabled: boolean;
  /** Hide wrapper characters in the UI (show styled text only) */
  hideWrappers: boolean;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  color: string;
  /**
   * If true, bare text with no wrappers uses this role’s style.
   * At most one rule should set this.
   */
  defaultForBare: boolean;
  /** Include this rule in the generation style instruction for the LLM */
  injectInPrompt: boolean;
}

export interface MessageStyleSettings {
  rules: MessageStyleRule[];
}

// ---------- Quick Replies ----------

export interface QuickReply {
  id: string;
  label: string;
  message: string;
  /** If true, send immediately; else fill composer */
  autoSend: boolean;
  /** Optional slash command only */
  isSystem?: boolean;
}

export interface QuickReplySet {
  id: string;
  name: string;
  replies: QuickReply[];
}

// ---------- World Info ----------

export enum WIPosition {
  Before = 0,
  After = 1,
  ANTop = 2,
  ANBottom = 3,
  AtDepth = 4,
  EMTop = 5,
  EMBottom = 6,
}

export enum WILogic {
  AND_ANY = 0,
  NOT_ALL = 1,
  NOT_ANY = 2,
  AND_ALL = 3,
}

export interface WIEntry {
  uid: number;
  key: string[];
  keysecondary: string[];
  comment: string;
  content: string;
  constant: boolean;
  selective: boolean;
  selectiveLogic: WILogic;
  order: number;
  position: WIPosition;
  disable: boolean;
  excludeRecursion: boolean;
  preventRecursion: boolean;
  delayUntilRecursion: boolean | number;
  probability: number;
  useProbability: boolean;
  depth: number;
  role: 0 | 1 | 2; // system/user/assistant for atDepth
  group: string;
  groupOverride: boolean;
  groupWeight: number;
  scanDepth: number | null;
  caseSensitive: boolean | null;
  matchWholeWords: boolean | null;
  raw?: Record<string, unknown>;
}

export interface Lorebook {
  id: string;
  name: string;
  entries: WIEntry[];
  raw?: Record<string, unknown>;
}

// ---------- Connections ----------

export type TextProvider = 'openai' | 'anthropic' | 'google' | 'openrouter' | 'custom';
export type ImageProvider = 'google' | 'openai' | 'openrouter' | 'fal' | 'replicate' | 'custom';

export interface TextConnection {
  provider: TextProvider;
  model: string;
  baseUrl?: string;
  /**
   * Reasoning effort for models that expose levels (OpenRouter reports them as
   * `reasoning.supported_efforts`; OpenAI calls the field `reasoning_effort`).
   * Null/undefined means "let the provider use the model's own default" —
   * which is not the same as low, and must not be silently replaced by it.
   */
  reasoningEffort?: string | null;
  /** key stored server-side in secrets, referenced by provider name */
}

/**
 * A model kept one click away.
 *
 * Stores the provider alongside the id because switching models can also mean
 * switching provider, and a bare id would silently point at whatever provider
 * happened to be selected.
 */
export interface PinnedModel {
  provider: TextProvider;
  model: string;
  /** Restored with the model — effort is part of "which model this is". */
  reasoningEffort?: string | null;
  /** Catalog display name at pin time, so the chip reads like a name. */
  label?: string;
}

/** Pins are a shortcut, not a library — three keeps the switcher glanceable. */
export const MAX_PINNED_MODELS = 3;

export interface ImageConnection {
  provider: ImageProvider | null;
  model: string;
  baseUrl?: string;
}

/** ST instruct template — wrap sequences for roles (full ST control set). */
export interface InstructPreset {
  id: string;
  name: string;
  input_sequence: string;
  output_sequence: string;
  system_sequence: string;
  stop_sequence: string;
  input_suffix: string;
  output_suffix: string;
  system_suffix: string;
  last_system_sequence: string;
  first_output_sequence: string;
  last_output_sequence: string;
  first_input_sequence: string;
  last_input_sequence: string;
  user_alignment_message: string;
  activation_regex: string;
  wrap: boolean;
  macro: boolean;
  names_behavior: string; // none | force | always
  sequences_as_stop_strings: boolean;
  bind_to_context: boolean;
  skip_examples: boolean;
  system_same_as_user: boolean;
  story_string_prefix: string;
  story_string_suffix: string;
  raw?: Record<string, unknown>;
}

/** ST context template — story_string layout. */
export interface ContextPreset {
  id: string;
  name: string;
  story_string: string;
  example_separator: string;
  chat_start: string;
  use_stop_strings: boolean;
  names_as_stop_strings: boolean;
  story_string_position: number;
  story_string_depth: number;
  story_string_role: number;
  always_force_name2: boolean;
  raw?: Record<string, unknown>;
}

/** ST system prompt pack. */
export interface SyspromptPreset {
  id: string;
  name: string;
  content: string;
  post_history: string;
  raw?: Record<string, unknown>;
}

/** ST reasoning / think-block wrappers. */
export interface ReasoningPreset {
  id: string;
  name: string;
  prefix: string;
  suffix: string;
  separator: string;
  raw?: Record<string, unknown>;
}

export type DrawerId =
  | 'api'
  | 'preset'
  | 'formatting'
  | 'worldinfo'
  | 'persona'
  | 'characters'
  | 'presetComposer'
  | 'regex'
  | 'quickreply'
  | 'appearance'
  | 'security'
  | 'brain'
  | 'skills'
  | 'terminal'
  | null;

/** UI look & feel (persisted in settings.json). */
export interface AppearanceSettings {
  /**
   * Chat transcript / messages area background.
   * CSS color (prefer #rrggbb). Empty / missing = app default canvas black.
   */
  chatBackground?: string;
}

/**
 * Global Character Brain defaults (see docs/brain-system.md).
 * Per-character overrides live in `data/brains/{id}.json`; these are the master
 * switch and the values a newly born brain inherits.
 */
export interface BrainSettings {
  /** Master switch. Off = the app behaves exactly as it did before brains existed. */
  enabled: boolean;
  /** Run a consolidation pass automatically after this many new messages. */
  updateEveryMessages: number;
  autoUpdate: boolean;
  /** Share of the model's usable context the brain may occupy. Hard ceiling 1/3. */
  shareOfContext: number;
  /** Allow trauma-style encoding (strong sensory trace, weak contextual one). */
  traumaEnabled: boolean;
  /** Allow traumatic memories to intrude unbidden into replies. */
  intrusionsEnabled: boolean;
  /** Create a brain automatically the first time a character is chatted with. */
  autoCreate: boolean;
}

/**
 * On-device image understanding. When enabled, portraits are described by a
 * small VLM running on this machine and only the resulting text is eligible to
 * reach a cloud API — the image bytes never leave.
 */
export interface LocalVisionSettings {
  enabled: boolean;
  /** Treat a local failure as an error rather than falling back to cloud. */
  strict: boolean;
  /** Longest image edge fed to the encoder. Bigger is much slower, rarely better. */
  maxEdge: number;
  /** Release the model's ~2 GB after this long idle. 0 keeps it resident. */
  idleUnloadMs: number;
}

export interface AppSettings {
  textConnection: TextConnection;
  /** Up to MAX_PINNED_MODELS quick-switch targets. */
  pinnedModels?: PinnedModel[];
  utilityConnection?: TextConnection | null;
  /** Unset behaves as enabled+strict: local-first is the default posture. */
  localVision?: LocalVisionSettings | null;
  /**
   * Optional small/cheap model for structured work — memory encoding, trait
   * reading, speaker decisions. Tried first for those tasks and escalated to the
   * utility model when it fails its own validity check.
   *
   * Unset means no routing at all: every task resolves exactly as before, so
   * this can never silently downgrade anyone who did not ask for it.
   */
  cheapConnection?: TextConnection | null;
  imageConnection: ImageConnection;
  activePresetId: string;
  activePersonaId: string;
  activeInstructId: string;
  activeContextId: string;
  activeSyspromptId: string;
  activeReasoningId: string;
  /** ST power_user.instruct.enabled */
  instructEnabled: boolean;
  /** ST power_user.sysprompt.enabled */
  syspromptEnabled: boolean;
  /** ST power_user.reasoning.* */
  reasoningSettings: {
    autoParse: boolean;
    autoExpand: boolean;
    addToPrompts: boolean;
    maxAdditions: number;
    showHidden: boolean;
  };
  globalLorebooks: string[];
  wiSettings: {
    depth: number;
    budgetPercent: number;
    recursive: boolean;
    caseSensitive: boolean;
    matchWholeWords: boolean;
    minActivations: number;
    maxRecursionSteps: number;
  };
  /** Global regex scripts */
  regexScripts: RegexScript[];
  /** Dialogue / action / thought display + LLM format contract */
  messageStyle: MessageStyleSettings;
  /** Active quick-reply set id */
  activeQuickReplySetId: string;
  /** Global variables ({{getglobalvar}}) */
  globalVariables: Record<string, string>;
  /** Timeline / branching behaviour */
  timeline?: {
    /** What to do when changing swipe or deep-swiping mid-history with descendants. */
    midHistoryPolicy?: TimelineMidHistoryPolicy;
    /** Soft warning threshold for number of stored forks (default 40). */
    maxForksWarning?: number;
  };
  /** Chat area look (background, etc.) */
  appearance?: AppearanceSettings;
  /** Character Brain (long-term memory) defaults */
  brain?: BrainSettings;
  /** Global skill library behaviour (see docs/skills-system.md) */
  skills?: SkillsSettings;
}

// ---------- Prompt building ----------

export interface BuiltMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  name?: string;
}

export interface PromptItem {
  source: string; // e.g. 'main', 'worldInfoBefore', 'chatHistory[12]'
  role: string;
  tokens: number;
  preview: string;
}

export interface PromptPlan {
  messages: BuiltMessage[];
  itemization: PromptItem[];
  totalTokens: number;
  /** Scaffolding cost before memory, examples and transcript — see buildPrompt. */
  fixedTokens: number;
  stops: string[];
}
