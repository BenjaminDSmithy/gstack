#!/bin/bash
# hook-syntax.sh — parse gate for the shell, python and hook-payload files this
# repo ships.
#
# Sourced by `setup` before it links, copies or registers anything; pinned by
# `test/hook-syntax.test.ts`, which runs in the free `bun test` suite. Also
# runnable alone:
#
#   /bin/bash scripts/hook-syntax.sh                  # sweep the whole repo
#   /bin/bash scripts/hook-syntax.sh <file|dir>...    # check the named targets
#   /bin/bash scripts/hook-syntax.sh --report [...]   # ...and print the coverage
#
# WHY THIS EXISTS. On 2026-08-27 `~/.claude/hooks/secret-guard.sh` sat on disk
# mid-merge with unresolved conflict markers at lines 771/795/819. It is wired
# as a PreToolUse hook, so EVERY Bash call in EVERY Claude Code session on the
# machine — a bare `echo` included — came back as
#
#   PreToolUse:Bash hook error: [$HOME/.claude/hooks/secret-guard.sh]:
#   line 771: syntax error near unexpected token `<<<'
#
# Nothing detected it; a human noticed. That hook belongs to another repo, which
# now gates its own tree, as does the synapse skills suite. Neither can gate
# this one. gstack ships hooks of its own, and `setup` wires four of them into
# `~/.claude/settings.json` — one of which is PreToolUse and can take a machine
# down in exactly the same way:
#
#   hosts/claude/hooks/question-preference-hook   PreToolUse    (plan-tune)
#   hosts/claude/hooks/question-log-hook          PostToolUse   (plan-tune)
#   hosts/claude/hooks/auq-error-fallback-hook    PostToolUse
#   hosts/claude/hooks/timeline-stop-hook         Stop
#   bin/gstack-session-update                     SessionStart  (team mode)
#
# Two more are wired by hand from the /careful, /freeze and /guard skill docs,
# and both are PreToolUse: `careful/bin/check-careful.sh` and
# `freeze/bin/check-freeze.sh`, which share `careful/bin/hook-extract.sh`.
#
# WHAT IT CHECKS, EXACTLY. The sweep visits every file in the tree and keys on
# the SHEBANG, never on an extension — an extension-keyed sweep in a sibling
# repo missed three of four wired hooks because they end in `.template` and
# still reported green.
#
#   * bash/sh shebang -> `bash -n` (parse only; it cannot see runtime faults)
#   * python3 shebang -> compiled in-memory (no .pyc is written)
#   * a bun payload   -> `bun build --target=bun`, entrypoint AND everything it
#     imports, parsed in memory (nothing is written). See below for how a
#     payload is found; it is derived from a shim's own content, not guessed
#     from an extension
#   * conflict markers -> checked SEPARATELY from parsing, because a marker
#     inside a heredoc body or a comment block can parse cleanly and still be
#     a half-merged file
#   * anything else is SKIPPED — and skipped is not passed, so nothing here
#     reports it as checked. `--report` prints the split.
#
# THE BUN ARM, AND WHY IT IS NOT KEYED ON `.ts`. Every hook gstack wires is a
# bash shim that hands a TypeScript file to bun:
#
#   HERE="$(cd "$(dirname "$0")" && pwd)"
#   exec bun "$HERE/question-preference-hook.ts"
#
# `bash -n` on the shim proves the shim parses and says nothing about the file
# that actually runs. A syntax error in the payload makes bun exit non-zero,
# which for the PreToolUse shim (`set -e; exec bun ...`) is a blocked tool call
# — the 2026-08-27 failure mode with a different first line. So a file that the
# gate has just parsed as bash is scanned for the paths it hands to bun, and
# each of those is parsed too. Discovering the payload from the shim's content
# means a renamed or extension-less payload cannot slip past; guessing from
# `*.ts` would have exactly the blind spot this gate exists to avoid.
#
# WHAT IT DOES NOT COVER — do not read a wider claim into it.
#   * Scope is this repository's working tree, minus `node_modules`, `.git`,
#     `dist`, `.build`, `__pycache__` and `.venv`. Vendored trees are pruned,
#     so a broken script inside one is invisible here.
#   * TypeScript and JavaScript files are SKIPPED unless a shim hands one to
#     bun, or one is reached as an import of such a file. `spawn-bin.ts` is
#     covered because all four hook payloads import it; a `.ts` that nothing
#     wired reaches is not.
#   * Skipped files are not marker-scanned either, because the marker scan runs
#     only on the kinds this gate parses. A half-merged `.md` or `.json` is
#     invisible here.
#   * `bash -n` is a parse, not a lint and not a run. A hook that parses and
#     then fails at runtime is out of scope; `test/hook-scripts.test.ts` is
#     where the /careful and /freeze guards get their behaviour pinned.
#   * An absent `python3` or `bun` is reported as a coverage gap, never counted
#     as a pass.
#
# SILENT WHEN HEALTHY. Any output at all (without `--report`) means something
# is genuinely broken. A gate that chatters on a good tree gets routed around,
# and then it protects nobody.
#
# FAIL-CLOSED on a broken file, but never the reason an unrelated thing fails:
# an unreadable path or an absent interpreter is reported, not swallowed.

# Interpreters. Seams for the test suite, which points them at names that do
# not exist to exercise the absent-interpreter paths. In every real caller they
# are python3 and bun.
HOOK_SYNTAX_PYTHON="${HOOK_SYNTAX_PYTHON:-python3}"
HOOK_SYNTAX_BUN="${HOOK_SYNTAX_BUN:-bun}"

# Files the last sweep actually parsed, and files it skipped. Read by callers
# that want to report coverage honestly rather than assert it.
HOOK_SYNTAX_CHECKED=0
HOOK_SYNTAX_SKIPPED=0

# Newline-delimited paths already CHECKED this run, so a payload reached
# through its shim is not counted a second time when the sweep walks past the
# payload itself. Skipped files are deliberately not recorded: the list is
# scanned linearly, and holding every file in the tree would make a sweep
# quadratic for no benefit.
HOOK_SYNTAX_SEEN=""

# Directories never descended into. Vendored and generated trees carry other
# people's scripts; a finding in one is noise this gate cannot act on.
HOOK_SYNTAX_PRUNE_NAMES="node_modules .git dist .build __pycache__ .venv"

# $1 = path. Returns 0 when this run has already checked it. Both producers of
# a path — the sweep and a shim's payload list — spell it the same way (the
# payload is built from the shim's own directory), so the raw path is the key
# and no subprocess is spent canonicalising one. Deliberately fork-free: a
# sweep reads a couple of thousand files and a fork per file costs seconds.
_hook_syntax_seen() {
  case "${HOOK_SYNTAX_SEEN}" in
    *"
$1
"*) return 0 ;;
  esac
  return 1
}

# $1 = path. Record it as checked.
_hook_syntax_mark() {
  HOOK_SYNTAX_SEEN="${HOOK_SYNTAX_SEEN}
$1
"
}

# $1 = path to read a shebang from. Sets HOOK_SYNTAX_KIND to bash, python or
# none. A global rather than an echo: this runs once per file in the tree, and
# a command substitution would fork a subshell a couple of thousand times.
HOOK_SYNTAX_KIND=none
_hook_syntax_kind() {
  local line=''
  HOOK_SYNTAX_KIND=none
  IFS= read -r line < "$1" 2>/dev/null
  case "$line" in
    '#!/bin/bash' | '#!/bin/bash '* | '#!/usr/bin/env bash' | '#!/usr/bin/env bash '*) HOOK_SYNTAX_KIND=bash ;;
    '#!/bin/sh' | '#!/bin/sh '* | '#!/usr/bin/env sh' | '#!/usr/bin/env sh '*) HOOK_SYNTAX_KIND=bash ;;
    '#!'*python3 | '#!'*python3' '* | '#!'*python) HOOK_SYNTAX_KIND=python ;;
  esac
}

# Conflict markers, checked on CONTENT rather than on parse.
#
# Only the three LABELLED markers are scanned — the opening, the diff3 base and
# the closing one. git always writes a ref name after each, so the trailing
# space is required and a bare run of seven characters (a comment rule, a doc
# quoting the shape) is not a false positive. The middle `=` separator is
# deliberately absent from this pattern: git writes it with NO label, which
# makes it indistinguishable from a banner rule — and this repo draws plenty.
# Nothing is lost, because a real conflict writes all four.
#
# $1 = file to scan, $2 = label to report it as.
_hook_syntax_markers() {
  local hits
  hits=$(grep -nE '^([<]{7}|[>]{7}|[|]{7}) ' "$1" 2>/dev/null) || return 0
  [ -z "$hits" ] && return 0
  printf 'hook-syntax: UNRESOLVED CONFLICT MARKERS in %s\n' "$2" >&2
  printf '%s\n' "$hits" | while IFS= read -r h; do
    printf '  %s:%s\n' "$2" "$h" >&2
  done
  return 1
}

# The paths a shell shim hands to bun. Matches the shape every gstack hook shim
# uses — `bun "$HERE/<rel>"`, with or without `exec` and with or without `run`
# — and resolves each against the shim's own directory.
#
# Comment lines are dropped first. A commented-out invocation is not a payload,
# and neither is a doc block quoting the shape — this file's own header quotes
# it, and matching that made the gate report a missing payload against itself.
#
# $1 = the shim, already known to parse as bash. Echoes zero or more paths.
_hook_syntax_bun_payloads() {
  local dir="${1%/*}" rel
  [ "$dir" = "$1" ] && dir='.'
  sed -nE '/^[[:space:]]*#/d
           s|.*bun[[:space:]]+(run[[:space:]]+)?"\$HERE/([^"]+)".*|\2|p' \
    "$1" 2>/dev/null |
    while IFS= read -r rel; do
      [ -n "$rel" ] && printf '%s/%s\n' "$dir" "$rel"
    done
}

# Parse a bun payload — the entrypoint and, because this bundles, everything it
# imports. Output goes to stdout and is discarded, so nothing is written to
# disk. $1 = file, $2 = label. Silent on success.
_hook_syntax_check_bun() {
  local file="$1" label="$2" out
  if ! command -v "$HOOK_SYNTAX_BUN" >/dev/null 2>&1; then
    # Say so rather than counting it as checked. An absent bun is a coverage
    # gap, not a fault: the shims themselves already exit cleanly when bun is
    # missing, so nothing is broken by it being absent here either.
    printf 'hook-syntax: %s absent — %s NOT checked\n' "$HOOK_SYNTAX_BUN" "$label" >&2
    HOOK_SYNTAX_SKIPPED=$((HOOK_SYNTAX_SKIPPED + 1))
    return 0
  fi
  HOOK_SYNTAX_CHECKED=$((HOOK_SYNTAX_CHECKED + 1))
  if ! out=$("$HOOK_SYNTAX_BUN" build "$file" --target=bun 2>&1 >/dev/null); then
    printf 'hook-syntax: FAILS TO PARSE %s\n' "$label" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  _hook_syntax_markers "$file" "$label" || return 1
  return 0
}

# $1 = file to parse, $2 = label to report it as (they differ when the content
# came out of the index or a temp file). Silent on success.
hook_syntax_check_file() {
  local file="$1" label="${2:-$1}" kind out rc=0 payload

  _hook_syntax_seen "$file" && return 0

  if [ ! -r "$file" ]; then
    printf 'hook-syntax: UNREADABLE %s — cannot check it\n' "$label" >&2
    return 1
  fi

  _hook_syntax_kind "$file"
  kind="$HOOK_SYNTAX_KIND"

  # Skipped first, and without joining the seen-list. Skipped is not passed —
  # `--report` prints the split so nobody reads a green sweep as full coverage.
  if [ "$kind" = none ]; then
    HOOK_SYNTAX_SKIPPED=$((HOOK_SYNTAX_SKIPPED + 1))
    return 0
  fi
  _hook_syntax_mark "$file"

  case "$kind" in
    bash)
      HOOK_SYNTAX_CHECKED=$((HOOK_SYNTAX_CHECKED + 1))
      if ! out=$(bash -n "$file" 2>&1); then
        printf 'hook-syntax: FAILS TO PARSE %s\n' "$label" >&2
        # bash names the path it was handed; rewrite it to the path a person
        # can actually open. The line numbers are already right.
        printf '%s\n' "$out" | sed "s|$file|$label|g" >&2
        rc=1
      fi
      ;;
    python)
      if ! command -v "$HOOK_SYNTAX_PYTHON" >/dev/null 2>&1; then
        # Say so rather than counting it as checked. Absent python3 is a
        # coverage gap, not a fault — nothing wired here needs it.
        printf 'hook-syntax: %s absent — %s NOT checked\n' \
          "$HOOK_SYNTAX_PYTHON" "$label" >&2
        HOOK_SYNTAX_SKIPPED=$((HOOK_SYNTAX_SKIPPED + 1))
      else
        HOOK_SYNTAX_CHECKED=$((HOOK_SYNTAX_CHECKED + 1))
        if ! out=$("$HOOK_SYNTAX_PYTHON" -c \
          'import sys; compile(open(sys.argv[1],"rb").read(), sys.argv[2], "exec")' \
          "$file" "$label" 2>&1); then
          printf 'hook-syntax: FAILS TO PARSE %s\n' "$label" >&2
          printf '%s\n' "$out" | sed "s|$file|$label|g" >&2
          rc=1
        fi
      fi
      ;;
  esac

  _hook_syntax_markers "$file" "$label" || rc=1

  # A shim that parses is only half the story: parse what it hands to bun. Done
  # after the shim's own verdict so a broken shim still reports its own line
  # first, and guarded by the seen-list so the sweep does not re-check the
  # payload when it walks past it later.
  if [ "$kind" = bash ]; then
    while IFS= read -r payload; do
      [ -n "$payload" ] || continue
      _hook_syntax_seen "$payload" && continue
      _hook_syntax_mark "$payload"
      if [ ! -r "$payload" ]; then
        printf 'hook-syntax: MISSING PAYLOAD %s — handed to bun by %s\n' \
          "$payload" "$label" >&2
        rc=1
        continue
      fi
      _hook_syntax_check_bun "$payload" "$payload" || rc=1
    done < <(_hook_syntax_bun_payloads "$file")
  fi

  return "$rc"
}

# Sweep every candidate file under a directory. $1 = the repo root by default
# (the directory holding this scripts/). Returns 1 if ANY file is broken — and
# checks them all first, so one bad file does not hide the next.
hook_syntax_check_tree() {
  local dir="${1:-}" rc=0 f name prune
  if [ -z "$dir" ]; then
    dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P)"
  fi
  [ -d "$dir" ] || {
    printf 'hook-syntax: no such directory: %s\n' "$dir" >&2
    return 1
  }
  prune=""
  for name in $HOOK_SYNTAX_PRUNE_NAMES; do
    prune="$prune -o -name $name"
  done
  # shellcheck disable=SC2086
  while IFS= read -r -d '' f; do
    hook_syntax_check_file "$f" "$f" || rc=1
  done < <(find "$dir" \( ${prune# -o } \) -prune -o \
    -type f -print0 2>/dev/null | sort -z)
  return "$rc"
}

# Print what the last sweep actually covered. Callers that want to state their
# coverage use this instead of asserting it; nothing prints it by default.
hook_syntax_report() {
  printf 'hook-syntax: %d checked, %d skipped\n' \
    "$HOOK_SYNTAX_CHECKED" "$HOOK_SYNTAX_SKIPPED" >&2
}

# Direct invocation: sweep, or check the targets named on the command line.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  _report=0
  if [ "${1:-}" = "--report" ]; then
    _report=1
    shift
  fi
  _rc=0
  if [ "$#" -eq 0 ]; then
    hook_syntax_check_tree || _rc=1
  else
    for _f in "$@"; do
      # A directory argument sweeps it. Treating one as a file would read a
      # directory, get no shebang, and report a clean skip — a pass for
      # something never looked at.
      if [ -d "$_f" ]; then
        hook_syntax_check_tree "$_f" || _rc=1
      else
        hook_syntax_check_file "$_f" "$_f" || _rc=1
      fi
    done
  fi
  [ "$_report" -eq 1 ] && hook_syntax_report
  exit "$_rc"
fi
