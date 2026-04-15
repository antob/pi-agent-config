#!/usr/bin/env bash
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: query.sh <keyword> [keyword2 ...]" >&2
  exit 1
fi

results=$(zoxide query --list --score "$@" 2>/dev/null || true)

if [[ -z "$results" ]]; then
  echo "No zoxide match found for: $*" >&2
  exit 1
fi

count=$(echo "$results" | wc -l | tr -d ' ')

if [[ "$count" -eq 1 ]]; then
  # Single match: print just the path
  echo "$results" | awk '{print $2}'
else
  # Multiple matches: print ranked list (score + path)
  echo "Top matches for \"$*\":"
  echo "$results" | awk '{printf "%2d. %s  (score: %s)\n", NR, $2, $1}'
fi
