---
name: audit-extensions
description: Audit the user's Pi extensions, skills and packages. Checks compatibility with the Pi version pinned in ~/.pi/agent/package.json (TypeScript check of local extensions, peer ranges and API use of packages), warns when the global pi binary differs from the repo version, reviews code for security issues, checks for newer package versions, and produces a summary table. Use when the user asks to check, audit, review or health-check their extensions, skills or packages, or before or after upgrading Pi.
---

# Audit Extensions

The reference Pi version is the one in `~/.pi/agent/package.json` (`@earendil-works/pi-coding-agent`), with typings and source in `~/.pi/agent/node_modules/@earendil-works/`. The global binary (`pi --version`) is Nix managed and can drift from it.

This is a read-only audit. Do not run `pi update`, `bun install`, or edit any extension, skill or package. Print fix commands instead. The only files written are the facts and the report in `~/.pi/agent/tmp/pi-audit/` (gitignored).

## 1. Collect facts

```bash
python3 -I ~/.pi/agent/skills/audit-extensions/scripts/audit.py
```

Flags: `--offline` (skip npm registry and `git ls-remote`), `--no-typecheck`, `--max-hits N`, `--out DIR`.

The script prints a Markdown report and saves it to `~/.pi/agent/tmp/pi-audit/YYYY-MM-DD-facts.md`. It contains:

- **Pi versions**: global, declared, installed, copy under `npm/node_modules`, latest on npm, and version warnings.
- **TypeScript check**: `tsc` over the repo `tsconfig.json` (local `extensions/` and `skills/` `.ts`). Legacy `@mariozechner/*` imports are remapped to `@earendil-works/*` for the check, because a stale 0.73 copy of the old scope may sit in `node_modules` and would otherwise hide real breakage.
- **Local extensions / skills / packages**: paths, the extension's doc comment or package description, registered tools/commands/providers, Pi imports, legacy imports, frontmatter problems, peer ranges evaluated against the repo version, the Pi version a package was built against (devDependencies), lifecycle script commands, and update status (npm `latest`, git remote HEAD vs local HEAD). Use the doc and registrations for the Summary column instead of opening files.
- **Package TypeScript check**: each package's extension entry points checked against the repo's Pi packages. With a shipped `tsconfig.json` its settings are used. Without one, tsc runs with and without `strict` and only errors present in both are listed; settings-dependent errors are counted but not shown, because they reflect the package's code style rather than Pi API changes.
- **Changelog matches**: for packages built against an older Pi, the Breaking Changes and Removed entries of the Pi changelog between that version and the repo version, limited to entries whose API identifiers appear in the package source, with `file:line`. Matches are leads: read the entry and the code to decide whether the change affects how the package uses the symbol.
- **Security leads**: regex hits per category with `file:line`, and hosts referenced. `SHELL-STRING` (shell commands built with template literals, concatenation, `shell: true`, `sh -c`) is high priority, review every hit. Then `exec`, `eval`, `network`, `secrets`, `fs-write`, `obfuscation`, and low-priority `env` (env var reads, first 3 locations only). In Markdown files only `shell-string`, `network` and `obfuscation` count. These are leads, not findings. Most hits are benign.

## 2. Compatibility

- Local extensions: TS errors are the primary signal. Classify each as API break (Pi type or export changed), or environment issue (missing `@types/*`, missing `lib: DOM`). Legacy `@mariozechner/*` imports work only through a runtime alias, so flag them as "migrate import" even when types pass.
- Packages: peer `MISMATCH` is a hard failure. Errors from the package TypeScript check are the next strongest signal; classify them the same way as local ones. "OLDER THAN REPO" means the package was typed against an older Pi; review its changelog matches and only report a break when the package's use of the symbol is affected.
- Skills: frontmatter problems from the report, plus any CLI or script they depend on that is missing (`command -v`).

## 3. Security review

Read the code around each lead and judge in context. Per component, answer:

- What leaves the machine, to which host, and is it expected for the stated purpose?
- Are shell commands built from model or user input without quoting or argument arrays?
- Does it read credentials (`auth.json`, env API keys, `~/.ssh`) and where do they go?
- Does it write or delete outside its own state files or the working directory?
- `eval`, dynamic `Function`, encoded blobs, lifecycle install scripts, or downloaded binaries.

Rate each component: **OK**, **Note** (worth knowing, acceptable), **Concern** (should change or be removed). Do not execute any extension or package code to test behavior.

For packages, the scanned code is the package itself plus same-scope runtime deps. Third-party deps are not reviewed; the lifecycle-scripts section lists installed deps that run code at install time.

### Reading pi-automode's source

pi-automode hard-denies, in code, any `sed`, `python`, `node`, `perl`, `ruby`, `cp`, `mv`, `tee`, `rm` or similar command whose text contains `pi-automode`, even read-only ones like `sed -n`. No config rule can override this. To review its source under `~/.pi/agent/npm/node_modules/@czottmann/pi-automode/`, use the `read` tool (with `offset`/`limit`), `rg`, `cat` or `head`. If any other denial occurs, report it and mark the component "not fully reviewed" instead of retrying another way.

## 4. Report

Start with warnings, most important first. If the global Pi version differs from the repo version, the first line must say so, with both versions.

Then one table covering every local extension, local skill, package, and package-provided skill:

| Name | Kind | Source | Version | Latest | Pi compat | Security | Summary |
| --- | --- | --- | --- | --- | --- | --- | --- |

- Kind: extension, skill, package.
- Source: local, npm, git.
- Version / Latest: `-` for local items. Mark updates with `update`.
- Pi compat: `ok`, `legacy import`, `N TS errors`, `peer mismatch`, `verify (built for X)`.
- Security: OK, Note, Concern.
- Summary: what it does, at most about 12 words.

After the table, a short findings list only for rows that are not ok/OK, each with `file:line` and the suggested fix. Then list update commands, for example `pi update npm:@czottmann/pi-automode`, and `bun update` in `~/.pi/agent` for repo Pi deps. Do not run them.

Write the full report (warnings, table, findings, update commands) to `~/.pi/agent/tmp/pi-audit/YYYY-MM-DD-report.md`, overwriting a report from the same day, and give the path at the end of the chat reply.
