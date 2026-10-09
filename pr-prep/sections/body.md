<!-- AUTO-GENERATED from body.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Mode: body (regenerate the PR description)

The description is the owner's template plus one facts block the helper
regenerates. Never hand-edit the live body and never patch it with search
and replace.

### 1. The template

If `<state dir>/body.tmpl.md` does not exist yet (render names that path
when it is missing), build it from the live body. Read the live body only
through the envelope:

```bash
~/.claude/skills/gstack/bin/gstack-issue-guard pr-body <pr-number> --repo <upstream-repo>
```

Then write the template with the Write tool. Keep the owner's prose and
images exactly. Replace every volatile line (head SHA, base, version,
merges, CI, test counts, "the head") with one `<!-- pr-prep:facts -->` marker, and drop
any line that states another PR's version claim.

### 2. Render

```bash
~/.claude/skills/gstack/bin/gstack-pr-body render --pr <pr-number> --repo <upstream-repo>
```

`RESULT REFUSED` (exit 20) with `LOST` lines: the new body would drop a
live screenshot or a ticked box. Put them in the template. With `LINT`
lines, fix the prose. With `FACTS` lines, move the template's
`<!-- pr-prep:facts -->` out of its Liveness proof section. Never publish
around a refusal.

### 3. Publish, with the owner's yes

Show the owner what changes, then AskUserQuestion, with
`<gstack-qid:pr-prep-body-publish>` in the question, naming the PR number and
the body's sha256 from render's `RESULT` line. On yes, publish that line's
`body=` file with its `sha256=`:

```bash
~/.claude/skills/gstack/bin/gstack-pr-body publish --pr <pr-number> --repo <upstream-repo> --body "<rendered file>" --body-sha256 <sha256 from render> --yes
```

A refusal that a flag can accept (`--accept-live-diff`,
`--accept-rewritten-stale`, `--confirm-redaction`) asks to send more than
the owner's yes saw. Ask again under the same
`<gstack-qid:pr-prep-body-publish>`, never an ad-hoc id, naming the
sha256 and the exact value the flag will carry, and re-run the publish
above with the flag added only on that yes.

- Exit 20 naming the body's sha256: the file is not the body the owner
  approved (it was re-rendered). Ask again with the new sha256.
- Exit 20 naming the facts block: it is not the one render generated for
  this head. Render again; never edit the facts block by hand.
- Exit 20 with `live-diff=<x>`: the live body is not the one last
  published here (an owner or maintainer edit, or the first publish over a
  hand-written body). Show the owner the enveloped diff and ask again
  (`<gstack-qid:pr-prep-body-publish>`, naming `live-diff=<x>`); only on
  that yes re-run with `--accept-live-diff <x>`. `<x>` pairs that live
  body with this rendered body: if either one changes, publish shows a new
  diff and a new value.
- Exit 30 from the pre-write gate (a latched P0 or unacknowledged P1, an
  UNVERIFIED poll, or a PR that is not open): the watch section says what
  to do. `RESULT PRECONDITION the pre-write gate ran ... before the edit`:
  run publish again.
- Exit 30 naming the PR head: a push landed after the render, so the
  facts describe an older head. Render again, show the owner, and ask
  again with the new sha256. A sync or `ci:` push marks the body stale
  (`body-stale-since=` on each RESULT line) until this publish clears it.
- Exit 30 saying the stale push is not in the PR head's history: the
  branch was rewritten after that push (a force-push, or GitHub's "Update
  branch" rebase), and sync push and retrigger stay refused until a
  publish. Find out what replaced the push, tell the owner, and ask again
  (`<gstack-qid:pr-prep-body-publish>`, naming that sha); only on that yes
  re-run publish with `--accept-rewritten-stale <sha>`, the sha the
  refusal printed.
- Exit 22: a redaction finding. HIGH blocks. Show the owner each MEDIUM
  finding and ask again (`<gstack-qid:pr-prep-body-publish>`, naming every
  MEDIUM key); only on that yes re-run with their keys in
  `--confirm-redaction <key,...>`. Versions the repo already published are
  not findings.
- Exit 40 (render or publish): the PR's head or base branch is gone from
  its remote, or kept moving during the fetch. Find out what moved, then
  render again.
- Exit 45: another pr-prep run holds this PR's lock. Wait for it, then
  run publish again.
- `RESULT ERROR ... read-back`: a concurrent edit replaced what was sent.
  The pre-publish body is saved beside the state. Tell the owner; do not
  re-publish automatically.

Each publish prints a reminder: tell the owner to close any open browser
edit of the description, because saving it overwrites this body and its
screenshot.
