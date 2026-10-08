<!-- AUTO-GENERATED from sync.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Mode: sync (an open upstream PR fell behind its base)

Run from the PR worktree, on the PR's head branch under its real name.
Every step is a helper; the judgement left to you is in the STOP lines.

### 1. Signals first

```bash
~/.claude/skills/gstack/bin/gstack-pr-watch poll --pr <number> --repo <upstream owner/name>
```

Exit 10 (P0: superseded, closed, absorbed) or 11 (P1: a maintainer spoke):
STOP. Show the owner the signal; the watch section says what to do. Exit 12
(UNVERIFIED): STOP, the PR's state is unknown.

### 2. Plan, then merge

```bash
~/.claude/skills/gstack/bin/gstack-pr-sync plan --pr <number> --repo <upstream owner/name>
```

- Exit 0: only release files or generated files conflict, which the merge
  resolves mechanically.
- Exit 10: up to date (`merge` still re-checks the version queue).
- Exit 20: a code or template conflict, so STOP and show the owner the
  paths; a hand resolution is the owner's call.

```bash
~/.claude/skills/gstack/bin/gstack-pr-sync merge --pr <number> --repo <upstream owner/name>
```

This merges upstream's base (never a rebase), takes upstream's release
files, puts our CHANGELOG entry on top of upstream's byte-identical entries,
re-versions through the merged tree's own `bin/gstack-next-version`, proves
the PR's code diff is unchanged, and commits in a scratch worktree
(`RESULT STAGED ... scratch=<dir>`). Exit 21 (`proof=CHANGED`): show the
owner the changed files before going on. Exit 60: the version queue could
not be read; never pick a version by hand.

### 3. Validate the exact commit

```bash
~/.claude/skills/gstack/bin/gstack-pr-validate run --pr <number> --repo <upstream owner/name>
```

It validates the staged scratch worktree after CI's own preconditions. RED:
read the summary it names. A failure is this sync's unless the same file
also fails on the base (run it there too) before you call it pre-existing.

### 4. Push, with the owner's yes

AskUserQuestion, with `<gstack-qid:pr-prep-sync-push>` in the question: PR
number, `<head remote> <head ref>`, old head -> staged SHA, the version
change, and the validation summary. On yes:

```bash
~/.claude/skills/gstack/bin/gstack-pr-sync push --pr <number> --repo <upstream owner/name> --yes
```

The push re-polls the watch, requires the green validation of that SHA,
refuses if the remote head moved, and pushes fast-forward only. Then the PR
body is stale: run the body mode now.
