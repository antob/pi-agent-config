# Model router for claude-bridge

Renamed from model-advisor on 2026-11-18 (extension dir, config file `model-router.json`, status key, this file). The `/model-advice` command keeps its name. Earlier sections use the old wording.

Status: plan agreed (A1, B1, C1). Phase 1 done and confirmed live (2026-11-15). Phases 1 to 4 done (2026-11-15). Phases 1 to 3 tested live; phase 4 added the README entry. Quota awareness (C2) not done.

Phase 3 test run (agent-driven Pi in a tmux pane, `/tmp`, Sonnet · high default):

| Test | Result |
|---|---|
| A: first prompt "what does the -N flag do in git add", Switch | Dialog before any request, switched to Haiku · low, bridge `row=1 resume=none effort=low` |
| C: `/model-advice` after A | "current model fits" |
| B: `/new`, monolith migration question (two-sentence answer), Keep | Suggested Sonnet · low (judged the deliverable), stayed on Sonnet · high, `effort=high` |
| B2: second prompt in that session | No dialog, cache read 97% |
| E: `/model-advice` mid-session | Offered Haiku · low with "(re-sends the history uncached)", Escape kept the model |

Phase 3 choices beyond the plan:

- No dialog for subagent children (`PI_SUBAGENT_ID`) or sessions started with `--model`: their first prompt arrives as `interactive` with nobody to answer, or the model was chosen explicitly.
- A keyword-fallback suggestion only goes to the status line, no dialog.
- Status line key `model-router`: `choosing a model...`, `<model> fits`, `switched to ...`, `kept, suggested ...`, `guess ... (<error>)`. Cleared on `session_start`.
- `/model-advice` without text refuses to switch while the agent runs.

Phase 2 results (`/model-advice`, DeepSeek, 611 to 914 ms each, all as expected):

| Task | Pick |
|---|---|
| what does the -N flag do in git add | Haiku · low |
| add a --json flag to the backup-status script | Sonnet · medium |
| refactor the networking aspects so wireguard and tailscale share one module | Opus · high |
| figure out why desktob intermittently loses DNS after suspend | Opus · high |

Phase 1 result (`claude-bridge.log`, switch Sonnet to Haiku `low` in the `input` handler of the first prompt):

```
syncResult: path=clean-start ... from=none priors=0 ... row=1
provider: fresh query model=claude-haiku-5-5[1m] msgs=1 ... resume=none effort=low ... prompt=say hi
```

The switch and the level apply to the same run, and there is no re-import. A later prompt in a switched session resumes the Claude Code session normally (`resume=<id>`, model and effort kept).

Writes: pi-automode hard-denies every path under `~/.pi/agent/extensions/` (`isSafetyControlPath`, `paths.ts`). Edit via `~/Projects/pi-agent-config/extensions/model-router/`, which the user's allow rule covers.

## Goal

When a new task starts, suggest which Claude model (Haiku, Sonnet, Opus, Fable) and thinking level to use, based on Anthropic's published guidance. Only active when the session model's provider is `claude-bridge`.

## Decisions

- A1: the suggestion comes from a side chat model, not claude-bridge. Default `openrouter/deepseek/deepseek-v4.1-flash-1017`, configurable. Keyword fallback when the call fails or times out.
- B1: blocking `ctx.ui.select` on the first prompt of a session, before the first provider request.
- C1: Anthropic guidance only. Quota from `claude-usage-band.ts` is not used in v1.

## Anthropic guidance (sources, read 2026-11-15)

- https://docs.claude.com/en/docs/about-claude/models/choosing-a-model (selection matrix, effort)
- https://code.claude.com/docs/en/model-config (aliases, "Work with Fable", effort levels). Only the model and effort sections were read.
- https://docs.claude.com/en/docs/about-claude/models/optimizing-for-cost-and-intelligence (only "Start here" and "Upgrade the model" were read)
- https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan

| Family | Use for | Thinking level |
|---|---|---|
| Haiku 5.5 | Simple tasks. Quick questions, lookups, renames, small edits, formatting, summaries, commit messages, high-volume work with checkable output. | default `medium`, `low` for trivial |
| Sonnet 5.5 | Daily coding. Features with a clear scope, tests, data analysis, docs, code review, tool-heavy agent work. | `medium`, `high` when verification matters (bug fix in existing code) |
| Opus 5.5 | Complex reasoning and agentic coding. Multi-file refactors, systems engineering, debugging across subsystems, design with tradeoffs, long autonomous runs. Anthropic: "Most workloads start with Opus 5.5"; Claude Code default on Pro. | `medium`, `high`/`xhigh` for hard problems |
| Fable 5.2 | Hardest and longest tasks. Work larger than one sitting, ambiguous root-cause or outage investigation, architecture decisions, deep research ending in a finished document. Anthropic: move to Fable when Opus at `xhigh`/`max` still falls short. | default |

Rules derived from the sources:

- "Tuning effort is often a better lever than switching models." Always suggest a thinking level with the model.
- On Pro, Fable runs on pay-as-you-go usage credits from the first request. Suggest it only on a strong case and always label it "usage credits".
- Docs disagree on Fable 5.2's default effort (`high` on the platform page, `medium` in Claude Code docs). Not relevant while Pi sends an explicit thinking level.

## Constraints from the setup

- pi-claude-bridge (0.12.0, README): a model change or changed instructions import Pi's history into a fresh Claude Code session, uncached. A switch is free only before the first request, so the extension acts on the first prompt.
- The extension must not change the system prompt or inject messages. UI only (`notify`, `select`, `setStatus`).
- Side calls must not go through claude-bridge (quota, and possible nested-call rejection noted in `prompt-suggestions.md`).
- Pi thinking level maps to Claude Code effort in the bridge (`effortForReasoning`, `src/index.ts`).
- Do not hardcode model IDs. Resolve each family to the newest `claude-bridge` model in `ctx.scopedModels` (from `enabledModels`) whose id contains `haiku`, `sonnet`, `opus` or `fable`. A family with no match is never suggested.

## Design

One directory: `extensions/model-router/index.ts`. Config: `~/.pi/agent/model-router.json`, read on each use, same shape as `session-recap.json`:

```json
{
  "enabled": true,
  "model": "openrouter/deepseek/deepseek-v4.1-flash-1017",
  "timeoutMs": 4000,
  "allowFable": true
}
```

Trigger (`input` event):

1. Skip unless `ctx.model?.provider === "claude-bridge"`, `ctx.hasUI`, `event.source === "interactive"` and `event.streamingBehavior` is undefined.
2. Skip unless this is the first user prompt on the session branch.
3. Skip text starting with `/`.

Suggestion:

1. Side call via `ctx.modelRegistry.streamSimple()`: system prompt holds the rubric for the available families, user content is the prompt (head and tail kept, 4k chars). `cacheRetention: "none"`, `maxTokens: 200`, no reasoning. Expected output: `{"family": "...", "level": "...", "reason": "..."}`.
   - The current model is left out of the request so it does not bias the pick.
   - Levels are limited to `low`, `medium`, `high`. The bridge maps Pi `xhigh` to Claude `max` (`REASONING_TO_EFFORT`, `cc-child.ts`), which Anthropic says is prone to overthinking.
2. Validate: family must resolve to an available model, thinking must be a valid Pi level. On parse error, timeout or failure, use the keyword fallback.
3. Keyword fallback: small scored word lists per family (for example `rename`, `typo`, `what is` toward Haiku; `refactor`, `architecture`, `across` toward Opus). Never suggests Fable.

UI:

- Suggestion equals current model and level: `setStatus("model-advisor", "advisor: ok")`, no dialog.
- Otherwise `ctx.ui.select` titled with the suggestion and reason, for example `Opus 5.5 (high): multi-file refactor of the auth flow`. Options: Switch, Keep current. Fable options carry "(usage credits)".
- Switch: `pi.setModel(model)` then `pi.setThinkingLevel(level)`, then return `continue` so the prompt proceeds.
- Esc or Keep: continue unchanged.

Command `/model-advice [text]`:

- With text: dry run, show the suggestion via `notify`, change nothing. Used for tuning the rubric.
- Without text: suggest from the last user prompt and offer the same select dialog (mid-session new task; switching then costs a re-import, stated in the dialog). Phase 3; in phase 2 it prints usage.

`enabled` in the config only gates the automatic trigger (phase 3).

## Phases

1. Probe (source reading says yes: `_preparePrompt` runs input handlers before `_startRun`, `setModel` sets `agent.state.model` synchronously and resets the thinking level, and the bridge takes the fresh path, row 1, when there is no state and no priors): in an `input` handler on claude-bridge, call `pi.setModel` and `pi.setThinkingLevel` and confirm the same run uses the new model and effort (bridge debug log, `claude-bridge-diag.log`) and that no re-import happens.
2. Suggestion logic: rubric prompt, side-model call, validation, keyword fallback, `/model-advice <text>` dry run.
3. Auto trigger on the first prompt with the select dialog and status line.
4. Optional: README entry, quota awareness (C2) if wanted later.

## Open questions

- Should skill invocations (`/skill:...`) be classified? Skipped in v1.

## Investigation: virtual model routing instead of the input hook (2026-11-18)

Source: https://docs.pi.dev/latest/virtual-models, `core/virtual-models.d.ts` in Pi 1.5.2 (API present), pi-claude-bridge 0.12.0 `src/index.ts`.

Idea: register `claude-bridge/auto` with `pi.registerVirtualModel`. `route()` classifies the first `user` request with the side model, stores the pick as router state, and returns the same physical model for every later request.

Bridge compatibility (source reading, not tested):

- The bridge only sees the physical model (`streamSimple(model, ...)`, `claudeCodeModelId(model)`), so the first routed request takes row 1 (clean start), same as today's pre-request switch.
- Row 3 (full uncached import) triggers on `state.model !== modelId` or a changed prompt append (`syncSharedSession`, line ~597). Effort is a per-query option, so changing only the thinking level per turn does not re-import. Whether Anthropic's prompt cache survives an effort change is unverified.
- Listing under provider `claude-bridge` keeps `ctx.model.provider === "claude-bridge"`, which the bridge's bash timeout hook (line ~2356) and `claude-usage-band.ts` rely on.

Gains:

- Uses a supported mechanism instead of `setModel` inside an `input` handler. No first-prompt detection, no `--model`/subagent heuristics: choosing `auto` is the opt-in, and it works without UI (subagents, print mode).
- Footer shows `auto • level → physical • level`; `/session` shows cost per physical model.
- State follows the session tree and survives resume and compaction.
- `retry` with `request.failed` can fall back on overload or rate limit (natural place for C2 quota awareness).
- The virtual thinking level can act as a budget, for example `low` caps at Sonnet, `medium` at Opus, `high` allows Fable. `allowFable` still applies on top.

Costs and breakage:

- The Switch/Keep dialog (B1) goes away. `route()` gets an `ExtensionContext`, so `ctx.ui.select` is possible, but it blocks inside the request path. Override is picking a physical model with `/model`.
- `handoff.ts` calls `complete(ctx.model!)` directly; with a virtual model that is api `pi-virtual` and fails. Needs the last physical model or `ctx.modelRegistry.streamSimple`.
- `claude-usage-band.ts` `seedCache` compares assistant `m.model` to `ctx.model.id` (`auto`), so the cache seed is always null. Needs the last response's model.
- `subagent.ts` exports `claude-bridge/auto` as `PI_SUBAGENT_MODEL`, so children route themselves. Probably fine, but a choice.
- `direct` requests (compaction summary, extension calls) have no state; route them to `previous` or Haiku.
- Mid-session re-route (`/model-advice` without text) still costs a re-import; it would reset the router state so the next `user` request re-classifies.

Open: keep the input-hook path for physical selections, or remove it and make `auto` the default model.

### Implemented (2026-11-18, not tested live)

- `claude-bridge/auto` in `extensions/model-router/index.ts`. Levels `low`/`medium`/`high` as budget (`BUDGET`). Route: `retry` returns `failed`; `direct` returns a bridge `previous`, else the latest successful bridge reply on the branch, else Sonnet (or the smallest available) at `medium`, with `off` when the request asks for `off`; a bridge `previous` that differs from the stored pick wins and becomes new state (source `kept`), so returning to `auto` never switches models; then the stored pick; otherwise classify the last user message (empty text goes straight to the keyword fallback), store `{modelId, level, reason, source}`. Status line `auto: ...`, also on router errors. A bad config file falls back to defaults with a warning; a budget with no available family takes the smallest available family; with no bridge models in `enabledModels`, all available bridge models are considered.
- Input hook kept for physical selections, skipped when the selection is virtual. `/model-advice` without text only notifies when `auto` is selected.
- `handoff.ts` uses `ctx.modelRegistry.streamSimple` (routes virtual models as `direct`, resolves auth) and throws on `stopReason: "error"`.
- `claude-usage-band.ts` `seedCache` accepts any bridge model when the selection is virtual.
- Typecheck passes against the Pi 1.5.2 types in the nix store. The repo's `node_modules` still has pi-coding-agent 0.84.2, so `npm run typecheck` in the repo will fail on `registerVirtualModel` until dependencies are reinstalled.
- `claude-bridge/auto` is in `enabledModels` (`settings.json`).
- Review fixes (subagent review, 2026-11-18, all 11 findings): the route order and fallbacks described above. `claude-usage-band.ts` imports `isVirtual` from `model-router/index.ts` and keeps the cache on `model_select` only when the next request goes to the model that replied last. `handoff.ts` shows generation errors instead of "Cancelled".

Test plan: `/model claude-bridge/auto`, new session, short question (expect Haiku or Sonnet, footer `auto • ... → ...`, bridge log row 1); second prompt in that session (no re-import, `resume=<id>`); `auto:low` with a refactor prompt (capped at Sonnet); switch to `auto` mid-session (status `kept`); `/compact` and `/handoff` under `auto`; resume the session and check the usage band seeds the cache.
