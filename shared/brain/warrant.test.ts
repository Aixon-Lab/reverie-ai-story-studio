import { describe, expect, it } from 'vitest';
import { emptyBrain, TIME_UNIT_MS } from './defaults';
import { encodeEvent } from './encoding';
import { consolidate } from './consolidation';
import { attachWarrant, COLLAPSE_SUPPORT, recomputeWarrants } from './warrant';
import { addEdge } from './graph';
import { neutralAppraisal } from './emotion';
import type { AppraisedEvent, MemoryNode } from './types';

const T0 = 1_700_000_000_000;
let n = 0;
const makeId = () => `id-${++n}`;

function event(over: Partial<AppraisedEvent> = {}): AppraisedEvent {
  return {
    gist: 'an event of some importance occurred',
    actors: ['Kira'],
    tags: ['kira'],
    appraisal: { ...neutralAppraisal(), goalRelevance: 0.6, ...(over.appraisal ?? {}) },
    salience: 0.7,
    ...over,
  };
}

describe('meta-memory warrant (§B.2 #7)', () => {
  it('attaches evidence when a belief is formed from episodes', () => {
    const b = emptyBrain('c', 'x', 'Wren', T0);
    const evs = [
      event({ gist: 'Kira lied about the ledger again this morning' }),
      event({ gist: 'Kira lied about the ledger in front of the crew' }),
      event({ gist: 'Kira lied about the ledger and laughed it off' }),
    ];
    // Age the episodes so semanticise will fire (it waits a day).
    encodeEvent(b, evs[0], { now: T0 - 3 * TIME_UNIT_MS, makeId });
    encodeEvent(b, evs[1], { now: T0 - 2 * TIME_UNIT_MS, makeId });
    encodeEvent(b, evs[2], { now: T0 - 1 * TIME_UNIT_MS, makeId });
    consolidate(b, { events: [], now: T0, makeId, maintenance: true });
    const semantic = Object.values(b.nodes).find((n) => n.kind === 'semantic');
    expect(semantic?.warrant).toBeTruthy();
    expect(semantic!.warrant!.evidence.length).toBeGreaterThanOrEqual(2);
    expect(b.edges.some((e) => e.kind === 'derived_from')).toBe(true);
  });

  it('collapses a belief when its evidence is gone', () => {
    const b = emptyBrain('c', 'x', 'Wren', T0);
    const ev = encodeEvent(b, event({ gist: 'Kira broke a promise about the docks' }), { now: T0, makeId });
    const belief: MemoryNode = {
      ...ev.node!,
      id: makeId(),
      kind: 'schema',
      gist: 'Kira cannot be relied on',
      confidence: 0.85,
    };
    b.nodes[belief.id] = belief;
    attachWarrant(b, belief, [ev.node!], 'they keep doing this');
    // Wipe the evidence.
    delete b.nodes[ev.node!.id];
    const r = recomputeWarrants(b);
    expect(r.collapsed).toContain(belief.id);
    expect(belief.warrant!.support).toBeLessThanOrEqual(COLLAPSE_SUPPORT);
    expect(belief.confidence).toBeLessThan(0.4);
    expect(belief.status).toBe('faded');
  });

  it('weakens a belief when its evidence is contradicted', () => {
    const b = emptyBrain('c', 'x', 'Wren', T0);
    const ev = encodeEvent(b, event({ gist: 'Kira broke a promise about the docks' }), { now: T0, makeId });
    const belief: MemoryNode = {
      ...ev.node!,
      id: makeId(),
      kind: 'schema',
      gist: 'Kira cannot be relied on',
      confidence: 0.85,
    };
    b.nodes[belief.id] = belief;
    attachWarrant(b, belief, [ev.node!], 'they keep doing this');
    addEdge(b, ev.node!.id, belief.id, 'contradicts', 0.8);
    const r = recomputeWarrants(b);
    expect(r.collapsed.length + r.weakened.length).toBeGreaterThan(0);
    expect(belief.warrant!.support).toBeLessThan(1);
  });
});
