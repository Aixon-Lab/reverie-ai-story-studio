/**
 * "Started" is the line between opening a character and having a conversation.
 *
 * Opening one seeds their greeting so there is something on screen; listing that
 * in history fills the rail with rows the user never wrote a word in.
 */
import { describe, expect, it } from 'vitest';
import { isStartedTranscript } from './routes/chats';

const ai = { controlledBy: 'ai' as const };
const human = { controlledBy: 'human' as const };

describe('isStartedTranscript', () => {
  it('treats an empty chat as not started', () => {
    expect(isStartedTranscript([])).toBe(false);
  });

  it('treats a greeting-only chat as not started', () => {
    expect(isStartedTranscript([ai])).toBe(false);
  });

  it('is started the moment the human says anything', () => {
    expect(isStartedTranscript([ai, human])).toBe(true);
    // Even without a greeting — some cards have no first_mes.
    expect(isStartedTranscript([human])).toBe(true);
  });

  it('is started when a second reply was generated, e.g. via Narrator or a nudge', () => {
    expect(isStartedTranscript([ai, ai])).toBe(true);
  });
});
