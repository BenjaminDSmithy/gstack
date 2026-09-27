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

const DIA_LAUNCHER = /\b(?:nativeDiaLaunchOptions|runProtectedLaunch)\s*\(/;
const transpiler = new Bun.Transpiler({ loader: 'ts' });

/** Whether the call at `at` sits inside the argument list of a `mockKeychainChromium(` call. */
function insideShimCall(code: string, at: number): boolean {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (code[i] === ')') depth++;
    else if (code[i] === '(') {
      if (depth > 0) depth--;
      else if (/\bmockKeychainChromium\s*$/.test(code.slice(Math.max(0, i - 64), i))) return true;
    }
  }
  return false;
}

/**
 * Real-Chromium launches a test file hands to the Dia launcher without the
 * shim, as the offending code lines. Bun's transpiler strips comments with a
 * real lexer, joins calls split across lines, and keeps strings and templates,
 * so a comment cannot vouch for a launch and launch code built as a string
 * (the comparison test's probe is) is still checked. Every
 * `chromium.executablePath()` must sit inside a `mockKeychainChromium(` call.
 */
function unshimmedStandIns(source: string): string[] {
  if (!DIA_LAUNCHER.test(source)) return [];
  const code = transpiler.transformSync(source);
  if (!DIA_LAUNCHER.test(code)) return [];
  return [...code.matchAll(/\bchromium\s*\.\s*executablePath\s*\(/g)]
    .filter(match => !insideShimCall(code, match.index!))
    .map(match => {
      const end = code.indexOf('\n', match.index!);
      return code.slice(code.lastIndexOf('\n', match.index!) + 1, end === -1 ? undefined : end).trim();
    });
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
        unshimmed.push(`${path.relative(ROOT, file).split(path.sep).join('/')}: ${line}`);
      }
    }
    expect(unshimmed).toEqual([]);
  });

  test('the stand-in check flags each unshimmed launch, whatever its layout', () => {
    const launcher = 'nativeDiaLaunchOptions(exe, env);';
    const wrapped = 'const exe = mockKeychainChromium(dir, realpathSync(chromium.executablePath()));';
    const raw = 'await runProtectedLaunch(chromium.executablePath(), profile, env);';
    const flagged = (...lines: string[]) => unshimmedStandIns(lines.join('\n')).length;
    // Wrapped launches pass, on one line or spread across several.
    expect(flagged(launcher, wrapped)).toBe(0);
    expect(flagged(launcher, 'const exe = mockKeychainChromium(', '  dir,', '  realpathSync(chromium.executablePath()),', ');')).toBe(0);
    // One shimmed launch does not exempt a raw one, in the same file or on the same line.
    expect(flagged(wrapped, launcher, raw)).toBe(1);
    expect(flagged(`mockKeychainChromium(dir, other); ${raw}`)).toBe(1);
    expect(flagged(`${wrapped} ${raw}`)).toBe(1);
    // A raw launch split across lines is still found.
    expect(flagged('runProtectedLaunch(chromium.executablePath(', '), profile, env);')).toBe(1);
    // Comments cannot vouch for a launch, and "/*" inside a string does not hide code.
    expect(flagged('runProtectedLaunch(/* mockKeychainChromium( */ chromium.executablePath());')).toBe(1);
    expect(flagged(`const a = "/*"; ${raw} const b = "*/";`)).toBe(1);
    // A comment is not a launch; launch code built as a string still is.
    expect(flagged(launcher, '// never pass chromium.executablePath() bare')).toBe(0);
    expect(flagged(launcher, 'const probe = `runProtectedLaunch(chromium.executablePath(), home)`;')).toBe(1);
    // Files that never reach the Dia launcher keep Playwright's own mocks and are not checked.
    expect(flagged('chromium.launch({ executablePath: chromium.executablePath() });')).toBe(0);
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
