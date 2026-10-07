/**
 * pr-validate — run the tests a PR touches, after CI's own local
 * preconditions, the way CI would, and record a verdict for the exact
 * commit so gstack-pr-sync push can refuse an untested merge.
 *
 *   gstack-pr-validate run     --pr <n|url> [--repo o/r] [--cwd <pr worktree>] [--tree <dir>] [--accept-full-risk]
 *   gstack-pr-validate select  --pr <n|url> [...]          (print the selection only)
 *   gstack-pr-validate declare --pr <n|url> [...] <test path>...
 *
 * The tree defaults to the staged sync's scratch worktree (gstack-pr-sync
 * merge), else --cwd. The verdict lands in the PR state as
 * `validation: {sha, worst, summary, at}` and in
 * <state dir>/validate/<sha12>/summary.txt, last line `VALIDATE-END worst=N`.
 *
 * What #3032 taught (RESUME 2026-10-05..07):
 * - cookie-workflow-judge-input failed locally until `gen:skill-docs --host all`
 *   ran first: CI's preconditions run before any selected test.
 * - a merge from main broke 11 hook-syntax and 3 setup-bun-floor tests with
 *   no textual conflict: selection is re-derived on every run from the diff
 *   against the pinned base, plus the declared set.
 * - a bun run that exits 0 without `Ran N tests across M files` was cut
 *   short (a stray process.exit): it is a failure, never a pass.
 * - Claude Code's env changes bun's output (agent mode) and real-path TMPDIR
 *   matters on macOS: both are fixed here, not by the caller.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PrContextError, RELEASE_FILES, defaultGh, defaultGit, parsePrRefFor, upstreamRepoFromGh, remoteForRepo,
  pinBranch, readPr, topicFor, prStateDir, readStateFor, writeState, withPrLock,
  type GhResult, type GhRunner, type GitRunner, type PrInfo, type PrState,
} from './pr-context';
import { collectFreeTestFiles } from '../scripts/test-free-shards';

export const VALIDATE_EXIT = { GREEN: 0, RED: 1, USAGE: 2, PRECONDITION: 30 } as const;

export const VALIDATE_USAGE = `gstack-pr-validate <run|select|declare> --pr <number|url> [options] [paths]

Runs the free tests a PR touches after CI's local preconditions
(bun install --frozen-lockfile, gen:skill-docs --host all + the
freshness check, the browse node-server build), one bun process per file,
with Claude Code's env stripped, provider tokens unset and a real-path
TMPDIR. Records the verdict for the exact commit in the PR state.

  run       preconditions + selection + per-file runs + mirrors
            (typecheck, typecheck:test, the added-line secret scan,
            shellcheck when shell files changed); exit 0 green, 1 red
  select    print the selection and the rule that picked each file
  declare   record test paths that must always run for this PR

A file passes only with exit 0, no "(fail)" line and a
"Ran N tests across 1 file" line (no line = a truncated run).
A change to package.json beyond .version, bun.lock, tsconfig or the
free-suite runner needs the full suite: the selection prints FULL and
the run stays red unless --accept-full-risk (CI runs the full suite).

Options:
  --pr N|URL            the upstream PR (required)
  --repo OWNER/NAME     upstream repo (default: gh repo view in --cwd)
  --cwd DIR             the PR worktree (default: .)
  --tree DIR            tree to validate (default: the staged sync, else --cwd)
  --accept-full-risk    a FULL trigger does not by itself make the run red

First line of output: RESULT <WORD> ...`;

// ── environment ─────────────────────────────────────────────────────────────

const STRIP_RE = /^(CLAUDECODE|AI_AGENT|CLAUDE[A-Z0-9_]*|GSTACK_SKIP_RENDER_HOOK|EVALS[A-Z0-9_]*|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN)$|_API_KEY$/;

/** The env a validation run gets: agent markers and provider credentials gone, CI's git default branch, real-path TMPDIR. */
export function validationEnv(base: NodeJS.ProcessEnv, tmpdir: string, seedBase: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!STRIP_RE.test(k) && v !== undefined) env[k] = v;
  const n = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  env.GIT_CONFIG_COUNT = String(n + 1);
  env[`GIT_CONFIG_KEY_${n}`] = 'init.defaultBranch';
  env[`GIT_CONFIG_VALUE_${n}`] = 'main';
  env.TMPDIR = tmpdir.endsWith('/') ? tmpdir : `${tmpdir}/`;
  if (seedBase) env.GSTACK_FREE_SEED_BASE = seedBase;
  return env;
}

// ── selection ───────────────────────────────────────────────────────────────

const FULL_RE = /^(bun\.lock|bun\.lockb|patches\/.*|tsconfig[^/]*\.json|scripts\/test-free-shards\.ts|scripts\/lib\/(shard-engine|windows-curation|free-[^/]*)\.ts)$/;
const SKILL_SURFACE_RE = /(^|\/)SKILL\.md\.tmpl$|^scripts\/resolvers\/|^scripts\/gen-skill-docs\.ts$|^hosts\//;
const CODE_RE = /^(bin|lib|scripts)\//;
const CLASS_SKILL = ['test/gen-skill-docs.test.ts', 'test/skill-validation.test.ts', 'test/catalog-budget.test.ts', 'test/context-budget-ratchet.test.ts'];
const CLASS_CODE = ['test/egress-receipt-wiring.test.ts'];
const CLASS_TEST = ['test/spawnsync-timeout-tripwire.test.ts', 'test/test-of-test-ratchet.test.ts', 'test/paid-orphan-tripwire.test.ts', 'test/test-free-shards.test.ts'];
const CLASS_RELEASE = ['test/agents-digest.test.ts', 'test/gstack-version-bump.test.ts', 'test/gstack-next-version.test.ts', 'test/ship-version-sync.test.ts', 'test/version-source.test.ts'];

export interface Selection { files: { file: string; rules: string[] }[]; full: string[] }

/**
 * Pure. `changed` is `git diff --name-only <merge base with the pinned
 * upstream> HEAD`; `pkgVersionOnly` says package.json changed only in
 * .version (a release, not a dependency change); `source(f)` returns a
 * test file's text.
 */
export function selectTests(x: { changed: string[]; universe: string[]; declared: string[]; pkgVersionOnly: boolean; source: (f: string) => string }): Selection {
  const universe = new Set(x.universe);
  const picks = new Map<string, Set<string>>();
  const add = (f: string, rule: string) => {
    if (!universe.has(f)) return;
    if (!picks.has(f)) picks.set(f, new Set());
    picks.get(f)!.add(rule);
  };
  const full: string[] = [];
  for (const f of x.changed) {
    if (FULL_RE.test(f) || (f === 'package.json' && !x.pkgVersionOnly)) full.push(f);
    if (universe.has(f)) add(f, 'changed');
    if (SKILL_SURFACE_RE.test(f)) CLASS_SKILL.forEach(t => add(t, `class:skill(${f})`));
    if (CODE_RE.test(f) && !/\.test\.ts$/.test(f)) CLASS_CODE.forEach(t => add(t, `class:code(${f})`));
    if (/^(test|browse\/test|design\/test)\//.test(f)) CLASS_TEST.forEach(t => add(t, `class:test(${f})`));
    if (RELEASE_FILES.includes(f)) CLASS_RELEASE.forEach(t => add(t, `class:release(${f})`));
  }
  // A test that names a changed path, or a changed bin's basename, exercises it.
  const tokens = x.changed
    .filter(f => !RELEASE_FILES.includes(f) && !universe.has(f))
    .flatMap(f => {
      const out = [f];
      const base = path.basename(f);
      if (f.startsWith('bin/') && base.length >= 6) out.push(base);
      return out;
    });
  if (tokens.length) {
    for (const t of x.universe) {
      const src = x.source(t);
      const hit = tokens.find(tok => src.includes(tok));
      if (hit) add(t, `names:${hit}`);
    }
  }
  for (const f of x.declared) add(f, 'declared');
  return { files: [...picks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, rules]) => ({ file, rules: [...rules].sort() })), full };
}

// ── parsing ─────────────────────────────────────────────────────────────────

export interface FileVerdict { file: string; rc: number | null; pass: number; fail: number; skip: number; ran: boolean; ok: boolean; why: string }

/** One `bun test <file>` run: green only with exit 0, no (fail), and a `Ran N tests across 1 file` line. */
export function judgeBunRun(file: string, r: GhResult): FileVerdict {
  const text = `${r.stdout}\n${r.stderr}`;
  const num = (word: string) => Number(new RegExp(`^\\s*(\\d+) ${word}\\b`, 'm').exec(text)?.[1] ?? 0);
  const ran = /^Ran \d+ tests? across \d+ files?/m.test(text);
  const failLine = /^\(fail\)/m.test(text);
  const v = { file, rc: r.status, pass: num('pass'), fail: num('fail'), skip: num('skip'), ran };
  let why = 'ok';
  if (r.error) why = `did not finish: ${r.error}`;
  else if (r.status !== 0) why = `exit ${r.status}`;
  else if (failLine || v.fail > 0) why = 'a (fail) line';
  else if (!ran) why = 'no "Ran N tests" line: the run was cut short';
  return { ...v, ok: why === 'ok', why };
}

export function bunPinFrom(workflow: string | null): string | null {
  return workflow ? (/bun-version:\s*['"]?(\d+\.\d+\.\d+)/.exec(workflow)?.[1] ?? null) : null;
}

/** The files CI's macos-named-regressions job re-runs on the default (symlinked) temp root. */
export function macosNamedFrom(workflow: string | null): string[] {
  if (!workflow) return [];
  const at = workflow.indexOf('macos-named-regressions:');
  if (at < 0) return [];
  const m = /files=\(([^)]*)\)/.exec(workflow.slice(at));
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
}

// ── runners and deps ────────────────────────────────────────────────────────

export type ToolRunner = (cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; input?: string }) => GhResult;

export const defaultTool: ToolRunner = (cmd, args, opts) => {
  const timeout = opts.timeoutMs ?? 900_000;
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env, input: opts.input, encoding: 'utf8', timeout, maxBuffer: 128 * 1024 * 1024 });
  if (r.error) return { status: null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: `${cmd}: ${r.error.message}` };
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

export interface ValidateDeps {
  gh: GhRunner; git: GitRunner; tool: ToolRunner; env: NodeJS.ProcessEnv; now: () => Date;
  out: (line: string) => void; which: (cmd: string) => boolean;
  /** Free test files of a tree; default scripts/test-free-shards.ts collectFreeTestFiles. */
  universe: (root: string) => string[];
  /** Where per-run TMPDIRs are made; the macOS named regressions re-run on it unresolved. */
  tempRoot: () => string;
}

/**
 * The OS temp root CI's macOS jobs see (`/var/folders/.../T`, behind the
 * /var symlink), not the caller's TMPDIR (a Claude Code session points it
 * at a long scratchpad path, and deep test sockets must stay under macOS's
 * 104-byte AF_UNIX limit).
 */
export function systemTempDir(): string {
  if (process.platform === 'darwin') {
    const r = spawnSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8', timeout: 10_000 });
    const dir = r.status === 0 ? r.stdout.trim() : '';
    if (dir && fs.existsSync(dir)) return dir;
  }
  return '/tmp';
}

const realDeps = (): ValidateDeps => ({
  gh: defaultGh, git: defaultGit, tool: defaultTool, env: process.env, now: () => new Date(),
  out: l => process.stdout.write(l + '\n'),
  which: cmd => spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { timeout: 10_000 }).status === 0,
  universe: root => collectFreeTestFiles(root),
  tempRoot: systemTempDir,
});

// ── context ─────────────────────────────────────────────────────────────────

interface Flags { sub: string; pr: string | null; repo: string | null; cwd: string; tree: string | null; acceptFull: boolean; paths: string[] }

export function parseValidateArgs(argv: string[]): Flags {
  const f: Flags = { sub: argv[0] ?? '', pr: null, repo: null, cwd: process.cwd(), tree: null, acceptFull: false, paths: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new PrContextError(`${a} needs a value`, 2);
      return v;
    };
    if (a === '--pr') f.pr = val();
    else if (a === '--repo') f.repo = val();
    else if (a === '--cwd') f.cwd = path.resolve(val());
    else if (a === '--tree') f.tree = path.resolve(val());
    else if (a === '--accept-full-risk') f.acceptFull = true;
    else if (a.startsWith('--')) throw new PrContextError(`unknown option ${a}`, 2);
    else f.paths.push(a);
  }
  return f;
}

interface Ctx { d: ValidateDeps; f: Flags; repo: string; pr: PrInfo; stateDir: string; tree: string; base: string; stagedH0: string | null }

function gitOk(d: ValidateDeps, cwd: string, args: string[], what: string): string {
  const r = d.git(args, { cwd });
  if (r.status !== 0) throw new PrContextError(`${what} failed: ${(r.error ?? r.stderr).trim().split('\n').at(-1)}`, 1);
  return r.stdout;
}

function resolveCtx(d: ValidateDeps, f: Flags): Ctx {
  if (!f.pr) throw new PrContextError('--pr is required', 2);
  const repo = f.repo ?? upstreamRepoFromGh(d.gh, f.cwd);
  const pr = readPr(d.gh, repo, parsePrRefFor(f.pr, repo));
  const stateDir = prStateDir({ cwd: f.cwd, topic: topicFor(pr.headRef), env: d.env });
  let staged: { scratch?: string; base?: string; h0?: string; repo?: string; number?: number } | null = null;
  try {
    staged = JSON.parse(fs.readFileSync(path.join(stateDir, 'sync.json'), 'utf8'));
  } catch { /* no staged sync */ }
  if (staged && (staged.repo !== repo || staged.number !== pr.number)) staged = null;
  const tree = f.tree ?? (staged?.scratch && fs.existsSync(staged.scratch) ? staged.scratch : f.cwd);
  let base = staged?.base ?? '';
  if (!base) {
    const remote = remoteForRepo(d.git, f.cwd, repo);
    if (!remote) throw new PrContextError(`no git remote in ${f.cwd} points at ${repo}`, 30);
    base = pinBranch(d.git, f.cwd, remote, pr.baseRef).sha;
  }
  return { d, f, repo, pr, stateDir, tree, base, stagedH0: staged?.h0 ?? null };
}

function changedFiles(c: Ctx, mb: string): string[] {
  return gitOk(c.d, c.tree, ['diff', '--name-only', mb, 'HEAD'], 'git diff').split('\n').filter(Boolean);
}

function pkgVersionOnly(c: Ctx, mb: string): boolean {
  const a = c.d.git(['show', `${mb}:package.json`], { cwd: c.tree });
  const b = c.d.git(['show', 'HEAD:package.json'], { cwd: c.tree });
  if (a.status !== 0 || b.status !== 0) return a.status === b.status;
  try {
    const ja = JSON.parse(a.stdout);
    const jb = JSON.parse(b.stdout);
    delete ja.version;
    delete jb.version;
    return JSON.stringify(ja) === JSON.stringify(jb);
  } catch {
    return false;
  }
}

function selection(c: Ctx, state: PrState | null): { sel: Selection; mb: string } {
  const mb = gitOk(c.d, c.tree, ['merge-base', 'HEAD', c.base], 'git merge-base').trim();
  const changed = changedFiles(c, mb);
  const universe = c.d.universe(c.tree);
  const declared = (state?.focused?.paths ?? []).concat(c.f.sub === 'declare' ? c.f.paths : []);
  const source = (f: string) => {
    try {
      return fs.readFileSync(path.join(c.tree, f), 'utf8');
    } catch {
      return '';
    }
  };
  return { sel: selectTests({ changed, universe, declared, pkgVersionOnly: pkgVersionOnly(c, mb), source }), mb };
}

// ── subcommands ─────────────────────────────────────────────────────────────

function cmdSelect(c: Ctx): number {
  const state = readStateFor(c.stateDir, c.pr);
  const { sel, mb } = selection(c, state);
  c.d.out(`RESULT SELECTED files=${sel.files.length} full=${sel.full.length ? 'yes' : 'no'} base=${c.base.slice(0, 12)} merge-base=${mb.slice(0, 12)}`);
  for (const f of sel.full) c.d.out(`FULL\t${f}`);
  for (const s of sel.files) c.d.out(`SELECT\t${s.file}\t${s.rules.join(',')}`);
  return 0;
}

function cmdDeclare(c: Ctx): number {
  if (!c.f.paths.length) throw new PrContextError('declare needs at least one test path', 2);
  const missing = c.f.paths.filter(p => !/\.test\.ts$/.test(p) || !fs.existsSync(path.join(c.tree, p)));
  if (missing.length) throw new PrContextError(`not test files in ${c.tree}: ${missing.join(', ')}`, 2);
  withPrLock(c.stateDir, () => {
    const s = readStateFor(c.stateDir, c.pr) ?? freshState(c.pr);
    const paths = [...new Set([...(s.focused?.paths ?? []), ...c.f.paths])].sort();
    writeState(c.stateDir, { ...s, focused: { paths, declaredAt: c.d.now().toISOString() } });
    c.d.out(`RESULT DECLARED ${paths.length} path(s): ${paths.join(' ')}`);
  });
  return 0;
}

function freshState(pr: PrInfo): PrState {
  return {
    v: 1, topic: topicFor(pr.headRef), repo: pr.repo, number: pr.number, headRef: pr.headRef, headOwner: pr.headOwner,
    headRemote: null, upstreamRemote: null, defaultBranch: pr.baseRef, focused: null, validation: null,
    bodyStaleSince: null, lastPublishedBodySha256: null, signals: { latched: [], acked: [] }, audit: null,
  };
}

function cmdRun(c: Ctx): number {
  const { d } = c;
  const sha = gitOk(d, c.tree, ['rev-parse', 'HEAD'], 'git rev-parse').trim();
  const dirty = gitOk(d, c.tree, ['status', '--porcelain', '--untracked-files=no'], 'git status').trim();
  if (dirty) throw new PrContextError(`${c.tree} has uncommitted changes; a verdict must name a commit`, VALIDATE_EXIT.PRECONDITION);
  const outDir = path.join(c.stateDir, 'validate', sha.slice(0, 12));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const sysTmp = d.tempRoot();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(sysTmp, 'gstack-prv-')));
  try {
    return runIn(c, sha, outDir, tmp, sysTmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function runIn(c: Ctx, sha: string, outDir: string, tmp: string, sysTmp: string): number {
  const { d } = c;
  const state = readStateFor(c.stateDir, c.pr);
  const { sel, mb } = selection(c, state);
  const env = validationEnv(d.env, tmp, mb);
  const lines: string[] = [];
  let worst = 0;
  const line = (s: string, bad: boolean) => {
    lines.push(s);
    if (bad) worst = 1;
  };
  const tool = (cmd: string, args: string[], timeoutMs?: number, input?: string) => d.tool(cmd, args, { cwd: c.tree, env, timeoutMs, input });

  // What runs is upstream code: say which range before executing any of it.
  if (c.stagedH0) {
    const mb0 = gitOk(d, c.tree, ['merge-base', c.stagedH0, c.base], 'git merge-base').trim();
    const range = gitOk(d, c.tree, ['log', '--oneline', '--no-merges', `${mb0}..${c.base}`], 'git log').split('\n').filter(Boolean);
    d.out(`UPSTREAM_RANGE ${mb0.slice(0, 12)}..${c.base.slice(0, 12)} ${range.length} commit(s) about to run locally`);
    for (const r of range.slice(0, 20)) d.out(`  ${r}`);
  }

  const workflow = (() => {
    const r = d.git(['show', `${c.base}:.github/workflows/free-tests.yml`], { cwd: c.tree });
    return r.status === 0 ? r.stdout : null;
  })();
  const pin = bunPinFrom(workflow);
  const have = tool('bun', ['--version'], 30_000).stdout.trim();
  line(`bun-pin ${pin ? `want=${pin} have=${have}` : 'no pin found'} rc=${pin && pin !== have ? 1 : 0}`, !!pin && pin !== have);

  // CI's preconditions, in CI's order.
  if (fs.existsSync(path.join(c.tree, 'bun.lock'))) {
    const r = tool('bun', ['install', '--frozen-lockfile'], 300_000);
    line(`precondition bun-install rc=${r.status}`, r.status !== 0);
  }
  const pkg = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(c.tree, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    } catch {
      return {};
    }
  })();
  if (pkg.scripts?.['gen:skill-docs']) {
    const g = tool('bun', ['run', 'gen:skill-docs', '--host', 'all'], 900_000);
    const diff = gitOk(d, c.tree, ['status', '--porcelain', '--untracked-files=all'], 'git status').split('\n').filter(Boolean);
    line(`precondition gen-skill-docs-all rc=${g.status} drift=${diff.length}${diff.length ? ` (${diff.slice(0, 5).map(l => l.slice(3)).join(', ')})` : ''}`, g.status !== 0 || diff.length > 0);
  }
  if (fs.existsSync(path.join(c.tree, 'browse/scripts/build-node-server.sh'))) {
    const r = tool('bash', ['browse/scripts/build-node-server.sh'], 600_000);
    line(`precondition build-node-server rc=${r.status}`, r.status !== 0);
  }

  if (sel.full.length) line(`selection FULL (${sel.full.join(', ')}): the full free suite is the real gate${c.f.acceptFull ? '; accepted by --accept-full-risk' : ''}`, !c.f.acceptFull);

  // Each selected file in its own bun process, as the runner shards would see it.
  const macos = new Set(macosNamedFrom(workflow));
  let green = 0;
  for (const s of sel.files) {
    const abs = path.join(c.tree, s.file);
    const v = judgeBunRun(s.file, tool('bun', ['test', abs, '--timeout=30000', '--max-concurrency=1'], 900_000));
    if (v.ok) green++;
    line(`${s.file} rc=${v.rc} ${v.pass} pass ${v.fail} fail ${v.skip} skip ran=${v.ran ? 1 : 0} ${v.ok ? 'ok' : `RED: ${v.why}`} [${s.rules.join(',')}]`, !v.ok);
    if (macos.has(s.file)) {
      const sys = judgeBunRun(s.file, d.tool('bun', ['test', abs, '--timeout=30000', '--max-concurrency=1'], { cwd: c.tree, env: { ...env, TMPDIR: sysTmp.endsWith('/') ? sysTmp : `${sysTmp}/` }, timeoutMs: 900_000 }));
      line(`${s.file} (default temp root) rc=${sys.rc} ran=${sys.ran ? 1 : 0} ${sys.ok ? 'ok' : `RED: ${sys.why}`}`, !sys.ok);
    }
  }

  // Cheap mirrors of CI's other gates.
  for (const script of ['typecheck', 'typecheck:test']) {
    if (!pkg.scripts?.[script]) continue;
    const r = tool('bun', ['run', script], 900_000);
    line(`mirror ${script} rc=${r.status}`, r.status !== 0);
  }
  const scanner = path.join(c.tree, '.github/scripts/gate-secret-scan.mjs');
  if (fs.existsSync(scanner)) {
    const diff = d.git(['diff', '--unified=0', '--no-color', mb, 'HEAD', '--', '.', ':(exclude)test/fixtures/**', ':(exclude)browse/test/fixtures/**', ':(exclude)docs/evals/**', ':(exclude)test/helpers/security-bench*'], { cwd: c.tree });
    const runner = d.which('node') ? 'node' : 'bun';
    const r = tool(runner, [scanner], 120_000, diff.stdout);
    line(`mirror secret-scan rc=${r.status}`, r.status !== 0);
  }
  const shellChanged = changedFiles(c, mb).filter(f => /\.sh$/.test(f) && fs.existsSync(path.join(c.tree, f)));
  if (shellChanged.length && d.which('shellcheck')) {
    const r = tool('shellcheck', ['--severity=error', ...shellChanged], 300_000);
    line(`mirror shellcheck rc=${r.status} (${shellChanged.length} file(s))`, r.status !== 0);
  }

  const summary = `${green}/${sel.files.length} selected files green${worst ? '; RED' : ''}`;
  lines.push(`VALIDATE-END worst=${worst}`);
  fs.writeFileSync(path.join(outDir, 'summary.txt'), lines.join('\n') + '\n');
  withPrLock(c.stateDir, () => {
    const s = readStateFor(c.stateDir, c.pr) ?? freshState(c.pr);
    writeState(c.stateDir, { ...s, validation: { sha, worst: worst ? 1 : 0, summary, at: d.now().toISOString() } });
  });
  d.out(`RESULT ${worst ? 'RED' : 'GREEN'} sha=${sha.slice(0, 12)} ${summary} summary=${path.join(outDir, 'summary.txt')}`);
  for (const l of lines) d.out(l);
  return worst ? VALIDATE_EXIT.RED : VALIDATE_EXIT.GREEN;
}

export async function validateMain(argv: string[], deps: Partial<ValidateDeps> = {}): Promise<number> {
  const d = { ...realDeps(), ...deps };
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    d.out(VALIDATE_USAGE);
    return argv.length ? 0 : VALIDATE_EXIT.USAGE;
  }
  try {
    const f = parseValidateArgs(argv);
    if (!['run', 'select', 'declare'].includes(f.sub)) throw new PrContextError(`unknown subcommand ${JSON.stringify(f.sub)}`, 2);
    const c = resolveCtx(d, f);
    if (f.sub === 'select') return cmdSelect(c);
    if (f.sub === 'declare') return cmdDeclare(c);
    return cmdRun(c);
  } catch (error) {
    if (error instanceof PrContextError) {
      d.out(`RESULT ${error.code === 2 ? 'USAGE' : error.code === 30 ? 'PRECONDITION' : 'ERROR'} ${error.message}`);
      return error.code;
    }
    d.out(`RESULT ERROR ${(error as Error).message}`);
    return 1;
  }
}
