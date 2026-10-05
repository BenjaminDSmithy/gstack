/**
 * Whether this module graph was loaded inside the bun test runner.
 *
 * Under the runner, server.ts's module-scope background timers are a
 * liability, not a feature: importing server.ts from any test arms an idle
 * poll (and, with a parent pid, the parent watchdog) that fires for the rest
 * of the process and shuts down through `activeShutdown` — which ends in
 * process.exit() and kills the runner mid-run, at exit code 0. The tests that
 * care about idle and watchdog behaviour drive `__testInternals__.idleCheckTick()`
 * and `parentWatchdogTick` directly, so nothing is lost by not arming the
 * wall-clock polls there. For the same reason a test that builds a fetch
 * handler calls `__testInternals__.clearActiveShutdown()` when it is done:
 * otherwise a browser closing or a timer firing minutes later runs a real
 * shutdown() through the stale pointer.
 *
 * The marker is a global set by test-setup.ts (bunfig's preload), NOT an env
 * var. NODE_ENV was the first attempt and it was wrong: `bun test` sets
 * NODE_ENV=test, and the tests that spawn the server as a SUBPROCESS inherit
 * the environment — so the real daemon under test lost its watchdog and its
 * idle timer too, which is exactly the behaviour watchdog.test.ts exists to
 * check. A global does not cross a process boundary, so an in-process import
 * is disarmed and a spawned daemon is not.
 */
export const IS_TEST_RUN = (globalThis as Record<string, unknown>).__GSTACK_TEST_RUNNER__ === true;
