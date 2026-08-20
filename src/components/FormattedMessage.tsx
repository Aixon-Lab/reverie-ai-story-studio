/** Renders chat text with dialogue / action / thought styles from settings. */
import { useMemo } from 'react';
import type { MessageStyleSettings } from '@shared/types';
import { ensureForcedMessageStyle, parseMessageStyles, styleRuleCss } from '@shared/engine/messageStyle';
import { sanitizeAiOutput } from '@shared/engine/sanitizeOutput';
import { useApp } from '../store';

export function FormattedMessage({
  text,
  className = 't-body-lg',
  style,
}: {
  text: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const messageStyle = useApp((s) => s.settings?.messageStyle);
  const activeReasoningId = useApp((s) => s.settings?.activeReasoningId);
  const reasoningList = useApp((s) => s.reasoning);
  const reasoningWrappers = useMemo(() => {
    const r = reasoningList?.find((x) => x.id === activeReasoningId);
    if (!r?.prefix?.trim() && !r?.suffix?.trim()) return null;
    return { prefix: r?.prefix, suffix: r?.suffix };
  }, [reasoningList, activeReasoningId]);
  const rules = useMemo(
    () => ensureForcedMessageStyle(messageStyle as MessageStyleSettings | undefined).rules,
    [messageStyle],
  );
  // Hide model thinking / INTERNAL THOUGHTS + junk (also cleans historical messages)
  const clean = useMemo(
    () => sanitizeAiOutput(text ?? '', reasoningWrappers),
    [text, reasoningWrappers],
  );
  const segments = useMemo(
    () => parseMessageStyles(clean, messageStyle as MessageStyleSettings | undefined),
    [clean, messageStyle],
  );

  if (!clean?.trim()) {
    return (
      <div className={`fmt-msg ${className}`} style={{ whiteSpace: 'pre-wrap', color: 'var(--ink-faint)', ...style }}>
        …
      </div>
    );
  }

  return (
    <div className={`fmt-msg ${className}`} style={{ whiteSpace: 'pre-wrap', overflowWrap: 'break-word', ...style }}>
      {segments.map((seg, i) => {
        const rule = rules.find((r) => r.id === seg.ruleId);
        const css = styleRuleCss(rule, seg.role) as React.CSSProperties;
        return (
          <span key={i} className={`fmt-seg fmt-${seg.role}`} style={css}>
            {seg.text}
          </span>
        );
      })}
    </div>
  );
}
