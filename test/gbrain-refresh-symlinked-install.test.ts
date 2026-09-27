/**
 * `gstack-config gbrain-refresh` against a symlinked install, driven for real.
 *
 * A fork install keeps its durable clone under ~/src and links
 * ~/.claude/skills/gstack to it. The installed skills serve the :user render
 * in ${GSTACK_HOME}/render/claude, not the checkout, so a landing on that
 * clone is not live until the render is rebuilt. gbrain-refresh used to refuse
 * every symlinked install as "likely a dev worktree", which left no supported
 * way to rebuild it short of a full ./setup. It now renders from a symlinked
 * install that resolves to the root of a git checkout's MAIN worktree, still
 * refuses a linked worktree or a symlink to anything else, and proves the
 * swap left no installed gstack skill link dangling.
 *
 * Hermetic: temp HOME, GSTACK_HOME and GSTACK_USER_RENDER_DIR; a stub gbrain
 * detector; a fake install whose `gen:skill-docs:user` script writes a tiny
 * render, and whose gstack-relink links every rendered skill into the temp
 * skills dir.
 */
import { describe, test as _bunTest, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Each case spawns gstack-config, bun, git and a relink stub. That is ~1s on
// an idle box and measured 6s at load ~150, past bun's 5s default.
const test = Object.assign(
  ((name: any, fn: any, timeout?: number) => _bunTest(name, fn, timeout ?? 60_000)) as typeof _bunTest,
  _bunTest,
);

const ROOT = path.resolve(import.meta.dir, '..');

let tmp: string;
let home: string;
let gstackHome: string;
let renderDir: string;
let skillsDir: string;
let configBin: string;
let gitEnv: NodeJS.ProcessEnv;

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode === undefined ? undefined : { mode });
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf-8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A fake gstack clone. Its render script copies `.render-marker` into
 * <out>/alpha/SKILL.md (plus a section), or fails part-way when `.render-fail`
 * exists. Its relink links every rendered skill into the skills dir.
 */
function makeInstall(dir: string, marker: string): string {
  write(path.join(dir, 'VERSION'), '9.9.9.0\n');
  write(path.join(dir, 'package.json'), JSON.stringify({
    name: 'fake-gstack', private: true, scripts: { 'gen:skill-docs:user': 'bash fake-render.sh' },
  }));
  write(path.join(dir, '.render-marker'), `${marker}\n`);
  write(path.join(dir, 'fake-render.sh'), [
    'out=""; while [ $# -gt 0 ]; do case "$1" in --out-dir) out="$2"; shift 2 ;; *) shift ;; esac; done',
    'mkdir -p "$out/alpha/sections"',
    'if [ -f .render-fail ]; then echo "partial" > "$out/alpha/SKILL.md"; echo "boom: broken template alpha" >&2; exit 1; fi',
    'cp .render-marker "$out/alpha/SKILL.md"',
    'echo "section" > "$out/alpha/sections/s.md"',
    '',
  ].join('\n'));
  write(path.join(dir, 'bin', 'gstack-relink'), [
    '#!/bin/bash',
    'render="${GSTACK_USER_RENDER_DIR:?}"',
    'for d in "$render"/*/; do s=$(basename "$d"); mkdir -p "$HOME/.claude/skills/$s"; ln -snf "$render/$s/SKILL.md" "$HOME/.claude/skills/$s/SKILL.md"; done',
    'echo relinked >> "$HOME/relink.log"',
    '',
  ].join('\n'), 0o755);
  git(dir, 'init', '-q', '--template=');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fake install');
  return dir;
}

function refresh(): { code: number | null; out: string; err: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: home, GSTACK_HOME: gstackHome, GSTACK_USER_RENDER_DIR: renderDir,
    GIT_CONFIG_GLOBAL: gitEnv.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const k of ['GSTACK_STATE_ROOT', 'GSTACK_STATE_DIR', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete env[k];
  const r = spawnSync(path.join(configBin, 'gstack-config'), ['gbrain-refresh'], { env, encoding: 'utf-8', timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function linkInstall(target: string): void {
  fs.symlinkSync(target, path.join(skillsDir, 'gstack'));
}

function seedPreviousRender(): void {
  write(path.join(renderDir, 'alpha', 'SKILL.md'), 'previous-render\n');
  write(path.join(renderDir, 'alpha', 'sections', 's.md'), 'previous-section\n');
}

function renderLeftovers(): string[] {
  return fs.readdirSync(path.dirname(renderDir)).filter((e) => e !== path.basename(renderDir));
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-refresh-link-')));
  home = path.join(tmp, 'home');
  gstackHome = path.join(tmp, 'gstack-home');
  renderDir = path.join(gstackHome, 'render', 'claude');
  skillsDir = path.join(home, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(path.dirname(renderDir), { recursive: true });
  const gitconfig = path.join(tmp, 'gitconfig');
  write(gitconfig, '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n');
  gitEnv = { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete gitEnv[k];
  // gstack-config resolves its detector next to itself: a stub reports a
  // healthy gbrain so the render branch runs without a real one.
  configBin = path.join(tmp, 'config-bin');
  fs.mkdirSync(configBin);
  fs.copyFileSync(path.join(ROOT, 'bin', 'gstack-config'), path.join(configBin, 'gstack-config'));
  fs.chmodSync(path.join(configBin, 'gstack-config'), 0o755);
  write(path.join(configBin, 'gstack-gbrain-detect'),
    '#!/bin/bash\necho \'{"gbrain_local_status":"ok","gbrain_version":"0.0.0-test"}\'\n', 0o755);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('gbrain-refresh: symlinked install', () => {
  test('renders from a symlink to the root of a main-worktree clone, swaps, relinks, checks links', () => {
    const install = makeInstall(path.join(tmp, 'src', 'gstack'), 'fresh-render');
    linkInstall(install);
    seedPreviousRender();

    const r = refresh();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Install is a symlink to the checkout ${install}`);
    expect(r.out).toContain('Checked 1 installed skill links: none dangling.');
    expect(fs.readFileSync(path.join(renderDir, 'alpha', 'SKILL.md'), 'utf-8')).toBe('fresh-render\n');
    // The whole tree was replaced, sections included: no SKILL.md-only refresh.
    expect(fs.readFileSync(path.join(renderDir, 'alpha', 'sections', 's.md'), 'utf-8')).toBe('section\n');
    expect(fs.readFileSync(path.join(skillsDir, 'alpha', 'SKILL.md'), 'utf-8')).toBe('fresh-render\n');
    expect(fs.readFileSync(path.join(home, 'relink.log'), 'utf-8')).toBe('relinked\n');
    expect(renderLeftovers()).toEqual([]);
    // The clone is untouched: the render never lands in the checkout.
    expect(git(install, 'status', '--porcelain')).toBe('');
  });

  test('refuses a symlink to a linked worktree and leaves the render alone', () => {
    const install = makeInstall(path.join(tmp, 'src', 'gstack'), 'fresh-render');
    const worktree = path.join(tmp, 'worktrees', 'gstack', 'feature');
    git(install, 'worktree', 'add', '-q', '--detach', worktree);
    linkInstall(worktree);
    seedPreviousRender();

    const r = refresh();
    expect(r.code).toBe(0);
    expect(r.out).toContain('is a symlink to a linked git worktree (likely a dev worktree)');
    expect(fs.readFileSync(path.join(renderDir, 'alpha', 'SKILL.md'), 'utf-8')).toBe('previous-render\n');
    expect(fs.existsSync(path.join(home, 'relink.log'))).toBe(false);
    expect(renderLeftovers()).toEqual([]);
  });

  test('refuses a symlink into a checkout that is not its root', () => {
    const outer = path.join(tmp, 'src', 'vendoring-repo');
    fs.mkdirSync(outer, { recursive: true });
    git(outer, 'init', '-q', '--template=');
    const nested = path.join(outer, 'vendor', 'gstack');
    write(path.join(nested, 'VERSION'), '9.9.9.0\n');
    write(path.join(nested, 'package.json'), '{}\n');
    linkInstall(nested);
    seedPreviousRender();

    const r = refresh();
    expect(r.code).toBe(0);
    expect(r.out).toContain(`is a symlink into ${outer}, not to the root of that checkout`);
    expect(fs.readFileSync(path.join(renderDir, 'alpha', 'SKILL.md'), 'utf-8')).toBe('previous-render\n');
  });

  test('refuses a symlink to a directory that is not a git checkout', () => {
    const plain = path.join(tmp, 'plain-copy');
    write(path.join(plain, 'VERSION'), '9.9.9.0\n');
    write(path.join(plain, 'package.json'), '{}\n');
    linkInstall(plain);

    const r = refresh();
    expect(r.code).toBe(0);
    expect(r.out).toContain(`is a symlink to ${plain}, which is not a git checkout`);
    expect(fs.existsSync(renderDir)).toBe(false);
  });

  test('a failed render exits non-zero, shows the error, and leaves the previous render whole', () => {
    const install = makeInstall(path.join(tmp, 'src', 'gstack'), 'fresh-render');
    write(path.join(install, '.render-fail'), '1\n');
    linkInstall(install);
    seedPreviousRender();

    const r = refresh();
    expect(r.code).toBe(1);
    expect(r.err).toContain('render failed');
    expect(r.err).toContain('boom: broken template alpha');
    // Never the old in-place advice: a partial in-place render mixes trees.
    expect(r.err).not.toContain(`--out-dir ${renderDir}`);
    expect(fs.readFileSync(path.join(renderDir, 'alpha', 'SKILL.md'), 'utf-8')).toBe('previous-render\n');
    expect(fs.readFileSync(path.join(renderDir, 'alpha', 'sections', 's.md'), 'utf-8')).toBe('previous-section\n');
    expect(renderLeftovers()).toEqual([]);
  });

  test('an installed skill link the new render no longer serves fails the refresh by name', () => {
    const install = makeInstall(path.join(tmp, 'src', 'gstack'), 'fresh-render');
    linkInstall(install);
    seedPreviousRender();
    write(path.join(renderDir, 'retired', 'SKILL.md'), 'old skill\n');
    fs.mkdirSync(path.join(skillsDir, 'retired'));
    fs.symlinkSync(path.join(renderDir, 'retired', 'SKILL.md'), path.join(skillsDir, 'retired', 'SKILL.md'));
    // Another suite's dangling link is not gstack's to report.
    fs.mkdirSync(path.join(skillsDir, 'foreign'));
    fs.symlinkSync(path.join(tmp, 'elsewhere', 'SKILL.md'), path.join(skillsDir, 'foreign', 'SKILL.md'));

    const r = refresh();
    expect(r.code).toBe(1);
    expect(r.err).toContain('installed skill links that no longer resolve: retired/SKILL.md');
    expect(r.err).not.toContain('foreign');
    // The render itself still went live; only the stale link is reported.
    expect(fs.readFileSync(path.join(renderDir, 'alpha', 'SKILL.md'), 'utf-8')).toBe('fresh-render\n');
  });

  test('a real (non-symlink) install still renders as before', () => {
    const install = makeInstall(path.join(skillsDir, 'gstack'), 'real-install-render');

    const r = refresh();
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('Install is a symlink');
    expect(r.out).toContain('Checked 1 installed skill links: none dangling.');
    expect(fs.readFileSync(path.join(renderDir, 'alpha', 'SKILL.md'), 'utf-8')).toBe('real-install-render\n');
    expect(git(install, 'status', '--porcelain')).toBe('');
  });

  test('a git hook environment cannot point the worktree probe at another repo', () => {
    const install = makeInstall(path.join(tmp, 'src', 'gstack'), 'fresh-render');
    const worktree = path.join(tmp, 'worktrees', 'gstack', 'feature');
    git(install, 'worktree', 'add', '-q', '--detach', worktree);
    linkInstall(install);
    // Hooks export GIT_DIR. Run from a linked worktree's hook, it would make
    // the durable clone look like that worktree (or the reverse).
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: home, GSTACK_HOME: gstackHome, GSTACK_USER_RENDER_DIR: renderDir,
      GIT_DIR: path.join(install, '.git', 'worktrees', 'feature'), GIT_WORK_TREE: worktree,
      GIT_CONFIG_GLOBAL: gitEnv.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1',
    };
    const r = spawnSync(path.join(configBin, 'gstack-config'), ['gbrain-refresh'], { env, encoding: 'utf-8', timeout: 60_000 });
    expect(r.stdout).toContain(`Install is a symlink to the checkout ${install}`);
    expect(r.status).toBe(0);
  });
});
