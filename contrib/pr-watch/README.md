# pr-watch LaunchAgent (opt-in)

Polls every upstream PR you enabled with `gstack-pr-watch enable` every
30 minutes and raises a macOS notification while a P0 (superseded, closed
unmerged, absorbed upstream) or P1 (a maintainer comment or review, a merge
conflict) signal waits for you. It exists because on #3032 a maintainer
bot's "the fix wave rewrote this" comment arrived during a usage-limit gap
and sat unanswered for 3 h 17 min before the PR was closed.

A watch that fails twice in a row (it could not verify the PR, or the PR's
worktree is gone) also notifies, then about once a day while it keeps
failing, so a dead watch never looks like a quiet one.

What it touches: GitHub is only read (REST GETs, `gh pr list`). In the
PR's worktree, git fetches the base branch, and the PR head only when the
worktree lacks its commit, into the private `refs/pr-prep/` namespace. It
writes the signals it latches into the PR's `state.json` under
`~/.gstack/projects/` (that is what makes every pr-prep write wait for your
ack), a log line per PR, and a per-PR failure count under
`~/.gstack/analytics/`. A notification names only the PR number and the
signal class or exit code, never comment text. Nothing is installed for
you; you run the commands below.

## Enable a PR

Run from the PR's worktree:

```bash
~/.claude/skills/gstack/bin/gstack-pr-watch enable --pr <number> --repo <owner/name>
```

`disable` with the same arguments stops it. After reading a signal,
acknowledge it at the level the poll showed you (its NEXT line spells
each one as `<id>@<level>`), so the notifications and the write gate
stop. An ack refuses a signal that has risen since; poll again first.

```bash
~/.claude/skills/gstack/bin/gstack-pr-watch ack --pr <number> --repo <owner/name> <signal id>@<level>
```

## Install

The runner needs `bun`, `gh` and `jq` on the PATH the plist sets. This
writes the plist with your paths and loads it:

```bash
sed -e "s|@RUNNER@|$HOME/.claude/skills/gstack/contrib/pr-watch/pr-watch-runner.sh|" -e "s|@HOME@|$HOME|g" -e "s|@PATH@|$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin|" ~/.claude/skills/gstack/contrib/pr-watch/com.gstack.pr-watch.plist.template > ~/Library/LaunchAgents/com.gstack.pr-watch.plist
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.gstack.pr-watch.plist
```

Each run appends one line per PR to `~/.gstack/analytics/pr-watch.log`.

## Uninstall

```bash
launchctl bootout gui/$(id -u)/com.gstack.pr-watch
```

```bash
rm ~/Library/LaunchAgents/com.gstack.pr-watch.plist
```
