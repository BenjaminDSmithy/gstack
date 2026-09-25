import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Keychain switches Playwright passes to Chromium by default. On macOS
 * `--use-mock-keychain` keeps Chromium's cookie-encryption key ("Chromium Safe
 * Storage") out of the Security framework; `--password-store=basic` is the
 * Linux counterpart (no libsecret/kwallet prompt).
 */
export const MOCK_KEYCHAIN_SWITCHES = ['--use-mock-keychain', '--password-store=basic'] as const;

/**
 * Wrap a real Chromium executable so it always runs with the keychain mocked.
 *
 * For tests that drive the Dia qualification launcher with Playwright's
 * bundled Chromium standing in for Dia. `nativeDiaLaunchOptions` strips both
 * switches on purpose (real Dia must reach its real Safe Storage key), and the
 * `observeBrowserLaunches` spawn policy rejects any launch that carries them.
 * A stand-in started that way under a scratch HOME asks the Security framework
 * to store "Chromium Safe Storage" in a login keychain the scratch HOME does
 * not have: errSecNoDefaultKeychain (-25307), and SecurityAgent puts up a
 * desktop-blocking "Keychain Not Found" dialog that stalls the launch until a
 * human clicks Cancel.
 *
 * The shim execs the browser in place (same pid, same process group, same
 * inherited pipes) with the switches first, so the spawn policy still sees and
 * enforces the production argv while the browser never touches a keychain.
 * POSIX only: it is a `/bin/sh` script, and the Dia tests are excluded from
 * the Windows lane.
 */
export function mockKeychainChromium(directory: string, executable: string): string {
  const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  const shim = path.join(directory, 'chromium-mock-keychain');
  writeFileSync(shim, `#!/bin/sh\nexec ${quote(executable)} ${MOCK_KEYCHAIN_SWITCHES.join(' ')} "$@"\n`);
  chmodSync(shim, 0o755);
  return shim;
}

/** Argv of a live process, for asserting what a launched browser actually runs with. */
export function liveProcessArgv(pid: number): string[] {
  if (process.platform === 'linux') {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  }
  // ps joins argv with spaces, so an argument containing a space comes back
  // split. Fine for matching switches, which never contain one.
  const result = spawnSync('ps', ['-ww', '-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ps could not read pid ${pid}`);
  return result.stdout.trim().split(/\s+/);
}
