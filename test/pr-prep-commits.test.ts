/**
 * gstack-pr-prep-commits: the audit skips merges, release-only commits and
 * empty `ci:` re-runs; a commit audited before (matched by patch-id, so a
 * rebase keeps the match) only re-queries what is new and keeps its old
 * verdict, so `worst` never drops; an unreported commit is UNVERIFIED; and
 * the branch's own open PR is never scored against itself.
 */
import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listAuditCommits, stampReport, dropSelf, worstOf, searchQualifier, commitsMain, type PriorReport } from '../lib/pr-prep-commits';
import { defaultGit } from '../lib/pr-context';

setDefaultTimeout(60_000);

let ROOT = '';
let repo = '';
let base = '';
const sha: Record<string, string> = {};

function gitIn(dir: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const git = (...args: string[]) => gitIn(repo, ...args);
/** Write (or, for null, delete) files, commit them and return the new sha. */
function commitIn(dir: string, files: Record<string, string | null>, msg: string): string {
  for (const [f, t] of Object.entries(files)) {
    if (t === null) {
      fs.rmSync(path.join(dir, f));
      continue;
    }
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), t);
  }
  gitIn(dir, 'add', '-A');
  gitIn(dir, 'commit', '-q', '--allow-empty', '-m', msg);
  return gitIn(dir, 'rev-parse', 'HEAD');
}
function commit(name: string, files: Record<string, string>, msg: string): void {
  sha[name] = commitIn(repo, files, msg);
}
/** A fresh repo under ROOT with one base commit; returns its dir and base sha. */
function freshRepo(name: string, files: Record<string, string>): { dir: string; base: string } {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir);
  gitIn(dir, 'init', '-q', '-b', 'main');
  return { dir, base: commitIn(dir, files, 'base') };
}

beforeAll(() => {
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-prep-commits-')));
  repo = path.join(ROOT, 'repo');
  fs.mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  commit('base', { 'VERSION': '1.0.0.0\n', 'CHANGELOG.md': '# C\n', 'lib/z.ts': 'z\n' }, 'base');
  base = sha.base;
  git('checkout', '-q', '-b', 'pr/a');
  commit('c1', { 'lib/a.ts': 'a\n' }, 'feat: a');
  commit('c2', { 'VERSION': '1.0.1.0\n', 'CHANGELOG.md': '# C\n\n## [1.0.1.0]\n' }, 'chore(release): 1.0.1.0');
  commit('c3', {}, 'ci: re-run after a Bun IOCP crash');
  git('checkout', '-q', 'main');
  commit('m1', { 'lib/main.ts': 'm\n' }, 'main moves (#5)');
  git('checkout', '-q', 'pr/a');
  git('merge', '-q', '--no-edit', 'main');
  commit('c4', { 'lib/b.ts': 'b\n' }, 'fix: b');
  // The audit's base is upstream's pinned tip, which already holds m1.
  base = sha.m1;
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('listAuditCommits', () => {
  test('merges, release-only and empty commits carry no new work', () => {
    const l = listAuditCommits(defaultGit, repo, base, null);
    expect(l.audit.map(c => c.sha)).toEqual([sha.c1, sha.c4]);
    expect(l.audit.every(c => c.mode === 'NEW')).toBe(true);
    expect(l.skipped.map(s => [s.sha, s.reason])).toEqual([[sha.c2, 'release-only'], [sha.c3, 'empty']]);
  });

  test('a commit audited before carries its verdict and searches only newer items; UNVERIFIED is re-checked in full', () => {
    const first = listAuditCommits(defaultGit, repo, base, null);
    // c1 was audited under another sha (before a rebase): its patch-id and subject still match.
    const prior = { generated_at: '2026-10-05T10:00:00Z', commits: [{ sha: 'f'.repeat(40), subject: 'feat: a', bucket: 'OVERLAP' }], audited: [{ patchId: first.audit[0].patchId, sha: 'f'.repeat(40), bucket: 'OVERLAP' }, { patchId: first.audit[1].patchId, sha: sha.c4, bucket: 'UNVERIFIED' }] };
    const l = listAuditCommits(defaultGit, repo, base, prior);
    expect(l.audit.map(c => c.mode)).toEqual(['CARRY', 'RECHECK']);
    expect(searchQualifier(l.audit[0])).toBe('updated:>=2026-10-05');
    expect(searchQualifier(l.audit[1])).toBeNull();
  });

  test('a commit reworded since its audit, or a prior with no subject, is searched in full: the keywords come from the subject', () => {
    const now = new Date('2026-10-08T00:00:00Z');
    const { dir, base: b } = freshRepo('reword', { 'lib/z.ts': 'z\n' });
    commitIn(dir, { 'lib/c.ts': 'c\n' }, 'fix(cache): misc cleanup');
    const l1 = listAuditCommits(defaultGit, dir, b, null);
    const r1 = stampReport({ summary: 's', commits: [{ sha: l1.audit[0].sha, bucket: 'CLEAN' }] }, l1, now) as PriorReport;
    expect(listAuditCommits(defaultGit, dir, b, r1).audit[0].mode).toBe('CARRY');
    gitIn(dir, 'commit', '-q', '--amend', '-m', 'feat(browse): add a persistent CDP session cache');
    const l2 = listAuditCommits(defaultGit, dir, b, r1);
    expect(l2.audit[0].patchId).toBe(l1.audit[0].patchId);
    expect(l2.audit[0].mode).toBe('RECHECK');
    const bare = { generated_at: '2026-10-05T10:00:00Z', audited: [{ patchId: l1.audit[0].patchId, sha: 'f'.repeat(40), bucket: 'CLEAN' }] };
    expect(listAuditCommits(defaultGit, dir, b, bare).audit[0].mode).toBe('RECHECK');
  });
});

describe('stampReport', () => {
  const now = new Date('2026-10-08T00:00:00Z');
  test('worst never drops for a carried commit; an unreported commit is UNVERIFIED; stamps are not typed by the agent', () => {
    const first = listAuditCommits(defaultGit, repo, base, null);
    const prior = { generated_at: '2026-10-05T10:00:00Z', commits: [{ sha: sha.c1, subject: 'feat: a', bucket: 'OVERLAP' }], audited: [{ patchId: first.audit[0].patchId, sha: sha.c1, bucket: 'OVERLAP' }] };
    const l = listAuditCommits(defaultGit, repo, base, prior);
    const r = stampReport({ summary: 'x', worst: 'CLEAN', commits: [{ sha: sha.c1.slice(0, 8), bucket: 'CLEAN' }] }, l, now) as Record<string, any>;
    expect(r.commits.map((c: { bucket: string }) => c.bucket)).toEqual(['OVERLAP', 'UNVERIFIED']);
    expect(r.worst).toBe('UNVERIFIED');
    expect(r).toMatchObject({ head: git('rev-parse', 'HEAD'), base_sha: base, generated_at: now.toISOString() });
    expect(r.audited.map((a: { sha: string }) => a.sha)).toEqual([sha.c1, sha.c4]);
  });

  test('a carried EXACT_DUP is searched in full again and clears once the full search stops finding it', () => {
    const first = listAuditCommits(defaultGit, repo, base, null);
    const r1 = stampReport({ summary: 's', commits: [{ sha: sha.c1, bucket: 'EXACT_DUP' }, { sha: sha.c4, bucket: 'CLEAN' }] }, first, now);
    const l = listAuditCommits(defaultGit, repo, base, r1 as PriorReport);
    expect(l.audit.map(c => c.mode)).toEqual(['RECHECK', 'CARRY']);
    expect(searchQualifier(l.audit[0])).toBeNull();
    // The duplicate closed upstream (or it was this branch's own PR, scored once by mistake).
    const r2 = stampReport({ summary: 's', commits: [{ sha: sha.c1, bucket: 'CLEAN' }, { sha: sha.c4, bucket: 'CLEAN' }] }, l, now) as Record<string, any>;
    expect(r2.worst).toBe('CLEAN');
  });

  test('every row the agent reported counts toward worst, and its own worst is a floor', () => {
    const l = listAuditCommits(defaultGit, repo, base, null);
    const st = (commits: { sha: string; bucket: string }[], worst?: string) =>
      stampReport({ summary: 's', ...(worst ? { worst } : {}), commits }, l, now) as Record<string, any>;
    const twice = st([{ sha: sha.c1, bucket: 'CLEAN' }, { sha: sha.c1, bucket: 'EXACT_DUP' }, { sha: sha.c4, bucket: 'CLEAN' }]);
    expect(twice.commits[0].bucket).toBe('EXACT_DUP');
    expect(twice.worst).toBe('EXACT_DUP');
    // c2 is skipped as release-only; a verdict reported for it still counts.
    expect(st([{ sha: sha.c1, bucket: 'CLEAN' }, { sha: sha.c4, bucket: 'CLEAN' }, { sha: sha.c2, bucket: 'EXACT_DUP' }]).worst).toBe('EXACT_DUP');
    expect(st([{ sha: sha.c1, bucket: 'CLEAN' }, { sha: sha.c4, bucket: 'CLEAN' }], 'EXACT_DUP').worst).toBe('EXACT_DUP');
    expect(st([{ sha: sha.c1, bucket: 'CLEAN' }, { sha: sha.c4, bucket: 'CLEAN' }], 'MAYBE').worst).toBe('UNVERIFIED');
  });

  test('a row naming no commit on the branch, or by fewer than 7 hex characters, refuses the report', () => {
    const l = listAuditCommits(defaultGit, repo, base, null);
    const codeOf = (fn: () => unknown): number | null => {
      try { fn(); return null; } catch (e) { return (e as { code?: number }).code ?? -1; }
    };
    const st = (list: typeof l, commits: { sha: string; bucket: string }[]) => () => stampReport({ summary: 's', commits }, list, now);
    expect(codeOf(st(l, [{ sha: sha.c1.slice(0, 6), bucket: 'EXACT_DUP' }]))).toBe(2);
    expect(codeOf(st(l, [{ sha: sha.c1, bucket: 'CLEAN' }, { sha: 'deadbeefcafe', bucket: 'EXACT_DUP' }]))).toBe(2);
    // A wrong --base (HEAD) leaves nothing to audit; the agent's rows must not stamp CLEAN.
    const empty = listAuditCommits(defaultGit, repo, git('rev-parse', 'HEAD'), null);
    expect(empty.audit).toEqual([]);
    expect(codeOf(st(empty, [{ sha: sha.c4, bucket: 'EXACT_DUP' }]))).toBe(2);
  });

  test('a malformed report and an unknown bucket fail closed', () => {
    const l = listAuditCommits(defaultGit, repo, base, null);
    expect(() => stampReport({ commits: [] }, l, now)).toThrow();
    expect(worstOf(['CLEAN', 'MAYBE'])).toBe('UNVERIFIED');
    expect(worstOf(['CLEAN', 'SIBLING', 'EXACT_DUP', 'UNVERIFIED'])).toBe('EXACT_DUP');
    // An unknown bucket ranks as UNVERIFIED; it must not hide a later EXACT_DUP.
    expect(worstOf(['MAYBE', 'EXACT_DUP'])).toBe('EXACT_DUP');
  });
});

describe('a revert and a re-apply share a patch-id', () => {
  test('both commits carry the worse of the two verdicts', () => {
    const now = new Date('2026-10-08T00:00:00Z');
    const { dir, base: b } = freshRepo('revert', { 'lib/z.ts': 'z\n' });
    const A = commitIn(dir, { 'lib/r.ts': 'r\n' }, 'feat: r');
    const R = commitIn(dir, { 'lib/r.ts': null }, 'Revert "feat: r"');
    const A2 = commitIn(dir, { 'lib/r.ts': 'r\n' }, 'feat: r');
    const l1 = listAuditCommits(defaultGit, dir, b, null);
    expect(l1.audit[0].patchId).toBe(l1.audit[2].patchId);
    const r1 = stampReport({ summary: 's', commits: [{ sha: A, bucket: 'OVERLAP' }, { sha: R, bucket: 'CLEAN' }, { sha: A2, bucket: 'CLEAN' }] }, l1, now);
    const l2 = listAuditCommits(defaultGit, dir, b, r1 as PriorReport);
    expect(l2.audit.map(c => `${c.mode}:${c.prior?.bucket}`)).toEqual(['CARRY:OVERLAP', 'CARRY:CLEAN', 'CARRY:OVERLAP']);
    const r2 = stampReport({ summary: 's', commits: [A, R, A2].map(s => ({ sha: s, bucket: 'CLEAN' })) }, l2, now) as Record<string, any>;
    expect(r2.worst).toBe('OVERLAP');
  });
});

describe('dropSelf', () => {
  test('drops the own PR by number or head ref + owner, keeps another fork\'s same-named branch', () => {
    const cands = [
      { number: 3066, headRefName: 'pr/x', headRepositoryOwner: { login: 'Me' } },
      { number: 1, headRefName: 'pr/x', headRepositoryOwner: { login: 'me' } },
      { number: 2, headRefName: 'pr/x', headRepositoryOwner: { login: 'someone' } },
      { number: 3, headRefName: 'other', author: { login: 'me' } },
    ];
    expect(dropSelf(cands, { number: 3066, headRef: 'pr/x', headOwner: 'me' }).map(c => c.number)).toEqual([2, 3]);
  });
});

describe('CLI', () => {
  test('stamp writes the /ship report and the persistent copy; the next list carries from it', async () => {
    const env = { ...process.env, GSTACK_STATE_ROOT: path.join(ROOT, 'home') };
    const out: string[] = [];
    const run = (argv: string[]) => commitsMain([...argv, '--cwd', repo], { out: l => out.push(l), env, now: () => new Date('2026-10-08T00:00:00Z') });
    const agent = path.join(ROOT, 'agent.json');
    fs.writeFileSync(agent, JSON.stringify({ summary: '2 CLEAN', commits: [{ sha: sha.c1, bucket: 'CLEAN' }, { sha: sha.c4, bucket: 'SIBLING' }] }));
    const ship = path.join(ROOT, 'ship-report.json');
    expect(await run(['stamp', '--base', base, '--report', agent, '--out', ship])).toBe(0);
    expect(out.at(-1)).toBe(`PR_PREP_REPORT: ${ship} (SIBLING)`);
    expect(await run(['paths'])).toBe(0);
    const persisted = out.at(-1)!;
    expect(JSON.parse(fs.readFileSync(persisted, 'utf8')).worst).toBe('SIBLING');
    expect(await run(['list', '--base', base])).toBe(0);
    const listed = JSON.parse(out.at(-1)!);
    expect(listed.audit.map((c: { mode: string }) => c.mode)).toEqual(['CARRY', 'CARRY']);
    fs.writeFileSync(agent, '{"nope": 1}');
    expect(await run(['stamp', '--base', base, '--report', agent, '--out', ship])).toBe(2);
    expect(JSON.parse(fs.readFileSync(ship, 'utf8')).worst).toBe('SIBLING');
  });
});
