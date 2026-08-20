# Product defaults (shipped)

Files here are **part of the Reverie package**. They are tracked by git and visible to AI agents.

On first run (empty `data/` folders), `server/seed.ts` copies/parses these into the user runtime tree under `data/`.

## What belongs here

- Starter character card(s) (e.g. `default_Maya.png`)
- Default chat-completion presets (`st-default-preset.json`, `presets/openai/`)
- Instruct / context / sysprompt / reasoning / textgen packs under `presets/`
- Sample lorebooks (e.g. `Northline.json`)

## What does **not** belong here

Anything created or imported **through the running app** (your characters, chats, personal presets, API keys, settings). Those live only in `data/` and must stay off git and out of agent context.

See root `AGENTS.md` for the full privacy map.
