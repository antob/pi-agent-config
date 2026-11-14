#!/usr/bin/env bash
# Start a pi subagent in a new tmux column. It reports back to the calling pi
# through the subagent extension (extensions/subagent.ts).
#
# Usage: spawn.sh [--model provider/id[:thinking]] [--keep-open] [--name NAME] [--cwd DIR] TASK_FILE
set -euo pipefail

usage() {
  echo "usage: spawn.sh [--model provider/id[:thinking]] [--keep-open] [--name NAME] [--cwd DIR] TASK_FILE" >&2
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
    -*) usage ;;
    *) [ -z "$task" ] || usage; task="$1"; shift ;;
  esac
done

[ -n "$task" ] || usage
[ -n "${TMUX:-}" ] && [ -n "${TMUX_PANE:-}" ] || die "not running inside tmux"
[ -n "${PI_SUBAGENT_INBOX:-}" ] || die "PI_SUBAGENT_INBOX is not set (is extensions/subagent.ts loaded in this pi?)"
[ -d "$PI_SUBAGENT_INBOX" ] || die "inbox $PI_SUBAGENT_INBOX does not exist"
[ -f "$task" ] || die "task file $task not found"
[ -d "$cwd" ] || die "directory $cwd not found"
command -v tmux-columns >/dev/null || die "tmux-columns not on PATH"

task="$(realpath "$task")"
cwd="$(realpath "$cwd")"
skill_dir="$(dirname "$(realpath "${BASH_SOURCE[0]}")")"

# Model: explicit, or the parent's current model and thinking level.
model_args=()
if [ -n "$model" ]; then
  model_args=(--model "$model")
elif [ -n "${PI_SUBAGENT_MODEL:-}" ]; then
  model_args=(--model "$PI_SUBAGENT_MODEL")
  [ -n "${PI_SUBAGENT_THINKING:-}" ] && model_args+=(--thinking "$PI_SUBAGENT_THINKING")
fi

[ -n "$name" ] || name="$(basename "$task" .md)"
name="$(printf '%s' "$name" | tr -c 'A-Za-z0-9._-' '-')"
id="${name}-$(date +%s)-$RANDOM"

run_dir="${XDG_RUNTIME_DIR:-/tmp}/pi-subagents/runs/$id"
(umask 077 && mkdir -p "$run_dir")
run="$run_dir/run.sh"

{
  echo '#!/usr/bin/env bash'
  printf 'cd %q || exit 1\n' "$cwd"
  printf 'export PI_SUBAGENT_REPORT_TO=%q PI_SUBAGENT_ID=%q PI_SUBAGENT_NAME=%q PI_SUBAGENT_KEEP_OPEN=%q\n' \
    "$PI_SUBAGENT_INBOX" "$id" "$name" "$keep_open"
  printf 'pi'
  printf ' %q' "${model_args[@]}" \
    --tools read,bash,edit,write,subagent_report --no-mcp \
    --append-system-prompt "$skill_dir/child-prompt.md" \
    --name "subagent: $name" \
    "@$task" "Do the task described in the attached file."
  echo
  # Covers failures where the extension never ran (bad model, crash at startup).
  cat <<'EOF'
status=$?
if [ "$status" -ne 0 ] && [ -d "$PI_SUBAGENT_REPORT_TO" ]; then
  esc() { local s=${1//\\/\\\\}; s=${s//\"/\\\"}; printf '%s' "${s//$'\n'/\\n}"; }
  f="$PI_SUBAGENT_REPORT_TO/$PI_SUBAGENT_ID-failed"
  printf '{"id":"%s","name":"%s","status":"failed","summary":"pi exited with status %s. The pane is left open with the error output.","pane":"%s","keepOpen":true,"cwd":"%s"}\n' \
    "$(esc "$PI_SUBAGENT_ID")" "$(esc "$PI_SUBAGENT_NAME")" "$status" "$(esc "${TMUX_PANE:-}")" "$(esc "$PWD")" >"$f.tmp" &&
    mv "$f.tmp" "$f.json"
fi
rm -rf "$(dirname "$0")"
exit "$status"
EOF
} >"$run"

pane="$(tmux-columns new "$TMUX_PANE")"
tmux select-pane -t "$TMUX_PANE"
tmux select-pane -t "$pane" -T "subagent:$name"
# Leading space keeps it out of shell history. The pane closes on a clean exit.
tmux send-keys -t "$pane" -l " bash $(printf '%q' "$run") && exit"
tmux send-keys -t "$pane" Enter

echo "id=$id pane=$pane model=${model:-${PI_SUBAGENT_MODEL:-default}} keep_open=$keep_open"
