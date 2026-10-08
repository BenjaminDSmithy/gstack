/**
 * gstack-pr-ci-triage on the three Windows Free Tests failures #3032 hit:
 * run 37346036310 shard 4 and run 37504870219 shard 5 (Bun IOCP abort,
 * exit 3, no failing test) and run 37347305098 shard 5 (a hang to the
 * deadline). Fixtures are the trimmed windows-result-<n> artifacts and the
 * last 40 lines of each shard log, stored as `.log.txt` because the repo's
 * .gitignore drops `*.log`. A draft appears only for a fully evidenced
 * CRASH, or a HANG whose identical tree passed the shard earlier, on the
 * PR's current head. The helper never commits or pushes.
 */
import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyShard, inFlightFile, draftable, triageMain, SHARD_JOB_RE } from '../lib/pr-ci-triage';
import { prStateDir, topicFor, type GhRunner } from '../lib/pr-context';

setDefaultTimeout(60_000);

const FX = path.join(import.meta.dir, 'fixtures', 'pr-ci-triage');
const read = (f: string) => fs.readFileSync(path.join(FX, f), 'utf8');
const result = (run: string) => JSON.parse(read(`${run}-result.json`)).outcome;

describe('pure classification', () => {
  test('the shard job name, with and without a second matrix dimension', () => {
    expect(SHARD_JOB_RE.exec('windows-free-shard (4)')?.[1]).toBe('4');
    expect(SHARD_JOB_RE.exec('windows-free-shard (5, 2)')?.[1]).toBe('5');
    expect(SHARD_JOB_RE.exec('windows-free-tests')).toBeNull();
  });

  test('IOCP abort: CRASH with the in-flight file, draftable', () => {
    const t = classifyShard(4, result('37346036310'), read('37346036310-shard.log.txt'));
    expect(t).toMatchObject({ klass: 'CRASH', signature: 'IOCP', inFlight: 'browse/test/cookie-import-node.test.ts', failLines: 0 });
    expect(draftable(t)).toBe(true);
  });

  test('every GetQueuedCompletionStatusEx abort is an IOCP crash: error 6 (#3032 run 37265273040) and CRLF endings', () => {
    const t = classifyShard(1, result('37265273040'), read('37265273040-shard.log.txt'));
    expect(t).toMatchObject({ klass: 'CRASH', signature: 'IOCP', inFlight: 'browse/test/handoff.test.ts', failLines: 0 });
    expect(t.why).toMatch(/GetQueuedCompletionStatusEx error 6\b/);
    expect(t.why).not.toContain('735');
    expect(draftable(t)).toBe(true);
    const crlf = '::group::test\\a.test.ts:\r\n(pass) x [1.00ms]\r\nGetQueuedCompletionStatusEx: (735) ERROR_ABANDONED_WAIT_0\r\r\n';
    expect(classifyShard(4, result('37346036310'), crlf)).toMatchObject({ klass: 'CRASH', signature: 'IOCP', inFlight: 'test/a.test.ts' });
  });

  test('a hang is HANG, but draftable only with same-tree evidence', () => {
    const t = classifyShard(5, result('37347305098'), read('37347305098-shard.log.txt'));
    expect(t.klass).toBe('HANG');
    expect(draftable(t)).toBe(false);
    expect(draftable({ ...t, sameTreeGreen: '37346036310' })).toBe(true);
  });

  test('a named failing file is REAL; no signature is UNKNOWN; a (fail) line or a missing artifact blocks a draft', () => {
    expect(classifyShard(1, { status: 'failed', exitCode: 1, failingFiles: ['test/x.test.ts'] }, null).klass).toBe('REAL');
    expect(classifyShard(1, { status: 'failed', exitCode: 3, failingFiles: [] }, 'just noise\n').klass).toBe('UNKNOWN');
    const failBefore = classifyShard(1, result('37346036310'), `(fail) something [3ms]\n${read('37346036310-shard.log.txt')}`);
    expect(failBefore.klass).toBe('CRASH');
    expect(draftable(failBefore)).toBe(false);
    expect(classifyShard(1, null, null).klass).toBe('UNKNOWN');
    expect(classifyShard(1, { status: 'passed', exitCode: 0, failingFiles: [] }, null).klass).toBe('INFRA');
  });

  test('an abort or a hang drafts only when the missing summary is the shard\'s ONLY failure evidence', () => {
    const crashLog = read('37346036310-shard.log.txt');
    const crash = result('37346036310');
    // the runner's other fail marker, and an unhandled error between tests, are failure evidence
    expect(draftable(classifyShard(4, crash, `✗ suite > broke [2.00ms]\n${crashLog}`))).toBe(false);
    const unhandled = `::group::test\\a.test.ts:\n# Unhandled error between tests\nerror: boom\nGetQueuedCompletionStatusEx: (735) ERROR_ABANDONED_WAIT_0\n`;
    expect(draftable(classifyShard(4, crash, unhandled))).toBe(false);
    // the runner counted more than the missing terminal summary, or the artifact predates the fields
    expect(draftable(classifyShard(4, { ...crash, unattributedFailures: 2 }, crashLog))).toBe(false);
    expect(draftable(classifyShard(4, { ...crash, summary: { sawTerminalSummary: true } }, crashLog))).toBe(false);
    const { unattributedFailures: _u, summary: _s, ...bare } = crash;
    expect(draftable(classifyShard(4, bare, crashLog))).toBe(false);
    // a hang with a (fail) line, or with no log read, never drafts, even with same-tree evidence
    const hang = result('37347305098');
    const hangLog = read('37347305098-shard.log.txt');
    expect(draftable({ ...classifyShard(5, hang, `(fail) suite > a real assertion failed [3.00ms]\n${hangLog}`), sameTreeGreen: '150' })).toBe(false);
    expect(draftable({ ...classifyShard(5, hang, null), sameTreeGreen: '150' })).toBe(false);
    expect(draftable({ ...classifyShard(5, { ...hang, unattributedFailures: 3 }, hangLog), sameTreeGreen: '150' })).toBe(false);
  });

  test('inFlightFile ignores a group that was closed', () => {
    expect(inFlightFile('::group::a.test.ts:\n(pass) x\n::endgroup::\n')).toBeNull();
    expect(inFlightFile('::group::a.test.ts:\n::endgroup::\n::group::b\\c.test.ts:\nboom\n')).toBe('b/c.test.ts');
  });
});

// ── against a fake gh and a real repo ───────────────────────────────────────

let ROOT = '';
let repoDir = '';
let A = '';
let B = '';
beforeAll(() => {
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-ci-triage-')));
  repoDir = path.join(ROOT, 'repo');
  fs.mkdirSync(repoDir);
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' } });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'pr/t');
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'feat: a');
  A = git('rev-parse', 'HEAD');
  git('commit', '-q', '--allow-empty', '-m', 'ci: re-run');
  B = git('rev-parse', 'HEAD');
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

interface FakeRun { id: number; sha: string; shard: number; fixture: string; result?: Record<string, unknown>; conclusion?: string; status?: string; jobs?: { name: string; conclusion: string }[] }

function fakeGh(runs: FakeRun[], calls: string[][], headOid = B): GhRunner {
  const view = (r: FakeRun) => ({
    databaseId: r.id, headSha: r.sha, headBranch: 'pr/t', event: 'pull_request', conclusion: r.conclusion ?? 'failure', status: r.status ?? 'completed', createdAt: '2026-10-06T00:00:00Z',
    jobs: r.jobs ?? [{ databaseId: 1, name: `windows-free-shard (${r.shard})`, conclusion: 'failure' }, { databaseId: 2, name: 'windows-free-tests', conclusion: 'failure' }],
  });
  return (args => {
    calls.push(args);
    const ok = (v: unknown) => ({ status: 0, stdout: JSON.stringify(v), stderr: '' });
    if (args[0] === 'pr' && args[1] === 'view') {
      return ok({ number: 3, state: 'OPEN', isDraft: false, headRefOid: headOid, url: 'https://github.com/acme/gt/pull/3', headRepositoryOwner: { login: 'me' }, headRepository: { name: 'gt' }, headRefName: 'pr/t', baseRefName: 'main' });
    }
    if (args[0] === 'run' && args[1] === 'list') {
      const commit = args.includes('--commit') ? args[args.indexOf('--commit') + 1] : null;
      return ok(runs.filter(r => !commit || r.sha === commit).map(view).sort((x, y) => y.databaseId - x.databaseId));
    }
    if (args[0] === 'run' && args[1] === 'view') {
      const r = runs.find(x => String(x.id) === args[2]);
      return r ? ok(view(r)) : { status: 1, stdout: '', stderr: 'not found' };
    }
    if (args[0] === 'run' && args[1] === 'download') {
      const r = runs.find(x => String(x.id) === args[2]);
      const name = args[args.indexOf('-n') + 1];
      const dir = args[args.indexOf('-D') + 1];
      if (!r) return { status: 1, stdout: '', stderr: 'no run' };
      if (name === `windows-result-${r.shard}`) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `shard-${r.shard}.json`), r.result ? JSON.stringify({ outcome: r.result }) : read(`${r.fixture}-result.json`));
        return ok('');
      }
      if (name === `windows-free-test-shard-logs-${r.shard}` && fs.existsSync(path.join(FX, `${r.fixture}-shard.log.txt`))) {
        fs.mkdirSync(path.join(dir, 'gstack'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'gstack', 'shard.log'), read(`${r.fixture}-shard.log.txt`));
        return ok('');
      }
      return { status: 1, stdout: '', stderr: 'no artifact' };
    }
    return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  }) as GhRunner;
}

async function triage(runs: FakeRun[], extra: string[] = [], headOid = B) {
  const calls: string[][] = [];
  const out: string[] = [];
  const env = { ...process.env, GSTACK_STATE_ROOT: path.join(ROOT, `home-${runs.map(r => r.id).join('-')}-${extra.join('')}`) };
  const code = await triageMain(['run', '--pr', '3', '--repo', 'acme/gt', '--cwd', repoDir, ...extra], { gh: fakeGh(runs, calls, headOid), env, out: l => out.push(l) });
  return { code, out, calls, env };
}

describe('run', () => {
  test('an IOCP crash on the current head drafts the ci: message, and nothing is committed or pushed', async () => {
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    const r = await triage([{ id: 100, sha: B, shard: 4, fixture: '37346036310' }]);
    expect(r.code).toBe(0);
    const file = r.out.find(l => l.startsWith('RESULT DRAFTED'))!.match(/message=(\S+)/)![1];
    const msg = fs.readFileSync(file, 'utf8');
    expect(msg.split('\n')[0]).toBe('ci: re-run CI after a Bun IOCP crash on windows-free-shard (4)');
    expect(msg).toContain('run 100');
    expect(msg).toContain('browse/test/cookie-import-node.test.ts');
    expect(path.dirname(file)).toBe(prStateDir({ cwd: repoDir, topic: topicFor('pr/t'), env: r.env }));
    expect(r.calls.some(c => c.includes('rerun') || c[1] === 'edit' || c[1] === 'comment')).toBe(false);
    expect(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8', timeout: 10_000 }).stdout.trim()).toBe(head);
  });

  test('a run on an older head, or one with a newer run on the head, gets no draft', async () => {
    const old = await triage([{ id: 101, sha: A, shard: 4, fixture: '37346036310' }], ['--run', '101']);
    expect(old.code).toBe(10);
    expect(old.out.some(l => l.startsWith('STALE run 101 is for'))).toBe(true);
    const newer = await triage([{ id: 102, sha: B, shard: 4, fixture: '37346036310' }, { id: 103, sha: B, shard: 4, fixture: '37346036310', conclusion: '', status: 'in_progress' }], ['--run', '102']);
    expect(newer.code).toBe(10);
    expect(newer.out.some(l => l.includes('a newer run on the head exists'))).toBe(true);
  });

  test('a hang drafts only when an earlier run of the identical tree passed the shard', async () => {
    const lone = await triage([{ id: 200, sha: B, shard: 5, fixture: '37347305098' }]);
    expect(lone.code).toBe(10);
    const passedEarlier = { id: 150, sha: A, shard: 5, fixture: '37347305098', conclusion: 'success', jobs: [{ name: 'windows-free-shard (5)', conclusion: 'success' }] };
    const r = await triage([{ id: 201, sha: B, shard: 5, fixture: '37347305098' }, passedEarlier]);
    expect(r.code).toBe(0);
    expect(r.out.some(l => l.includes('same-tree-green 150'))).toBe(true);
  });

  test('a named failing test is REAL: the blame protocol, never a draft; no failed run is NOTHING', async () => {
    const r = await triage([{ id: 300, sha: B, shard: 2, fixture: 'none', result: { status: 'failed', exitCode: 1, elapsedMs: 1000, failingFiles: ['test/x.test.ts'] } }]);
    expect(r.code).toBe(10);
    expect(r.out.some(l => l.startsWith('BLAME shard 2'))).toBe(true);
    expect((await triage([])).code).toBe(11);
  });
});
