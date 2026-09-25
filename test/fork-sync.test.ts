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
  compareVersions, droppedSubjects, fill, gateCandidates, landingBranchName,
  parseSuiteLog, renderPlist, suiteComplete, defaultConfig,
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

  const notifyLog = path.join(base, 'notify.log');
  write(path.join(bin, 'notify'), `#!${BASH}\nprintf '%s\\n' "$*" >> ${JSON.stringify(notifyLog)}\n`, 0o755);
  // Fake free suite: fails every `file — test` line listed in .fake-failures.
  write(path.join(bin, 'suite'), [
    `#!${BASH}`,
    'n=0; [ -f .fake-failures ] && n=$(grep -c . .fake-failures)',
    'echo "[test:free] full suite: 3 files across 1 shard processes"',
    'if [ "$n" -gt 0 ]; then',
    '  echo "[test:free] shard 1/1: 3 files, 1s, fail"',
    '  echo "[test:free] FAIL — $n failing test(s) in 1 file(s), 0 crashed worker(s). Full log: /dev/null"',
    '  while IFS= read -r l; do [ -n "$l" ] && echo "  ✗ $l"; done < .fake-failures',
    '  exit 1',
    'fi',
    'echo "[test:free] shard 1/1: 3 files, 1s, pass"',
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
    '--setup-cmd', 'true', '--proof-cmd', "echo 'SKILL_START_PROTO: 1'", ...extra,
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
    expect(current.code).toBe(0);
    expect(current.out).toContain('UP_TO_DATE');

    const up = upstreamShips(sb, '1.1.0.0', { 'up.txt': 'up\n' });
    const stateFile = path.join(sb.home, '.gstack', 'fork-sync', 'state.json');
    const runsDir = path.join(sb.home, '.gstack', 'fork-sync', 'runs');
    const stateBefore = fs.readFileSync(stateFile, 'utf8');
    const runsBefore = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).length : 0;
    const dry = runSync(sb, ['--dry-run']);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('would land as feat/x-1.1.0');
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

    const r = runSync(sb);
    expect(r.code).toBe(3);
    expect(r.out).toContain('BLOCKED_CONFLICT');
    expect(liveState(sb)).toEqual(before);
    expect(git(sb.durable, sb.env, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    const n = notes(sb);
    expect(n).toHaveLength(1);
    expect(n[0]).toContain('--remote');
    expect(n[0]).toContain('feat: ours edits line one');
    expect(n[0]).toContain('a.txt');

    // Same pair again: skipped, not re-paged.
    const again = runSync(sb);
    expect(again.code).toBe(0);
    expect(again.out).toContain('SKIPPED_BLOCKED');
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
    expect(r.code).toBe(3);
    expect(r.out).toContain('BLOCKED_REGRESSION');
    expect(liveState(sb)).toEqual(before);
    expect(git(sb.durable, sb.env, 'rev-parse', '--verify', 'refs/fork-sync/attempt')).toMatch(/^[0-9a-f]{40}$/);
    expect(notes(sb)[0]).toContain('test/ours.test.ts');
  });

  e2e('a red baseline does not block, and an ours-only failure that passes in isolation is flaky', (sb) => {
    commit(sb.durable, sb.env, 'feat: ours has a flaky test', { 'flaky.txt': 'x\n' });
    git(sb.durable, sb.env, 'push', '-q', 'origin', 'feat/x-1.0.0');
    // Upstream is red on its own test (fails in isolation too) …
    upstreamShips(sb, '1.1.0.0', {
      '.fake-failures': 'test/base.test.ts — red upstream\n', '.fake-iso-fail': 'test/base.test.ts\n', 'test/base.test.ts': '//\n',
    });
    // … and ours adds a failure that isolation clears.
    const r1 = runSync(sb, ['--suite-cmd', `${path.join(sb.bin, 'suite')}; s=$?; [ -f flaky.txt ] && echo '  ✗ test/flaky.test.ts — once'; exit $s`]);
    expect(r1.out).toContain('LANDED');
    const gate = stateJson(sb).lastRun.gate;
    expect(gate.verdict.flaky).toEqual(['test/flaky.test.ts']);
    expect(gate.verdict.regressions).toEqual([]);
  });

  e2e('stale generated output after a clean rebase STOPS and is not regenerated', (sb) => {
    upstreamShips(sb, '1.1.0.0', { 'up.txt': 'up\n' });
    const before = liveState(sb);
    const r = runSync(sb, ['--freshness-cmd', 'echo drift >> a.txt']);
    expect(r.code).toBe(3);
    expect(r.out).toContain('BLOCKED_STALE');
    expect(liveState(sb)).toEqual(before);
    expect(notes(sb)[0]).toContain('a.txt');
  });

  e2e('a dirty live checkout STOPS without discarding anything, and re-arms once cleaned', (sb) => {
    upstreamShips(sb, '1.1.0.0', { 'up.txt': 'up\n' });
    write(path.join(sb.durable, 'ours1.txt'), 'uncommitted edit\n');
    const r = runSync(sb);
    expect(r.code).toBe(3);
    expect(r.out).toContain('BLOCKED_DIRTY');
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
    expect(r.code).toBe(4);
    expect(r.out).toContain('ROLLED_BACK');
    expect(liveState(sb).branch).toBe(before.branch);
    expect(liveState(sb).head).toBe(before.head);
    expect(notes(sb)[0]).toContain('rolled back');
  });

  e2e('an existing landing branch means someone else is on it: STOP before any rebase', (sb) => {
    upstreamShips(sb, '1.1.0.0', { 'up.txt': 'up\n' });
    git(sb.durable, sb.env, 'push', '-q', 'origin', 'upstream/main:refs/heads/feat/x-1.1.0');
    const before = liveState(sb);
    const r = runSync(sb);
    expect(r.code).toBe(3);
    expect(r.out).toContain('BLOCKED_COLLISION');
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
    expect(r.code).toBe(0);
    expect(r.out).toContain('REHEARSED');
    expect(liveState(sb)).toEqual(before);
    expect(notes(sb)).toEqual([]);
    expect(stateJson(sb).rehearsal.outcome).toBe('REHEARSED');
  });

  e2e('a live link that does not resolve to the checkout is a precondition STOP', (sb) => {
    const other = path.join(sb.base, 'elsewhere');
    fs.mkdirSync(other);
    const r = runSync(sb, ['--repo', sb.durable, '--live-link', other]);
    expect(r.code).toBe(3);
    expect(r.out).toContain('BLOCKED_PRECONDITION');
  });
});
