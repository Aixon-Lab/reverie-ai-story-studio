/**
 * Psyche → prompt (§P.8).
 *
 * The state block sits above the memories and answers a different question. The
 * memory block says *what they know*; this says *who is in the room right now* —
 * what they are carrying, what they cannot look at, and what the effort of
 * holding it together is costing.
 *
 * Two rules learned from the memory composer:
 *
 * 1. **Silence when nothing is off baseline.** A block that fires every turn is
 *    noise the model learns to skip. A calm, rested character gets three lines.
 * 2. **Behaviour, never diagnosis.** "They will change the subject rather than go
 *    near it" — never "avoidance: 0.62". The numbers are for the engine.
 *
 * `AVOID` and `CANNOT` are the highest-value lines here: a character becomes a
 * person at the moment there are things they will not say.
 */
import { describeBody, describeLoad } from './body';
import { describeFeeling, familyOf } from './dynamics';
import { describeCondition } from './condition';
import { describeCopingStyle } from './regulation';
import { renderIntrusion, traumaStatus } from './trauma';
import type { ExpressedAffect, PsycheParams, PsycheState, RegulationChoice } from './types';

export interface PsycheBlockInput {
  psyche: PsycheState;
  name: string;
  affect: ExpressedAffect;
  regulation: RegulationChoice;
  pull: string;
  intrusions: { nodeId: string; text: string; probability: number }[];
  /** Active belief gists biasing this moment. */
  beliefs?: string[];
  /** What they expect the people present to do. */
  expectations?: string[];
  /** How they currently take themselves to be (§P.6.2). */
  selfConcept?: string;
  /** How they tell the story of their life so far. */
  lifeStory?: string;
  /** What the people present do NOT know (§N.2.1). */
  tomLines?: string[];
  /** How accommodating they are willing to be (§N.2.3). */
  stance?: string;
  params: PsycheParams;
}

export function composePsycheBlock(input: PsycheBlockInput): string {
  const { psyche, name, affect } = input;
  const g = psyche.dynamics.granularity;
  const lines: string[] = [];

  lines.push(`### ${name} right now`);

  // --- what they feel, at the resolution they can perceive it -------------
  const felt = describeFeeling(affect.felt, g);
  if (affect.opacity > 0.4) {
    // The gap is the characterisation. Spell out both halves explicitly, because
    // a model given only "she feels shame" will write her showing it.
    lines.push(
      `FEELING: ${felt} — but they are ${input.regulation.description}. `
      + `What reaches the surface is ${affect.shown.label === 'neutral' ? 'almost nothing' : affect.shown.label}`
      + (affect.leak ? `, apart from ${affect.leak}` : '')
      + '. Write the surface, and let the rest show only in what they do not say.',
    );
  } else {
    lines.push(`FEELING: ${felt}. It is visible.`);
  }

  lines.push(`PULL: what they want to do this second is ${input.pull}.`);

  // --- the body, only when it matters -------------------------------------
  const body = describeBody(psyche.body);
  if (body) lines.push(`BODY: ${body}. This is not set dressing — it is why they have less to give than usual.`);

  const load = describeLoad(psyche.load, input.params);
  if (load) lines.push(`CARRYING: ${load}.`);

  // --- what is surfacing uninvited ----------------------------------------
  if (input.intrusions.length) {
    const trauma = psyche.traumas.find((t) => t.nodeId === input.intrusions[0].nodeId);
    if (trauma) {
      lines.push(
        `INTRUSION: ${renderIntrusion(trauma, input.intrusions[0].text, g)} `
        + 'Do not narrate this as a memory. It arrives as a flinch, a lost half-second, '
        + 'a reaction they cannot account for.',
      );
    }
  }

  // --- the condition, in behaviour -----------------------------------------
  const condition = describeCondition(psyche.condition);
  if (condition.length) {
    lines.push(`STATE: ${condition.slice(0, 4).join('; ')}.`);
  }

  // --- what they steer around ----------------------------------------------
  const avoided = avoidTopics(psyche);
  if (avoided.length) {
    lines.push(
      `AVOID: they will steer away from ${avoided.join('; ')}. `
      + 'If pushed toward it they deflect, go flat, or get sharp — they do not simply answer.',
    );
  }

  // --- what they cannot do right now ----------------------------------------
  const cannot = cannotDo(psyche);
  if (cannot.length) lines.push(`CANNOT: ${cannot.join('; ')}.`);

  // --- who they take themselves to be ---------------------------------------
  // Placed above beliefs about the world because self-concept is what a scene can
  // actually threaten, and an unabsorbed contradiction is the best pressure point
  // a writer has.
  if (input.selfConcept) lines.push(`SELF: ${input.selfConcept}.`);
  if (input.lifeStory) lines.push(`STORY: ${input.lifeStory}.`);

  // --- beliefs and expectations ---------------------------------------------
  if (input.beliefs?.length) {
    lines.push(`BELIEF: they are acting on — ${input.beliefs.slice(0, 3).join('; ')}.`);
  }
  if (input.expectations?.length) {
    lines.push(`EXPECT: ${input.expectations.slice(0, 3).join('; ')}.`);
  }

  /**
   * What the others do not know. Placed late and kept to two lines: it is a
   * constraint on the reply rather than colour, and it matters most when it is
   * the last thing read before writing.
   */
  if (input.tomLines?.length) {
    lines.push(`THEY DO NOT KNOW: ${input.tomLines.slice(0, 2).join(' ')}`);
  }

  /**
   * Stance is last on purpose. It is the instruction most at risk of being
   * overridden by the model's pull toward agreeableness, and recency is the
   * cheapest defence available.
   */
  if (input.stance) lines.push(`STANCE: ${input.stance}`);

  // --- how they habitually cope ---------------------------------------------
  if (psyche.copingHistory.length >= 6) {
    lines.push(`HABIT: under pressure they default to ${describeCopingStyle(psyche)}.`);
  }

  return lines.join('\n');
}

/**
 * Subjects this character steers around — derived from unprocessed traumas and
 * from who hurt them, never from a list someone wrote.
 */
function avoidTopics(psyche: PsycheState): string[] {
  const out: string[] = [];
  for (const t of psyche.traumas) {
    if (t.avoidanceCount <= t.approachCount || t.nowness < 0.4) continue;
    const who = t.perpetrator ? ` and anything touching ${t.perpetrator}` : '';
    const what = t.pathway === 'betrayal'
      ? 'being asked whether they trusted the wrong person'
      : t.pathway === 'moral'
        ? 'what they did, or failed to do'
        : 'what happened to them';
    out.push(`${what}${who}`);
    if (out.length >= 2) break;
  }
  return out;
}

/**
 * Hard limits on the character this scene.
 *
 * These are the lines that stop a traumatised character being written as
 * conveniently articulate about their trauma — the failure mode that makes most
 * fictional psychology ring false.
 */
function cannotDo(psyche: PsycheState): string[] {
  const out: string[] = [];
  const c = psyche.condition;
  const g = psyche.dynamics.granularity;

  if (g < 0.35) out.push('they cannot name what they are feeling — do not let them explain it neatly');
  if (c.dissociation.acute > 0.5) out.push('they are not fully present; responses arrive late and from a distance');
  if (psyche.load.level > 0.85) out.push('they have no patience left for anything that is not immediate');
  if (c.depression.anhedonia > 0.6) out.push('they cannot be cheered up, and attempts to do it will land badly');
  if (psyche.attachment.avoidance > 0.7) out.push('they cannot ask for help in plain words, even wanting to');
  if (c.ptsd.intrusion > 0.6) out.push('they cannot give a clean, ordered account of the event — it comes out in fragments or not at all');
  return out;
}

/** Compact status for the Mind page — one line per trauma. */
export function traumaLines(psyche: PsycheState, nodeGist: (id: string) => string): string[] {
  return psyche.traumas.map((t) =>
    `${nodeGist(t.nodeId).slice(0, 60)} — ${traumaStatus(t)} `
    + `(${t.intrusionCount} intrusions, ${t.approachCount} faced, ${t.avoidanceCount} pushed away)`);
}

/** Rough token cost of the block, so the budget planner can account for it. */
export function psycheBlockTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export { familyOf };
