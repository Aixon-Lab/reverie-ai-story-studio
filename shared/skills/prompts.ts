/**
 * The three prompts the skill system needs: arm, scout, author.
 */
import { SKILL_TAG_OPEN } from './parse';
import type { Skill } from './types';
import { buildSkillRoster } from './compose';

/**
 * The inline selector — the reason this system costs nothing per turn.
 *
 * Appended as the last system message of a normal generation. The model writes
 * its reply as usual and then, on one final line, names the skills the *next*
 * turn will need. That is why a skill takes effect from the turn after the one
 * that called for it: the decision is a by-product of a reply, not a request of
 * its own.
 *
 * Note what the model is asked to judge: not "is this skill nice", but whether
 * this character, in this world, would actually have and use it. A brawl in a
 * college dorm and a duel between wuxia masters are both fights; only one wants
 * the martial-arts document.
 */
export function skillSelectorTail(input: {
  roster: Skill[];
  activeNames: string[];
  characterName: string;
}): string {
  if (!input.roster.length) return '';
  const active = input.activeNames.length ? input.activeNames.join(', ') : 'none';
  return [
    'SKILL ROUTING (out-of-character bookkeeping — invisible to the story):',
    'After your reply is complete, append ONE final line, exactly in this form:',
    `${SKILL_TAG_OPEN} name, name]]   or   ${SKILL_TAG_OPEN} none]]`,
    '',
    'That line names the craft documents the NEXT turn should load, chosen from:',
    buildSkillRoster(input.roster),
    '',
    `Currently loaded: ${active}.`,
    'Rules for choosing:',
    `- Ask whether ${input.characterName} plausibly HAS this skill in this world and this era, not merely whether the topic came up. A frightened student swinging a chair is a fight; it is not martial arts.`,
    '- Pick a skill when the coming turn is likely to depend on doing that thing well.',
    '- Keep listing a loaded skill while it still matters; omit it once the scene has moved on.',
    '- List nothing rather than something marginal. Two at once is already a lot.',
    '',
    'The line is stripped before anyone sees your message. Never refer to it, never explain it,',
    'never let it change your prose, and never write it anywhere but the very last line.',
  ].join('\n');
}

/**
 * The scout — used only when the inline tag did not come back.
 *
 * Runs after the reply has already been delivered, on the cheap connection, so
 * the user never waits for it. Deliberately answer-only: this is a classifier,
 * and every extra word it writes is a word that has to be parsed away.
 */
export function skillScoutPrompt(input: {
  roster: Skill[];
  activeNames: string[];
  excerpt: string;
  characterName: string;
  personaName: string;
}): { system: string; user: string } {
  return {
    system: [
      'You route craft documents for a roleplay engine. You never write story.',
      'Given a scene excerpt and a list of available skills, name the skills the next turn will need.',
      'Judge plausibility, not topic: the character must credibly possess the skill in this world and era.',
      'Answer with a bare comma-separated list of skill names, or the single word none. No other text.',
    ].join(' '),
    user: [
      `Characters: ${input.characterName} (AI), ${input.personaName} (player).`,
      `Currently loaded: ${input.activeNames.join(', ') || 'none'}.`,
      '',
      'Available skills:',
      buildSkillRoster(input.roster),
      '',
      'Recent scene:',
      '"""',
      input.excerpt,
      '"""',
      '',
      'Skills needed for the next turn (comma-separated names, or none):',
    ].join('\n'),
  };
}

/**
 * The author — turns "kung fu" into a usable document.
 *
 * The hard requirement is breadth. A skill written for one setting is worse
 * than useless: it drags every scene toward the world it was written in. So the
 * prompt insists on principles, ranges and adaptation rules rather than a fixed
 * cast, era, or move list — the document has to serve a Ming-dynasty duel, a
 * bar fight and a zero-gravity boarding action without being rewritten.
 */
export function skillAuthorPrompt(input: {
  idea: string;
  depth: 'brief' | 'standard' | 'deep';
  existingNames?: string[];
}): { system: string; user: string } {
  const words = input.depth === 'brief' ? '500–800' : input.depth === 'deep' ? '1800–2600' : '1000–1500';
  return {
    system: [
      'You write craft reference documents for a roleplay writing engine.',
      'Your documents teach a model how to WRITE a thing well in prose — not how the thing works in real life,',
      'and not how one particular story goes.',
      'You are precise, concrete and unsentimental. You never write fiction here.',
    ].join(' '),
    user: [
      `Write a skill document for: ${input.idea}`,
      '',
      `Target length: ${words} words.`,
      '',
      'FORMAT — output exactly this, nothing before or after:',
      '---',
      'name: <2–4 words, the skill as a person would name it>',
      'description: <ONE sentence, under 25 words, saying when this skill becomes relevant. This single line is all a router sees when deciding whether to load the document.>',
      'keywords: <8–14 lowercase comma-separated words likely to appear in a scene that needs this>',
      'tags: <2–4 lowercase category words>',
      '---',
      '',
      '## Core principles',
      '## Vocabulary and sensory palette',
      '## Range of competence',
      '## How it reads on the page',
      '## Escalation and stakes',
      '## Failure, limits and cost',
      '## Adapting to setting and character',
      '## Never do this',
      '',
      'HARD REQUIREMENTS:',
      '- Setting-agnostic. Never assume a period, technology level, culture, genre or cast.',
      '  Where setting matters, give the writer branches ("if firearms exist…", "in a low-tech era…").',
      '- Cover the whole competence range, from someone who has never done this to a master.',
      '  A skill that only describes experts makes every character an expert.',
      '- Concrete over abstract: name the movements, the sensations, the tells, the mistakes.',
      '  "Describe the fight vividly" is worthless; "weight lands before the strike does" is usable.',
      '- Teach restraint. Say when NOT to reach for this, and how to keep it from swallowing a scene.',
      '- No character names, no scenario, no example roleplay dialogue, no meta commentary about AI.',
      input.existingNames?.length
        ? `- Do not duplicate an existing skill: ${input.existingNames.join(', ')}.`
        : '',
    ].filter(Boolean).join('\n'),
  };
}
