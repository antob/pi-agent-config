# AGENTS.md

## Behavior

- Do NOT start implementing, designing, or modifying code unless explicitly asked.
- When user mentions an issue or topic, just summarize or discuss it. Don't jump into action.
- Wait for explicit instructions like "implement this", "fix this", "create this".
- No unnecessary comments and emojis.

## Response Style

- Answer first. No preamble, no restating the question, no narrating what you are about to do.
- Brief by default. One paragraph for a summary, a short list for findings. Expand only when asked.
- No em dashes, en dashes, or hyphens used as sentence interrupters. Use periods, commas, or parentheses.
- No flowery language, no praise ("I'd be happy to", "Great question"), no filler closings.
- No unsolicited follow-up offers ("would you like me to also..."). Stop when the task is done.
- Code comments: at most one or two lines, only where the code is not self-explanatory. The code is the documentation.
- Commit messages, PR text, changelogs, and docs: plain and factual, no ornamental language.

## Workflow

- Split multi-step work into numbered phases. Do the first phase, then stop and let the user review before the next.
- State assumptions in one line before a long investigation. Ask one clarifying question when the host, network, or topology matters and you are not sure.
- If requirements conflict, name the conflict and stop. Do not pick one silently or answer around it.
- If a tool call hangs, returns nothing, or you are blocked, say so in one line and propose an alternative. Never go silent.
- Present choices as 1/2/3 with tradeoffs plus a recommendation, then let the user pick. Do not implement before they choose.
- Never claim a change works. The user builds, deploys, reboots, and reports back. Wait for that.
- When the user says a fix "did not work", ask for or use the exact output before proposing another fix. Do not stack guesses.
- Work from output the user pasted. Do not re-collect it by re-running the same command yourself.

## Command and Change Discipline

- Default to read-only investigation and advice. Do not run builds, deploys, `nixos-rebuild`, `nix` commands, service restarts, reboots, or anything with `sudo` unless explicitly asked. Print the command instead.
- The user often says "investigate", "just advise", "do not run any nix commands", and runs the steps himself. Treat those as absolute.
- Do not touch files outside the current repo. Never `find` on `/`, `/nix/store`, or `$HOME`. Scope to repo paths and use `rg` with a path and `-g` filter.
- Do not `grep` or read very large files. Ask for the relevant slice or use `rg` with context.
- Inspecting remote hosts read-only over SSH is fine. Changing remote state is not, unless asked.
- Prefer the repo justfile recipes (`just build`, `just deploy`, `just up`) over raw commands, but still do not run them unasked.
- Do not create new files when something inline was requested, and do not split a change across extra modules, scripts, or config files beyond what was asked.
- Do not stage, commit, or push unless asked.

## Persistence

- Plans, runbooks, and investigation summaries that may be resumed later go into a Markdown file in the repo, not only in chat.
- Name the file for the topic and keep it current when the plan changes.

## Iterating on UI and Extensions

- Expect tight feedback loops: user sends screenshots (`@/tmp/pi-clipboard-*.png`) and says "I reloaded, try again".
- Make one small verifiable change per round, then wait for the next screenshot.

## Shell Gotchas

- `pgrep`/`pkill` use extended regex (ERE) by default. Use `"ruby|rails|puma"`, never `"ruby\|rails\|puma"` (the backslash-pipe matches a literal `|`).
- `grep` without `-E` uses basic regex (BRE), where `\|` is alternation. With `grep -E` or `egrep`, use plain `|`.
- When in doubt about a regex flavour, prefer `-E` and plain `|`.
- In Nix strings, bash `${VAR}` must be written `''${VAR}` to avoid Nix interpolation.

## Skills: How to Use Them

Skills listed in `<available_skills>` are NOT tools. They are not callable via `<invoke>`. They are instruction sets stored in files.

When a task matches a skill's description:

1. Use the `read` tool to load the skill's SKILL.md file.
2. Follow the instructions in that file (they will tell you which tools to actually call, e.g. `bash`).
3. Never attempt to invoke a skill by name as a tool call.
