# Hook parse gate (gstack) — what it covers, and the hole it does not close

Added 2026-08-27, the day an unparseable hook took every Claude Code session on
one machine down at once. This is the gstack arm of a gate that landed the same
day in two sibling repos that own the other hooks on that machine. None of the
three can gate the others' files.

## The incident

`~/.claude/hooks/secret-guard.sh` sat on disk mid-merge with unresolved conflict
markers at lines 771/795/819. It is wired as a **PreToolUse** hook, so every
Bash call in every session — a bare `echo` included — came back as:

```txt
PreToolUse:Bash hook error: [$HOME/.claude/hooks/secret-guard.sh]: line 771: syntax error near unexpected token `<<<'
```

Nothing detected it. A human noticed.

## Why gstack needs its own arm

`./setup` writes hook entries into `~/.claude/settings.json` pointing straight
at files in this repository, and the /careful, /freeze and /guard skills tell
users to wire two more by hand. Seven files, two of them PreToolUse:

| Wired path | Event | Wired by |
| --- | --- | --- |
| `hosts/claude/hooks/question-preference-hook` | **PreToolUse** | `./setup` (plan-tune) |
| `careful/bin/check-careful.sh` | **PreToolUse** | /careful, /guard skill docs |
| `freeze/bin/check-freeze.sh` | **PreToolUse** | /freeze, /guard, /investigate skill docs |
| `hosts/claude/hooks/question-log-hook` | PostToolUse | `./setup` (plan-tune) |
| `hosts/claude/hooks/auq-error-fallback-hook` | PostToolUse | `./setup` |
| `hosts/claude/hooks/timeline-stop-hook` | Stop | `./setup` |
| `bin/gstack-session-update` | SessionStart | `./setup` (team mode) |

Any of the three PreToolUse entries can take a machine down in exactly the way
`secret-guard.sh` did. `careful/bin/hook-extract.sh` is sourced by two of them,
so it carries the same blast radius without being wired itself.

**Every one of the four `hosts/claude/hooks/` entries is a bash shim that hands
a TypeScript file to bun**, and the payload is where the interesting failures
live:

```bash
HERE="$(cd "$(dirname "$0")" && pwd)"
exec bun "$HERE/question-preference-hook.ts"
```

`bash -n` on the shim proves the shim parses and says nothing about the file
that actually runs. A syntax error in the payload makes bun exit non-zero,
which under that shim's `set -e; exec` is a blocked PreToolUse call — the same
outage with a different first line. So the gate parses the payload too.

## What was built

`scripts/hook-syntax.sh` — one checker, two consumers.

| Consumer | Fires on | Verdict |
| --- | --- | --- |
| `test/hook-syntax.test.ts` | every `bun test` (the free suite, and CI's sharded `test:free`) | fails the suite (non-zero exit, names file and line) |
| `./setup` | any install, including the one `/gstack-upgrade` runs | **refuses** — nothing is created, linked, copied or registered |

Checks performed per file:

* `bash`/`sh` shebang → `bash -n` (parse only; it cannot see runtime faults)
* `python3` shebang → compiled in memory, no `.pyc` written
* a **bun payload** → `bun build --target=bun`, which parses the entrypoint
  **and everything it imports**, in memory, writing nothing. That transitivity
  is why `hosts/claude/hooks/spawn-bin.ts`, `lib/is-conductor.ts` and
  `scripts/one-way-doors.ts` are covered: all four wired payloads reach them
* a **separate** conflict-marker scan, because a marker inside a heredoc body
  parses cleanly and is still a half-merged file. It scans only the three
  **labelled** markers — opening, diff3 base, closing — and requires the
  trailing ref name git always writes after each, so a bare run of seven
  characters in a comment or a doc is not a false positive. The middle `=`
  separator is deliberately not scanned: git writes it with no label, which
  makes it indistinguishable from a banner rule, and this repo draws plenty.
  Nothing is lost, because a real conflict writes all four
* anything else is **skipped**, and skipped is never counted as checked

Three design points worth stating:

* **The sweep keys on the SHEBANG, never on an extension.** In a sibling repo
  three of four wired hooks end in `.template`; an extension-keyed sweep missed
  all three and still reported green. Here the sweep reads the first line of
  every file in the tree and dispatches on that.
* **The bun payload is discovered from the shim's own content**, not guessed
  from `*.ts`. A renamed or extension-less payload cannot slip past, and a
  `.ts` nothing wired reaches is honestly reported as skipped rather than
  silently included. Comment lines are stripped first — this gate's own header
  quotes the shim shape, and matching that made it report a missing payload
  against itself. **If you are porting this arm to another repo, do not
  "simplify" it into a `*.ts` sweep.** The sibling arms have no bun arm at all
  because in those repos the wired hook IS the logic; gstack's wired hooks are
  shims, and keying on what each shim hands to bun is the whole distinction.
* **A missing checker is a refusal, not a warning.** Deleting
  `scripts/hook-syntax.sh` must not be a way past it. There is no legitimate
  shape where `setup` carries the gate block and the checker is absent — they
  ship in the same commit, so an older tag has neither — which makes a missing
  checker a partial or half-merged checkout, exactly the state the gate exists
  to catch.
* **The gate runs above every `mkdir`, `ln` and `cp` in `setup`.**
  `test/hook-syntax.test.ts` asserts that on refusal no `~/.claude`,
  `~/.gstack` or `~/.codex` exists — checked functionally, in an isolated
  `HOME`, not by reading the order of lines in `setup` — plus a static ordering
  assertion as a second line of defence.

**Silent on a healthy tree.** One passing assertion, no output. A gate that
chatters gets routed around, and then it protects nobody. Coverage is available
on request and never volunteered:

```bash
/bin/bash scripts/hook-syntax.sh --report
```

At the time of writing that prints `hook-syntax: 91 checked, 1898 skipped` —
87 shell/python files parsed plus the 4 bun payloads, over 1,989 files. A full
sweep is about 1.9 seconds.

## What it does NOT cover — read no wider claim into it

* **Scope is this repository's working tree**, minus `node_modules`, `.git`,
  `dist`, `.build`, `__pycache__` and `.venv`. `ios-qa/scripts/gen-accessors-tool/.build`
  is a real vendored SwiftPM checkout carrying its own `.sample` git hooks;
  those are pruned and are not gstack's to fix.
* **TypeScript and JavaScript are skipped unless something wired reaches them.**
  A `.ts` a shim hands to bun is parsed, and so is anything it imports.
  Everything else in `lib/`, `scripts/`, `browse/src/` and `test/` is skipped
  here — those are covered by `bun test` and the type checker, not by this gate.
* **Skipped files are not marker-scanned either.** The marker scan runs only on
  the kinds the gate parses, so a half-merged `.md`, `.json` or `.tmpl` is
  invisible here. Widening it would mean deciding what to do about
  documentation that legitimately shows a marker.
* **`bash -n` is a parse, not a lint and not a run.** A hook that parses and
  then misbehaves is out of scope; `test/hook-scripts.test.ts` is where the
  /careful and /freeze guards get their behaviour pinned.
* **There is no commit-time arm.** This repository's git hooks live in
  `.git/hooks/`, untracked, so there is nothing in the tree to wire. The free
  test suite and `./setup` carry the weight instead.
* **`bin/gstack-relink` is not gated**, because it only re-points SKILL.md
  symlinks — it never touches a hook or `settings.json`. If that changes, it
  needs the gate.
* **An absent `python3` or `bun` is reported as a coverage gap, not counted as
  a pass.**

## The hole that remains — a finding, not a fix

`git merge` writes conflict markers straight into the working tree, and for
hooks wired by path the working tree **is** the deployed hook. On the machine
this was found on, `settings.json` points at
`~/.claude/skills/gstack/hosts/claude/hooks/timeline-stop-hook`, which is a
separate clone of this repository, not a symlink into a dev checkout — but the
principle is identical: whichever checkout `settings.json` names, the outage
starts the moment a merge writes an unresolved file into it, before any commit,
before `./setup`, before any test run.

Closing that means changing how the **hook runner** treats a hook that will not
parse: failing OPEN (log it, skip that hook, continue) instead of failing every
tool call. That is a `settings.json` / Claude Code semantics change, not a
change in this repository, and it trades a safety guard silently not running
for the machine staying usable. **Recorded here as a finding for the owner to
decide; deliberately not implemented.**

Partial mitigations available today, none of them adopted here:

* land into the checkout `settings.json` points at from a scratch worktree and
  fast-forward, so the live tree never holds an unresolved conflict
* keep the merge window short, and run the checker before doing anything else

## How the deployed copy is refreshed

Worth stating plainly, because a fix committed here does not reach a wired hook
by itself. On the machine this was found on:

* `~/.claude/skills/gstack` is a **separate clone** of this repository, tracked
  by the dotfiles repo as a gitlink at `skills/gstack` (mode `160000`) with no
  `.gitmodules` entry — so `git submodule update` does not drive it. It is
  refreshed by pulling in that clone and re-running `./setup` there, which is
  what `/gstack-upgrade` does. The gitlink is pinned at a specific SHA and has
  to be re-pinned in the dotfiles repo afterwards, or the next dotfiles
  checkout drags the clone back to the old commit.
* `settings.json` names that clone's path, so the gate protects the live hook
  only once the clone is refreshed. Until then the gate protects the next
  install, not the running one — which is the same hole the finding above
  describes, seen from the other end.

## Running it by hand

```bash
/bin/bash scripts/hook-syntax.sh
```

Silent, exit 0 on a healthy tree. Any output means a file is genuinely broken;
the report names the file and the line. Targets may be named explicitly, and a
directory argument is swept rather than read as a file.

Spell `/bin/bash`, not a bare `bash`. A PATH-resolved `bash <path>` picks up
Homebrew bash 5.3 **and** bypasses the script's own `#!/bin/bash`, reopening the
heredoc deadlock `setup` already sets `BASH_COMPAT=50` to avoid.

## Mutation results

Eight named regressions were injected and every one was killed by a named test:

| Injected regression | Killed by |
| --- | --- |
| marker scan removed | `markers inside a heredoc body fail, though the file parses` (+5 more) |
| sweep made non-recursive | `descends into nested directories and names the file` (+4 more) |
| skipped counted as checked | `a TypeScript file no shim reaches is skipped, not counted as checked` |
| extension-keyed instead of shebang-keyed | `the sweep dispatches on the shebang, never on a file extension` (+5 more) |
| bun payload arm removed | `a broken payload fails through its shim, which parses fine on its own` (+5 more) |
| unlabelled `=` added to the marker scan | `the trailing label is what separates a conflict from a rule` |
| gate moved below the deploy step | `setup refuses a tree whose hook does not parse` (+2 more) |
| gate warns instead of refusing | `setup refuses a tree whose hook does not parse` |
| checker deleted so the gate cannot run | `setup refuses when the gate ITSELF is missing` |

Every mutation asserts that its own edit actually applied before the suite runs.
A mutant whose replace target never matched reads as "survived" and is a false
green about a false green.

## The other arms

Four repos own hooks wired in `~/.claude/settings.json`, and none can gate
another's files. As of 2026-08-27 all four have a `feature/hook-parse-gate`
branch: dotfiles-claude (`hooks/lib/hook-syntax.sh`), synapse
(`skills/lib/hook-syntax.sh`), claude-skills (`scripts/lib/hook-syntax.sh`) and
this one. The marker-scan pattern and the labelled-marker rationale are
deliberately identical across all four; the bun payload arm is unique to gstack
for the reason given above.
