# Memory and learning from experience

Reverie retains its existing character brain and adds precise techniques learned
within one conversation. Open a character's **Mind → Learned skills** to inspect
them, search by skill or condition, reveal their source evidence, or mute them in
replies. Learning runs with the existing background memory cadence. **Read this
conversation** can extract lessons from earlier exchanges.

For example, an art student may learn “rotate the brush 90 degrees” for a
particular mark. The record keeps that action and its conditions. Being taught
the action means **understood, untested**. An actual attempt records practice;
successful attempts provide evidence of experience. The engine never awards
practice credit just for recalling or injecting a technique into a prompt.

## Design and implementation plan

The starting system already includes working memory, episodic and semantic
memory, emotional appraisal, consolidation, reconstructive recall, habits,
relationships, personality drift and a psyche model. Replacing those mechanisms
would remove features. This upgrade extends their existing orchestration:

1. Preserve the current brain, global Skills library, provider routing and privacy controls.
2. Add a separate collection of precise, evidence-backed techniques inside each chat/character brain.
3. Extract learning in the existing background encoder call, including quiet lessons that emotional salience could miss.
4. Validate sources, retain corrections and distinguish instruction from actual practice.
5. Recall relevant techniques locally within the existing memory budget.
6. Expose learning and evidence in the Mind page; verify behavior with synthetic fixtures, integration tests and browser checks.

## How the memory systems cooperate

| Function | Existing or added behavior |
|---|---|
| Working memory | Existing recent-turn and recalled-event slots keep the immediate scene available. |
| Episodes and facts | Existing event encoding, associative retrieval and long-term consolidation remain in place. |
| Emotion | Existing appraisal, affect, salience and trauma handling continue to influence remembered experience. |
| Habits and identity | Existing procedural habits, personality and relationship changes remain separate from technical proficiency. |
| Learned techniques | New precise actions, applicability conditions, observed results and learning evidence. |
| Physical skills | Techniques retain the actual motion, tools, quantities or angles stated in the source. |
| Social skills | Techniques retain the situation and observed response; their prompt guidance does not promise the same response from someone else. |
| Application | The reply model adapts a relevant learned action to the current scene without inventing unstated steps or assuming mastery. |

These are functional analogies, not a simulation of brain anatomy. Human memory
involves interacting systems; associating a software collection with one brain
region does not reproduce its biology. The user's supplied
[memory overview](https://courses.lumenlearning.com/waymaker-psychology/chapter/parts-of-the-brain-involved-with-memory/)
distinguishes roles of the hippocampus, amygdala, cerebellum and prefrontal cortex.
The implementation uses that distinction to separate experiences, emotions,
immediate context and learned actions while keeping their existing connections.

## Learning contract

Each technique stores:

- A broad skill category and a physical, social, creative, practical or cognitive domain.
- A precise action (up to 420 characters), its conditions (180), and an observed result when present (180).
- Source message ID, exact supporting quote (600), source fingerprint, recording time and learning mode.
- An optional explicit correction link and a reversible mute flag.

Learning modes are taught, observed, practiced, succeeded, failed and corrected.
The displayed stage derives from evidence: understood/untested, practicing, tried
successfully, repeated success, or needs practice. Three distinct successful
source messages qualify as repeated success; this is an engineering label,
not a scientifically calibrated proficiency scale or general expertise.

The encoder must identify the exact learner and quote the current transcript.
The engine rejects malformed entries, missing source IDs, invented quotes,
unsupported numeric quantities and oversized fields. It does not silently cut
off the end of an action or remove a condition to make it fit.

Exact technique/condition matches accumulate evidence, with each attempt's result
kept in its evidence entry. A re-read cannot
award the same source message twice to the same technique. A paraphrased item
using the same exact quotation is also ignored. Different techniques or
conditions can coexist. Semantic equivalence between arbitrarily different
paraphrases still depends on the extractor; it receives relevant existing wording
to reuse rather than requiring a second model call to deduplicate it.

An explicit correction hides the earlier technique from recall while keeping
its history visible. Muting the correction restores the earlier technique as a
candidate. Edited, hidden, deleted or excluded source messages invalidate their
learning evidence before generation. Removing the final evidence for a correction
also restores the earlier candidate. Generation never overwrites concurrently
consolidated learning or a user's mute setting.

## Performance and cost

Learning shares the existing encoder request and its maximum of two attempts.
Recognized learning language can route a scene through that encoder even when
the previous emotional admission gate would have skipped it. That is an
intentional background cost to avoid losing quiet lessons. An accepted learning-only
response completes after one attempt. No dedicated skill-learning model request
is added to reply generation.

Retrieval uses local term relevance across skill, conditions, technique and
outcome. At most six whole techniques are composed, capped at 900 estimated
tokens and 30% of the memory budget remaining after the character state block.
Unspent budget remains available to normal memory. Muted, superseded and
unrelated techniques spend no learned-technique prompt tokens. Evidence quotes
remain available in the inspector and are not copied into every reply.

Source reconciliation hashes only messages that supplied learning. The library
is retained without a destructive technique-count cap; retrieval scans it
locally. Very large libraries therefore still have linear lookup cost.

A local synthetic benchmark (Node 24, 20 measured runs after warm-up) measured
reconciliation plus composition as follows. These exclude disk I/O, model time,
the existing brain pipeline and large-transcript traversal; they are not an
end-to-end chat latency claim.

| Stored techniques | Median | Slowest measured run | Injected techniques | Estimated prompt tokens |
|---|---:|---:|---:|---:|
| 100 | 0.33 ms | 0.60 ms | 6 | 328 |
| 1,000 | 2.71 ms | 3.49 ms | 6 | 328 |
| 10,000 | 27.46 ms | 33.80 ms | 6 | 327 |

For implementation work, relevant source reads, bounded tool output and
synthetic tests avoid repeated full-repository context or paid model calls.
This follows the scope and context guidance in
[OpenAI's Codex usage documentation](https://learn.chatgpt.com/docs/pricing#what-can-i-do-to-make-my-usage-limits-last-longer).
No measured 100× whole-app improvement is claimed.

## Compatibility and verification limits

Old saves load with an empty learned-technique collection. Learning is stored
inside the existing encrypted/atomic brain storage, scoped to the existing chat
and character key. Global uploaded Skills are neither modified nor promoted to
personal experience. Turning off character memory also disables this learning.
No dependencies or new provider request paths are added to the product.

Unit tests cover precise details, source validation, duplicate practice,
corrections, source edits/deletion, scope, migration, concurrent updates, relevance
and hard prompt caps. Mocked orchestration tests exercise the real encoder,
cursor and generation integration without private runtime files or provider calls.
An isolated browser fixture checks searching, evidence disclosure, mute/unmute,
mobile overflow and browser errors.

The model must still interpret whether learning happened, who witnessed it, and
whether an attempt worked. Exact-source and numeric checks cannot prove every
semantic claim. The offline event fallback preserves ordinary memory if both
encoder attempts fail; it does not invent a technical lesson. Such lessons can
be recovered with **Read this conversation** after the provider is working.
Lexical recall can miss a scene expressed entirely through unrelated synonyms.
Live quality across the user's configured models requires separate evaluation;
synthetic tests do not establish that every model will extract or apply every
lesson correctly.
