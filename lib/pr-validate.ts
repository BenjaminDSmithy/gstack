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
 * <state dir>/validate/<sha12>/summary.txt, last line `VALIDATE-END worst=N`
 * (ci.gitconfig beside it is the global git config the tests saw).
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
 * - CI's free lane builds the gate binaries and arms GSTACK_EXPECT_BINARIES
 *   so the make-pdf gates cannot go green by self-skipping: so does this.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PrContextError, RELEASE_FILES, envelope, defaultGh, defaultGit, parsePrRefFor, upstreamRepoFromGh, remoteForRepo,
  pinBranch, readPr, topicFor, prStateDir, readStateFor, writeState, withPrLock,
  type GhResult, type GhRunner, type GitRunner, type PrInfo, type PrState,
} from './pr-context';
import { collectFreeTestFiles } from '../scripts/test-free-shards';
import { parseBunTerminalSummary, stripAnsiLine } from '../scripts/lib/shard-engine';
import { FREE_HOME_SURFACES, privateFreeHome, type FreeHomeGuard } from '../scripts/lib/free-home-guard';

export const VALIDATE_EXIT = { GREEN: 0, RED: 1, USAGE: 2, PRECONDITION: 30 } as const;

/** gstack's release tooling: the selection rules and CI mirrors assume a tree that carries it. */
const PLATFORM_FILES = ['bin/gstack-next-version', 'scripts/gen-agents-digest.ts'];

export const VALIDATE_USAGE = `gstack-pr-validate <run|select|declare> --pr <number|url> [options] [paths]

Runs the free tests a PR touches after CI's local preconditions in CI's
order (bun install --frozen-lockfile, gen:skill-docs --host all + the
freshness check, vendor:xterm, the browse node-server build, build:gates,
build:cso; GSTACK_EXPECT_BINARIES=1 for the tests when build:gates ran),
one bun process per file in a CI shard's sandbox (a private HOME, its
own TMPDIR, Chromium profile and browse state; a write to the private
HOME's ~/.gstack, ~/.claude, ~/.codex, ~/.agents or ~/.config/gstack is
red, as CI's home guard makes it, and never reaches yours),
with agent markers (CLAUDECODE, AI_AGENT, AGENT, REPL_ID, CLAUDE*)
stripped, every credential-shaped variable unset, no system git config
and an empty gh config dir (your gh login and keychain helper stay out
of reach), CI=true (as GitHub
Actions sets it: a committed test.only fails) and a real-path
TMPDIR; git reads CI's global config (identity, init.defaultBranch main,
safe.directory) instead of yours. Records the verdict for the exact
commit in the PR state.

  run       preconditions + selection + per-file runs + mirrors
            (typecheck, typecheck:test, the added-line secret scan,
            shellcheck on changed *.sh files and the files CI's quality
            gate shellchecks); exit 0 green, 1 red
  select    print the selection and the rule that picked each file
  declare   record test paths that must always run for this PR (free
            test files of the tree only; voids a recorded verdict that
            did not run them)

A file passes only with exit 0, no "(fail)" line and bun's own last
"Ran N tests across 1 file" line on stderr, with no test result after
it, agreeing with the counts above it (no such line = a truncated run;
a block a test printed cannot stand in). A file in which no test passed (every
test skipped) is UNVERIFIED: named in the summary, never counted green.
Each changed file (anything but release files, *.md and FULL triggers)
needs a passing selected test that exercises it: the file itself, a test
importing it, pointing a relative path at it or naming it, or for a
template, resolver or host the skill-rendering tests. A class
tripwire's pass (egress wiring, sync-spawn timeouts, ...) is not
coverage. A file with none is red (NO_TESTS), never "0/0 green": declare
the tests that cover it (a passing declared test covers the change).
A change to package.json beyond .version, bun.lock, tsconfig,
bunfig.toml or its preload files, or the free-suite runner needs the
full suite: the selection prints FULL and the run stays red unless
--accept-full-risk (CI runs the full suite).

Options:
  --pr N|URL            the upstream PR (required)
  --repo OWNER/NAME     upstream repo (default: gh repo view in --cwd)
  --cwd DIR             the PR worktree (default: .)
  --tree DIR            tree to validate (default: the staged sync, else --cwd)
  --accept-full-risk    a FULL trigger does not by itself make the run red;
                        the recorded summary says the full suite was waived

Exit 30: a precondition (the tree lacks gstack's release tooling,
bin/gstack-next-version and scripts/gen-agents-digest.ts; uncommitted
changes or untracked files; no remote for the repo).

First line of stdout: RESULT <WORD> ... (run prints the upstream range
of a staged sync on stderr before executing it).`;

// ── environment ─────────────────────────────────────────────────────────────

// Agent markers (bun 1.4 switches to agent-mode output on CLAUDECODE, AGENT
// and REPL_ID, which breaks nested-runner tests), the render hook and eval
// knobs.
const STRIP_RE = /^(CLAUDECODE|AI_AGENT|AGENT|REPL_ID|CLAUDE[A-Z0-9_]*|GSTACK_SKIP_RENDER_HOOK|EVALS[A-Z0-9_]*)$/;
// CI's free lane is secretless: any name with a credential-shaped segment
// goes, the same segment rule as test/helpers/hermetic-env.ts
// (GITHUB_TOKEN_1, GH_PAT, AWS_SESSION_TOKEN, SSH_AUTH_SOCK), never a
// substring match (GITHUB_PATH, GITHUB_TOKENIZER are metadata).
const CREDENTIAL_SEGMENTS = new Set([
  'KEY', 'KEYS', 'TOKEN', 'TOKENS', 'SECRET', 'SECRETS', 'PASSWORD', 'PASSWD',
  'PASS', 'CREDENTIAL', 'CREDENTIALS', 'AUTH', 'PAT', 'DSN', 'COOKIE',
  'SESSION', 'PRIVATE',
]);
const credentialShaped = (name: string) => name.toUpperCase().split('_').some(seg => CREDENTIAL_SEGMENTS.has(seg));

// The caller's own git config overrides: CI has none, and GIT_CONFIG_COUNT
// entries outrank a test's GIT_CONFIG_GLOBAL isolation.
const GIT_CONFIG_ENV_RE = /^GIT_CONFIG(_COUNT|_KEY_\d+|_VALUE_\d+|_PARAMETERS|_GLOBAL|_SYSTEM|_NOSYSTEM)?$/;

/** The global git config free-tests.yml writes with `git config --global` before the suite. */
export const CI_GITCONFIG = '[user]\n\temail = free-tests-ci@gstack.test\n\tname = Free Tests CI\n[init]\n\tdefaultBranch = main\n[safe]\n\tdirectory = *\n';

/** Write CI's global git config into `dir`; returns its path for validationEnv. */
export function writeCiGitConfig(dir: string): string {
  const file = path.join(dir, 'ci.gitconfig');
  fs.writeFileSync(file, CI_GITCONFIG, { mode: 0o600 });
  return file;
}

/**
 * The env a validation run gets: agent markers, credentials and the
 * caller's git config overrides gone; CI's global git config as
 * GIT_CONFIG_GLOBAL (so a test that isolates with its own
 * GIT_CONFIG_GLOBAL loses it, exactly as in CI, and the caller's
 * ~/.gitconfig never reaches a test); real-path TMPDIR.
 */
export function validationEnv(base: NodeJS.ProcessEnv, tmpdir: string, seedBase: string | null, gitConfig: string | null = null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (!STRIP_RE.test(k) && !credentialShaped(k) && !GIT_CONFIG_ENV_RE.test(k) && v !== undefined) env[k] = v;
  }
  if (gitConfig) env.GIT_CONFIG_GLOBAL = gitConfig;
  // CI's free lane holds no credentials (persist-credentials: false, no
  // GH_TOKEN): no system git config (Homebrew's names the osxkeychain
  // credential helper) and an empty gh config dir, so neither git over
  // https nor gh can act as the owner.
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GH_CONFIG_DIR = path.join(tmpdir, 'gh-config');
  // GitHub Actions sets CI=true for every step. Bun then refuses a committed
  // test.only (without it, bun runs only that test and skips its failing
  // siblings), and tests that branch on CI take CI's branch.
  env.CI = 'true';
  env.TMPDIR = tmpdir.endsWith('/') ? tmpdir : `${tmpdir}/`;
  if (seedBase) env.GSTACK_FREE_SEED_BASE = seedBase;
  return env;
}

// Pointers into the caller's gstack, agent and config state. CI has none of
// them, and a test that honours one writes the owner's live install.
const STATE_POINTER_RE = /^(GSTACK_HOME|GSTACK_STATE_ROOT|GSTACK_USER_RENDER_DIR|CODEX_HOME|XDG_(CONFIG|DATA|STATE|CACHE)_HOME)$/;

/**
 * The env one test file runs with, as a CI shard's (runFreeShard): HOME
 * redirected to `<stateDir>/home` by the free runner's own
 * privateFreeHome (the browser cache still comes from the real home), its
 * own TMPDIR, Chromium profile and browse state file, and no variable
 * pointing into the caller's gstack, agent or config state (the named
 * pointers, and any single path inside a home surface the runner's guard
 * watches). The guard reports a write to the private HOME's watched
 * surfaces, which CI's home guard fails a shard for; with the real HOME
 * the write would land in the owner's live install.
 */
export function testFileEnv(base: NodeJS.ProcessEnv, stateDir: string, file: string, tmpdir?: string): { env: NodeJS.ProcessEnv; guard: FreeHomeGuard } {
  const realHome = base.HOME || os.homedir();
  const surfaces = FREE_HOME_SURFACES.map(s => path.join(realHome, s));
  const intoState = (v: string) => path.isAbsolute(v) && !v.includes(path.delimiter) && surfaces.some(s => v === s || v.startsWith(`${s}/`));
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !STATE_POINTER_RE.test(k) && !intoState(v)) env[k] = v;
  }
  const tmp = tmpdir ?? path.join(stateDir, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  env.TMPDIR = tmp.endsWith('/') ? tmp : `${tmp}/`;
  env.TEMP = env.TMP = tmp;
  env.CHROMIUM_PROFILE = path.join(stateDir, 'chromium-profile');
  env.BROWSE_STATE_FILE = path.join(stateDir, '.gstack', 'browse.json');
  const guard = privateFreeHome([file], env, stateDir);
  return { env, guard };
}

// ── selection ───────────────────────────────────────────────────────────────

// Changes that reach every free test: dependencies, compiler config, bun's
// own test config and its preload (bunfig.toml preloads test-setup.ts into
// every file), and the free runner with its import closure (the paid-set
// helper decides what counts as a free test).
const FULL_RE = /^(bun\.lock|bun\.lockb|bunfig\.toml|test-setup\.ts|patches\/.*|tsconfig[^/]*\.json|scripts\/test-free-shards\.ts|scripts\/lib\/(shard-engine|windows-curation|free-[^/]*)\.ts|test\/helpers\/paid-test-set\.ts)$/;
const SKILL_SURFACE_RE = /(^|\/)SKILL\.md\.tmpl$|^scripts\/resolvers\/|^scripts\/gen-skill-docs\.ts$|^hosts\//;
const CODE_RE = /^(bin|lib|scripts)\//;
const CLASS_SKILL = ['test/gen-skill-docs.test.ts', 'test/skill-validation.test.ts', 'test/catalog-budget.test.ts', 'test/context-budget-ratchet.test.ts'];
const CLASS_CODE = ['test/egress-receipt-wiring.test.ts'];
const CLASS_TEST = ['test/spawnsync-timeout-tripwire.test.ts', 'test/test-of-test-ratchet.test.ts', 'test/paid-orphan-tripwire.test.ts', 'test/test-free-shards.test.ts'];
const CLASS_RELEASE = ['test/agents-digest.test.ts', 'test/gstack-version-bump.test.ts', 'test/gstack-next-version.test.ts', 'test/ship-version-sync.test.ts', 'test/version-source.test.ts'];

export interface Selection {
  files: { file: string; rules: string[] }[];
  full: string[];
  /** Declared paths that are not free test files of this tree: they cannot run, so they are red. */
  missingDeclared: string[];
}

// `from '…'`, `import '…'`, `import('…')`, `require('…')` with a relative specifier.
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"])(\.{1,2}\/[^'"\n]+)\1/gm;
// Any other relative path literal: path.join(import.meta.dir, '../src/x.ts'), new URL('../src/x.ts', import.meta.url).
const REL_LITERAL_RE = /(['"`])(\.{1,2}\/[^'"`\n$]+)\1/g;
const IMPORT_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json'];

/**
 * Repo-relative targets of a file's relative specifiers, one hop, extension
 * unresolved: `imports` are import/require specifiers, `refs` every other
 * relative path literal (resolved against the file's own directory, as
 * import.meta.dir and __dirname joins are).
 */
export function relativeImports(file: string, src: string): { imports: string[]; refs: string[] } {
  const dir = path.posix.dirname(file);
  const resolve = (spec: string) => path.posix.normalize(path.posix.join(dir, spec));
  const imports = new Set<string>();
  for (const m of src.matchAll(IMPORT_RE)) imports.add(resolve(m[2]));
  const refs = new Set<string>();
  for (const m of src.matchAll(REL_LITERAL_RE)) {
    const r = resolve(m[2]);
    if (!imports.has(r)) refs.add(r);
  }
  return { imports: [...imports], refs: [...refs] };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Path segments as consecutive quoted path.join arguments: `'scripts', 'eval-list.ts'`. */
function joinedSegmentsRe(segs: string[]): RegExp {
  return new RegExp(segs.map((s, i) => `(['"\`])${escapeRe(s)}\\${i + 1}`).join('\\s*,\\s*'));
}

/**
 * A test naming `f` relative to its own directory (`dir`, with a trailing
 * slash), as `import.meta.dir`/`__dirname` joins do: two or more segments,
 * joined (`'fixtures', 'one.json'`) or as one literal (`'fixtures/one.json'`).
 */
function namesFromDir(src: string, dir: string, f: string, cache: Map<string, RegExp[]>): boolean {
  if (!f.startsWith(dir)) return false;
  const rel = f.slice(dir.length);
  if (!rel.includes('/')) return false;
  let res = cache.get(rel);
  if (!res) cache.set(rel, (res = [joinedSegmentsRe(rel.split('/')), new RegExp(`(['"\`])${escapeRe(rel)}\\1`)]));
  return res.some(re => re.test(src));
}

/** The changed path an import specifier resolves to, the way bun resolves it (extension, /index, .js naming a .ts). */
function importedChange(spec: string, changed: Set<string>): string | undefined {
  const stem = spec.replace(/\.[mc]?js$/, '');
  const candidates = [spec, ...IMPORT_EXTS.map(e => stem + e), ...IMPORT_EXTS.map(e => `${spec}/index${e}`)];
  return candidates.find(c => changed.has(c));
}

/**
 * Pure. `changed` is `git diff --name-only <merge base with the pinned
 * upstream> HEAD`; `pkgVersionOnly` says package.json changed only in
 * .version (a release, not a dependency change); `source(f)` returns a
 * test file's text; `preload` lists the tree's bunfig.toml preload files.
 */
export function selectTests(x: { changed: string[]; universe: string[]; declared: string[]; pkgVersionOnly: boolean; source: (f: string) => string; preload?: string[] }): Selection {
  const universe = new Set(x.universe);
  const picks = new Map<string, Set<string>>();
  const add = (f: string, rule: string) => {
    if (!universe.has(f)) return;
    if (!picks.has(f)) picks.set(f, new Set());
    picks.get(f)!.add(rule);
  };
  const full: string[] = [];
  for (const f of x.changed) {
    if (FULL_RE.test(f) || (x.preload ?? []).includes(f) || (f === 'package.json' && !x.pkgVersionOnly)) full.push(f);
    if (universe.has(f)) add(f, 'changed');
    if (SKILL_SURFACE_RE.test(f)) CLASS_SKILL.forEach(t => add(t, `class:skill(${f})`));
    if (CODE_RE.test(f) && !/\.test\.ts$/.test(f)) CLASS_CODE.forEach(t => add(t, `class:code(${f})`));
    if (/^(test|browse\/test|design\/test)\//.test(f)) CLASS_TEST.forEach(t => add(t, `class:test(${f})`));
    if (RELEASE_FILES.includes(f)) CLASS_RELEASE.forEach(t => add(t, `class:release(${f})`));
  }
  // A test that imports a changed module (one hop, the way bun resolves the
  // specifier), points a relative path literal at it, names a changed path,
  // or names a changed bin's basename, exercises it. Tests import without
  // the extension ('../lib/foo'), which `git diff --name-only` never
  // prints, so the edge is resolved rather than searched for as text.
  const nonRelease = x.changed.filter(f => !RELEASE_FILES.includes(f));
  const importable = new Set(nonRelease);
  // How a test can name a changed path: the path itself, a bin's basename,
  // or its segments as path.join arguments (path.join(ROOT, 'scripts',
  // 'eval-list.ts')); every changed path a test names is recorded, since
  // each one's coverage is judged on its own.
  const named = nonRelease
    .filter(f => !universe.has(f))
    .map(f => {
      const tokens = [f];
      const base = path.basename(f);
      if (f.startsWith('bin/') && base.length >= 6) tokens.push(base);
      return { f, base, tokens, joined: f.includes('/') ? joinedSegmentsRe(f.split('/')) : null };
    });
  const relRes = new Map<string, RegExp[]>();
  if (importable.size) {
    for (const t of x.universe) {
      const src = x.source(t);
      const rel = relativeImports(t, src);
      for (const [kind, specs] of [['imports', rel.imports], ['refs', rel.refs]] as const) {
        for (const spec of specs) {
          const hit = importedChange(spec, importable);
          if (hit && hit !== t) add(t, `${kind}:${hit}`);
        }
      }
      const dir = `${path.posix.dirname(t)}/`;
      for (const n of named) {
        // Every form below contains the basename: a cheap exact pre-filter.
        if (!src.includes(n.base)) continue;
        if (n.tokens.some(tok => src.includes(tok)) || n.joined?.test(src) || namesFromDir(src, dir, n.f, relRes)) add(t, `names:${n.f}`);
      }
    }
  }
  const missingDeclared: string[] = [];
  for (const f of x.declared) {
    if (universe.has(f)) add(f, 'declared');
    else if (!missingDeclared.includes(f)) missingDeclared.push(f);
  }
  return { files: [...picks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, rules]) => ({ file, rules: [...rules].sort() })), full, missingDeclared };
}

// ── parsing ─────────────────────────────────────────────────────────────────

export interface FileVerdict {
  file: string; rc: number | null; pass: number; fail: number; skip: number;
  /** bun's own last summary names exactly one file and agrees with the counts above it. */
  ran: boolean;
  ok: boolean;
  /** The run was clean but no test passed (every test skipped or todo): it verified nothing. */
  unverified: boolean;
  why: string;
}

/**
 * One `bun test <file>` run. Green only with exit 0, no `(fail)` line or
 * unhandled error between tests (either stream), and bun's own summary:
 * the LAST `Ran N tests across 1 file. [t]` line on stderr, bun's
 * reporter stream (a test's console.log goes to stdout), with no test
 * result line after it, and whose N equals the pass, fail, skip and todo
 * counts printed directly above it. So a block a test printed on stdout,
 * or echoed on stderr from a child run before a stray process.exit (bun
 * prints the echoing test's result after it), cannot stand in. A clean
 * run in which no test passed is unverified, never green.
 */
export function judgeBunRun(file: string, r: GhResult): FileVerdict {
  const lines = r.stderr.split('\n').map(stripAnsiLine);
  let at = -1;
  let sum: { tests: number; files: number } | null = null;
  for (let i = lines.length - 1; i >= 0 && !sum; i--) {
    sum = parseBunTerminalSummary(lines[i]);
    if (sum) at = i;
  }
  if (sum && lines.slice(at + 1).some(l => /^\((pass|fail|skip|todo)\) /.test(l))) {
    sum = null;
    at = -1;
  }
  const counts: Record<string, number> = { pass: 0, fail: 0, skip: 0, todo: 0 };
  for (let i = at - 1; i >= 0; i--) {
    const m = /^\s*(\d+) (\S.*)$/.exec(lines[i]);
    if (!m) break;
    if (m[2] in counts) counts[m[2]] = Number(m[1]);
  }
  const total = counts.pass + counts.fail + counts.skip + counts.todo;
  const ran = sum !== null && sum.files === 1 && sum.tests === total;
  const failLine = [...r.stdout.split('\n').map(stripAnsiLine), ...lines].some(l => /^\(fail\) /.test(l) || l === '# Unhandled error between tests');
  const v = { file, rc: r.status, pass: counts.pass, fail: counts.fail, skip: counts.skip, ran };
  let why = 'ok';
  if (r.error) why = `did not finish: ${r.error}`;
  else if (r.status !== 0) why = `exit ${r.status}`;
  else if (failLine || v.fail > 0) why = 'a (fail) line';
  else if (!sum) why = 'no "Ran N tests" line: the run was cut short';
  else if (sum.files !== 1) why = `bun's summary names ${sum.files} files, not 1`;
  else if (sum.tests !== total) why = `bun's summary says ${sum.tests} tests but the counts say ${total}: the run was cut short`;
  const unverified = why === 'ok' && counts.pass === 0;
  if (unverified) why = total ? 'no test passed: every test skipped' : 'the file has no tests';
  return { ...v, ok: why === 'ok', unverified, why };
}

/** The `[test] preload` files of a bunfig.toml, repo-relative (string or array form). */
export function bunfigPreload(toml: string | null): string[] {
  if (!toml) return [];
  const m = /^\s*preload\s*=\s*(\[[^\]]*\]|"[^"\n]*"|'[^'\n]*')/m.exec(toml);
  if (!m) return [];
  return [...m[1].matchAll(/["']([^"'\n]+)["']/g)].map(q => path.posix.normalize(q[1]).replace(/^\.\//, ''));
}

export function bunPinFrom(workflow: string | null): string | null {
  return workflow ? (/bun-version:\s*['"]?(\d+\.\d+\.\d+)/.exec(workflow)?.[1] ?? null) : null;
}

/** The files quality-gate.yml's ShellCheck step names (`shellcheck --severity=error <files...>`). */
export function shellcheckTargetsFrom(workflow: string | null): string[] {
  const flag = 'shellcheck --severity=error';
  const at = workflow ? workflow.indexOf(flag) : -1;
  if (!workflow || at < 0) return [];
  const rest = workflow.slice(at + flag.length);
  const end = rest.search(/\n\s*-\s+(name|uses|run|if|with):|\n\S/);
  return (end < 0 ? rest : rest.slice(0, end)).split(/\s+/).filter(t => /^[\w.][\w./-]*$/.test(t));
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
  /** Progress that must not displace stdout's RESULT first line (the upstream range). */
  err: (line: string) => void;
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
  err: l => process.stderr.write(l + '\n'),
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
  const absent = PLATFORM_FILES.filter(file => d.git(['cat-file', '-e', `HEAD:${file}`], { cwd: tree }).status !== 0);
  if (absent.length) throw new PrContextError(`${tree} is not a gstack release tree (HEAD lacks ${absent.join(', ')}): gstack-pr-validate only validates gstack-shaped trees`, VALIDATE_EXIT.PRECONDITION);
  let base = staged?.base ?? '';
  if (!base) {
    const remote = remoteForRepo(d.git, f.cwd, repo);
    if (!remote) throw new PrContextError(`no git remote in ${f.cwd} points at ${repo}`, 30);
    base = pinBranch(d.git, f.cwd, remote, pr.baseRef).sha;
  }
  return { d, f, repo, pr, stateDir, tree, base, stagedH0: staged?.h0 ?? null };
}

/** Both sides of a rename: a test that still names or imports the old path must run. */
/** A file at the pinned upstream base, or null. */
function showBase(c: Ctx, file: string): string | null {
  const r = c.d.git(['show', `${c.base}:${file}`], { cwd: c.tree });
  return r.status === 0 ? r.stdout : null;
}

function changedFiles(c: Ctx, mb: string): string[] {
  return gitOk(c.d, c.tree, ['diff', '--name-only', '--no-renames', mb, 'HEAD'], 'git diff').split('\n').filter(Boolean);
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

/**
 * Changed files a test could verify: not release metadata, not prose, still
 * present (a deleted module has nothing left to run), and not a FULL
 * trigger (those are the full suite's, waived or red on their own).
 */
export function untestedCode(changed: string[], sel: Selection, exists: (f: string) => boolean): string[] {
  return changed.filter(f => !RELEASE_FILES.includes(f) && !/\.md$/i.test(f) && !sel.full.includes(f) && exists(f));
}

/**
 * The changed files in `code` that no passing selected file exercises. A
 * pick covers the path its rule names (`changed` a test file itself,
 * `imports:`, `refs:`, `names:`), and `class:skill(<f>)` covers its
 * template, resolver or host, since those tests render every template for
 * every host. The other class picks (code, test, release) are tripwires
 * that scan source for one pattern: they run, but never count as
 * coverage. A passing declared test covers everything: the owner
 * declared it for the change.
 */
export function uncoveredCode(code: string[], sel: Selection, passed: (file: string) => boolean): string[] {
  const covered = new Set<string>();
  for (const s of sel.files) {
    if (!passed(s.file)) continue;
    if (s.rules.includes('declared')) return [];
    for (const r of s.rules) {
      if (r === 'changed') covered.add(s.file);
      const m = /^(?:imports|refs|names):(.+)$/.exec(r) ?? /^class:skill\((.+)\)$/.exec(r);
      if (m) covered.add(m[1]);
    }
  }
  return code.filter(f => !covered.has(f));
}

function noTestsLine(files: string[]): string {
  return `NO_TESTS ${files.length} changed file(s) no passing selected test exercises (${files.slice(0, 5).join(', ')}${files.length > 5 ? ', ...' : ''}): a class tripwire is not coverage; declare the tests that cover them (gstack-pr-validate declare)`;
}

function selection(c: Ctx, state: PrState | null): { sel: Selection; mb: string; changed: string[] } {
  const mb = gitOk(c.d, c.tree, ['merge-base', 'HEAD', c.base], 'git merge-base').trim();
  const changed = changedFiles(c, mb);
  const universe = c.d.universe(c.tree);
  const declared = state?.focused?.paths ?? [];
  const source = (f: string) => {
    try {
      return fs.readFileSync(path.join(c.tree, f), 'utf8');
    } catch {
      return '';
    }
  };
  const preload = bunfigPreload(source('bunfig.toml') || null);
  return { sel: selectTests({ changed, universe, declared, pkgVersionOnly: pkgVersionOnly(c, mb), source, preload }), mb, changed };
}

// ── subcommands ─────────────────────────────────────────────────────────────

function cmdSelect(c: Ctx): number {
  const state = readStateFor(c.stateDir, c.pr);
  const { sel, mb, changed } = selection(c, state);
  c.d.out(`RESULT SELECTED files=${sel.files.length} full=${sel.full.length ? 'yes' : 'no'} base=${c.base.slice(0, 12)} merge-base=${mb.slice(0, 12)}`);
  for (const f of sel.full) c.d.out(`FULL\t${f}`);
  for (const s of sel.files) c.d.out(`SELECT\t${s.file}\t${s.rules.join(',')}`);
  for (const f of sel.missingDeclared) c.d.out(`DECLARED_MISSING\t${f}`);
  // What run would call NO_TESTS if every selected file passed.
  const bare = uncoveredCode(untestedCode(changed, sel, f => fs.existsSync(path.join(c.tree, f))), sel, () => true);
  if (bare.length) c.d.out(noTestsLine(bare));
  return 0;
}

/** A declared path in the universe's form (`test/x.test.ts`), or why it can never run. */
function declaredPath(c: Ctx, universe: Set<string>, p: string): { path: string } | { why: string } {
  const rel = path.isAbsolute(p) ? path.relative(c.tree, p) : p;
  const n = path.posix.normalize(rel.split(path.sep).join('/')).replace(/^\.\//, '');
  if (n === '..' || n.startsWith('../') || path.isAbsolute(n)) return { why: `${p} (outside ${c.tree})` };
  if (universe.has(n)) return { path: n };
  return { why: `${p} (${fs.existsSync(path.join(c.tree, n)) ? 'not a free test file: paid evals and non-test files never run here' : 'not found'})` };
}

function cmdDeclare(c: Ctx): number {
  if (!c.f.paths.length) throw new PrContextError('declare needs at least one test path', 2);
  const universe = new Set(c.d.universe(c.tree));
  const wanted = c.f.paths.map(p => declaredPath(c, universe, p));
  const bad = wanted.flatMap(w => ('why' in w ? [w.why] : []));
  if (bad.length) throw new PrContextError(`cannot declare ${bad.join(', ')}`, 2);
  const add = wanted.flatMap(w => ('path' in w ? [w.path] : []));
  withPrLock(c.stateDir, () => {
    const s = readStateFor(c.stateDir, c.pr) ?? freshState(c.pr);
    const before = new Set(s.focused?.paths ?? []);
    const paths = [...new Set([...before, ...add])].sort();
    const added = paths.filter(p => !before.has(p));
    // A recorded verdict never ran a newly declared file: void it so push asks for a new run.
    const voided = added.length > 0 && s.validation !== null;
    writeState(c.stateDir, { ...s, focused: { paths, declaredAt: c.d.now().toISOString() }, validation: voided ? null : s.validation });
    c.d.out(`RESULT DECLARED ${paths.length} path(s): ${paths.join(' ')}`);
    if (voided) c.d.out(`NOTE the recorded validation of ${s.validation!.sha.slice(0, 12)} did not run ${added.join(' ')}: it is void; run gstack-pr-validate run again`);
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
  // Untracked files count: a test can import one the commit lacks, and the verdict would name that commit.
  const dirty = gitOk(d, c.tree, ['status', '--porcelain', '--untracked-files=normal'], 'git status').split('\n').filter(Boolean);
  if (dirty.length) {
    const untracked = dirty.filter(l => l.startsWith('??')).map(l => l.slice(3));
    const what = untracked.length === dirty.length ? `untracked files (${untracked.slice(0, 5).join(', ')})` : `uncommitted changes (${dirty.slice(0, 5).map(l => l.slice(3)).join(', ')})`;
    throw new PrContextError(`${c.tree} has ${what}; a verdict must name a commit that holds everything the tests use`, VALIDATE_EXIT.PRECONDITION);
  }
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
  const { sel, mb, changed } = selection(c, state);
  const env = validationEnv(d.env, tmp, mb, writeCiGitConfig(outDir));
  const lines: string[] = [];
  let worst = 0;
  const line = (s: string, bad: boolean) => {
    lines.push(s);
    if (bad) worst = 1;
  };
  const tool = (cmd: string, args: string[], timeoutMs?: number, input?: string) => d.tool(cmd, args, { cwd: c.tree, env, timeoutMs, input });

  // What runs is upstream code: say which range before executing any of it.
  // On stderr, so stdout's first line stays RESULT; the subjects are
  // contributors' PR titles, so they are enveloped as untrusted data.
  if (c.stagedH0) {
    const mb0 = gitOk(d, c.tree, ['merge-base', c.stagedH0, c.base], 'git merge-base').trim();
    const range = gitOk(d, c.tree, ['log', '--oneline', '--no-merges', `${mb0}..${c.base}`], 'git log').split('\n').filter(Boolean);
    d.err(`UPSTREAM_RANGE ${mb0.slice(0, 12)}..${c.base.slice(0, 12)} ${range.length} commit(s) about to run locally`);
    if (range.length) d.err(envelope(range.slice(0, 20).join('\n'), 'upstream-range'));
  }

  const workflow = showBase(c, '.github/workflows/free-tests.yml');
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
  const script = (name: string, timeoutMs: number): boolean => {
    if (!pkg.scripts?.[name]) return false;
    const r = tool('bun', ['run', name], timeoutMs);
    line(`precondition ${name} rc=${r.status}`, r.status !== 0);
    return true;
  };
  script('vendor:xterm', 120_000);
  if (fs.existsSync(path.join(c.tree, 'browse/scripts/build-node-server.sh'))) {
    const r = tool('bash', ['browse/scripts/build-node-server.sh'], 600_000);
    line(`precondition build-node-server rc=${r.status}`, r.status !== 0);
  }
  // The make-pdf gates self-skip without these binaries; CI builds them and
  // arms GSTACK_EXPECT_BINARIES on the test step so a missing build fails.
  const gates = script('build:gates', 900_000);
  script('build:cso', 600_000);
  const testEnv: NodeJS.ProcessEnv = gates ? { ...env, GSTACK_EXPECT_BINARIES: '1' } : env;

  for (const f of sel.missingDeclared) line(`declared ${f} RED: not a free test file in this tree`, true);
  if (sel.full.length) line(`selection FULL (${sel.full.join(', ')}): the full free suite is the real gate${c.f.acceptFull ? '; accepted by --accept-full-risk' : ''}`, !c.f.acceptFull);

  // Each selected file in its own bun process, as the runner shards would see it.
  const macos = new Set(macosNamedFrom(workflow));
  let green = 0;
  const passed = new Set<string>();
  const unverified: string[] = [];
  const verdict = (v: FileVerdict) => (v.ok ? 'ok' : v.unverified ? `UNVERIFIED: ${v.why}` : `RED: ${v.why}`);
  // One run in its own CI-shard sandbox; a write to its private HOME is red, as CI's home guard makes it.
  const runFile = (file: string, stateDir: string, tmpdir?: string): FileVerdict => {
    const { env: fileEnv, guard } = testFileEnv(testEnv, stateDir, file, tmpdir);
    const v = judgeBunRun(file, d.tool('bun', ['test', path.join(c.tree, file), '--timeout=30000', '--max-concurrency=1'], { cwd: c.tree, env: fileEnv, timeoutMs: 900_000 }));
    const wrote = guard.verify();
    return wrote ? { ...v, ok: false, unverified: false, why: `home write: ${wrote}` } : v;
  };
  sel.files.forEach((s, i) => {
    const v = runFile(s.file, path.join(tmp, `file-${i}`));
    if (v.ok) {
      green++;
      passed.add(s.file);
    }
    if (v.unverified) unverified.push(s.file);
    line(`${s.file} rc=${v.rc} ${v.pass} pass ${v.fail} fail ${v.skip} skip ran=${v.ran ? 1 : 0} ${verdict(v)} [${s.rules.join(',')}]`, !v.ok && !v.unverified);
    if (macos.has(s.file)) {
      const sys = runFile(s.file, path.join(tmp, `file-${i}-default-temp`), sysTmp);
      line(`${s.file} (default temp root) rc=${sys.rc} ran=${sys.ran ? 1 : 0} ${verdict(sys)}`, !sys.ok && !sys.unverified);
    }
  });

  // Each changed file needs a passing test that exercises it, never GREEN 0/0 or a tripwire's pass.
  const bare = uncoveredCode(untestedCode(changed, sel, f => fs.existsSync(path.join(c.tree, f))), sel, f => passed.has(f));
  if (bare.length) line(noTestsLine(bare), true);

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
  // CI shellchecks a named list (the extensionless `setup` among it); *.sh files are checked too.
  const ciShell = new Set(shellcheckTargetsFrom(showBase(c, '.github/workflows/quality-gate.yml')));
  const shellChanged = changed.filter(f => (/\.sh$/.test(f) || ciShell.has(f)) && fs.existsSync(path.join(c.tree, f)));
  if (shellChanged.length && d.which('shellcheck')) {
    const r = tool('shellcheck', ['--severity=error', ...shellChanged], 300_000);
    line(`mirror shellcheck rc=${r.status} (${shellChanged.length} file(s))`, r.status !== 0);
  }

  const skipped = unverified.length ? `; ${unverified.length} unverified (every test skipped: ${unverified.slice(0, 3).join(', ')}${unverified.length > 3 ? ', ...' : ''})` : '';
  // The summary is what the push question shows and gstack-pr-body publishes: a waiver must travel with it.
  const waived = sel.full.length && c.f.acceptFull ? `; FULL waived (${sel.full.join(', ')}): the full suite did not run` : '';
  const summary = `${green}/${sel.files.length} selected files green${skipped}${waived}${worst ? '; RED' : ''}`;
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
