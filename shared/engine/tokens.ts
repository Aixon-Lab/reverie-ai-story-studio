/**
 * Token estimation. Provider-accurate tokenizers can be slotted in later;
 * for budgeting, ST itself falls back to heuristics for unknown models.
 * ~3.6 chars/token is a safe median for English prose across GPT/Claude/Gemini tokenizers.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const words = text.split(/\s+/).length;
  const chars = text.length;
  // blend word- and char-based estimates, biased slightly high (safer for budgets)
  return Math.ceil(Math.max(words * 1.35, chars / 3.6));
}

export function estimateMessagesTokens(messages: { content: string; name?: string }[]): number {
  // ~4 tokens overhead per message (role scaffolding)
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + (m.name ? estimateTokens(m.name) : 0) + 4, 0);
}
