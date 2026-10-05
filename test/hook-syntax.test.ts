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
import { cleanupFixtures, makeFixture, makeSource, put, type Fixture } from './helpers/install-fixture';

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

// The UTF-8 locales a byte-level case runs under: C.UTF-8 and en_US.UTF-8,
// each only where the host has it (ubuntu:24.04 has no en_US.UTF-8). bash
// counts the two bytes of U+00E9 as one character only in a UTF-8 locale. A
// missing locale falls back to C, where a case passes without proving
// anything, and bash warns on stderr at startup and each time it switches
// back to it, which fails a case that expects no output. A case with neither
// locale is skipped.
const UTF8_LOCALES = ['C.UTF-8', 'en_US.UTF-8'].filter(loc => {
  const r = spawnSync('/bin/bash', ['-c', 'x=$(printf "\\303\\251"); [ "${#x}" = 1 ]'], { env: { ...process.env, LC_ALL: loc }, stdio: 'ignore', timeout: 30_000 });
  if (r.status === null) throw new Error(`UTF-8 locale probe for ${loc}: ${r.error ?? r.signal}`);
  return r.status === 0;
});

// Each turns on POSIX mode in a bash it starts. `set +o posix` unbinds the
// first and edits the second; the third stays exported to every child.
const POSIX_ENVS: Array<[string, Record<string, string>]> = [
  ['POSIXLY_CORRECT=1', { POSIXLY_CORRECT: '1' }],
  ['SHELLOPTS=posix', { SHELLOPTS: 'posix' }],
  ['POSIX_PEDANTIC=1', { POSIX_PEDANTIC: '1' }],
];

// Whether the temp filesystem keeps a name that is not valid UTF-8. APFS
// refuses one (EILSEQ); overlayfs and ext4 keep the bytes as given.
const BYTE_NAMES = (() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hook-syntax-name-'));
  try {
    fs.writeFileSync(Buffer.concat([Buffer.from(`${dir}/caf`), Buffer.from([0xe9])]), '');
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EILSEQ') return false;
    throw e;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();

// One gate run costs a bash fork per file plus a bun bundle per payload. That
// is well under a second on an idle machine and many times that while the rest
// of the free suite runs its shards alongside. bun's 5s default would turn that
// into a load-dependent flake — the one failure mode a gate must not have.
const SPAWN_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = 150_000;
const SWEEP_TIMEOUT_MS = 240_000;

type Run = { code: number; output: string };
type Captured = { status: number | null; signal: string | null; stdout: string; stderr: string };

// Child output goes through files, never pipes. Under heavy load Bun 1.3's
// spawnSync has returned the right exit status with an EMPTY piped stderr (1
// spawn in 2,400 in a churn loop, against 0 in 2,400 through file
// descriptors), and every verdict this file checks is printed on stderr: a lost
// pipe reads as a silent gate. Status-only spawns keep spawnSync.
function spawnCaptured(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {}): Captured {
  const io = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-hook-syntax-io-'));
  const outFd = fs.openSync(path.join(io, 'out'), 'w');
  const errFd = fs.openSync(path.join(io, 'err'), 'w');
  try {
    const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', outFd, errFd], timeout: opts.timeout ?? SPAWN_TIMEOUT_MS });
    return {
      status: r.status,
      signal: r.signal ?? null,
      stdout: fs.readFileSync(path.join(io, 'out'), 'utf-8'),
      stderr: fs.readFileSync(path.join(io, 'err'), 'utf-8'),
    };
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    fs.rmSync(io, { recursive: true, force: true });
  }
}

// A child killed by a signal (the spawn timeout included) has no exit status.
// It reads as -1, never as 1: a gate that hung until it was killed must not
// pass a case that expects the refusal status.
function codeOf(r: Captured): number {
  return r.status ?? -1;
}

function runGate(args: string[], env: Record<string, string> = {}): Run {
  return runGateWith('/bin/bash', args, env);
}

function runGateWith(bash: string, args: string[], env: Record<string, string> = {}): Run {
  const r = spawnCaptured(bash, [GATE, ...args], { env: { ...process.env, ...env } });
  const killed = r.signal ? `\n[killed by ${r.signal}]` : '';
  return { code: codeOf(r), output: `${r.stdout}${r.stderr}${killed}`.trim() };
}

// /bin/bash, and the PATH bash when it is another one. /bin/bash is 3.2 on
// macOS and 5 on Linux; a Mac's PATH bash is usually Homebrew's 5. Cases that
// turn on how a newer bash behaves run under both, and prove it only where one
// is new enough.
function hostBashes(): string[] {
  return [...new Set(['/bin/bash', spawnCaptured('/bin/bash', ['-c', 'command -v bash']).stdout.trim()])].filter(Boolean);
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

// Skills register hooks in their frontmatter; they run whenever the skill is
// active. Some are written in the template (`bash $HOME/.claude/skills/gstack/
// <rel>`), and some are injected when SKILL.md is generated (/autoplan's,
// inside a `bash -c` wrapper), so both files are read, and any installed path
// a hook command names counts.
function frontmatterHooks(): Wired[] {
  const out = new Map<string, Wired>();
  for (const dir of fs.readdirSync(ROOT)) {
    for (const name of ['SKILL.md.tmpl', 'SKILL.md']) {
      const file = path.join(ROOT, dir, name);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf-8');
      if (!text.startsWith('---\n')) continue;
      const front = text.slice(4, text.indexOf('\n---', 4));
      if (!/^hooks:/m.test(front)) continue;
      let event = '';
      for (const line of front.split('\n')) {
        const ev = line.match(/^ {2}([A-Za-z]+):\s*$/);
        if (ev) event = ev[1];
        if (!/^\s*command:/.test(line)) continue;
        for (const m of line.matchAll(/\$HOME\/\.claude\/skills\/gstack\/([A-Za-z0-9_.\/-]+)/g)) {
          const rel = m[1];
          if (!out.has(rel) && fs.existsSync(path.join(ROOT, rel))) out.set(rel, { rel, event, source: `${dir}/${name} frontmatter` });
        }
      }
    }
  }
  return [...out.values()];
}

const WIRED: Wired[] = [...knownHooks(), ...frontmatterHooks()];

// The payload a shim hands to bun, read the way a reader would, independent of
// the gate's own discovery.
function payloadOf(shimText: string): string | null {
  // HERE, or any variable the shim sets from its own directory.
  const ownDir = new Set(['HERE']);
  for (const m of shimText.matchAll(/^\s*(?:export\s+|readonly\s+|local\s+)?([A-Za-z_]\w*)="\$\(cd "\$\(dirname "\$(?:0|\{BASH_SOURCE\[0\]\}|BASH_SOURCE)"\)"/gm)) ownDir.add(m[1]);
  for (const line of shimText.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/bun\s+(?:run\s+)?"\$\{?([A-Za-z_]\w*)\}?\/([^"]+)"/);
    if (m && ownDir.has(m[1])) return m[2];
  }
  return null;
}

// ── fixtures ───────────────────────────────────────────────────────────────

let FX = '';
// A scratch copy of everything the wired hooks reach: the shims, their bun
// payloads, everything those import, and the libraries the bin hooks source.
let SCRATCH = '';
// What a wired hook and its payload pull in lives under these roots, plus the
// hook's own directory (careful/bin, autoplan/bin, ...), derived so a newly
// wired hook is copied without editing this list.
const SCRATCH_ROOTS = ['hosts', 'lib', 'scripts', 'bin'];
const SCRATCH_DIRS = [...new Set([...SCRATCH_ROOTS, ...WIRED.map(h => path.dirname(h.rel))])]
  .filter(d => !SCRATCH_ROOTS.some(r => d !== r && d.startsWith(`${r}/`)));

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
    expect(WIRED.find(h => h.rel === 'autoplan/bin/phase-publication-hook')?.event).toBe('PreToolUse');
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

    test('the pristine scratch copy is GREEN, and everything that runs was parsed', async () => {
      // The shim, plus every local file its payload's build pulls in, the
      // payload included: the list asked of bun's build API directly.
      let expected = 1;
      if (payloadRel) {
        const built = await Bun.build({ entrypoints: [path.join(SCRATCH, payloadRel)], target: 'bun', packages: 'external', metafile: true });
        expected += Object.keys(built.metafile!.inputs).length;
      }
      const r = runGate(['--report', path.join(SCRATCH, hook.rel)]);
      expect(r.code).toBe(0);
      expect(r.output).toBe(`hook-syntax: ${expected} checked, 0 skipped`);
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
        const r = spawnCaptured(viaBash ? 'bash' : p, viaBash ? [p] : [], {
          cwd: FX,
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: path.join(FX, 'home') },
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

// ── line endings ───────────────────────────────────────────────────────────

// The first line of a file, without reading the whole of it.
function firstLine(p: string): string {
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, 256, 0);
    return buf.subarray(0, n).toString('utf-8').split('\n', 1)[0].replace(/\r$/, '');
  } finally {
    fs.closeSync(fd);
  }
}

describe('hook-syntax: line endings', () => {
  test('every tracked file the gate parses as shell is pinned to LF', () => {
    // A default Windows checkout (core.autocrlf=true) writes CRLF unless
    // .gitattributes says otherwise, and bash keeps the \r on every line. The
    // dispatch below mirrors the gate's: a shell shebang, or no #! at all and
    // a .sh name.
    const ls = spawnCaptured('git', ['-C', ROOT, 'ls-files', '-z']);
    if (ls.status !== 0) return; // not a git checkout: nothing to enumerate
    const shells = ls.stdout.split('\0').filter(Boolean).filter((rel) => {
      const p = path.join(ROOT, rel);
      let first: string;
      try {
        if (!fs.lstatSync(p).isFile()) return false;
        first = firstLine(p);
      } catch {
        return false;
      }
      if (/^#!(\/bin\/(ba)?sh|\/usr\/bin\/env (ba)?sh)( |$)/.test(first)) return true;
      return !first.startsWith('#!') && rel.endsWith('.sh');
    });
    // A floor, so a new script never turns this red, but a dispatch that
    // silently stopped matching does.
    expect(shells.length).toBeGreaterThanOrEqual(90);
    expect(shells).toContain('hosts/claude/hooks/question-preference-hook');
    const attr = spawnCaptured('git', ['-C', ROOT, 'check-attr', 'eol', '--', ...shells]);
    expect(attr.status).toBe(0);
    const unpinned = attr.stdout.split('\n').filter((l) => l && !l.endsWith(': eol: lf'));
    expect(unpinned).toEqual([]);
  }, TEST_TIMEOUT_MS);

  test('heal-eol rewrites an unchanged CRLF shell script and nothing else', () => {
    // An install checked out with autocrlf before the LF rules existed keeps
    // its CRLF copies through `git pull`; setup heals them before the gate.
    const repo = path.join(FX, 'heal-repo');
    fs.mkdirSync(repo, { recursive: true });
    const env = { ...process.env, HOME: repo, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const g = (...args: string[]) => spawnCaptured('git', args, { cwd: repo, env });
    expect(g('init', '-q').status).toBe(0);
    fs.writeFileSync(path.join(repo, '.gitattributes'), '* text eol=lf\n');
    const lf: Record<string, string> = {
      'clean.sh': '#!/bin/bash\necho clean\n',
      'edited.sh': '#!/bin/bash\necho edited\n',
      'flagged.sh': '#!/bin/bash\necho flagged\n',
      'notes.md': '# notes\nplain text\n',
      'g[l]ob.sh': '#!/usr/bin/env bash\necho glob\n',
      'readonly.sh': '#!/bin/bash\necho readonly\n',
    };
    for (const [name, body] of Object.entries(lf)) fs.writeFileSync(path.join(repo, name), body, { mode: 0o755 });
    // A healed script keeps its mode, executable or not.
    fs.chmodSync(path.join(repo, 'clean.sh'), 0o755);
    fs.chmodSync(path.join(repo, 'g[l]ob.sh'), 0o644);
    fs.chmodSync(path.join(repo, 'readonly.sh'), 0o555);
    expect(g('add', '.').status).toBe(0);
    expect(g('-c', 'user.email=you@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init').status).toBe(0);
    const crlf = (body: string) => body.replace(/\n/g, '\r\n');
    for (const name of ['clean.sh', 'notes.md', 'g[l]ob.sh']) fs.writeFileSync(path.join(repo, name), crlf(lf[name]));
    // A read-only script, left CRLF: written through a brief owner-write bit.
    fs.chmodSync(path.join(repo, 'readonly.sh'), 0o755);
    fs.writeFileSync(path.join(repo, 'readonly.sh'), crlf(lf['readonly.sh']));
    fs.chmodSync(path.join(repo, 'readonly.sh'), 0o555);
    fs.writeFileSync(path.join(repo, 'edited.sh'), '#!/bin/bash\r\necho local change\r\n');
    expect(g('update-index', '--assume-unchanged', 'flagged.sh').status).toBe(0);
    fs.writeFileSync(path.join(repo, 'flagged.sh'), '#!/bin/bash\r\necho hidden local edit\r\n');
    // A held index lock must neither block the heal nor cost a file.
    fs.writeFileSync(path.join(repo, '.git', 'index.lock'), '');
    // A UTF-8 locale, as on a default macOS shell: bash 3.2 must not collate
    // the ordinary `H` tag into the assume-unchanged range.
    const utf8 = { ...env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
    // Under setup's own `umask 077`, which a fresh temp file would inherit.
    const r = spawnCaptured('/bin/bash', ['-c', 'umask 077; exec /bin/bash "$0" "$1"', path.join(ROOT, 'scripts', 'heal-eol.sh'), repo], { env: utf8 });
    fs.rmSync(path.join(repo, '.git', 'index.lock'), { force: true });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('rewrote clean.sh');
    expect(fs.readFileSync(path.join(repo, 'clean.sh'), 'utf-8')).toBe(lf['clean.sh']);
    expect(fs.statSync(path.join(repo, 'clean.sh')).mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(path.join(repo, 'g[l]ob.sh'), 'utf-8')).toBe(lf['g[l]ob.sh']);
    expect(fs.statSync(path.join(repo, 'g[l]ob.sh')).mode & 0o777).toBe(0o644);
    expect(fs.readFileSync(path.join(repo, 'readonly.sh'), 'utf-8')).toBe(lf['readonly.sh']);
    expect(fs.statSync(path.join(repo, 'readonly.sh')).mode & 0o777).toBe(0o555);
    // Not a shell script: outside the gate's concern, left alone.
    expect(fs.readFileSync(path.join(repo, 'notes.md'), 'utf-8')).toBe(crlf(lf['notes.md']));
    // Real edits, visible or hidden behind assume-unchanged, are never touched.
    expect(fs.readFileSync(path.join(repo, 'edited.sh'), 'utf-8')).toBe('#!/bin/bash\r\necho local change\r\n');
    expect(fs.readFileSync(path.join(repo, 'flagged.sh'), 'utf-8')).toBe('#!/bin/bash\r\necho hidden local edit\r\n');
    expect(fs.readdirSync(repo).filter((n) => n.includes('.heal-eol.'))).toEqual([]);
    // Not a repository: a silent no-op.
    fs.mkdirSync(path.join(FX, 'heal-not-a-repo'), { recursive: true });
    const none = spawnCaptured('/bin/bash', [path.join(ROOT, 'scripts', 'heal-eol.sh'), path.join(FX, 'heal-not-a-repo')], { env });
    expect(none.status).toBe(0);
    expect(none.stderr).toBe('');
  }, TEST_TIMEOUT_MS);

  test('heal-eol in a subdirectory of another repository heals from its own index entry', () => {
    // A vendored install: gstack's files are tracked by a parent project that
    // has a same-named file of its own at the top, and its own attributes.
    const proj = path.join(FX, 'heal-vendored');
    const sub = path.join(proj, 'vendor', 'gstack');
    fs.mkdirSync(sub, { recursive: true });
    const env = { ...process.env, HOME: proj, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
    const g = (...args: string[]) => spawnCaptured('git', args, { cwd: proj, env });
    expect(g('init', '-q').status).toBe(0);
    fs.writeFileSync(path.join(proj, '.gitattributes'), 'setup text eol=crlf\n');
    fs.writeFileSync(path.join(proj, 'setup'), '#!/bin/bash\necho project\n', { mode: 0o755 });
    fs.writeFileSync(path.join(sub, '.gitattributes'), 'setup text eol=lf\n');
    fs.writeFileSync(path.join(sub, 'setup'), '#!/bin/bash\necho gstack\n', { mode: 0o755 });
    expect(g('add', '.').status).toBe(0);
    expect(g('-c', 'user.email=you@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init').status).toBe(0);
    fs.writeFileSync(path.join(sub, 'setup'), '#!/bin/bash\r\necho gstack\r\n');
    const r = spawnCaptured('/bin/bash', [path.join(ROOT, 'scripts', 'heal-eol.sh'), sub], { env });
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('rewrote setup');
    expect(fs.readFileSync(path.join(sub, 'setup'), 'utf-8')).toBe('#!/bin/bash\necho gstack\n');
  }, TEST_TIMEOUT_MS);

  test('heal-eol heals with POSIX mode turned on in the caller environment', () => {
    // /bin/bash 3.2 in POSIX mode rejects heal-eol's process substitution:
    // it died on a syntax error, setup ignores a failed heal, and the gate
    // then refused the CRLF copy heal-eol exists to rewrite.
    for (const [label, extra] of POSIX_ENVS) {
      const repo = path.join(FX, `heal-posix-${label.split('=')[0].toLowerCase()}`);
      fs.mkdirSync(repo, { recursive: true });
      const env = { ...process.env, HOME: repo, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
      const g = (...args: string[]) => spawnCaptured('git', args, { cwd: repo, env });
      expect(g('init', '-q').status).toBe(0);
      fs.writeFileSync(path.join(repo, '.gitattributes'), '* text eol=lf\n');
      fs.writeFileSync(path.join(repo, 'clean.sh'), '#!/bin/bash\necho clean\n', { mode: 0o755 });
      expect(g('add', '.').status).toBe(0);
      expect(g('-c', 'user.email=you@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init').status).toBe(0);
      fs.writeFileSync(path.join(repo, 'clean.sh'), '#!/bin/bash\r\necho clean\r\n');
      const r = spawnCaptured('/bin/bash', [path.join(ROOT, 'scripts', 'heal-eol.sh'), repo], { env: { ...env, ...extra } });
      expect([label, r.status, r.stderr]).toEqual([label, 0, 'heal-eol: rewrote clean.sh with LF line endings\n']);
      expect(fs.readFileSync(path.join(repo, 'clean.sh'), 'utf-8')).toBe('#!/bin/bash\necho clean\n');
    }
  }, TEST_TIMEOUT_MS);

  test('the gate and heal-eol turn POSIX mode off above their first process substitution', () => {
    // The POSIX-mode cases fail only where /bin/bash is 3.2: bash 5.1 and
    // later accept a process substitution in POSIX mode, so on a Linux host
    // they pass with these lines deleted. The gate's `-n` children inherit
    // POSIX_PEDANTIC, which `set +o posix` leaves exported.
    const code = (src: string) => `\n${src.split('\n').filter(l => !l.trimStart().startsWith('#')).join('\n')}`;
    const heal = code(fs.readFileSync(path.join(ROOT, 'scripts', 'heal-eol.sh'), 'utf-8'));
    const gate = code(GATE_SRC);
    for (const [name, src, lines] of [
      ['heal-eol.sh', heal, ['set +o posix']],
      ['hook-syntax.sh', gate, ['set +o posix', 'unset POSIX_PEDANTIC']],
    ] as const) {
      const sub = src.indexOf('<(');
      for (const line of lines) {
        const at = src.indexOf(`\n${line}\n`);
        expect([name, line, at > -1, sub > -1, at < sub]).toEqual([name, line, true, true, true]);
      }
    }
  });

  test('setup heals line endings after choosing its bash and before it runs the gate', () => {
    const chosen = SETUP_SRC.indexOf('_HOOK_SYNTAX_BASH=/bin/bash');
    const heal = SETUP_SRC.indexOf('"$_HOOK_SYNTAX_BASH" "$_HEAL_EOL" "$SOURCE_GSTACK_DIR" || true');
    const gate = SETUP_SRC.indexOf('"$_HOOK_SYNTAX_BASH" "$HOOK_SYNTAX_GATE" "$SOURCE_GSTACK_DIR"');
    expect(chosen).toBeGreaterThan(-1);
    expect(heal).toBeGreaterThan(chosen);
    expect(gate).toBeGreaterThan(heal);
  });

  test('a CRLF shell file is refused, never skipped', () => {
    // The \r-terminated shebang used to match no kind: skipped, then passed.
    // `bash -n` accepts this file, so the CR check has to be its own.
    const crlf = fixture('crlf/hook', '#!/usr/bin/env bash\r\necho hi\r\n');
    expect(spawnSync('bash', ['-n', crlf], { timeout: SPAWN_TIMEOUT_MS }).status).toBe(0); // guard the premise
    const r = runGate(['--report', crlf]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('CRLF LINE ENDINGS');
    expect(r.output).toContain('1 checked, 0 skipped');
  }, TEST_TIMEOUT_MS);

  test('an LF shebang over a body with a CR in it is refused too', () => {
    const mixed = fixture('crlf/mixed', '#!/usr/bin/env bash\nHERE=.\nexec bun "$HERE/x.ts"\r\n');
    const r = runGate([mixed]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('CRLF LINE ENDINGS');
  }, TEST_TIMEOUT_MS);

  test('a CR after an invalid UTF-8 byte is refused under a UTF-8 locale', () => {
    // BSD grep in a UTF-8 locale skips a match that follows an invalid byte
    // on the same line; the byte-level scans run in the C locale.
    const latin = fixture('crlf/latin1.sh', '');
    fs.writeFileSync(latin, Buffer.concat([Buffer.from('#!/bin/bash\n: "caf'), Buffer.from([0xe9]), Buffer.from('"; true\r\n')]));
    expect(spawnSync('bash', ['-n', latin], { timeout: SPAWN_TIMEOUT_MS }).status).toBe(0); // guard the premise
    const r = runGate(['--report', latin], { LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' });
    expect(r.code).toBe(1);
    expect(r.output).toContain('CRLF LINE ENDINGS');
  }, TEST_TIMEOUT_MS);

  test('a payload named after an invalid UTF-8 byte on its line is followed under a UTF-8 locale', () => {
    // bash's regex finds no match past an invalid byte in a UTF-8 locale.
    fixture('latin1-call/hook', '');
    const shim = path.join(FX, 'fx', 'latin1-call', 'hook');
    fs.writeFileSync(shim, Buffer.concat([
      Buffer.from('#!/usr/bin/env bash\nHERE="$(cd "$(dirname "$0")" && pwd)"\n: "caf'),
      Buffer.from([0xe9]),
      Buffer.from('"; exec bun "$HERE/hook.ts"\n'),
    ]));
    fixture('latin1-call/hook.ts', 'const broken: number = {\n');
    const r = runGate([shim], { LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' });
    expect(r.code, r.output).toBe(1);
    expect(r.output).toContain('FAILS TO PARSE');
    expect(r.output).toContain('hook.ts');
  }, TEST_TIMEOUT_MS);

  test.skipIf(!UTF8_LOCALES.length)('an own-directory assignment is read as bash reads it, byte for byte, under a UTF-8 locale', () => {
    // None of these bytes changes what bash runs. Read in a UTF-8 locale, each
    // changes what the gate sees, and the payload goes unfollowed:
    //   nbsp  a line led by a no-break space is a command to bash, not an
    //         assignment, but BSD grep counts the NBSP as [[:space:]]
    //   mid   GNU grep prints no line that holds an invalid byte
    //   hash  macOS's regex fails a match with an invalid byte in the two
    //         bytes after its end
    //   end   bash 5.2's read takes the newline after a trailing invalid
    //         byte as part of a character, so the last such line never
    //         comes back
    // The line scan splits words itself, a byte at a time: to it the nbsp line
    // is a command whatever grep matched, and a comment's bytes never reach
    // the own-directory match.
    const own = 'D="$(cd "$(dirname "$0")" && pwd)"';
    const shims: Array<[string, Buffer]> = [
      ['nbsp', Buffer.concat([Buffer.from(`${own}\n`), Buffer.from([0xc2, 0xa0]), Buffer.from('D=/elsewhere || true\n')])],
      ['mid', Buffer.concat([Buffer.from(`${own}  # r`), Buffer.from([0xe9]), Buffer.from('pertoire\n')])],
      ['hash', Buffer.concat([Buffer.from(`${own} #`), Buffer.from([0xe9, 0x74, 0xe9]), Buffer.from(' ok\n')])],
      ['end', Buffer.concat([Buffer.from(`${own}  # caf`), Buffer.from([0xe9]), Buffer.from('\n')])],
    ];
    for (const [name, body] of shims) {
      const shim = fixture(`own-dir-bytes-${name}/hook`, '');
      fs.writeFileSync(shim, Buffer.concat([Buffer.from('#!/usr/bin/env bash\n'), body, Buffer.from('exec bun "$D/payload.ts"\n')]));
      const payload = fixture(`own-dir-bytes-${name}/payload.ts`, 'const broken: number = {\n');
      for (const loc of UTF8_LOCALES) {
        const r = runGate([shim], { LC_ALL: loc, LANG: loc });
        expect([name, loc, r.code], r.output).toEqual([name, loc, 1]);
        expect(r.output).toContain(`FAILS TO PARSE ${payload}`);
      }
    }
  }, TEST_TIMEOUT_MS);

  test.skipIf(!UTF8_LOCALES.length)('a reassignment after a line ending in an invalid UTF-8 byte is still read under a UTF-8 locale', () => {
    // The `end` row's run-on also cut the other way: read under a UTF-8
    // locale, bash 5.2 took the `D="$D/lib"` line into the own-directory line
    // before it, so the gate saw no reassignment and refused the shim's own
    // payload.ts. bash runs lib/payload.ts, which parses.
    const shim = fixture('own-dir-reassigned/hook', '');
    fs.writeFileSync(shim, Buffer.concat([
      Buffer.from('#!/usr/bin/env bash\nD="$(cd "$(dirname "$0")" && pwd)"  # caf'),
      Buffer.from([0xe9]),
      Buffer.from('\nD="$D/lib"\nexec bun "$D/payload.ts"\n'),
    ]));
    fixture('own-dir-reassigned/payload.ts', 'const broken: number = {\n');
    fixture('own-dir-reassigned/lib/payload.ts', 'export const ok = 1;\n');
    for (const loc of ['C', ...UTF8_LOCALES]) {
      const r = runGate([shim], { LC_ALL: loc, LANG: loc });
      expect([loc, r.code, r.output]).toEqual([loc, 0, '']);
    }
  }, TEST_TIMEOUT_MS);

  test.skipIf(!UTF8_LOCALES.length)('an own-directory assignment is matched byte for byte on glibc as well, either way', () => {
    // The `hash` row above fails a UTF-8 match on macOS alone; glibc's regex
    // matches it. These two differ on both. A UTF-8 regex cannot match across
    // the invalid byte in a redirect target, so the payload went unfollowed.
    // It reads U+2003 as [[:space:]], so an assignment bash continues past the
    // quote, D being `<dir><U+2003>`, read as the shim's own directory, and
    // the payload bash never runs was refused.
    const rows: Array<[string, Buffer, boolean]> = [
      ['latin1-log', Buffer.concat([Buffer.from('D="$(cd "$(dirname "$0")" 2>>"$HOME/hook-caf'), Buffer.from([0xe9]), Buffer.from('.log" && pwd)"\n')]), true],
      ['emsp-after', Buffer.from('D="$(cd "$(dirname "$0")" && pwd)" \n'), false],
    ];
    for (const [name, assign, followed] of rows) {
      const shim = fixture(`own-dir-glibc-${name}/hook`, '');
      fs.writeFileSync(shim, Buffer.concat([Buffer.from('#!/usr/bin/env bash\n'), assign, Buffer.from('exec bun "$D/payload.ts"\n')]));
      const payload = fixture(`own-dir-glibc-${name}/payload.ts`, 'const broken: number = {\n');
      for (const loc of UTF8_LOCALES) {
        const r = runGate([shim], { LC_ALL: loc, LANG: loc });
        if (followed) {
          expect([name, loc, r.code], r.output).toEqual([name, loc, 1]);
          expect(r.output).toContain(`FAILS TO PARSE ${payload}`);
        } else {
          expect([name, loc, r.code, r.output]).toEqual([name, loc, 0, '']);
        }
      }
    }
  }, TEST_TIMEOUT_MS);

  test("a CRLF shim's payload is still found and parsed", () => {
    fixture('crlf-shim/hook', SHIM('hook.ts').replace(/\n/g, '\r\n'));
    fixture('crlf-shim/hook.ts', 'export const ok = 1;\n');
    const r = runGate(['--report', path.join(FX, 'fx', 'crlf-shim', 'hook')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('CRLF LINE ENDINGS');
    expect(r.output).toContain('2 checked, 0 skipped');
  }, TEST_TIMEOUT_MS);

  test('a CRLF python file is classified and compiled, not refused', () => {
    // Python reads CRLF source fine; only bash keeps the \r.
    if (spawnSync('python3', ['-c', 'pass'], { timeout: SPAWN_TIMEOUT_MS }).status !== 0) return;
    const py = fixture('crlf/tool.py', '#!/usr/bin/env python3\r\nprint("ok")\r\n');
    const r = runGate(['--report', py]);
    expect(r.code).toBe(0);
    expect(r.output).toContain('1 checked, 0 skipped');
  }, TEST_TIMEOUT_MS);

  test('a missing TMPDIR does not refuse a healthy tree', () => {
    // Session scratch dirs get wiped; the gate writes no temp file.
    const r = runGate([fixture('tmpdir-gone/ok.sh', '#!/bin/bash\necho ok\n')], { TMPDIR: path.join(FX, 'no-such-tmpdir') });
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
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

  test.skipIf(!BYTE_NAMES || !UTF8_LOCALES.length)('a name ending in an invalid UTF-8 byte hides no file from the sweep under a UTF-8 locale', () => {
    // Read in a UTF-8 locale by bash 5.2, such a name takes the NUL after it,
    // and the name after it is lost; one that sorts last never comes back.
    // Both files are broken, so a sweep that drops either one is caught.
    const dir = path.join(FX, 'fx', 'byte-name');
    fixture('byte-name/d.sh', '#!/bin/bash\nif true; then\n');
    fs.writeFileSync(Buffer.concat([Buffer.from(`${dir}/caf`), Buffer.from([0xe9])]), '#!/bin/bash\nif true; then\n');
    for (const loc of UTF8_LOCALES) {
      const r = runGate(['--report', dir], { LC_ALL: loc, LANG: loc });
      expect([loc, r.code], r.output).toEqual([loc, 1]);
      expect([loc, r.output.split('FAILS TO PARSE').length - 1], r.output).toEqual([loc, 2]);
      expect(r.output).toContain('2 checked, 0 skipped');
    }
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

  test('a relative directory is swept with CDPATH exported', () => {
    // With CDPATH set, cd prints the directory it resolved; a root captured
    // through $(cd ... && pwd -P) would then hold two lines and match nothing.
    fixture('cdpath/sub/ok.sh', '#!/bin/bash\nexit 0\n');
    fixture('cdpath/sub/broken.sh', '#!/bin/bash\nif true; then\n');
    const cwd = path.join(FX, 'fx', 'cdpath');
    const r = spawnCaptured('/bin/bash', [GATE, '--report', 'sub'], { cwd, env: { ...process.env, CDPATH: '.' } });
    const output = `${r.stdout}${r.stderr}`;
    expect(codeOf(r)).toBe(1);
    expect(output).toContain('broken.sh');
    expect(output).toContain('2 checked, 0 skipped');
  }, TEST_TIMEOUT_MS);

  test('the gate finds its own root with CDPATH exported, run or sourced by a relative path', () => {
    // `/bin/bash scripts/hook-syntax.sh` from the root, and a caller that
    // sources it and calls hook_syntax_check_tree, both take the root from
    // $(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P). That dirname is
    // relative, so cd consults CDPATH and prints what it found: the captured
    // root would hold two lines, and a healthy tree be refused as "no such
    // directory".
    const root = path.join(FX, 'fx', 'cdpath-root');
    fixture('cdpath-root/scripts/hook-syntax.sh', GATE_SRC);
    fixture('cdpath-root/ok.sh', '#!/bin/bash\nexit 0\n');
    const env = { ...process.env, CDPATH: '.' };
    const runs: Array<[string, Captured]> = [
      ['run', spawnCaptured('/bin/bash', ['scripts/hook-syntax.sh', '--report'], { cwd: root, env })],
      ['sourced', spawnCaptured('/bin/bash', ['-c', 'source scripts/hook-syntax.sh; hook_syntax_check_tree; rc=$?; hook_syntax_report; exit $rc'], { cwd: root, env })],
    ];
    for (const [how, r] of runs) {
      const output = `${r.stdout}${r.stderr}`;
      expect([how, codeOf(r)], output).toEqual([how, 0]);
      expect(output).not.toContain('no such directory');
      expect(output).toContain('2 checked, 0 skipped');
    }
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

  // The content scans read grep's `name:line:text` output a line at a time, so
  // no hit ever matched a name holding a newline: a half-merged file there,
  // and a broken payload its shim named, passed with exit 0.
  test.skipIf(process.platform === 'win32')('a checked file whose path holds a newline is refused, never passed unscanned', () => {
    const merged = fixture('nl-markers/a\nb.sh', `#!/bin/bash\n${CONFLICT_HEREDOC}`);
    fixture('nl-shim/hook\nx', SHIM('payload.ts'));
    fixture('nl-shim/payload.ts', 'const broken: number = {\n');
    const real = (rel: string) => fs.realpathSync(path.join(FX, 'fx', rel));
    const runs: Array<[string, string]> = [
      [merged, merged],
      [path.join(FX, 'fx', 'nl-markers'), `${real('nl-markers')}/a\nb.sh`],
      [path.join(FX, 'fx', 'nl-shim'), `${real('nl-shim')}/hook\nx`],
    ];
    for (const [target, named] of runs) {
      const r = runGate([target]);
      expect([target, r.code], r.output).toEqual([target, 1]);
      expect(r.output).toContain(`NEWLINE IN PATH ${named}`);
    }
  }, TEST_TIMEOUT_MS);

  test.skipIf(process.platform === 'win32')('a root whose path holds a newline is refused once, not swept blind', () => {
    // However the root is reached: named directly, through a symlink that has
    // no newline itself, as `.` from inside it, or as the gate's own root, run
    // or sourced with no target. A trailing newline is the trap: $(...) strips
    // it, so `x<NL>` resolved to its healthy sibling `x`, which was swept in
    // its place and passed.
    fixture('nl-root/x/ok.sh', '#!/bin/bash\nexit 0\n');
    for (const [name, linkName] of [['n\nl', 'link-nl'], ['x\n', 'link-x']]) {
      fixture(`nl-root/${name}/ok.sh`, '#!/bin/bash\nexit 0\n');
      fixture(`nl-root/${name}/hook`, SHIM('payload.ts'));
      fixture(`nl-root/${name}/payload.ts`, 'const broken: number = {\n');
      fixture(`nl-root/${name}/merged.sh`, `#!/bin/bash\n${CONFLICT_HEREDOC}`);
      const own = fixture(`nl-root/${name}/scripts/hook-syntax.sh`, GATE_SRC);
      const dir = path.join(FX, 'fx', 'nl-root', name);
      const link = path.join(FX, 'fx', 'nl-root', linkName);
      fs.symlinkSync(dir, link);
      const runs: Array<[string, Captured]> = [
        ['named', spawnCaptured('/bin/bash', [GATE, '--report', dir])],
        ['through a symlink', spawnCaptured('/bin/bash', [GATE, '--report', link])],
        ['as .', spawnCaptured('/bin/bash', [GATE, '--report', '.'], { cwd: dir })],
        ['own root, run', spawnCaptured('/bin/bash', [own, '--report'])],
        ['own root, sourced', spawnCaptured('/bin/bash', ['-c', 'source "$1"; hook_syntax_check_tree; rc=$?; hook_syntax_report; exit $rc', 'sh', own])],
      ];
      for (const [how, r] of runs) {
        const label = `${JSON.stringify(name)} ${how}`;
        const output = `${r.stdout}${r.stderr}`;
        expect([label, codeOf(r)], output).toEqual([label, 1]);
        expect(output.split('NEWLINE IN PATH').length - 1, output).toBe(1);
        expect(output).toContain(`NEWLINE IN PATH ${fs.realpathSync(dir)}`);
        expect(output).toContain('hook-syntax: 0 checked, 0 skipped');
      }
    }
  }, TEST_TIMEOUT_MS);

  test.skipIf(process.platform === 'win32')('a path holding a newline is never taken for two paths already checked', () => {
    // The run keeps the paths it checked newline-delimited, so `A<NL><NL>B`
    // matched the entries A and B once both were checked: a half-merged file
    // there passed unread, named after them or swept with their directory.
    fixture('nl-seen/a', '#!/bin/bash\nexit 0\n');
    fixture('nl-seen/b', '#!/bin/bash\nexit 0\n');
    const dir = fs.realpathSync(path.join(FX, 'fx', 'nl-seen'));
    const [a, b] = [path.join(dir, 'a'), path.join(dir, 'b')];
    const merged = `${a}\n\n${b}`;
    fs.mkdirSync(path.dirname(merged), { recursive: true });
    fs.writeFileSync(merged, `#!/bin/bash\n${CONFLICT_HEREDOC}`);
    for (const last of [merged, dir]) {
      const r = runGate(['--report', a, b, last]);
      expect([last, r.code], r.output).toEqual([last, 1]);
      expect(r.output.split('NEWLINE IN PATH').length - 1, r.output).toBe(1);
      expect(r.output).toContain(`NEWLINE IN PATH ${merged}`);
    }
  }, TEST_TIMEOUT_MS);

  test.skipIf(process.platform === 'win32')('a module a payload imports, whose path holds a newline, is refused', () => {
    // The sweep skips a .ts no shim names; bun's import list, one path per
    // line, carries it to the marker scan. Split there, its markers went
    // unseen: a file named by the first half was scanned in its place and the
    // run passed, or, with no such file, it was refused as UNREADABLE for a
    // file the payload never imported.
    for (const sibling of [true, false]) {
      const dir = `nl-import-${sibling ? 'sibling' : 'alone'}`;
      fixture(`${dir}/hook`, SHIM('hook.ts'));
      fixture(`${dir}/hook.ts`, 'import { msg } from "./a\\nb.ts";\nconsole.log(msg);\n');
      const mod = fixture(`${dir}/a\nb.ts`, `export const msg = \`\n${LT} HEAD\na\n${EQ}\nb\n${GT} other\n\`;\n`);
      if (sibling) fixture(`${dir}/a`, 'notes\n');
      for (const target of [path.join(FX, 'fx', dir, 'hook'), path.join(FX, 'fx', dir)]) {
        const r = runGate(['--report', target]);
        expect([target, r.code], r.output).toEqual([target, 1]);
        expect(r.output).toContain(`NEWLINE IN PATH ${JSON.stringify(fs.realpathSync(mod))} — imported by`);
        expect(r.output).not.toContain('cannot place');
        expect(r.output).not.toContain('UNREADABLE');
      }
    }
  }, TEST_TIMEOUT_MS);

  test.skipIf(process.platform === 'win32')('control: a symlink whose own name holds a newline sweeps the directory it names', () => {
    // Only the resolved root is swept, so only its spelling can put a newline
    // in a path the scans read.
    fixture('nl-link/real/ok.sh', '#!/bin/bash\nexit 0\n');
    const link = path.join(FX, 'fx', 'nl-link', 'li\nnk');
    fs.symlinkSync(path.join(FX, 'fx', 'nl-link', 'real'), link);
    const r = runGate(['--report', link]);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toBe('hook-syntax: 1 checked, 0 skipped');
  }, TEST_TIMEOUT_MS);

  test.skipIf(process.platform === 'win32')('control: a skipped file whose name holds a newline does not refuse the tree', () => {
    // A skipped file no payload imports never reaches the content scans, so
    // its name costs nothing. One a payload imports is refused through bun's
    // import list: 'a module a payload imports, whose path holds a newline,
    // is refused'.
    fixture('nl-skipped/ok.sh', '#!/bin/bash\nexit 0\n');
    fixture('nl-skipped/notes\nx.md', '# notes\n');
    const r = runGate(['--report', path.join(FX, 'fx', 'nl-skipped')]);
    expect(r.code, r.output).toBe(0);
    expect(r.output).toBe('hook-syntax: 1 checked, 1 skipped');
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
    const sys = spawnCaptured('/bin/bash', ['-c', 'echo "${BASH_VERSINFO[0]}"']).stdout.trim();
    const envBash = spawnCaptured('bash', ['-c', 'echo "${BASH_VERSINFO[0]}"']).stdout.trim();
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

  test('a one-line data file is read only as far as a #! line reaches', () => {
    // Every file in the tree has its first line read. Uncapped, that read
    // costs time that grows faster than the line: a 210 KB single-line JSON
    // in this repo took over a minute under a UTF-8 locale. An 8 MB line does
    // not finish inside SPAWN_TIMEOUT_MS uncapped; capped, it is one more
    // skipped file.
    fixture('long-first-line/ok.sh', '#!/bin/bash\nexit 0\n');
    fixture('long-first-line/one-line.json', 'a'.repeat(8 * 1024 * 1024));
    const r = runGate(['--report', path.join(FX, 'fx', 'long-first-line')]);
    expect(r.code).toBe(0);
    expect(r.output).toContain('1 checked, 1 skipped');
  }, TEST_TIMEOUT_MS);

  test('a shebang behind a run of NUL bytes is not read', () => {
    // The kernel reads a shebang from a file's first bytes only. bash 4 and
    // later drop NUL bytes from a read without counting them toward -n, so a
    // read keyed on newline ran on through the NULs and classified the
    // shebang after them. Run under /bin/bash and under the PATH bash: on CI
    // /bin/bash is 5, and a macOS PATH bash is usually Homebrew's 5. A 3.2
    // read stops at the NULs on either branch, so 3.2 alone proves nothing;
    // it still has to give the right answer.
    const bashes = [...new Set(['/bin/bash', spawnCaptured('/bin/bash', ['-c', 'command -v bash']).stdout.trim()])].filter(Boolean);
    expect(bashes.length).toBeGreaterThanOrEqual(1);
    const dir = path.join(FX, 'fx', 'nul-prefix');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ok.sh'), '#!/bin/bash\nexit 0\n');
    fs.writeFileSync(path.join(dir, 'nul-led'), Buffer.concat([Buffer.alloc(8192), Buffer.from('#!/bin/bash\nif true; then\n')]));
    for (const bash of bashes) {
      const r = spawnCaptured(bash, [GATE, '--report', dir], { env: process.env });
      expect(r.status).toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain('1 checked, 1 skipped');
    }
  }, TEST_TIMEOUT_MS);

  test('the first-line read is capped at a #! length, and stops at a NUL from bash 4 on', () => {
    for (const re of [/IFS= read -r -d '' -n (\d+) line < "\$1"/, /IFS= read -r -n (\d+) line < "\$1"/]) {
      const m = GATE_SRC.match(re);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBeGreaterThanOrEqual(128);
      expect(Number(m![1])).toBeLessThanOrEqual(1024);
    }
    // NUL-delimited, so the newline cut must follow that read; and only from
    // bash 4 on, where NULs are not counted toward -n.
    expect(GATE_SRC).toContain('line="${line%%"$HOOK_SYNTAX_NL"*}"');
    expect(GATE_SRC).toContain('if [ "${BASH_VERSINFO[0]}" -ge 4 ]; then\n  HOOK_SYNTAX_READ_TO_NUL=1');
  });
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

  test.skipIf(!UTF8_LOCALES.length)('a marker whose label holds an invalid UTF-8 byte fails under a UTF-8 locale', () => {
    // A label is free text, such as a Latin-1 branch name or commit subject.
    // In a UTF-8 locale BSD grep drops a match whose next byte is invalid, and
    // GNU grep prints "binary file matches" in place of any matching line that
    // holds one. The marker scan runs in the C locale.
    const labels: Array<[string, Buffer]> = [
      ['first', Buffer.concat([Buffer.from(`${LT} `), Buffer.from([0xe9]), Buffer.from('branch')])],
      ['later', Buffer.concat([Buffer.from(`${LT} HEAD caf`), Buffer.from([0xe9])])],
    ];
    for (const [name, label] of labels) {
      const p = fixture(`latin1-marker/${name}.sh`, '');
      fs.writeFileSync(p, Buffer.concat([Buffer.from("#!/bin/bash\ncat <<'EOF'\n"), label, Buffer.from('\nEOF\n')]));
      expect(spawnSync('/bin/bash', ['-n', p], { timeout: SPAWN_TIMEOUT_MS }).status).toBe(0); // guard the premise
      for (const loc of UTF8_LOCALES) {
        const r = runGate([p], { LC_ALL: loc, LANG: loc });
        expect([name, loc, r.code], r.output).toEqual([name, loc, 1]);
        expect(r.output).toContain(`UNRESOLVED CONFLICT MARKERS in ${p}`);
      }
    }
  }, TEST_TIMEOUT_MS);

  test('a NUL byte in a file does not hide its markers', () => {
    // grep reads a file whose first 32 KiB hold a NUL as binary, and prints
    // "Binary file X matches" (BSD) or nothing on stdout (GNU) in place of
    // the marker lines. git sniffs only the first 8,000 bytes for a NUL, so a
    // file with one past them is merged as text and gets real markers; bash
    // runs a script whose NUL sits past its first two lines. A NUL on the
    // marker line itself is dropped from the report, and bash 4.4 and later
    // must not add a warning about dropping it.
    const pad = `# ${'p'.repeat(77)}\n`.repeat(110);
    const merged = `#!/bin/bash\n${pad}: '\u0000'\n${CONFLICT_HEREDOC}`;
    const late = fixture('nul-markers/merged.sh', merged);
    const onLine = fixture('nul-markers/label.sh', `#!/bin/bash\ncat <<'EOF'\n${LT} HEAD\u0000x\nEOF\n`);
    const nul = fs.readFileSync(late).indexOf(0);
    expect(nul).toBeGreaterThan(8000); // premise: git merges it as text
    expect(nul).toBeLessThan(32 * 1024); // premise: grep reads it as binary
    const cases: Array<[string, number]> = [
      [late, merged.split('\n').findIndex(l => l.startsWith(LT)) + 1],
      [onLine, 3],
    ];
    for (const bash of hostBashes()) {
      for (const [p, line] of cases) {
        expect(spawnSync(bash, ['-n', p], { timeout: SPAWN_TIMEOUT_MS }).status).toBe(0); // guard the premise
        const r = runGateWith(bash, [p]);
        expect([bash, p, r.code], r.output).toEqual([bash, p, 1]);
        expect(r.output).toContain(`UNRESOLVED CONFLICT MARKERS in ${p}`);
        expect(r.output).toContain(`${p}:${line}:${LT} HEAD`);
        expect(r.output).not.toContain('null byte');
      }
    }
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

  test('a module a swept payload imports is counted once, as checked, never also as skipped', () => {
    // The sweep reaches lib.ts before any payload is built and counts it as
    // skipped (no #! line, not .sh). The build then marker-scans it, so that
    // skip is taken back. Naming the shim alone never puts lib.ts on the
    // skipped list; only a sweep, the way setup runs the gate, reaches this.
    fixture('counted-import/hook', SHIM('hook.ts'));
    fixture('counted-import/hook.ts', "import { y } from './lib';\nconsole.log(y);\n");
    fixture('counted-import/lib.ts', 'export const y: number = 2;\n');
    const r = runGate(['--report', path.join(FX, 'fx', 'counted-import')]);
    expect([r.code, r.output]).toEqual([0, 'hook-syntax: 3 checked, 0 skipped']);
  }, TEST_TIMEOUT_MS);

  test('a payload another payload imports is counted, and taken off skipped, once, whichever shim comes first', () => {
    // The imported file is reached twice: as an import of the other payload's
    // build, and as its own shim's payload, built again as an entry point. It
    // is one file checked, and its skip is taken back once; taken back twice,
    // the count would hide orphan.ts, which nothing reaches. The sweep meets
    // a-hook first, so the two layouts put the importer first, then last.
    for (const [importer, imported] of [['a', 'b'], ['b', 'a']]) {
      const dir = `counted-entry-${importer}${imported}`;
      fixture(`${dir}/${importer}-hook`, SHIM(`${importer}.ts`));
      fixture(`${dir}/${importer}.ts`, `import { ok } from './${imported}.ts';\nconsole.log(ok);\n`);
      fixture(`${dir}/${imported}-hook`, SHIM(`${imported}.ts`));
      fixture(`${dir}/${imported}.ts`, 'export const ok: number = 1;\n');
      fixture(`${dir}/orphan.ts`, 'export const unreached = 1;\n');
      const r = runGate(['--report', path.join(FX, 'fx', dir)]);
      expect([dir, r.code, r.output]).toEqual([dir, 0, 'hook-syntax: 4 checked, 1 skipped']);
    }
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
    const v = spawnCaptured('python3', ['-c', 'import sys; print(sys.version_info[1] if sys.version_info[0] == 3 else 0)']);
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

  test('a PATH bash that cannot run is a coverage gap, probed once, never "fails to parse"', () => {
    // Only `#!/usr/bin/env bash` files resolve bash through PATH. A
    // `#!/bin/bash` file in the same run is still parsed, and still caught.
    const bash = brokenInterpreter('bash');
    const ok = fixture('bash-shim/ok.sh', '#!/usr/bin/env bash\necho ok\n');
    const broken = fixture('bash-shim/broken.sh', '#!/usr/bin/env bash\nif true; then\n');
    const fixed = fixture('bash-shim/fixed.sh', '#!/bin/bash\nif true; then\n');
    const r = runGate(['--report', ok, broken, fixed], { PATH: `${path.dirname(bash.bin)}:${process.env.PATH ?? '/usr/bin:/bin'}` });
    expect(r.code).toBe(1);
    expect(r.output).toContain('bash cannot run (exit 127)');
    expect(r.output).not.toContain(`FAILS TO PARSE ${ok}`);
    expect(r.output).not.toContain(`FAILS TO PARSE ${broken}`);
    expect(r.output).toContain(`FAILS TO PARSE ${fixed} (/bin/bash -n)`);
    expect(r.output).toContain('1 checked, 2 skipped');
    expect(bash.calls()).toBe(1);
  }, TEST_TIMEOUT_MS);

  // An interpreter that exits with a chosen status on every call.
  function exitingInterpreter(name: string, code: number): string {
    const bin = fixture(`exiting-${code}/${name}`, `#!/bin/sh\necho "${name}: broken" >&2\nexit ${code}\n`);
    fs.chmodSync(bin, 0o755);
    return bin;
  }

  test('a gap in the parse is not a gap in the content scans', () => {
    // With the PATH bash unable to run, an env-bash file still has its
    // conflict markers, carriage returns and bun payload checked.
    const bash = brokenInterpreter('bash');
    const env = { PATH: `${path.dirname(bash.bin)}:${process.env.PATH ?? '/usr/bin:/bin'}` };
    const marked = runGate(['--report', fixture('gap-scans/marked.sh', `#!/usr/bin/env bash\n${CONFLICT_HEREDOC}`)], env);
    expect(marked.code).toBe(1);
    expect(marked.output).toContain('UNRESOLVED CONFLICT MARKERS');
    expect(marked.output).toContain('NOT checked');
    const crlf = runGate(['--report', fixture('gap-scans/crlf.sh', '#!/usr/bin/env bash\r\necho ok\r\n')], env);
    expect(crlf.code).toBe(1);
    expect(crlf.output).toContain('CRLF LINE ENDINGS');
    fixture('gap-scans/hook', SHIM('hook.ts'));
    fixture('gap-scans/hook.ts', 'const broken: number = {\n');
    const payload = runGate(['--report', path.join(FX, 'fx', 'gap-scans/hook')], env);
    expect(payload.code).toBe(1);
    expect(payload.output).toContain('FAILS TO PARSE');
    // And with python3 unable to run, a .py file's markers still fail.
    const py = brokenInterpreter('python3');
    const pyMarked = runGate(['--report', fixture('gap-scans/marked.py', `#!/usr/bin/env python3\nprint('ok')\n${LT} HEAD\n${GT} other\n`)], { HOOK_SYNTAX_PYTHON: py.bin });
    expect(pyMarked.code).toBe(1);
    expect(pyMarked.output).toContain('UNRESOLVED CONFLICT MARKERS');
  }, TEST_TIMEOUT_MS);

  test('a PATH bash that exits 2 is refused: every hook it runs would block', () => {
    const bash = exitingInterpreter('bash', 2);
    const ok = fixture('bash-exit2/ok.sh', '#!/usr/bin/env bash\necho ok\n');
    const r = runGate(['--report', ok], { PATH: `${path.dirname(bash)}:${process.env.PATH ?? '/usr/bin:/bin'}` });
    expect(r.code).toBe(1);
    expect(r.output).toContain('bash exits 2 on every call');
    // Premise: the same file, run as a hook would run it, exits 2.
    fs.chmodSync(ok, 0o755);
    const ran = spawnCaptured(ok, [], { env: { PATH: `${path.dirname(bash)}:/usr/bin:/bin` } });
    expect(ran.status).toBe(2);
  }, TEST_TIMEOUT_MS);

  test('a bun that exits 2 is refused for a payload; a python3 that exits 2 stays a gap', () => {
    const bun = exitingInterpreter('bun', 2);
    const r = runGate(['--report', path.join(SCRATCH, 'hosts/claude/hooks/timeline-stop-hook')], { HOOK_SYNTAX_BUN: bun });
    expect(r.code).toBe(1);
    expect(r.output).toContain('exits 2 on every call');
    // No wired hook runs through python3, so a broken one costs coverage only.
    const py = exitingInterpreter('python3', 2);
    const p = runGate(['--report', fixture('py-exit2/a.py', '#!/usr/bin/env python3\nprint("ok")\n')], { HOOK_SYNTAX_PYTHON: py });
    expect(p.code).toBe(0);
    expect(p.output).toContain('cannot run (exit 2)');
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

  // A marker inside a template literal or a comment parses cleanly, and the
  // sweep skips a .ts no shim names, so the import list bun's own build
  // reports is what carries an imported module to the marker scan.
  const conflictedLiteral = (name: string) => `export const ${name} = \`\n${LT} HEAD\na\n${EQ}\nb\n${GT} other\n\`;\n`;

  test('conflict markers in a module the payload imports fail, naming that module', () => {
    fixture('import-markers/hook', SHIM('hook.ts'));
    fixture('import-markers/hook.ts', "import { msg } from './lib/helper';\nconsole.log(msg);\n");
    const helper = fixture('import-markers/lib/helper.ts', conflictedLiteral('msg'));
    const r = runGate([path.join(FX, 'fx', 'import-markers/hook')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain(`UNRESOLVED CONFLICT MARKERS in ${fs.realpathSync(helper)}`);
  }, TEST_TIMEOUT_MS);

  test('markers inside a comment of an imported module fail too', () => {
    fixture('import-comment/hook', SHIM('hook.ts'));
    fixture('import-comment/hook.ts', "import { ok } from './ok';\nconsole.log(ok);\n");
    const mod = fixture('import-comment/ok.ts', `/*\n${LT} HEAD\none\n${EQ}\ntwo\n${GT} other\n*/\nexport const ok = 1;\n`);
    const r = runGate([path.join(FX, 'fx', 'import-comment/hook')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain(`UNRESOLVED CONFLICT MARKERS in ${fs.realpathSync(mod)}`);
  }, TEST_TIMEOUT_MS);

  test('an imported module under a non-ASCII directory is found and named', () => {
    fixture('import-unicode/hook', SHIM('hook.ts'));
    fixture('import-unicode/hook.ts', "import { msg } from './ünï dir/helper';\nconsole.log(msg);\n");
    const helper = fixture('import-unicode/ünï dir/helper.ts', conflictedLiteral('msg'));
    const r = runGate([path.join(FX, 'fx', 'import-unicode/hook')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain(`UNRESOLVED CONFLICT MARKERS in ${fs.realpathSync(helper)}`);
  }, TEST_TIMEOUT_MS);

  test('markers in the payload itself are named once', () => {
    fixture('payload-markers/hook', SHIM('hook.ts'));
    fixture('payload-markers/hook.ts', `${conflictedLiteral('msg')}console.log(msg);\n`);
    const r = runGate([path.join(FX, 'fx', 'payload-markers/hook')]);
    expect(r.code).toBe(1);
    expect(r.output.split('UNRESOLVED CONFLICT MARKERS').length - 1).toBe(1);
  }, TEST_TIMEOUT_MS);

  test('markers in an imported module holding a NUL byte still fail', () => {
    // bun accepts a raw NUL in source, and git merges a module as text while
    // its first 8,000 bytes hold none; grep reads the same bytes as binary.
    fixture('import-nul/hook', SHIM('hook.ts'));
    fixture('import-nul/hook.ts', "import { msg, z } from './helper';\nconsole.log(msg, z);\n");
    const mod = fixture('import-nul/helper.ts', `${conflictedLiteral('msg')}// ${'x'.repeat(9000)}\nexport const z = "\u0000";\n`);
    expect(fs.readFileSync(mod).indexOf(0)).toBeGreaterThan(8000); // guard the premise
    const r = runGate([path.join(FX, 'fx', 'import-nul/hook')]);
    expect(r.code, r.output).toBe(1);
    expect(r.output).toContain(`UNRESOLVED CONFLICT MARKERS in ${fs.realpathSync(mod)}`);
  }, TEST_TIMEOUT_MS);

  test('control: an imported module that only spells a marker in an escaped string stays GREEN', () => {
    // bun re-prints such a string as a template literal with the marker at
    // column 0 of its bundle; the module's own bytes hold no marker line.
    fixture('import-escaped/hook', SHIM('hook.ts'));
    fixture('import-escaped/hook.ts', "import { isConflicted } from './detect';\nconsole.log(isConflicted(''));\n");
    fixture('import-escaped/detect.ts', `export const isConflicted = (s: string) => ("\\n" + s).includes("\\n${LT} ");\n`);
    const r = runGate([path.join(FX, 'fx', 'import-escaped/hook')]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test('control: an imported template literal holding an unlabelled run stays GREEN', () => {
    fixture('import-banner/hook', SHIM('hook.ts'));
    fixture('import-banner/hook.ts', "import { banner } from './banner';\nconsole.log(banner);\n");
    fixture('import-banner/banner.ts', `export const banner = \`\n${LT}\n${EQ}\n${GT}\n\`;\n`);
    const r = runGate([path.join(FX, 'fx', 'import-banner/hook')]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test('a bun that cannot list imports says so, and is not a pass for them', () => {
    // A fake bun: answers the probe, and has a build API without a metafile.
    const bin = fixture('no-metafile/bun', '#!/bin/sh\ncase "$1" in --version) echo 9.9.9 ;; -e) echo NO_METAFILE ;; esac\nexit 0\n');
    fs.chmodSync(bin, 0o755);
    fixture('no-metafile/tree/hook', SHIM('hook.ts'));
    fixture('no-metafile/tree/hook.ts', "import { a } from './a';\nconsole.log(a);\n");
    const r = runGate([path.join(FX, 'fx', 'no-metafile/tree/hook')], { HOOK_SYNTAX_BUN: bin });
    expect(r.code).toBe(0);
    expect(r.output).toContain('cannot list what');
    expect(r.output).toContain('NOT marker-scanned');
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
    // Parsed as TypeScript, the way `bun <file>` runs it: the diagnostic is
    // the syntax error, not a complaint about the file type.
    expect(r.output).toMatch(/payload-no-extension:1:\d+/);
  }, TEST_TIMEOUT_MS);

  test('control: a valid extension-less payload, and what it imports, are GREEN and checked', () => {
    fixture('noext-ok/hook', SHIM('payload-no-extension'));
    fixture('noext-ok/payload-no-extension', "import { y } from './lib';\nconst x: number = y;\nconsole.log(x);\n");
    fixture('noext-ok/lib.ts', 'export const y: number = 2;\n');
    const r = runGate(['--report', path.join(FX, 'fx', 'noext-ok/hook')]);
    expect(r.code).toBe(0);
    expect(r.output).toBe('hook-syntax: 3 checked, 0 skipped');
  }, TEST_TIMEOUT_MS);

  test('a commented-out bun invocation is not a payload', () => {
    // The gate's own header quotes the shim shape.
    const p = fixture('commented/hook', '#!/usr/bin/env bash\nHERE="$(pwd)"\n# exec bun "$HERE/never-existed.ts"\nexit 0\n');
    const r = runGate([p]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test('an indented commented-out bun invocation is not a payload either', () => {
    // A call commented out inside a branch or a function body is indented, by
    // spaces or a tab. Read as a call, it names a file nothing runs and
    // refuses a healthy install.
    const shim = '#!/usr/bin/env bash\nHERE="$(cd "$(dirname "$0")" && pwd)"\nif true; then\n  # exec bun "$HERE/never-existed.ts"\n\t# bun run "$HERE/never-existed-too.ts"\n  exit 0\nfi\n';
    const r = runGate([fixture('commented-indented/hook', shim)]);
    expect([r.code, r.output]).toEqual([0, '']);
  }, TEST_TIMEOUT_MS);

  test('HERE is followed however the shim sets it', () => {
    // Only a variable other than HERE has to be set in the cd/pwd shape. Every
    // real shim spells HERE that way, so nothing else pins the exemption.
    const forms = [
      'HERE="$(dirname "$0")"',
      'HERE="${0%/*}"',
      'HERE="$(cd -- "$(dirname -- "$0")" && pwd)"',
    ];
    forms.forEach((assign, i) => {
      fixture(`here-any-${i}/hook`, `#!/usr/bin/env bash\n${assign}\nexec bun "$HERE/payload.ts"\n`);
      const payload = fixture(`here-any-${i}/payload.ts`, 'const broken: number = {\n');
      const r = runGate([path.join(FX, 'fx', `here-any-${i}/hook`)]);
      expect([assign, r.code], r.output).toEqual([assign, 1]);
      expect(r.output).toContain(`FAILS TO PARSE ${payload}`);
    });
  }, TEST_TIMEOUT_MS);

  test('a payload named through a variable set from the shim\'s own directory is found', () => {
    // /autoplan's hook spells it `bun "$_AUTOPLAN_HOOK_DIR/<payload>"`.
    const shim = '#!/usr/bin/env bash\nD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"\nR="$(bun "$D/payload.ts")"\necho "$R"\n';
    fixture('var-payload/hook', shim);
    fixture('var-payload/payload.ts', 'const broken: number = {\n');
    const r = runGate(['--report', path.join(FX, 'fx', 'var-payload/hook')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('FAILS TO PARSE');
    expect(r.output).toContain('payload.ts');
  }, TEST_TIMEOUT_MS);

  test('a shim holding a NUL byte still has its payload followed, through HERE or its own-directory variable', () => {
    // bash runs a script whose NUL sits past its first two lines, dropping the
    // byte. grep reads the same file as binary and prints no line for the
    // payload search, or the own-directory assignment lookup, to read.
    const forms: Array<[string, string]> = [
      ['HERE', '$(cd "$(dirname "$0")" && pwd)'],
      ['D', '$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)'],
    ];
    for (const [name, assign] of forms) {
      const shim = fixture(`nul-shim-${name}/hook`, `#!/usr/bin/env bash\nset -e\n# a stray \u0000 byte\n${name}="${assign}"\nexec bun "$${name}/hook.ts"\n`);
      fs.chmodSync(shim, 0o755);
      const payload = fixture(`nul-shim-${name}/hook.ts`, 'const broken: number = {\n');
      // Premise: bash parses the shim, and running it reaches the payload.
      expect(spawnSync('/bin/bash', ['-n', shim], { timeout: SPAWN_TIMEOUT_MS }).status).toBe(0);
      const ran = spawnCaptured(shim, [], { env: process.env });
      expect([name, ran.status]).toEqual([name, 1]);
      expect(ran.stderr).toContain('hook.ts');
      for (const [target, named] of [[shim, payload], [path.dirname(shim), fs.realpathSync(payload)]]) {
        const r = runGate([target]);
        expect([name, target, r.code], r.output).toEqual([name, target, 1]);
        expect(r.output).toContain(`FAILS TO PARSE ${named}`);
      }
    }
  }, TEST_TIMEOUT_MS);

  test('control: a healthy shim with a NUL byte on its bun line is followed, GREEN and silent under every bash', () => {
    // The NUL reaches the gate's own command substitution, and bash 4.4 and
    // later warn on stderr when one drops it. bash drops it at run time too.
    const shim = fixture('nul-call/hook', `#!/usr/bin/env bash\nHERE="$(cd "$(dirname "$0")" && pwd)"\nexec bun "$HERE/hook.ts" # \u0000\n`);
    fixture('nul-call/hook.ts', 'export {};\n');
    for (const bash of hostBashes()) {
      const r = runGateWith(bash, ['--report', shim]);
      expect([bash, r.code], r.output).toEqual([bash, 0]);
      expect(r.output).toBe('hook-syntax: 2 checked, 0 skipped');
    }
  }, TEST_TIMEOUT_MS);

  test('a NUL byte inside a shim line is dropped as bash drops it, wherever it sits, under every bash', () => {
    // bash drops a NUL past a script's first two lines even inside a word or
    // a name, so each row runs as if the byte were not there. Each was misread
    // all the same. A grep pattern matches nothing a NUL splits, so the call,
    // the variable or the name in the first, second and fourth rows went
    // unseen under every bash. /bin/bash 3.2's read cuts a line at its first
    // NUL and loses the rest of it, so under it the third row went unfollowed
    // and the last read as the shim's own directory, refusing a healthy hook.
    // The shim's own payload.ts is broken and sub/payload.ts is valid, so a
    // payload.ts the gate refuses is one it followed into the shim's own
    // directory. A stub bun on PATH records the path each bash hands it, and
    // every row is checked against that record before the gate runs.
    const rows: Array<[string, string, string]> = [
      ['the bun call', 'HERE="$(cd "$(dirname "$0")" && pwd)"\nexec bun\u0000 "$HERE/payload.ts"', 'payload.ts'],
      ['the variable it names', 'HERE="$(cd "$(dirname "$0")" && pwd)"\nexec bun "$HE\u0000RE/payload.ts"', 'payload.ts'],
      ['the own-directory assignment', 'D="$(cd "$(dirname "$0")" &&\u0000 pwd)"\nexec bun "$D/payload.ts"', 'payload.ts'],
      ['the assigned name', 'D\u0000="$(cd "$(dirname "$0")" && pwd)"\nexec bun "$D/payload.ts"', 'payload.ts'],
      ['the end of the own directory', 'D="$(cd "$(dirname "$0")" && pwd)"\u0000/sub\nexec bun "$D/payload.ts"', 'sub/payload.ts'],
    ];
    const stub = fixture('nul-in-line-bin/bun', '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a" >> "$BUN_LOG"; done\n');
    fs.chmodSync(stub, 0o755);
    const hooks = rows.map(([, body], i) => {
      const hook = fixture(`nul-in-line-${i}/hook`, `#!/usr/bin/env bash\nset -e\n${body}\n`);
      fixture(`nul-in-line-${i}/sub/payload.ts`, 'export const ok = 1;\n');
      return hook;
    });
    const bashes = hostBashes();
    const ran: Array<[string, string, string[]]> = [];
    for (const bash of bashes) {
      rows.forEach(([name], i) => {
        const log = path.join(FX, 'fx', `nul-in-line-${i}`, 'bun.log');
        fs.writeFileSync(log, '');
        spawnCaptured(bash, [hooks[i]], { env: { ...process.env, PATH: `${path.dirname(stub)}:${process.env.PATH}`, BUN_LOG: log } });
        const dir = path.dirname(hooks[i]);
        ran.push([bash, name, fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean).map(p => path.relative(dir, p))]);
      });
    }
    expect(ran).toEqual(bashes.flatMap(bash => rows.map(([name, , runs]) => [bash, name, [runs]]))); // the premise
    const got: Array<[string, string, number, string]> = [];
    rows.forEach(([name], i) => {
      const payload = fixture(`nul-in-line-${i}/payload.ts`, 'const broken: number = {\n');
      for (const bash of bashes) {
        const r = runGateWith(bash, [hooks[i]]);
        const clean = !/null byte|MISSING PAYLOAD/.test(r.output);
        got.push([bash, name, r.code, clean && r.output.includes(`FAILS TO PARSE ${payload}`) ? 'followed' : r.output]);
      }
    });
    expect(got).toEqual(rows.flatMap(([name, , runs]) => bashes.map(bash => [bash, name, runs === 'payload.ts' ? 1 : 0, runs === 'payload.ts' ? 'followed' : ''])));
  }, TEST_TIMEOUT_MS);

  test('control: a variable that names somewhere else is not followed', () => {
    const p = fixture('other-var/hook', '#!/usr/bin/env bash\nexec bun "$HOME/never-shipped.ts"\n');
    const r = runGate([p]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test('a variable assigned a path below the shim\'s directory is not followed', () => {
    // `$(cd ... && pwd -P)/sub` is somewhere else. Read as the shim's own
    // directory it named a payload that is not there, refusing a valid hook.
    const shim = '#!/usr/bin/env bash\nD="$(cd "$(dirname "$0")" && pwd -P)/sub"\nexec bun "$D/payload.ts"\n';
    const p = fixture('sub-var/hook', shim);
    fixture('sub-var/sub/payload.ts', 'export const ok = 1;\n');
    const r = runGate([p]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
  }, TEST_TIMEOUT_MS);

  test('an own-directory assignment with text after its closing quote is not followed', () => {
    // `"$(cd ... && pwd)"/sub` is one word to bash: D names sub/. Read as the
    // shim's own directory it names a payload bash never runs, and refuses a
    // valid hook.
    const forms = [
      'D="$(cd "$(dirname "$0")" && pwd)"/sub',
      'D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"/sub',
    ];
    forms.forEach((assign, i) => {
      const p = fixture(`after-quote-${i}/hook`, `#!/usr/bin/env bash\n${assign}\nexec bun "$D/payload.ts"\n`);
      fixture(`after-quote-${i}/sub/payload.ts`, 'export const ok = 1;\n');
      const r = runGate([p]);
      expect([assign, r.code, r.output]).toEqual([assign, 0, '']);
    });
  }, TEST_TIMEOUT_MS);

  test('an own-directory variable set with a redirect on the cd, or extra spaces, is followed', () => {
    // bin/gstack-brain-enqueue spells it `$(cd "$(dirname "$0")" 2>/dev/null && pwd)`.
    // The assignment ends at a blank or at a control operator, with or without
    // a blank before it.
    const forms = [
      'D="$(cd "$(dirname "$0")" 2>/dev/null && pwd)"',
      'D="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"',
      'D="$(cd "$(dirname "$0")"  &&  pwd)" || exit 0',
      'D="$(cd "$(dirname "$0")" && pwd)"; export D',
      'D="$(cd "$(dirname "$0")" && pwd)"|| exit 0',
      'D="$(cd "$(dirname "$0")" && pwd)"&& export D',
    ];
    forms.forEach((assign, i) => {
      fixture(`redirect-var-${i}/hook`, `#!/usr/bin/env bash\n${assign}\nexec bun "$D/payload.ts"\n`);
      fixture(`redirect-var-${i}/payload.ts`, 'const broken: number = {\n');
      const r = runGate([path.join(FX, 'fx', `redirect-var-${i}/hook`)]);
      expect([assign, r.code], r.output).toEqual([assign, 1]);
      expect(r.output).toContain('FAILS TO PARSE');
    });
  }, TEST_TIMEOUT_MS);

  test('an own-directory assignment with a colon later on its line is still followed', () => {
    // The gate reads `grep -n` output as LINE:TEXT, split at the first colon.
    // A fallback message or a trailing comment can carry another one.
    const forms = [
      'D="$(cd "$(dirname "$0")" && pwd)" || { echo "hook: cannot find own dir" >&2; exit 0; }',
      'D="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"  # note: resolves symlinks',
    ];
    forms.forEach((assign, i) => {
      fixture(`colon-var-${i}/hook`, `#!/usr/bin/env bash\n${assign}\nexec bun "$D/payload.ts"\n`);
      fixture(`colon-var-${i}/payload.ts`, 'const broken: number = {\n');
      const r = runGate([path.join(FX, 'fx', `colon-var-${i}/hook`)]);
      expect([assign, r.code], r.output).toEqual([assign, 1]);
      expect(r.output).toContain('FAILS TO PARSE');
    });
  }, TEST_TIMEOUT_MS);

  test('a variable reassigned above the call is not followed; one reassigned below it is', () => {
    // `D="$D/lib"` names lib/, where the shim's directory has no payload.
    const shim = '#!/usr/bin/env bash\nD="$(cd "$(dirname "$0")" && pwd)"\nD="$D/lib"\nexec bun "$D/payload.ts"\n';
    const p = fixture('reassigned-var/hook', shim);
    fixture('reassigned-var/lib/payload.ts', 'export const ok = 1;\n');
    const r = runGate([p]);
    expect(r.output).toBe('');
    expect(r.code).toBe(0);
    // setup's shape: SOURCE_GSTACK_DIR is its own directory when bun runs the
    // payload, and is reassigned only further down.
    const later = '#!/usr/bin/env bash\nD="$(cd "$(dirname "$0")" && pwd -P)"\nbun "$D/payload.ts"\nD="$D/migrated"\n';
    fixture('reassigned-later/hook', later);
    fixture('reassigned-later/payload.ts', 'const broken: number = {\n');
    const l = runGate([path.join(FX, 'fx', 'reassigned-later/hook')]);
    expect(l.code).toBe(1);
    expect(l.output).toContain('FAILS TO PARSE');
  }, TEST_TIMEOUT_MS);

  test('a variable reassigned from its own bun call is followed through its old value', () => {
    // bash expands `$(bun "$D/...")` before it assigns D, so bun is handed the
    // shim's own directory: the assignment that holds the call is not yet in
    // force for it.
    const shim = '#!/usr/bin/env bash\nD="$(cd "$(dirname "$0")" && pwd)"\nD="$(bun "$D/resolve.ts")"\necho "$D"\n';
    fixture('self-reassign/hook', shim);
    const payload = fixture('self-reassign/resolve.ts', 'const broken: number = {\n');
    const r = runGate([path.join(FX, 'fx', 'self-reassign/hook')]);
    expect(r.code, r.output).toBe(1);
    expect(r.output).toContain(`FAILS TO PARSE ${payload}`);
  }, TEST_TIMEOUT_MS);

  test('an assignment counts at a bun call once bash has run it, on a line above or earlier on the call line', () => {
    // bash runs `D="$D/lib"; exec bun "$D/payload.ts"` with D already lib/,
    // and `D="$(cd ... && pwd)"; exec bun ...` with D already the shim's own
    // directory. Until bash has run the assignment's command, the call is
    // inside its value, or is a word of the command it only prefixes, and
    // bash expands the call's $D before it assigns. An assignment that only
    // prefixes a command (`D=x cmd`), or runs in a pipeline or in the
    // background, never changes D for the shim. After `|| exec bun`, the call
    // runs only once the assignment failed. Quotes hide `;`, `|` and `&`.
    // The shim's own payload.ts and resolve.ts are broken and lib/payload.ts
    // is valid, so each file the gate refuses is one it followed into the
    // shim's own directory. A stub bun on PATH records the paths bash hands
    // it, and each row is checked against that record before the gate runs.
    const own = 'D="$(cd "$(dirname "$0")" && pwd)"';
    const rows: Array<[string, string[]]> = [
      [`${own}\nD="$D/lib"; exec bun "$D/payload.ts"`, []],
      [`${own}\nD="$D/lib" && exec bun "$D/payload.ts"`, []],
      [`${own}\nD="$D/lib" || exit 0; exec bun "$D/payload.ts"`, []],
      [`${own}\nD="$(cd "$D/lib" && pwd)" || exec bun "$D/payload.ts"`, []],
      [`${own}; exec bun "$D/payload.ts"`, ['payload.ts']],
      [`${own} && exec bun "$D/payload.ts"`, ['payload.ts']],
      [`${own}\nD="$D/lib" bun "$D/payload.ts"`, ['payload.ts']],
      [`${own}\nD=$(cd "$D" && bun "$D/payload.ts")`, ['payload.ts']],
      [`${own}\nD="$(cd "$D" && bun "$D/payload.ts")"`, ['payload.ts']],
      [`${own}\nD="$(bun "$D/resolve.ts")"; exec bun "$D/payload.ts"`, ['resolve.ts']],
      // A prefix, with or without a redirect, sets D for its command alone.
      [`${own}\nD=/nowhere true; exec bun "$D/payload.ts"`, ['payload.ts']],
      [`${own}\nD="$D/lib" bun "$D/lib/payload.ts"; exec bun "$D/payload.ts"`, ['payload.ts']],
      [`${own}\nD=/nowhere 2>&1 bun "$D/payload.ts"`, ['payload.ts']],
      [`${own}\nD=/nowhere export X=1; exec bun "$D/payload.ts"`, ['payload.ts']],
      [`D=/nowhere\n${own} true; exec bun "$D/payload.ts"`, []],
      // The last assignment run before the call wins, wherever it sits.
      [`${own}\nD="$D/lib"; ${own}; exec bun "$D/payload.ts"`, ['payload.ts']],
      [`${own}; D="$D/lib"; exec bun "$D/payload.ts"`, []],
      [`${own}\nD="$D/lib" X="$(bun "$D/payload.ts")"`, []],
      // Reached only once the cd failed; skipped once an assignment succeeded.
      [`${own} || exec bun "$D/payload.ts"`, []],
      [`D=/nowhere || ${own}; exec bun "$D/payload.ts"`, []],
      // A redirect, or export, still assigns; quotes and $(...) hold words.
      [`${own}\nD="$D/lib" 2>/dev/null; exec bun "$D/payload.ts"`, []],
      [`${own}\nexport D="$D/lib"; exec bun "$D/payload.ts"`, []],
      [`${own}\nD='a | b'; exec bun "$D/payload.ts"`, []],
      [`${own}\nD="$(echo "/no where")"; exec bun "$D/payload.ts"`, []],
      // A subshell's assignment, and operators inside quotes.
      [`${own}\nD="$D/lib" | bun "$D/payload.ts"`, ['payload.ts']],
      [`${own}\nD="$D/lib" & exec bun "$D/payload.ts"`, ['payload.ts']],
      [`${own}\nD="a;b" bun "$D/payload.ts"`, ['payload.ts']],
      [`${own}\nD='x|y' true && exec bun "$D/payload.ts"`, ['payload.ts']],
      // The same rules on a line above the call.
      [`${own}\nD=/nowhere true\nexec bun "$D/payload.ts"`, ['payload.ts']],
      [`${own}\nD="$D/lib" | cat\nexec bun "$D/payload.ts"`, ['payload.ts']],
      [`${own}\ntrue; D="$D/lib"\nexec bun "$D/payload.ts"`, []],
    ];
    const stub = fixture('same-line-assign-bin/bun', '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a" >> "$BUN_LOG"; done\n');
    fs.chmodSync(stub, 0o755);
    const ran = rows.map(([body], i) => {
      const dir = path.join(FX, 'fx', `same-line-assign-${i}`);
      const hook = fixture(`same-line-assign-${i}/hook`, `#!/usr/bin/env bash\n${body}\n`);
      fixture(`same-line-assign-${i}/lib/payload.ts`, 'export const ok = 1;\n');
      const log = path.join(dir, 'bun.log');
      fs.writeFileSync(log, '');
      spawnCaptured('/bin/bash', [hook], { env: { ...process.env, PATH: `${path.dirname(stub)}:${process.env.PATH}`, BUN_LOG: log } });
      const handed = fs.readFileSync(log, 'utf-8').split('\n');
      return [body, ['payload.ts', 'resolve.ts'].filter(name => handed.includes(path.join(dir, name)))];
    });
    expect(ran).toEqual(rows); // the premise: what bash hands bun
    const got = rows.map(([body], i) => {
      const dir = `same-line-assign-${i}`;
      const hook = path.join(FX, 'fx', dir, 'hook');
      const files = ['payload.ts', 'resolve.ts'].map(name => [name, fixture(`${dir}/${name}`, 'const broken: number = {\n')]);
      const r = runGate([hook]);
      return [body, files.filter(([, p]) => r.output.includes(`FAILS TO PARSE ${p}`)).map(([name]) => name), r.code];
    });
    expect(got).toEqual(rows.map(([body, followed]) => [body, followed, followed.length ? 1 : 0]));
  }, TEST_TIMEOUT_MS);

  test.skipIf(!UTF8_LOCALES.length)('a line holding invalid UTF-8 bytes is read a byte at a time under a UTF-8 locale', () => {
    // bash hands bun `<the bytes>/payload.ts` or `/x/payload.ts` for the first
    // three, in any locale: D is not the shim's own directory. Read as UTF-8,
    // /bin/bash 3.2 takes an invalid byte and the byte after it as one
    // character, a `;` or a closing quote included, and the line scan then
    // followed the shim's own directory. glibc's bash reads them a byte at a
    // time either way.
    const own = 'D="$(cd "$(dirname "$0")" && pwd)"';
    const rows: Array<[string, Buffer, boolean]> = [
      ['run-on', Buffer.from('D=\xe9\xc3; true', 'latin1'), false],
      ['quoted', Buffer.from("D='\xe9\xc3'; true", 'latin1'), false],
      ['prefix-then', Buffer.from('X="\xe9" D=/x', 'latin1'), false],
      ['control', Buffer.from('D=\xe9 true', 'latin1'), true],
    ];
    const got: Array<[string, string, number, boolean]> = [];
    for (const [name, line] of rows) {
      const shim = fixture(`scan-bytes-${name}/hook`, '');
      fs.writeFileSync(shim, Buffer.concat([Buffer.from(`#!/usr/bin/env bash\n${own}\n`), line, Buffer.from('\nexec bun "$D/payload.ts"\n')]));
      const payload = fixture(`scan-bytes-${name}/payload.ts`, 'const broken: number = {\n');
      for (const loc of UTF8_LOCALES) {
        const r = runGate([shim], { LC_ALL: loc, LANG: loc });
        got.push([name, loc, r.code, r.output.includes(`FAILS TO PARSE ${payload}`)]);
      }
    }
    expect(got).toEqual(rows.flatMap(([name, , followed]) => UTF8_LOCALES.map(loc => [name, loc, followed ? 1 : 0, followed])));
  }, TEST_TIMEOUT_MS);

  test('a payload after a bun call that is not followed, on the same line, is still found', () => {
    const shim = '#!/usr/bin/env bash\nHERE="$(cd "$(dirname "$0")" && pwd)"\nbun "$HOME/elsewhere.ts"; exec bun "$HERE/hook.ts"\n';
    fixture('same-line/hook', shim);
    fixture('same-line/hook.ts', 'const broken: number = {\n');
    const r = runGate([path.join(FX, 'fx', 'same-line/hook')]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('FAILS TO PARSE');
    expect(r.output).toContain('hook.ts');
  }, TEST_TIMEOUT_MS);

  test('a call that is not followed does not excuse a missing payload after it on the same line', () => {
    // Only a followed call makes the calls after it optional. One that names
    // somewhere else, through a variable never set or one set elsewhere,
    // leaves the next call the first one that must ship.
    const head = '#!/usr/bin/env bash\nHERE="$(cd "$(dirname "$0")" && pwd)"\n';
    const lines = [
      'bun "$HOME/elsewhere.ts"; exec bun "$HERE/gone.ts"',
      'D="$HOME/lib"\nbun "$D/elsewhere.ts"; exec bun "$HERE/gone.ts"',
    ];
    lines.forEach((l, i) => {
      const r = runGate([fixture(`unfollowed-then-missing-${i}/hook`, `${head}${l}\n`)]);
      expect([l, r.code], r.output).toEqual([l, 1]);
      expect(r.output).toContain(`MISSING PAYLOAD ${path.join(FX, 'fx', `unfollowed-then-missing-${i}`, 'gone.ts')}`);
    });
  }, TEST_TIMEOUT_MS);

  test('a later bun call on a line, in a comment or a string, need not exist; when it does, it is parsed', () => {
    // Only the first followed call on a line must ship. A trailing comment or
    // a quoted fallback can name a file bash never runs.
    const head = '#!/usr/bin/env bash\nHERE="$(cd "$(dirname "$0")" && pwd)"\n';
    const lines = [
      'exec bun "$HERE/hook.ts"  # was: bun "$HERE/old-hook.ts" before the rename',
      'exec bun "$HERE/hook.ts" || echo \'fallback: bun "$HERE/legacy.ts"\'',
    ];
    lines.forEach((l, i) => {
      fixture(`later-call-${i}/hook`, `${head}${l}\n`);
      fixture(`later-call-${i}/hook.ts`, 'export const ok = 1;\n');
      const r = runGate([path.join(FX, 'fx', `later-call-${i}/hook`)]);
      expect([l, r.code, r.output]).toEqual([l, 0, '']);
    });
    fixture('later-call-both/hook', `${head}bun "$HERE/a.ts"; exec bun "$HERE/b.ts"\n`);
    fixture('later-call-both/a.ts', 'export const ok = 1;\n');
    fixture('later-call-both/b.ts', 'const broken: number = {\n');
    const both = runGate([path.join(FX, 'fx', 'later-call-both/hook')]);
    expect(both.code).toBe(1);
    expect(both.output).toContain('b.ts');
  }, TEST_TIMEOUT_MS);

  test('a later bun call need not exist when the first one on its line was already checked this run', () => {
    // What makes a later call optional is that the line's first followed call
    // ships, not that this run built it there first. An earlier line, or a
    // sibling shim sharing the payload, must not make a trailing comment's
    // path a requirement.
    const head = '#!/usr/bin/env bash\nHERE="$(cd "$(dirname "$0")" && pwd)"\n';
    const tail = 'exec bun "$HERE/hook.ts"  # was: bun "$HERE/old-hook.ts"';
    const line = fixture('seen-line/hook', `${head}bun "$HERE/hook.ts"\n${tail}\n`);
    fixture('seen-line/hook.ts', 'export const ok = 1;\n');
    fixture('seen-shim/hook-a', SHIM('hook.ts'));
    fixture('seen-shim/hook-b', `${head}${tail}\n`);
    fixture('seen-shim/hook.ts', 'export const ok = 1;\n');
    const dir = path.join(FX, 'fx', 'seen-shim');
    for (const args of [[line], [dir], [path.join(dir, 'hook-a'), path.join(dir, 'hook-b')]]) {
      const r = runGate(args);
      expect([args, r.code, r.output]).toEqual([args, 0, '']);
    }
  }, TEST_TIMEOUT_MS);

  test('a payload a later call only mentions must still ship when another call runs it', () => {
    // A trailing comment may name a file that is not there. That must not
    // excuse the same file when a later line, or another shim, runs it, in
    // whichever order the sweep reaches them.
    const head = '#!/usr/bin/env bash\nHERE="$(cd "$(dirname "$0")" && pwd)"\n';
    const line = fixture('mentioned-line/hook', `${head}bun "$HERE/a.ts"  # was: bun "$HERE/b.ts"\nexec bun "$HERE/b.ts"\n`);
    fixture('mentioned-line/a.ts', 'export const ok = 1;\n');
    fixture('mentioned-shim/hook-a', `${head}exec bun "$HERE/a.ts"  # was: bun "$HERE/b.ts"\n`);
    fixture('mentioned-shim/hook-b', SHIM('b.ts'));
    fixture('mentioned-shim/a.ts', 'export const ok = 1;\n');
    const dir = path.join(FX, 'fx', 'mentioned-shim');
    const a = path.join(dir, 'hook-a');
    const b = path.join(dir, 'hook-b');
    for (const args of [[line], [dir], [a, b], [b, a]]) {
      const r = runGate(args);
      expect([args, r.code], r.output).toEqual([args, 1]);
      expect(r.output).toContain('MISSING PAYLOAD');
      expect(r.output).toContain('/b.ts — handed to bun by');
    }
  }, TEST_TIMEOUT_MS);

  test('a payload another payload imports as text is still parsed, in either order', () => {
    // A text import is listed in the build's metafile but never parsed. Listed
    // first, it must not count as the second shim's payload already checked.
    for (const [first, second] of [['a-hook', 'b-hook'], ['b-hook', 'a-hook']]) {
      const dir = `text-import-${first}`;
      fixture(`${dir}/a-hook`, SHIM('a.ts'));
      fixture(`${dir}/a.ts`, "import b from './b.ts' with { type: 'text' };\nconsole.log(b.length);\n");
      fixture(`${dir}/b-hook`, SHIM('b.ts'));
      fixture(`${dir}/b.ts`, 'const broken: number = {\n');
      // Through the real path: bun lists imports by real path, and a TMPDIR
      // behind a symlink (/var, /tmp on macOS) would spell the shims' payloads
      // differently, so the two would never meet and the case could not fail.
      const real = fs.realpathSync(path.join(FX, 'fx', dir));
      const r = runGate(['--report', path.join(real, first), path.join(real, second)]);
      expect(r.code, `${first} then ${second}\n${r.output}`).toBe(1);
      expect(r.output).toContain('FAILS TO PARSE');
      expect(r.output).toContain('b.ts');
    }
  }, TEST_TIMEOUT_MS);

  test('an import bun names by drive letter is placed through cygpath, or reported', () => {
    // Bun on Windows lists C:\... paths. A stub bun stands in for it here.
    const bin = path.join(FX, 'fx', 'drive', 'bin');
    fixture('drive/hook', SHIM('hook.ts'));
    fixture('drive/hook.ts', 'export const ok = 1;\n');
    const helper = fixture('drive/helper.ts', `export const s = \`\n${LT} HEAD\na\n${EQ}\nb\n${GT} other\n\`;\n`);
    fixture('drive/bin/bun', '#!/bin/bash\ncase "$1" in\n  --version) echo 1.3.13 ;;\n  -e) printf \'%s\\n\' \'C:\\repo\\helper.ts\' ;;\nesac\nexit 0\n');
    fs.chmodSync(path.join(bin, 'bun'), 0o755);
    const shim = path.join(FX, 'fx', 'drive', 'hook');
    const unplaced = runGate(['--report', shim], { HOOK_SYNTAX_BUN: path.join(bin, 'bun') });
    expect(unplaced.code).toBe(0);
    expect(unplaced.output).toContain('cannot place C:\\repo\\helper.ts');
    expect(unplaced.output).toContain('NOT marker-scanned');
    // A cygpath that succeeds and prints nothing has not placed the file.
    // Taken as the path, the empty line would drop the import unreported.
    fixture('drive/bin/cygpath', '#!/bin/bash\nexit 0\n');
    fs.chmodSync(path.join(bin, 'cygpath'), 0o755);
    const empty = runGate(['--report', shim], { HOOK_SYNTAX_BUN: path.join(bin, 'bun'), PATH: `${bin}:${process.env.PATH}` });
    expect(empty.code, empty.output).toBe(0);
    expect(empty.output).toContain('cannot place C:\\repo\\helper.ts');
    expect(empty.output).toContain('NOT marker-scanned');
    fixture('drive/bin/cygpath', `#!/bin/bash\n[ "$1" = -u ] && printf '%s\\n' ${JSON.stringify(helper)}\n`);
    fs.chmodSync(path.join(bin, 'cygpath'), 0o755);
    const placed = runGate(['--report', shim], { HOOK_SYNTAX_BUN: path.join(bin, 'bun'), PATH: `${bin}:${process.env.PATH}` });
    expect(placed.code).toBe(1);
    expect(placed.output).toContain('UNRESOLVED CONFLICT MARKERS');
    expect(placed.output).toContain('helper.ts');
  }, TEST_TIMEOUT_MS);

  test('a payload a shim names but does not ship is a failure', () => {
    const r = runGate([fixture('missing/hook', SHIM('gone.ts'))]);
    expect(r.code).toBe(1);
    expect(r.output).toContain('MISSING PAYLOAD');
  }, TEST_TIMEOUT_MS);

  test('a missing payload on a later line, or in a later shim of the same sweep, is still a failure', () => {
    // Only a later call on the SAME line may be absent. The first followed
    // call on every line, in every shim the sweep reaches, must ship.
    const head = '#!/usr/bin/env bash\nHERE="$(cd "$(dirname "$0")" && pwd)"\n';
    const line = fixture('later-line-missing/hook', `${head}bun "$HERE/a.ts"\nexec bun "$HERE/gone.ts"\n`);
    fixture('later-line-missing/a.ts', 'export const ok = 1;\n');
    fixture('later-shim-missing/hook-a', SHIM('a.ts'));
    fixture('later-shim-missing/a.ts', 'export const ok = 1;\n');
    fixture('later-shim-missing/hook-b', SHIM('gone.ts'));
    for (const target of [line, path.join(FX, 'fx', 'later-shim-missing')]) {
      const r = runGate([target]);
      expect([target, r.code], r.output).toEqual([target, 1]);
      expect(r.output).toContain('MISSING PAYLOAD');
      expect(r.output).toContain('/gone.ts — handed to bun by');
    }
  }, TEST_TIMEOUT_MS);

  test('a payload two shims run is built, and reported, once', () => {
    // An entry point is recorded once it is judged: one bun build per
    // payload however many shims run it, so one broken file is one FAILS TO
    // PARSE and one missing file is one MISSING PAYLOAD.
    fixture('two-shims/a-hook', SHIM('x.ts'));
    fixture('two-shims/b-hook', SHIM('x.ts'));
    fixture('two-shims/c-hook', SHIM('gone.ts'));
    fixture('two-shims/d-hook', SHIM('gone.ts'));
    fixture('two-shims/x.ts', 'const broken: number = {\n');
    const r = runGate(['--report', path.join(FX, 'fx', 'two-shims')]);
    expect(r.code, r.output).toBe(1);
    expect(r.output.split('FAILS TO PARSE').length - 1, r.output).toBe(1);
    expect(r.output.split('MISSING PAYLOAD').length - 1, r.output).toBe(1);
    expect(r.output).toContain('hook-syntax: 5 checked, 0 skipped');
  }, TEST_TIMEOUT_MS);

  test('a payload whose name holds a tab is followed: VAR ends at the first tab', () => {
    // The calls are carried as VAR<TAB>rel. A variable name cannot hold a tab
    // and a path can, so a split at any later tab names a VAR no line sets,
    // and the payload drops out unparsed. Swept as a directory, as setup does.
    fixture('tab-name/hook', SHIM('a\tb.ts'));
    const payload = fixture('tab-name/a\tb.ts', 'const broken: number = {\n');
    const r = runGate([path.join(FX, 'fx', 'tab-name')]);
    expect(r.code, r.output).toBe(1);
    expect(r.output).toContain(`FAILS TO PARSE ${fs.realpathSync(payload)}`);
  }, TEST_TIMEOUT_MS);
});

// ── the caller's environment ───────────────────────────────────────────────

// A PATH whose first grep applies GREP_OPTIONS as macOS grep (BSD 2.6.0)
// does, its words ahead of the arguments. GNU grep has ignored the variable
// since 3.6, so on Linux a case that left it to the host grep passed whether
// or not anything unset it.
function bsdGrepPath(): string {
  const dir = path.join(FX, 'bsd-grep');
  if (!fs.existsSync(path.join(dir, 'grep'))) {
    const real = spawnCaptured('/bin/sh', ['-c', 'command -v grep']).stdout.trim();
    if (!real.startsWith('/')) throw new Error(`no grep on PATH: ${JSON.stringify(real)}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'grep'), `#!/bin/sh\nopts=$GREP_OPTIONS\nunset GREP_OPTIONS\nexec '${real}' $opts "$@"\n`, { mode: 0o755 });
  }
  return `${dir}:${process.env.PATH ?? '/usr/bin:/bin'}`;
}

// A shim over a valid payload, and beside it an own-directory shim over a
// broken payload and a shell file with conflict markers in a heredoc. What
// the gate says about each must not change with the caller's environment.
function expectVerdictsUnchanged(env: Record<string, string>): void {
  fixture('caller-env/ok/hook', SHIM('hook.ts'));
  fixture('caller-env/ok/hook.ts', 'export const ok = 1;\n');
  const ok = runGate(['--report', path.join(FX, 'fx', 'caller-env', 'ok')], env);
  expect(ok.code, ok.output).toBe(0);
  expect(ok.output).toBe('hook-syntax: 2 checked, 0 skipped');
  fixture('caller-env/bad/hook', '#!/usr/bin/env bash\nD="$(cd "$(dirname "$0")" && pwd)"\nexec bun "$D/payload.ts"\n');
  const payload = fixture('caller-env/bad/payload.ts', 'const broken: number = {\n');
  const merged = fixture('caller-env/bad/merged.sh', `#!/bin/bash\n${CONFLICT_HEREDOC}`);
  const bad = runGate([path.join(FX, 'fx', 'caller-env', 'bad')], env);
  expect(bad.code, bad.output).toBe(1);
  expect(bad.output).toContain(`FAILS TO PARSE ${fs.realpathSync(payload)}`);
  expect(bad.output).toContain(`UNRESOLVED CONFLICT MARKERS in ${fs.realpathSync(merged)}`);
}

// What a function the caller exported (`export -f`) runs in place of: in
// every bash started with it, the gate included, it shadows the command it
// is named after.
const EXPORTED_FUNCTIONS: Array<[string, string]> = [
  ['grep', 'command grep --color=always "$@"'],
  ['find', ':'],
];

describe("hook-syntax: the caller's environment", () => {
  // A grep forcing --color=always passed a broken payload behind an
  // own-directory variable; a find that prints nothing refused a healthy tree
  // as "no files found".
  for (const [name, body] of EXPORTED_FUNCTIONS) {
    test(`a ${name} function the caller exported changes no verdict`, () => {
      expectVerdictsUnchanged({ [`BASH_FUNC_${name}%%`]: `() {  ${body}\n}` });
    }, TEST_TIMEOUT_MS);
  }

  test('a shell that sources the gate keeps its own functions', () => {
    // Only a run drops them: sourced, the shell is the caller's own.
    const r = spawnCaptured('/bin/bash', ['-c', 'mine() { echo kept; }; . "$1" && mine', 'sh', GATE]);
    expect([codeOf(r), r.stdout, r.stderr]).toEqual([0, 'kept\n', '']);
  }, TEST_TIMEOUT_MS);

  test('a colour-forcing GREP_OPTIONS neither invents a missing payload nor hides a broken file', () => {
    // macOS grep (BSD 2.6.0) still applies GREP_OPTIONS, without a word, and
    // GNU grep did until 3.6. --color=always wraps every match in escapes: the
    // path read out of a `bun "$HERE/..."` hit carried them, so a healthy shim
    // read MISSING PAYLOAD and setup refused the tree, and an own-directory
    // assignment no longer matched, so its broken payload went unchecked. The
    // grep first on PATH applies the variable on any host.
    expectVerdictsUnchanged({ GREP_OPTIONS: '--color=always', PATH: bsdGrepPath() });
  }, TEST_TIMEOUT_MS);

  // POSIXLY_CORRECT or POSIX_PEDANTIC, or `posix` in an exported SHELLOPTS,
  // starts /bin/bash in POSIX mode, and bash 3.2 there rejects process
  // substitution: the gate's first function holding one was a syntax error,
  // exit 2, which setup reads as "could not run" and refuses a healthy tree
  // on. bash 5.1 and later allow it in POSIX mode, so where /bin/bash is one
  // these pass either way, and a source pin under line endings holds the
  // lines that turn the mode off.
  for (const [label, env] of POSIX_ENVS) {
    test(`the gate reaches a verdict with ${label} exported`, () => {
      // The healthy file holds a process substitution of its own, as the gate
      // and heal-eol.sh do: its `-n` parse must not inherit POSIX mode.
      const ok = fixture(`posix-env/${label.split('=')[0].toLowerCase()}/ok.sh`, '#!/bin/bash\nwhile read -r l; do :; done < <(echo x)\n');
      const bad = fixture(`posix-env/${label.split('=')[0].toLowerCase()}/bad.sh`, '#!/bin/bash\nif true; then\n');
      const good = runGate(['--report', ok], env);
      expect([label, good.code], good.output).toEqual([label, 0]);
      expect(good.output).toBe('hook-syntax: 1 checked, 0 skipped');
      const broken = runGate([bad], env);
      expect([label, broken.code], broken.output).toEqual([label, 1]);
      expect(broken.output).toContain(`FAILS TO PARSE ${bad}`);
    }, TEST_TIMEOUT_MS);
  }

  // nounset, from `bash -u` or `nounset` in an exported SHELLOPTS, makes bash
  // 3.2 abort on "${a[@]}" over an empty array: the gate ended in "unbound
  // variable" and exit 1, which setup reads as a tree that does not parse.
  // bash 4.4 and later expand an empty array under nounset, so where /bin/bash
  // is one this passes either way.
  test('the gate reaches a verdict with nounset turned on by the caller', () => {
    // A shim that names its payload through a variable it never assigns leaves
    // the own-directory lookup's list empty, a payload parsed before any file
    // was skipped leaves the skipped list empty, and a tree with no shell file
    // leaves the content scans' lists empty.
    const shim = fixture('nounset/shim/hook', '#!/usr/bin/env bash\nexec bun "$X/payload.ts"\n');
    const followed = fixture('nounset/payload/hook', SHIM('hook.ts'));
    fixture('nounset/payload/hook.ts', 'export const ok = 1;\n');
    const text = path.dirname(fixture('nounset/text/notes.txt', 'hello\n'));
    const rows: Array<[string, string[], Record<string, string>, string]> = [];
    const targets = [[shim, '1 checked, 0 skipped'], [path.dirname(shim), '1 checked, 0 skipped'], [followed, '2 checked, 0 skipped'], [text, '0 checked, 1 skipped']];
    for (const [target, report] of targets) {
      rows.push([target, ['-u'], {}, report], [target, [], { SHELLOPTS: 'nounset' }, report]);
    }
    const got = rows.map(([target, flags, env]) => {
      const r = spawnCaptured('/bin/bash', [...flags, GATE, '--report', target], { env: { ...process.env, ...env } });
      return [target, flags, env, codeOf(r), `${r.stdout}${r.stderr}`.trim()];
    });
    expect(got).toEqual(rows.map(([target, flags, env, report]) => [target, flags, env, 0, `hook-syntax: ${report}`]));
  }, TEST_TIMEOUT_MS);
});

// ── house rules ────────────────────────────────────────────────────────────

describe.skipIf(process.platform === 'win32')('setup: the canonical tree hooks are registered from', () => {
  // Hooks are registered under ~/.claude/skills/gstack, which can resolve into
  // a checkout other than the one setup runs from. That tree is gated too.
  // Each fixture is a full checkout; removing several took over Bun's 5 s
  // default hook timeout at a load average near 300.
  afterAll(cleanupFixtures, 120_000);

  // A whole install, not one gate run: about 20-30 s on this Mac at a load
  // average near 100, and past 120 s near 350. The bound only catches a hang.
  const SETUP_RUN_TIMEOUT_MS = 480_000;
  const setupIn = (f: Fixture, setup: string, args: string[] = []) =>
    spawnCaptured('bash', [setup, '--no-plan-tune-hooks', ...args], { cwd: f.home, env: f.env, timeout: SETUP_RUN_TIMEOUT_MS });
  const settings = (f: Fixture) => {
    const p = path.join(f.home, '.claude', 'settings.json');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
  };
  // A pending migration: the state root marked at the newest shipped
  // migration, and one more in the running checkout that leaves a file when it
  // runs. One shipped migration registers a hook, so a refused run runs none.
  // The checkout's VERSION is moved one step past the newest migration: a
  // release that ships a migration names it after itself, and setup runs none
  // while the marker equals VERSION.
  const marker = (f: Fixture) => path.join(f.home, '.gstack', '.last-setup-version');
  const ran = (f: Fixture) => fs.existsSync(path.join(f.home, 'pending-migration-ran'));
  const pendingMigration = (f: Fixture, src: string) => {
    const dir = path.join(src, 'gstack-upgrade', 'migrations');
    const cmp = (x: string, y: string) => {
      const a = x.split('.').map(Number), b = y.split('.').map(Number);
      for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
      return 0;
    };
    const newest = fs.readdirSync(dir).filter(n => /^v[0-9.]+\.sh$/.test(n)).map(n => n.slice(1, -3)).sort(cmp).pop()!;
    put(marker(f), `${newest}\n`);
    put(path.join(dir, `v${newest}.1.sh`), '#!/bin/bash\ntouch "$HOME/pending-migration-ran"\n', 0o755);
    const parts = newest.split('.').map(Number);
    parts[parts.length - 1] += 1;
    put(path.join(src, 'VERSION'), `${parts.join('.')}\n`);
    return newest;
  };

  // Every run names its host rather than lean on setup's default (claude):
  // only a run that installs for Claude gates the canonical tree, and the
  // --host codex run below is the contrast.
  test('a broken global checkout gets no hook registered from a clean second checkout', () => {
    const f = makeFixture();
    const a = makeSource(f, path.join(f.home, 'src-a/gstack'));
    const b = makeSource(f, path.join(f.home, 'src-b/gstack'));
    const canon = path.join(f.home, '.claude/skills/gstack');
    // A owns the global link, installed without the Stop hook.
    const first = setupIn(f, path.join(a, 'setup'), ['--host', 'claude', '--no-timeline-stop-hook']);
    expect(first.status, first.stderr).toBe(0);
    expect(fs.realpathSync(canon)).toBe(fs.realpathSync(a));
    expect(settings(f)).not.toContain('timeline-stop-hook');
    // A goes mid-merge; B is clean and asks for the Stop hook. A's opt-out is
    // saved in config, so B must ask explicitly for there to be a hook at all.
    const hook = path.join(a, 'hosts/claude/hooks/timeline-stop-hook');
    put(hook, `${fs.readFileSync(hook, 'utf-8')}\n${CONFLICT_HEREDOC}`, 0o755);
    const marked = pendingMigration(f, b);
    const r = setupIn(f, path.join(b, 'setup'), ['--host', 'claude', '--timeline-stop-hook']);
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain('REFUSING TO REGISTER HOOKS');
    expect(r.stderr).toContain('UNRESOLVED CONFLICT MARKERS');
    // The last line names the tree to fix and everything this run skipped,
    // and sends the reader up to the gate's details. Matched as a whole line.
    const closing = (tree: string) => `\nsetup finished WITHOUT registering hooks or running migrations: ${tree} failed the hook parse gate (see above).\n`;
    expect(r.stderr).toContain(closing(fs.realpathSync(a)));
    // A link there is re-pointed by --global, so the refusal offers it.
    expect(r.stderr).toContain('\nFix that checkout, or make this one the global install (./setup --global),\nthen re-run ./setup.\n');
    expect(settings(f)).not.toContain('timeline-stop-hook');
    // No migration ran, and the marker did not move: the next ./setup runs it.
    expect(ran(f)).toBe(false);
    expect(fs.readFileSync(marker(f), 'utf-8').trim()).toBe(marked);
    expect(r.stderr).toContain('ran no migration');

    // The same broken checkout as a real directory at the global path, the
    // README's `git clone ... ~/.claude/skills/gstack` install. setup never
    // replaces a real directory there, and it resolves to itself, not to the
    // checkout setup runs from, so it is gated the same way.
    expect(fs.lstatSync(canon).isSymbolicLink()).toBe(true);
    fs.unlinkSync(canon);
    fs.renameSync(a, canon);
    expect(fs.lstatSync(canon).isDirectory()).toBe(true);
    expect(fs.realpathSync(canon)).toBe(canon);
    const real = setupIn(f, path.join(b, 'setup'), ['--host', 'claude', '--timeline-stop-hook']);
    expect(real.status, real.stdout + real.stderr).toBe(1);
    expect(real.stderr).toContain(`REFUSING TO REGISTER HOOKS: ${canon} resolves to ${canon},`);
    expect(real.stderr).toContain(closing(canon));
    // --global never replaces a real directory, so the refusal must not offer
    // it: a user who followed that advice met the same refusal again.
    const realFix = `\nFix that checkout, then re-run ./setup. ./setup --global would not help:\nsetup never replaces a real directory at ${canon}.\n`;
    expect(real.stderr).toContain(realFix);
    expect(real.stderr).not.toContain('(./setup --global)');
    const again = setupIn(f, path.join(b, 'setup'), ['--host', 'claude', '--global', '--timeline-stop-hook']);
    expect(again.status, again.stdout + again.stderr).toBe(1);
    expect(fs.lstatSync(canon).isDirectory()).toBe(true);
    expect(again.stderr).toContain(realFix);
    expect(settings(f)).not.toContain('timeline-stop-hook');
    expect(ran(f)).toBe(false);
    expect(fs.readFileSync(marker(f), 'utf-8').trim()).toBe(marked);

    // A run for another host registers and re-points no hook into the Claude
    // checkout, so that checkout does not gate it (#2347: --host codex leaves
    // the Claude install alone). The one migration that registers a hook,
    // v1.58.0.0 inside Conductor, names the checkout setup runs from, which
    // setup's first sweep passed. The run finishes and runs the migration the
    // refused runs skipped.
    const before = settings(f);
    const codex = setupIn(f, path.join(b, 'setup'), ['--host', 'codex']);
    expect(codex.status, codex.stdout + codex.stderr).toBe(0);
    expect(codex.stderr).not.toContain('REFUSING TO REGISTER HOOKS');
    expect(ran(f)).toBe(true);
    expect(fs.readFileSync(marker(f), 'utf-8').trim()).toBe(fs.readFileSync(path.join(b, 'VERSION'), 'utf-8').trim());
    expect(settings(f)).toBe(before);
  }, 5 * SETUP_RUN_TIMEOUT_MS + 60_000);

  test('control: a healthy global checkout still gets its hooks from a second checkout', () => {
    const f = makeFixture();
    const a = makeSource(f, path.join(f.home, 'src-a/gstack'));
    const b = makeSource(f, path.join(f.home, 'src-b/gstack'));
    expect(setupIn(f, path.join(a, 'setup'), ['--host', 'claude', '--no-timeline-stop-hook']).status).toBe(0);
    pendingMigration(f, b);
    const r = setupIn(f, path.join(b, 'setup'), ['--host', 'claude', '--timeline-stop-hook']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stderr).not.toContain('REFUSING TO REGISTER HOOKS');
    expect(settings(f)).toContain(path.join(f.home, '.claude/skills/gstack/hosts/claude/hooks/timeline-stop-hook'));
    expect(ran(f)).toBe(true);
    expect(fs.readFileSync(marker(f), 'utf-8').trim()).toBe(fs.readFileSync(path.join(b, 'VERSION'), 'utf-8').trim());
  }, 2 * SETUP_RUN_TIMEOUT_MS + 60_000);
});

describe('hook-syntax: house rules', () => {
  test('the harness reads a killed gate as killed, never as exit 1', () => {
    const r = spawnCaptured('/bin/sh', ['-c', 'kill -KILL $$']);
    expect(r.status).toBeNull();
    expect(r.signal).toBe('SIGKILL');
    expect(codeOf(r)).toBe(-1);
  });

  test('the gate ships a /bin/bash shebang and carries no heredoc', () => {
    // A PATH bash on macOS is Homebrew's 5.x, which can deadlock writing a
    // heredoc body.
    expect(GATE_SRC.split('\n')[0]).toBe('#!/bin/bash');
    expect(GATE_SRC.split('\n').filter(l => !/^\s*#/.test(l)).some(l => /<<-?\s*['"]?[A-Z]+/.test(l))).toBe(false);
  });

  test('every verdict is exit 0 or 1; any other code means the gate did not run', () => {
    // setup reads the exit: 1 is "a file is broken", and anything but 0 or 1
    // is "the checker could not reach a verdict". A third code from the gate
    // itself would blur those.
    fixture('exit-matrix/ok.sh', '#!/bin/bash\nexit 0\n');
    fixture('exit-matrix-bad/broken.sh', '#!/bin/bash\nif true; then\n');
    fs.mkdirSync(path.join(FX, 'fx', 'exit-matrix-empty'), { recursive: true });
    const runs: [string[], Record<string, string>, number][] = [
      [[path.join(FX, 'fx', 'exit-matrix')], {}, 0],
      [[path.join(FX, 'fx', 'exit-matrix-bad')], {}, 1],
      [[path.join(FX, 'fx', 'exit-matrix-empty')], {}, 1],
      [[path.join(FX, 'fx', 'no-such-dir-at-all')], {}, 1],
      [[path.join(FX, 'fx', 'no-such-file.sh')], {}, 1],
      [['--report', path.join(FX, 'fx', 'exit-matrix')], { HOOK_SYNTAX_BUN: 'definitely-not-bun', HOOK_SYNTAX_PYTHON: 'definitely-not-python' }, 0],
    ];
    for (const [args, env, want] of runs) {
      expect([args.join(' '), runGate(args, env).code]).toEqual([args.join(' '), want]);
    }
    // And statically: the direct invocation's status is only ever 0 or 1.
    const assigned = [...GATE_SRC.matchAll(/_rc=([^\s;|]+)/g)].map((m) => m[1]);
    expect(new Set(assigned)).toEqual(new Set(['0', '1']));
  }, TEST_TIMEOUT_MS);

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

function runSetup(dir: string, home: string, extra: Record<string, string> = {}): Run {
  // A scrubbed env: if the gate ever let setup through by mistake, every
  // write must land in the scratch HOME, never in a real GSTACK_HOME,
  // CLAUDE_CONFIG_DIR or CODEX_HOME inherited from the caller. `extra` adds
  // the one variable a case is about.
  const r = spawnCaptured('/bin/bash', [path.join(dir, 'tree', 'setup'), '--no-prefix', '--no-team'], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, TMPDIR: path.join(dir, 'tmp'), ...extra },
    cwd: path.join(dir, 'tree'),
  });
  const killed = r.signal ? `\n[killed by ${r.signal}]` : '';
  return { code: codeOf(r), output: `${r.stdout}${r.stderr}${killed}` };
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

  // What a user's shell may export that changed the gate's verdict on a
  // healthy tree. The tree's hook hands a payload to bun, so the payload
  // search runs too.
  const CALLER_ENVS: Array<[string, Record<string, string>]> = [
    ['GREP_OPTIONS=--color=always', { GREP_OPTIONS: '--color=always' }],
    ...POSIX_ENVS,
  ];
  for (const [label, extra] of CALLER_ENVS) {
    test(`control: a healthy tree gets past the gate with ${label} exported`, () => {
      const { dir, home } = mkSetupTree();
      const hooks = path.join(dir, 'tree', 'hosts', 'claude', 'hooks');
      fs.writeFileSync(path.join(hooks, 'question-preference-hook'), SHIM('question-preference-hook.ts'));
      fs.writeFileSync(path.join(hooks, 'question-preference-hook.ts'), 'export const ok = 1;\n');
      const r = runSetup(dir, home, extra);
      expect(r.output).not.toContain('REFUSING TO REGISTER');
      expect(r.output).not.toContain('hook-syntax:');
      expect(r.output).toContain(PAST_GATE);
      expect(homeIsEmpty(home)).toBe(true);
    }, TEST_TIMEOUT_MS);
  }

  test('setup unsets GREP_OPTIONS before its own greps read a match back', () => {
    // setup takes the name it links each skill under from
    // `grep -m1 '^name:'`, and macOS grep applies GREP_OPTIONS: with
    // --color=always the name came back wrapped in escapes, and the skill was
    // linked under that. The stub setup runs first after the gate makes the
    // same read, through a grep that applies the variable on any host.
    const { dir, home } = mkSetupTree();
    fs.writeFileSync(path.join(dir, 'tree', 'bin', 'gstack-state-root.sh'), `echo "${PAST_GATE}: $(printf 'name: qa\\n' | grep -m1 '^name:')"\nexit 7\n`);
    const r = runSetup(dir, home, { GREP_OPTIONS: '--color=always', PATH: bsdGrepPath() });
    expect(r.output).toContain(`${PAST_GATE}: name: qa\n`);
    expect(homeIsEmpty(home)).toBe(true);
  }, TEST_TIMEOUT_MS);

  for (const code of [2, 127]) {
    test(`a gate that exits ${code} is "could not run", never "does not parse"`, () => {
      // 126/127: the interpreter could not exec the checker. 2: bash could
      // not parse the checker itself, as in a half-merged copy. Nothing was
      // checked, so setup still refuses, but must not send anyone hunting for
      // a broken file.
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
