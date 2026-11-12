# Session recap (Claude Code style away summary)

Goal: a dim one-line `※ recap:` above or below the editor, stating the task and the next step, shown after being away.

## Candidates (from READMEs, source not reviewed)

| Package | Trigger | Model | Notes |
|---|---|---|---|
| `@tmustier/pi-session-recap` (`git:github.com/tmustier/pi-extensions`, filter `session-recap/index.ts`) | terminal blur 90 s (DECSET ?1004), turn ending while blurred, 120 s idle fallback, session resume | `--recap-model`, else Haiku for Anthropic sessions, else active model | Closest to Claude Code. Saves recap as a custom entry, reused on resume if still current. No system prompt or tools sent, reasoning off. Config via CLI flags only. |
| `@ladbabynpm/picc-recap` | 5 min idle after `agent_settled`, `/away` | `small-fast` heuristic, `current`, or `provider/id` | Port of Claude Code's prompt and `※` marker. Last ~30 messages. Config in `~/.pi/agent/extension-data/picc-recap/config.json`. |
| `@tifan/pi-recap` | 5 min idle after settle, `/recap`, resume | default `openai-codex/gpt-5.6-luna`, change with `/recap config` | Goal-first one-liner. 0 dependencies, ~85 installs/week. |
| `Dovyski/pi-recap` | after every interaction | `openai/gpt-5-nano` | Recap in status bar plus terminal title. |

Others seen, not reviewed: `pi-recap` (Fornace, always-visible panel), `@fradser/pi-recap`, `amiklosi/pi-recap`, `ssweens/pi-recap`, `JNRuan/pi-recap`, `@lazco/pi-recap` (popup), `pi-spark`, `pi-agent-session-recap`.

## tmustier session-recap review (npm `@tmustier/pi-session-recap` 0.6.1)

Source: single `index.ts` (635 lines), identical in the npm tarball and repo HEAD `f2632e7`. No dependencies, no install scripts, Pi packages as peers.

- Network: only the recap model call (`pi-ai/compat` `complete`/`completeSimple`), with key, headers and base URL from `ctx.modelRegistry.getApiKeyAndHeaders()`. `cacheRetention: "none"`, `maxTokens: 256`, no reasoning, empty system prompt, Pi session ID passed as `sessionId`.
- Data sent: last 30 messages of the projected context, including assistant text, tool calls and tool results (each result cut to first and last 2,000 chars), plus the first user request (up to 8,000 chars) and the latest compaction summary. Much more than supi, which sends only the last assistant message.
- Files: appends a `session-recap` custom entry to the session file, then restores the file's atime/mtime with `utimesSync`. Nothing else written.
- Terminal: writes DECSET `?1004h` to stdout and adds its own `process.stdin` data listener for `ESC[I`/`ESC[O`. Pi 1.4.0 fullscreen already enables 1004 with mouse mode and parses focus-in itself, so the sequences are expected. On shutdown the extension writes `?1004l`.
- Display: in fullscreen it appends a component to `tui.children[0]` (Pi's internal transcript container). Relies on Pi internals; falls back to an above-editor widget if the shape differs.
- Model: `--recap-model` CLI flag only (no settings file). Without it, a non-Anthropic, non-GPT session uses the active model. `claude-bridge/*` sessions likely fail silently, since `completeSimple` cannot route Pi-only custom providers (caught and returns nothing).
- Minor: `assert` on a malformed saved recap throws outside the try block (unhandled rejection on resume).

## picc-recap review (npm `@ladbabynpm/picc-recap` 0.1.1, published 2026-09-03)

Source: `src/index.ts`, `src/awaySummary.ts`, `src/config.ts` (849 lines). No dependencies, no install scripts.

- Network: only the recap model call (`pi-ai/compat` `complete`), auth from `getApiKeyAndHeaders()`. Requires a non-empty `apiKey`. No reasoning control, no cache setting, `maxTokens: 300`.
- Data sent: last 30 raw branch `message` entries with role user or assistant. Tool results excluded; tool calls included as `[tool:Name <full JSON args>]` (untruncated, so `write`/`edit` contents go out). Uses `getBranch()`, not the projection, so it ignores compaction and context edits.
- Files: reads its config; appends an `away_summary` custom entry (session mtime changes). Optional `sessionMemoryPaths` reads any listed files (empty by default).
- Display: plain widget, dim `※ recap:` in italics. Matches the Claude Code look. No Pi internals touched.
- Trigger: 5 min after `agent_settled` if still idle, cancelled by input or a new run. `/away` manual. At most one per user turn. No focus detection, no recap on resume.
- Model: JSON config. Default `small-fast` picks the first available model whose ID contains haiku/flash/mini/etc., preferring the current provider (unpredictable with OpenRouter's catalog; picks `claude-bridge/claude-haiku-*` in bridge sessions, which fails).
- Problems: errors go to `console.debug`/`console.warn`, which write raw text into the TUI. No `stopReason: "length"` check, so a truncated reply can be shown; with a reasoning model and no reasoning control, reasoning can use the 300 tokens and leave nothing.

## Comparison

| | tmustier session-recap | picc-recap |
|---|---|---|
| Trigger | terminal blur 90 s, turn ends while blurred, idle fallback, resume | 5 min idle after settle |
| Look | `✦ recap` header + dim text, in transcript (fullscreen) | dim `※ recap:` line, like Claude Code |
| Model config | `--recap-model` CLI flag | JSON file, explicit `provider/id` |
| Sent | 30 msgs incl. tool results (2k+2k chars each) and tool calls, initial request, compaction summary | 30 msgs, tool calls with full args, no tool results |
| Reasoning / truncation | reasoning off, only complete replies shown | neither handled |
| Error reporting | `ctx.ui.notify` | `console.*` into the TUI |
| Pi internals | inserts into transcript container | none |
| Maintenance | 0.6.1, Nov 2026, tests | 0.1.1, Sep 2026 |

## Custom extension (`extensions/session-recap.ts`)

Adapted from tmustier's `index.ts` (MIT, attributed in the file header). Status: phase 1 written. Type-checks clean (strict) against Pi 1.4.0 typings; fails against the repo's installed 0.84.2 typings (missing `streamSimple`, `buildSessionProjection`, `ContextEditEntry`, `ProjectedSessionEntry`). Repo typings now pinned to 1.4.0 and clean. `/recap` and the away trigger confirmed working.

Changes from tmustier:

- Config in `~/.pi/agent/session-recap.json` instead of CLI flags: `enabled`, `model` (`provider/id`), `awaySeconds`, `idleSeconds`, `focusReporting`, `duringActive`. Read on `session_start`, so `/reload` applies edits.
- Model: configured model, else the active model. `claude-bridge/*` is never used; with no usable model, auto recaps are skipped and `/recap` warns.
- Model call through `ctx.modelRegistry.streamSimple()` (Pi handles auth) instead of `pi-ai/compat` with manual keys. No reasoning option, `maxTokens: 256`, `cacheRetention: "none"`.
- No tool results sent. The conversation is flattened into one text transcript: user and assistant text (each cut to first and last 2,000 chars) and `[tool: name args]` markers (args cut to 300 chars). Avoids sending tool calls without results.
- Display: dim `※ recap: <italic text>` widget above the editor. No insertion into Pi's transcript container.
- `assert` on saved recaps replaced with a type guard. `/recap` warns when the model returns no complete recap.

Kept: focus detection (DECSET 1004, raw stdin listener), turn-end-while-blurred, idle fallback, resume recaps, saved `session-recap` entries with mtime preserved, `/recap`.

Phases:

1. Write extension and config. Done.
2. User runs `/reload`, tries `/recap`, then tabs away for 90 s and back. Done, both work.
3. Tune prompt, placement, or timings from feedback.

## Notes

- Use a direct model (OpenRouter), not `claude-bridge/*`.
- Ghostty/Kitty/WezTerm support focus reporting; inside tmux needs `set -g focus-events on`.
