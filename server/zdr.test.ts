/**
 * The zero-data-retention guarantee.
 *
 * These are the tests that have to keep passing for the promise in
 * `docs/zdr-policy.md` to still be true. The last group is an audit rather than
 * a unit test: it fails when someone adds a new OpenRouter call site that
 * bypasses the choke point, which is the only way this guarantee realistically
 * breaks.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ZDR_PROVIDER_PREFS, ZdrViolationError, bodyHasZdr, enforceZdrBody, explainZdrError,
  isOpenRouterUrl, zdrFetch,
} from './providers/zdr';

describe('isOpenRouterUrl', () => {
  it('recognises the API host', () => {
    expect(isOpenRouterUrl('https://openrouter.ai/api/v1/chat/completions')).toBe(true);
    expect(isOpenRouterUrl(new URL('https://openrouter.ai/api/v1/models'))).toBe(true);
    expect(isOpenRouterUrl('https://api.openrouter.ai/v1/chat/completions')).toBe(true);
  });

  it('catches a custom connection pointed at OpenRouter', () => {
    // The leak this closes: provider === 'custom' with an OpenRouter baseUrl
    // used to skip every OpenRouter-specific code path.
    expect(isOpenRouterUrl('https://openrouter.ai/api/v1')).toBe(true);
  });

  it('leaves other providers alone', () => {
    expect(isOpenRouterUrl('https://api.openai.com/v1/chat/completions')).toBe(false);
    expect(isOpenRouterUrl('https://api.anthropic.com/v1/messages')).toBe(false);
    expect(isOpenRouterUrl('http://127.0.0.1:8080/v1/chat/completions')).toBe(false);
  });

  it('is not fooled by a lookalike host', () => {
    expect(isOpenRouterUrl('https://openrouter.ai.evil.example/v1')).toBe(false);
  });
});

describe('enforceZdrBody', () => {
  const body = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ model: 'anthropic/claude-sonnet-4.5', messages: [{ role: 'user', content: 'hi' }], ...extra });

  it('adds both guarantees to a plain request', () => {
    const out = JSON.parse(enforceZdrBody(body()));
    expect(out.provider).toEqual({ zdr: true, data_collection: 'deny' });
  });

  it('keeps the rest of the request untouched', () => {
    const out = JSON.parse(enforceZdrBody(body({ temperature: 0.9, stream: true })));
    expect(out.model).toBe('anthropic/claude-sonnet-4.5');
    expect(out.temperature).toBe(0.9);
    expect(out.stream).toBe(true);
    expect(out.messages).toHaveLength(1);
  });

  it('merges with unrelated provider preferences without losing them', () => {
    const out = JSON.parse(enforceZdrBody(body({ provider: { order: ['anthropic'] } })));
    expect(out.provider.order).toEqual(['anthropic']);
    expect(out.provider.zdr).toBe(true);
    expect(out.provider.data_collection).toBe('deny');
  });

  it('cannot be overridden by a call site asking for the opposite', () => {
    expect(() => enforceZdrBody(body({ provider: { zdr: false } }))).toThrow(ZdrViolationError);
    expect(() => enforceZdrBody(body({ provider: { data_collection: 'allow' } }))).toThrow(ZdrViolationError);
  });

  it('refuses plugins, which OpenRouter excludes from the ZDR guarantee', () => {
    expect(() => enforceZdrBody(body({ plugins: [{ id: 'web' }] }))).toThrow(/plugins/i);
  });

  it('refuses a body it cannot read rather than sending it', () => {
    expect(() => enforceZdrBody('not json')).toThrow(ZdrViolationError);
    expect(() => enforceZdrBody('[1,2,3]')).toThrow(ZdrViolationError);
    expect(() => enforceZdrBody(body({ provider: 'anthropic' }))).toThrow(ZdrViolationError);
  });

  it('is idempotent', () => {
    const once = enforceZdrBody(body());
    expect(enforceZdrBody(once)).toBe(once);
  });
});

describe('zdrFetch', () => {
  /** Capture what would have gone out, without a network. */
  function withStubbedFetch<T>(run: (calls: { url: string; init?: RequestInit }[]) => T, response?: Response) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return response ?? new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;
    try {
      return run(calls);
    } finally {
      globalThis.fetch = original;
    }
  }

  const post = { method: 'POST', body: JSON.stringify({ model: 'm', messages: [] }) };

  it('forces the preferences onto an OpenRouter completion', async () => {
    await withStubbedFetch(async (calls) => {
      await zdrFetch('https://openrouter.ai/api/v1/chat/completions', post);
      const sent = JSON.parse(String(calls[0].init!.body));
      expect(sent.provider).toEqual(ZDR_PROVIDER_PREFS);
    });
  });

  it('covers the vision and image paths, which had no preferences at all', async () => {
    await withStubbedFetch(async (calls) => {
      await zdrFetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'm', messages: [], modalities: ['image', 'text'] }),
      });
      expect(bodyHasZdr(String(calls[0].init!.body))).toBe(true);
      expect(JSON.parse(String(calls[0].init!.body)).modalities).toEqual(['image', 'text']);
    });
  });

  it('does not touch a request to another provider', async () => {
    await withStubbedFetch(async (calls) => {
      await zdrFetch('https://api.openai.com/v1/chat/completions', post);
      expect(String(calls[0].init!.body)).toBe(post.body);
    });
  });

  it('lets the public model catalogue through — a GET carries no prompt', async () => {
    await withStubbedFetch(async (calls) => {
      await zdrFetch('https://openrouter.ai/api/v1/models', { method: 'GET' });
      expect(calls).toHaveLength(1);
    });
  });

  it('refuses to POST to OpenRouter without a readable body', async () => {
    await withStubbedFetch(async (calls) => {
      await expect(zdrFetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST' }))
        .rejects.toThrow(ZdrViolationError);
      // Nothing was sent.
      expect(calls).toHaveLength(0);
    });
  });

  it('reports a routing refusal as policy, not as a server fault', async () => {
    const denial = new Response(
      JSON.stringify({ error: { message: 'No endpoints found matching your data policy' } }),
      { status: 404 },
    );
    await withStubbedFetch(async () => {
      await expect(zdrFetch('https://openrouter.ai/api/v1/chat/completions', post))
        .rejects.toThrow(/zero-data-retention provider/i);
    }, denial);
  });

  it('leaves unrelated 4xx errors to the caller', async () => {
    const rateLimited = new Response('{"error":"rate limited"}', { status: 429 });
    await withStubbedFetch(async () => {
      const res = await zdrFetch('https://openrouter.ai/api/v1/chat/completions', post);
      expect(res.status).toBe(429);
      // The body must still be readable — we only cloned it.
      expect(await res.text()).toContain('rate limited');
    }, rateLimited);
  });
});

describe('explainZdrError', () => {
  it('names the model to change', () => {
    const msg = explainZdrError(404, 'No allowed providers are available', 'x/y');
    expect(msg).toContain('x/y');
    expect(msg).toContain('nothing was sent');
  });

  it('stays silent about errors that are not about policy', () => {
    expect(explainZdrError(500, 'upstream timeout')).toBeNull();
  });
});

describe('no OpenRouter call site bypasses the choke point', () => {
  const root = __dirname;

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  const files = walk(root).filter((f) => !f.endsWith('zdr.ts') && !f.endsWith('.test.ts'));

  it('finds the provider modules it is meant to be auditing', () => {
    expect(files.some((f) => f.endsWith('text.ts'))).toBe(true);
  });

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const mentionsOpenRouter = /openrouter/i.test(source);
    const bareFetch = source.match(/(?<![\w.])fetch\s*\(/g);
    if (!mentionsOpenRouter && !bareFetch) continue;

    it(`${path.relative(root, file).replace(/\\/g, '/')} routes every request through zdrFetch`, () => {
      if (mentionsOpenRouter) {
        // A file that can reach OpenRouter must not hold a raw fetch, because a
        // raw fetch is exactly how a request escapes the preferences block.
        expect(bareFetch, `bare fetch( in a file that talks to OpenRouter: ${file}`).toBeNull();
      }
    });
  }
});
