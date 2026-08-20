/**
 * The Mind — one character's memory inside one conversation.
 *
 * A brain is scoped to a chat: the same character in another chat is a
 * different person who has not lived through what happened here. The route is
 * therefore `/mind/:chatId/:characterId`.
 *
 * Four views over one brain:
 *   Network  the associative graph (2D / 3D), with a full node inspector
 *   Psyche   temperament drift vs. disposition, mood, goals, relationships
 *   Story    chapters → memories in time, with the emotional trace
 *   Log      every consolidation pass, so nothing the engine did is a mystery
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  Activity, Brain, Clock, Gauge, MessageSquare, Network, Pin, RotateCcw,
  ScrollText, Search, Trash2, TriangleAlert, Users,
} from 'lucide-react';
import {
  api, type BrainAuditEntry, type BrainGraph, type BrainGraphNode, type BrainJob,
  type BrainNodeDetail, type BrainRecallHit, type BrainSummary, type ModelLimits,
} from '../api';
import { BrainJobProgress } from '../components/BrainJobProgress';
import { IconAi } from '../components/Icons';
import { GlobeLoader } from '../components/GlobeLoader';
import { useApp } from '../store';
import { Avatar } from '../components/Avatar';
import { MemoryGraph, MEMORY_EDGE_COLORS } from '../components/MemoryGraph';
import { useConfirm } from '../components/ConfirmDialog';

type Tab = 'network' | 'psyche' | 'story' | 'log';

const KIND_LABEL: Record<string, string> = {
  episodic: 'Episodes',
  semantic: 'Knowledge',
  schema: 'Beliefs',
  identity: 'Formative',
  sensory: 'Trauma',
  relational: 'Relationships',
  procedural: 'Habits',
};

const TRAIT_LABEL: Record<string, [string, string]> = {
  warmth: ['Cold', 'Warm'],
  dominance: ['Deferential', 'Commanding'],
  volatility: ['Steady', 'Volatile'],
  trust: ['Guarded', 'Trusting'],
  courage: ['Fearful', 'Fearless'],
  openness: ['Rigid', 'Curious'],
  conscientiousness: ['Careless', 'Disciplined'],
  selfWorth: ['Insecure', 'Self-assured'],
};

export function MindPage() {
  const { chatId, characterId } = useParams<{ chatId: string; characterId: string }>();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const confirm = useConfirm();
  const { characters, chats } = useApp();

  const [graph, setGraph] = useState<BrainGraph | null>(null);
  const [limits, setLimits] = useState<ModelLimits | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [tab, setTab] = useState<Tab>((params.get('tab') as Tab) || 'network');
  const [mode, setMode] = useState<'2d' | '3d'>('3d');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BrainNodeDetail | null>(null);
  const [kindFilter, setKindFilter] = useState<Set<string>>(new Set());
  const [showForgotten, setShowForgotten] = useState(true);
  const [query, setQuery] = useState('');
  const [probe, setProbe] = useState('');
  const [probeHits, setProbeHits] = useState<BrainRecallHit[] | null>(null);
  const [audit, setAudit] = useState<BrainAuditEntry[]>([]);
  /** A consolidation run for this mind, watched while it reads. */
  const [job, setJob] = useState<BrainJob | null>(null);

  const card = characters.find((c) => c.id === characterId);
  const chat = chats.find((c) => c.id === chatId);

  const load = useCallback(async () => {
    if (!chatId || !characterId) return;
    setLoading(true);
    setError('');
    try {
      const g = await api.brain.graph(chatId, characterId);
      setGraph(g);
      const l = await api.brain.limits({
        share: g.config.shareOfContext,
        reservedOutput: 1024,
        chatId,
        characterId,
      }).catch(() => null);
      setLimits(l);
    } catch (err: any) {
      setError(err?.message ?? 'Could not open this mind.');
    } finally {
      setLoading(false);
    }
  }, [chatId, characterId]);

  useEffect(() => { void load(); }, [load]);

  /**
   * Pick up a run that is already going.
   *
   * Reading a long conversation is minutes of model calls, and the job lives on
   * the server — but the *bar* lived only in this component's state. Reloading
   * the page, or leaving and coming back, therefore showed a mind with no
   * memories, no progress, and every button live to start the same run again.
   */
  useEffect(() => {
    if (!chatId) return;
    let cancelled = false;
    api.brain.activeJob(chatId)
      .then((j) => {
        // Only a run that involves this character belongs on this page.
        if (cancelled || !j) return;
        if (!characterId || j.members.some((m) => m.characterId === characterId)) setJob(j);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [chatId, characterId]);

  useEffect(() => {
    if ((tab !== 'log' && tab !== 'story') || !chatId || !characterId) return;
    api.brain.audit(chatId, characterId).then(setAudit).catch(() => setAudit([]));
  }, [tab, chatId, characterId, graph?.stats.updates]);

  /** Follow a live run, then refresh the graph so the new memories appear. */
  useEffect(() => {
    if (!job || (job.status !== 'planning' && job.status !== 'running')) return;
    let cancelled = false;
    const t = setInterval(async () => {
      try {
        const next = await api.brain.job(job.id);
        if (cancelled) return;
        setJob(next);
        if (next.status !== 'planning' && next.status !== 'running') void load();
      } catch {
        if (!cancelled) { setJob(null); void load(); }
      }
    }, 900);
    return () => { cancelled = true; clearInterval(t); };
  }, [job, load]);

  useEffect(() => {
    if (!selectedId || !chatId || !characterId) { setDetail(null); return; }
    let cancelled = false;
    api.brain.node(chatId, characterId, selectedId)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch(() => { if (!cancelled) setDetail(null); });
    return () => { cancelled = true; };
  }, [selectedId, chatId, characterId]);

  function switchTab(next: Tab) {
    setTab(next);
    params.set('tab', next);
    setParams(params, { replace: true });
  }

  const filteredNodes = useMemo(() => {
    if (!graph) return [];
    const q = query.trim().toLowerCase();
    return graph.nodes.filter((n) => {
      if (kindFilter.size && !kindFilter.has(n.kind)) return false;
      if (!q) return true;
      return (
        n.gist.toLowerCase().includes(q)
        || n.tags.some((t) => t.includes(q))
        || n.actors.some((a) => a.toLowerCase().includes(q))
      );
    });
  }, [graph, kindFilter, query]);

  const highlightIds = useMemo(
    () => (probeHits ? probeHits.slice(0, 12).map((h) => h.id) : []),
    [probeHits],
  );

  /** A run is live while it is planning or reading — nothing else may start one. */
  const running = !!job && (job.status === 'planning' || job.status === 'running');

  /**
   * Reading is chunked, and a long conversation is many chunks — so this starts
   * a watched run rather than blocking on one request that may take minutes.
   */
  async function runUpdate(force = false) {
    if (!chatId || !characterId || running) return;
    setError('');
    /**
     * Show something *immediately*.
     *
     * Starting a run left every control exactly as it was until the first poll
     * came back, so the button stayed live (a second click started a second
     * run) and the empty state carried on saying "nothing has happened here
     * yet" — for minutes, while the mind was being read. A placeholder job puts
     * the bar on screen in the same frame as the click.
     */
    setJob({
      id: 'pending', chatId, kind: force ? 'reread' : 'update', status: 'planning',
      startedAt: Date.now(), chunks: 0, chunksDone: 0,
      members: [{
        characterId,
        name: card?.name ?? graph?.characterName ?? 'this mind',
        status: 'pending', chunks: 0, chunksDone: 0, messages: 0, messagesRead: 0, encoded: 0,
      }],
    });
    try {
      setJob(await api.brain.chatConsolidate(chatId, force, [characterId]));
    } catch (err: any) {
      setJob(null);
      setError(err?.message ?? 'Consolidation failed.');
    }
  }

  async function cancelRun() {
    if (!job) return;
    try {
      setJob(await api.brain.cancelJob(job.id));
    } catch {
      setJob(null);
    }
  }

  /** Re-derive the temperament anchor from the card, keeping earned drift. */
  async function rebuildBaseline() {
    if (!chatId || !characterId) return;
    setBusy('Reading the card…');
    try {
      await api.brain.init(chatId, characterId, true);
      await load();
    } catch (err: any) {
      setError(err?.message ?? 'Could not build the baseline.');
    } finally {
      setBusy('');
    }
  }

  /**
   * A setting that fails must say so.
   *
   * These used to be unhandled rejections: the request failed, the control
   * snapped back to its old value, and nothing anywhere explained why — which
   * is indistinguishable from the setting not working at all.
   */
  async function patchConfig(patch: Record<string, unknown>) {
    if (!chatId || !characterId || !graph) return;
    try {
      const next = await api.brain.config(chatId, characterId, patch);
      setGraph({ ...graph, config: next });
      const l = await api.brain.limits({
        share: next.shareOfContext, reservedOutput: 1024, chatId, characterId,
      }).catch(() => null);
      setLimits(l);
    } catch (err: any) {
      setError(err?.message ?? 'Could not save that setting.');
      await load();
    }
  }

  async function patchNode(nodeId: string, patch: Record<string, unknown>) {
    if (!chatId || !characterId) return;
    try {
      await api.brain.patchNode(chatId, characterId, nodeId, patch);
      await load();
      if (patch.delete) setSelectedId(null);
    } catch (err: any) {
      setError(err?.message ?? 'Could not change that memory.');
    }
  }

  if (!chatId || !characterId) return <div className="mind-empty">No conversation selected.</div>;

  if (loading && !graph) {
    return (
      <div className="mind-empty">
        <GlobeLoader size={36} />
        <p className="t-caption">Opening the mind…</p>
      </div>
    );
  }

  const isEmpty = !graph || graph.nodes.length === 0;
  const chatTitle = graph?.chatTitle || chat?.title || 'this conversation';
  const name = graph?.characterName ?? card?.name ?? characterId;
  /**
   * One label for "this mind is working", whatever the work is.
   *
   * A consolidation run left `busy` empty, so every control that keyed off it
   * stayed enabled and every "in progress" line stayed hidden while the mind
   * was being read. Folding the run in means one flag governs the whole page.
   */
  const busyLabel = busy || (running ? 'Reading the conversation…' : '');

  return (
    <div className="mind-page">
      <header className="mind-head">
        <button className="icon-btn" onClick={() => nav(-1)} title="Back">‹</button>
        <Avatar src={card?.avatar} name={name} characterId={characterId} size={40} />
        <div className="mind-head-meta">
          <h1 className="mind-title">{name}</h1>
          <p className="t-caption mind-index-sub">
            <button className="mind-chatlink" onClick={() => nav(`/chat/${chatId}`)} title="Back to the conversation">
              <MessageSquare size={12} /> {chatTitle}
            </button>
            {/* One mind is one head in a scene — the way back to the rest of the cast. */}
            <button
              className="mind-chatlink"
              onClick={() => nav(`/mind/${encodeURIComponent(chatId)}`)}
              title="Everyone's memory in this conversation"
            >
              <Users size={12} /> Whole cast
            </button>
            <span>
              {graph
                ? `${graph.nodes.length} memories · ${graph.edges.length} connections · ${graph.people.length} people known`
                : 'no memory yet'}
            </span>
          </p>
        </div>
        <span style={{ flex: 1 }} />
        {graph && <MoodPill mood={graph.mood} />}
        <div className="mind-tabs">
          {([
            ['network', 'Network', Network],
            ['psyche', 'Psyche', Brain],
            ['story', 'Story', Clock],
            ['log', 'Log', ScrollText],
          ] as [Tab, string, typeof Brain][]).map(([id, label, Icon]) => (
            <button
              key={id}
              className={`chip${tab === id ? ' active' : ''}`}
              onClick={() => switchTab(id)}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="mind-banner">
          <TriangleAlert size={15} /> {error}
          <button className="btn btn-ghost btn-sm" onClick={() => setError('')}>Dismiss</button>
        </div>
      )}

      {job && (
        <div className="mind-cast-progress">
          <BrainJobProgress job={job} onCancel={() => void cancelRun()} onDismiss={() => setJob(null)} />
        </div>
      )}

      {isEmpty && (
        <div className="mind-empty">
          <Brain size={32} strokeWidth={1.4} />
          {/* While a run is going this is not an empty mind, it is a mind mid-read. */}
          <h2 className="t-label">
            {running ? `Reading ${chatTitle}…` : 'Nothing has happened here yet'}
          </h2>
          <p className="t-caption" style={{ maxWidth: 480, textAlign: 'center' }}>
            {running ? (
              <>
                {name} is going through the conversation now. Memories appear here as each pass
                finishes — the progress above is real work already saved, so stopping keeps
                everything read so far.
              </>
            ) : (
              <>
                {name} has no memory of <b>{chatTitle}</b> so far. Memory forms in the background as
                you play — or build the baseline now and read the conversation from the start.
                {' '}Their memory of other conversations is separate and stays untouched.
              </>
            )}
          </p>
          <div className="btn-row">
            <button
              className="btn btn-primary btn-sm"
              disabled={!!busyLabel}
              onClick={rebuildBaseline}
            >
              <IconAi size={14} /> Build baseline from card
            </button>
            <button className="btn btn-secondary btn-sm" disabled={!!busyLabel} onClick={() => runUpdate(true)}>
              <Activity size={14} /> Read this conversation
            </button>
          </div>
          {busyLabel && <p className="t-caption"><GlobeLoader size={13} label={busyLabel} /></p>}
        </div>
      )}

      {graph && !isEmpty && tab === 'network' && (
        <div className="mind-network">
          <aside className="mind-side">
            <section className="mind-block">
              <p className="field-label">Search memory</p>
              <div className="mind-search">
                <Search size={14} />
                <input
                  className="input"
                  placeholder="text, person, tag…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </section>

            <section className="mind-block">
              <p className="field-label">Kinds</p>
              <div className="mind-chips">
                {Object.entries(KIND_LABEL).map(([kind, label]) => {
                  const n = graph.nodes.filter((x) => x.kind === kind).length;
                  if (!n) return null;
                  const on = kindFilter.has(kind);
                  return (
                    <button
                      key={kind}
                      className={`chip${on ? ' active' : ''}`}
                      onClick={() => {
                        const next = new Set(kindFilter);
                        if (on) next.delete(kind); else next.add(kind);
                        setKindFilter(next);
                      }}
                    >
                      {label} <span className="mind-count">{n}</span>
                    </button>
                  );
                })}
              </div>
              <label className="mind-toggle">
                <input
                  type="checkbox"
                  checked={showForgotten}
                  onChange={(e) => setShowForgotten(e.target.checked)}
                />
                <span>Show what has slipped away</span>
              </label>
            </section>

            <section className="mind-block">
              <p className="field-label">Probe recall</p>
              <p className="t-caption" style={{ marginBottom: 6 }}>
                Ask what this cue would bring to mind. Inspecting never changes the memory.
              </p>
              <textarea
                className="textarea"
                rows={2}
                placeholder="e.g. the night at the docks"
                value={probe}
                onChange={(e) => setProbe(e.target.value)}
              />
              <div className="btn-row" style={{ marginTop: 6 }}>
                <button
                  className="btn btn-secondary btn-sm"
                  disabled={!probe.trim()}
                  onClick={async () => {
                    const res = await api.brain.recall(chatId, characterId, { text: probe });
                    setProbeHits(res.hits);
                  }}
                >
                  Recall
                </button>
                {probeHits && (
                  <button className="btn btn-ghost btn-sm" onClick={() => setProbeHits(null)}>Clear</button>
                )}
              </div>
              {probeHits && (
                <div className="mind-probe-list">
                  {probeHits.length === 0 && <p className="t-caption">Nothing comes to mind.</p>}
                  {probeHits.slice(0, 10).map((h) => (
                    <button key={h.id} className="mind-probe-row" onClick={() => setSelectedId(h.id)}>
                      <span className="mind-probe-act">{h.activation.toFixed(2)}</span>
                      <span className="mind-probe-gist">{h.gist}</span>
                      {h.intrusion && <span className="mind-tag mind-tag-danger">intrusive</span>}
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section className="mind-block">
              <p className="field-label">Legend</p>
              <ul className="mind-legend">
                <li><span className="dot" style={{ background: 'hsl(38 60% 50%)' }} /> good feeling</li>
                <li><span className="dot" style={{ background: 'hsl(352 70% 50%)' }} /> painful</li>
                <li><span className="dot dot-ring" /> ring = arousal</li>
                <li><span className="dot dot-halo" /> halo = permanent</li>
                <li><span className="dot dot-pulse" /> pulsing = intrusive</li>
                <li><span className="dot dot-ghost" /> faint = forgotten</li>
              </ul>
              <div className="mind-legend-edges">
                {Object.entries(MEMORY_EDGE_COLORS).slice(0, 8).map(([kind, color]) => (
                  <span key={kind} className="mind-edge-key">
                    <i style={{ background: color }} /> {kind.replace(/_/g, ' ')}
                  </span>
                ))}
              </div>
            </section>
          </aside>

          <div className="mind-canvas-wrap">
            <div className="mind-canvas-bar">
              <div className="mind-chips">
                <button className={`chip${mode === '3d' ? ' active' : ''}`} onClick={() => setMode('3d')}>3D</button>
                <button className={`chip${mode === '2d' ? ' active' : ''}`} onClick={() => setMode('2d')}>2D</button>
              </div>
              <span style={{ flex: 1 }} />
              <span className="t-caption">{filteredNodes.length} of {graph.nodes.length} shown</span>
            </div>
            <MemoryGraph
              nodes={filteredNodes}
              edges={graph.edges}
              mode={mode}
              selectedId={selectedId}
              highlightIds={highlightIds}
              onSelect={setSelectedId}
              showForgotten={showForgotten}
            />
          </div>

          <aside className="mind-inspector">
            {!selectedId && (
              <div className="mind-inspector-empty">
                <p className="t-caption">
                  Click any memory to open it — its full record, why it is (or is not) available right now,
                  and everything it is wired to.
                </p>
                <BudgetPanel graph={graph} limits={limits} onChange={patchConfig} />
                <CadencePanel graph={graph} onChange={patchConfig} busy={busyLabel} onUpdate={runUpdate} />
              </div>
            )}
            {selectedId && (
              <NodeInspector
                node={graph.nodes.find((n) => n.id === selectedId)}
                detail={detail}
                onSelect={setSelectedId}
                onPatch={patchNode}
                onClose={() => setSelectedId(null)}
              />
            )}
          </aside>
        </div>
      )}

      {graph && !isEmpty && tab === 'psyche' && (
        <PsycheView
          graph={graph}
          limits={limits}
          onChange={patchConfig}
          busy={busyLabel}
          onUpdate={runUpdate}
          onRebuildBaseline={rebuildBaseline}
          onWipe={async () => {
            const ok = await confirm({
              title: `Erase what ${name} remembers of “${chatTitle}”?`,
              body: 'Their memory of other conversations is not affected. This cannot be undone.',
              confirmLabel: 'Erase memories',
              danger: true,
            });
            if (!ok) return;
            await api.brain.wipe(chatId, characterId);
            await load();
          }}
        />
      )}

      {graph && !isEmpty && tab === 'story' && (
        <StoryView
          graph={graph}
          idle={audit.filter((e) => e.kind === 'mentation')}
          onSelect={(id) => { setSelectedId(id); switchTab('network'); }}
        />
      )}

      {graph && !isEmpty && tab === 'log' && <LogView entries={audit} />}
    </div>
  );
}

/** `/mind` — every conversation, and whose minds live inside it. */
export function MindIndex() {
  const { characters, chats, groups } = useApp();
  const nav = useNavigate();
  const [summaries, setSummaries] = useState<BrainSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.brain.list()
      .then(setSummaries)
      .catch(() => setSummaries([]))
      .finally(() => setLoading(false));
  }, []);

  const byChat = useMemo(() => {
    const map = new Map<string, Map<string, BrainSummary>>();
    for (const s of summaries) {
      const inner = map.get(s.chatId) ?? new Map<string, BrainSummary>();
      inner.set(s.characterId, s);
      map.set(s.chatId, inner);
    }
    return map;
  }, [summaries]);

  const rows = useMemo(() => {
    return chats.map((chat) => {
      const memberIds = chat.groupId
        ? groups.find((g) => g.id === chat.groupId)?.members ?? []
        : chat.characterId ? [chat.characterId] : [];
      const cast = memberIds
        .map((id) => characters.find((c) => c.id === id))
        .filter((c): c is NonNullable<typeof c> => !!c);
      return { chat, cast, brains: byChat.get(chat.id) ?? new Map<string, BrainSummary>() };
    }).filter((r) => r.cast.length);
  }, [chats, groups, characters, byChat]);

  return (
    <div className="mind-index">
      <header className="mind-index-head">
        <h1 className="mind-title"><Brain size={22} strokeWidth={1.6} /> Minds</h1>
        <p className="t-caption">
          Each character builds a real memory inside <b>each conversation</b> — events, feelings, beliefs,
          and how those change who they are. The same character in another chat is a different person
          who has not lived through this one. Open a mind to see the network, or to tune how it
          remembers and forgets.
        </p>
      </header>

      {loading && <p className="t-caption"><GlobeLoader size={13} label="Looking…" /></p>}
      {!loading && !rows.length && (
        <p className="t-caption">No conversations yet — start a chat and memory begins forming on its own.</p>
      )}

      <div className="mind-index-grid" style={{ gridTemplateColumns: '1fr' }}>
        {rows.map(({ chat, cast, brains }) => (
          <section key={chat.id} className="mind-index-group">
            <div className="mind-index-group-head">
              <h2>{chat.title}</h2>
              <span className="t-caption">
                {chat.groupId ? `group · ${cast.length} present` : 'solo'} ·
                {' '}updated {new Date(chat.updatedAt).toLocaleDateString()}
              </span>
              {/* The cast's memory as a whole — settings for everyone in the scene. */}
              <button
                className="mind-chatlink"
                onClick={() => nav(`/mind/${encodeURIComponent(chat.id)}`)}
                title="Everyone's memory in this conversation, and its settings"
              >
                <Users size={12} /> Whole cast
              </button>
            </div>
            <div className="mind-index-faces">
              {cast.map((c) => {
                const s = brains.get(c.id);
                return (
                  <button
                    key={c.id}
                    className="mind-index-face"
                    onClick={() => nav(`/mind/${encodeURIComponent(chat.id)}/${encodeURIComponent(c.id)}`)}
                    title={`Open ${c.name}'s mind for “${chat.title}”`}
                  >
                    <Avatar src={c.avatar} name={c.name} characterId={c.id} size={30} interactive={false} />
                    <span className="mind-index-face-meta">
                      <b>{c.name}</b>
                      <span>
                        {s ? `${s.counts.total} memories · ${s.mood.label}` : 'no memory yet'}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

// ---------- pieces ----------

function MoodPill({ mood }: { mood: BrainGraph['mood'] }) {
  const hue = mood.valence < 0 ? 352 : 90;
  return (
    <span
      className="mind-mood"
      title={`valence ${mood.valence.toFixed(2)} · arousal ${mood.arousal.toFixed(2)} · dominance ${mood.dominance.toFixed(2)}`}
    >
      <i style={{ background: `hsl(${hue} ${(20 + Math.abs(mood.valence) * 55).toFixed(0)}% 50%)` }} />
      {mood.label}
    </span>
  );
}

function NodeInspector({
  node, detail, onSelect, onPatch, onClose,
}: {
  node?: BrainGraphNode;
  detail: BrainNodeDetail | null;
  onSelect: (id: string) => void;
  onPatch: (id: string, patch: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const confirm = useConfirm();
  if (!node) return <p className="t-caption" style={{ padding: 16 }}>That memory is gone.</p>;
  const raw = detail?.node as Record<string, any> | undefined;

  return (
    <div className="mind-node">
      <div className="mind-node-head">
        <span className={`mind-tag mind-tag-${node.kind}`}>{KIND_LABEL[node.kind] ?? node.kind}</span>
        {node.intrusive && <span className="mind-tag mind-tag-danger">intrusive</span>}
        {node.pinned && <span className="mind-tag"><Pin size={11} /> pinned</span>}
        {node.drifted && <span className="mind-tag mind-tag-drift">drifted</span>}
        {node.primed && <span className="mind-tag">primed</span>}
        {node.fatigued && <span className="mind-tag">worn</span>}
        <span className={`mind-tag mind-tag-${node.status}`}>{node.status}</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={onClose} title="Close">×</button>
      </div>

      <p className="mind-node-gist">{node.gist}</p>
      {raw?.verbatim && <blockquote className="mind-node-quote">“{String(raw.verbatim)}”</blockquote>}
      {raw?.detail && <p className="mind-node-detail">{String(raw.detail)}</p>}

      <div className="mind-meters">
        <Meter label="Availability" value={node.probability} hint="Chance this comes to mind with an ordinary cue right now" />
        <Meter label="Vividness" value={node.vividness} hint="How richly it is re-experienced" />
        <Meter label="Conviction" value={node.confidence} hint="How sure they are it happened this way" />
        <Meter label="Accuracy" value={node.fidelity} hint="How close it still is to what actually happened" tone={node.confidence - node.fidelity > 0.3 ? 'warn' : undefined} />
        <Meter label="Context binding" value={node.contextBinding} hint="How firmly tied to a time and place — low means it can intrude" />
      </div>

      {node.confidence - node.fidelity > 0.3 && (
        <p className="mind-note">
          They are certain of this, but it has drifted from what happened. That gap is normal — it is
          what makes vivid memories feel unimpeachable while quietly rewriting themselves.
        </p>
      )}

      {(() => {
        const distortions = (raw?.distortions as { at: number; kind: string; note: string }[] | undefined) ?? [];
        if (!distortions.length) return null;
        return (
          <section className="mind-block">
            <p className="field-label">How it has drifted</p>
            <p className="t-caption" style={{ marginBottom: 6 }}>
              The memory is now this version. They do not know it moved.
            </p>
            <ul className="mind-drift-list">
              {distortions.slice().reverse().map((d, i) => (
                <li key={`${d.at}-${i}`}>
                  <span className="mind-tag">{d.kind}</span>
                  <span>{d.note}</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })()}

      {(detail?.forecast || node.forecast) && (
        <p className="mind-forecast">{detail?.forecast?.label ?? node.forecast}</p>
      )}

      {detail?.warrant && (
        <section className="mind-block">
          <p className="field-label">Why they hold this</p>
          <p className="t-caption">{detail.warrant}</p>
        </section>
      )}

      {raw?.synapse && typeof raw.synapse === 'object' && (
        <section className="mind-block">
          <p className="field-label">Synapse</p>
          <div className="mind-meters">
            <Meter
              label="Primed"
              value={Number((raw.synapse as { facilitation?: number }).facilitation ?? 0)}
              hint="How warmed-up this trace is from recent use"
            />
            <Meter
              label="Left in it"
              value={Number((raw.synapse as { resources?: number }).resources ?? 1)}
              hint="How much is left before repetition wears it out"
            />
            <Meter
              label="Stability"
              value={Math.min(1, Number((raw.synapse as { stability?: number }).stability ?? 1) / 12)}
              hint="How structurally durable it has become from rehearsal"
            />
            <Meter
              label="Interference"
              value={Number((raw.synapse as { noise?: number }).noise ?? 0)}
              hint="Accumulated distortion — this is what drives confident errors"
              tone={Number((raw.synapse as { noise?: number }).noise ?? 0) > 0.35 ? 'warn' : undefined}
            />
          </div>
        </section>
      )}

      <dl className="mind-facts">
        <div><dt>Felt as</dt><dd>{node.emotion} ({node.valence >= 0 ? '+' : ''}{node.valence.toFixed(2)} valence, {node.arousal.toFixed(2)} arousal)</dd></div>
        <div><dt>Strength</dt><dd>{node.strength.toFixed(3)} (base-level activation)</dd></div>
        <div><dt>Encountered</dt><dd>{node.useCount}×</dd></div>
        <div><dt>Formed</dt><dd>{new Date(node.encodedAt).toLocaleString()}</dd></div>
        {node.perceivedAt && Math.abs(node.perceivedAt - node.encodedAt) > 36e5 && (
          <div>
            <dt>Feels like</dt>
            <dd>{new Date(node.perceivedAt).toLocaleString()} — the date has drifted</dd>
          </div>
        )}
        {node.lastRetrievedAt && <div><dt>Last recalled</dt><dd>{new Date(node.lastRetrievedAt).toLocaleString()}</dd></div>}
        {node.actors.length > 0 && <div><dt>Who</dt><dd>{node.actors.join(', ')}</dd></div>}
        {node.place && <div><dt>Where</dt><dd>{node.place}</dd></div>}
        {node.tags.length > 0 && <div><dt>Cues</dt><dd>{node.tags.join(' · ')}</dd></div>}
      </dl>

      {detail && detail.neighbors.length > 0 && (
        <section className="mind-block">
          <p className="field-label">Wired to</p>
          <div className="mind-neighbors">
            {detail.neighbors.map((nb) => (
              <button key={nb.id} className="mind-neighbor" onClick={() => onSelect(nb.id)}>
                <i style={{ background: MEMORY_EDGE_COLORS[nb.edge] ?? '#6b7686' }} />
                <span className="mind-neighbor-kind">{nb.edge.replace(/_/g, ' ')}</span>
                <span className="mind-neighbor-gist">{nb.gist}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="btn-row mind-node-actions">
        <button className="btn btn-secondary btn-sm" onClick={() => onPatch(node.id, { pinned: !node.pinned })}>
          <Pin size={13} /> {node.pinned ? 'Unpin' : 'Pin forever'}
        </button>
        {node.status !== 'dormant' ? (
          <button className="btn btn-ghost btn-sm" onClick={() => onPatch(node.id, { forget: true })}>
            Let it fade
          </button>
        ) : (
          <button className="btn btn-ghost btn-sm" onClick={() => onPatch(node.id, { restore: true })}>
            <RotateCcw size={13} /> Bring it back
          </button>
        )}
        <button
          className="btn btn-ghost btn-sm mind-danger"
          onClick={async () => {
            const ok = await confirm({
              title: 'Erase this memory permanently?',
              body: 'This cannot be undone.',
              confirmLabel: 'Erase',
              danger: true,
            });
            if (ok) onPatch(node.id, { delete: true });
          }}
        >
          <Trash2 size={13} /> Erase
        </button>
      </div>
    </div>
  );
}

function Meter({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: 'warn' }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <div className="mind-meter" title={hint}>
      <div className="mind-meter-top">
        <span>{label}</span>
        <span className={tone === 'warn' ? 'mind-warn' : undefined}>{pct}%</span>
      </div>
      <div className="mind-meter-track"><i style={{ width: `${pct}%` }} data-tone={tone} /></div>
    </div>
  );
}

function BudgetPanel({
  graph, limits, onChange,
}: {
  graph: BrainGraph;
  limits: ModelLimits | null;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const maxShare = limits?.maxShare ?? 1 / 3;
  const share = graph.config.shareOfContext;
  const plan = limits?.plan;

  return (
    <section className="mind-block mind-budget">
      <p className="field-label"><Gauge size={13} /> Context budget</p>
      {limits ? (
        <>
          <p className="t-caption">
            {limits.model} · {limits.contextTokens.toLocaleString()} token window
            <span className="mind-src"> ({limits.source})</span>
          </p>
          {plan && (
            <div className="mind-budget-bar" title="How the model's usable context is divided">
              <i className="seg seg-brain" style={{ width: `${(plan.brainBudget / plan.usable) * 100}%` }} />
              <i className="seg seg-history" style={{ width: `${(plan.historyBudget / plan.usable) * 100}%` }} />
            </div>
          )}
          {plan && (
            <p className="t-caption">
              Memory {plan.brainBudget.toLocaleString()} · conversation {plan.historyBudget.toLocaleString()} ·
              ceiling {plan.brainCap.toLocaleString()}
              {plan.saturated ? ' — memory is full and now forgets to stay inside it' : ''}
            </p>
          )}
        </>
      ) : (
        <p className="t-caption">Model window unknown — using a conservative default.</p>
      )}

      <label className="mind-slider">
        <span>Share of context <b>{(share * 100).toFixed(0)}%</b> <em>max {(maxShare * 100).toFixed(0)}%</em></span>
        <input
          type="range"
          min={0}
          max={Math.round(maxShare * 100)}
          value={Math.round(share * 100)}
          onChange={(e) => onChange({ shareOfContext: Number(e.target.value) / 100 })}
        />
      </label>
      <p className="t-caption">
        Memory can never take more than a third of the window — the rest is always the conversation.
        Change model and this refits automatically.
      </p>
    </section>
  );
}

/**
 * How often this mind consolidates, shown right beside the network so the
 * answer to "why is nothing appearing?" is one glance away.
 */
function CadencePanel({
  graph, onChange, busy, onUpdate,
}: {
  graph: BrainGraph;
  onChange: (patch: Record<string, unknown>) => void;
  busy: string;
  onUpdate: (force?: boolean) => void;
}) {
  const every = graph.config.updateEveryMessages;
  const seen = Object.values(graph.stats.cursor ?? {}).reduce((a, b) => Math.max(a, b), 0);

  return (
    <section className="mind-block">
      <p className="field-label"><Activity size={13} /> How often memory forms</p>
      <div className="mind-chips">
        {[1, 2, 4, 6, 10, 20].map((n) => (
          <button
            key={n}
            className={`chip${every === n ? ' active' : ''}`}
            title={n === 1 ? 'One model call per message — most responsive, most expensive' : `A pass every ${n} messages`}
            onClick={() => onChange({ updateEveryMessages: n })}
          >
            {n === 1 ? 'Every msg' : `Every ${n}`}
          </button>
        ))}
      </div>
      <p className="t-caption">
        {graph.config.autoUpdate
          ? `A pass runs in the background every ${every} new ${every === 1 ? 'message' : 'messages'}.`
          : 'Background passes are off — memory only forms when you run one.'}
        {' '}Last pass read up to message {seen}.
      </p>
      <div className="btn-row">
        <button className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => onUpdate(false)}>
          {busy ? <><GlobeLoader size={13} /> {busy}</> : 'Consolidate now'}
        </button>
        <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => onUpdate(true)} title="Read this conversation again from the very start, in chunks">
          Re-read all
        </button>
      </div>
      <p className="t-caption">
        A long conversation is read in several passes — the progress bar at the top shows how far
        it has got, and stopping keeps everything read so far.
      </p>
      <p className="t-caption">
        Only {graph.nodes.length} memories after a long scene? Open the <b>Log</b> tab — each pass
        records how many events were proposed and how many were too forgettable to keep.
      </p>
    </section>
  );
}

/**
 * State of mind — the psyche layer made legible.
 *
 * Two rules, both borrowed from the prompt composer: describe *behaviour* rather
 * than diagnosis, and stay quiet when nothing is off baseline. A settled
 * character shows a single line; a character who has been through something
 * shows why, and what it is doing to them.
 */
function ConditionPanel({ graph }: { graph: BrainGraph }) {
  const p = graph.psyche;
  if (!p) {
    return (
      <section className="panel mind-panel">
        <h2 className="t-label">State of mind</h2>
        <p className="t-caption">
          Nothing yet — this mind was created before the psyche layer existed. It starts
          living through what happens on the next consolidation pass.
        </p>
      </section>
    );
  }

  const bar = (label: string, value: number, hint: string, invert = false) => {
    const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
    // Green when high is good, red when high is bad — the meaning of "full" is
    // not the same for Growth as for Load.
    const tone = invert
      ? (pct > 66 ? 'bad' : pct > 33 ? 'warn' : 'good')
      : (pct > 66 ? 'good' : pct > 33 ? 'warn' : 'bad');
    return (
      // Own class namespace: `mind-meter*` already belongs to the budget meters
      // further up this file, and sharing it silently restyled those too.
      <div className="psyche-meter" key={label} title={hint}>
        <span className="psyche-meter-label">{label}</span>
        <span className="psyche-meter-value">{pct}%</span>
        <span className="psyche-meter-track">
          <span className={`psyche-meter-fill is-${tone}`} style={{ width: `${pct}%` }} />
        </span>
      </div>
    );
  };

  return (
    <section className="panel mind-panel">
      <h2 className="t-label">State of mind</h2>

      {graph.condition.length > 0 ? (
        <ul className="mind-condition">
          {graph.condition.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : (
        <p className="t-caption psyche-prose">Nothing that would show. They are, as far as any of this goes, all right.</p>
      )}

      <div className="psyche-meters">
        {bar('Carrying', p.load.level, 'Allostatic load — accumulated cost of everything so far', true)}
        {bar('Body', 1 - (p.body.sleepDebt * 0.4 + p.body.pain * 0.4 + (1 - p.body.energy) * 0.2),
          'What they physically have left to meet things with')}
        {bar('Safety', p.body.safety, 'Recovery is gated on this — an unsafe character never comes down')}
        {bar('Can name feelings', p.dynamics.granularity,
          'Emotional granularity. Low means they feel "bad" rather than "ashamed"')}
        {bar('Defences', p.defenseMaturity,
          'How grown-up their coping is. Regresses under load, matures with use')}
        {p.condition.growth.severity > 0.05
          && bar('Growth', p.condition.growth.severity, 'Post-traumatic growth — earned, not given')}
      </div>

      {graph.copingStyle && graph.copingStyle !== 'not enough history to say' && (
        <p className="t-caption psyche-prose">Under pressure they default to <b>{graph.copingStyle}</b>.</p>
      )}

      {graph.identity.selfConcept && (
        <>
          <h3 className="sec-h" style={{ marginTop: 14 }}>Who they take themselves to be</h3>
          <p className="t-caption psyche-prose">{graph.identity.selfConcept}.</p>
        </>
      )}
      {graph.identity.lifeStory && graph.identity.arcs.length >= 2 && (
        <p className="t-caption psyche-prose">They tell it as <b>{graph.identity.lifeStory}</b>.</p>
      )}

      {graph.traumaStatus.length > 0 && (
        <>
          <h3 className="sec-h" style={{ marginTop: 14 }}>What is still open</h3>
          <ul className="mind-trauma-list">
            {graph.traumaStatus.map((t) => (
              <li key={t.nodeId}>
                <b>{t.gist.slice(0, 70)}{t.gist.length > 70 ? '…' : ''}</b>
                <span className={`mind-tag is-${t.pathway}`}>{t.pathway}</span>
                <em>{t.status}</em>
                <span className="t-caption">
                  surfaced {t.intrusions}× · faced {t.faced} · pushed away {t.pushedAway}
                </span>
              </li>
            ))}
          </ul>
          <p className="t-caption psyche-prose">
            Facing it in safety integrates it; pushing it away makes it arrive harder next time.
            Neither outcome is set — it depends on what the story lets them do.
          </p>
        </>
      )}

      {graph.bonds.filter((b) => b.ruptures > 0 || b.transferredFrom).length > 0 && (
        <>
          <h3 className="sec-h" style={{ marginTop: 14 }}>Where the relationships stand</h3>
          <ul className="mind-condition">
            {graph.bonds
              .filter((b) => b.ruptures > 0 || b.transferredFrom)
              .slice(0, 6)
              .map((b) => <li key={b.key}>{b.description}</li>)}
          </ul>
        </>
      )}
    </section>
  );
}

function PsycheView({
  graph, limits, onChange, busy, onUpdate, onWipe, onRebuildBaseline,
}: {
  graph: BrainGraph;
  limits: ModelLimits | null;
  onChange: (patch: Record<string, unknown>) => void;
  busy: string;
  onUpdate: (force?: boolean) => void;
  onWipe: () => void;
  onRebuildBaseline: () => void;
}) {
  return (
    <div className="mind-psyche">
      <ConditionPanel graph={graph} />

      {(graph.intention || graph.steer || (graph.working && graph.working.length > 0)) && (
        <section className="panel mind-panel">
          <h2 className="t-label">What they want in this scene</h2>
          {graph.intention ? (
            <div className="mind-intention">
              <div className="mind-intention-head">
                <span className={`mind-tag mind-tag-${graph.intention.kind}`}>{graph.intention.kind}</span>
                {graph.intention.target && <span className="t-caption">→ {graph.intention.target}</span>}
                <span className="t-caption">{graph.intention.ttl} turn{graph.intention.ttl === 1 ? '' : 's'} left</span>
              </div>
              <p className="mind-intention-text">{graph.intention.text}</p>
              <p className="t-caption">{graph.intention.rationale}</p>
              <div className="mind-intention-progress" title="Progress, read off what happened — they do not get to declare this themselves">
                <i style={{
                  left: graph.intention.progress >= 0 ? '50%' : `${50 + graph.intention.progress * 50}%`,
                  width: `${Math.abs(graph.intention.progress) * 50}%`,
                  background: graph.intention.progress >= 0 ? 'var(--accent)' : 'var(--danger)',
                }} />
              </div>
            </div>
          ) : (
            <p className="t-caption">No particular objective right now.</p>
          )}
          {graph.steer && (
            <p className="t-caption mind-steer">
              Steered: {graph.steer.text}
              {graph.steer.prefer ? ` · leaning ${graph.steer.prefer}` : ''}
              {' '}({graph.steer.ttl} turn{graph.steer.ttl === 1 ? '' : 's'} left)
            </p>
          )}
          {graph.working && graph.working.length > 0 && (
            <>
              <p className="field-label" style={{ marginTop: 12 }}>Holding in mind</p>
              <ul className="mind-bullets">
                {graph.working.map((s) => <li key={s.id}>{s.gist}</li>)}
              </ul>
            </>
          )}
        </section>
      )}

      <section className="panel mind-panel">
        <h2 className="t-label">Temperament</h2>
        {graph.dispositionSource !== 'model' && (
          <div className="mind-repair">
            <TriangleAlert size={15} />
            <div>
              <b>
                {graph.dispositionSource === 'none'
                  ? 'No baseline yet — every axis is sitting at dead zero.'
                  : 'Baseline came from card keywords only.'}
              </b>
              <p className="t-caption">
                {graph.dispositionSource === 'none'
                  ? 'This character has no temperament to feel or drift from, so appraisal falls back to neutral. Build it from the card to fix this.'
                  : 'The utility model was unreachable when this mind was created, so only the keyword reader ran. Rebuild for a proper read of the card.'}
              </p>
              <button
                className="btn btn-primary btn-sm"
                disabled={!!busy}
                onClick={onRebuildBaseline}
              >
                <IconAi size={13} /> Build baseline from card
              </button>
            </div>
          </div>
        )}
        <p className="t-caption">
          The small mark is who they were when this conversation began (read from the card). The dot is
          who they are now. What happens here moves them — but never past their own limits, and
          deliberately slowly: expect hundredths per pass, not visible lurches.
        </p>
        <div className="mind-traits">
          {Object.keys(TRAIT_LABEL).map((axis) => {
            const now = graph.traits[axis] ?? 0;
            const base = graph.disposition[axis] ?? 0;
            const [lo, hi] = TRAIT_LABEL[axis];
            const drift = now - base;
            return (
              <div key={axis} className="mind-trait">
                <div className="mind-trait-top">
                  <span>{lo}</span>
                  <b>
                    {axis}
                    <span className="mind-trait-num">
                      {now >= 0 ? '+' : ''}{now.toFixed(3)}
                      {Math.abs(drift) > 0.0005 && (
                        <em>{drift > 0 ? ' ▲' : ' ▼'}{Math.abs(drift).toFixed(3)}</em>
                      )}
                    </span>
                  </b>
                  <span>{hi}</span>
                </div>
                <div className="mind-trait-track">
                  <i className="mind-trait-mid" />
                  <i className="mind-trait-anchor" style={{ left: `${((base + 1) / 2) * 100}%` }} title={`Card disposition ${base.toFixed(2)}`} />
                  <i
                    className="mind-trait-now"
                    style={{ left: `${((now + 1) / 2) * 100}%` }}
                    data-drift={Math.abs(drift) > 0.08 ? (drift > 0 ? 'up' : 'down') : undefined}
                    title={`Now ${now.toFixed(2)}`}
                  />
                </div>
                {Math.abs(drift) > 0.08 && (
                  <span className="mind-trait-drift">
                    {drift > 0 ? '↑' : '↓'} {Math.abs(drift).toFixed(2)} from what happened here
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="panel mind-panel">
        <h2 className="t-label">Working self</h2>
        <p className="t-caption">Active goals gate what they notice and what comes back to them.</p>
        {graph.workingSelf.goals.filter((g) => g.status === 'active').length === 0 && (
          <p className="t-caption">No active goals recorded yet.</p>
        )}
        <ul className="mind-goals">
          {graph.workingSelf.goals.map((g) => (
            <li key={g.id} data-status={g.status}>
              <i style={{ width: `${g.priority * 100}%` }} />
              <span>{g.text}</span>
              <em>{g.status}</em>
            </li>
          ))}
        </ul>
        {graph.workingSelf.selfImages.length > 0 && (
          <>
            <p className="field-label" style={{ marginTop: 12 }}>Self-image</p>
            <ul className="mind-bullets">
              {graph.workingSelf.selfImages.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </>
        )}
        {graph.workingSelf.concerns.length > 0 && (
          <>
            <p className="field-label" style={{ marginTop: 12 }}>Always on their mind</p>
            <p className="t-caption">{graph.workingSelf.concerns.join(' · ')}</p>
          </>
        )}
      </section>

      <section className="panel mind-panel">
        <h2 className="t-label"><Users size={14} /> People</h2>
        {graph.people.length === 0 && <p className="t-caption">They have not formed a view of anyone yet.</p>}
        <div className="mind-people">
          {graph.people
            .slice()
            .sort((a, b) => b.interactions - a.interactions)
            .map((p) => (
              <div key={p.key} className="mind-person">
                <div className="mind-person-head">
                  <b>{p.displayName}</b>
                  <span className="t-caption">{p.interactions} shared moments</span>
                </div>
                <div className="mind-person-axes">
                  {([
                    ['trust', p.trust], ['affection', p.affection], ['respect', p.respect],
                    ['fear', p.fear], ['resentment', p.resentment],
                  ] as [string, number][]).map(([label, v]) => (
                    <div key={label} className="mind-axis" title={`${label} ${v.toFixed(2)}`}>
                      <span>{label}</span>
                      <div className="mind-axis-track">
                        <i
                          style={{
                            left: v >= 0 ? '50%' : `${50 + v * 50}%`,
                            width: `${Math.abs(v) * 50}%`,
                            background: v >= 0 ? 'var(--accent)' : 'var(--danger)',
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
        </div>
      </section>

      <section className="panel mind-panel">
        <h2 className="t-label">How memory behaves</h2>
        <p className="t-caption">These settings apply to this character in this conversation only.</p>
        <BudgetPanel graph={graph} limits={limits} onChange={onChange} />

        <label className="mind-slider">
          <span>Consolidate every <b>{graph.config.updateEveryMessages}</b> messages</span>
          <input
            type="range" min={1} max={40}
            value={graph.config.updateEveryMessages}
            onChange={(e) => onChange({ updateEveryMessages: Number(e.target.value) })}
          />
        </label>
        <p className="t-caption">
          Memory forms offline, in batches — like sleep. Lower is more responsive and costs more model calls.
        </p>

        <div className="mind-switches">
          {([
            ['enabled', 'Memory active', 'Turn off and this character behaves in this chat as they did before they had a brain.'],
            ['autoUpdate', 'Consolidate automatically', 'Run a pass in the background as this conversation grows.'],
            ['traumaEnabled', 'Allow trauma encoding', 'Extreme, uncontrollable events form a separate sensory trace that resists forgetting.'],
            ['intrusionsEnabled', 'Allow intrusions', 'Traumatic traces can surface unbidden when something in the scene matches them.'],
          ] as [keyof BrainGraph['config'], string, string][]).map(([key, label, hint]) => (
            <label key={String(key)} className="mind-switch" title={hint}>
              <input
                type="checkbox"
                checked={Boolean(graph.config[key])}
                onChange={(e) => onChange({ [key]: e.target.checked })}
              />
              <span>
                <b>{label}</b>
                <em>{hint}</em>
              </span>
            </label>
          ))}
        </div>

        <p className="field-label" style={{ marginTop: 14 }}>Run a pass now</p>
        <div className="mind-run">
          <button className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => onUpdate(false)}>
            {busy ? <><GlobeLoader size={13} /> {busy}</> : 'Consolidate new messages'}
          </button>
          <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => onUpdate(true)} title="Re-read this conversation from the very start">
            Re-read all
          </button>
        </div>
        <p className="t-caption">
          Last pass: {graph.stats.lastUpdateAt ? new Date(graph.stats.lastUpdateAt).toLocaleString() : 'never'} ·
          {' '}{graph.stats.updates} total · {graph.stats.totalEncoded} formed · {graph.stats.totalPruned} lost ·
          {' '}{graph.stats.totalRecalls} recalls
        </p>

        <div className="btn-row" style={{ marginTop: 14 }}>
          <button className="btn btn-ghost btn-sm mind-danger" onClick={onWipe}>
            <Trash2 size={13} /> Erase this mind
          </button>
        </div>
      </section>
    </div>
  );
}

function StoryView({
  graph, idle, onSelect,
}: {
  graph: BrainGraph;
  idle: BrainAuditEntry[];
  onSelect: (id: string) => void;
}) {
  const chapters = useMemo(() => {
    const byChapter = new Map<string, BrainGraphNode[]>();
    for (const n of graph.nodes) {
      const key = n.chapterId ?? '__loose__';
      byChapter.set(key, [...(byChapter.get(key) ?? []), n]);
    }
    const rows = graph.chapters.map((c) => ({
      id: c.id,
      title: c.title,
      startedAt: c.startedAt,
      endedAt: c.endedAt,
      nodes: (byChapter.get(c.id) ?? []).sort((a, b) => a.encodedAt - b.encodedAt),
    }));
    const loose = byChapter.get('__loose__') ?? [];
    if (loose.length) {
      rows.push({
        id: '__loose__',
        title: 'Unfiled',
        startedAt: Math.min(...loose.map((n) => n.encodedAt)),
        endedAt: undefined,
        nodes: loose.sort((a, b) => a.encodedAt - b.encodedAt),
      });
    }
    /**
     * Newest chapter first, like the log and the idle strip above it.
     *
     * `nodes` stays in encoding order because the emotional band below reads as a
     * trace — left to right is past to present, and flipping it would draw the
     * arc backwards. Only the list under it is reversed, at the point of render.
     */
    return rows.sort((a, b) => b.startedAt - a.startedAt);
  }, [graph]);

  return (
    <div className="mind-story">
      {idle.length > 0 && (
        <section className="mind-idle-strip">
          <h2 className="t-label">Idle mind</h2>
          <p className="t-caption">
            What happened in their head between turns. Most ticks do nothing; the ones below did not.
          </p>
          <ol className="mind-idle-list">
            {idle.slice(0, 8).map((e) => (
              <li key={e.id}>
                <span className="mind-log-time">{new Date(e.at).toLocaleString()}</span>
                <span>{e.summary}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      {chapters.map((ch) => (
        <section key={ch.id} className="mind-chapter">
          <header className="mind-chapter-head">
            <h2 className="t-label">{ch.title}</h2>
            <span className="t-caption">
              {new Date(ch.startedAt).toLocaleDateString()}
              {ch.endedAt ? ` – ${new Date(ch.endedAt).toLocaleDateString()}` : ' – now'} · {ch.nodes.length} memories
            </span>
          </header>
          <div className="mind-emoband" title="Emotional trace across this stretch">
            {ch.nodes.map((n) => (
              <i
                key={n.id}
                style={{
                  background: n.valence >= 0
                    ? `hsl(${38 + n.valence * 22} ${(20 + Math.abs(n.valence) * 55).toFixed(0)}% 50%)`
                    : `hsl(${352 + n.valence * 14} ${(20 + Math.abs(n.valence) * 55).toFixed(0)}% 50%)`,
                  height: `${18 + n.arousal * 26}px`,
                  opacity: n.status === 'dormant' ? 0.2 : n.status === 'faded' ? 0.5 : 1,
                }}
                onClick={() => onSelect(n.id)}
                title={`${n.gist} — ${n.emotion}`}
              />
            ))}
          </div>
          <ul className="mind-chapter-list">
            {/* Newest first — and so the 40 shown are the newest 40, not the oldest. */}
            {ch.nodes.slice().reverse().slice(0, 40).map((n) => (
              <li key={n.id}>
                <button onClick={() => onSelect(n.id)} data-status={n.status}>
                  <span className={`mind-tag mind-tag-${n.kind}`}>{KIND_LABEL[n.kind] ?? n.kind}</span>
                  {n.drifted && <span className="mind-tag mind-tag-drift">drifted</span>}
                  <span className="mind-chapter-gist">{n.gist}</span>
                  <span className="t-caption">{new Date(n.encodedAt).toLocaleDateString()}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {!chapters.length && <p className="t-caption" style={{ padding: 20 }}>No chapters yet.</p>}
    </div>
  );
}

function LogView({ entries }: { entries: BrainAuditEntry[] }) {
  return (
    <div className="mind-log">
      <p className="t-caption" style={{ padding: '0 4px 10px' }}>
        Every change the memory engine made, and why. Nothing happens to a character's mind that you cannot audit.
      </p>
      {!entries.length && <p className="t-caption">No passes recorded yet.</p>}
      {entries.map((e) => (
        <div key={e.id} className={`mind-log-row mind-log-${e.kind}`}>
          <span className="mind-log-time">{new Date(e.at).toLocaleString()}</span>
          <span className={`mind-tag mind-tag-${e.kind}`}>{e.kind}</span>
          <span className="mind-log-summary">{e.summary}</span>
        </div>
      ))}
    </div>
  );
}
