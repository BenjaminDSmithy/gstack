import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';

const template = readFileSync(join(import.meta.dir, '../gstack-upgrade/SKILL.md.tmpl'), 'utf8');
const blockAfter = (marker: string) => {
  const section = template.slice(template.indexOf(marker));
  return section.match(/```bash\n([\s\S]*?)\n```/)![1].replaceAll('{{SETUP_COMMAND}}', './setup');
};

describe.skipIf(process.platform === 'win32')('upgrade setup recovery (real shell)', () => {
  for (const mode of ['vendored', 'local'] as const) {
    for (const setupExit of [0, 1]) {
      test(`${mode}: setup exit ${setupExit} ${setupExit ? 'restores old install' : 'removes backup only after success'}`, () => {
        const root = mkdtempSync(join(tmpdir(), 'upgrade-recovery-'));
        const target = join(root, 'target');
        const source = join(root, 'source');
        const bin = join(root, 'bin');
        try {
          for (const dir of [target, source, bin, join(target, 'bin'), join(source, 'bin')]) mkdirSync(dir);
          writeFileSync(join(target, 'VERSION'), 'old');
          writeFileSync(join(source, 'VERSION'), 'new');
          // C9: fences only touch a directory that looks like a gstack install.
          for (const dir of [target, source]) writeFileSync(join(dir, 'bin', 'gstack-config'), '#!/bin/sh\n', { mode: 0o755 });
          writeFileSync(join(target, 'setup'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
          writeFileSync(join(source, 'setup'), '#!/bin/sh\nexit "$SETUP_EXIT"\n', { mode: 0o755 });
          writeFileSync(join(bin, 'git'), '#!/bin/sh\nfor last; do :; done\ncp -R "$UPGRADE_FIXTURE" "$last"\n', { mode: 0o755 });
          const script = blockAfter(mode === 'vendored'
            ? '**For vendored installs**'
            : '**If `LOCAL_GSTACK` is non-empty AND `TEAM_MODE` is NOT `true`:**');
          const result = spawnSync('bash', ['-c', script], {
            cwd: root, encoding: 'utf8', timeout: 10_000,
            env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, INSTALL_DIR: mode === 'vendored' ? target : source,
              LOCAL_GSTACK: target, UPGRADE_FIXTURE: source, SETUP_EXIT: String(setupExit) },
          });
          expect(result.status, result.stderr).toBe(setupExit);
          expect(readFileSync(join(target, 'VERSION'), 'utf8')).toBe(setupExit ? 'old' : 'new');
          expect(existsSync(`${target}.bak`)).toBe(false);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }

  test('git setup failure is not routed into the divergence reset fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'upgrade-git-setup-'));
    try {
      const bin = join(root, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'git'), '#!/bin/sh\nif [ "$1 $2" = "rev-parse --show-toplevel" ]; then pwd -P; elif [ "$1" = rev-parse ]; then echo old-commit; fi\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(root, 'setup'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      // C9: the git fence verifies it is inside gstack's own checkout first.
      writeFileSync(join(root, 'VERSION'), '1.0.0.0\n');
      writeFileSync(join(root, 'bin', 'gstack-config'), '#!/bin/sh\n', { mode: 0o755 });
      const result = spawnSync('bash', ['-c', blockAfter('**For git installs**')], {
        cwd: root, encoding: 'utf8', timeout: 10_000,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, INSTALL_DIR: root },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('SETUP_FAILED');
      expect(result.stdout).not.toContain('FF_REFUSED');
      expect(result.stdout).not.toContain('FF_OK');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// /gstack-upgrade checks the incoming release's Bun floor before pulling, with
// the auto-updater's helper: below it the checkout and installs stay untouched.
describe.skipIf(process.platform === 'win32')('upgrade Bun floor (real git)', () => {
  const git = (cwd: string, ...args: string[]) =>
    spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 }).stdout.trim();

  function fixture(floor: string, bunVersion: string) {
    const root = mkdtempSync(join(tmpdir(), 'upgrade-bun-floor-'));
    const origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    const install = join(root, 'install');
    const stub = join(root, 'stub');
    for (const dir of [join(seed, 'bin'), stub]) mkdirSync(dir, { recursive: true });
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 30_000 });
    const helper = readFileSync(join(import.meta.dir, '../bin/gstack-bun-version.sh'), 'utf8');
    writeFileSync(join(seed, 'bin', 'gstack-bun-version.sh'), helper);
    writeFileSync(join(seed, 'bin', 'gstack-config'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(seed, 'VERSION'), '1.0.0\n');
    writeFileSync(join(seed, 'setup'), '#!/bin/sh\necho ran >> "$SETUP_LOG"\n', { mode: 0o755 });
    git(seed, 'init', '-q', '-b', 'main');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'seed');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'main');
    spawnSync('git', ['clone', '-q', origin, install], { timeout: 30_000 });
    writeFileSync(join(seed, 'bin', 'gstack-bun-version.sh'),
      helper.replace(/^GSTACK_BUN_FLOOR="[^"]*"/m, `GSTACK_BUN_FLOOR="${floor}"`));
    writeFileSync(join(seed, 'VERSION'), '1.1.0\n');
    git(seed, 'commit', '-aqm', 'release 1.1.0');
    git(seed, 'push', '-q', 'origin', 'main');
    writeFileSync(join(stub, 'bun'), `#!/bin/sh\necho ${bunVersion}\n`, { mode: 0o755 });
    const before = git(install, 'rev-parse', 'HEAD');
    const result = spawnSync('bash', ['-c', blockAfter('**For git installs**')], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, PATH: `${stub}:${process.env.PATH}`, INSTALL_DIR: install, SETUP_LOG: join(root, 'setup.log') },
    });
    return { root, install, stub, before, result, after: git(install, 'rev-parse', 'HEAD'),
      setupRan: existsSync(join(root, 'setup.log')), version: readFileSync(join(install, 'VERSION'), 'utf8') };
  }

  test('below the incoming floor: stops before the pull with the held reason', () => {
    const fx = fixture('9.0.0', '1.4.0');
    try {
      expect(fx.result.status).toBe(1);
      expect(fx.result.stderr).toContain(
        `BUN_TOO_OLD: bun-too-old: found Bun 1.4.0 at ${join(fx.stub, 'bun')}; gstack 1.1.0 needs 9.0.0 or newer; nothing was changed`);
      expect(fx.result.stdout).not.toContain('FF_OK');
      expect(fx.after).toBe(fx.before);
      expect(fx.version).toBe('1.0.0\n');
      expect(fx.setupRan).toBe(false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test('at or above the incoming floor: the fast-forward and setup run', () => {
    const fx = fixture('1.3.3', '1.4.0');
    try {
      expect(fx.result.status, fx.result.stderr).toBe(0);
      expect(fx.result.stdout).toContain('FF_OK');
      expect(fx.after).not.toBe(fx.before);
      expect(fx.version).toBe('1.1.0\n');
      expect(fx.setupRan).toBe(true);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

// /gstack-upgrade runs the auto-updater's hook check on the exact origin/main
// commit it moves to, before the fast-forward and before the reset fallback,
// and judges an autostash pop by its unmerged files, not by git's exit code.
describe.skipIf(process.platform === 'win32')('upgrade hook check and autostash (real git)', () => {
  const ROOT = join(import.meta.dir, '..');
  const HOOK = 'hosts/claude/hooks/question-log-hook';
  const PATH_WITH_BUN = `${dirname(process.execPath)}:${process.env.PATH}`;
  const TIMEOUT_MS = 60_000;
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };

  function fixture(opts: { installHasChecker?: boolean } = {}) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'upgrade-hook-check-')));
    const origin = join(root, 'origin.git');
    const seed = join(root, 'seed');
    const install = join(root, 'install');
    const tmp = join(root, 'tmp');
    for (const dir of [join(seed, 'bin'), join(seed, dirname(HOOK)), tmp]) mkdirSync(dir, { recursive: true });
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 30_000 });
    writeFileSync(join(seed, 'bin', 'gstack-config'), '#!/bin/sh\n', { mode: 0o755 });
    if (opts.installHasChecker !== false) {
      writeFileSync(join(seed, 'bin', 'gstack-hook-check'), readFileSync(join(ROOT, 'bin', 'gstack-hook-check'), 'utf8'), { mode: 0o755 });
    }
    writeFileSync(join(seed, 'VERSION'), '1.0.0\n');
    writeFileSync(join(seed, 'notes.txt'), 'top\nmiddle\nbottom\n');
    // Stub setup: records its run and registers the hook the way real setup
    // does, which is where the check reads the hook list from.
    writeFileSync(join(seed, 'setup'), `#!/bin/sh\necho ran >> "$SETUP_LOG"\nLOG_HOOK="$(_hook_command_path ${HOOK} || true)"\n`, { mode: 0o755 });
    writeFileSync(join(seed, HOOK), readFileSync(join(ROOT, HOOK), 'utf8'), { mode: 0o755 });
    writeFileSync(join(seed, `${HOOK}.ts`), "console.log('hook ran');\n");
    git(seed, 'init', '-q', '-b', 'main');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'seed');
    git(seed, 'remote', 'add', 'origin', origin);
    git(seed, 'push', '-q', 'origin', 'main');
    spawnSync('git', ['clone', '-q', origin, install], { timeout: 30_000 });
    if (opts.installHasChecker === false) {
      writeFileSync(join(seed, 'bin', 'gstack-hook-check'), readFileSync(join(ROOT, 'bin', 'gstack-hook-check'), 'utf8'), { mode: 0o755 });
    }
    return { root, seed, install, tmp, setupLog: join(root, 'setup.log') };
  }
  type Fx = ReturnType<typeof fixture>;

  function release(fx: Fx, files: Record<string, string>): string {
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(fx.seed, rel), body);
    git(fx.seed, 'add', '-A');
    git(fx.seed, 'commit', '-qm', 'release');
    git(fx.seed, 'push', '-q', 'origin', 'main');
    return git(fx.seed, 'rev-parse', 'HEAD');
  }

  function run(fx: Fx, marker = '**For git installs**') {
    return spawnSync('bash', ['-c', blockAfter(marker)], {
      cwd: fx.root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, PATH: PATH_WITH_BUN, INSTALL_DIR: fx.install, SETUP_LOG: fx.setupLog, TMPDIR: fx.tmp },
    });
  }
  const leftovers = (fx: Fx) => readdirSync(fx.tmp);
  const brokenHook = (fx: Fx) => ({ [HOOK]: `${readFileSync(join(fx.seed, HOOK), 'utf8')}if then\n` });

  test('an incoming hook that does not parse stops before the fast-forward', () => {
    const fx = fixture();
    try {
      const before = git(fx.install, 'rev-parse', 'HEAD');
      release(fx, { ...brokenHook(fx), VERSION: '1.1.0\n' });
      const r = run(fx);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(new RegExp(`HOOK_DOES_NOT_PARSE: ${HOOK}:\\d+: .*; nothing was changed`));
      expect(r.stdout).not.toContain('FF_OK');
      expect(r.stdout).not.toContain('FF_REFUSED');
      expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(before);
      expect(existsSync(fx.setupLog)).toBe(false);
      expect(leftovers(fx)).toEqual([]);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  test("an install that predates the checker uses origin/main's copy", () => {
    const fx = fixture({ installHasChecker: false });
    try {
      expect(existsSync(join(fx.install, 'bin', 'gstack-hook-check'))).toBe(false);
      const before = git(fx.install, 'rev-parse', 'HEAD');
      release(fx, { ...brokenHook(fx), VERSION: '1.1.0\n' });
      const r = run(fx);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`HOOK_DOES_NOT_PARSE: ${HOOK}:`);
      expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(before);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  test('a parseable incoming revision fast-forwards to the checked commit and sets up (control)', () => {
    const fx = fixture();
    try {
      const incoming = release(fx, { VERSION: '1.1.0\n' });
      const r = run(fx);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('FF_OK');
      expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(incoming);
      expect(existsSync(fx.setupLog)).toBe(true);
      expect(leftovers(fx)).toEqual([]);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  test('a conflicting autostash leaves no markers, keeps the edits, and sets up', () => {
    const fx = fixture();
    try {
      writeFileSync(join(fx.install, 'notes.txt'), 'top LOCAL\nmiddle\nbottom\n');
      const incoming = release(fx, { 'notes.txt': 'top UPSTREAM\nmiddle\nbottom\n', VERSION: '1.1.0\n' });
      const r = run(fx);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('FF_OK');
      expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(incoming);
      expect(git(fx.install, 'ls-files', '-u')).toBe('');
      expect(readFileSync(join(fx.install, 'notes.txt'), 'utf8')).toBe('top UPSTREAM\nmiddle\nbottom\n');
      const kept = r.stdout.match(/AUTOSTASH_KEPT ([0-9a-f]{40})/);
      expect(kept, r.stdout).not.toBeNull();
      expect(git(fx.install, 'stash', 'show', '-p', kept![1])).toContain('+top LOCAL');
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  test('files left unmerged before the upgrade stop it with nothing changed', () => {
    const fx = fixture();
    try {
      const before = git(fx.install, 'rev-parse', 'HEAD');
      const blob = (body: string) => spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: fx.install, input: body, encoding: 'utf8', timeout: 30_000 }).stdout.trim();
      const stages = [blob('top\n'), blob('top OURS\n'), blob('top THEIRS\n')];
      git(fx.install, 'update-index', '--force-remove', 'notes.txt');
      spawnSync('git', ['update-index', '--index-info'], {
        cwd: fx.install, timeout: 30_000,
        input: stages.map((sha, i) => `100644 ${sha} ${i + 1}\tnotes.txt\n`).join(''),
      });
      release(fx, { VERSION: '1.1.0\n' });
      const r = run(fx);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('UNMERGED_FILES');
      expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(before);
      expect(git(fx.install, 'ls-files', '-u').split('\n')).toHaveLength(3);
      expect(existsSync(fx.setupLog)).toBe(false);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

  test('the reset fallback resets only to the commit the fast-forward step checked', () => {
    const fx = fixture();
    try {
      writeFileSync(join(fx.install, 'local.txt'), 'mine\n');
      git(fx.install, 'add', 'local.txt');
      git(fx.install, 'commit', '-qm', 'local commit');
      const before = git(fx.install, 'rev-parse', 'HEAD');
      const checked = release(fx, { VERSION: '1.1.0\n' });
      const ff = run(fx);
      expect(ff.stdout).toContain(`FF_REFUSED ${checked}`);
      const fallback = (incoming?: string) => spawnSync('bash', ['-c', blockAfter('**Fallback (ff-only refused')], {
        cwd: fx.root, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, PATH: PATH_WITH_BUN, INSTALL_DIR: fx.install, SETUP_LOG: fx.setupLog, TMPDIR: fx.tmp, ...(incoming ? { INCOMING: incoming } : {}) },
      });
      writeFileSync(join(fx.install, 'notes.txt'), 'dirty\n');
      const untouched = () => {
        expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(before);
        expect(git(fx.install, 'stash', 'list')).toBe('');
        expect(readFileSync(join(fx.install, 'notes.txt'), 'utf8')).toBe('dirty\n');
      };
      // Without the checked commit named, nothing is stashed or reset.
      expect(fallback().status).not.toBe(0);
      untouched();
      // origin/main moved on to a commit nothing checked: the same refusal.
      release(fx, { ...brokenHook(fx), VERSION: '1.2.0\n' });
      git(fx.install, 'fetch', '-q', 'origin');
      const stale = fallback(checked);
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain('ORIGIN_MOVED');
      untouched();
      // Back on the checked commit, the reset runs to it.
      git(fx.seed, 'push', '-q', '-f', 'origin', `${checked}:refs/heads/main`);
      git(fx.install, 'fetch', '-q', 'origin');
      const r = fallback(checked);
      expect(r.status, r.stderr).toBe(0);
      expect(git(fx.install, 'rev-parse', 'HEAD')).toBe(checked);
      expect(existsSync(fx.setupLog)).toBe(true);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
