---
name: zoxide
description: Resolve an ambiguous directory name to an absolute path using zoxide's frecency database. Use when the user's request targets a directory by a short name or keyword that is not an absolute path, not a relative path from the current working directory, and does not match an existing subdirectory here. This includes requests like "list files in nixos-config", "open my-project", "what's in dotfiles", or any task where the target directory is identified only by a short name and its real path is unknown.
---

# zoxide

Query the local zoxide database to resolve a directory keyword to its most likely absolute path.

## When to use

- The user's request mentions a directory by short name (e.g. "nixos-config", "my-project", "dotfiles") without a leading `/` or `./`
- The name does not match any subdirectory in the current working directory
- The task requires knowing the real path before running further commands (ls, find, cd, grep, etc.)
- Examples: "list all files in nixos-config", "what's in my dotfiles", "open pi-agent-config", "show me the README in my-project"

## Usage

```bash
{baseDir}/query.sh <keyword> [keyword2 ...]
```

- Pass one or more keywords. Zoxide ranks matches by frecency (frequency + recency).
- Returns the best matching absolute path, or a ranked list when multiple plausible matches exist.
- If no match is found, the script exits with a non-zero status and prints a message.

## Steps

1. Run the script with the keyword(s) the user mentioned.
2. If a single result is returned, treat that path as the resolved directory and continue.
3. If multiple results are returned, pick the top result or ask the user to confirm when the choice is ambiguous.
4. If no result is found, tell the user that zoxide has no record of a directory matching that name.
