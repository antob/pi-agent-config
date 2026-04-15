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

## Skills: How to Use Them

Skills listed in `<available_skills>` below are NOT tools. They are not callable via `<invoke>`. They are instruction sets stored in files.

When a task matches a skill's description:

1. Use the `read` tool to load the skill's SKILL.md file.
2. Follow the instructions in that file (they will tell you which tools to actually call, e.g. `bash`).
3. Never attempt to invoke a skill by name as a tool call.
