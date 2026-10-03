/**
 * A missing state-root twin fails loudly on every bash setup meets.
 *
 * setup sources bin/gstack-state-root.sh with a
 * `|| { echo "... is missing ..."; exit 1; }` fallback. Under macOS's
 * /bin/bash 3.2 with `set -e`, and under any bash in POSIX mode, `.` of a
 * missing file exits the shell before `||` runs: setup dies with status 1
 * and no message (the `.` runs with 2>/dev/null). The guard is a
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
// Bun's default test timeout is 5 s; a loaded machine can exceed it.
const SETUP_TEST_TIMEOUT_MS = 60_000;
const LANES: Array<{ name: string; argv: string[] }> = [
  { name: '/bin/bash', argv: ['/bin/bash'] },
  { name: '/bin/bash --posix', argv: ['/bin/bash', '--posix'] },
];

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

        const r = runCaptured([...lane.argv, path.join(tree, 'setup'), '--no-prefix', '--no-team'], tmp, { cwd: tree, env: scrubbedEnv(tmp) });
        expect(r.stderr).toContain(`cannot resolve the gstack state root: ${tree}/bin/gstack-state-root.sh is missing`);
        expect(r.stderr).toContain('reinstall with ./setup or /gstack-upgrade');
        expect(r.status).toBe(1);
        expect(fs.readdirSync(path.join(tmp, 'home'))).toEqual([]);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }, SETUP_TEST_TIMEOUT_MS);
  }
});
