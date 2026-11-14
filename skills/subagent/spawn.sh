#!/usr/bin/env bash
# Start a pi subagent in a new tmux column. It reports back to the calling pi
# through the subagent extension (extensions/subagent.ts).
#
# Usage: spawn.sh [--model provider/id[:thinking]] [--keep-open] [--name NAME] [--cwd DIR] TASK_FILE|-
# With "-" the task is read from stdin. The task is copied into the run directory,
# which is removed when the subagent exits.
set -euo pipefail

usage() {
  echo "usage: spawn.sh [--model provider/id[:thinking]] [--keep-open] [--name NAME] [--cwd DIR] TASK_FILE|-" >&2
  exit 2
}

die() {
  echo "spawn.sh: $*" >&2
  exit 1
}

model=""
keep_open=0
name=""
cwd="$PWD"
task=""

while [ $# -gt 0 ]; do
  case "$1" in
    --model) [ $# -ge 2 ] || usage; model="$2"; shift 2 ;;
    --keep-open) keep_open=1; shift ;;
    --name) [ $# -ge 2 ] || usage; name="$2"; shift 2 ;;
    --cwd) [ $# -ge 2 ] || usage; cwd="$2"; shift 2 ;;
    -h | --help) usage ;;
    -) [ -z "$task" ] || usage; task="-"; shift ;;
    -*) usage ;;
    *) [ -z "$task" ] || usage; task="$1"; shift ;;
  esac
done

[ -n "$task" ] || usage
[ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ] || die "not running inside tmux"
[ -n "${XDG_RUNTIME_DIR:-}" ] || die "XDG_RUNTIME_DIR is not set"
[ -n "${PI_SUBAGENT_INBOX:-}" ] || die "PI_SUBAGENT_INBOX is not set (is extensions/subagent.ts loaded in this pi?)"
[ -d "$PI_SUBAGENT_INBOX" ] || die "inbox $PI_SUBAGENT_INBOX does not exist"
[ "$task" = - ] || [ -f "$task" ] || die "task file $task not found"
[ -d "$cwd" ] || die "directory $cwd not found"
command -v tmux-columns >/dev/null || die "tmux-columns not on PATH"
jq_bin="$(command -v jq)" || die "jq not on PATH"

cwd="$(realpath "$cwd")"
skill_dir="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"

# Model: explicit, or the parent's current model and thinking level.
model_args=()
if [ -n "$model" ]; then
  model_args=(--model "$model")
  shown="model=$model"
elif [ -n "${PI_SUBAGENT_MODEL:-}" ]; then
  model_args=(--model "$PI_SUBAGENT_MODEL")
  [ -n "${PI_SUBAGENT_THINKING:-}" ] && model_args+=(--thinking "$PI_SUBAGENT_THINKING")
  shown="model=$PI_SUBAGENT_MODEL thinking=${PI_SUBAGENT_THINKING:-default}"
else
  shown="model=default"
fi

if [ -z "$name" ]; then
  if [ "$task" = - ]; then name="subagent"; else name="$(basename "$task" .md)"; fi
fi
name="$(printf '%s' "$name" | tr -c 'A-Za-z0-9._-' '-')"
id="${name}-$(date +%s)-$RANDOM"

run_dir="$XDG_RUNTIME_DIR/pi-subagents/runs/$id"
(umask 077 && mkdir -p "$run_dir")
if [ "$task" = - ]; then cat >"$run_dir/task.md"; else cp "$task" "$run_dir/task.md"; fi
[ -s "$run_dir/task.md" ] || { rm -rf "$run_dir"; die "task is empty"; }

{
  echo '#!/usr/bin/env bash'
  printf 'export PI_SUBAGENT_REPORT_TO=%q PI_SUBAGENT_ID=%q PI_SUBAGENT_NAME=%q PI_SUBAGENT_KEEP_OPEN=%q PI_SUBAGENT_RUN_DIR=%q\n' \
    "$PI_SUBAGENT_INBOX" "$id" "$name" "$keep_open" "$run_dir"
  printf 'jq=%q\n' "$jq_bin"
  printf 'if cd %q; then\n  pi' "$cwd"
  printf ' %q' "${model_args[@]}" \
    --tools read,bash,edit,write,subagent_report --no-mcp \
    --append-system-prompt "$skill_dir/child-prompt.md"
  # pi puts the session name in the pane title; $TMUX_PANE expands in the pane.
  # name is sanitised above, so it is safe inside double quotes.
  printf ' --name "subagent: %s (${TMUX_PANE:-?})"' "$name"
  printf ' %q' "@$run_dir/task.md" "Do the task described in the attached file."
  printf '\n  status=$?\nelse\n  status=1\nfi\n'
  # Covers failures where the extension never reported (bad model, crash at startup).
  cat <<'EOF'
if [ "$status" -ne 0 ] && [ ! -e "$PI_SUBAGENT_RUN_DIR/reported" ] && [ -d "$PI_SUBAGENT_REPORT_TO" ]; then
  f="$PI_SUBAGENT_REPORT_TO/$PI_SUBAGENT_ID-failed"
  "$jq" -n --arg id "$PI_SUBAGENT_ID" --arg name "$PI_SUBAGENT_NAME" --arg pane "${TMUX_PANE:-}" \
    --arg cwd "$PWD" --argjson status "$status" \
    '{id: $id, name: $name, status: "failed", pane: $pane, keepOpen: true, cwd: $cwd,
      summary: "pi exited with status \($status). The pane is left open with the error output."}' \
    >"$f.tmp" && mv "$f.tmp" "$f.json"
fi
rm -rf "$PI_SUBAGENT_RUN_DIR"
exit "$status"
EOF
} >"$run_dir/run.sh"

pane="$(tmux-columns new "$TMUX_PANE")"
tmux select-pane -t "$TMUX_PANE"
# Leading space keeps it out of shell history. The pane closes on a clean exit.
tmux send-keys -t "$pane" -l " bash $(printf '%q' "$run_dir/run.sh") && exit"
tmux send-keys -t "$pane" Enter

echo "id=$id pane=$pane $shown keep_open=$keep_open"
