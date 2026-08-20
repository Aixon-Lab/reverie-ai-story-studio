/**
 * Mandatory Zero Data Retention for OpenRouter.
 *
 * OpenRouter is a router: a request for `anthropic/claude-sonnet-4.5` may be
 * served by any of several upstream providers, and their retention policies
 * differ. ZDR can be switched on for an account in the dashboard, but an account
 * setting is invisible from here, silently revocable, and does not survive
 * someone pasting a different API key. So this app states the requirement on
 * every single request instead of trusting the account to have it.
 *
 * The mechanism is OpenRouter's provider-preferences block
 * (https://openrouter.ai/docs/features/provider-routing):
 *
 *   { "provider": { "zdr": true, "data_collection": "deny" } }
 *
 * `zdr: true` restricts routing to endpoints with a Zero Data Retention policy.
 * `data_collection: "deny"` is the older, broader guarantee — it excludes any
 * provider that stores or trains on prompts. Both are sent: they overlap, and
 * the overlap is the point. If no endpoint satisfies them, OpenRouter refuses
 * the request, which is the correct outcome — a refusal costs a retry, and the
 * alternative costs the data.
 *
 * ## Why this lives at the transport
 *
 * Enforcement by convention fails the first time someone adds a call site and
 * forgets. Two of them already had: the vision and image paths sent user photos
 * to openrouter.ai with no preferences at all. So every provider request goes
 * through `zdrFetch`, which decides by *destination host* rather than by the
 * connection's `provider` field — a connection of type `custom` pointed at
 * `https://openrouter.ai/api/v1` is an OpenRouter request and is treated as one.
 *
 * Anything that cannot be verified is refused rather than sent. See
 * `docs/zdr-policy.md`.
 */

/** The preferences block forced onto every OpenRouter inference request. */
export const ZDR_PROVIDER_PREFS = Object.freeze({
  zdr: true,
  data_collection: 'deny' as const,
});

/** Thrown instead of sending anything that cannot be guaranteed ZDR. */
export class ZdrViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZdrViolationError';
  }
}

export function isOpenRouterUrl(url: string | URL): boolean {
  let host: string;
  try {
    host = (url instanceof URL ? url : new URL(String(url))).hostname.toLowerCase();
  } catch {
    // An unparseable URL is not provably safe. Callers treat `true` as "enforce",
    // and enforcing on something that turns out not to be OpenRouter costs
    // nothing, while the reverse costs a leak.
    return /openrouter/i.test(String(url));
  }
  return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
}

/**
 * Requests that carry no prompt content.
 *
 * The model catalogue is a public list; fetching it sends an API key and nothing
 * about the user. Provider preferences are meaningless on a GET, so these pass
 * through — but only GET and HEAD ever qualify, and the check is on the method,
 * not on anyone's judgement about a particular endpoint.
 */
function isReadOnly(method: string): boolean {
  const m = method.toUpperCase();
  return m === 'GET' || m === 'HEAD';
}

/**
 * Force the preferences into a request body.
 *
 * Returns the rewritten JSON. Throws rather than send when the body cannot be
 * parsed, or when it contains something the ZDR guarantee does not cover.
 */
export function enforceZdrBody(bodyText: string): string {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new ZdrViolationError(
      'Refusing to send a request to OpenRouter whose body could not be read as JSON, '
      + 'because the zero-data-retention preference cannot be attached to it.',
    );
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ZdrViolationError(
      'Refusing to send a non-object request body to OpenRouter — the zero-data-retention '
      + 'preference has nowhere to attach.',
    );
  }

  const obj = body as Record<string, unknown>;

  /**
   * Plugins and tools are explicitly outside OpenRouter's ZDR guarantee — their
   * documentation says enforcement "does not apply to plugins and tools you
   * choose to enable, such as web search", which are third-party services with
   * their own retention. Nothing in this app sets them; the guard is here so
   * that stays true.
   */
  if (obj.plugins !== undefined && obj.plugins !== null) {
    throw new ZdrViolationError(
      'Refusing to send an OpenRouter request that enables plugins: OpenRouter\'s zero-data-'
      + 'retention guarantee does not cover plugins or tools, so this data would be outside it.',
    );
  }

  const existing = obj.provider;
  if (existing !== undefined && existing !== null) {
    if (typeof existing !== 'object' || Array.isArray(existing)) {
      throw new ZdrViolationError(
        'Refusing to send an OpenRouter request with a malformed `provider` block.',
      );
    }
    const prefs = existing as Record<string, unknown>;
    // A caller that asked for the opposite is a bug, not a preference to merge.
    if (prefs.zdr === false) {
      throw new ZdrViolationError('Refusing an OpenRouter request that sets `provider.zdr: false`.');
    }
    if (prefs.data_collection === 'allow') {
      throw new ZdrViolationError(
        'Refusing an OpenRouter request that sets `provider.data_collection: "allow"`.',
      );
    }
  }

  return JSON.stringify({
    ...obj,
    // Spread ours last: the guarantee is not overridable by a call site.
    provider: { ...(existing as object | undefined), ...ZDR_PROVIDER_PREFS },
  });
}

/** True when a body already carries the full guarantee. Used by the audit test. */
export function bodyHasZdr(bodyText: string): boolean {
  try {
    const prefs = (JSON.parse(bodyText) as Record<string, any>)?.provider;
    return prefs?.zdr === true && prefs?.data_collection === 'deny';
  } catch {
    return false;
  }
}

/**
 * Turn OpenRouter's routing refusal into something a person can act on.
 *
 * When a model has no zero-retention endpoint the request fails, and the raw
 * error reads like a server fault. It is not — it is the policy working, and the
 * only useful thing to say is which model to stop using.
 */
export function explainZdrError(status: number, text: string, model?: string): string | null {
  const t = String(text ?? '');
  const looksLikePolicy =
    /zdr|zero[- ]data|data[_ ]collection|data polic|no (?:allowed|endpoints)|no endpoints found/i.test(t);
  if (!looksLikePolicy) return null;
  const which = model ? `“${model}”` : 'That model';
  return [
    `${which} has no zero-data-retention provider on OpenRouter right now, so nothing was sent.`,
    'This app refuses to fall back to a provider that may retain your prompts.',
    'Pick a different model in Connections (most first-party Anthropic, OpenAI and Google routes are ZDR),',
    'or call that provider directly instead of through OpenRouter.',
    `(OpenRouter said ${status}: ${t.slice(0, 200)})`,
  ].join(' ');
}

/**
 * The only way this app talks to a model provider.
 *
 * Non-OpenRouter hosts pass through untouched — their retention posture is an
 * account-level matter between the user and that vendor, and rewriting their
 * request bodies would be both useless and presumptuous. OpenRouter requests
 * get the preferences forced in, or they do not get sent.
 */
export async function zdrFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  if (!isOpenRouterUrl(input)) return fetch(input as any, init);

  const method = init?.method ?? 'GET';
  if (isReadOnly(method)) return fetch(input as any, init);

  const body = init?.body;
  if (typeof body !== 'string') {
    throw new ZdrViolationError(
      `Refusing a ${method} to OpenRouter with a ${body == null ? 'missing' : 'non-text'} body: `
      + 'the zero-data-retention preference can only be attached to a JSON body.',
    );
  }

  const res = await fetch(input as any, { ...init, body: enforceZdrBody(body) });

  /**
   * Surface a policy refusal as a policy refusal.
   *
   * The response is returned either way so callers keep their own error
   * handling; this only replaces the reason text when the failure was ours to
   * explain. Reading the body clones the response first — callers still get an
   * unconsumed stream.
   */
  if (!res.ok && res.status >= 400 && res.status < 500) {
    let text = '';
    try {
      text = await res.clone().text();
    } catch {
      return res;
    }
    let model: string | undefined;
    try {
      model = (JSON.parse(body) as Record<string, any>)?.model;
    } catch { /* not important enough to fail over */ }
    const explained = explainZdrError(res.status, text, model);
    if (explained) throw new ZdrViolationError(explained);
  }

  return res;
}
