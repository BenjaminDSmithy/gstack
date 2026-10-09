/**
 * The pr-prep helpers that end with process.exitCode (so a slow reader gets
 * every byte) keep the exit code they computed when the reader closes the
 * pipe early (`... | head -1`): under exitCode, Bun turns an unhandled
 * stdout EPIPE into exit 1, which an agent under pipefail reads as an error.
 *
 * These cases drive each real bin through a bash pipe, so they are POSIX-only.
 * They live in this file of their own because Windows curation
 * (scripts/lib/windows-curation.ts) drops a whole test file for one
 * `/bin/bash` literal or `'bin'` path segment; inside the helpers' own test
 * files they took test/pr-body.test.ts out of the Windows free lane.
 */
import { describe, test, expect, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

setDefaultTimeout(120_000);

describe('a reader that closes the pipe early', () => {
  for (const name of ['gstack-pr-watch', 'gstack-pr-body', 'gstack-pr-prep-commits']) {
    test(`${name} leaves the exit code as computed, never 1`, () => {
      const bin = path.join(import.meta.dir, '..', 'bin', name);
      for (const [args, want] of [[[], 2], [['--help'], 0]] as const) {
        // `true` exits long before bun starts writing, so every write meets a closed pipe (EPIPE).
        const r = spawnSync('/bin/bash', ['-c', '"$0" "$@" 2>/dev/null | true; echo "rc=${PIPESTATUS[0]}"', bin, ...args], { encoding: 'utf8', timeout: 60_000 });
        expect(r.stdout.trim(), `${bin} ${args.join(' ')}`).toBe(`rc=${want}`);
      }
    });
  }
});
