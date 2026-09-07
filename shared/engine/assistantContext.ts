/**
 * Desk-assistant context pack.
 *
 * Omniscient over the open story's *text* — persona, cards, author's note,
 * transcript, memory, lore, skills — and never over images. The packer is pure
 * so tests can prove avatars and data-URLs cannot leak into the prompt.
 */
import { estimateTokens } from './tokens';

export interface AssistantCastMember {
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creator_notes?: string;
  system_prompt?: string;
  post_history_instructions?: string;
  tags?: string[];
  /** Text labels only. Never URLs or image payloads. */
  photoLabels?: string[];
}

export interface AssistantTranscriptLine {
  name: string;
  text: string;
}

export interface AssistantPackInput {
  hasChat: boolean;
  chatTitle?: string;
  persona?: { name: string; description?: string };
  /** The library character the user is currently playing, if any. */
  youCard?: AssistantCastMember;
  characters: AssistantCastMember[];
  authorsNote?: string;
  scenarioOverride?: string;
  summary?: string;
  variables?: Record<string, string>;
  director?: {
    nudge?: string;
    intensity?: number;
    sceneGoal?: string;
    cutTo?: string;
    prefer?: string;
  };
  transcript: AssistantTranscriptLine[];
  brains: { name: string; text: string }[];
  lore: string[];
  skills: { name: string; description?: string }[];
  budgetTokens: number;
}

export interface AssistantPack {
  system: string;
  tokens: number;
  dropped: string[];
}

/** Strip image markdown, data URLs, and character-avatar API paths from text. */
export function stripImagePayloads(text: string): string {
  if (!text) return '';
  return text
    .replace(/data:image\/[a-zA-Z0+.\-]+;base64,[A-Za-z0-9+/=\s]+/gi, '[image omitted]')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '[image omitted]')
    .replace(/\/api\/characters\/[^\s)"']+/g, '[image omitted]')
    .replace(/https?:\/\/\S+\.(?:png|jpe?g|gif|webp|svg|avif)(?:\?\S*)?/gi, '[image omitted]');
}

function field(label: string, value: string | undefined): string {
  const v = stripImagePayloads(value ?? '').trim();
  if (!v) return '';
  return `${label}:\n${v}`;
}

export function renderCastMember(c: AssistantCastMember): string {
  const parts = [
    `### ${stripImagePayloads(c.name) || 'Unnamed'}`,
    field('Description', c.description),
    field('Personality', c.personality),
    field('Scenario', c.scenario),
    field('First message', c.first_mes),
    field('Example dialogue', c.mes_example),
    field('Creator notes', c.creator_notes),
    field('System prompt', c.system_prompt),
    field('Post-history instructions', c.post_history_instructions),
  ].filter(Boolean);
  const tags = (c.tags ?? []).map((t) => stripImagePayloads(t).trim()).filter(Boolean);
  if (tags.length) parts.push(`Tags: ${tags.join(', ')}`);
  const labels = (c.photoLabels ?? []).map((t) => stripImagePayloads(t).trim()).filter(Boolean);
  if (labels.length) parts.push(`Portrait labels (text only, no images): ${labels.join(', ')}`);
  return parts.join('\n\n');
}

function instructions(hasChat: boolean): string {
  return [
    'You are Reverie — the desk assistant for this story platform. You are not a character in the scene.',
    'The user asks you ABOUT the story: the open chat, who they are playing, the author\'s note, the cast sheets, memories, lore, and anything else on the desk below.',
    'Answer from that desk. Quote or name the source when it helps (author\'s note, a chat line, a character sheet, a memory). If it is not on the desk, say you do not have it — do not invent wardrobe, locations, or events.',
    'You never receive images or portraits. Do not claim to see a picture.',
    'You do not post into the story chat. Stay out of character unless they explicitly ask you to draft a line for them.',
    hasChat
      ? 'A story is open. Prefer the current author\'s note and recent transcript when the user asks what is happening or what someone is wearing or doing right now.'
      : 'No story is open. You still know who the user is playing as. Invite them to open a chat if the question needs a scene.',
    'Keep answers concise unless they ask for detail. Proper sentences. No meta about "the system prompt".',
  ].join('\n');
}

interface Section {
  id: string;
  text: string;
  /** Lower is kept longer when trimming. */
  keep: number;
}

function takeBudget(sections: Section[], budget: number): { kept: Section[]; dropped: string[] } {
  const dropped: string[] = [];
  const ordered = [...sections].sort((a, b) => a.keep - b.keep);
  const included = new Set<string>();
  let used = 0;
  for (const s of ordered) {
    if (!s.text.trim()) continue;
    const cost = estimateTokens(s.text) + 4;
    if (used + cost > budget && included.size > 0 && s.keep > 1) {
      dropped.push(s.id);
      continue;
    }
    included.add(s.id);
    used += cost;
  }
  // If we are still over (instructions + you + note alone), trim the transcript tail from the start.
  return {
    kept: sections.filter((s) => included.has(s.id)),
    dropped,
  };
}

function trimTranscript(lines: AssistantTranscriptLine[], maxTokens: number): string {
  const rendered: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = `${stripImagePayloads(lines[i].name)}: ${stripImagePayloads(lines[i].text)}`.trim();
    if (!line || line === ':') continue;
    const cost = estimateTokens(line) + 1;
    if (used + cost > maxTokens && rendered.length) break;
    rendered.push(line);
    used += cost;
  }
  rendered.reverse();
  return rendered.join('\n');
}

export function packAssistantContext(input: AssistantPackInput): AssistantPack {
  const budget = Math.max(800, input.budgetTokens);
  const youName = stripImagePayloads(input.persona?.name || input.youCard?.name || 'You');

  const youParts = [
    `## You (the user)`,
    `Playing as: ${youName}`,
    field('Persona', input.persona?.description),
  ];
  if (input.youCard) {
    youParts.push('Character sheet for who you are playing:');
    youParts.push(renderCastMember(input.youCard));
  }

  const recent = input.transcript.slice(-16);
  const older = input.transcript.slice(0, Math.max(0, input.transcript.length - 16));

  const castText = input.characters
    .filter((c) => c.name && c.name !== input.youCard?.name)
    .map(renderCastMember)
    .filter(Boolean)
    .join('\n\n');

  const brainText = input.brains
    .map((b) => `### ${stripImagePayloads(b.name)}\n${stripImagePayloads(b.text)}`.trim())
    .filter((t) => t.length > 4)
    .join('\n\n');

  const loreText = input.lore.map(stripImagePayloads).map((s) => s.trim()).filter(Boolean).join('\n\n');

  const skillText = input.skills
    .map((s) => {
      const n = stripImagePayloads(s.name).trim();
      const d = stripImagePayloads(s.description ?? '').trim();
      return d ? `- ${n}: ${d}` : `- ${n}`;
    })
    .filter((l) => l.length > 2)
    .join('\n');

  const directorBits = [
    input.director?.nudge
      ? `Nudge (intensity ${input.director.intensity ?? '?'}): ${stripImagePayloads(input.director.nudge)}`
      : '',
    input.director?.sceneGoal ? `Scene goal: ${stripImagePayloads(input.director.sceneGoal)}` : '',
    input.director?.cutTo ? `Cut to: ${stripImagePayloads(input.director.cutTo)}` : '',
    input.director?.prefer ? `Prefer: ${stripImagePayloads(input.director.prefer)}` : '',
  ].filter(Boolean).join('\n');

  const vars = input.variables
    ? Object.entries(input.variables)
      .filter(([k, v]) => k && v)
      .map(([k, v]) => `${k} = ${stripImagePayloads(v)}`)
      .join('\n')
    : '';

  const header = input.hasChat
    ? `Open story: ${stripImagePayloads(input.chatTitle || 'Untitled chat')}`
    : 'No story is open.';

  const sections: Section[] = [
    { id: 'instructions', keep: 0, text: instructions(input.hasChat) },
    { id: 'header', keep: 0, text: header },
    { id: 'you', keep: 1, text: youParts.filter(Boolean).join('\n') },
    {
      id: 'authorsNote',
      keep: 1,
      text: input.authorsNote?.trim()
        ? `## Author's note (current scene direction)\n${stripImagePayloads(input.authorsNote)}`
        : '',
    },
    {
      id: 'scenario',
      keep: 2,
      text: input.scenarioOverride?.trim()
        ? `## Scenario override\n${stripImagePayloads(input.scenarioOverride)}`
        : '',
    },
    {
      id: 'summary',
      keep: 3,
      text: input.summary?.trim()
        ? `## Running summary\n${stripImagePayloads(input.summary)}`
        : '',
    },
    {
      id: 'recent',
      keep: 2,
      text: recent.length
        ? `## Recent conversation\n${trimTranscript(recent, Math.floor(budget * 0.35))}`
        : '',
    },
    {
      id: 'older',
      keep: 7,
      text: older.length
        ? `## Earlier conversation\n${trimTranscript(older, Math.floor(budget * 0.15))}`
        : '',
    },
    {
      id: 'cast',
      keep: 4,
      text: castText ? `## Cast sheets\n${castText}` : '',
    },
    {
      id: 'brains',
      keep: 4,
      text: brainText ? `## Character memory and inner state\n${brainText}` : '',
    },
    {
      id: 'director',
      keep: 5,
      text: directorBits ? `## Director\n${directorBits}` : '',
    },
    {
      id: 'variables',
      keep: 6,
      text: vars ? `## Chat variables\n${vars}` : '',
    },
    {
      id: 'lore',
      keep: 6,
      text: loreText ? `## Active lore\n${loreText}` : '',
    },
    {
      id: 'skills',
      keep: 8,
      text: skillText ? `## Armed skills\n${skillText}` : '',
    },
  ];

  const { kept, dropped } = takeBudget(sections, budget);
  const system = kept.map((s) => s.text.trim()).filter(Boolean).join('\n\n');
  return { system, tokens: estimateTokens(system), dropped };
}

/** Convert a library card into the image-free shape the packer accepts. */
export function cardToAssistantMember(card: {
  name: string;
  description?: string;
  personality?: string;
  scenario?: string;
  first_mes?: string;
  mes_example?: string;
  creator_notes?: string;
  system_prompt?: string;
  post_history_instructions?: string;
  tags?: string[];
  avatar?: string;
  photos?: { url?: string; label?: string }[];
}): AssistantCastMember {
  return {
    name: card.name,
    description: card.description,
    personality: card.personality,
    scenario: card.scenario,
    first_mes: card.first_mes,
    mes_example: card.mes_example,
    creator_notes: card.creator_notes,
    system_prompt: card.system_prompt,
    post_history_instructions: card.post_history_instructions,
    tags: card.tags,
    photoLabels: (card.photos ?? []).map((p) => p.label).filter((x): x is string => !!x?.trim()),
  };
}
