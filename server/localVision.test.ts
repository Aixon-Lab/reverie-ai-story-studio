/**
 * On-device image scanning.
 *
 * Inference is verified by running the real engine, not here. What these pin
 * down is the surrounding contract: that the app can provision itself on this
 * platform, that it keeps everything inside its own folder, and that the
 * defaults which make it fast and private cannot drift silently.
 */
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import {
  DEFAULT_LOCAL_VISION, MODELS_DIR, RUNTIME_DIR, VISION_MODEL, detectLocalVision, downscale,
  platformAsset, type LocalVisionConfig,
} from './providers/localVision';

const cfg = (over: Partial<LocalVisionConfig> = {}): LocalVisionConfig => ({
  ...DEFAULT_LOCAL_VISION,
  ...over,
});

describe('self-containment', () => {
  it('keeps weights and engine inside the app folder, not a system path', () => {
    expect(MODELS_DIR.endsWith(`${path.sep}models`)).toBe(true);
    expect(RUNTIME_DIR.includes(`${path.sep}runtime${path.sep}llama`)).toBe(true);
    for (const d of [MODELS_DIR, RUNTIME_DIR]) {
      expect(d.startsWith(os.tmpdir())).toBe(false);
      expect(d.startsWith(os.homedir() + path.sep + '.')).toBe(false);
    }
  });

  it('has a prebuilt engine for every platform we claim to support', () => {
    const supported: [NodeJS.Platform, string][] = [
      ['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'x64'],
    ];
    for (const [p, a] of supported) {
      const asset = platformAsset(p, a);
      expect(asset, `${p}/${a}`).not.toBeNull();
      expect(asset!.asset).toMatch(/^llama-b\d+-bin-.*\.zip$/);
      expect(asset!.exe).toBe(p === 'win32' ? 'llama-server.exe' : 'llama-server');
    }
  });

  it('reports honestly when there is no prebuilt engine, instead of guessing', () => {
    expect(platformAsset('linux', 'arm64')).toBeNull();
    expect(platformAsset('freebsd' as NodeJS.Platform, 'x64')).toBeNull();
  });

  it('declares the download size so the UI can warn before a 1.6 GB fetch', () => {
    expect(VISION_MODEL.approxDownloadMb).toBeGreaterThan(1000);
    expect(VISION_MODEL.weights).toMatch(/\.gguf$/);
    expect(VISION_MODEL.mmproj).toMatch(/\.gguf$/);
  });
});

describe('defaults', () => {
  it('ships strict-on, so a local failure can never silently upload the image', () => {
    expect(DEFAULT_LOCAL_VISION.enabled).toBe(true);
    expect(DEFAULT_LOCAL_VISION.strict).toBe(true);
  });

  // Measured: the same portrait at 970x1455 took ~100s to encode (19 slices)
  // versus ~4.5s at 448 (3 slices). This default is load-bearing for usability.
  it('downscales to the encoder tile size — the difference between 6s and 2min', () => {
    expect(DEFAULT_LOCAL_VISION.maxEdge).toBeLessThanOrEqual(448);
    expect(DEFAULT_LOCAL_VISION.maxEdge).toBeGreaterThanOrEqual(320);
  });

  it('gives the ~2 GB back when idle, rather than squatting on a 4 GB laptop', () => {
    expect(DEFAULT_LOCAL_VISION.idleUnloadMs).toBeGreaterThan(0);
  });
});

describe('detectLocalVision', () => {
  it('is available without anything installed — the app provisions itself', async () => {
    const s = await detectLocalVision(cfg());
    expect(s.available).toBe(true);
    expect(s.model).toBe(VISION_MODEL.id);
    expect(typeof s.engineReady).toBe('boolean');
    expect(typeof s.weightsReady).toBe('boolean');
  });

  it('explains the one-time download until both engine and weights are present', async () => {
    const s = await detectLocalVision(cfg());
    if (s.engineReady && s.weightsReady) expect(s.setup).toBeUndefined();
    else expect(s.setup).toMatch(/download/i);
  });

  it('is unavailable when the user turned on-device scanning off', async () => {
    const s = await detectLocalVision(cfg({ enabled: false }));
    expect(s.available).toBe(false);
    expect(s.error).toMatch(/turned off/i);
  });
});

describe('downscale', () => {
  it('returns the image unchanged rather than throwing on undecodable bytes', async () => {
    // A resize failure must degrade to "slow but correct", never to a failed scan.
    const junk = { mime: 'image/png', b64: Buffer.from('not an image').toString('base64') };
    expect(await downscale(junk, 448)).toEqual(junk);
  });
});
