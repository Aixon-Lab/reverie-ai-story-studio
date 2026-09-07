import { describe, expect, it } from 'vitest';
import {
  cardToAssistantMember,
  packAssistantContext,
  renderCastMember,
  stripImagePayloads,
} from './assistantContext';

describe('stripImagePayloads', () => {
  it('removes data URLs, markdown images, avatar API paths, and image http links', () => {
    const raw = [
      'see ![coat](data:image/png;base64,aaaBBB==) today',
      'avatar /api/characters/Maya-1.png and https://cdn.example.com/hat.jpg',
    ].join(' ');
    const out = stripImagePayloads(raw);
    expect(out).not.toMatch(/data:image/);
    expect(out).not.toMatch(/aaaBBB/);
    expect(out).not.toMatch(/\/api\/characters/);
    expect(out).not.toMatch(/hat\.jpg/);
    expect(out).toContain('[image omitted]');
  });
});

describe('cardToAssistantMember', () => {
  it('keeps photo labels and drops avatar URLs', () => {
    const member = cardToAssistantMember({
      name: 'Maya',
      description: 'Wears a green flight jacket.',
      avatar: '/api/characters/Maya.png',
      photos: [
        { url: '/api/characters/Maya/photos/1.png', label: 'green jacket' },
        { url: '/api/characters/Maya/photos/2.png' },
      ],
    });
    expect(member.photoLabels).toEqual(['green jacket']);
    const rendered = renderCastMember(member);
    expect(rendered).toContain('green jacket');
    expect(rendered).toContain('green flight jacket');
    expect(rendered).not.toContain('/api/characters');
    expect(rendered).not.toContain('.png');
    expect(JSON.stringify(member)).not.toContain('avatar');
  });
});

describe('packAssistantContext', () => {
  it('puts persona, author note, and recent chat in the system pack', () => {
    const pack = packAssistantContext({
      hasChat: true,
      chatTitle: 'The quay',
      persona: { name: 'Hughie', description: 'Black hoodie, scuffed trainers.' },
      authorsNote: 'Hughie is wearing the borrowed navy coat.',
      transcript: [
        { name: 'Hughie', text: 'I button the navy coat against the wind.' },
        { name: 'Maya', text: 'That colour suits you.' },
      ],
      characters: [{ name: 'Maya', description: 'Pilot. Flight jacket.' }],
      brains: [{ name: 'Maya', text: 'She noticed the coat was not his.' }],
      lore: ['The quay floods at spring tide.'],
      skills: [{ name: 'Reading people', description: 'Watch hands, not words.' }],
      budgetTokens: 4000,
    });
    expect(pack.system).toContain('Playing as: Hughie');
    expect(pack.system).toContain('navy coat');
    expect(pack.system).toContain('Author\'s note');
    expect(pack.system).toContain('I button the navy coat');
    expect(pack.system).toContain('She noticed the coat');
    expect(pack.system).toContain('Reading people');
    expect(pack.system).not.toMatch(/data:image/);
  });

  it('still produces a desk when no chat is open', () => {
    const pack = packAssistantContext({
      hasChat: false,
      persona: { name: 'You', description: 'Just visiting.' },
      characters: [],
      transcript: [],
      brains: [],
      lore: [],
      skills: [],
      budgetTokens: 1200,
    });
    expect(pack.system).toContain('No story is open');
    expect(pack.system).toContain('Playing as: You');
    expect(pack.tokens).toBeGreaterThan(50);
  });

  it('drops low-priority lore before the author\'s note when the budget is tight', () => {
    const pack = packAssistantContext({
      hasChat: true,
      persona: { name: 'A' },
      authorsNote: 'CURRENT OUTFIT: red scarf.',
      transcript: Array.from({ length: 40 }, (_, i) => ({
        name: 'A',
        text: `Line ${i} with enough words to cost real tokens in the estimator.`,
      })),
      characters: [],
      brains: [],
      lore: [Array.from({ length: 80 }, (_, i) => `Lore dump ${i} padding padding.`).join(' ')],
      skills: [{ name: 'Pad', description: 'x '.repeat(200) }],
      budgetTokens: 900,
    });
    expect(pack.system).toContain('red scarf');
    expect(pack.dropped.length).toBeGreaterThan(0);
  });
});
