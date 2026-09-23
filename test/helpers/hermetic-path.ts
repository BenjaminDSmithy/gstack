/**
 * Hermetic PATH for tests that shell out to gstack's bin/ scripts.
 *
 * Two host dependencies kept biting the free suite:
 *
 *   1. A hardcoded "safe" PATH of system dirs excluded `gbrain` — and also
 *      excluded `bun`. gstack's bin scripts use `#!/usr/bin/env -S bun run`,
 *      so on a machine where bun lives in ~/.bun/bin (the official installer's
 *      default) every such script exited 127. On a machine where bun came
 *      from Homebrew the same tests passed. Same code, opposite result.
 *
 *   2. Tests that wanted "gbrain is unreachable" inherited the developer's
 *      real PATH, so `spawnSync('gbrain', ...)` found the real binary and
 *      talked to the real brain: seconds per call instead of milliseconds,
 *      and bun's 5s per-test timeout turned that into an intermittent red.
 *
 * `hermeticPath()` solves both: a shim directory holding nothing but a `bun`
 * symlink to the interpreter running the test, plus the standard system dirs.
 * bun resolves; gbrain (installed via `bun link`, so it lives beside bun in
 * ~/.bun/bin) does not.
 */
import { mkdtempSync, symlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

/** System dirs that carry POSIX tools, jq, git, curl — but not bun or gbrain. */
export const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin';

let cachedShimDir: string | null = null;

/** A directory containing only a `bun` symlink to the running interpreter. */
export function bunShimDir(): string {
  if (cachedShimDir && existsSync(join(cachedShimDir, 'bun'))) return cachedShimDir;
  const dir = mkdtempSync(join(tmpdir(), 'gstack-bun-shim-'));
  symlinkSync(process.execPath, join(dir, 'bun'));
  cachedShimDir = dir;
  return dir;
}

/**
 * PATH with `bun` available and `gbrain` deliberately absent.
 * Anything passed in is prepended, so callers can add their own fake bins.
 */
export function hermeticPath(...prepend: string[]): string {
  return [...prepend, bunShimDir(), SYSTEM_PATH].join(':');
}
