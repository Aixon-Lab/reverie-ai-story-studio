import { describe, expect, it } from 'vitest';
import { buildSelfConcept, describeSelfConcept } from './identity';
import { DEFAULT_PARAMS } from '../brain/defaults';
import type { MemoryNode } from '../brain/types';
const NOW = 1_700_000_000_000;
const node = (o: Partial<MemoryNode>): MemoryNode => ({
  id: Math.random().toString(36).slice(2), kind: 'episodic', gist: 'x', encodedAt: NOW,
  uses: [NOW], useCount: 1, permanentBoost: 1,
  affect: { valence: -0.8, arousal: 0.6, dominance: -0.4, label: 'shame' },
  appraisal: { novelty: 0.4, pleasantness: 0, goalRelevance: 0.5, goalConduciveness: 0, agency: 'other', intent: 0, copingPotential: 0.5, norms: 0, urgency: 0.3 },
  vividness: 0.5, confidence: 0.7, fidelity: 0.8, actors: [], tags: [], contextBinding: 0.6,
  suppressed: 0, status: 'active', ...o,
});
describe('self-concept prose', () => {
  it('never renders a formative EVENT as a statement of self', () => {
    const nodes = [
      node({ kind: 'identity', gist: "Rooke forced Wren to choose between vivisection by Kessler's scientists and ownership as his" }),
      node({ kind: 'schema', gist: 'She is something people use and put down' }),
    ];
    const out = describeSelfConcept(buildSelfConcept(nodes, 'Wren', NOW, DEFAULT_PARAMS), 'Wren');
    console.log('\n>>> ' + out + '\n');
    expect(out).toMatch(/takes themselves to be something people use/);
    expect(out).not.toMatch(/takes themselves to be Rooke forced/);
    expect(out).toMatch(/What shaped that:/);
  });
  it('says nothing about self-belief when only episodes exist', () => {
    const out = describeSelfConcept(buildSelfConcept([node({ kind: 'identity', gist: 'Rooke forced Wren into the transport box' })], 'Wren', NOW, DEFAULT_PARAMS), 'Wren');
    console.log('\n>>> ' + out + '\n');
    expect(out).not.toMatch(/takes themselves to be/);
  });
  it('truncates a long gist on a word boundary', () => {
    const long = 'She is ' + 'something people use and discard again '.repeat(6);
    const out = describeSelfConcept(buildSelfConcept([node({ kind: 'schema', gist: long })], 'Wren', NOW, DEFAULT_PARAMS), 'Wren');
    expect(out).toMatch(/\.\.\./);
    expect(out.length).toBeLessThan(220);
  });
});
