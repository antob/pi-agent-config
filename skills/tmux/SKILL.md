---
name: tmux
description: Use tmux panes and windows for logs, builds, and parallel tasks. Use this skill when the user mentions tmux, asks to open or manage panes or windows, wants to split the terminal, run something in a new pane, or check output from another pane.
---

# Tmux Usage

## Task

$@

## Detection

```bash
# Check if inside tmux (empty = not in tmux)
echo $TMUX

# Current session/window info
tmux display-message -p '#S:#I.#P'
```

## Open New Panes as Columns (Default)

The user's tmux uses a "columns" layout managed by `tmux-columns` (on `PATH`). A column is one top-level, side-by-side slot of the window layout and can hold several panes. Ctrl+Shift+Enter opens a new column. Always open new panes as a new column with `tmux-columns new`. Do NOT use a plain `tmux split-window`, it splits the current pane instead of adding a column.

`new`, `down` and `right` start the default shell in the source pane's working directory, make the new pane active, resize the affected column or container evenly, and print the new pane's ID on stdout. Capture it, give focus back, then type the command into the shell:

```bash
PANE=$(tmux-columns new "$TMUX_PANE") && tmux select-pane -t "$TMUX_PANE"
echo "$PANE"   # e.g. %347
tmux send-keys -t "$PANE" 'your command' Enter
```

Commands (`<pane>` is any pane target, use `"$TMUX_PANE"` for the calling pane):

| Command | Effect |
|---------|--------|
| `tmux-columns new <pane>` | New full-height column right of `<pane>`'s column (default for this skill) |
| `tmux-columns down <pane>` | Split `<pane>` vertically, within its column |
| `tmux-columns right <pane>` | Split `<pane>` horizontally, within its column |
| `tmux-columns swap <pane> left\|right` | Swap `<pane>`'s column with its neighbour (no-op at the edge or when zoomed) |
| `tmux-columns snapshot` / `closed` | Internal, run by tmux hooks. Do not call. |

Notes:

- `$TMUX_PANE` is the pane the agent runs in. Use it as the anchor, not the active pane.
- Use `down` or `right` only if the user explicitly asks for a split inside a column.
- The new pane is an interactive shell, so it stays open after the command exits. Do not append `; read`.
- The shell starts in the anchor pane's current directory. Use `cd /path && command` for another directory.
- Closing panes triggers the `closed` hook, which re-evens the layout. This is expected.

## Identify Panes You Open (Important)

Pane indexes are NOT stable. New panes can be inserted in the middle and tmux hooks (the columns relayout hooks on `after-kill-pane`, `after-split-window`) reorder panes. Never target a pane you opened by index (`:.2`).

Always capture the stable pane ID (`%N`) when creating the pane (see above), and use it for every later command:

```bash
tmux capture-pane -t "$PANE" -p -S -100
tmux send-keys -t "$PANE" 'text' Enter
tmux kill-pane -t "$PANE"
```

Rules:

- Get the ID from the column snippet above. For a new window use `tmux new-window -d -P -F '#{pane_id}'`.
- Shell variables do not persist between separate bash tool calls. Either do create and use in one call, or write the ID down (for example in your reply) and pass the literal `%N` in later calls.
- A pane ID is valid until that pane closes. If `tmux display-message -p -t %N '#{pane_id}'` fails, the pane is gone.
- To find an existing pane, look it up by ID or title, not index: `tmux list-panes -F '#{pane_id} #{pane_index} #{pane_current_command} #{pane_title}'`.
- Poll for output with `capture-pane` after a `sleep`, since the pane is asynchronous.
- Only kill panes you opened yourself (IDs you captured). Do not kill other panes unasked.

## Read Output from Other Panes

```bash
# Capture last 100 lines from a pane by ID
tmux capture-pane -t %347 -p -S -100

# Capture entire scrollback
tmux capture-pane -t %347 -p -S -
```

## Run Commands in Other Panes

```bash
# Send command to a pane by ID
tmux send-keys -t %347 'npm run dev' Enter

# Create a column and run a command (capture the ID, see "Open New Panes as Columns")
tmux send-keys -t "$PANE" 'tail -f logs/app.log' Enter
```

## Pane Targeting

| Target | Meaning |
|--------|---------|
| `%347` | Pane by unique ID (preferred, stable) |
| `:.1` | Pane index 1 in current window (unstable, only for panes you did not open) |
| `:0.1` | Pane 1 in window 0 (unstable) |
| `{last}` | Last active pane |

## Driving Pi in a Pane

- When the user asks for a subagent or wants to delegate a task to another agent, use the `subagent` skill instead of starting pi in a column by hand.
- Quit an interactive pi with `tmux send-keys -t %N C-d`. Ctrl+C may only clear the editor and not exit.
- Greyed-out text in the pi input box is a prompt suggestion (supi-prompt-suggestions extension), not user input. Ignore it.

## Important: devenv up requires nix develop

`devenv up` must always be invoked inside a nix shell. Never call `devenv up` directly. Always wrap it with `nix develop --no-pure-eval -c devenv up`.

## Common Patterns

| Task | Command |
|------|---------|
| Start devenv server (using nix develop) in given folder | open a column, then `tmux send-keys -t %N 'cd /path/to/folder && nix develop --no-pure-eval -c devenv up' Enter` |
| Watch logs | open a column, then `tmux send-keys -t %N 'tail -f app.log' Enter` |
| Check build output | `tmux capture-pane -t %N -p -S -50` |
| Start dev server | `tmux send-keys -t %N 'npm run dev' Enter` |
| Kill pane | `tmux kill-pane -t %N` |
| List panes | `tmux list-panes -a -F '#{pane_id} #{window_name}.#{pane_index}: #{pane_current_command}'` |
