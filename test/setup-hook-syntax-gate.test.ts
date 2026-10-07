/**
 * Claude Code runs gstack's hook shims through /bin/sh. A shim that does not
 * parse exits 2, which for a PreToolUse hook blocks the tool call in every
 * session. bin/gstack-hook-check parses every hook setup registers (the shim
 * with the interpreter its shebang names, and each TypeScript entry it runs
 * bundled with its local imports), and setup registers the hooks that parse,
 * refuses the rest with file and line, and exits non-zero.
 *
 * The setup tests run the real hook sections of setup (canonical root, gate,
 * heal, SessionStart, plan-tune and Stop registration, and the final refusal)
 * against a fixture install and a temp settings.json; driving all of ./setup
 * (builds, browser install) here is disproportionate.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const CHECK = path.join(ROOT, 'bin', 'gstack-hook-check');
const SETUP = fs.readFileSync(path.join(ROOT, 'setup'), 'utf8');

function slice(from: string, to: string | null): string {
  const start = SETUP.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = to === null ? SETUP.length : SETUP.indexOf(to, start);
  expect(end).toBeGreaterThan(start);
  return SETUP.slice(start, end);
}

const HOOK_SECTIONS = [
  slice('CANONICAL_GSTACK_ROOT="${CLAUDE_CONFIG_DIR', '# ─── GBrain detection'),
  slice('# 11. Plan-tune cathedral hook install', '# ─── Redact pre-push guard consent'),
  slice('if [ -n "${_HOOK_REFUSED:-}" ]; then', null),
].join('\n');

function listHooks(root: string, setupFile?: string): string[] {
  const args = setupFile ? ['--setup', setupFile, '--list', root] : ['--list', root];
  const r = spawnSync('bash', [CHECK, ...args], { encoding: 'utf8', timeout: 15_000 });
  expect(r.status).toBe(0);
  return r.stdout.trim().split('\n');
}

const bases: string[] = [];
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

const HOOKS = listHooks(ROOT);

// Skill frontmatter hooks: Claude Code registers a skill's `hooks:` while the
// skill is active, so a broken one fails exactly like a broken setup hook (a
// PreToolUse one blocks the tool call). Read here
// independently of the checker: the YAML frontmatter of the root SKILL.md and
// each <skill>/SKILL.md, every `command:` line, every installed gstack path.
const SKILL_FILES = ['SKILL.md', ...fs.readdirSync(ROOT).map(d => path.join(d, 'SKILL.md'))]
  .filter(rel => fs.existsSync(path.join(ROOT, rel)));
function frontmatterOf(rel: string): string | null {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  return end < 0 ? null : text.slice(4, end);
}
const FRONTMATTER_HOOKS = new Map<string, string[]>();
for (const rel of SKILL_FILES) {
  const front = frontmatterOf(rel);
  if (!front) continue;
  const hooks = front.split('\n').filter(l => /^\s*command:/.test(l))
    .flatMap(l => [...l.matchAll(/\$HOME\/\.claude\/skills\/gstack\/([A-Za-z0-9._/-]+)/g)].map(m => m[1]!));
  if (hooks.length) FRONTMATTER_HOOKS.set(rel, [...new Set(hooks)]);
}

// The shell files a shim sources, read here independently of the checker: the
// paths its `# shellcheck source=` directives name, and each `<name>.sh` a
// non-comment line names beside it.
function helpersOf(hook: string): string[] {
  const text = fs.readFileSync(path.join(ROOT, hook), 'utf8');
  const declared = [...text.matchAll(/^\s*#\s*shellcheck\s.*source=(\S+)/gm)].map(m => m[1]!);
  const beside = text.split('\n').filter(l => !/^\s*#/.test(l))
    .flatMap(l => l.match(/[A-Za-z0-9._-]+\.sh/g) ?? []).map(n => path.join(path.dirname(hook), n));
  return [...new Set([...declared, ...beside])].filter(rel => rel !== hook && fs.existsSync(path.join(ROOT, rel)));
}

/** A gstack tree with the real hook shims and the helpers they source, trivial TypeScript entries, and the frontmatter of each skill that registers a hook. */
function fixtureTree(root: string) {
  for (const hook of HOOKS) {
    fs.mkdirSync(path.dirname(path.join(root, hook)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, hook), path.join(root, hook));
    fs.chmodSync(path.join(root, hook), 0o755);
    if (fs.existsSync(path.join(ROOT, `${hook}.ts`))) fs.writeFileSync(path.join(root, `${hook}.ts`), 'export const ok = 1;\n');
    for (const helper of helpersOf(hook)) {
      fs.mkdirSync(path.dirname(path.join(root, helper)), { recursive: true });
      fs.copyFileSync(path.join(ROOT, helper), path.join(root, helper));
    }
  }
  fs.copyFileSync(path.join(ROOT, 'setup'), path.join(root, 'setup'));
  for (const rel of FRONTMATTER_HOOKS.keys()) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), `---\n${frontmatterOf(rel)}\n---\n`);
  }
}

// Conflict markers are built here so this file never carries one at the start
// of a line.
const LT = '<'.repeat(7), EQ = '='.repeat(7), GT = '>'.repeat(7);

function tmpBase(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-gate-'));
  bases.push(base);
  return base;
}

function check(root: string) {
  const r = spawnSync('bash', [CHECK, root], { encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('gstack-hook-check: the hook list is the registration code', () => {
  test('equals every hook setup resolves for registration plus every skill-frontmatter hook', () => {
    const registered = [...SETUP.matchAll(/_hook_command_path (\S+)/g)].map(m => m[1]!.replace(/\W+$/, ''));
    const frontmatter = [...FRONTMATTER_HOOKS.values()].flat();
    const expected = [...new Set([...registered, ...frontmatter])].sort();
    expect(registered.length).toBeGreaterThanOrEqual(5);
    // /autoplan's guard, the /careful and /freeze checks (also run by /guard
    // and /investigate), and /plan-ceo-review's mode hand-off.
    for (const hook of ['autoplan/bin/phase-publication-hook', 'careful/bin/check-careful.sh', 'freeze/bin/check-freeze.sh', 'plan-ceo-review/bin/mode-handoff-hook']) {
      expect(frontmatter).toContain(hook);
    }
    expect([...HOOKS].sort()).toEqual(expected);
  });

  test('every listed hook is a file in this tree, spelled exactly (no trailing backslash or CR)', () => {
    // BusyBox awk once ran each frontmatter path into the `\"` that closes it,
    // so all four were reported `missing` and went unchecked.
    for (const hook of HOOKS) {
      expect(hook).toMatch(/^[A-Za-z0-9._/-]+$/);
      expect(fs.statSync(path.join(ROOT, hook)).isFile()).toBe(true);
    }
  });

  test('every skill whose frontmatter has hooks contributes at least one checked path', () => {
    // Guards the derivation: a hook command spelled some other way (a YAML
    // block scalar, a relative path) would otherwise drop out of the check.
    const withHooks = SKILL_FILES.filter(rel => /^hooks:/m.test(frontmatterOf(rel) ?? ''));
    expect(withHooks.length).toBeGreaterThanOrEqual(6);
    expect(withHooks.filter(rel => !FRONTMATTER_HOOKS.has(rel))).toEqual([]);
  });

  test('SKILL.md files checked out with CRLF line endings still have their hooks listed', () => {
    const root = tmpBase();
    fixtureTree(root);
    for (const rel of FRONTMATTER_HOOKS.keys()) {
      const skill = path.join(root, rel);
      fs.writeFileSync(skill, fs.readFileSync(skill, 'utf8').replace(/\n/g, '\r\n'));
    }
    expect([...listHooks(root)].sort()).toEqual([...HOOKS].sort());
  });

  test('every shipped hook in this checkout passes', () => {
    const r = check(ROOT);
    expect(r.code).toBe(0);
    expect(r.out.trim().split('\n')).toEqual(HOOKS.map(h => `ok ${h}`));
  });
});

describe('gstack-hook-check: what fails', () => {
  test('healthy fixture passes', () => {
    const root = tmpBase();
    fixtureTree(root);
    expect(check(root).code).toBe(0);
  });

  test('a half-merged shell shim fails with its file and line', () => {
    const root = tmpBase();
    fixtureTree(root);
    const shim = path.join(root, 'hosts/claude/hooks/question-preference-hook');
    const lines = fs.readFileSync(shim, 'utf8').split('\n').length;
    fs.appendFileSync(shim, '<<<<<<< HEAD\nif [ -n "$x" ]; then\n');
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(new RegExp(`^fail hosts/claude/hooks/question-preference-hook ${shim}:${lines}: syntax error`, 'm'));
  });

  test('a half-merged shim whose markers sit inside a heredoc still parses, and fails at the first marker', () => {
    const root = tmpBase();
    fixtureTree(root);
    const shim = path.join(root, 'hosts/claude/hooks/question-preference-hook');
    const before = fs.readFileSync(shim, 'utf8');
    const first = before.split('\n').length + 1;
    fs.appendFileSync(shim, `cat >/dev/null <<'EOF'\n${LT} HEAD\nours\n${EQ}\ntheirs\n${GT} main\nEOF\n`);
    // The gap this closes: bash itself accepts the file.
    expect(spawnSync('bash', ['-n', shim], { timeout: 15_000 }).status).toBe(0);
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`fail hosts/claude/hooks/question-preference-hook ${shim}:${first}: unresolved merge conflict marker`);
    expect(r.out).not.toContain('ok hosts/claude/hooks/question-preference-hook');
  });

  test('a TypeScript entry with markers inside a template literal still bundles, and fails at the first marker', () => {
    const root = tmpBase();
    fixtureTree(root);
    const ts = path.join(root, 'hosts/claude/hooks/timeline-stop-hook.ts');
    fs.writeFileSync(ts, `export const x = \`\n${LT} HEAD\na\n${EQ}\nb\n${GT} main\n\`;\n`);
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`fail hosts/claude/hooks/timeline-stop-hook ${ts}:2: unresolved merge conflict marker`);
  });

  test('a half-merged helper the /careful and /freeze checks source fails both, at the helper', () => {
    const root = tmpBase();
    fixtureTree(root);
    const helper = path.join(root, 'careful/bin/hook-extract.sh');
    expect(fs.existsSync(helper)).toBe(true);
    const first = fs.readFileSync(helper, 'utf8').split('\n').length + 1;
    fs.appendFileSync(helper, `cat >/dev/null <<'EOF'\n${LT} HEAD\nours\n${EQ}\ntheirs\n${GT} main\nEOF\n`);
    const r = check(root);
    expect(r.code).toBe(1);
    for (const hook of ['careful/bin/check-careful.sh', 'freeze/bin/check-freeze.sh']) {
      expect(r.out).toContain(`fail ${hook} ${helper}:${first}: unresolved merge conflict marker`);
    }
  });

  test('a helper that a helper sources is checked too (/careful and /freeze reach bin/gstack-state-root.sh through hook-extract.sh)', () => {
    const root = tmpBase();
    fixtureTree(root);
    const helper = path.join(root, 'bin/gstack-state-root.sh');
    expect(fs.existsSync(helper)).toBe(true);
    const lines = fs.readFileSync(helper, 'utf8').split('\n').length;
    fs.appendFileSync(helper, 'if then\n');
    const r = check(root);
    expect(r.code).toBe(1);
    for (const hook of ['careful/bin/check-careful.sh', 'freeze/bin/check-freeze.sh', 'bin/gstack-session-update']) {
      expect(r.out).toMatch(new RegExp(`^fail ${hook.replace(/\./g, '\\.')} ${helper}:${lines}: syntax error`, 'm'));
    }
  });

  test('a script a hook only runs, not sources, is not parsed as its helper', () => {
    // A POSIX sh shim may exec a bash worker beside it; parsing that worker
    // with sh would refuse a hook that runs fine.
    const root = tmpBase();
    fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(root, 'setup'), 'X="$(_hook_command_path hooks/plain || true)"\n');
    fs.writeFileSync(path.join(root, 'hooks/plain'), '#!/bin/sh\nexec "$(dirname "$0")/worker.sh" "$@"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'hooks/worker.sh'), '#!/usr/bin/env bash\nwhile read -r l; do echo "$l"; done < <(echo a)\n', { mode: 0o755 });
    const r = check(root);
    expect(r.out.trim()).toBe('ok hooks/plain');
    expect(r.code).toBe(0);
  });

  test('a helper the auto-updater sources that does not parse fails its hook with the helper file and line', () => {
    const root = tmpBase();
    fixtureTree(root);
    const helper = path.join(root, 'bin/gstack-egress-lib.sh');
    expect(fs.existsSync(helper)).toBe(true);
    const lines = fs.readFileSync(helper, 'utf8').split('\n').length;
    fs.appendFileSync(helper, 'if then\n');
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(new RegExp(`^fail bin/gstack-session-update ${helper}:${lines}: syntax error`, 'm'));
  });

  const bunHasMetafile = (spawnSync('bun', ['build', '--help'], { encoding: 'utf8', timeout: 15_000 }).stdout ?? '').includes('--metafile');
  test.skipIf(!bunHasMetafile)('a module a TypeScript entry imports fails at its first marker, even inside a template literal', () => {
    const root = tmpBase();
    fixtureTree(root);
    const dir = path.join(root, 'hosts/claude/hooks');
    fs.writeFileSync(path.join(dir, 'question-log-hook.ts'), "import { banner } from './hook-log';\nconsole.log(banner);\n");
    const mod = path.join(dir, 'hook-log.ts');
    fs.writeFileSync(mod, `export const banner = \`\n${LT} HEAD\na\n${EQ}\nb\n${GT} main\n\`;\n`);
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`fail hosts/claude/hooks/question-log-hook ${fs.realpathSync(mod)}:2: unresolved merge conflict marker`);
  });

  test('a bun whose build has no --metafile falls back to scanning the entry alone, with no false failure', () => {
    const root = tmpBase();
    fixtureTree(root);
    const oldBun = path.join(root, 'old-bun');
    fs.writeFileSync(oldBun, [
      '#!/bin/bash',
      `if [ "$1" = build ] && [ "$2" = --help ]; then '${process.execPath}' build --help | grep -v -- --metafile; exit 0; fi`,
      'for a in "$@"; do case "$a" in --metafile*) echo "error: unknown flag $a" >&2; exit 1 ;; esac; done',
      `exec '${process.execPath}' "$@"`,
    ].join('\n') + '\n', { mode: 0o755 });
    const run = () => {
      const r = spawnSync('bash', [CHECK, root], { encoding: 'utf8', timeout: 30_000, env: { ...process.env, GSTACK_HOOK_CHECK_BUN: oldBun } });
      return { code: r.status, out: `${r.stdout}${r.stderr}` };
    };
    expect(run().code).toBe(0);
    const ts = path.join(root, 'hosts/claude/hooks/timeline-stop-hook.ts');
    fs.writeFileSync(ts, `export const x = \`\n${LT} HEAD\n\`;\n`);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(`fail hosts/claude/hooks/timeline-stop-hook ${ts}:2: unresolved merge conflict marker`);
  });

  test('a bare ======= line is an ordinary banner, not a marker', () => {
    const root = tmpBase();
    fixtureTree(root);
    const shim = path.join(root, 'hosts/claude/hooks/question-log-hook');
    fs.appendFileSync(shim, `cat >/dev/null <<'EOF'\n${EQ}\nEOF\n`);
    expect(check(root).code).toBe(0);
  });

  test('a broken skill-frontmatter hook fails like a setup hook (/freeze, which /guard and /investigate also run)', () => {
    const root = tmpBase();
    fixtureTree(root);
    const shim = path.join(root, 'freeze/bin/check-freeze.sh');
    const lines = fs.readFileSync(shim, 'utf8').split('\n').length;
    fs.appendFileSync(shim, 'if then\n');
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(new RegExp(`^fail freeze/bin/check-freeze\\.sh ${shim}:${lines}: syntax error`, 'm'));
  });

  test('a TypeScript entry with a syntax error fails with its file and line', () => {
    const root = tmpBase();
    fixtureTree(root);
    const ts = path.join(root, 'hosts/claude/hooks/timeline-stop-hook.ts');
    fs.writeFileSync(ts, 'export const ok = 1;\nexport const x = {;\n');
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`fail hosts/claude/hooks/timeline-stop-hook ${ts}:2: Expected identifier`);
  });

  test('a broken module the entry imports fails at the imported file', () => {
    const root = tmpBase();
    fixtureTree(root);
    const dir = path.join(root, 'hosts/claude/hooks');
    fs.writeFileSync(path.join(dir, 'question-log-hook.ts'), "import { log } from './hook-log';\nimport { chromium } from 'playwright';\nlog(chromium);\n");
    fs.writeFileSync(path.join(dir, 'hook-log.ts'), 'export function log(x: unknown) {\n  return x +;\n}\n');
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`fail hosts/claude/hooks/question-log-hook ${path.join(dir, 'hook-log.ts')}:2:`);
    expect(r.out).not.toContain('playwright');
  });

  test('a missing local import fails', () => {
    const root = tmpBase();
    fixtureTree(root);
    const entry = path.join(root, 'autoplan/bin/phase-publication-hook.ts');
    fs.writeFileSync(entry, "import { x } from '../../lib/gone';\nconsole.log(x);\n");
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`fail autoplan/bin/phase-publication-hook ${entry}:1: Could not resolve: "../../lib/gone"`);
  });

  test('a missing entry fails instead of being skipped', () => {
    const root = tmpBase();
    fixtureTree(root);
    const entry = path.join(root, 'hosts/claude/hooks/auq-error-fallback-hook.ts');
    fs.rmSync(entry);
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`fail hosts/claude/hooks/auq-error-fallback-hook ${entry}:1: missing TypeScript entry`);
  });

  test('a missing shim is reported as missing, not failed (setup already skips registering it)', () => {
    const root = tmpBase();
    fixtureTree(root);
    fs.rmSync(path.join(root, 'hosts/claude/hooks/timeline-stop-hook'));
    const r = check(root);
    expect(r.code).toBe(0);
    expect(r.out).toContain('missing hosts/claude/hooks/timeline-stop-hook');
  });
});

describe('setup: registers the hooks that parse, refuses the rest, exits non-zero', () => {
  test('the gate runs before any hook registration is healed or written', () => {
    const gate = SETUP.indexOf('# Hook parse gate');
    const heal = SETUP.indexOf('# Heal-first: prune dead gstack hook entries');
    expect(gate).toBeGreaterThan(-1);
    expect(heal).toBeGreaterThan(gate);
    const writes = [...SETUP.matchAll(/"\$SETTINGS_HOOK" (?:ensure-event|add-event|prune-stale|remove-source)/g)].map(m => m.index!);
    expect(writes.length).toBeGreaterThan(0);
    expect(Math.min(...writes)).toBeGreaterThan(heal);
    expect(SETUP).not.toContain('refusing to register hooks: a hook file does not parse');
  });

  function setupFixture() {
    const base = tmpBase();
    const home = path.join(base, 'home');
    const canonical = path.join(home, '.claude', 'skills', 'gstack');
    fs.mkdirSync(canonical, { recursive: true });
    fs.mkdirSync(path.join(home, '.gstack'), { recursive: true });
    fixtureTree(canonical);
    return { base, home, canonical, settings: path.join(home, '.claude', 'settings.json') };
  }
  type Fx = ReturnType<typeof setupFixture>;

  function runSetupHooks(fx: Fx) {
    const script = [
      'set -e',
      "log() { printf '%s\\n' \"$*\"; }",
      `BUN_CMD='${process.execPath}'`,
      `SOURCE_GSTACK_DIR='${ROOT}'`,
      `SETTINGS_HOOK='${ROOT}/bin/gstack-settings-hook'`,
      `GSTACK_CONFIG='${ROOT}/bin/gstack-config'`,
      'TEAM_MODE=1 NO_TEAM_MODE=0 IS_WINDOWS=0 QUIET=1 PLAN_TUNE_HOOKS_MODE="" TIMELINE_STOP_HOOK_MODE=""',
      HOOK_SECTIONS,
      'echo SETUP_HOOKS_DONE',
    ].join('\n');
    const env: Record<string, string> = {
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
      HOME: fx.home,
      GSTACK_STATE_ROOT: path.join(fx.home, '.gstack'),
      GSTACK_SETTINGS_FILE: fx.settings,
      GSTACK_PLAN_TUNE_HOOKS: 'yes',
      TMPDIR: fx.base,
    };
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env, timeout: 60_000 });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  }

  function registeredCommands(fx: Fx): string[] {
    const settings = JSON.parse(fs.readFileSync(fx.settings, 'utf8'));
    return Object.values(settings.hooks ?? {}).flatMap((entries: any) =>
      entries.flatMap((e: any) => (e.hooks ?? []).map((h: any) => String(h.command)))).sort();
  }

  const shim = (fx: Fx, rel: string) => path.join(fx.canonical, rel);
  const ALL = ['bin/gstack-session-update', 'hosts/claude/hooks/question-log-hook', 'hosts/claude/hooks/question-preference-hook',
    'hosts/claude/hooks/auq-error-fallback-hook', 'hosts/claude/hooks/timeline-stop-hook'];
  // Each case runs the hook sections once or twice, and each run parses every
  // hook and bundles its TypeScript. A run took 2.5 s at load 48, so a case
  // that runs it twice can pass a bare `bun test`'s 5 s default (the free
  // runner allows 30 s).
  const SETUP_HOOKS_TEST_MS = 120_000;

  test('healthy install registers every hook and finishes', () => {
    const fx = setupFixture();
    const r = runSetupHooks(fx);
    expect(r.out).toContain('SETUP_HOOKS_DONE');
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('refusing to register');
    expect(registeredCommands(fx)).toEqual(ALL.map(rel => shim(fx, rel)).sort());
  }, SETUP_HOOKS_TEST_MS);

  test('fresh install: the unparseable hook is not registered, the rest are, and setup exits 1 with file:line', () => {
    const fx = setupFixture();
    const broken = shim(fx, 'hosts/claude/hooks/question-log-hook');
    const lines = fs.readFileSync(broken, 'utf8').split('\n').length;
    fs.appendFileSync(broken, 'if then\n');
    const r = runSetupHooks(fx);
    expect(r.code).toBe(1);
    expect(r.out).not.toContain('SETUP_HOOKS_DONE');
    expect(r.out).toContain('gstack setup: refusing to register hooks that do not parse');
    expect(r.out).toContain(`  ${broken}:${lines}: syntax error`);
    expect(r.out).toContain('Skipped: hosts/claude/hooks/question-log-hook');
    expect(r.out).toContain(`This is a gstack bug; report ${broken}:${lines}`);
    expect(r.out).toContain('Hooks that parse register as usual: bin/gstack-session-update hosts/claude/hooks/question-preference-hook');
    expect(r.out).toContain('https://github.com/garrytan/gstack/blob/main/docs/troubleshooting.md#setup-hook-does-not-parse');
    expect(r.out).not.toContain('previous install is still active');
    expect(r.out).not.toContain('no stable install');
    expect(registeredCommands(fx)).toEqual(ALL.filter(rel => rel !== 'hosts/claude/hooks/question-log-hook').map(rel => shim(fx, rel)).sort());
  }, SETUP_HOOKS_TEST_MS);

  test('upgrade over live registrations: the others stay registered, the broken one is not re-registered, exit 1', () => {
    const fx = setupFixture();
    expect(runSetupHooks(fx).code).toBe(0);
    const before = registeredCommands(fx);
    expect(before).toHaveLength(ALL.length);

    // The new revision's Stop hook entry does not parse.
    fs.writeFileSync(shim(fx, 'hosts/claude/hooks/timeline-stop-hook.ts'), 'export const x = {;\n');
    const r = runSetupHooks(fx);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${shim(fx, 'hosts/claude/hooks/timeline-stop-hook.ts')}:1: Expected identifier`);
    expect(r.out).toContain('Skipped: hosts/claude/hooks/timeline-stop-hook');
    expect(r.out).toContain('keeps running the broken file until it is fixed');
    expect(r.out).not.toContain('previous install is still active');
    expect(registeredCommands(fx)).toEqual(before);
  }, SETUP_HOOKS_TEST_MS);

  test('a half-merged skill-frontmatter hook: setup names it, still registers its own hooks, and exits 1', () => {
    const fx = setupFixture();
    const broken = shim(fx, 'careful/bin/check-careful.sh');
    const first = fs.readFileSync(broken, 'utf8').split('\n').length + 1;
    fs.appendFileSync(broken, `cat >/dev/null <<'EOF'\n${LT} HEAD\nours\n${EQ}\ntheirs\n${GT} main\nEOF\n`);
    const r = runSetupHooks(fx);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`  ${broken}:${first}: unresolved merge conflict marker`);
    expect(r.out).toContain('Skipped: careful/bin/check-careful.sh');
    expect(r.out).toContain('or that a skill file runs, keeps running the broken file until it is fixed');
    expect(registeredCommands(fx)).toEqual(ALL.map(rel => shim(fx, rel)).sort());
  }, SETUP_HOOKS_TEST_MS);
});
