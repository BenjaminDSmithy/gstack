/**
 * A missing sourced twin fails loudly on every bash gstack meets.
 *
 * setup and the shipped executables source a sibling file
 * (bin/gstack-state-root.sh, bin/gstack-remote-identity.sh) with a
 * `|| { echo "... is missing ..."; exit 1; }` fallback. Under macOS's
 * /bin/bash 3.2 with `set -e`, and under any bash in POSIX mode, `.` of a
 * missing file exits the shell before `||` runs: the script dies with status
 * 1 and no message (the `.` runs with 2>/dev/null). The guard is a
 * `[ -r FILE ] &&` test in front of the `.`, so the fallback is reachable.
 *
 * Two lanes: /bin/bash (3.2 on macOS, the reported failure) and
 * `/bin/bash --posix`, which makes the same `.` failure fatal on every bash
 * version, so Linux CI (bash 5) catches a regression too.
 *
 * Value: protects=the reinstall message when a sourced twin is missing; fails_when=a site sources the twin without the -r guard; why_new=existing missing-twin tests run a PATH bash, which is Homebrew 5.x or Linux 5.x and never hits the silent exit; seam=none
 */
import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SPAWN_TIMEOUT_MS = 20_000;
// Bun's default test timeout is 5 s. One sweep lane is 44 spawns and took
// 3-8 s at load average ~200, so both spawning tests set their own.
const SETUP_TEST_TIMEOUT_MS = 60_000;
const SWEEP_TEST_TIMEOUT_MS = 180_000;
const LANES: Array<{ name: string; argv: string[] }> = [
  { name: '/bin/bash', argv: ['/bin/bash'] },
  { name: '/bin/bash --posix', argv: ['/bin/bash', '--posix'] },
];

/** A `.`/`source` of a quoted path whose failure falls through to `||`. */
const SITE = /(?:^|&&)\s*(?:\.|source)\s+"[^\n]*\|\|/;
const GUARDED = /^\s*\[ -r (".+?") \] && \. \1(?: 2>\/dev\/null)? \|\| /;

interface Site { rel: string; line: number; text: string }

/**
 * What a script needs to reach its source line with the twin missing. Most
 * need nothing; these exit earlier on an empty env.
 */
const REACH: Record<string, { args?: string[]; env?: (tmp: string) => Record<string, string>; prep?: (tmp: string) => void; unreachable?: string }> = {
  'bin/gstack-brain-enqueue': { args: ['entry.md'] },
  'bin/gstack-relink': { env: tmp => ({ GSTACK_INSTALL_DIR: path.join(tmp, 'tree') }) },
  'gstack-upgrade/migrations/v1.17.0.0.sh': {
    prep: tmp => {
      const config = path.join(tmp, 'home', '.claude', 'skills', 'gstack', 'bin', 'gstack-config');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, '#!/bin/sh\necho full\n', { mode: 0o755 });
    },
  },
  'bin/gstack-repo-mode': { unreachable: 'reaches its source only after gstack-slug resolves a slug, and gstack-slug needs the same twin' },
};

function headBytes(abs: string, n: number): string {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(n);
    return buf.subarray(0, fs.readSync(fd, buf, 0, n, 0)).toString('latin1');
  } finally {
    fs.closeSync(fd);
  }
}

/** Every shell executable gstack ships, as repo-relative paths. */
function shippedShellFiles(): string[] {
  const out = ['setup'];
  for (const dir of ['bin', 'browse/bin', 'gstack-upgrade/migrations']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir)).sort()) {
      const rel = `${dir}/${name}`;
      const abs = path.join(ROOT, rel);
      if (!fs.statSync(abs).isFile()) continue;
      // Read the shebang only: bin/ can hold a ~60MB compiled binary.
      if (/^#!.*\b(?:ba)?sh\b/.test(headBytes(abs, 128).split('\n', 1)[0])) out.push(rel);
    }
  }
  return out;
}

function listTree(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push(p);
    if (e.isDirectory() && !e.isSymbolicLink()) out.push(...listTree(p));
  }
  return out.sort();
}

function sourceSites(): Site[] {
  const sites: Site[] = [];
  for (const rel of shippedShellFiles()) {
    fs.readFileSync(path.join(ROOT, rel), 'utf-8').split('\n').forEach((text, i) => {
      if (SITE.test(text)) sites.push({ rel, line: i + 1, text });
    });
  }
  return sites;
}

function scrubbedEnv(tmp: string): Record<string, string> {
  return {
    PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: path.join(tmp, 'home'),
    TMPDIR: path.join(tmp, 'tmp'),
  };
}

function mkScratch(prefix: string): string {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  for (const d of ['home', 'tmp', 'cwd', 'out']) fs.mkdirSync(path.join(tmp, d));
  return tmp;
}

/**
 * spawnSync with the child's stdout/stderr written to files under tmp/out.
 * Through pipes, Bun 1.3.13 on a loaded Mac (load average ~250) returned the
 * right exit status with an empty stderr in 1 of 2,400 spawns, which is this
 * test's failure signature. Through files: 0 of 2,400.
 */
function runCaptured(argv: string[], tmp: string, opts: { cwd: string; env: Record<string, string> }) {
  const outFile = path.join(tmp, 'out', 'stdout');
  const errFile = path.join(tmp, 'out', 'stderr');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync(argv[0], argv.slice(1), { ...opts, timeout: SPAWN_TIMEOUT_MS, stdio: ['ignore', outFd, errFd] });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  return {
    status: r.status, signal: r.signal, error: r.error,
    stdout: fs.readFileSync(outFile, 'utf-8'), stderr: fs.readFileSync(errFile, 'utf-8'),
  };
}

describe('sourced twin missing', () => {
  test('every source site carries the -r guard on the path it sources', () => {
    const sites = sourceSites();
    // setup, the state-root bins, browse/bin/remote-slug and the migrations.
    expect(sites.length).toBeGreaterThan(40);
    const unguarded = sites.filter(s => !GUARDED.test(s.text)).map(s => `${s.rel}:${s.line}`);
    expect(unguarded).toEqual([]);
  });

  for (const lane of LANES) {
    test(`setup prints the reinstall message under ${lane.name}`, () => {
      const tmp = mkScratch('gstack-setup-twin-');
      try {
        const tree = path.join(tmp, 'tree');
        fs.mkdirSync(path.join(tree, 'scripts'), { recursive: true });
        fs.mkdirSync(path.join(tree, 'hosts', 'claude', 'hooks'), { recursive: true });
        fs.copyFileSync(path.join(ROOT, 'setup'), path.join(tree, 'setup'));
        // A setup that runs the hook parse gate first needs its checker.
        const gate = path.join(ROOT, 'scripts', 'hook-syntax.sh');
        if (fs.existsSync(gate)) fs.copyFileSync(gate, path.join(tree, 'scripts', 'hook-syntax.sh'));
        // The gate follows every payload setup hands to bun and refuses a
        // missing one before setup reaches its sources, so stub each one.
        const setupText = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
        for (const m of setupText.matchAll(/\$SOURCE_GSTACK_DIR\/([\w./-]+\.(?:ts|mjs|js))(?![\w.])/g)) {
          fs.mkdirSync(path.dirname(path.join(tree, m[1])), { recursive: true });
          fs.writeFileSync(path.join(tree, m[1]), 'export {};\n');
        }

        const r = runCaptured([...lane.argv, path.join(tree, 'setup'), '--no-prefix', '--no-team'], tmp, { cwd: tree, env: scrubbedEnv(tmp) });
        expect(r.stderr).toContain(`cannot resolve the gstack state root: ${tree}/bin/gstack-state-root.sh is missing`);
        expect(r.stderr).toContain('reinstall with ./setup or /gstack-upgrade');
        expect(r.status).toBe(1);
        expect(fs.readdirSync(path.join(tmp, 'home'))).toEqual([]);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }, SETUP_TEST_TIMEOUT_MS);

    test(`each shipped executable reaches its fallback under ${lane.name}`, () => {
      const firstSite = new Map<string, Site>();
      for (const s of sourceSites()) if (s.rel !== 'setup' && !firstSite.has(s.rel)) firstSite.set(s.rel, s);
      expect(firstSite.size).toBeGreaterThan(40);
      expect(Object.keys(REACH).filter(rel => !firstSite.has(rel))).toEqual([]);

      const failures: string[] = [];
      for (const site of firstSite.values()) {
        const reach = REACH[site.rel] ?? {};
        if (reach.unreachable) continue;
        const failOpen = /\|\| exit 0\s*(?:#.*)?$/.test(site.text);
        const tmp = mkScratch('gstack-bin-twin-');
        try {
          const script = path.join(tmp, 'tree', site.rel);
          fs.mkdirSync(path.dirname(script), { recursive: true });
          fs.copyFileSync(path.join(ROOT, site.rel), script);
          fs.chmodSync(script, 0o755);
          reach.prep?.(tmp);
          const homeBefore = listTree(path.join(tmp, 'home'));
          const r = runCaptured([...lane.argv, script, ...(reach.args ?? [])], tmp, {
            cwd: path.join(tmp, 'cwd'), env: { ...scrubbedEnv(tmp), ...reach.env?.(tmp) },
          });
          const ok = failOpen
            ? r.status === 0 && r.stderr === ''
            : r.status === 1 && /is missing\. fix: reinstall with \.\/setup or \/gstack-upgrade/.test(r.stderr);
          const wroteHome = listTree(path.join(tmp, 'home')).join('\n') !== homeBefore.join('\n');
          if (!ok || wroteHome) {
            failures.push(`${site.rel}:${site.line} status=${r.status} signal=${r.signal} error=${r.error?.message} wroteHome=${wroteHome} stdout=${JSON.stringify(r.stdout.slice(0, 200))} stderr=${JSON.stringify(r.stderr.slice(0, 200))}`);
          }
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      }
      expect(failures).toEqual([]);
    }, SWEEP_TEST_TIMEOUT_MS);
  }
});
