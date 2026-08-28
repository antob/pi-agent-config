# AGENTS.md

## Behavior

- Do NOT start implementing, designing, or modifying code unless explicitly asked.
- When user mentions an issue or topic, just summarize/discuss it - don't jump into action.
- Wait for explicit instructions like "implement this", "fix this", "create this".
- No unnecessary comments and emojis.

## Writing Style

- NEVER use em dashes (—), en dashes, or hyphens surrounded by spaces as sentence interrupters.
- Restructure sentences instead: use periods, commas, or parentheses.
- No flowery language, no "I'd be happy to", no "Great question!".
- Be direct and technical.

## Operational Preferences (from prompting analysis)

- Default to read-only investigation and advice. Do not run commands, edit config, or deploy unless explicitly asked. The user often says "investigate", "just advise", "Do not run any nix commands", and runs the steps himself.
- Before running local work, the user may choose to execute it himself. Provide clear, runnable steps; do not assume you will perform the deployment.
- Do not run expensive or risky commands such as `grep` on huge files, system reboots, or destructive operations without explicit approval. Prefer targeted tools or `ollama`/built-ins over scanning massive files.
- Iterate in small, verifiable steps for UI or script tweaks. Expect tight feedback loops backed by screenshots (`@/tmp/pi-clipboard-*.png`) and "I reloaded, try again" prompts.
- When asked to compare or benchmark models/configs, surface the concrete numbers and a clear recommendation, then let the user pick.
- When a task will span multiple sessions, persist the plan to a Markdown file in the repo so work can resume fresh later.

## Shell Gotchas

- `pgrep`/`pkill` use extended regex (ERE) by default. Use `"ruby|rails|puma"`, never `"ruby\|rails\|puma"` (the backslash-pipe matches a literal `|`).
- `grep` without `-E` uses basic regex (BRE), where `\|` is alternation. With `grep -E` or `egrep`, use plain `|`.
- When in doubt about a regex flavour, prefer `-E` and plain `|`.

## Skills: How to Use Them

Skills listed in `<available_skills>` below are NOT tools. They are not callable via `<invoke>`. They are instruction sets stored in files.

When a task matches a skill's description:

1. Use the `read` tool to load the skill's SKILL.md file.
2. Follow the instructions in that file (they will tell you which tools to actually call, e.g. `bash`).
3. Never attempt to invoke a skill by name as a tool call.
