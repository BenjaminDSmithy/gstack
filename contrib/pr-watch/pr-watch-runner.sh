#!/bin/bash
# pr-watch runner: polls every PR enabled with `gstack-pr-watch enable` and
# raises a macOS notification while a P0 or P1 signal waits for the owner.
# Opt-in: the owner installs the LaunchAgent (README.md). Reads only.
set -u
GSTACK_DIR=${GSTACK_DIR:-$HOME/.claude/skills/gstack}
ROOT=$("$GSTACK_DIR/bin/gstack-paths" --get GSTACK_STATE_ROOT 2>/dev/null) || ROOT=$HOME/.gstack
[ -n "$ROOT" ] || ROOT=$HOME/.gstack
LOG=$ROOT/analytics/pr-watch.log
mkdir -p "$ROOT/analytics"
for f in "$ROOT"/projects/*/pr-drafts/*/watch.json; do
  [ -f "$f" ] || continue
  repo=$(jq -r '.repo // empty' "$f" 2>/dev/null)
  n=$(jq -r '.number // empty' "$f" 2>/dev/null)
  cwd=$(jq -r '.cwd // empty' "$f" 2>/dev/null)
  case $n in ''|*[!0-9]*) echo "skip $f: bad number" >> "$LOG"; continue ;; esac
  case $repo in */*) ;; *) echo "skip $f: bad repo" >> "$LOG"; continue ;; esac
  case $repo in *[!A-Za-z0-9._/-]*) echo "skip $f: bad repo" >> "$LOG"; continue ;; esac
  [ -d "$cwd" ] || { echo "skip $f: no worktree" >> "$LOG"; continue; }
  "$GSTACK_DIR/bin/gstack-pr-watch" poll --pr "$n" --repo "$repo" --cwd "$cwd" > /dev/null 2>&1
  rc=$?
  printf '%s pr=%s repo=%s rc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$n" "$repo" "$rc" >> "$LOG"
  case $rc in
    10) level='P0: superseded or closed' ;;
    11) level='P1: needs attention' ;;
    *) continue ;;
  esac
  osascript -e "display notification \"PR #$n $level\" with title \"gstack pr-watch\"" > /dev/null 2>&1 || true
done
exit 0
