<!-- AUTO-GENERATED from body.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Mode: body (regenerate the PR description)

The description is the owner's template plus one facts block the helper
regenerates. Never hand-edit the live body and never patch it with search
and replace.

### 1. The template

If `<state dir>/body.tmpl.md` does not exist yet, build it from the live
body. Read the live body only through the envelope:

```bash
~/.claude/skills/gstack/bin/gstack-issue-guard pr-body <number> --repo <upstream owner/name>
```

Then write the template with the Write tool. Keep the owner's prose and
images exactly. Replace every volatile line (head SHA, base, version,
merges, CI, test counts, "the head") with one `<!-- pr-prep:facts -->` marker, and drop
any line that states another PR's version claim.

### 2. Render

```bash
~/.claude/skills/gstack/bin/gstack-pr-body render --pr <number> --repo <upstream owner/name>
```

`RESULT REFUSED` with `LOST` lines: the new body would drop a live
screenshot or a ticked box. Put them in the template. With `LINT` lines,
fix the prose. Never publish around a refusal.

### 3. Publish, with the owner's yes

Show the owner what changes, then AskUserQuestion with the PR number and
the body's sha256 from render's `RESULT` line. On yes:

```bash
~/.claude/skills/gstack/bin/gstack-pr-body publish --pr <number> --repo <upstream owner/name> --body <rendered file> --body-sha256 <sha256 from render> --yes
```

- Exit 20 naming the body's sha256: the file is not the body the owner
  approved (it was re-rendered). Ask again with the new sha256.
- Exit 20 with `live-sha256=<x>`: the live body is not the one last
  published here (an owner or maintainer edit, or the first publish over a
  hand-written body). Show the owner the enveloped diff, and only after
  they accept it re-run with `--accept-live-diff <x>`. If the live body
  changes again, publish shows a new diff and a new sha256.
- Exit 22: a redaction finding. HIGH blocks. For each MEDIUM, show the
  owner the finding, and pass its key in `--confirm-redaction` only after
  their yes. Versions the repo already published are not findings.
- `RESULT ERROR ... read-back`: a concurrent edit replaced what was sent.
  The pre-publish body is saved beside the state. Tell the owner; do not
  re-publish automatically.

Each publish prints a reminder: tell the owner to close any open browser
edit of the description, because saving it overwrites this body and its
screenshot.
