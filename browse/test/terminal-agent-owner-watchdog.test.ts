import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const AGENT_SCRIPT = path.join(import.meta.dir, '../src/terminal-agent.ts');
const spawned: any[] = [];
const tempDirs: string[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await Bun.sleep(25);
  }
  return predicate();
}

afterEach(() => {
  for (const proc of spawned.splice(0)) {
    try { proc.kill?.('SIGKILL'); } catch {}
  }
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe('terminal-agent owner lifecycle', () => {
  test('exits after its owning browse server process exits', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-term-owner-'));
    tempDirs.push(stateDir);
    const stateFile = path.join(stateDir, 'browse.json');
    fs.writeFileSync(stateFile, JSON.stringify({ token: 'test-token' }));

    // process.execPath (the running bun) instead of `sleep`: coreutils are
    // not guaranteed on a bare windows-latest runner, and this test is on the
    // Windows CI curated list — the owner-orphan leak it pins is a Windows bug.
    // The owner's lifetime is tied to this test process instead of a fixed
    // 30s sleep: it blocks until its stdin (a pipe we hold open) hits EOF, so
    // it is guaranteed alive until the SIGTERM below no matter how slow the
    // runner is, and it reaps itself if the test process dies without running
    // afterEach. Node-compatible stdin APIs, not Bun.stdin — Windows-portable.
    const owner = Bun.spawn(
      [process.execPath, '-e',
        "process.stdin.resume(); const bye = () => process.exit(0); "
        + "process.stdin.on('end', bye); process.stdin.on('error', bye); process.stdin.on('close', bye);"],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    );
    spawned.push(owner);
    const agent = Bun.spawn(['bun', 'run', AGENT_SCRIPT], {
      env: {
        ...process.env,
        BROWSE_STATE_FILE: stateFile,
        BROWSE_SERVER_PORT: '0',
        BROWSE_OWNER_PID: String(owner.pid),
        GSTACK_TERMINAL_OWNER_WATCHDOG_MS: '25',
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    spawned.push(agent);

    expect(await waitFor(() => fs.existsSync(path.join(stateDir, 'terminal-agent-pid')))).toBe(true);
    expect(isAlive(agent.pid)).toBe(true);

    owner.kill('SIGTERM');
    await owner.exited;

    expect(await waitFor(() => !isAlive(agent.pid))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'terminal-agent-pid'))).toBe(false);
    expect(fs.existsSync(path.join(stateDir, 'terminal-port'))).toBe(false);
  });
});

// A terminal-agent started without BROWSE_OWNER_PID arms no owner watchdog.
// When the test runner dies before its afterAll (a per-test timeout, a killed
// shard, a stray process.exit), launchd adopts the agent and it listens on
// loopback until someone kills it by hand. Every test that spawns the agent
// as a long-lived process must name an owner so the watchdog above reaps it.
function testSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'fixtures' || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testSources(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

// Text of the call starting at `open` (the index of its `(`), with parens
// inside string and template literals ignored.
function callText(src: string, open: number): string {
  let depth = 0;
  let quote = '';
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

function agentSpawns(file: string): { where: string; owned: boolean }[] {
  const src = fs.readFileSync(file, 'utf-8');
  const agentConsts = new Set(
    [...src.matchAll(/\bconst\s+(\w+)\s*=[^;\n]*terminal-agent\.ts/g)].map(m => m[1]),
  );
  const found: { where: string; owned: boolean }[] = [];
  for (const m of src.matchAll(/\bBun\.spawn\(\s*\[([^\]]*)\]/g)) {
    const argv = m[1];
    const isAgent = /terminal-agent\.ts/.test(argv)
      || [...agentConsts].some(name => new RegExp(`\\b${name}\\b`).test(argv));
    if (!isAgent) continue;
    const open = m.index! + m[0].indexOf('(');
    const line = src.slice(0, m.index).split('\n').length;
    found.push({
      where: `${path.relative(path.join(import.meta.dir, '..', '..'), file)}:${line}`,
      owned: callText(src, open).includes('BROWSE_OWNER_PID'),
    });
  }
  return found;
}

describe('test-spawned terminal-agents are owned', () => {
  test('every Bun.spawn of terminal-agent.ts in a test passes BROWSE_OWNER_PID', () => {
    const roots = [import.meta.dir, path.join(import.meta.dir, '..', '..', 'test')];
    const spawns = roots.filter(r => fs.existsSync(r)).flatMap(testSources).flatMap(agentSpawns);
    // Self-check: the owned spawn in this file must be found, or the scan is
    // matching nothing and the assertion below proves nothing.
    expect(spawns.some(s => s.where.includes('terminal-agent-owner-watchdog.test.ts') && s.owned)).toBe(true);
    expect(spawns.filter(s => !s.owned).map(s => s.where)).toEqual([]);
  });
});
