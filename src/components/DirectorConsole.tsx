/** Director console — nudge with intensity, scene goal, cut-to, narrator beat, genesis.
 *  `compact` = right-rail layout; default = chat overlay card. */
import { useState } from 'react';
import type { ChatMeta, DirectorState } from '@shared/types';

const PREFER: { id: NonNullable<DirectorState['prefer']>; label: string }[] = [
  { id: 'pursue', label: 'Pursue' },
  { id: 'repair', label: 'Repair' },
  { id: 'confront', label: 'Confront' },
  { id: 'conceal', label: 'Conceal' },
  { id: 'withdraw', label: 'Withdraw' },
  { id: 'test', label: 'Test' },
  { id: 'endure', label: 'Endure' },
  { id: 'enjoy', label: 'Enjoy' },
];

export function DirectorConsole({ meta, onSave, onNarrate, onGenesis, compact = false }: {
  meta: ChatMeta;
  onSave: (d: DirectorState) => Promise<void>;
  onNarrate: () => void;
  onGenesis?: (hint: string) => Promise<void>;
  compact?: boolean;
}) {
  const [nudge, setNudge] = useState(meta.director?.nudge?.text ?? '');
  const [intensity, setIntensity] = useState<1 | 2 | 3 | 4 | 5>(meta.director?.nudge?.intensity ?? 3);
  const [goal, setGoal] = useState(meta.director?.sceneGoal?.text ?? '');
  const [cutTo, setCutTo] = useState('');
  const [prefer, setPrefer] = useState<DirectorState['prefer']>(meta.director?.prefer);
  const [genesisHint, setGenesisHint] = useState('');
  const [saved, setSaved] = useState(false);

  async function apply() {
    const d: DirectorState = {
      nudge: nudge.trim() ? { text: nudge.trim(), intensity, setAtMessage: 0 } : undefined,
      sceneGoal: goal.trim() ? { text: goal.trim(), status: 'active' } : undefined,
      cutTo: cutTo.trim() || undefined,
      prefer,
    };
    await onSave(d);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  const body = (
    <>
      <div className={compact ? 'director-stack' : 'director-grid'}>
        <div>
          <label className="field-label">Stage Direction (invisible to the characters)</label>
          <input
            className="input"
            value={nudge}
            onChange={(e) => setNudge(e.target.value)}
            placeholder="e.g. A storm knocks the power out mid-sentence"
          />
          <div className="director-intensity">
            <span className="t-caption">Intensity</span>
            {([1, 2, 3, 4, 5] as const).map((i) => (
              <button
                key={i}
                type="button"
                className="intensity-dot"
                data-on={i <= intensity || undefined}
                onClick={() => setIntensity(i)}
                aria-label={`Intensity ${i}`}
              />
            ))}
            <span className="t-caption">
              {intensity <= 2 ? 'A seed, planted quietly' : intensity <= 4 ? 'Weave it in soon' : 'Happens now'}
            </span>
          </div>
        </div>
        <div>
          <label className="field-label">Standing Scene Goal</label>
          <input
            className="input"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. The heist must go wrong"
          />
          <label className="field-label" style={{ marginTop: 10 }}>What they should reach for</label>
          <div className="director-prefer">
            <button
              type="button"
              className={`chip${!prefer ? ' active' : ''}`}
              onClick={() => setPrefer(undefined)}
            >
              Let them decide
            </button>
            {PREFER.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`chip${prefer === p.id ? ' active' : ''}`}
                onClick={() => setPrefer(prefer === p.id ? undefined : p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="t-caption">Biases their objective. A terrified character told to confront will still withdraw.</p>
          <label className="field-label" style={{ marginTop: 10 }}>Cut To</label>
          <input
            className="input"
            value={cutTo}
            onChange={(e) => setCutTo(e.target.value)}
            placeholder="e.g. The docks, later that night"
          />
        </div>
      </div>
      <div className="director-actions">
        <button className="btn btn-primary btn-sm" onClick={apply}>
          {saved ? 'Applied ✓' : 'Apply Direction'}
        </button>
        <button className="btn btn-secondary btn-sm" onClick={onNarrate}>
          Narrator Beat
        </button>
        {onGenesis && (
          <>
            <input
              className="input"
              style={{ flex: 1, minWidth: 140 }}
              value={genesisHint}
              onChange={(e) => setGenesisHint(e.target.value)}
              placeholder="Genesis: who enters & why?"
              title="Requires Genesis ON under Members"
            />
            <button
              className="btn btn-secondary btn-sm"
              disabled={!genesisHint.trim()}
              onClick={() => onGenesis(genesisHint.trim())}
              title="Draft a new character into the scene (Genesis)"
            >
              Genesis
            </button>
          </>
        )}
      </div>
    </>
  );

  if (compact) {
    return <div className="director-compact">{body}</div>;
  }

  return (
    <div className="glass-float director-float">
      {body}
    </div>
  );
}
