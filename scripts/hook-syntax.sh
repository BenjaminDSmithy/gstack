#!/bin/bash
# hook-syntax.sh — parse gate for the shell, python and hook-payload files this
# repo ships.
#
# Run by `setup` before it sources, builds, links, copies or registers anything
# (only scripts/heal-eol.sh runs first; the read-only `./setup --status` exits
# earlier and installs nothing), and pinned by `test/hook-syntax.test.ts`, which
# runs in the free suite. Also runnable alone (spell /bin/bash — see
# "Invocation" below):
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
# freeze/bin/check-freeze.sh. /autoplan's generated frontmatter wires a third
# for as long as the skill is active: autoplan/bin/phase-publication-hook.
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
#   * a bun payload -> bundled through Bun's build API (target bun, npm
#     packages external, the bundle `bun build --target=bun
#     --packages=external` makes): the entrypoint and every local file it
#     imports, in memory, writing nothing. npm packages are left unresolved on
#     purpose — `setup` runs this before its own `bun install`, so resolving
#     them would refuse every fresh clone for a reason that has nothing to do
#     with syntax. Every local file the build pulled in is then marker-scanned
#     from its own bytes
#   * conflict markers -> scanned SEPARATELY from parsing, because a marker
#     inside a heredoc body or a quoted string parses cleanly and is still a
#     half-merged file. This scan and the search for bun payloads read every
#     file as text, NUL bytes included: bash runs a script with a NUL past its
#     first two lines, where grep would call the file binary and print no line.
#     bash drops each NUL as it reads, so a shim line holding one is read with
#     the NUL dropped, wherever it sits: inside `bun`, a name or a value
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
# hands to bun, and each of those is parsed too. `$HERE` is the usual name;
# a variable whose last assignment before the call is the shim's own directory,
# `VAR="$(cd "$(dirname "$0")" && pwd)"` (`pwd -P`, `${BASH_SOURCE[0]}` and a
# redirect on the cd allowed), counts the same, which is how /autoplan's hook
# names its payload. The payload is found from the
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
#     is invisible here, unless a bun payload imports it.
#   * A parse is not a run. A hook that parses and then fails at runtime is out
#     of scope.
#   * A shim that reaches bun any other way than `bun "$VAR/<path>"`, with
#     VAR set from the shim's own directory, has its payload unchecked. The
#     shim itself is still parsed.
#   * An interpreter that is absent or cannot run (python3, bun, a PATH bash)
#     is reported as a coverage gap for its parse, never counted as a pass and
#     never as a parse failure. The content scans still run on its files. A
#     shell or bun whose probe exits 2 is refused instead: every hook it runs
#     would exit 2 too.
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
# runs once per sweep over every file the parse pass accepted. Beyond that: one
# probe per interpreter per run, one bun process per payload, and one grep per
# shim that names its payload through a variable other than $HERE.
#
# EXIT. 0 clean, 1 something is broken or could not be looked at. Never
# anything else: setup reads any other code as "the checker could not run".
#
# INVOCATION. Spell `/bin/bash`, not a bare `bash`: on macOS a PATH-resolved
# bash is Homebrew's 5.x, which can deadlock writing a heredoc body. This file
# has no heredocs, and stays bash-3.2-clean.

# What the caller exports must not reach a verdict. macOS grep (BSD 2.6.0)
# still applies GREP_OPTIONS, without a word, as GNU grep did until 3.6, and
# `--color=always` there wrapped every match in escapes: a payload path read
# out of a hit named a file that does not exist, refusing a healthy tree as
# MISSING PAYLOAD, and an own-directory assignment matched nothing, so a
# broken payload behind it passed unchecked. No grep here wants an option it
# did not spell.
unset GREP_OPTIONS

# A function the caller exported (`export -f`) runs in place of the command it
# is named after: a grep forcing --color=always passed a broken payload behind
# an own-directory variable, and a find that printed nothing refused a healthy
# tree as "no files found". Run directly, this file calls no function it does
# not define below, so every one its shell started with is dropped first. A
# shell that sources it keeps its own.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  while read -r _ _ _fn; do
    unset -f "$_fn"
  done < <(declare -F)
fi

# Interpreter seams for the test suite, which points them at names that do not
# exist to exercise the absent-interpreter paths.
HOOK_SYNTAX_PYTHON="${HOOK_SYNTAX_PYTHON:-python3}"
HOOK_SYNTAX_BUN="${HOOK_SYNTAX_BUN:-bun}"

# Run as `bun -e` in place of `bun build`, so one process both parses a
# payload and names what it imports. Same bundle: target bun, npm packages
# external, nothing written. On failure: bun's diagnostics, exit 1. On success:
# the physical path of every local file the build pulled in other than the
# entrypoint, one per line, read from the build's metafile; a bun whose build
# API has no metafile prints NO_METAFILE instead. The list comes from the
# build itself, never from the bundle's text, which bun re-prints: it turns an
# ordinary "\n<<<<<<< " string into a template literal with the marker at
# column 0, and it names modules in comment headers whose shape varies.
#
# An entrypoint without a JavaScript or TypeScript extension is loaded as
# TypeScript, which is how `bun <file>` runs it. Left to the build's own rules
# it is an asset: copied, never parsed, so a broken one passed (and `bun build`
# refused a valid one with "cannot write multiple output files").
HOOK_SYNTAX_BUN_JS='const path = require("path"); const fs = require("fs");
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const entry = real(process.argv[1]);
const plugins = [];
if (![".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(path.extname(entry))) {
  const exact = new RegExp("^" + entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
  plugins.push({ name: "hook-syntax-entry-as-ts", setup(b) {
    b.onLoad({ filter: exact }, () => ({ contents: fs.readFileSync(entry, "utf8"), loader: "ts" }));
  } });
}
let r;
try {
  r = await Bun.build({ entrypoints: [entry], target: "bun", packages: "external", metafile: true, plugins });
} catch (e) {
  for (const m of (e && e.errors) || [e]) console.error(Bun.inspect(m));
  process.exit(1);
}
if (!r.success) { for (const m of r.logs) console.error(Bun.inspect(m)); process.exit(1); }
if (!r.metafile) { console.log("NO_METAFILE"); process.exit(0); }
for (const k of Object.keys(r.metafile.inputs)) { const p = real(k); if (p !== entry) console.log(p); }'

# What the run actually covered. Read by `--report`; never asserted.
HOOK_SYNTAX_CHECKED=0
HOOK_SYNTAX_SKIPPED=0
HOOK_SYNTAX_NESTED=0

# Set by _hook_syntax_payload when a `bun "$VAR/..."` names the shim's directory.
HOOK_SYNTAX_FOLLOWED=0
# Filled by _hook_syntax_bun_calls: one VAR<TAB>rel line per call, and the
# line's text before each call, one element per call in the same order.
HOOK_SYNTAX_CALLS=''
HOOK_SYNTAX_BEFORE=()
# Set by _hook_syntax_assigns: what a shim line leaves a variable holding.
HOOK_SYNTAX_VALUE=''
# Filled by _hook_syntax_read_list: the records it read, one per element.
HOOK_SYNTAX_LIST=()

# Paths already checked this run, newline-delimited, so a payload reached
# through its shim is not checked again when the sweep walks past it.
HOOK_SYNTAX_SEEN=""
# Payloads already judged as entry points this run, built or reported
# missing, kept the same way.
HOOK_SYNTAX_ENTRIES=""

# Directories never descended into: vendored and generated trees carry other
# people's scripts, and a finding in one is noise this gate cannot act on.
HOOK_SYNTAX_PRUNE_NAMES="node_modules .git dist .build __pycache__ .venv"

# Queues drained once per sweep by _hook_syntax_finish.
HOOK_SYNTAX_PARSED=()    # every file parsed: marker-scanned
HOOK_SYNTAX_SHELLS=()    # every shell file parsed: searched for bun payloads
HOOK_SYNTAX_UNPARSED=()  # every file skipped, so a payload found later is uncounted

HOOK_SYNTAX_NL='
'
# In the C locale, an ERE bracket that matches a NUL byte and nothing else.
# bash drops every NUL from a script it runs, inside a word or a name too, so
# a scan that must see a shim's lines as bash runs them also takes each line
# holding a NUL, and reads it with the NUL dropped. BSD and GNU grep match a
# NUL this way under -a. BusyBox grep ends a line at a NUL, so there a line
# holding one is still misread.
HOOK_SYNTAX_NUL_RE=$'[^\001-\377]'

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

# An interpreter the probe could not run is a coverage gap for the parse it
# would have done: say so, count the file as skipped, return 0. One exception,
# for the interpreters that run hooks (a shell, bun): a probe that exited 2.
# Every hook run through that interpreter exits 2 as well, which is the status
# Claude Code reads as "block", so that is a refusal, not a gap.
# $1 = interpreter, $2 = file, $3 = runs-hooks (1 or 0). Reads HOOK_SYNTAX_PROBE.
_hook_syntax_gap() {
  if [ "$3" -eq 1 ] && [ "$HOOK_SYNTAX_PROBE" = 'cannot run (exit 2)' ]; then
    printf 'hook-syntax: %s exits 2 on every call — a hook it runs, such as %s, would block every tool call it is wired to\n' "$1" "$2" >&2
    return 1
  fi
  printf 'hook-syntax: %s %s — %s NOT checked\n' "$1" "$HOOK_SYNTAX_PROBE" "$2" >&2
  HOOK_SYNTAX_SKIPPED=$((HOOK_SYNTAX_SKIPPED + 1))
  return 0
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

# $1 = path. Reads the first line, up to 512 characters and never past a run
# of NUL bytes (a builtin read, no fork), and sets:
#   HOOK_SYNTAX_KIND     shell | python | none
#   HOOK_SYNTAX_INTERP   the interpreter a shell shebang names
#   HOOK_SYNTAX_SHEBANG  1 when the first line starts with #! at all
HOOK_SYNTAX_KIND=none
HOOK_SYNTAX_INTERP=''
HOOK_SYNTAX_SHEBANG=0
# bash 4 and later drop NUL bytes from a read without counting them toward -n,
# so a newline-delimited read of a NUL-heavy file runs on past the cap (an 8 MB
# run of NULs: about 1 s under bash 5.3). There the read stops at the first NUL
# instead and the line is cut at its first newline afterwards. bash 3.2 counts
# a NUL toward -n, so the cap already holds there, and it keeps the newline
# read: NUL-delimited, a 3.2 read never stops at a newline, takes all 512
# characters one byte at a time, and made a sweep of this tree 1.5-2.5 s slower.
if [ "${BASH_VERSINFO[0]}" -ge 4 ]; then
  HOOK_SYNTAX_READ_TO_NUL=1
else
  HOOK_SYNTAX_READ_TO_NUL=0
fi
_hook_syntax_kind() {
  local line=''
  HOOK_SYNTAX_KIND=none
  HOOK_SYNTAX_INTERP=''
  HOOK_SYNTAX_SHEBANG=0
  # At most 512 characters. Every file in the tree passes through here, and an
  # uncapped read of a one-line data file costs time that grows faster than
  # its length: one 210 KB single-line JSON in this repo took over a minute
  # under a UTF-8 locale. A #! line longer than the cap is classified on its
  # first 512 characters. Either read leaves a shebang that sits behind a run
  # of NULs unread, which matches the kernel: a shebang is a file's first
  # bytes.
  if [ "$HOOK_SYNTAX_READ_TO_NUL" -eq 1 ]; then
    IFS= read -r -d '' -n 512 line < "$1" 2>/dev/null
    line="${line%%"$HOOK_SYNTAX_NL"*}"
  else
    IFS= read -r -n 512 line < "$1" 2>/dev/null
  fi
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
  #
  # -a reads every file as text. Without it grep calls a file binary when its
  # first buffer (32 KiB for BSD grep) holds a NUL, and prints "Binary file X
  # matches" (BSD) or nothing at all on stdout (GNU) in place of the lines, so
  # no line names the file. bash runs a script whose NUL sits past its first
  # two lines, dropping the byte, and git merges a file as text, markers and
  # all, while its first 8,000 bytes hold none. A NUL on a matched line is
  # dropped from the capture too; the braces keep bash 4.4 and later from
  # warning about it on stderr.
  { hits=$(LC_ALL=C grep -anHE '^([<]{7}|[>]{7}|[|]{7}) ' -- "$@" 2>/dev/null); } 2>/dev/null
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

# Parse one bun payload, the entrypoint and every local file it imports, in
# memory, and queue each of those files for the content scans. $1 = payload.
# Silent on success.
_hook_syntax_check_bun() {
  local out line placed rc=0 queued=0
  # A payload an earlier payload imported is counted and queued already; it is
  # still built here as an entry point of its own.
  _hook_syntax_seen "$1" && queued=1
  if [ "$queued" -eq 0 ]; then
    _hook_syntax_mark "$1"
    _hook_syntax_unskip "$1"
    # The payload's own bytes are marker-scanned whatever the probe says.
    HOOK_SYNTAX_PARSED+=("$1")
  fi
  if ! _hook_syntax_probe "$HOOK_SYNTAX_BUN" --version; then
    # Otherwise a coverage gap: every shim exits cleanly when bun is absent,
    # and what the payload imports cannot be listed without it.
    _hook_syntax_gap "$HOOK_SYNTAX_BUN" "$1" 1
    return
  fi
  [ "$queued" -eq 1 ] || HOOK_SYNTAX_CHECKED=$((HOOK_SYNTAX_CHECKED + 1))
  if ! out=$("$HOOK_SYNTAX_BUN" -e "$HOOK_SYNTAX_BUN_JS" "$1" 2>&1); then
    printf 'hook-syntax: FAILS TO PARSE %s\n' "$1" >&2
    printf '%s\n' "$out" >&2
    return 1
  fi
  # A module bun parsed as part of the payload is marker-scanned from its own
  # bytes, like any other parsed file, so it counts as checked; one an earlier
  # walk counted as skipped is taken back. A marker inside a template literal
  # or a comment parses cleanly, and the sweep alone would skip the file.
  while IFS= read -r line; do
    case "$line" in
      [A-Za-z]:[\\/]*)
        # Bun on Windows names a file by drive letter; under Git Bash, cygpath
        # maps it. Unmapped, it falls through to the warning below.
        if command -v cygpath >/dev/null 2>&1 && placed=$(cygpath -u "$line" 2>/dev/null) && [ -n "$placed" ]; then
          line="$placed"
        fi
        ;;
    esac
    case "$line" in
      NO_METAFILE)
        printf 'hook-syntax: %s cannot list what %s imports — those files are NOT marker-scanned\n' "$HOOK_SYNTAX_BUN" "$1" >&2
        ;;
      /*)
        _hook_syntax_seen "$line" && continue
        _hook_syntax_mark "$line"
        if [ ! -r "$line" ]; then
          printf 'hook-syntax: UNREADABLE %s — imported by %s, cannot check it\n' "$line" "$1" >&2
          rc=1
          continue
        fi
        _hook_syntax_unskip "$line"
        HOOK_SYNTAX_CHECKED=$((HOOK_SYNTAX_CHECKED + 1))
        HOOK_SYNTAX_PARSED+=("$line")
        ;;
      '') ;;
      *)
        printf 'hook-syntax: cannot place %s, imported by %s — it is NOT marker-scanned\n' "$line" "$1" >&2
        ;;
    esac
  done < <(printf '%s\n' "$out")
  return "$rc"
}

# Find what every queued shell file hands to bun, and parse each of those. One
# grep over all of them; the shape is `bun "$VAR/<rel>"`, with or without
# `exec` and `run`, resolved against the shim's own directory. VAR is HERE, or
# a variable the same file sets from its own directory; any other variable
# names somewhere else, and the path is not followed.
_hook_syntax_payloads() {
  [ "${#HOOK_SYNTAX_SHELLS[@]}" -gt 0 ] || return 0
  local hits rest hit shim f text line calls call var rel strict k rc=0 tab=$'\t'
  # Read as text, and a dropped NUL kept quiet, as in _hook_syntax_markers:
  # a NUL anywhere in a shim's first 32 KiB hid every call in it. Every line
  # holding a NUL is taken too, and read below with the NUL dropped, as bash
  # runs it: the pattern matches no call a NUL splits (`bun<NUL> "$HERE/x"`).
  { hits=$(LC_ALL=C grep -anHE 'bun[[:space:]]+(run[[:space:]]+)?"\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/'"|$HOOK_SYNTAX_NUL_RE" -- "${HOOK_SYNTAX_SHELLS[@]}" 2>/dev/null); } 2>/dev/null
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
    line="${text%%:*}"
    _hook_syntax_bun_calls "${text#*:}"
    # Every `bun "$VAR/..."` on the line, not only the first: a line can hand
    # bun two paths, and one that is not followed must not hide the next. Only
    # the first followed one must exist; a later one may sit in a trailing
    # comment or a quoted string, so it is parsed when it is there and skipped
    # when it is not.
    strict=1
    calls="$HOOK_SYNTAX_CALLS"
    k=0
    while [ -n "$calls" ]; do
      call="${calls%%"$HOOK_SYNTAX_NL"*}"
      calls="${calls#*"$HOOK_SYNTAX_NL"}"
      var="${call%%"$tab"*}"
      rel="${call#*"$tab"}"
      HOOK_SYNTAX_FOLLOWED=0
      _hook_syntax_payload "$shim" "$var" "$rel" "$line" "$strict" "${HOOK_SYNTAX_BEFORE[k]}" || rc=1
      [ "$HOOK_SYNTAX_FOLLOWED" -eq 1 ] && strict=0
      k=$((k + 1))
    done
  done
  return "$rc"
}

# The `bun "$VAR/<rel>"` calls on one shim line, in order, as VAR<TAB>rel
# lines in HOOK_SYNTAX_CALLS, and the line's text before each one in
# HOOK_SYNTAX_BEFORE; none for a comment line. $1 = the line's text.
# Read in the C locale, like the greps: under a UTF-8 locale bash's regex
# finds no match past an invalid UTF-8 byte, so a call after one went unread.
_hook_syntax_bun_calls() {
  local LC_ALL=C text="$1"
  local comment_re='^[[:space:]]*#'
  local bun_re='bun[[:space:]]+(run[[:space:]]+)?"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/([^"]+)"'
  HOOK_SYNTAX_CALLS=''
  HOOK_SYNTAX_BEFORE=()
  [[ $text =~ $comment_re ]] && return 0
  while [[ $text =~ $bun_re ]]; do
    HOOK_SYNTAX_CALLS="$HOOK_SYNTAX_CALLS${BASH_REMATCH[2]}"$'\t'"${BASH_REMATCH[3]}$HOOK_SYNTAX_NL"
    text="${text#*"${BASH_REMATCH[0]}"}"
    HOOK_SYNTAX_BEFORE+=("${1%"${BASH_REMATCH[0]}$text"}")
  done
  return 0
}

# Read stdin into HOOK_SYNTAX_LIST, one element per record; $1 ends a record
# ('' for NUL). Read in the C locale: under a UTF-8 locale, bash 5.2's read
# takes the bytes after an invalid UTF-8 byte as part of one character, the
# delimiter included, so a record that ended in one ran on into the next, and
# a last record that ended in one was never returned.
#
# Not for a file's lines: /bin/bash 3.2's read cuts a record at its first NUL
# and throws the rest of it away, as bash 4.2 does (4.3 and later drop the
# NUL and go on). _hook_syntax_lines splits those.
_hook_syntax_read_list() {
  local LC_ALL=C item
  HOOK_SYNTAX_LIST=()
  while IFS= read -r -d "$1" item; do
    HOOK_SYNTAX_LIST+=("$item")
  done
  return 0
}

# Split $1 into HOOK_SYNTAX_LIST, one element per line. $1 comes from a
# command substitution, which every bash drops a NUL from, as it does at run
# time. Unlike read, pattern removal cuts at the newline byte in any locale,
# after an invalid UTF-8 byte too.
_hook_syntax_lines() {
  local rest="$1"
  HOOK_SYNTAX_LIST=()
  while [ -n "$rest" ]; do
    HOOK_SYNTAX_LIST+=("${rest%%"$HOOK_SYNTAX_NL"*}")
    case "$rest" in
      *"$HOOK_SYNTAX_NL"*) rest="${rest#*"$HOOK_SYNTAX_NL"}" ;;
      *) rest='' ;;
    esac
  done
  return 0
}

# $1 =~ $2 in the C locale. Returns the match status.
_hook_syntax_match() {
  local LC_ALL=C
  [[ $1 =~ $2 ]]
}

# What one shim line does to VAR, read as bash reads it: split into commands
# at `;`, `&`, `&&`, `||` and `|` outside quotes, `(...)`, `$(...)`, `${...}`
# and backquotes, each command into words at blanks, and a `#` that opens a
# word ending the line. $1 = the text, $2 = VAR, $3 = `call` when $1 is a
# line's text before a bun call. Returns 0 and sets HOOK_SYNTAX_VALUE to what
# VAR holds at the end of the text, or at the call: the text after `VAR=` in
# the last assignment of VAR in force there, with a `+` before it for
# `VAR+=`, or '' at a call that runs only once that assignment has failed.
# Returns 1 when no assignment of VAR in the text is in force there, and VAR
# keeps the value it had.
#
# An assignment is in force once its command has run, when that command holds
# only assignments and redirects (`VAR=x`, `VAR=x 2>/dev/null`), or is
# export, readonly, local, declare or typeset with `VAR=x` as an argument.
# Commands run as on the path where each of those succeeds and anything else
# may go either way: a command after `&&` or `||` runs unless the `||` follows
# one of those. Neither of these changes VAR: an assignment that only prefixes a
# command (`VAR=x cmd`), which sets VAR for that command alone, and one in a
# pipeline, or in a list sent to the background with `&`, which runs in a
# subshell.
#
# At a call, the call's own command has not run: bash expands the call before
# it assigns (`VAR=x bun ...`, `VAR="$(bun "$VAR/x.ts")"`), though an
# assignment ahead of the one whose value holds the call is in force for it
# (`X=y VAR="$(bun "$X/x.ts")"`). A call reached only through `||` straight
# after an assignment of VAR runs once that assignment has failed, and VAR
# then holds the failed substitution's output, not the value as written.
#
# Straight-line reading, as for the lines above the call: a compound command
# is read as if its parts stood alone (`if`, `then`, `do`, `{`, `!` and the
# like are skipped, so a `{ ...; }` or `if ... fi` piped or sent to the
# background is not seen as one), and an assignment inside `(...)` or `$(...)`
# is not read. Read in the C locale, a byte at a time.
_hook_syntax_assigns() {
  local LC_ALL=C text="$1" var="$2" mode="${3:-}"
  local i=0 base=0 len win run c nx top op adv wstart=-1 stack='' tab=$'\t'
  # What ends a run of plain bytes in each context.
  local sp_q="[\\\\']" sp_dq="[\\\\\$\"\`]" sp_bq="[\\\\\`]" sp_br="[\\\\\$\"\`}]"
  local sp_cmd="[\\\\\$\"'\`()<> $tab#;&|]"
  local name_re='^[A-Za-z_][A-Za-z0-9_]*(\[[^]]*\])?\+?='
  local redir_re='^([0-9]+|\{[A-Za-z_][A-Za-z0-9_]*\})?(&>|[<>]([^(]|$))'
  local redir_only_re='^([0-9]+|\{[A-Za-z_][A-Za-z0-9_]*\})?(&>>?|<<<|<<-?|<>|<&|>&|>>|>\||<|>)$'
  # VAR as the lists that have ended leave it (set, value), and as the list
  # still open does (lset, lvalue). For the open list: the operator before the
  # next command, whether the last command ran, whether it ended ok (it is an
  # assignment) or either way, and whether it assigned VAR.
  local set=0 value='' lset=0 lvalue='' prev='' ran=1 status=ok ran_var=0
  # What _hook_syntax_assigns_words makes of one command's words.
  local kind asg val neg cmd_at
  local -a words
  words=()
  len=${#text}
  # Read through a window of the text, a run of plain bytes at a time, and a
  # word taken out once, when it ends: every expansion of a string costs its
  # whole length, so reading the text itself byte by byte, or growing a word
  # byte by byte, is quadratic in a long line. The stack holds the open quotes
  # and brackets: S '...', Q $'...', " "...", ` `...`, { ${...}, ( (...).
  win="${text:0:260}"
  while [ "$i" -lt "$len" ]; do
    if [ $((i - base)) -ge 256 ]; then
      base=$i
      win="${text:base:260}"
    fi
    top="${stack#"${stack%?}"}"
    [ "$wstart" -lt 0 ] && wstart=$i
    # A run of bytes that mean nothing where they stand is skipped whole.
    run="${win:i-base}"
    case "$top" in
      S) run="${run%%"'"*}" ;;
      Q) run="${run%%$sp_q*}" ;;
      '"') run="${run%%$sp_dq*}" ;;
      '`') run="${run%%$sp_bq*}" ;;
      '{') run="${run%%$sp_br*}" ;;
      *) run="${run%%$sp_cmd*}" ;;
    esac
    if [ -n "$run" ]; then
      i=$((i + ${#run}))
      continue
    fi
    c="${win:i-base:1}"
    nx="${win:i-base+1:1}"
    if [ "$top" = S ]; then
      [ "$c" = "'" ] && stack="${stack%?}"
      i=$((i + 1))
      continue
    fi
    if [ "$c" = '\' ]; then
      i=$((i + 2))
      continue
    fi
    if [ "$top" = Q ]; then
      [ "$c" = "'" ] && stack="${stack%?}"
      i=$((i + 1))
      continue
    fi
    if [ "$c" = '$' ] && [ "$top" != '`' ]; then
      case "$nx" in
        '('|'{') stack="$stack$nx"; i=$((i + 2)); continue ;;
      esac
    fi
    case "$top" in
      '`') [ "$c" = '`' ] && stack="${stack%?}" ;;
      '"'|'{')
        case "$top$c" in
          '""'|'{}') stack="${stack%?}" ;;
          '"`'|'{"'|'{`') stack="$stack$c" ;;
        esac
        ;;
      *)
        # A command: the line itself, or one inside (...) or $(...).
        case "$c$nx" in
          "\$'"*) stack="${stack}Q"; i=$((i + 2)); continue ;;
          "'"*) stack="${stack}S" ;;
          '"'*|'`'*|'('*) stack="$stack$c" ;;
          ')'*) [ -n "$stack" ] && stack="${stack%?}" ;;
          # `>&`, `<&` and `>|` are redirects, not operators.
          '>&'|'<&'|'>|') i=$((i + 2)); continue ;;
          '&>') [ -z "$stack" ] && { i=$((i + 2)); continue; } ;;
          ' '*|"$tab"*|'#'*|';'*|'&'*|'|'*)
            if [ -z "$stack" ]; then
              op="$c" adv=1
              case "$c$nx" in
                '#'*)
                  if [ "$wstart" -eq "$i" ]; then
                    wstart=-1
                    break
                  fi
                  op=''
                  ;;
                ' '*|"$tab"*) op='' ;;
                '&&'|'||') op="$c$nx" adv=2 ;;
                '|&'|';&') adv=2 ;;
                ';;') adv=2; [ "${win:i-base+2:1}" = '&' ] && adv=3 ;;
              esac
              if [ "$c" != '#' ]; then
                if [ "$i" -gt "$wstart" ]; then
                  if [ "$wstart" -ge "$base" ]; then
                    words+=("${win:wstart-base:i-wstart}")
                  else
                    words+=("${text:wstart:i-wstart}")
                  fi
                fi
                wstart=-1
                [ -n "$op" ] && _hook_syntax_assigns_cmd "$op"
                i=$((i + adv))
                continue
              fi
            fi
            ;;
        esac
        ;;
    esac
    i=$((i + 1))
  done
  if [ "$mode" = call ]; then
    # The call's own command, so far: its words, and the one the call is in.
    if [ "$prev" = '||' ] && [ "$status" = ok ] && [ "$ran_var" -eq 1 ]; then
      lset=1
      lvalue=''
    fi
    if [ -n "$stack" ] && [ "$wstart" -ge 0 ] && [[ ${text:wstart} =~ $name_re ]]; then
      _hook_syntax_assigns_words
      if [ "$kind" = assign ] && [ "$asg" -eq 1 ]; then
        lset=1
        lvalue="$val"
      fi
    fi
  else
    [ "$wstart" -ge 0 ] && words+=("${text:wstart}")
    [ "${#words[@]}" -gt 0 ] && _hook_syntax_assigns_cmd ''
  fi
  if [ "$lset" -eq 1 ]; then
    set=1
    value="$lvalue"
  fi
  [ "$set" -eq 1 ] || return 1
  HOOK_SYNTAX_VALUE="$value"
  return 0
}

# One command's words, for _hook_syntax_assigns, whose locals it reads and
# sets (bash scopes them dynamically). kind: `assign` (assignments and
# redirects alone), `builtin` (export and the like) or `other`; asg=1 and val
# when it assigns VAR in force, the last such assignment; neg=1 after a `!`.
_hook_syntax_assigns_words() {
  local m=${#words[@]} w any=0
  kind=other asg=0 val='' neg=0 cmd_at=0
  while [ "$cmd_at" -lt "$m" ]; do
    case "${words[cmd_at]}" in
      '!') neg=1 ;;
      '{'|if|then|else|elif|do|while|until|time) ;;
      *) break ;;
    esac
    cmd_at=$((cmd_at + 1))
  done
  while [ "$cmd_at" -lt "$m" ]; do
    w="${words[cmd_at]}"
    if [[ $w =~ $name_re ]]; then
      any=1
      case "$w" in
        "$var="*) asg=1; val="${w#"$var="}" ;;
        "$var+="*) asg=1; val="+${w#"$var+="}" ;;
      esac
    elif [[ $w =~ $redir_re ]]; then
      [[ $w =~ $redir_only_re ]] && cmd_at=$((cmd_at + 1))
    else
      break
    fi
    cmd_at=$((cmd_at + 1))
  done
  if [ "$cmd_at" -ge "$m" ]; then
    [ "$any" -eq 1 ] && kind=assign
    return 0
  fi
  # A command word: the assignments ahead of it only prefix it.
  asg=0
  val=''
  case "${words[cmd_at]}" in
    export|readonly|local|declare|typeset)
      kind=builtin
      while [ "$cmd_at" -lt "$m" ]; do
        w="${words[cmd_at]}"
        case "$w" in
          "$var="*) asg=1; val="${w#"$var="}" ;;
          "$var+="*) asg=1; val="+${w#"$var+="}" ;;
        esac
        cmd_at=$((cmd_at + 1))
      done
      ;;
  esac
  return 0
}

# One command of _hook_syntax_assigns ends at $1, the operator after it ('' at
# the end of the line). Runs it as the success path does, and records an
# assignment of VAR it leaves in force.
_hook_syntax_assigns_cmd() {
  local after="$1" runs=1
  _hook_syntax_assigns_words
  words=()
  if [ "$prev" = '|' ]; then
    runs=$ran
  elif [ "$prev" = '||' ] && [ "$status" = ok ]; then
    runs=0
  fi
  ran=$runs
  if [ "$runs" -eq 1 ]; then
    ran_var=0
    status=other
    if [ "$prev" != '|' ] && [ "$after" != '|' ]; then
      if [ "$asg" -eq 1 ]; then
        lset=1
        lvalue="$val"
        ran_var=1
      fi
      [ "$kind" != other ] && [ "$neg" -eq 0 ] && status=ok
    fi
  fi
  case "$after" in
    '&&'|'||'|'|') prev="$after" ;;
    *)
      # The list ends. One sent to the background ran in a subshell.
      if [ "$after" != '&' ] && [ "$lset" -eq 1 ]; then
        set=1
        value="$lvalue"
      fi
      lset=0 prev='' ran=1 status=ok ran_var=0
      ;;
  esac
}

# One `bun "$VAR/<rel>"` in a shim. $1 = shim, $2 = VAR, $3 = rel, $4 = the
# line the call is on, $5 = 1 when a missing payload is a failure (sets
# HOOK_SYNTAX_FOLLOWED=1 when VAR names the shim's directory), $6 = the
# line's text before the call. VAR other than HERE is followed only when what
# it holds at the call is the shim's own directory, as the lines above leave
# it and then the text before the call on its own line, each read through
# _hook_syntax_assigns: `VAR="$(cd "$(dirname "$0")" && pwd)"`, with
# `pwd -P`, BASH_SOURCE, or a redirect on the cd (`2>/dev/null`,
# `>/dev/null 2>&1`). An assignment that goes on past the `)"`, such as
# `.../sub"`, or a later one before the call (`VAR="$VAR/lib"`) names
# somewhere else. Straight-line reading: a branch or a function body is not
# followed through.
_hook_syntax_payload() {
  local shim="$1" var="$2" rel="$3" at="$4" strict="$5" before="$6" dir payload hits ln n last=''
  local assign_re="(^|[^A-Za-z0-9_])$var\\+?="
  local own_re='^"\$\(cd "\$\(dirname "\$(0|\{BASH_SOURCE\[0\]\}|BASH_SOURCE)"\)"([[:space:]]+[0-9]*>&?[^[:space:]&;|]+)*[[:space:]]*&&[[:space:]]*pwd( -P)?\)"$'
  if [ "$var" != HERE ]; then
    # Read as text, with every line holding a NUL, as in _hook_syntax_payloads,
    # and through a command substitution, never read: /bin/bash 3.2's read
    # cuts a line at its first NUL, so `D="$(cd ... &&<NUL> pwd)"` named no
    # directory and `D="$(cd ... && pwd)"<NUL>/sub` named the shim's own.
    # _hook_syntax_assigns finds no assignment of VAR on a line without one.
    { hits=$(LC_ALL=C grep -anE "$assign_re|$HOOK_SYNTAX_NUL_RE" -- "$shim" 2>/dev/null); } 2>/dev/null
    _hook_syntax_lines "$hits"
    for ln in "${HOOK_SYNTAX_LIST[@]}"; do
      n="${ln%%:*}"
      if [ "$n" -lt "$at" ] && _hook_syntax_assigns "${ln#*:}" "$var"; then
        last="$HOOK_SYNTAX_VALUE"
      fi
    done
    case "$before" in
      *"$var="*|*"$var+="*)
        if _hook_syntax_assigns "$before" "$var" call; then
          last="$HOOK_SYNTAX_VALUE"
        fi
        ;;
    esac
    [ -n "$last" ] || return 0
    _hook_syntax_match "$last" "$own_re" || return 0
  fi
  HOOK_SYNTAX_FOLLOWED=1
  dir="${shim%/*}"
  [ "$dir" = "$shim" ] && dir='.'
  payload="$dir/$rel"
  # Entry points are tracked apart from the content-scan list: a file another
  # payload imported as a text asset is on that list unparsed, and must still
  # be parsed when a shim runs it.
  case "$HOOK_SYNTAX_ENTRIES" in
    *"$HOOK_SYNTAX_NL$payload$HOOK_SYNTAX_NL"*) return 0 ;;
  esac
  # A file that is not there, named by a call that need not have it, is not
  # recorded: a call that must have it, on a later line or in another shim,
  # is still judged, in whatever order the sweep reaches them.
  [ -r "$payload" ] || [ "$strict" -eq 1 ] || return 0
  HOOK_SYNTAX_ENTRIES="$HOOK_SYNTAX_ENTRIES$HOOK_SYNTAX_NL$payload$HOOK_SYNTAX_NL"
  if [ ! -r "$payload" ]; then
    printf 'hook-syntax: MISSING PAYLOAD %s — handed to bun by %s\n' "$payload" "$shim" >&2
    return 1
  fi
  _hook_syntax_check_bun "$payload"
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
      # The content scans (markers, carriage returns, the payloads it hands to
      # bun) need no interpreter, so they run whatever the probe says.
      HOOK_SYNTAX_PARSED+=("$file")
      HOOK_SYNTAX_SHELLS+=("$file")
      # Probed like python3 and bun: a PATH bash can be a version-manager shim
      # that fails every call, and `-n` under it says nothing about the file.
      if ! _hook_syntax_probe "$HOOK_SYNTAX_INTERP" -c :; then
        _hook_syntax_gap "$HOOK_SYNTAX_INTERP" "$file" 1
        return
      fi
      HOOK_SYNTAX_CHECKED=$((HOOK_SYNTAX_CHECKED + 1))
      if ! out=$("$HOOK_SYNTAX_INTERP" -n "$file" 2>&1); then
        printf 'hook-syntax: FAILS TO PARSE %s (%s -n)\n' "$file" "$HOOK_SYNTAX_INTERP" >&2
        printf '%s\n' "$out" >&2
        return 1
      fi
      ;;
    python)
      HOOK_SYNTAX_PARSED+=("$file")
      if ! _hook_syntax_probe "$HOOK_SYNTAX_PYTHON" -c pass; then
        _hook_syntax_gap "$HOOK_SYNTAX_PYTHON" "$file" 0
        return
      fi
      HOOK_SYNTAX_CHECKED=$((HOOK_SYNTAX_CHECKED + 1))
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
  # CDPATH is cleared for the cd: with it exported, cd prints the directory it
  # found, and the captured root would hold that line and pwd's.
  dir="$(CDPATH='' cd "$dir" 2>/dev/null && pwd -P)" || {
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
  # The list is read whole, in the C locale, before any file is visited: read
  # in a UTF-8 locale by bash 5.2, a name ending in an invalid UTF-8 byte took
  # the NUL after it, and the next name was lost.
  _hook_syntax_read_list '' < <(find "$dir" \( "${expr[@]:1}" \) -prune -o \( -type f -o -type d \) -print0 2>/dev/null | sort -z)
  for f in "${HOOK_SYNTAX_LIST[@]}"; do
    if [ -d "$f" ]; then
      if [ ! -r "$f" ] || [ ! -x "$f" ]; then
        printf 'hook-syntax: UNREADABLE directory %s — cannot check what is under it\n' "$f" >&2
        rc=1
      fi
      continue
    fi
    n=$((n + 1))
    _hook_syntax_visit "$f" || rc=1
  done
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
  # Judged on output, like the marker scan. Every scan here matches bytes, so
  # grep runs in the C locale: under a UTF-8 locale BSD grep misses a CR that
  # follows an invalid UTF-8 byte on the same line.
  hits=$(LC_ALL=C grep -l $'\r' -- "$@" 2>/dev/null)
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
  [ -n "$dir" ] || dir="$(CDPATH='' cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P)"
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
    _hook_syntax_walk "$(CDPATH='' cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd -P)" || _rc=1
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
