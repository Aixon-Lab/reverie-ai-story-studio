/**
 * Volition: what the character is trying to do, and what it takes to change it.
 *
 * The load-bearing properties are the boring-sounding ones — that an objective
 * expires, that it does not flicker, and that steering biases rather than
 * dictates. Those three are what separate an inner life from a script.
 */
import { describe, expect, it } from 'vitest';
import { TIME_UNIT_MS, emptyBrain, neutralAffect, neutralTraits } from './defaults';
import { emptyPsyche } from '../psyche/defaults';
import { neutralAppraisal } from './emotion';
import {
  INTENTION_TTL, MAX_GOALS, activeSteer, describeIntention, describeVolition,
  formIntention, reviewGoals, scoreIntention, setSteer, spendIntention, spendSteer,
  ttlFromIntensity,
} from './volition';
import type { AppraisedEvent, BrainState, Goal, MemoryNode, RelationModel } from './types';

const T0 = 1_700_000_000_000;
const DAY = TIME_UNIT_MS;

let seq = 0;
const makeId = () => `id-${++seq}`;

function brain(mutate: (b: BrainState) => void = () => {}): BrainState {
  seq = 0;
  const b = emptyBrain('chat', 'char', 'Mara', T0 - 30 * DAY);
  b.psyche = emptyPsyche(neutralTraits(), T0 - 30 * DAY);
  mutate(b);
  return b;
}

function person(over: Partial<RelationModel> = {}): RelationModel {
  return {
    key: 'rell',
    displayName: 'Rell',
    trust: 0, affection: 0, fear: 0, respect: 0, resentment: 0,
    debt: 0, familiarity: 0.8, model: '', interactions: 20,
    firstMetAt: T0 - 100 * DAY, lastSeenAt: T0,
    ...over,
  };
}

function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: 'g1',
    text: 'find out who opened the gate',
    priority: 0.8,
    status: 'active',
    createdAt: T0 - 10 * DAY,
    updatedAt: T0 - DAY,
    ...over,
  };
}

function event(over: Partial<AppraisedEvent> = {}): AppraisedEvent {
  return {
    gist: 'something happened',
    actors: ['Rell'],
    tags: [],
    appraisal: { ...neutralAppraisal(), goalRelevance: 0.8, goalConduciveness: 0 },
    salience: 0.5,
    ...over,
  };
}

const ctx = { present: ['Rell'], now: T0, makeId };

describe('choosing an objective', () => {
  it('always produces one — nobody wants nothing', () => {
    const i = formIntention(brain(), { present: [], now: T0, makeId });
    expect(i.kind).toBe('enjoy');
    expect(i.text).toBeTruthy();
  });

  it('pursues the strongest standing goal when nothing else is pressing', () => {
    const b = brain((x) => { x.workingSelf.goals = [goal()]; });
    const i = formIntention(b, { present: [], now: T0, makeId });
    expect(i.kind).toBe('pursue');
    expect(i.goalId).toBe('g1');
  });

  it('reaches to repair with somebody they still care about', () => {
    const b = brain((x) => {
      x.people.rell = person({ affection: 0.8, resentment: 0.6, trust: -0.4 });
    });
    const i = formIntention(b, ctx);
    expect(i.kind).toBe('repair');
    expect(i.target).toBe('Rell');
  });

  it('confronts rather than repairs when the affection has gone', () => {
    const b = brain((x) => {
      x.people.rell = person({ affection: -0.2, resentment: 0.9 });
      x.traits.courage = 0.9;
    });
    expect(formIntention(b, ctx).kind).toBe('confront');
  });

  it('does not confront somebody they are frightened of', () => {
    const brave = brain((x) => {
      x.people.rell = person({ affection: -0.2, resentment: 0.9, fear: 0 });
      x.traits.courage = 0.9;
    });
    const cowed = brain((x) => {
      x.people.rell = person({ affection: -0.2, resentment: 0.9, fear: 0.95 });
      x.traits.courage = 0.9;
    });
    expect(formIntention(brave, ctx).kind).toBe('confront');
    expect(formIntention(cowed, ctx).kind).not.toBe('confront');
  });

  it('tries to work out a stranger', () => {
    const b = brain((x) => {
      x.people.rell = person({ familiarity: 0.1, trust: 0.05 });
    });
    expect(formIntention(b, ctx).kind).toBe('test');
  });

  it('withdraws when there is nothing left to spend', () => {
    const b = brain((x) => {
      x.psyche!.load.level = 0.95;
      x.psyche!.body.energy = 0.05;
      x.psyche!.condition.ptsd.avoidance = 0.8;
      x.workingSelf.goals = [goal()];
    });
    expect(formIntention(b, { present: [], now: T0, makeId }).kind).toBe('withdraw');
  });

  it('only tries to get through it when it is not safe to want anything else', () => {
    const b = brain((x) => {
      x.psyche!.body.safety = 0;
      x.psyche!.body.pain = 0.9;
      x.psyche!.load.level = 0.9;
    });
    expect(formIntention(b, { present: [], now: T0, makeId }).kind).toBe('endure');
  });

  it('records why, for anyone reading the Mind page', () => {
    const b = brain((x) => { x.workingSelf.goals = [goal()]; });
    expect(formIntention(b, { present: [], now: T0, makeId }).rationale).toBeTruthy();
  });
});

describe('holding an objective', () => {
  it('does not change its mind for a marginally better option', () => {
    const b = brain((x) => { x.workingSelf.goals = [goal()]; });
    b.intention = formIntention(b, { present: [], now: T0, makeId });
    const first = b.intention.id;
    // Same situation, re-evaluated: it must be the same objective, not a clone.
    expect(formIntention(b, { present: [], now: T0, makeId }).id).toBe(first);
  });

  it('does change its mind when something clearly beats it', () => {
    const b = brain((x) => { x.workingSelf.goals = [goal({ priority: 0.1 })]; });
    b.intention = formIntention(b, { present: [], now: T0, makeId });
    expect(b.intention.kind).toBe('pursue');

    // The room changes: somebody they resent walks in.
    b.people.rell = person({ affection: -0.2, resentment: 0.95 });
    b.traits.courage = 1;
    expect(formIntention(b, ctx).kind).toBe('confront');
  });

  it('burns urgent objectives faster than idle ones', () => {
    const urgent = brain((x) => {
      x.people.rell = person({ affection: 0.9, resentment: 0.9, trust: -0.9 });
    });
    const idle = brain();
    const a = formIntention(urgent, ctx);
    const b = formIntention(idle, { present: [], now: T0, makeId });
    expect(a.urgency).toBeGreaterThan(b.urgency);
    expect(a.ttl).toBeLessThan(b.ttl);
  });
});

describe('expiry', () => {
  it('spends a turn on every generation', () => {
    const b = brain();
    b.intention = formIntention(b, ctx);
    const before = b.intention.ttl;
    spendIntention(b);
    expect(b.intention!.ttl).toBe(before - 1);
  });

  it('lapses when the turns run out, and reports it exactly once', () => {
    const b = brain();
    b.intention = formIntention(b, ctx);
    const resolutions: unknown[] = [];
    for (let i = 0; i <= INTENTION_TTL * 2; i++) {
      const r = spendIntention(b).resolved;
      if (r) resolutions.push(r);
    }
    expect(b.intention!.status).toBe('expired');
    // Once, not on every subsequent call — the caller acts on this.
    expect(resolutions).toEqual(['expired']);
  });

  it('lets a new objective form once the old one has lapsed', () => {
    const b = brain();
    b.intention = formIntention(b, ctx);
    const first = b.intention.id;
    for (let i = 0; i <= INTENTION_TTL * 2; i++) spendIntention(b);
    expect(formIntention(b, ctx).id).not.toBe(first);
  });

  it('never composes an objective that has lapsed', () => {
    const b = brain();
    b.intention = formIntention(b, ctx);
    b.intention.status = 'expired';
    expect(describeIntention(b.intention, 'Mara')).toBe('');
  });
});

describe('progress', () => {
  it('is read off appraisal, not asserted', () => {
    const b = brain((x) => { x.workingSelf.goals = [goal()]; });
    b.intention = formIntention(b, { present: [], now: T0, makeId });
    scoreIntention(b, [event({ actors: [], appraisal: { ...neutralAppraisal(), goalRelevance: 0.9, goalConduciveness: 0.8 } })]);
    expect(b.intention!.progress).toBeGreaterThan(0);
  });

  it('settles when the objective is met', () => {
    const b = brain((x) => { x.workingSelf.goals = [goal()]; });
    b.intention = formIntention(b, { present: [], now: T0, makeId });
    const helping = event({ actors: [], appraisal: { ...neutralAppraisal(), goalRelevance: 0.9, goalConduciveness: 1 } });
    const resolutions: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      const r = scoreIntention(b, [helping]).resolved;
      if (r) resolutions.push(r);
    }
    expect(resolutions).toEqual(['satisfied']);
    expect(b.intention!.status).toBe('satisfied');
  });

  it('blocks the underlying goal when the objective is thwarted', () => {
    const b = brain((x) => { x.workingSelf.goals = [goal()]; });
    b.intention = formIntention(b, { present: [], now: T0, makeId });
    const blocking = event({ actors: [], appraisal: { ...neutralAppraisal(), goalRelevance: 0.9, goalConduciveness: -1 } });
    for (let i = 0; i < 6; i++) scoreIntention(b, [blocking]);
    expect(b.intention!.status).toBe('thwarted');
    expect(b.workingSelf.goals[0].status).toBe('blocked');
  });

  it('ignores events that have nothing to do with what they want', () => {
    const b = brain((x) => {
      x.people.rell = person({ affection: 0.8, resentment: 0.7, trust: -0.5 });
    });
    b.intention = formIntention(b, ctx);
    scoreIntention(b, [event({ actors: ['Somebody Else'], appraisal: { ...neutralAppraisal(), goalRelevance: 0.9, goalConduciveness: 1 } })]);
    expect(b.intention!.progress).toBe(0);
  });
});

describe('steering', () => {
  it('tilts a close call the way the scene is leaning', () => {
    const setup = (b: BrainState) => {
      b.people.rell = person({ familiarity: 0.1, trust: 0.05, affection: 0, resentment: 0.5 });
      b.traits.courage = 0.6;
    };
    const unsteered = brain(setup);
    const steered = brain((x) => {
      setup(x);
      x.steer = { text: 'bring the argument to a head', prefer: 'confront', setAt: T0, ttl: 10 };
    });
    // Without the nudge, sizing Rell up beats having it out with him.
    expect(formIntention(unsteered, ctx).kind).toBe('test');
    expect(formIntention(steered, ctx).kind).toBe('confront');
  });

  it('can only tilt toward something the character was already capable of', () => {
    // No grievance means no confrontation to boost. Steering adds weight to a
    // candidate; it never invents one.
    const b = brain((x) => {
      x.people.rell = person({ familiarity: 0.1, trust: 0.05, resentment: 0 });
      x.steer = { text: 'bring the argument to a head', prefer: 'confront', setAt: T0, ttl: 10 };
    });
    expect(formIntention(b, ctx).kind).not.toBe('confront');
  });

  it('cannot force an objective the character has no capacity for', () => {
    // The guarantee that makes steering safe: it biases, it does not script.
    const b = brain((x) => {
      x.psyche!.body.safety = 0;
      x.psyche!.body.pain = 1;
      x.psyche!.load.level = 1;
      x.people.rell = person({ fear: 1, resentment: 0.3 });
      x.traits.courage = -1;
      x.steer = { text: 'have it out with Rell', prefer: 'confront', setAt: T0, ttl: 10 };
    });
    expect(formIntention(b, ctx).kind).not.toBe('confront');
  });

  it('expires by turn count', () => {
    const b = brain((x) => {
      x.steer = { text: 'push the scene', prefer: 'confront', setAt: T0, ttl: 2 };
    });
    expect(activeSteer(b, T0)).toBeTruthy();
    spendSteer(b);
    spendSteer(b);
    expect(activeSteer(b, T0)).toBeNull();
  });

  it('plants a directive from the director and replaces the previous one', () => {
    const b = brain();
    setSteer(b, { text: 'get him to say where he was', prefer: 'confront', now: T0, ttl: 8 });
    expect(activeSteer(b, T0)?.prefer).toBe('confront');
    setSteer(b, { text: 'let it go', prefer: 'withdraw', now: T0 + 1000 });
    expect(activeSteer(b, T0 + 1000)?.text).toBe('let it go');
    expect(b.steer?.prefer).toBe('withdraw');
  });

  it('maps a loud intensity onto a short life', () => {
    expect(ttlFromIntensity(5)).toBeLessThan(ttlFromIntensity(1));
    expect(ttlFromIntensity(3)).toBe(12);
  });

  it('expires by the clock even if nobody spent it', () => {
    // A directive nobody cleared must not quietly become a system prompt.
    const b = brain((x) => {
      x.steer = { text: 'push the scene', prefer: 'confront', setAt: T0, ttl: 99 };
    });
    expect(activeSteer(b, T0 + 2 * DAY)).toBeNull();
  });
});

describe('the goal curator', () => {
  function schema(over: Partial<MemoryNode> = {}): MemoryNode {
    return {
      id: 's1',
      kind: 'schema',
      gist: 'Rell cannot be relied on the way I once assumed — this keeps turning out to be true.',
      encodedAt: T0 - 20 * DAY,
      uses: [T0 - 20 * DAY],
      useCount: 5,
      permanentBoost: 1.2,
      affect: { ...neutralAffect(), valence: -0.7, arousal: 0.5 },
      appraisal: neutralAppraisal(),
      vividness: 0.2,
      confidence: 0.8,
      fidelity: 0.7,
      actors: ['Rell'],
      tags: [],
      contextBinding: 0.1,
      suppressed: 0,
      status: 'active',
      ...over,
    };
  }

  it('does nothing when nothing durable has changed', () => {
    const b = brain((x) => { x.workingSelf.goals = [goal()]; });
    const r = reviewGoals(b, T0, makeId);
    expect(r).toEqual({ added: [], retired: [], blocked: [], reprioritised: [] });
  });

  it('promotes a belief the character keeps running into', () => {
    const b = brain((x) => { x.nodes.s1 = schema(); });
    const r = reviewGoals(b, T0, makeId);
    expect(r.added).toHaveLength(1);
    expect(b.workingSelf.goals[0].text).toMatch(/Rell/);
  });

  it('will not promote a belief nobody has run into twice', () => {
    const b = brain((x) => { x.nodes.s1 = schema({ useCount: 1 }); });
    expect(reviewGoals(b, T0, makeId).added).toEqual([]);
  });

  it('will not promote a belief with no feeling behind it', () => {
    const b = brain((x) => {
      x.nodes.s1 = schema({ affect: { ...neutralAffect(), valence: 0.05 } });
    });
    expect(reviewGoals(b, T0, makeId).added).toEqual([]);
  });

  it('does not add the same goal twice', () => {
    const b = brain((x) => { x.nodes.s1 = schema(); });
    reviewGoals(b, T0, makeId);
    const after = b.workingSelf.goals.length;
    reviewGoals(b, T0 + DAY, makeId);
    expect(b.workingSelf.goals.length).toBe(after);
  });

  it('retires a low-priority goal that has gone quiet', () => {
    const b = brain((x) => {
      x.workingSelf.goals = [goal({ priority: 0.2, updatedAt: T0 - 60 * DAY })];
    });
    expect(reviewGoals(b, T0, makeId).retired).toContain('g1');
    expect(b.workingSelf.goals[0].status).toBe('abandoned');
  });

  it('leaves a quiet but important goal alone', () => {
    // A long-standing commitment is more characteristic than a loud recent one.
    const b = brain((x) => {
      x.workingSelf.goals = [goal({ priority: 0.9, updatedAt: T0 - 60 * DAY })];
    });
    expect(reviewGoals(b, T0, makeId).retired).toEqual([]);
  });

  it('keeps the list small, dropping the weakest rather than the oldest', () => {
    const b = brain((x) => {
      x.workingSelf.goals = Array.from({ length: MAX_GOALS + 3 }, (_, i) => goal({
        id: `g${i}`,
        text: `goal number ${i}`,
        priority: (i + 1) / (MAX_GOALS + 3),
        updatedAt: T0,
      }));
    });
    reviewGoals(b, T0, makeId);
    const active = b.workingSelf.goals.filter((g) => g.status === 'active');
    expect(active.length).toBe(MAX_GOALS);
    // g0 was the weakest and the oldest; g8+ were strong and new. Weakest goes.
    expect(active.map((g) => g.id)).not.toContain('g0');
    expect(active.map((g) => g.id)).toContain(`g${MAX_GOALS + 2}`);
  });
});

describe('composition', () => {
  it('is one sentence, naming what they are after', () => {
    const b = brain((x) => { x.workingSelf.goals = [goal()]; });
    b.intention = formIntention(b, { present: [], now: T0, makeId });
    const line = describeIntention(b.intention, 'Mara');
    expect(line).toContain('Mara');
    expect(line).toContain('who opened the gate');
    expect(line.split('\n')).toHaveLength(1);
  });

  it('tells the model not to announce a covert objective', () => {
    const b = brain((x) => {
      x.psyche!.traumas = [{
        nodeId: 'n1', contextBinding: 0.2, nowness: 0.6, elaboration: 0.2,
        appraisals: { selfBlame: 0.5, worldDanger: 0.4, permanentChange: 0.5, shame: 0.9 },
        avoidanceCount: 3, approachCount: 0, pathway: 'moral',
        encodedAt: T0 - 40 * DAY, intrusionCount: 2,
      }];
      x.people.rell = person();
    });
    b.intention = formIntention(b, ctx);
    expect(b.intention.kind).toBe('conceal');
    expect(describeIntention(b.intention, 'Mara')).toMatch(/without announcing it/);
  });

  it('describes itself for the Mind page', () => {
    const b = brain((x) => { x.workingSelf.goals = [goal()]; });
    b.intention = formIntention(b, { present: [], now: T0, makeId });
    expect(describeVolition(b)).toMatch(/pursue/);
    expect(describeVolition(b)).toMatch(/turns left/);
  });

  it('says so plainly when there is no objective at all', () => {
    expect(describeVolition(brain())).toBe('No particular objective.');
  });
});
