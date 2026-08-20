/** Chat — solo & group. Streaming, AI Turn Director, play-as, in-place swipes,
 *  animated right rail (Members / Samplers / Inspector / Director / Author). */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useNavigate, useParams } from 'react-router-dom';
import type { CharacterCard, ChatMessage, ChatMeta, DirectorState, Group, Persona, TimelineGraphNode, TimelineState } from '@shared/types';
import { api, streamGenerate, ApiError, type BrainActivity } from '../api';
import { TimelinePanel } from '../components/TimelinePanel';
import { useApp } from '../store';
import { Avatar } from '../components/Avatar';
import { DirectorConsole } from '../components/DirectorConsole';
import { GenesisReveal } from '../components/GenesisReveal';
import { SamplerControls } from '../components/SamplerControls';
import { IconAi, IconDelete, IconDirection, IconEdit, IconNext, IconPlus, IconPrev } from '../components/Icons';
import { GlobeLoader, PageLoader } from '../components/GlobeLoader';
import { DirectionPopover } from '../components/DirectionPopover';
import { parseSlash, runSlash } from '@shared/engine/slash';
import { humanSeatId, humanSeatIds } from '@shared/engine/identity';
import {
  canSpeak, cursorAfterId, nextSpeakerId, reanchorCursor, type SeatContext,
} from '@shared/engine/turnOrder';
import { applyRegexScripts } from '@shared/engine/regex';
import {
  buildTimelineFromMessages,
  defaultBranchName,
  forkCountByMessage,
  forkCountWarning,
  graphViewModel,
} from '@shared/engine/timeline';
import type { QuickReply } from '@shared/types';
import {
  BookOpen, Brain, CaseSensitive, Check, ChevronDown, ChevronUp, Download, EyeOff, GitBranch, GitFork,
  MessageSquareQuote, PanelRight, PenLine, Save, SkipForward, SpellCheck,
  Trash2, Undo2, UserRound, Asterisk,
} from 'lucide-react';
import { FormattedMessage } from '../components/FormattedMessage';
import { GroupMemberStrip } from '../components/GroupMemberStrip';
import { SoftReveal } from '../components/SoftReveal';
import { MicDictateButton } from '../components/MicDictateButton';
import { PinnedModelSwitch } from '../components/PinnedModelSwitch';
import { ensureForcedMessageStyle, wrapWithRule } from '@shared/engine/messageStyle';
import {
  AUTHORS_NOTE_RICHNESS,
  DEFAULT_AUTHORS_NOTE_RICHNESS,
  clampAuthorsNoteRichness,
  type AuthorsNoteRichness,
  DRAFT_LENGTH,
  DEFAULT_DRAFT_LENGTH,
  clampDraftLength,
  type DraftLength,
} from '@shared/engine/agents';
import { useConfirm } from '../components/ConfirmDialog';

type CapsMode = 'normal' | 'sentences' | 'words';

/** Stand-in key for "no cast seat" when a null has to be remembered in a ref. */
const NO_SEAT = '__no_seat__';

/** Director mode: consecutive AI turns before the scene hands back to you. */
const DIRECTOR_TURN_CAP = 4;

/**
 * Auto-advance: turns the scene may take on its own before it stops for you.
 *
 * `autoModeDelay` was a stored, editable, and entirely unread setting — the
 * field promised the scene would keep playing and nothing anywhere made it do
 * so. Now that it works it needs a ceiling, because every turn is a model call
 * and a group chat left open overnight would otherwise keep spending.
 */
const AUTO_ADVANCE_CAP = 12;

const CAPS_CYCLE: CapsMode[] = ['normal', 'sentences', 'words'];
const CAPS_LABEL: Record<CapsMode, string> = {
  normal: 'Natural (as typed)',
  sentences: 'Sentence case',
  words: 'Capitalize Words',
};

/**
 * Full-string capitalization transforms (used when cycling the Aa button).
 * - normal: unchanged (caller restores natural snapshot)
 * - words: Title Case every word
 * - sentences: lowercase, then capitalise starts of sentences
 */
function transformCaps(text: string, mode: CapsMode): string {
  if (!text || mode === 'normal') return text;
  if (mode === 'words') {
    return text.replace(/\p{L}[\p{L}\p{M}\p{N}'’]*/gu, (word) => {
      const first = word[0] ?? '';
      const rest = word.slice(1);
      return first.toLocaleUpperCase() + rest.toLocaleLowerCase();
    });
  }
  // Sentence case
  const lower = text.toLocaleLowerCase();
  return lower.replace(
    /(^|[.!?…]["'”’)\]\}]*\s+)(\p{L})/gu,
    (_, lead: string, ch: string) => lead + ch.toLocaleUpperCase(),
  );
}

/**
 * Live typing helper: only force capitals on new boundaries so mid-word edits stay usable.
 * Words/sentences still lower the rest of a word when the first letter is capitalised.
 */
function applyCapsMode(text: string, mode: CapsMode): string {
  if (mode === 'normal' || !text) return text;
  // While typing, full transform is fine (same length) and keeps the field consistent
  return transformCaps(text, mode);
}

interface StreamingMsg {
  speakerName: string;
  avatar?: string;
  isNarrator: boolean;
  text: string;
  /** When set, stream replaces this message in-place (swipe / continue) — never a ghost row below. */
  targetMessageId?: string;
  mode?: 'swipe' | 'continue' | 'new';
}

type RailTab = 'cast' | 'tune' | 'inspector' | 'director' | 'note' | 'timeline';

/** Chat-only side panel — names distinct from left-rail drawers (Library, Presets, Lore…). */
const RAIL_LABEL: Record<RailTab, string> = {
  cast: 'Members',
  tune: 'Samplers',
  inspector: 'Inspector',
  director: 'Director',
  note: 'Author',
  timeline: 'Timeline',
};

/** Wider than 320 so six rail tabs (Members…Timeline) fit without crowding. */
const RAIL_WIDTH = 400;
const RAIL_EASE = [0.22, 1, 0.36, 1] as const;
/** Composer grows from one line up to this, then scrolls. */
const COMPOSER_MAX_H = 160;

export function ChatPage() {
  const { chatId } = useParams<{ chatId: string }>();
  const nav = useNavigate();
  const confirm = useConfirm();
  const setInspector = useApp((s) => s.setInspector);
  const setDrawer = useApp((s) => s.setDrawer);
  const inspector = useApp((s) => (chatId ? s.inspector[chatId] : undefined));
  const activePreset = useApp((s) => s.activePreset());
  const refreshChats = useApp((s) => s.refreshChats);
  const [meta, setMeta] = useState<ChatMeta | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [timeline, setTimeline] = useState<TimelineState | null>(null);
  const [timelineGraph, setTimelineGraph] = useState<TimelineGraphNode[]>([]);
  const [timelineWarning, setTimelineWarning] = useState<string | null>(null);
  const [selectedTimelineMsgId, setSelectedTimelineMsgId] = useState<string | null>(null);
  /** When set, Timeline branches list filters to forks at this message. */
  const [timelineForkFilterMsgId, setTimelineForkFilterMsgId] = useState<string | null>(null);
  const [group, setGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<CharacterCard[]>([]);
  const [soloChar, setSoloChar] = useState<CharacterCard | null>(null);
  const [persona, setPersona] = useState<Persona | null>(null);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState<StreamingMsg | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** Skills the last generated turn was actually given, from the SSE stream. */
  const [turnSkills, setTurnSkills] = useState<{ id: string; name: string; level: string }[]>([]);
  const [rail, setRail] = useState<RailTab | null>(null);

  const [genesis, setGenesis] = useState<{ card: CharacterCard; promptCard: string | null } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [styleBusy, setStyleBusy] = useState(false);
  const [slashNote, setSlashNote] = useState('');
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [dirOpen, setDirOpen] = useState(false);
  /** Write-me draft: AI fills the composer; accept / decline / regen without sending yet */
  const [writeDraft, setWriteDraft] = useState<{
    original: string;
    draft: string;
    status: 'streaming' | 'ready' | 'error';
    /** Human-readable failure reason (shown in the draft panel, not a bare "500") */
    error?: string;
  } | null>(null);
  /**
   * Write Me length — same 1–5 rail as the Author's Note slider, remembered
   * across chats because it is a preference about how you write, not about this
   * scene. Shown on the draft panel so the obvious move after a first draft is
   * "longer / shorter, Regen".
   */
  const [writeLength, setWriteLength] = useState<DraftLength>(readStoredWriteLength);
  /**
   * Impersonate draft — the character's next message, held for review.
   *
   * Carries the card it was written for: a group draft has to be posted in that
   * character's name minutes later, and the picker may have moved on since.
   */
  const [impDraft, setImpDraft] = useState<{
    card: { id: string; name: string; avatar?: string };
    original: string;
    draft: string;
    status: 'streaming' | 'ready' | 'error';
    error?: string;
  } | null>(null);
  /** Its own rail: a character's reply length is not the same preference as yours. */
  const [impLength, setImpLength] = useState<DraftLength>(readStoredImpLength);
  const [impPickOpen, setImpPickOpen] = useState(false);
  /**
   * Narrator draft — the next beat, held for review.
   *
   * Same panel and same rail as Impersonate, minus the card: narration has no
   * speaker to pin, so there is nothing that can become ineligible between the
   * draft and the Accept. What it keeps instead is the composer seed, so Regen
   * can re-read the box the way both other tools do.
   */
  const [narDraft, setNarDraft] = useState<{
    original: string;
    draft: string;
    status: 'streaming' | 'ready' | 'error';
    error?: string;
  } | null>(null);
  /** Third rail: how long a scene beat should run is its own preference again. */
  const [narLength, setNarLength] = useState<DraftLength>(readStoredNarLength);
  const [capsMode, setCapsMode] = useState<CapsMode>('normal');
  /**
   * Proofread: `busy` while the model is working, `undo` holding the pre-fix text
   * so one click puts the user's own words back. Unlike Write Me this needs no
   * accept/decline panel — the change is small and reversible by design.
   */
  const [proofread, setProofread] = useState<{ busy: boolean; undo: string | null }>({
    busy: false,
    undo: null,
  });
  /** Natural "as typed" text so cycling back from Word/Sentence case can restore it. */
  const naturalInputRef = useRef('');
  /** When false, Send is disabled (AI turn chain). Solo / natural always true when idle. */
  const [awaitingUser, setAwaitingUser] = useState(true);
  /** AI Director is calling the model to pick the next speaker (not generating dialogue yet). */
  const [directorDeciding, setDirectorDeciding] = useState(false);
  /** Mirrors of the two "something is running" flags, for the Esc listener. */
  const busyRef = useRef(false);
  const decidingRef = useRef(false);
  decidingRef.current = directorDeciding;
  busyRef.current = busy;
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [turnModeOpen, setTurnModeOpen] = useState(false);
  /** Expanded header cast: always on in manual; toggle for series drag-order */
  const [castExpanded, setCastExpanded] = useState(false);
  const [dragMemberId, setDragMemberId] = useState<string | null>(null);
  /** Compact tool row: icon-only primary actions; Narrator/Skip in overflow */
  const [compactTools, setCompactTools] = useState(false);
  const [toolsMoreOpen, setToolsMoreOpen] = useState(false);
  const dirBtnRef = useRef<HTMLButtonElement>(null);
  const turnModeRef = useRef<HTMLDivElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const composerActionsRef = useRef<HTMLDivElement>(null);
  const toolsMoreRef = useRef<HTMLDivElement>(null);
  const impPickRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<(() => void) | null>(null);
  /**
   * The synchronous truth about "this chat is already doing something".
   *
   * `busy` is React state and lands a tick late, and it is only ever true while
   * a *stream* is open — not while the Turn Director is deciding, and not in the
   * gap between one turn resolving and the next starting inside a loop. Every
   * entry point used to check `busy` alone, which meant a click during either
   * window started a second generation: `abortRef` was overwritten, the first
   * stream was orphaned with nobody holding its cancel function, Stop could not
   * reach it, and two streams raced to write the transcript.
   */
  const activeRef = useRef<symbol | null>(null);
  const autoTurnsRef = useRef(0);
  /**
   * Bumped by Stop. A turn loop captures the value it started with and bails the
   * moment it changes, so stopping mid-chain ends the whole run — not just the
   * one reply that happened to be streaming.
   */
  const turnRunRef = useRef(0);
  /** In-flight Turn Director request, so "who speaks next" is interruptible too. */
  const decideAbortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * Sticky bottom (ChatGPT / Claude pattern):
   * auto-follow new tokens only while the user is near the bottom.
   * Scroll up → pin off; scroll back near bottom → pin on.
   * New user send / generate → pin back on so the fresh reply is followed.
   */
  const pinToBottomRef = useRef(true);
  const scrollRafRef = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const settings = useApp((s) => s.settings);
  const saveSettings = useApp((s) => s.saveSettings);
  const storePersonas = useApp((s) => s.personas);
  const storeCharacters = useApp((s) => s.characters);
  const refreshGroups = useApp((s) => s.refreshGroups);
  const refreshCharacters = useApp((s) => s.refreshCharacters);
  const becomeCharacter = useApp((s) => s.becomeCharacter);

  function insertStyle(role: 'dialogue' | 'action') {
    const rules = ensureForcedMessageStyle(settings?.messageStyle).rules;
    const rule = rules.find((r) => r.role === role && r.enabled) ?? rules.find((r) => r.role === role);
    if (!rule) return;
    const el = composerRef.current;
    const start = el?.selectionStart ?? input.length;
    const end = el?.selectionEnd ?? input.length;
    const { next, cursor } = wrapWithRule(input, start, end, rule);
    setInput(applyCapsMode(next, capsMode));
    requestAnimationFrame(() => {
      if (!composerRef.current) return;
      composerRef.current.focus();
      composerRef.current.setSelectionRange(cursor, cursor);
    });
  }

  /**
   * Proofread the draft in place: spelling, grammar, punctuation, and closing a
   * sentence the writer left hanging. Never a rewrite — see `proofreadPrompt`.
   *
   * Clicking again while a correction is showing reverts to what was typed, so
   * the button is safe to press on a line you were happy with.
   */
  async function proofreadDraft() {
    if (proofread.busy) return;

    if (proofread.undo !== null) {
      const original = proofread.undo;
      naturalInputRef.current = original;
      setInput(original);
      setProofread({ busy: false, undo: null });
      requestAnimationFrame(() => {
        composerRef.current?.focus();
        resizeComposer();
      });
      return;
    }

    const source = input;
    if (!source.trim()) {
      setSlashNote('Write something first — this fixes your spelling and grammar, it does not write for you.');
      window.setTimeout(() => setSlashNote((cur) => (cur.startsWith('Write something first') ? '' : cur)), 3500);
      return;
    }

    setProofread({ busy: true, undo: null });
    try {
      const res = await api.proofread(source, chatId);
      const fixed = (res.text ?? '').trim();
      if (!fixed || fixed === source.trim()) {
        // Nothing to correct is a success, not an error — say so and leave it alone.
        setProofread({ busy: false, undo: null });
        setSlashNote('Nothing to fix — that already reads clean.');
        window.setTimeout(() => setSlashNote((cur) => (cur.startsWith('Nothing to fix') ? '' : cur)), 2500);
        return;
      }
      // Caps mode is a display transform over the natural text; the correction
      // becomes the new natural baseline so cycling case still behaves.
      naturalInputRef.current = fixed;
      setInput(capsMode === 'normal' ? fixed : transformCaps(fixed, capsMode));
      setProofread({ busy: false, undo: source });
      requestAnimationFrame(() => {
        const el = composerRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
        resizeComposer();
      });
    } catch (err: any) {
      setProofread({ busy: false, undo: null });
      setError(err?.message ?? 'Proofread failed.');
    }
  }

  function cycleCapsMode() {
    const el = composerRef.current;
    const selStart = el?.selectionStart ?? 0;
    const selEnd = el?.selectionEnd ?? 0;
    const hadFullSelection =
      !!el && el.value.length > 0 && selStart === 0 && selEnd === el.value.length;
    const hadAnySelection = selStart !== selEnd;

    const i = CAPS_CYCLE.indexOf(capsMode);
    const next = CAPS_CYCLE[(i + 1) % CAPS_CYCLE.length];

    // Freeze natural when leaving natural mode; always transform from that snapshot
    // so Word → Sentence → Natural cycles are stable and visible.
    if (capsMode === 'normal') {
      naturalInputRef.current = input;
    }
    const base = naturalInputRef.current || input;

    let nextText: string;
    if (next === 'normal') {
      nextText = naturalInputRef.current || input;
    } else if (hadAnySelection && !hadFullSelection) {
      // Partial selection: only re-case the selected span (from natural when possible)
      const baseSel =
        naturalInputRef.current && naturalInputRef.current.length === input.length
          ? naturalInputRef.current.slice(selStart, selEnd)
          : input.slice(selStart, selEnd);
      const transformedSel = transformCaps(baseSel, next);
      nextText = input.slice(0, selStart) + transformedSel + input.slice(selEnd);
      // Keep natural in sync for the edited span when lengths match
      if (naturalInputRef.current && naturalInputRef.current.length === input.length) {
        naturalInputRef.current =
          naturalInputRef.current.slice(0, selStart)
          + baseSel
          + naturalInputRef.current.slice(selEnd);
      }
    } else {
      nextText = transformCaps(base, next);
    }

    setCapsMode(next);
    setInput(nextText);

    // Keep focus + selection so click-cycling with all text selected keeps working
    requestAnimationFrame(() => {
      const box = composerRef.current;
      if (!box) return;
      box.focus();
      if (hadFullSelection && nextText.length > 0) {
        // Select-all stays selected so you can keep cycling
        box.setSelectionRange(0, nextText.length);
      } else if (hadAnySelection) {
        const selLen = selEnd - selStart;
        const end = Math.min(selStart + selLen, nextText.length);
        box.setSelectionRange(selStart, Math.max(selStart, end));
      } else {
        box.setSelectionRange(nextText.length, nextText.length);
      }
      resizeComposer();
    });
  }

  function onComposerChange(value: string) {
    const el = composerRef.current;
    const start = el?.selectionStart ?? value.length;
    // Once they edit by hand, "undo the fix" would restore text older than what
    // they are looking at — so the offer expires.
    if (proofread.undo !== null) setProofread({ busy: false, undo: null });
    if (capsMode === 'normal') {
      naturalInputRef.current = value;
      setInput(value);
    } else {
      // Edits become the new natural baseline; display is fully re-cased for the mode
      naturalInputRef.current = value;
      const transformed = transformCaps(value, capsMode);
      setInput(transformed);
      if (el && transformed.length === value.length) {
        requestAnimationFrame(() => {
          if (!composerRef.current) return;
          composerRef.current.setSelectionRange(start, start);
        });
      }
    }
    resizeComposer();
  }

  /** Single-line start → grow to max → then scroll. */
  function resizeComposer() {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 0), COMPOSER_MAX_H)}px`;
  }

  /** Insert local Whisper dictation at the caret (on-device STT, not LLM). */
  /**
   * Live dictation preview.
   *
   * Words appear in the composer while they are still being spoken, so the
   * text before the caret is frozen on the first partial and the transcript is
   * rewritten after it on every update. Passing '' clears the preview.
   */
  const dictationBaseRef = useRef<{ before: string; after: string } | null>(null);

  function showLiveDictation(live: string) {
    if (!live) {
      dictationBaseRef.current = null;
      return;
    }
    if (!dictationBaseRef.current) {
      const el = composerRef.current;
      const start = el?.selectionStart ?? input.length;
      const end = el?.selectionEnd ?? input.length;
      dictationBaseRef.current = { before: input.slice(0, start), after: input.slice(end) };
    }
    const { before, after } = dictationBaseRef.current;
    const needBefore = before.length > 0 && !/\s$/.test(before);
    setInput(`${before}${needBefore ? ' ' : ''}${live}${after}`);
  }

  function insertDictation(text: string) {
    const clean = text.replace(/\s+/g, ' ').trim();
    // The live preview already anchored where the text goes; reuse that anchor
    // so the final result cannot land in a different place than the preview.
    const anchor = dictationBaseRef.current;
    dictationBaseRef.current = null;
    if (!clean) {
      if (anchor) setInput(anchor.before + anchor.after);
      return;
    }
    if (anchor) {
      const needBefore = anchor.before.length > 0 && !/\s$/.test(anchor.before);
      const needAfter = anchor.after.length > 0 && !/^[\s.!?…]/.test(anchor.after);
      const piece = `${needBefore ? ' ' : ''}${clean}${needAfter ? ' ' : ''}`;
      const next = anchor.before + piece + anchor.after;
      const cursor = anchor.before.length + piece.length - (needAfter ? 1 : 0);
      setInput(applyCapsMode(next, capsMode));
      requestAnimationFrame(() => {
        const el = composerRef.current;
        el?.focus();
        el?.setSelectionRange(cursor, cursor);
      });
      return;
    }
    const el = composerRef.current;
    const start = el?.selectionStart ?? input.length;
    const end = el?.selectionEnd ?? input.length;
    const before = input.slice(0, start);
    const after = input.slice(end);
    const needBefore = before.length > 0 && !/\s$/.test(before);
    const needAfter = after.length > 0 && !/^[\s.!?…]/.test(after);
    const piece = `${needBefore ? ' ' : ''}${clean}${needAfter ? ' ' : ''}`;
    const next = before + piece + after;
    const cursor = before.length + piece.length - (needAfter ? 1 : 0);
    setInput(applyCapsMode(next, capsMode));
    requestAnimationFrame(() => {
      const box = composerRef.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(cursor, cursor);
      resizeComposer();
    });
  }

  /**
   * Which chat load is the current one.
   *
   * `load` has no abort signal, so a slow response for the chat you just left
   * used to arrive after the new one had rendered and overwrite it — you would
   * open a conversation and find the previous one's messages under its header.
   * Every setter below is gated on still being the newest request.
   */
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    if (!chatId) return;
    const seq = ++loadSeqRef.current;
    const current = () => loadSeqRef.current === seq;
    setError('');
    /**
     * A different conversation is a clean slate.
     *
     * Only the cast was being cleared, so the previous chat's messages, composer
     * text, half-finished Write Me draft and open editor all survived the
     * switch — and an edit committed at that moment wrote the old chat's text
     * into the new chat's file.
     */
    setGroup(null); setSoloChar(null); setAwaitingUser(true); setDirectorDeciding(false);
    setMessages([]); setMembers([]); setStreaming(null); setBusy(false);
    setInput(''); setWriteDraft(null); setEditing(null); setEditText('');
    setSlashNote(''); setGenesis(null); setTimeline(null); setTimelineGraph([]);
    setSelectedTimelineMsgId(null); setTimelineForkFilterMsgId(null);
    setProofread({ busy: false, undo: null });
    autoTurnsRef.current = 0;
    autoChainRef.current = 0;
    activeRef.current = null;
    try {
      // Always pull fresh character library so group + / play-as stay current
      const [chat, personas, allChars] = await Promise.all([
        api.getChat(chatId),
        api.listPersonas(),
        api.listCharacters(),
      ]);
      if (!current()) return;
      const { meta, messages, timeline: tl, graph } = chat as typeof chat & { timeline?: TimelineState; graph?: TimelineGraphNode[] };
      setMeta(meta);
      setMessages(messages);
      if (tl) setTimeline(tl);
      if (graph) setTimelineGraph(graph);
      else setTimelineGraph([]);
      // Keep global store in sync with disk (imports from Home, studio, etc.)
      useApp.setState({ characters: allChars });
      const activeId = useApp.getState().settings?.activePersonaId;
      setPersona(
        personas.find((p) => p.id === activeId)
          ?? personas.find((p) => p.id === meta.personaId)
          ?? personas[0],
      );
      if (meta.groupId) {
        let g = await api.getGroup(meta.groupId);
        if (!current()) return;
        // Heal orphan cast seats (deleted characters) so play-as / next never stick on ghosts
        const validMembers = g.members.filter((id) => allChars.some((c) => c.id === id));
        const playAsValid = g.playAs && validMembers.includes(g.playAs) ? g.playAs : null;
        const disabledValid = (g.disabledMembers ?? []).filter((id) => validMembers.includes(id));
        if (
          validMembers.length !== g.members.length
          || playAsValid !== g.playAs
          || disabledValid.length !== (g.disabledMembers ?? []).length
        ) {
          try {
            g = await api.updateGroup(g.id, {
              members: validMembers,
              playAs: playAsValid,
              disabledMembers: disabledValid,
            });
            void refreshGroups();
          } catch {
            g = { ...g, members: validMembers, playAs: playAsValid, disabledMembers: disabledValid };
          }
        }
        if (!current()) return;
        setGroup(g);
        setMembers(
          g.members.map((id) => allChars.find((c) => c.id === id)).filter(Boolean) as CharacterCard[],
        );
        setSoloChar(null);
      } else if (meta.characterId) {
        setGroup(null);
        setMembers([]);
        setSoloChar(allChars.find((c) => c.id === meta.characterId) ?? null);
      }
    } catch (err: any) {
      if (current()) setError(err.message);
    }
  }, [chatId, refreshGroups]);
  useEffect(() => { void load(); }, [load]);

  // Leaving the chat ends its turns — a chained scene must not keep generating
  // into a chat you have closed.
  useEffect(() => () => {
    turnRunRef.current += 1;
    decideAbortRef.current?.abort();
    decideAbortRef.current = null;
    abortRef.current?.();
    abortRef.current = null;
  }, [chatId]);

  // Esc stops whatever is running (never while typing in a field).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))) return;
      if (!busyRef.current && !decidingRef.current) return;
      e.preventDefault();
      stopGeneration();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Re-sync library when window regains focus (user may have imported elsewhere)
  useEffect(() => {
    const onFocus = () => { void refreshCharacters(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshCharacters]);

  // Drop deleted characters from live cast / play-as (avoids sticky selection ring on ghosts)
  useEffect(() => {
    if (!group || !storeCharacters.length) return;
    const known = new Set(storeCharacters.map((c) => c.id));
    const nextMembers = group.members.filter((id) => known.has(id));
    const nextPlayAs = group.playAs && known.has(group.playAs) && nextMembers.includes(group.playAs)
      ? group.playAs
      : null;
    const nextDisabled = group.disabledMembers.filter((id) => known.has(id));
    const castChanged =
      nextMembers.length !== group.members.length
      || nextPlayAs !== group.playAs
      || nextDisabled.length !== group.disabledMembers.length;
    if (castChanged) {
      setGroup((g) =>
        g
          ? { ...g, members: nextMembers, playAs: nextPlayAs, disabledMembers: nextDisabled }
          : g,
      );
      void api
        .updateGroup(group.id, {
          members: nextMembers,
          playAs: nextPlayAs,
          disabledMembers: nextDisabled,
        })
        .then((g) => {
          setGroup(g);
          void refreshGroups();
        })
        .catch(() => { /* keep optimistic local cast */ });
    }
    setMembers((prev) => {
      const next = nextMembers
        .map((id) => storeCharacters.find((c) => c.id === id) ?? prev.find((p) => p.id === id))
        .filter(Boolean) as CharacterCard[];
      if (
        next.length === prev.length
        && next.every((c, i) => c.id === prev[i]?.id && c.avatar === prev[i]?.avatar)
      ) {
        return prev;
      }
      return next;
    });
  }, [storeCharacters, group?.id, group?.members, group?.playAs, group?.disabledMembers, refreshGroups]);

  useEffect(() => {
    // Only user-authored quick replies (never ship dumb "Hello" defaults in the composer)
    api.listQuickReplies().then((sets) => {
      const id = settings?.activeQuickReplySetId ?? 'default';
      const set = sets.find((s) => s.id === id) ?? sets[0];
      const junk = new Set(['hello', 'hello!', '…', '...', '/continue', '/regen', '/regenerate']);
      setQuickReplies(
        (set?.replies ?? []).filter((r) => {
          const m = r.message.trim().toLowerCase();
          const l = r.label.trim().toLowerCase();
          if (junk.has(m) || junk.has(l)) return false;
          if (r.isSystem) return false;
          return m.length > 0;
        }),
      );
    }).catch(() => {});
  }, [settings?.activeQuickReplySetId]);

  /** Distance from bottom under which we treat the viewport as "at bottom". */
  const NEAR_BOTTOM_PX = 120;

  const isNearBottom = useCallback((el: HTMLElement, threshold = NEAR_BOTTOM_PX) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }, []);

  /** Re-enable follow mode (user sent / started gen / jumped to tip). */
  const pinScrollToBottom = useCallback(() => {
    pinToBottomRef.current = true;
    const el = scrollRef.current;
    if (!el) return;
    // Instant jump — smooth fights streaming token updates
    el.scrollTop = el.scrollHeight;
  }, []);

  /** Follow stream only if still pinned. */
  const scrollToBottomIfPinned = useCallback(() => {
    if (!pinToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const onMessagesScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // User scrolled away from tip → stop yanking them down on every token
    pinToBottomRef.current = isNearBottom(el);
  }, [isNearBottom]);

  // Auto-scroll while pinned: new messages + streaming deltas
  useEffect(() => {
    if (!pinToBottomRef.current) return;
    // Coalesce rapid stream deltas into one layout frame
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = 0;
      scrollToBottomIfPinned();
    });
    return () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
    };
  }, [messages, streaming, streaming?.text, scrollToBottomIfPinned]);

  // Keep composer height in sync when text / drafts change
  useEffect(() => {
    resizeComposer();
  }, [input]);

  // Sync persona from global store (Persona drawer create / import / become)
  useEffect(() => {
    if (!storePersonas.length) return;
    const preferred =
      storePersonas.find((p) => p.id === settings?.activePersonaId)
      ?? (meta?.personaId ? storePersonas.find((p) => p.id === meta.personaId) : undefined)
      ?? storePersonas[0];
    if (preferred) setPersona(preferred);
  }, [storePersonas, settings?.activePersonaId, meta?.personaId]);

  /**
   * Your seat in the cast. The persona and `group.playAs` describe the same
   * person, so they are resolved to one id here: a persona minted from a cast
   * member's card (or simply sharing their name) *is* that member. Without this
   * the AI happily wrote lines for the character you were playing — you replying
   * to yourself under your own face.
   */
  const youIds = useMemo(
    () => (group ? humanSeatIds({ members, playAs: group.playAs, persona }) : []),
    [group, members, persona],
  );
  const youId = useMemo(
    () => (group ? humanSeatId({ members, playAs: group.playAs, persona }) : null),
    [group, members, persona],
  );
  /** True for any cast member the human occupies — AI must never voice them. */
  const isYou = (id?: string | null) => !!id && youIds.includes(id);

  const playAsCard = youId ? members.find((m) => m.id === youId) ?? null : null;
  const userDisplayName = playAsCard?.name ?? persona?.name ?? 'You';
  const allCards = members.concat(soloChar ? [soloChar] : []);

  /**
   * Keep the cast seat and the persona pointing at the same person.
   *
   * Becoming a cast member anywhere (Persona drawer, Home, the As row) claims
   * their seat, so the AI stops writing them; becoming somebody outside the cast
   * releases whatever seat was held. Without this the two systems drifted and
   * the same character existed twice — once as you, once as an AI.
   */
  const lastPersonaIdRef = useRef<string | null>(null);
  const seatSyncFailedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!group || !persona) return;
    const seat = humanSeatIds({ members, persona })[0] ?? null;
    const personaSwitched = lastPersonaIdRef.current !== null && lastPersonaIdRef.current !== persona.id;
    lastPersonaIdRef.current = persona.id;
    if (seatSyncFailedRef.current === (seat ?? NO_SEAT)) return;
    if (seat) {
      if (group.playAs !== seat) void applyPlayAs(seat);
    } else if (personaSwitched && group.playAs) {
      void applyPlayAs(null);
    }
  }, [persona?.id, group?.id, group?.playAs, members]);

  /** Resolve portrait for a speaker — prefers card cache, then global library, then id path. */
  function avatarFor(characterId?: string, fallbackName?: string): { src?: string; name: string; id?: string } {
    if (!characterId) return { name: fallbackName ?? '?' };
    const card =
      allCards.find((c) => c.id === characterId)
      ?? storeCharacters.find((c) => c.id === characterId)
      ?? null;
    const src = card?.avatar || `/api/avatars/${characterId}.png`;
    return { src, name: card?.name ?? fallbackName ?? '?', id: characterId };
  }

  /** Normalize legacy 'pooled' → series (list). One ordered mode is enough. */
  const turnMode = group
    ? (group.turnMode === 'pooled' ? 'list' : group.turnMode)
    : null;

  /** Members in group.members order (series order). */
  const orderedMembers = useMemo(() => {
    if (!group) return members;
    const byId = new Map(members.map((m) => [m.id, m]));
    const ordered = group.members.map((id) => byId.get(id)).filter(Boolean) as CharacterCard[];
    // Include any member cards not yet in group.members (shouldn't happen, safety)
    for (const m of members) {
      if (!group.members.includes(m.id)) ordered.push(m);
    }
    return ordered;
  }, [group, members]);

  /** Eligible AI speakers in series order (skips muted + play-as). */
  const seriesSpeakers = useMemo(() => {
    if (!group) return orderedMembers;
    return orderedMembers.filter(
      (m) => !group.disabledMembers.includes(m.id) && !isYou(m.id),
    );
  }, [group, orderedMembers, youIds]);

  /** Cast the Impersonate picker may offer — unmuted, still present, not yours. */
  const impCandidates = useMemo(
    () => (group ? seriesSpeakers : soloChar ? [soloChar] : []),
    [group, seriesSpeakers, soloChar],
  );

  /** Last AI character that spoke (user replies freeze this). Streaming wins. */
  const lastAiSpeakerId = useMemo(() => {
    if (streaming && !streaming.isNarrator) {
      const byName = members.find((m) => m.name === streaming.speakerName);
      if (byName) return byName.id;
      if (soloChar && soloChar.name === streaming.speakerName) return soloChar.id;
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.controlledBy === 'ai' && m.speaker.type === 'character' && m.speaker.characterId) {
        return m.speaker.characterId;
      }
    }
    return null;
  }, [streaming, messages, members, soloChar]);

  /**
   * What memory is doing, so the chat can say so.
   *
   * Consolidation is background work that costs real time and real model calls,
   * and none of it was visible from the conversation: a mind could be halfway
   * through reading a long scene with nothing anywhere to indicate it. Polled
   * gently, paused when the tab is hidden, and never allowed to raise an error —
   * this is an indicator, not a feature the chat depends on.
   */
  const [brainActivity, setBrainActivity] = useState<BrainActivity | null>(null);
  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    let controller: AbortController | null = null;
    const tick = async () => {
      if (cancelled || document.hidden) return;
      controller?.abort();
      controller = new AbortController();
      try {
        const next = await api.brain.activity(chatId, { signal: controller.signal });
        if (!cancelled) setBrainActivity(next);
      } catch {
        /* memory status is decoration; never surface its failures in the chat */
      }
    };
    void tick();
    const t = window.setInterval(() => void tick(), 6000);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(t);
      setBrainActivity(null);
    };
  }, [chatId]);

  /** The last AI character actually in the transcript — no streaming, no guesses. */
  const lastSpokenCharacterId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.controlledBy === 'ai' && m.speaker.type === 'character' && m.speaker.characterId) {
        return m.speaker.characterId;
      }
    }
    return null;
  }, [messages]);

  /**
   * Keep the series cursor honest about the transcript.
   *
   * The cursor is a *cache* of one fact — the series resumes after whoever last
   * spoke — but only the turn loop and a forced reply ever wrote it. Every other
   * way the transcript can change left it pointing at the old future: delete the
   * reply that just landed and the character who wrote it silently forfeits
   * their turn forever, and the same went for editing, branching, restoring a
   * path and deep-swiping. Deriving it here means a rewrite of any kind lands
   * the turn where it belongs, and the turn loop's own write becomes a no-op
   * agreement rather than the only source of truth.
   *
   * Held off while a turn is in flight: mid-stream the transcript is not yet
   * what it is about to be.
   */
  useEffect(() => {
    if (!group || turnMode !== 'list' || busy || streaming) return;
    if (!lastSpokenCharacterId) return;
    const next = cursorAfter(lastSpokenCharacterId);
    if (next !== null) commitSeriesCursor(next);
  }, [group?.id, group?.members, group?.listIndex, turnMode, busy, streaming, lastSpokenCharacterId]);

  /**
   * Left-of-title face: who is next.
   * Series → seat at listIndex (if that's you/play-as, preview next AI instead).
   * Never shows play-as as an AI "next" ring.
   */
  const focusSpeakerId = useMemo(() => {
    const notPlayAs = (id: string | null | undefined) => !!id && !isYou(id);

    if (streaming && !streaming.isNarrator) {
      const byName = members.find((m) => m.name === streaming.speakerName);
      if (byName && notPlayAs(byName.id)) return byName.id;
    }
    if (group && turnMode === 'list') {
      // Same picker the turn actually uses, so the preview can never disagree
      // with who speaks when you hit Send.
      return seriesPick()?.id ?? null;
    }
    if (notPlayAs(lastAiSpeakerId)) return lastAiSpeakerId;
    if (soloChar) return soloChar.id;
    if (group) return seriesSpeakers[0]?.id ?? null;
    return null;
  }, [streaming, members, group, turnMode, seriesSpeakers, lastAiSpeakerId, soloChar, youIds]);

  /**
   * Left of title = preview of next AI speaker (NOT removed from the right cast).
   * Right cast = always every group member. Play-as is marked "you", never "next" for AI.
   */
  const headerCast = useMemo(() => {
    const cast = group ? orderedMembers : soloChar ? [soloChar] : [];
    if (!cast.length) return { focus: null as CharacterCard | null, all: [] as CharacterCard[] };
    let focusId = focusSpeakerId;
    if (lastAiSpeakerId && turnMode !== 'list' && !streaming && !isYou(lastAiSpeakerId)) {
      focusId = lastAiSpeakerId;
    }
    // Never preview the human-controlled character as AI "next"
    if (isYou(focusId)) {
      focusId = seriesSpeakers[0]?.id ?? null;
    }
    const focus = focusId ? cast.find((c) => c.id === focusId) ?? null : seriesSpeakers[0] ?? null;
    return { focus, all: cast };
  }, [group, orderedMembers, soloChar, focusSpeakerId, lastAiSpeakerId, turnMode, streaming, seriesSpeakers, youIds]);

  /**
   * Whose mind the header button opens: the solo character, or in a group the
   * one currently in focus (next/last to speak) — the head the scene is in.
   */
  const mindTarget = soloChar ?? headerCast.focus ?? headerCast.all[0] ?? null;

  /**
   * One line about the state of memory, for the Mind button's tooltip.
   *
   * Says which of the three things is true — reading now, waiting for more to
   * happen, or switched off — because "nothing is happening" and "memory is
   * disabled" look identical from the outside and only one of them is a problem.
   */
  const memoryStatus = useMemo((): { working: boolean; label?: string } => {
    const a = brainActivity;
    if (!a) return { working: false };
    if (!a.globalEnabled) return { working: false, label: 'Memory is switched off in the Memory drawer.' };
    const job = a.job;
    if (job && (job.status === 'planning' || job.status === 'running')) {
      const who = job.members.find((m) => m.characterId === job.currentCharacterId)?.name;
      return {
        working: true,
        label: who
          ? `Reading ${who}'s side of the scene — ${job.chunksDone}/${job.chunks || '?'} passes`
          : 'Consolidating this conversation…',
      };
    }
    const busyNames = a.members.filter((m) => m.consolidating).map((m) => m.name);
    if (busyNames.length) {
      return { working: true, label: `${busyNames.join(', ')} ${busyNames.length === 1 ? 'is' : 'are'} taking in what just happened…` };
    }
    const live = a.members.filter((m) => m.enabled);
    if (!live.length) return { working: false };
    const soonest = live.reduce((a2, b) => (b.cadence - b.pending < a2.cadence - a2.pending ? b : a2));
    const until = Math.max(0, soonest.cadence - soonest.pending);
    return {
      working: false,
      label: until === 0
        ? `${soonest.name} has ${soonest.pending} unread — a pass is due`
        : `Next memory pass in ${until} message${until === 1 ? '' : 's'} (${soonest.name})`,
    };
  }, [brainActivity]);

  /** Manual always expanded; series expands for drag; optional expand for others */
  const castIsExpanded =
    !!group && (turnMode === 'manual' || turnMode === 'list' || castExpanded);

  const sendAvatarSrc = playAsCard?.avatar ?? persona?.avatar;
  const sendAvatarName = userDisplayName;
  /**
   * Is the composer yours right now?
   *
   * This used to read `turnMode === 'manual' || turnMode !== 'director' || …`,
   * whose second clause subsumes the first and is true for every non-director
   * mode — so `awaitingUser` was ignored outside Director and the composer
   * stayed live through a Series turn. Solo chats and Manual mode really are
   * always yours; every other mode has to wait for the AI to finish.
   */
  const isUserTurn = !group || turnMode === 'manual' || awaitingUser;
  const canSend = !busy && isUserTurn && !!input.trim();
  /** Idle user turn with empty box — soft prompt that it's their line (rotating ring on Send). */
  const showUserTurnHint = !!group && isUserTurn && !busy && !directorDeciding && !input.trim() && !writeDraft;

  // Auto-expand when switching to manual / series
  useEffect(() => {
    if (turnMode === 'manual' || turnMode === 'list') setCastExpanded(true);
  }, [turnMode]);

  useEffect(() => {
    if (!turnModeOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (turnModeRef.current && !turnModeRef.current.contains(e.target as Node)) setTurnModeOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [turnModeOpen]);

  // Collapse composer tools when the row is tight (group avatars crowd the right side)
  useEffect(() => {
    const el = composerActionsRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const w = el.clientWidth;
      const playAsW = group ? 72 + Math.min(members.length, 8) * 34 : 0;
      // Full labels need ~420px tools + play-as; below that → icon-only + overflow
      setCompactTools(w < 520 + playAsW || w < 680);
    };
    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [group, members.length, rail]);

  useEffect(() => {
    if (!toolsMoreOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (toolsMoreRef.current && !toolsMoreRef.current.contains(e.target as Node)) {
        setToolsMoreOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [toolsMoreOpen]);

  // The cast picker dismisses like every other menu here: click away or Esc.
  useEffect(() => {
    if (!impPickOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (impPickRef.current && !impPickRef.current.contains(e.target as Node)) {
        setImpPickOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setImpPickOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [impPickOpen]);

  useEffect(() => {
    if (editingTitle) {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    }
  }, [editingTitle]);

  /**
   * Take exclusive control of this chat's turn, or refuse.
   *
   * Returns the token that must be handed back to `releaseTurn`, or `null` when
   * somebody else already has it. Every path that can start a generation goes
   * through here, so "two replies at once" stops being possible rather than
   * being unlikely.
   */
  function claimTurn(): symbol | null {
    if (activeRef.current) return null;
    const token = Symbol('turn');
    activeRef.current = token;
    return token;
  }

  function releaseTurn(token: symbol | null) {
    if (token && activeRef.current === token) activeRef.current = null;
  }

  function generateAs(
    speakerId: string | undefined,
    speakerName: string,
    avatar?: string,
    isNarrator = false,
    opts?: {
      mode?: 'swipe';
      generationType?: 'normal' | 'continue' | 'impersonate' | 'suggest_user' | 'narrate';
      targetMessageId?: string;
      hint?: string;
      /** Stream draft into composer (write-me), not as a chat bubble */
      intoComposer?: boolean;
      /**
       * Stream into a review panel; nothing is posted until Accept. Which panel
       * follows from the speaker — narrator beats have their own.
       */
      intoDraft?: boolean;
      /** Draft length slider (1–5) — Write Me, Impersonate, Narrator */
      draftLength?: DraftLength;
      /** Set by the turn loop, which already holds the turn for the whole chain. */
      owned?: boolean;
    },
  ): Promise<ChatMessage | null> {
    // Exclusive control: never let AI write the character the human is playing as
    const genType = opts?.generationType ?? 'normal';
    if (isYou(speakerId) && !isNarrator && genType !== 'suggest_user') {
      setError(`You're playing as ${speakerName} — AI won't write their lines. Switch "As" first.`);
      setAwaitingUser(true);
      return Promise.resolve(null);
    }
    // The loop owns the turn across its whole chain; a standalone call takes it
    // for itself and refuses outright if the chat is already mid-turn.
    const token = opts?.owned ? null : claimTurn();
    if (!opts?.owned && !token) return Promise.resolve(null);
    const done = () => releaseTurn(token);

    return new Promise((resolve) => {
      setBusy(true);
      setError('');
      // Starting a reply re-pins to bottom so the user follows the new stream
      // (unless this is Write Me into the composer, which doesn't grow the transcript).
      const intoComposer =
        opts?.intoComposer ||
        opts?.generationType === 'suggest_user';
      // Impersonate and Narrator in review mode stream into their own panel,
      // not the transcript.
      const intoDraft = !!opts?.intoDraft;
      /**
       * One streaming path, two panels. The alternative — a second copy of every
       * delta / done / error branch below — is how the two flows drift apart the
       * first time one of them is fixed.
       */
      const draftKind: 'narrate' | 'impersonate' | null =
        intoDraft ? (isNarrator ? 'narrate' : 'impersonate') : null;
      const draftLabel = draftKind === 'narrate' ? 'Narrator' : 'Impersonate';
      const patchDraft = (patch: { draft?: string; status?: 'streaming' | 'ready' | 'error'; error?: string }) => {
        if (draftKind === 'narrate') setNarDraft((d) => (d ? { ...d, ...patch } : d));
        else setImpDraft((d) => (d ? { ...d, ...patch } : d));
      };
      const offTranscript = intoComposer || intoDraft;
      if (!offTranscript) {
        pinToBottomRef.current = true;
        // next frame after streaming row mounts
        requestAnimationFrame(() => pinScrollToBottom());
      }
      const inPlace = opts?.mode === 'swipe' || opts?.generationType === 'continue';
      let accumulated = '';
      if (!offTranscript) {
        setStreaming({
          speakerName,
          avatar,
          isNarrator,
          text: '',
          mode: opts?.mode === 'swipe' ? 'swipe' : opts?.generationType === 'continue' ? 'continue' : 'new',
          targetMessageId: inPlace ? opts?.targetMessageId : undefined,
        });
      } else {
        setStreaming(null);
        // Keep seed in the box; draft streams into the Accept bar (not the seed field)
      }
      /**
       * Narrator always steers from the composer when it has text — new beat,
       * swipe (+), continue, or turn-director pick. Explicit opts.hint wins
       * (e.g. narrate() already captured the seed). Empty composer = free
       * AI beat from chat history, story, and context.
       */
      const hintToSend =
        (opts?.hint ?? '').trim() || (isNarrator ? input.trim() : '');
      /**
       * Drop last turn's skill strip before this one starts.
       *
       * No `skills` event is sent when a turn uses none, so leaving the old list
       * up would credit this reply with documents it never saw.
       */
      setTurnSkills([]);
      /**
       * A leaked token locks the chat for good, so nothing may escape this.
       *
       * `streamGenerate` settles through its callbacks, which release the token;
       * a synchronous throw before that would leave it held with no stream to
       * stop and no way back short of a reload.
       */
      try {
      abortRef.current = streamGenerate(
        {
          chatId: chatId!,
          speakerId,
          ...(opts?.mode ? { mode: opts.mode } : {}),
          ...(opts?.generationType ? { generationType: opts.generationType } : {}),
          ...(opts?.targetMessageId ? { targetMessageId: opts.targetMessageId } : {}),
          ...((opts?.generationType === 'suggest_user' || opts?.generationType === 'impersonate' || opts?.generationType === 'narrate' || isNarrator || hintToSend)
            ? { hint: hintToSend || undefined }
            : {}),
          ...(opts?.generationType === 'suggest_user' || intoDraft
            ? {
              draftLength: opts.draftLength ?? (
                draftKind === 'narrate' ? narLength : draftKind === 'impersonate' ? impLength : writeLength
              ),
            }
            : {}),
          ...(intoDraft ? { draft: true } : {}),
        },
        {
          onItemization: (items, totalTokens) => setInspector(chatId!, items, totalTokens),
          // Which craft documents this reply was written with. Worth showing:
          // "why did she suddenly fight like that" should have a visible answer.
          onSkills: (list) => setTurnSkills(list),
          // Cleared when the next turn starts, so the strip can never describe
          // a reply other than the one on screen.
          onDelta: (t) => {
            if (!t) return;
            accumulated += t;
            if (intoComposer) {
              setWriteDraft((d) =>
                d
                  ? { ...d, draft: accumulated, status: 'streaming' }
                  : { original: opts?.hint ?? '', draft: accumulated, status: 'streaming' },
              );
            } else if (intoDraft) {
              patchDraft({ draft: accumulated, status: 'streaming' });
            } else {
              setStreaming((s) => (s ? { ...s, text: s.text + t } : s));
            }
          },
          onDone: ({ message, impersonated }) => {
            setStreaming(null);
            setBusy(false);
            abortRef.current = null;
            done();
            if (intoDraft) {
              const finalText = [impersonated, accumulated].find((t) => (t ?? '').trim())?.trim() ?? '';
              const seed = (opts?.hint ?? '').trim();
              if (finalText && finalText.toLowerCase() === seed.toLowerCase()) {
                // A verbatim echo is a failed generation, not a reply in their voice.
                patchDraft({
                  draft: '',
                  status: 'error',
                  error: draftKind === 'narrate'
                    ? 'The narrator only repeated your steer. Press Regen, or check the model.'
                    : 'Impersonate only repeated your script. Press Regen, or check the model.',
                });
              } else if (finalText) {
                patchDraft({ draft: finalText, status: 'ready' });
              } else {
                patchDraft({
                  draft: '',
                  status: 'error',
                  error: `${draftLabel} got no text from the model. Check Connections / model.`,
                });
              }
              setError('');
              resolve(null);
              return;
            }
            if (opts?.generationType === 'suggest_user') {
              const finalText = [impersonated, accumulated].find((s) => (s ?? '').trim() && (s ?? '').trim().toLowerCase() !== (opts?.hint ?? '').trim().toLowerCase())?.trim()
                || [impersonated, accumulated].find((s) => (s ?? '').trim())?.trim()
                || '';
              if (finalText && finalText.toLowerCase() !== (opts?.hint ?? '').trim().toLowerCase()) {
                setWriteDraft({
                  original: opts?.hint ?? '',
                  draft: finalText,
                  status: 'ready',
                });
                // Leave seed in input until Accept — then replace with full draft
              } else if (finalText) {
                // Model only echoed seed — still show as error, don't pretend success
                setWriteDraft({
                  original: opts?.hint ?? '',
                  draft: '',
                  status: 'error',
                  error: 'Write Me only repeated your seed. Try a clearer seed, or check the model.',
                });
                setError('');
              } else {
                setWriteDraft({
                  original: opts?.hint ?? '',
                  draft: '',
                  status: 'error',
                  error: 'Write Me got no text from the model. Check Connections / model and Max Tokens.',
                });
                setError('');
              }
              resolve(null);
              return;
            }
            if (message) {
              const text = (message.text ?? '').trim() || accumulated.trim();
              const fixed = text && text !== (message.text ?? '') ? { ...message, text, swipes: [text], swipeIndex: 0 } : { ...message, text };
              if (!fixed.text?.trim()) {
                setError('Model returned an empty reply. Try again or check Connections.');
                resolve(null);
                return;
              }
              // Impersonate must not be a verbatim seed paste
              if (
                opts?.generationType === 'impersonate' &&
                opts.hint &&
                fixed.text.trim().toLowerCase() === opts.hint.trim().toLowerCase()
              ) {
                setError('Impersonate only echoed your hint. Try again — the model should elaborate in-character.');
                resolve(null);
                return;
              }
              setMessages((m) => {
                if (opts?.mode === 'swipe' || opts?.generationType === 'continue') {
                  return m.map((x) => (x.id === fixed.id ? fixed : x));
                }
                return [...m, fixed];
              });
              refreshChats();
              resolve(fixed);
              return;
            }
            if (opts?.generationType === 'impersonate') {
              setError(accumulated.trim()
                ? 'Impersonate finished without saving the message. Try again.'
                : 'Impersonate got no text. Check Connections / model.');
            }
            refreshChats();
            resolve(null);
          },
          onError: (msg) => {
            setStreaming(null);
            setBusy(false);
            abortRef.current = null;
            done();
            const reason = (msg || '').trim() || 'Generation failed. Check Connections / model.';
            if (intoDraft) {
              // Same contract as Write Me: the reason belongs in the panel the
              // user is looking at, not in the chat's error banner.
              // Keep whatever streamed in before the failure — a half-written
              // beat is still worth reading before deciding to Regen.
              patchDraft({ ...(accumulated ? { draft: accumulated } : {}), status: 'error', error: reason });
              setError('');
              resolve(null);
              return;
            }
            if (intoComposer) {
              // Keep Write Me panel up with the real reason — do not dump bare codes into chat chrome
              setWriteDraft((d) => ({
                original: d?.original ?? opts?.hint ?? '',
                draft: accumulated || d?.draft || '',
                status: 'error',
                error: reason,
              }));
              setError(''); // chat area stays intact; reason lives in the draft panel
            } else {
              setError(reason);
            }
            resolve(null);
          },
          onAbort: () => {
            // Instant Stop: clear busy UI; drop ghost stream (do not save partial)
            setStreaming(null);
            setBusy(false);
            abortRef.current = null;
            done();
            if (intoDraft) {
              setImpDraft((d) => (d ? {
                ...d,
                draft: accumulated || d.draft,
                status: accumulated.trim() ? 'ready' : 'error',
                error: accumulated.trim() ? undefined : 'Stopped before any text arrived.',
              } : d));
              resolve(null);
              return;
            }
            if (intoComposer) {
              // Keep whatever draft streamed so far so Accept/Regen still work
              setWriteDraft((d) =>
                d
                  ? {
                      ...d,
                      draft: accumulated || d.draft,
                      status: accumulated.trim() ? 'ready' : 'error',
                      error: accumulated.trim() ? undefined : 'Stopped before any text arrived.',
                    }
                  : null,
              );
            }
            resolve(null);
          },
        },
      );
      } catch (err: any) {
        setStreaming(null);
        setBusy(false);
        abortRef.current = null;
        done();
        setError(err?.message ?? 'Could not start generation.');
        resolve(null);
      }
    });
  }

  /**
   * Stop everything this chat is doing: the streaming reply, a Turn Director
   * decision in flight, and any queued turns behind them. Stop means stopped —
   * the scene hands straight back to you.
   */
  function stopGeneration() {
    const stop = abortRef.current;
    abortRef.current = null;
    // Invalidate any running turn loop before awaiting anything else.
    turnRunRef.current += 1;
    decideAbortRef.current?.abort();
    decideAbortRef.current = null;
    autoTurnsRef.current = 0;
    // Stop ends auto-advance too — otherwise it would restart on its own timer.
    autoChainRef.current = AUTO_ADVANCE_CAP;
    /**
     * Hand the turn back unconditionally.
     *
     * Stop means stopped: the loop's own `finally` will also release, but it
     * cannot run until its current `await` settles, and until then every other
     * control would still refuse. Clearing it here is what makes Stop followed
     * immediately by Send work.
     */
    activeRef.current = null;
    // Clear UI immediately even if abort callback is slow
    setStreaming(null);
    setBusy(false);
    setDirectorDeciding(false);
    setAwaitingUser(true);
    stop?.();
  }

  /**
   * Auto-advance: let the scene play itself, on a leash.
   *
   * Fires only from a settled, idle, user-owned turn, so it can never stack on
   * top of a running one. Anything that touches the composer, Stop, or a chat
   * switch cancels the pending timer; the cap stops an unattended scene from
   * running indefinitely.
   */
  const autoChainRef = useRef(0);
  const autoDelayMs = Math.max(0, Math.min(120, group?.autoModeDelay ?? 0)) * 1000;
  const autoEligible =
    !!group && !!chatId && autoDelayMs > 0 && turnMode !== 'manual'
    && awaitingUser && !busy && !streaming && !directorDeciding && !genesis
    && !input.trim() && !writeDraft && !editing;

  useEffect(() => {
    if (!autoEligible) return;
    if (autoChainRef.current >= AUTO_ADVANCE_CAP) return;
    const t = window.setTimeout(() => {
      // Re-check synchronously: state may have moved during the wait.
      if (activeRef.current) return;
      autoChainRef.current += 1;
      if (autoChainRef.current >= AUTO_ADVANCE_CAP) {
        sceneNote(`Auto-advance paused after ${AUTO_ADVANCE_CAP} turns — say something to carry on.`);
      }
      void runTurnLoop(false);
    }, autoDelayMs);
    return () => window.clearTimeout(t);
  }, [autoEligible, autoDelayMs, messages.length]);

  /** Transient line under the composer — why the scene did (or did not) move. */
  function sceneNote(text: string, ms = 3500) {
    setSlashNote(text);
    window.setTimeout(() => setSlashNote((cur) => (cur === text ? '' : cur)), ms);
  }

  /**
   * Advance the scene.
   * - Series / Natural / Manual: **exactly one** AI reply (or wait on you), then stop.
   * - Director: may chain up to DIRECTOR_TURN_CAP replies until USER / cap.
   *
   * Every branch ends with the turn back in your hands: either a reply landed,
   * or something says why it did not. Silence is always a bug here.
   */
  /**
   * The one way to advance the scene.
   *
   * Owns the turn for the whole chain, not just for whichever reply happens to
   * be streaming: the gaps — a Turn Director call in flight, the moment between
   * one reply resolving and the next starting — used to look idle to every
   * other button in the UI, so a click in one of them started a competing
   * generation. Every exit hands the turn back, including the failing ones: a
   * throw here used to leave the composer disabled with no Stop button and no
   * way back except reloading.
   */
  async function runTurnLoop(fresh = true) {
    const token = claimTurn();
    if (!token) return;
    try {
      await runTurnLoopInner(fresh);
    } catch (err: any) {
      console.error('[chat] turn loop failed', err);
      setError(err?.message ?? 'The scene could not continue. Try again.');
    } finally {
      releaseTurn(token);
      setBusy(false);
      setDirectorDeciding(false);
      // Whatever happened, the turn is yours again.
      setAwaitingUser(true);
    }
  }

  async function runTurnLoopInner(fresh: boolean) {
    if (!group || !chatId) return;
    if (fresh) autoTurnsRef.current = 0;
    setAwaitingUser(false);
    setDirectorDeciding(false);

    // Stop bumps this; every await below re-checks it before doing more work.
    const run = turnRunRef.current;
    const stopped = () => turnRunRef.current !== run;

    const mode = group.turnMode === 'pooled' ? 'list' : group.turnMode;

    // ---- Series: one AI only, then always hand back to the user ----
    if (mode === 'list') {
      const speaker = seriesPick();
      if (stopped()) return;
      if (!speaker) {
        sceneNote(noSpeakerReason());
        setAwaitingUser(true);
        return;
      }
      const ok = await generateAs(speaker.id, speaker.name, speaker.avatar, false, { owned: true });
      if (stopped()) return;
      // Advance only on a real reply, and relative to who actually spoke — a
      // failed turn leaves the seat to whoever was up instead of quietly
      // costing them their place, and a roster edit mid-reply cannot desync it.
      if (ok) {
        const next = cursorAfter(speaker.id);
        if (next !== null) commitSeriesCursor(next);
      }
      setAwaitingUser(true); // STOP — do not continue the series
      return;
    }

    // ---- Natural: one pick, then stop ----
    if (mode === 'natural') {
      const decision = naturalTurn();
      if (stopped()) return;
      if (!decision || decision.next === 'USER') {
        if (!decision) sceneNote(noSpeakerReason());
        setAwaitingUser(true);
        return;
      }
      const card = members.find((m) => m.id === decision.speakerId || m.name === decision.next);
      if (card && !isYou(card.id)) {
        await generateAs(card.id, card.name, card.avatar, false, { owned: true });
      }
      if (!stopped()) setAwaitingUser(true);
      return;
    }

    // ---- Manual: human picks faces; never auto-chain ----
    if (mode === 'manual') {
      // Nothing replies on its own here — say so rather than looking hung.
      if (fresh && members.length) sceneNote('Manual mode — tap a face above to make them reply.', 2600);
      setAwaitingUser(true);
      return;
    }

    // ---- Director: may chain a few AI turns until USER ----
    while (autoTurnsRef.current < DIRECTOR_TURN_CAP) {
      if (stopped()) return;
      let decision;
      const decideAbort = new AbortController();
      decideAbortRef.current = decideAbort;
      try {
        setDirectorDeciding(true);
        decision = await api.turn(chatId, { signal: decideAbort.signal });
      } catch (err: any) {
        setDirectorDeciding(false);
        // Stop cut the decision short — that is not an error to report.
        if (stopped() || err?.code === 'abort' || err?.name === 'AbortError') return;
        setError(`Turn Director: ${err.message}`);
        setAwaitingUser(true);
        return;
      } finally {
        if (decideAbortRef.current === decideAbort) decideAbortRef.current = null;
        setDirectorDeciding(false);
      }
      if (stopped()) return;
      if (!decision) {
        setAwaitingUser(true);
        return;
      }
      if (decision.new_character_needed && group.genesisEnabled) {
        try {
          sceneNote('Genesis: Turn Director requested a new character…');
          const g = await api.genesis(chatId, decision.new_character_needed.hint);
          if (stopped()) return;
          setGenesis(g);
          if ((g as any).styleProfile) {
            setGroup((gr) => (gr ? { ...gr, styleProfile: (g as any).styleProfile } : gr));
          }
        } catch (err: any) {
          if (stopped()) return;
          setError(`Genesis: ${err.message}`);
        }
        setAwaitingUser(true);
        return;
      }
      if (decision.next === 'USER') {
        setAwaitingUser(true);
        return;
      }
      // The narrator only speaks when the scene has one.
      const wantsNarrator = decision.next === 'NARRATOR' && group.narratorEnabled;

      const decidedCard = members.find(
        (m) => m.id === (decision as any).speakerId || m.name === decision.next,
      );
      // A pick we cannot honour (unknown name, muted, deleted, or one of yours)
      // must not end the scene in silence — fall back to a live AI seat.
      const speaker = wantsNarrator
        ? null
        : (decidedCard && aiCanSpeak(decidedCard.id)) ?? seriesPick();
      if (decidedCard && isYou(decidedCard.id)) {
        setAwaitingUser(true);
        return;
      }
      if (!wantsNarrator && !speaker) {
        sceneNote(noSpeakerReason());
        setAwaitingUser(true);
        return;
      }
      autoTurnsRef.current += 1;
      const ok = wantsNarrator
        ? await generateAs('__narrator__', 'Narrator', undefined, true, { owned: true })
        : await generateAs(speaker!.id, speaker!.name, speaker!.avatar, false, { owned: true });
      if (stopped()) return;
      if (!ok) {
        setAwaitingUser(true);
        return;
      }
    }
    if (!stopped()) {
      if (autoTurnsRef.current >= DIRECTOR_TURN_CAP) {
        sceneNote(`${DIRECTOR_TURN_CAP} AI turns in a row — your move (Skip to keep going).`);
      }
      setAwaitingUser(true);
    }
  }

  /** Seats in speaking order — group.members is the truth; live cards are the fallback. */
  function seriesOrder(): string[] {
    if (!group) return members.map((m) => m.id);
    return group.members.length ? group.members : members.map((m) => m.id);
  }

  /** Seat rules for this chat, in the shape the turn-order engine wants. */
  function seatContext(cursor?: number): SeatContext {
    return {
      order: seriesOrder(),
      present: members.map((m) => m.id),
      muted: group?.disabledMembers ?? [],
      human: youIds,
      cursor: cursor ?? group?.listIndex ?? 0,
    };
  }

  /** A seat the AI may take: card still exists, not muted, not one of yours. */
  function aiCanSpeak(id: string): CharacterCard | null {
    if (!canSpeak(seatContext(), id)) return null;
    return members.find((m) => m.id === id) ?? null;
  }

  /** Who speaks next in series — see `shared/engine/turnOrder`. */
  function seriesPick(from?: number): CharacterCard | null {
    const id = nextSpeakerId(seatContext(from));
    return id ? members.find((m) => m.id === id) ?? null : null;
  }

  /** Persist the series cursor once, optimistically. */
  function commitSeriesCursor(nextIndex: number) {
    if (!group) return;
    if (group.listIndex === nextIndex) return;
    setGroup((g) => (g ? { ...g, listIndex: nextIndex } : g));
    void api.updateGroup(group.id, { listIndex: nextIndex }).catch(() => {
      /* cursor is advisory — a failed write just replays this seat next time */
    });
  }

  /** Cursor position that resumes the series *after* a given character. */
  function cursorAfter(characterId: string): number | null {
    return cursorAfterId(seriesOrder(), characterId);
  }

  /** Where the cursor belongs once the roster changes shape. */
  function nextCursorForRoster(nextOrder: string[]): number {
    return reanchorCursor(seriesOrder(), nextOrder, group?.listIndex ?? 0);
  }

  /** Why the scene cannot move — used instead of stalling in silence. */
  function noSpeakerReason(): string {
    if (!group) return 'No characters in this chat.';
    if (!members.length) return 'This group has no characters — add someone from the cast panel.';
    const muted = members.filter((m) => group.disabledMembers.includes(m.id)).length;
    const yours = members.filter((m) => isYou(m.id)).length;
    if (muted && muted + yours >= members.length) {
      return 'Everyone else is muted — unmute someone under Cast to let the scene continue.';
    }
    if (yours >= members.length) {
      return 'You are the only one in this scene — add another character to get a reply.';
    }
    return 'No one is available to speak right now.';
  }

  function naturalTurn(): { next: string; reason: string; speakerId?: string; new_character_needed?: null } | null {
    // AI-only pool (never the human's play-as)
    const enabled = seriesSpeakers.length
      ? seriesSpeakers
      : members.filter((m) => !group!.disabledMembers.includes(m.id) && !isYou(m.id));
    if (!enabled.length) return null;

    const lastText = messages.at(-1)?.text ?? '';
    // Names carry punctuation ("Dr. Vex", "C-3PO") — escape before matching.
    const mentioned = enabled.find((m) => {
      const first = m.name.split(' ')[0];
      if (!first) return false;
      return new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(lastText);
    });
    const pick = mentioned ?? enabled[Math.floor(Math.random() * enabled.length)];
    return { next: pick.name, reason: mentioned ? 'Mentioned by name' : 'Natural order pick', speakerId: pick.id };
  }

  async function sendUserText(rawText: string) {
    if (!chatId || !meta || busy) return;
    let text = rawText.trim();
    if (!text) return;

    // User is sending → always follow the new turn
    pinToBottomRef.current = true;
    requestAnimationFrame(() => pinScrollToBottom());

    // slash commands
    const parsed = parseSlash(text);
    if (parsed.kind === 'command') {
      setInput('');
      const feedback = await runSlash(parsed, {
        chatId,
        setInput,
        sendAsUser: (t) => sendUserText(t),
        continueReply,
        regenerate,
        impersonate: () => impersonateCharacter(),
        narrate: () => narrate(undefined, ''),
        setAuthorsNote: async (note, depth = 4) => {
          const authorsNote = note
            ? { text: note, depth, interval: 1, role: 'system' as const }
            : undefined;
          setMeta(await api.updateChat(chatId!, { authorsNote }));
        },
        setVariable: async (key, value, global) => {
          if (global) {
            await saveSettings({ globalVariables: { ...(settings?.globalVariables ?? {}), [key]: value } });
          } else {
            setMeta(await api.updateChat(chatId!, { variables: { ...(meta.variables ?? {}), [key]: value } }));
          }
        },
        getVariable: (key, global) =>
          global ? (settings?.globalVariables?.[key] ?? '') : (meta.variables?.[key] ?? ''),
        triggerSpeaker: async (nameOrId) => {
          const card = members.find(
            (m) => m.id === nameOrId || m.name.toLowerCase() === nameOrId.toLowerCase(),
          );
          // Same path as double-clicking a face: refuses muted/your own seat and
          // moves the series on so /trigger cannot desync the running order.
          if (card) await forceReplyFrom(card);
          else setError(`No character called "${nameOrId}" in this chat.`);
        },
        renameChat: async (title) => {
          setMeta(await api.updateChat(chatId!, { title }));
          refreshChats();
        },
        hideLast: async () => {
          const last = messages.at(-1);
          if (!last) return;
          await toggleHide(last.id);
        },
        sys: async (t) => {
          const msg = await api.postMessage(chatId!, {
            speaker: { type: 'system', displayName: 'System' },
            controlledBy: 'human',
            text: t,
            hiddenFromPrompt: false,
          });
          setMessages((m) => [...m, msg]);
        },
      });
      if (feedback) {
        setSlashNote(feedback);
        setTimeout(() => setSlashNote(''), 4000);
      }
      return;
    }

    // user-input regex
    text = applyRegexScripts(parsed.kind === 'none' ? parsed.text : text, settings?.regexScripts ?? [], 'user_input', {
      forDisplay: true,
    });

    setInput('');
    setError('');
    setProofread({ busy: false, undo: null });
    setAwaitingUser(false);
    // You spoke: the scene may play itself again from here.
    autoChainRef.current = 0;
    // reset pooled spoken after user speaks
    if (group?.turnMode === 'pooled') {
      void api.updateGroup(group.id, { pooledSpoken: [] });
    }
    const msg = await api.postMessage(chatId, {
      speaker: playAsCard
        ? { type: 'character', characterId: playAsCard.id, displayName: playAsCard.name }
        : { type: 'user', displayName: persona?.name ?? 'You' },
      controlledBy: 'human',
      text,
    });
    setMessages((m) => [...m, msg]);
    if (group) {
      // Genesis: if enabled, scan whether a brand-new character is needed from context
      if (group.genesisEnabled) {
        try {
          const scan = await api.genesisScan(chatId);
          if (scan.needed && scan.hint) {
            setSlashNote(`Genesis: scene needs someone new — drafting…`);
            setTimeout(() => setSlashNote(''), 4000);
            const draft = await api.genesis(chatId, scan.hint);
            setGenesis(draft);
            if (draft.styleProfile) {
              setGroup((g) => (g ? { ...g, styleProfile: draft.styleProfile as Group['styleProfile'] } : g));
            }
            setAwaitingUser(true);
            return; // wait for user to accept/discard before more turns
          }
        } catch (err: any) {
          // non-fatal — continue scene
          console.warn('Genesis scan:', err.message);
        }
      }
      if (group.turnMode === 'manual') {
        setAwaitingUser(true);
        return;
      }
      await runTurnLoop();
    } else if (soloChar) {
      await generateAs(soloChar.id, soloChar.name, soloChar.avatar);
      setAwaitingUser(true);
    } else {
      setAwaitingUser(true);
    }
  }

  async function send() {
    if (!canSend && !writeDraft) return;
    await sendUserText(input);
  }

  async function toggleHide(id: string) {
    const next = messages.map((m) =>
      m.id === id ? { ...m, hiddenFromPrompt: !m.hiddenFromPrompt } : m,
    );
    setMessages(next);
    await api.saveMessages(chatId!, next);
  }

  function beginRenameTitle() {
    setTitleDraft(meta?.title ?? '');
    setEditingTitle(true);
  }

  async function commitRenameTitle() {
    const title = titleDraft.trim();
    setEditingTitle(false);
    if (!title || !chatId || title === meta?.title) return;
    setMeta(await api.updateChat(chatId, { title }));
    refreshChats();
  }

  function cancelRenameTitle() {
    setEditingTitle(false);
    setTitleDraft(meta?.title ?? '');
  }

  function applyTimelineResult(res: {
    meta?: ChatMeta;
    messages?: ChatMessage[];
    timeline?: TimelineState;
    graph?: TimelineGraphNode[];
    warnings?: string[];
  }) {
    if (res.meta) setMeta(res.meta);
    if (res.messages) setMessages(res.messages);
    if (res.timeline) setTimeline(res.timeline);
    if (res.graph) setTimelineGraph(res.graph);
    if (res.warnings?.length) {
      setSlashNote(res.warnings.join(' · '));
      setTimeout(() => setSlashNote(''), 4000);
    }
  }

  async function saveBranch(name?: string) {
    if (!chatId) return;
    const n = name !== undefined ? name : prompt('Checkpoint name', `Checkpoint ${new Date().toLocaleString()}`);
    if (n === null) return;
    try {
      const res = await api.timelineCheckpoint(chatId, n || undefined);
      applyTimelineResult(res);
      setSlashNote('Checkpoint saved');
      setTimeout(() => setSlashNote(''), 2500);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function restoreBranch(branchId: string) {
    if (!chatId || busy) return;
    const ok = await confirm({
      title: 'Switch to this path?',
      body: 'Your current live path will be saved first as “Before restore”, so you can come back.',
      confirmLabel: 'Switch path',
    });
    if (!ok) return;
    try {
      const res = await api.timelineRestore(chatId, branchId);
      applyTimelineResult(res);
      setTimelineForkFilterMsgId(null);
      setSlashNote('Switched path');
      setTimeout(() => setSlashNote(''), 2500);
    } catch (err: any) {
      setError(err.message);
    }
  }

  /**
   * Branch from a message: snapshot the full current path, then truncate the live
   * chat to that message so you continue a new future. Tip-only → checkpoint.
   */
  async function branchFromMessage(messageId: string) {
    if (!chatId || busy) return;
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) {
      setError('Message not found on the live path.');
      return;
    }
    const isTip = idx === messages.length - 1;
    const msg = messages[idx];
    const defaultName = defaultBranchName(msg, isTip);

    if (isTip) {
      const n = prompt(
        'You are on the last message — this saves a checkpoint of the current path (nothing to truncate).',
        defaultName,
      );
      if (n === null) return;
      try {
        const res = await api.timelineCheckpoint(chatId, n.trim() || undefined);
        applyTimelineResult(res);
        setRail('timeline');
        setSlashNote(`Checkpoint saved as «${(n.trim() || defaultName)}»`);
        setTimeout(() => setSlashNote(''), 3500);
      } catch (err: any) {
        setError(err.message);
      }
      return;
    }

    const afterCount = messages.length - idx - 1;
    const branchOk = await confirm({
      title: 'Branch from this message?',
      body:
        `The next ${afterCount} message${afterCount === 1 ? '' : 's'} will be saved as a branch. ` +
        `You’ll continue from here on a new path.\n\n` +
        `Nothing is permanently deleted — switch back anytime in Timeline.`,
      confirmLabel: 'Create branch',
    });
    if (!branchOk) return;
    const n = prompt('Name this branch (optional)', defaultName);
    if (n === null) return;
    try {
      const res = await api.timelineFork(chatId, messageId, n.trim() || defaultName);
      applyTimelineResult(res);
      setSelectedTimelineMsgId(messageId);
      setTimelineForkFilterMsgId(null);
      setRail('timeline');
      const label = n.trim() || defaultName;
      setSlashNote(`Saved «${label}». Continuing from this message.`);
      setTimeout(() => setSlashNote(''), 4500);
    } catch (err: any) {
      setError(err.message);
    }
  }

  function openTimelineAtMessage(messageId: string) {
    setSelectedTimelineMsgId(messageId);
    setTimelineForkFilterMsgId(messageId);
    setRail('timeline');
    const el = document.querySelector(`[data-msg-id="${messageId}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function renameTimelineFork(forkId: string, name: string) {
    if (!chatId) return;
    try {
      const res = await api.timelineRenameFork(chatId, forkId, name);
      setTimeline(res.timeline);
      setTimelineGraph(res.graph);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function deleteTimelineFork(forkId: string) {
    if (!chatId) return;
    try {
      const res = await api.timelineDeleteFork(chatId, forkId);
      setTimeline(res.timeline);
      setTimelineGraph(res.graph);
    } catch (err: any) {
      setError(err.message);
    }
  }

  function scrollToMessage(id: string) {
    setSelectedTimelineMsgId(id);
    const el = document.querySelector(`[data-msg-id="${id}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  const forkCounts = useMemo(() => forkCountByMessage(timeline), [timeline]);
  const forkTotal = timeline?.forks?.length ?? 0;
  const forkWarning = useMemo(
    () => (timeline ? forkCountWarning(timeline) : null),
    [timeline],
  );
  /** Always reflect the live message list (server graph can lag between saves). */
  const liveTimelineGraph = useMemo(() => {
    const tl = buildTimelineFromMessages(messages, timeline);
    return graphViewModel(messages, tl);
  }, [messages, timeline]);

  async function deepSwipeMessage(messageId: string, confirmed = false) {
    if (!chatId || busy) return;
    try {
      const res = await api.timelineDeepSwipe(chatId, messageId, confirmed);
      applyTimelineResult(res);
      const msg = (res.messages ?? messages).find((m) => m.id === messageId);
      if (!msg) return;
      const card = msg.speaker.characterId ? allCards.find((c) => c.id === msg.speaker.characterId) : null;
      if (msg.speaker.type === 'narrator') {
        await generateAs('__narrator__', 'Narrator', undefined, true, { mode: 'swipe', targetMessageId: messageId });
      } else if (card) {
        await generateAs(card.id, card.name, card.avatar, false, { mode: 'swipe', targetMessageId: messageId });
      } else {
        setError('Cannot deep-swipe: speaker card not found.');
      }
    } catch (err: any) {
      if (err instanceof ApiError && err.code === 'NEEDS_CONFIRM') {
        const ok = await confirm({
          title: 'Continue deep swipe?',
          body: err.message,
          confirmLabel: 'Continue',
          danger: true,
        });
        if (ok) await deepSwipeMessage(messageId, true);
        return;
      }
      setError(err.message);
    }
  }

  async function deleteChat() {
    if (!chatId) return;
    const isGroupChat = !!meta?.groupId;
    const name = (meta?.title || 'this chat').trim();
    const ok = await confirm({
      title: isGroupChat ? `Delete group chat “${name}”?` : `Delete chat “${name}”?`,
      body: isGroupChat
        ? 'This permanently removes the whole group and every chat linked to it, plus those conversations’ memories.\n\nThe characters themselves are not deleted.'
        : 'This permanently deletes the conversation and its messages.\n\nThe character is not deleted.',
      confirmLabel: isGroupChat ? 'Delete group chat' : 'Delete chat',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
    await api.deleteChat(chatId);
    await refreshChats();
    if (isGroupChat) void refreshGroups();
    nav('/');
  }

  function togglePanel() {
    setRail((r) => (r ? null : 'cast'));
  }

  function lastAiIndex(): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].controlledBy === 'ai') return i;
    }
    return -1;
  }

  async function cycleSwipe(msgId: string, dir: 1 | -1, confirmed = false) {
    if (busy || !chatId) return;
    const m = messages.find((x) => x.id === msgId);
    if (!m) return;
    const swipes = m.swipes?.length ? m.swipes : [m.text];
    const cur = m.swipeIndex ?? 0;
    const idx = Math.min(Math.max(cur + dir, 0), swipes.length - 1);
    if (idx === cur) return;
    try {
      const res = await api.swipeMessage(chatId, msgId, idx, confirmed);
      applyTimelineResult(res);
    } catch (err: any) {
      if (err instanceof ApiError && err.code === 'NEEDS_CONFIRM') {
        const ok = await confirm({
          title: 'Continue swipe?',
          body: err.message,
          confirmLabel: 'Continue',
          danger: true,
        });
        if (ok) await cycleSwipe(msgId, dir, true);
        return;
      }
      setError(err.message);
    }
  }

  async function newSwipe(targetId?: string) {
    if (busy) return;
    const id = targetId ?? messages[lastAiIndex()]?.id;
    if (!id) return;
    await deepSwipeMessage(id, false);
  }

  async function continueReply() {
    if (busy || (!soloChar && !group)) return;
    const idx = lastAiIndex();
    if (idx === -1) return;
    const last = messages[idx];
    if (last.speaker.type === 'narrator') {
      await generateAs('__narrator__', 'Narrator', undefined, true, {
        generationType: 'continue',
        targetMessageId: last.id,
      });
    } else {
      const card = last.speaker.characterId ? allCards.find((c) => c.id === last.speaker.characterId) : soloChar;
      if (card) {
        await generateAs(card.id, card.name, card.avatar, false, {
          generationType: 'continue',
          targetMessageId: last.id,
        });
      }
    }
  }

  async function regenerate() {
    if (busy) return;
    await newSwipe();
  }

  /**
   * Write Me — draft YOUR (player) next line into the composer.
   * Empty input: pure context. With input: expand seed as your voice.
   * Accept / Decline / Regen; Send posts it.
   */
  async function writeMe(lengthOverride?: DraftLength) {
    if (busy) return;
    const card = soloChar ?? members.find((m) => !isYou(m.id)) ?? members[0];
    if (!card) {
      setError('No character loaded for this chat — open the chat again.');
      return;
    }
    /**
     * Regen re-reads the composer, it does not replay the seed that produced the
     * draft on screen. The box stays editable while a draft is up, so editing it
     * and pressing Regen is the obvious way to steer — replaying the old seed
     * made the button look broken.
     */
    const seed = input.trim();
    setNarDraft(null);
    setError('');
    setWriteDraft({
      original: input,
      draft: '',
      status: 'streaming',
      error: undefined,
    });
    try {
      await generateAs(card.id, card.name, card.avatar, false, {
        generationType: 'suggest_user',
        hint: seed,
        intoComposer: true,
        draftLength: lengthOverride ?? writeLength,
      });
    } catch (err: any) {
      // generateAs normally resolves; this is a last-resort guard so the UI never hard-breaks
      const reason = err?.message?.trim() || 'Write Me failed unexpectedly.';
      setWriteDraft((d) => ({
        original: d?.original ?? seed,
        draft: d?.draft ?? '',
        status: 'error',
        error: reason,
      }));
      setBusy(false);
      setStreaming(null);
    }
  }

  /**
   * Who the AI may be asked to impersonate: still in the cast, not muted, and
   * not the seat the human is playing. This is the list the picker shows and
   * the same list a one-candidate scene skips the picker for.
   */
  function impersonationCandidates(): CharacterCard[] {
    if (!group) return soloChar ? [soloChar] : [];
    // Same eligibility the turn loop uses, so the picker can never offer a seat
    // the generator would refuse.
    return seriesSpeakers;
  }

  /**
   * Impersonate — a CHARACTER's next message, drafted for review.
   *
   * With input: the seed is a script for that character and is followed exactly.
   * Empty input: free reply from chat, brain/memories, director, author's note.
   * Nothing reaches the transcript until Accept.
   */
  async function impersonateCharacter() {
    if (busy) return;
    const candidates = impersonationCandidates();
    if (!candidates.length) {
      setError(
        group
          ? 'Nobody left to impersonate — everyone else is muted or played by you. Unmute someone under Cast.'
          : 'No character loaded for this chat — open the chat again.',
      );
      return;
    }
    /**
     * One candidate is not a choice, so it is not worth a dialog: the picker
     * only earns its interruption when the answer is genuinely ambiguous.
     */
    if (candidates.length === 1) {
      await runImpersonate(candidates[0]);
      return;
    }
    setWriteDraft(null);
    setNarDraft(null);
    setError('');
    setImpPickOpen(true);
  }

  async function runImpersonate(card: CharacterCard, lengthOverride?: DraftLength) {
    if (busy) return;
    setImpPickOpen(false);
    setWriteDraft(null);
    setNarDraft(null);
    setError('');
    /**
     * The seed stays in the box while the draft is up, exactly as Write Me
     * leaves it: Regen re-reads the box, so editing the script and pressing
     * Regen is how you steer. Accept is what clears it.
     */
    const seed = input.trim();
    setImpDraft({
      card: { id: card.id, name: card.name, avatar: card.avatar },
      original: seed,
      draft: '',
      status: 'streaming',
    });
    try {
      await generateAs(card.id, card.name, card.avatar, false, {
        generationType: 'impersonate',
        hint: seed || undefined,
        intoDraft: true,
        draftLength: lengthOverride ?? impLength,
      });
    } catch (err: any) {
      const reason = err?.message?.trim() || 'Impersonate failed unexpectedly.';
      setImpDraft((d) => (d ? { ...d, status: 'error', error: reason } : null));
      setBusy(false);
      setStreaming(null);
    }
  }

  /**
   * Regen redrafts for the same character the panel is showing — never a
   * different one, even if the cast changed underneath. If that character is
   * gone (deleted, muted, or now played by the human), say so instead of
   * silently drafting in somebody else's name.
   */
  async function regenImpersonate() {
    const draft = impDraft;
    if (!draft) return;
    const card = allCards.find((c) => c.id === draft.card.id);
    const stillEligible = impCandidates.some((c) => c.id === draft.card.id);
    if (!card || !stillEligible) {
      setImpDraft((d) => (d ? {
        ...d,
        status: 'error',
        error: `${draft.card.name} is no longer available to impersonate — they may be muted, removed, or played by you now.`,
      } : d));
      return;
    }
    await runImpersonate(card);
  }

  function declineImpersonate() {
    setImpDraft(null);
    setError('');
  }

  /**
   * Accept posts the draft as that character's message — the first moment it
   * touches the transcript. The composer is only cleared if it still holds the
   * script that produced this draft: anything the user typed since is theirs.
   */
  async function acceptImpersonate() {
    const draft = impDraft;
    if (!draft?.draft.trim() || !chatId) {
      setError('No draft to accept yet — wait for Impersonate to finish, or press Regen.');
      return;
    }
    setBusy(true);
    try {
      const msg = await api.commitImpersonation(chatId, draft.card.id, draft.draft.trim());
      setMessages((m) => [...m, msg]);
      if (draft.original && input.trim() === draft.original) setInput('');
      setImpDraft(null);
      setError('');
      pinToBottomRef.current = true;
      requestAnimationFrame(() => pinScrollToBottom());
      refreshChats();
    } catch (err: any) {
      setImpDraft((d) => (d ? { ...d, status: 'error', error: err?.message ?? 'Could not post the message.' } : null));
    } finally {
      setBusy(false);
    }
  }

  function setImpLengthPersist(next: DraftLength) {
    setImpLength(next);
    try { window.localStorage.setItem(IMP_LENGTH_KEY, String(next)); } catch { /* ignore quota / private mode */ }
  }

  function setWriteLengthPersist(next: DraftLength) {
    setWriteLength(next);
    try { window.localStorage.setItem(WRITE_ME_LENGTH_KEY, String(next)); } catch { /* ignore quota / private mode */ }
  }

  function declineWriteMe() {
    if (writeDraft) setInput(writeDraft.original);
    setWriteDraft(null);
    setError('');
  }

  function acceptWriteMe() {
    if (!writeDraft?.draft?.trim()) {
      setError('No draft to accept yet — wait for Write Me to finish, or press Regen.');
      return;
    }
    // Put the elaborated AI draft into the input for you to send
    setInput(writeDraft.draft);
    setWriteDraft(null);
    setError('');
  }

  function setNarLengthPersist(next: DraftLength) {
    setNarLength(next);
    try { window.localStorage.setItem(NAR_LENGTH_KEY, String(next)); } catch { /* ignore quota / private mode */ }
  }

  /**
   * Narrator — the next scene beat, drafted for review.
   *
   * Composer text steers the beat (priority 1); Director + Author's Note are
   * applied on the server. Unlike the two character drafts this one has no
   * speaker to write *as* — the voice is the same third-person narrator it has
   * always been. Everything else is the Impersonate contract: the seed stays in
   * the box so Regen re-reads it, and nothing reaches the transcript until
   * Accept, so a declined beat leaves no trace.
   */
  async function narrate(lengthOverride?: DraftLength, seedOverride?: string) {
    if (busy) return;
    setImpDraft(null);
    setWriteDraft(null);
    setError('');
    /**
     * `/narrate` clears the box a render too late for this closure to see, so the
     * command text itself would arrive as the steer. The slash path passes its
     * own empty seed instead of trusting a `setInput` that has not landed yet.
     */
    const seed = (seedOverride ?? input).trim();
    setNarDraft({ original: seed, draft: '', status: 'streaming' });
    try {
      await generateAs('__narrator__', 'Narrator', undefined, true, {
        generationType: 'narrate',
        hint: seed || undefined,
        intoDraft: true,
        draftLength: lengthOverride ?? narLength,
      });
    } catch (err: any) {
      const reason = err?.message?.trim() || 'Narrator failed unexpectedly.';
      setNarDraft((d) => (d ? { ...d, status: 'error', error: reason } : null));
      setBusy(false);
      setStreaming(null);
    }
  }

  function declineNarrate() {
    setNarDraft(null);
    setError('');
  }

  /**
   * Accept posts the beat as a narration message — the first moment it touches
   * the transcript. The composer is only cleared if it still holds the steer
   * that produced this beat: anything typed since is the user's.
   */
  async function acceptNarrate() {
    const draft = narDraft;
    if (!draft?.draft.trim() || !chatId) {
      setError('No beat to accept yet — wait for the Narrator to finish, or press Regen.');
      return;
    }
    setBusy(true);
    try {
      const msg = await api.commitNarration(chatId, draft.draft.trim());
      setMessages((m) => [...m, msg]);
      if (draft.original && input.trim() === draft.original) setInput('');
      setNarDraft(null);
      setError('');
      pinToBottomRef.current = true;
      requestAnimationFrame(() => pinScrollToBottom());
      refreshChats();
    } catch (err: any) {
      setNarDraft((d) => (d ? { ...d, status: 'error', error: err?.message ?? 'Could not post the narration.' } : null));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Editing and deleting rewrite the *whole* transcript file.
   *
   * Doing that while a reply is streaming persists a snapshot taken before that
   * reply existed: the server then appends the finished message to a list the
   * client has already overwritten, and depending on which write lands last the
   * reply is either lost or duplicated. Both operations therefore wait for the
   * turn — the message being edited may be the very one Continue is extending.
   */
  function transcriptEditBlocked(): boolean {
    if (!activeRef.current && !busy) return false;
    setError('Wait for the reply to finish (or press Stop) before editing the transcript.');
    return true;
  }

  async function saveEdit(id: string) {
    if (transcriptEditBlocked()) return;
    const next = messages.map((m) => {
      if (m.id !== id) return m;
      const swipes = m.swipes?.length ? m.swipes.map((s, i) => (i === (m.swipeIndex ?? 0) ? editText : s)) : m.swipes;
      return { ...m, text: editText, swipes };
    });
    setMessages(next);
    setEditing(null);
    await api.saveMessages(chatId!, next);
  }

  async function deleteMessage(id: string) {
    if (transcriptEditBlocked()) return;
    const next = messages.filter((m) => m.id !== id);
    setMessages(next);
    await api.saveMessages(chatId!, next);
  }

  /**
   * Take (or release) a seat in the cast. The roster is never reordered here —
   * the cast is the user's, and switching who you play is not a reason to move
   * anyone's place in the series.
   */
  async function applyPlayAs(id: string | null) {
    if (!group || group.playAs === id) return;
    const prev = group;

    // The cursor indexes the full cast, and `seriesPick` walks over seats that
    // cannot speak — so taking a seat never needs the cursor moved.
    setGroup({ ...group, playAs: id });
    try {
      setGroup(await api.updateGroup(group.id, { playAs: id }));
      seatSyncFailedRef.current = null;
      void refreshGroups();
    } catch (err: any) {
      // Remember the failure: the reconcile effect reverts to this same target,
      // so without a marker a dead server would retry it forever.
      seatSyncFailedRef.current = id ?? NO_SEAT;
      setGroup(prev);
      setError(err.message ?? 'Could not switch character');
    }
  }

  /**
   * The "As" row is the identity switch: you are always one of the cast, so
   * taking a seat also makes that character your persona — the header, the
   * composer and the cast then name the same person instead of three different
   * ones. There is no seatless "you" to fall back to.
   */
  async function setPlayAs(id: string) {
    if (!group) return;
    const card = members.find((m) => m.id === id);
    if (!card) return;
    await applyPlayAs(id);
    try {
      await becomeCharacter(card);
    } catch (err: any) {
      setError(err.message ?? 'Could not switch persona');
    }
  }

  async function patchGroup(patch: Partial<Group>) {
    if (!group) return;
    setGroup(await api.updateGroup(group.id, patch));
  }

  /** Add a platform character to the group cast (ST + member). */
  async function addGroupMember(card: CharacterCard) {
    if (group) {
      if (group.members.includes(card.id)) return;
      const nextMembers = [...group.members, card.id];
      const g = await api.updateGroup(group.id, { members: nextMembers });
      setGroup(g);
      setMembers((m) => (m.some((x) => x.id === card.id) ? m : [...m, card]));
      void refreshGroups();
      if (!storeCharacters.some((c) => c.id === card.id)) void refreshCharacters();
      return;
    }
    // Solo chat → promote to group in place (messages preserved)
    if (soloChar && chatId) {
      await promoteSoloToGroup(card);
    }
  }

  /** Turn a 1:1 chat into a group with the current character + the new member. */
  async function promoteSoloToGroup(card: CharacterCard) {
    if (!chatId || !soloChar || !meta) return;
    if (card.id === soloChar.id) return;
    setError('');
    try {
      const res = await api.addChatMember(chatId, card.id);
      setMeta(res.meta);
      setGroup(res.group);
      const all = await api.listCharacters();
      useApp.setState({ characters: all });
      setMembers(
        res.group.members.map((id) => all.find((c) => c.id === id)).filter(Boolean) as CharacterCard[],
      );
      setSoloChar(null);
      setCastExpanded(true);
      void refreshGroups();
      void refreshChats();
      setSlashNote(`${card.name} joined — this is now a group chat`);
      setTimeout(() => setSlashNote(''), 3500);
    } catch (err: any) {
      setError(err.message ?? 'Could not add character');
    }
  }

  async function removeGroupMember(card: CharacterCard) {
    if (!group || group.members.length <= 1) return;
    const nextMembers = group.members.filter((id) => id !== card.id);
    const g = await api.updateGroup(group.id, {
      members: nextMembers,
      disabledMembers: group.disabledMembers.filter((id) => id !== card.id),
      playAs: group.playAs === card.id ? null : group.playAs,
      listIndex: nextCursorForRoster(nextMembers),
    });
    setGroup(g);
    setMembers((m) => m.filter((x) => x.id !== card.id));
    void refreshGroups();
  }

  /** Drag-reorder series (group.members order = speaking order). */
  async function reorderMembers(fromId: string, toId: string) {
    if (!group || fromId === toId) return;
    const next = [...group.members];
    const from = next.indexOf(fromId);
    const to = next.indexOf(toId);
    if (from < 0 || to < 0) return;
    next.splice(from, 1);
    next.splice(to, 0, fromId);
    // Dragging changes seat numbers, not whose turn it is.
    const listIndex = nextCursorForRoster(next);
    const byId = new Map(members.map((m) => [m.id, m]));
    setMembers(next.map((id) => byId.get(id)).filter(Boolean) as CharacterCard[]);
    setGroup({ ...group, members: next, listIndex });
    try {
      setGroup(await api.updateGroup(group.id, { members: next, listIndex }));
      void refreshGroups();
    } catch (err: any) {
      setError(err.message ?? 'Could not reorder cast');
      void load();
    }
  }

  /**
   * Synchronous guard so the two clicks of a double-click can never start two
   * generations. `busy` is React state and lands a tick too late for this.
   */
  const speakRequestRef = useRef(0);

  function claimSpeakSlot(): boolean {
    const now = Date.now();
    if (now - speakRequestRef.current < 700) return false;
    speakRequestRef.current = now;
    return true;
  }

  function onCastAvatarActivate(card: CharacterCard) {
    if (!group || busy) return;
    if (turnMode !== 'manual') return;
    // Manual tap = AI speaks as that face — not allowed for the character you control
    if (isYou(card.id)) {
      setError(`You're playing as ${card.name}. Type below and Send — or switch "As" to free them for AI.`);
      return;
    }
    // Mute is absolute: manual tap is the one path that could still reach a
    // muted face, so it has to refuse here too.
    if (group.disabledMembers.includes(card.id)) {
      setError(`${card.name} is muted in this scene. Unmute them under Cast to let the AI speak for them.`);
      return;
    }
    if (!claimSpeakSlot()) return;
    void generateAs(card.id, card.name, card.avatar);
  }

  /**
   * Double-click a portrait → that character replies **now**, whatever the turn
   * order says. Director mode, series order, pooled — all bypassed. This is the
   * escape hatch for "I want to hear from them, out of turn".
   *
   * Works in solo chats too (double-click the character's portrait to pull
   * another reply without typing).
   */
  async function forceReplyFrom(card: CharacterCard) {
    if (busy) return;
    if (isYou(card.id)) {
      setError(`You're playing as ${card.name} — AI won't write their lines. Switch "As" first.`);
      return;
    }
    if (group?.disabledMembers?.includes(card.id)) {
      setError(`${card.name} is muted in this scene. Re-enable them to let the AI speak for them.`);
      return;
    }
    if (!claimSpeakSlot()) return;
    sceneNote(
      turnMode === 'list'
        ? `${card.name} speaks now — the series continues after them`
        : `${card.name} speaks — forced out of turn`,
      2600,
    );
    const ok = await generateAs(card.id, card.name, card.avatar);
    // Jumping the queue moves the queue: series resumes from the seat after the
    // face you pulled, rather than rewinding to whoever was nominally next.
    if (ok && turnMode === 'list') {
      const next = cursorAfter(card.id);
      if (next !== null) commitSeriesCursor(next);
    }
  }

  async function analyzeStyle() {
    if (!group) return;
    setStyleBusy(true);
    setError('');
    try {
      const profile = await api.analyzeStyle(group.id);
      setGroup({ ...group, styleProfile: profile });
    } catch (err: any) {
      setError(`Style analysis: ${err.message}`);
    } finally {
      setStyleBusy(false);
    }
  }

  async function saveStyleProfile(patch: Partial<NonNullable<Group['styleProfile']>>) {
    if (!group?.styleProfile) return;
    const styleProfile = { ...group.styleProfile, ...patch };
    setGroup(await api.updateGroup(group.id, { styleProfile }));
  }

  async function acceptGenesis(card: CharacterCard) {
    if (!group || !chatId) return;
    const g = await api.updateGroup(group.id, { members: [...group.members, card.id] });
    setGroup(g);
    setMembers((m) => [...m, card]);
    setGenesis(null);
    if (card.first_mes) {
      const msg = await api.postMessage(chatId, {
        speaker: { type: 'character', characterId: card.id, displayName: card.name },
        controlledBy: 'ai',
        text: card.first_mes,
        extra: { genesis: true },
      });
      setMessages((m) => [...m, msg]);
    }
  }

  async function saveDirector(director: DirectorState) {
    if (!meta) return;
    setMeta(await api.updateChat(meta.id, { director }));
    const text = director.nudge?.text?.trim() || director.sceneGoal?.text?.trim();
    if (text) {
      await api.brain.steer(meta.id, {
        text,
        prefer: director.prefer,
        intensity: director.nudge?.intensity,
      }).catch(() => undefined);
    }
  }

  if (!meta) return <PageLoader label={error || 'Opening the conversation…'} />;

  const lastIdx = lastAiIndex();
  const inPlaceStream = streaming?.targetMessageId;

  return (
    <div className={`chat-page${rail ? ' is-rail-open' : ''}`}>
      <div className="chat-column">
        <div className="chat-header">
            <div className={`header-cast${castIsExpanded ? ' is-expanded' : ''}${turnMode === 'manual' ? ' is-manual' : ''}${turnMode === 'list' ? ' is-series' : ''}${!group ? ' is-solo' : ''}`}>
              {/* Left face: group = next AI preview / director deciding; solo = character portrait */}
              <div
                className="header-cast-focus"
                aria-label={
                  directorDeciding
                    ? 'AI Director is deciding who speaks'
                    : group
                      ? 'Next speaker'
                      : 'Character'
                }
              >
                <AnimatePresence mode="wait" initial={false}>
                  {directorDeciding ? (
                    <motion.div
                      key="director-deciding"
                      className="header-cast-avatar is-focus is-deciding"
                      initial={{ scale: 0.72, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      exit={{ scale: 0.72, opacity: 0 }}
                      transition={{ duration: 0.18, ease: RAIL_EASE }}
                      title="AI Director is choosing who speaks next… — click to stop"
                      role="button"
                      tabIndex={0}
                      onClick={stopGeneration}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          stopGeneration();
                        }
                      }}
                    >
                      <span className="director-deciding-orb" aria-hidden>
                        <GlobeLoader size={16} title="Choosing speaker" />
                      </span>
                      <span className="header-cast-turn-badge is-deciding" title="Choosing speaker">
                        …
                      </span>
                    </motion.div>
                  ) : (
                    (group ? headerCast.focus : soloChar) && (
                      <motion.div
                        key={(group ? headerCast.focus!.id : soloChar!.id)}
                        className={`header-cast-avatar is-focus is-forceable${group ? ' is-preview' : ''}`}
                        initial={{ scale: 0.72, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.72, opacity: 0 }}
                        transition={{ duration: 0.18, ease: RAIL_EASE }}
                        title={`${(group ? headerCast.focus! : soloChar!).name}${group ? ' · next' : ''}\nDouble-click to make them reply now, out of turn`}
                        role="button"
                        tabIndex={0}
                        onDoubleClick={() => forceReplyFrom(group ? headerCast.focus! : soloChar!)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            forceReplyFrom(group ? headerCast.focus! : soloChar!);
                          }
                        }}
                      >
                        <Avatar
                          src={(group ? headerCast.focus : soloChar)!.avatar}
                          name={(group ? headerCast.focus : soloChar)!.name}
                          characterId={(group ? headerCast.focus : soloChar)!.id}
                          size={30}
                          shape="square"
                          interactive={false}
                        />
                        {group && (
                          <span className="header-cast-turn-badge" title="Next to speak">next</span>
                        )}
                      </motion.div>
                    )
                  )}
                </AnimatePresence>
              </div>

              <div className="header-title-block">
                {editingTitle ? (
                  <div className="header-title-edit">
                    <input
                      ref={titleInputRef}
                      className="header-title-input"
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void commitRenameTitle();
                        }
                        if (e.key === 'Escape') cancelRenameTitle();
                      }}
                      aria-label="Chat title"
                    />
                    <button
                      type="button"
                      className="header-title-save"
                      title="Save name"
                      onClick={() => void commitRenameTitle()}
                    >
                      <Check size={14} strokeWidth={2.5} />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="header-title-btn t-heading"
                    title="Click to rename"
                    onClick={beginRenameTitle}
                  >
                    {meta.title}
                  </button>
                )}
              </div>

              {/* Group: full cast stack. Solo: no duplicate avatar — only + to invite (promotes to group). */}
              <div
                className={`header-cast-stack${castIsExpanded ? ' is-expanded' : ''}${!group ? ' is-solo-add' : ''}`}
                title={
                  !group
                    ? 'Add a character — turns this into a group chat (history kept)'
                    : turnMode === 'manual'
                      ? 'Tap a face — that character speaks'
                      : turnMode === 'list'
                        ? 'All cast · drag to set series order'
                        : 'Group cast'
                }
              >
                {group && (castIsExpanded ? headerCast.all : headerCast.all.slice(0, 8)).map((c, i) => {
                  const seriesPos = orderedMembers.findIndex((m) => m.id === c.id);
                  const isPlayAs = isYou(c.id);
                  const isMuted = group.disabledMembers.includes(c.id);
                  const isNext = !isPlayAs && !isMuted && headerCast.focus?.id === c.id;
                  return (
                    <div
                      key={c.id}
                      className={[
                        'header-cast-avatar',
                        castIsExpanded ? 'is-expanded-face' : 'is-stack',
                        turnMode === 'manual' && !isPlayAs && !isMuted ? 'is-tappable' : '',
                        !isPlayAs && !isMuted ? 'is-forceable' : '',
                        isMuted ? 'is-muted' : '',
                        turnMode === 'list' ? 'is-draggable' : '',
                        isNext ? 'is-next' : '',
                        dragMemberId === c.id ? 'is-dragging' : '',
                      ].filter(Boolean).join(' ')}
                      style={
                        castIsExpanded
                          ? { zIndex: 2, marginLeft: 0 }
                          : { zIndex: headerCast.all.length - i, marginLeft: i === 0 ? 0 : -10 }
                      }
                      title={
                        isMuted
                          ? `${c.name} · muted — skipped in every turn mode.\nUnmute under Cast in the right rail.`
                          : isPlayAs
                          ? `${c.name} · playing as (AI skipped)`
                          : `${
                              turnMode === 'manual'
                                ? `${c.name} speaks`
                                : turnMode === 'list'
                                  ? `${c.name} · #${seriesPos + 1} — drag to reorder`
                                  : isNext
                                    ? `${c.name} · next`
                                    : c.name
                            }\nDouble-click to make them reply now, out of turn`
                      }
                      role={!isPlayAs ? 'button' : undefined}
                      tabIndex={!isPlayAs || turnMode === 'list' ? 0 : undefined}
                      draggable={turnMode === 'list'}
                      onDragStart={(e) => {
                        if (turnMode !== 'list') return;
                        const de = e as unknown as ReactDragEvent;
                        setDragMemberId(c.id);
                        de.dataTransfer.setData('text/plain', c.id);
                        de.dataTransfer.effectAllowed = 'move';
                      }}
                      onDragEnd={() => setDragMemberId(null)}
                      onDragOver={(e) => {
                        if (turnMode === 'list') (e as unknown as ReactDragEvent).preventDefault();
                      }}
                      onDrop={(e) => {
                        const de = e as unknown as ReactDragEvent;
                        de.preventDefault();
                        const from = de.dataTransfer.getData('text/plain');
                        if (from) void reorderMembers(from, c.id);
                        setDragMemberId(null);
                      }}
                      onClick={() => {
                        if (!busy) onCastAvatarActivate(c);
                      }}
                      onDoubleClick={() => forceReplyFrom(c)}
                      onKeyDown={(e) => {
                        if ((e.key === 'Enter' || e.key === ' ') && !busy) {
                          e.preventDefault();
                          // Manual mode already speaks on activate; elsewhere the
                          // keyboard equivalent of a double-click is a forced turn.
                          if (turnMode === 'manual') onCastAvatarActivate(c);
                          else forceReplyFrom(c);
                        }
                      }}
                    >
                      <Avatar
                        src={c.avatar}
                        name={c.name}
                        characterId={c.id}
                        size={castIsExpanded ? 28 : 26}
                        shape="square"
                        interactive={false}
                      />
                      {turnMode === 'list' && seriesPos >= 0 && (
                        <span className="header-cast-order" aria-hidden>{seriesPos + 1}</span>
                      )}
                    </div>
                  );
                })}

                <div
                  className="header-cast-add"
                  style={{ marginLeft: group && headerCast.all.length ? 6 : 0 }}
                >
                  <GroupMemberStrip
                    members={group ? orderedMembers : soloChar ? [soloChar] : []}
                    pool={storeCharacters}
                    onAdd={(c) => void addGroupMember(c)}
                    size={26}
                    dense
                    addOnly
                    canRemove={false}
                    addLabel={group ? 'Add member to group' : 'Add character (becomes group chat)'}
                  />
                </div>

                {group && turnMode !== 'manual' && turnMode !== 'list' && headerCast.all.length > 1 && (
                  <button
                    type="button"
                    className={`header-cast-expand${castExpanded ? ' is-open' : ''}`}
                    title={castExpanded ? 'Collapse cast' : 'Expand cast'}
                    aria-label={castExpanded ? 'Collapse cast' : 'Expand cast'}
                    onClick={() => setCastExpanded((v) => !v)}
                  >
                    <ChevronDown size={14} />
                  </button>
                )}
              </div>
            </div>

          {group && (
            <div className="turn-mode-select" ref={turnModeRef}>
              <button
                type="button"
                className={`turn-mode-trigger${turnModeOpen ? ' is-open' : ''}${directorDeciding ? ' is-deciding' : ''}`}
                onClick={() => setTurnModeOpen((o) => !o)}
                title={
                  directorDeciding
                    ? 'AI Director is choosing who speaks next…'
                    : 'How the cast takes turns'
                }
                aria-haspopup="listbox"
                aria-expanded={turnModeOpen}
              >
                <span className="turn-mode-dot" data-mode={turnMode ?? group.turnMode} />
                <span className="turn-mode-label">
                  {directorDeciding
                    ? 'Deciding…'
                    : ({
                        director: 'AI Director',
                        natural: 'Natural',
                        list: 'Series',
                        pooled: 'Series',
                        manual: 'Manual',
                      } as Record<Group['turnMode'], string>)[turnMode ?? group.turnMode]}
                </span>
                <ChevronDown size={14} className={`turn-mode-chevron${turnModeOpen ? ' is-open' : ''}`} />
              </button>
              <AnimatePresence>
                {turnModeOpen && (
                  <motion.ul
                    className="turn-mode-menu"
                    role="listbox"
                    initial={{ opacity: 0, y: -6, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, scale: 0.98 }}
                    transition={{ duration: 0.16, ease: RAIL_EASE }}
                  >
                    {([
                      { id: 'director' as const, label: 'AI Director', hint: 'Model picks who speaks next' },
                      { id: 'natural' as const, label: 'Natural', hint: 'Name mentions & free pick' },
                      { id: 'list' as const, label: 'Series', hint: 'One AI reply per turn · Skip for next · drag to order' },
                      { id: 'manual' as const, label: 'Manual', hint: 'Tap a face in the header to speak' },
                    ]).map((opt) => {
                      const selected = (turnMode ?? group.turnMode) === opt.id
                        || (opt.id === 'list' && group.turnMode === 'pooled');
                      return (
                        <li key={opt.id}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={selected}
                            className={`turn-mode-option${selected ? ' is-selected' : ''}`}
                            onClick={() => {
                              void patchGroup({ turnMode: opt.id });
                              setTurnModeOpen(false);
                              if (opt.id !== 'director') setAwaitingUser(true);
                              if (opt.id === 'manual' || opt.id === 'list') setCastExpanded(true);
                            }}
                          >
                            <span className="turn-mode-dot" data-mode={opt.id} />
                            <span className="turn-mode-option-text">
                              <span className="turn-mode-option-label">{opt.label}</span>
                              <span className="turn-mode-option-hint">{opt.hint}</span>
                            </span>
                            {selected && <Check size={14} className="turn-mode-check" />}
                          </button>
                        </li>
                      );
                    })}
                  </motion.ul>
                )}
              </AnimatePresence>
            </div>
          )}
          {/* Which model is answering — and the pinned alternatives, one click away */}
          <PinnedModelSwitch disabled={busy} />

          <div className="direction-pop-wrap chat-header-direction">
            <button
              ref={dirBtnRef}
              type="button"
              className={`btn btn-sm btn-secondary btn-icon-only${dirOpen ? ' btn-primary' : ''}`}
              disabled={busy}
              onClick={() => setDirOpen((o) => !o)}
              title="Direction — steer the next beat"
              aria-label="Direction"
            >
              <IconDirection size={16} />
            </button>
            <DirectionPopover
              open={dirOpen}
              onClose={() => setDirOpen(false)}
              anchorRef={dirBtnRef}
              initial={meta.director?.nudge}
              initialPrefer={meta.director?.prefer}
              onApply={async (nudge) => {
                await saveDirector({
                  ...(meta.director ?? {}),
                  nudge: { text: nudge.text, intensity: nudge.intensity, setAtMessage: messages.length },
                  prefer: nudge.prefer,
                });
                setSlashNote(`Direction set (intensity ${nudge.intensity})`);
                setTimeout(() => setSlashNote(''), 2500);
              }}
            />
          </div>
          {/* A group has several minds: open the cast's memory, not a guess at
              which one you meant. Solo chats go straight to the only mind there is. */}
          {(group || mindTarget) && (
            <button
              type="button"
              className={`btn btn-sm btn-secondary btn-icon-only${memoryStatus.working ? ' is-remembering' : ''}`}
              onClick={() => nav(
                group
                  ? `/mind/${encodeURIComponent(meta.id)}`
                  : `/mind/${encodeURIComponent(meta.id)}/${encodeURIComponent(mindTarget!.id)}`,
              )}
              title={memoryStatus.label ?? (group
                ? 'Memory of this scene — what every character remembers, feels, and has become'
                : `${mindTarget!.name}'s mind in this chat — what they remember, feel, and have become`)}
              aria-label={group ? 'Open the cast’s memory' : `Open ${mindTarget!.name}'s mind`}
            >
              {memoryStatus.working ? <GlobeLoader size={16} title="Remembering" /> : <Brain size={16} />}
            </button>
          )}
          <button
            type="button"
            className={`btn btn-sm btn-secondary btn-icon-only timeline-header-btn${rail === 'timeline' ? ' is-open' : ''}`}
            onClick={() => {
              setTimelineForkFilterMsgId(null);
              setRail((r) => (r === 'timeline' ? null : 'timeline'));
            }}
            title={
              forkTotal
                ? `Timeline & branches (${forkTotal} saved)`
                : 'Timeline & branches — branch from any message to save alternate futures'
            }
            aria-label="Timeline"
          >
            <GitBranch size={16} />
            {forkTotal > 0 && (
              <span className="timeline-fork-badge" aria-hidden>
                {forkTotal > 99 ? '99+' : forkTotal}
              </span>
            )}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-file btn-icon-only"
            onClick={() => void saveBranch()}
            title="Save checkpoint of the current path (does not leave this path)"
            aria-label="Save checkpoint"
          >
            <Save size={16} />
          </button>
          <a
            className="btn btn-sm btn-file btn-icon-only"
            href={`/api/chats/${chatId}/export.jsonl`}
            title="Export chat JSONL"
            aria-label="Export chat"
          >
            <Download size={16} />
          </a>
          <button
            type="button"
            className="btn btn-sm btn-ghost btn-danger btn-icon-only"
            onClick={() => void deleteChat()}
            title="Delete chat"
            aria-label="Delete chat"
          >
            <Trash2 size={16} />
          </button>
          <button
            type="button"
            className={`btn btn-sm btn-secondary btn-icon-only panel-toggle-btn${rail ? ' is-open' : ''}`}
            onClick={togglePanel}
            title={rail ? 'Close side panel' : 'Open panel (Members · Samplers · Inspector · Director · Author)'}
            aria-label="Toggle side panel"
            aria-pressed={!!rail}
          >
            <PanelRight size={18} />
          </button>
        </div>

        <div ref={scrollRef} className="chat-messages" onScroll={onMessagesScroll}>
          <div style={{ maxWidth: 760, margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', gap: 18 }}>
            {messages.map((m, i) => {
              const isSwipeTarget = inPlaceStream === m.id;
              const canSwipe = m.controlledBy === 'ai' && m.speaker.type !== 'system';
              const baseCount = Math.max(m.swipes?.length ?? 1, 1);
              const swiping = isSwipeTarget && streaming?.mode === 'swipe';
              const continuing = isSwipeTarget && streaming?.mode === 'continue';
              const isTip = i === messages.length - 1;
              const branchCount = forkCounts[m.id] ?? 0;

              return (
                <MessageRow
                  key={m.id}
                  msg={m}
                  avatar={
                    m.speaker.type === 'character' || m.speaker.characterId
                      ? avatarFor(m.speaker.characterId, m.speaker.displayName).src
                      : m.speaker.type === 'user'
                        ? (persona?.avatar)
                        : undefined
                  }
                  characterId={m.speaker.characterId}
                  editing={editing === m.id}
                  editText={editText}
                  setEditText={setEditText}
                  onEdit={() => { setEditing(m.id); setEditText(m.text); }}
                  onSaveEdit={() => saveEdit(m.id)}
                  onDelete={() => deleteMessage(m.id)}
                  onHide={() => void toggleHide(m.id)}
                  onCancelEdit={() => setEditing(null)}
                  onBranch={() => void branchFromMessage(m.id)}
                  branchDisabled={busy}
                  isTip={isTip}
                  branchCount={branchCount}
                  onOpenBranches={() => openTimelineAtMessage(m.id)}
                  displayText={
                    swiping
                      ? (streaming?.text ?? '')
                      : continuing
                        ? `${m.text}${streaming?.text ? streaming.text : ''}`
                        : m.text
                  }
                  streamingInPlace={!!isSwipeTarget}
                  generating={!!isSwipeTarget}
                  selected={selectedTimelineMsgId === m.id}
                  onSelect={() => setSelectedTimelineMsgId(m.id)}
                  swipeControls={
                    canSwipe
                      ? {
                          index: swiping ? baseCount : (m.swipeIndex ?? 0),
                          count: swiping ? baseCount + 1 : baseCount,
                          generating: swiping,
                          disabled: busy && !isSwipeTarget,
                          onPrev: () => void cycleSwipe(m.id, -1),
                          onNext: () => void cycleSwipe(m.id, 1),
                          onNew: () => void newSwipe(m.id),
                        }
                      : undefined
                  }
                />
              );
            })}

            {/* Only brand-new generations render below — never swipes/continues */}
            {streaming && !streaming.targetMessageId && (
              <div
                className={streaming.isNarrator ? 'narrator-block msg-enter' : 'msg-row msg-enter'}
                style={streaming.isNarrator ? undefined : { display: 'flex', gap: 12 }}
              >
                {!streaming.isNarrator && (
                  <Avatar
                    src={streaming.avatar}
                    name={streaming.speakerName}
                    characterId={allCards.find((c) => c.name === streaming.speakerName)?.id}
                    size={40}
                    shape="portrait"
                  />
                )}
                <div style={{ flex: 1 }}>
                  {!streaming.isNarrator && (
                    <div className="t-label" style={{ marginBottom: 4 }}>{streaming.speakerName}</div>
                  )}
                  {streaming.text ? (
                    <div className="caret">
                      <FormattedMessage text={streaming.text} />
                    </div>
                  ) : (
                    <div className="gen-pulse t-caption"><GlobeLoader size={14} /> Generating…</div>
                  )}
                </div>
              </div>
            )}

            <SoftReveal show={!!turnSkills.length} gap={4}>
              <div className="chat-skill-strip">
                <span className="t-caption t-faint">Using</span>
                {turnSkills.map((sk) => (
                  <button
                    key={sk.id}
                    type="button"
                    className="chip skill-row-badge"
                    title={
                      sk.level === 'full'
                        ? 'The full document was loaded.'
                        : sk.level === 'sections'
                          ? 'Context was tight — part of the document was loaded.'
                          : 'Context was tight — only a summary was loaded.'
                    }
                    onClick={() => setDrawer('skills')}
                  >
                    {sk.name}
                    {sk.level !== 'full' && <span className="t-faint"> · {sk.level}</span>}
                  </button>
                ))}
              </div>
            </SoftReveal>

            <SoftReveal show={!!error} gap={4}>
              <div className="chat-error-banner" role="alert">
                <span className="chat-error-banner-text">{error}</span>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setError('')}>
                  Dismiss
                </button>
              </div>
            </SoftReveal>
          </div>
        </div>

        <div className="chat-composer">
          <div className="chat-composer-inner">
            <div
              ref={composerActionsRef}
              className={`chat-composer-actions${compactTools ? ' is-compact' : ''}`}
            >
              <div className="composer-tools-primary">
                <button
                  type="button"
                  className={`btn btn-secondary btn-sm composer-tool-btn${compactTools ? ' is-icon-only' : ''}`}
                  disabled={busy || !isUserTurn}
                  onClick={() => void writeMe()}
                  title="Write Me — draft YOUR next line (seed optional; empty uses full scene context)"
                  aria-label="Write Me"
                >
                  <PenLine size={15} />
                  {!compactTools && <span className="composer-tool-label">Write Me</span>}
                </button>
                {/* Impersonate + its cast picker. The menu only opens when more
                    than one character is eligible; otherwise the click drafts. */}
                <div className="composer-imp" ref={impPickRef}>
                  <button
                    type="button"
                    className={`btn btn-secondary btn-sm composer-tool-btn${compactTools ? ' is-icon-only' : ''}`}
                    disabled={busy}
                    onClick={() => void impersonateCharacter()}
                    title="Impersonate — a character's reply, drafted for review (type a script first to control exactly what they do)"
                    aria-label="Impersonate"
                    aria-haspopup={impCandidates.length > 1 ? 'menu' : undefined}
                    aria-expanded={impCandidates.length > 1 ? impPickOpen : undefined}
                  >
                    <UserRound size={15} />
                    {!compactTools && <span className="composer-tool-label">Impersonate</span>}
                  </button>
                  <AnimatePresence>
                    {impPickOpen && (
                      <motion.div
                        className="composer-more-menu imp-pick-menu"
                        role="menu"
                        aria-label="Impersonate which character"
                        initial={{ opacity: 0, y: 8, scale: 0.96 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 6, scale: 0.98 }}
                        transition={{ duration: 0.16, ease: RAIL_EASE }}
                      >
                        <div className="imp-pick-head t-caption">
                          Who replies?
                          {input.trim() ? ' They follow your script exactly.' : ''}
                        </div>
                        {impCandidates.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            role="menuitem"
                            className="composer-more-item imp-pick-item"
                            disabled={busy}
                            onClick={() => void runImpersonate(c)}
                          >
                            <Avatar src={c.avatar} name={c.name} size={24} shape="square" interactive={false} />
                            <span>{c.name}</span>
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Wide: Narrator / Skip inline. Tight: chevron-up overflow */}
                {!compactTools && (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm composer-tool-btn"
                      disabled={busy}
                      onClick={() => void narrate()}
                      title="Narrator beat — scene description, time, world events. Drafted for review before it posts."
                      aria-label="Narrator"
                    >
                      <BookOpen size={15} />
                      <span className="composer-tool-label">Narrator</span>
                    </button>
                    {group && turnMode !== 'manual' && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm composer-tool-btn"
                        disabled={busy || directorDeciding}
                        onClick={() => void runTurnLoop()}
                        title="Skip — continue the scene without you"
                      >
                        <SkipForward size={15} />
                        <span className="composer-tool-label">Skip</span>
                      </button>
                    )}
                    {group && turnMode === 'manual' && (
                      <span className="t-caption composer-manual-hint">Tap a face above to speak</span>
                    )}
                    {quickReplies.map((qr) => (
                      <button
                        key={qr.id}
                        type="button"
                        className="chip"
                        disabled={busy || !isUserTurn}
                        title={qr.message}
                        onClick={() => {
                          if (qr.autoSend) void sendUserText(qr.message);
                          else setInput(qr.message);
                        }}
                      >
                        {qr.label}
                      </button>
                    ))}
                  </>
                )}

                {compactTools && (
                  <div className="composer-tools-more" ref={toolsMoreRef}>
                    <button
                      type="button"
                      className={`btn btn-ghost btn-sm composer-tool-btn is-icon-only composer-more-trigger${toolsMoreOpen ? ' is-open' : ''}`}
                      aria-label="More tools"
                      aria-expanded={toolsMoreOpen}
                      aria-haspopup="menu"
                      title="More tools"
                      onClick={() => setToolsMoreOpen((o) => !o)}
                    >
                      <ChevronUp size={16} className={toolsMoreOpen ? 'composer-more-chevron is-open' : 'composer-more-chevron'} />
                    </button>
                    <AnimatePresence>
                      {toolsMoreOpen && (
                        <motion.div
                          className="composer-more-menu"
                          role="menu"
                          initial={{ opacity: 0, y: 8, scale: 0.96 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: 6, scale: 0.98 }}
                          transition={{ duration: 0.16, ease: RAIL_EASE }}
                        >
                          <button
                            type="button"
                            role="menuitem"
                            className="composer-more-item"
                            disabled={busy}
                            onClick={() => {
                              setToolsMoreOpen(false);
                              void narrate();
                            }}
                          >
                            <BookOpen size={15} />
                            <span>Narrator</span>
                            <span className="composer-more-hint">Scene / world beat</span>
                          </button>
                          {group && turnMode !== 'manual' && (
                            <button
                              type="button"
                              role="menuitem"
                              className="composer-more-item"
                              disabled={busy || directorDeciding}
                              onClick={() => {
                                setToolsMoreOpen(false);
                                void runTurnLoop();
                              }}
                            >
                              <SkipForward size={15} />
                              <span>Skip</span>
                              <span className="composer-more-hint">Continue without you</span>
                            </button>
                          )}
                          {group && turnMode === 'manual' && (
                            <div className="composer-more-note t-caption">
                              Tap a face above to make them speak
                            </div>
                          )}
                          {quickReplies.length > 0 && (
                            <>
                              <div className="composer-more-sep" />
                              {quickReplies.map((qr) => (
                                <button
                                  key={qr.id}
                                  type="button"
                                  role="menuitem"
                                  className="composer-more-item"
                                  disabled={busy || !isUserTurn}
                                  title={qr.message}
                                  onClick={() => {
                                    setToolsMoreOpen(false);
                                    if (qr.autoSend) void sendUserText(qr.message);
                                    else setInput(qr.message);
                                  }}
                                >
                                  <span>{qr.label}</span>
                                </button>
                              ))}
                            </>
                          )}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )}
              </div>

              <span className="composer-tools-spacer" />

              {/* Playing as — right-aligned avatar chips; click any face to switch who you write as.
                  Cast faces only: you are always somebody in the scene, never a faceless "you",
                  and one chip per identity is what stops the same character appearing twice. */}
              {group && (
                <div className="play-as-row" role="group" aria-label="Playing as">
                  <span className="play-as-label t-caption">As</span>
                  {orderedMembers.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className={`play-as-chip${playAsCard?.id === m.id ? ' is-active' : ''}`}
                      onClick={() => void setPlayAs(m.id)}
                      title={`Play as ${m.name}`}
                      aria-label={`Play as ${m.name}`}
                      aria-pressed={playAsCard?.id === m.id}
                    >
                      <Avatar src={m.avatar} name={m.name} size={28} shape="square" interactive={false} />
                    </button>
                  ))}
                </div>
              )}
            </div>

            <SoftReveal show={!!writeDraft} gap={8}>
              {writeDraft && (
                <div className={`draft-panel${writeDraft.status === 'error' ? ' is-error' : ''}`}>
                  <div className="draft-bar">
                    <UserRound size={14} />
                    <span className="t-caption" style={{ flex: 1 }}>
                      {writeDraft.status === 'streaming'
                        ? (writeDraft.original?.trim()
                          ? 'Writing out exactly what you asked for…'
                          : 'Writing your next line from the scene…')
                        : writeDraft.status === 'error'
                          ? 'Write Me failed — fix the issue, then Regen or Decline.'
                          : 'Draft ready — Accept puts it in the box so you can Send.'}
                    </span>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={declineWriteMe}>
                      Decline
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busy}
                      title="Re-draft from whatever is in the box right now"
                      onClick={() => void writeMe()}
                    >
                      Regen
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={busy || !writeDraft.draft.trim() || writeDraft.status === 'error'}
                      onClick={acceptWriteMe}
                    >
                      Accept
                    </button>
                  </div>
                  <AnimatePresence initial={false}>
                    {(writeDraft.draft || writeDraft.status === 'streaming' || writeDraft.status === 'error') && (
                      <motion.div
                        key="draft-body"
                        className="draft-body-shell"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.28, ease: RAIL_EASE }}
                      >
                        {/* Shell clips height animation; inner body scrolls so full draft is readable */}
                        <div className="draft-body">
                          <div className="draft-body-pad">
                            <p className="t-caption" style={{ marginBottom: 6 }}>
                              {writeDraft.original?.trim() ? (
                                <>Your script (followed exactly): <em>{writeDraft.original}</em></>
                              ) : (
                                <>No script — drafted from the scene</>
                              )}
                            </p>
                            {writeDraft.status === 'error' && (
                              <div className="draft-error" role="alert">
                                {writeDraft.error || 'Write Me failed. Check Connections / model, then Regen.'}
                              </div>
                            )}
                            {(writeDraft.draft || writeDraft.status === 'streaming') && (
                              <div className="draft-text">
                                {writeDraft.draft || (busy ? '…' : '')}
                              </div>
                            )}
                            <DraftLengthRail
                              id="write-me-length"
                              value={writeLength}
                              disabled={busy}
                              onChange={setWriteLengthPersist}
                            />
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}
            </SoftReveal>

            {/* Narrator review panel — the scene beat before it exists */}
            <SoftReveal show={!!narDraft} gap={8}>
              {narDraft && (
                <div className={`draft-panel${narDraft.status === 'error' ? ' is-error' : ''}`}>
                  <div className="draft-bar">
                    <BookOpen size={14} />
                    <span className="t-caption" style={{ flex: 1 }}>
                      {narDraft.status === 'streaming'
                        ? (narDraft.original.trim()
                          ? 'Narrating the beat you asked for…'
                          : 'Narrating the next beat from the scene…')
                        : narDraft.status === 'error'
                          ? 'Narrator failed — fix the issue, then Regen or Decline.'
                          : 'Beat ready — Accept posts it as narration.'}
                    </span>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={declineNarrate}>
                      Decline
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busy}
                      title="Re-narrate from whatever is in the box right now"
                      onClick={() => void narrate()}
                    >
                      Regen
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={busy || !narDraft.draft.trim() || narDraft.status === 'error'}
                      onClick={() => void acceptNarrate()}
                    >
                      Accept
                    </button>
                  </div>
                  <AnimatePresence initial={false}>
                    {(narDraft.draft || narDraft.status === 'streaming' || narDraft.status === 'error') && (
                      <motion.div
                        key="nar-draft-body"
                        className="draft-body-shell"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.28, ease: RAIL_EASE }}
                      >
                        <div className="draft-body">
                          <div className="draft-body-pad">
                            <p className="t-caption" style={{ marginBottom: 6 }}>
                              {narDraft.original.trim() ? (
                                <>The narrator delivers your steer: <em>{narDraft.original}</em></>
                              ) : (
                                <>No steer — the narrator picks the beat from the scene</>
                              )}
                            </p>
                            {narDraft.status === 'error' && (
                              <div className="draft-error" role="alert">
                                {narDraft.error || 'Narrator failed. Check Connections / model, then Regen.'}
                              </div>
                            )}
                            {(narDraft.draft || narDraft.status === 'streaming') && (
                              <div className="draft-text">
                                {narDraft.draft || (busy ? '…' : '')}
                              </div>
                            )}
                            <DraftLengthRail
                              id="narrate-length"
                              value={narLength}
                              disabled={busy}
                              onChange={setNarLengthPersist}
                            />
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}
            </SoftReveal>

            {/* Impersonate review panel — the character's message before it exists */}
            <SoftReveal show={!!impDraft} gap={8}>
              {impDraft && (
                <div className={`draft-panel${impDraft.status === 'error' ? ' is-error' : ''}`}>
                  <div className="draft-bar">
                    <Avatar src={impDraft.card.avatar} name={impDraft.card.name} size={20} shape="square" interactive={false} />
                    <span className="t-caption" style={{ flex: 1 }}>
                      {impDraft.status === 'streaming'
                        ? (impDraft.original.trim()
                          ? `Writing ${impDraft.card.name}'s reply from your script…`
                          : `Writing ${impDraft.card.name}'s next reply…`)
                        : impDraft.status === 'error'
                          ? 'Impersonate failed — fix the issue, then Regen or Decline.'
                          : `Draft ready — Accept posts it as ${impDraft.card.name}.`}
                    </span>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={declineImpersonate}>
                      Decline
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      disabled={busy}
                      title="Re-draft from whatever is in the box right now"
                      onClick={() => void regenImpersonate()}
                    >
                      Regen
                    </button>
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={busy || !impDraft.draft.trim() || impDraft.status === 'error'}
                      onClick={() => void acceptImpersonate()}
                    >
                      Accept
                    </button>
                  </div>
                  <AnimatePresence initial={false}>
                    {(impDraft.draft || impDraft.status === 'streaming' || impDraft.status === 'error') && (
                      <motion.div
                        key="imp-draft-body"
                        className="draft-body-shell"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.28, ease: RAIL_EASE }}
                      >
                        <div className="draft-body">
                          <div className="draft-body-pad">
                            <p className="t-caption" style={{ marginBottom: 6 }}>
                              {impDraft.original.trim() ? (
                                <>
                                  {impDraft.card.name} follows your script exactly: <em>{impDraft.original}</em>
                                </>
                              ) : (
                                <>No script — {impDraft.card.name} decides from the scene</>
                              )}
                            </p>
                            {impDraft.status === 'error' && (
                              <div className="draft-error" role="alert">
                                {impDraft.error || 'Impersonate failed. Check Connections / model, then Regen.'}
                              </div>
                            )}
                            {(impDraft.draft || impDraft.status === 'streaming') && (
                              <div className="draft-text">
                                {impDraft.draft || (busy ? '…' : '')}
                              </div>
                            )}
                            <DraftLengthRail
                              id="impersonate-length"
                              value={impLength}
                              disabled={busy}
                              onChange={setImpLengthPersist}
                            />
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              )}
            </SoftReveal>

            <SoftReveal show={!!slashNote} gap={8}>
              <p className="t-caption" style={{ color: 'var(--accent)', whiteSpace: 'pre-wrap' }}>{slashNote}</p>
            </SoftReveal>
            {/*
              Same width as chat content above (760):
              [ yellow zone = format frame ][ white zone = full remaining = input + mic + send ]
            */}
            <div className="composer-input-row">
              <div className="composer-format-frame" role="toolbar" aria-label="Text format">
                <button
                  type="button"
                  className="icon-btn composer-format-btn"
                  title='Dialogue — wrap selection in " "'
                  onClick={() => insertStyle('dialogue')}
                >
                  <MessageSquareQuote size={15} />
                </button>
                <button
                  type="button"
                  className="icon-btn composer-format-btn"
                  title="Action — wrap selection in * *"
                  onClick={() => insertStyle('action')}
                >
                  <Asterisk size={15} />
                </button>
                <button
                  type="button"
                  className={`icon-btn composer-format-btn${capsMode !== 'normal' ? ' is-active' : ''}`}
                  title={`Capitalization: ${CAPS_LABEL[capsMode]} (click to cycle)`}
                  aria-label={`Capitalization mode: ${CAPS_LABEL[capsMode]}`}
                  onClick={cycleCapsMode}
                >
                  {capsMode === 'words' ? (
                    <span className="composer-caps-label">Aa</span>
                  ) : capsMode === 'sentences' ? (
                    <span className="composer-caps-label">A.</span>
                  ) : (
                    <CaseSensitive size={15} />
                  )}
                </button>
                <button
                  type="button"
                  className={`icon-btn composer-format-btn${proofread.undo !== null ? ' is-active' : ''}`}
                  title={
                    proofread.busy
                      ? 'Fixing spelling and grammar…'
                      : proofread.undo !== null
                        ? 'Undo the fix — put back exactly what you typed'
                        : 'Fix spelling & grammar — corrects what you wrote without writing it for you'
                  }
                  aria-label={
                    proofread.undo !== null ? 'Undo spelling and grammar fix' : 'Fix spelling and grammar'
                  }
                  onClick={() => void proofreadDraft()}
                  disabled={proofread.busy || (!input.trim() && proofread.undo === null)}
                >
                  {proofread.busy ? (
                    <GlobeLoader size={15} title="Fixing spelling" />
                  ) : proofread.undo !== null ? (
                    <Undo2 size={15} />
                  ) : (
                    <SpellCheck size={15} />
                  )}
                </button>
              </div>

              <div className="input-box">
                <div className="composer-field">
                  {!input && !busy && (
                    <span className="composer-placeholder">
                      Write as {userDisplayName}… "dialogue" *action*
                      {capsMode !== 'normal' ? ` · ${CAPS_LABEL[capsMode]}` : ''}
                    </span>
                  )}
                  <textarea
                    ref={composerRef}
                    className="composer-textarea"
                    rows={1}
                    value={input}
                    aria-label={`Write as ${userDisplayName}`}
                    onChange={(e) => onComposerChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        if (writeDraft) {
                          acceptWriteMe();
                          return;
                        }
                        if (canSend) void send();
                      }
                    }}
                    disabled={!isUserTurn && !busy}
                  />
                </div>
                <div className="composer-send-cluster">
                  <MicDictateButton
                    disabled={!!busy || (!isUserTurn && !busy)}
                    onLiveText={showLiveDictation}
                    onText={insertDictation}
                    onStatus={(msg) => {
                      // Only surface useful mic feedback (errors / loading). Success is the text in the box.
                      if (/fail|error|denied|not available|too short|No speech|Downloading|Loading|Preparing|Whisper ready|Listening|Transcrib/i.test(msg)) {
                        setSlashNote(msg);
                        window.setTimeout(() => {
                          setSlashNote((cur) => (cur === msg ? '' : cur));
                        }, /fail|error|denied|not available|too short|No speech/i.test(msg) ? 4000 : 2500);
                      }
                    }}
                  />
                  {/* Anything running is stoppable — including the Director thinking
                      between replies, which used to leave no way out but waiting. */}
                  {busy || directorDeciding ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={stopGeneration}
                      title={directorDeciding && !busy
                        ? 'Stop — cancel the Turn Director and take the turn back'
                        : 'Stop generating (ends the rest of the AI turns too)'}
                    >
                      Stop
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={[
                        'btn btn-primary btn-sm',
                        group ? 'send-with-avatar' : '',
                        showUserTurnHint ? 'send-user-turn' : '',
                      ].filter(Boolean).join(' ')}
                      onClick={() => {
                        if (writeDraft) {
                          acceptWriteMe();
                          return;
                        }
                        void send();
                      }}
                      disabled={!canSend}
                      title={
                        showUserTurnHint
                          ? `Your turn — write as ${sendAvatarName}, then Send`
                          : isUserTurn
                            ? (group ? `Send as ${sendAvatarName}` : 'Send')
                            : directorDeciding
                              ? 'AI Director is choosing who speaks…'
                              : 'Wait for your turn'
                      }
                      aria-description={
                        showUserTurnHint ? 'Your turn — type a message to send' : undefined
                      }
                    >
                      {group && (
                        <span className="send-avatar-slot" aria-hidden>
                          <AnimatePresence mode="wait" initial={false}>
                            <motion.span
                              key={playAsCard?.id ?? persona?.id ?? 'you'}
                              className="send-avatar-inner"
                              initial={{ scale: 0.5, opacity: 0, rotate: -12 }}
                              animate={{ scale: 1, opacity: 1, rotate: 0 }}
                              exit={{ scale: 0.5, opacity: 0, rotate: 12 }}
                              transition={{ type: 'spring', stiffness: 480, damping: 28 }}
                            >
                              {sendAvatarSrc ? (
                                <img src={sendAvatarSrc} alt="" />
                              ) : (
                                <span className="send-avatar-fallback">
                                  {(sendAvatarName || 'Y').slice(0, 1).toUpperCase()}
                                </span>
                              )}
                            </motion.span>
                          </AnimatePresence>
                        </span>
                      )}
                      Send
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Smooth slide-in right rail — never pops open instantly */}
      <AnimatePresence initial={false}>
        {rail && (
          <motion.aside
            key="chat-rail"
            className="chat-right-rail"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: RAIL_WIDTH, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.32, ease: RAIL_EASE }}
            style={{ overflow: 'hidden' }}
          >
            <div className="chat-right-rail-inner">
              <div className="rail-tabs">
                {(['cast', 'tune', 'inspector', 'director', 'note', 'timeline'] as RailTab[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="rail-tab"
                    data-active={rail === t || undefined}
                    onClick={() => setRail(t)}
                  >
                    {RAIL_LABEL[t]}
                  </button>
                ))}
              </div>
              <div className="chat-right-body">
                {rail === 'cast' && (
                  <CastPanel
                    group={group}
                    members={members}
                    youId={youId}
                    soloChar={soloChar}
                    characterPool={storeCharacters}
                    onToggleMute={(id) =>
                      patchGroup({
                        disabledMembers: group!.disabledMembers.includes(id)
                          ? group!.disabledMembers.filter((x) => x !== id)
                          : [...group!.disabledMembers, id],
                      })
                    }
                    onPatchGroup={patchGroup}
                    onAddMember={(c) => addGroupMember(c)}
                    onRemoveMember={(c) => removeGroupMember(c)}
                    onAnalyzeStyle={analyzeStyle}
                    styleBusy={styleBusy}
                    onSaveStyle={saveStyleProfile}
                    onOpenCharacter={(id) => nav(`/creator/${id}`)}
                  />
                )}
                {rail === 'tune' && <SamplerControls />}
                {rail === 'inspector' && (
                  <InspectorPanel data={inspector} maxContext={activePreset?.max_context ?? 32000} />
                )}
                {rail === 'director' && meta && (
                  <DirectorConsole
                    compact
                    meta={meta}
                    onSave={saveDirector}
                    onNarrate={() => void narrate()}
                    onGenesis={
                      group
                        ? async (hint) => {
                            if (!group.genesisEnabled) {
                              setError('Turn on Genesis under Members first.');
                              return;
                            }
                            try {
                              setSlashNote('Genesis drafting…');
                              const g = await api.genesis(chatId!, hint);
                              setGenesis(g);
                              setSlashNote('');
                            } catch (err: any) {
                              setError(err.message);
                              setSlashNote('');
                            }
                          }
                        : undefined
                    }
                  />
                )}
                {rail === 'note' && meta && (
                  <AuthorsNotePanel
                    meta={meta}
                    onChange={(authorsNote) => {
                      setMeta({ ...meta, authorsNote });
                    }}
                    onCommit={async (authorsNote) => {
                      setMeta(await api.updateChat(meta.id, { authorsNote: authorsNote?.text?.trim() ? authorsNote : undefined }));
                    }}
                  />
                )}
                {rail === 'timeline' && (
                  <TimelinePanel
                    messages={messages}
                    timeline={timeline}
                    graph={liveTimelineGraph.length ? liveTimelineGraph : timelineGraph}
                    warning={timelineWarning || forkWarning}
                    busy={busy}
                    selectedMessageId={selectedTimelineMsgId}
                    filterForkMessageId={timelineForkFilterMsgId}
                    onClearForkFilter={() => setTimelineForkFilterMsgId(null)}
                    onSelectMessage={scrollToMessage}
                    onCheckpoint={(name) => void saveBranch(name ?? '')}
                    onBranchFromMessage={(id) => void branchFromMessage(id)}
                    onRestore={(id) => void restoreBranch(id)}
                    onRename={(id, name) => void renameTimelineFork(id, name)}
                    onDelete={(id) => void deleteTimelineFork(id)}
                    onDeepSwipe={(id) => void deepSwipeMessage(id)}
                  />
                )}
              </div>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {genesis && <GenesisReveal draft={genesis} onAccept={acceptGenesis} onDiscard={() => setGenesis(null)} />}
    </div>
  );
}

// ---------------- panels ----------------

/**
 * The draft length rail — one control, two tools.
 *
 * Deliberately built from the Author's Note slider's own classes rather than a
 * lookalike: three sliders that merely resemble each other drift apart the
 * first time one of them is restyled.
 */
function DraftLengthRail({ id, value, disabled, onChange }: {
  id: string;
  value: DraftLength;
  disabled: boolean;
  onChange: (next: DraftLength) => void;
}) {
  return (
    <div className="an-richness draft-length">
      <div className="an-richness-head">
        <label className="field-label" htmlFor={id} style={{ marginBottom: 0 }}>
          Length &amp; detail
        </label>
        <span className="an-richness-value">
          {DRAFT_LENGTH[value].label}
          <em>~{DRAFT_LENGTH[value].targetWords} words</em>
        </span>
      </div>
      <input
        id={id}
        type="range"
        min={1}
        max={5}
        step={1}
        value={value}
        disabled={disabled}
        aria-valuemin={1}
        aria-valuemax={5}
        aria-valuenow={value}
        aria-valuetext={`${DRAFT_LENGTH[value].label}, about ${DRAFT_LENGTH[value].targetWords} words`}
        onChange={(e) => onChange(clampDraftLength(Number(e.target.value)))}
      />
      <div className="an-richness-ticks" aria-hidden>
        {([1, 2, 3, 4, 5] as const).map((n) => (
          <button
            key={n}
            type="button"
            className={`an-richness-tick${value === n ? ' is-active' : ''}`}
            disabled={disabled}
            onClick={() => onChange(n)}
          >
            {DRAFT_LENGTH[n].label}
          </button>
        ))}
      </div>
      <p className="t-caption an-richness-hint">
        {DRAFT_LENGTH[value].hint} · press Regen to redraft at this length
      </p>
    </div>
  );
}

const WRITE_ME_LENGTH_KEY = 'nw.writeMe.length';
const IMP_LENGTH_KEY = 'nw.impersonate.length';
const NAR_LENGTH_KEY = 'nw.narrate.length';

function readStoredLength(key: string): DraftLength {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null || raw.trim() === '') return DEFAULT_DRAFT_LENGTH;
    return clampDraftLength(Number(raw));
  } catch {
    return DEFAULT_DRAFT_LENGTH;
  }
}

function readStoredWriteLength(): DraftLength {
  return readStoredLength(WRITE_ME_LENGTH_KEY);
}

function readStoredImpLength(): DraftLength {
  return readStoredLength(IMP_LENGTH_KEY);
}

function readStoredNarLength(): DraftLength {
  return readStoredLength(NAR_LENGTH_KEY);
}

const AN_RICHNESS_KEY = 'nw.authorsNote.richness';

function readStoredRichness(): AuthorsNoteRichness {
  try {
    const raw = window.localStorage.getItem(AN_RICHNESS_KEY);
    if (raw == null || raw.trim() === '') return DEFAULT_AUTHORS_NOTE_RICHNESS;
    return clampAuthorsNoteRichness(Number(raw));
  } catch {
    return DEFAULT_AUTHORS_NOTE_RICHNESS;
  }
}

function AuthorsNotePanel({ meta, onChange, onCommit }: {
  meta: ChatMeta;
  onChange: (n: ChatMeta['authorsNote']) => void;
  onCommit: (n: ChatMeta['authorsNote']) => Promise<void>;
}) {
  const note = meta.authorsNote;
  const [seed, setSeed] = useState(note?.text ?? '');
  const [draft, setDraft] = useState<{ text: string; seed: string; richness: AuthorsNoteRichness } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const [richness, setRichness] = useState<AuthorsNoteRichness>(readStoredRichness);

  // Keep seed field in sync when note loads/changes from outside (unless drafting)
  useEffect(() => {
    if (!draft) setSeed(note?.text ?? '');
  }, [note?.text, draft]);

  function setRichnessPersist(next: AuthorsNoteRichness) {
    setRichness(next);
    try { window.localStorage.setItem(AN_RICHNESS_KEY, String(next)); } catch { /* ignore quota / private mode */ }
  }

  function patchNote(text: string) {
    return {
      text,
      depth: note?.depth ?? 4,
      interval: note?.interval ?? 1,
      role: note?.role ?? ('system' as const),
    };
  }

  /**
   * Always expands from what is in the seed box *now*, including on Regen — the
   * field stays editable while a draft is showing, so "edit the seed, press
   * Regen" has to be the thing that steers the next draft.
   */
  async function runAiExpand() {
    setAiError('');
    setAiBusy(true);
    try {
      const useSeed = seed;
      const { text } = await api.expandAuthorsNote(meta.id, useSeed, richness);
      setDraft({ text, seed: useSeed, richness });
    } catch (err: any) {
      setAiError(err.message ?? 'Could not expand author\'s note');
    } finally {
      setAiBusy(false);
    }
  }

  function acceptDraft() {
    if (!draft?.text.trim()) return;
    const next = patchNote(draft.text.trim());
    onChange(next);
    void onCommit(next);
    setSeed(draft.text.trim());
    setDraft(null);
  }

  function deleteDraft() {
    setDraft(null);
    setAiError('');
  }

  return (
    <div>
      <p className="t-caption" style={{ marginBottom: 12 }}>
        Author&apos;s Note for this chat only. Type a seed, set how long the expansion should be, then use AI — it reads your input, the character cards, and the story so far.
      </p>
      <label className="field-label">Note text</label>
      <textarea
        className="textarea"
        rows={6}
        value={seed}
        onChange={(e) => {
          setSeed(e.target.value);
          onChange(patchNote(e.target.value));
        }}
        onBlur={() => {
          if (!draft) void onCommit(patchNote(seed));
        }}
        placeholder="Seed or full note — e.g. “keep tension high, she distrusts him”…"
        disabled={aiBusy}
      />
      <div className="an-richness">
        <div className="an-richness-head">
          <label className="field-label" htmlFor="an-richness-slider" style={{ marginBottom: 0 }}>
            Length &amp; detail
          </label>
          <span className="an-richness-value">
            {AUTHORS_NOTE_RICHNESS[richness].label}
            <em>~{AUTHORS_NOTE_RICHNESS[richness].targetWords} words</em>
          </span>
        </div>
        <input
          id="an-richness-slider"
          type="range"
          min={1}
          max={5}
          step={1}
          value={richness}
          disabled={aiBusy}
          aria-valuemin={1}
          aria-valuemax={5}
          aria-valuenow={richness}
          aria-valuetext={`${AUTHORS_NOTE_RICHNESS[richness].label}, about ${AUTHORS_NOTE_RICHNESS[richness].targetWords} words`}
          onChange={(e) => setRichnessPersist(clampAuthorsNoteRichness(Number(e.target.value)))}
        />
        <div className="an-richness-ticks" aria-hidden>
          {([1, 2, 3, 4, 5] as const).map((n) => (
            <button
              key={n}
              type="button"
              className={`an-richness-tick${richness === n ? ' is-active' : ''}`}
              disabled={aiBusy}
              onClick={() => setRichnessPersist(n)}
            >
              {AUTHORS_NOTE_RICHNESS[n].label}
            </button>
          ))}
        </div>
        <p className="t-caption an-richness-hint">{AUTHORS_NOTE_RICHNESS[richness].hint}</p>
      </div>
      <div className="an-ai-row">
        <button
          type="button"
          className={`an-ai-btn${aiBusy ? ' is-busy' : ''}`}
          disabled={aiBusy}
          title={`Expand with AI to ~${AUTHORS_NOTE_RICHNESS[richness].targetWords} words using seed, cards, and story so far`}
          aria-label="Expand author's note with AI"
          onClick={() => void runAiExpand()}
        >
          {aiBusy ? <GlobeLoader size={16} title="Writing note" /> : <IconAi size={16} />}
        </button>
        <span className="t-caption an-ai-hint">
          {aiBusy
            ? `Writing ${AUTHORS_NOTE_RICHNESS[richness].label.toLowerCase()} note from seed, cards, and story…`
            : 'AI expand — seed + cards + story so far'}
        </span>
      </div>
      <SoftReveal show={!!aiError} gap={0}>
        <p className="t-caption" style={{ color: 'var(--danger)', marginTop: 8 }}>{aiError}</p>
      </SoftReveal>
      <SoftReveal show={!!draft} gap={0}>
        {draft && (
          <div className="an-draft-panel" style={{ marginTop: 12 }}>
            <div className="an-draft-bar">
              <IconAi size={14} />
              <span className="t-caption" style={{ flex: 1 }}>AI draft ready</span>
              <button type="button" className="btn btn-ghost btn-sm" disabled={aiBusy} onClick={deleteDraft}>
                Delete
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={aiBusy}
                title="Re-expand from the seed text as it reads right now"
                onClick={() => void runAiExpand()}
              >
                Regen
              </button>
              <button type="button" className="btn btn-primary btn-sm" disabled={aiBusy || !draft.text.trim()} onClick={acceptDraft}>
                Accept
              </button>
            </div>
            <p className="t-caption an-draft-seed" title={draft.seed || undefined}>
              Seed: <em>{draft.seed || '(scene only)'}</em>
              {' · '}
              {AUTHORS_NOTE_RICHNESS[draft.richness].label}
              {' · ~'}
              {AUTHORS_NOTE_RICHNESS[draft.richness].targetWords} words
            </p>
            <div className="an-draft-body">{draft.text}</div>
          </div>
        )}
      </SoftReveal>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12 }}>
        <div>
          <label className="field-label">Depth</label>
          <input
            className="input"
            type="number"
            min={0}
            value={note?.depth ?? 4}
            onChange={(e) =>
              onChange({
                text: seed,
                depth: Number(e.target.value),
                interval: note?.interval ?? 1,
                role: note?.role ?? 'system',
              })
            }
            onBlur={() => void onCommit(patchNote(seed))}
          />
        </div>
        <div>
          <label className="field-label">Interval</label>
          <input
            className="input"
            type="number"
            min={1}
            value={note?.interval ?? 1}
            onChange={(e) =>
              onChange({
                text: seed,
                depth: note?.depth ?? 4,
                interval: Number(e.target.value),
                role: note?.role ?? 'system',
              })
            }
            onBlur={() => void onCommit(patchNote(seed))}
          />
        </div>
      </div>
      <label className="field-label" style={{ marginTop: 10 }}>Role</label>
      <select
        className="input"
        value={note?.role ?? 'system'}
        onChange={(e) => {
          const authorsNote = {
            text: seed,
            depth: note?.depth ?? 4,
            interval: note?.interval ?? 1,
            role: e.target.value as 'system' | 'user' | 'assistant',
          };
          onChange(authorsNote);
          void onCommit(authorsNote);
        }}
      >
        <option value="system">System</option>
        <option value="user">User</option>
        <option value="assistant">Assistant</option>
      </select>
    </div>
  );
}

/** Pull readable sheet text from a card (skip raw JSON dumps). */
function characterSheetText(char: CharacterCard): string {
  const d = char.description || '';
  let body = d;
  if (d.trim().startsWith('{')) {
    try {
      const j = JSON.parse(d) as Record<string, unknown>;
      const inner = (j.character && typeof j.character === 'object' ? j.character : j) as Record<string, unknown>;
      const parts = [inner.description, inner.personality, inner.scenario]
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
      body = parts.join('\n\n') || d.slice(0, 200);
    } catch {
      body = d;
    }
  }
  const personality = char.personality?.trim();
  if (personality && !body.includes(personality.slice(0, Math.min(48, personality.length)))) {
    body = body
      ? `${body}\n\nPersonality: ${personality}`
      : `Personality: ${personality}`;
  }
  return body.trim();
}

type SheetBlock = { label?: string; value: string };

/** Parse "Label: value" lines into structured rows for the Members panel. */
function parseCharacterSheet(text: string): SheetBlock[] {
  if (!text) return [];
  const blocks: SheetBlock[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;
    // Short label before first colon (e.g. "Age: 25", "Real Human Name: Elin")
    const m = line.match(/^([A-Za-z][A-Za-z0-9 /&'’.-]{0,36}):\s*(.*)$/);
    if (m && m[1].length <= 36 && !/^\d/.test(m[1])) {
      blocks.push({ label: m[1].trim(), value: m[2] });
      continue;
    }
    // Continuation of previous multi-line value
    if (blocks.length > 0) {
      const prev = blocks[blocks.length - 1]!;
      prev.value = prev.value ? `${prev.value}\n${line}` : line;
    } else {
      blocks.push({ value: line });
    }
  }
  return blocks;
}

function CharacterSheet({ char }: { char: CharacterCard }) {
  const text = characterSheetText(char);
  const blocks = parseCharacterSheet(text);
  if (!blocks.length) {
    return <p className="t-caption">No description yet.</p>;
  }
  return (
    <div className="char-sheet">
      {blocks.map((b, i) => (
        <div key={`${b.label ?? 'p'}-${i}`} className="char-sheet-row">
          {b.label ? <div className="char-sheet-label">{b.label}</div> : null}
          <div className="char-sheet-value">{b.value}</div>
        </div>
      ))}
    </div>
  );
}

function CastPanel({
  group, members, youId, soloChar, characterPool, onToggleMute, onPatchGroup, onAddMember, onRemoveMember,
  onAnalyzeStyle, styleBusy, onSaveStyle, onOpenCharacter,
}: {
  group: Group | null;
  members: CharacterCard[];
  /** Cast member the human occupies (persona-aware), or null. */
  youId: string | null;
  soloChar: CharacterCard | null;
  characterPool: CharacterCard[];
  onToggleMute: (id: string) => void;
  onPatchGroup: (p: Partial<Group>) => void;
  onAddMember: (c: CharacterCard) => void | Promise<void>;
  onRemoveMember: (c: CharacterCard) => void | Promise<void>;
  onAnalyzeStyle: () => void;
  styleBusy: boolean;
  onSaveStyle: (p: Partial<NonNullable<Group['styleProfile']>>) => void;
  onOpenCharacter: (id: string) => void;
}) {
  if (soloChar) {
    return (
      <div className="cast-solo">
        <div className="cast-solo-header">
          <Avatar src={soloChar.avatar} name={soloChar.name} characterId={soloChar.id} size={56} />
          <div className="cast-solo-meta">
            <div className="cast-solo-name">{soloChar.name}</div>
            <button
              type="button"
              className="btn btn-ghost btn-sm cast-solo-open"
              onClick={() => onOpenCharacter(soloChar.id)}
            >
              Open in Creator →
            </button>
          </div>
        </div>
        <CharacterSheet char={soloChar} />
      </div>
    );
  }
  if (!group) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div>
        <p className="field-label">This chat’s members</p>
        <p className="t-caption" style={{ marginBottom: 10 }}>
          Who is in <em>this</em> scene (not the global Library). Use <strong>+</strong> to add from your character pool.
        </p>
        <GroupMemberStrip
          members={members}
          pool={characterPool}
          onAdd={onAddMember}
          onRemove={onRemoveMember}
          onOpen={(c) => onOpenCharacter(c.id)}
          size={44}
          playAsId={youId}
          mutedIds={group.disabledMembers}
          addLabel="Add member"
        />
        <div className="cast-member-list">
          {members.map((m) => {
            const muted = group.disabledMembers.includes(m.id);
            return (
              <div key={m.id} className={`cast-member-row${muted ? ' is-muted' : ''}`}>
                <Avatar src={m.avatar} name={m.name} characterId={m.id} size={28} />
                <button
                  type="button"
                  style={{
                    background: 'none', border: 'none',
                    color: muted ? 'var(--ink-faint)' : 'var(--ink)',
                    cursor: 'pointer', flex: 1, textAlign: 'left',
                    fontWeight: 600,
                    fontSize: 13,
                    padding: 0,
                  }}
                  className="cast-member-name"
                  onClick={() => onOpenCharacter(m.id)}
                >
                  {m.name}{youId === m.id ? ' · You' : ''}
                </button>
                <button type="button" className="chip" style={{ height: 22 }} onClick={() => onToggleMute(m.id)}>
                  {muted ? 'Unmute' : 'Mute'}
                </button>
                {members.length > 1 && (
                  <button
                    type="button"
                    className="chip"
                    style={{ height: 22 }}
                    title={`Remove ${m.name}`}
                    onClick={() => void onRemoveMember(m)}
                  >
                    Remove
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div>
        <p className="field-label">Scene Systems</p>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer' }}>
          <input type="checkbox" checked={group.narratorEnabled} onChange={(e) => onPatchGroup({ narratorEnabled: e.target.checked })} />
          <span className="t-label">Narrator voice</span>
        </label>

        <div className="genesis-switch-card">
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={group.genesisEnabled}
              onChange={(e) => onPatchGroup({ genesisEnabled: e.target.checked })}
              style={{ marginTop: 3 }}
            />
            <span>
              <span className="t-label" style={{ display: 'block' }}>Genesis — auto new characters</span>
              <span className="t-caption" style={{ display: 'block', marginTop: 4 }}>
                When on, if the scene needs someone not in the group (e.g. “I saw him walk in”),
                AI drafts a full card + portrait. No image API → prompt in the frame with Copy;
                generate elsewhere and drop the image in to save.
              </span>
            </span>
          </label>
          {group.genesisEnabled && (
            <p className="t-caption" style={{ marginTop: 8, color: 'var(--accent)' }}>
              Active — scans after you send · also via Director → Summon
            </p>
          )}
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer' }}>
          <input type="checkbox" checked={group.allowSelfResponses} onChange={(e) => onPatchGroup({ allowSelfResponses: e.target.checked })} />
          <span className="t-label">Allow self-responses</span>
        </label>
        <label className="field-label" style={{ marginTop: 10 }}>Generation mode (ST)</label>
        <select
          className="input"
          value={group.generationMode ?? 'swap'}
          onChange={(e) => onPatchGroup({ generationMode: e.target.value as Group['generationMode'] })}
        >
          <option value="swap">Swap (active card only)</option>
          <option value="append">Append (merge members)</option>
          <option value="append_disabled">Append disabled</option>
        </select>
        <label className="field-label" style={{ marginTop: 10 }}>Auto-advance delay (seconds, 0 = off)</label>
        <input
          className="input"
          type="number"
          min={0}
          max={120}
          value={group.autoModeDelay ?? 0}
          onChange={(e) => onPatchGroup({
            autoModeDelay: Math.max(0, Math.min(120, Number(e.target.value) || 0)),
          })}
        />
        <p className="t-caption">
          Above 0 the scene keeps playing itself: after each reply it waits this long, then takes
          the next turn. Type or press Stop to take it back. It pauses on its own after{' '}
          {AUTO_ADVANCE_CAP} turns so a scene cannot run all night.
        </p>
        {(group.generationMode === 'append') && (
          <>
            <label className="field-label" style={{ marginTop: 10 }}>Join prefix</label>
            <input className="input" value={group.generationModeJoinPrefix ?? ''}
              onChange={(e) => onPatchGroup({ generationModeJoinPrefix: e.target.value })} />
            <label className="field-label" style={{ marginTop: 10 }}>Join suffix</label>
            <input className="input" value={group.generationModeJoinSuffix ?? ''}
              onChange={(e) => onPatchGroup({ generationModeJoinSuffix: e.target.value })} />
          </>
        )}
      </div>
      <div>
        <p className="field-label">Art Style Profile</p>
        {group.styleProfile ? (
          <div className="panel" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <label className="field-label">Medium</label>
            <input className="input" value={group.styleProfile.medium} onChange={(e) => onSaveStyle({ medium: e.target.value })} />
            <label className="field-label">Keywords (comma-separated)</label>
            <input
              className="input"
              value={group.styleProfile.keywords.join(', ')}
              onChange={(e) => onSaveStyle({ keywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
            />
            <label className="field-label">Palette</label>
            <input className="input" value={group.styleProfile.palette ?? ''} onChange={(e) => onSaveStyle({ palette: e.target.value })} />
            <label className="field-label">Notes</label>
            <textarea className="textarea" rows={2} value={group.styleProfile.notes ?? ''} onChange={(e) => onSaveStyle({ notes: e.target.value })} />
          </div>
        ) : (
          <p className="t-caption">Not analyzed yet. Genesis and scene images use this to match your group&apos;s art.</p>
        )}
        <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={onAnalyzeStyle} disabled={styleBusy}>
          {styleBusy ? 'Analyzing…' : group.styleProfile ? 'Re-analyze (vision)' : 'Analyze Style'}
        </button>
      </div>
    </div>
  );
}

function InspectorPanel({ data, maxContext }: {
  data?: { items: { source: string; role: string; tokens: number; preview: string }[]; totalTokens: number; at: number };
  maxContext: number;
}) {
  const [open, setOpen] = useState<number | null>(null);
  if (!data) {
    return (
      <p className="t-caption">
        No generation yet. The full assembled prompt of the last reply appears here — every block, its role, and its token cost.
      </p>
    );
  }
  const pct = Math.min(100, Math.round((data.totalTokens / Math.max(maxContext, 1)) * 100));
  const hot = pct >= 85;
  return (
    <div>
      <p className="t-caption">
        Last prompt · {data.totalTokens.toLocaleString()} / {maxContext.toLocaleString()} tokens · {new Date(data.at).toLocaleTimeString()}
      </p>
      <div className="budget-bar" data-hot={hot || undefined} title={`${pct}% of context`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <p className="t-caption" style={{ margin: '6px 0 12px' }}>{pct}% of max context</p>
      {data.items.map((it, i) => (
        <div key={i} style={{ borderBottom: '1px solid var(--hairline)', padding: '7px 0' }}>
          <button
            type="button"
            onClick={() => setOpen(open === i ? null : i)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', width: '100%',
              textAlign: 'left', color: 'var(--ink)', display: 'flex', gap: 8,
            }}
          >
            <span className="t-label" style={{ flex: 1 }}>{it.source}</span>
            <span className="t-caption">{it.role}</span>
            <span className="t-caption" style={{ minWidth: 40, textAlign: 'right' }}>{it.tokens}t</span>
          </button>
          {open === i && <p className="t-caption" style={{ whiteSpace: 'pre-wrap', marginTop: 6 }}>{it.preview}</p>}
        </div>
      ))}
    </div>
  );
}

// ---------------- message row ----------------

interface SwipeControls {
  index: number;
  count: number;
  generating?: boolean;
  disabled?: boolean;
  onPrev: () => void;
  onNext: () => void;
  onNew: () => void;
}

function MessageRow({
  msg, avatar, characterId, editing, editText, setEditText, onEdit, onSaveEdit, onDelete, onHide, onCancelEdit,
  onBranch, branchDisabled, isTip, branchCount, onOpenBranches,
  displayText, streamingInPlace, generating, swipeControls, selected, onSelect,
}: {
  msg: ChatMessage;
  avatar?: string;
  characterId?: string;
  editing: boolean;
  editText: string;
  setEditText: (s: string) => void;
  onEdit: () => void;
  onSaveEdit: () => void;
  onDelete: () => void;
  onHide: () => void;
  onCancelEdit: () => void;
  onBranch?: () => void;
  branchDisabled?: boolean;
  isTip?: boolean;
  branchCount?: number;
  onOpenBranches?: () => void;
  displayText: string;
  streamingInPlace?: boolean;
  generating?: boolean;
  swipeControls?: SwipeControls;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const actions = !editing && (
    <span className="msg-actions">
      {onBranch && (
        <button
          type="button"
          className="icon-btn msg-action-btn"
          onClick={(e) => {
            e.stopPropagation();
            onBranch();
          }}
          disabled={branchDisabled}
          title={
            isTip
              ? 'Save checkpoint of current path'
              : 'Branch from here — save everything after this and continue from this message'
          }
          aria-label="Branch from here"
        >
          <GitFork size={16} />
        </button>
      )}
      {(branchCount ?? 0) > 0 && onOpenBranches && (
        <button
          type="button"
          className="msg-branch-count"
          onClick={(e) => {
            e.stopPropagation();
            onOpenBranches();
          }}
          title={`${branchCount} saved branch${branchCount === 1 ? '' : 'es'} at this message — open Timeline`}
        >
          <GitBranch size={12} />
          {branchCount}
        </button>
      )}
      <button
        type="button"
        className="icon-btn msg-action-btn"
        onClick={(e) => {
          e.stopPropagation();
          onEdit();
        }}
        title="Edit"
        aria-label="Edit"
      >
        <IconEdit size={16} />
      </button>
      <button
        type="button"
        className="icon-btn msg-action-btn"
        onClick={onHide}
        title={msg.hiddenFromPrompt ? 'Show in prompt' : 'Hide from prompt'}
        aria-label="Hide from prompt"
        style={{ color: msg.hiddenFromPrompt ? 'var(--accent)' : undefined }}
      >
        <EyeOff size={16} />
      </button>
      <button type="button" className="icon-btn msg-action-btn icon-btn-danger" onClick={onDelete} title="Delete" aria-label="Delete">
        <IconDelete size={16} />
      </button>
    </span>
  );

  const swipes = swipeControls && (
    <span className="swipe-pager" style={{ marginTop: 8 }}>
      <button
        type="button"
        disabled={swipeControls.generating || swipeControls.disabled || swipeControls.index === 0}
        onClick={swipeControls.onPrev}
        title="Previous variant"
        aria-label="Previous variant"
      >
        <IconPrev size={18} />
      </button>
      <span className="swipe-pager-count">
        {swipeControls.generating
          ? `${swipeControls.index + 1}/${swipeControls.count}`
          : `${swipeControls.index + 1}/${swipeControls.count}`}
      </span>
      <button
        type="button"
        disabled={
          swipeControls.generating ||
          swipeControls.disabled ||
          swipeControls.index >= swipeControls.count - 1
        }
        onClick={swipeControls.onNext}
        title="Next variant"
        aria-label="Next variant"
      >
        <IconNext size={18} />
      </button>
      <button
        type="button"
        disabled={swipeControls.generating || swipeControls.disabled}
        onClick={swipeControls.onNew}
        title="Generate a new variant"
        aria-label="New variant"
        className={swipeControls.generating ? 'is-busy' : undefined}
      >
        <IconPlus size={18} />
      </button>
    </span>
  );

  if (msg.speaker.type === 'narrator') {
    return (
      <div
        data-msg-id={msg.id}
        className={`narrator-block msg-frame${generating ? ' is-generating' : ''}${selected ? ' is-timeline-selected' : ''}`}
        onClick={onSelect}
      >
        {editing ? (
          <div onClick={(e) => e.stopPropagation()}>
            <textarea
              className="textarea"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              rows={5}
              autoFocus
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 6, justifyContent: 'center' }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={onSaveEdit}>Save</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onCancelEdit}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            {generating && !displayText ? (
              <div className="gen-pulse t-caption"><GlobeLoader size={14} /> Generating variant…</div>
            ) : (
              <div className={streamingInPlace ? 'caret msg-swipe-in' : undefined}>
                <FormattedMessage text={displayText} />
              </div>
            )}
            <div style={{ marginTop: 6, display: 'flex', gap: 8, justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap' }}>
              {swipes}
              {actions}
            </div>
          </>
        )}
      </div>
    );
  }

  const human = msg.controlledBy === 'human';
  return (
    <div
      data-msg-id={msg.id}
      className={`msg-row msg-frame${human ? ' human' : ''}${generating ? ' is-generating' : ''}${selected ? ' is-timeline-selected' : ''}`}
      style={msg.hiddenFromPrompt ? { opacity: 0.55 } : undefined}
      onClick={onSelect}
    >
      <Avatar
        src={avatar}
        name={msg.speaker.displayName}
        characterId={characterId}
        size={40}
        shape="portrait"
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, minHeight: 28 }}>
          <span className="t-label">{msg.speaker.displayName}</span>
          {human && msg.speaker.type === 'character' && (
            <span className="t-caption" style={{ color: 'var(--accent)' }}>You</span>
          )}
          {msg.speaker.type === 'system' && (
            <span className="t-caption" style={{ color: 'var(--accent)' }}>System</span>
          )}
          {msg.hiddenFromPrompt && (
            <span className="t-caption" style={{ color: 'var(--ink-faint)' }}>Hidden</span>
          )}
          {msg.extra?.genesis && (
            <span className="t-caption" style={{ color: 'var(--accent)' }}>New arrival</span>
          )}
          <span className="t-caption">
            {new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
          {actions}
        </div>
        {editing ? (
          <div>
            <textarea className="textarea" value={editText} onChange={(e) => setEditText(e.target.value)} />
            <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={onSaveEdit}>Save</button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onCancelEdit}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            {generating && !displayText ? (
              <div className="gen-pulse t-caption"><GlobeLoader size={14} /> Generating variant…</div>
            ) : (
              <div className={streamingInPlace ? 'caret msg-swipe-in' : undefined}>
                <FormattedMessage text={displayText} />
              </div>
            )}
            {swipes}
          </>
        )}
      </div>
    </div>
  );
}

