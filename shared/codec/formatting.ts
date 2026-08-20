/** ST instruct / context / sysprompt / reasoning codecs — lossless via `raw`. */
import type { ContextPreset, InstructPreset, ReasoningPreset, SyspromptPreset } from '../types';

type AnyObj = Record<string, any>;

function slug(name: string): string {
  return name.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/\s+/g, '-').slice(0, 80) || 'preset';
}

export function parseInstruct(raw: AnyObj, id?: string, name?: string): InstructPreset {
  const n = name ?? String(raw.name ?? 'Instruct');
  // migrate legacy separator_sequence → output_suffix
  const outputSuffix =
    raw.output_suffix != null
      ? str(raw.output_suffix)
      : raw.separator_sequence != null
        ? str(raw.separator_sequence)
        : '';
  let namesBehavior = str(raw.names_behavior, 'force');
  if (raw.names !== undefined && raw.names_behavior === undefined) {
    namesBehavior = raw.names ? 'always' : raw.names_force_groups ? 'force' : 'none';
  }
  return {
    id: id ?? slug(n),
    name: n,
    input_sequence: str(raw.input_sequence),
    output_sequence: str(raw.output_sequence),
    system_sequence: str(raw.system_sequence),
    stop_sequence: str(raw.stop_sequence),
    input_suffix: str(raw.input_suffix),
    output_suffix: outputSuffix,
    system_suffix: str(raw.system_suffix),
    last_system_sequence: str(raw.last_system_sequence),
    first_output_sequence: str(raw.first_output_sequence),
    last_output_sequence: str(raw.last_output_sequence),
    first_input_sequence: str(raw.first_input_sequence),
    last_input_sequence: str(raw.last_input_sequence),
    user_alignment_message: str(raw.user_alignment_message),
    activation_regex: str(raw.activation_regex),
    wrap: raw.wrap !== false,
    macro: !!raw.macro,
    names_behavior: namesBehavior,
    sequences_as_stop_strings: raw.sequences_as_stop_strings !== false,
    bind_to_context: !!raw.bind_to_context,
    skip_examples: !!raw.skip_examples,
    system_same_as_user: !!raw.system_same_as_user,
    story_string_prefix: str(raw.story_string_prefix),
    story_string_suffix: str(raw.story_string_suffix),
    raw,
  };
}

export function exportInstruct(p: InstructPreset): AnyObj {
  return {
    ...(p.raw ?? {}),
    name: p.name,
    input_sequence: p.input_sequence,
    output_sequence: p.output_sequence,
    system_sequence: p.system_sequence,
    stop_sequence: p.stop_sequence,
    input_suffix: p.input_suffix,
    output_suffix: p.output_suffix,
    system_suffix: p.system_suffix,
    last_system_sequence: p.last_system_sequence,
    first_output_sequence: p.first_output_sequence,
    last_output_sequence: p.last_output_sequence,
    first_input_sequence: p.first_input_sequence,
    last_input_sequence: p.last_input_sequence,
    user_alignment_message: p.user_alignment_message,
    activation_regex: p.activation_regex,
    wrap: p.wrap,
    macro: p.macro,
    names_behavior: p.names_behavior,
    sequences_as_stop_strings: p.sequences_as_stop_strings,
    bind_to_context: p.bind_to_context,
    skip_examples: p.skip_examples,
    system_same_as_user: p.system_same_as_user,
    story_string_prefix: p.story_string_prefix,
    story_string_suffix: p.story_string_suffix,
  };
}

export function parseContext(raw: AnyObj, id?: string, name?: string): ContextPreset {
  const n = name ?? String(raw.name ?? 'Context');
  return {
    id: id ?? slug(n),
    name: n,
    story_string: str(
      raw.story_string,
      '{{#if system}}{{system}}\n{{/if}}{{#if description}}{{description}}\n{{/if}}{{#if personality}}{{personality}}\n{{/if}}{{#if scenario}}{{scenario}}\n{{/if}}{{#if persona}}{{persona}}\n{{/if}}{{trim}}',
    ),
    example_separator: str(raw.example_separator, '***'),
    chat_start: str(raw.chat_start, '***'),
    use_stop_strings: !!raw.use_stop_strings,
    names_as_stop_strings: raw.names_as_stop_strings !== false,
    story_string_position: num(raw.story_string_position, 0),
    story_string_depth: num(raw.story_string_depth, 1),
    story_string_role: num(raw.story_string_role, 0),
    always_force_name2: raw.always_force_name2 !== false,
    raw,
  };
}

export function exportContext(p: ContextPreset): AnyObj {
  return {
    ...(p.raw ?? {}),
    name: p.name,
    story_string: p.story_string,
    example_separator: p.example_separator,
    chat_start: p.chat_start,
    use_stop_strings: p.use_stop_strings,
    names_as_stop_strings: p.names_as_stop_strings,
    story_string_position: p.story_string_position,
    story_string_depth: p.story_string_depth,
    story_string_role: p.story_string_role,
    always_force_name2: p.always_force_name2,
  };
}

export function parseSysprompt(raw: AnyObj, id?: string, name?: string): SyspromptPreset {
  const n = name ?? String(raw.name ?? 'System Prompt');
  return {
    id: id ?? slug(n),
    name: n,
    content: str(raw.content),
    post_history: str(raw.post_history),
    raw,
  };
}

export function exportSysprompt(p: SyspromptPreset): AnyObj {
  return { ...(p.raw ?? {}), name: p.name, content: p.content, post_history: p.post_history };
}

export function parseReasoning(raw: AnyObj, id?: string, name?: string): ReasoningPreset {
  const n = name ?? String(raw.name ?? 'Reasoning');
  return {
    id: id ?? slug(n),
    name: n,
    prefix: str(raw.prefix),
    suffix: str(raw.suffix),
    separator: str(raw.separator, '\n\n'),
    raw,
  };
}

export function exportReasoning(p: ReasoningPreset): AnyObj {
  return { ...(p.raw ?? {}), name: p.name, prefix: p.prefix, suffix: p.suffix, separator: p.separator };
}

export function defaultInstruct(): InstructPreset {
  return parseInstruct(
    { name: 'Blank', input_sequence: '', output_sequence: '', system_sequence: '', stop_sequence: '', wrap: false },
    'blank',
    'Blank',
  );
}

export function defaultContext(): ContextPreset {
  return parseContext({ name: 'Default' }, 'Default', 'Default');
}

export function defaultSysprompt(): SyspromptPreset {
  return parseSysprompt({ name: 'Blank', content: '', post_history: '' }, 'Blank', 'Blank');
}

export function defaultReasoning(): ReasoningPreset {
  return parseReasoning({ name: 'Blank', prefix: '', suffix: '', separator: '' }, 'Blank', 'Blank');
}

function str(v: unknown, d = ''): string {
  return typeof v === 'string' ? v : d;
}
function num(v: unknown, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
