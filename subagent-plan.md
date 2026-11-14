# Subagent skill plan

Status: all phases done. Phase 4 tests passed on 2026-11-14 (see below).
Review fixes (see "Review fixes") are written, typecheck passes, and the retest
passed on 2026-11-14.

Decisions: option 2 (skill + extension). Child tools: `read,bash,edit,write` plus
`subagent_report` (no codemode, tool_search or MCP). Reports are custom extension
messages (`subagent-report`). Auto mode hard-denies writes to `extensions/`; it must be
off while editing the extension or skill scripts.

## Goal

When the user asks for a subagent, the main pi agent opens a new tmux column, starts an
interactive pi there with a task derived from the request, and keeps working. The
subagent reports back to the main agent when done. The pane closes after the report
unless the user asked to keep it open. Model defaults to the main agent's current
model (and thinking level), or whatever the user names.

## Research: communication between pi agents in tmux panes

| Mechanism | Payload | Async wake-up of main | Verdict |
|---|---|---|---|
| `tmux send-keys` into the main pane | Yes, typed into the TUI editor | Yes | Fragile. Collides with whatever the user is typing, Enter semantics change while pi is streaming, long text gets mangled. |
| `tmux capture-pane` polling | Scraped TUI text | No, main must poll | Fragile and token-heavy (fullscreen TUI). Fine for a glance, not for results. |
| `tmux wait-for <chan>` / `-S` | None (signal only) | No, main blocks in a bash call | Simple, skill-only. Blocks the main agent and is bounded by the bash timeout. |
| Result file + extension `fs.watch` + `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` | Yes | Yes. Starts a turn when idle, queues a follow-up when busy | Robust. Pi ships this pattern as `examples/extensions/file-trigger.ts`. |
| `pi --mode rpc` subprocess | Yes (JSONL) | Yes | No TUI in the pane, so the user cannot watch or talk to the subagent. Rejected. |
| `pi.events` event bus | Yes | Yes | In-process only, not cross-process. Not usable. |

Other relevant facts:

- An extension sees the current model via `ctx.model` / `ctx.thinkingLevel` and the
  `model_select` / `thinking_level_select` events. A skill alone does not reliably
  know the exact `provider/id`.
- `ctx.shutdown()` in interactive mode is deferred until the agent is idle, so a
  subagent can report and then exit cleanly.
- `session_shutdown` fires on Ctrl+C, Ctrl+D, SIGHUP and SIGTERM, which allows a
  fallback "exited without report" message.
- The bash tool inherits the pi process environment, so env vars set by an extension
  at `session_start` are visible to commands the main agent runs.
- Pi's bundled `examples/extensions/subagent` runs subagents as hidden `--mode json`
  subprocesses inside a tool call. Good reference, but not tmux-visible.

## Options

1. **Skill only.** Skill tells the main agent to open a column, write the task to a
   temp file, start `pi --model ... @task.md` with an appended system prompt that
   says "when done, write your report to `<file>` then run `tmux wait-for -S <chan>`".
   Main blocks on `tmux wait-for <chan>` (or polls the file).
   Pros: no code. Cons: main is blocked while waiting, relies on the subagent model
   following instructions, model default is a guess, no fallback if the subagent dies.
2. **Skill + small extension (recommended).** The extension provides the plumbing
   (inbox watch, current model, a `subagent_report` tool in the child, auto close).
   The skill tells the main agent when and how to spawn, via a helper script.
   Pros: async, main keeps working or idles and is woken by the report, exact model
   default, deterministic close and fallback. Cons: one extension plus one script.
3. **Extension tool only.** A `subagent_spawn` tool does everything, no skill.
   Pros: most deterministic. Cons: you asked for a skill, and a tool is always in
   the tool list (token cost every request) while a skill loads on demand.

## Recommended design (option 2)

### Files (all in pi-agent-config)

- `skills/subagent/SKILL.md`: when to use, how to write the task, calling the script,
  what to do with reports.
- `skills/subagent/spawn.sh`: opens the column and launches the child pi.
- `extensions/subagent.ts`: parent and child behaviour, selected by env vars.

### Parent side (extension, main pi)

- At `session_start`, create an inbox `$XDG_RUNTIME_DIR/pi-subagents/<pid>/` and set
  `process.env.PI_SUBAGENT_INBOX`, `PI_SUBAGENT_MODEL` (`provider/id`) and
  `PI_SUBAGENT_THINKING`. Update the model vars on `model_select` /
  `thinking_level_select`.
- `fs.watch` the inbox. For each new `<id>.json` report, call
  `pi.sendMessage({ customType: "subagent-report", content, display: true },
  { triggerTurn: true, deliverAs: "followUp" })`, then delete the file.
- Content: subagent name, status (`done` / `exited-without-report`), the report text,
  pane id, and the child session file path so the main agent can read the full
  transcript if needed.
- Remove the inbox in `session_shutdown`.

### Child side (same extension, active when `PI_SUBAGENT_REPORT_TO` is set)

- Register a tool `subagent_report({ summary })`. It writes
  `{ id, name, status, summary, pane, sessionFile }` atomically (write tmp, rename)
  into the parent inbox. If `PI_SUBAGENT_KEEP_OPEN` is not `1`, it then calls
  `ctx.shutdown()`.
- `session_shutdown` without a prior report writes an `exited-without-report` entry
  with the last assistant text, so the main agent is never left waiting.
- Do not set up a parent inbox in the child (no nested subagents).

### `spawn.sh`

```
spawn.sh [--model provider/id[:thinking]] [--keep-open] [--name NAME] [--cwd DIR] TASK_FILE
```

- Requires `$TMUX` and `$PI_SUBAGENT_INBOX` (fails clearly otherwise).
- Model: `--model` if given, else `$PI_SUBAGENT_MODEL:$PI_SUBAGENT_THINKING`.
- `PANE=$(tmux-columns new "$TMUX_PANE")`, `tmux select-pane -t "$TMUX_PANE"` to
  return focus, `tmux select-pane -t "$PANE" -T "subagent:<name>"` for a title.
- Sends one short line to the pane:
  `PI_SUBAGENT_REPORT_TO=<inbox> PI_SUBAGENT_ID=<id> PI_SUBAGENT_NAME=<name>
  PI_SUBAGENT_KEEP_OPEN=<0|1> pi --model <m> --append-system-prompt <child-prompt.md>
  @<task-file>; [ $? -eq 0 ] && exit`
  The pane closes when pi exits cleanly, and stays open on error so the failure is
  visible.
- Prints `id` and pane id for the main agent.

### Child system prompt (`skills/subagent/child-prompt.md`)

Short: you are a subagent started by another agent; do the task in the first message;
when finished (or blocked and needing the main agent) call `subagent_report` with a
concise result (findings, files changed, open questions); do not spawn subagents.
The user's global AGENTS.md still applies.

### `SKILL.md` contents

- Trigger: user asks for a subagent / delegate / "let an agent do X in a pane".
- Write a self-contained task file to `/tmp/pi-subagent-<name>.md` (the child has no
  context from this conversation: include paths, goal, constraints, what to report).
- Run `spawn.sh`, tell the user the name and pane id in one line, then continue or end
  the turn. Do not poll the pane. The report arrives as a `subagent-report` message.
- Model mapping: resolve user-named models against `enabledModels` (as in AGENTS.md).
- `--keep-open` only when the user asks. Several subagents may run in parallel.
- On a report: summarise it for the user, act on it only if the original request said so.

## Open questions

1. Does pi-automode need a rule for running `spawn.sh` / `tmux send-keys`? Check
   during the first test.

## Phases

1. [done] Extension (`extensions/subagent.ts`), typecheck with `bun run typecheck`.
2. [done] `spawn.sh` and `child-prompt.md`. spawn.sh writes a per-run `run.sh` under
   `$XDG_RUNTIME_DIR/pi-subagents/runs/<id>/` and types only `bash run.sh && exit` into
   the pane. On a non-zero pi exit, run.sh drops a `failed` report into the inbox and
   the pane stays open.
3. [done] `SKILL.md`, plus a pointer from the tmux skill.
4. [done] Tests, all passed:
   - Env vars exported in the parent bash tool.
   - Single subagent: report arrives, pane closes, run dir removed.
   - `--keep-open`: report says "kept open", pane stays; Ctrl+D later closes it with no
     extra report.
   - `--model claude-bridge/claude-haiku-5-5`: runs on haiku.
   - Esc + Ctrl+D before reporting: `exited-without-report` with last reply.
   - Unknown model: `failed` report, pane stays open with the pi error.
   - Auto mode did not block running `spawn.sh`. pi overrides the pane title with its
     own (`π - subagent: <name> - <dir>`), so the `-T` title is cosmetic only.

## Review fixes (code review by a subagent, 2026-11-14)

Done in `spawn.sh`, `SKILL.md`, `child-prompt.md`:

- Task is passed on stdin (`-`) or as a file and copied to `run_dir/task.md`, so there
  are no predictable `/tmp` task files and nothing to clean up.
- Refuses to run without `XDG_RUNTIME_DIR` (no `/tmp` fallback).
- run.sh exports `PI_SUBAGENT_RUN_DIR`, writes `failed` only when pi exits non-zero
  and `run_dir/reported` is missing, builds the JSON with `jq`, and turns a failed
  `cd` into a `failed` report instead of exiting silently.
- Removed the ineffective `select-pane -T`. Output line shows thinking when inherited.
- SKILL.md: stdin heredoc, refer to subagents by name with pane ID, malformed reports.
- child-prompt.md: report the question instead of stopping for review.

Done in `extensions/subagent.ts`:

- Unique report file names (`<id>-<ms>-<uuid8>.json`), drop the `seen` set.
- Nested pi guard via `PI_SUBAGENT_CHILD_PID` (only the pid spawn.sh started is the child).
- `subagent_report`: catch write errors; if undelivered, stay open and say so.
- Write the `run_dir/reported` marker; use it (not just memory) to skip
  `exited-without-report` after /reload.
- Watcher `error` handler; clear the inbox on `startup` (stale inbox, pid reuse).
- No `/tmp` fallback; malformed reports become a message; unlink after sending.
- Add `failed` to `ReportStatus`; drop the redundant `setActiveTools`.

Retest after reload, all passed: single subagent (report, pane closes, `--tools` alone
enables `subagent_report`), keep-open plus `/reload` in the child then a second report
(arrived; Ctrl+D afterwards sent nothing), quit before reporting (exactly one
`exited-without-report`), unknown model (`failed`).

## Possible follow-ups

- Pane identification: the pi session name is now `subagent: <name> (%N)`, so pi's
  pane title includes the pane ID.
- Pane titles (nixos-config, uncommitted): `tmux.conf` sets `pane-border-status top`
  and a border format without the click buttons; `zsh.nix` sets the pane title to the
  running command in tmux and clears it at the prompt.
- Written, typecheck passes, untested: `extensions/terminal-title.ts` (pi title `π <state><label>`, label =
  session name, else shortened first prompt, else cwd; state `● ` working, `? `
  waiting on a UI prompt, nothing idle).
