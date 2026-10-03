# Hook parse gate — what it covers, and the hole it does not close

`scripts/hook-syntax.sh` refuses to let a gstack hook that does not parse reach
`~/.claude/settings.json`, and fails the free test suite if one exists in the
tree. This page says exactly what it checks, where it runs, and what it does
not protect.

## Why a parse error is an outage

Claude Code runs a hook by path, straight out of the checkout `./setup`
registered. A shell hook that does not parse exits **2**, under `#!/bin/bash`
and `#!/usr/bin/env bash` alike (`test/hook-syntax.test.ts` measures it for
every wired hook), and exit 2 is the status Claude Code reads as "block". Per
the Claude Code hooks reference:

| Event | What exit 2 does |
| --- | --- |
| PreToolUse | blocks the tool call — every matching call, in every session |
| UserPromptSubmit | blocks the prompt, so it never reaches Claude |
| Stop | prevents Claude from stopping |
| PostToolUse | shows stderr to Claude after every matching call |
| SessionStart | shows stderr to the user |

The fail-open patterns some shims use (`|| true; exit 0`) do not help: bash
never reaches them, because it refuses the whole file before running a line.

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

`test/hook-syntax.test.ts` derives this list from those two sources rather than
typing it out, so a hook added to either is covered without editing the test.

## Where it runs

| Consumer | Fires on | Verdict |
| --- | --- | --- |
| `test/hook-syntax.test.ts` | every `bun run test`, and the required free-suite CI check | fails the suite, naming the file and line |
| `./setup` | every install, including the one `/gstack-upgrade` runs | **refuses**: nothing is sourced, run, created, linked or registered |

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
change. The bytes come from `git cat-file --filters` and replace the file with
one `mv`, so nothing is deleted first and a failure leaves the original as it
was. It is the one write the setup block makes before the gate's verdict.

## What it checks

The sweep reads the first line of every file in the tree (up to 512 characters,
so a one-line data file costs no more than a script) and dispatches on the
**shebang**, never on an extension:

* **Shell** — `-n` under the interpreter the shebang names, because that is the
  one that runs it. `#!/bin/bash` is bash 3.2 on macOS and `#!/usr/bin/env bash`
  is whatever bash is first on `PATH`; `;;&` parses under one and not the other.
  `#!/bin/sh` goes to `/bin/sh`, which is dash on Debian and Ubuntu.
* **Python** — compiled in memory with `-W error::SyntaxWarning`, because an
  invalid escape sequence is only a warning without it. No `.pyc` is written.
* **bun payloads** — every hook in `hosts/claude/hooks/` is a bash shim that
  hands a TypeScript file to bun (`exec bun "$HERE/question-preference-hook.ts"`).
  `bash -n` on the shim says nothing about the file that runs, so each shell
  file is searched for the paths it hands to bun, and each one is parsed with
  `bun build --target=bun --packages=external`: the entrypoint and every local
  file it imports, in memory. npm packages are deliberately left unresolved —
  `setup` runs the gate before its own `bun install`, and resolving them would
  refuse every fresh clone for a reason that is not syntax. A missing *local*
  import still fails.
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
* **Shebang-less shell libraries** — the one rule that reads a name. A file
  with no `#!` line at all whose name ends in `.sh` is parsed as bash: it is a
  sourced library, and `bin/gstack-egress-lib.sh`, sourced by the SessionStart
  hook, is one. A file with any shebang is dispatched on the shebang alone.
* **Everything else is skipped**, and skipped is never counted as checked.

An interpreter that is present but cannot run — an asdf, mise or pyenv shim
with no version selected, or the xcode-select `python3` stub — is a coverage
gap, not a parse failure. `python3 -c pass` and `bun --version` are probed once
per run, and a file handed to one that fails is reported as `NOT checked`.

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

Measured 2026-10-03: on upstream v1.91.13 that printed `hook-syntax: 115
checked, 2687 skipped`, and a full sweep took 23 seconds of wall clock at a
load average of 175. The per-file pass forks once (the parse), and every
content scan runs once per sweep. Every `setup` run pays for one sweep, 8–14
seconds at a load average near 150, almost all of it the per-file parses. That
adds up in tests that run `setup` repeatedly: `setup-codex-scope.test.ts` went
from 494 to 643 seconds in the same load window, still 19 pass, 0 fail.

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
  `.tmpl` is invisible here.
* **A parse is not a run.** A hook that parses and then fails at runtime is out
  of scope.
* **A shim that reaches bun any other way** than `bun "$HERE/<path>"` has its
  payload unchecked; the shim itself is still parsed.
* **An absent interpreter** (`python3`, `bun`, a `PATH` bash) is reported as a
  coverage gap, never counted as a pass.
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

What keeps a broken hook out of the pulled tree in the first place is this
test running on every pull request in the required free-suite check — `setup`'s
refusal is the second line, and it guards the next install, not the running
one. Closing the hole for good means checking the **incoming** tree before it
is switched in: gate it in a throwaway worktree, then fast-forward the
registered checkout to the commit that passed. Any job that moves a registered
checkout should do that. The alternative — Claude Code failing open on a hook
that will not parse — is a change to the hook runner, not to this repository,
and trades a safety guard silently not running for the machine staying usable.

## Mutation results

Twenty-five named regressions were injected into the checker, `setup`,
`scripts/heal-eol.sh` and `.gitattributes`, one at a time, against the whole
of `test/hook-syntax.test.ts`. Each edit was asserted to have applied before the
suite ran, because an edit that silently misses reads as a survivor that proves
nothing. All twenty-five are killed:

| Injected regression | Cases that fail |
| --- | --- |
| marker scan removed | 20 |
| sweep made non-recursive | 6 |
| skipped files counted as checked | 5 |
| dispatch keyed on extension instead of shebang | 52 |
| bun payload arm removed | 23 |
| unlabelled `=` added to the marker scan | 3 |
| every shell file parsed by one PATH bash | 1 |
| shebang-less `.sh` rule removed | 2 |
| npm packages resolved instead of left external | 1 |
| python SyntaxWarning no longer an error | 1 |
| `setup` warns instead of refusing | 2 |
| `setup` tolerates a missing checker | 1 |
| gate moved below `setup`'s first write | 6 |
| interpreter probe removed (a shim that cannot run reads as a parse failure) | 2 |
| a sweep that found nothing allowed to pass | 2 |
| nested checkouts swept | 2 |
| glob characters in a nested-checkout path left unescaped | 1 |
| directory access check removed | 2 |
| carriage-return scan removed | 3 |
| CRLF shebang no longer stripped for dispatch | 3 |
| `setup` reads every non-zero gate exit as a parse failure | 2 |
| `setup` no longer heals CRLF copies before the gate | 1 |
| LF pin for the hook shims removed from `.gitattributes` | 1 |
| gate exits 3 instead of 1 | 33 |
| heal-eol rewrites any CRLF file, not only shell scripts | 1 |

`setup` warns instead of refusing survived a first pass: in a minimal fixture
tree, `setup` died one line after the gate anyway. The fixture now carries a stub
for the first tree code `setup` runs after the gate, and every refusal case
asserts the stub was never reached.

Two kills depend on the machine. The one-interpreter case needs a `/bin/bash`
older than 4, which is macOS, and the python case needs python 3.12 or later.
Elsewhere those cases pass without proving anything, so those two mutants would
survive.

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
