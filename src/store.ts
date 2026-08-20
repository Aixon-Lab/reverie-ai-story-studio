/** Global app store — settings, presets, formatting packs, drawer host. */
import { create } from 'zustand';
import type {
  AppSettings, CharacterCard, ChatMeta, ContextPreset, DrawerId, Group, InstructPreset,
  Lorebook, Persona, Preset, PromptItem, ReasoningPreset, SyspromptPreset,
} from '@shared/types';
import { api } from './api';
import { personaIdForCharacter } from '@shared/engine/identity';
import {
  clampToViewport,
  findFreePortraitSlot,
  PORTRAIT_FRAME_H,
  PORTRAIT_FRAME_W,
} from './lib/portraitFloat';

export interface PortraitFloatItem {
  id: string;
  src?: string;
  name: string;
  x: number;
  y: number;
  /** Frame width (3:4 locked with h). Defaults to PORTRAIT_FRAME_W when opened. */
  w: number;
  /** Frame height (3:4 locked with w). Defaults to PORTRAIT_FRAME_H when opened. */
  h: number;
}

interface AppState {
  loaded: boolean;
  settings: AppSettings | null;
  presets: Preset[];
  instruct: InstructPreset[];
  context: ContextPreset[];
  sysprompt: SyspromptPreset[];
  reasoning: ReasoningPreset[];
  lorebooks: Lorebook[];
  personas: Persona[];
  characters: CharacterCard[];
  groups: Group[];
  chats: ChatMeta[];
  secretKeys: string[];
  inspector: Record<string, { items: PromptItem[]; totalTokens: number; at: number }>;
  openDrawer: DrawerId;
  /** Multiple floating portraits (same z-level, no stacking). */
  portraitFloats: PortraitFloatItem[];

  loadAll: () => Promise<void>;
  refreshChats: () => Promise<void>;
  refreshCharacters: () => Promise<void>;
  refreshGroups: () => Promise<void>;
  refreshLorebooks: () => Promise<void>;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
  activePreset: () => Preset | null;
  patchActivePreset: (patch: Partial<Preset>) => void;
  commitActivePreset: () => Promise<void>;
  setActivePresetId: (id: string) => Promise<void>;
  setPresets: (p: Preset[]) => void;
  setPersonas: (p: Persona[]) => void;
  /** Activate a persona and keep the open chat's meta in sync. */
  activatePersona: (id: string) => Promise<void>;
  /** Become a library character: reuse/mint their persona, then activate it. */
  becomeCharacter: (card: CharacterCard) => Promise<Persona>;
  setInspector: (chatId: string, items: PromptItem[], totalTokens: number) => void;
  setDrawer: (id: DrawerId) => void;
  toggleDrawer: (id: NonNullable<DrawerId>) => void;
  openPortrait: (p: { src?: string; name: string }) => void;
  closePortrait: (id: string) => void;
  closeAllPortraits: () => void;
  movePortrait: (id: string, x: number, y: number) => void;
  /** Resize float (caller keeps 3:4). Also reclamps position so it stays on-screen. */
  resizePortrait: (id: string, w: number, h: number) => void;
}

export const useApp = create<AppState>((set, get) => ({
  loaded: false,
  settings: null,
  presets: [],
  instruct: [],
  context: [],
  sysprompt: [],
  reasoning: [],
  lorebooks: [],
  personas: [],
  characters: [],
  groups: [],
  chats: [],
  secretKeys: [],
  inspector: {},
  openDrawer: null,
  portraitFloats: [],

  loadAll: async () => {
    const [settings, presets, instruct, context, sysprompt, reasoning, lorebooks, personas, characters, groups, chats, secrets] =
      await Promise.all([
        api.getSettings(), api.listPresets(),
        api.listInstruct(), api.listContext(), api.listSysprompt(), api.listReasoning(),
        api.listLorebooks(), api.listPersonas(), api.listCharacters(),
        api.listGroups(), api.listChats(), api.listSecrets(),
      ]);
    set({
      settings, presets, instruct, context, sysprompt, reasoning, lorebooks,
      personas, characters, groups, chats, secretKeys: secrets.keys, loaded: true,
    });
  },
  refreshChats: async () => set({ chats: await api.listChats() }),
  refreshCharacters: async () => set({ characters: await api.listCharacters() }),
  refreshGroups: async () => set({ groups: await api.listGroups() }),
  refreshLorebooks: async () => set({ lorebooks: await api.listLorebooks() }),

  saveSettings: async (patch) => {
    set({ settings: await api.saveSettings(patch) });
  },

  activePreset: () => {
    const { settings, presets } = get();
    if (!settings) return null;
    return presets.find((p) => p.id === settings.activePresetId) ?? presets[0] ?? null;
  },

  patchActivePreset: (patch) => {
    const { settings, presets } = get();
    if (!settings) return;
    set({
      presets: presets.map((p) => (p.id === settings.activePresetId ? { ...p, ...patch } : p)),
    });
  },

  commitActivePreset: async () => {
    const preset = get().activePreset();
    if (!preset) return;
    const saved = await api.updatePreset(preset.id, preset);
    set({ presets: get().presets.map((p) => (p.id === saved.id ? saved : p)) });
  },

  setActivePresetId: async (id) => {
    await get().saveSettings({ activePresetId: id });
  },

  setPresets: (presets) => set({ presets }),
  setPersonas: (personas) => set({ personas }),

  activatePersona: async (id) => {
    await get().saveSettings({ activePersonaId: id });
    // Keep the open chat's meta in step so the server picks the same identity.
    const chatId = window.location.pathname.match(/\/chat\/([^/]+)/)?.[1];
    if (chatId) {
      try {
        await api.updateChat(chatId, { personaId: id });
      } catch {
        /* non-fatal — settings.activePersonaId still drives generation */
      }
    }
  },

  /**
   * One identity, one persona per card: the id is derived from the character so
   * "who am I" is answerable from the persona alone — that is what lets a chat
   * recognise its cast member and never let the AI voice them.
   */
  becomeCharacter: async (card) => {
    const personas = get().personas;
    const existing =
      personas.find((p) => p.id === personaIdForCharacter(card.id))
      ?? personas.find((p) => p.name === card.name && p.avatar === card.avatar);
    const next: Persona = existing
      ? {
          ...existing,
          name: card.name,
          description: card.description || card.personality || existing.description,
          avatar: card.avatar ?? existing.avatar,
        }
      : {
          id: personaIdForCharacter(card.id),
          name: card.name,
          description: card.description || card.personality || '',
          avatar: card.avatar,
        };
    const list = existing
      ? personas.map((p) => (p.id === next.id ? next : p))
      : [...personas, next];
    set({ personas: list });
    await api.savePersonas(list);
    await get().activatePersona(next.id);
    return next;
  },
  setInspector: (chatId, items, totalTokens) =>
    set((s) => ({ inspector: { ...s.inspector, [chatId]: { items, totalTokens, at: Date.now() } } })),

  setDrawer: (openDrawer) => set({ openDrawer }),
  toggleDrawer: (id) => set((s) => ({ openDrawer: s.openDrawer === id ? null : id })),

  openPortrait: (p) => {
    const list = get().portraitFloats;
    // Focus existing same src+name instead of duplicating
    const existing = list.find(
      (f) => f.name === p.name && (f.src || '') === (p.src || ''),
    );
    if (existing) {
      // Bring to end (top of list for Escape order) without changing position
      set({
        portraitFloats: [...list.filter((f) => f.id !== existing.id), existing],
      });
      return;
    }
    const slot = findFreePortraitSlot(list);
    const item: PortraitFloatItem = {
      id: `pf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      src: p.src,
      name: p.name,
      x: slot.x,
      y: slot.y,
      w: PORTRAIT_FRAME_W,
      h: PORTRAIT_FRAME_H,
    };
    set({ portraitFloats: [...list, item] });
  },
  closePortrait: (id) => set((s) => ({ portraitFloats: s.portraitFloats.filter((f) => f.id !== id) })),
  closeAllPortraits: () => set({ portraitFloats: [] }),
  movePortrait: (id, x, y) => set((s) => ({
    portraitFloats: s.portraitFloats.map((f) => (f.id === id ? { ...f, x, y } : f)),
  })),
  resizePortrait: (id, w, h) => set((s) => ({
    portraitFloats: s.portraitFloats.map((f) => {
      if (f.id !== id) return f;
      const pos = clampToViewport(f.x, f.y, w, h);
      return { ...f, w, h, x: pos.x, y: pos.y };
    }),
  })),
}));
