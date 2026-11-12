# pi-agent-config

Personal configuration for the [pi coding agent](https://github.com/mariozechner/pi). This repo is the live agent directory, bind mounted at `~/.pi/agent`.

## Layout

| Path | Purpose |
| --- | --- |
| `extensions/` | Custom extensions. |
| `skills/` | Instruction sets loaded on demand via `SKILL.md`. |
| `AGENTS.md` | Global instructions for every project. |
| `settings.json` | Pi settings, default model, enabled models, packages. |
| `models.json`, `llama_cpp_preset.ini` | Custom model and local llama.cpp config. |
| `keybindings.json`, `session-recap.json`, `supi/` | Per extension and package settings. |
| `deprecated/` | Retired extensions, skills, agents, prompts and themes. Kept for a while before deletion or restore. Gitignored. |

Not tracked: `auth.json`, `trust.json`, `models-store.json`, `sessions/`, `node_modules/`, `npm/`.

## Packages

Installed through `settings.json`:

- `antob/pi-cbm`
- `pi-autoresearch`
- `pi-claude-bridge`
- `@czottmann/pi-automode`
- `@mrclrchtr/supi-prompt-suggestions`

## Maintenance

- `just update` updates the local dependencies with `bun`.
- `bun` is configured as the npm command in `settings.json`.
- `bun run typecheck` type checks the extensions.
