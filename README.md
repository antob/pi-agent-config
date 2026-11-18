# pi-agent-config

Personal configuration for the [pi coding agent](https://github.com/mariozechner/pi). This repo is the live agent directory, bind mounted at `~/.pi/agent`.

## Layout

| Path                                                                    | Purpose                                               |
| ----------------------------------------------------------------------- | ----------------------------------------------------- |
| `extensions/`                                                           | Custom extensions.                                    |
| `skills/`                                                               | Instruction sets loaded on demand via `SKILL.md`.     |
| `AGENTS.md`                                                             | Global instructions for every project.                |
| `settings.json`                                                         | Pi settings, default model, enabled models, packages. |
| `models.json`, `llama_cpp_preset.ini`                                   | Custom model and local llama.cpp config.              |
| `keybindings.json`, `session-recap.json`, `model-router.json`, `supi/` | Per extension and package settings.                   |

Not tracked: `auth.json`, `trust.json`, `models-store.json`, `sessions/`, `node_modules/`, `npm/`.

## Extensions

### model-router

Picks or suggests a Claude model (Haiku, Sonnet, Opus, Fable) and thinking level for a task, based on Anthropic's model selection guidance. Only active when the session model's provider is `claude-bridge`. Design, sources and test results: `model-router-plan.md`.

- Virtual model `claude-bridge/auto`: on the first prompt of a session a side model picks the model and level, and the session stays on it (a model change re-imports the history uncached). The thinking level selected on `auto` is a budget: `low` allows Haiku and Sonnet, `medium` adds Opus, `high` adds Fable (if `allowFable`). If none of the allowed families is in `enabledModels`, the smallest available one is used. Selecting `auto` mid-session, or again after a detour to a physical model, keeps the bridge model that answered last. Retries stay on the failed model; compaction and extension calls follow the conversation's bridge model, and calls that ask for no thinking (handoff) get none. Runs in subagent panes too, and a keyword guess routes when the side model fails.
- With a physical `claude-bridge` model selected, the first prompt of a session is judged instead, and if the suggestion differs, a dialog offers to switch before the first request, when switching costs nothing.
- `/model-advice <text>` shows a suggestion without switching. `/model-advice` without text judges the last prompt and offers a switch, which re-sends the history uncached.
- Fable is marked "usage credits", since it is not included in the Pro plan.
- The first-prompt dialog is skipped for subagent panes and sessions started with `--model`. If the side model fails, its keyword guess is shown in the status line only.
- The side model never runs through `claude-bridge`, so it does not use the Claude quota.

Optional config in `model-router.json` (defaults shown):

```json
{
  "enabled": true,
  "model": "openrouter/deepseek/deepseek-v4.1-flash-1017",
  "timeoutMs": 4000,
  "allowFable": true
}
```

`enabled: false` turns off the automatic dialog; `auto` and `/model-advice` keep working. Writes under `~/.pi/agent/extensions/` are blocked by pi-automode, so edit the extension through `~/Projects/pi-agent-config/extensions/model-router/`.

### notify-unfocused

Desktop notification (`notify-send`, with `pi-icon.svg`) when pi finishes a run or waits on a UI prompt such as `ask_user` or an automode confirmation. Based on the Claude Code hook `~/.config/claude/hooks/notify-unfocused.sh`.

- Skipped when the pane's tmux window is the current window of a focused tmux client. Needs tmux `focus-events on`. Outside tmux it always notifies.
- Title is the project name (the main repo for a git worktree). Body is the session name and worktree, if any, then "Finished" or "Waiting for input".
- No notification for runs aborted with Escape, or in modes without a UI.
- Subagent panes only notify when waiting, since their result goes to the parent agent.

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
