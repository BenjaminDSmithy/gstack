#!/usr/bin/env bash
# gstack-update-channel.sh — which branch of garrytan/gstack an install follows.
#
# Sourced by bin/gstack-session-update, bin/gstack-update-check and
# bin/gstack-upgrade; runnable by the /gstack-upgrade skill. Bash 3.2 plus git.
#
# Channels (docs/releases.md):
#   main    every merge to main (a version per merge, a dozen a day)
#   stable  the weekly tagged release: refs/heads/stable on origin, moved only
#           forward along main's first-parent history by the release workflow
#
# The config key update_channel (bin/gstack-config) is auto | stable | main.
# auto, the default, is stable when team_mode is true and main otherwise, so a
# team install follows releases and a contributor install follows main with
# nothing to migrate. GSTACK_UPDATE_CHANNEL overrides the config (tests, a
# one-off command). Any other value counts as auto.
#
# Functions (never fail; a broken config means main, the behaviour before
# channels existed):
#   gstack_update_channel <install dir>          prints stable | main
#   gstack_update_channel_refspec <channel>      prints the fetch refspec for
#                                                stable, "" for main (callers
#                                                keep their @{upstream} /
#                                                default-branch path)
#   gstack_update_channel_missing <git stderr>   true when a fetch failed only
#                                                because origin has no such ref
#                                                (no release cut yet): callers
#                                                fall back to main
#
# CLI (the /gstack-upgrade skill): `bash bin/gstack-update-channel.sh [--fetch-ref] [<install dir>]`
#   prints the channel; --fetch-ref fetches the channel ref from origin and
#   prints the revision to fast-forward to (origin/stable or origin/main),
#   falling back to origin/main only when origin has no stable yet. Any other
#   fetch failure keeps origin/stable (the fast-forward then stops or finds
#   nothing new); a team install never moves to main because the network
#   blinked.

gstack_update_channel() {
  _uc_dir=${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
  _uc_value=${GSTACK_UPDATE_CHANNEL:-}
  if [ -z "$_uc_value" ] && [ -x "$_uc_dir/bin/gstack-config" ]; then
    _uc_value=$("$_uc_dir/bin/gstack-config" get update_channel 2>/dev/null) || _uc_value=""
  fi
  case "$_uc_value" in
    stable|main) printf '%s\n' "$_uc_value"; return 0 ;;
  esac
  _uc_team=""
  [ -x "$_uc_dir/bin/gstack-config" ] && { _uc_team=$("$_uc_dir/bin/gstack-config" get team_mode 2>/dev/null) || _uc_team=""; }
  if [ "$_uc_team" = true ]; then printf 'stable\n'; else printf 'main\n'; fi
}

gstack_update_channel_refspec() {
  case "${1:-}" in stable) printf '+refs/heads/stable:refs/remotes/origin/stable\n' ;; *) printf '\n' ;; esac
}

gstack_update_channel_missing() {
  printf '%s' "${1:-}" | grep -qiE "couldn't find remote ref|no such ref was fetched|invalid refspec" 2>/dev/null
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  _uc_fetch=0 _uc_arg=""
  for _uc_a in "$@"; do
    case "$_uc_a" in
      --fetch-ref) _uc_fetch=1 ;;
      -h|--help) sed -n '2,36p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) _uc_arg=$_uc_a ;;
    esac
  done
  _uc_root=${_uc_arg:-$(cd "$(dirname "$0")/.." && pwd)}
  _uc_ch=$(gstack_update_channel "$_uc_root")
  if [ "$_uc_fetch" -eq 0 ]; then printf '%s\n' "$_uc_ch"; exit 0; fi
  # Egress receipts for the fetches below, fail-open like /gstack-upgrade's own.
  [ -r "$(dirname "$0")/gstack-egress-lib.sh" ] && . "$(dirname "$0")/gstack-egress-lib.sh" 2>/dev/null || _receipted_git() { shift 5; "$@"; }
  _uc_host=$(git -C "$_uc_root" remote get-url origin 2>/dev/null); _uc_host=${_uc_host#*://}; _uc_host=${_uc_host#*@}; _uc_host=${_uc_host%%[/:]*}
  export GIT_TERMINAL_PROMPT=0
  if [ "$_uc_ch" = stable ]; then
    _uc_err=$(_receipted_git open gstack-upgrade "${_uc_host:-unknown}" gstack-self-update-pull "user ran /gstack-upgrade" git -C "$_uc_root" fetch -q origin "$(gstack_update_channel_refspec stable)" 2>&1 >/dev/null) \
      && { printf 'origin/stable\n'; exit 0; }
    if gstack_update_channel_missing "$_uc_err"; then
      echo "gstack-update-channel: origin has no stable release yet; following origin/main until the first weekly release is cut" >&2
    else
      echo "gstack-update-channel: fetching origin/stable failed ($(printf '%s' "$_uc_err" | head -1 | head -c 200)); staying on origin/stable as last fetched" >&2
      printf 'origin/stable\n'; exit 0
    fi
  fi
  _receipted_git open gstack-upgrade "${_uc_host:-unknown}" gstack-self-update-pull "user ran /gstack-upgrade" git -C "$_uc_root" fetch -q origin 2>/dev/null || true
  printf 'origin/main\n'
fi
