/**
 * gate-incoming.test.ts — pins bin/gstack-gate-incoming and the two updaters
 * that call it before they move a registered checkout.
 *
 * WHY. settings.json runs gstack's hooks by path, straight out of the checkout
 * ./setup registered, so the working tree IS the deployed hook set. Team mode's
 * bin/gstack-session-update and /gstack-upgrade both used to `git pull` first
 * and run ./setup second: a pulled hook that does not parse broke every session
 * at once, and setup's refusal came after the fact. They now gate the incoming
 * commit in a throwaway worktree and fast-forward only to the commit that
 * passed. See docs/hook-syntax-gate.md.
 *
 * The properties defended here:
 *   1. a broken incoming hook leaves the checkout on its old commit, says why,
 *      and leaves no worktree or scratch directory behind
 *   2. a clean incoming commit is fast-forwarded to, and only that commit
 *   3. no verdict (a checker that exits 2+, or hangs) is never a pass
 *   4. an autostash pop that conflicts never leaves conflict markers in the
 *      live tree, and never loses the local edits
 *   5. a merge in progress in the checkout is never reset away
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const HELPER = path.join(ROOT, 'bin', 'gstack-gate-incoming');
const SESSION_UPDATE = path.join(ROOT, 'bin', 'gstack-session-update');
const CHECKER = path.join(ROOT, 'scripts', 'hook-syntax.sh');
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'gstack-upgrade', 'SKILL.md.tmpl'), 'utf-8');

// A gate run forks once per file in the tree; under the free suite's parallel
// shards that is seconds, not milliseconds.
const SPAWN_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 180_000;

// Built from a constant so this file never carries a marker at line start.
const LT = '<'.repeat(7);

const HOOK = 'hosts/claude/hooks/demo-hook';
const GOOD_HOOK = '#!/bin/bash\necho ok\n';
const BROKEN_HOOK = '#!/bin/bash\nif then fi\n';

// No global or system git config: a global core.hooksPath would make the
// hooks-isolation case pass without proving anything.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'gate-test',
  GIT_AUTHOR_EMAIL: 'gate-test@example.com',
  GIT_COMMITTER_NAME: 'gate-test',
  GIT_COMMITTER_EMAIL: 'gate-test@example.com',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: GIT_ENV }).trim();
}

type Fx = { base: string; seed: string; install: string; state: string; tmp: string; mark: string };

const made: string[] = [];
afterAll(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

function write(root: string, rel: string, body: string, mode = 0o644) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body, { mode });
}

/**
 * origin (bare) <- seed (where upstream commits are made) -> install (the
 * registered checkout). The install carries the real helper and checker, so
 * the /gstack-upgrade block can call them by $INSTALL_DIR the way it does on
 * a real machine. A real-path base keeps /var vs /private/var spellings out
 * of every comparison.
 */
function makeFixture(): Fx {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-gate-incoming-test-')));
  made.push(base);
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const install = path.join(base, 'install');
  const state = path.join(base, 'state');
  const tmp = path.join(base, 'tmp');
  fs.mkdirSync(state);
  fs.mkdirSync(tmp);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: GIT_ENV, timeout: 30_000 });
  write(seed, 'VERSION', '1.0.0\n');
  write(seed, 'SKILL.md', '# top\nname: qa\nbody line\n');
  write(seed, 'bin/gstack-config',
    '#!/usr/bin/env bash\nif [ "$1" = "get" ]; then case "$2" in auto_upgrade) echo true;; skill_prefix) echo false;; *) echo "";; esac; fi\nexit 0\n',
    0o755);
  write(seed, 'bin/gstack-patch-names', '#!/usr/bin/env bash\nexit 0\n', 0o755);
  write(seed, 'bin/gstack-gate-incoming', fs.readFileSync(HELPER, 'utf-8'), 0o755);
  write(seed, 'scripts/hook-syntax.sh', fs.readFileSync(CHECKER, 'utf-8'), 0o755);
  write(seed, 'setup', '#!/bin/sh\necho ran >> "${SETUP_MARK:-/dev/null}"\n', 0o755);
  write(seed, HOOK, GOOD_HOOK, 0o755);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, install], { env: GIT_ENV, timeout: 30_000 });
  return { base, seed, install, state, tmp, mark: path.join(base, 'setup-ran') };
}

/** Commit files (null deletes) upstream and push; returns the new sha. */
function advance(fx: Fx, files: Record<string, string | null>, msg = 'upstream change'): string {
  for (const [rel, body] of Object.entries(files)) {
    if (body === null) fs.rmSync(path.join(fx.seed, rel), { force: true });
    else write(fx.seed, rel, body, 0o755);
  }
  git(fx.seed, 'add', '-A');
  git(fx.seed, 'commit', '-q', '-m', msg);
  git(fx.seed, 'push', '-q', 'origin', 'main');
  return git(fx.seed, 'rev-parse', 'HEAD');
}

function head(fx: Fx): string {
  return git(fx.install, 'rev-parse', 'HEAD');
}

/** Worktrees registered on the install, and scratch dirs left in TMPDIR. */
function leftovers(fx: Fx) {
  const worktrees = git(fx.install, 'worktree', 'list', '--porcelain')
    .split('\n').filter((l) => l.startsWith('worktree ')).length;
  const scratch = fs.readdirSync(fx.tmp).filter((n) => n.startsWith('gstack-gate-incoming.'));
  return { worktrees, scratch };
}

function runHelper(fx: Fx, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(HELPER, args, {
    encoding: 'utf8',
    env: { ...GIT_ENV, TMPDIR: fx.tmp, ...env },
    timeout: SPAWN_TIMEOUT_MS,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('gstack-gate-incoming: gate only', () => {
  test('a clean incoming commit passes, judged by the incoming checker, and leaves nothing behind', () => {
    const fx = makeFixture();
    const sha = advance(fx, { VERSION: '1.1.0\n' });
    git(fx.install, 'fetch', '-q');
    const before = head(fx);
    const r = runHelper(fx, [fx.install, 'origin/main']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^HOOK_GATE clean ${sha}: hook-syntax: [1-9][0-9]* checked`));
    expect(r.stdout).toContain('(incoming checker)');
    // Gate only: the checkout does not move.
    expect(head(fx)).toBe(before);
    expect(leftovers(fx)).toEqual({ worktrees: 1, scratch: [] });
  }, TEST_TIMEOUT_MS);

  test('a broken incoming hook is blocked, named, and leaves nothing behind', () => {
    const fx = makeFixture();
    const sha = advance(fx, { [HOOK]: BROKEN_HOOK });
    git(fx.install, 'fetch', '-q');
    const r = runHelper(fx, [fx.install, 'origin/main']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain(`HOOK_GATE blocked ${sha}`);
    expect(r.stderr).toContain('demo-hook');
    expect(leftovers(fx)).toEqual({ worktrees: 1, scratch: [] });
  }, TEST_TIMEOUT_MS);

  test('a tree without the checker is judged by the installed one, not waved through', () => {
    const fx = makeFixture();
    advance(fx, { 'scripts/hook-syntax.sh': null, [HOOK]: BROKEN_HOOK });
    git(fx.install, 'fetch', '-q');
    const r = runHelper(fx, [fx.install, 'origin/main']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('demo-hook');

    const clean = makeFixture();
    advance(clean, { 'scripts/hook-syntax.sh': null });
    git(clean.install, 'fetch', '-q');
    const ok = runHelper(clean, [clean.install, 'origin/main']);
    expect(ok.code, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('(installed checker)');
  }, TEST_TIMEOUT_MS);

  test('a checker that exits neither 0 nor 1 is no verdict, never a pass', () => {
    const fx = makeFixture();
    advance(fx, { 'scripts/hook-syntax.sh': '#!/bin/bash\nexit 3\n' });
    git(fx.install, 'fetch', '-q');
    const r = runHelper(fx, [fx.install, 'origin/main']);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('HOOK_GATE no-verdict');
    expect(r.stdout).toContain('exited 3');
    expect(leftovers(fx)).toEqual({ worktrees: 1, scratch: [] });
  }, TEST_TIMEOUT_MS);

  test('a checker that hangs is stopped at the timeout, grandchildren included, and is no verdict', async () => {
    const fx = makeFixture();
    // The hang is a grandchild of the checker: killing only the checker's
    // direct children would leave it running.
    advance(fx, {
      'scripts/hook-syntax.sh': '#!/bin/bash\nbash -c \'sleep 60 & echo $! > "$HANG_PIDFILE"; wait\'\n',
    });
    git(fx.install, 'fetch', '-q');
    const pidFile = path.join(fx.base, 'hang.pid');
    const started = Date.now();
    const r = runHelper(fx, [fx.install, 'origin/main'], { GSTACK_HOOK_GATE_TIMEOUT: '2', HANG_PIDFILE: pidFile });
    const sleeper = Number(fs.readFileSync(pidFile, 'utf8').trim());
    try {
      expect(r.code).toBe(2);
      expect(r.stdout).toContain('ran past 2s');
      expect(Date.now() - started).toBeLessThan(45_000);
      expect(leftovers(fx)).toEqual({ worktrees: 1, scratch: [] });
      expect(sleeper).toBeGreaterThan(0);
      let alive = true;
      for (let i = 0; i < 20 && alive; i++) {
        try { process.kill(sleeper, 0); await new Promise((res) => setTimeout(res, 100)); } catch { alive = false; }
      }
      expect(alive).toBe(false);
    } finally {
      try { process.kill(sleeper, 'SIGKILL'); } catch { /* already gone */ }
    }
  }, TEST_TIMEOUT_MS);

  test('a revision that names no commit is no verdict', () => {
    const fx = makeFixture();
    const r = runHelper(fx, [fx.install, 'no-such-ref']);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('does not name a commit');
  }, TEST_TIMEOUT_MS);

  test("the install's own git hooks do not run against the throwaway checkout", () => {
    const fx = makeFixture();
    advance(fx, { VERSION: '1.1.0\n' });
    git(fx.install, 'fetch', '-q');
    const fired = path.join(fx.base, 'post-checkout-fired');
    write(fx.install, '.git/hooks/post-checkout', `#!/bin/sh\ntouch "${fired}"\n`, 0o755);
    const r = runHelper(fx, [fx.install, 'origin/main']);
    expect(r.code, r.stderr).toBe(0);
    expect(fs.existsSync(fired)).toBe(false);
  }, TEST_TIMEOUT_MS);
});

describe('gstack-gate-incoming --fast-forward', () => {
  test('a clean incoming commit is fast-forwarded to', () => {
    const fx = makeFixture();
    const before = head(fx);
    const sha = advance(fx, { VERSION: '1.1.0\n' });
    git(fx.install, 'fetch', '-q');
    const r = runHelper(fx, ['--fast-forward', fx.install, 'origin/main']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(`FF moved ${before}..${sha}`);
    expect(head(fx)).toBe(sha);
  }, TEST_TIMEOUT_MS);

  test('a broken incoming hook leaves the checkout, and its local edits, where they were', () => {
    const fx = makeFixture();
    const before = head(fx);
    advance(fx, { [HOOK]: BROKEN_HOOK });
    git(fx.install, 'fetch', '-q');
    fs.appendFileSync(path.join(fx.install, 'SKILL.md'), 'local edit\n');
    const r = runHelper(fx, ['--fast-forward', fx.install, 'origin/main']);
    expect(r.code).toBe(1);
    expect(head(fx)).toBe(before);
    expect(fs.readFileSync(path.join(fx.install, HOOK), 'utf8')).toBe(GOOD_HOOK);
    expect(fs.readFileSync(path.join(fx.install, 'SKILL.md'), 'utf8')).toContain('local edit');
    expect(git(fx.install, 'stash', 'list')).toBe('');
  }, TEST_TIMEOUT_MS);

  test('nothing to take: no gate run, no move', () => {
    const fx = makeFixture();
    const r = runHelper(fx, ['--fast-forward', fx.install, 'origin/main']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('FF current');
    expect(r.stdout).not.toContain('HOOK_GATE');
  }, TEST_TIMEOUT_MS);

  test('a diverged checkout is refused before the gate runs', () => {
    const fx = makeFixture();
    write(fx.install, 'local.txt', 'mine\n');
    git(fx.install, 'add', 'local.txt');
    git(fx.install, 'commit', '-q', '-m', 'local commit');
    const before = head(fx);
    advance(fx, { VERSION: '1.1.0\n' });
    git(fx.install, 'fetch', '-q');
    const r = runHelper(fx, ['--fast-forward', fx.install, 'origin/main']);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('not a fast-forward');
    expect(r.stdout).not.toContain('HOOK_GATE');
    expect(head(fx)).toBe(before);
  }, TEST_TIMEOUT_MS);

  test('a merge in progress is refused and left exactly as it was', () => {
    const fx = makeFixture();
    advance(fx, { VERSION: '1.1.0\n' });
    git(fx.install, 'fetch', '-q');
    // Unmerged index entries, the state a conflicted merge leaves behind.
    const blob = git(fx.install, 'hash-object', '-w', 'VERSION');
    git(fx.install, 'update-index', '--force-remove', 'VERSION');
    execFileSync('git', ['update-index', '--index-info'], {
      cwd: fx.install,
      env: GIT_ENV,
      timeout: 30_000,
      input: [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\tVERSION\n`).join(''),
    });
    const unmerged = git(fx.install, 'ls-files', '-u');
    const r = runHelper(fx, ['--fast-forward', fx.install, 'origin/main']);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain('unmerged files');
    // Refused up front, not after a gate run and a merge attempt.
    expect(r.stdout).not.toContain('HOOK_GATE');
    expect(git(fx.install, 'ls-files', '-u')).toBe(unmerged);
  }, TEST_TIMEOUT_MS);

  test('an autostash pop that conflicts is reset to the gated commit, and the stash is kept', () => {
    const fx = makeFixture();
    const sha = advance(fx, { 'SKILL.md': '# top v2\nname: qa\nbody line\n' });
    git(fx.install, 'fetch', '-q');
    write(fx.install, 'SKILL.md', '# top LOCAL\nname: qa\nbody line\n');
    const r = runHelper(fx, ['--fast-forward', fx.install, 'origin/main']);
    expect(r.code, r.stderr).toBe(0);
    expect(head(fx)).toBe(sha);
    const skill = fs.readFileSync(path.join(fx.install, 'SKILL.md'), 'utf8');
    expect(skill).not.toContain(LT);
    expect(skill).toBe('# top v2\nname: qa\nbody line\n');
    expect(git(fx.install, 'ls-files', '-u')).toBe('');
    const kept = r.stdout.match(/^AUTOSTASH_KEPT ([0-9a-f]{40}):/m);
    expect(kept).not.toBeNull();
    expect(git(fx.install, 'stash', 'show', '-p', kept![1])).toContain('# top LOCAL');
  }, TEST_TIMEOUT_MS);

  test('the move names the gated commit, not a ref that changed while the gate ran', () => {
    const fx = makeFixture();
    // A: the commit to gate. Its checker moves origin/main mid-gate to B, a
    // descendant with a broken hook, and passes.
    const gated = advance(fx, {
      'scripts/hook-syntax.sh': '#!/bin/bash\ngit -C "$RACE_REPO" update-ref refs/remotes/origin/main "$RACE_TO"\nexit 0\n',
    });
    const broken = advance(fx, { [HOOK]: BROKEN_HOOK });
    git(fx.install, 'fetch', '-q');
    git(fx.install, 'update-ref', 'refs/remotes/origin/main', gated);
    const r = runHelper(fx, ['--fast-forward', fx.install, 'origin/main'], { RACE_REPO: fx.install, RACE_TO: broken });
    expect(r.code, r.stderr).toBe(0);
    // The race happened: the ref the caller named now points at B.
    expect(git(fx.install, 'rev-parse', 'refs/remotes/origin/main')).toBe(broken);
    expect(head(fx)).toBe(gated);
    expect(fs.readFileSync(path.join(fx.install, HOOK), 'utf8')).toBe(GOOD_HOOK);
  }, TEST_TIMEOUT_MS);
});

// ── bin/gstack-session-update ───────────────────────────────────────────────

function runSessionUpdate(fx: Fx, env: Record<string, string> = {}) {
  return spawnSync('bash', [SESSION_UPDATE], {
    encoding: 'utf8',
    env: { ...GIT_ENV, GSTACK_DIR: fx.install, GSTACK_STATE_DIR: fx.state, TMPDIR: fx.tmp, SETUP_MARK: fx.mark, ...env },
    timeout: 30_000,
  });
}

// The update forks into the background; its log is the only output.
const DONE = /UPDATED from=|UP_TO_DATE|PULL_FAILED|HOOK_SYNTAX_BLOCKED|HOOK_GATE_INCONCLUSIVE/;
async function waitForLog(fx: Fx, ms = 120_000): Promise<string> {
  const logFile = path.join(fx.state, 'analytics', 'session-update.log');
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const content = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    if (DONE.test(content)) return content;
    await new Promise((r) => setTimeout(r, 200));
  }
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
}

describe('gstack-session-update gates the incoming tree before it moves the checkout', () => {
  test('an incoming commit with a broken hook leaves the checkout on OLD_HEAD and logs why', async () => {
    const fx = makeFixture();
    const before = head(fx);
    const sha = advance(fx, { [HOOK]: BROKEN_HOOK });
    expect(runSessionUpdate(fx).status).toBe(0);
    const log = await waitForLog(fx);
    const line = log.split('\n').find((l) => l.includes('HOOK_SYNTAX_BLOCKED')) ?? '';
    expect(line, log).toContain(`head=${before}`);
    expect(line).toContain(`incoming=${sha}`);
    expect(line).toContain('demo-hook');
    expect(log).not.toContain('UPDATING');
    expect(head(fx)).toBe(before);
    expect(fs.readFileSync(path.join(fx.install, HOOK), 'utf8')).toBe(GOOD_HOOK);
    expect(fs.existsSync(fx.mark)).toBe(false);
    expect(leftovers(fx)).toEqual({ worktrees: 1, scratch: [] });
  }, TEST_TIMEOUT_MS);

  test('a clean incoming commit is fast-forwarded to and set up', async () => {
    const fx = makeFixture();
    const sha = advance(fx, { VERSION: '1.1.0\n' });
    expect(runSessionUpdate(fx).status).toBe(0);
    const log = await waitForLog(fx);
    expect(log).toContain(`HOOK_GATE_PASSED incoming=${sha}`);
    expect(log).toContain('UPDATED from=1.0.0 to=1.1.0');
    expect(log).not.toContain('SETUP_FAILED');
    expect(head(fx)).toBe(sha);
    expect(fs.readFileSync(fx.mark, 'utf8')).toBe('ran\n');
  }, TEST_TIMEOUT_MS);

  test('a gate with no verdict holds the checkout and logs it as inconclusive', async () => {
    const fx = makeFixture();
    const before = head(fx);
    advance(fx, { 'scripts/hook-syntax.sh': '#!/bin/bash\nexit 3\n' });
    expect(runSessionUpdate(fx).status).toBe(0);
    const log = await waitForLog(fx);
    expect(log).toMatch(/HOOK_GATE_INCONCLUSIVE head=\S+ incoming=\S+ exit=2 /);
    expect(log).not.toContain('UPDATING');
    expect(head(fx)).toBe(before);
  }, TEST_TIMEOUT_MS);

  test('a conflicting autostash pop leaves no conflict markers live, keeps the stash, and still sets up', async () => {
    const fx = makeFixture();
    const sha = advance(fx, { 'SKILL.md': '# top v2\nname: qa\nbody line\n' });
    write(fx.install, 'SKILL.md', '# top LOCAL\nname: qa\nbody line\n');
    expect(runSessionUpdate(fx).status).toBe(0);
    const log = await waitForLog(fx);
    expect(log).toMatch(/AUTOSTASH_CONFLICT_RECOVERED tree_reset=1 kept_stash=[0-9a-f]{40}/);
    expect(log).toContain('UPDATED from=');
    expect(head(fx)).toBe(sha);
    expect(fs.readFileSync(path.join(fx.install, 'SKILL.md'), 'utf8')).not.toContain(LT);
    expect(git(fx.install, 'stash', 'list')).toContain('autostash');
    expect(fs.readFileSync(fx.mark, 'utf8')).toBe('ran\n');
  }, TEST_TIMEOUT_MS);
});

// ── /gstack-upgrade Step 4, run as a real shell against real git ────────────

function blockAfter(marker: string): string {
  const at = TEMPLATE.indexOf(marker);
  if (at < 0) throw new Error(`marker not in gstack-upgrade/SKILL.md.tmpl: ${marker}`);
  return TEMPLATE.slice(at).match(/```bash\n([\s\S]*?)\n```/)![1].replaceAll('{{SETUP_COMMAND}}', './setup');
}

function runBlock(fx: Fx, marker: string) {
  const r = spawnSync('bash', ['-c', blockAfter(marker)], {
    cwd: fx.base,
    encoding: 'utf8',
    env: { ...GIT_ENV, INSTALL_DIR: fx.install, TMPDIR: fx.tmp, SETUP_MARK: fx.mark },
    timeout: SPAWN_TIMEOUT_MS,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('/gstack-upgrade Step 4 gates origin/main before the install moves', () => {
  test('a broken hook on origin/main is refused; the install and setup are untouched', () => {
    const fx = makeFixture();
    const before = head(fx);
    advance(fx, { [HOOK]: BROKEN_HOOK });
    const r = runBlock(fx, '**For git installs**');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('HOOK_GATE_REFUSED');
    expect(r.stdout).toContain('HOOK_GATE blocked');
    expect(r.stdout).not.toContain('FF_REFUSED');
    expect(head(fx)).toBe(before);
    expect(fs.existsSync(fx.mark)).toBe(false);
  }, TEST_TIMEOUT_MS);

  test('a clean origin/main is fast-forwarded to and set up', () => {
    const fx = makeFixture();
    const sha = advance(fx, { VERSION: '1.1.0\n' });
    const r = runBlock(fx, '**For git installs**');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('FF_OK');
    expect(head(fx)).toBe(sha);
    expect(fs.readFileSync(fx.mark, 'utf8')).toBe('ran\n');
  }, TEST_TIMEOUT_MS);

  test('a diverged install routes to the fallback, whose re-gate refuses a broken origin/main before any reset', () => {
    const fx = makeFixture();
    write(fx.install, 'local.txt', 'mine\n');
    git(fx.install, 'add', 'local.txt');
    git(fx.install, 'commit', '-q', '-m', 'local commit');
    const before = head(fx);
    advance(fx, { [HOOK]: BROKEN_HOOK });
    const main = runBlock(fx, '**For git installs**');
    expect(main.stdout).toContain('FF_REFUSED');
    expect(main.stdout).toContain('not a fast-forward');
    const fallback = runBlock(fx, 'The block re-gates `origin/main`');
    expect(fallback.code).toBe(1);
    expect(fallback.stderr).toContain('HOOK_GATE_REFUSED');
    expect(head(fx)).toBe(before);
    expect(git(fx.install, 'stash', 'list')).toBe('');
    expect(fs.existsSync(fx.mark)).toBe(false);
  }, TEST_TIMEOUT_MS);
});
