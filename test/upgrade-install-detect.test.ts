/**
 * /gstack-upgrade Step 2 runs on every host. Each host installs differently:
 * Claude's ~/.claude/skills/gstack is the checkout (or a symlink to it), while
 * `setup --host codex|factory|cursor|kiro|opencode` builds a runtime root of
 * runtime assets whose bin/ links into the source checkout (README: clone to
 * ~/gstack, then setup). Step 2 must find that checkout, and must never take a
 * runtime root or a repo-local sidecar for a vendored copy: the vendored path
 * replaces INSTALL_DIR with a full clone.
 *
 * These run the rendered Step 2 bash in a fake HOME, under bash 3.2 and zsh
 * (the shells an agent's tool calls use).
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { spawnSync, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateUpgradeDetectInstall, generateUpgradeRoot } from '../scripts/resolvers/utility';
import type { TemplateContext } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');
const SHELLS = ['/bin/bash', '/bin/zsh'].filter((s) => fs.existsSync(s));
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
});

const block = (host: string) => generateUpgradeDetectInstall({ host } as TemplateContext);

function tmp(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-detect-')));
  scratch.push(d);
  return d;
}

/** A gstack source tree: setup + VERSION + bin/, optionally a git checkout. */
function source(dir: string, git: boolean): string {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'setup'), '#!/bin/bash\n');
  fs.writeFileSync(path.join(dir, 'VERSION'), '1.0.0\n');
  if (git) execFileSync('git', ['init', '-q', dir], { timeout: 30_000, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  return dir;
}

/** What setup builds for a non-Claude host: runtime assets, bin/ linked into the source. */
function runtimeRoot(dir: string, src: string): string {
  fs.mkdirSync(path.join(dir, 'gstack-upgrade'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '# gstack\n');
  fs.symlinkSync(path.join(src, 'bin'), path.join(dir, 'bin'));
  return dir;
}

function detect(shell: string, host: string, home: string, cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync(shell, ['-c', block(host)], {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...env },
  });
  const m = /Install type: (\S+) at (.+)/.exec(r.stdout ?? '');
  return { code: r.status, type: m?.[1], dir: m?.[2]?.trim(), out: `${r.stdout}${r.stderr}` };
}

for (const shell of SHELLS) {
  describe(`gstack-upgrade Step 2 under ${path.basename(shell)}`, () => {
    test('Codex: the README install (~/gstack + ~/.codex/skills/gstack) upgrades the checkout', () => {
      const home = tmp();
      const src = source(path.join(home, 'gstack'), true);
      runtimeRoot(path.join(home, '.codex/skills/gstack'), src);
      const r = detect(shell, 'codex', home, tmp());
      expect(r.out).toContain('Install type: global-git');
      expect(r.dir).toBe(src);
    });

    test('Codex honours CODEX_HOME, as setup does', () => {
      const home = tmp();
      const src = source(path.join(tmp(), 'checkout'), true);
      const codexHome = path.join(tmp(), 'codex-home');
      runtimeRoot(path.join(codexHome, 'skills/gstack'), src);
      const r = detect(shell, 'codex', home, tmp(), { CODEX_HOME: codexHome });
      expect(r.type).toBe('global-git');
      expect(r.dir).toBe(src);
    });

    for (const [host, rel] of [['factory', '.factory/skills/gstack'], ['cursor', '.cursor/skills/gstack'], ['kiro', '.kiro/skills/gstack'], ['opencode', '.config/opencode/skills/gstack']]) {
      test(`${host}: the runtime root at ~/${rel} resolves to its checkout, never to itself`, () => {
        const home = tmp();
        const src = source(path.join(tmp(), 'checkout'), true);
        runtimeRoot(path.join(home, rel), src);
        const r = detect(shell, host, home, tmp());
        expect(r.type).toBe('global-git');
        expect(r.dir).toBe(src);
      });
    }

    test('a runtime root over a non-git copy upgrades the copy as vendored-global', () => {
      const home = tmp();
      const src = source(path.join(tmp(), 'copy'), false);
      const rt = runtimeRoot(path.join(home, '.factory/skills/gstack'), src);
      const r = detect(shell, 'factory', home, tmp());
      expect(r.type).toBe('vendored-global');
      expect(r.dir).toBe(src);
      expect(r.dir).not.toBe(rt);
    });

    test('a runtime root that cannot be traced (copied bin/, no ~/gstack) is refused, not replaced', () => {
      const home = tmp();
      const rt = path.join(home, '.codex/skills/gstack');
      fs.mkdirSync(path.join(rt, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(rt, 'SKILL.md'), '# gstack\n');
      const r = detect(shell, 'codex', home, tmp());
      expect(r.code).toBe(1);
      expect(r.out).toContain('ERROR: gstack not found');
      expect(r.type).toBeUndefined();
    });

    test('an untraceable runtime root is refused beside a ~/gstack checkout the install registry does not name', () => {
      const home = tmp();
      source(path.join(home, 'gstack'), true);
      const rt = path.join(home, '.codex/skills/gstack');
      fs.mkdirSync(path.join(rt, 'bin'), { recursive: true });
      const r = detect(shell, 'codex', home, tmp());
      expect(r.code).toBe(1);
      expect(r.out).toContain('ERROR: gstack not found');
      expect(r.type).toBeUndefined();
    });

    test('Codex: a repo-local .agents sidecar resolves to its checkout as local-git', () => {
      const home = tmp();
      const project = tmp();
      const src = source(path.join(tmp(), 'checkout'), true);
      runtimeRoot(path.join(project, '.agents/skills/gstack'), src);
      const r = detect(shell, 'codex', home, project);
      expect(r.type).toBe('local-git');
      expect(r.dir).toBe(src);
    });

    test('Claude: a global install symlinked to its checkout is global-git at the checkout', () => {
      const home = tmp();
      const src = source(path.join(tmp(), 'checkout'), true);
      fs.mkdirSync(path.join(home, '.claude/skills'), { recursive: true });
      fs.symlinkSync(src, path.join(home, '.claude/skills/gstack'));
      const r = detect(shell, 'claude', home, tmp());
      expect(r.type).toBe('global-git');
      // Step 2 prints the physical path: each later fence runs in a fresh shell.
      expect(r.dir).toBe(src);
    });

    test('Claude: a global install that is a linked worktree (.git file) is still global-git', () => {
      const home = tmp();
      const src = source(path.join(home, '.claude/skills/gstack'), false);
      fs.writeFileSync(path.join(src, '.git'), 'gitdir: /elsewhere\n');
      const r = detect(shell, 'claude', home, tmp());
      expect(r.type).toBe('global-git');
    });

    test('Claude: a project-vendored copy is vendored; a bare skills dir is not', () => {
      const home = tmp();
      const project = tmp();
      source(path.join(project, '.claude/skills/gstack'), false);
      const r = detect(shell, 'claude', home, project);
      expect(r.type).toBe('vendored');
      expect(r.dir).toBe(path.join(project, '.claude/skills/gstack'));

      const empty = tmp();
      fs.mkdirSync(path.join(empty, '.claude/skills/gstack'), { recursive: true });
      expect(detect(shell, 'claude', tmp(), empty).code).toBe(1);
    });
  });
}

describe('gstack-upgrade Step 4.5 leaves a runtime sidecar alone', () => {
  const tmpl = fs.readFileSync(path.join(ROOT, 'gstack-upgrade/SKILL.md.tmpl'), 'utf-8');
  const step45 = tmpl.slice(tmpl.indexOf('### Step 4.5')).match(/```bash\n([\s\S]*?)\n```/)![1]
    .replaceAll('{{UPGRADE_ROOT}}', generateUpgradeRoot({ host: 'claude' } as TemplateContext));

  function localCopy(binIsLink: boolean): string {
    const project = tmp();
    execFileSync('git', ['init', '-q', project], { timeout: 30_000, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    const local = path.join(project, '.claude/skills/gstack');
    fs.mkdirSync(local, { recursive: true });
    if (binIsLink) fs.symlinkSync(path.join(source(path.join(tmp(), 'checkout'), false), 'bin'), path.join(local, 'bin'));
    else source(local, false);
    const r = spawnSync('/bin/bash', ['-c', step45], {
      cwd: project,
      encoding: 'utf8',
      timeout: 30_000,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmp(), INSTALL_DIR: source(path.join(tmp(), 'primary'), true), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    });
    return /LOCAL_GSTACK=(.*)/.exec(r.stdout ?? '')?.[1] ?? 'NO OUTPUT';
  }

  test('a sidecar whose bin/ links into a checkout is not synced over', () => {
    expect(localCopy(true)).toBe('');
  });

  test('a real vendored copy is still found', () => {
    expect(localCopy(false)).toContain('.claude/skills/gstack');
  });
});

describe('gstack-upgrade template wiring', () => {
  const tmpl = fs.readFileSync(path.join(ROOT, 'gstack-upgrade/SKILL.md.tmpl'), 'utf-8');
  const rendered = fs.readFileSync(path.join(ROOT, 'gstack-upgrade/SKILL.md'), 'utf-8');

  test('Step 2 is the host-aware block, and the Claude render carries it verbatim', () => {
    expect(tmpl).toContain('### Step 2: Detect install type\n\n```bash\n{{UPGRADE_DETECT_INSTALL}}\n```');
    expect(rendered).toContain(block('claude'));
  });

  test('no bash block calls the running skill through a Claude-only path', () => {
    // Prose may name the path; code must go through $_RT so every host gets its own root.
    // Upstream's state-root rule (test/state-root-ratchet.test.ts) spells state
    // reads through the Claude path, and every host render rewrites it to its
    // own root, so that one form is not a Claude-only call.
    const code = [...tmpl.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n')
      .replaceAll('GSTACK_STATE_ROOT=$(~/.claude/skills/gstack/bin/gstack-paths --get GSTACK_STATE_ROOT)', '');
    expect(code).not.toMatch(/~\/\.claude\/skills\/gstack\/bin/);
    expect(code).not.toContain('"$HOME/.claude/skills/gstack"');
    for (const line of code.split('\n').filter((l) => l.includes('$_RT/'))) {
      expect(code.indexOf('{{UPGRADE_ROOT}}')).toBeGreaterThan(-1);
      expect(line).not.toContain('~/');
    }
  });

  test('every bash block that uses $_RT sets it first (each block runs in a fresh shell)', () => {
    for (const m of tmpl.matchAll(/```bash\n([\s\S]*?)```/g)) {
      const body = m[1];
      const use = body.indexOf('$_RT');
      if (use === -1 || body.includes('{{UPGRADE_DETECT_INSTALL}}')) continue;
      const set = body.indexOf('{{UPGRADE_ROOT}}');
      expect(set).toBeGreaterThan(-1);
      expect(set).toBeLessThan(use);
    }
  });
});
