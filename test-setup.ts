/**
 * Global test preload (Bun: `[test] preload` in bunfig.toml).
 *
 * Snapshots `process.env` once at preload time, then restores it after
 * every test. Defends against the recurring pollution class where one
 * test file mutates `process.env.PATH` / `HOME` / etc. and leaks into
 * unrelated subsequent files in the same Bun process — surfaces as
 * `Executable not found in $PATH: "bun"` or `Bun.which('bash')` returning
 * null in tests that have no business touching env.
 *
 * `process.env = X` reassignment does work in Bun (it swaps the underlying
 * proxy), but several test files use the broken pattern of
 * `origEnv = {...process.env}` followed by per-test mutation without a
 * matching restore inside try/finally. Centralizing the safety net here
 * means new tests don't have to remember the dance, and the bug class
 * stays dead.
 */
import { afterEach, beforeAll } from 'bun:test';

// Narrowly restore PATH after every test. Defends against the recurring
// pollution class where one test sets `process.env.PATH = '/test/bin:/usr/bin'`
// to exercise a scrubbed-env fixture and either forgets to restore or uses
// the broken `process.env = origEnv` reassignment, then a downstream test
// (security.test.ts > resolveBashBinary, pair-agent-tunnel-eval, or
// server-no-import-side-effects) sees the wrong PATH and either has
// `Bun.which('bash')` return null or `Bun.spawn(['bun', ...])` ENOENT.
//
// Deliberately narrow: snapshotting + restoring all of process.env breaks
// tests that legitimately set per-file env at module top-level (e.g.,
// domain-skills-storage.test.ts assigns `process.env.GSTACK_HOME` at
// import time so the loaded module reads the test sandbox path on first
// invocation — wiping that on afterEach would route reads at the user's
// real ~/.gstack and the test would assert on the wrong filesystem).
//
// If a future test pollutes a different variable in the same broken way,
// add it to RESTORE_KEYS rather than widening the snapshot scope.
// ─── process.exit guard ────────────────────────────────────────────────
//
// A single stray `process.exit()` anywhere in the test process kills bun's
// runner instantly: no summary line, every remaining test file silently
// skipped, and — because the code under test exits 0 on a clean shutdown —
// the whole `bun run test` command reports SUCCESS while failures are
// already on the board. A gate that exits 0 mid-run is worse than a red
// one; it cannot fail a build at all.
//
// browse/src/server.ts's factory shutdown() ends in `process.exit(exitCode)`.
// Tests that drive shutdown on purpose stub process.exit themselves, but a
// shutdown reached from a leaked idle timer or agent watchdog fires outside
// any stub, and `bun test browse/test/` truncated at
// server-embedder-terminal-port.test.ts with rc=0 as a result.
//
// So: no test run may exit the process. The guard throws instead, which
// surfaces as a normal test failure attributed to whatever triggered it.
// Verified that bun's own runner still terminates and reports normally with
// this installed — bun does not route its own teardown through JS exit.
const realExit = process.exit.bind(process);
(process as any).exit = ((code?: number) => {
  const err = new Error(
    `process.exit(${code ?? 0}) was called during a test run. Nothing in a test ` +
    `may exit the runner — stub it (see browse/test/server-embedder-terminal-port.test.ts) ` +
    `or stop the timer that reached it.`,
  );
  // Keep the real exit reachable for anything that genuinely needs it.
  (err as any).realExit = realExit;
  throw err;
}) as any;

const RESTORE_KEYS = ['PATH', 'Path'] as const;
const baseline: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of RESTORE_KEYS) baseline[k] = process.env[k];
});

afterEach(() => {
  for (const k of RESTORE_KEYS) {
    const want = baseline[k];
    if (want === undefined) {
      if (process.env[k] !== undefined) delete process.env[k];
    } else if (process.env[k] !== want) {
      process.env[k] = want;
    }
  }
});
