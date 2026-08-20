/** API connection drawer — text + image providers without leaving chat. */
import { useEffect, useState } from 'react';
import type { PinnedModel, TextConnection } from '@shared/types';
import { MAX_PINNED_MODELS } from '@shared/types';
import { api } from '../../api';
import { ModelPicker } from '../ModelPicker';
import { shortModelName } from '../PinnedModelSwitch';
import { useApp } from '../../store';
import { DrawerHeader } from './DrawerHost';
import { GlobeLoader } from '../GlobeLoader';

const TEXT_PROVIDERS = [
  { id: 'openrouter', label: 'OpenRouter', defaultModel: 'anthropic/claude-sonnet-4.5' },
  { id: 'anthropic', label: 'Anthropic', defaultModel: 'claude-sonnet-4-5' },
  { id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.2' },
  { id: 'google', label: 'Google', defaultModel: 'gemini-3-pro' },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', defaultModel: '' },
] as const;

export function ApiDrawer({ onClose }: { onClose: () => void }) {
  const { settings, secretKeys, saveSettings, loadAll } = useApp();
  const [keyInput, setKeyInput] = useState('');
  const [imageKey, setImageKey] = useState('');
  const [catalog, setCatalog] = useState<Record<string, { label: string; models: string[] }>>({});
  const [status, setStatus] = useState('');
  const [textCatalogKey, setTextCatalogKey] = useState(0);
  const [imageCatalogKey, setImageCatalogKey] = useState(0);
  const pinned: PinnedModel[] = settings?.pinnedModels ?? [];

  /** One writer for the list, so the cap cannot be bypassed by a caller. */
  async function savePins(next: PinnedModel[]) {
    await saveSettings({ pinnedModels: next.slice(0, MAX_PINNED_MODELS) });
  }

  useEffect(() => {
    api.imageCatalog().then(setCatalog).catch(() => {});
  }, []);

  if (!settings) return null;

  const textKeyName = `text.${settings.textConnection.provider}.apiKey`;
  const hasKey = secretKeys.includes(textKeyName) || settings.textConnection.provider === 'custom';
  const imageKeyName = settings.imageConnection.provider ? `image.${settings.imageConnection.provider}.apiKey` : '';
  const hasImageKey = Boolean(imageKeyName && secretKeys.includes(imageKeyName));

  async function flash(msg: string) {
    setStatus(msg);
    setTimeout(() => setStatus(''), 1600);
  }

  return (
    <>
      <DrawerHeader title="API Connections" onClose={onClose} />
      <div className="drawer-body">
        <p className="t-section" style={{ marginBottom: 10 }}>Text LLM</p>
        <label className="field-label">Provider</label>
        <select
          className="input"
          value={settings.textConnection.provider}
          onChange={(e) => {
            const provider = e.target.value as typeof settings.textConnection.provider;
            const def = TEXT_PROVIDERS.find((p) => p.id === provider)?.defaultModel ?? '';
            void saveSettings({
              textConnection: {
                ...settings.textConnection,
                provider,
                model: def || settings.textConnection.model,
              },
            });
          }}
        >
          {TEXT_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>

        {/* Pins first: the fastest path through this drawer is "switch back". */}
        {pinned.length > 0 && (
          <div className="pinned-models">
            <label className="field-label">Pinned · one click in the chat header</label>
            <div className="pinned-models-row">
              {pinned.map((p) => {
                const active = p.provider === settings.textConnection.provider
                  && p.model === settings.textConnection.model;
                return (
                  <span key={`${p.provider}:${p.model}`} className={`pinned-model-chip${active ? ' is-active' : ''}`}>
                    <button
                      type="button"
                      className="pinned-model-use"
                      title={`Use ${p.model}${p.reasoningEffort ? ` · ${p.reasoningEffort}` : ''}`}
                      onClick={() => void saveSettings({
                        textConnection: {
                          ...settings.textConnection,
                          provider: p.provider,
                          model: p.model,
                          reasoningEffort: p.reasoningEffort ?? null,
                        },
                      })}
                    >
                      {shortModelName(p.model, p.label)}
                      {p.reasoningEffort && <em>{p.reasoningEffort}</em>}
                    </button>
                    <button
                      type="button"
                      className="pinned-model-x"
                      title="Unpin"
                      aria-label={`Unpin ${p.model}`}
                      onClick={() => void savePins(pinned.filter((x) => !(x.provider === p.provider && x.model === p.model)))}
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          </div>
        )}

        <label className="field-label" style={{ marginTop: 12 }}>Model</label>
        <ModelPicker
          provider={settings.textConnection.provider}
          kind="text"
          value={settings.textConnection.model}
          refreshKey={textCatalogKey + (hasKey ? 1 : 0)}
          effort={settings.textConnection.reasoningEffort ?? null}
          onEffortChange={(reasoningEffort) => void saveSettings({
            textConnection: { ...settings.textConnection, reasoningEffort },
          })}
          isPinned={(id) => pinned.some(
            (p) => p.provider === settings.textConnection.provider && p.model === id,
          )}
          pinLimitReached={pinned.length >= MAX_PINNED_MODELS}
          onTogglePin={(m) => {
            const provider = settings.textConnection.provider;
            const already = pinned.some((p) => p.provider === provider && p.model === m.id);
            if (already) {
              void savePins(pinned.filter((p) => !(p.provider === provider && p.model === m.id)));
              return;
            }
            if (pinned.length >= MAX_PINNED_MODELS) return;
            void savePins([
              ...pinned,
              {
                provider,
                model: m.id,
                label: m.name && m.name !== m.id ? m.name : undefined,
                // Pin the effort only when it is the one in force for this model.
                reasoningEffort: settings.textConnection.model === m.id
                  ? settings.textConnection.reasoningEffort ?? null
                  : null,
              },
            ]);
          }}
          onChange={(model, info) => void saveSettings({
            textConnection: {
              ...settings.textConnection,
              model,
              /**
               * A stored effort is meaningless on a model that does not accept
               * it, and worse than meaningless if the new model has different
               * levels — so switching model clears it unless the level survives.
               */
              reasoningEffort: (() => {
                const cur = settings.textConnection.reasoningEffort;
                if (!cur) return null;
                const levels = info?.reasoning?.supportedEfforts;
                if (!info) return cur; // typed a custom id: leave the user's setting alone
                return levels?.includes(cur) ? cur : null;
              })(),
            },
          })}
        />

        <ZdrNotice
          provider={settings.textConnection.provider}
          baseUrl={settings.textConnection.baseUrl}
        />

        {(settings.textConnection.provider === 'custom' || settings.textConnection.provider === 'openrouter') && (
          <>
            <label className="field-label" style={{ marginTop: 12 }}>Base URL</label>
            <input
              className="input"
              value={settings.textConnection.baseUrl ?? ''}
              onChange={(e) => void saveSettings({ textConnection: { ...settings.textConnection, baseUrl: e.target.value } })}
              placeholder="https://…"
            />
          </>
        )}

        <label className="field-label" style={{ marginTop: 12 }}>
          API Key {hasKey ? <span style={{ color: 'var(--accent)' }}>· set</span> : <span style={{ color: 'var(--danger)' }}>· missing</span>}
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input" type="password" placeholder={hasKey ? '••••••••' : 'Paste key'} value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
          <button className="btn btn-secondary btn-sm" disabled={!keyInput} onClick={async () => {
            await api.setSecret(textKeyName, keyInput);
            setKeyInput('');
            await loadAll();
            setTextCatalogKey((n) => n + 1);
            flash('Key saved');
          }}>Save</button>
        </div>

        {/*
          Background models. Neither is required, and both fall back to the main
          model, so this section can be ignored entirely without anything
          breaking — which is why it sits below the connection that must be set.
        */}
        <p className="t-section" style={{ margin: '22px 0 6px' }}>Background models</p>
        <p className="t-caption" style={{ marginBottom: 10 }}>
          Work that is not the roleplay reply: reading memory, deriving temperament, picking who
          speaks next, proofreading. Leave both unset to run everything on your main model.
        </p>

        <BackgroundModel
          label="Utility model"
          hint="Used for all background work. Falls back to your main model."
          conn={settings.utilityConnection ?? null}
          onChange={(utilityConnection) => void saveSettings({ utilityConnection })}
        />

        <BackgroundModel
          label="Cheap model"
          hint={'Tried FIRST for structured work (memory encoding, trait reading). If it returns '
            + 'something unusable, the utility model is retried automatically — so a weak model '
            + 'here costs quality nothing and saves most of the spend.'}
          conn={settings.cheapConnection ?? null}
          onChange={(cheapConnection) => void saveSettings({ cheapConnection })}
        />

        <p className="t-section" style={{ margin: '22px 0 10px' }}>Image</p>
        <label className="field-label">Provider</label>
        <select
          className="input"
          value={settings.imageConnection.provider ?? ''}
          onChange={(e) => {
            const provider = (e.target.value || null) as typeof settings.imageConnection.provider;
            const models = provider ? catalog[provider]?.models ?? [] : [];
            void saveSettings({
              imageConnection: { provider, model: models[0] ?? '', baseUrl: settings.imageConnection.baseUrl },
            });
          }}
        >
          <option value="">None (prompt card fallback)</option>
          {Object.entries(catalog).map(([id, c]) => <option key={id} value={id}>{c.label}</option>)}
        </select>
        {settings.imageConnection.provider && (
          <>
            <label className="field-label" style={{ marginTop: 12 }}>Model</label>
            <ModelPicker
              provider={settings.imageConnection.provider}
              kind="image"
              value={settings.imageConnection.model}
              refreshKey={imageCatalogKey + (hasImageKey ? 1 : 0)}
              onChange={(model) => void saveSettings({
                imageConnection: { ...settings.imageConnection, model },
              })}
            />
            <ZdrNotice
              provider={settings.imageConnection.provider}
              baseUrl={settings.imageConnection.baseUrl}
            />
            <label className="field-label" style={{ marginTop: 12 }}>
              API Key {hasImageKey ? <span style={{ color: 'var(--accent)' }}>· set</span> : <span style={{ color: 'var(--ink-muted)' }}>· optional / missing</span>}
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="input" type="password" value={imageKey} onChange={(e) => setImageKey(e.target.value)} placeholder="Paste key" />
              <button className="btn btn-secondary btn-sm" disabled={!imageKey || !imageKeyName} onClick={async () => {
                await api.setSecret(imageKeyName, imageKey);
                setImageKey('');
                await loadAll();
                setImageCatalogKey((n) => n + 1);
                flash('Image key saved');
              }}>Save</button>
            </div>
          </>
        )}

        <LocalVisionSection />

        {status && <p className="t-caption" style={{ marginTop: 14, color: 'var(--accent)' }}>{status}</p>}
      </div>
    </>
  );
}

/**
 * On-device image scanning.
 *
 * Portraits are described by a small VLM running on this machine, so the image
 * itself never reaches a cloud API — only the text it produces does. Strict
 * mode is what turns that from a default into a guarantee: with it on, a
 * missing local model stops the scan instead of quietly uploading the picture.
 */
function LocalVisionSection() {
  const { settings, saveSettings } = useApp();
  const [probe, setProbe] = useState<Awaited<ReturnType<typeof api.localVisionStatus>> | null>(null);
  const [checking, setChecking] = useState(false);

  const lv = settings?.localVision
    ?? { enabled: true, strict: true, maxEdge: 448, idleUnloadMs: 600_000 };

  async function check() {
    setChecking(true);
    try {
      setProbe(await api.localVisionStatus());
    } catch {
      setProbe(null);
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => { void check(); }, []);

  // While the one-time download runs, poll so the bar actually moves.
  const phase = probe?.progress?.phase;
  useEffect(() => {
    if (phase !== 'engine' && phase !== 'weights') return;
    const t = setInterval(() => { void check(); }, 1500);
    return () => clearInterval(t);
  }, [phase]);

  return (
    <>
      <p className="t-section" style={{ margin: '24px 0 10px' }}>Local image scanning</p>

      <label className="mind-switch">
        <input
          type="checkbox"
          checked={lv.enabled}
          onChange={(e) => void saveSettings({ localVision: { ...lv, enabled: e.target.checked } })}
        />
        <span>
          <b>Describe images on this device</b>
          <em>Runs inside Reverie on your CPU — nothing to install. The image never leaves your computer.</em>
        </span>
      </label>

      <label className="mind-switch" style={{ marginTop: 8 }}>
        <input
          type="checkbox"
          checked={lv.strict}
          disabled={!lv.enabled}
          onChange={(e) => void saveSettings({ localVision: { ...lv, strict: e.target.checked } })}
        />
        <span>
          <b>Strict — never fall back to a cloud vision model</b>
          <em>
            {lv.strict
              ? 'If no local model is running, the scan stops. Your image is never uploaded.'
              : 'Warning: without a local model, images WILL be uploaded to your cloud vision provider.'}
          </em>
        </span>
      </label>

      <p className="t-caption" style={{ marginTop: 12, color: 'var(--ink-muted)' }}>
        Model: {probe?.label ?? 'MiniCPM-V 4.6 (1.3B)'} · ~{probe?.approxRamMb ?? 2100} MB RAM while scanning
      </p>

      <label className="field-label" style={{ marginTop: 12 }}>
        Image detail — {lv.maxEdge}px
      </label>
      <input
        type="range"
        min={320}
        max={768}
        step={64}
        value={lv.maxEdge}
        disabled={!lv.enabled}
        onChange={(e) => void saveSettings({ localVision: { ...lv, maxEdge: Number(e.target.value) } })}
      />
      <p className="t-caption" style={{ color: 'var(--ink-muted)' }}>
        Cost scales with area, steeply. 448px scans in seconds; 768px can take minutes and rarely
        adds detail worth having.
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
        <button className="btn btn-secondary btn-sm" disabled={checking} onClick={() => void check()}>
          {checking ? <><GlobeLoader size={13} /> Checking…</> : 'Refresh'}
        </button>
        {probe && !(probe.engineReady && probe.weightsReady) && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={async () => { await api.localVisionWarmup(); void check(); }}
          >
            Download now (~{probe.approxDownloadMb} MB)
          </button>
        )}
        {probe?.engineReady && probe.weightsReady && (
          <span className="t-caption" style={{ color: 'var(--accent)' }}>
            Ready — works offline{probe.running ? ' · loaded' : ''}
          </span>
        )}
      </div>

      {(phase === 'engine' || phase === 'weights') && (
        <p className="t-caption" style={{ marginTop: 10 }}>
          <GlobeLoader size={13} />{' '}
          Downloading {probe?.progress?.file ?? (phase === 'engine' ? 'engine' : 'model')}…{' '}
          {probe?.progress?.receivedMb != null
            ? `${probe.progress.receivedMb}${probe.progress.totalMb ? ` / ${probe.progress.totalMb}` : ''} MB`
            : ''}
        </p>
      )}

      {probe?.progress?.phase === 'error' && (
        <p className="t-caption" style={{ marginTop: 10, color: 'var(--danger, #c00)' }}>
          {probe.progress.error}
        </p>
      )}

      {probe && !(probe.engineReady && probe.weightsReady) && probe.setup && (
        <p className="t-caption" style={{ marginTop: 10, color: 'var(--ink-muted)' }}>{probe.setup}</p>
      )}
    </>
  );
}

/**
 * An optional secondary connection.
 *
 * Shares the main provider's API key by design: these are alternate *models*,
 * not alternate accounts, and asking for a second key to use a cheaper model on
 * the same provider would stop most people bothering.
 */
function BackgroundModel({
  label, hint, conn, onChange,
}: {
  label: string;
  hint: string;
  conn: TextConnection | null;
  onChange: (conn: TextConnection | null) => void;
}) {
  const enabled = !!conn?.model?.trim();
  const provider = conn?.provider ?? 'openrouter';

  return (
    <div className="bg-model">
      <label className="mind-switch">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked ? { provider, model: '' } : null)}
        />
        <span>
          <b>{label}</b>
          <em>{hint}</em>
        </span>
      </label>

      {conn && (
        <div className="bg-model-fields">
          <select
            className="input"
            value={conn.provider}
            onChange={(e) => onChange({ ...conn, provider: e.target.value as TextConnection['provider'], model: '' })}
          >
            {TEXT_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
          <ModelPicker
            provider={conn.provider}
            kind="text"
            value={conn.model}
            onChange={(model) => onChange({ ...conn, model })}
          />
          <ZdrNotice provider={conn.provider} baseUrl={conn.baseUrl} />
        </div>
      )}
    </div>
  );
}

/**
 * States the enforcement where the provider is chosen.
 *
 * A privacy guarantee the user cannot see is a guarantee they have to take on
 * faith. This says exactly what is sent and what happens when a model cannot
 * satisfy it, so "why did that model just fail" has an answer in the same place
 * the model was picked.
 */
function ZdrNotice({ provider, baseUrl }: { provider: string; baseUrl?: string }) {
  // Matches the server rule: enforcement follows the destination host, so a
  // `custom` connection aimed at OpenRouter is covered and says so.
  const isOpenRouter =
    provider === 'openrouter' || /(^|\.)openrouter\.ai/i.test(baseUrl ?? '');
  if (!isOpenRouter) return null;

  return (
    <div className="zdr-notice">
      <span className="zdr-badge">ZDR enforced</span>
      <p className="t-caption">
        Every request to OpenRouter is sent with{' '}
        <code>provider: {'{'} zdr: true, data_collection: "deny" {'}'}</code>, so it can only be
        routed to endpoints that keep nothing. This is applied in code on each call — it does not
        depend on your account settings or on which key is pasted above.
      </p>
      <p className="t-caption t-faint">
        If a model has no zero-retention provider, the request fails and nothing is sent. Pick
        another model rather than turning this off; it cannot be turned off.
      </p>
    </div>
  );
}
