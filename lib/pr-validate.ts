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
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PrContextError, RELEASE_FILES, envelope, defaultGh, defaultGit, parsePrRefFor, upstreamRepoFromGh, remoteForRepo,
  pinBranch, readPr, topicFor, prStateDir, readStateFor, writeState, withPrLock,
  type GhResult, type GhRunner, type GitRunner, type PrInfo, type PrState,
} from './pr-context';
import { collectFreeTestFiles, TEST_ROOTS } from '../scripts/test-free-shards';
import { parseBunTerminalSummary, stripAnsiLine } from '../scripts/lib/shard-engine';
import { FREE_HOME_SURFACES, privateFreeHome, type FreeHomeGuard } from '../scripts/lib/free-home-guard';

export const VALIDATE_EXIT = { GREEN: 0, RED: 1, USAGE: 2, PRECONDITION: 30 } as const;

/**
 * How long a finished run waits for the PR state lock to record its
 * verdict. The default 10 s is too short to wait out a sync push holding
 * the lock across its network write, and losing a minutes-long run's
 * verdict to a busy lock (exit 45) means running it all again.
 */
export const VERDICT_LOCK_BUDGET_MS = 120_000;

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
red, as CI's home guard makes it, and never reaches yours). Agent
markers (CLAUDECODE, AI_AGENT, AGENT, REPL_ID, CLAUDE*) are stripped,
every credential-shaped variable is unset, git reads no system config,
git's ssh no ~/.ssh and gh an empty config dir (your gh login, keychain
helper and ssh keys stay out of git's and gh's reach; a test that runs
ssh itself still reads ~/.ssh), CI=true (as GitHub Actions sets it: a
committed test.only fails) and TMPDIR is a real path; git reads CI's
global config (identity, init.defaultBranch main, safe.directory)
instead of yours.
Records the verdict for the exact commit in the PR state; red if HEAD
moves off that commit, a tracked file changes while the preconditions
(bar their own build outputs) or the tests run, or an untracked file
appears while the preconditions run. Every commit is read as CI's
checkout holds it: your replace refs (git replace) and graft file
(info/grafts) are ignored.

  run       preconditions + selection + per-file runs + mirrors
            (typecheck, typecheck:test, the added-line secret scan,
            shellcheck on changed *.sh files and the files CI's quality
            gate shellchecks)
  select    print the selection and the rule that picked each file
  declare   record test paths that must always run for this PR (free
            test files of the tree only; voids a recorded verdict that
            did not run them, and a run in flight when one is declared
            records RED)

A file passes only with exit 0, no "(fail)" line and bun's own last
"Ran N tests across 1 file" line on stderr, with no test result after
it, agreeing with the counts above it (no such line = a truncated run;
a block a test printed cannot stand in). A file in which no test passed
(every test skipped) is UNVERIFIED: named in the summary, never counted
green.
Each changed file (anything but release files, *.md and FULL triggers)
needs a passing selected test that exercises it: the file itself, a test
importing it (directly or through the modules it imports), pointing a
relative path at it, joining its path segments (from the repo root, the
test's own directory or file, or a const resolved from them; a code
file's extension may be left off when the join ends there) or naming it,
or, for a template gen-skill-docs renders or a module it imports, the
skill-rendering tests. A class tripwire's pass (egress wiring,
sync-spawn timeouts, skill budgets, tracker-text wiring, ...) is not
coverage. A file with none is red (NO_TESTS), never "0/0 green": declare
the tests that cover it (a passing declared test covers the change).
A change to package.json beyond .version, bun.lock, tsconfig,
bunfig.toml or its preload files, .github/workflows/free-tests.yml, or
the free-suite runner and the modules it imports needs the full suite:
the selection prints FULL and the run stays red unless
--accept-full-risk (CI runs the full suite).

Options:
  --pr N|URL            the upstream PR (required)
  --repo OWNER/NAME     upstream repo (default: gh repo view in --cwd)
  --cwd DIR             the PR worktree (default: .)
  --tree DIR            tree to validate (default: the staged sync, else --cwd)
  --accept-full-risk    a FULL trigger does not by itself make the run red;
                        the recorded summary says the full suite was waived

Exit codes (the RESULT word tells 1's two cases apart):
  0   run: GREEN; select, declare, --help: done
  1   run: RED (the verdict is recorded); or RESULT ERROR: a gh, git or
      PR-state failure (nothing recorded)
  2   RESULT USAGE: bad arguments, a missing --pr, a path declare refuses
  30  RESULT PRECONDITION: the tree lacks gstack's release tooling
      (bin/gstack-next-version, scripts/gen-agents-digest.ts), has
      uncommitted changes or untracked files, no remote points at the
      repo, or the PR state belongs to another PR
  40  RESULT ERROR: the PR's base branch is gone upstream or moved while
      it was pinned; run again
  45  RESULT ERROR: the PR state lock stayed busy (10 s for declare,
      120 s for run's verdict); run again

First line of stdout: RESULT <WORD> ... (run prints the upstream range
of a staged sync on stderr before executing it).`;

// ── environment ─────────────────────────────────────────────────────────────

// Agent markers (bun 1.4 switches to agent-mode output on CLAUDECODE, AGENT
// and REPL_ID, which breaks nested-runner tests), the render hook and eval
// knobs.
// GSTACK_EXPECT_BINARIES is a step setting, not ambient state: CI sets it on the
// free-suite step only. A caller that holds it (a validate run inside the free
// suite) must not pass it to the precondition builds, or to tests after a tree
// with no build:gates; the test step arms it itself.
const STRIP_RE = /^(CLAUDECODE|AI_AGENT|AGENT|REPL_ID|CLAUDE[A-Z0-9_]*|GSTACK_SKIP_RENDER_HOOK|GSTACK_EXPECT_BINARIES|EVALS[A-Z0-9_]*)$/;
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
// entries outrank a test's GIT_CONFIG_GLOBAL isolation. GIT_SSH and
// GIT_SSH_VARIANT name the caller's ssh; validationEnv sets its own.
const GIT_CONFIG_ENV_RE = /^GIT_CONFIG(_COUNT|_KEY_\d+|_VALUE_\d+|_PARAMETERS|_GLOBAL|_SYSTEM|_NOSYSTEM)?$|^GIT_SSH(_COMMAND|_VARIANT)?$/;

/**
 * The ssh git runs for a test: OpenSSH reads ~/.ssh (config, keys, known
 * hosts) from the passwd entry's home, not $HOME, so a private HOME does
 * not hide the owner's GitHub key. This one reads no config file, offers
 * no key and no agent, keeps no known hosts and never prompts, like CI's
 * keyless free lane. A test that sets its own GIT_SSH_COMMAND, or runs
 * ssh directly, is not covered.
 */
export const KEYLESS_SSH = 'ssh -F /dev/null -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o IdentityAgent=none -o UserKnownHostsFile=/dev/null -o GlobalKnownHostsFile=/dev/null -o BatchMode=yes';

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
  // GH_TOKEN, no ssh key): no system git config (Homebrew's names the
  // osxkeychain credential helper), an empty gh config dir and a keyless
  // ssh, so git over https or ssh and gh cannot act as the owner.
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GH_CONFIG_DIR = path.join(tmpdir, 'gh-config');
  env.GIT_SSH_COMMAND = KEYLESS_SSH;
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
// every file), the free lane's workflow, and the free runner with its whole
// import closure: the shard engine, home guard, CI health and Windows
// curation, lib/state-root.ts, and the paid-set helper with the matchGlob
// it imports through test/helpers/touchfiles.ts from test-selection.ts
// (together they decide what counts as a free test). touchfiles-data.ts,
// pure E2E data in that closure, is left out. test/pr-validate.test.ts
// walks the runner's imports and pins this list.
const FULL_RE = /^(bun\.lock|bun\.lockb|bunfig\.toml|test-setup\.ts|patches\/.*|tsconfig[^/]*\.json|\.github\/workflows\/free-tests\.yml|scripts\/test-free-shards\.ts|scripts\/lib\/(shard-engine|windows-curation|free-[^/]*)\.ts|lib\/state-root\.ts|test\/helpers\/(paid-test-set|touchfiles|test-selection)\.ts)$/;
// The skill surface: the roots test/tracker-guard-wiring.test.ts scans (its
// trackedFiles filter: every *.md.tmpl, section templates included,
// scripts/resolvers/ and review/*.md; test/pr-validate.test.ts reads that
// filter and pins this), the generator, and the hosts it renders for.
const SKILL_SURFACE_RE = /\.md\.tmpl$|^scripts\/resolvers\/|^review\/[^/]+\.md$|^scripts\/gen-skill-docs\.ts$|^hosts\//;
// The templates scripts/gen-skill-docs.ts renders (scripts/discover-skills.ts):
// the root's and each top-level skill's SKILL.md.tmpl, and its sections/*.md.tmpl.
const RENDERED_TMPL_RE = /^(?:[^/]+\/)?SKILL\.md\.tmpl$|^[^/]+\/sections\/[^/]+\.md\.tmpl$/;
const GENERATOR = 'scripts/gen-skill-docs.ts';
// The roots test/egress-receipt-wiring.test.ts's NEW-SINK SCANNER sweeps
// (its SWEEP list; pinned by test/pr-validate.test.ts). The class:test
// roots are the free runner's TEST_ROOTS, which the sync-spawn tripwire
// scans, plus any test file (the paid-orphan tripwire reads every one).
const CODE_ROOTS = ['bin', 'lib', 'scripts', 'design/src', 'browse/src', 'hosts'];
const TEST_FILE_RE = /\.test\.[cm]?[jt]sx?$/;
const under = (f: string, roots: readonly string[]) => roots.some(r => f.startsWith(`${r}/`));
// They run the generator over every template for every host: a rendered
// template, and every module the generator imports, runs in them (`renders:`).
const RENDER_TESTS = ['test/gen-skill-docs.test.ts', 'test/skill-validation.test.ts'];
// Tripwires over the skill surface: the generated files' size budgets and the
// tracker-text wiring scan. Like every class pick they run but never cover,
// and a path they only name (names:) is a file they reason about, not one they
// run. The code they import or reach runs in them and is covered; a path they
// point at or join (refs:, joins:) is a file they read, which is covered only
// when it is data (tripwireData), never a template or code they scan as text.
const CLASS_SKILL = ['test/catalog-budget.test.ts', 'test/context-budget-ratchet.test.ts', 'test/tracker-guard-wiring.test.ts'];
// Data a skill tripwire reads and checks: a test fixture, or a file outside
// the code roots with a data extension (the formats tracked there: JSON,
// YAML, TOML, text). It names what data is rather than what a script is,
// since setup, browse/bin/remote-slug or a .py tool has no .ts or .sh name.
// The skill surface is never data: templates, review prose, or files under
// scripts/ and hosts/.
const DATA_EXT_RE = /\.(?:json|ya?ml|toml|txt)$/;
const tripwireData = (f: string) => /(?:^|\/)test\/fixtures\//.test(f) || (!under(f, CODE_ROOTS) && DATA_EXT_RE.test(f));
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

const CODE_EXT_RE = /\.[cm]?[jt]sx?$/;

/**
 * Path segments as consecutive quoted path.join arguments (`'scripts',
 * 'eval-list.ts'`), right after `anchor` (a regex source for the first
 * argument) when given, and closing the call when `closes`.
 */
function joinedSegmentsRe(segs: string[], anchor: string | null = null, closes = false): RegExp {
  const args = segs.map((s, i) => `(['"\`])${escapeRe(s)}\\${i + 1}`).join('\\s*,\\s*');
  return new RegExp(`${anchor === null ? '' : `(?:${anchor})\\s*,\\s*`}${args}${closes ? '\\s*\\)' : ''}`);
}

/**
 * The joins that name a path given as `segs`: as written, and without a
 * code file's extension when the join ends there (a test that runs
 * `path.join(ROOT, 'hosts', 'claude', 'hooks', 'question-log-hook')`
 * runs the shim that execs question-log-hook.ts; a join that goes on,
 * `'hosts', 'claude', 'hooks'`, names a directory, not hosts/claude.ts).
 */
function joinsOf(segs: string[], anchor: string | null = null): RegExp[] {
  const last = segs[segs.length - 1];
  const stem = last.replace(CODE_EXT_RE, '');
  const res = [joinedSegmentsRe(segs, anchor)];
  if (stem && stem !== last) res.push(joinedSegmentsRe([...segs.slice(0, -1), stem], anchor, true));
  return res;
}

// `const NAME = path.resolve(<base>, 'seg', ...)`: a path a test joins from later.
const CONST_JOIN_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:path\.)?(?:resolve|join)\(\s*(import\.meta\.(?:dirname|dir|path|filename)|__dirname|__filename|[A-Za-z_$][\w$]*)((?:\s*,\s*(?:'[^'\n]*'|"[^"\n]*"))*)\s*\)/g;

/**
 * What a test's path.join/resolve calls start from, as [anchor regex
 * source, repo-relative path]: its own directory (`import.meta.dir`,
 * `__dirname`), its own file (`import.meta.path, '..'` resolves to the
 * directory), and every `const NAME = path.resolve(<one of those>, ...)`
 * it declares (browse/test's `const ROOT = path.resolve(__dirname, '..')`
 * is browse/). A const that leaves the repo is dropped.
 */
function joinAnchors(t: string, src: string): [string, string][] {
  const dir = path.posix.dirname(t);
  const anchors: [string, string][] = [['import\\.meta\\.dir(?:name)?\\b|\\b__dirname\\b', dir], ['import\\.meta\\.(?:path|filename)\\b|\\b__filename\\b', t]];
  const bases = new Map<string, string>([['import.meta.dir', dir], ['import.meta.dirname', dir], ['__dirname', dir], ['import.meta.path', t], ['import.meta.filename', t], ['__filename', t]]);
  for (const m of src.matchAll(CONST_JOIN_RE)) {
    const from = bases.get(m[2]);
    if (from === undefined) continue;
    const segs = [...m[3].matchAll(/['"]([^'"\n]*)['"]/g)].map(q => q[1]);
    const base = path.posix.normalize(path.posix.join(from, ...segs));
    if (base === '..' || base.startsWith('../')) continue;
    bases.set(m[1], base);
    anchors.push([`\\b${escapeRe(m[1])}\\b`, base]);
  }
  return anchors;
}

type JoinCache = Map<string, { joins: RegExp[]; names: RegExp[] }>;

/**
 * How test `t` names `f` relative to where its joins start (joinAnchors):
 * joined right after the anchor, at any depth
 * (`import.meta.dir, '..', 'src', 'cli.ts'`, `ROOT, 'src', 'server.ts'`),
 * or, below its own directory, two or more segments joined anywhere
 * (`'fixtures', 'one.json'`) or as one literal (`'fixtures/one.json'`, a
 * name rather than a join).
 */
function fromAnchors(src: string, t: string, anchors: [string, string][], f: string, cache: JoinCache): 'joins' | 'names' | null {
  for (const [anchor, base] of anchors) {
    const rel = path.posix.relative(base, f);
    if (!rel) continue;
    const key = `${anchor}\0${rel}`;
    let c = cache.get(key);
    if (!c) cache.set(key, (c = { joins: joinsOf(rel.split('/'), anchor), names: [] }));
    if (c.joins.some(re => re.test(src))) return 'joins';
  }
  const rel = path.posix.relative(path.posix.dirname(t), f);
  const segs = rel.split('/');
  if (segs.length < 2 || segs[0] === '..') return null;
  let c = cache.get(rel);
  if (!c) cache.set(rel, (c = { joins: joinsOf(segs), names: [new RegExp(`(['"\`])${escapeRe(rel)}\\1`)] }));
  if (c.joins.some(re => re.test(src))) return 'joins';
  return c.names.some(re => re.test(src)) ? 'names' : null;
}

/** The files an import specifier can name, in bun's order (as written, an extension, /index, .js naming a .ts). */
function importCandidates(spec: string): string[] {
  const stem = spec.replace(/\.[mc]?js$/, '');
  return [spec, ...IMPORT_EXTS.map(e => stem + e), ...IMPORT_EXTS.map(e => `${spec}/index${e}`)];
}

/** The changed path an import specifier resolves to, the way bun resolves it. */
function importedChange(spec: string, changed: Set<string>): string | undefined {
  return importCandidates(spec).find(c => changed.has(c));
}

/**
 * The tree's import graph through non-test modules, read lazily through
 * `source` (a missing or empty file imports nothing and is not a module).
 * `closure(start)` walks it breadth-first from a file's own imports and
 * calls `visit` with every specifier a reached module imports.
 */
function importGraph(source: (f: string) => string) {
  const text = new Map<string, string>();
  const read = (f: string) => {
    let s = text.get(f);
    if (s === undefined) text.set(f, (s = source(f)));
    return s;
  };
  const specs = new Map<string, string[]>();
  const importsOf = (f: string) => {
    let s = specs.get(f);
    if (!s) specs.set(f, (s = relativeImports(f, read(f)).imports));
    return s;
  };
  const resolved = new Map<string, string | null>();
  const moduleFor = (spec: string) => {
    let m = resolved.get(spec);
    if (m === undefined) resolved.set(spec, (m = importCandidates(spec).find(c => !TEST_FILE_RE.test(c) && read(c) !== '') ?? null));
    return m;
  };
  const closure = (start: string, visit: (spec: string) => void): Set<string> => {
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length) {
      const f = queue.shift()!;
      for (const spec of importsOf(f)) {
        if (f !== start) visit(spec);
        const m = moduleFor(spec);
        if (m && !seen.has(m)) {
          seen.add(m);
          queue.push(m);
        }
      }
    }
    return seen;
  };
  return { read, closure };
}

/**
 * Pure. `changed` is `git diff --name-only <merge base with the pinned
 * upstream> HEAD`; `pkgVersionOnly` says package.json changed only in
 * .version (a release, not a dependency change); `source(f)` returns a
 * file's text, '' when it is missing (tests, the modules they import and
 * the skill generator's imports are read); `preload` lists the tree's
 * bunfig.toml preload files.
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
  const graph = importGraph(x.source);
  let generator: Set<string> | null = null;
  for (const f of x.changed) {
    if (FULL_RE.test(f) || (x.preload ?? []).includes(f) || (f === 'package.json' && !x.pkgVersionOnly)) full.push(f);
    if (universe.has(f)) add(f, 'changed');
    const rendered = RENDERED_TMPL_RE.test(f) || (generator ??= graph.closure(GENERATOR, () => {})).has(f);
    if (rendered || SKILL_SURFACE_RE.test(f)) RENDER_TESTS.forEach(t => add(t, rendered ? `renders:${f}` : `class:skill(${f})`));
    if (SKILL_SURFACE_RE.test(f)) CLASS_SKILL.forEach(t => add(t, `class:skill(${f})`));
    if (under(f, CODE_ROOTS) && !TEST_FILE_RE.test(f)) CLASS_CODE.forEach(t => add(t, `class:code(${f})`));
    if (under(f, TEST_ROOTS) || TEST_FILE_RE.test(f)) CLASS_TEST.forEach(t => add(t, `class:test(${f})`));
    if (RELEASE_FILES.includes(f)) CLASS_RELEASE.forEach(t => add(t, `class:release(${f})`));
  }
  // A test that imports a changed module (directly, or through the non-test
  // modules it imports, each specifier resolved the way bun resolves it),
  // points a relative path literal at it, names a changed path, or names a
  // changed bin's basename, exercises it. Tests import without
  // the extension ('../lib/foo'), which `git diff --name-only` never
  // prints, so the edge is resolved rather than searched for as text.
  const nonRelease = x.changed.filter(f => !RELEASE_FILES.includes(f));
  const importable = new Set(nonRelease);
  // How a test can name a changed path: its segments as path.join
  // arguments, from the repo root (path.join(ROOT, 'scripts',
  // 'eval-list.ts')) or from where the test's joins start (joinAnchors)
  // (`joins:`), else the path itself or a bin's basename (`names:`). Every
  // changed path a test names is recorded, since each one's coverage is
  // judged on its own.
  const named = nonRelease
    .filter(f => !universe.has(f))
    .map(f => {
      const tokens = [f];
      const base = path.basename(f);
      if (f.startsWith('bin/') && base.length >= 6) tokens.push(base);
      return { f, stem: base.replace(CODE_EXT_RE, '') || base, tokens, joins: f.includes('/') ? joinsOf(f.split('/')) : [] };
    });
  const joinCache: JoinCache = new Map();
  if (importable.size) {
    for (const t of x.universe) {
      const src = graph.read(t);
      const rel = relativeImports(t, src);
      const direct = new Set<string>();
      for (const [kind, specs] of [['imports', rel.imports], ['refs', rel.refs]] as const) {
        for (const spec of specs) {
          const hit = importedChange(spec, importable);
          if (hit && hit !== t) {
            add(t, `${kind}:${hit}`);
            direct.add(hit);
          }
        }
      }
      // A module the test reaches through the modules it imports (an index
      // re-exporting it, a helper importing it) runs when the test does.
      graph.closure(t, spec => {
        const hit = importedChange(spec, importable);
        if (hit && hit !== t && !direct.has(hit)) add(t, `reaches:${hit}`);
      });
      let anchors: [string, string][] | null = null;
      for (const n of named) {
        // Every form below contains the basename without its extension: a cheap exact pre-filter.
        if (!src.includes(n.stem)) continue;
        anchors ??= joinAnchors(t, src);
        const how = n.joins.some(re => re.test(src)) ? 'joins' : (fromAnchors(src, t, anchors, n.f, joinCache) ?? (n.tokens.some(tok => src.includes(tok)) ? 'names' : null));
        if (how) add(t, `${how}:${n.f}`);
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

/**
 * Every git call validate makes reads the objects as they are, as CI's fresh
 * checkout holds them: never through the caller's replace refs (`git
 * replace`). A ref replacing the merge base with a stand-in that carries the
 * PR's tree hides every change from the selection (RESULT GREEN 0/0 for a PR
 * whose test fails), and one replacing the PR's head lets a tree checked out
 * under it read clean in `git status` while it holds what the verdict's
 * commit does not. Nor through the graft file (`info/grafts`, what replace
 * refs superseded), which GIT_NO_REPLACE_OBJECTS leaves on: a graft giving
 * the new upstream base the PR's head as parent makes the head the merge
 * base. GIT_GRAFT_FILE names a path under /dev/null, which no file can be:
 * git reads no grafts and stays silent (GIT_GRAFT_FILE=/dev/null itself is
 * read, and prints the deprecated-grafts hint). Env only, so each argv stays
 * as it is. The tests' own git keeps git's default: their env is
 * validationEnv's.
 */
const NO_GRAFT_FILE = '/dev/null/gstack-pr-validate-no-grafts';
function withoutReplaceRefs(git: GitRunner, env: NodeJS.ProcessEnv): GitRunner {
  return (args, o) => git(args, { ...o, env: { ...(o.env ?? env), GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: NO_GRAFT_FILE } });
}

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
  return gitOk(c.d, c.tree, ['diff', '--name-only', '--no-renames', '-z', mb, 'HEAD'], 'git diff').split('\0').filter(Boolean);
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
 * pick covers the path its rule names: `changed` (a test file itself),
 * `imports:`, `reaches:`, `refs:`, `joins:`, `names:`, and `renders:` (the
 * skill-rendering tests run a rendered template and every module the
 * generator imports). A `class:*` pick never covers: those tests are
 * tripwires that scan source or generated files for one pattern, and they
 * run without exercising the change. A skill-surface tripwire's `names:`
 * never covers either: it names the files it reasons about
 * (test/tracker-guard-wiring.test.ts's exemption list), not code it runs.
 * What it imports or reaches runs in it, as in any test
 * (test/context-budget-ratchet.test.ts is the only importer of the capture
 * helper); what it points at or joins is a file it reads, covered only when
 * that is data it checks (tripwireData: a fixture, a JSON or YAML file),
 * since only the renderers cover a skill file and a module or script it
 * reads as text never ran. A passing declared test covers everything: the
 * owner declared it for the change.
 */
export function uncoveredCode(code: string[], sel: Selection, passed: (file: string) => boolean): string[] {
  const covered = new Set<string>();
  for (const s of sel.files) {
    if (!passed(s.file)) continue;
    if (s.rules.includes('declared')) return [];
    const tripwire = CLASS_SKILL.includes(s.file);
    for (const r of s.rules) {
      if (r === 'changed') covered.add(s.file);
      const m = /^(imports|reaches|refs|joins|names|renders):(.+)$/.exec(r);
      if (!m) continue;
      const [, kind, f] = m;
      if (tripwire && !(kind === 'imports' || kind === 'reaches' || ((kind === 'refs' || kind === 'joins') && tripwireData(f)))) continue;
      covered.add(f);
    }
  }
  return code.filter(f => !covered.has(f));
}

function noTestsLine(files: string[]): string {
  return `NO_TESTS ${files.length} changed file(s) no passing selected test exercises (${shownPaths(files)}${files.length > 5 ? ', ...' : ''}): a class tripwire is not coverage; declare the tests that cover them (gstack-pr-validate declare)`;
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
  for (const f of sel.full) c.d.out(`FULL\t${shownPath(f)}`);
  for (const s of sel.files) c.d.out(`SELECT\t${shownPath(s.file)}\t${s.rules.map(shownPath).join(',')}`);
  for (const f of sel.missingDeclared) c.d.out(`DECLARED_MISSING\t${shownPath(f)}`);
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
    c.d.out(`RESULT DECLARED ${paths.length} path(s): ${paths.map(shownPath).join(' ')}`);
    if (voided) c.d.out(`NOTE the recorded validation of ${s.validation!.sha.slice(0, 12)} did not run ${added.map(shownPath).join(' ')}: it is void; run gstack-pr-validate run again`);
  });
  return 0;
}

/**
 * Tracked files a precondition rebuilds: build:gates' build:diagram-render
 * rewrites lib/diagram-render/dist (BUILD_INFO.json and the bundled html).
 */
const REBUILT_RE = /^lib\/diagram-render\/dist\//;

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };

/**
 * The a/ path of a `diff --git` header line, as named on disk. git
 * C-quotes a path holding a control byte, a quote, a backslash or, under
 * the default core.quotePath, a non-ASCII byte ("a/lib/caf\303\251.ts").
 */
function headerPath(header: string): string {
  const quoted = /^diff --git "a\/((?:[^"\\]|\\.)*)"/.exec(header);
  if (!quoted) return /^diff --git a\/(.+?) b\//.exec(header)?.[1] ?? header;
  const bytes = quoted[1].split(/(\\(?:[0-3][0-7]{2}|.))/).map(part => {
    if (!part.startsWith('\\')) return Buffer.from(part, 'utf8');
    const e = part.slice(1);
    return Buffer.from([/^[0-7]{3}$/.test(e) ? parseInt(e, 8) : C_ESCAPES[e] ?? e.charCodeAt(0)]);
  });
  return Buffer.concat(bytes).toString('utf8');
}

/**
 * HEAD and the tracked worktree changes against it (`git diff HEAD`), per
 * file and as one digest. The prefixes are explicit: a caller's
 * diff.noprefix, diff.mnemonicPrefix, diff.srcPrefix or diff.dstPrefix
 * would move the header off `a/<f> b/<f>`, headerPath would key the file
 * by the whole header, and a precondition's own rebuilt output would read
 * as a tree change. The content is git's own too: a caller's textconv
 * (a diff driver named through core.attributesFile) can convert HEAD and
 * an edited file alike, and the edit would drop out of the fingerprint.
 */
function treeState(c: Ctx): { head: string; diff: string; files: Map<string, string> } {
  const head = gitOk(c.d, c.tree, ['rev-parse', 'HEAD'], 'git rev-parse').trim();
  const r = c.d.git(['diff', 'HEAD', '--no-color', '--binary', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'], { cwd: c.tree });
  if (r.status !== 0) throw new PrContextError(`git diff HEAD failed: ${(r.error ?? r.stderr).trim().split('\n').at(-1)}`, 1);
  const files = new Map<string, string>();
  for (const part of r.stdout.split(/^(?=diff --git )/m).filter(p => p.startsWith('diff --git '))) {
    files.set(headerPath(part.split('\n')[0]), createHash('sha256').update(part).digest('hex'));
  }
  return { head, diff: createHash('sha256').update(r.stdout).digest('hex'), files };
}

/** Tracked files whose `git diff HEAD` section differs between two tree states. */
function movedFiles(a: { files: Map<string, string> }, b: { files: Map<string, string> }): string[] {
  return [...new Set([...a.files.keys(), ...b.files.keys()])].filter(f => a.files.get(f) !== b.files.get(f));
}

const CONTROL_RE = /[\x00-\x1f\x7f-\x9f]/g;

/** Text as printed: every C0, DEL and C1 character as a \u escape. */
function escapeControl(s: string): string {
  return s.replace(CONTROL_RE, ch => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * A tree path as printed. Names reach validate raw (`git status -z`, the
 * test-file walk behind the universe), and upstream code that runs here can
 * name a file anything: a raw newline would print a line of its own (a
 * forged RESULT, or a line in the PR body gstack-pr-body publishes from the
 * summary), and ESC or a C1 byte would drive the terminal. A path holding
 * one prints JSON-quoted, every such byte escaped.
 */
function shownPath(p: string): string {
  return p.search(CONTROL_RE) === -1 ? p : escapeControl(JSON.stringify(p));
}

/** Paths as printed, at most five, comma-separated. */
function shownPaths(paths: string[]): string {
  return paths.slice(0, 5).map(shownPath).join(', ');
}

/**
 * What `git status` lists against HEAD, one entry per path: tracked changes
 * and untracked files (ignored files never appear; `normal` lists an
 * untracked directory once). -z hands every name over raw, never C-quoted
 * as the caller's core.quotePath would leave it: print one with shownPath.
 */
function statusEntries(c: Ctx, untrackedFiles: 'all' | 'normal' = 'all'): { path: string; untracked: boolean }[] {
  const parts = gitOk(c.d, c.tree, ['status', '--porcelain', '-z', `--untracked-files=${untrackedFiles}`], 'git status').split('\0');
  const entries: { path: string; untracked: boolean }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    entries.push({ path: e.slice(3), untracked: e.startsWith('??') });
    // A rename or copy names its source in the next field: X is R or C when
    // it is staged; Y is R when it is in the worktree (the new name added -N),
    // or C for a worktree copy under status.renames=copies.
    if (/^(?:[RC]|.[RC])/.test(e)) i++;
  }
  return entries;
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
  const dirty = statusEntries(c, 'normal');
  if (dirty.length) {
    const what = dirty.every(e => e.untracked) ? 'untracked files' : 'uncommitted changes';
    // The caller's own `git status` follows their replace refs and can read clean: say why this one does not.
    const replaced = d.git(['replace', '-l'], { cwd: c.tree }).stdout.split('\n').filter(Boolean).length;
    const against = replaced ? ` against HEAD as CI's checkout holds it, read without this repo's ${replaced} replace ref(s) (git replace -l)` : '';
    throw new PrContextError(`${c.tree} has ${what} (${shownPaths(dirty.map(e => e.path))})${against}; a verdict must name a commit that holds everything the tests use`, VALIDATE_EXIT.PRECONDITION);
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

/**
 * Whether git may fetch a missing object here from a promisor remote: a
 * partial clone. git 2.56's `clone --filter` sets remote.<name>.promisor
 * and no extensions.partialClone, which older clones set. A promisor key
 * set to false counts too; the cost is one more read of blobs already held.
 */
function isPartialClone(c: Ctx): boolean {
  return c.d.git(['config', '--get-regexp', '^(extensions\\.partialclone|remote\\..+\\.promisor)$'], { cwd: c.tree }).status === 0;
}

/** What CI's secret-scan step diffs: all but the fixtures and baselines that hold credential-shaped strings on purpose. */
const SECRET_SCAN_PATHSPEC = ['.', ':(exclude)test/fixtures/**', ':(exclude)browse/test/fixtures/**', ':(exclude)docs/evals/**', ':(exclude)test/helpers/security-bench*'];

/**
 * The patch CI's secret-scan step pipes to gate-secret-scan.mjs: `git diff
 * --unified=0 --no-color <base> <head>` in a fresh Linux checkout, under
 * CI's global config and nothing else. Run in the caller's repo, the diff
 * reads the caller's config and attributes, and several of them leave an
 * added line with no `+`:
 * - a `-diff` or binary rule (core.attributesFile, the XDG attributes file,
 *   .git/info/attributes, GIT_ATTR_SOURCE, the system file), a driver with
 *   binary=true, or a file over core.bigFileThreshold prints only
 *   'Binary files ... differ';
 * - diff.renames=copies turns a new file copied from a modified one into a
 *   copy header;
 * - a replace ref swaps the blob that is read;
 * - macOS's core.ignorecase lets a `*.TS` rule match lib/y.ts, which CI's
 *   Linux checkout never does.
 * So the diff runs in an empty git dir of its own over the caller's object
 * store. It reads no config but CI's global one, no attributes but the
 * tree's tracked .gitattributes, and no GIT_* variable of the caller's.
 * --no-ext-diff and --no-textconv (diff.external, a driver's command or
 * textconv) stay for a config that reaches it anyway.
 *
 * A partial clone holds only the blobs it has fetched, and that git dir has
 * no promisor remote to fetch the rest: the merge base's side of a changed
 * file, never checked out, fails the diff with 'unable to read'. So the
 * caller's repo fetches them first, in one batch. A diff that prints a stat
 * reads both sides of every path (--quiet stops at the first change, with
 * the rest unfetched); its output is discarded. Like every git call here it
 * reads no replace refs (withoutReplaceRefs), so it fetches the objects the
 * own git dir reads, which has none.
 */
function secretScanDiff(c: Ctx, mb: string, sha: string, ciGitConfig: string, tmp: string): { r: GhResult; what: string } {
  if (isPartialClone(c)) {
    const r = c.d.git(['diff', '--numstat', '--no-renames', '--no-ext-diff', '--no-textconv', mb, sha, '--', ...SECRET_SCAN_PATHSPEC], { cwd: c.tree });
    if (r.status !== 0 || r.error) return { r, what: 'partial-clone blob fetch' };
  }
  const objects = path.resolve(c.tree, gitOk(c.d, c.tree, ['rev-parse', '--git-path', 'objects'], 'git rev-parse').trim());
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(c.d.env)) if (!k.startsWith('GIT_') && v !== undefined) env[k] = v;
  Object.assign(env, { GIT_CONFIG_GLOBAL: ciGitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1' });
  const gitDir = path.join(tmp, 'secret-scan.git');
  // Without its git dir, `git diff` falls back to --no-index and reads the arguments as paths.
  const init = c.d.git(['init', '-q', '--bare', '--template=', gitDir], { cwd: tmp, env });
  if (init.status !== 0 || init.error) return { r: init, what: 'git init' };
  const r = c.d.git([
    `--git-dir=${gitDir}`, `--work-tree=${c.tree}`, '-c', 'core.attributesFile=/dev/null', '-c', 'core.ignorecase=false',
    'diff', '--unified=0', '--no-color', '--no-ext-diff', '--no-textconv', mb, sha, '--', ...SECRET_SCAN_PATHSPEC,
  ], { cwd: c.tree, env: { ...env, GIT_OBJECT_DIRECTORY: objects } });
  return { r, what: 'git diff' };
}

function runIn(c: Ctx, sha: string, outDir: string, tmp: string, sysTmp: string): number {
  const { d } = c;
  const state = readStateFor(c.stateDir, c.pr);
  const declaredAtStart = new Set(state?.focused?.paths ?? []);
  const { sel, mb, changed } = selection(c, state);
  const ciGitConfig = writeCiGitConfig(outDir);
  const env = validationEnv(d.env, tmp, mb, ciGitConfig);
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

  // CI's preconditions, in CI's order. They run for minutes: what the tree
  // holds when they start (`sha`, clean) is what they may change.
  let settled = treeState(c);
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
  // Paths the drift check already reported: red there, not a change made alongside the preconditions.
  const drifted = new Set<string>();
  if (pkg.scripts?.['gen:skill-docs']) {
    const g = tool('bun', ['run', 'gen:skill-docs', '--host', 'all'], 900_000);
    const diff = statusEntries(c).map(e => e.path);
    line(`precondition gen-skill-docs-all rc=${g.status} drift=${diff.length}${diff.length ? ` (${shownPaths(diff)})` : ''}`, g.status !== 0 || diff.length > 0);
    diff.forEach(f => drifted.add(f));
    // The drift check judged everything up to here but a commit.
    settled = treeState(c);
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
  // The verdict names `sha`. A commit made while the preconditions ran, or
  // an edit to anything but their own build outputs, is what the tests
  // would run instead. `git status` also shows an untracked file a test
  // could import (cmdRun refuses one for that reason) and an edit made
  // before the first fingerprint; their ignored build outputs never show.
  const before = treeState(c);
  if (before.head !== sha) line(`tree changed during the preconditions: HEAD moved from ${sha.slice(0, 12)} to ${before.head.slice(0, 12)}; the verdict cannot name either`, true);
  else {
    const status = statusEntries(c).filter(e => !REBUILT_RE.test(e.path) && !drifted.has(e.path));
    const moved = [...new Set([...movedFiles(settled, before), ...status.filter(e => !e.untracked).map(e => e.path)])].filter(f => !REBUILT_RE.test(f));
    const gained = status.filter(e => e.untracked).map(e => e.path);
    if (moved.length) line(`tree changed during the preconditions: tracked files ${shownPaths(moved)} differ from ${sha.slice(0, 12)}, which is not what the tests would run`, true);
    if (gained.length) line(`tree changed during the preconditions: untracked files ${shownPaths(gained)} appeared, which ${sha.slice(0, 12)} does not hold and the tests could use`, true);
  }

  for (const f of sel.missingDeclared) line(`declared ${shownPath(f)} RED: not a free test file in this tree`, true);
  if (sel.full.length) line(`selection FULL (${sel.full.map(shownPath).join(', ')}): the full free suite is the real gate${c.f.acceptFull ? '; accepted by --accept-full-risk' : ''}`, !c.f.acceptFull);

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
    return wrote ? { ...v, ok: false, unverified: false, why: `home write: ${escapeControl(wrote)}` } : v;
  };
  sel.files.forEach((s, i) => {
    const v = runFile(s.file, path.join(tmp, `file-${i}`));
    if (v.ok) {
      green++;
      passed.add(s.file);
    }
    if (v.unverified) unverified.push(s.file);
    line(`${shownPath(s.file)} rc=${v.rc} ${v.pass} pass ${v.fail} fail ${v.skip} skip ran=${v.ran ? 1 : 0} ${verdict(v)} [${s.rules.map(shownPath).join(',')}]`, !v.ok && !v.unverified);
    if (macos.has(s.file)) {
      const sys = runFile(s.file, path.join(tmp, `file-${i}-default-temp`), sysTmp);
      line(`${shownPath(s.file)} (default temp root) rc=${sys.rc} ran=${sys.ran ? 1 : 0} ${verdict(sys)}`, !sys.ok && !sys.unverified);
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
    const { r: diff, what } = secretScanDiff(c, mb, sha, ciGitConfig, tmp);
    // CI's step runs under `set -euo pipefail`: a failed diff fails it, and scanning an empty or partial one would pass.
    if (diff.status !== 0 || diff.error) {
      line(`mirror secret-scan RED: ${what} failed (${diff.error ?? `exit ${diff.status}: ${diff.stderr.trim().split('\n').at(-1)}`}); nothing was scanned`, true);
    } else {
      const runner = d.which('node') ? 'node' : 'bun';
      const r = tool(runner, [scanner], 120_000, diff.stdout);
      line(`mirror secret-scan rc=${r.status}`, r.status !== 0);
    }
  }
  // CI shellchecks a named list (the extensionless `setup` among it); *.sh files are checked too.
  const ciShell = new Set(shellcheckTargetsFrom(showBase(c, '.github/workflows/quality-gate.yml')));
  const shellChanged = changed.filter(f => (/\.sh$/.test(f) || ciShell.has(f)) && fs.existsSync(path.join(c.tree, f)));
  if (shellChanged.length && d.which('shellcheck')) {
    const r = tool('shellcheck', ['--severity=error', ...shellChanged], 300_000);
    line(`mirror shellcheck rc=${r.status} (${shellChanged.length} file(s))`, r.status !== 0);
  }

  // An edit or commit made while the tests ran (minutes) was tested, not `sha`; the verdict cannot name it.
  const after = treeState(c);
  if (after.head !== before.head) line(`tree changed during the run: HEAD moved from ${before.head.slice(0, 12)} to ${after.head.slice(0, 12)}; the verdict cannot name either`, true);
  else if (after.diff !== before.diff) {
    const moved = movedFiles(before, after);
    line(`tree changed during the run: tracked files ${shownPaths(moved) || '(content)'} differ from what the preconditions left; ${sha.slice(0, 12)} was not what ran`, true);
  }

  const skipped = unverified.length ? `; ${unverified.length} unverified (every test skipped: ${unverified.slice(0, 3).map(shownPath).join(', ')}${unverified.length > 3 ? ', ...' : ''})` : '';
  // The summary is what the push question shows and gstack-pr-body publishes: a waiver must travel with it.
  const waived = sel.full.length && c.f.acceptFull ? `; FULL waived (${sel.full.map(shownPath).join(', ')}): the full suite did not run` : '';
  const summaryOf = () => `${green}/${sel.files.length} selected files green${skipped}${waived}${worst ? '; RED' : ''}`;
  const writeSummary = () => fs.writeFileSync(path.join(outDir, 'summary.txt'), [...lines, `VALIDATE-END worst=${worst}`].join('\n') + '\n');
  writeSummary();
  let summary = summaryOf();
  withPrLock(c.stateDir, () => {
    const s = readStateFor(c.stateDir, c.pr) ?? freshState(c.pr);
    // A declare that landed while this run was in flight named a file it never ran (the selection read
    // the declared set at the start), and the declare found no verdict to void yet: this one cannot stand.
    const late = (s.focused?.paths ?? []).filter(p => !declaredAtStart.has(p));
    if (late.length) {
      line(`declared during the run, never ran: ${late.map(shownPath).join(', ')}: run gstack-pr-validate run again`, true);
      writeSummary();
      summary = summaryOf();
    }
    writeState(c.stateDir, { ...s, validation: { sha, worst: worst ? 1 : 0, summary, at: d.now().toISOString() } });
  }, { budgetMs: VERDICT_LOCK_BUDGET_MS });
  lines.push(`VALIDATE-END worst=${worst}`);
  d.out(`RESULT ${worst ? 'RED' : 'GREEN'} sha=${sha.slice(0, 12)} ${summary} summary=${path.join(outDir, 'summary.txt')}`);
  for (const l of lines) d.out(l);
  return worst ? VALIDATE_EXIT.RED : VALIDATE_EXIT.GREEN;
}

export async function validateMain(argv: string[], deps: Partial<ValidateDeps> = {}): Promise<number> {
  const given = { ...realDeps(), ...deps };
  const d: ValidateDeps = { ...given, git: withoutReplaceRefs(given.git, given.env) };
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
