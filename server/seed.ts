/**
 * First-run seeding — copies shipped package assets from `server/defaults/`
 * into empty folders under `data/`. App is never empty on a fresh install.
 *
 * Only `server/defaults/` is versioned. Runtime user data stays in `data/`
 * (gitignored + agent-hidden). See AGENTS.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCardPayload } from '../shared/codec/png';
import { parseCard } from '../shared/codec/card';
import { parsePreset, defaultPreset } from '../shared/codec/preset';
import { parseLorebook } from '../shared/codec/lorebook';
import { parseInstruct, parseContext, parseSysprompt, parseReasoning } from '../shared/codec/formatting';
import { parseSkillDoc, hydrateSkill } from '../shared/skills/parse';
import { dirs, writeBlobSync, writeJsonSync } from './storage';

const DEFAULTS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'defaults');
const PRESET_PACKS = path.join(DEFAULTS, 'presets');

function isEmpty(dir: string): boolean {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length === 0;
  } catch {
    return true;
  }
}

function seedFolder(
  kind: 'instruct' | 'context' | 'sysprompt' | 'reasoning',
  parse: (raw: Record<string, unknown>, id: string, name: string) => { id: string },
): void {
  const src = path.join(PRESET_PACKS, kind);
  const dest = dirs[kind];
  if (!isEmpty(dest)) return;
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(src).filter((f) => f.endsWith('.json'))) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(src, file), 'utf8'));
      const name = String(raw.name ?? path.parse(file).name);
      const id = path.parse(file).name.replace(/[^a-zA-Z0-9._ -]/g, '_');
      const parsed = parse(raw, id, name);
      writeJsonSync(path.join(dest, `${parsed.id}.json`), parsed);
    } catch (err) {
      console.error(`Skip seed ${kind}/${file}:`, err);
    }
  }
}

export function seedContent(): void {
  try {
    if (isEmpty(dirs.characters)) {
      const png = fs.readFileSync(path.join(DEFAULTS, 'default_Maya.png'));
      const card = parseCard(readCardPayload(new Uint8Array(png)), 'maya');
      writeBlobSync(path.join(dirs.avatars, 'maya.png'), png);
      card.avatar = '/api/avatars/maya.png';
      writeJsonSync(path.join(dirs.characters, 'maya.json'), card);
    }

    if (isEmpty(dirs.presets)) {
      const stRaw = JSON.parse(fs.readFileSync(path.join(DEFAULTS, 'st-default-preset.json'), 'utf8'));
      const st = parsePreset(stRaw, 'st-default', 'Classic Default');
      writeJsonSync(path.join(dirs.presets, 'st-default.json'), st);

      // Also import openai Default if present
      const openaiPath = path.join(PRESET_PACKS, 'openai', 'Default.json');
      if (fs.existsSync(openaiPath)) {
        const oRaw = JSON.parse(fs.readFileSync(openaiPath, 'utf8'));
        const o = parsePreset(oRaw, 'openai-Default', 'OpenAI Default');
        writeJsonSync(path.join(dirs.presets, 'openai-Default.json'), o);
      }

      const nw = defaultPreset('default', 'Reverie Roleplay');
      const main = nw.prompts.find((p) => p.identifier === 'main');
      if (main) {
        main.content = [
          "Write {{char}}'s next reply in an immersive, ongoing roleplay with {{user}}.",
          "Stay fully in character. Show, don't tell: ground every beat in sensory detail, body language, and voice.",
          'Advance the scene — introduce small complications, react to subtext, never stall.',
          'Use *asterisks* for actions and inner thought, "quotes" for speech. 2–4 paragraphs unless the moment demands otherwise.',
          'Never speak or act for {{user}}. Never break the fourth wall.',
        ].join(' ');
      }
      nw.temperature = 0.9;
      nw.max_tokens = 600;
      writeJsonSync(path.join(dirs.presets, 'default.json'), nw);
    }

    seedFolder('instruct', parseInstruct);
    seedFolder('context', parseContext);
    seedFolder('sysprompt', parseSysprompt);
    seedFolder('reasoning', parseReasoning);

    /**
     * Two worked examples rather than a big shipped library.
     *
     * They exist mostly to answer "what is a skill supposed to look like" —
     * broad, setting-agnostic, competence-ranged — because that shape is the
     * difference between a skill that serves every story and one that drags
     * every scene toward the world it was written in. Both start disabled: a
     * fresh install should not quietly change how anyone's characters write.
     */
    if (isEmpty(dirs.skills)) {
      const src = path.join(DEFAULTS, 'skills');
      if (fs.existsSync(src)) {
        fs.mkdirSync(dirs.skills, { recursive: true });
        for (const file of fs.readdirSync(src).filter((f) => f.endsWith('.md'))) {
          try {
            const id = path.parse(file).name;
            const doc = parseSkillDoc(fs.readFileSync(path.join(src, file), 'utf8'), id);
            const skill = hydrateSkill({
              id,
              name: doc.name,
              description: doc.description,
              body: doc.body,
              keywords: doc.keywords,
              tags: doc.tags,
              enabled: false,
              mode: 'auto' as const,
              priority: 50,
              stickyTurns: 2,
              digest: '',
              source: 'manual' as const,
              createdAt: Date.now(),
              updatedAt: Date.now(),
            });
            writeJsonSync(path.join(dirs.skills, `${id}.json`), skill);
          } catch (err) {
            console.error(`Skip seed skill ${file}:`, err);
          }
        }
      }
    }

    if (isEmpty(dirs.lorebooks)) {
      const raw = JSON.parse(fs.readFileSync(path.join(DEFAULTS, 'Northline.json'), 'utf8'));
      const book = parseLorebook(raw, 'northline', 'Northline');
      writeJsonSync(path.join(dirs.lorebooks, 'northline.json'), book);
    }
  } catch (err) {
    console.error('Seeding failed (continuing without seeds):', err);
  }
}
