/**
 * hook-syntax.test.ts — pins the hook parse gate (scripts/hook-syntax.sh) and
 * its consumer, ./setup.
 *
 * WHY. Claude Code runs a hook by path out of the checkout ./setup registered,
 * and a hook that does not parse exits 2 — the status Claude Code reads as
 * "block". A broken PreToolUse hook fails every matching tool call in every
 * session on the machine; on 2026-08-27 one from another repo, left mid-merge
 * with conflict markers, failed every Bash call there was.
 *
 * The properties worth defending, in order:
 *   1. every hook gstack wires goes RED when a scratch copy of it is broken,
 *      and stays GREEN when the pristine copy goes through the same harness —
 *      a gate never shown to fail is not a gate
 *   2. it is SILENT on a healthy tree; a chattering gate gets routed around
 *   3. it does not claim coverage it lacks: skipped is reported as skipped
 *   4. ./setup refuses BEFORE it runs, writes, links or registers anything
 *
 * The wired-hook list is DERIVED, not typed out: KNOWN_HOOKS in
 * bin/gstack-settings-hook is the registry ./setup and gstack-memorable write
 * from, and skill frontmatter carries the rest. A hook added to either joins
 * the per-hook cases below without anyone editing this file.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const ROOT = path.resolve(import.meta.dir, '..');
const GATE = path.join(ROOT, 'scripts', 'hook-syntax.sh');
const SETUP_SCRIPT = path.join(ROOT, 'setup');
const GATE_SRC = fs.readFileSync(GATE, 'utf-8');
const SETUP_SRC = fs.readFileSync(SETUP_SCRIPT, 'utf-8');

// Conflict markers are built from constants so this file never carries one at
// the start of a line.
const LT = '<'.repeat(7);
const EQ = '='.repeat(7);
const GT = '>'.repeat(7);
const PIPE = '|'.repeat(7);
const CONFLICT_HEREDOC = `cat <<'HOOKEOF'\n${LT} HEAD\na\n${EQ}\nb\n${GT} other\nHOOKEOF\n`;

// One gate run costs a bash fork per file plus a bun bundle per payload. That
// is well under a second on an idle machine and many times that while the rest
// of the free suite runs its shards alongside. bun's 5s default would turn that
// into a load-dependent flake — the one failure mode a gate must not have.
const SPAWN_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 150_000;
const SWEEP_TIMEOUT_MS = 240_000;

type Run = { code: number; output: string };

function runGate(args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync('/bin/bash', [GATE, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
  });
  return { code: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

// ── the wired hooks, derived from where they are registered ────────────────

type Wired = { rel: string; event: string; source: string };

function knownHooks(): Wired[] {
  const src = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-settings-hook'), 'utf-8');
  const block = src.slice(src.indexOf('var KNOWN_HOOKS = {'), src.indexOf('};', src.indexOf('var KNOWN_HOOKS = {')));
  const out: Wired[] = [];
  for (const m of block.matchAll(/event: "([A-Za-z]+)".*?relpath: "([^"]+)"/g)) {
    out.push({ rel: m[2], event: m[1], source: 'bin/gstack-settings-hook KNOWN_HOOKS' });
  }
  return out;
}

// Skills register hooks in their frontmatter, as `bash $HOME/.claude/skills/
// gstack/<rel>`; they run whenever the skill is active.
function frontmatterHooks(): Wired[] {
  const out = new Map<string, Wired>();
  for (const dir of fs.readdirSync(ROOT)) {
    const tmpl = path.join(ROOT, dir, 'SKILL.md.tmpl');
    if (!fs.existsSync(tmpl)) continue;
    const text = fs.readFileSync(tmpl, 'utf-8');
    if (!text.startsWith('---\n')) continue;
    const front = text.slice(4, text.indexOf('\n---', 4));
    if (!/^hooks:/m.test(front)) continue;
    let event = '';
    for (const line of front.split('\n')) {
      const ev = line.match(/^ {2}([A-Za-z]+):\s*$/);
      if (ev) event = ev[1];
      const cmd = line.match(/command: "bash \$HOME\/\.claude\/skills\/gstack\/([^"\s]+)"/);
      if (cmd && !out.has(cmd[1])) out.set(cmd[1], { rel: cmd[1], event, source: `${dir}/SKILL.md.tmpl frontmatter` });
    }
  }
  return [...out.values()];
}

const WIRED: Wired[] = [...knownHooks(), ...frontmatterHooks()];

// The payload a shim hands to bun, read the way a reader would, independent of
// the gate's own discovery.
function payloadOf(shimText: string): string | null {
  for (const line of shimText.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/bun\s+(?:run\s+)?"\$HERE\/([^"]+)"/);
    if (m) return m[1];
  }
  return null;
}

// ── fixtures ───────────────────────────────────────────────────────────────

let FX = '';
// A scratch copy of everything the wired hooks reach: the shims, their bun
// payloads, everything those import, and the libraries the bin hooks source.
let SCRATCH = '';
const SCRATCH_DIRS = ['hosts', 'lib', 'scripts', 'bin', 'careful/bin', 'freeze/bin'];

beforeAll(() => {
  FX = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hook-syntax-'));
  SCRATCH = path.join(FX, 'scratch');
  for (const dir of SCRATCH_DIRS) {
    fs.cpSync(path.join(ROOT, dir), path.join(SCRATCH, dir), { recursive: true });
  }
});

afterAll(() => {
  if (FX) fs.rmSync(FX, { recursive: true, force: true });
});

function fixture(name: string, body: string): string {
  const p = path.join(FX, 'fx', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

// Edit a scratch file, run `fn` on it, and put it back whatever happens, so
// the next case starts from the pristine copy again.
function withEdit<T>(rel: string, edit: (orig: string) => string, fn: (p: string) => T): T {
  const p = path.join(SCRATCH, rel);
  const orig = fs.readFileSync(p, 'utf-8');
  try {
    fs.writeFileSync(p, edit(orig));
    return fn(p);
  } finally {
    fs.writeFileSync(p, orig);
  }
}

// An unclosed `if` straight after the shebang: bash reads to end of file
// looking for the `fi`, so nothing in the file ever executes.
const breakParse = (orig: string) => {
  const nl = orig.indexOf('\n');
  return `${orig.slice(0, nl + 1)}if true; then\n${orig.slice(nl + 1)}`;
};
const halfMerge = (orig: string) => `${orig}\n${CONFLICT_HEREDOC}`;
const breakTs = (orig: string) => `${orig}\nconst broken: number = {\n`;
const harmless = (orig: string) => `${orig}\n# control edit — changes nothing\n`;

// ── every wired hook: RED when broken, GREEN when pristine ─────────────────

describe('hook-syntax: the wired hook list', () => {
  test('is derived from the registries, and is not empty', () => {
    // Floors, not exact counts: this must not go red every time a hook lands,
    // but it must catch a derivation that silently stopped finding them.
    expect(knownHooks().length).toBeGreaterThanOrEqual(5);
    expect(frontmatterHooks().length).toBeGreaterThanOrEqual(2);
    expect(WIRED.find(h => h.rel === 'hosts/claude/hooks/question-preference-hook')?.event).toBe('PreToolUse');
    expect(WIRED.find(h => h.rel === 'careful/bin/check-careful.sh')?.event).toBe('PreToolUse');
  });

  test('every hosts/claude/hooks shim hands a payload to bun', () => {
    // The per-hook payload cases below key on this. A shim that stopped
    // matching the shape would quietly drop out of them.
    for (const h of WIRED.filter(w => w.rel.startsWith('hosts/claude/hooks/'))) {
      expect([h.rel, payloadOf(fs.readFileSync(path.join(ROOT, h.rel), 'utf-8'))]).not.toEqual([h.rel, null]);
    }
  });
});

for (const hook of WIRED) {
  describe(`hook-syntax: wired ${hook.event} hook ${hook.rel} (${hook.source})`, () => {
    const payload = payloadOf(fs.readFileSync(path.join(ROOT, hook.rel), 'utf-8'));
    const payloadRel = payload ? path.join(path.dirname(hook.rel), payload) : null;

    test('the pristine scratch copy is GREEN, and everything that runs was parsed', () => {
      const r = runGate(['--report', path.join(SCRATCH, hook.rel)]);
      expect(r.code).toBe(0);
      expect(r.output).toBe(`hook-syntax: ${payload ? 2 : 1} checked, 0 skipped`);
    }, TEST_TIMEOUT_MS);

    test('control: a harmless edit through the same harness stays GREEN', () => {
      // Proves the RED cases are caused by the break, not by copying or
      // rewriting the file.
      withEdit(hook.rel, harmless, (p) => {
        const r = runGate([p]);
        expect(r.output).toBe('');
        expect(r.code).toBe(0);
      });
    }, TEST_TIMEOUT_MS);

    test('RED: a parse error is caught, naming the file and the line', () => {
      withEdit(hook.rel, breakParse, (p) => {
        const r = runGate([p]);
        expect(r.code).toBe(1);
        expect(r.output).toContain('FAILS TO PARSE');
        expect(r.output).toContain(path.basename(hook.rel));
        expect(r.output).toMatch(/line \d+/);
      });
    }, TEST_TIMEOUT_MS);

    test('premise: that same broken copy exits 2 when the host runs it', () => {
      // Exit 2 is what Claude Code reads as "block". Run exactly as a host
      // would — by path for a shim it registers, through `bash` for a
      // frontmatter command — in a scratch HOME. The break leaves an `if`
      // open to end of file, so nothing in the hook executes.
      withEdit(hook.rel, breakParse, (p) => {
        fs.chmodSync(p, 0o755);
        const viaBash = hook.source.includes('frontmatter');
        const r = spawnSync(viaBash ? 'bash' : p, viaBash ? [p] : [], {
          cwd: FX,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: path.join(FX, 'home') },
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf-8',
          timeout: SPAWN_TIMEOUT_MS,
        });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('syntax error');
      });
    }, TEST_TIMEOUT_MS);

    test('RED: a half-merged copy that still parses is caught', () => {
      withEdit(hook.rel, halfMerge, (p) => {
        // Guard the premise: a parse alone would MISS this.
        expect(spawnSync('/bin/bash', ['-n', p], { timeout: SPAWN_TIMEOUT_MS }).status).toBe(0);
        const r = runGate([p]);
        expect(r.code).toBe(1);
        expect(r.output).toContain('UNRESOLVED CONFLICT MARKERS');
        expect(r.output).toContain(path.basename(hook.rel));
      });
    }, TEST_TIMEOUT_MS);

    if (payloadRel) {
      test(`RED: a broken payload (${payload}) fails through a shim that parses`, () => {
        withEdit(payloadRel, breakTs, () => {
          const r = runGate([path.join(SCRATCH, hook.rel)]);
          expect(r.code).toBe(1);
          expect(r.output).toContain('FAILS TO PARSE');
          expect(r.output).toContain(path.basename(payloadRel));
        });
      }, TEST_TIMEOUT_MS);

      test('RED: a half-merged payload is caught', () => {
        // TypeScript markers do not parse either, but a marker inside a
        // template literal does — the content scan is what catches that.
        withEdit(payloadRel, (o) => `${o}\nexport const conflicted = \`\n${LT} HEAD\na\n${GT} other\n\`;\n`, () => {
          const r = runGate([path.join(SCRATCH, hook.rel)]);
          expect(r.code).toBe(1);
          expect(r.output).toContain('UNRESOLVED CONFLICT MARKERS');
        });
      }, TEST_TIMEOUT_MS);
    }
  });
}

describe('hook-syntax: libraries the wired hooks source', () => {
  test('bin/gstack-egress-lib.sh has no shebang and is still parsed', () => {
    // bin/gstack-session-update (SessionStart) sources it. A shebang-keyed
    // sweep alone would skip it.
    expect(fs.readFileSync(path.join(ROOT, 'bin', 'gstack-egress-lib.sh'), 'utf-8').startsWith('#!')).toBe(false);
    expect(fs.readFileSync(path.join(ROOT, 'bin', 'gstack-session-update'), 'utf-8')).toContain('/gstack-egress-lib.sh"');
    withEdit('bin/gstack-egress-lib.sh', breakParse, () => {
      const r = runGate([path.join(SCRATCH, 'bin')]);
      expect(r.code).toBe(1);
      expect(r.output).toContain('gstack-egress-lib.sh');
    });
  }, SWEEP_TIMEOUT_MS);

  test('careful/bin/hook-extract.sh, sourced by both frontmatter hooks, is parsed', () => {
    withEdit('careful/bin/hook-extract.sh', halfMerge, () => {
      const r = runGate([path.join(SCRATCH, 'careful')]);
      expect(r.code).toBe(1);
      expect(r.output).toContain('hook-extract.sh');
    });
  }, TEST_TIMEOUT_MS);
});

// ── the real tree ──────────────────────────────────────────────────────────

describe('hook-syntax: the real gstack tree', () => {
  test('parses, and the gate says nothing about it', () => {
    const r = runGate([ROOT]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
  }, SWEEP_TIMEOUT_MS);

  test('the sweep actually parsed something — green is not vacuous', () => {
    const r = runGate(['--report', ROOT]);
    expect(r.code).toBe(0);
    const m = r.output.match(/hook-syntax: (\d+) checked, (\d+) skipped/);
    expect(m).not.toBeNull();
    // 115 when this landed. A floor, so a new script never turns it red, but
    // a sweep that silently stopped finding files does.
    expect(Number(m![1])).toBeGreaterThanOrEqual(90);
  }, SWEEP_TIMEOUT_MS);
});

// ── sweep mechanics ────────────────────────────────────────────────────────

describe('hook-syntax: sweep mechanics', () => {
  test('descends into nested directories and names the file', () => {
    fixture('deep/top.sh', '#!/bin/bash\nexit 0\n');
    fixture('deep/lib/broken.sh', '#!/bin/bash\nif true; then\n');
    const r = runGate([path.join(FX, 'fx', 'deep')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('lib/broken.sh');
  }, TEST_TIMEOUT_MS);

  test('one broken file does not hide the next', () => {
    fixture('two/lib/broken.sh', '#!/bin/bash\nif true; then\n');
    fixture('two/inner/also-broken.sh', '#!/bin/bash\nwhile true; do\n');
    const r = runGate([path.join(FX, 'fx', 'two')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('lib/broken.sh');
    expect(r.output).toContain('inner/also-broken.sh');
  }, TEST_TIMEOUT_MS);

  test('node_modules is pruned, not swept', () => {
    fixture('pruned-nm/ok.sh', '#!/bin/bash\nexit 0\n');
    fixture('pruned-nm/node_modules/junk/vendored.sh', '#!/bin/bash\nif true; then\n');
    const r = runGate([path.join(FX, 'fx', 'pruned-nm')]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test('.build is pruned — vendored SwiftPM checkouts carry sample git hooks', () => {
    fixture('pruned-build/ok.sh', '#!/bin/bash\nexit 0\n');
    fixture('pruned-build/.build/checkouts/x/hooks/pre-commit.sample', '#!/bin/sh\ncase x in\n');
    const r = runGate([path.join(FX, 'fx', 'pruned-build')]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test('a directory argument is swept, not read as a file', () => {
    // Reading a directory finds no shebang and reports a clean skip: a pass
    // for something never looked at.
    fixture('asdir/broken.sh', '#!/bin/bash\nif true; then\n');
    expect(runGate([path.join(FX, 'fx', 'asdir')]).code).toBe(1);
  }, TEST_TIMEOUT_MS);

  test('a path that does not exist is a failure, not a skip', () => {
    const r = runGate([path.join(FX, 'fx', 'never-written.sh')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('UNREADABLE');
  }, TEST_TIMEOUT_MS);

  test('a symlinked directory is swept through, not read as empty', () => {
    // The live install, ~/.claude/skills/gstack, is a symlink to a checkout.
    fixture('symlinked/real/broken.sh', '#!/bin/bash\nif true; then\n');
    const link = path.join(FX, 'fx', 'symlinked', 'link');
    fs.symlinkSync(path.join(FX, 'fx', 'symlinked', 'real'), link);
    const r = runGate([link]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('broken.sh');
  }, TEST_TIMEOUT_MS);

  test('a nested checkout is another branch, and is not swept', () => {
    // e.g. .claude/worktrees/<name>: a conflict there must not refuse this
    // install. A worktree's .git is a file, a clone's a directory; both count.
    fixture('nested/top/ok.sh', '#!/bin/bash\nexit 0\n');
    fixture('nested/top/wt/.git', 'gitdir: /elsewhere\n');
    fixture('nested/top/wt/broken.sh', '#!/bin/bash\nif true; then\n');
    fixture('nested/top/clone/.git/HEAD', 'ref: refs/heads/main\n');
    fixture('nested/top/clone/conflicted.sh', `#!/bin/bash\n${CONFLICT_HEREDOC}`);
    const r = runGate(['--report', path.join(FX, 'fx', 'nested', 'top')]);
    expect(r.code).toBe(0);
    expect(r.output).toContain('1 checked, 0 skipped');
    expect(r.output).toContain('2 nested checkout(s) not swept');
  }, TEST_TIMEOUT_MS);

  test("the root's own .git does not hide the root", () => {
    fixture('rootgit/.git/HEAD', 'ref: refs/heads/main\n');
    fixture('rootgit/broken.sh', '#!/bin/bash\nif true; then\n');
    const r = runGate([path.join(FX, 'fx', 'rootgit')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('broken.sh');
  }, TEST_TIMEOUT_MS);

  test('a nested checkout under a path with glob characters is matched literally', () => {
    fixture('glob[1]/top/ok.sh', '#!/bin/bash\nexit 0\n');
    fixture('glob[1]/top/wt/.git', 'gitdir: /elsewhere\n');
    fixture('glob[1]/top/wt/broken.sh', '#!/bin/bash\nif true; then\n');
    const r = runGate([path.join(FX, 'fx', 'glob[1]', 'top')]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test('a .git inside an already-pruned tree is not counted as a nested checkout', () => {
    fixture('pruned-git/ok.sh', '#!/bin/bash\nexit 0\n');
    fixture('pruned-git/node_modules/pkg/.git/HEAD', 'ref: refs/heads/main\n');
    const r = runGate(['--report', path.join(FX, 'fx', 'pruned-git')]);
    expect(r.code).toBe(0);
    expect(r.output).not.toContain('nested checkout');
  }, TEST_TIMEOUT_MS);

  for (const [label, mode] of [['unreadable', 0o300], ['unsearchable', 0o600]] as const) {
    test(`an ${label} directory is a failure, not a quiet skip of what it holds`, () => {
      fixture(`locked-${label}/ok.sh`, '#!/bin/bash\nexit 0\n');
      fixture(`locked-${label}/inner/broken.sh`, '#!/bin/bash\nif true; then\n');
      const inner = path.join(FX, 'fx', `locked-${label}`, 'inner');
      fs.chmodSync(inner, mode);
      try {
        try {
          fs.accessSync(inner, fs.constants.R_OK | fs.constants.X_OK);
          return; // read-anything privileges: nothing is hidden, nothing to assert
        } catch {
          // expected: genuinely locked
        }
        const r = runGate([path.join(FX, 'fx', `locked-${label}`)]);
        expect(r.code).toBe(1);
        expect(r.output).toContain('UNREADABLE directory');
        expect(r.output).toContain(`locked-${label}/inner`);
      } finally {
        fs.chmodSync(inner, 0o700);
      }
    }, TEST_TIMEOUT_MS);
  }

  test('a sweep that finds no file at all is a failure, not a pass', () => {
    fs.mkdirSync(path.join(FX, 'fx', 'empty-sweep', 'node_modules', 'pkg'), { recursive: true });
    fixture('empty-sweep/node_modules/pkg/ok.sh', '#!/bin/bash\nexit 0\n');
    const r = runGate([path.join(FX, 'fx', 'empty-sweep')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('no files found');
  }, TEST_TIMEOUT_MS);
});

// ── per-file verdicts ──────────────────────────────────────────────────────

describe('hook-syntax: per-file verdicts', () => {
  test('a healthy file is silent', () => {
    const r = runGate([fixture('fine.sh', '#!/bin/bash\necho fine\n')]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test('an unclosed if fails, naming the file and the line', () => {
    const r = runGate([fixture('unclosed.sh', '#!/bin/bash\nif true; then\n  echo hi\n')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('FAILS TO PARSE');
    expect(r.output).toContain('unclosed.sh');
    // The line is the difference between "a hook is broken" and a message
    // that points straight at it.
    expect(r.output).toContain('line 4');
  }, TEST_TIMEOUT_MS);

  test('env-bash and sh shebangs are covered too', () => {
    expect(runGate([fixture('env-bash.sh', '#!/usr/bin/env bash\ncase x in\n')]).code).toBe(1);
    expect(runGate([fixture('plain-sh.sh', '#!/bin/sh\nfoo() {\n')]).code).toBe(1);
  }, TEST_TIMEOUT_MS);

  test('a file is parsed by the interpreter its shebang names', () => {
    // `;;&` is bash 4+. It parses under a PATH bash 5 and is a syntax error
    // under the /bin/bash 3.2 that macOS runs a `#!/bin/bash` hook with.
    const body = 'case a in a) echo;;& esac\n';
    const sys = spawnSync('/bin/bash', ['-c', 'echo "${BASH_VERSINFO[0]}"'], { encoding: 'utf-8', timeout: SPAWN_TIMEOUT_MS }).stdout.trim();
    const envBash = spawnSync('bash', ['-c', 'echo "${BASH_VERSINFO[0]}"'], { encoding: 'utf-8', timeout: SPAWN_TIMEOUT_MS }).stdout.trim();
    const fixed = runGate([fixture('interp/fixed.sh', `#!/bin/bash\n${body}`)]);
    const viaEnv = runGate([fixture('interp/env.sh', `#!/usr/bin/env bash\n${body}`)]);
    expect(fixed.code).toBe(Number(sys) < 4 ? 1 : 0);
    expect(viaEnv.code).toBe(Number(envBash) < 4 ? 1 : 0);
    if (Number(sys) < 4) expect(fixed.output).toContain('/bin/bash -n');
  }, TEST_TIMEOUT_MS);

  test('an unreadable file is a failure, not a skip', () => {
    const p = fixture('locked.sh', '#!/bin/bash\nexit 0\n');
    fs.chmodSync(p, 0o000);
    try {
      fs.accessSync(p, fs.constants.R_OK);
      fs.chmodSync(p, 0o600);
      return; // running with read-anything privileges; nothing to assert
    } catch {
      // expected: genuinely unreadable
    }
    const r = runGate([p]);
    fs.chmodSync(p, 0o600);
    expect(r.code).toBe(1);
    expect(r.output).toContain('UNREADABLE');
  }, TEST_TIMEOUT_MS);
});

// ── the one rule that reads a name ─────────────────────────────────────────

describe('hook-syntax: shebang-less shell libraries', () => {
  test('a .sh file with no #! line is parsed as bash', () => {
    const r = runGate(['--report', fixture('srclib/broken-lib.sh', 'helper() {\n  echo\n')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('broken-lib.sh');
    expect(r.output).toContain('1 checked, 0 skipped');
  }, TEST_TIMEOUT_MS);

  test('any shebang wins over the name', () => {
    // A zsh script named .sh is not this gate's to parse as bash.
    const r = runGate(['--report', fixture('srclib/zsh-script.sh', '#!/bin/zsh\nfoo=( ${(s:,:)bar} )\n')]);
    expect(r.code).toBe(0);
    expect(r.output).toContain('0 checked, 1 skipped');
  }, TEST_TIMEOUT_MS);

  test('a shebang-less file with any other name is still skipped', () => {
    const r = runGate(['--report', fixture('no-shebang', 'if true; then\n')]);
    expect(r.code).toBe(0);
    expect(r.output).toContain('0 checked, 1 skipped');
  }, TEST_TIMEOUT_MS);
});

// ── conflict markers, which are NOT the same check as parsing ──────────────

describe('hook-syntax: conflict markers', () => {
  test('top-level conflict markers fail', () => {
    const p = fixture('conflicted.sh', `#!/bin/bash\n${LT} HEAD\necho a\n${EQ}\necho b\n${GT} other\n`);
    expect(runGate([p]).code).toBe(1);
  }, TEST_TIMEOUT_MS);

  test('markers inside a heredoc body fail, though the file parses', () => {
    const p = fixture('heredoc-conflict.sh', `#!/bin/bash\n${CONFLICT_HEREDOC}`);
    expect(spawnSync('/bin/bash', ['-n', p], { timeout: SPAWN_TIMEOUT_MS }).status).toBe(0); // guard the premise
    const r = runGate([p]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('UNRESOLVED CONFLICT MARKERS');
    expect(r.output).toContain('heredoc-conflict.sh:3:');
  }, TEST_TIMEOUT_MS);

  test('the diff3 base marker fails too', () => {
    const p = fixture('conflict-base.sh', `#!/bin/bash\ncat <<'EOF'\n${PIPE} base\nEOF\n`);
    expect(runGate([p]).code).toBe(1);
  }, TEST_TIMEOUT_MS);

  test('an = banner rule is not a conflict marker', () => {
    // git writes the `=` separator with no label, so it cannot be told apart
    // from a rule, and is deliberately not scanned. A real conflict writes the
    // labelled markers too.
    const p = fixture('banner.sh', `#!/bin/bash\n# ${EQ}${EQ}\n#${EQ}\ncat <<'EOF'\n${EQ}\nEOF\n: done\n`);
    const r = runGate([p]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test('the trailing label is what separates a conflict from a rule', () => {
    const bare = fixture('bare.sh', `#!/bin/bash\ncat <<'EOF'\n${LT}\na\nEOF\n`);
    const labelled = fixture('labelled.sh', `#!/bin/bash\ncat <<'EOF'\n${LT} HEAD\na\nEOF\n`);
    expect(spawnSync('/bin/bash', ['-n', bare], { timeout: SPAWN_TIMEOUT_MS }).status).toBe(0);
    expect(spawnSync('/bin/bash', ['-n', labelled], { timeout: SPAWN_TIMEOUT_MS }).status).toBe(0);
    const clean = runGate([bare]);
    expect(clean.output).toBe('');
    expect(clean.code).toBe(0);
    const dirty = runGate([labelled]);
    expect(dirty.code).toBe(1);
    expect(dirty.output).toContain('UNRESOLVED CONFLICT MARKERS');
  }, TEST_TIMEOUT_MS);

  test('each conflicted file is named once, with all of its marker lines', () => {
    const a = fixture('multi/a.sh', `#!/bin/bash\n${CONFLICT_HEREDOC}`);
    const b = fixture('multi/b.sh', `#!/bin/bash\n${CONFLICT_HEREDOC}`);
    const r = runGate([a, b]);
    expect(r.code).toBe(1);
    expect(r.output.split(`UNRESOLVED CONFLICT MARKERS in ${a}`).length - 1).toBe(1);
    expect(r.output.split(`UNRESOLVED CONFLICT MARKERS in ${b}`).length - 1).toBe(1);
    expect(r.output.split(`${b}:`).length - 1).toBe(2);
  }, TEST_TIMEOUT_MS);
});

// ── what is skipped, and honestly reported as skipped ──────────────────────

describe('hook-syntax: honest coverage', () => {
  test('a TypeScript file no shim reaches is skipped, not counted as checked', () => {
    const r = runGate(['--report', fixture('orphan.ts', 'const x: number = {\n')]);
    expect(r.code).toBe(0);
    expect(r.output).toContain('0 checked, 1 skipped');
  }, TEST_TIMEOUT_MS);

  test('a payload reached by a sweep is counted once, as checked', () => {
    fixture('counted/hook', '#!/usr/bin/env bash\nHERE="$(cd "$(dirname "$0")" && pwd)"\nexec bun "$HERE/hook.ts"\n');
    fixture('counted/hook.ts', 'export const ok = 1;\n');
    const r = runGate(['--report', path.join(FX, 'fx', 'counted')]);
    expect(r.code).toBe(0);
    expect(r.output).toContain('2 checked, 0 skipped');
  }, TEST_TIMEOUT_MS);

  test('python files are compiled, and no .pyc is written', () => {
    if (spawnSync('python3', ['--version'], { timeout: SPAWN_TIMEOUT_MS }).status !== 0) return;
    const ok = fixture('py/fine.py', '#!/usr/bin/env python3\nprint("ok")\n');
    const bad = fixture('py/broken.py', '#!/usr/bin/env python3\ndef f(:\n');
    const good = runGate([ok]);
    expect(good.output).toBe('');
    expect(good.code).toBe(0);
    const r = runGate([bad]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('FAILS TO PARSE');
    expect(fs.existsSync(path.join(FX, 'fx', 'py', '__pycache__'))).toBe(false);
  }, TEST_TIMEOUT_MS);

  test('an invalid escape in python fails; the raw-string spelling does not', () => {
    // Both directions, or the rule would simply ban docstrings that mention a
    // regex. Python reports an invalid escape as SyntaxWarning from 3.12 on.
    const v = spawnSync('python3', ['-c', 'import sys; print(sys.version_info[1] if sys.version_info[0] == 3 else 0)'], { encoding: 'utf-8', timeout: SPAWN_TIMEOUT_MS });
    if (v.status !== 0 || Number(v.stdout.trim()) < 12) return;
    const bad = runGate([fixture('py/escape.py', '#!/usr/bin/env python3\n"""matches \\s+"""\n')]);
    const raw = runGate([fixture('py/raw.py', '#!/usr/bin/env python3\nr"""matches \\s+"""\n')]);
    expect(bad.code).toBe(1);
    expect(raw.output).toBe('');
    expect(raw.code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test('an absent python interpreter is a coverage gap, and says so', () => {
    const bad = fixture('py2/broken.py', '#!/usr/bin/env python3\ndef f(:\n');
    const r = runGate(['--report', bad], { HOOK_SYNTAX_PYTHON: 'definitely-not-an-interpreter' });
    expect(r.code).toBe(0);
    expect(r.output).toContain('NOT checked');
    expect(r.output).toContain('0 checked, 1 skipped');
  }, TEST_TIMEOUT_MS);

  test('an absent bun is a coverage gap for the payload, and says so', () => {
    const r = runGate(['--report', path.join(SCRATCH, 'hosts/claude/hooks/timeline-stop-hook')], {
      HOOK_SYNTAX_BUN: 'definitely-not-bun',
    });
    expect(r.code).toBe(0);
    expect(r.output).toContain('NOT checked');
    // The shim still parses; only its payload goes uncovered.
    expect(r.output).toContain('1 checked, 1 skipped');
  }, TEST_TIMEOUT_MS);

  // An interpreter that is on PATH and fails every invocation: an asdf, mise
  // or pyenv shim with no version selected, or the xcode-select stub. It logs
  // each call, so the test can see the probe ran once, not once per file.
  function brokenInterpreter(name: string): { bin: string; calls: () => number } {
    const log = path.join(FX, 'fx', 'broken-interp', `${name}.calls`);
    const bin = fixture(`broken-interp/${name}`, `#!/bin/sh\necho call >> '${log}'\necho "${name}: no version is set" >&2\nexit 127\n`);
    fs.chmodSync(bin, 0o755);
    return { bin, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean).length : 0) };
  }

  test('a python3 that cannot run is a coverage gap, probed once, never "fails to parse"', () => {
    const py = brokenInterpreter('python3');
    const a = fixture('py-shim/a.py', '#!/usr/bin/env python3\nprint("ok")\n');
    const b = fixture('py-shim/b.py', '#!/usr/bin/env python3\nprint("ok")\n');
    const r = runGate(['--report', a, b], { HOOK_SYNTAX_PYTHON: py.bin });
    expect(r.code).toBe(0);
    expect(r.output).not.toContain('FAILS TO PARSE');
    expect(r.output).toContain('cannot run (exit 127)');
    expect(r.output).toContain('0 checked, 2 skipped');
    expect(py.calls()).toBe(1);
  }, TEST_TIMEOUT_MS);

  test('a bun that cannot run is a coverage gap for the payload, never "fails to parse"', () => {
    const bun = brokenInterpreter('bun');
    const r = runGate(['--report', path.join(SCRATCH, 'hosts/claude/hooks/timeline-stop-hook')], { HOOK_SYNTAX_BUN: bun.bin });
    expect(r.code).toBe(0);
    expect(r.output).not.toContain('FAILS TO PARSE');
    expect(r.output).toContain('cannot run (exit 127)');
    expect(r.output).toContain('1 checked, 1 skipped');
    expect(bun.calls()).toBe(1);
  }, TEST_TIMEOUT_MS);
});

// ── the bun payload arm ────────────────────────────────────────────────────

const SHIM = (target: string) => `#!/usr/bin/env bash\nHERE="$(cd "$(dirname "$0")" && pwd)"\nexec bun "$HERE/${target}"\n`;

describe('hook-syntax: bun payloads', () => {
  test('a broken module the payload IMPORTS fails too', () => {
    fixture('imports/hook', SHIM('hook.ts'));
    fixture('imports/hook.ts', "import { helper } from './helper';\nconsole.log(helper);\n");
    fixture('imports/helper.ts', 'export const helper: = {\n');
    const r = runGate([path.join(FX, 'fx', 'imports/hook')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('FAILS TO PARSE');
  }, TEST_TIMEOUT_MS);

  test('a local import that does not exist fails', () => {
    fixture('missing-import/hook', SHIM('hook.ts'));
    fixture('missing-import/hook.ts', "import { gone } from './gone';\nconsole.log(gone);\n");
    expect(runGate([path.join(FX, 'fx', 'missing-import/hook')]).code).toBe(1);
  }, TEST_TIMEOUT_MS);

  test('an npm import is left unresolved, so an install without node_modules is not refused', () => {
    // setup runs this gate before its own `bun install`. Resolving packages
    // would refuse every fresh clone for a reason that is not syntax.
    fixture('npm-import/hook', SHIM('hook.ts'));
    fixture('npm-import/hook.ts', "import { thing } from 'gstack-no-such-package-anywhere';\nconsole.log(thing);\n");
    const r = runGate([path.join(FX, 'fx', 'npm-import/hook')]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test('payload discovery is content-keyed, so an extension-less payload is still checked', () => {
    fixture('noext/hook', SHIM('payload-no-extension'));
    fixture('noext/payload-no-extension', 'const x: number = {\n');
    const r = runGate(['--report', path.join(FX, 'fx', 'noext/hook')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('payload-no-extension');
  }, TEST_TIMEOUT_MS);

  test('a commented-out bun invocation is not a payload', () => {
    // The gate's own header quotes the shim shape.
    const p = fixture('commented/hook', '#!/usr/bin/env bash\nHERE="$(pwd)"\n# exec bun "$HERE/never-existed.ts"\nexit 0\n');
    const r = runGate([p]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test('a payload a shim names but does not ship is a failure', () => {
    const r = runGate([fixture('missing/hook', SHIM('gone.ts'))]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('MISSING PAYLOAD');
  }, TEST_TIMEOUT_MS);
});

// ── house rules ────────────────────────────────────────────────────────────

describe('hook-syntax: house rules', () => {
  test('the gate ships a /bin/bash shebang and carries no heredoc', () => {
    // A PATH bash on macOS is Homebrew's 5.x, which can deadlock writing a
    // heredoc body.
    expect(GATE_SRC.split('\n')[0]).toBe('#!/bin/bash');
    expect(GATE_SRC.split('\n').filter(l => !/^\s*#/.test(l)).some(l => /<<-?\s*['"]?[A-Z]+/.test(l))).toBe(false);
  });

  test('the gate cannot be switched off by an environment variable', () => {
    // HOOK_SYNTAX_PYTHON and HOOK_SYNTAX_BUN are interpreter-name seams for
    // this suite and are deliberately not matched here.
    const offSwitch = /HOOK_SYNTAX_(SKIP|DISABLE|OFF|BYPASS)([^A-Za-z0-9_]|$)/;
    expect(offSwitch.test(GATE_SRC)).toBe(false);
    expect(offSwitch.test(SETUP_SRC)).toBe(false);
  });

  test('the shebang dispatch never keys on a file extension', () => {
    const kind = GATE_SRC.slice(GATE_SRC.indexOf('_hook_syntax_kind() {'));
    const body = kind.slice(0, kind.indexOf('\n}\n'));
    expect(body).toContain("'#!/bin/bash'");
    expect(body).not.toMatch(/\*\.(sh|bash|py|template)/);
  });

  test('the marker scan is separate from the parse, and skips the unlabelled = rule', () => {
    const scan = GATE_SRC.slice(GATE_SRC.indexOf('_hook_syntax_markers() {'));
    const body = scan.slice(0, scan.indexOf('\n}\n'));
    expect(body).toContain('[<]{7}');
    expect(body).toContain('[>]{7}');
    expect(body).toContain('[|]{7}');
    expect(body).not.toContain('[=]{7}');
  });
});

// ── ./setup, the consumer ──────────────────────────────────────────────────

// A minimal install tree: `setup`, the gate, whatever hook fixture the test
// wants, and stubs for the first tree code setup runs AFTER the gate. Each
// stub announces itself on stdout and exits. Without them, a setup that merely
// WARNED and carried on would still die a line later on a missing file, and a
// refusal test could not tell "refused" from "warned, then fell over". With
// them, getting past the gate is observed, never inferred.
//
// Two stubs, because the first thing setup runs after the gate depends on the
// setup: newer ones source bin/gstack-state-root.sh straight away (stderr
// discarded, hence stdout), older ones reach scripts/preflight-codex-overlap.ts
// first and turn any failure there into `exit 1`. The marker is the signal;
// the exit code after it is the stub's business.
const PAST_GATE = 'PAST THE GATE';

function mkSetupTree(): { dir: string; home: string } {
  const dir = fs.mkdtempSync(path.join(FX, 'setup-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  for (const sub of ['scripts', 'bin', 'hosts/claude/hooks']) {
    fs.mkdirSync(path.join(dir, 'tree', sub), { recursive: true });
  }
  fs.copyFileSync(SETUP_SCRIPT, path.join(dir, 'tree', 'setup'));
  fs.chmodSync(path.join(dir, 'tree', 'setup'), 0o755);
  fs.copyFileSync(GATE, path.join(dir, 'tree', 'scripts', 'hook-syntax.sh'));
  fs.writeFileSync(path.join(dir, 'tree', 'bin', 'gstack-state-root.sh'), `echo "${PAST_GATE}"\nexit 7\n`);
  fs.writeFileSync(path.join(dir, 'tree', 'scripts', 'preflight-codex-overlap.ts'), `console.log(${JSON.stringify(PAST_GATE)});\nprocess.exit(7);\n`);
  return { dir, home };
}

function runSetup(dir: string, home: string): Run {
  // A scrubbed env: if the gate ever let setup through by mistake, every
  // write must land in the scratch HOME, never in a real GSTACK_HOME,
  // CLAUDE_CONFIG_DIR or CODEX_HOME inherited from the caller.
  const r = spawnSync('/bin/bash', [path.join(dir, 'tree', 'setup'), '--no-prefix', '--no-team'], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: path.join(dir, 'tmp') },
    cwd: path.join(dir, 'tree'),
    encoding: 'utf-8',
    timeout: SPAWN_TIMEOUT_MS,
  });
  return { code: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function homeIsEmpty(home: string): boolean {
  return fs.readdirSync(home).length === 0;
}

// What every refusal must look like: setup's own exit 1, the refusal banner,
// nothing after the gate reached, nothing written.
function expectRefused(r: Run, home: string): void {
  expect(r.output).toContain('REFUSING TO REGISTER');
  expect(r.output).not.toContain(PAST_GATE);
  expect(r.code).toBe(1);
  expect(homeIsEmpty(home)).toBe(true);
}

describe('setup: the gate refuses before anything is installed', () => {
  test('setup refuses a tree whose PreToolUse hook does not parse', () => {
    const { dir, home } = mkSetupTree();
    fs.writeFileSync(path.join(dir, 'tree', 'hosts', 'claude', 'hooks', 'question-preference-hook'), '#!/usr/bin/env bash\nif true; then\n');
    const r = runSetup(dir, home);
    expectRefused(r, home);
    expect(r.output).toContain('question-preference-hook');
  }, TEST_TIMEOUT_MS);

  test('setup refuses a half-merged hook that still parses', () => {
    const { dir, home } = mkSetupTree();
    fs.writeFileSync(path.join(dir, 'tree', 'hosts', 'claude', 'hooks', 'timeline-stop-hook'), `#!/usr/bin/env bash\n${CONFLICT_HEREDOC}`);
    const r = runSetup(dir, home);
    expectRefused(r, home);
    expect(r.output).toContain('UNRESOLVED CONFLICT MARKERS');
  }, TEST_TIMEOUT_MS);

  test('setup refuses when the gate ITSELF is missing', () => {
    // Deleting the checker must not be a way past it. setup and the checker
    // ship in the same commit, so a missing checker means a partial checkout —
    // the state the gate exists to catch.
    const { dir, home } = mkSetupTree();
    fs.rmSync(path.join(dir, 'tree', 'scripts', 'hook-syntax.sh'));
    const r = runSetup(dir, home);
    expectRefused(r, home);
    expect(r.output).toContain('hook parse gate is missing');
  }, TEST_TIMEOUT_MS);

  test('control: a healthy tree gets past the gate', () => {
    // Same minimal tree, nothing broken: a stub is reached, and it stops
    // setup before it writes anything.
    const { dir, home } = mkSetupTree();
    fs.writeFileSync(path.join(dir, 'tree', 'hosts', 'claude', 'hooks', 'question-preference-hook'), '#!/usr/bin/env bash\nexit 0\n');
    const r = runSetup(dir, home);
    expect(r.output).not.toContain('REFUSING TO REGISTER');
    expect(r.output).not.toContain('hook-syntax:');
    expect(r.output).toContain(PAST_GATE);
    expect(r.code).not.toBe(0);
    expect(homeIsEmpty(home)).toBe(true);
  }, TEST_TIMEOUT_MS);

  for (const code of [2, 127]) {
    test(`a gate that exits ${code} is "could not run", never "does not parse"`, () => {
      // 126/127: the interpreter could not exec the checker. 2: an old bash in
      // POSIX mode rejected its process substitution. Nothing was checked, so
      // setup still refuses, but must not send anyone hunting for a broken file.
      const { dir, home } = mkSetupTree();
      fs.writeFileSync(path.join(dir, 'tree', 'scripts', 'hook-syntax.sh'), `#!/bin/bash\nexit ${code}\n`);
      const r = runSetup(dir, home);
      expectRefused(r, home);
      expect(r.output).toContain('the hook parse gate could not run');
      expect(r.output).toContain(`exited ${code}`);
      expect(r.output).not.toContain('does not parse,');
    }, TEST_TIMEOUT_MS);
  }

  test('setup prefers /bin/bash, and falls back to the bash running it, never a bare PATH bash first', () => {
    // No env seam on purpose: an overridable interpreter would let `/bin/true`
    // stand in for the gate.
    expect(SETUP_SRC).toContain('_HOOK_SYNTAX_BASH=/bin/bash\n[ -x "$_HOOK_SYNTAX_BASH" ] || _HOOK_SYNTAX_BASH="${BASH:-bash}"');
    expect(SETUP_SRC).toContain('"$_HOOK_SYNTAX_BASH" "$HOOK_SYNTAX_GATE" "$SOURCE_GSTACK_DIR" || _hook_syntax_rc=$?');
  });

  test('the gate runs before setup sources, executes or writes anything', () => {
    // Kills "gate moved below the deploy step" directly, in case a refactor
    // lets a refusal reach a write before it exits. A helper DEFINITION writes
    // nothing until it is called, so only top-level lines count.
    const gateAt = SETUP_SRC.indexOf('HOOK_SYNTAX_GATE="$SOURCE_GSTACK_DIR/scripts/hook-syntax.sh"');
    expect(gateAt).toBeGreaterThan(-1);
    let offset = 0;
    let inFunction = false;
    let firstUse = -1;
    for (const line of SETUP_SRC.split('\n')) {
      if (/^[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{\s*$/.test(line)) inFunction = true;
      else if (inFunction && line === '}') inFunction = false;
      else if (!inFunction && firstUse < 0) {
        const t = line.trim();
        if (!t.startsWith('#') && (
          /^(mkdir|ln|cp|rm|mv|_link_or_copy)\s/.test(t)
          || /^(\.|source)\s+"\$SOURCE_GSTACK_DIR\//.test(t)
          || /^bun\s+"\$SOURCE_GSTACK_DIR\//.test(t)
        )) firstUse = offset;
      }
      offset += line.length + 1;
    }
    expect(firstUse).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(firstUse);
  });
});
