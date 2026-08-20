/**
 * Searchable model catalog — live provider lists, ranked, with the numbers that
 * decide a choice on the row itself: price per million, context window, the
 * Artificial Analysis intelligence score when the provider publishes one, and
 * the reasoning-effort levels the model accepts.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pin, PinOff, Sparkles, RefreshCw } from 'lucide-react';
import { GlobeLoader } from './GlobeLoader';
import { api, type ModelInfo } from '../api';
import {
  formatContext, rankModels, variantsByBase, type ModelSortKey,
} from '@shared/modelCatalog';

interface Props {
  provider: string;
  kind: 'text' | 'image';
  value: string;
  onChange: (modelId: string, model?: ModelInfo) => void;
  /** Bump to force refetch (e.g. after saving a key). */
  refreshKey?: number;
  disabled?: boolean;
  /** Current reasoning effort, when the host stores one. */
  effort?: string | null;
  onEffortChange?: (effort: string | null) => void;
  /** Pinning is only offered where the host can persist it. */
  isPinned?: (modelId: string) => boolean;
  onTogglePin?: (model: ModelInfo) => void;
  pinLimitReached?: boolean;
}

function shortEffort(effort: string): string {
  return effort.length > 7 ? effort.slice(0, 7) : effort;
}

export function ModelPicker({
  provider, kind, value, onChange, refreshKey = 0, disabled,
  effort, onEffortChange, isPinned, onTogglePin, pinLimitReached,
}: Props) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [source, setSource] = useState<'live' | 'cache' | 'fallback' | ''>('');
  const [warn, setWarn] = useState('');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [remoteQ, setRemoteQ] = useState('');
  const [localRefresh, setLocalRefresh] = useState(0);
  const [sort, setSort] = useState<ModelSortKey>('relevance');
  const [freeOnly, setFreeOnly] = useState(false);
  const [reasoningOnly, setReasoningOnly] = useState(false);
  const [showAllVariants, setShowAllVariants] = useState(false);
  const forceRefreshRef = useRef(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const useRemoteSearch = provider === 'openrouter' || provider === 'fal';

  useEffect(() => {
    if (!provider || disabled) return;
    let cancelled = false;
    const refresh = forceRefreshRef.current;
    forceRefreshRef.current = false;
    setLoading(true);
    api.listModels({ provider, kind, q: remoteQ || undefined, refresh })
      .then((res) => {
        if (cancelled) return;
        setModels(res.models);
        setSource(res.source);
        setWarn(res.error ?? '');
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setModels([]);
        setSource('fallback');
        setWarn(err.message);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [provider, kind, remoteQ, refreshKey, localRefresh, disabled]);

  useEffect(() => {
    if (!useRemoteSearch) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const t = query.trim();
      setRemoteQ(t.length >= 2 ? t : '');
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, useRemoteSearch]);

  const selected = useMemo(
    () => models.find((m) => m.id === value) ?? null,
    [models, value],
  );

  /**
   * `:free` / `:batch` / `:thinking` are the same model on different terms, and
   * listing them as siblings triples the catalog for no information — they fold
   * into their base row as chips instead.
   */
  const variantGroups = useMemo(() => variantsByBase(models), [models]);

  const filtered = useMemo(
    () => rankModels(models, { query, sort, freeOnly, reasoningOnly, showAllVariants }),
    [models, query, sort, freeOnly, reasoningOnly, showAllVariants],
  );

  const efforts = selected?.reasoning?.supportedEfforts ?? [];
  const hasScores = models.some((m) => m.intelligenceIndex != null);

  return (
    <div className="model-picker">
      <div className="model-picker-toolbar">
        <input
          className="input"
          placeholder={useRemoteSearch ? 'Search models…' : 'Filter models…'}
          value={query}
          disabled={disabled}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon-only"
          disabled={disabled || loading}
          title="Refresh catalog"
          aria-label="Refresh catalog"
          onClick={() => {
            forceRefreshRef.current = true;
            setLocalRefresh((n) => n + 1);
          }}
        >
          <RefreshCw size={14} />
        </button>
      </div>

      <div className="model-picker-controls">
        <select
          className="input model-picker-sort"
          value={sort}
          disabled={disabled}
          aria-label="Sort models"
          onChange={(e) => setSort(e.target.value as ModelSortKey)}
        >
          <option value="relevance">{query.trim() ? 'Best match' : 'Top rated'}</option>
          <option value="intelligence">Intelligence</option>
          <option value="cheapest">Cheapest</option>
          <option value="context">Biggest context</option>
          <option value="name">Name</option>
        </select>
        <button
          type="button"
          className={`chip model-filter-chip${freeOnly ? ' is-active' : ''}`}
          disabled={disabled}
          onClick={() => setFreeOnly((v) => !v)}
          title="Only models with no per-token charge"
        >
          Free
        </button>
        <button
          type="button"
          className={`chip model-filter-chip${reasoningOnly ? ' is-active' : ''}`}
          disabled={disabled}
          onClick={() => setReasoningOnly((v) => !v)}
          title="Only models that expose reasoning / thinking levels"
        >
          Reasoning
        </button>
        {variantGroups.size > 0 && (
          <button
            type="button"
            className={`chip model-filter-chip${showAllVariants ? ' is-active' : ''}`}
            disabled={disabled}
            onClick={() => setShowAllVariants((v) => !v)}
            title="List :free / :batch / :thinking variants as their own rows"
          >
            Variants
          </button>
        )}
      </div>

      <div className="model-picker-list" role="listbox" aria-label="Models">
        {loading && (
          <p className="t-caption" style={{ padding: 10 }}>
            <GlobeLoader size={14} label="Loading models…" />
          </p>
        )}
        {!loading && !filtered.length && (
          <p className="t-caption" style={{ padding: 10 }}>
            {warn || 'No models match. Clear the filters, or type a custom id below.'}
          </p>
        )}
        {!loading && filtered.map((m) => {
          const active = m.id === value;
          const variants = variantGroups.get(m.id) ?? [];
          const pinned = isPinned?.(m.id) ?? false;
          return (
            <div key={m.id} className={`model-picker-row${active ? ' active' : ''}`}>
              <button
                type="button"
                role="option"
                aria-selected={active}
                className="model-picker-hit"
                disabled={disabled}
                onClick={() => onChange(m.id, m)}
              >
                <span className="model-picker-row-main">
                  <span className="model-picker-row-text">
                    <span className="t-label model-picker-name">
                      {m.name}
                      {m.variant && <span className="model-variant-tag">:{m.variant}</span>}
                    </span>
                    {m.name !== m.id && <span className="t-caption">{m.id}</span>}
                  </span>
                  <span className="model-picker-metrics">
                    {m.intelligenceIndex != null && (
                      <span
                        className="model-metric is-intel"
                        title={[
                          `Artificial Analysis Intelligence Index: ${m.intelligenceIndex}`,
                          m.codingIndex != null ? `Coding: ${m.codingIndex}` : '',
                          m.agenticIndex != null ? `Agentic: ${m.agenticIndex}` : '',
                          'Published by OpenRouter; higher is stronger.',
                        ].filter(Boolean).join('\n')}
                      >
                        <Sparkles size={11} />
                        {Math.round(m.intelligenceIndex)}
                      </span>
                    )}
                    {m.contextTokens != null && (
                      <span
                        className="model-metric"
                        title={`Context window: ${m.contextTokens.toLocaleString()} tokens${
                          m.maxOutputTokens ? `\nMax output: ${m.maxOutputTokens.toLocaleString()} tokens` : ''
                        }`}
                      >
                        {formatContext(m.contextTokens)}
                      </span>
                    )}
                    {m.price && (
                      <span className="model-picker-price" title="Prompt / completion per 1M tokens (USD)">
                        {m.price}
                      </span>
                    )}
                  </span>
                </span>
                {m.description && (
                  <span className="t-caption model-picker-desc">{m.description}</span>
                )}
                {(m.reasoning?.supportedEfforts?.length || variants.length > 0) && (
                  <span className="model-picker-extras">
                    {m.reasoning?.supportedEfforts?.length && (
                      <span
                        className="model-effort-hint"
                        title={[
                          `Reasoning levels: ${m.reasoning.supportedEfforts.join(', ')}`,
                          m.reasoning.defaultEffort ? `Default: ${m.reasoning.defaultEffort}` : '',
                          m.reasoning.mandatory ? 'Always reasons — cannot be switched off.' : '',
                          m.priceReasoningPerM != null
                            ? `Reasoning tokens billed at $${m.priceReasoningPerM.toFixed(2)} / 1M`
                            : '',
                        ].filter(Boolean).join('\n')}
                      >
                        {m.reasoning.supportedEfforts.map(shortEffort).join(' · ')}
                      </span>
                    )}
                    {variants.map((v) => (
                      <span
                        key={v.id}
                        className="model-variant-chip"
                        title={`${v.id}${v.price ? ` — ${v.price}` : ''}`}
                      >
                        :{v.variant}{v.price ? ` ${v.price.replace(' · 1M', '')}` : ''}
                      </span>
                    ))}
                  </span>
                )}
              </button>
              {onTogglePin && (
                <button
                  type="button"
                  className={`model-pin-btn${pinned ? ' is-pinned' : ''}`}
                  disabled={disabled || (!pinned && pinLimitReached)}
                  aria-pressed={pinned}
                  title={
                    pinned
                      ? 'Unpin — removes it from the quick switcher'
                      : pinLimitReached
                        ? 'Three models are already pinned — unpin one first'
                        : 'Pin for one-click switching from the chat header'
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    onTogglePin(m);
                  }}
                >
                  {pinned ? <Pin size={13} /> : <PinOff size={13} />}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/*
        Effort belongs to the *selected* model, so it sits under the list rather
        than on every row: the levels a row advertises are information, but the
        one you are actually sending is a setting.
      */}
      {onEffortChange && efforts.length > 0 && (
        <div className="model-effort">
          <div className="model-effort-head">
            <label className="field-label" style={{ marginBottom: 0 }}>Reasoning effort</label>
            {selected?.priceReasoningPerM != null && (
              <span className="t-caption">
                thinking tokens ${selected.priceReasoningPerM.toFixed(2)} / 1M
              </span>
            )}
          </div>
          <div className="model-effort-row" role="group" aria-label="Reasoning effort">
            {!selected?.reasoning?.mandatory && (
              <button
                type="button"
                className={`chip model-effort-chip${!effort ? ' is-active' : ''}`}
                disabled={disabled}
                title="Send no effort setting — the model uses its own default"
                onClick={() => onEffortChange(null)}
              >
                Default{selected?.reasoning?.defaultEffort ? ` (${selected.reasoning.defaultEffort})` : ''}
              </button>
            )}
            {efforts.map((lvl) => (
              <button
                key={lvl}
                type="button"
                className={`chip model-effort-chip${effort === lvl ? ' is-active' : ''}`}
                disabled={disabled}
                onClick={() => onEffortChange(lvl)}
              >
                {lvl}
              </button>
            ))}
          </div>
          <p className="t-caption model-effort-note">
            Higher effort spends more thinking tokens per reply — the rate is the same, the token
            count is not. Slower and dearer, usually sharper.
          </p>
        </div>
      )}

      <label className="field-label" style={{ marginTop: 12 }}>Selected / custom model id</label>
      <input
        className="input"
        value={value}
        disabled={disabled}
        placeholder="model id"
        onChange={(e) => onChange(e.target.value)}
      />

      <p className="t-caption" style={{ marginTop: 8 }}>
        {loading ? <GlobeLoader size={12} label="Fetching…" /> : (
          <>
            {filtered.length.toLocaleString()} shown
            {source ? ` · ${source}` : ''}
            {models.length !== filtered.length ? ` of ${models.length.toLocaleString()}` : ''}
            {!hasScores && provider === 'openrouter' && !loading ? ' · no scores in this slice' : ''}
          </>
        )}
      </p>
      {warn && !loading && (
        <p className="t-caption" style={{ marginTop: 4, color: 'var(--ink-muted)' }}>{warn}</p>
      )}
    </div>
  );
}
