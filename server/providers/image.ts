/** Image generation adapters. Uniform request -> base64 PNG(s). */
import type { ImageConnection } from '../../shared/types';
import { getSecret } from '../storage';
import { zdrFetch } from './zdr';

export interface ImageRequest {
  prompt: string;
  negative?: string;
  aspect: '1:1' | '3:4' | '4:3' | '16:9' | '9:16';
  /** base64 data-URIs of reference images (style/character consistency) */
  references?: string[];
}

export interface ImageResult {
  /** base64 (no data: prefix), always png/jpeg bytes */
  b64: string;
  mime: string;
  model: string;
}

/** Editable model catalog — the UI merges this with free-text overrides. */
export const IMAGE_CATALOG: Record<string, { label: string; models: string[] }> = {
  google: {
    label: 'Google (Gemini / Nano Banana)',
    models: ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview', 'gemini-3.1-flash-image'],
  },
  openai: {
    label: 'OpenAI (GPT Image)',
    models: ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1'],
  },
  openrouter: {
    label: 'OpenRouter (aggregator)',
    models: ['google/gemini-3-pro-image-preview', 'openai/gpt-image-2', 'bytedance/seedream-5', 'black-forest-labs/flux.2-pro'],
  },
  fal: {
    label: 'fal.ai (aggregator)',
    models: ['fal-ai/flux-pro/v2', 'fal-ai/bytedance/seedream/v5', 'fal-ai/nano-banana-pro'],
  },
  custom: { label: 'Custom (OpenAI-compatible /images)', models: [] },
};

function keyFor(provider: string): string {
  return `image.${provider}.apiKey`;
}

export async function generateImage(conn: ImageConnection, req: ImageRequest): Promise<ImageResult> {
  if (!conn.provider) throw new Error('NO_IMAGE_API');
  const apiKey = (await getSecret(keyFor(conn.provider))) ?? '';
  if (!apiKey) throw new Error('NO_IMAGE_API');

  switch (conn.provider) {
    case 'google':
      return googleImage(conn, req, apiKey);
    case 'openai':
    case 'custom':
      return openaiImage(conn, req, apiKey);
    case 'openrouter':
      return openrouterImage(conn, req, apiKey);
    case 'fal':
      return falImage(conn, req, apiKey);
    default:
      throw new Error(`Unsupported image provider: ${conn.provider}`);
  }
}

async function googleImage(conn: ImageConnection, req: ImageRequest, apiKey: string): Promise<ImageResult> {
  const base = conn.baseUrl?.replace(/\/$/, '') || 'https://generativelanguage.googleapis.com';
  const parts: any[] = [{ text: req.prompt + (req.negative ? `\nAvoid: ${req.negative}` : '') }];
  for (const ref of req.references ?? []) {
    const m = /^data:(.+?);base64,(.*)$/.exec(ref);
    if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
  }
  const res = await zdrFetch(`${base}/v1beta/models/${encodeURIComponent(conn.model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: req.aspect } },
    }),
  });
  if (!res.ok) throw new Error(`Google image error ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json: any = await res.json();
  const img = json.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData);
  if (!img) throw new Error('Google returned no image (possibly filtered).');
  return { b64: img.inlineData.data, mime: img.inlineData.mimeType ?? 'image/png', model: conn.model };
}

async function openaiImage(conn: ImageConnection, req: ImageRequest, apiKey: string): Promise<ImageResult> {
  const base = conn.baseUrl?.replace(/\/$/, '') || 'https://api.openai.com/v1';
  const sizes: Record<string, string> = { '1:1': '1024x1024', '3:4': '1024x1536', '4:3': '1536x1024', '16:9': '1536x1024', '9:16': '1024x1536' };
  const res = await zdrFetch(`${base}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: conn.model, prompt: req.prompt, size: sizes[req.aspect] ?? '1024x1024', n: 1 }),
  });
  if (!res.ok) throw new Error(`OpenAI image error ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json: any = await res.json();
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image data.');
  return { b64, mime: 'image/png', model: conn.model };
}

async function openrouterImage(conn: ImageConnection, req: ImageRequest, apiKey: string): Promise<ImageResult> {
  const res = await zdrFetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: conn.model,
      messages: [{ role: 'user', content: req.prompt }],
      modalities: ['image', 'text'],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter image error ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json: any = await res.json();
  const images = json.choices?.[0]?.message?.images;
  const url: string | undefined = images?.[0]?.image_url?.url;
  if (!url) throw new Error('OpenRouter returned no image.');
  const m = /^data:(.+?);base64,(.*)$/.exec(url);
  if (m) return { b64: m[2], mime: m[1], model: conn.model };
  const imgRes = await zdrFetch(url);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  return { b64: buf.toString('base64'), mime: imgRes.headers.get('content-type') ?? 'image/png', model: conn.model };
}

async function falImage(conn: ImageConnection, req: ImageRequest, apiKey: string): Promise<ImageResult> {
  const res = await zdrFetch(`https://fal.run/${conn.model}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Key ${apiKey}` },
    body: JSON.stringify({ prompt: req.prompt, negative_prompt: req.negative, aspect_ratio: req.aspect }),
  });
  if (!res.ok) throw new Error(`fal.ai error ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json: any = await res.json();
  const url = json.images?.[0]?.url ?? json.image?.url;
  if (!url) throw new Error('fal.ai returned no image.');
  const imgRes = await zdrFetch(url);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  return { b64: buf.toString('base64'), mime: imgRes.headers.get('content-type') ?? 'image/png', model: conn.model };
}
