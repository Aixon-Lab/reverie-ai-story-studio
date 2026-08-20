/**
 * Character Brain — public surface.
 *
 * Design: docs/brain-system.md
 * Science: docs/research/human-memory-architecture.md
 *
 * Everything exported here is pure and deterministic given an injected clock,
 * id source, and rng. Nothing in this folder performs I/O or talks to a model.
 */
export * from './types';
export * from './defaults';
export * from './activation';
export * from './emotion';
export * from './graph';
export * from './encoding';
export * from './personality';
export * from './consolidation';
export * from './retrieval';
export * from './budget';
export * from './compose';
export * from './prompts';
export * from './heuristics';
export * from './synapse';
export * from './reconstruction';
export * from './neuromodulation';
export * from './mentation';
export * from './volition';
export * from './admission';
export * from './working';
export * from './entities';
export * from './warrant';
export * from './persist';
