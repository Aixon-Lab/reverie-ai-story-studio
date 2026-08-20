# Agent notes — privacy & package layout

## The rule of thumb (read this first)

| How it got there | Where it lives | Git / GitHub | AI agents (Cursor, Claude, Grok, …) |
|------------------|----------------|--------------|-------------------------------------|
| **Via the app** (import character, chat, preset, settings, API keys, persona, lorebook you added in UI) | `data/` | **Never** | **Hidden** — do not open, list, summarize, or commit |
| **Via code / agents** (starter content meant for every install of the product) | `server/defaults/` (+ seed logic in `server/seed.ts`) | **Yes — ship it** | **Yes — edit freely** |
| App source, engine, UI | `src/`, `server/` (except runtime), `shared/`, `public/` | **Yes** | **Yes** |

**Do not** put personal imports under `server/defaults/`.  
**Do not** commit anything under `data/`.  
If you want a new **default** character / preset / sysprompt / lorebook in the product package, add it under `server/defaults/` and wire seeding in `server/seed.ts` (first-run only copies into empty `data/` folders).

## Runtime vs package paths

```
server/defaults/          ← SHIPPED product seeds (tracked)
  default_Maya.png        ← starter character card PNG
  Northline.json          ← starter lorebook
  st-default-preset.json
  presets/instruct|context|sysprompt|reasoning|openai|textgen/

data/                     ← USER RUNTIME only (ignored + agent-hidden)
  characters/ avatars/ chats/ groups/
  presets/                ← includes personal packs imported in the app
  instruct/ context/ sysprompt/ reasoning/
  lorebooks/ images/ style-profiles/ quick-replies/
  settings.json personas.json secrets.json
```

On first run (or when a target folder is empty), `server/seed.ts` copies from `server/defaults/` → `data/`. After that, the app only reads/writes `data/`. Your imports never touch the package defaults tree.

## Git vs AI visibility (detail)

| Path | On GitHub? | Cursor / Claude | Grok CLI |
|------|------------|-----------------|----------|
| `src/`, `server/`, `shared/`, `public/` | Yes | Yes | Yes |
| `server/defaults/` | **Yes** (product package) | Yes | Yes |
| `drop-zone/` | **No** (`.gitignore`) | **Yes** | **Yes** — logos, temp assets |
| `backup/` | **No** | **Yes** | **Yes** — original prompts / archives |
| `.claude/` | **No** | **Yes** | **Yes** — local Claude project files |
| `docs/` | **No** | **Yes** | **Yes** — design/research for agents |
| `Resources/` | **No** | **Yes** | **Yes** — design refs |
| `data/` (everything the app stores at runtime) | **Never** | **Hidden** | **Hidden** |
| `dogfood-output/` | **No** | **Hidden** | **Hidden** |

## Important: tools do not share ignore files

| File | What it does |
|------|----------------|
| `.gitignore` | What stays off `git push` only |
| `.cursorignore` | Cursor indexing / agent context |
| `.claudeignore` | Claude Code agent context |
| `.grok/config.toml` `[permission] deny` | **Grok CLI** tool blocks (Read/Edit/Write/Grep) |

Grok does **not** honor `.cursorignore` or `.claudeignore`.  
Do **not** set Grok `respect_gitignore = true` globally for this repo — that would also hide `docs/`, `backup/`, and `drop-zone/` from tools.

## Rules for agents

1. **Never** commit, open, summarize, or echo `data/`, secrets, chat history, imported characters, or user presets.
2. Prefer reading `docs/` and `backup/` for product context; they are local-only (gitignored, agent-visible).
3. Shipped seeds live under `server/defaults/` — that is the correct place for starter characters, default presets, sysprompts, instruct/context packs, and sample lorebooks.
4. To add package content: edit `server/defaults/` (+ `server/seed.ts` if a new seed step is needed). Do **not** copy personal files out of `data/` into the repo unless the user explicitly wants them to become public defaults.
5. Durable public docs for GitHub go in tracked files (e.g. `README.md` / `AGENTS.md`), not only under gitignored `docs/`.
6. **Never add a bare `fetch()` that can reach OpenRouter.** Every provider request goes through `zdrFetch` (`server/providers/zdr.ts`), which forces `provider: { zdr: true, data_collection: "deny" }` onto each call so nothing is ever routed to an endpoint that retains prompts. `server/zdr.test.ts` fails the build if a file that mentions OpenRouter holds a raw `fetch(`. See `docs/zdr-policy.md`.

## Config files

- `.gitignore` — what stays off `git push`
- `.cursorignore` — what Cursor should not index
- `.claudeignore` — what Claude Code should not load
- `.grok/config.toml` — Grok project permissions (deny private paths)
