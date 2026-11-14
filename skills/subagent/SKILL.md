---
name: subagent
description: Start a pi subagent in a new tmux column to work on a delegated task, using the current model or one the user names. The subagent reports back to this agent when done and its pane closes unless asked to keep it open. Use when the user asks for a subagent, asks to delegate a task to another agent, or wants an agent to do something in a separate pane.
---

# Subagents

## Task

$@

## How it works

- `extensions/subagent.ts` gives this pi an inbox and exports `PI_SUBAGENT_INBOX`,
  `PI_SUBAGENT_MODEL` and `PI_SUBAGENT_THINKING` to the bash tool.
- `spawn.sh` (next to this file) opens a new tmux column and starts an interactive pi
  there with the task file as its first prompt.
- The subagent calls `subagent_report` when done. The report arrives here as a
  `subagent-report` message: it starts a turn when idle, or queues as a follow-up when
  busy. Then the subagent's pane closes, unless `--keep-open` was used.
- Subagents get only `read,bash,edit,write` and `subagent_report`, no codemode, MCP or
  graph tools. They cannot start subagents.

If `PI_SUBAGENT_INBOX` is empty, the extension is not loaded. Say so in one line and
stop. Do not start pi in a pane by hand instead.

## Steps

1. **Write the task file** to `/tmp/pi-subagent-<name>.md`. The subagent has none of this
   conversation's context, so make it self-contained:
   - Goal and expected outcome.
   - Relevant paths, symbols, commands and facts already established here.
   - Constraints (for example read-only, do not commit, do not run builds) and the
     user's restrictions that apply.
   - What to put in the report.
2. **Start it**:

   ```bash
   ~/.pi/agent/skills/subagent/spawn.sh --name <name> [--model <provider/id[:thinking]>] [--keep-open] [--cwd <dir>] /tmp/pi-subagent-<name>.md
   ```

   - `--name`: short kebab-case label (`fix-login-test`, `scout-auth`).
   - `--model`: only when the user names a model. Resolve it against `enabledModels`
     in `~/.pi/agent/settings.json` and pass the full `provider/id`. Without it, the
     current model and thinking level are used.
   - `--keep-open`: only when the user asks to keep the pane or session open.
   - `--cwd`: only when the work belongs in another directory. Default is the current
     directory.
3. **Tell the user** in one line: name, pane ID and model (from the script's output line).
   Then continue with other work or end the turn.

Several subagents can run in parallel: write one task file per subagent and start each.

## While it runs

- Do not poll, capture or type into the subagent's pane. The report comes on its own.
- Do not kill the pane. The user may be talking to the subagent there.
- Only look at the pane (`tmux capture-pane -t %N -p -S -50`) if the user asks for its
  status.

## When a report arrives

- `done`: summarise the result for the user. Act on it only if the original request
  said what to do next.
- `exited-without-report`: the subagent quit before reporting (Ctrl+C, or the user
  closed it). The message carries its last reply. Tell the user.
- `failed`: pi exited with an error, usually a bad model or a startup crash. The pane
  stays open with the error. Tell the user the pane ID.
- For details beyond the summary, read the session file named in the report.
- With `--keep-open`, a subagent may send more reports later if the user keeps working
  with it.
