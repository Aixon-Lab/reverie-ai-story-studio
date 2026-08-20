/** ST chat-completion preset JSON <-> internal Preset. Lossless: raw kept for export. */
import type { Preset, PresetPrompt, PromptOrderEntry } from '../types';

type AnyObj = Record<string, any>;

export const CORE_MARKERS = [
  'main', 'nsfw', 'jailbreak', 'enhanceDefinitions',
  'worldInfoBefore', 'worldInfoAfter', 'charDescription', 'charPersonality',
  'scenario', 'dialogueExamples', 'chatHistory', 'personaDescription',
] as const;

const DEFAULT_UTILITY = {
  impersonation_prompt:
    "[Write {{user}}'s next reply in FIRST PERSON only (I / me / my). Output only spoken dialogue in \"quotes\" and actions/thoughts in *asterisks*. No third-person narration about {{user}}. No meta, counters, stages, OOC, or system notes.]",
  new_chat_prompt: '[Start a new Chat]',
  new_group_chat_prompt: '[Start a new group chat. Group members: {{group}}]',
  new_example_chat_prompt: '[Example Chat]',
  continue_nudge_prompt:
    '[Continue your last message without repeating its original content. Stay in first person as {{char}}. Only dialogue and *actions*. No meta.]',
  group_nudge_prompt:
    '[Write the next reply ONLY as {{char}}, in FIRST PERSON (I / me / my). Never " {{char}} does X" — write "I do X". Only "dialogue" and *actions/thoughts*. No other speakers. No meta lines.]',
  wi_format: '{0}',
  scenario_format: '{{scenario}}',
  personality_format: '{{personality}}',
  send_if_empty: '',
};

/**
 * Hard default writing contract — injected every generation.
 * Wrapper characters (quotes / asterisks / custom) come ONLY from Message Style
 * rules (see buildMessageStylePrompt) so user regex/style changes stay authoritative.
 */
export const DEFAULT_WRITING_CONTRACT = [
  'CRITICAL WRITING RULES (non-negotiable — override any preset that conflicts):',
  '1. You ARE {{char}}. Write ONLY in first person: I, me, my, mine. Never third person ("{{char}} walks", "she says").',
  '2. Output ONLY in-world prose using the FORMAT wrappers from the Message Style rules (dialogue + action/thought). Nothing else.',
  '3. NEVER use HTML or markup of any kind: no <font>, no color=#HEX, no <div>, no <span>, no <!-- comments -->, no raw tags.',
  '4. NEVER prefix replies with time/location/weather headers (no "[ Time … | Location … | Fog … ]", no emoji status bars).',
  '5. NEVER append Twitter/X feeds, "Plot Momentum", <details> trackers, OOC, counters, stage notes, JSON, or audience reactions.',
  '6. NEVER narrate {{user}}\'s actions, thoughts, or dialogue. Do not control {{user}}.',
  '7. Stay fully in character. Plain RP only. No author commentary. No empty replies.',
].join('\n');

/** ST stores prompt_order as [{character_id, order}] — 100000/100001 are the global dummies. */
function extractOrder(raw: AnyObj): PromptOrderEntry[] {
  const orders = raw.prompt_order;
  if (Array.isArray(orders)) {
    const global = orders.find((o: AnyObj) => o.character_id === 100001)
      ?? orders.find((o: AnyObj) => o.character_id === 100000)
      ?? orders[orders.length - 1];
    if (global && Array.isArray(global.order)) {
      return global.order.map((e: AnyObj) => ({ identifier: String(e.identifier), enabled: e.enabled !== false }));
    }
  }
  // sensible default order (ST default preset)
  return ['main', 'worldInfoBefore', 'personaDescription', 'charDescription', 'charPersonality', 'scenario', 'nsfw', 'worldInfoAfter', 'dialogueExamples', 'chatHistory', 'jailbreak']
    .map((identifier) => ({ identifier, enabled: true }));
}

export function parsePreset(raw: AnyObj, id: string, name: string): Preset {
  const prompts: PresetPrompt[] = Array.isArray(raw.prompts)
    ? raw.prompts.map((p: AnyObj) => ({
        identifier: String(p.identifier),
        name: String(p.name ?? p.identifier),
        role: p.role,
        content: p.content,
        system_prompt: !!p.system_prompt,
        marker: !!p.marker,
        injection_position: p.injection_position,
        injection_depth: p.injection_depth,
        injection_order: p.injection_order,
        forbid_overrides: p.forbid_overrides,
      }))
    : defaultPrompts();

  return {
    id,
    name,
    temperature: num(raw.temperature, 1),
    frequency_penalty: num(raw.frequency_penalty, 0),
    presence_penalty: num(raw.presence_penalty, 0),
    top_p: num(raw.top_p, 1),
    top_k: num(raw.top_k, 0),
    min_p: num(raw.min_p, 0),
    repetition_penalty: num(raw.repetition_penalty, 1),
    max_context: num(raw.openai_max_context, 32000),
    max_tokens: num(raw.openai_max_tokens, 800),
    stream: raw.stream_openai !== false,
    names_behavior: num(raw.names_behavior, 0),
    squash_system_messages: !!raw.squash_system_messages,
    wrap_in_quotes: !!raw.wrap_in_quotes,
    utility_prompts: {
      impersonation_prompt: strOr(raw.impersonation_prompt, DEFAULT_UTILITY.impersonation_prompt),
      new_chat_prompt: strOr(raw.new_chat_prompt, DEFAULT_UTILITY.new_chat_prompt),
      new_group_chat_prompt: strOr(raw.new_group_chat_prompt, DEFAULT_UTILITY.new_group_chat_prompt),
      new_example_chat_prompt: strOr(raw.new_example_chat_prompt, DEFAULT_UTILITY.new_example_chat_prompt),
      continue_nudge_prompt: strOr(raw.continue_nudge_prompt, DEFAULT_UTILITY.continue_nudge_prompt),
      group_nudge_prompt: strOr(raw.group_nudge_prompt, DEFAULT_UTILITY.group_nudge_prompt),
      wi_format: strOr(raw.wi_format, DEFAULT_UTILITY.wi_format),
      scenario_format: strOr(raw.scenario_format, DEFAULT_UTILITY.scenario_format),
      personality_format: strOr(raw.personality_format, DEFAULT_UTILITY.personality_format),
      send_if_empty: strOr(raw.send_if_empty, ''),
    },
    prompts,
    prompt_order: extractOrder(raw),
    stop_strings: Array.isArray(raw.stop_strings)
      ? raw.stop_strings.map(String)
      : Array.isArray(raw.custom_stopping_strings)
        ? raw.custom_stopping_strings.map(String)
        : [],
    logit_bias: (raw.logit_bias && typeof raw.logit_bias === 'object' ? raw.logit_bias : {}) as Record<string, number>,
    raw,
  };
}

export function exportPreset(preset: Preset): AnyObj {
  const out: AnyObj = { ...(preset.raw ?? {}) };
  out.temperature = preset.temperature;
  out.frequency_penalty = preset.frequency_penalty;
  out.presence_penalty = preset.presence_penalty;
  out.top_p = preset.top_p;
  out.top_k = preset.top_k;
  out.min_p = preset.min_p;
  out.repetition_penalty = preset.repetition_penalty;
  out.openai_max_context = preset.max_context;
  out.openai_max_tokens = preset.max_tokens;
  out.stream_openai = preset.stream;
  out.names_behavior = preset.names_behavior;
  out.squash_system_messages = preset.squash_system_messages;
  Object.assign(out, preset.utility_prompts);
  out.prompts = preset.prompts;
  out.prompt_order = [
    { character_id: 100000, order: preset.prompt_order },
    { character_id: 100001, order: preset.prompt_order },
  ];
  out.stop_strings = preset.stop_strings ?? [];
  out.custom_stopping_strings = preset.stop_strings ?? [];
  out.logit_bias = preset.logit_bias ?? {};
  return out;
}

export function defaultPrompts(): PresetPrompt[] {
  return [
    {
      identifier: 'main',
      name: 'Main Prompt',
      role: 'system',
      system_prompt: true,
      content: [
        'You are {{char}} in a live roleplay with {{user}}.',
        'Write ONLY {{char}}\'s next message, in FIRST PERSON (I / me / my) — as if you are living the moment, not describing {{char}} from outside.',
        'WRONG: "{{char}} glares." / "She steps closer."  RIGHT: "*I glare.*" / "*I step closer.*"',
        'Content must be only: "spoken lines" and *actions, sensations, thoughts*.',
        'Forbidden in the reply: counters, stages, trackers, OOC, meta, system notes, JSON, labels like counter:/stage:/turn:.',
        'Do not write {{user}}\'s lines or decide their actions.',
      ].join(' '),
    },
    { identifier: 'nsfw', name: 'Auxiliary Prompt', role: 'system', system_prompt: true, content: '' },
    { identifier: 'dialogueExamples', name: 'Chat Examples', system_prompt: true, marker: true },
    {
      identifier: 'jailbreak',
      name: 'Post-History Instructions',
      role: 'system',
      system_prompt: true,
      content: [
        '[Final check before you answer as {{char}}]',
        '- First person only (I/me/my).',
        '- Only "dialogue" and *action/thought*.',
        '- Zero meta (no counter, stage, status, OOC).',
        '- Stay in character. No empty output.',
      ].join('\n'),
    },
    { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
    { identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, marker: true },
    { identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true },
    { identifier: 'charDescription', name: 'Char Description', system_prompt: true, marker: true },
    { identifier: 'charPersonality', name: 'Char Personality', system_prompt: true, marker: true },
    { identifier: 'scenario', name: 'Scenario', system_prompt: true, marker: true },
    { identifier: 'personaDescription', name: 'Persona Description', system_prompt: true, marker: true },
  ];
}

export function defaultPreset(id = 'default', name = 'Reverie Default'): Preset {
  return parsePreset({}, id, name);
}

function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function strOr(v: unknown, d: string): string {
  return typeof v === 'string' ? v : d;
}
