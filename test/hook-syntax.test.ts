/**
 * hook-syntax.test.ts — pins the hook parse gate (scripts/hook-syntax.sh) and
 * its consumer, ./setup.
 *
 * WHY. On 2026-08-27 `~/.claude/hooks/secret-guard.sh` sat on disk mid-merge
 * with unresolved conflict markers. It is a PreToolUse hook, so every Bash call
 * in every Claude Code session on the machine failed — a bare `echo` included.
 * That file belongs to another repo, which gates its own tree now. It cannot
 * gate this one, and gstack ships hooks of its own: `./setup` registers four
 * into ~/.claude/settings.json, one of them PreToolUse, and the /careful,
 * /freeze and /guard skills document two more PreToolUse hooks users wire by
 * hand.
 *
 * The properties worth defending, in order:
 *   1. it FAILS on an unparseable file — a gate never shown to fail is not a
 *      gate — and the report names the file AND the line
 *   2. it is SILENT on a healthy tree; a chattering gate gets routed around
 *   3. it does not claim coverage it lacks: files with no shebang are SKIPPED,
 *      and skipped is reported as skipped, never counted as checked
 *   4. every WIRED hook is inside what it parses, payload included, so a green
 *      sweep is not vacuous
 *   5. `./setup` refuses BEFORE it creates, links, copies or registers anything
 */
import { describe, test, expect, beforeAll } from 'bun:test';
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
// the start of a line. `.ts` files are skipped by the gate today (and skipped
// files are not marker-scanned), but a fixture that could trip the gate under
// test is a self-inflicted red waiting for the day that changes.
const LT = '<'.repeat(7);
const EQ = '='.repeat(7);
const GT = '>'.repeat(7);
const PIPE = '|'.repeat(7);

// The hooks `./setup` registers in ~/.claude/settings.json, plus the two the
// /careful, /freeze and /guard skill docs tell users to wire by hand. Paths
// are relative to the repo root; the event is what a broken one takes down.
const WIRED_HOOKS: { rel: string; event: string; payload: boolean }[] = [
  { rel: 'hosts/claude/hooks/question-preference-hook', event: 'PreToolUse', payload: true },
  { rel: 'hosts/claude/hooks/question-log-hook', event: 'PostToolUse', payload: true },
  { rel: 'hosts/claude/hooks/auq-error-fallback-hook', event: 'PostToolUse', payload: true },
  { rel: 'hosts/claude/hooks/timeline-stop-hook', event: 'Stop', payload: true },
  { rel: 'bin/gstack-session-update', event: 'SessionStart', payload: false },
  { rel: 'careful/bin/check-careful.sh', event: 'PreToolUse', payload: false },
  { rel: 'freeze/bin/check-freeze.sh', event: 'PreToolUse', payload: false },
];

// A whole-repo sweep is ~2s idle and several times that when the rest of the
// free suite is running its shards alongside it. bun's 5s default turns that
// into a load-dependent flake, which is the one failure mode a gate must not
// have — a red nobody trusts gets routed around exactly like a chatty one.
const FULL_SWEEP_TIMEOUT_MS = 120_000;

type Run = { code: number; output: string };

function runGate(args: string[], env: Record<string, string> = {}): Run {
  const r = spawnSync('/bin/bash', [GATE, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 120_000,
  });
  return { code: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

let FX = '';
beforeAll(() => {
  FX = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hook-syntax-'));
});

function fixture(name: string, body: string): string {
  const p = path.join(FX, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

// ── the real tree ──────────────────────────────────────────────────────────

describe('hook-syntax: the real gstack tree', () => {
  test('parses, and the gate says nothing about it', () => {
    const r = runGate([ROOT]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
  }, FULL_SWEEP_TIMEOUT_MS);

  test('the sweep actually parsed something — green is not vacuous', () => {
    const r = runGate(['--report', ROOT]);
    expect(r.code).toBe(0);
    const m = r.output.match(/hook-syntax: (\d+) checked, (\d+) skipped/);
    expect(m).not.toBeNull();
    // 91 at the time of writing (87 shell/python + 4 bun payloads). A floor
    // rather than the exact number: this must not go red every time a script
    // lands, but it must catch a sweep that silently stopped finding files.
    expect(Number(m![1])).toBeGreaterThanOrEqual(80);
  }, FULL_SWEEP_TIMEOUT_MS);

  for (const hook of WIRED_HOOKS) {
    test(`the wired ${hook.event} hook ${hook.rel} is parsed, not skipped`, () => {
      expect(fs.existsSync(path.join(ROOT, hook.rel))).toBe(true);
      const r = runGate(['--report', path.join(ROOT, hook.rel)]);
      expect(r.code).toBe(0);
      // A shim that hands a file to bun is two checks: the shim, and the
      // payload that actually runs.
      expect(r.output).toContain(`${hook.payload ? 2 : 1} checked, 0 skipped`);
    });
  }

  test('a conflict marker in the PreToolUse hook itself is caught', () => {
    // The file that can do to a machine what secret-guard.sh did. Copied, then
    // given the 2026-08-27 shape in a form `bash -n` alone would pass: markers
    // inside a quoted heredoc body parse cleanly.
    const src = fs.readFileSync(path.join(ROOT, 'hosts/claude/hooks/question-preference-hook'), 'utf-8');
    const p = fixture(
      'pretool/question-preference-hook',
      `${src}\ncat <<'HOOKEOF'\n${LT} HEAD\na\n${EQ}\nb\n${GT} other\nHOOKEOF\n`,
    );

    // Guard the premise: parsing alone would MISS this.
    expect(spawnSync('/bin/bash', ['-n', p]).status).toBe(0);

    const r = runGate([p]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('UNRESOLVED CONFLICT MARKERS');
    expect(r.output).toContain('question-preference-hook');
  });
});

// ── sweep mechanics ────────────────────────────────────────────────────────

describe('hook-syntax: sweep mechanics', () => {
  test('descends into nested directories and names the file', () => {
    fixture('deep/top.sh', '#!/bin/bash\nexit 0\n');
    fixture('deep/lib/broken.sh', '#!/bin/bash\nif true; then\n');
    const r = runGate([path.join(FX, 'deep')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('lib/broken.sh');
  });

  test('one broken file does not hide the next', () => {
    fixture('two/lib/broken.sh', '#!/bin/bash\nif true; then\n');
    fixture('two/inner/also-broken.sh', '#!/bin/bash\nwhile true; do\n');
    const r = runGate([path.join(FX, 'two')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('lib/broken.sh');
    expect(r.output).toContain('inner/also-broken.sh');
  });

  test('node_modules is pruned, not swept', () => {
    fixture('pruned-nm/ok.sh', '#!/bin/bash\nexit 0\n');
    fixture('pruned-nm/node_modules/junk/vendored.sh', '#!/bin/bash\nif true; then\n');
    const r = runGate([path.join(FX, 'pruned-nm')]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
  });

  test('.build is pruned — vendored SwiftPM checkouts carry sample git hooks', () => {
    // ios-qa/scripts/gen-accessors-tool/.build is a real, untracked SwiftPM
    // tree in this repo. Its vendored .sample hooks are not gstack's to fix.
    fixture('pruned-build/ok.sh', '#!/bin/bash\nexit 0\n');
    fixture('pruned-build/.build/checkouts/x/hooks/pre-commit.sample', '#!/bin/sh\ncase x in\n');
    const r = runGate([path.join(FX, 'pruned-build')]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
  });

  test('a directory argument is swept, not read as a file', () => {
    // Reading a directory would find no shebang and report a clean skip — a
    // pass for something never looked at.
    fixture('asdir/broken.sh', '#!/bin/bash\nif true; then\n');
    expect(runGate([path.join(FX, 'asdir')]).code).toBe(1);
  });
});

// ── per-file verdicts ──────────────────────────────────────────────────────

describe('hook-syntax: per-file verdicts', () => {
  test('a healthy file is silent', () => {
    const r = runGate([fixture('fine.sh', '#!/bin/bash\necho fine\n')]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
  });

  test('an unclosed if fails, naming the file and the line', () => {
    const r = runGate([fixture('unclosed.sh', '#!/bin/bash\nif true; then\n  echo hi\n')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('FAILS TO PARSE');
    expect(r.output).toContain('unclosed.sh');
    // The line number is the difference between "a hook is broken" and the
    // 2026-08-27 message, which pointed straight at line 771.
    expect(r.output).toContain('line 4');
  });

  test('env-bash and sh shebangs are covered too', () => {
    expect(runGate([fixture('env-bash.sh', '#!/usr/bin/env bash\ncase x in\n')]).code).toBe(1);
    expect(runGate([fixture('plain-sh.sh', '#!/bin/sh\nfoo() {\n')]).code).toBe(1);
  });

  test('an unreadable file is a failure, not a skip', () => {
    const p = fixture('locked.sh', '#!/bin/bash\nexit 0\n');
    fs.chmodSync(p, 0o000);
    try {
      fs.accessSync(p, fs.constants.R_OK);
      return; // running with read-anything privileges; nothing to assert
    } catch {
      // expected: genuinely unreadable
    }
    const r = runGate([p]);
    fs.chmodSync(p, 0o600);
    expect(r.code).toBe(1);
    expect(r.output).toContain('UNREADABLE');
  });
});

// ── conflict markers, which are NOT the same check as parsing ──────────────

describe('hook-syntax: conflict markers', () => {
  test('top-level conflict markers fail', () => {
    const p = fixture('conflicted.sh', `#!/bin/bash\n${LT} HEAD\necho a\n${EQ}\necho b\n${GT} other\n`);
    expect(runGate([p]).code).toBe(1);
  });

  test('markers inside a heredoc body fail, though the file parses', () => {
    const p = fixture(
      'heredoc-conflict.sh',
      `#!/bin/bash\ncat <<'EOF'\n${LT} HEAD\na\n${EQ}\nb\n${GT} other\nEOF\n`,
    );
    expect(spawnSync('/bin/bash', ['-n', p]).status).toBe(0); // guard the premise
    const r = runGate([p]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('UNRESOLVED CONFLICT MARKERS');
  });

  test('the diff3 base marker fails too', () => {
    const p = fixture('conflict-base.sh', `#!/bin/bash\ncat <<'EOF'\n${PIPE} base\nEOF\n`);
    expect(runGate([p]).code).toBe(1);
  });

  test('an = banner rule is not a conflict marker', () => {
    // This repo draws plenty. The `=` separator is deliberately not in the
    // scanned set: git writes it with no label, so it cannot be told apart
    // from a rule. Nothing is lost — a real conflict writes the labelled
    // markers too.
    // Both shapes: a commented rule, and a bare run at column 0 inside a
    // heredoc — the latter is what git's own unlabelled separator looks like,
    // and is indistinguishable from a banner.
    const p = fixture(
      'banner.sh',
      `#!/bin/bash\n# ${EQ}${EQ}\n#${EQ}\ncat <<'EOF'\n${EQ}\nEOF\n: done\n`,
    );
    const r = runGate([p]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
  });

  test('the trailing label is what separates a conflict from a rule', () => {
    // git always writes a ref name after the opening marker. A bare run of
    // seven characters is a comment rule or a doc quoting the shape and must
    // not fire; the same line with a label must. Both fixtures sit inside a
    // quoted heredoc so `bash -n` passes either way and only the marker scan
    // decides.
    const bare = fixture('bare.sh', `#!/bin/bash\ncat <<'EOF'\n${LT}\na\nEOF\n`);
    const labelled = fixture('labelled.sh', `#!/bin/bash\ncat <<'EOF'\n${LT} HEAD\na\nEOF\n`);
    expect(spawnSync('/bin/bash', ['-n', bare]).status).toBe(0);
    expect(spawnSync('/bin/bash', ['-n', labelled]).status).toBe(0);

    const clean = runGate([bare]);
    expect(clean.output).toBe('');
    expect(clean.code).toBe(0);

    const dirty = runGate([labelled]);
    expect(dirty.code).toBe(1);
    expect(dirty.output).toContain('UNRESOLVED CONFLICT MARKERS');
  });
});

// ── what is skipped, and honestly reported as skipped ──────────────────────

describe('hook-syntax: honest coverage', () => {
  test('a TypeScript file no shim reaches is skipped, not counted as checked', () => {
    // Reporting it as checked would be a coverage claim this gate cannot back:
    // nothing hands this file to an interpreter.
    const p = fixture('orphan.ts', 'const x: number = {\n');
    const r = runGate(['--report', p]);
    expect(r.code).toBe(0);
    expect(r.output).toContain('0 checked, 1 skipped');
  });

  test('a file with no shebang is skipped', () => {
    const r = runGate(['--report', fixture('no-shebang', 'if true; then\n')]);
    expect(r.code).toBe(0);
    expect(r.output).toContain('0 checked, 1 skipped');
  });

  test('python files are compiled, and no .pyc is written', () => {
    if (spawnSync('python3', ['--version']).status !== 0) return;
    const ok = fixture('py/fine.py', '#!/usr/bin/env python3\nprint("ok")\n');
    const bad = fixture('py/broken.py', '#!/usr/bin/env python3\ndef f(:\n');

    const good = runGate([ok]);
    expect(good.output).toBe('');
    expect(good.code).toBe(0);

    const r = runGate([bad]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('FAILS TO PARSE');
    expect(fs.existsSync(path.join(FX, 'py', '__pycache__'))).toBe(false);
  });

  test('an absent python interpreter is a coverage gap, and says so', () => {
    // The trap this defends: a check that answers its own error with a pass.
    const bad = fixture('py2/broken.py', '#!/usr/bin/env python3\ndef f(:\n');
    const r = runGate(['--report', bad], { HOOK_SYNTAX_PYTHON: 'definitely-not-an-interpreter' });
    expect(r.code).toBe(0);
    expect(r.output).toContain('NOT checked');
    expect(r.output).toContain('0 checked, 1 skipped');
  });

  test('an absent bun is a coverage gap for the payload, and says so', () => {
    const r = runGate(['--report', path.join(ROOT, 'hosts/claude/hooks/timeline-stop-hook')], {
      HOOK_SYNTAX_BUN: 'definitely-not-bun',
    });
    expect(r.code).toBe(0);
    expect(r.output).toContain('NOT checked');
    // The shim still parses; only its payload goes uncovered.
    expect(r.output).toContain('1 checked, 1 skipped');
  });
});

// ── the bun payload arm ────────────────────────────────────────────────────

describe('hook-syntax: bun payloads', () => {
  test('a broken payload fails through its shim, which parses fine on its own', () => {
    fixture('payload/hook', '#!/usr/bin/env bash\nHERE="$(cd "$(dirname "$0")" && pwd)"\nexec bun "$HERE/hook.ts"\n');
    fixture('payload/hook.ts', 'const x: number = {\n');

    // Guard the premise: the shim itself is perfectly good bash.
    expect(spawnSync('/bin/bash', ['-n', path.join(FX, 'payload/hook')]).status).toBe(0);

    const r = runGate([path.join(FX, 'payload/hook')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('FAILS TO PARSE');
    expect(r.output).toContain('hook.ts');
  });

  test('a broken module the payload IMPORTS fails too', () => {
    // All four wired payloads import ./spawn-bin. Parsing only the entrypoint
    // would leave the shared helper — and lib/, and scripts/ — uncovered.
    fixture('imports/hook', '#!/usr/bin/env bash\nHERE="$(cd "$(dirname "$0")" && pwd)"\nexec bun "$HERE/hook.ts"\n');
    fixture('imports/hook.ts', "import { helper } from './helper';\nconsole.log(helper);\n");
    fixture('imports/helper.ts', 'export const helper: = {\n');

    const r = runGate([path.join(FX, 'imports/hook')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('FAILS TO PARSE');
  });

  test('payload discovery is content-keyed, so an extension-less payload is still checked', () => {
    // The trap: an extension-keyed sweep in a sibling repo missed three of
    // four wired hooks because they end in `.template`, and still reported
    // green. Nothing here looks at an extension.
    fixture('noext/hook', '#!/usr/bin/env bash\nHERE="$(cd "$(dirname "$0")" && pwd)"\nexec bun "$HERE/payload-no-extension"\n');
    fixture('noext/payload-no-extension', 'const x: number = {\n');

    const r = runGate(['--report', path.join(FX, 'noext/hook')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('payload-no-extension');
  });

  test('a commented-out bun invocation is not a payload', () => {
    // This gate\'s own header quotes the shim shape. Matching a comment made
    // it report a missing payload against itself.
    const p = fixture('commented/hook', '#!/usr/bin/env bash\nHERE="$(pwd)"\n# exec bun "$HERE/never-existed.ts"\nexit 0\n');
    const r = runGate([p]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
  });

  test('a payload a shim names but does not ship is a failure', () => {
    const p = fixture('missing/hook', '#!/usr/bin/env bash\nHERE="$(cd "$(dirname "$0")" && pwd)"\nexec bun "$HERE/gone.ts"\n');
    const r = runGate([p]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('MISSING PAYLOAD');
  });
});

// ── house rules ────────────────────────────────────────────────────────────

describe('hook-syntax: house rules', () => {
  test('the gate ships a /bin/bash shebang', () => {
    // Homebrew bash 5.3 heredoc deadlock: #!/usr/bin/env bash is banned for a
    // file this hot.
    expect(GATE_SRC.split('\n')[0]).toBe('#!/bin/bash');
  });

  test('the gate cannot be switched off by an environment variable', () => {
    // If a skip switch is ever added it belongs in a failure message, not in a
    // hook. HOOK_SYNTAX_PYTHON and HOOK_SYNTAX_BUN are interpreter-name seams
    // for this suite and are deliberately not matched here.
    const offSwitch = /HOOK_SYNTAX_(SKIP|DISABLE|OFF)([^A-Za-z0-9_]|$)/;
    expect(offSwitch.test(GATE_SRC)).toBe(false);
    expect(offSwitch.test(SETUP_SRC)).toBe(false);
  });

  test('the sweep dispatches on the shebang, never on a file extension', () => {
    // The regression this kills: keying the sweep on `*.sh`. Three of four
    // wired hooks in a sibling repo end in `.template`; an extension-keyed
    // sweep missed all three and still reported green.
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

// A minimal install tree: `setup` and the gate, plus whatever hook fixture the
// test wants. The gate sits above every path that reads more than this, so a
// refusal never gets far enough to need the rest of the repo.
function mkSetupTree(): { dir: string; home: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-setup-gate-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(dir, 'tree', 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tree', 'hosts', 'claude', 'hooks'), { recursive: true });
  fs.copyFileSync(SETUP_SCRIPT, path.join(dir, 'tree', 'setup'));
  fs.chmodSync(path.join(dir, 'tree', 'setup'), 0o755);
  fs.copyFileSync(GATE, path.join(dir, 'tree', 'scripts', 'hook-syntax.sh'));
  return { dir, home };
}

function runSetup(tree: string, home: string): Run {
  const r = spawnSync('/bin/bash', [path.join(tree, 'tree', 'setup'), '--no-prefix', '--no-team'], {
    env: { ...process.env, HOME: home },
    cwd: path.join(tree, 'tree'),
    encoding: 'utf-8',
    timeout: 120_000,
  });
  return { code: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('setup: the gate refuses before anything is installed', () => {
  test('setup refuses a tree whose hook does not parse', () => {
    const { dir, home } = mkSetupTree();
    fs.writeFileSync(
      path.join(dir, 'tree', 'hosts', 'claude', 'hooks', 'question-preference-hook'),
      '#!/usr/bin/env bash\nif true; then\n',
    );
    const r = runSetup(dir, home);
    expect(r.code).not.toBe(0);
    expect(r.output).toContain('REFUSING TO REGISTER');
    expect(r.output).toContain('question-preference-hook');
  }, FULL_SWEEP_TIMEOUT_MS);

  test('setup refuses a half-merged hook that still parses', () => {
    const { dir, home } = mkSetupTree();
    fs.writeFileSync(
      path.join(dir, 'tree', 'hosts', 'claude', 'hooks', 'timeline-stop-hook'),
      `#!/usr/bin/env bash\ncat <<'HOOKEOF'\n${LT} HEAD\na\n${EQ}\nb\n${GT} other\nHOOKEOF\n`,
    );
    const r = runSetup(dir, home);
    expect(r.code).not.toBe(0);
    expect(r.output).toContain('UNRESOLVED CONFLICT MARKERS');
  }, FULL_SWEEP_TIMEOUT_MS);

  test('setup creates nothing at all when it refuses', () => {
    // Registering an unparseable hook is what makes one file everyone's
    // problem. The gate has to sit above the install, not merely report after
    // it — checked functionally, not by reading the order of lines in setup.
    const { dir, home } = mkSetupTree();
    fs.writeFileSync(
      path.join(dir, 'tree', 'hosts', 'claude', 'hooks', 'question-log-hook'),
      '#!/usr/bin/env bash\ncase x in\n',
    );
    const r = runSetup(dir, home);
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(path.join(home, '.claude'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.gstack'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
  }, FULL_SWEEP_TIMEOUT_MS);

  test('setup invokes the gate with /bin/bash, never a bare bash', () => {
    expect(SETUP_SRC).toContain('/bin/bash "$HOOK_SYNTAX_GATE"');
  });

  test('the gate is invoked above the first mkdir, ln or copy in setup', () => {
    // Kills the "gate moved below the deploy step" regression directly, in
    // case a future refactor makes a refusal reach a write before exiting.
    const gateAt = SETUP_SRC.indexOf('HOOK_SYNTAX_GATE="$SOURCE_GSTACK_DIR/scripts/hook-syntax.sh"');
    expect(gateAt).toBeGreaterThan(-1);

    const lines = SETUP_SRC.split('\n');
    let offset = 0;
    let inFunction = false;
    let firstWrite = -1;
    for (const line of lines) {
      // A helper definition writes nothing until it is called, so the `rm -rf`
      // inside _link_or_copy is not the first write — the first CALL is, and
      // every call site sits far below the gate.
      if (/^[A-Za-z_][A-Za-z0-9_]*\(\)\s*\{\s*$/.test(line)) inFunction = true;
      else if (inFunction && line === '}') inFunction = false;
      else if (!inFunction && firstWrite < 0) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('#') && /^(mkdir|ln|cp|rm|_link_or_copy)\s/.test(trimmed)) {
          firstWrite = offset;
        }
      }
      offset += line.length + 1;
    }
    expect(firstWrite).toBeGreaterThan(-1);
    expect(gateAt).toBeLessThan(firstWrite);
  });
});
