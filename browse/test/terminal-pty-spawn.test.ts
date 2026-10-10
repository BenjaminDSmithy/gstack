/**
 * spawnPty: a PTY child must not run before Bun.spawn() has returned.
 *
 * On macOS a PTY child that writes and exits inside Bun.spawn() wedges the
 * spawning thread in wait4() for good (see spawnPty in
 * ../src/terminal-pty-lifecycle.ts). The window is microseconds unless the
 * machine is oversubscribed, so these tests widen it on purpose: the injected
 * spawn holds the parent after the child exists and before spawnPty gets the
 * process back, the way a preempted thread does.
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnPty } from '../src/terminal-pty-lifecycle';

function holdAfterSpawn(holdMs: number, whileHeld: () => void) {
  return (argv: string[], options: Record<string, any>) => {
    const proc = (Bun as any).spawn(argv, options);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);
    whileHeld();
    return proc;
  };
}

async function runPty(argv: string[], spawn?: Parameters<typeof spawnPty>[2]) {
  let output = '';
  const proc = spawnPty(argv, {
    terminal: { cols: 80, rows: 24, data(_t: unknown, chunk: Uint8Array) { output += Buffer.from(chunk).toString(); } },
  }, spawn);
  const code = await proc.exited;
  // The reader can trail the exit by a tick or two.
  for (let i = 0; i < 50 && !output.includes('<end>'); i++) await Bun.sleep(20);
  proc.terminal?.close();
  return { code, output: output.replace(/\r\n/g, '\n') };
}

describe('spawnPty', () => {
  test.skipIf(process.platform !== 'darwin')('the child cannot start while the spawning thread is held', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pty-spawn-'));
    const marker = path.join(dir, 'started');
    let startedWhileHeld: boolean | null = null;
    try {
      const result = await runPty(
        ['/bin/sh', '-c', ': > "$1"; printf "ran<end>"; exit 7', 'sh', marker],
        holdAfterSpawn(500, () => { startedWhileHeld = fs.existsSync(marker); }),
      );
      expect(startedWhileHeld).toBe(false);
      expect(result).toEqual({ code: 7, output: 'ran<end>' });
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== 'darwin')('argv reaches the child unchanged and fd 3 does not leak', async () => {
    const result = await runPty([
      '/bin/sh', '-c', 'printf "[%s]" "$@"; if [ -e /dev/fd/3 ]; then printf leak; fi; printf "<end>"',
      'sh', 'two words', '', 'line one\nline two', '$HOME `x`',
    ]);
    expect(result).toEqual({ code: 0, output: '[two words][][line one\nline two][$HOME `x`]<end>' });
  });

  test.skipIf(process.platform !== 'darwin')('the gate leaves no fd open in the parent', async () => {
    const openFds = () => fs.readdirSync('/dev/fd').length;
    await runPty(['/bin/sh', '-c', 'printf "<end>"']);
    const before = openFds();
    for (let i = 0; i < 10; i++) await runPty(['/bin/sh', '-c', 'printf "<end>"']);
    expect(openFds() - before).toBeLessThan(3);
  });

  test.skipIf(process.platform !== 'darwin')('a child the gate cannot release is killed, not left waiting', async () => {
    const withoutGateFd = (argv: string[], options: Record<string, any>) =>
      (Bun as any).spawn(argv, { ...options, stdio: undefined });
    const proc = spawnPty(['/bin/sh', '-c', 'sleep 30'], { terminal: { cols: 80, rows: 24, data() {} } }, withoutGateFd);
    await proc.exited;
    proc.terminal?.close();
    expect(proc.signalCode).toBe('SIGKILL');
  });

  test('other platforms spawn the argv as given', () => {
    const calls: unknown[] = [];
    const proc = { pid: 1 };
    const options = { terminal: { cols: 80, rows: 24 }, env: { A: '1' } };
    const spawn = (argv: string[], opts: Record<string, any>) => { calls.push([argv, opts]); return proc; };
    expect(spawnPty(['claude', '--flag'], options, spawn, 'linux')).toBe(proc);
    expect(calls).toEqual([[['claude', '--flag'], options]]);
  });
});
