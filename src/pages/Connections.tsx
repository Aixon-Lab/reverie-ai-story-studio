/** Connections page — deep link; day-to-day API/preset/lore edits use top-bar drawers. */
import { useApp } from '../store';

export function Connections() {
  const { setDrawer } = useApp();
  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: '40px 35px' }}>
      <div style={{ maxWidth: 560 }}>
        <h1 className="t-display-md" style={{ marginBottom: 10 }}>Connections</h1>
        <p className="t-body-lg t-faint" style={{ marginBottom: 24 }}>
          API keys, models, presets, formatting, and world info stay one click away from chat via the top bar.
          Open a drawer without leaving your conversation.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-start' }}>
          <button className="btn btn-primary" onClick={() => setDrawer('api')}>Open API drawer</button>
          <button className="btn btn-secondary" onClick={() => setDrawer('preset')}>Open Preset & Tune</button>
          <button className="btn btn-secondary" onClick={() => setDrawer('formatting')}>Open Formatting</button>
          <button className="btn btn-secondary" onClick={() => setDrawer('worldinfo')}>Open World Info</button>
          <button className="btn btn-secondary" onClick={() => setDrawer('persona')}>Open Persona</button>
        </div>
      </div>
    </div>
  );
}
