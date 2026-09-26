# fork-sync

Keeps a gstack install that carries its own commits current with upstream.
When the carried commits can't be moved onto upstream mechanically, it stops and tells a human.

## Why the built-in upgrade can't do this

`bin/gstack-update-check` compares against **upstream**
(`raw.githubusercontent.com/garrytan/gstack/main/VERSION`). The install step
in `gstack-upgrade` pulls **`origin main`**. On a fork, `origin` is the fork.
Its `main` is an ancestor of the working branch, so the pull says "Already up
to date" and nothing moves, while the check keeps firing. Before pulling,
that step also runs `git checkout -- '*/SKILL.md'`, which silently discards
any uncommitted skill edit in the live checkout.

`gstack-upgrade` Step 0 detects a fork install (an `upstream` remote plus this
directory). It hands off to this job and skips its own pull and discard.

## What a run does

1. **Preconditions.** `~/.claude/skills/gstack` must resolve to a main (not
   linked) worktree on a named branch, with `upstream` and `origin` remotes.
   The run defers when the 1-minute load is above 4× the core count, or when
   another free-suite run is in progress. It defers at most 3 runs in a row;
   after that it runs anyway, because a box that is always busy would
   otherwise never land. Isolated re-runs absorb the flakes that load causes.
2. **Fetch.** If the branch already contains `upstream/main`, the outcome is
   `UP_TO_DATE`.
3. **Rebase** the branch tip onto `upstream/main` in a throwaway detached
   worktree under `~/worktrees/<repo>/fork-sync-*`. Rebased commits keep
   their author and name `gstack fork-sync` as committer. Commits upstream
   already adopted drop out and are named. A conflict aborts the rebase and
   STOPS.
4. **Freshness.** `bun run gen:skill-docs --host all` must leave the tree
   clean, the same check CI runs. If it doesn't, the run STOPS; it never
   regenerates for you.
5. **Gate.** Both trees get built. The free suite then runs on the rebased
   tree and on pristine upstream, one after the other, with
   `--wall-timeout 3600`. Upstream's suite is not green on every machine, so
   the verdict is comparative. A failure counts only when all three hold:
   - it is ours alone,
   - it fails every isolated re-run on our side,
   - base passes that file in isolation, or doesn't have it.

   A test file our commits touch gets re-run in isolation even when both sides
   fail, so a red baseline cannot hide a regression there. Failures that nested
   fixture runs report under a random temp path compare by basename and are
   never isolated; the parent test that spawned them fails in its own right. A
   regression confirmed in isolation STOPS the run even when a shard wedged.
   An incomplete run with nothing confirmed is `INCONCLUSIVE`, and retries.
6. **Land.** These steps run in order:
   - Re-verify the live checkout: same branch, same tip, clean.
   - Push the old tip to `origin` as a `backup/fork-sync-*` ref, unless origin
     already has it.
   - Push the new branch `<stem>-<upstream version>`, for example
     `feat/pr-prep-skill-1.92.0`. This creates a new ref and is never forced.
   - Switch the live checkout to the new branch.
   - Run `./setup` and the version migrations.
   - Prove the suite starts: `gstack-skill-start` must print
     `SKILL_START_PROTO: 1`.

   Any failure after the switch rolls back to the old branch.

It never force-pushes, never resolves a conflict, never discards a local edit,
and never opens a PR or an issue.

## Commands

```bash
bun contrib/fork-sync/fork-sync.ts run --dry-run
```

```bash
bun contrib/fork-sync/fork-sync.ts run --no-land --branch <branch>
```

```bash
bun contrib/fork-sync/fork-sync.ts run
```

```bash
bun contrib/fork-sync/fork-sync.ts status
```

- `--dry-run` fetches and reports what a run would do. It writes nothing.
- `--no-land` rehearses the full rebase and gate on any branch without
  touching the live checkout, paging anyone, or recording a STOP.
- `--force` retries a pair that already stopped.
- `--ignore-load` runs on a busy box.

The schedule is a LaunchAgent (`com.gstack.fork-sync`). It fires at 02:47,
08:47, 14:47 and 20:47. `RunAtLoad` is false, so loading it never lands
anything. Install it from the **durable checkout's** copy, never a worktree,
because launchd would point into a directory that gets reaped:

```bash
bun ~/.claude/skills/gstack/contrib/fork-sync/fork-sync.ts install-agent --notify ~/src/personal/synapse/apps/cli/pipeline/iris-notify
```

`--print` renders the plist without installing it, and `uninstall-agent`
removes it. Alerts go through the `--notify` command (the synapse
`iris-notify` contract: `--title --body --key`, plus
`--remote --priority high --tags warning` when loud). Without `--notify`,
alerts fall back to an `osascript` banner.

## Outcomes

| Outcome | Exit | Pages? | What to do |
|---|---|---|---|
| `UP_TO_DATE`, `LANDED`, `REHEARSED`, `DRY_RUN` | 0 | a landing banner (loud if something was dropped) | nothing |
| `SKIPPED_BLOCKED` | 0 | no | the pair already stopped; see below |
| `DEFERRED_LOAD`, `DEFERRED_BUSY`, `DEFERRED_FETCH`, `INCONCLUSIVE`, `ABORTED_MOVED` | 2 | loud after 6 in a row | usually nothing; retries next slot |
| `BLOCKED_CONFLICT` | 3 | loud, once per pair | rekey the named commit by hand (below) |
| `BLOCKED_STALE` | 3 | loud, once per pair | regenerate and commit on the branch |
| `BLOCKED_REGRESSION` | 3 | loud, once per pair | the rebased tip is at `refs/fork-sync/attempt`; fix on the branch |
| `BLOCKED_DIRTY` | 3 | loud, once | commit or move the live checkout's changes |
| `BLOCKED_COLLISION` | 3 | loud, once | someone else is landing that version; switch to their branch or delete it |
| `BLOCKED_PUSH`, `BLOCKED_SWITCH`, `BLOCKED_PRECONDITION` | 3 | loud, once | read the message; nothing landed |
| `ROLLED_BACK` | 4 | loud | the new branch failed live; the old one is live and proven again |
| `ERROR` | 1 | loud | read `fork-sync.log` |

A STOP is remembered per (reason, upstream sha, branch tip). A deterministic
stop (conflict, stale docs, regression, rollback) is skipped until upstream or
the branch moves. A transient one (dirty tree, push, collision) retries every
run but pages only once.

## Clearing a conflict by hand

Rebase in a worktree, not the live checkout. Rekey each conflicting commit by
what it was *for*, not the lines it once changed. Push the result as the
landing branch name and switch the live checkout to it. The next run then
sees `UP_TO_DATE`. For generated `SKILL.md` conflicts, resolve the `.tmpl`
side and regenerate. Never pick a side of generated output.

## Files

- `~/.gstack/fork-sync/state.json` holds the last run, the last STOP, and
  history.
- `~/.gstack/fork-sync/fork-sync.log` is one line per event.
- `~/.gstack/fork-sync/runs/<stamp>/` holds `ours.log`, `base.log`,
  `isolate.log` and `setup-*.log`.
- `~/.gstack/fork-sync/launchd.log` holds the agent's stdout and stderr.
