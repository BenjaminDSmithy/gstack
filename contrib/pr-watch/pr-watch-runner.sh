#!/bin/bash
# pr-watch runner: polls every PR enabled with `gstack-pr-watch enable` and
# raises a macOS notification while a P0 or P1 signal waits for the owner,
# and when a watch keeps failing, so a dead watch never reads as quiet.
# Opt-in: the owner installs the LaunchAgent (README.md). A notification
# carries fixed text only: a PR number, a signal class or an exit code.
set -u
GSTACK_DIR=${GSTACK_DIR:-$HOME/.claude/skills/gstack}
ROOT=$("$GSTACK_DIR/bin/gstack-paths" --get GSTACK_STATE_ROOT 2>/dev/null) || ROOT=$HOME/.gstack
[ -n "$ROOT" ] || ROOT=$HOME/.gstack
LOG=$ROOT/analytics/pr-watch.log
FAILS=$ROOT/analytics/pr-watch-failures
mkdir -p "$ROOT/analytics" "$FAILS"

notify() {
  osascript -e "display notification \"$1\" with title \"gstack pr-watch\"" > /dev/null 2>&1 || true
}

# Count a failed run against its PR. The second failure in a row notifies,
# then every 48th (about a day at 30 minutes): one 502 stays quiet, a watch
# that cannot verify for good does not.
failed() {
  local key=$1 text=$2 count
  count=$(cat "$FAILS/$key" 2>/dev/null)
  case $count in ''|*[!0-9]*) count=0 ;; esac
  count=$((count + 1))
  echo "$count" > "$FAILS/$key"
  if [ "$count" -eq 2 ] || [ $((count % 48)) -eq 0 ]; then notify "$text"; fi
}

# Without jq every watch.json parses as empty and would be skipped in
# silence (macOS 14 and older ship no /usr/bin/jq): a failure, not quiet.
if ! command -v jq > /dev/null 2>&1; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) jq is missing: no PR polled" >> "$LOG"
  failed jq-missing "pr-watch: jq is missing, no PR is being watched"
  exit 0
fi
rm -f "$FAILS/jq-missing"

# A watch.json the runner cannot use is a watch that never runs: count it
# like a failed poll, keyed on its path under the state root.
skip() {
  echo "skip $1: $2" >> "$LOG"
  failed "$3" "pr-watch: a watch file is unreadable, see pr-watch.log"
}

for f in "$ROOT"/projects/*/pr-drafts/*/watch.json; do
  [ -f "$f" ] || continue
  fkey=${f#"$ROOT"/projects/}
  fkey=file-${fkey//[!A-Za-z0-9._-]/_}
  repo=$(jq -r '.repo // empty' "$f" 2>/dev/null)
  n=$(jq -r '.number // empty' "$f" 2>/dev/null)
  cwd=$(jq -r '.cwd // empty' "$f" 2>/dev/null)
  case $n in ''|*[!0-9]*) skip "$f" "bad number" "$fkey"; continue ;; esac
  case $repo in */*) ;; *) skip "$f" "bad repo" "$fkey"; continue ;; esac
  case $repo in *[!A-Za-z0-9._/-]*) skip "$f" "bad repo" "$fkey"; continue ;; esac
  rm -f "$FAILS/$fkey"
  key="${repo//\//_}-$n"
  if [ ! -d "$cwd" ]; then
    echo "skip $f: no worktree" >> "$LOG"
    failed "$key" "PR #$n: watch stopped, its worktree is gone"
    continue
  fi
  "$GSTACK_DIR/bin/gstack-pr-watch" poll --pr "$n" --repo "$repo" --cwd "$cwd" > /dev/null 2>&1
  rc=$?
  printf '%s pr=%s repo=%s rc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$n" "$repo" "$rc" >> "$LOG"
  case $rc in
    0) rm -f "$FAILS/$key" ;;
    10) rm -f "$FAILS/$key"; notify "PR #$n P0: superseded or closed" ;;
    11) rm -f "$FAILS/$key"; notify "PR #$n P1: needs attention" ;;
    *) failed "$key" "PR #$n: watch could not verify (rc=$rc)" ;;
  esac
done
exit 0
