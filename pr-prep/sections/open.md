<!-- AUTO-GENERATED from open.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->
## Mode: open (before the upstream PR exists)

Opening a PR on someone else's repo is the owner's decision. This mode
prepares everything, then waits for an explicit instruction in chat that
names the branch ("open the PR for pr/hook-check-gaps"). A yes to anything
else is not that instruction.

### 1. The audit is fresh

Run the audit (no arguments) first if this branch has no report, or if the
report's `head` is not `git rev-parse HEAD`. Do not open over EXACT_DUP.

### 2. Size against what upstream merges

```bash
~/.claude/skills/gstack/bin/gstack-pr-watch size --repo <upstream-repo>
```

`RESULT GREEN|AMBER|RED` compares churn and files, release files
included, with contributor PRs among the last 200 merged (the static
2026-10-07 thresholds when fewer than 20). Commits are shown, not scored:
upstream squash-merges. Exit 30 (no remote for the repo) or 40 (its base
branch is gone): report it. On RED, ask the owner with AskUserQuestion
(`<gstack-qid:pr-prep-size-split>`) whether to split the branch first or
open as is: a 74-commit, +4632-line contributor PR read RED and was
rewritten upstream inside a 220-file maintainer wave. Never decide this
yourself.

### 3. The body template

Write `<state dir>/body.tmpl.md` with the Write tool (`gstack-pr-prep-commits
paths` prints the state dir's `audit.json`; the template goes beside it).
Use the upstream PR template's headings verbatim (read
`.github/PULL_REQUEST_TEMPLATE.md` from the pinned base). Put `<!-- pr-prep:facts -->`
where the current state belongs (usually under the live-evidence heading).
Keep head, base, version, merges, CI and test counts OUT of the prose: the
facts block owns them, and they go stale on every push. Never state another
PR's version claim.

In the liveness section write `Screenshot to follow from @<your login>.`
(`gh api user --jq .login`) and leave checklist box 1 unticked, unless the
login is the repo owner (owner exemption).

### 4. Open as a draft (only on the owner's explicit instruction)

The first body is the template with `<!-- pr-prep:facts -->` replaced by a
short "facts follow after the first push" line (`gstack-pr-body render`
needs the PR number). The title and body are free text, so they go into
files, never into a shell command:

```bash
_GT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.gstack/tmp"
mkdir -p "$_GT" && chmod 700 "$_GT" || { echo "Not sent: cannot create $_GT for the text file." >&2; exit 1; }
_EX=$(git rev-parse --git-path info/exclude 2>/dev/null) && mkdir -p "$(dirname "$_EX")" && { grep -qxF '/.gstack/tmp/' "$_EX" 2>/dev/null || echo '/.gstack/tmp/' >> "$_EX"; }
TITLE_FILE=$(mktemp "${_GT:?}/pr-title.XXXXXX") || { echo "Not sent: mktemp failed in $_GT." >&2; exit 1; }; echo "TITLE_FILE: $TITLE_FILE (name: ${TITLE_FILE##*/})"
BODY_FILE=$(mktemp "${_GT:?}/pr-body.XXXXXX") || { echo "Not sent: mktemp failed in $_GT." >&2; exit 1; }; echo "BODY_FILE: $BODY_FILE (name: ${BODY_FILE##*/})"
```

Write the text into each printed file with your file-write tool (Claude Code's Write tool needs a Read of the empty file first), exactly as it should appear. The text never goes into a shell command, heredoc or quoted argument. If a write fails or is refused, do not send: print the cause, the file path and the command below for sending by hand.

`gh pr create --head` opens whatever the fork's branch holds, so first
check it is exactly the commit the audit and the size check measured
(substitute your login and the branch):

```bash
HEAD_SHA=$(git rev-parse HEAD)
FORK_SHA=$(git remote | while IFS= read -r r; do case "$(git remote get-url "$r" 2>/dev/null)" in (*[/:]<github-username>/*) git ls-remote "$r" refs/heads/<branch-name> | cut -f1; break ;; esac; done)
if [ -n "$FORK_SHA" ] && [ "$FORK_SHA" = "$HEAD_SHA" ]; then echo "PR_PREP_OPEN_HEAD: $HEAD_SHA"; else echo "PR_PREP_OPEN_HEAD: MISMATCH local $HEAD_SHA, fork ${FORK_SHA:-absent}"; fi
```

On `MISMATCH` do not open: the branch was never pushed, or local history
changed after the push, so the PR would show commits nobody audited. The
owner pushes the branch; the agent never pushes it. If HEAD changed, run
steps 1 and 2 again.

Scan the exact bytes that will be sent (substitute the printed names):

```bash
TITLE_FILE="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.gstack/tmp/<title-file-name>"
BODY_FILE="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.gstack/tmp/<body-file-name>"
[ -s "$TITLE_FILE" ] && [ -s "$BODY_FILE" ] || { echo "Not sent: write the title and body files first." >&2; exit 1; }
~/.claude/skills/gstack/bin/gstack-redact --from-file "$BODY_FILE" --repo-visibility public --json; echo "BODY_SCAN: exit $?"
~/.claude/skills/gstack/bin/gstack-redact --from-file "$TITLE_FILE" --repo-visibility public --json; echo "TITLE_SCAN: exit $?"
```

Exit 0 on both: go on. Exit 2: show the owner each MEDIUM finding and
continue only on their yes to each. Exit 3 (HIGH), or anything else: never
send; fix the file and scan again. Never edit a file after its scan.

Then, in the turn the owner gives the open instruction, ask with
AskUserQuestion, with `<gstack-qid:pr-prep-open-pr>` in the question,
naming the upstream repo, `<github-username>:<branch-name>` at the
`PR_PREP_OPEN_HEAD` SHA, the base and the title. On yes, send the scanned
files:

```bash
TITLE_FILE="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.gstack/tmp/<title-file-name>"
BODY_FILE="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.gstack/tmp/<body-file-name>"
~/.claude/skills/gstack/bin/gstack-egress-receipt write --sink pr-prep --host github.com --class pr-create --payload-file "$BODY_FILE" --consent "user ran /pr-prep"
gh pr create --draft --repo <upstream-repo> --head <github-username>:<branch-name> --base <base> --title "$(cat "$TITLE_FILE")" --body-file "$BODY_FILE"
```

### 5. Hand the liveness step to the owner

Tell the owner, as a checklist:
1. Type `GSTACK PR` live into a real surface and screenshot it.
2. Attach it in the PR's Liveness proof section, tick box 1, delete the
   placeholder line.
3. Close any other open edit of the description first: GitHub keeps the
   last save, and an old tab overwrites the screenshot.
4. Mark the PR ready for review (`gh pr ready`) when they are satisfied.

Then verify with `/pr-prep liveness`. The agent never attaches, paints or
uploads a screenshot and never runs `gh pr ready`.

### 6. Keep watching

Offer the owner `gstack-pr-watch enable --pr <pr-number> --repo
<upstream-repo>` for this PR and the opt-in LaunchAgent in
`contrib/pr-watch/README.md` (the owner installs it).
