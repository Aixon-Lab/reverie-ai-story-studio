import type { SnapEdge } from './assistantSnap';

const KEY = 'reverie.desk.v1';
const MAX_TURNS = 40;

export interface DeskChrome {
  docked: boolean;
  edge: SnapEdge;
  t: number;
}

export interface DeskMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface DeskSave {
  chrome: DeskChrome;
  threads: Record<string, DeskMessage[]>;
}

const FALLBACK: DeskSave = {
  chrome: { docked: true, edge: 'right', t: 0.38 },
  threads: {},
};

function isEdge(v: unknown): v is SnapEdge {
  return v === 'left' || v === 'right' || v === 'bottom';
}

export function loadDesk(): DeskSave {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...FALLBACK, threads: {} };
    const parsed = JSON.parse(raw) as Partial<DeskSave>;
    const chrome = parsed.chrome;
    return {
      chrome: {
        docked: chrome?.docked !== false,
        edge: isEdge(chrome?.edge) ? chrome.edge : 'right',
        t: typeof chrome?.t === 'number' && Number.isFinite(chrome.t) ? Math.min(1, Math.max(0, chrome.t)) : 0.38,
      },
      threads: parsed.threads && typeof parsed.threads === 'object' ? parsed.threads : {},
    };
  } catch {
    return { ...FALLBACK, threads: {} };
  }
}

export function saveDesk(next: DeskSave) {
  try {
    const threads: Record<string, DeskMessage[]> = {};
    for (const [k, msgs] of Object.entries(next.threads)) {
      threads[k] = msgs.slice(-MAX_TURNS);
    }
    localStorage.setItem(KEY, JSON.stringify({ chrome: next.chrome, threads }));
  } catch {
    // quota / private mode — chrome still works in memory
  }
}

export function threadKey(chatId: string | undefined): string {
  return chatId || 'global';
}
