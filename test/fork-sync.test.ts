/**
 * contrib/fork-sync — the job that keeps a fork install (our commits carried
 * on upstream) current. Unit tests pin the pure pieces; the end-to-end tests
 * drive the real script against sandbox upstream/origin/durable repos with
 * fake suite, setup, proof and notify commands, and assert the one property
 * that matters most: every STOP leaves the live checkout exactly as it was.
 */
import { describe, test, expect } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  compareVersions, droppedSubjects, fill, gateCandidates, landingBranchName, nameList,
  fsResolve, oursOnlyUnattributed, parseSuiteLog, renderPlist, samePath, suiteComplete, unvouchedFiles, worktreeKind, defaultConfig,
  RENDER_HOOKS, RENDER_HOOK_MARKER, renderHookShim, renderHookSkip,
} from '../contrib/fork-sync/fork-sync';

const ROOT = path.resolve(import.meta.dir, '..');
const SCRIPT = path.join(ROOT, 'contrib', 'fork-sync', 'fork-sync.ts');
// POSIX-only on purpose: the fixtures are bash scripts.
const BASH = '/bin/bash';
// A sandbox test takes ~10s, but a loaded box stalls file I/O for minutes at
// a time (measured: one fixture build 8s, the same build 122s ten minutes
// later). The ceiling is for a wedge, not for a slow disk.
const E2E_TIMEOUT = 600_000;

// ─── Pure pieces ────────────────────────────────────────────────────────────

describe('landingBranchName', () => {
  test('follows the fork convention <stem>-<upstream version>', () => {
    expect(landingBranchName('feat/pr-prep-skill-1.89.1', '1.91.1.0', '2a113ae7e623')).toBe('feat/pr-prep-skill-1.91.1');
    expect(landingBranchName('feat/x', '1.2.0.0', 'abc12345')).toBe('feat/x-1.2.0');
    expect(landingBranchName('feat/x-1.2.0', '1.2.3.4', 'abc12345')).toBe('feat/x-1.2.3.4');
  });

  test('upstream moving without a VERSION bump gets a sha suffix, and that suffix is re-stemmed', () => {
    expect(landingBranchName('feat/x-1.2.0', '1.2.0.0', 'abcdef0123456')).toBe('feat/x-1.2.0-uabcdef01');
    expect(landingBranchName('feat/x-1.2.0-uabcdef01', '1.3.0.0', '1234567890')).toBe('feat/x-1.3.0');
  });
});

describe('suite log parsing', () => {
  const log = [
    '[test:free] full suite: 9 files across 2 shard processes (duration-packed)',
    '[test:free] shard 1/2: 5 files, 30s, fail',
    '[test:free] FAIL — 2 failing test(s) in 2 file(s), 1 crashed worker(s). Full log: /x',
    '  ✗ test/a.test.ts — alpha > does a thing',
    '  ✗ (unattributed) — mystery',
    '  ⚠ crashed+retried: test/c.test.ts',
    '[test:free] shard 2/2: 4 files, 20s, pass',
  ].join('\n');

  test('collects failures, crashes and shard completion', () => {
    const r = parseSuiteLog(log);
    expect([...r.failures]).toEqual(['test/a.test.ts — alpha > does a thing', '(unattributed) — mystery']);
    expect([...r.failingFiles]).toEqual(['test/a.test.ts']);
    expect(r.unattributed).toBe(1);
    expect([...r.crashed]).toEqual(['test/c.test.ts']);
    expect(suiteComplete(r)).toBe(true);
  });

  test('a timed-out or missing shard makes the run incomplete', () => {
    expect(suiteComplete(parseSuiteLog(log.replace('20s, pass', '20s, timed-out')))).toBe(false);
    expect(suiteComplete(parseSuiteLog(log.replace('[test:free] shard 2/2: 4 files, 20s, pass', '')))).toBe(false);
    expect(suiteComplete(parseSuiteLog('no epilogue at all'))).toBe(false);
    // A shard killed by a signal still prints its epilogue line, but did not run every file.
    expect(suiteComplete(parseSuiteLog(`[test:free] shard 2/2 failed with exit code signal\n${log}`))).toBe(false);
    expect(suiteComplete(parseSuiteLog(`[test:free] shard 2/2 exited 0 but never printed the summary. Treating as FAILED.\n${log}`))).toBe(false);
    // An ordinary failing shard (exit 1) is complete.
    expect(suiteComplete(parseSuiteLog(`[test:free] shard 1/2 failed with exit code 1\n${log}`))).toBe(true);
  });

  test('failures reported without named result lines count as unattributed failures', () => {
    const line = '  ⚠ 3 failure(s) reported without named result lines';
    const ours = parseSuiteLog(`${log}\n${line}`);
    expect(ours.failures.has('(unattributed) — 3 failure(s) reported without named result lines')).toBe(true);
    expect(ours.unattributed).toBe(4);
    expect(suiteComplete(ours)).toBe(true);
    expect(oursOnlyUnattributed(ours, parseSuiteLog(log))).toBe(1);
    expect(oursOnlyUnattributed(ours, ours)).toBe(0);
  });

  test('a shard that lost output capture is abnormal and never vouched from its accounting', () => {
    // The runner line for an exit-0 shard whose stdout pipe closed before end.
    // Its summary counted every file, but failure lines may be what was lost.
    const r = parseSuiteLog([
      '[test:free] shard 1/1 plan: test/x.test.ts test/y.test.ts',
      '[test:free] shard 1/1 output capture was incomplete (stdout), so its failure list may be short. Treating as FAILED. (summary: 2/2 files)',
      '[test:free] shard 1/1: 2 files, 30s, fail',
    ].join('\n'));
    expect([...r.captureLost]).toEqual([1]);
    expect([...r.abnormal]).toEqual([1]);
    expect(suiteComplete(r)).toBe(false);
    expect(unvouchedFiles(r).files).toEqual(['test/x.test.ts', 'test/y.test.ts']);
    // The same shard without the capture line is vouched by its accounting.
    const fine = parseSuiteLog([
      '[test:free] shard 1/1 plan: test/x.test.ts test/y.test.ts',
      '[test:free] shard 1/1 exited 0 but reported 1 failing test(s) and 0 unhandled error(s) between tests. Treating as FAILED. (summary: 2/2 files)',
      '[test:free] shard 1/1: 2 files, 30s, fail',
    ].join('\n'));
    expect(unvouchedFiles(fine).files).toEqual([]);
  });

  test('an unhandled error between tests counts as an unattributed failure', () => {
    // The preload's exit guard makes a leaked process.exit an unhandled error: the
    // shard finishes, exits 1 and stays complete, so this line is all that is left.
    const line = '  ⚠ unhandled error between tests (around test/b.test.ts)';
    const ours = parseSuiteLog(`${log}\n${line}`);
    expect(ours.failures.has('(unattributed) — unhandled error between tests (around test/b.test.ts)')).toBe(true);
    expect(ours.unattributed).toBe(2);
    expect([...ours.failingFiles]).toEqual(['test/a.test.ts']);
    expect(suiteComplete(ours)).toBe(true);
    // Ours-only: the gate cannot vouch for it. Shared with the base: it cancels out.
    expect(oursOnlyUnattributed(ours, parseSuiteLog(log))).toBe(1);
    expect(oursOnlyUnattributed(ours, ours)).toBe(0);
    // Two around the same file on our side against one on the base: one is ours.
    const twice = parseSuiteLog(`${log}\n${line}\n${line}`);
    expect(oursOnlyUnattributed(twice, ours)).toBe(1);
    const nested = parseSuiteLog('  ⚠ unhandled error between tests (around private/var/folders/qh/x/T/gstack-free-shard-AB/tmp/q-1/r.test.ts)');
    expect([...nested.failures]).toEqual(['(unattributed) — unhandled error between tests (around (nested)/r.test.ts)']);
  });

  test('nested fixture runs report temp paths; those compare by basename and are never isolated', () => {
    const ours = parseSuiteLog('  ✗ private/var/folders/qh/x/T/gstack-free-shard-AB/tmp/auq-parallel-free-KQ/registration.test.ts — t');
    const base = parseSuiteLog('  ✗ private/var/folders/qh/x/T/gstack-free-shard-ZZ/tmp/auq-parallel-free-YY/registration.test.ts — t');
    expect([...ours.failures]).toEqual(['(nested)/registration.test.ts — t']);
    expect([...ours.failingFiles]).toEqual([]);
    expect(gateCandidates(ours, base, [])).toEqual([]);
    expect(gateCandidates(ours, parseSuiteLog(''), [])).toEqual([]);
  });

  // The defect this pins, measured 2026-09-27 on run 20260927-181603: shard 2
  // of 6 was truncated on BOTH trees, so test/ceo-mode-preference-al.test.ts
  // produced no line on either side, landed in neither `regressions` nor
  // `baseline`, and `regressions=0` read as "nothing broke" over a set that
  // excluded it. Run directly, that file failed.
  test('an unfinished shard leaks its whole planned set: the run cannot vouch for those files', () => {
    const r = parseSuiteLog([
      '[test:free] full suite: 4 files across 2 shard processes (duration-packed)',
      '[test:free] shard 1/2 plan: test/a.test.ts test/quiet.test.ts',
      '[test:free] shard 2/2 plan: test/never-reached.test.ts test/reported.test.ts',
      '[test:free] shard 1/2: 2 files, 30s, pass',
      '[test:free] shard 2/2 exited 0 but never printed bun\'s terminal summary — the run was truncated. Treating as FAILED.',
      '[test:free] shard 2/2: 2 files, 65s, fail',
      '  ✗ test/reported.test.ts — got as far as failing',
    ].join('\n'));
    expect(r.plans.get(1)).toEqual(['test/a.test.ts', 'test/quiet.test.ts']);
    expect(suiteComplete(r)).toBe(false);
    const un = unvouchedFiles(r);
    // Shard 1 finished, so its files are vouched for — including the one that
    // passed quietly. Shard 2 did not, so its files are not; the file that got
    // as far as printing a failure is left to the comparative verdict.
    expect(un.files).toEqual(['test/never-reached.test.ts']);
    expect(un.shards).toEqual([2]);
    expect(un.unnamedShards).toEqual([]);
  });

  test('a complete run has nothing unvouched, however red it is', () => {
    const r = parseSuiteLog([
      '[test:free] shard 1/1 plan: test/a.test.ts test/b.test.ts',
      '[test:free] shard 1/1 failed with exit code 1',
      '[test:free] shard 1/1: 2 files, 30s, fail',
      '  ✗ test/a.test.ts — red',
    ].join('\n'));
    expect(suiteComplete(r)).toBe(true);
    expect(unvouchedFiles(r)).toEqual({ files: [], shards: [], unnamedShards: [] });
  });

  test('a timed-out shard is unvouched, and one with no plan line at all is named as unnameable', () => {
    const timedOut = parseSuiteLog([
      '[test:free] shard 1/2 plan: test/a.test.ts',
      '[test:free] shard 2/2 plan: test/slow.test.ts',
      '[test:free] shard 1/2: 1 files, 5s, pass',
      '[test:free] shard 2/2: 1 files, 3600s, timed-out',
    ].join('\n'));
    expect(unvouchedFiles(timedOut)).toEqual({ files: ['test/slow.test.ts'], shards: [2], unnamedShards: [] });

    // The whole-suite wall can fire before a shard prints anything: its plan
    // is missing, so its files cannot be named and the verdict must say so
    // rather than report an empty unrun set as "nothing to worry about".
    const noPlan = parseSuiteLog([
      '[test:free] shard 1/2 plan: test/a.test.ts',
      '[test:free] shard 1/2: 1 files, 5s, pass',
    ].join('\n'));
    expect(unvouchedFiles(noPlan)).toEqual({ files: [], shards: [2], unnamedShards: [2] });
  });

  // Sharpened 2026-09-28 (TODOS P3). The runner now states its terminal
  // summary's file accounting on EVERY abnormal line, so the ambiguity that
  // forced this set to surrender a whole shard on any abnormal verdict is
  // gone: a shard whose summary accounted for its full planned count DID run
  // its files, whatever its exit code claimed. The run stays incomplete
  // either way — only the FILE surrender narrows.
  const abnormalShard = (line: string, plan = 'test/x.test.ts test/y.test.ts', epilogue = '[test:free] shard 2/2: 2 files, 30s, fail') => parseSuiteLog([
    '[test:free] shard 1/2 plan: test/a.test.ts',
    `[test:free] shard 2/2 plan: ${plan}`,
    '[test:free] shard 1/2: 1 files, 5s, pass',
    line,
    epilogue,
  ].join('\n'));
  const NOTHING_UNVOUCHED = { files: [], shards: [], unnamedShards: [] };
  const SURRENDERED = { files: ['test/x.test.ts', 'test/y.test.ts'], shards: [2], unnamedShards: [] };

  test('a full accounting vouches for the files of a shard that only lied about its exit code', () => {
    // The measured shard-4 shape: 2123s, 178 files, 101 failing tests, exit 0.
    const r = abnormalShard("[test:free] shard 2/2 exited 0 but reported 3 failing test(s) and 0 unhandled error(s) between tests. Treating as FAILED. (summary: 2/2 files)");
    expect(unvouchedFiles(r)).toEqual(NOTHING_UNVOUCHED);
    // Naming fewer files must not turn an incomplete run into a complete one.
    expect(suiteComplete(r)).toBe(false);
  });

  test('a full accounting on a signal-killed shard vouches for it too', () => {
    const r = abnormalShard('[test:free] shard 2/2 failed with exit code signal (summary: 2/2 files)');
    expect(unvouchedFiles(r)).toEqual(NOTHING_UNVOUCHED);
    expect(suiteComplete(r)).toBe(false);
  });

  test("a nested run's extra summary does not spoil the accounting: any count matching the plan vouches", () => {
    const r = abnormalShard('[test:free] shard 2/2 failed with exit code signal (summary: 1,2/2 files)');
    expect(unvouchedFiles(r)).toEqual(NOTHING_UNVOUCHED);
  });

  test('a SHORT accounting stays unvouched — the shard stopped early', () => {
    const r = abnormalShard("[test:free] shard 2/2 exited 0 but reported 1 failing test(s) and 0 unhandled error(s) between tests. Treating as FAILED. (summary: 1/2 files)");
    expect(unvouchedFiles(r)).toEqual(SURRENDERED);
  });

  test('an ABSENT accounting stays unvouched — no summary is not a count of zero', () => {
    const r = abnormalShard("[test:free] shard 2/2 exited 0 but never printed bun's terminal summary — the run was truncated (a process.exit fired mid-suite). Treating as FAILED. (summary: none/2 files)");
    expect(unvouchedFiles(r)).toEqual(SURRENDERED);
  });

  test('a line with NO accounting at all stays unvouched (an older runner, or a truncated line)', () => {
    const r = abnormalShard("[test:free] shard 2/2 exited 0 but reported 1 failing test(s) and 0 unhandled error(s) between tests. Treating as FAILED.");
    expect(unvouchedFiles(r)).toEqual(SURRENDERED);
  });

  test('an UNPARSEABLE accounting stays unvouched — a parsing miss must never vouch', () => {
    for (const token of ['(summary: ?/2 files)', '(summary: 2/2)', '(summary: two/2 files)', '(summary: 2 of 2 files)', '(summary: /2 files)']) {
      const r = abnormalShard(`[test:free] shard 2/2 failed with exit code signal ${token}`);
      expect(unvouchedFiles(r)).toEqual(SURRENDERED);
    }
  });

  test('an accounting that disagrees with the plan it is paired with is distrusted', () => {
    // The line claims 3 planned files, the plan line names 2. One of the two
    // is a log we do not understand, so neither is trusted.
    const r = abnormalShard('[test:free] shard 2/2 failed with exit code signal (summary: 3/3 files)');
    expect(unvouchedFiles(r)).toEqual(SURRENDERED);
  });

  test('a timed-out shard is never vouched for, however full its accounting', () => {
    // A wall-clock kill is not a run that reported itself finished: the
    // runner refuses to grade it, and so does this.
    const r = abnormalShard(
      '[test:free] shard 2/2 exceeded the 3600s wall-clock deadline — killed the process group. Reporting as TIMED-OUT (distinct from failed). (summary: 2/2 files)',
      'test/x.test.ts test/y.test.ts',
      '[test:free] shard 2/2: 2 files, 3600s, timed-out',
    );
    expect(unvouchedFiles(r)).toEqual(SURRENDERED);
  });

  test('a vouched shard still surrenders nothing while an unvouched sibling surrenders its own', () => {
    const r = parseSuiteLog([
      '[test:free] shard 1/2 plan: test/a.test.ts test/b.test.ts',
      '[test:free] shard 2/2 plan: test/x.test.ts test/y.test.ts',
      '[test:free] shard 1/2 exited 0 but reported 2 failing test(s) and 0 unhandled error(s) between tests. Treating as FAILED. (summary: 2/2 files)',
      '[test:free] shard 1/2: 2 files, 30s, fail',
      '  ✗ test/a.test.ts — red',
      "[test:free] shard 2/2 exited 0 but never printed bun's terminal summary. Treating as FAILED. (summary: none/2 files)",
      '[test:free] shard 2/2: 2 files, 10s, fail',
    ].join('\n'));
    expect(unvouchedFiles(r)).toEqual(SURRENDERED);
  });

  test('a suite that printed no shard line at all names no shard and no file', () => {
    const r = parseSuiteLog('bun: command not found');
    expect(suiteComplete(r)).toBe(false);
    expect(r.shardTotal).toBe(0);
    // Nothing to enumerate: there is no shard count and no plan. The verdict
    // has to say the plan itself is missing, which judge() does from this.
    expect(unvouchedFiles(r)).toEqual({ files: [], shards: [], unnamedShards: [] });
  });

  test('nameList bounds what a log line or a notification carries', () => {
    expect(nameList(['a', 'b'], 3)).toBe('a, b');
    expect(nameList(['a', 'b', 'c', 'd'], 3)).toBe('a, b, c and 1 more');
  });

  test('gate candidates: ours-only failures and crashes, plus touched tests failing anywhere', () => {
    const ours = parseSuiteLog(['  ✗ test/a.test.ts — x', '  ✗ test/b.test.ts — y', '  ✗ test/t.test.ts — z', '  ⚠ crashed+retried: test/c.test.ts'].join('\n'));
    const base = parseSuiteLog(['  ✗ test/b.test.ts — y', '  ✗ test/t.test.ts — z'].join('\n'));
    expect(gateCandidates(ours, base, [])).toEqual(['test/a.test.ts', 'test/c.test.ts']);
    // test/t.test.ts is red on both sides, but our commits touch it: a red
    // baseline must not hide a regression there.
    expect(gateCandidates(ours, base, ['test/t.test.ts'])).toEqual(['test/a.test.ts', 'test/c.test.ts', 'test/t.test.ts']);
  });
});

describe('worktreeKind', () => {
  const stub = (map: Record<string, string | Error>) => (p: string) => {
    const v = map[p];
    return v instanceof Error ? { path: p, real: null, why: v.message } : { path: p, real: v, why: '' };
  };

  test('a main worktree resolves both paths to the same place', () => {
    expect(worktreeKind('/r/.git', '/r/.git', stub({ '/r/.git': '/real/r/.git' })))
      .toEqual({ kind: 'main', detail: '/real/r/.git' });
  });

  test('a linked worktree is a RESOLVED mismatch', () => {
    const k = worktreeKind('/r/.git/worktrees/w', '/r/.git', stub({
      '/r/.git/worktrees/w': '/real/r/.git/worktrees/w', '/r/.git': '/real/r/.git',
    }));
    expect(k.kind).toBe('linked');
  });

  // The defect: a path that could not be STATTED used to compare as null
  // against a real path and be reported as a linked worktree — a loud,
  // memoised claim about the repo layout that nothing had established, and
  // unfalsifiable afterwards because the fs error was swallowed.
  test('a path that cannot be resolved says so, and is never read as linked', () => {
    const k = worktreeKind('/r/.git', '/r/.git', stub({ '/r/.git': new Error('EMFILE: too many open files') }));
    expect(k.kind).toBe('unresolved');
    expect(k.detail).toContain('EMFILE');
    expect(k.detail).toContain('/r/.git');
  });

  // `[a, b].map(resolve)` hands the callback (element, INDEX, ARRAY). A
  // resolver with optional parameters — fsResolve takes an injectable realpath,
  // an attempt count and a sleep — then receives 0 and the array in them and
  // silently reports both paths unresolvable with no reason. Measured: it turned
  // the real linked-worktree STOP into `cannot resolve ... (); ... ()`.
  test('the resolver is called with the path and nothing else', () => {
    const arity: number[] = [];
    const resolver = (...args: unknown[]) => {
      arity.push(args.length);
      return { path: String(args[0]), real: '/same', why: '' };
    };
    expect(worktreeKind('/a', '/b', resolver).kind).toBe('main');
    expect(arity).toEqual([1, 1]);
  });

  test('one side unresolvable is unresolved, not linked', () => {
    const k = worktreeKind('/a/.git', '/b/.git', stub({ '/a/.git': '/real/a/.git', '/b/.git': new Error('ENOENT') }));
    expect(k.kind).toBe('unresolved');
    expect(k.detail).toContain('/b/.git');
  });
});

// The swallow `worktreeKind` was extracted to kill survived in the three
// live-link comparisons, which still read `realpathOrNull(a) !== realpathOrNull(b)`.
// Both directions are wrong and the SECOND is the dangerous one: two
// unresolvable paths compared EQUAL, so a pairing nothing could stat was
// vouched for as correct and the run proceeded.
describe('samePath', () => {
  const stub = (map: Record<string, string | Error>) => (p: string) => {
    const v = map[p];
    return v instanceof Error ? { path: p, real: null, why: v.message } : { path: p, real: v, why: '' };
  };

  test('two paths that resolve to one place are the same, and say where', () => {
    const r = samePath('/link', '/repo', stub({ '/link': '/real/repo', '/repo': '/real/repo' }));
    expect(r.same).toBe(true);
    expect(r.detail).toContain('/real/repo');
  });

  test('a resolved mismatch is a mismatch, and names both sides', () => {
    const r = samePath('/link', '/repo', stub({ '/link': '/real/elsewhere', '/repo': '/real/repo' }));
    expect(r.same).toBe(false);
    expect(r.detail).toContain('/real/elsewhere');
    expect(r.detail).toContain('/real/repo');
  });

  test('an unresolvable side is neither same nor different: null, with the reason', () => {
    const one = samePath('/link', '/repo', stub({ '/link': new Error('ENOENT: no such file'), '/repo': '/real/repo' }));
    expect(one.same).toBeNull();
    expect(one.detail).toContain('/link');
    expect(one.detail).toContain('ENOENT');
    // Both unresolvable is the direction that used to compare EQUAL.
    const both = samePath('/link', '/repo', stub({ '/link': new Error('EMFILE'), '/repo': new Error('EMFILE') }));
    expect(both.same).toBeNull();
    expect(both.detail).toContain('/link');
    expect(both.detail).toContain('/repo');
  });

  test('the resolver is called with the path and nothing else', () => {
    const arity: number[] = [];
    const resolver = (...args: unknown[]) => {
      arity.push(args.length);
      return { path: String(args[0]), real: '/same', why: '' };
    };
    expect(samePath('/a', '/b', resolver).same).toBe(true);
    expect(arity).toEqual([1, 1]);
  });
});

describe('fsResolve', () => {
  const errno = (code: string, message: string): NodeJS.ErrnoException => Object.assign(new Error(message), { code });
  /** A realpath that throws the given errors in order, then returns `real`. */
  const flaky = (errs: NodeJS.ErrnoException[], real: string) => {
    const calls: string[] = [];
    let thrown = 0;
    return {
      calls,
      realpath: (p: string): string => {
        calls.push(p);
        if (thrown < errs.length) { thrown += 1; throw errs[thrown - 1]; }
        return real;
      },
    };
  };

  // Measured on this box (macOS 25.6, 2026-09-28): realpath needs a file
  // descriptor. `fs.realpathSync` on a path that EXISTS throws
  // `EMFILE: too many open files, lstat <path>` once the process is out of
  // descriptors, while `statSync` on the same path still succeeds. And in a
  // main checkout the two paths the precondition compares are the IDENTICAL
  // string (`--absolute-git-dir` and `path.resolve(repo, '--git-common-dir')`,
  // measured byte-identical), so the 2026-09-27 'linked worktree' verdict was
  // only reachable if one of two resolves OF ONE STRING failed. A descriptor
  // shortage that lasts a millisecond is not a fact about the repository's
  // layout, and a STOP on it is memoised until upstream or the tip moves.
  test('a descriptor shortage that clears is retried, not reported', () => {
    const f = flaky([errno('EMFILE', 'EMFILE: too many open files, lstat /r/.git')], '/real/r/.git');
    const slept: number[] = [];
    const r = fsResolve('/r/.git', f.realpath, 3, (ms) => slept.push(ms));
    expect(r.real).toBe('/real/r/.git');
    expect(r.why).toBe('');
    expect(f.calls).toHaveLength(2);
    expect(slept).toHaveLength(1);
  });

  test('a shortage that never clears reports itself, with the fs reason', () => {
    const e = errno('ENFILE', 'ENFILE: file table overflow, lstat /r/.git');
    const f = flaky([e, e, e], '/never');
    const r = fsResolve('/r/.git', f.realpath, 3, () => {});
    expect(r.real).toBeNull();
    expect(r.why).toContain('ENFILE');
    expect(f.calls).toHaveLength(3);
  });

  test('a path that is genuinely missing is answered at once, never slept on', () => {
    const f = flaky([errno('ENOENT', "ENOENT: no such file or directory, lstat '/gone'")], '/never');
    const slept: number[] = [];
    const r = fsResolve('/gone', f.realpath, 3, (ms) => slept.push(ms));
    expect(r.real).toBeNull();
    expect(r.why).toContain('ENOENT');
    expect(f.calls).toHaveLength(1);
    expect(slept).toEqual([]);
  });
});

describe('small helpers', () => {
  test('droppedSubjects is a multiset difference', () => {
    expect(droppedSubjects(['a', 'b', 'b', 'c'], ['b', 'c'])).toEqual(['a', 'b']);
    expect(droppedSubjects(['a'], ['a'])).toEqual([]);
  });

  test('compareVersions is numeric per segment', () => {
    expect(compareVersions('1.10.0.0', '1.9.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.2', '1.2.0.0')).toBe(0);
  });

  test('fill shell-quotes substituted values', () => {
    expect(fill('bun test {path}', { path: "/a b/it's.ts" })).toBe(`bun test '/a b/it'\\''s.ts'`);
    expect(fill('{unknown} stays', {})).toBe('{unknown} stays');
  });

  test('the LaunchAgent never runs at load and passes the notifier through', () => {
    const plist = renderPlist(defaultConfig(), '/opt/bun/bin/bun', '/repo/contrib/fork-sync/fork-sync.ts', '/n/iris-notify');
    expect(plist).toContain('<key>RunAtLoad</key><false/>');
    expect(plist).toContain('<string>--scheduled</string>');
    expect(plist).toContain('<key>FORK_SYNC_NOTIFY</key><string>/n/iris-notify</string>');
  });
});

describe('render hooks: when a hook rebuilds the live render', () => {
  const at = (hook: string, args: string[], extra: Partial<Parameters<typeof renderHookSkip>[0]> = {}) =>
    renderHookSkip({ hook, args, atLive: true, rebasing: false, picksLeft: null, ...extra });

  test('only the durable checkout rebuilds; every other worktree returns at once', () => {
    expect(at('post-merge', ['0'])).toBeNull();
    expect(at('post-merge', ['0'], { atLive: false })).toBe('not the durable checkout');
  });

  test('post-merge: a fast-forward or merge rebuilds, a squash (HEAD unmoved) does not', () => {
    expect(at('post-merge', ['1'])).toContain('squash');
  });

  test('post-checkout: only a branch checkout that moved HEAD, and never mid-rebase', () => {
    expect(at('post-checkout', ['a', 'b', '1'])).toBeNull();
    expect(at('post-checkout', ['a', 'a', '1'])).toBe('HEAD did not move');
    expect(at('post-checkout', ['a', 'b', '0'])).toBe('file checkout');
    expect(at('post-checkout', ['a', 'b', '1'], { rebasing: true })).toContain('rebase in progress');
  });

  test('post-rewrite: a rebase rebuilds once at its end; an amend already did in post-commit', () => {
    expect(at('post-rewrite', ['rebase'], { rebasing: true })).toBeNull();
    expect(at('post-rewrite', ['amend'])).toContain('amend');
  });

  test('post-commit: a plain commit or the last pick rebuilds; earlier picks and rebase steps wait', () => {
    expect(at('post-commit', [])).toBeNull();
    expect(at('post-commit', [], { picksLeft: 1 })).toBeNull();
    expect(at('post-commit', [], { picksLeft: 3 })).toBe('2 more pick(s) to go');
    expect(at('post-commit', [], { rebasing: true })).toContain('rebase in progress');
  });

  test('the shim is /bin/bash, skippable, marked, and hands off to the checkout\'s own copy', () => {
    for (const hook of RENDER_HOOKS) {
      const shim = renderHookShim(hook);
      expect(shim.startsWith('#!/bin/bash\n')).toBe(true);
      expect(shim).toContain(RENDER_HOOK_MARKER);
      expect(shim).toContain('[ -n "${GSTACK_SKIP_RENDER_HOOK:-}" ] && exit 0');
      expect(shim).toContain('/contrib/fork-sync/fork-sync.ts"');
      expect(shim).toContain('grep -q "render-hook" "$script" 2>/dev/null || exit 0');
      expect(shim).toContain(`render-hook ${hook} "$@"`);
    }
  });

});

describe('landing render step', () => {
  test('the default landing render step is gbrain-refresh on the live link', () => {
    expect(defaultConfig({ HOME: '/h' } as NodeJS.ProcessEnv).renderCmd).toBe('{live}/bin/gstack-config gbrain-refresh');
  });
});

describe('gstack-upgrade defers to fork-sync on fork installs', () => {
  test('Step 0 runs before the upgrade question and before any pull or discard', () => {
    for (const file of ['gstack-upgrade/SKILL.md.tmpl', 'gstack-upgrade/SKILL.md']) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const step0 = text.indexOf('### Step 0: Fork installs');
      expect(step0).toBeGreaterThan(-1);
      expect(text).toContain('contrib/fork-sync/fork-sync.ts');
      expect(step0).toBeLessThan(text.indexOf('### Step 1:'));
      expect(step0).toBeLessThan(text.indexOf("git checkout -- 'SKILL.md'"));
      // No `cd`, not even in a subshell: shell guards that keep agents out of
      // ~/.claude refuse any `cd` into it, and the live link lives there.
      expect(text.slice(step0, text.indexOf('### Step 1:'))).not.toMatch(/\bcd\s/);
    }
  });
});

// ─── End to end, against sandbox repos ──────────────────────────────────────

interface Sandbox {
  base: string; seed: string; durable: string; home: string; notifyLog: string; bin: string; env: NodeJS.ProcessEnv;
}

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', timeout: 60_000 }).trim();
}

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

function commit(dir: string, env: NodeJS.ProcessEnv, message: string, files: Record<string, string>): string {
  for (const [name, content] of Object.entries(files)) write(path.join(dir, name), content);
  git(dir, env, 'add', '-A');
  git(dir, env, 'commit', '-q', '-m', message);
  return git(dir, env, 'rev-parse', 'HEAD');
}

function makeSandbox(opts: { pushCarried?: boolean } = {}): Sandbox {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-fork-sync-')));
  const home = path.join(base, 'home');
  const bin = path.join(base, 'bin');
  const gitconfig = path.join(base, 'gitconfig');
  write(gitconfig, '[user]\n\tname = Test Author\n\temail = author@example.com\n[init]\n\tdefaultBranch = main\n');
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', FORK_SYNC_NOTIFY: '',
  };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  // All three selectors are one hazard class (test/ship-hook-refresh.test.ts
  // clears the same set): an inherited GIT_COMMON_DIR would make the sandbox's
  // own main checkout look like a linked worktree and STOP every run.
  delete env.GIT_COMMON_DIR;
  // An operator who exported GSTACK_SKIP_RENDER_HOOK for their own git command
  // would silence every render-hook shim in the sandbox, so the hook cases
  // would fail on any tree. Cases that want it opt in per command.
  delete env.GSTACK_SKIP_RENDER_HOOK;

  const notifyLog = path.join(base, 'notify.log');
  write(path.join(bin, 'notify'), `#!${BASH}\nprintf '%s\\n' "$*" >> ${JSON.stringify(notifyLog)}\n`, 0o755);
  // Fake free suite: fails every `file — test` line listed in .fake-failures.
  // .fake-plan names the files the shard was TOLD to run (the real runner's
  // `plan:` line); .fake-truncate makes the shard exit without bun's summary,
  // so those files ran without ever reporting; .fake-account makes the shard
  // abnormal but with a FULL `(summary: N/N files)` accounting — the shard
  // that ran everything and only got its exit code wrong.
  write(path.join(bin, 'suite'), [
    `#!${BASH}`,
    'n=0; [ -f .fake-failures ] && n=$(grep -c . .fake-failures)',
    'st=pass',
    '[ "$n" -gt 0 ] && st=fail',
    '[ -f .fake-truncate ] && st=fail',
    '[ -f .fake-account ] && st=fail',
    '[ -f .fake-wedge ] && st=timed-out',
    'planned=0; [ -f .fake-plan ] && planned=$(grep -c . .fake-plan)',
    'echo "[test:free] full suite: 3 files across 1 shard processes"',
    `[ -f .fake-plan ] && echo "[test:free] shard 1/1 plan: $(tr '\\n' ' ' < .fake-plan)"`,
    'if [ -f .fake-truncate ]; then',
    '  echo "[test:free] shard 1/1 exited 0 but never printed bun\'s terminal summary — the run was truncated (a process.exit fired mid-suite). Treating as FAILED. (summary: none/$planned files)"',
    'elif [ -f .fake-account ]; then',
    '  echo "[test:free] shard 1/1 exited 0 but reported 2 failing test(s) and 0 unhandled error(s) between tests. Treating as FAILED. (summary: $planned/$planned files)"',
    'fi',
    'echo "[test:free] shard 1/1: 3 files, 1s, $st"',
    'if [ "$n" -gt 0 ]; then',
    '  echo "[test:free] FAIL — $n failing test(s) in 1 file(s), 0 crashed worker(s). Full log: /dev/null"',
    '  while IFS= read -r l; do [ -n "$l" ] && echo "  ✗ $l"; done < .fake-failures',
    '  exit 1',
    'fi',
    '[ -f .fake-truncate ] && exit 1',
    '[ -f .fake-account ] && exit 1',
    'exit 0',
    '',
  ].join('\n'), 0o755);
  // Fake isolated run: fails when the tree's .fake-iso-fail lists the file.
  write(path.join(bin, 'iso'), [
    `#!${BASH}`,
    'root="$2"; rel="${1#"$root"/}"',
    'if [ -f "$root/.fake-iso-fail" ] && grep -qxF "$rel" "$root/.fake-iso-fail"; then echo "(fail) it"; exit 1; fi',
    'echo "Ran 1 test across 1 file. [1ms]"',
    '',
  ].join('\n'), 0o755);

  const upstreamBare = path.join(base, 'upstream.git');
  const originBare = path.join(base, 'origin.git');
  // --template= skips copying git's sample hooks, the slowest part of a fixture.
  git(base, env, 'init', '-q', '--template=', '--bare', upstreamBare);
  git(base, env, 'init', '-q', '--template=', '--bare', originBare);
  const seed = path.join(base, 'seed');
  fs.mkdirSync(seed);
  git(seed, env, 'init', '-q', '--template=');
  commit(seed, env, 'v1.0.0.0 initial', { VERSION: '1.0.0.0\n', 'a.txt': 'line one\nline two\n' });
  git(seed, env, 'remote', 'add', 'upstream', upstreamBare);
  git(seed, env, 'push', '-q', 'upstream', 'main');
  git(seed, env, 'push', '-q', originBare, 'main');

  const durable = path.join(base, 'durable');
  git(base, env, 'clone', '-q', '--template=', originBare, durable);
  git(durable, env, 'remote', 'add', 'upstream', upstreamBare);
  git(durable, env, 'fetch', '-q', 'upstream');
  git(durable, env, 'switch', '-q', '-c', 'feat/x-1.0.0', 'upstream/main');
  commit(durable, env, 'feat: ours one', { 'ours1.txt': 'one\n' });
  commit(durable, env, 'feat: ours two', { 'ours2.txt': 'two\n' });
  if (opts.pushCarried !== false) git(durable, env, 'push', '-q', '-u', 'origin', 'feat/x-1.0.0');

  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync(durable, path.join(home, '.claude', 'skills', 'gstack'));
  return { base, seed, durable, home, notifyLog, bin, env };
}

/** Upstream ships: commit in the seed and push to upstream main. */
function upstreamShips(sb: Sandbox, version: string, files: Record<string, string>, message = `v${version} upstream`): string {
  const sha = commit(sb.seed, sb.env, message, { VERSION: `${version}\n`, ...files });
  git(sb.seed, sb.env, 'push', '-q', 'upstream', 'main');
  return sha;
}

function runSync(sb: Sandbox, extra: string[] = []) {
  const args = [
    SCRIPT, 'run', '--ignore-load', '--notify', path.join(sb.bin, 'notify'),
    '--install-cmd', 'true', '--freshness-cmd', 'true', '--build-cmd', 'true',
    '--suite-cmd', path.join(sb.bin, 'suite'), '--isolate-cmd', `${path.join(sb.bin, 'iso')} {path} {root}`,
    '--setup-cmd', 'true', '--proof-cmd', "echo 'SKILL_START_PROTO: 1'", '--render-cmd', 'true', ...extra,
  ];
  const r = spawnSync(process.execPath, args, { env: sb.env, encoding: 'utf8', timeout: 90_000 });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

function notes(sb: Sandbox): string[] {
  return fs.existsSync(sb.notifyLog) ? fs.readFileSync(sb.notifyLog, 'utf8').trim().split('\n').filter(Boolean) : [];
}

function liveState(sb: Sandbox) {
  return {
    branch: git(sb.durable, sb.env, 'symbolic-ref', '--short', 'HEAD'),
    head: git(sb.durable, sb.env, 'rev-parse', 'HEAD'),
    worktrees: git(sb.durable, sb.env, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length,
  };
}

function stateJson(sb: Sandbox) {
  return JSON.parse(fs.readFileSync(path.join(sb.home, '.gstack', 'fork-sync', 'state.json'), 'utf8'));
}

/** One sandbox per test, removed inside the test's own (generous) timeout. */
function e2e(name: string, fn: (sb: Sandbox) => void, opts: { pushCarried?: boolean } = {}): void {
  test(name, () => {
    const sb = makeSandbox(opts);
    try { fn(sb); } finally { fs.rmSync(sb.base, { recursive: true, force: true }); }
  }, E2E_TIMEOUT);
}

describe('fork-sync run (sandbox repos)', () => {
  e2e('load deferral is bounded: three deferrals in a row, then the run proceeds', (sb) => {
    // Drop --ignore-load; a max load this low is always exceeded.
    const busy = () => {
      const args = [SCRIPT, 'run', '--notify', path.join(sb.bin, 'notify'), '--max-load', '0.001'];
      const r = spawnSync(process.execPath, args, { env: sb.env, encoding: 'utf8', timeout: 90_000 });
      return `${r.stdout}${r.stderr}`;
    };
    for (let i = 0; i < 3; i += 1) expect(busy()).toContain('DEFERRED_LOAD');
    const fourth = busy();
    expect(fourth).toContain('running despite');
    expect(fourth).toContain('UP_TO_DATE');
    expect(stateJson(sb).deferStreak).toBe(0);
  });

  e2e('clean upstream advance: up to date, then dry run, then lands as a new branch, pushed, proven and marked', (sb) => {
    const before = liveState(sb);
    const current = runSync(sb);
    expect(current.out).toContain('UP_TO_DATE');
    expect(current.code).toBe(0);

    const up = upstreamShips(sb, '1.1.0.0', { 'up.txt': 'up\n' });
    const stateFile = path.join(sb.home, '.gstack', 'fork-sync', 'state.json');
    const runsDir = path.join(sb.home, '.gstack', 'fork-sync', 'runs');
    const stateBefore = fs.readFileSync(stateFile, 'utf8');
    const runsBefore = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).length : 0;
    const dry = runSync(sb, ['--dry-run']);
    expect(dry.out).toContain('would land as feat/x-1.1.0');
    expect(dry.code).toBe(0);
    // A dry run writes nothing: same state, no new run directory.
    expect(fs.readFileSync(stateFile, 'utf8')).toBe(stateBefore);
    expect(fs.existsSync(runsDir) ? fs.readdirSync(runsDir).length : 0).toBe(runsBefore);

    const r = runSync(sb);
    expect(r.out).toContain('LANDED');
    expect(r.code).toBe(0);

    const after = liveState(sb);
    expect(after.branch).toBe('feat/x-1.1.0');
    expect(after.worktrees).toBe(1);
    expect(git(sb.durable, sb.env, 'merge-base', '--is-ancestor', up, 'HEAD')).toBe('');
    expect(git(sb.durable, sb.env, 'log', '--format=%s', `${up}..HEAD`).split('\n')).toEqual(['feat: ours two', 'feat: ours one']);
    // Rebased commits name the automation as committer and keep their author.
    expect(git(sb.durable, sb.env, 'log', '-1', '--format=%cn|%an')).toBe('gstack fork-sync|Test Author');
    // Old branch untouched; new branch on origin; tracking set.
    expect(git(sb.durable, sb.env, 'rev-parse', 'feat/x-1.0.0')).toBe(before.head);
    expect(git(sb.durable, sb.env, 'ls-remote', '--heads', 'origin', 'feat/x-1.1.0')).toContain(after.head);
    expect(git(sb.durable, sb.env, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/feat/x-1.1.0');
    expect(fs.readFileSync(path.join(sb.home, '.gstack', 'just-upgraded-from'), 'utf8').trim()).toBe('1.0.0.0');
    // Local main (where new worktrees are cut) is fast-forwarded to upstream; origin/main is not pushed.
    expect(git(sb.durable, sb.env, 'rev-parse', 'main')).toBe(up);
    expect(git(sb.durable, sb.env, 'ls-remote', '--heads', 'origin', 'main')).not.toContain(up);
    const n = notes(sb);
    expect(n).toHaveLength(1);
    expect(n[0]).toContain('landed');
    expect(n[0]).not.toContain('--remote');
    expect(stateJson(sb).lastRun.outcome).toBe('LANDED');

    // A second run is a no-op on the new branch, and pages nobody.
    expect(runSync(sb).out).toContain('UP_TO_DATE');
    expect(notes(sb)).toHaveLength(1);
  });

  e2e('a conflict STOPS, leaves the live checkout exactly as it was, and pages once', (sb) => {
    commit(sb.durable, sb.env, 'feat: ours edits line one', { 'a.txt': 'OURS one\nline two\n' });
    git(sb.durable, sb.env, 'push', '-q', 'origin', 'feat/x-1.0.0');
    upstreamShips(sb, '1.1.0.0', { 'a.txt': 'UPSTREAM one\nline two\n' });
    const before = liveState(sb);

    // A main with its own commit is never moved.
    git(sb.durable, sb.env, 'branch', '-f', 'main', 'feat/x-1.0.0');
    const r = runSync(sb);
    expect(r.out).toContain('BLOCKED_CONFLICT');
    expect(r.code).toBe(3);
    expect(r.out).toContain('main has commits upstream lacks');
    expect(git(sb.durable, sb.env, 'rev-parse', 'main')).toBe(before.head);
    expect(liveState(sb)).toEqual(before);
    expect(git(sb.durable, sb.env, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    const n = notes(sb);
    expect(n).toHaveLength(1);
    expect(n[0]).toContain('--remote');
    expect(n[0]).toContain('feat: ours edits line one');
    expect(n[0]).toContain('a.txt');

    // Same pair again: skipped, not re-paged.
    const again = runSync(sb);
    expect(again.out).toContain('SKIPPED_BLOCKED');
    expect(again.code).toBe(0);
    expect(notes(sb)).toHaveLength(1);
  });

  e2e('an ours-only failure that survives isolation is a regression: STOP, live untouched', (sb) => {
    commit(sb.durable, sb.env, 'feat: ours breaks a test', {
      'test/ours.test.ts': '// stand-in\n', '.fake-failures': 'test/ours.test.ts — breaks\n', '.fake-iso-fail': 'test/ours.test.ts\n',
    });
    git(sb.durable, sb.env, 'push', '-q', 'origin', 'feat/x-1.0.0');
    upstreamShips(sb, '1.1.0.0', { 'up.txt': 'up\n' });
    const before = liveState(sb);

    const r = runSync(sb);
    expect(r.out).toContain('BLOCKED_REGRESSION');
    expect(r.code).toBe(3);
    expect(liveState(sb)).toEqual(before);
    expect(git(sb.durable, sb.env, 'rev-parse', '--verify', 'refs/fork-sync/attempt')).toMatch(/^[0-9a-f]{40}$/);
    expect(notes(sb)[0]).toContain('test/ours.test.ts');
  });

  e2e('a wedged shard is inconclusive, unless isolation confirms a regression, which then STOPS', (sb) => {
    commit(sb.durable, sb.env, 'feat: ours wedges a shard', { '.fake-wedge': 'x\n', '.fake-failures': 'test/ok.test.ts — flaked\n' });
    git(sb.durable, sb.env, 'push', '-q', 'origin', 'feat/x-1.0.0');
    upstreamShips(sb, '1.1.0.0', { 'up.txt': 'up\n' });
    const flakyOnly = runSync(sb);
    expect(flakyOnly.out).toContain('INCONCLUSIVE');
    expect(flakyOnly.code).toBe(2);

    commit(sb.durable, sb.env, 'feat: ours also breaks a test', {
      '.fake-failures': 'test/ok.test.ts — flaked\ntest/bad.test.ts — breaks\n', '.fake-iso-fail': 'test/bad.test.ts\n', 'test/bad.test.ts': '//\n',
    });
    git(sb.durable, sb.env, 'push', '-q', 'origin', 'feat/x-1.0.0');
    const confirmed = runSync(sb);
    expect(confirmed.out).toContain('BLOCKED_REGRESSION');
    expect(confirmed.code).toBe(3);
    expect(notes(sb).some((l) => l.includes('test/bad.test.ts'))).toBe(true);
  });

  e2e('an incomplete run NAMES the files it cannot vouch for, not just the condition', (sb) => {
    commit(sb.durable, sb.env, 'feat: ours truncates a shard', {
      '.fake-truncate': 'x\n',
      '.fake-plan': 'test/never-reached.test.ts\ntest/also-unreached.test.ts\n',
    });
    git(sb.durable, sb.env, 'push', '-q', 'origin', 'feat/x-1.0.0');
    upstreamShips(sb, '1.1.0.0', { 'up.txt': 'up\n' });
    const before = liveState(sb);

    const r = runSync(sb);
    expect(r.out).toContain('INCONCLUSIVE');
    expect(r.code).toBe(2);
    // The whole point: a verdict that says WHICH files, not only that a shard
    // died. `regressions=0` over a set that silently excluded them is the bug.
    expect(r.out).toContain('test/never-reached.test.ts');
    expect(r.out).toContain('test/also-unreached.test.ts');
    expect(liveState(sb)).toEqual(before);
    const gate = stateJson(sb).lastRun.gate;
    expect(gate.verdict.unrun).toEqual(['test/also-unreached.test.ts', 'test/never-reached.test.ts']);
    expect(gate.ours.unvouchedShards).toEqual([1]);
    // Inconclusive stays inconclusive: naming files must not turn a truncated
    // run into a pass.
    expect(gate.verdict.verdict).toBe('inconclusive');
  });

  e2e('an abnormal shard whose summary accounted for every planned file surrenders nothing', (sb) => {
    // The measured shard-4 case end to end: the shard ran all its files, a
    // test failed, and it exited 0. Before the accounting rode on the
    // abnormal line this shard was indistinguishable from a truncation and
    // its whole planned set was named as unrun.
    commit(sb.durable, sb.env, 'feat: ours makes a shard lie about its exit code', {
      '.fake-account': 'x\n',
      '.fake-plan': 'test/ran-fine.test.ts\ntest/also-ran.test.ts\n',
    });
    git(sb.durable, sb.env, 'push', '-q', 'origin', 'feat/x-1.0.0');
    upstreamShips(sb, '1.1.0.0', { 'up.txt': 'up\n' });
    const before = liveState(sb);

    const r = runSync(sb);
    // The RUN is still incomplete — an abnormal shard is an abnormal shard —
    // so nothing lands and the verdict stays inconclusive.
    expect(r.code).toBe(2);
    expect(r.out).toContain('INCONCLUSIVE');
    expect(liveState(sb)).toEqual(before);
    const gate = stateJson(sb).lastRun.gate;
    expect(gate.verdict.verdict).toBe('inconclusive');
    // What changed: those two files are no longer named as unrun.
    expect(gate.verdict.unrun).toEqual([]);
    expect(gate.ours.unvouchedShards).toEqual([]);
    expect(gate.ours.unvouchedFiles).toBe(0);
  });

  e2e('a suite that never reported a shard says so, rather than naming an empty unrun set', (sb) => {
    upstreamShips(sb, '1.1.0.0', { 'up.txt': 'up\n' });
    const before = liveState(sb);
    const r = runSync(sb, ['--suite-cmd', "echo 'bun: command not found'"]);
    expect(r.out).toContain('INCONCLUSIVE');
    expect(r.code).toBe(2);
    expect(r.out).toContain('printed no shard line at all');
    expect(liveState(sb)).toEqual(before);
  });

  e2e('an unrun file our commits TOUCH is re-run on both trees: a confirmed failure STOPS', (sb) => {
    // Phase 1: upstream ships the file and we land onto it, so pristine
    // upstream has it too and the isolated comparison is a real three-way.
    upstreamShips(sb, '1.1.0.0', { 'test/shared.test.ts': '// upstream\n' });
    expect(runSync(sb).out).toContain('LANDED');

    // Phase 2: our commit touches that file, and the shard holding it dies
    // before reporting on it — the dangerous case. Nothing measured what we
    // changed, and the comparative diff of failure lists cannot see it.
    commit(sb.durable, sb.env, 'feat: ours edits a test that then goes unrun', {
      'test/shared.test.ts': '// ours\n',
      '.fake-truncate': 'x\n',
      '.fake-plan': 'test/shared.test.ts\n',
      '.fake-iso-fail': 'test/shared.test.ts\n',
    });
    git(sb.durable, sb.env, 'push', '-q', 'origin', 'feat/x-1.1.0');
    upstreamShips(sb, '1.2.0.0', { 'up2.txt': 'up\n' });
    const before = liveState(sb);

    const r = runSync(sb);
    expect(r.out).toContain('BLOCKED_REGRESSION');
    expect(r.code).toBe(3);
    expect(r.out).toContain('test/shared.test.ts');
    expect(liveState(sb)).toEqual(before);
    const gate = stateJson(sb).lastRun.gate;
    expect(gate.verdict.regressions).toEqual(['test/shared.test.ts']);
    expect(gate.verdict.unrun).toEqual([]);
    expect(notes(sb).some((l) => l.includes('test/shared.test.ts'))).toBe(true);
  });

  e2e('an unrun touched file that passes in isolation is vouched for, and is not called flaky', (sb) => {
    upstreamShips(sb, '1.1.0.0', { 'test/shared.test.ts': '// upstream\n' });
    expect(runSync(sb).out).toContain('LANDED');

    commit(sb.durable, sb.env, 'feat: ours edits a test that then goes unrun', {
      'test/shared.test.ts': '// ours\n', '.fake-truncate': 'x\n', '.fake-plan': 'test/shared.test.ts\n',
    });
    git(sb.durable, sb.env, 'push', '-q', 'origin', 'feat/x-1.1.0');
    upstreamShips(sb, '1.2.0.0', { 'up2.txt': 'up\n' });
    const before = liveState(sb);

    const r = runSync(sb);
    expect(r.out).toContain('INCONCLUSIVE');
    expect(r.code).toBe(2);
    // Nothing landed: a shard that did not finish is still a shard that did
    // not finish, even once every touched file in it has been vouched for.
    expect(liveState(sb)).toEqual(before);
    const gate = stateJson(sb).lastRun.gate;
    expect(gate.verdict.vouched).toEqual(['test/shared.test.ts']);
    // It was never seen failing, so calling it flaky would inflate that count.
    expect(gate.verdict.flaky).toEqual([]);
    expect(gate.verdict.unrun).toEqual([]);
    expect(gate.verdict.regressions).toEqual([]);
  });

  e2e('a red baseline does not block, and an ours-only failure that passes in isolation is flaky', (sb) => {
    commit(sb.durable, sb.env, 'feat: ours has a flaky test', { 'test/flaky.test.ts': '//\n' });
    git(sb.durable, sb.env, 'push', '-q', 'origin', 'feat/x-1.0.0');
    // Upstream is red on its own test (fails in isolation too) …
    upstreamShips(sb, '1.1.0.0', {
      '.fake-failures': 'test/base.test.ts — red upstream\n', '.fake-iso-fail': 'test/base.test.ts\n', 'test/base.test.ts': '//\n',
    });
    // … and ours adds a failure that isolation clears.
    const r1 = runSync(sb, ['--suite-cmd', `${path.join(sb.bin, 'suite')}; s=$?; [ -f test/flaky.test.ts ] && echo '  ✗ test/flaky.test.ts — once'; exit $s`]);
    expect(r1.out).toContain('LANDED');
    const gate = stateJson(sb).lastRun.gate;
    expect(gate.verdict.flaky).toEqual(['test/flaky.test.ts']);
    expect(gate.verdict.regressions).toEqual([]);
  });

  e2e('stale generated output after a clean rebase STOPS and is not regenerated', (sb) => {
    upstreamShips(sb, '1.1.0.0', { 'up.txt': 'up\n' });
    const before = liveState(sb);
    const r = runSync(sb, ['--freshness-cmd', 'echo drift >> a.txt']);
    expect(r.out).toContain('BLOCKED_STALE');
    expect(r.code).toBe(3);
    expect(liveState(sb)).toEqual(before);
    expect(notes(sb)[0]).toContain('a.txt');
  });

  e2e('a dirty live checkout STOPS without discarding anything, and re-arms once cleaned', (sb) => {
    upstreamShips(sb, '1.1.0.0', { 'up.txt': 'up\n' });
    write(path.join(sb.durable, 'ours1.txt'), 'uncommitted edit\n');
    const r = runSync(sb);
    expect(r.out).toContain('BLOCKED_DIRTY');
    expect(r.code).toBe(3);
    expect(fs.readFileSync(path.join(sb.durable, 'ours1.txt'), 'utf8')).toBe('uncommitted edit\n');
    expect(liveState(sb).worktrees).toBe(1);

    git(sb.durable, sb.env, 'checkout', '--', 'ours1.txt');
    const r2 = runSync(sb);
    expect(r2.out).toContain('LANDED');
    expect(notes(sb).filter((l) => l.includes('--remote'))).toHaveLength(1);
  });

  e2e('a commit upstream adopted is dropped and named, and the landing pages', (sb) => {
    upstreamShips(sb, '1.1.0.0', { 'ours1.txt': 'one\n' }, 'feat: ours one');
    const r = runSync(sb);
    expect(r.out).toContain('LANDED');
    expect(stateJson(sb).lastRun.dropped).toEqual(['feat: ours one']);
    const landed = notes(sb).find((l) => l.includes('landed')) ?? '';
    expect(landed).toContain('1 dropped');
    expect(landed).toContain('--remote');
  });

  e2e('a setup failure after the switch rolls back to the old branch', (sb) => {
    const before = liveState(sb);
    upstreamShips(sb, '1.1.0.0', { '.break-setup': 'x\n' });
    const r = runSync(sb, ['--setup-cmd', 'test ! -f .break-setup']);
    expect(r.out).toContain('ROLLED_BACK');
    expect(r.code).toBe(4);
    expect(liveState(sb).branch).toBe(before.branch);
    expect(liveState(sb).head).toBe(before.head);
    expect(notes(sb)[0]).toContain('rolled back');
  });

  e2e('a landing rebuilds the live render from the new branch, after setup and the proof', (sb) => {
    upstreamShips(sb, '1.1.0.0', { 'up.txt': 'up\n' });
    const log = path.join(sb.base, 'render.log');
    const r = runSync(sb, ['--render-cmd', `printf '%s %s\\n' {live} "$(git symbolic-ref --short HEAD)" >> ${log}`]);
    expect(r.out).toContain('LANDED');
    expect(fs.readFileSync(log, 'utf8')).toBe(`${path.join(sb.home, '.claude', 'skills', 'gstack')} feat/x-1.1.0\n`);
  });

  e2e('a render failure after the switch rolls back and re-renders the old branch', (sb) => {
    const before = liveState(sb);
    upstreamShips(sb, '1.1.0.0', { '.break-render': 'x\n' });
    const log = path.join(sb.base, 'render.log');
    const r = runSync(sb, ['--render-cmd', `git symbolic-ref --short HEAD >> ${log}; test ! -f .break-render`]);
    expect(r.out).toContain('ROLLED_BACK');
    expect(r.code).toBe(4);
    expect(liveState(sb).branch).toBe(before.branch);
    expect(liveState(sb).head).toBe(before.head);
    expect(notes(sb)[0]).toContain('render refresh exited 1');
    expect(fs.readFileSync(log, 'utf8')).toBe('feat/x-1.1.0\nfeat/x-1.0.0\n');
  });

  e2e('an existing landing branch means someone else is on it: STOP before any rebase', (sb) => {
    upstreamShips(sb, '1.1.0.0', { 'up.txt': 'up\n' });
    git(sb.durable, sb.env, 'push', '-q', 'origin', 'upstream/main:refs/heads/feat/x-1.1.0');
    const before = liveState(sb);
    const r = runSync(sb);
    expect(r.out).toContain('BLOCKED_COLLISION');
    expect(r.code).toBe(3);
    expect(liveState(sb)).toEqual(before);
  });

  e2e('an old tip missing from origin is backed up there before the live checkout leaves it', (sb) => {
    upstreamShips(sb, '1.1.0.0', { 'up.txt': 'up\n' });
    const oldTip = liveState(sb).head;
    const r = runSync(sb);
    expect(r.out).toContain('LANDED');
    const heads = git(sb.durable, sb.env, 'ls-remote', '--heads', 'origin');
    expect(heads).toMatch(new RegExp(`${oldTip}\\s+refs/heads/backup/fork-sync-feat-x-1\\.0\\.0-\\d{8}-\\d{6}`));
  }, { pushCarried: false });

  e2e('--no-land rehearses another branch without touching the live checkout or paging', (sb) => {
    git(sb.durable, sb.env, 'branch', 'feat/y-1.0.0', 'feat/x-1.0.0');
    upstreamShips(sb, '1.1.0.0', { 'up.txt': 'up\n' });
    const before = liveState(sb);
    const r = runSync(sb, ['--no-land', '--branch', 'feat/y-1.0.0']);
    expect(r.out).toContain('REHEARSED');
    expect(r.code).toBe(0);
    expect(liveState(sb)).toEqual(before);
    expect(notes(sb)).toEqual([]);
    expect(stateJson(sb).rehearsal.outcome).toBe('REHEARSED');
  });

  e2e('a live checkout that really is a linked worktree is a precondition STOP', (sb) => {
    const linked = path.join(sb.base, 'linked');
    git(sb.durable, sb.env, 'worktree', 'add', '--detach', linked, 'feat/x-1.0.0');
    const link = path.join(sb.home, '.claude', 'skills', 'gstack');
    fs.unlinkSync(link);
    fs.symlinkSync(linked, link);
    const r = runSync(sb);
    expect(r.out).toContain('BLOCKED_PRECONDITION');
    expect(r.code).toBe(3);
    expect(r.out).toContain('linked worktree');
    // The claim is only ever made about a git dir that RESOLVED: an
    // unresolvable path reports itself instead of being read as this.
    expect(r.out).not.toContain('cannot resolve');
    // And it names the two paths that disagreed. The 2026-09-27 recurrence of
    // this exact message could not be traced from its log, because the body
    // asserted the repository's layout without carrying the evidence for it —
    // so a wrong verdict and a right one read identically.
    expect(r.out).toContain(path.join(sb.durable, '.git', 'worktrees', 'linked'));
    expect(r.out).toContain(`!= ${path.join(sb.durable, '.git')}`);
  });

  // REPRODUCED on 2288d0ed, 2026-09-28: 1 of 9 runs of the six-file
  // combination (`test/fork-sync.test.ts` with the five free-runner files, one
  // bun process, 1-minute load 91) STOPPED with
  // `BLOCKED_PRECONDITION not a git work tree: durable` against a sandbox
  // durable checkout that IS a work tree. The check read only stdout, so a git
  // that could not RUN — empty stdout — asserted a fact about the repository
  // and discarded the reason. Same defect shape as the realpath swallow above:
  // a verdict that reads as settled while resting on evidence it never
  // gathered, memoised until upstream or the tip moves.
  e2e('a git that cannot run reports itself, and never claims the repo is not a work tree', (sb) => {
    const shim = path.join(sb.base, 'brokenbin');
    write(path.join(shim, 'git'), `#!${BASH}\necho 'git: cannot fork' >&2\nexit 128\n`, 0o755);
    const args = [
      SCRIPT, 'run', '--ignore-load', '--notify', path.join(sb.bin, 'notify'),
      '--install-cmd', 'true', '--freshness-cmd', 'true', '--build-cmd', 'true',
      '--setup-cmd', 'true', '--render-cmd', 'true',
    ];
    const r = spawnSync(process.execPath, args, {
      env: { ...sb.env, PATH: `${shim}:${sb.env.PATH ?? ''}` }, encoding: 'utf8', timeout: 90_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(out).toContain('BLOCKED_PRECONDITION');
    // The claim it must NOT make: nothing established that the checkout is not
    // a work tree, and a later run with a working git would contradict it.
    expect(out).not.toContain('not a git work tree');
    // What it must say instead: that git failed, and how.
    expect(out).toContain('git exited 128');
    expect(out).toContain('cannot fork');
  });

  e2e('a live link that does not resolve to the checkout is a precondition STOP', (sb) => {
    const other = path.join(sb.base, 'elsewhere');
    fs.mkdirSync(other);
    const r = runSync(sb, ['--repo', sb.durable, '--live-link', other]);
    expect(r.out).toContain('BLOCKED_PRECONDITION');
    expect(r.code).toBe(3);
  });
});

// ─── Render hooks, against a sandbox durable checkout ───────────────────────

/**
 * Give the durable checkout the two files a hook needs from its own tree: a
 * copy of this script (the shim runs the checkout's copy) and a gstack-config
 * stub whose gbrain-refresh records which HEAD it rendered and whether a hook
 * variable leaked through.
 */
function withRenderTooling(sb: Sandbox): string {
  const log = path.join(sb.home, 'refresh.log');
  write(path.join(sb.durable, 'contrib', 'fork-sync', 'fork-sync.ts'), fs.readFileSync(SCRIPT, 'utf8'));
  write(path.join(sb.durable, 'bin', 'gstack-config'), [
    `#!${BASH}`,
    'echo "$1 $(git rev-parse --short HEAD) $(git symbolic-ref -q --short HEAD || echo detached) git_dir=${GIT_DIR:-unset}" >> "$HOME/refresh.log"',
    '',
  ].join('\n'), 0o755);
  git(sb.durable, sb.env, 'add', '-A');
  git(sb.durable, sb.env, 'commit', '-q', '-m', 'tooling');
  return log;
}

function hookCli(sb: Sandbox, ...args: string[]) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { env: sb.env, encoding: 'utf8', timeout: 90_000 });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}

function refreshes(log: string): string[] {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

describe('render hooks (sandbox repo)', () => {
  e2e('each way of landing on the durable checkout rebuilds the render once, at its end; other worktrees never do', (sb) => {
    const log = withRenderTooling(sb);
    const hooksDir = path.join(sb.durable, '.git', 'hooks');
    expect(hookCli(sb, 'status').out).toContain('render hooks: 0/4 installed');
    const inst = hookCli(sb, 'install-hooks');
    expect(inst.code).toBe(0);
    for (const hook of RENDER_HOOKS) expect(fs.statSync(path.join(hooksDir, hook)).mode & 0o111).not.toBe(0);
    expect(hookCli(sb, 'status').out).toContain('render hooks: installed (4/4)');

    const short = (rev: string) => git(sb.durable, sb.env, 'rev-parse', '--short', rev);
    const wt = path.join(sb.base, 'wt');
    // Creating a worktree fires post-checkout there: not the durable checkout.
    git(sb.durable, sb.env, 'worktree', 'add', '-q', '-b', 'topic', wt);
    commit(wt, sb.env, 'topic one', { 't1.txt': '1\n' });
    commit(wt, sb.env, 'topic two', { 't2.txt': '2\n' });
    expect(refreshes(log)).toEqual([]);

    // A hand fast-forward.
    git(sb.durable, sb.env, 'merge', '-q', '--ff-only', 'topic~1');
    expect(refreshes(log)).toEqual([`gbrain-refresh ${short('HEAD')} feat/x-1.0.0 git_dir=unset`]);

    // Opted out for one command, and a file checkout: neither rebuilds.
    git(sb.durable, { ...sb.env, GSTACK_SKIP_RENDER_HOOK: '1' }, 'merge', '-q', '--ff-only', 'topic');
    fs.writeFileSync(path.join(sb.durable, 'a.txt'), 'scribble\n');
    git(sb.durable, sb.env, 'checkout', '--', 'a.txt');
    expect(refreshes(log).length).toBe(1);

    // A ranged cherry-pick of three commits rebuilds once, at the last pick.
    commit(wt, sb.env, 'pick one', { 'p1.txt': '1\n' });
    commit(wt, sb.env, 'pick two', { 'p2.txt': '2\n' });
    commit(wt, sb.env, 'pick three', { 'p3.txt': '3\n' });
    git(sb.durable, sb.env, 'cherry-pick', 'topic~3..topic');
    expect(refreshes(log).length).toBe(2);
    expect(refreshes(log)[1]).toBe(`gbrain-refresh ${short('HEAD')} feat/x-1.0.0 git_dir=unset`);

    // A commit made in the durable checkout rebuilds; amending it rebuilds
    // once more (post-commit), not twice (post-rewrite amend as well).
    commit(sb.durable, sb.env, 'durable only', { 'd.txt': 'd\n' });
    expect(refreshes(log).length).toBe(3);
    git(sb.durable, sb.env, 'commit', '-q', '--amend', '-m', 'durable only, amended');
    expect(refreshes(log).length).toBe(4);
    expect(refreshes(log)[3]).toBe(`gbrain-refresh ${short('HEAD')} feat/x-1.0.0 git_dir=unset`);

    // A rebase replaying that commit rebuilds once, after it ends, on the
    // branch: not at its detached checkout, not per replayed commit.
    commit(wt, sb.env, 'upstream-ish', { 'u.txt': 'u\n' });
    git(sb.durable, sb.env, 'rebase', '-q', 'topic');
    expect(git(sb.durable, sb.env, 'log', '-1', '--format=%s')).toBe('durable only, amended');
    expect(refreshes(log).length).toBe(5);
    expect(refreshes(log)[4]).toBe(`gbrain-refresh ${short('HEAD')} feat/x-1.0.0 git_dir=unset`);

    // A landing that switches the live checkout to a new branch.
    git(sb.durable, sb.env, 'branch', 'feat/x-1.1.0', 'topic');
    git(sb.durable, sb.env, 'switch', '-q', 'feat/x-1.1.0');
    expect(refreshes(log).length).toBe(6);
    expect(refreshes(log)[5]).toBe(`gbrain-refresh ${short('HEAD')} feat/x-1.1.0 git_dir=unset`);

    // Anything in the linked worktree, which shares the hooks, stays quiet.
    git(wt, sb.env, 'merge', '-q', '--ff-only', 'feat/x-1.0.0');
    git(wt, sb.env, 'switch', '-q', '-c', 'elsewhere', 'feat/x-1.0.0~2');
    commit(wt, sb.env, 'wt only', { 'w.txt': 'w\n' });
    expect(refreshes(log).length).toBe(6);

    // A worktree whose copy of this script predates render-hook says nothing:
    // no usage text leaks into its git output.
    write(path.join(wt, 'contrib', 'fork-sync', 'fork-sync.ts'), 'console.log("usage: old fork-sync");\n');
    const old = spawnSync('git', ['commit', '-q', '-am', 'old copy'], { cwd: wt, env: sb.env, encoding: 'utf8', timeout: 60_000 });
    expect(old.status).toBe(0);
    expect(`${old.stdout}${old.stderr}`).toBe('');
  });

  e2e('install-hooks keeps a hook the operator owns, refuses a shared hooksPath, and uninstall removes only its own', (sb) => {
    const hooksDir = path.join(sb.durable, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const mine = '#!/bin/bash\necho mine\n';
    fs.writeFileSync(path.join(hooksDir, 'post-merge'), mine, { mode: 0o755 });

    const inst = hookCli(sb, 'install-hooks');
    expect(inst.out).toContain(`kept ${path.join(hooksDir, 'post-merge')}`);
    expect(inst.code).toBe(1);
    expect(inst.out).toContain('render-hook post-merge "$@"');
    expect(fs.readFileSync(path.join(hooksDir, 'post-merge'), 'utf8')).toBe(mine);
    for (const hook of RENDER_HOOKS.filter((h) => h !== 'post-merge')) {
      expect(fs.readFileSync(path.join(hooksDir, hook), 'utf8')).toBe(renderHookShim(hook));
    }
    // Re-running replaces its own shims and still keeps the operator's.
    expect(hookCli(sb, 'install-hooks').code).toBe(1);
    expect(fs.readFileSync(path.join(hooksDir, 'post-merge'), 'utf8')).toBe(mine);

    expect(hookCli(sb, 'uninstall-hooks').code).toBe(0);
    expect(fs.readdirSync(hooksDir)).toEqual(['post-merge']);
    expect(fs.readFileSync(path.join(hooksDir, 'post-merge'), 'utf8')).toBe(mine);

    const shared = path.join(sb.base, 'shared-hooks');
    git(sb.durable, sb.env, 'config', 'core.hooksPath', shared);
    const refused = hookCli(sb, 'install-hooks');
    expect(refused.out).toContain('core.hooksPath is set');
    expect(refused.code).toBe(1);
    expect(fs.existsSync(shared)).toBe(false);
  });
});
