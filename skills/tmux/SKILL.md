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

## Read Output from Other Panes

```bash
# Capture last 100 lines from pane 1
tmux capture-pane -t :.1 -p -S -100

# Capture entire scrollback
tmux capture-pane -t :.1 -p -S -
```

## Run Commands in Other Panes

```bash
# Send command to pane 1
tmux send-keys -t :.1 'npm run dev' Enter

# Create pane and run command
tmux split-window -v 'tail -f logs/app.log'
```

## Pane Targeting

| Target | Meaning |
|--------|---------|
| `:.1` | Pane 1 in current window |
| `:0.1` | Pane 1 in window 0 |
| `{last}` | Last active pane |

## Important: devenv up requires nix develop

`devenv up` must always be invoked inside a nix shell. Never call `devenv up` directly. Always wrap it with `nix develop --no-pure-eval -c devenv up`.

## Common Patterns

| Task | Command |
|------|---------|
| Start devenv server (using nix develop) in given folder | `tmux split-window -h 'cd /path/to/folder && nix develop --no-pure-eval -c devenv up'` |
| Watch logs | `tmux split-window -h 'tail -f app.log'` |
| Check build output | `tmux capture-pane -t :.1 -p -S -50` |
| Start dev server | `tmux send-keys -t :.1 'npm run dev' Enter` |
| Kill pane | `tmux kill-pane -t :.1` |
| List panes | `tmux list-panes -a -F '#{window_name}.#{pane_index}: #{pane_current_command}'` |
