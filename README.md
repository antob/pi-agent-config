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
| `keybindings.json`, `session-recap.json`, `model-advisor.json`, `supi/` | Per extension and package settings. |
| `deprecated/` | Retired extensions, skills, agents, prompts and themes. Kept for a while before deletion or restore. Gitignored. |

Not tracked: `auth.json`, `trust.json`, `models-store.json`, `sessions/`, `node_modules/`, `npm/`.

## Extensions

### model-advisor

Suggests a Claude model (Haiku, Sonnet, Opus, Fable) and thinking level for a task, based on Anthropic's model selection guidance. Only active when the session model's provider is `claude-bridge`. Design, sources and test results: `model-advisor-plan.md`.

- On the first prompt of a session, a side model judges the task. If the suggestion differs from the current model or level, a dialog offers to switch before the first request, when switching costs nothing.
- `/model-advice <text>` shows a suggestion without switching. `/model-advice` without text judges the last prompt and offers a switch, which re-sends the history uncached.
- Fable is marked "usage credits", since it is not included in the Pro plan.
- Skipped for subagent panes and sessions started with `--model`. If the side model fails, a keyword guess is shown in the status line only.
- The side model never runs through `claude-bridge`, so it does not use the Claude quota.

Optional config in `model-advisor.json` (defaults shown):

```json
{
  "enabled": true,
  "model": "openrouter/deepseek/deepseek-v4.1-flash-1017",
  "timeoutMs": 4000,
  "allowFable": true
}
```

`enabled: false` turns off the automatic dialog; `/model-advice` keeps working. Writes under `~/.pi/agent/extensions/` are blocked by pi-automode, so edit the extension through `~/Projects/pi-agent-config/extensions/model-advisor/`.

## Packages

Installed through `settings.json`:

- `antob/pi-cbm`
- `pi-claude-bridge`
- `@czottmann/pi-automode`
- `@mrclrchtr/supi-prompt-suggestions`

## Maintenance

- `just update` updates the local dependencies with `bun`.
- `bun` is configured as the npm command in `settings.json`.
- `bun run typecheck` type checks the extensions.
