/**
 * Test-owned Chromium launches must keep the keychain mocked.
 *
 * Many suites run Chromium under a scratch HOME. On macOS a Chromium started
 * without --use-mock-keychain there asks the Security framework to store its
 * "Chromium Safe Storage" key in a login keychain the scratch HOME does not
 * have (errSecNoDefaultKeychain, -25307), and SecurityAgent puts up a
 * desktop-blocking "Keychain Not Found" dialog that also stalls the launch.
 *
 * Playwright passes the mocks by default. Two things can take them away: a
 * launch that strips Playwright's defaults, and a real Chromium standing in
 * for Dia behind the Dia qualification launcher, which strips them on purpose.
 * The live-argv check for the stand-in sits in dia-macos-qualification.test.ts,
 * next to the real launch it inspects.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { STEALTH_IGNORE_DEFAULT_ARGS } from '../src/stealth';
import { MOCK_KEYCHAIN_SWITCHES, mockKeychainChromium } from './fixtures/mock-keychain-chromium';

const ROOT = path.resolve(import.meta.dir, '../..');

/**
 * Lines of a test file that hand a real Chromium to the Dia launcher without
 * the shim: every non-comment `chromium.executablePath()` in a file that calls
 * the launcher must sit inside a `mockKeychainChromium(` call on the same line.
 * Inline block comments are stripped first, so a comment cannot vouch for it.
 */
function unshimmedStandIns(text: string): number[] {
  if (!/\b(?:nativeDiaLaunchOptions|runProtectedLaunch)\(/.test(text)) return [];
  const lines: number[] = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\/\*.*?\*\//g, '');
    if (/^\s*(?:\/\/|\*)/.test(line)) return;
    const launch = line.indexOf('chromium.executablePath()');
    if (launch === -1) return;
    const shim = line.indexOf('mockKeychainChromium(');
    if (shim === -1 || shim > launch) lines.push(index + 1);
  });
  return lines;
}

function sourceFiles(directory: string, pattern: RegExp): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && pattern.test(entry.name))
    .map(entry => path.join(entry.parentPath, entry.name))
    .filter(file => !file.split(path.sep).some(part => part === 'node_modules' || part === 'dist'));
}

describe('test-owned Chromium launches keep the keychain mocked', () => {
  test('the browse daemon launch never strips the keychain mocks', () => {
    // launch(), launchHeaded() and handoff() run under scratch HOMEs across the suite.
    for (const flag of MOCK_KEYCHAIN_SWITCHES) expect(STEALTH_IGNORE_DEFAULT_ARGS).not.toContain(flag);
  });

  test('only the CI-gated Dia launcher strips the keychain mocks', () => {
    const stripping: string[] = [];
    for (const directory of ['browse/src', 'lib', 'scripts', 'bin', 'design/src', 'make-pdf/src', '.github/scripts']) {
      for (const file of sourceFiles(path.join(ROOT, directory), /\.(?:[cm]?js|ts)$/)) {
        for (const match of readFileSync(file, 'utf8').matchAll(/ignoreDefaultArgs\s*:\s*(true|\[[^\]]*\])/g)) {
          if (match[1] === 'true' || MOCK_KEYCHAIN_SWITCHES.some(flag => match[1].includes(flag))) {
            stripping.push(path.relative(ROOT, file).split(path.sep).join('/'));
          }
        }
      }
    }
    // nativeDiaLaunchOptions: real Dia must reach its real Safe Storage key.
    expect(stripping).toEqual(['.github/scripts/qualify-dia-macos.ts']);
  });

  test('tests that drive the Dia launcher with real Chromium go through mockKeychainChromium', () => {
    // The Dia launcher's only test consumers live here; test/ has none. This
    // file is skipped: its negative controls spell out unshimmed launches.
    const unshimmed: string[] = [];
    for (const file of sourceFiles(import.meta.dir, /\.test\.ts$/)) {
      if (file === import.meta.path) continue;
      for (const line of unshimmedStandIns(readFileSync(file, 'utf8'))) {
        unshimmed.push(`${path.relative(ROOT, file).split(path.sep).join('/')}:${line}`);
      }
    }
    expect(unshimmed).toEqual([]);
  });

  test('the stand-in check flags each unshimmed launch site, not the file', () => {
    const wrapped = 'const exe = mockKeychainChromium(dir, realpathSync(chromium.executablePath()));';
    const raw = 'await runProtectedLaunch(chromium.executablePath(), profile, env);';
    expect(unshimmedStandIns(['nativeDiaLaunchOptions(exe, env);', wrapped].join('\n'))).toEqual([]);
    // One shimmed launch no longer exempts a second, raw one in the same file.
    expect(unshimmedStandIns([wrapped, 'nativeDiaLaunchOptions(exe, env);', raw].join('\n'))).toEqual([3]);
    // A comment cannot vouch for a raw launch, and a comment line is not a launch.
    expect(unshimmedStandIns(['runProtectedLaunch(/* mockKeychainChromium( */ chromium.executablePath());'].join('\n'))).toEqual([1]);
    expect(unshimmedStandIns(['nativeDiaLaunchOptions(exe, env);', '// never pass chromium.executablePath() bare'].join('\n'))).toEqual([]);
    // Files that never reach the Dia launcher keep Playwright's own mocks and are not checked.
    expect(unshimmedStandIns('chromium.launch({ executablePath: chromium.executablePath() });')).toEqual([]);
  });

  describe.skipIf(process.platform === 'win32')('mockKeychainChromium', () => {
    test('execs the browser in place with the keychain mocks first and every argument verbatim', async () => {
      const directory = mkdtempSync(path.join(tmpdir(), 'mock-keychain-'));
      try {
        // Stands in for Chromium: prints its pid, then one argument per line.
        const browser = path.join(directory, "stand-in 'browser'");
        writeFileSync(browser, '#!/bin/sh\nprintf \'%s\\n\' "$$" "$@"\n');
        chmodSync(browser, 0o755);
        const args = ['--remote-debugging-pipe', '--user-data-dir=/scratch/a b', 'it\'s $HOME `id` "quoted"'];
        const child = Bun.spawn([mockKeychainChromium(directory, browser), ...args], { stdout: 'pipe', stderr: 'pipe' });
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(code, stderr).toBe(0);
        const [pid, ...argv] = stdout.replace(/\n$/, '').split('\n');
        expect(argv).toEqual([...MOCK_KEYCHAIN_SWITCHES, ...args]);
        // exec, not fork: the launcher's owned-group kill and its pipes reach the browser itself.
        expect(Number(pid)).toBe(child.pid);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});
