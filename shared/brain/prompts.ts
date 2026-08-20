/**
 * LLM prompts for the brain's two structured calls.
 *
 * 1. `brainDispositionPrompt` — once, at brain birth: card → trait anchor,
 *    self-images, standing concerns, opening goals.
 * 2. `brainEncoderPrompt` — every consolidation pass: transcript → appraised
 *    events, in *this character's* frame of reference.
 *
 * The encoder is asked for appraisal checks, not emotions. That is deliberate:
 * appraisal is the person-independent part of the situation, and the local
 * engine turns it into this character's emotion via their traits (§5.4). Asking
 * the model "how did they feel" instead would collapse every character into the
 * model's own generic affect.
 */
import type { BrainState, MemoryNode } from './types';

export interface EncoderCharacterContext {
  name: string;
  description: string;
  personality: string;
  scenario?: string;
}

/** Card → dispositional anchor. Run once per character. */
export function brainDispositionPrompt(card: EncoderCharacterContext): { system: string; user: string } {
  const system = [
    'You convert a roleplay character card into a psychological baseline for a memory simulation.',
    'Rate eight trait axes from -1 to 1. Judge from the card only; do not invent a backstory.',
    '',
    'AXES (what -1 and +1 mean):',
    'warmth: -1 cold/callous … +1 warm/caring',
    'dominance: -1 submissive/deferential … +1 commanding/controlling',
    'volatility: -1 unflappably calm … +1 explosive/reactive/anxious',
    'trust: -1 paranoid/guarded … +1 open/credulous',
    'courage: -1 timid/fearful … +1 fearless/reckless',
    'openness: -1 rigid/conventional … +1 curious/inventive',
    'conscientiousness: -1 chaotic/careless … +1 disciplined/principled',
    'selfWorth: -1 self-loathing … +1 self-assured/proud',
    '',
    'Also extract:',
    'selfImages: 2-4 short "I am someone who…" statements, phrased in third person about the character.',
    'concerns: 2-5 standing preoccupations that would always be on their mind.',
    'goals: 1-4 concrete active goals with priority 0-1.',
    '',
    'Respond with ONLY minified JSON:',
    '{"traits":{"warmth":0,"dominance":0,"volatility":0,"trust":0,"courage":0,"openness":0,"conscientiousness":0,"selfWorth":0},',
    '"selfImages":["..."],"concerns":["..."],"goals":[{"text":"...","priority":0.7}]}',
  ].join('\n');

  const user = [
    `NAME: ${card.name}`,
    card.description ? `DESCRIPTION:\n${card.description.slice(0, 2500)}` : '',
    card.personality ? `PERSONALITY:\n${card.personality.slice(0, 1500)}` : '',
    card.scenario ? `SCENARIO:\n${card.scenario.slice(0, 800)}` : '',
    'Produce the baseline JSON now.',
  ].filter(Boolean).join('\n\n');

  return { system, user };
}

export interface EncoderInput {
  character: EncoderCharacterContext;
  brain: BrainState;
  /** Rendered transcript slice since the last consolidation. */
  transcript: string;
  /** Existing memories the new events might contradict or extend. */
  candidates: MemoryNode[];
  /** Names present in the scene (the character's own name included). */
  cast: string[];
  isGroup: boolean;
}

/** Transcript → appraised events, from inside this character's head. */
export function brainEncoderPrompt(input: EncoderInput): { system: string; user: string } {
  const { character, brain } = input;

  const system = [
    `You are the memory-encoding stage of ${character.name}'s mind.`,
    `You read what just happened and decide what ${character.name} would actually retain — from THEIR vantage point only.`,
    '',
    'HARD RULES',
    `1. Only encode what ${character.name} personally witnessed, was told, or inferred. If they were absent or asleep, it does not exist for them.`,
    '2. Be selective, not silent. Small talk, pleasantries and filler are NOT events — but anything that changed the situation, the relationship, or how they feel IS. Expect roughly one event per 3-5 substantive exchanges. Returning nothing for a long, eventful stretch is wrong.',
    '3. Segment at real boundaries: a change of place, of who is present, of goal, or a consequential act. One event per boundary, not one per message.',
    '4. Write the gist as what it MEANS, in one or two plain sentences, third person about the character. Not a transcript.',
    '5. verbatim: include only a genuinely striking exact line (a promise, a threat, a confession, a name). Otherwise omit it.',
    '6. detail: the sensory particulars — what it looked, sounded, smelled like. Required when arousal is extreme.',
    '',
    'APPRAISAL — rate the SITUATION, not the feeling.',
    `Do NOT tell us what ${character.name} felt. Rate the checks below and the simulation derives the emotion from their temperament.`,
    'novelty 0-1: how unexpected, given what came before.',
    'pleasantness -1..1: intrinsically nice or nasty, independent of goals.',
    'goalRelevance 0-1: does this touch something they care about at all.',
    'goalConduciveness -1..1: does it advance (+) or block (-) what they want.',
    'agency: "self" | "other" | "circumstance" — who brought it about.',
    'intent -1..1: if agency is "other", how malicious (-) or benevolent (+) the act appears.',
    'copingPotential 0-1: how much power/control they objectively had over the outcome.',
    'norms -1..1: does it violate (-) or uphold (+) a standard of conduct.',
    'urgency 0-1: does it demand a response right now.',
    '',
    'salience 0-1: how memorable this would be a month from now. Use the whole scale:',
    '  0.0-0.15 forgettable filler (do not return these at all)',
    '  0.3      an ordinary but real beat worth keeping',
    '  0.5-0.7  significant — a promise, a betrayal, a first time, a decision',
    '  0.85+    life-marking',
    'identityRelevant: true only for genuinely self-defining moments (a handful per lifetime).',
    '',
    'UPDATING EXISTING MEMORIES',
    'If an event contradicts or extends a listed existing memory, reference it in "updates" with kind "contradicts" or "extends" and, for extends, a merged newGist.',
    'Use "links" to connect an event to existing memories: caused, led_to, reminds_of, resolved, broke_promise, kept_promise, about_person, at_place.',
    'If two names in this stretch are the same person (Wren / Miss Vale), put them in "aliases": [{"canonical":"Wren","also":["Miss Vale"]}].',
    '',
    'Respond with ONLY minified JSON:',
    '{"events":[{"gist":"...","verbatim":"...","detail":"...","actors":["Name"],"place":"...","tags":["..."],',
    '"appraisal":{"novelty":0,"pleasantness":0,"goalRelevance":0,"goalConduciveness":0,"agency":"other","intent":0,"copingPotential":0.5,"norms":0,"urgency":0},',
    '"salience":0.3,"identityRelevant":false,"aliases":[{"canonical":"Name","also":["Other Name"]}],',
    '"updates":[{"nodeId":"...","kind":"extends","newGist":"..."}],"links":[{"nodeId":"...","kind":"caused"}]}],',
    '"goalUpdates":[{"text":"...","status":"active|achieved|abandoned|blocked","priority":0.5}],',
    '"chapterTitle":"short name for this stretch of the story, or empty"}',
  ].join('\n');

  const traitLine = Object.entries(brain.traits)
    .map(([k, v]) => `${k} ${v.toFixed(2)}`)
    .join(', ');
  const goals = brain.workingSelf.goals.filter((g) => g.status === 'active');

  const candidateBlock = input.candidates.length
    ? input.candidates
        .slice(0, 24)
        .map((n) => `${n.id} [${n.kind}] ${n.gist.slice(0, 160)}`)
        .join('\n')
    : '(none yet)';

  const user = [
    `CHARACTER: ${character.name}`,
    character.description ? `CARD:\n${character.description.slice(0, 1200)}` : '',
    character.personality ? `PERSONALITY: ${character.personality.slice(0, 600)}` : '',
    `CURRENT TEMPERAMENT (-1..1): ${traitLine}`,
    `CURRENT MOOD: ${brain.mood.label} (valence ${brain.mood.valence.toFixed(2)}, arousal ${brain.mood.arousal.toFixed(2)})`,
    goals.length ? `ACTIVE GOALS:\n${goals.map((g) => `- ${g.text}`).join('\n')}` : 'ACTIVE GOALS: (none recorded)',
    brain.workingSelf.concerns.length ? `STANDING CONCERNS: ${brain.workingSelf.concerns.join('; ')}` : '',
    `PRESENT IN SCENE: ${input.cast.join(', ')}${input.isGroup ? ' (group scene — encode only what they witnessed)' : ''}`,
    `EXISTING MEMORIES THAT MIGHT BE AFFECTED (id [kind] gist):\n${candidateBlock}`,
    `NEW TRANSCRIPT SINCE LAST CONSOLIDATION:\n${input.transcript.slice(0, 12000)}`,
    `What does ${character.name} retain from this? Return the JSON now.`,
  ].filter(Boolean).join('\n\n');

  return { system, user };
}

/**
 * Optional refinement pass: rewrite an auto-derived semantic/schema gist into
 * natural language. Cheap, and only worth running when new abstractions formed.
 */
export function abstractionPolishPrompt(
  characterName: string,
  drafts: { id: string; kind: string; gist: string; supporting: string[] }[],
): { system: string; user: string } {
  return {
    system: [
      `You polish auto-generated generalisations in ${characterName}'s memory into natural first-person-adjacent statements (written in third person about them).`,
      'A "semantic" item is a fact they now simply know. A "schema" item is a belief they have formed and act on without stating.',
      'Keep each under 20 words. Do not add facts that are not supported. Do not moralise.',
      'Respond with ONLY minified JSON: {"items":[{"id":"...","gist":"..."}]}',
    ].join('\n'),
    user: drafts
      .map((d) => `${d.id} [${d.kind}] draft: ${d.gist}\n  from: ${d.supporting.slice(0, 4).join(' | ')}`)
      .join('\n\n'),
  };
}
