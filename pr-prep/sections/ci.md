<!-- AUTO-GENERATED from ci.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Mode: ci (a Windows Free Tests shard failed)

```bash
~/.claude/skills/gstack/bin/gstack-pr-ci-triage run --pr <number> --repo <upstream owner/name>
```

- `RESULT DRAFTED`: every failed shard is a known runner flake on the
  current head. Either a Bun abort (`GetQueuedCompletionStatusEx` with any
  error code, 735 and 6 seen so far, or GLib) as the shard log's last line,
  with no failing test and a clean log, or a hang whose shard passed in an
  earlier run that tested the same merged tree (head plus base) and files.
  The `ci:` message names the run, the shard and the evidence.
- `RESULT NO_DRAFT` with `BLAME`: a test failed. It is this PR's failure
  until the same file also fails on the base: run it on both with
  gstack-pr-validate (declare it first) before saying otherwise.
- `NO_DRAFT` for a stale run, a newer run, or missing evidence: wait for
  the newer run, or report what is missing.

A fork contributor cannot re-run upstream jobs, so the remedy is one empty
`ci:` commit. Ask the owner with AskUserQuestion, with
`<gstack-qid:pr-prep-ci-retrigger-push>` in the question: PR number, run,
shard, class, and the head the draft is bound to (`head` in the binding
file the RESULT line names). On yes:

```bash
~/.claude/skills/gstack/bin/gstack-pr-sync retrigger --pr <number> --repo <upstream owner/name> --message <drafted message file> --yes
```

retrigger refuses (exit 30) a draft that is not bound to the PR's current
head and newest Windows run, or whose bytes changed since triage. Never
edit or hand-write the draft: re-run triage and ask again. The new head
makes the PR body's facts stale, so run the body mode next.

For disclosure (never as clearance), the per-day flake counts across
upstream runs:

```bash
~/.claude/skills/gstack/bin/gstack-pr-ci-triage onset --repo <upstream owner/name>
```
