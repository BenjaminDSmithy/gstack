#!/bin/bash
# hook-syntax.sh — parse gate for the shell, python and hook-payload files this
# repo ships.
#
# Run by `setup` before it executes, links, copies or registers anything, and
# pinned by `test/hook-syntax.test.ts`, which runs in the free suite. Also
# runnable alone (spell /bin/bash — see "Invocation" below):
#
#   /bin/bash scripts/hook-syntax.sh                  # sweep the whole repo
#   /bin/bash scripts/hook-syntax.sh <file|dir>...    # check the named targets
#   /bin/bash scripts/hook-syntax.sh --report [...]   # ...and print the coverage
#
# WHY THIS EXISTS. Claude Code runs a hook by path, straight out of the
# checkout `setup` registered. A hook that does not parse exits 2, and exit 2
# is what Claude Code reads as "block": a broken PreToolUse hook fails every
# matching tool call, a broken UserPromptSubmit hook drops every prompt, a
# broken Stop hook refuses to let a turn end — in every session on the
# machine, not just gstack's. On 2026-08-27 a PreToolUse hook from another repo
# sat on disk mid-merge with unresolved conflict markers and did exactly that to
# every Bash call, a bare `echo` included. Nothing detected it; a person did.
#
# `bin/gstack-settings-hook` (KNOWN_HOOKS) lists every hook gstack wires:
#
#   hosts/claude/hooks/question-preference-hook    PreToolUse        ./setup
#   hosts/claude/hooks/question-log-hook           PostToolUse       ./setup
#   hosts/claude/hooks/auq-error-fallback-hook     PostToolUse       ./setup
#   hosts/claude/hooks/timeline-stop-hook          Stop              ./setup
#   hosts/claude/hooks/memorable-user-prompt-hook  UserPromptSubmit  gstack-memorable
#   bin/gstack-session-update                      SessionStart      ./setup --team
#   bin/gstack-verify-gate                         Stop              by hand
#
# and the /careful, /freeze and /guard skills tell users to wire two more
# PreToolUse hooks by hand: careful/bin/check-careful.sh and
# freeze/bin/check-freeze.sh.
#
# WHAT IT CHECKS. The sweep reads the first line of every file in the tree and
# dispatches on the SHEBANG, never on an extension — an extension-keyed sweep in
# a sibling repo missed three of four wired hooks because they end in
# `.template`, and still reported green.
#
#   * a shell shebang -> `-n` under the interpreter the shebang names, because
#     that is the one that runs it: `#!/bin/bash` is bash 3.2 on macOS, and
#     `#!/usr/bin/env bash` is whatever bash is first on PATH. Syntax one
#     accepts can be a parse error in the other (`;;&` is). `#!/bin/sh` goes
#     to /bin/sh, which is dash on Debian and Ubuntu
#   * a python shebang -> compiled in memory with SyntaxWarning as an error (an
#     invalid escape is only a warning without it); no .pyc is written
#   * a bun payload -> `bun build --target=bun --packages=external`: the
#     entrypoint and every local file it imports, in memory, writing nothing.
#     npm packages are left unresolved on purpose — `setup` runs this before
#     its own `bun install`, so resolving them would refuse every fresh clone
#     for a reason that has nothing to do with syntax
#   * conflict markers -> scanned SEPARATELY from parsing, because a marker
#     inside a heredoc body or a quoted string parses cleanly and is still a
#     half-merged file
#   * a CR byte anywhere in a shell file -> refused. `bash -n` accepts plenty
#     of CRLF scripts, but bash keeps the \r on every line at run time, so
#     `exec bun "$HERE/x.ts"` names `x.ts\r`. A CRLF shebang is stripped for
#     dispatch, so such a file is classified and refused, never skipped.
#     Python reads CRLF source fine and is not affected
#   * anything else is SKIPPED, and skipped is never counted as checked.
#     `--report` prints the split.
#
# ONE RULE LOOKS AT A NAME. A file with no `#!` line at all whose name ends in
# `.sh` is parsed as bash: it is a sourced library, and libraries carry no
# shebang. bin/gstack-egress-lib.sh is one, and the wired SessionStart hook
# sources it. This only ever widens coverage — no file is skipped because of
# its name, and a file with any shebang is dispatched on the shebang alone.
#
# THE BUN ARM. Every hook in hosts/claude/hooks/ is a bash shim that hands a
# TypeScript file to bun, in the shape
#
#     HERE="$(cd "$(dirname "$0")" && pwd)"
#     exec bun "$HERE/question-preference-hook.ts"
#
# `bash -n` on the shim proves the shim parses and says nothing about the file
# that runs. So every shell file this run parsed is searched for the paths it
# hands to bun, and each of those is parsed too. The payload is found from the
# shim's own content, never guessed from `*.ts`, so a renamed or extension-less
# payload cannot slip past, and a `.ts` nothing wired reaches is reported as
# skipped rather than silently included. Comment lines never name a payload —
# this header quotes the shape above.
#
# WHAT IT DOES NOT COVER — read no wider claim into it.
#   * Scope is the tree it is pointed at, minus node_modules, .git, dist,
#     .build, __pycache__ and .venv, and minus any nested checkout (a
#     directory holding its own .git): another branch's files, not this
#     install's. `--report` counts them.
#   * TypeScript and JavaScript a shim does not reach are skipped; the type
#     checker and the test suite own those.
#   * Skipped files are not marker-scanned. A half-merged .md, .json or .tmpl
#     is invisible here.
#   * A parse is not a run. A hook that parses and then fails at runtime is out
#     of scope.
#   * A shim that reaches bun any other way than `bun "$HERE/<path>"` has its
#     payload unchecked. The shim itself is still parsed.
#   * An interpreter that is absent or cannot run (python3, bun, a PATH bash)
#     is reported as a coverage gap, never counted as a pass and never as a
#     parse failure.
#   * It guards the next install, not the running one. Hooks are registered by
#     path, so a merge that writes markers into the registered checkout is live
#     before any test or setup run sees it. docs/hook-syntax-gate.md has the
#     full account.
#
# SILENT WHEN HEALTHY. Any output (without --report) means something is broken.
# A gate that chatters on a good tree gets routed around.
#
# FORK BUDGET. Under a loaded scheduler a fork costs far more than the work it
# does, so the per-file pass forks once (the parse) and every content scan
# runs once per sweep over every file the parse pass accepted.
#
# EXIT. 0 clean, 1 something is broken or could not be looked at. Never
# anything else: setup reads any other code as "the checker could not run".
#
# INVOCATION. Spell `/bin/bash`, not a bare `bash`: on macOS a PATH-resolved
# bash is Homebrew's 5.x, which can deadlock writing a heredoc body. This file
# has no heredocs, and stays bash-3.2-clean.

# Interpreter seams for the test suite, which points them at names that do not
# exist to exercise the absent-interpreter paths.
HOOK_SYNTAX_PYTHON="${HOOK_SYNTAX_PYTHON:-python3}"
HOOK_SYNTAX_BUN="${HOOK_SYNTAX_BUN:-bun}"

# What the run actually covered. Read by `--report`; never asserted.
HOOK_SYNTAX_CHECKED=0
HOOK_SYNTAX_SKIPPED=0
HOOK_SYNTAX_NESTED=0

# Paths already checked this run, newline-delimited, so a payload reached
# through its shim is not checked again when the sweep walks past it.
HOOK_SYNTAX_SEEN=""

# Directories never descended into: vendored and generated trees carry other
# people's scripts, and a finding in one is noise this gate cannot act on.
HOOK_SYNTAX_PRUNE_NAMES="node_modules .git dist .build __pycache__ .venv"

# Queues drained once per sweep by _hook_syntax_finish.
HOOK_SYNTAX_PARSED=()    # every file parsed: marker-scanned
HOOK_SYNTAX_SHELLS=()    # every shell file parsed: searched for bun payloads
HOOK_SYNTAX_UNPARSED=()  # every file skipped, so a payload found later is uncounted

HOOK_SYNTAX_NL='
'

# Interpreters this run has probed, as `<name>=><verdict>` lines.
HOOK_SYNTAX_PROBED="$HOOK_SYNTAX_NL"
HOOK_SYNTAX_PROBE=''

# $1 = interpreter, rest = a no-op invocation of it. Sets HOOK_SYNTAX_PROBE to
# `ok`, `absent` or `cannot run (exit N)` and returns 0 only for `ok`. Probes
# each interpreter once per run.
#
# Present is not the same as runnable: an asdf, mise or pyenv shim with no
# version selected, or the xcode-select python3 stub, is on PATH and fails
# every invocation. Without the probe, every file it was handed read as
# "FAILS TO PARSE" and refused setup for a reason that is not syntax. A
# coverage gap is what it is.
_hook_syntax_probe() {
  local name="$1" entry rc=0
  shift
  case "$HOOK_SYNTAX_PROBED" in
    *"$HOOK_SYNTAX_NL$name=>"*)
      entry="${HOOK_SYNTAX_PROBED#*"$HOOK_SYNTAX_NL$name=>"}"
      HOOK_SYNTAX_PROBE="${entry%%"$HOOK_SYNTAX_NL"*}"
      [ "$HOOK_SYNTAX_PROBE" = ok ]
      return
      ;;
  esac
  if ! command -v "$name" >/dev/null 2>&1; then
    HOOK_SYNTAX_PROBE=absent
  else
    "$name" "$@" >/dev/null 2>&1 || rc=$?
    if [ "$rc" -eq 0 ]; then
      HOOK_SYNTAX_PROBE=ok
    else
      HOOK_SYNTAX_PROBE="cannot run (exit $rc)"
    fi
  fi
  HOOK_SYNTAX_PROBED="$HOOK_SYNTAX_PROBED$name=>$HOOK_SYNTAX_PROBE$HOOK_SYNTAX_NL"
  [ "$HOOK_SYNTAX_PROBE" = ok ]
}

# $1 = path. Returns 0 when this run has already checked it. Fork-free: a sweep
# reads a few thousand files.
_hook_syntax_seen() {
  case "$HOOK_SYNTAX_SEEN" in
    *"$HOOK_SYNTAX_NL$1$HOOK_SYNTAX_NL"*) return 0 ;;
  esac
  return 1
}

_hook_syntax_mark() {
  HOOK_SYNTAX_SEEN="$HOOK_SYNTAX_SEEN$HOOK_SYNTAX_NL$1$HOOK_SYNTAX_NL"
}

# $1 = path. Reads up to 512 characters of the first line (a builtin read, no
# fork) and sets:
#   HOOK_SYNTAX_KIND     shell | python | none
#   HOOK_SYNTAX_INTERP   the interpreter a shell shebang names
#   HOOK_SYNTAX_SHEBANG  1 when the first line starts with #! at all
HOOK_SYNTAX_KIND=none
HOOK_SYNTAX_INTERP=''
HOOK_SYNTAX_SHEBANG=0
_hook_syntax_kind() {
  local line=''
  HOOK_SYNTAX_KIND=none
  HOOK_SYNTAX_INTERP=''
  HOOK_SYNTAX_SHEBANG=0
  # At most 512 characters. Every file in the tree passes through here, and an
  # uncapped read of a one-line data file costs time that grows faster than
  # its length: one 210 KB single-line JSON in this repo took over a minute
  # under a UTF-8 locale. A #! line longer than the cap is classified on its
  # first 512 characters.
  IFS= read -r -n 512 line < "$1" 2>/dev/null
  # A CRLF checkout (Windows, core.autocrlf=true) ends the shebang in \r. Left
  # on, it matched no kind, so the file was skipped and passed. Stripped, the
  # file is classified, and the CR scan in _hook_syntax_finish refuses it.
  line="${line%$'\r'}"
  case "$line" in
    '#!'*) HOOK_SYNTAX_SHEBANG=1 ;;
  esac
  case "$line" in
    '#!/bin/bash' | '#!/bin/bash '*) HOOK_SYNTAX_KIND=shell HOOK_SYNTAX_INTERP=/bin/bash ;;
    '#!/usr/bin/env bash' | '#!/usr/bin/env bash '*) HOOK_SYNTAX_KIND=shell HOOK_SYNTAX_INTERP=bash ;;
    '#!/bin/sh' | '#!/bin/sh '*) HOOK_SYNTAX_KIND=shell HOOK_SYNTAX_INTERP=/bin/sh ;;
    '#!/usr/bin/env sh' | '#!/usr/bin/env sh '*) HOOK_SYNTAX_KIND=shell HOOK_SYNTAX_INTERP=sh ;;
    '#!'*python3 | '#!'*python3' '* | '#!'*python) HOOK_SYNTAX_KIND=python ;;
  esac
}

# Conflict markers, checked on CONTENT, one grep over every queued file.
#
# Only the three LABELLED markers are scanned: the opening, the diff3 base and
# the closing one. git always writes a label after each, so the trailing space
# is required, and a bare run of seven characters (a comment rule, a doc quoting
# the shape) is not a false positive. The middle `=` separator is deliberately
# absent: git writes it with NO label, which makes it indistinguishable from a
# banner rule. Nothing is lost, because a real conflict writes all four.
#
# $@ = files. Reports each conflicted file once, then its marker lines.
_hook_syntax_markers() {
  [ "$#" -gt 0 ] || return 0
  local hits f rest hit found rc=0
  # Judged on output, not exit status: grep exits 2 when any one file errors,
  # even after printing matches in the rest.
  hits=$(grep -nHE '^([<]{7}|[>]{7}|[|]{7}) ' -- "$@" 2>/dev/null)
  [ -n "$hits" ] || return 0
  for f in "$@"; do
    found=0
    rest="$hits"
    while [ -n "$rest" ]; do
      hit="${rest%%"$HOOK_SYNTAX_NL"*}"
      case "$rest" in
        *"$HOOK_SYNTAX_NL"*) rest="${rest#*"$HOOK_SYNTAX_NL"}" ;;
        *) rest='' ;;
      esac
      case "$hit" in
        "$f":[0-9]*)
          if [ "$found" -eq 0 ]; then
            printf 'hook-syntax: UNRESOLVED CONFLICT MARKERS in %s\n' "$f" >&2
            found=1
            rc=1
          fi
          printf '  %s\n' "$hit" >&2
          ;;
      esac
    done
  done
  return "$rc"
}

# $1 = path. If an earlier walk counted it as skipped, take that back: it is
# about to be checked as a payload.
_hook_syntax_unskip() {
  local f
  for f in "${HOOK_SYNTAX_UNPARSED[@]}"; do
    if [ "$f" = "$1" ]; then
      HOOK_SYNTAX_SKIPPED=$((HOOK_SYNTAX_SKIPPED - 1))
      return 0
    fi
  done
  return 0
}

# Parse one bun payload: the entrypoint and every local file it imports, in
# memory. $1 = payload. Silent on success.
_hook_syntax_check_bun() {
  local out
  _hook_syntax_unskip "$1"
  if ! _hook_syntax_probe "$HOOK_SYNTAX_BUN" --version; then
    # A coverage gap, not a fault: every shim exits cleanly when bun is absent.
    printf 'hook-syntax: %s %s — %s NOT checked\n' "$HOOK_SYNTAX_BUN" "$HOOK_SYNTAX_PROBE" "$1" >&2
    HOOK_SYNTAX_SKIPPED=$((HOOK_SYNTAX_SKIPPED + 1))
    return 0
  fi
  HOOK_SYNTAX_CHECKED=$((HOOK_SYNTAX_CHECKED + 1))
  HOOK_SYNTAX_PARSED+=("$1")
  if ! out=$("$HOOK_SYNTAX_BUN" build "$1" --target=bun --packages=external 2>&1 >/dev/null); then
    printf 'hook-syntax: FAILS TO PARSE %s\n' "$1" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  return 0
}

# Find what every queued shell file hands to bun, and parse each of those. One
# grep over all of them; the shape is `bun "$HERE/<rel>"`, with or without
# `exec` and `run`, resolved against the shim's own directory.
_hook_syntax_payloads() {
  [ "${#HOOK_SYNTAX_SHELLS[@]}" -gt 0 ] || return 0
  local hits rest hit shim f text rel dir payload rc=0
  local comment_re='^[[:space:]]*#'
  local bun_re='bun[[:space:]]+(run[[:space:]]+)?"\$HERE/([^"]+)"'
  hits=$(grep -HE 'bun[[:space:]]+(run[[:space:]]+)?"\$HERE/' -- "${HOOK_SYNTAX_SHELLS[@]}" 2>/dev/null)
  [ -n "$hits" ] || return 0
  rest="$hits"
  while [ -n "$rest" ]; do
    hit="${rest%%"$HOOK_SYNTAX_NL"*}"
    case "$rest" in
      *"$HOOK_SYNTAX_NL"*) rest="${rest#*"$HOOK_SYNTAX_NL"}" ;;
      *) rest='' ;;
    esac
    shim=''
    for f in "${HOOK_SYNTAX_SHELLS[@]}"; do
      case "$hit" in
        "$f":*) shim="$f"; break ;;
      esac
    done
    [ -n "$shim" ] || continue
    text="${hit#"$shim:"}"
    [[ $text =~ $comment_re ]] && continue
    [[ $text =~ $bun_re ]] || continue
    rel="${BASH_REMATCH[2]}"
    dir="${shim%/*}"
    [ "$dir" = "$shim" ] && dir='.'
    payload="$dir/$rel"
    _hook_syntax_seen "$payload" && continue
    _hook_syntax_mark "$payload"
    if [ ! -r "$payload" ]; then
      printf 'hook-syntax: MISSING PAYLOAD %s — handed to bun by %s\n' "$payload" "$shim" >&2
      rc=1
      continue
    fi
    _hook_syntax_check_bun "$payload" || rc=1
  done
  return "$rc"
}

# Parse one file. $1 = path. Queues it for the content scans; does not run them.
_hook_syntax_visit() {
  local file="$1" out

  _hook_syntax_seen "$file" && return 0

  if [ ! -r "$file" ]; then
    printf 'hook-syntax: UNREADABLE %s — cannot check it\n' "$file" >&2
    return 1
  fi

  _hook_syntax_kind "$file"

  # The one rule that reads a name: no #! line at all, and a `.sh` name, is a
  # sourced shell library.
  if [ "$HOOK_SYNTAX_KIND" = none ] && [ "$HOOK_SYNTAX_SHEBANG" -eq 0 ]; then
    case "$file" in
      *.sh) HOOK_SYNTAX_KIND=shell HOOK_SYNTAX_INTERP=bash ;;
    esac
  fi

  if [ "$HOOK_SYNTAX_KIND" = none ]; then
    HOOK_SYNTAX_SKIPPED=$((HOOK_SYNTAX_SKIPPED + 1))
    HOOK_SYNTAX_UNPARSED+=("$file")
    return 0
  fi
  _hook_syntax_mark "$file"

  case "$HOOK_SYNTAX_KIND" in
    shell)
      # Probed like python3 and bun: a PATH bash can be a version-manager shim
      # that fails every call, and `-n` under it says nothing about the file.
      if ! _hook_syntax_probe "$HOOK_SYNTAX_INTERP" -c :; then
        printf 'hook-syntax: %s %s — %s NOT checked\n' "$HOOK_SYNTAX_INTERP" "$HOOK_SYNTAX_PROBE" "$file" >&2
        HOOK_SYNTAX_SKIPPED=$((HOOK_SYNTAX_SKIPPED + 1))
        return 0
      fi
      HOOK_SYNTAX_CHECKED=$((HOOK_SYNTAX_CHECKED + 1))
      HOOK_SYNTAX_PARSED+=("$file")
      HOOK_SYNTAX_SHELLS+=("$file")
      if ! out=$("$HOOK_SYNTAX_INTERP" -n "$file" 2>&1); then
        printf 'hook-syntax: FAILS TO PARSE %s (%s -n)\n' "$file" "$HOOK_SYNTAX_INTERP" >&2
        printf '%s\n' "$out" >&2
        return 1
      fi
      ;;
    python)
      if ! _hook_syntax_probe "$HOOK_SYNTAX_PYTHON" -c pass; then
        printf 'hook-syntax: %s %s — %s NOT checked\n' "$HOOK_SYNTAX_PYTHON" "$HOOK_SYNTAX_PROBE" "$file" >&2
        HOOK_SYNTAX_SKIPPED=$((HOOK_SYNTAX_SKIPPED + 1))
        return 0
      fi
      HOOK_SYNTAX_CHECKED=$((HOOK_SYNTAX_CHECKED + 1))
      HOOK_SYNTAX_PARSED+=("$file")
      if ! out=$("$HOOK_SYNTAX_PYTHON" -W error::SyntaxWarning -c \
        'import sys; compile(open(sys.argv[1],"rb").read(), sys.argv[1], "exec")' \
        "$file" 2>&1); then
        printf 'hook-syntax: FAILS TO PARSE %s\n' "$file" >&2
        printf '%s\n' "$out" >&2
        return 1
      fi
      ;;
  esac
  return 0
}

# Visit every file under a directory. $1 = directory.
_hook_syntax_walk() {
  local dir="$1" rc=0 f name n=0
  if [ ! -d "$dir" ]; then
    printf 'hook-syntax: no such directory: %s\n' "$dir" >&2
    return 1
  fi
  # One physical spelling of the root. find does not descend a symlinked
  # starting point on its own, and the live install (~/.claude/skills/gstack)
  # is one; every path the sweep compares below must share this prefix.
  dir="$(cd "$dir" 2>/dev/null && pwd -P)" || {
    printf 'hook-syntax: cannot enter %s\n' "$1" >&2
    return 1
  }
  local g pat
  local -a expr=() skip=()
  for name in $HOOK_SYNTAX_PRUNE_NAMES; do
    expr+=(-o -name "$name")
    [ "$name" = .git ] || skip+=(-o -name "$name")
  done
  # A nested checkout (a worktree or clone under the tree, e.g. Claude Code's
  # .claude/worktrees/<name>) is another branch's files, not this install's; a
  # conflict marker there must not refuse this setup. Prune every directory
  # that holds its own .git, file or directory. The search skips the other
  # prune names, so a checkout inside an already-pruned tree is not counted,
  # and starts at depth 1 so the root's own .git is the one entry it skips.
  # Each path becomes a -path PATTERN, so its glob characters are escaped: a
  # checkout under .../gstack[old]/ must match itself, literally.
  while IFS= read -r -d '' g; do
    [ "$g" = "$dir/.git" ] && continue
    pat="${g%/.git}"
    pat="${pat//\\/\\\\}"
    pat="${pat//\[/\\[}"
    pat="${pat//\]/\\]}"
    pat="${pat//\*/\\*}"
    pat="${pat//\?/\\?}"
    expr+=(-o -path "$pat")
    HOOK_SYNTAX_NESTED=$((HOOK_SYNTAX_NESTED + 1))
  done < <(find "$dir" -mindepth 1 \( "${skip[@]:1}" \) -prune -o -name .git -print0 -prune 2>/dev/null)
  # Directories come through the same find as files. One the sweep cannot read
  # or search hides everything under it, and find says so only on stderr, which
  # goes to /dev/null here; so each directory is asked directly. `[ -r ]` and
  # `[ -x ]` are builtins over access(): no fork per directory, ACLs and
  # ownership count, and no temp file, so a wiped TMPDIR cannot refuse setup.
  while IFS= read -r -d '' f; do
    if [ -d "$f" ]; then
      if [ ! -r "$f" ] || [ ! -x "$f" ]; then
        printf 'hook-syntax: UNREADABLE directory %s — cannot check what is under it\n' "$f" >&2
        rc=1
      fi
      continue
    fi
    n=$((n + 1))
    _hook_syntax_visit "$f" || rc=1
  done < <(find "$dir" \( "${expr[@]:1}" \) -prune -o \( -type f -o -type d \) -print0 2>/dev/null | sort -z)
  # A sweep that found no file at all checked nothing; never let that read
  # green.
  if [ "$n" -eq 0 ]; then
    printf 'hook-syntax: no files found under %s — nothing was checked\n' "$dir" >&2
    rc=1
  fi
  return "$rc"
}

# CR bytes in shell files: one grep over every queued shell file. $@ = files.
_hook_syntax_carriage_returns() {
  [ "$#" -gt 0 ] || return 0
  local hits f rest rc=0
  # Judged on output, like the marker scan.
  hits=$(grep -l $'\r' -- "$@" 2>/dev/null)
  [ -n "$hits" ] || return 0
  rest="$hits"
  while [ -n "$rest" ]; do
    f="${rest%%"$HOOK_SYNTAX_NL"*}"
    case "$rest" in
      *"$HOOK_SYNTAX_NL"*) rest="${rest#*"$HOOK_SYNTAX_NL"}" ;;
      *) rest='' ;;
    esac
    printf 'hook-syntax: CRLF LINE ENDINGS %s — bash keeps the \\r on every line\n' "$f" >&2
    rc=1
  done
  return "$rc"
}

# Drain the queues: parse the bun payloads, then scan for carriage returns in
# shell files and for conflict markers in everything parsed. Payloads first,
# so they are marker-scanned too.
_hook_syntax_finish() {
  local rc=0
  _hook_syntax_payloads || rc=1
  _hook_syntax_carriage_returns "${HOOK_SYNTAX_SHELLS[@]}" || rc=1
  _hook_syntax_markers "${HOOK_SYNTAX_PARSED[@]}" || rc=1
  HOOK_SYNTAX_PARSED=()
  HOOK_SYNTAX_SHELLS=()
  HOOK_SYNTAX_UNPARSED=()
  return "$rc"
}

# Public entry points. Each returns 1 if anything is broken, and checks
# everything first, so one bad file does not hide the next.
hook_syntax_check_file() {
  local rc=0
  _hook_syntax_visit "$1" || rc=1
  _hook_syntax_finish || rc=1
  return "$rc"
}

# $1 = directory; the repo root (the directory holding scripts/) by default.
hook_syntax_check_tree() {
  local dir="${1:-}" rc=0
  [ -n "$dir" ] || dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P)"
  _hook_syntax_walk "$dir" || rc=1
  _hook_syntax_finish || rc=1
  return "$rc"
}

hook_syntax_report() {
  printf 'hook-syntax: %d checked, %d skipped\n' \
    "$HOOK_SYNTAX_CHECKED" "$HOOK_SYNTAX_SKIPPED" >&2
  if [ "$HOOK_SYNTAX_NESTED" -gt 0 ]; then
    printf 'hook-syntax: %d nested checkout(s) not swept\n' "$HOOK_SYNTAX_NESTED" >&2
  fi
}

# Direct invocation: sweep the repo, or the targets named on the command line.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  _report=0
  if [ "${1:-}" = "--report" ]; then
    _report=1
    shift
  fi
  _rc=0
  if [ "$#" -eq 0 ]; then
    _hook_syntax_walk "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P)" || _rc=1
  else
    for _f in "$@"; do
      # A directory is swept. Reading one as a file would find no shebang and
      # report a clean skip: a pass for something never looked at.
      if [ -d "$_f" ]; then
        _hook_syntax_walk "$_f" || _rc=1
      else
        _hook_syntax_visit "$_f" || _rc=1
      fi
    done
  fi
  _hook_syntax_finish || _rc=1
  [ "$_report" -eq 1 ] && hook_syntax_report
  exit "$_rc"
fi
