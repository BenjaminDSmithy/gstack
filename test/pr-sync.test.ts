/**
 * gstack-pr-sync against real temp topologies: a bare upstream
 * (`.../up/acme/gstack.git`), a bare fork (`.../fork/me/gstack.git`) and a
 * clone of the fork on the PR branch. Only gh is faked (in-process); git is
 * the real binary through lib/pr-context's runners. The fixture tree carries
 * stand-ins for the release tooling the sync runs from the merged tree:
 * bin/gstack-next-version (prints a queue answer the test chooses),
 * bin/gstack-version-bump, scripts/gen-agents-digest.ts and a generator whose
 * SKILL.md header hashes its template (so two sides that touch one template
 * conflict on the generated file, not the template).
 *
 * The scenarios replay the shapes the #3032 effort hit by hand:
 * main released our number (22d5b39f9), four release-file conflicts plus a
 * queue claim (07f20bd96), a code conflict that must stop (bf1fad6f8), an
 * upstream move with no release (c285d88b9), an up-to-date PR whose version
 * was claimed, and a generated-file conflict.
 */
import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  syncMain, parseMergeTree, classifyConflicts, changelogBlock, rebuildChangelog, renameBlockHeading,
  qualifyQueue, pickVersion, cmpVersion, readStagedSync, classifyPush, type SyncDeps,
} from '../lib/pr-sync';
import { prStateDir, topicFor, readStateFor, writeState, type GhRunner, type PrState } from '../lib/pr-context';
import { listReceipts } from '../lib/egress-receipt';

setDefaultTimeout(180_000);

const REPO_ROOT = path.resolve(import.meta.dir, '..');
const NOW = new Date(2026, 9, 8, 12, 0, 0);
const TODAY = '2026-10-08';
let ROOT = '';
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-sync-')));
  for (const k of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GSTACK_STATE_ROOT', 'FAKE_QUEUE', 'FAKE_QUEUE_LOG']) saved[k] = process.env[k];
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GSTACK_STATE_ROOT = path.join(ROOT, 'home');
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (${cwd}): ${r.stderr}`);
  return r.stdout.trim();
}

function write(dir: string, rel: string, text: string, mode?: number): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
  if (mode) fs.chmodSync(path.join(dir, rel), mode);
}

const FAKE_NEXT_VERSION = `#!/usr/bin/env bun
import fs from 'node:fs';
if (process.env.FAKE_QUEUE_LOG) fs.appendFileSync(process.env.FAKE_QUEUE_LOG, JSON.stringify({ argv: process.argv.slice(2), ghRepo: process.env.GH_REPO }) + '\\n');
if (!process.env.FAKE_QUEUE || !fs.existsSync(process.env.FAKE_QUEUE)) { console.error('no queue'); process.exit(2); }
process.stdout.write(fs.readFileSync(process.env.FAKE_QUEUE, 'utf8'));
`;
const FAKE_VERSION_BUMP = `#!/usr/bin/env bun
import fs from 'node:fs';
const a = process.argv.slice(2);
if (a[0] !== 'write') process.exit(2);
const v = a[a.indexOf('--version') + 1];
fs.writeFileSync('VERSION', v + '\\n');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = v.split('.').slice(0, 3).join('.');
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\\n');
fs.writeFileSync('agents-digest/gstack-AGENTS.md', '# gstack digest v' + v + '\\n');
console.log(JSON.stringify({ wrote: v, packageJson: true, packageJsonVersion: pkg.version, agentsDigest: true }));
`;
const FAKE_DIGEST = `import fs from 'node:fs';
fs.writeFileSync('agents-digest/gstack-AGENTS.md', '# gstack digest v' + fs.readFileSync('VERSION', 'utf8').trim() + '\\n');
`;
const FAKE_GEN = `import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const dry = process.argv.includes('--dry-run');
let stale = false;
const walk = (d: string) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.md.tmpl')) {
      const src = fs.readFileSync(p, 'utf8');
      const out = '<!-- ' + crypto.createHash('sha256').update(src).digest('hex').slice(0, 8) + ' -->\\n' + src;
      const target = p.slice(0, -5);
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== out) { stale = true; if (!dry) fs.writeFileSync(target, out); }
    }
  }
};
walk(process.cwd());
process.exit(dry && stale ? 1 : 0);
`;

function render(tmpl: string): string {
  const h = new Bun.CryptoHasher('sha256').update(tmpl).digest('hex').slice(0, 8);
  return `<!-- ${h} -->\n${tmpl}`;
}

const TMPL = 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\n';
const BASE_CL = '# Changelog\n\nAll notable changes.\n\n## [1.0.0.0] - 2026-10-01\n\n- base\n';

function pkg(version3: string): string {
  return JSON.stringify({ name: 'fx', version: version3, scripts: { 'gen:skill-docs': 'bun run scripts/gen-skill-docs.ts' } }, null, 2) + '\n';
}

function seedTree(dir: string): void {
  write(dir, 'VERSION', '1.0.0.0\n');
  write(dir, 'package.json', pkg('1.0.0'));
  write(dir, 'CHANGELOG.md', BASE_CL);
  write(dir, 'agents-digest/gstack-AGENTS.md', '# gstack digest v1.0.0.0\n');
  write(dir, 'src/a.txt', 'a1\na2\na3\n');
  write(dir, 'src/b.txt', 'b1\nb2\nb3\n');
  write(dir, 'x/SKILL.md.tmpl', TMPL);
  write(dir, 'x/SKILL.md', render(TMPL));
  write(dir, 'bin/gstack-next-version', FAKE_NEXT_VERSION, 0o755);
  write(dir, 'bin/gstack-version-bump', FAKE_VERSION_BUMP, 0o755);
  write(dir, 'scripts/detect-bump.ts', fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'detect-bump.ts'), 'utf8'));
  write(dir, 'scripts/gen-agents-digest.ts', FAKE_DIGEST);
  write(dir, 'scripts/gen-skill-docs.ts', FAKE_GEN);
}

/** A release commit's files: VERSION, package.json, digest, and one CHANGELOG entry on top. */
function release(dir: string, version: string, date: string, note: string): void {
  write(dir, 'VERSION', `${version}\n`);
  write(dir, 'package.json', pkg(version.split('.').slice(0, 3).join('.')));
  write(dir, 'agents-digest/gstack-AGENTS.md', `# gstack digest v${version}\n`);
  const cl = fs.readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8');
  write(dir, 'CHANGELOG.md', rebuildChangelog(cl, `## [${version}] - ${date}\n\n- ${note}\n\n`));
}

interface Topo { base: string; up: string; fork: string; seed: string; clone: string; wt: string }

function topology(name: string, opts: { pr: (d: string) => void; main?: (d: string) => void }): Topo {
  const base = path.join(ROOT, name);
  const up = path.join(base, 'up', 'acme', 'gstack.git');
  const fork = path.join(base, 'fork', 'me', 'gstack.git');
  const seed = path.join(base, 'seed');
  const clone = path.join(base, 'clone');
  for (const bare of [up, fork]) {
    fs.mkdirSync(bare, { recursive: true });
    git(bare, 'init', '-q', '--bare', '-b', 'main');
  }
  fs.mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  seedTree(seed);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'base');
  git(seed, 'push', '-q', up, 'main');
  git(seed, 'push', '-q', fork, 'main');
  git(seed, 'checkout', '-q', '-b', 'pr/feat');
  opts.pr(seed);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'feat: our change');
  git(seed, 'push', '-q', fork, 'pr/feat');
  git(seed, 'checkout', '-q', 'main');
  if (opts.main) {
    opts.main(seed);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', 'main moves (#99)');
    git(seed, 'push', '-q', up, 'main');
  }
  git(base, 'clone', '-q', fork, clone);
  git(clone, 'remote', 'add', 'upstream', up);
  git(clone, 'config', 'user.name', 'T');
  git(clone, 'config', 'user.email', 't@example.com');
  git(clone, 'checkout', '-q', 'pr/feat');
  return { base, up, fork, seed, clone, wt: path.join(base, 'wt') };
}

function fakeGh(t: Topo, opts: { state?: string } = {}): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const gh = ((args: string[]) => {
    calls.push(args);
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
    if (args[0] === 'pr' && args[1] === 'view') {
      const oid = git(t.fork, 'rev-parse', 'refs/heads/pr/feat');
      return ok(JSON.stringify({
        number: 7, state: opts.state ?? 'OPEN', isDraft: false, headRefOid: oid, url: 'https://github.com/acme/gstack/pull/7',
        headRepositoryOwner: { login: 'me' }, headRepository: { name: 'gstack' }, headRefName: 'pr/feat', baseRefName: 'main',
      }));
    }
    if (args[0] === 'api' && args[1] === 'user') return ok('me\n');
    if (args[0] === 'pr' && args[1] === 'list') return ok('[]');
    // gstack-pr-watch's poll, run by the default pre-write gate: a quiet PR.
    if (args[0] === 'api' && args[1] === 'repos/acme/gstack/pulls/7') return ok(JSON.stringify({ state: 'open', merged: false, mergeable_state: 'clean', head: { sha: 'x' } }));
    if (args[0] === 'api' && (args[1]?.startsWith('repos/acme/gstack/issues/7/comments') || args[1]?.startsWith('repos/acme/gstack/pulls/7/reviews'))) return ok('[]');
    if (args[0] === 'api' && args.some(a => a.startsWith('repos/acme/gstack/issues/7/timeline'))) return ok('[]');
    return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  }) as GhRunner & { calls: string[][] };
  gh.calls = calls;
  return gh;
}

function queue(t: Topo, answer: Record<string, unknown>): void {
  const file = path.join(t.base, 'queue.json');
  fs.writeFileSync(file, JSON.stringify({ offline: false, fallback: null, claimed: [], reason: 'test', warnings: [], ...answer }));
  process.env.FAKE_QUEUE = file;
  process.env.FAKE_QUEUE_LOG = path.join(t.base, 'queue.log');
}

/** Each topology gets its own state root: the clones share a slug and a topic, as two checkouts of one PR would. */
const envFor = (t: Topo): NodeJS.ProcessEnv => ({ ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') });

async function run(t: Topo, argv: string[], extra: Partial<SyncDeps> = {}): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  process.env.GSTACK_STATE_ROOT = path.join(t.base, 'home');
  const code = await syncMain([...argv, '--pr', '7', '--repo', 'acme/gstack', '--cwd', t.clone, '--worktree-root', t.wt], {
    gh: fakeGh(t), env: envFor(t), now: () => NOW, out: l => out.push(l), err: () => {}, readbackDelayMs: 0, ...extra,
  });
  return { code, out };
}

const stateDir = (t: Topo) => prStateDir({ cwd: t.clone, topic: topicFor('pr/feat'), env: envFor(t) });
const pr = { repo: 'acme/gstack', number: 7, headRef: 'pr/feat', headOwner: 'me' };

function recordValidation(t: Topo, sha: string, worst: 0 | 1): void {
  const dir = stateDir(t);
  const s = readStateFor(dir, pr) as PrState;
  writeState(dir, { ...s, validation: { sha, worst, summary: worst ? '1 red' : 'all green', at: NOW.toISOString() } });
}

const ourFeature = (d: string) => {
  write(d, 'src/a.txt', 'a1\nOURS\na3\n');
  release(d, '1.0.1.0', '2026-10-02', 'ours');
};

// ── pure helpers ────────────────────────────────────────────────────────────

describe('pure helpers', () => {
  test('parseMergeTree stops at the first blank line (messages never become paths)', () => {
    const r = parseMergeTree(`${'a'.repeat(40)}\nVERSION\nCHANGELOG.md\n\nAuto-merging setup\nCONFLICT (content): Merge conflict in VERSION\n`);
    expect(r).toEqual({ tree: 'a'.repeat(40), conflicts: ['VERSION', 'CHANGELOG.md'] });
    expect(() => parseMergeTree('fatal: nope\n')).toThrow();
  });

  test('classifyConflicts: release, generated, code; a template is always code', () => {
    const gen = (p: string) => p === 'x/SKILL.md' || p === 'x/SKILL.md.tmpl';
    expect(classifyConflicts(['VERSION', 'x/SKILL.md', 'x/SKILL.md.tmpl', 'src/a.txt'], gen)).toEqual({
      release: ['VERSION'], generated: ['x/SKILL.md'], code: ['x/SKILL.md.tmpl', 'src/a.txt'],
    });
  });

  test('changelogBlock accepts one inserted block and refuses an edited older entry', () => {
    const head = rebuildChangelog(BASE_CL, '## [1.0.1.0] - 2026-10-02\n\n- ours\n\n');
    expect(changelogBlock(BASE_CL, head)).toEqual({ block: '## [1.0.1.0] - 2026-10-02\n\n- ours\n\n', headings: ['1.0.1.0'] });
    expect(changelogBlock(BASE_CL, head.replace('- base', '- base, edited'))).toBeNull();
    expect(changelogBlock(BASE_CL, BASE_CL.replace('All notable', 'Some'))).toBeNull();
    const two = rebuildChangelog(head, '## [1.0.2.0] - 2026-10-03\n\n- more\n\n');
    expect(changelogBlock(BASE_CL, two)?.headings).toEqual(['1.0.2.0', '1.0.1.0']);
  });

  test('renameBlockHeading rewrites only the first line', () => {
    expect(renameBlockHeading('## [1.0.1.0] - 2026-10-02\n\n- ours\n', '1.0.3.0', TODAY)).toBe(`## [1.0.3.0] - ${TODAY}\n\n- ours\n`);
    expect(() => renameBlockHeading('- no heading\n', '1.0.3.0', TODAY)).toThrow();
  });

  test('qualifyQueue fails closed on every unusable answer (code 60)', () => {
    const ok = (j: Record<string, unknown>) => ({ status: 0, stdout: JSON.stringify({ version: '1.0.2.0', base_version: '1.0.1.0', offline: false, fallback: null, claimed: [], ...j }), stderr: '' });
    expect(qualifyQueue(ok({}), '1.0.1.0').version).toBe('1.0.2.0');
    for (const bad of [ok({ offline: true }), ok({ fallback: 'git' }), ok({ base_version: '1.0.0.0' }), ok({ version: '1.0.2' }), { status: 2, stdout: '', stderr: 'boom' }, { status: 0, stdout: 'nope', stderr: '' }]) {
      expect(() => qualifyQueue(bad, '1.0.1.0')).toThrow(expect.objectContaining({ code: 60 }));
    }
  });

  test('classifyPush reads git push --porcelain: a hook refusal is 41, a non-fast-forward 40, a server refusal 41', () => {
    const ref = 'refs/heads/pr/feat';
    const res = (status: number, stdout: string, stderr: string) => ({ status, stdout, stderr });
    // git 2.56 output, captured from real pushes.
    expect(classifyPush(res(0, `To ../bare.git\n \tX:${ref}\t2b349fb..90b238c\nDone\n`, ''), ref)).toMatchObject({ landed: true, code: 0 });
    expect(classifyPush(res(1, '', "pre-push: BLOCKED - secret\nerror: failed to push some refs to '../bare.git'\n"), ref)).toMatchObject({ landed: false, code: 41 });
    expect(classifyPush(res(1, `To ../bare.git\n!\tX:${ref}\t[rejected] (non-fast-forward)\nDone\n`, "error: failed to push some refs to '../bare.git'\nhint: Updates were rejected\n"), ref)).toMatchObject({ landed: false, code: 40 });
    expect(classifyPush(res(1, `To ../bare.git\n!\tX:${ref}\t[remote rejected] (pre-receive hook declined)\nDone\n`, "remote: secret found\nerror: failed to push some refs to '../bare.git'\n"), ref)).toMatchObject({ landed: false, code: 41 });
    expect(classifyPush(res(1, `To ../bare.git\n!\tX:${ref}\t[remote rejected] (deny updating a hidden ref)\nDone\n`, "error: failed to push some refs to '../bare.git'\n"), ref)).toMatchObject({ landed: false, code: 41 });
    // Never reached the remote for another reason: a plain failure, not a hook.
    expect(classifyPush(res(128, '', "fatal: '/nonexistent/x.git' does not appear to be a git repository\nfatal: Could not read from remote repository.\n"), ref)).toMatchObject({ landed: false, code: 1 });
    // A rejection whose text says "rejected" is not a non-fast-forward unless git's status line says so.
    expect(classifyPush(res(1, '', "push rejected: secret scan found a token\nerror: failed to push some refs to 'x'\n"), ref).code).toBe(41);
  });

  test('pickVersion keeps ours only when it is above main and unclaimed', () => {
    const q = (claimed: string[]) => ({ version: '1.0.3.0', claimed, reason: '', warnings: [] });
    expect(pickVersion('1.0.2.0', '1.0.1.0', q([]))).toEqual({ version: '1.0.2.0', kept: true });
    expect(pickVersion('1.0.2.0', '1.0.1.0', q(['1.0.2.0']))).toEqual({ version: '1.0.3.0', kept: false });
    expect(pickVersion('1.0.1.0', '1.0.1.0', q([]))).toEqual({ version: '1.0.3.0', kept: false });
    expect(cmpVersion('1.0.10.0', '1.0.9.0')).toBe(1);
  });
});

// ── merge scenarios ─────────────────────────────────────────────────────────

describe('merge', () => {
  test('main released our number: CHANGELOG-only conflict, re-slotted, main entry byte-identical (22d5b39f9)', async () => {
    const t = topology('s1', { pr: ourFeature, main: d => { write(d, 'src/b.txt', 'b1\nMAIN\nb3\n'); release(d, '1.0.1.0', '2026-10-03', 'theirs'); } });
    queue(t, { version: '1.0.2.0', base_version: '1.0.1.0' });
    const plan = await run(t, ['plan']);
    expect(plan.code).toBe(0);
    expect(plan.out.join('\n')).toContain('CONFLICT\trelease\tCHANGELOG.md');
    const r = await run(t, ['merge']);
    expect(r.code, r.out.join('\n')).toBe(0);
    const staged = readStagedSync(stateDir(t), pr)!;
    expect(staged).toMatchObject({ kind: 'merge', oldVersion: '1.0.1.0', version: '1.0.2.0', mainVersion: '1.0.1.0', proof: 'IDENTICAL' });
    const main = git(t.up, 'show', 'main:CHANGELOG.md') + '\n';
    const cl = git(staged.scratch, 'show', 'HEAD:CHANGELOG.md') + '\n';
    expect(cl).toBe(rebuildChangelog(main, `## [1.0.2.0] - ${TODAY}\n\n- ours\n\n`));
    expect(git(staged.scratch, 'show', 'HEAD:VERSION')).toBe('1.0.2.0');
    expect(git(staged.scratch, 'show', 'HEAD:agents-digest/gstack-AGENTS.md')).toBe('# gstack digest v1.0.2.0');
    expect(git(staged.scratch, 'rev-list', '--parents', '-n1', 'HEAD').split(' ')).toHaveLength(3);
    const msg = git(staged.scratch, 'log', '-1', '--format=%B');
    expect(msg).toContain('1.0.1.0 -> 1.0.2.0');
    expect(msg).not.toMatch(/claimed by|#\d+ .*1\.0\.\d\.\d/);
    expect(git(t.fork, 'rev-parse', 'refs/heads/pr/feat')).toBe(staged.h0);
    const q = JSON.parse(fs.readFileSync(process.env.FAKE_QUEUE_LOG!, 'utf8').trim().split('\n').at(-1)!);
    expect(q.ghRepo).toBe('acme/gstack');
    expect(q.argv).toEqual(expect.arrayContaining(['--current-version', '1.0.1.0', '--exclude-pr', '7', '--workspace-root', 'null']));
  });

  test('four release-file conflicts and our version claimed: takes the queue slot (07f20bd96)', async () => {
    const t = topology('s2', {
      pr: d => { write(d, 'src/a.txt', 'a1\nOURS\na3\n'); release(d, '1.0.2.0', '2026-10-02', 'ours'); },
      main: d => release(d, '1.0.1.0', '2026-10-03', 'theirs'),
    });
    queue(t, { version: '1.0.3.0', base_version: '1.0.1.0', claimed: [{ pr: 12, version: '1.0.2.0' }] });
    const r = await run(t, ['merge']);
    expect(r.code, r.out.join('\n')).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    expect(s.version).toBe('1.0.3.0');
    expect(JSON.parse(git(s.scratch, 'show', 'HEAD:package.json')).version).toBe('1.0.3');
    expect(git(s.scratch, 'show', 'HEAD:CHANGELOG.md')).toStartWith(`# Changelog\n\nAll notable changes.\n\n## [1.0.3.0] - ${TODAY}\n\n- ours\n\n## [1.0.1.0] - 2026-10-03`);
  });

  test('a code conflict stops before any worktree is made (bf1fad6f8)', async () => {
    const t = topology('s3', { pr: ourFeature, main: d => write(d, 'src/a.txt', 'a1\nMAIN\na3\n') });
    queue(t, { version: '1.0.2.0', base_version: '1.0.0.0' });
    const r = await run(t, ['merge']);
    expect(r.code, r.out.join('\n')).toBe(20);
    expect(r.out.join('\n')).toContain('CONFLICT\tcode\tsrc/a.txt');
    expect(fs.existsSync(t.wt)).toBe(false);
    expect(readStagedSync(stateDir(t), pr)).toBeNull();
    expect(git(t.clone, 'status', '--porcelain')).toBe('');
  });

  test('upstream moved without a release: our unclaimed version and its date are kept (c285d88b9)', async () => {
    const t = topology('s4', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b1\nMAIN\nb3\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    const r = await run(t, ['merge']);
    expect(r.code, r.out.join('\n')).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    expect(s.version).toBe('1.0.1.0');
    expect(git(s.scratch, 'show', 'HEAD:CHANGELOG.md')).toContain('## [1.0.1.0] - 2026-10-02');
    expect(git(s.scratch, 'show', 'HEAD:src/b.txt')).toContain('MAIN');
  });

  test('up to date: nothing to do when unclaimed; a release-only commit when claimed', async () => {
    const t = topology('s5', { pr: ourFeature });
    queue(t, { version: '1.0.2.0', base_version: '1.0.0.0' });
    const idle = await run(t, ['merge']);
    expect(idle.code, idle.out.join('\n')).toBe(10);
    expect(fs.existsSync(path.join(t.wt, 'feat-sync'))).toBe(false);
    queue(t, { version: '1.0.2.0', base_version: '1.0.0.0', claimed: [{ pr: 12, version: '1.0.1.0' }] });
    const r = await run(t, ['merge']);
    expect(r.code, r.out.join('\n')).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    expect(s.kind).toBe('release-only');
    expect(git(s.scratch, 'rev-parse', 'HEAD^')).toBe(s.h0);
    expect(git(s.scratch, 'diff', '--name-only', 'HEAD^', 'HEAD').split('\n').sort()).toEqual(['CHANGELOG.md', 'VERSION', 'agents-digest/gstack-AGENTS.md', 'package.json']);
  });

  test('a generated-file conflict is regenerated from the merged template', async () => {
    const t = topology('s7', {
      pr: d => { const m = TMPL.replace('line 2', 'line 2 ours'); write(d, 'x/SKILL.md.tmpl', m); write(d, 'x/SKILL.md', render(m)); release(d, '1.0.1.0', '2026-10-02', 'ours'); },
      main: d => { const m = TMPL.replace('line 5', 'line 5 main'); write(d, 'x/SKILL.md.tmpl', m); write(d, 'x/SKILL.md', render(m)); },
    });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    const plan = await run(t, ['plan']);
    expect(plan.out.join('\n')).toContain('CONFLICT\tgenerated\tx/SKILL.md');
    const r = await run(t, ['merge']);
    expect(r.code, r.out.join('\n')).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    const tmpl = git(s.scratch, 'show', 'HEAD:x/SKILL.md.tmpl') + '\n';
    expect(tmpl).toContain('line 2 ours');
    expect(tmpl).toContain('line 5 main');
    expect(git(s.scratch, 'show', 'HEAD:x/SKILL.md') + '\n').toBe(render(tmpl));
  });

  test('preconditions: a VERSION move with no entry, or two entries, stops with 30', async () => {
    const noEntry = topology('s6a', { pr: d => { write(d, 'src/a.txt', 'a1\nOURS\na3\n'); write(d, 'VERSION', '1.0.1.0\n'); }, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(noEntry, { version: '1.0.1.0', base_version: '1.0.0.0' });
    expect((await run(noEntry, ['merge'])).code).toBe(30);
    const two = topology('s6b', { pr: d => { release(d, '1.0.1.0', '2026-10-02', 'one'); release(d, '1.0.2.0', '2026-10-02', 'two'); }, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(two, { version: '1.0.3.0', base_version: '1.0.0.0' });
    const r = await run(two, ['merge']);
    expect(r.code, r.out.join('\n')).toBe(30);
    expect(r.out[0]).toContain('2 CHANGELOG entries');
  });

  test('unpushed local commits and a renamed local branch are refused', async () => {
    const t = topology('s11', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    write(t.clone, 'src/c.txt', 'local only\n');
    git(t.clone, 'add', '-A');
    git(t.clone, 'commit', '-q', '-m', 'wip');
    expect((await run(t, ['merge'])).code).toBe(50);
    git(t.clone, 'checkout', '-q', '-b', 'pr/feat-r2');
    expect((await run(t, ['merge'])).code).toBe(30);
  });

  test('a queue that cannot be read is never guessed around (60), and the scratch worktree is removed', async () => {
    const t = topology('s12', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(t, { version: '1.0.2.0', base_version: '1.0.0.0', offline: true });
    const r = await run(t, ['merge']);
    expect(r.code, r.out.join('\n')).toBe(60);
    expect(fs.existsSync(path.join(t.wt, 'feat-sync'))).toBe(false);
    expect(git(t.clone, 'worktree', 'list').split('\n')).toHaveLength(1);
  });
});

// ── push ────────────────────────────────────────────────────────────────────

describe('push', () => {
  test('refuses without approval, without a green validation of the exact commit, and on a moved head; then pushes once', async () => {
    const t = topology('p1', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b1\nMAIN\nb3\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    expect((await run(t, ['merge'])).code).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    const forkHead = () => git(t.fork, 'rev-parse', 'refs/heads/pr/feat');

    const noYes = await run(t, ['push']);
    expect(noYes.code).toBe(2);
    expect(noYes.out[0]).toContain('approval missing');
    expect((await run(t, ['push', '--yes'])).code).toBe(31);
    recordValidation(t, s.h0, 0);
    expect((await run(t, ['push', '--yes'])).code).toBe(31);
    recordValidation(t, s.sha, 1);
    expect((await run(t, ['push', '--yes'])).code).toBe(31);
    recordValidation(t, s.sha, 0);
    const gated = await run(t, ['push', '--yes'], { preWriteGate: () => ({ ok: false, reason: 'unacknowledged P0 supersede' }) });
    expect(gated.code).toBe(30);
    expect(forkHead()).toBe(s.h0);

    const home = path.join(t.base, 'home');
    const before = listReceipts(home).filter(x => x.sink === 'pr-prep').length;
    const r = await run(t, ['push', '--yes']);
    expect(r.code, r.out.join('\n')).toBe(0);
    expect(forkHead()).toBe(s.sha);
    const receipts = listReceipts(home).filter(x => x.sink === 'pr-prep');
    expect(receipts.length).toBe(before + 1);
    expect(receipts.at(-1)).toMatchObject({ payload_class: 'pr-sync-push', consent: 'user ran /pr-prep', status: 'exit:0' });
    expect(git(t.clone, 'rev-parse', 'HEAD')).toBe(s.sha);
    expect(fs.existsSync(s.scratch)).toBe(false);
    expect(readStagedSync(stateDir(t), pr)).toBeNull();
    expect(readStateFor(stateDir(t), pr)?.bodyStaleSince).toBe(s.sha);
  });

  test('the remote head moving after the sync is staged stops the push (no force, no overwrite)', async () => {
    const t = topology('p2', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    expect((await run(t, ['merge'])).code).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    recordValidation(t, s.sha, 0);
    git(t.seed, 'checkout', '-q', 'pr/feat');
    write(t.seed, 'src/d.txt', 'someone else\n');
    git(t.seed, 'add', '-A');
    git(t.seed, 'commit', '-q', '-m', 'maintainer push');
    git(t.seed, 'push', '-q', t.fork, 'pr/feat');
    const moved = git(t.fork, 'rev-parse', 'refs/heads/pr/feat');
    const r = await run(t, ['push', '--yes']);
    expect(r.code, r.out.join('\n')).toBe(30);
    expect(r.out[0]).toContain('head moved');
    expect(git(t.fork, 'rev-parse', 'refs/heads/pr/feat')).toBe(moved);
  });

  test('the default gate polls the watch: a maintainer-proxy supersede comment stops the push', async () => {
    const t = topology('p4', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    expect((await run(t, ['merge'])).code).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    recordValidation(t, s.sha, 0);
    const quiet = fakeGh(t);
    const warned = ((args: string[]) => args[0] === 'api' && args[1]?.startsWith('repos/acme/gstack/issues/7/comments')
      ? { status: 0, stderr: '', stdout: JSON.stringify([{ id: 5, user: { login: 'capy-ai[bot]', type: 'Bot' }, author_association: 'CONTRIBUTOR', created_at: '2026-10-08T00:00:00Z', body: 'The fix wave rewrote the fix on another branch.' }]) }
      : quiet(args)) as GhRunner;
    const r = await run(t, ['push', '--yes'], { gh: warned });
    expect(r.code, r.out.join('\n')).toBe(30);
    expect(r.out[0]).toContain('superseded-comment');
    expect(git(t.fork, 'rev-parse', 'refs/heads/pr/feat')).toBe(s.h0);
  });

  test('a local pre-push hook refusal is exit 41 with the hook\'s own words, for push and retrigger', async () => {
    const t = topology('p6', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    expect((await run(t, ['merge'])).code).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    recordValidation(t, s.sha, 0);
    // The owner's installed hook prints this shape; git adds only "failed to push some refs".
    write(t.clone, '.git/hooks/pre-push', '#!/bin/sh\necho "pre-push: BLOCKED — secret-shaped token(s) in pushed range" >&2\necho "intentional override: git push --no-verify" >&2\nexit 1\n', 0o755);
    const r = await run(t, ['push', '--yes']);
    expect(r.code, r.out.join('\n')).toBe(41);
    expect(r.out[0]).toStartWith('RESULT HOOK_REFUSED');
    expect(r.out.join('\n')).toContain('pre-push: BLOCKED');
    expect(git(t.fork, 'rev-parse', 'refs/heads/pr/feat')).toBe(s.h0);
    expect(readStagedSync(stateDir(t), pr)?.sha).toBe(s.sha);
    expect(readStateFor(stateDir(t), pr)?.bodyStaleSince).toBeNull();

    expect((await run(t, ['abort'])).code).toBe(0);
    const msg = path.join(t.base, 'ci-msg.txt');
    fs.writeFileSync(msg, 'ci: re-run CI\n');
    const rt = await run(t, ['retrigger', '--message', msg, '--yes']);
    expect(rt.code, rt.out.join('\n')).toBe(41);
    expect(rt.out.join('\n')).toContain('pre-push: BLOCKED');
    expect(git(t.fork, 'rev-parse', 'refs/heads/pr/feat')).toBe(s.h0);
  });

  test('retrigger pushes one empty ci: commit on the head, with approval, and marks the body stale', async () => {
    const t = topology('p5', { pr: ourFeature });
    const msg = path.join(t.base, 'ci-msg.txt');
    fs.writeFileSync(msg, 'feat: not a ci message\n');
    expect((await run(t, ['retrigger', '--message', msg])).code).toBe(2);
    expect((await run(t, ['retrigger', '--message', msg, '--yes'])).code).toBe(2);
    fs.writeFileSync(msg, 'ci: re-run CI after a Bun IOCP crash on windows-free-shard (4)\n\nRun 1 failed with no failing test.\n');
    const h0 = git(t.fork, 'rev-parse', 'refs/heads/pr/feat');
    const r = await run(t, ['retrigger', '--message', msg, '--yes']);
    expect(r.code, r.out.join('\n')).toBe(0);
    const head = git(t.fork, 'rev-parse', 'refs/heads/pr/feat');
    expect(git(t.fork, 'rev-parse', `${head}^`)).toBe(h0);
    expect(git(t.fork, 'rev-parse', `${head}^{tree}`)).toBe(git(t.fork, 'rev-parse', `${h0}^{tree}`));
    expect(git(t.fork, 'log', '-1', '--format=%s', head)).toBe('ci: re-run CI after a Bun IOCP crash on windows-free-shard (4)');
    expect(readStateFor(stateDir(t), pr)?.bodyStaleSince).toBe(head);
    expect((await run(t, ['retrigger', '--message', msg, '--yes'])).code).toBe(32);
  });

  test('a stale body from an earlier push blocks the next one; abort removes a staged sync', async () => {
    const t = topology('p3', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    expect((await run(t, ['merge'])).code).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    recordValidation(t, s.sha, 0);
    const st = readStateFor(stateDir(t), pr)!;
    writeState(stateDir(t), { ...st, bodyStaleSince: 'a'.repeat(40) });
    expect((await run(t, ['push', '--yes'])).code).toBe(32);
    expect((await run(t, ['merge'])).code).toBe(50);
    const ab = await run(t, ['abort']);
    expect(ab.code).toBe(0);
    expect(fs.existsSync(s.scratch)).toBe(false);
    expect(readStagedSync(stateDir(t), pr)).toBeNull();
  });
});
