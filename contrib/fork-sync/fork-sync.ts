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
 *      red baseline cannot hide a regression in it.
 *   6. Land. Re-verify the live checkout (same branch, same tip, clean), make
 *      sure the old tip is on origin, push the new branch (a NEW ref, never a
 *      force), switch the live checkout to it, run ./setup and the version
 *      migrations, and prove the suite starts. Any failure after the switch
 *      rolls back to the old branch.
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

export interface SuiteResult {
  /** `file — test name` keys, from the runner epilogue's `  ✗ ` lines. */
  failures: Set<string>;
  failingFiles: Set<string>;
  crashed: Set<string>;
  unattributed: number;
  shardsSeen: Set<number>;
  shardTotal: number;
  timedOut: boolean;
  passedWhole: boolean;
}

export interface GateVerdict {
  verdict: 'pass' | 'regression' | 'inconclusive';
  regressions: string[];
  flaky: string[];
  baseline: string[];
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
const SHARD_LINE = /^\[test:free\] shard (\d+)\/(\d+): \d+ files, \d+s, (pass|fail|timed-out)$/;

/**
 * Parse the free runner's output (scripts/test-free-shards.ts). Each shard
 * prints `[test:free] shard i/N: … pass|fail|timed-out` and, when it failed,
 * an epilogue naming every failing test as `  ✗ <file> — <test>`.
 */
export function parseSuiteLog(text: string): SuiteResult {
  const result: SuiteResult = {
    failures: new Set(), failingFiles: new Set(), crashed: new Set(), unattributed: 0,
    shardsSeen: new Set(), shardTotal: 0, timedOut: false, passedWhole: false,
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
    const shard = SHARD_LINE.exec(line);
    if (shard) {
      result.shardsSeen.add(Number(shard[1]));
      result.shardTotal = Math.max(result.shardTotal, Number(shard[2]));
      if (shard[3] === 'timed-out') result.timedOut = true;
    }
  }
  return result;
}

/** A run is complete when every shard 1..N printed its epilogue line and none timed out. */
export function suiteComplete(r: SuiteResult): boolean {
  if (r.timedOut || r.shardTotal === 0) return false;
  for (let i = 1; i <= r.shardTotal; i += 1) if (!r.shardsSeen.has(i)) return false;
  return true;
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

/** Ours-only unattributed failures cannot be isolated to a file. */
export function oursOnlyUnattributed(ours: SuiteResult, base: SuiteResult): number {
  let n = 0;
  for (const key of ours.failures) if (key.startsWith('(unattributed) — ') && !base.failures.has(key)) n += 1;
  return n;
}

// ─── Process helpers ────────────────────────────────────────────────────────

interface Sh { code: number; stdout: string; stderr: string }

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Sh {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd, env: opts.env ?? process.env, encoding: 'utf8',
    timeout: opts.timeoutMs ?? 120_000, maxBuffer: 64 * 1024 * 1024,
  });
  // trimEnd, not trim: porcelain output starts with a status column that may be a space.
  return { code: r.status ?? (r.error ? 127 : 1), stdout: (r.stdout ?? '').trimEnd(), stderr: (r.stderr ?? '').trim() };
}

const GIT_ENV: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' };

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
    '--proof-cmd': 'proofCmd', '--proof-expect': 'proofExpect', '--notify': 'notifyCmd',
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

async function judge(cfg: Config, ours: SuiteResult, base: SuiteResult, touchedTests: string[], oursRoot: string, baseRoot: string, runDir: string): Promise<GateVerdict> {
  // Isolate first, judge completeness second: a regression confirmed in
  // isolation is definitive even when a shard wedged, and naming it is what
  // makes the STOP actionable. An incomplete run with nothing confirmed can
  // prove nothing either way, so it stays inconclusive.
  const v: GateVerdict = { verdict: 'pass', regressions: [], flaky: [], baseline: [], reasons: [] };
  if (!suiteComplete(ours)) {
    v.verdict = 'inconclusive';
    v.reasons.push(ours.timedOut ? 'a shard of the rebased suite timed out' : 'the rebased suite did not finish every shard');
  }
  const unattributed = oursOnlyUnattributed(ours, base);
  if (unattributed > 0) {
    v.verdict = 'inconclusive';
    v.reasons.push(`${unattributed} ours-only failure(s) could not be attributed to a file`);
  }
  for (const file of gateCandidates(ours, base, touchedTests)) {
    const isoLog = path.join(runDir, 'isolate.log');
    if (!fs.existsSync(path.join(oursRoot, file))) {
      // Attributed to a path this tree does not have: not a file we can re-run.
      v.reasons.push(`skipped ${file}: not a file in the rebased tree`);
      continue;
    }
    if (await isolatedPasses(cfg, oursRoot, file, isoLog)) { v.flaky.push(file); continue; }
    if (!fs.existsSync(path.join(baseRoot, file))) { v.regressions.push(`${file} (new on our side, fails)`); continue; }
    if (await isolatedPasses(cfg, baseRoot, file, isoLog)) v.regressions.push(file);
    else v.baseline.push(file);
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
    if (git(repo, 'rev-parse', '--is-inside-work-tree').stdout !== 'true') return pre(`not a git work tree: ${path.basename(repo)}`);
    const gitDir = gitOk(repo, 'rev-parse', '--absolute-git-dir');
    const commonDir = path.resolve(repo, gitOk(repo, 'rev-parse', '--git-common-dir'));
    if (realpathOrNull(gitDir) !== realpathOrNull(commonDir)) {
      return pre('the durable checkout is a linked worktree; the live suite must run from the main checkout');
    }
    if (!cfg.noLand) {
      const live = realpathOrNull(cfg.liveLink);
      if (live !== realpathOrNull(repo)) return pre(`the live link resolves to ${live ?? 'nothing'}, not the durable checkout; re-run ./setup there`);
    }
    for (const remote of [cfg.upstreamRemote, cfg.originRemote]) {
      if (git(repo, 'remote', 'get-url', remote).code !== 0) return pre(`no '${remote}' remote: not a fork install`);
    }
    const current = git(repo, 'symbolic-ref', '--quiet', '--short', 'HEAD').stdout;
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
    Object.assign(facts, {
      gate: {
        ours: { failures: oursResult.failures.size, files: oursResult.failingFiles.size, complete: suiteComplete(oursResult), exit: oursSuite.code },
        base: { failures: baseResult.failures.size, files: baseResult.failingFiles.size, complete: suiteComplete(baseResult), exit: baseSuite.code },
        verdict,
      },
    });
    logLine(cfg, `gate ours=${oursResult.failures.size} base=${baseResult.failures.size} verdict=${verdict.verdict}`
      + ` regressions=${verdict.regressions.length} flaky=${verdict.flaky.length} baseline=${verdict.baseline.length}`);

    // A suite run can repoint the live link (older team-mode tests ran ./setup
    // with the real HOME). Never leave the machine pointing into a throwaway.
    if (!cfg.noLand && realpathOrNull(cfg.liveLink) !== realpathOrNull(repo)) {
      logLine(cfg, 'WARN the live link moved during the gate; restoring it from the durable checkout');
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
    if (realpathOrNull(cfg.liveLink) !== realpathOrNull(repo)) return 'the live link does not resolve to the durable checkout after setup';
    const proof = sh('/bin/bash', ['-c', fill(cfg.proofCmd, { live: cfg.liveLink, pid: String(process.pid) })], { cwd: repo, timeoutMs: 120_000 });
    if (!proof.stdout.split('\n').some((l) => l.trim() === cfg.proofExpect)) {
      return `the proof command did not print "${cfg.proofExpect}" (exit ${proof.code})`;
    }
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
  return [brief, last?.detail ? `  ${last.detail}` : '', `  state: ${path.join(cfg.stateDir, 'state.json')}`,
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
  if (realpathOrNull(SELF) !== realpathOrNull(scriptPath) && !args.includes('--allow-foreign')) {
    console.error(`install-agent must run from the durable checkout's copy (${scriptPath}), not ${SELF}.`);
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
      default:
        console.log('usage: fork-sync.ts run [--dry-run] [--no-land] [--force] [--ignore-load] | status [--brief|--json] | install-agent [--print] [--notify <path>] | uninstall-agent');
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
