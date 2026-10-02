#!/usr/bin/env bun
/**
 * fork-sync — keep a gstack install that carries its own commits current with
 * upstream, and stop to ask a human whenever that cannot be done mechanically.
 *
 * WHY THIS EXISTS. gstack's built-in upgrade cannot upgrade a fork install.
 * The update CHECK reads upstream (bin/gstack-update-check), but the INSTALL
 * pulls `origin main` (gstack-upgrade/SKILL.md.tmpl Step 4). On a fork,
 * `origin` is the fork: its main is an ancestor of the working branch, so the
 * pull reports "Already up to date", nothing moves, and the check keeps firing.
 * That step also discards uncommitted SKILL.md edits in the live checkout
 * before it pulls. This job is the upgrade path for such an install, and the
 * inline flow defers to it (gstack-upgrade Step 0).
 *
 * WHAT ONE `run` DOES
 *   1. Preconditions. The live link must resolve to a main (not linked)
 *      worktree on a named branch, with `upstream` and `origin` remotes. On a
 *      saturated box, or while another free-suite run is going, it defers
 *      rather than gate.
 *   2. Fetch. If the branch already contains upstream/main: UP_TO_DATE.
 *   3. Rebase the branch tip onto upstream/main in a THROWAWAY detached
 *      worktree under ~/worktrees/<repo>/. The live checkout is untouched until
 *      step 6. A conflict aborts the rebase, notifies, and STOPS. Commits
 *      upstream already adopted drop out and are named.
 *   4. Freshness. Generated skill docs must match their templates, checked
 *      the way CI checks them. Stale output STOPS; it is never regenerated here.
 *   5. Gate. The free suite runs on the rebased tree AND on pristine upstream,
 *      sequentially, with an explicit wall timeout. Upstream's suite is not
 *      green on every machine, so the verdict is comparative. A failure counts
 *      only if it is ours alone and survives isolated re-runs: ours fails every
 *      attempt, while base passes one or lacks the file. A test file our
 *      commits touch is re-run in isolation even when both sides fail, so a
 *      red baseline cannot hide a regression in it. A comparative verdict is
 *      blind to a file that produced no line on EITHER side, so a shard that
 *      did not finish surrenders its whole planned set: those files are named
 *      in the verdict, and the ones our commits touch are re-run here and now
 *      rather than left unmeasured.
 *   6. Land. Re-verify the live checkout (same branch, same tip, clean), make
 *      sure the old tip is on origin, push the new branch (a NEW ref, never a
 *      force), switch the live checkout to it, run ./setup and the version
 *      migrations, prove the suite starts, and rebuild the gbrain render the
 *      installed skills serve (gstack-config gbrain-refresh). Any failure
 *      after the switch rolls back to the old branch.
 *
 * Hand landings on the durable checkout rebuild that render through git
 * hooks: `install-hooks` writes them, and `render-hook` is what they call.
 *
 * A STOP is remembered per (reason, upstream, tip), so a blocked pair notifies
 * once, not every run. Either side moving re-arms the attempt.
 *
 * It never force-pushes, never resolves a conflict, never discards a local
 * edit, and never opens a PR or an issue.
 *
 * Single file with no local imports on purpose: bun reads the whole module at
 * start, so a landing that rewrites this file cannot change a run in flight.
 *
 * Usage:
 *   bun contrib/fork-sync/fork-sync.ts run [--dry-run] [--no-land] [--force] [flags]
 *   bun contrib/fork-sync/fork-sync.ts status [--brief|--json]
 *   bun contrib/fork-sync/fork-sync.ts install-agent [--print] [--notify <path>]
 *   bun contrib/fork-sync/fork-sync.ts uninstall-agent
 *   bun contrib/fork-sync/fork-sync.ts install-hooks [--print] | uninstall-hooks
 */
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ─── Types ──────────────────────────────────────────────────────────────────

export type Outcome =
  | 'UP_TO_DATE' | 'LANDED' | 'REHEARSED' | 'DRY_RUN' | 'SKIPPED_BLOCKED'
  | 'DEFERRED_LOAD' | 'DEFERRED_BUSY' | 'DEFERRED_FETCH' | 'INCONCLUSIVE' | 'ABORTED_MOVED'
  | 'BLOCKED_PRECONDITION' | 'BLOCKED_DIRTY' | 'BLOCKED_CONFLICT' | 'BLOCKED_STALE'
  | 'BLOCKED_REGRESSION' | 'BLOCKED_COLLISION' | 'BLOCKED_PUSH' | 'BLOCKED_SWITCH'
  | 'ROLLED_BACK' | 'ERROR';

export interface Config {
  repo: string;
  liveLink: string;
  upstreamRemote: string;
  upstreamBranch: string;
  originRemote: string;
  worktreeRoot: string;
  stateDir: string;
  gstackStateDir: string;
  installCmd: string;
  freshnessCmd: string;
  buildCmd: string;
  suiteCmd: string;
  isolateCmd: string;
  setupCmd: string | null;
  proofCmd: string;
  proofExpect: string;
  /** Rebuilds the gbrain render the installed skills serve; must exit 0. */
  renderCmd: string;
  notifyCmd: string | null;
  maxLoad: number;
  /** Consecutive load deferrals allowed before a run proceeds anyway. */
  maxLoadDefers: number;
  ignoreLoad: boolean;
  suiteTimeoutMs: number;
  stepTimeoutMs: number;
  isolateTimeoutMs: number;
  isolateAttempts: number;
  noLand: boolean;
  dryRun: boolean;
  force: boolean;
  branch: string | null;
  onto: string | null;
  /** Local branch kept fast-forwarded to upstream ('' disables). */
  mirrorBranch: string;
  scheduled: boolean;
  deferNotifyAfter: number;
}

/**
 * What bun's terminal summary accounted for in one shard, as the runner's
 * abnormal line states it: `(summary: <reported>/<expected> files)`.
 * `reported` is null when there was no terminal summary at all — distinct from
 * a summary reporting zero files, which is a number.
 */
export interface ShardAccounting {
  reported: number[] | null;
  expected: number;
}

export interface SuiteResult {
  /** `file — test name` keys, from the runner epilogue's `  ✗ ` lines. */
  failures: Set<string>;
  failingFiles: Set<string>;
  crashed: Set<string>;
  unattributed: number;
  shardsSeen: Set<number>;
  shardTotal: number;
  /** Shards that died by signal, exited abnormally, or were truncated: their files did not all run. */
  abnormal: Set<number>;
  /** Shard -> the files it was TOLD to run, from the runner's `plan:` line. */
  plans: Map<number, string[]>;
  /** Shard -> the `(summary: N/M files)` accounting its abnormal line stated, when it stated one. */
  accounting: Map<number, ShardAccounting>;
  /** Shards whose epilogue said `timed-out`; the whole-suite wall sets `timedOut` instead. */
  timedOutShards: Set<number>;
  /** Shards whose output capture was incomplete: failure lines may be missing. */
  captureLost: Set<number>;
  timedOut: boolean;
  passedWhole: boolean;
}

/** Test files an incomplete run reached no verdict on, and why they cannot be named. */
export interface UnvouchedSet {
  /** Files in a shard that never finished, with no failure or crash line of their own. */
  files: string[];
  /** Shard numbers that did not finish. */
  shards: number[];
  /** Shards that did not finish AND never printed their plan: their files cannot be named. */
  unnamedShards: number[];
}

export interface GateVerdict {
  verdict: 'pass' | 'regression' | 'inconclusive';
  regressions: string[];
  flaky: string[];
  baseline: string[];
  /** Files the run never reached a verdict on. Named, not run: see judge(). */
  unrun: string[];
  /** Unrun files our commits touch that an isolated re-run then proved good. */
  vouched: string[];
  reasons: string[];
}

interface CommitInfo { sha: string; subject: string }

interface State {
  version: 1;
  lastRun?: Record<string, unknown>;
  rehearsal?: Record<string, unknown>;
  blocked?: { key: string; reason: string; at: string } | null;
  deferStreak?: number;
  history?: Array<{ at: string; outcome: Outcome; detail: string }>;
}

interface RunResult { outcome: Outcome; detail: string; exitCode: number }

const AGENT_LABEL = 'com.gstack.fork-sync';
const COMMITTER_NAME = 'gstack fork-sync';
const COMMITTER_EMAIL = 'fork-sync@localhost';
const SELF = path.resolve(import.meta.path);

// ─── Pure helpers (exported for tests) ──────────────────────────────────────

/** Single-quote a string for /bin/bash. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Fill `{name}` placeholders with shell-quoted values. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? shq(values[key]) : whole);
}

/**
 * The branch a landing creates. The fork's convention is `<stem>-<version>`
 * (feat/pr-prep-skill-1.89.1 carries our commits on upstream v1.89.1.0), so
 * the stem is the current branch minus any version suffix, and a trailing
 * `.0` fourth segment is dropped. When upstream moved without a VERSION bump,
 * the name would repeat the current branch, so the upstream sha disambiguates.
 */
export function landingBranchName(current: string, upstreamVersion: string, upstreamSha: string): string {
  const stem = current.replace(/-\d+(?:\.\d+){1,3}(?:-u[0-9a-f]{7,})?$/, '');
  const parts = upstreamVersion.trim().split('.');
  const tag = parts.length === 4 && parts[3] === '0' ? parts.slice(0, 3).join('.') : parts.join('.');
  const name = `${stem}-${tag}`;
  return name === current ? `${name}-u${upstreamSha.slice(0, 8)}` : name;
}

/** Numeric dotted-version compare (the `sort -V` the inline flow uses). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Subjects in `before` that no longer appear in `after` (multiset difference). */
export function droppedSubjects(before: string[], after: string[]): string[] {
  const left = new Map<string, number>();
  for (const s of after) left.set(s, (left.get(s) ?? 0) + 1);
  const dropped: string[] = [];
  for (const s of before) {
    const n = left.get(s) ?? 0;
    if (n > 0) left.set(s, n - 1);
    else dropped.push(s);
  }
  return dropped;
}

const FAIL_LINE = /^ {2}✗ (.+?) — (.+)$/;
/**
 * Tests that spawn nested bun test runs report the CHILD file, which lives in
 * a random temp dir (`private/var/folders/…/tmp/auq-parallel-free-KQFZsC/
 * registration.test.ts`). The random segment never matches across trees, so
 * those paths are normalised to `(nested)/<basename>` and never isolated: the
 * parent test that spawned them fails in its own right.
 */
const NESTED_PATH = /(^|\/)(private\/)?(var\/folders|tmp)\//;
export function normaliseTestPath(file: string): string {
  return NESTED_PATH.test(file) ? `(nested)/${file.split('/').pop()}` : file;
}
const CRASH_LINE = /^ {2}⚠ crashed\+retried: (.+)$/;
// `  ⚠ unhandled error between tests (around <file>)`, from the runner's epilogue.
// test-setup.ts turns a stray process.exit() into a thrown error, so a leaked
// shutdown no longer truncates the shard (which read INCONCLUSIVE): bun runs on,
// prints its full summary and exits 1. This line is then the only trace, and
// it must count as a failure or an ours-only one would let the gate pass.
const UNHANDLED_LINE = /^ {2}⚠ unhandled error between tests \(around (.+)\)$/;
const SHARD_LINE = /^\[test:free\] shard (\d+)\/(\d+): \d+ files, \d+s, (pass|fail|timed-out)$/;
// Printed by runFreeShard BEFORE the shard runs anything, so it survives a
// wedge: the set of files that shard was told to run.
const SHARD_PLAN = /^\[test:free\] shard (\d+)\/(\d+) plan:(.*)$/;
// The runner's own verdicts on a shard that did not run all its files:
// `failed with exit code signal|<n>` (1 is an ordinary test failure) and
// `exited 0 but … Treating as FAILED.` (a truncated run).
const SHARD_ABNORMAL = /^\[test:free\] shard (\d+)\/\d+ (?:failed with exit code (signal|\d+)|exited 0 but .*Treating as FAILED\.|output capture was incomplete .*Treating as FAILED\.)/;
// A shard whose stdout or stderr was lost may be missing failure lines, so its
// accounting cannot vouch for its files even when it counted all of them.
const SHARD_CAPTURE_LOST = /^\[test:free\] shard (\d+)\/\d+ output capture was incomplete /;
// The file accounting the runner states on EVERY abnormal shard line
// (`shardAccounting` in scripts/test-free-shards.ts): what bun's terminal
// summary reported over what the shard was told to run.
//
// This is what makes an abnormal verdict readable. The runner picks its
// `exited 0 but …` reason from an ORDERED list, so a shard with failing tests
// or an unhandled error reports "reported N failing test(s) and M unhandled
// error(s)" and never reaches the branches that speak about file counts —
// measured 2026-09-28, shard 4 of 6 (2123s, 178 files, 101 failing tests, a
// complete run that only got its exit code wrong) and shard 3 (118s, one
// unhandled error, a truncation) printed the same message. The accounting is
// the fact that separates them, so `unvouchedFiles` can surrender only the
// genuinely short shards.
//
// `none` is the absent-summary rendering, deliberately not `0`. An accounting
// that is missing, short, or in any way unparseable leaves the shard
// surrendered: a gate must not claim knowledge it lacks, and a parsing miss
// must never be the thing that vouches for a file.
const SHARD_ACCOUNTING = /^\[test:free\] shard (\d+)\/\d+ .*\(summary: (none|\d+(?:,\d+)*)\/(\d+) files\)$/;

/**
 * Parse the free runner's output (scripts/test-free-shards.ts). Each shard
 * prints `[test:free] shard i/N: … pass|fail|timed-out` and, when it failed,
 * an epilogue naming every failing test as `  ✗ <file> — <test>`.
 */
export function parseSuiteLog(text: string): SuiteResult {
  const result: SuiteResult = {
    failures: new Set(), failingFiles: new Set(), crashed: new Set(), unattributed: 0,
    shardsSeen: new Set(), shardTotal: 0, abnormal: new Set(), plans: new Map(),
    accounting: new Map(), timedOutShards: new Set(), captureLost: new Set(), timedOut: false, passedWhole: false,
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const fail = FAIL_LINE.exec(line);
    if (fail) {
      const file = normaliseTestPath(fail[1].trim());
      result.failures.add(`${file} — ${fail[2].trim()}`);
      if (file === '(unattributed)') result.unattributed += 1;
      else if (!file.startsWith('(nested)/')) result.failingFiles.add(file);
      continue;
    }
    const crash = CRASH_LINE.exec(line);
    if (crash) {
      const file = normaliseTestPath(crash[1].trim());
      if (!file.startsWith('(nested)/')) result.crashed.add(file);
      continue;
    }
    // Unattributed on purpose: "around" names the file bun was in when the error
    // surfaced, not the one that leaked it. An ours-only key makes the verdict
    // INCONCLUSIVE through oursOnlyUnattributed; one the base shares cancels out.
    const unhandled = UNHANDLED_LINE.exec(line);
    if (unhandled) {
      result.failures.add(`(unattributed) — unhandled error between tests (around ${normaliseTestPath(unhandled[1].trim())})`);
      result.unattributed += 1;
      continue;
    }
    // Recorded off ANY shard line carrying the token — the timeout line does
    // too — and does not consume the line: the abnormal match still runs.
    const acct = SHARD_ACCOUNTING.exec(line);
    if (acct) {
      result.accounting.set(Number(acct[1]), {
        reported: acct[2] === 'none' ? null : acct[2].split(',').map(Number),
        expected: Number(acct[3]),
      });
    }
    const lost = SHARD_CAPTURE_LOST.exec(line);
    if (lost) result.captureLost.add(Number(lost[1]));
    const abnormal = SHARD_ABNORMAL.exec(line);
    if (abnormal && abnormal[2] !== '1') { result.abnormal.add(Number(abnormal[1])); continue; }
    const plan = SHARD_PLAN.exec(line);
    if (plan) {
      result.plans.set(Number(plan[1]), plan[3].trim().split(/\s+/).filter(Boolean));
      result.shardTotal = Math.max(result.shardTotal, Number(plan[2]));
      continue;
    }
    const shard = SHARD_LINE.exec(line);
    if (shard) {
      result.shardsSeen.add(Number(shard[1]));
      result.shardTotal = Math.max(result.shardTotal, Number(shard[2]));
      if (shard[3] === 'timed-out') { result.timedOut = true; result.timedOutShards.add(Number(shard[1])); }
    }
  }
  return result;
}

/** A run is complete when every shard 1..N printed its epilogue line and none timed out. */
export function suiteComplete(r: SuiteResult): boolean {
  if (r.timedOut || r.shardTotal === 0 || r.abnormal.size > 0) return false;
  for (let i = 1; i <= r.shardTotal; i += 1) if (!r.shardsSeen.has(i)) return false;
  return true;
}

/**
 * Did this shard's stated accounting cover every file it was planned?
 *
 * False for every uncertainty, without exception: no accounting on the line
 * (an older runner, or a line cut short), no terminal summary at all
 * (`reported === null`), an accounting whose expected total disagrees with the
 * plan line it is paired with (one of the two is a log we do not understand,
 * so neither is trusted), no plan to compare against, or a reported count that
 * never reaches the planned one. The equality test mirrors
 * `strictTestExitCode`: ANY of bun's counts matching the planned total is the
 * evidence a shard passes on, nested runs' own summaries included.
 */
function fullyAccounted(a: ShardAccounting | undefined, plan: string[] | undefined): boolean {
  if (!a || a.reported === null || !plan) return false;
  if (a.expected !== plan.length) return false;
  return a.reported.includes(a.expected);
}

/**
 * The files an incomplete run reached no verdict on.
 *
 * `regressions=0` over a comparative diff of FAILURE LISTS silently excludes
 * every file that produced no line at all: a shard that dies before reaching
 * a file puts it in neither side's list, so it is in neither `regressions`
 * nor `baseline` and the verdict reads as "nothing broke" over a set that
 * quietly omits it. Measured 2026-09-27: shard 2 of 6 was truncated on both
 * trees and `test/ceo-mode-preference-al.test.ts` appeared in neither log,
 * while a direct run failed it.
 *
 * A shard is vouched for only by its own terminal summary, which the runner
 * requires to report EXACTLY the planned file count. So an unvouched shard
 * (never finished, timed out, or abnormal without a full accounting) leaks its
 * whole planned set, minus the files that did produce a failure or crash line
 * — those the comparative verdict and the isolated re-runs already cover in
 * their own right.
 *
 * An abnormal shard whose `(summary: N/M files)` accounting reached its full
 * planned count is the exception: that summary is the same evidence the runner
 * grades a PASSING shard on, so those files ran and are vouched for even
 * though the shard's verdict is abnormal. It does not make the RUN complete —
 * `suiteComplete` is untouched — it only stops naming files that did run.
 * Before this, the ambiguity of the runner's ordered reason list surrendered
 * 343 files across two shards of one measured run where ~178 were genuinely
 * unknown.
 */
export function unvouchedFiles(r: SuiteResult): UnvouchedSet {
  const shards: number[] = [];
  const unnamedShards: number[] = [];
  const files = new Set<string>();
  // The whole-suite wall can fire before any shard prints an epilogue, so a
  // shard with no epilogue at all counts as unvouched, not as absent.
  const total = Math.max(r.shardTotal, ...[0, ...r.plans.keys()]);
  for (let i = 1; i <= total; i += 1) {
    if (r.shardsSeen.has(i) && !r.abnormal.has(i) && !r.timedOutShards.has(i)) continue;
    // A wall-clock kill is excluded on purpose: the runner refuses to grade a
    // timed-out shard at all, and nothing here should grade it either.
    if (!r.timedOutShards.has(i) && !r.captureLost.has(i) && fullyAccounted(r.accounting.get(i), r.plans.get(i))) continue;
    shards.push(i);
    const plan = r.plans.get(i);
    if (!plan) { unnamedShards.push(i); continue; }
    for (const file of plan) {
      if (r.failingFiles.has(file) || r.crashed.has(file)) continue;
      files.add(file);
    }
  }
  return { files: [...files].sort(), shards, unnamedShards };
}

/**
 * Files that need an isolated verdict: failures or crashes only ours has,
 * plus any test file our commits touch that fails on ours at all.
 */
export function gateCandidates(ours: SuiteResult, base: SuiteResult, touchedTests: string[]): string[] {
  const files = new Set<string>();
  for (const key of ours.failures) {
    if (base.failures.has(key)) continue;
    const file = key.split(' — ')[0];
    if (file !== '(unattributed)' && !file.startsWith('(nested)/')) files.add(file);
  }
  for (const file of ours.crashed) if (!base.crashed.has(file)) files.add(file);
  for (const file of touchedTests) if (ours.failingFiles.has(file) || ours.crashed.has(file)) files.add(file);
  return [...files].sort();
}

/** How a path resolved: `real` is null when it could not be, with `why`. */
export interface Resolved { path: string; real: string | null; why: string }

/**
 * Classify a checkout from its git dir and common dir.
 *
 * The comparison used to be `realpathOrNull(a) !== realpathOrNull(b)`, which
 * swallowed the resolve error and compared null against a real path — so a
 * path that could not be STATTED was reported as a linked worktree. That is a
 * loud, memoised claim about the repository's layout that nothing had
 * established, and unfalsifiable afterwards because the fs error was gone.
 * Only a resolved mismatch is a linked worktree.
 */
export function worktreeKind(gitDir: string, commonDir: string, resolve: (p: string) => Resolved):
{ kind: 'main' | 'linked' | 'unresolved'; detail: string } {
  // One argument, explicitly: `.map(resolve)` would hand the resolver
  // (element, index, array), and a resolver with optional parameters takes
  // those as its own.
  const resolved = [gitDir, commonDir].map((p) => resolve(p));
  const unresolved = resolved.filter((r) => r.real === null);
  if (unresolved.length > 0) {
    return { kind: 'unresolved', detail: unresolved.map((r) => `${r.path} (${r.why})`).join('; ') };
  }
  if (resolved[0].real !== resolved[1].real) return { kind: 'linked', detail: `${resolved[0].real} != ${resolved[1].real}` };
  return { kind: 'main', detail: resolved[0].real ?? '' };
}

/**
 * Whether two paths are the same place, keeping an unresolvable path
 * distinguishable from a genuine mismatch. This is the swallow `worktreeKind`
 * was extracted to kill, in the live-link comparisons it survived in:
 * `realpathOrNull(a) !== realpathOrNull(b)` reads ONE unresolvable path as a
 * mismatch, and BOTH unresolvable as a match — the second direction vouching
 * for a pairing nothing could stat, which is the worse of the two.
 */
export function samePath(a: string, b: string, resolve: (p: string) => Resolved):
{ same: boolean | null; detail: string } {
  // One argument, explicitly: see `worktreeKind`.
  const r = [a, b].map((p) => resolve(p));
  const unresolved = r.filter((x) => x.real === null);
  if (unresolved.length > 0) {
    return { same: null, detail: unresolved.map((x) => `${x.path} (${x.why})`).join('; ') };
  }
  return { same: r[0].real === r[1].real, detail: `${r[0].real} vs ${r[1].real}` };
}

/** fs error codes that describe a passing shortage, not a path that is wrong. */
const TRANSIENT_RESOLVE = new Set(['EMFILE', 'ENFILE', 'EAGAIN', 'EINTR', 'EIO']);

/** A synchronous pause: every caller on this path is synchronous. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * `worktreeKind`'s resolver over the real filesystem, retrying a shortage.
 *
 * realpath needs a file descriptor. Measured on this box (macOS 25.6,
 * 2026-09-28): `fs.realpathSync` on a path that EXISTS throws
 * `EMFILE: too many open files, lstat <path>` once the process is out of
 * descriptors, while `statSync` on the same path still succeeds. And in a main
 * checkout the two paths the precondition compares are the IDENTICAL string
 * (`rev-parse --absolute-git-dir` and `path.resolve(repo, --git-common-dir)`,
 * measured byte-identical), so the 2026-09-27 `linked worktree` STOP was only
 * reachable if one of two resolves OF ONE STRING failed under a competing
 * suite's descriptor pressure.
 *
 * `worktreeKind` no longer mislabels that as a layout fact, but a run still
 * STOPPED on it, and the STOP is memoised until upstream or the tip moves — so
 * a shortage lasting milliseconds parked the fork. Retry the transient codes;
 * answer a path that is genuinely wrong at once, so a real negative is never
 * slowed by a retry it cannot benefit from.
 */
export function fsResolve(
  p: string,
  realpath: (q: string) => string = fs.realpathSync,
  attempts = 3,
  sleep: (ms: number) => void = sleepSync,
): Resolved {
  let why = '';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return { path: p, real: realpath(p), why: '' }; }
    catch (err) {
      const e = err as NodeJS.ErrnoException;
      why = e.message;
      if (!TRANSIENT_RESOLVE.has(e.code ?? '')) break;
      if (attempt < attempts - 1) sleep(50 * (attempt + 1));
    }
  }
  return { path: p, real: null, why };
}

/** Ours-only unattributed failures cannot be isolated to a file. */
export function oursOnlyUnattributed(ours: SuiteResult, base: SuiteResult): number {
  let n = 0;
  for (const key of ours.failures) if (key.startsWith('(unattributed) — ') && !base.failures.has(key)) n += 1;
  return n;
}

// ─── Process helpers ────────────────────────────────────────────────────────

interface Sh { code: number; stdout: string; stderr: string }

/** How a git invocation failed, for a message that must not assert a repo fact. */
function shWhy(r: Sh): string {
  return `git exited ${r.code}${r.stderr ? `: ${r.stderr}` : ''}${r.stdout ? `, said "${r.stdout}"` : ''}`;
}

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Sh {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd, env: opts.env ?? process.env, encoding: 'utf8',
    timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024,
  });
  // trimEnd, not trim: porcelain output starts with a status column that may be a space.
  return { code: r.status ?? (r.error ? 127 : 1), stdout: (r.stdout ?? '').trimEnd(), stderr: (r.stderr ?? '').trim() };
}

// GSTACK_SKIP_RENDER_HOOK: this job's own switches and rebases must not fire
// the render hooks. A landing refreshes the render once, explicitly, in verify.
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no', GSTACK_SKIP_RENDER_HOOK: '1',
};

function git(cwd: string, ...args: string[]): Sh {
  return sh('git', args, { cwd, env: GIT_ENV, timeoutMs: 600_000 });
}

function gitOk(cwd: string, ...args: string[]): string {
  const r = git(cwd, ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/**
 * Run a configured shell command with output appended to `logFile`. Own
 * process group, so a timeout kills the whole tree (the free runner's shards
 * included), not just the shell.
 */
async function runLogged(cmd: string, cwd: string, logFile: string, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number; timedOut: boolean }> {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, `\n$ ${cmd}\n`);
  return await new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-c', `( ${cmd} ) >>"$FORK_SYNC_LOG" 2>&1`], {
      cwd, env: { ...env, FORK_SYNC_LOG: logFile }, stdio: 'ignore', detached: true,
    });
    let timedOut = false;
    let killer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-(child.pid as number), 'SIGTERM'); } catch { /* group already gone */ }
      killer = setTimeout(() => {
        try { process.kill(-(child.pid as number), 'SIGKILL'); } catch { /* group already gone */ }
      }, 10_000);
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (killer) clearTimeout(killer);
      resolve({ code: code ?? 1, timedOut });
    });
    child.on('error', () => { clearTimeout(timer); resolve({ code: 127, timedOut }); });
  });
}

function realpathOrNull(p: string): string | null {
  try { return fs.realpathSync(p); } catch { return null; }
}

function localStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// ─── Config ─────────────────────────────────────────────────────────────────

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.HOME ?? os.homedir();
  const liveLink = path.join(home, '.claude', 'skills', 'gstack');
  const repo = realpathOrNull(liveLink) ?? liveLink;
  const gstackStateDir = env.GSTACK_STATE_DIR ?? path.join(home, '.gstack');
  const cpus = os.availableParallelism?.() ?? os.cpus().length;
  return {
    repo,
    liveLink,
    upstreamRemote: 'upstream',
    upstreamBranch: 'main',
    originRemote: 'origin',
    worktreeRoot: path.join(home, 'worktrees', path.basename(repo)),
    stateDir: path.join(gstackStateDir, 'fork-sync'),
    gstackStateDir,
    installCmd: 'bun install --frozen-lockfile',
    freshnessCmd: 'bun run gen:skill-docs --host all',
    buildCmd: 'bun run build',
    suiteCmd: 'bun run scripts/test-free-shards.ts --wall-timeout 3600',
    isolateCmd: 'bun test {path} --timeout=30000 --max-concurrency=1',
    setupCmd: null,
    proofCmd: '{live}/bin/gstack-skill-start --skill sync-gbrain --model claude --parent-pid {pid}',
    proofExpect: 'SKILL_START_PROTO: 1',
    renderCmd: '{live}/bin/gstack-config gbrain-refresh',
    notifyCmd: env.FORK_SYNC_NOTIFY || null,
    maxLoad: env.FORK_SYNC_MAX_LOAD ? Number(env.FORK_SYNC_MAX_LOAD) : cpus * 4,
    maxLoadDefers: 3,
    ignoreLoad: false,
    suiteTimeoutMs: 3 * 60 * 60_000,
    stepTimeoutMs: 20 * 60_000,
    isolateTimeoutMs: 10 * 60_000,
    isolateAttempts: 2,
    noLand: false,
    dryRun: false,
    force: false,
    branch: null,
    onto: null,
    mirrorBranch: 'main',
    scheduled: false,
    deferNotifyAfter: 6,
  };
}

export function parseArgs(argv: string[], base: Config = defaultConfig()): Config {
  const cfg = { ...base };
  let repoGiven = false;
  const str: Record<string, keyof Config> = {
    '--repo': 'repo', '--live-link': 'liveLink', '--upstream-remote': 'upstreamRemote',
    '--upstream-branch': 'upstreamBranch', '--origin-remote': 'originRemote',
    '--worktree-root': 'worktreeRoot', '--state-dir': 'stateDir', '--gstack-state-dir': 'gstackStateDir',
    '--install-cmd': 'installCmd', '--freshness-cmd': 'freshnessCmd', '--build-cmd': 'buildCmd',
    '--suite-cmd': 'suiteCmd', '--isolate-cmd': 'isolateCmd', '--setup-cmd': 'setupCmd',
    '--proof-cmd': 'proofCmd', '--proof-expect': 'proofExpect', '--render-cmd': 'renderCmd', '--notify': 'notifyCmd',
    '--branch': 'branch', '--onto': 'onto', '--mirror-branch': 'mirrorBranch',
  };
  const bool: Record<string, keyof Config> = {
    '--ignore-load': 'ignoreLoad', '--no-land': 'noLand', '--dry-run': 'dryRun',
    '--force': 'force', '--scheduled': 'scheduled',
  };
  const num: Record<string, [keyof Config, number]> = {
    '--max-load': ['maxLoad', 1], '--max-load-defers': ['maxLoadDefers', 1], '--suite-timeout': ['suiteTimeoutMs', 1000],
    '--step-timeout': ['stepTimeoutMs', 1000], '--isolate-timeout': ['isolateTimeoutMs', 1000],
    '--isolate-attempts': ['isolateAttempts', 1], '--defer-notify-after': ['deferNotifyAfter', 1],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg in bool) { (cfg as Record<string, unknown>)[bool[arg]] = true; continue; }
    if (arg in str || arg in num) {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      if (arg in str) {
        (cfg as Record<string, unknown>)[str[arg]] = value;
        if (arg === '--repo') repoGiven = true;
      } else {
        const [key, scale] = num[arg];
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) throw new Error(`${arg} needs a non-negative number, got ${value}`);
        (cfg as Record<string, unknown>)[key] = n * scale;
      }
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  if (!repoGiven && cfg.liveLink !== base.liveLink) cfg.repo = realpathOrNull(cfg.liveLink) ?? cfg.liveLink;
  if (cfg.stateDir === base.stateDir && cfg.gstackStateDir !== base.gstackStateDir) {
    cfg.stateDir = path.join(cfg.gstackStateDir, 'fork-sync');
  }
  return cfg;
}

// ─── State, log, notify, lock ───────────────────────────────────────────────

function loadState(cfg: Config): State {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(cfg.stateDir, 'state.json'), 'utf8'));
    if (parsed && parsed.version === 1) return parsed as State;
  } catch { /* first run, or unreadable: start fresh */ }
  return { version: 1 };
}

function saveState(cfg: Config, state: State): void {
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  const file = path.join(cfg.stateDir, 'state.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function logLine(cfg: Config, message: string): void {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  if (cfg.dryRun) return;
  try {
    fs.mkdirSync(cfg.stateDir, { recursive: true });
    fs.appendFileSync(path.join(cfg.stateDir, 'fork-sync.log'), `${line}\n`);
  } catch { /* logging must never break a run */ }
}

/**
 * Raise an alert. `loud` goes to the phone when the notifier supports it
 * (synapse iris-notify: --remote). Fail-open: an alert never breaks a run.
 * Bodies carry branch names, versions and commit subjects of a public repo,
 * never local paths.
 */
function notify(cfg: Config, level: 'quiet' | 'loud', title: string, body: string, key: string): void {
  logLine(cfg, `notify(${level}) ${title} — ${body}`);
  if (cfg.dryRun || cfg.noLand) return;
  try {
    if (cfg.notifyCmd) {
      const args = ['--title', title, '--body', body, '--key', `gstack-fork-sync-${key}`];
      if (level === 'loud') args.push('--remote', '--priority', 'high', '--tags', 'warning');
      sh(cfg.notifyCmd, args, { timeoutMs: 30_000 });
    } else {
      const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      sh('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], { timeoutMs: 30_000 });
    }
  } catch { /* fail-open */ }
}

function acquireLock(cfg: Config): boolean {
  const dir = path.join(cfg.stateDir, 'lock');
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
      return true;
    } catch {
      const pid = Number.parseInt(fs.existsSync(path.join(dir, 'pid')) ? fs.readFileSync(path.join(dir, 'pid'), 'utf8') : '0', 10);
      let alive = false;
      if (pid > 0) {
        try { process.kill(pid, 0); alive = true; } catch (err) { alive = (err as NodeJS.ErrnoException).code === 'EPERM'; }
      }
      if (alive) return false;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  return false;
}

function releaseLock(cfg: Config): void {
  const dir = path.join(cfg.stateDir, 'lock');
  try {
    if (fs.readFileSync(path.join(dir, 'pid'), 'utf8').trim() === String(process.pid)) fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* not ours, or already gone */ }
}

// ─── Git facts ──────────────────────────────────────────────────────────────

function commitsIn(repo: string, range: string): CommitInfo[] {
  const out = gitOk(repo, 'log', '--reverse', '--format=%H%x09%s', range);
  return out ? out.split('\n').map((l) => { const [sha, ...rest] = l.split('\t'); return { sha, subject: rest.join('\t') }; }) : [];
}

function isAncestor(repo: string, a: string, b: string): boolean {
  return git(repo, 'merge-base', '--is-ancestor', a, b).code === 0;
}

function fileAt(repo: string, rev: string, file: string): string {
  const r = git(repo, 'show', `${rev}:${file}`);
  return r.code === 0 ? r.stdout.trim() : 'unknown';
}

/** Tracked modifications, staged changes, or an operation in progress. Untracked files are fine. */
function dirtyReasons(repo: string): string[] {
  const reasons: string[] = [];
  const status = git(repo, 'status', '--porcelain', '--untracked-files=no');
  if (status.code !== 0) return [`git status failed: ${status.stderr}`];
  if (status.stdout) reasons.push(...status.stdout.split('\n').slice(0, 20).map((l) => `modified: ${l.slice(3)}`));
  const gitDir = gitOk(repo, 'rev-parse', '--absolute-git-dir');
  for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG']) {
    if (fs.existsSync(path.join(gitDir, marker))) reasons.push(`in progress: ${marker}`);
  }
  return reasons;
}

/**
 * Keep the fork's local mirror branch (main) fast-forwarded to upstream.
 * Claude Desktop cuts new worktrees from local `main`; on this fork it sat at
 * v1.57.8.0 for months, so every new worktree started on a tree whose
 * brain-sync test wrote real HOME state. Fast-forward only, never while the
 * branch is checked out, never pushed (pushing main is the owner's call).
 */
function advanceMirror(cfg: Config, repo: string): void {
  if (!cfg.mirrorBranch || cfg.dryRun || cfg.noLand) return;
  const ref = `refs/heads/${cfg.mirrorBranch}`;
  const current = git(repo, 'rev-parse', '--verify', '--quiet', ref).stdout;
  const tip = git(repo, 'rev-parse', '--verify', '--quiet', `${cfg.upstreamRemote}/${cfg.upstreamBranch}^{commit}`).stdout;
  if (!current || !tip || current === tip) return;
  if (git(repo, 'worktree', 'list', '--porcelain').stdout.split('\n').includes(`branch ${ref}`)) {
    logLine(cfg, `mirror: ${cfg.mirrorBranch} is checked out somewhere; left at ${current.slice(0, 8)}`);
    return;
  }
  if (!isAncestor(repo, current, tip)) {
    logLine(cfg, `mirror: ${cfg.mirrorBranch} has commits upstream lacks; left at ${current.slice(0, 8)}`);
    return;
  }
  const r = git(repo, 'update-ref', ref, tip, current);
  logLine(cfg, r.code === 0 ? `mirror: ${cfg.mirrorBranch} ${current.slice(0, 8)} -> ${tip.slice(0, 8)}` : `mirror: update-ref failed: ${r.stderr}`);
}

/** Remote branches (on `remote`) that contain `sha`, after the fetch. */
function onRemote(repo: string, remote: string, sha: string): boolean {
  const r = git(repo, 'branch', '-r', '--contains', sha);
  return r.code === 0 && r.stdout.split('\n').some((l) => l.trim().startsWith(`${remote}/`));
}

function remoteBranchSha(repo: string, remote: string, branch: string): string | null {
  const r = git(repo, 'ls-remote', '--heads', remote, `refs/heads/${branch}`);
  if (r.code !== 0 || !r.stdout) return null;
  return r.stdout.split(/\s+/)[0] || null;
}

// ─── Worktrees ──────────────────────────────────────────────────────────────

function addWorktree(cfg: Config, name: string, rev: string): string {
  fs.mkdirSync(cfg.worktreeRoot, { recursive: true });
  const dir = path.join(cfg.worktreeRoot, name);
  gitOk(cfg.repo, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '--detach', dir, rev);
  // Locked so Claude Desktop's idle-worktree GC cannot reap it mid-run.
  git(cfg.repo, 'worktree', 'lock', '--reason', 'gstack fork-sync run in progress', dir);
  return dir;
}

/** Only ever removes a worktree this run created; its commits stay reachable via refs/fork-sync/*. */
function removeWorktree(cfg: Config, dir: string): void {
  git(cfg.repo, 'worktree', 'unlock', dir);
  const r = git(cfg.repo, 'worktree', 'remove', '--force', dir);
  if (r.code !== 0) logLine(cfg, `WARN could not remove worktree ${dir}: ${r.stderr}`);
}

// ─── Gate ───────────────────────────────────────────────────────────────────

function isolationEnv(stateDir: string): NodeJS.ProcessEnv {
  // Mirror the free runner's per-shard isolation (scripts/test-free-shards.ts).
  const tmp = path.join(stateDir, 'tmp');
  fs.mkdirSync(tmp);
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
  env.BROWSE_STATE_FILE = path.join(stateDir, '.gstack', 'browse.json');
  env.CHROMIUM_PROFILE = path.join(stateDir, 'chromium-profile');
  delete env.GSTACK_FREE_RETRY_FLAKY;
  return env;
}

async function isolatedPasses(cfg: Config, root: string, file: string, logFile: string): Promise<boolean> {
  for (let attempt = 1; attempt <= cfg.isolateAttempts; attempt += 1) {
    const before = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-fork-sync-iso-'));
    const r = await runLogged(fill(cfg.isolateCmd, { path: path.join(root, file), root }), root, logFile, cfg.isolateTimeoutMs, isolationEnv(scratch));
    fs.rmSync(scratch, { recursive: true, force: true });
    const tail = fs.readFileSync(logFile, 'utf8').slice(before);
    // bun's summary line proves the file ran to completion; exit 0 alone does not.
    if (r.code === 0 && !r.timedOut && /Ran \d+ tests? across \d+ files?/.test(tail)) return true;
  }
  return false;
}

/** How many unrun file names a one-line message carries before it summarises. */
const NAME_CAP = 8;

/** `a, b, c and 4 more` — bounded for a log line or a notification body. */
export function nameList(files: string[], cap = NAME_CAP): string {
  if (files.length <= cap) return files.join(', ');
  return `${files.slice(0, cap).join(', ')} and ${files.length - cap} more`;
}

async function judge(cfg: Config, ours: SuiteResult, base: SuiteResult, touchedTests: string[], oursRoot: string, baseRoot: string, runDir: string): Promise<GateVerdict> {
  // A regression confirmed in isolation is definitive even when a shard
  // wedged, and naming it is what makes the STOP actionable, so isolation runs
  // regardless of completeness and its verdict wins at the end. An incomplete
  // run with nothing confirmed can prove nothing either way, so it stays
  // inconclusive — and says which files that ignorance covers.
  const v: GateVerdict = { verdict: 'pass', regressions: [], flaky: [], baseline: [], unrun: [], vouched: [], reasons: [] };
  const isoLog = path.join(runDir, 'isolate.log');

  /**
   * The three-way isolated verdict on one file: ours passes => not ours to
   * answer for, into `passBucket` (`flaky` for a file seen failing, `vouched`
   * for one that never reported); ours fails and base passes or lacks it =>
   * regression; both fail => baseline-red. False when it cannot be re-run.
   */
  const isolate = async (file: string, passBucket: string[]): Promise<boolean> => {
    if (!fs.existsSync(path.join(oursRoot, file))) {
      // Attributed to a path this tree does not have: not a file we can re-run.
      v.reasons.push(`skipped ${file}: not a file in the rebased tree`);
      return false;
    }
    if (await isolatedPasses(cfg, oursRoot, file, isoLog)) { passBucket.push(file); return true; }
    if (!fs.existsSync(path.join(baseRoot, file))) { v.regressions.push(`${file} (new on our side, fails)`); return true; }
    if (await isolatedPasses(cfg, baseRoot, file, isoLog)) v.regressions.push(file);
    else v.baseline.push(file);
    return true;
  };

  if (!suiteComplete(ours)) {
    v.verdict = 'inconclusive';
    v.reasons.push(ours.timedOut ? 'a shard of the rebased suite timed out' : 'the rebased suite did not finish every shard');
  }
  const unattributed = oursOnlyUnattributed(ours, base);
  if (unattributed > 0) {
    v.verdict = 'inconclusive';
    v.reasons.push(`${unattributed} ours-only failure(s) could not be attributed to a file`);
  }
  const candidates = gateCandidates(ours, base, touchedTests);
  for (const file of candidates) await isolate(file, v.flaky);

  // Files the run reached no verdict on. A comparative diff of failure lists
  // cannot see them, so without this the verdict's `regressions=0` would be
  // reported over a set that silently excludes them.
  const unvouched = unvouchedFiles(ours);
  const already = new Set(candidates);
  const unrun = unvouched.files.filter((f) => !already.has(f));

  // ESCALATION. An unrun file that our commits TOUCH is the dangerous case:
  // nothing measured the thing we changed. It still does not escalate on the
  // bare fact of being unrun — BLOCKED_REGRESSION is memoised per (reason,
  // upstream sha, branch tip) and pages loudly, so raising it off a shard that
  // wedged (a LOAD artefact, not a property of the commits) would freeze the
  // fork behind a flake until a human forced it. It escalates through
  // MEASUREMENT instead: touched unrun files are re-run in isolation on both
  // trees here and now, and a failure confirmed that way is a regression by
  // the same definitive rule as any other. Bounded by construction — this is
  // the U..NEW test-file diff, a handful of files.
  const touched = new Set(touchedTests);
  const sweep = unrun.filter((f) => touched.has(f));
  const swept = new Set<string>();
  for (const file of sweep) {
    // Passing in isolation VOUCHES for the file; it was never seen failing,
    // so it is not flaky, and calling it that would inflate the flake count.
    if (await isolate(file, v.vouched)) swept.add(file);
  }
  v.unrun = unrun.filter((f) => !swept.has(f));

  // The rest are NAMED, not run. Isolation is one process per file and a
  // wedged shard holds ~180 of them; on the box this runs on (1-minute load
  // 100-190 for hours at a stretch) that is hours of wall clock to re-derive
  // a baseline the next scheduled run re-measures for free. Naming them is
  // what makes the inconclusive verdict actionable; running them is not.
  if (v.unrun.length > 0) {
    v.verdict = v.verdict === 'pass' ? 'inconclusive' : v.verdict;
    v.reasons.push(`no verdict on ${v.unrun.length} test file(s) in unfinished shard(s) ${unvouched.shards.join(', ')}: ${nameList(v.unrun)}`);
  }
  if (unvouched.unnamedShards.length > 0) {
    v.verdict = v.verdict === 'pass' ? 'inconclusive' : v.verdict;
    v.reasons.push(`shard(s) ${unvouched.unnamedShards.join(', ')} did not finish and never printed a plan line, so their files cannot be named`);
  }
  // No shard line at all: the runner died before it planned anything, so there
  // is not even a shard count to enumerate. Distinct from a shard dying, and
  // an empty unrun set here means "nothing is known", not "nothing is wrong".
  if (ours.shardTotal === 0 && ours.plans.size === 0) {
    v.verdict = v.verdict === 'pass' ? 'inconclusive' : v.verdict;
    v.reasons.push('the rebased suite printed no shard line at all, so no unrun file can be named');
  }
  if (v.regressions.length > 0) v.verdict = 'regression';
  return v;
}

// ─── The run ────────────────────────────────────────────────────────────────

const EXIT: Record<Outcome, number> = {
  UP_TO_DATE: 0, LANDED: 0, REHEARSED: 0, DRY_RUN: 0, SKIPPED_BLOCKED: 0,
  DEFERRED_LOAD: 2, DEFERRED_BUSY: 2, DEFERRED_FETCH: 2, INCONCLUSIVE: 2, ABORTED_MOVED: 2,
  BLOCKED_PRECONDITION: 3, BLOCKED_DIRTY: 3, BLOCKED_CONFLICT: 3, BLOCKED_STALE: 3,
  BLOCKED_REGRESSION: 3, BLOCKED_COLLISION: 3, BLOCKED_PUSH: 3, BLOCKED_SWITCH: 3,
  ROLLED_BACK: 4, ERROR: 1,
};

const DEFERRING = new Set<Outcome>(['DEFERRED_LOAD', 'DEFERRED_BUSY', 'DEFERRED_FETCH', 'INCONCLUSIVE', 'ABORTED_MOVED']);

export async function run(cfg: Config): Promise<RunResult> {
  const stamp = localStamp();
  const runDir = path.join(cfg.stateDir, 'runs', stamp);
  const state = loadState(cfg);
  const created: string[] = [];
  const facts: Record<string, unknown> = { at: new Date().toISOString(), scheduled: cfg.scheduled };
  let memoKey = '';

  const finish = (outcome: Outcome, detail: string): RunResult => {
    logLine(cfg, `${outcome} ${detail}`);
    const record = { ...facts, outcome, detail };
    if (cfg.dryRun) return { outcome, detail, exitCode: EXIT[outcome] };
    if (cfg.noLand) {
      state.rehearsal = record;
    } else {
      state.lastRun = record;
      if (outcome.startsWith('BLOCKED_') || outcome === 'ROLLED_BACK' || outcome === 'ERROR') {
        state.blocked = { key: memoKey || outcome, reason: outcome, at: new Date().toISOString() };
      } else if (outcome === 'UP_TO_DATE' || outcome === 'LANDED') {
        state.blocked = null;
      }
      if (DEFERRING.has(outcome)) {
        state.deferStreak = (state.deferStreak ?? 0) + 1;
        if (state.deferStreak === cfg.deferNotifyAfter) {
          notify(cfg, 'loud', 'gstack fork-sync keeps deferring',
            `${state.deferStreak} runs in a row deferred, latest: ${outcome}. Upstream may be drifting away. Run it by hand with --ignore-load.`, 'deferring');
        }
      } else if (outcome !== 'SKIPPED_BLOCKED') {
        state.deferStreak = 0;
      }
      state.history = [...(state.history ?? []), { at: new Date().toISOString(), outcome, detail: detail.slice(0, 300) }].slice(-30);
    }
    try { saveState(cfg, state); } catch (err) { logLine(cfg, `WARN state not saved: ${(err as Error).message}`); }
    return { outcome, detail, exitCode: EXIT[outcome] };
  };

  /** A STOP that pages once per (reason, upstream, tip). */
  const stop = (outcome: Outcome, title: string, body: string): RunResult => {
    const alreadyTold = state.blocked?.key === memoKey && memoKey !== '';
    if (!alreadyTold) notify(cfg, 'loud', title, body, outcome.toLowerCase());
    return finish(outcome, body);
  };

  if (!cfg.dryRun && !acquireLock(cfg)) return finish('DEFERRED_BUSY', 'another fork-sync run holds the lock');
  try {
    logLine(cfg, `run start repo=${cfg.repo}${cfg.noLand ? ' (rehearsal, no landing)' : ''}${cfg.dryRun ? ' (dry run)' : ''}`);

    // 1. Preconditions.
    const repo = cfg.repo;
    const pre = (why: string) => { memoKey = `PRE|${why}`; return stop('BLOCKED_PRECONDITION', 'gstack fork-sync cannot run', why); };
    // stdout ALONE cannot carry this: a git that could not run answers with an
    // empty stdout, and `'' !== 'true'` then asserts that the checkout is not a
    // work tree — a memoised claim nothing established. Reproduced 2026-09-28:
    // 1 of 9 six-file runs STOPPED this way against a sandbox clone that was
    // one. Only a git that ANSWERED can settle the question.
    const inside = git(repo, 'rev-parse', '--is-inside-work-tree');
    if (inside.code !== 0) return pre(`cannot ask whether ${path.basename(repo)} is a git work tree: ${shWhy(inside)}`);
    if (inside.stdout !== 'true') return pre(`not a git work tree: ${path.basename(repo)} (git said "${inside.stdout}")`);
    const gitDir = gitOk(repo, 'rev-parse', '--absolute-git-dir');
    const commonDir = path.resolve(repo, gitOk(repo, 'rev-parse', '--git-common-dir'));
    const kind = worktreeKind(gitDir, commonDir, fsResolve);
    if (kind.kind === 'unresolved') return pre(`cannot resolve the checkout's git directory: ${kind.detail}`);
    if (kind.kind === 'linked') {
      // The detail is the point: this verdict asserts a fact about the
      // repository's layout, so it names the two paths that disagreed. Without
      // them a wrong verdict reads exactly like a right one — which is why the
      // 2026-09-27 recurrence of this message could not be traced from its log.
      return pre(`the durable checkout is a linked worktree; the live suite must run from the main checkout (${kind.detail})`);
    }
    if (!cfg.noLand) {
      const pairing = samePath(cfg.liveLink, repo, fsResolve);
      if (pairing.same === null) return pre(`cannot resolve the live link against the durable checkout: ${pairing.detail}`);
      if (!pairing.same) return pre(`the live link does not resolve to the durable checkout (${pairing.detail}); re-run ./setup there`);
    }
    for (const remote of [cfg.upstreamRemote, cfg.originRemote]) {
      if (git(repo, 'remote', 'get-url', remote).code !== 0) return pre(`no '${remote}' remote: not a fork install`);
    }
    // `symbolic-ref --quiet` exits 1 on a genuinely detached HEAD with nothing
    // on stderr, so the two are told apart by whether git ran at all: a
    // non-zero exit WITH stderr is git failing, not a detached HEAD.
    const head = git(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD');
    if (head.code !== 0 && head.stderr) return pre(`cannot read HEAD in ${path.basename(repo)}: ${shWhy(head)}`);
    const current = head.stdout;
    const branch = cfg.branch ?? current;
    if (!branch) return pre('the durable checkout is on a detached HEAD');
    if (!cfg.noLand && !cfg.dryRun && branch !== current) return pre(`--branch ${branch} is not the live branch; rehearse it with --no-land`);
    if (git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).code !== 0) return pre(`no local branch ${branch}`);
    facts.branch = branch;

    // Deferral is bounded: on a box that is always busy, waiting for quiet
    // would mean never landing. After maxLoadDefers deferrals in a row the run
    // proceeds, and the isolated re-runs absorb load-induced flakes.
    if (!cfg.ignoreLoad && !cfg.dryRun) {
      const load = os.loadavg()[0];
      const busy = cfg.maxLoad > 0 && load > cfg.maxLoad ? `load ${load.toFixed(1)} > ${cfg.maxLoad}`
        : sh('pgrep', ['-f', 'scripts/test-free-shards.ts']).code === 0 ? 'another free-suite run is in progress on this machine' : '';
      if (busy && (state.deferStreak ?? 0) < cfg.maxLoadDefers) return finish('DEFERRED_LOAD', busy);
      if (busy) logLine(cfg, `running despite ${busy}: ${state.deferStreak} deferrals in a row`);
    }

    // 2. Fetch.
    for (const remote of [cfg.upstreamRemote, cfg.originRemote]) {
      const f = sh('git', ['fetch', '--quiet', remote], { cwd: repo, env: GIT_ENV, timeoutMs: 180_000 });
      if (f.code !== 0) return finish('DEFERRED_FETCH', `git fetch ${remote} failed: ${f.stderr.slice(0, 200)}`);
    }
    advanceMirror(cfg, repo);
    const ontoRef = cfg.onto ?? `${cfg.upstreamRemote}/${cfg.upstreamBranch}`;
    const U = gitOk(repo, 'rev-parse', '--verify', `${ontoRef}^{commit}`);
    const T = gitOk(repo, 'rev-parse', '--verify', `refs/heads/${branch}^{commit}`);
    const upVersion = fileAt(repo, U, 'VERSION');
    const oldVersion = fileAt(repo, T, 'VERSION');
    Object.assign(facts, { upstream: U, tip: T, upstreamVersion: upVersion, oldVersion });
    memoKey = `${U}|${T}`;

    if (isAncestor(repo, U, T)) return finish('UP_TO_DATE', `${branch} already contains upstream ${U.slice(0, 8)} (v${upVersion})`);
    if (!cfg.force && !cfg.noLand && !cfg.dryRun && state.blocked?.key === memoKey) {
      return finish('SKIPPED_BLOCKED', `(${U.slice(0, 8)}, ${T.slice(0, 8)}) already stopped as ${state.blocked.reason}; waiting for upstream or ${branch} to move`);
    }
    // Deterministic stops (conflict, stale docs, regression) key on the pair and
    // are skipped until a side moves. Retryable stops key with a prefix, so the
    // next run tries again but pages only once.
    const target = landingBranchName(branch, upVersion, U);
    const existing = cfg.noLand ? null
      : git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${target}`).stdout || remoteBranchSha(repo, cfg.originRemote, target);
    if (existing && !cfg.dryRun) {
      {
        memoKey = `COLLIDE|${U}|${T}`;
        return stop('BLOCKED_COLLISION', 'gstack fork-sync: landing branch already exists',
          `${target} already exists (${existing.slice(0, 8)}), so someone else is landing v${upVersion}. `
          + 'Nothing was attempted; the job will not build a parallel branch. Switch the live checkout to it, or delete it, and the next run proceeds.');
      }
    }
    const mergeBase = gitOk(repo, 'merge-base', U, T);
    const carried = commitsIn(repo, `${mergeBase}..${T}`);
    const behind = Number(gitOk(repo, 'rev-list', '--count', `${T}..${U}`));
    facts.carried = carried.length;
    if (cfg.dryRun) {
      const dirty = cfg.noLand ? [] : dirtyReasons(repo);
      return finish('DRY_RUN', `${branch} is ${behind} behind upstream v${upVersion} (${U.slice(0, 8)}) carrying ${carried.length} commit(s); `
        + `would land as ${target}`
        + (existing ? `; BUT ${target} already exists (${existing.slice(0, 8)}), so a real run would stop` : '')
        + (dirty.length ? `; BUT the live checkout is dirty (${dirty.length}): ${dirty.slice(0, 3).join('; ')}` : ''));
    }
    if (!cfg.noLand) {
      const dirty = dirtyReasons(repo);
      if (dirty.length) {
        memoKey = `DIRTY|${U}|${T}`;
        return stop('BLOCKED_DIRTY', 'gstack fork-sync: live checkout has local changes',
          `Upstream v${upVersion} is ready but ${branch} has ${dirty.length} uncommitted change(s) (${dirty.slice(0, 3).join('; ')}). Nothing was discarded; commit or move them, and the next run proceeds.`);
      }
    }

    // 3. Rebase in a throwaway worktree. Only runs that get this far keep a
    // run directory, so no-op runs cannot prune away a real run's gate logs.
    fs.mkdirSync(runDir, { recursive: true });
    facts.runDir = runDir;
    pruneRuns(cfg, 20);
    const oursDir = addWorktree(cfg, `fork-sync-${stamp}-ours`, T);
    created.push(oursDir);
    const rebaseEnv = { ...GIT_ENV, GIT_COMMITTER_NAME: COMMITTER_NAME, GIT_COMMITTER_EMAIL: COMMITTER_EMAIL };
    const rb = sh('git', ['-c', 'rerere.enabled=false', '-c', 'rebase.autoStash=false', '-c', 'rebase.updateRefs=false',
      '-c', 'core.hooksPath=/dev/null', 'rebase', '--empty=drop', '--no-autosquash', U], { cwd: oursDir, env: rebaseEnv, timeoutMs: 600_000 });
    if (rb.code !== 0) {
      const stopped = git(oursDir, 'rev-parse', '--verify', '--quiet', 'REBASE_HEAD').stdout;
      const subject = stopped ? git(oursDir, 'log', '-1', '--format=%s', stopped).stdout : '(unknown commit)';
      const files = git(oursDir, 'diff', '--name-only', '--diff-filter=U').stdout.split('\n').filter(Boolean);
      git(oursDir, 'rebase', '--abort');
      Object.assign(facts, { conflict: { commit: stopped, subject, files } });
      return stop('BLOCKED_CONFLICT', 'gstack fork-sync: rebase conflict',
        `Rebasing ${carried.length} commit(s) of ${branch} onto upstream v${upVersion} (${U.slice(0, 8)}) stopped at "${subject}"`
        + (files.length ? ` in ${files.slice(0, 5).join(', ')}` : ` (${rb.stderr.split('\n')[0]})`)
        + '. Nothing landed; the live suite is untouched. Rekey that commit by hand.');
    }
    const NEW = gitOk(oursDir, 'rev-parse', 'HEAD');
    gitOk(repo, 'update-ref', 'refs/fork-sync/attempt', NEW);
    const kept = commitsIn(repo, `${U}..${NEW}`);
    const dropped = droppedSubjects(carried.map((c) => c.subject), kept.map((c) => c.subject));
    Object.assign(facts, { rebased: NEW, kept: kept.length, dropped });
    logLine(cfg, `rebased ${carried.length} -> ${kept.length} commit(s) onto ${U.slice(0, 8)}; dropped: ${dropped.length ? dropped.join(' | ') : 'none'}`);

    // 4. Install and freshness, as CI checks it.
    const oursLog = path.join(runDir, 'ours.log');
    const inst = await runLogged(cfg.installCmd, oursDir, oursLog, cfg.stepTimeoutMs);
    if (inst.code !== 0) return finish('INCONCLUSIVE', `install failed on the rebased tree (see ${oursLog})`);
    const fresh = await runLogged(cfg.freshnessCmd, oursDir, oursLog, cfg.stepTimeoutMs);
    const stale = git(oursDir, 'status', '--porcelain', '--untracked-files=all').stdout.split('\n').filter(Boolean)
      .filter((l) => !/^\?\? node_modules\//.test(l));
    if (fresh.code !== 0 || stale.length > 0) {
      return stop('BLOCKED_STALE', 'gstack fork-sync: generated docs stale after rebase',
        `The rebase onto v${upVersion} is clean, but ${fresh.code !== 0 ? 'the generator failed' : `${stale.length} generated file(s) no longer match their templates (${stale.slice(0, 4).map((l) => l.slice(3)).join(', ')})`}. `
        + 'Nothing landed. Regenerate and commit on the branch by hand.');
    }

    // 5. Gate: build both trees, suite on both, compare.
    const baseDir = addWorktree(cfg, `fork-sync-${stamp}-base`, U);
    created.push(baseDir);
    const baseLog = path.join(runDir, 'base.log');
    const buildOurs = await runLogged(cfg.buildCmd, oursDir, oursLog, cfg.stepTimeoutMs);
    const baseInst = await runLogged(cfg.installCmd, baseDir, baseLog, cfg.stepTimeoutMs);
    const buildBase = baseInst.code === 0 ? await runLogged(cfg.buildCmd, baseDir, baseLog, cfg.stepTimeoutMs) : baseInst;
    if (buildOurs.code !== 0) {
      if (buildBase.code === 0) {
        return stop('BLOCKED_REGRESSION', 'gstack fork-sync: build regression',
          `The rebased tree fails to build on v${upVersion} while pristine upstream builds. Nothing landed.`);
      }
      return finish('INCONCLUSIVE', 'the build fails on both trees; see the run logs');
    }
    const suiteEnv = { ...process.env };
    delete suiteEnv.GSTACK_FREE_RETRY_FLAKY;
    const oursSuite = await runLogged(cfg.suiteCmd, oursDir, oursLog, cfg.suiteTimeoutMs, suiteEnv);
    const baseSuite = await runLogged(cfg.suiteCmd, baseDir, baseLog, cfg.suiteTimeoutMs, suiteEnv);
    const oursResult = parseSuiteLog(fs.readFileSync(oursLog, 'utf8'));
    const baseResult = parseSuiteLog(fs.readFileSync(baseLog, 'utf8'));
    if (oursSuite.timedOut) oursResult.timedOut = true;
    if (baseSuite.timedOut) baseResult.timedOut = true;
    const touchedTests = gitOk(repo, 'diff', '--name-only', U, NEW).split('\n')
      .filter((f) => /\.test\.ts$/.test(f) && fs.existsSync(path.join(oursDir, f)));
    const verdict = await judge(cfg, oursResult, baseResult, touchedTests, oursDir, baseDir, runDir);
    // Both trees' unvouched sets are recorded: only ours can hide a regression,
    // but a base shard that died is why a file of ours lands in `baseline`
    // instead of `regressions`, and that is not reconstructable later.
    const oursUnvouched = unvouchedFiles(oursResult);
    const baseUnvouched = unvouchedFiles(baseResult);
    Object.assign(facts, {
      gate: {
        ours: {
          failures: oursResult.failures.size, files: oursResult.failingFiles.size, complete: suiteComplete(oursResult), exit: oursSuite.code,
          unvouchedShards: oursUnvouched.shards, unvouchedFiles: oursUnvouched.files.length, unnamedShards: oursUnvouched.unnamedShards,
        },
        base: {
          failures: baseResult.failures.size, files: baseResult.failingFiles.size, complete: suiteComplete(baseResult), exit: baseSuite.code,
          unvouchedShards: baseUnvouched.shards, unvouchedFiles: baseUnvouched.files.length, unnamedShards: baseUnvouched.unnamedShards,
        },
        verdict,
      },
    });
    logLine(cfg, `gate ours=${oursResult.failures.size} base=${baseResult.failures.size} verdict=${verdict.verdict}`
      + ` regressions=${verdict.regressions.length} flaky=${verdict.flaky.length} baseline=${verdict.baseline.length}`
      + ` unrun=${verdict.unrun.length} vouched=${verdict.vouched.length}`
      + (verdict.unrun.length > 0 ? ` unrun-files=${nameList(verdict.unrun)}` : ''));

    // A suite run can repoint the live link (older team-mode tests ran ./setup
    // with the real HOME). Never leave the machine pointing into a throwaway.
    const gatePairing = samePath(cfg.liveLink, repo, fsResolve);
    if (!cfg.noLand && gatePairing.same !== true) {
      logLine(cfg, `WARN the live link moved during the gate (${gatePairing.detail}); restoring it from the durable checkout`);
      await runLogged(setupCommand(cfg), repo, path.join(runDir, 'setup.log'), cfg.stepTimeoutMs);
    }

    if (verdict.verdict === 'regression') {
      return stop('BLOCKED_REGRESSION', 'gstack fork-sync: gate regression',
        `The rebase onto v${upVersion} is clean, but ${verdict.regressions.length} test file(s) fail only on our side: `
        + `${verdict.regressions.slice(0, 5).join(', ')}. Nothing landed. The rebased tip is kept at refs/fork-sync/attempt.`);
    }
    if (verdict.verdict === 'inconclusive') return finish('INCONCLUSIVE', verdict.reasons.join('; '));
    if (cfg.noLand) {
      return finish('REHEARSED', `${branch} rebases cleanly onto v${upVersion}: ${kept.length} kept, ${dropped.length} dropped, gate pass `
        + `(${verdict.flaky.length} flaky, ${verdict.baseline.length} baseline-red)`);
    }

    // 6. Land.
    return await land(cfg, { branch, T, U, NEW, upVersion, oldVersion, kept: kept.length, dropped, stamp, runDir, facts, stop, finish, setMemo: (k) => { memoKey = k; } });
  } catch (err) {
    memoKey = `ERR|${(err as Error).message.slice(0, 120)}`;
    return stop('ERROR', 'gstack fork-sync failed', (err as Error).message.slice(0, 400));
  } finally {
    for (const dir of created) removeWorktree(cfg, dir);
    if (!cfg.dryRun) releaseLock(cfg);
  }
}

/** Keep the newest `keep` run directories; each holds full suite logs. */
function pruneRuns(cfg: Config, keep: number): void {
  const dir = path.join(cfg.stateDir, 'runs');
  try {
    const runs = fs.readdirSync(dir).filter((d) => /^\d{8}-\d{6}$/.test(d)).sort();
    for (const old of runs.slice(0, Math.max(0, runs.length - keep))) fs.rmSync(path.join(dir, old), { recursive: true, force: true });
  } catch { /* nothing to prune */ }
}

function setupCommand(cfg: Config): string {
  if (cfg.setupCmd) return cfg.setupCmd;
  const prefix = sh(path.join(cfg.repo, 'bin', 'gstack-config'), ['get', 'skill_prefix'], { cwd: cfg.repo }).stdout;
  return `./setup -q ${prefix === 'true' ? '--prefix' : '--no-prefix'}`;
}

interface LandCtx {
  branch: string; T: string; U: string; NEW: string; upVersion: string; oldVersion: string;
  kept: number; dropped: string[]; stamp: string; runDir: string; facts: Record<string, unknown>;
  stop: (o: Outcome, title: string, body: string) => RunResult;
  finish: (o: Outcome, detail: string) => RunResult;
  setMemo: (key: string) => void;
}

async function land(cfg: Config, c: LandCtx): Promise<RunResult> {
  const repo = cfg.repo;
  const { branch, T, U, NEW, upVersion } = c;

  // Re-verify: the gate took a while and the live checkout is shared.
  const head = git(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD').stdout;
  if (head !== branch || gitOk(repo, 'rev-parse', 'HEAD') !== T) {
    return c.finish('ABORTED_MOVED', `the live checkout moved during the run (now ${head || 'detached'}); retrying next run`);
  }
  const dirty = dirtyReasons(repo);
  if (dirty.length) {
    c.setMemo(`DIRTY|${U}|${T}`);
    return c.stop('BLOCKED_DIRTY', 'gstack fork-sync: live checkout has local changes',
      `Gate passed for v${upVersion}, but ${branch} gained ${dirty.length} uncommitted change(s) during the run. Nothing was discarded or landed.`);
  }

  const target = landingBranchName(branch, upVersion, U);
  c.facts.landing = target;
  const localSha = git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${target}`).stdout || null;
  const remoteSha = remoteBranchSha(repo, cfg.originRemote, target);
  if ((localSha && localSha !== NEW) || (remoteSha && remoteSha !== NEW)) {
    c.setMemo(`COLLIDE|${U}|${T}`);
    return c.stop('BLOCKED_COLLISION', 'gstack fork-sync: landing branch already exists',
      `${target} already exists${remoteSha ? ' on origin' : ' locally'} with different commits, so someone else is landing v${upVersion}. `
      + 'Nothing landed; the job will not create a parallel branch.');
  }

  // The old tip must survive on origin before the live checkout leaves it.
  if (!onRemote(repo, cfg.originRemote, T)) {
    const backup = `backup/fork-sync-${branch.replace(/[^A-Za-z0-9._-]+/g, '-')}-${c.stamp}`;
    const b = sh('git', ['push', cfg.originRemote, `${T}:refs/heads/${backup}`], { cwd: repo, env: GIT_ENV, timeoutMs: 180_000 });
    if (b.code !== 0) {
      c.setMemo(`PUSH|${U}|${T}`);
      return c.stop('BLOCKED_PUSH', 'gstack fork-sync: backup push refused',
        `Could not push the old tip of ${branch} to origin as ${backup}: ${b.stderr.split('\n').slice(-1)[0]}. Nothing landed.`);
    }
    logLine(cfg, `backed up ${T.slice(0, 8)} to ${cfg.originRemote}/${backup}`);
  }

  let createdLocal = false;
  if (!localSha) { gitOk(repo, 'branch', target, NEW); createdLocal = true; }
  if (!remoteSha) {
    const p = sh('git', ['push', cfg.originRemote, `refs/heads/${target}:refs/heads/${target}`], { cwd: repo, env: GIT_ENV, timeoutMs: 180_000 });
    if (p.code !== 0) {
      if (createdLocal) git(repo, 'branch', '-D', target);
      c.setMemo(`PUSH|${U}|${T}`);
      return c.stop('BLOCKED_PUSH', 'gstack fork-sync: push refused',
        `Gate passed for v${upVersion}, but pushing ${target} to origin failed: ${p.stderr.split('\n').slice(-1)[0]}. Nothing landed; it was not forced.`);
    }
  }

  const sw = git(repo, 'switch', target);
  if (sw.code !== 0) {
    return c.stop('BLOCKED_SWITCH', 'gstack fork-sync: switch refused',
      `Could not switch the live checkout to ${target}: ${sw.stderr.split('\n')[0]}. ${branch} is still live; ${target} is pushed.`);
  }
  git(repo, 'branch', `--set-upstream-to=${cfg.originRemote}/${target}`, target);
  logLine(cfg, `live checkout switched ${branch} -> ${target}`);

  const verify = async (label: string): Promise<string | null> => {
    const setupLog = path.join(c.runDir, `setup-${label}.log`);
    const s = await runLogged(setupCommand(cfg), repo, setupLog, cfg.stepTimeoutMs);
    if (s.code !== 0) return `./setup exited ${s.code}${s.timedOut ? ' (timed out)' : ''}`;
    if (label === 'land') runMigrations(cfg, c.oldVersion);
    const setupPairing = samePath(cfg.liveLink, repo, fsResolve);
    if (setupPairing.same !== true) return `the live link does not resolve to the durable checkout after setup (${setupPairing.detail})`;
    const proof = sh('/bin/bash', ['-c', fill(cfg.proofCmd, { live: cfg.liveLink, pid: String(process.pid) })], { cwd: repo, timeoutMs: 120_000 });
    if (!proof.stdout.split('\n').some((l) => l.trim() === cfg.proofExpect)) {
      return `the proof command did not print "${cfg.proofExpect}" (exit ${proof.code})`;
    }
    // Installed skills serve the gbrain render, not the checkout, so the
    // landing is not live until the render is rebuilt from it. ./setup
    // renders too but only warns when that fails; this step must succeed,
    // and it also proves no installed skill link was left dangling.
    const renderLog = path.join(c.runDir, `render-${label}.log`);
    const r = await runLogged(fill(cfg.renderCmd, { live: cfg.liveLink }), repo, renderLog, cfg.stepTimeoutMs);
    if (r.code !== 0) return `the render refresh exited ${r.code}${r.timedOut ? ' (timed out)' : ''}; see ${renderLog}`;
    return null;
  };

  const failure = await verify('land');
  if (failure) {
    const back = git(repo, 'switch', branch);
    const again = back.code === 0 ? await verify('rollback') : `switch back failed: ${back.stderr}`;
    c.setMemo(`${U}|${T}`);
    if (again) {
      return c.stop('ERROR', 'gstack fork-sync: live suite may be broken',
        `Landing ${target} failed (${failure}) and the rollback to ${branch} also failed (${again}). Run ./setup in the durable checkout now.`);
    }
    return c.stop('ROLLED_BACK', 'gstack fork-sync: landing rolled back',
      `${target} passed the gate but failed on the live checkout (${failure}). Rolled back to ${branch}, which is live and proven again.`);
  }

  // Tell gstack's own update check what happened: "just upgraded", no stale nag.
  if (c.oldVersion !== upVersion) {
    try {
      fs.mkdirSync(cfg.gstackStateDir, { recursive: true });
      fs.writeFileSync(path.join(cfg.gstackStateDir, 'just-upgraded-from'), `${c.oldVersion}\n`);
      fs.rmSync(path.join(cfg.gstackStateDir, 'last-update-check'), { force: true });
      fs.rmSync(path.join(cfg.gstackStateDir, 'update-snoozed'), { force: true });
    } catch (err) { logLine(cfg, `WARN could not write update markers: ${(err as Error).message}`); }
  }

  const summary = `v${c.oldVersion} -> v${upVersion} as ${target}: ${c.kept} kept, ${c.dropped.length} dropped`
    + (c.dropped.length ? ` (${c.dropped.join('; ')})` : '') + '. Live suite proven.';
  notify(cfg, c.dropped.length ? 'loud' : 'quiet', 'gstack fork-sync: landed', summary, 'landed');
  return c.finish('LANDED', summary);
}

function runMigrations(cfg: Config, oldVersion: string): void {
  const dir = path.join(cfg.repo, 'gstack-upgrade', 'migrations');
  if (oldVersion === 'unknown' || !fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => /^v[\d.]+\.sh$/.test(f))
    .sort((a, b) => compareVersions(a.slice(1, -3), b.slice(1, -3)));
  for (const f of files) {
    const version = f.slice(1, -3);
    if (compareVersions(version, oldVersion) <= 0) continue;
    // /bin/bash, not PATH bash: from launchd PATH bash is Homebrew 5.3, whose
    // heredoc path can deadlock on mid-sized bodies.
    const r = sh('/bin/bash', [path.join(dir, f)], { cwd: cfg.repo, env: { ...process.env, GSTACK_INSTALL_DIR: cfg.repo }, timeoutMs: 300_000 });
    logLine(cfg, `migration ${version} exit=${r.code}${r.code ? ' (non-fatal)' : ''}`);
  }
}

// ─── Render hooks ───────────────────────────────────────────────────────────
//
// Installed skills serve the gbrain render in ~/.gstack/render/claude, and its
// SKILL.md files Read section files by absolute render-tree paths. So a commit
// that reaches the durable checkout any way but a fork-sync landing (a hand
// fast-forward, a branch switch, a rebase, a cherry-pick) is not live until
// that render is rebuilt. These git hooks rebuild it. They sit in the
// repository's hooks dir, which every linked worktree shares, so each returns
// at once unless it fired in the durable checkout itself. `git reset --hard`
// fires no hook: after one, run `gstack-config gbrain-refresh` by hand.

export const RENDER_HOOKS = ['post-merge', 'post-checkout', 'post-rewrite', 'post-commit'] as const;
export const RENDER_HOOK_MARKER = 'gstack fork-sync render hook';

/** The hook file install-hooks writes: a thin shim into the checkout's own copy of this script. */
export function renderHookShim(hook: string): string {
  return [
    '#!/bin/bash',
    `# ${RENDER_HOOK_MARKER}, written by contrib/fork-sync/fork-sync.ts install-hooks.`,
    '# Rebuilds the gbrain render the installed skills serve when a landing moves the',
    '# durable checkout; other worktrees return at once. GSTACK_SKIP_RENDER_HOOK=1',
    '# disables it for one command; fork-sync.ts uninstall-hooks removes it.',
    '[ -n "${GSTACK_SKIP_RENDER_HOOK:-}" ] && exit 0',
    'script="$(git rev-parse --show-toplevel 2>/dev/null)/contrib/fork-sync/fork-sync.ts"',
    '# A checkout whose copy predates render-hook (an older fork worktree) stays silent.',
    'grep -q "render-hook" "$script" 2>/dev/null || exit 0',
    'command -v bun >/dev/null 2>&1 || { echo "gstack render hook: bun is not on PATH, so the live render was not rebuilt. Run: gstack-config gbrain-refresh" >&2; exit 0; }',
    `exec bun "$script" render-hook ${hook} "$@"`,
    '',
  ].join('\n');
}

export interface RenderHookFacts {
  hook: string;
  args: string[];
  /** The hook fired in the main worktree the live link resolves to. */
  atLive: boolean;
  /** A rebase is mid-flight (rebase-merge or rebase-apply exists). */
  rebasing: boolean;
  /** Lines left in the sequencer todo, the current pick included; null outside a pick or revert sequence. */
  picksLeft: number | null;
}

/**
 * Why a hook should NOT rebuild the render, or null when it should. Measured
 * on git 2.55: a rebase fires post-checkout and every post-commit with
 * rebase-merge present, then post-rewrite once; a ranged cherry-pick fires
 * post-commit per pick while sequencer/todo still lists the current pick, so
 * the last pick sees exactly one line; an amend fires post-commit and then
 * post-rewrite. Each landing therefore rebuilds once, at its end.
 */
export function renderHookSkip(f: RenderHookFacts): string | null {
  if (!f.atLive) return 'not the durable checkout';
  switch (f.hook) {
    case 'post-merge':
      return f.args[0] === '1' ? 'squash merge: HEAD did not move' : null;
    case 'post-checkout':
      if (f.args[2] !== '1') return 'file checkout';
      if (f.args[0] === f.args[1]) return 'HEAD did not move';
      return f.rebasing ? 'rebase in progress: post-rewrite rebuilds when it ends' : null;
    case 'post-rewrite':
      return f.args[0] === 'rebase' ? null : 'amend: post-commit already rebuilt';
    case 'post-commit':
      if (f.rebasing) return 'rebase in progress: post-rewrite rebuilds when it ends';
      if (f.picksLeft !== null && f.picksLeft > 1) return `${f.picksLeft - 1} more pick(s) to go`;
      return null;
    default:
      return `not a render hook: ${f.hook}`;
  }
}

/** Runs inside a git hook, in whichever worktree fired it. Never fails the git command. */
function renderHook(cfg: Config, hook: string, args: string[]): number {
  if (process.env.GSTACK_SKIP_RENDER_HOOK) return 0;
  const here = (...a: string[]) => sh('git', a, { timeoutMs: 30_000 }).stdout;
  const top = here('rev-parse', '--show-toplevel');
  if (!top) return 0;
  // An empty answer must stay empty: resolved, it would name the cwd.
  const resolved = (p: string) => (p ? path.resolve(process.cwd(), p) : '');
  const gitPath = (p: string) => resolved(here('rev-parse', '--git-path', p));
  const gitDir = realpathOrNull(here('rev-parse', '--absolute-git-dir'));
  const commonDir = realpathOrNull(resolved(here('rev-parse', '--git-common-dir')));
  let picksLeft: number | null = null;
  try {
    picksLeft = fs.readFileSync(gitPath('sequencer/todo') || '/nonexistent', 'utf8').split('\n')
      .filter((l) => l.trim() && !l.trimStart().startsWith('#')).length;
  } catch { /* no pick or revert sequence */ }
  const skip = renderHookSkip({
    hook, args, picksLeft,
    atLive: samePath(top, cfg.liveLink, fsResolve).same === true && gitDir !== null && gitDir === commonDir,
    rebasing: [gitPath('rebase-merge'), gitPath('rebase-apply')].some((d) => d !== '' && fs.existsSync(d)),
  });
  if (skip) return 0;
  console.error(`gstack render hook (${hook}): the live checkout is now at ${here('rev-parse', '--short', 'HEAD')}; rebuilding the render its skills serve.`);
  // The refresh inspects the install as its own repository; the hook's GIT_*
  // variables describe the worktree that fired it.
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|PREFIX|OBJECT_DIRECTORY)$/.test(k)) delete env[k];
  const r = spawnSync('/bin/bash', ['-c', fill(cfg.renderCmd, { live: cfg.liveLink })], {
    cwd: top, env, stdio: 'inherit', timeout: cfg.stepTimeoutMs,
  });
  if (r.status !== 0) {
    console.error(`gstack render hook: the refresh ${r.status === null ? 'was killed' : `exited ${r.status}`}; `
      + `the previous render is still live. Run: ${cfg.liveLink}/bin/gstack-config gbrain-refresh`);
  }
  return 0;
}

function hooksDir(cfg: Config): string {
  return path.resolve(cfg.repo, gitOk(cfg.repo, 'rev-parse', '--git-path', 'hooks'));
}

function renderHooksInstalled(cfg: Config): number {
  try {
    const dir = hooksDir(cfg);
    return RENDER_HOOKS.filter((h) => {
      try { return fs.readFileSync(path.join(dir, h), 'utf8').includes(RENDER_HOOK_MARKER); } catch { return false; }
    }).length;
  } catch { return 0; }
}

function installHooks(cfg: Config, args: string[]): number {
  if (args.includes('--print')) { process.stdout.write(renderHookShim('post-merge')); return 0; }
  // A hooksPath dir is usually shared by every repository on the machine.
  const shared = git(cfg.repo, 'config', '--get', 'core.hooksPath').stdout;
  if (shared) {
    console.error(`core.hooksPath is set (${shared}), so hooks there run for other repositories too. Not writing render hooks; `
      + `chain "bun ${path.join(cfg.repo, 'contrib', 'fork-sync', 'fork-sync.ts')} render-hook <hook> \\"$@\\"" from yours instead.`);
    return 1;
  }
  const dir = hooksDir(cfg);
  fs.mkdirSync(dir, { recursive: true });
  let kept = 0;
  for (const hook of RENDER_HOOKS) {
    const file = path.join(dir, hook);
    let present = false;
    try { fs.lstatSync(file); present = true; } catch { /* free */ }
    let ours = false;
    try { ours = fs.readFileSync(file, 'utf8').includes(RENDER_HOOK_MARKER); } catch { /* absent or dangling */ }
    if (present && !ours) {
      console.error(`kept ${file}: a hook you own is already there. Add this line to it to chain the render hook:\n`
        + `  bun "${path.join(cfg.repo, 'contrib', 'fork-sync', 'fork-sync.ts')}" render-hook ${hook} "$@"`);
      kept += 1;
      continue;
    }
    fs.writeFileSync(file, renderHookShim(hook), { mode: 0o755 });
    fs.chmodSync(file, 0o755);
    console.log(`installed ${file}`);
  }
  return kept ? 1 : 0;
}

function uninstallHooks(cfg: Config): number {
  const dir = hooksDir(cfg);
  for (const hook of RENDER_HOOKS) {
    const file = path.join(dir, hook);
    try {
      if (fs.readFileSync(file, 'utf8').includes(RENDER_HOOK_MARKER)) { fs.rmSync(file); console.log(`removed ${file}`); }
    } catch { /* absent */ }
  }
  return 0;
}

// ─── Status and LaunchAgent ─────────────────────────────────────────────────

function agentLoaded(): boolean {
  const uid = process.getuid?.() ?? 0;
  return sh('launchctl', ['print', `gui/${uid}/${AGENT_LABEL}`], { timeoutMs: 10_000 }).code === 0;
}

export function status(cfg: Config, mode: 'brief' | 'json' | 'full'): string {
  const state = loadState(cfg);
  if (mode === 'json') return JSON.stringify({ ...state, agentLoaded: agentLoaded() }, null, 2);
  const last = state.lastRun as { at?: string; outcome?: string; detail?: string } | undefined;
  const when = last?.at ? new Date(last.at).toLocaleString() : 'never';
  const agent = agentLoaded() ? `scheduled (${AGENT_LABEL})` : 'NOT scheduled';
  const brief = `fork-sync: ${agent}; last run ${when}: ${last?.outcome ?? 'none'}`
    + (state.blocked ? ` — STOPPED (${state.blocked.reason}), needs a human` : '');
  if (mode === 'brief') return brief;
  const hooks = renderHooksInstalled(cfg);
  const hookLine = hooks === RENDER_HOOKS.length ? `  render hooks: installed (${hooks}/${RENDER_HOOKS.length})`
    : `  render hooks: ${hooks}/${RENDER_HOOKS.length} installed; hand landings will not rebuild the live render (run install-hooks)`;
  return [brief, last?.detail ? `  ${last.detail}` : '', hookLine, `  state: ${path.join(cfg.stateDir, 'state.json')}`,
    `  log:   ${path.join(cfg.stateDir, 'fork-sync.log')}`].filter(Boolean).join('\n');
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Every six hours at :47, off the :00/:20/:40 marks other agents on this box use. */
export const AGENT_HOURS = [2, 8, 14, 20];

export function renderPlist(cfg: Config, bunPath: string, scriptPath: string, notifyCmd: string | null): string {
  const home = process.env.HOME ?? os.homedir();
  const envPath = [path.dirname(bunPath), '/opt/homebrew/bin', path.join(home, '.local', 'bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const envEntries: Array<[string, string]> = [['PATH', envPath], ['HOME', home]];
  if (notifyCmd) envEntries.push(['FORK_SYNC_NOTIFY', notifyCmd]);
  const logFile = path.join(cfg.stateDir, 'launchd.log');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<!-- gstack fork-sync: rebases the fork install onto upstream, gates it, lands it.',
    `     Rendered by ${xml(scriptPath)} install-agent. RunAtLoad is false: loading never lands anything. -->`,
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xml(bunPath)}</string>`,
    `    <string>${xml(scriptPath)}</string>`,
    '    <string>run</string>',
    '    <string>--scheduled</string>',
    '  </array>',
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    ...envEntries.map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`),
    '  </dict>',
    '  <key>StartCalendarInterval</key>',
    '  <array>',
    ...AGENT_HOURS.map((h) => `    <dict><key>Hour</key><integer>${h}</integer><key>Minute</key><integer>47</integer></dict>`),
    '  </array>',
    '  <key>Nice</key><integer>5</integer>',
    `  <key>StandardOutPath</key><string>${xml(logFile)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(logFile)}</string>`,
    '  <key>RunAtLoad</key><false/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function installAgent(cfg: Config, args: string[]): number {
  const print = args.includes('--print');
  const ni = args.indexOf('--notify');
  const notifyCmd = ni >= 0 ? args[ni + 1] : cfg.notifyCmd;
  const scriptPath = path.join(cfg.repo, 'contrib', 'fork-sync', 'fork-sync.ts');
  // The agent must run the DURABLE checkout's copy, which updates with every
  // landing. Pointing launchd into a worktree would dangle once it is reaped.
  const own = samePath(SELF, scriptPath, fsResolve);
  if (own.same !== true && !args.includes('--allow-foreign')) {
    console.error(`install-agent must run from the durable checkout's copy (${scriptPath}), not ${SELF}. (${own.detail})`);
    return 1;
  }
  if (notifyCmd && !fs.existsSync(notifyCmd)) { console.error(`notifier not found: ${notifyCmd}`); return 1; }
  const plist = renderPlist(cfg, process.execPath, scriptPath, notifyCmd);
  if (print) { process.stdout.write(plist); return 0; }
  const home = process.env.HOME ?? os.homedir();
  const target = path.join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
  fs.mkdirSync(cfg.stateDir, { recursive: true });
  fs.writeFileSync(target, plist);
  const uid = process.getuid?.() ?? 0;
  sh('launchctl', ['bootout', `gui/${uid}/${AGENT_LABEL}`]);
  const b = sh('launchctl', ['bootstrap', `gui/${uid}`, target]);
  if (b.code !== 0) { console.error(`launchctl bootstrap failed: ${b.stderr}`); return 1; }
  console.log(`installed ${target}; runs at ${AGENT_HOURS.map((h) => `${String(h).padStart(2, '0')}:47`).join(', ')}`);
  return 0;
}

function uninstallAgent(): number {
  const uid = process.getuid?.() ?? 0;
  sh('launchctl', ['bootout', `gui/${uid}/${AGENT_LABEL}`]);
  const home = process.env.HOME ?? os.homedir();
  fs.rmSync(path.join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`), { force: true });
  console.log(`removed ${AGENT_LABEL}`);
  return 0;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'run': return (await run(parseArgs(rest))).exitCode;
      case 'status': {
        const mode = rest.includes('--json') ? 'json' : rest.includes('--brief') ? 'brief' : 'full';
        console.log(status(parseArgs(rest.filter((a) => a !== '--json' && a !== '--brief')), mode));
        return 0;
      }
      case 'install-agent': {
        const own = new Set(['--print', '--allow-foreign']);
        const ni = rest.indexOf('--notify');
        const cfgArgs = rest.filter((a, i) => !own.has(a) && i !== ni && i !== ni + 1);
        return installAgent(parseArgs(cfgArgs), rest);
      }
      case 'uninstall-agent': return uninstallAgent();
      case 'install-hooks': return installHooks(parseArgs(rest.filter((a) => a !== '--print')), rest);
      case 'uninstall-hooks': return uninstallHooks(parseArgs(rest));
      // Called by the hook shims with git's own hook arguments, which are not flags.
      case 'render-hook': return renderHook(defaultConfig(), rest[0] ?? '', rest.slice(1));
      default:
        console.log('usage: fork-sync.ts run [--dry-run] [--no-land] [--force] [--ignore-load] | status [--brief|--json] | install-agent [--print] [--notify <path>] | uninstall-agent | install-hooks [--print] | uninstall-hooks');
        return command ? 1 : 0;
    }
  } catch (err) {
    console.error(`fork-sync: ${(err as Error).message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
