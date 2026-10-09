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
  qualifyQueue, pickVersion, cmpVersion, readStagedSync, classifyPush, defaultTool, pushUrlsOffTarget, type SyncDeps, type ToolRunner,
} from '../lib/pr-sync';
import { prStateDir, topicFor, readStateFor, writeState, defaultGit, type GhRunner, type GitRunner, type PrState } from '../lib/pr-context';
import { triageMain, writeRetriggerDraft } from '../lib/pr-ci-triage';
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
fs.writeFileSync('agents-digest/gstack-AGENTS.md', '# gstack digest v' + v + '\\n' + (fs.existsSync('rules.txt') ? fs.readFileSync('rules.txt', 'utf8') : ''));
console.log(JSON.stringify({ wrote: v, packageJson: true, packageJsonVersion: pkg.version, agentsDigest: true }));
`;
/** The digest is the version line plus rules.txt, when a tree has one; gen:skill-docs writes it too, as the real one does. */
const FAKE_DIGEST = `import fs from 'node:fs';
fs.writeFileSync('agents-digest/gstack-AGENTS.md', '# gstack digest v' + fs.readFileSync('VERSION', 'utf8').trim() + '\\n' + (fs.existsSync('rules.txt') ? fs.readFileSync('rules.txt', 'utf8') : ''));
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
const digest = '# gstack digest v' + fs.readFileSync('VERSION', 'utf8').trim() + '\\n' + (fs.existsSync('rules.txt') ? fs.readFileSync('rules.txt', 'utf8') : '');
if (fs.readFileSync('agents-digest/gstack-AGENTS.md', 'utf8') !== digest) { stale = true; if (!dry) fs.writeFileSync('agents-digest/gstack-AGENTS.md', digest); }
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

function topology(name: string, opts: { pr: (d: string) => void; main?: (d: string) => void; base?: (d: string) => void }): Topo {
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
  opts.base?.(seed);
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
    // retrigger's check for a newer Windows run on the head: none by default
    if (args[0] === 'run' && args[1] === 'list') return ok('[]');
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
  fs.writeFileSync(file, JSON.stringify({ host: 'github', offline: false, fallback: null, claimed: [], reason: 'test', warnings: [], ...answer }));
  process.env.FAKE_QUEUE = file;
  process.env.FAKE_QUEUE_LOG = path.join(t.base, 'queue.log');
}

/** Each topology gets its own state root: the clones share a slug and a topic, as two checkouts of one PR would. */
const envFor = (t: Topo): NodeJS.ProcessEnv => ({ ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') });

async function run(t: Topo, argv: string[], extra: Partial<SyncDeps> = {}, cwd = t.clone): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  process.env.GSTACK_STATE_ROOT = path.join(t.base, 'home');
  const code = await syncMain([...argv, '--pr', '7', '--repo', 'acme/gstack', '--cwd', cwd, '--worktree-root', t.wt], {
    gh: fakeGh(t), env: envFor(t), now: () => NOW, out: l => out.push(l), err: () => {}, readbackDelayMs: 0, ...extra,
  });
  return { code, out };
}

const stateDir = (t: Topo) => prStateDir({ cwd: t.clone, topic: topicFor('pr/feat'), env: envFor(t) });
const pr = { repo: 'acme/gstack', number: 7, headRef: 'pr/feat', headOwner: 'me' };

function recordValidation(t: Topo, sha: string, worst: 0 | 1, summary = worst ? '1 red' : 'all green'): void {
  const dir = stateDir(t);
  const s = readStateFor(dir, pr) as PrState;
  writeState(dir, { ...s, validation: { sha, worst, summary, at: NOW.toISOString() } });
}

const ourFeature = (d: string) => {
  write(d, 'src/a.txt', 'a1\nOURS\na3\n');
  release(d, '1.0.1.0', '2026-10-02', 'ours');
};

const forkHead = (t: Topo) => git(t.fork, 'rev-parse', 'refs/heads/pr/feat');

/** A ci: draft pair written by gstack-pr-ci-triage's own writer, bound to the fork head unless told otherwise. */
function ciDraft(t: Topo, opts: { run?: number; head?: string; message?: string; pr?: number; repo?: string } = {}): string {
  const head = opts.head ?? forkHead(t);
  const run = opts.run ?? 100;
  return writeRetriggerDraft(stateDir(t), {
    repo: opts.repo ?? 'acme/gstack', pr: opts.pr ?? 7, run, head, tree: git(t.fork, 'rev-parse', `${head}^{tree}`), shards: [],
    message: opts.message ?? `ci: re-run CI after a Bun IOCP crash on windows-free-shard (4)\n\nWindows Free Tests run ${run} on ${head.slice(0, 9)} failed with no failing test.\n`,
  }).message;
}

const retriggerReceipts = (t: Topo) => listReceipts(path.join(t.base, 'home')).filter(x => x.payload_class === 'pr-ci-retrigger-push').length;

const CI_FX = path.join(import.meta.dir, 'fixtures', 'pr-ci-triage');

/**
 * The sync fake gh plus the Windows Free Tests calls gstack-pr-ci-triage
 * makes: each run failed shard 4 with #3032 run 37346036310's real IOCP
 * result and shard log.
 */
function ciGh(t: Topo, runs: { id: number; sha: string }[]): GhRunner {
  const quiet = fakeGh(t);
  const ok = (v: unknown) => ({ status: 0, stdout: JSON.stringify(v), stderr: '' });
  const view = (r: { id: number; sha: string }) => ({
    databaseId: r.id, headSha: r.sha, headBranch: 'pr/feat', event: 'pull_request', conclusion: 'failure', status: 'completed', createdAt: '2026-10-06T00:00:00Z',
    jobs: [{ databaseId: 10, name: 'windows-free-shard (4)', conclusion: 'failure' }, { databaseId: 2, name: 'windows-free-tests', conclusion: 'failure' }],
  });
  return ((args: string[]) => {
    if (args[0] === 'run' && args[1] === 'list') {
      const commit = args.includes('--commit') ? args[args.indexOf('--commit') + 1] : null;
      return ok(runs.filter(r => !commit || r.sha === commit).map(view).sort((a, b) => b.databaseId - a.databaseId));
    }
    const r = runs.find(x => String(x.id) === args[2]);
    if (args[0] === 'run' && args[1] === 'view' && r) return ok(view(r));
    if (args[0] === 'run' && args[1] === 'download' && r) {
      const name = args[args.indexOf('-n') + 1];
      const dir = args[args.indexOf('-D') + 1];
      fs.mkdirSync(dir, { recursive: true });
      if (name === 'windows-result-4') fs.copyFileSync(path.join(CI_FX, '37346036310-result.json'), path.join(dir, 'shard-4.json'));
      else if (name === 'windows-free-test-shard-logs-4') fs.copyFileSync(path.join(CI_FX, '37346036310-shard.log.txt'), path.join(dir, 'shard.log'));
      else return { status: 1, stdout: '', stderr: 'no artifact' };
      return ok('');
    }
    return quiet(args);
  }) as GhRunner;
}

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

  test('renameBlockHeading rewrites only the version and date, keeping the rest of the heading', () => {
    expect(renameBlockHeading('## [1.0.1.0] - 2026-10-02\n\n- ours\n', '1.0.3.0', TODAY)).toBe(`## [1.0.3.0] - ${TODAY}\n\n- ours\n`);
    // 87 CHANGELOG headings carry a title after the date (`## [0.15.13.0] - 2026-04-04. Team Mode`).
    const titled = '## [1.0.1.0] - 2026-10-02. Team Mode\n\n- ours\n';
    expect(renameBlockHeading(titled, '1.0.1.0', '2026-10-02')).toBe(titled);
    expect(renameBlockHeading(titled, '1.0.3.0', TODAY)).toBe(`## [1.0.3.0] - ${TODAY}. Team Mode\n\n- ours\n`);
    expect(() => renameBlockHeading('- no heading\n', '1.0.3.0', TODAY)).toThrow();
  });

  test('qualifyQueue fails closed on every unusable answer (code 60)', () => {
    const ok = (j: Record<string, unknown>) => ({ status: 0, stdout: JSON.stringify({ version: '1.0.2.0', base_version: '1.0.1.0', host: 'github', offline: false, fallback: null, claimed: [], ...j }), stderr: '' });
    expect(qualifyQueue(ok({}), '1.0.1.0').version).toBe('1.0.2.0');
    // host "unknown" (an ssh alias origin, gh logged out) comes back offline:false, fallback:null, claimed:[]: the queue was never read.
    const unread = { host: 'unknown', warnings: ['host unknown; queue-awareness unavailable', 'host queue unavailable AND git found no claims'] };
    for (const bad of [ok({ offline: true }), ok({ fallback: 'git' }), ok({ base_version: '1.0.0.0' }), ok({ version: '1.0.2' }), ok(unread), ok({ host: 'gitlab' }), ok({ host: undefined }), ok({ warnings: ['host queue unavailable'] }), { status: 2, stdout: '', stderr: 'boom' }, { status: 0, stdout: 'nope', stderr: '' }]) {
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

  test('upstream turning a file the PR edits by hand into a generated one is code: a conflict stops (20), a clean merge proves CHANGED (21)', async () => {
    // y/SKILL.md is hand-written at the base; upstream adds y/SKILL.md.tmpl and renders it.
    const handWritten = (d: string) => write(d, 'y/SKILL.md', TMPL);
    const upstreamTemplate = (d: string) => { const m = TMPL.replace('line 2', 'line 2 main'); write(d, 'y/SKILL.md.tmpl', m); write(d, 'y/SKILL.md', render(m)); };
    const clash = topology('s14', {
      base: handWritten,
      pr: d => { write(d, 'y/SKILL.md', TMPL.replace('line 2', 'line 2 OURS')); release(d, '1.0.1.0', '2026-10-02', 'ours'); },
      main: upstreamTemplate,
    });
    queue(clash, { version: '1.0.1.0', base_version: '1.0.0.0' });
    const plan = await run(clash, ['plan']);
    expect(plan.code, plan.out.join('\n')).toBe(20);
    expect(plan.out.join('\n')).toContain('CONFLICT\tcode\ty/SKILL.md');
    expect((await run(clash, ['merge'])).code).toBe(20);

    // No textual conflict: the merge keeps our line 5, then regeneration from upstream's template drops it.
    const quiet = topology('s15', {
      base: handWritten,
      pr: d => { write(d, 'y/SKILL.md', TMPL.replace('line 5', 'line 5 OURS')); release(d, '1.0.1.0', '2026-10-02', 'ours'); },
      main: upstreamTemplate,
    });
    queue(quiet, { version: '1.0.1.0', base_version: '1.0.0.0' });
    const r = await run(quiet, ['merge']);
    expect(r.code, r.out.join('\n')).toBe(21);
    expect(r.out).toContain('CHANGED\ty/SKILL.md');
    expect(readStagedSync(stateDir(quiet), pr)?.proof).toBe('CHANGED');
  });

  test('no release of our own: the digest the generator rewrites is committed, and the scratch is clean', async () => {
    const t = topology('s16', {
      base: d => { write(d, 'rules.txt', 'rule 0\n'); write(d, 'agents-digest/gstack-AGENTS.md', '# gstack digest v1.0.0.0\nrule 0\n'); },
      pr: d => { write(d, 'rules.txt', 'rule 0\nrule added by the PR\n'); write(d, 'agents-digest/gstack-AGENTS.md', '# gstack digest v1.0.0.0\nrule 0\nrule added by the PR\n'); },
      main: d => write(d, 'src/b.txt', 'b1\nMAIN\nb3\n'),
    });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    const r = await run(t, ['merge']);
    expect(r.code, r.out.join('\n')).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    expect(git(s.scratch, 'show', 'HEAD:agents-digest/gstack-AGENTS.md')).toBe('# gstack digest v1.0.0.0\nrule 0\nrule added by the PR');
    expect(git(s.scratch, 'status', '--porcelain')).toBe('');
  });

  test('no release of our own while upstream releases: the record, RESULT line and commit say VERSION is upstream\'s', async () => {
    const t = topology('s17', { pr: d => write(d, 'src/a.txt', 'a1\nOURS\na3\n'), main: d => release(d, '1.0.1.0', '2026-10-03', 'theirs') });
    queue(t, { version: '1.0.2.0', base_version: '1.0.1.0' });
    const r = await run(t, ['merge']);
    expect(r.code, r.out.join('\n')).toBe(0);
    expect(r.out[0]).toContain('release=no');
    const s = readStagedSync(stateDir(t), pr)!;
    expect(s.version).toBe('1.0.1.0');
    expect(git(s.scratch, 'show', 'HEAD:VERSION')).toBe(s.version);
    const msg = git(s.scratch, 'log', '-1', '--format=%B');
    expect(msg).toContain('No release of our own');
    expect(msg).not.toContain('our CHANGELOG entry');
    expect(msg).not.toMatch(/kept|re-slotted/);
  });

  test('bun install runs once, in the merged tree, so the tools use upstream\'s lockfile', async () => {
    const t = topology('s18', {
      base: d => write(d, 'bun.lock', '{"lockfileVersion":1,"deps":"old"}\n'),
      pr: ourFeature,
      main: d => { write(d, 'bun.lock', '{"lockfileVersion":1,"deps":"new from upstream"}\n'); write(d, 'src/b.txt', 'b9\n'); },
    });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    const installs: string[] = [];
    const tool: ToolRunner = (cmd, args, opts) => {
      if (cmd === 'bun' && args[0] === 'install') {
        installs.push(fs.readFileSync(path.join(opts.cwd, 'bun.lock'), 'utf8'));
        return { status: 0, stdout: '', stderr: '' };
      }
      return defaultTool(cmd, args, opts);
    };
    const r = await run(t, ['merge'], { tool });
    expect(r.code, r.out.join('\n')).toBe(0);
    expect(installs).toEqual(['{"lockfileVersion":1,"deps":"new from upstream"}\n']);
  });

  test('plan\'s dry run reads the same git config as the real merge (a user merge.renames=false is a code conflict)', async () => {
    const t = topology('s19', {
      pr: d => { fs.renameSync(path.join(d, 'src/a.txt'), path.join(d, 'src/a2.txt')); release(d, '1.0.1.0', '2026-10-02', 'ours'); },
      main: d => write(d, 'src/a.txt', 'a1\nMAIN\na3\n'),
    });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    const cfg = path.join(t.base, 'user.gitconfig');
    fs.writeFileSync(cfg, '[merge]\n\trenames = false\n');
    const was = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = cfg;
    try {
      const plan = await run(t, ['plan']);
      expect(plan.code, plan.out.join('\n')).toBe(20);
      expect(plan.out.join('\n')).toContain('CONFLICT\tcode\tsrc/a.txt');
    } finally {
      process.env.GIT_CONFIG_GLOBAL = was;
    }
  });

  test('code-diff proof: upstream landing our own hunk is CHANGED (21, push needs --accept-diff-change); an edit beside it is CONTEXT-ONLY', async () => {
    const t = topology('s20', { pr: ourFeature, main: d => { write(d, 'src/a.txt', 'a1\nOURS\na3\n'); write(d, 'src/b.txt', 'b9\n'); } });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    const r = await run(t, ['merge']);
    expect(r.code, r.out.join('\n')).toBe(21);
    expect(r.out[0]).toStartWith('RESULT DIFF_CHANGED');
    expect(r.out).toContain('CHANGED\tsrc/a.txt');
    const s = readStagedSync(stateDir(t), pr)!;
    expect(s).toMatchObject({ proof: 'CHANGED', changedFiles: ['src/a.txt'] });
    recordValidation(t, s.sha, 0);
    expect((await run(t, ['push', '--yes'])).code).toBe(21);
    expect(git(t.fork, 'rev-parse', 'refs/heads/pr/feat')).toBe(s.h0);
    const pushed = await run(t, ['push', '--yes', '--accept-diff-change']);
    expect(pushed.code, pushed.out.join('\n')).toBe(0);
    expect(git(t.fork, 'rev-parse', 'refs/heads/pr/feat')).toBe(s.sha);

    const lines = 'l1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\n';
    const near = topology('s21', {
      base: d => write(d, 'src/long.txt', lines),
      pr: d => { write(d, 'src/long.txt', lines.replace('l3', 'l3 OURS')); release(d, '1.0.1.0', '2026-10-02', 'ours'); },
      main: d => write(d, 'src/long.txt', lines.replace('l5', 'l5 MAIN')),
    });
    queue(near, { version: '1.0.1.0', base_version: '1.0.0.0' });
    const c = await run(near, ['merge']);
    expect(c.code, c.out.join('\n')).toBe(0);
    expect(c.out[0]).toContain('proof=CONTEXT-ONLY');
    expect(readStagedSync(stateDir(near), pr)?.changedFiles).toEqual([]);
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

  test('a merge leaves SIGINT and SIGTERM at their default, so a signal ends it', async () => {
    // merge is synchronous (spawnSync throughout), so a JS signal listener could
    // never run during it; installing one would only swallow the signal.
    const t = topology('s13', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    const before = { int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') };
    const during: { int: number; term: number }[] = [];
    const tool: ToolRunner = (cmd, args, opts) => {
      if (args.includes('gen:skill-docs')) during.push({ int: process.listenerCount('SIGINT'), term: process.listenerCount('SIGTERM') });
      return defaultTool(cmd, args, opts);
    };
    const r = await run(t, ['merge'], { tool });
    expect(r.code, r.out.join('\n')).toBe(0);
    expect(during.length).toBeGreaterThan(0);
    for (const x of during) expect(x).toEqual(before);
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
    // a ci: draft for the head this push replaces
    const oldDraft = ciDraft(t, { head: s.h0 });
    const r = await run(t, ['push', '--yes']);
    expect(r.code, r.out.join('\n')).toBe(0);
    expect(forkHead()).toBe(s.sha);
    expect(fs.existsSync(oldDraft)).toBe(false);
    expect(fs.existsSync(oldDraft.replace(/\.txt$/, '.json'))).toBe(false);
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

  test('push re-pins the head itself: a head that moved after a passing gate is 40, nothing sent, never overwritten', async () => {
    const t = topology('p14', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
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
    // A gate that saw nothing (it ran before the push landed); push's own pin must catch it before anything is sent.
    const sent = () => listReceipts(path.join(t.base, 'home')).filter(x => x.sink === 'pr-prep').length;
    const before = sent();
    const r = await run(t, ['push', '--yes'], { preWriteGate: () => ({ ok: true, reason: 'ok' }) });
    expect(r.code, r.out.join('\n')).toBe(40);
    expect(r.out[0]).toStartWith('RESULT REMOTE_MOVED');
    expect(sent()).toBe(before);
    expect(git(t.fork, 'rev-parse', 'refs/heads/pr/feat')).toBe(moved);
    expect(readStagedSync(stateDir(t), pr)?.sha).toBe(s.sha);
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

  test('a P0 another poll latches after the gate passed stops push and retrigger under the lock: nothing sent', async () => {
    const t = topology('p19', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    expect((await run(t, ['merge'])).code).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    recordValidation(t, s.sha, 0);
    // This write's gate saw a quiet PR; a concurrent poll (the LaunchAgent, another session) then latches a P0.
    const latchAfterGate = () => {
      const st = readStateFor(stateDir(t), pr)!;
      writeState(stateDir(t), { ...st, signals: { latched: [{ id: 'comment:900', level: 'P0', kind: 'superseded-comment', at: NOW.toISOString(), ref: 'issuecomment-900' }], acked: [] } });
      return { ok: true, reason: 'ok' };
    };
    const sent = () => listReceipts(path.join(t.base, 'home')).filter(x => x.sink === 'pr-prep').length;
    const before = sent();
    const r = await run(t, ['push', '--yes'], { preWriteGate: latchAfterGate });
    expect(r.code, r.out.join('\n')).toBe(30);
    expect(r.out[0]).toContain('P0 superseded-comment [comment:900]');
    expect(forkHead(t)).toBe(s.h0);
    expect(sent()).toBe(before);
    expect(readStagedSync(stateDir(t), pr)?.sha).toBe(s.sha);
    expect((await run(t, ['abort'])).code).toBe(0);
    const rt = await run(t, ['retrigger', '--message', ciDraft(t), '--yes'], { preWriteGate: latchAfterGate });
    expect(rt.code, rt.out.join('\n')).toBe(30);
    expect(rt.out[0]).toContain('[comment:900]');
    expect(forkHead(t)).toBe(s.h0);
    expect(retriggerReceipts(t)).toBe(0);
  });

  test('a read-back failure after a landed push still records it: body stale, staged sync gone, branch forwarded', async () => {
    const t = topology('p7', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    expect((await run(t, ['merge'])).code).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    recordValidation(t, s.sha, 0);
    const quiet = fakeGh(t);
    // gh pr view answers until the fork head moves, then GitHub has a bad moment.
    const flaky = ((args: string[]) => args[0] === 'pr' && args[1] === 'view' && git(t.fork, 'rev-parse', 'refs/heads/pr/feat') !== s.h0
      ? { status: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' }
      : quiet(args)) as GhRunner;
    const r = await run(t, ['push', '--yes'], { gh: flaky });
    expect(r.code, r.out.join('\n')).toBe(0);
    expect(r.out[0]).toStartWith('RESULT PUSHED');
    expect(r.out[0]).toContain('readback=unverified');
    expect(git(t.fork, 'rev-parse', 'refs/heads/pr/feat')).toBe(s.sha);
    expect(readStateFor(stateDir(t), pr)?.bodyStaleSince).toBe(s.sha);
    expect(readStagedSync(stateDir(t), pr)).toBeNull();
    expect(fs.existsSync(s.scratch)).toBe(false);
    expect(git(t.clone, 'rev-parse', 'HEAD')).toBe(s.sha);
    // The stale-body gate now holds for the next write, even for a draft bound to the new head.
    const msg = ciDraft(t);
    expect((await run(t, ['retrigger', '--message', msg, '--yes'])).code).toBe(32);
  });

  test('a PR retargeted to another base after the sync was staged is refused (30)', async () => {
    const t = topology('p11', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    expect((await run(t, ['merge'])).code).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    expect(s.baseRef).toBe('main');
    recordValidation(t, s.sha, 0);
    git(t.seed, 'push', '-q', t.up, 'main:refs/heads/develop');
    const quiet = fakeGh(t);
    const retargeted = ((args: string[]) => {
      const r = quiet(args);
      return args[0] === 'pr' && args[1] === 'view' ? { ...r, stdout: r.stdout.replace('"baseRefName":"main"', '"baseRefName":"develop"') } : r;
    }) as GhRunner;
    const r = await run(t, ['push', '--yes'], { gh: retargeted });
    expect(r.code, r.out.join('\n')).toBe(30);
    expect(r.out[0]).toContain('develop');
    expect(git(t.fork, 'rev-parse', 'refs/heads/pr/feat')).toBe(s.h0);
  });

  test('a send more than 60 s after the pre-write gate is refused, for push and retrigger', async () => {
    const t = topology('p12', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    expect((await run(t, ['merge'])).code).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    recordValidation(t, s.sha, 0);
    // Once the gate has run, the clock reads 61 s later (a slow lock wait or fetch before the send).
    const slow = () => {
      let answered = false;
      return {
        preWriteGate: () => { answered = true; return { ok: true, reason: 'ok' }; },
        now: () => (answered ? new Date(NOW.getTime() + 61_000) : NOW),
      };
    };
    const r = await run(t, ['push', '--yes'], slow());
    expect(r.code, r.out.join('\n')).toBe(30);
    expect(r.out[0]).toContain('60 s');
    expect(git(t.fork, 'rev-parse', 'refs/heads/pr/feat')).toBe(s.h0);
    expect((await run(t, ['abort'])).code).toBe(0);
    const rt = await run(t, ['retrigger', '--message', ciDraft(t), '--yes'], slow());
    expect(rt.code, rt.out.join('\n')).toBe(30);
    expect(rt.out[0]).toContain('60 s');
    expect(git(t.fork, 'rev-parse', 'refs/heads/pr/feat')).toBe(s.h0);
  });

  test('a validation that waived the full suite needs --accept-full-risk on the push too', async () => {
    const t = topology('p13', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    expect((await run(t, ['merge'])).code).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    // gstack-pr-validate run --accept-full-risk records this summary (lib/pr-validate.ts).
    recordValidation(t, s.sha, 0, '3/3 selected files green; FULL waived (bunfig.toml): the full suite did not run');
    expect((await run(t, ['status'])).out[0]).toContain('validation=green-full-waived');
    const refused = await run(t, ['push', '--yes']);
    expect(refused.code, refused.out.join('\n')).toBe(31);
    expect(refused.out[0]).toContain('--accept-full-risk');
    expect(git(t.fork, 'rev-parse', 'refs/heads/pr/feat')).toBe(s.h0);
    const r = await run(t, ['push', '--yes', '--accept-full-risk']);
    expect(r.code, r.out.join('\n')).toBe(0);
    expect(git(t.fork, 'rev-parse', 'refs/heads/pr/feat')).toBe(s.sha);
  });

  test('a push URL that is not the PR head repo is refused before anything is sent', async () => {
    const t = topology('p10', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    expect((await run(t, ['merge'])).code).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    recordValidation(t, s.sha, 0);
    // The fetch URL names me/gstack (so the head remote matched); pushes would go elsewhere.
    const elsewhere = path.join(t.base, 'elsewhere', 'other', 'repo.git');
    fs.mkdirSync(elsewhere, { recursive: true });
    git(elsewhere, 'init', '-q', '--bare', '-b', 'main');
    git(t.clone, 'config', 'remote.origin.pushurl', elsewhere);
    const r = await run(t, ['push', '--yes']);
    expect(r.code, r.out.join('\n')).toBe(30);
    expect(r.out[0]).toContain('push URL');
    expect(git(t.fork, 'rev-parse', 'refs/heads/pr/feat')).toBe(s.h0);
    expect(spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/pr/feat'], { cwd: elsewhere, timeout: 30_000 }).status).not.toBe(0);
    expect(readStagedSync(stateDir(t), pr)?.sha).toBe(s.sha);
    expect(readStateFor(stateDir(t), pr)?.bodyStaleSince).toBeNull();
  });

  test('a push URL with the head repo\'s OWNER/NAME on another host or path is refused, for push and retrigger', async () => {
    const t = topology('p22', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    expect((await run(t, ['merge'])).code).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    recordValidation(t, s.sha, 0);
    // Same me/gstack path, another repository: a pushurl or a pushInsteadOf rule sends the push there.
    const mirror = path.join(t.base, 'mirror-host', 'me', 'gstack.git');
    fs.mkdirSync(mirror, { recursive: true });
    git(mirror, 'init', '-q', '--bare', '-b', 'main');
    const mirrorHead = () => spawnSync('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/pr/feat'], { cwd: mirror, timeout: 30_000 }).status;
    const sent = () => listReceipts(path.join(t.base, 'home')).filter(x => x.sink === 'pr-prep').length;
    const before = sent();
    for (const [key, value] of [['remote.origin.pushurl', mirror], [`url.${path.join(t.base, 'mirror-host')}/.pushInsteadOf`, path.join(t.base, 'fork') + '/']]) {
      git(t.clone, 'config', key, value);
      const r = await run(t, ['push', '--yes']);
      expect(r.code, r.out.join('\n')).toBe(30);
      expect(r.out[0]).toContain('push URL');
      git(t.clone, 'config', '--unset', key);
    }
    expect(sent()).toBe(before);
    expect(forkHead(t)).toBe(s.h0);
    expect(mirrorHead()).not.toBe(0);
    expect(readStagedSync(stateDir(t), pr)?.sha).toBe(s.sha);
    expect(readStateFor(stateDir(t), pr)?.bodyStaleSince).toBeNull();

    expect((await run(t, ['abort'])).code).toBe(0);
    git(t.clone, 'config', 'remote.origin.pushurl', mirror);
    const rt = await run(t, ['retrigger', '--message', ciDraft(t), '--yes']);
    expect(rt.code, rt.out.join('\n')).toBe(30);
    expect(retriggerReceipts(t)).toBe(0);
    expect(mirrorHead()).not.toBe(0);
  });

  test('pushUrlsOffTarget: a push URL must reach the fetch URL\'s host (ssh aliases resolved) and name the repo', () => {
    const alias = (a: string) => ({ 'gh-work': 'github.com', 'gh-evil': 'gitlab.example.com' } as Record<string, string>)[a] ?? null;
    const off = (fetch: string, push: string) => pushUrlsOffTarget(fetch, [push], 'me/gstack', '/w', alias).length > 0;
    const gh = 'https://github.com/me/gstack.git';
    expect(off(gh, 'git@github.com:me/gstack.git')).toBe(false);
    expect(off(gh, 'ssh://git@ssh.github.com:443/me/gstack.git')).toBe(false);
    expect(off(gh, 'git@gh-work:me/gstack.git')).toBe(false);
    expect(off('git@gh-work:me/gstack.git', 'https://github.com/me/gstack')).toBe(false);
    expect(off(gh, 'git@gh-evil:me/gstack.git')).toBe(true);
    expect(off(gh, 'git@gh-unknown:me/gstack.git')).toBe(true);
    expect(off(gh, 'https://gitlab.com/me/gstack.git')).toBe(true);
    // an https host is never an ssh alias
    expect(off(gh, 'https://gh-work/me/gstack.git')).toBe(true);
    expect(off(gh, 'https://github.com/other/gstack.git')).toBe(true);
    expect(off(gh, '/srv/mirror/me/gstack.git')).toBe(true);
    // local paths: the same repository only
    expect(off('/srv/fork/me/gstack.git', '/srv/fork/me/gstack.git/')).toBe(false);
    expect(off('/srv/fork/me/gstack.git', 'file:///srv/fork/me/gstack.git')).toBe(false);
    expect(off('/srv/fork/me/gstack.git', '/srv/mirror/me/gstack.git')).toBe(true);
    expect(off('/srv/fork/me/gstack.git', gh)).toBe(true);
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
    const rt = await run(t, ['retrigger', '--message', ciDraft(t), '--yes']);
    expect(rt.code, rt.out.join('\n')).toBe(41);
    expect(rt.out.join('\n')).toContain('pre-push: BLOCKED');
    expect(git(t.fork, 'rev-parse', 'refs/heads/pr/feat')).toBe(s.h0);
  });

  test('retrigger pushes one empty ci: commit on the head, with approval, and marks the body stale', async () => {
    const t = topology('p5', { pr: ourFeature });
    const notCi = ciDraft(t, { message: 'feat: not a ci message\n' });
    expect((await run(t, ['retrigger', '--message', notCi])).code).toBe(2);
    expect((await run(t, ['retrigger', '--message', notCi, '--yes'])).code).toBe(2);
    const msg = ciDraft(t);
    const h0 = forkHead(t);
    const r = await run(t, ['retrigger', '--message', msg, '--yes']);
    expect(r.code, r.out.join('\n')).toBe(0);
    const head = forkHead(t);
    expect(git(t.fork, 'rev-parse', `${head}^`)).toBe(h0);
    expect(git(t.fork, 'rev-parse', `${head}^{tree}`)).toBe(git(t.fork, 'rev-parse', `${h0}^{tree}`));
    expect(git(t.fork, 'log', '-1', '--format=%s', head)).toBe('ci: re-run CI after a Bun IOCP crash on windows-free-shard (4)');
    expect(readStateFor(stateDir(t), pr)?.bodyStaleSince).toBe(head);
    // the landed push removed the draft pair: it named a head that is no longer the PR's
    expect(fs.readdirSync(stateDir(t)).filter(e => e.startsWith('ci-retrigger-'))).toEqual([]);
    expect((await run(t, ['retrigger', '--message', ciDraft(t), '--yes'])).code).toBe(32);
  });

  test('a ci: draft gstack-pr-ci-triage bound to an older head is refused after the head moves, nothing sent', async () => {
    const t = topology('p16', { pr: ourFeature });
    const h1 = forkHead(t);
    const gh = ciGh(t, [{ id: 100, sha: h1 }]);
    const out: string[] = [];
    expect(await triageMain(['run', '--pr', '7', '--repo', 'acme/gstack', '--cwd', t.clone], { gh, env: envFor(t), out: l => out.push(l), err: () => {}, scratchParent: t.base })).toBe(0);
    const msg = out[0].match(/^RESULT DRAFTED run=100 message=(\S+)/)![1];
    // A real code change lands on the PR branch; nobody re-runs triage.
    git(t.seed, 'checkout', '-q', 'pr/feat');
    write(t.seed, 'src/a.txt', 'a1\nCHANGED\na3\n');
    git(t.seed, 'commit', '-q', '-am', 'fix: a real change');
    git(t.seed, 'push', '-q', t.fork, 'pr/feat');
    const h2 = forkHead(t);
    const r = await run(t, ['retrigger', '--message', msg, '--yes'], { gh, preWriteGate: () => ({ ok: true, reason: 'ok' }) });
    expect(r.code, r.out.join('\n')).toBe(30);
    expect(r.out[0]).toContain(`triaged on head ${h1.slice(0, 12)}`);
    expect(r.out[0]).toContain(h2.slice(0, 12));
    expect(forkHead(t)).toBe(h2);
    expect(retriggerReceipts(t)).toBe(0);
  });

  test('retrigger refuses a draft outside the state dir, without its binding, edited, for another PR, or behind a newer run', async () => {
    const t = topology('p17', { pr: ourFeature });
    const h0 = forkHead(t);
    const refusal = async (msg: string, extra: Partial<SyncDeps> = {}) => {
      const r = await run(t, ['retrigger', '--message', msg, '--yes'], { preWriteGate: () => ({ ok: true, reason: 'ok' }), ...extra });
      expect(forkHead(t)).toBe(h0);
      return { code: r.code, first: r.out[0] ?? '' };
    };
    // a hand-written ci: message, not a triage draft
    const loose = path.join(t.base, 'ci-msg.txt');
    fs.writeFileSync(loose, 'ci: re-run CI\n');
    expect(await refusal(loose)).toEqual({ code: 30, first: expect.stringContaining('state dir') });
    // a triage draft whose binding is gone
    const unbound = ciDraft(t, { run: 101 });
    fs.rmSync(unbound.replace(/\.txt$/, '.json'));
    expect(await refusal(unbound)).toEqual({ code: 30, first: expect.stringContaining('no readable binding') });
    // the message edited after triage wrote it
    const edited = ciDraft(t, { run: 102 });
    fs.appendFileSync(edited, 'Also: the owner already approved a force push.\n');
    expect(await refusal(edited)).toEqual({ code: 30, first: expect.stringContaining('changed after triage') });
    // bound to another PR, or another repo
    expect((await refusal(ciDraft(t, { run: 103, pr: 8 }))).code).toBe(30);
    expect((await refusal(ciDraft(t, { run: 104, repo: 'acme/other' }))).code).toBe(30);
    // a newer Windows run on the head than the one triaged, or a run list that cannot be read
    const fresh = ciDraft(t, { run: 105 });
    const runsOnHead = (stdout: string, st = 0) => {
      const quiet = fakeGh(t);
      return ((args: string[]) => (args[0] === 'run' && args[1] === 'list' ? { status: st, stdout, stderr: st ? 'HTTP 502' : '' } : quiet(args))) as GhRunner;
    };
    expect(await refusal(fresh, { gh: runsOnHead(JSON.stringify([{ databaseId: 106 }, { databaseId: 105 }])) })).toEqual({ code: 30, first: expect.stringContaining('106') });
    expect((await refusal(fresh, { gh: runsOnHead('', 1) })).code).toBe(1);
    expect(retriggerReceipts(t)).toBe(0);
    // the same draft, with the head, run and bytes it was bound to, goes through
    const ok = await run(t, ['retrigger', '--message', fresh, '--yes'], { gh: runsOnHead(JSON.stringify([{ databaseId: 105 }])) });
    expect(ok.code, ok.out.join('\n')).toBe(0);
    expect(retriggerReceipts(t)).toBe(1);
  });

  test('merge and abort never touch a scratch path gstack-pr-sync did not make', async () => {
    const t = topology('p8', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    const occupied = path.join(t.wt, 'feat-sync');
    // 1. An unrelated repository with uncommitted work.
    fs.mkdirSync(occupied, { recursive: true });
    git(occupied, 'init', '-q', '-b', 'main');
    write(occupied, 'notes.txt', 'owner notes\n');
    git(occupied, 'add', '-A');
    git(occupied, 'commit', '-q', '-m', 'notes');
    write(occupied, 'wip.txt', 'uncommitted\n');
    const m = await run(t, ['merge']);
    expect(m.code, m.out.join('\n')).toBe(50);
    expect(m.out[0]).not.toContain('abort');
    expect(readStagedSync(stateDir(t), pr)).toBeNull();
    const a = await run(t, ['abort']);
    expect(a.code, a.out.join('\n')).toBe(50);
    expect(fs.readFileSync(path.join(occupied, 'wip.txt'), 'utf8')).toBe('uncommitted\n');
    fs.rmSync(occupied, { recursive: true, force: true });
    // 2. The owner's own worktrees of this repository there, on a branch and detached.
    for (const how of [['-b', 'owner-work'], ['--detach']]) {
      git(t.clone, 'worktree', 'add', '-q', ...how, occupied, 'HEAD');
      write(occupied, 'src/a.txt', 'owner edit\n');
      const ab = await run(t, ['abort']);
      expect(ab.code, ab.out.join('\n')).toBe(50);
      expect(fs.readFileSync(path.join(occupied, 'src/a.txt'), 'utf8')).toBe('owner edit\n');
      git(t.clone, 'worktree', 'remove', '--force', occupied);
    }
  });

  test('an interrupted merge leaves a scratch that merge names and abort removes', async () => {
    const t = topology('p9', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    expect((await run(t, ['merge'])).code).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    // A merge killed before it recorded the sync leaves the scratch and no sync.json.
    fs.rmSync(path.join(stateDir(t), 'sync.json'));
    const m = await run(t, ['merge']);
    expect(m.code, m.out.join('\n')).toBe(50);
    expect(m.out[0]).toContain('gstack-pr-sync abort');
    const a = await run(t, ['abort']);
    expect(a.code, a.out.join('\n')).toBe(0);
    expect(fs.existsSync(s.scratch)).toBe(false);
    expect(git(t.clone, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  test('a moved-aside sibling worktree with a unique commit survives abort, a failed merge and a push', async () => {
    const t = topology('p20', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    // The owner's detached worktree, one commit only it holds, its directory moved away (an unmounted volume, a rename).
    const sib = path.join(t.base, 'sibling');
    git(t.clone, 'worktree', 'add', '-q', '--detach', sib, 'HEAD');
    write(sib, 'only-here.txt', 'unique\n');
    git(sib, 'add', 'only-here.txt');
    git(sib, 'commit', '-q', '-m', 'only here');
    const unique = git(sib, 'rev-parse', 'HEAD');
    fs.renameSync(sib, `${sib}.moved`);
    const registered = () => git(t.clone, 'worktree', 'list', '--porcelain').split('\n').includes(`worktree ${sib}`);
    expect(registered()).toBe(true);

    const ab = await run(t, ['abort']);
    expect(ab.code, ab.out.join('\n')).toBe(0);
    expect(ab.out[0]).toContain('(absent)');
    expect(registered()).toBe(true);

    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0', offline: true });
    expect((await run(t, ['merge'])).code).toBe(60);
    expect(registered()).toBe(true);

    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    expect((await run(t, ['merge'])).code).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    recordValidation(t, s.sha, 0);
    const p = await run(t, ['push', '--yes']);
    expect(p.code, p.out.join('\n')).toBe(0);
    expect(fs.existsSync(s.scratch)).toBe(false);
    expect(registered()).toBe(true);

    fs.renameSync(`${sib}.moved`, sib);
    expect(spawnSync('git', ['status', '--porcelain'], { cwd: sib, timeout: 30_000 }).status).toBe(0);
    expect(git(sib, 'rev-parse', 'HEAD')).toBe(unique);
  });

  test('abort clears the registration of its own scratch deleted by hand, and only that one', async () => {
    const t = topology('p21', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    expect((await run(t, ['merge'])).code).toBe(0);
    const s = readStagedSync(stateDir(t), pr)!;
    const listed = () => git(t.clone, 'worktree', 'list', '--porcelain').split('\n').filter(l => l.startsWith('worktree ')).map(l => l.slice(9));
    fs.rmSync(s.scratch, { recursive: true, force: true });
    // Another worktree of the repo whose directory is also gone, and not the scratch: left registered.
    const other = path.join(t.base, 'other-wt');
    git(t.clone, 'worktree', 'add', '-q', '--detach', other, 'HEAD');
    fs.rmSync(other, { recursive: true, force: true });
    const a = await run(t, ['abort']);
    expect(a.code, a.out.join('\n')).toBe(0);
    expect(listed()).toEqual([t.clone, other]);
    // The path is free again: the next merge can add its scratch there.
    expect((await run(t, ['merge'])).code).toBe(0);
    // The owner's own worktree registered at the scratch path, directory gone: no marker, so abort leaves it.
    expect((await run(t, ['abort'])).code).toBe(0);
    git(t.clone, 'worktree', 'add', '-q', '--detach', s.scratch, 'HEAD');
    fs.rmSync(s.scratch, { recursive: true, force: true });
    expect((await run(t, ['abort'])).code).toBe(0);
    expect(listed()).toEqual([t.clone, other, s.scratch]);
  });

  test('run from a linked worktree of the PR checkout, merge marks its scratch and abort removes it', async () => {
    const t = topology('p15', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    git(t.clone, 'checkout', '-q', 'main');
    const linked = path.join(t.base, 'linked');
    git(t.clone, 'worktree', 'add', '-q', linked, 'pr/feat');
    expect((await run(t, ['merge'], {}, linked)).code).toBe(0);
    const s = readStagedSync(prStateDir({ cwd: linked, topic: topicFor('pr/feat'), env: envFor(t) }), pr)!;
    expect(fs.existsSync(s.scratch)).toBe(true);
    const a = await run(t, ['abort'], {}, linked);
    expect(a.code, a.out.join('\n')).toBe(0);
    expect(fs.existsSync(s.scratch)).toBe(false);
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

  test('a sync a closed PR left staged names that PR, and abort --pr <it> clears it; the new PR never merges onto its state', async () => {
    const t = topology('p18', { pr: ourFeature, main: d => write(d, 'src/b.txt', 'b9\n') });
    queue(t, { version: '1.0.1.0', base_version: '1.0.0.0' });
    // PR #6 from pr/feat stages a sync and is then closed; #7 is opened from the same branch.
    const as6 = (state: string): GhRunner => {
      const base = fakeGh(t);
      return ((args: string[]) => {
        if (args[0] !== 'pr' || args[1] !== 'view' || args[2] !== '6') return base(args);
        const view = JSON.parse(base(args).stdout) as Record<string, unknown>;
        return { status: 0, stderr: '', stdout: JSON.stringify({ ...view, number: 6, state, url: 'https://github.com/acme/gstack/pull/6' }) };
      }) as GhRunner;
    };
    let worktreeAdds = 0;
    const counting = { git: ((args, o) => { if (args[0] === 'worktree' && args[1] === 'add') worktreeAdds++; return defaultGit(args, o); }) as GitRunner };
    const as = async (n: number, gh: GhRunner, argv: string[]) => {
      const out: string[] = [];
      const code = await syncMain([...argv, '--pr', String(n), '--repo', 'acme/gstack', '--cwd', t.clone, '--worktree-root', t.wt], {
        gh, env: envFor(t), now: () => NOW, out: l => out.push(l), err: () => {}, readbackDelayMs: 0, ...counting,
      });
      return { code, out };
    };
    expect((await as(6, as6('OPEN'), ['merge'])).code).toBe(0);
    const s6 = readStagedSync(stateDir(t), { repo: 'acme/gstack', number: 6 })!;
    expect(fs.existsSync(s6.scratch)).toBe(true);

    const st = await as(7, as6('CLOSED'), ['status']);
    expect(st.code, st.out.join('\n')).toBe(30);
    expect(st.out[0]).toContain('#6');
    expect(st.out[0]).toContain('gstack-pr-sync abort --pr 6');
    // abort is local: it runs for the closed PR that staged the sync, and removes only what that PR made.
    const ab = await as(6, as6('CLOSED'), ['abort']);
    expect(ab.code, ab.out.join('\n')).toBe(0);
    expect(fs.existsSync(s6.scratch)).toBe(false);
    expect(readStagedSync(stateDir(t), pr)).toBeNull();
    // A closed PR is still never pushed for.
    expect((await as(6, as6('CLOSED'), ['push', '--yes'])).code).toBe(30);

    // #6's state.json is still #6's: #7's merge refuses it before it makes a worktree.
    const before = worktreeAdds;
    const m = await as(7, as6('CLOSED'), ['merge']);
    expect(m.code, m.out.join('\n')).toBe(30);
    expect(m.out[0]).toContain('#6');
    expect(worktreeAdds).toBe(before);
  });
});
