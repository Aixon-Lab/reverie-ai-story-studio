/** Image prompt fallback card — white raised surface with the prompt + copy button. */
import { useState } from 'react';

export function PromptCard({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      style={{
        background: 'var(--surface-raised)',
        color: 'var(--ink-inverse)',
        borderRadius: 'var(--r-card)',
        padding: 26,
      }}
    >
      <p style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 14, whiteSpace: 'pre-wrap' }}>{prompt}</p>
      <button
        className="btn btn-sm"
        style={{ background: 'var(--ink-inverse)', color: 'var(--ink)' }}
        onClick={async () => {
          await navigator.clipboard.writeText(prompt);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'Copied ✓' : 'Copy Prompt'}
      </button>
    </div>
  );
}
