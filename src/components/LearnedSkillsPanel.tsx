import { useMemo, useState } from 'react';
import { learningStage, type LearnedTechnique } from '../../shared/brain/learning';

export function LearnedSkillsPanel({ techniques, characterName, onMute }: {
  techniques: LearnedTechnique[];
  characterName: string;
  onMute: (id: string, muted: boolean) => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const replaced = new Set(techniques.filter(t => !t.muted).map(t => t.supersedes));
  const groups = useMemo(() => {
    const map = new Map<string, LearnedTechnique[]>();
    const q = query.trim().toLocaleLowerCase();
    for (const t of techniques) {
      if (q && !`${t.skill} ${t.domain} ${t.technique} ${t.when} ${t.outcome}`.toLocaleLowerCase().includes(q)) continue;
      const items = map.get(t.skill) ?? [];
      items.push(t); map.set(t.skill, items);
    }
    return [...map].sort(([a], [b]) => a.localeCompare(b));
  }, [techniques, query]);
  return <div className="mind-learning">
    <section className="mind-block">
      <h2 className="t-label">What {characterName} has learned here</h2>
      <p className="t-caption">Specific techniques gained in this conversation. Lessons become practice only when the story shows an attempt; successful attempts build experience. Your shared Skills library remains available separately.</p>
      <input className="input" aria-label="Search learned skills" placeholder="Search a skill, technique, or condition…"
        value={query} onChange={e => setQuery(e.target.value)} />
      {error && <p role="alert" className="t-caption">{error}</p>}
    </section>
    {!techniques.length && <section className="mind-block"><p>No techniques learned yet. Teaching, observation, practice, and corrections are recorded as memory forms. Use “Read this conversation” to revisit earlier lessons.</p></section>}
    {!!techniques.length && !groups.length && <p className="t-caption">No matching techniques.</p>}
    {groups.map(([skill, items]) => <section className="mind-block" key={skill}>
      <h3 className="t-label">{skill} <span className="t-caption">· {items.length} technique{items.length === 1 ? '' : 's'}</span></h3>
      {items.map(t => <article key={t.id} className="learned-technique">
        <div className="btn-row"><span className="chip">{t.domain}</span><span className="chip">{learningStage(t)}</span>
          {replaced.has(t.id) && <span className="chip">Updated by a correction</span>}
          {t.muted && <span className="chip">Muted</span>}
        </div>
        <p><strong>{t.technique}</strong></p>
        <p className="t-caption">When: {t.when}</p>
        {t.outcome && <p className="t-caption">Observed result: {t.outcome}</p>}
        <details><summary className="t-caption">Learning history · {t.evidence.length} source{t.evidence.length === 1 ? '' : 's'}</summary>
          {t.evidence.map((e, i) => <blockquote key={`${e.messageId}-${i}`}>
            <span className="t-caption">{e.mode} · recorded {new Date(e.at).toLocaleDateString()}</span>
            <p>{e.quote}</p>
            {e.outcome && <p className="t-caption">Result: {e.outcome}</p>}
          </blockquote>)}
        </details>
        <button className="btn btn-ghost btn-sm" disabled={!!busy} onClick={async () => {
          setBusy(t.id); setError('');
          try { await onMute(t.id, !t.muted); } catch (e) { setError(e instanceof Error ? e.message : 'Could not update technique.'); }
          finally { setBusy(''); }
        }}>{busy === t.id ? 'Saving…' : t.muted ? 'Use in replies' : 'Mute in replies'}</button>
      </article>)}
    </section>)}
  </div>;
}
