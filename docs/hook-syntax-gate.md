# Hook parse gate — what it covers, and the hole it does not close

`scripts/hook-syntax.sh` refuses to let a gstack hook that does not parse reach
`~/.claude/settings.json`, and fails the free test suite if one exists in the
tree. This page says exactly what it checks, where it runs, and what it does
not protect.

## Why a parse error is an outage

Claude Code runs a hook by path, straight out of the checkout `./setup`
registered. A shell hook that does not parse exits **2** when bash reaches the
break, under `#!/bin/bash` and `#!/usr/bin/env bash` alike
(`test/hook-syntax.test.ts` measures it for every wired hook), and exit 2 is
the status Claude Code reads as "block". Per
the Claude Code hooks reference:

| Event | What exit 2 does |
| --- | --- |
| PreToolUse | blocks the tool call — every matching call, in every session |
| UserPromptSubmit | blocks the prompt, so it never reaches Claude |
| Stop | prevents Claude from stopping |
| PostToolUse | shows stderr to Claude after every matching call |
| SessionStart | shows stderr to the user |

The fail-open patterns some shims use (`|| true; exit 0`) do not help: bash
reads a file one command at a time and stops at the syntax error with exit 2,
so a fail-open line after the error never runs. The complete top-level
commands before the broken one have already run by then (bash reads a whole
`if`, function body or `;`-joined line before running any of it), so a broken
hook can leave side effects; and a shim whose
break sits after its `exec` line hands off and exits normally, never reaching
the error at all. Which broken file blocks and which slips through depends on
where the break falls, so the gate refuses every file that does not parse.

On 2026-08-27 a PreToolUse hook belonging to another repo sat on disk mid-merge,
with unresolved conflict markers, and every Bash call on the machine — a bare
`echo` included — came back as `syntax error near unexpected token`. Nothing
detected it; a person did.

## What gstack wires

`bin/gstack-settings-hook` keeps the registry (`KNOWN_HOOKS`) that `./setup` and
`gstack-memorable` register from, and skill frontmatter registers the rest while
the skill is active:

| Hook | Event | Registered by |
| --- | --- | --- |
| `hosts/claude/hooks/question-preference-hook` | **PreToolUse** | `./setup` (plan-tune) |
| `hosts/claude/hooks/question-log-hook` | PostToolUse | `./setup` (plan-tune) |
| `hosts/claude/hooks/auq-error-fallback-hook` | PostToolUse | `./setup` |
| `hosts/claude/hooks/timeline-stop-hook` | Stop | `./setup` |
| `hosts/claude/hooks/memorable-user-prompt-hook` | **UserPromptSubmit** | `gstack-memorable enable` |
| `bin/gstack-session-update` | SessionStart | `./setup --team` |
| `bin/gstack-verify-gate` | Stop | `gstack-verify-gate`, by hand |
| `careful/bin/check-careful.sh` | **PreToolUse** | /careful, /guard frontmatter |
| `freeze/bin/check-freeze.sh` | **PreToolUse** | /freeze, /guard, /investigate frontmatter |
| `autoplan/bin/phase-publication-hook` | **PreToolUse** | /autoplan frontmatter, injected when `SKILL.md` is generated |

`test/hook-syntax.test.ts` derives this list from those two sources rather than
typing it out, reading both a skill's template and its generated `SKILL.md`, so
a hook added to either is covered without editing the test.

## Where it runs

| Consumer | Fires on | Verdict |
| --- | --- | --- |
| `test/hook-syntax.test.ts` | every `bun run test`, and the required free-suite CI check | fails the suite, naming the file and line |
| `./setup` | every install, including the one `/gstack-upgrade` runs | **refuses**: nothing is sourced, built, created, linked or registered (only the CRLF heal below runs first; the read-only `./setup --status` exits before the gate and installs nothing) |
| `./setup`, before its migrations and hook registration | when `~/.claude/skills/gstack` resolves to a checkout other than the one setup runs from (a link to another checkout, or a real directory there, which setup never replaces), on a run that installs for Claude: only such a run registers or re-points a hook into that tree. On a run for another host, the one migration that registers a hook, v1.58.0.0 inside Conductor, names the checkout setup runs from, which the row above has already gated | **runs no migration and registers and re-points no hook** (one migration registers a hook itself; the next `./setup` runs them all), finishes the rest of the install, and exits 1 |

The setup block sits directly after `setup` resolves its own directory — above
the first `source`, the first `bun` call and the first `mkdir`/`ln`/`cp`. The
test pins that twice: functionally (a refusal leaves the scratch `HOME` empty)
and statically.

It runs the gate with `/bin/bash` when that exists, and otherwise with `$BASH`,
the bash already running `setup` (NixOS, FreeBSD and Guix have no `/bin/bash`).
It never falls back to a bare `PATH` bash first, which on macOS is Homebrew's
5.x and can deadlock writing a heredoc body. The gate exits only 0 or 1, and
`setup` reads the exit three ways:

| Gate exit | `setup` says | Means |
| --- | --- | --- |
| 0 | nothing | clean |
| 1 | "a file that does not parse, or one that is still half-merged" | the report above it names the file |
| anything else | "the hook parse gate could not run (… exited N …)" | nothing was checked: 126/127 when the interpreter could not exec it, 2 when an old bash in POSIX mode (`sh ./setup`) rejects its process substitution |

Each of the last two is a refusal.

**A missing checker is a refusal, not a warning.** The setup block and
`scripts/hook-syntax.sh` ship in the same commit, so an older checkout has
neither; a checkout with the block and without the checker is partial or
half-merged — the state the gate exists to catch. Deleting the checker is not a
way past it.

**Stale CRLF copies are healed first.** `.gitattributes` pins every tracked
shell script to LF, and `test/hook-syntax.test.ts` enumerates them, so a new
one cannot land unpinned. An install checked out on Windows with
`core.autocrlf=true` before those pins existed still holds CRLF copies, and
`git pull` never rewrites a file whose blob did not change. Just before the
gate, `setup` runs `scripts/heal-eol.sh`, which rewrites exactly those files:
tracked, LF in the index, `eol=lf` by attribute, CRLF in the working tree, a
shell shebang, not flagged assume-unchanged or skip-worktree, and no content
change. The bytes come from `git cat-file --filters`, read at the path's place
in the work tree, so a gstack vendored into another repository heals from its
own index entry. They go into a copy of the original, which keeps its mode (a
read-only script stays read-only), and replace the file with one `mv`, so
nothing is deleted first and a failure leaves the original as it was. It is the
one write the setup block makes before the gate's verdict.

## What it checks

The sweep reads the first line of every file in the tree (up to 512 characters,
and never past a run of NUL bytes, so a one-line data file or a binary costs no
more than a script) and dispatches on the **shebang**, never on an extension:

* **Shell** — `-n` under the interpreter the shebang names, because that is the
  one that runs it. `#!/bin/bash` is bash 3.2 on macOS and `#!/usr/bin/env bash`
  is whatever bash is first on `PATH`; `;;&` parses under one and not the other.
  `#!/bin/sh` goes to `/bin/sh`, which is dash on Debian and Ubuntu.
* **Python** — compiled in memory with `-W error::SyntaxWarning`, because an
  invalid escape sequence is only a warning without it. No `.pyc` is written.
* **bun payloads** — every hook in `hosts/claude/hooks/` is a bash shim that
  hands a TypeScript file to bun (`exec bun "$HERE/question-preference-hook.ts"`).
  `bash -n` on the shim says nothing about the file that runs, so each shell
  file is searched for the paths it hands to bun, and each one is bundled
  through Bun's build API with target `bun` and npm packages external (the
  bundle `bun build --target=bun --packages=external` makes): the entrypoint and
  every local file it imports, in memory. npm packages are deliberately left unresolved —
  `setup` runs the gate before its own `bun install`, and resolving them would
  refuse every fresh clone for a reason that is not syntax. A missing *local*
  import still fails. Every local file the build pulled in, as listed by the
  build's own metafile, is then marker-scanned from its own bytes and counted
  as checked. A marker inside a template literal or a comment of an imported
  module parses cleanly, and the sweep alone skips a `.ts` no shim names, so
  this is what catches it. The bundle's text is never scanned: bun re-prints an
  ordinary `"\n<<<<<<< "` string as a template literal with the marker at
  column 0. A bun whose build API has no metafile is reported as unable to
  list a payload's imports, and those files go unscanned.
* **Conflict markers** — scanned separately from parsing, because a marker
  inside a heredoc body, a quoted string or a template literal parses cleanly
  and is still a half-merged file. Only the three labelled markers are scanned,
  with the trailing label git always writes, so a bare run of seven characters
  in a comment is not a false positive. The unlabelled `=` separator is not
  scanned: it is indistinguishable from a banner rule, and a real conflict
  writes the labelled markers too.
* **Carriage returns** — a CR byte anywhere in a shell file is refused. `bash -n`
  accepts plenty of CRLF scripts, but bash keeps the `\r` on every line at run
  time: `exec bun "$HERE/x.ts"` names `x.ts\r`. A CRLF shebang is stripped
  before dispatch, so such a file is classified and refused, never skipped.
  Python reads CRLF source fine and is compiled as usual.
* **NUL bytes** — the conflict-marker scan and the search for bun payloads read
  every file as text (`grep -a`). Without that, BSD grep calls a file binary
  when its first 32 KiB hold a NUL and prints `Binary file X matches` in place
  of the lines, and GNU grep prints nothing on stdout, so a shim with one stray
  NUL had its payload go unbuilt and a file with one had its markers go
  unreported. bash still runs a script whose NUL sits past its first two lines,
  dropping the byte, and git merges a file as text, markers and all, while its
  first 8,000 bytes hold no NUL. A NUL on a matched line is dropped the same
  way, without the warning bash 4.4 and later would print about it. bash drops a
  NUL wherever it sits, inside `bun`, a variable's name or an own-directory
  value too, and no pattern matches across one, so the payload search and the
  own-directory lookup also take every line holding a NUL and read it with the
  NUL dropped. Neither reads a line through `read`: `/bin/bash` 3.2's read
  cuts a line at its first NUL and loses the rest of it. BusyBox grep ends a
  line at a NUL and numbers what follows as the next line, so there a line
  holding one is still misread.
* **Shebang-less shell libraries** — the one rule that reads a name. A file
  with no `#!` line at all whose name ends in `.sh` is parsed as bash: it is a
  sourced library, and `bin/gstack-egress-lib.sh`, sourced by the SessionStart
  hook, is one. A file with any shebang is dispatched on the shebang alone.
* **Everything else is skipped**, and skipped is never counted as checked.

An interpreter that is present but cannot run — an asdf, mise or pyenv shim
with no version selected, or the xcode-select `python3` stub — is a coverage
gap, not a parse failure. Each one is probed once per run before it is
trusted: `python3 -c pass`, `bun --version`, and `<shell> -c :` for every shell
a shebang names (`/bin/bash`, `/bin/sh`, a `PATH` bash or sh). A file handed to
one that fails is reported as `NOT checked` for its parse, and its content
scans (conflict markers, carriage returns, the payloads a shim hands to bun)
still run. One exit status is a refusal rather than a gap: a shell or bun whose
probe exits 2. Every hook run through it exits 2 as well, the status Claude
Code reads as "block".

The sweep itself fails rather than reading green when it could not look:

* a directory it cannot read or search, because everything under it would be
  invisible
* a sweep that found no file at all
* a path that does not exist

A symlinked root is resolved and swept through: the live install,
`~/.claude/skills/gstack`, is often a symlink.

Silent on a healthy tree. Coverage is printed only on request:

```bash
/bin/bash scripts/hook-syntax.sh --report
```

Measured 2026-10-04 on this tree (base v1.91.16.0): `hook-syntax: 153 checked,
2558 skipped`, the 153 including the 33 local files the seven bun payloads
import. A full sweep under `/bin/bash` took 16–24 seconds at a load average near
230; earlier the same day, with 118–133 checked, it took 5–9 seconds at
85–120. Each payload build takes 0.1–0.2 seconds; almost all the rest is the
per-file parses, one fork each, plus one probe per interpreter.

Every `setup` run pays for one sweep, and a run that installs for Claude pays
for a second when `~/.claude/skills/gstack` resolves to a different checkout.
`./setup --refresh-registered`, which `/gstack-upgrade` runs, re-runs `setup` once per
registered host, so an upgrade pays for 1+N sweeps. In three pairs of healthy
`./setup --host claude` runs on 2026-10-04 (load average 78–111), an install
took 10–12 seconds before the gate and 18–26 seconds with it. On v1.91.13, in
one load window, `setup-codex-scope.test.ts` went from 494 to 643 seconds, still
19 pass, 0 fail.

## What it does NOT cover — read no wider claim into it

* **Scope is the tree it is pointed at**, minus `node_modules`, `.git`, `dist`,
  `.build`, `__pycache__` and `.venv`.
* **Nested checkouts are not swept.** A directory holding its own `.git` —
  a worktree such as `.claude/worktrees/<name>`, or a clone — is another
  branch's files, and a conflict there must not refuse this install. `--report`
  counts them.
* **TypeScript and JavaScript no shim reaches are skipped.** The type checker
  and the test suite own those.
* **Skipped files are not marker-scanned.** A half-merged `.md`, `.json` or
  `.tmpl` is invisible here, unless a bun payload imports it.
* **A parse is not a run.** A hook that parses and then fails at runtime is out
  of scope.
* **A shim that reaches bun any other way** than `bun "$VAR/<path>"`, with
  `VAR` either `$HERE` or a variable whose last assignment before the call is
  the shim's own directory (`VAR="$(cd "$(dirname "$0")" && pwd)"`, as
  `/autoplan`'s `$_AUTOPLAN_HOOK_DIR` is), has its payload unchecked; the shim
  itself is still parsed. Each line is split into commands as bash splits it,
  quotes, `$(...)` and backquotes included, and an assignment counts once bash
  has run its command: `VAR="$VAR/lib"; exec bun ...` runs lib/'s payload.
  It does not count while the call sits inside its value
  (`VAR="$(bun "$VAR/x.ts")"`) or is a word of the command it prefixes
  (`VAR=x bun ...`), which bash expands before it assigns, nor ever when it
  only prefixes a command, sits in a pipeline or runs in the background, all
  of which leave the shim's `VAR` as it was. A call after `||` straight after
  an assignment runs only once that assignment failed. `$HERE` is taken to be
  the shim's directory however it is set, and the shim is read top to bottom:
  a branch, a `{ ...; }` group or a function body is not followed through, a
  command after `&&` or `||` is taken to run unless the `||` follows an
  assignment, and an assignment inside `(...)` or `$(...)` is not read.
* **An interpreter that is absent or cannot run** (`python3`, `bun`, a `PATH`
  bash) is reported as a coverage gap for the parse, never counted as a pass
  and never as a parse failure; the content scans still run. A shell or bun
  that exits 2 is refused.
* **There is no commit-time arm.** A repository's git hooks live in
  `.git/hooks/`, untracked, so there is nothing in the tree to wire. The free
  suite and `./setup` carry the weight.

## The hole that remains

Hooks are registered **by path**, so for a registered checkout the working tree
*is* the deployed hook. Whatever moves that tree changes every session's hooks
the moment it writes, before any test or `./setup` run can look:

* `git merge`, `git rebase` or `git stash pop` run by hand in the registered
  checkout write conflict markers straight into it — the 2026-08-27 shape.
* `/gstack-upgrade` pulls first and runs `./setup` second. A refusal there
  prints `SETUP_FAILED` with the previous commit, but the pulled tree is
  already the one `settings.json` points at.
* Team mode's `bin/gstack-session-update` pulls, then runs `./setup -q` with
  its output discarded. A refusal is logged as `SETUP_FAILED`; the pulled tree
  stays in place.
* Both updaters pull with `git pull --ff-only --autostash`. When a local edit
  to a tracked file conflicts with the incoming change, git (2.56, probed)
  exits 0, writes conflict markers into the file and keeps the edit in a stash
  entry. A hook edited locally can come out of a successful pull half-merged.

What keeps a broken hook out of the pulled tree in the first place is this
test running on every pull request in the required free-suite check — `setup`'s
refusal is the second line, and it guards the next install, not the running
one. Closing the hole for good means checking the **incoming** tree before it
is switched in: gate it in a throwaway worktree, then fast-forward the
registered checkout to the commit that passed. Gating the incoming commit
alone misses the autostash case above, so the job must also refuse a checkout
with local edits to tracked files, or reapply them in the throwaway worktree
and gate that result before the registered checkout moves: a gate run after
the edits land in the registered checkout finds markers that are already
live. Any job that moves a registered checkout should do that. The alternative — Claude Code failing open on a hook
that will not parse — is a change to the hook runner, not to this repository,
and trades a safety guard silently not running for the machine staying usable.

## Mutation results

Forty named regressions were injected into the checker, `setup`,
`scripts/heal-eol.sh` and `.gitattributes`, one at a time, against
`test/hook-syntax.test.ts`, on 2026-10-04 at this tree. Each edit was asserted
to have applied before the suite ran, because an edit that silently misses
reads as a survivor that proves nothing, and each file was restored byte for
byte afterwards. A regression in `setup` ran the whole file; every other one ran
it without the two real-setup canonical-tree cases, which take minutes each and
which only `setup` can change. The unmutated baseline passed the whole file,
152 cases. Thirty-nine are killed:

| Injected regression | Cases that fail |
| --- | --- |
| marker scan removed | 27 |
| sweep made non-recursive | 6 |
| skipped files counted as checked | 7 |
| dispatch keyed on extension instead of shebang | 62 |
| bun payload arm removed | 35 |
| unlabelled `=` added to the marker scan | 4 |
| every shell file parsed by one PATH bash | 2 |
| shebang-less `.sh` rule removed | 2 |
| npm packages resolved instead of left external | 1 |
| python SyntaxWarning no longer an error | 1 |
| `setup` warns instead of refusing | 2 |
| `setup` skips the gate when the checker is missing | 1 |
| gate moved below `setup`'s first source | 6 |
| interpreter probe removed (a shim that cannot run reads as a parse failure) | 8 |
| a sweep that found nothing allowed to pass | 2 |
| nested checkouts swept | 2 |
| glob characters in a nested-checkout path left unescaped | 1 |
| directory access check removed | 2 |
| carriage-return scan removed | 4 |
| CRLF shebang no longer stripped for dispatch | 4 |
| `setup` reads every non-zero gate exit as a parse failure | 2 |
| `setup` no longer heals CRLF copies before the gate | 1 |
| LF pin for the hook shims removed from `.gitattributes` | 1 |
| gate exits 3 instead of 1 | 72 |
| heal-eol rewrites any CRLF file, not only shell scripts | 1 |
| first-line read uncapped | 2 |
| first-line read keyed on newline on every bash (NUL bound removed) | 2 |
| a shell interpreter trusted on `command -v` alone | 3 |
| heal-eol's temp file created under `setup`'s umask | 1 |
| files a payload imports not marker-scanned | 3 |
| an extension-less payload left to the build's own rules | 2 |
| a bun that cannot list imports stays silent | 1 |
| a gap in the parse skips the content scans too | 1 |
| an interpreter that exits 2 treated as a gap | 2 |
| a payload followed only through `$HERE` | 4 |
| heal-eol reads index paths without the work-tree prefix | 1 |
| heal-eol leaves a read-only temp copy read-only | 1 |
| `setup` does not gate the canonical tree | 1 |
| `setup` exits 0 after refusing to register hooks | 1 |

The one survivor is equivalent, not a gap: deleting only the `exit 1` after
"the hook parse gate is missing" leaves `setup` to run the missing file, which
exits 127, and the "could not run" branch refuses instead. The row above where
`setup` skips the gate outright when the checker is missing is killed.

Two kills depend on the machine. The one-interpreter case needs a `/bin/bash`
older than 4, which is macOS, and the python case needs python 3.12 or later.
The NUL-bound case needs a bash 4 or newer, which is `/bin/bash` on Linux and a
`PATH` bash on most Macs. Elsewhere those cases pass without proving anything.

## Running it by hand

```bash
/bin/bash scripts/hook-syntax.sh
```

Silent, exit 0 on a healthy tree. Any output means a file is broken; the report
names the file and the line. Targets may be named explicitly, and a directory
argument is swept rather than read as a file:

```bash
/bin/bash scripts/hook-syntax.sh hosts/claude/hooks bin/gstack-session-update
```

Spell `/bin/bash`, not a bare `bash`: a `PATH` bash on macOS is Homebrew's 5.x,
which can deadlock writing a heredoc body — the reason `setup` sets
`BASH_COMPAT=50`.
