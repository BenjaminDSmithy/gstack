/**
 * Layer 2: server HTTP integration, no browser.
 *
 * Starts browse/src/server.ts as a subprocess with BROWSE_HEADLESS_SKIP and
 * talks to it over fetch(). No Chrome, no Claude, no agent.
 *
 * This file used to drive the sidebar chat queue — /sidebar-command,
 * /sidebar-agent/{event,kill}, /sidebar-chat, /sidebar-session/new. That
 * whole path was ripped in v1.14.0.0 when the interactive PTY replaced it
 * (docs/designs/SIDEBAR_MESSAGE_FLOW.md), so 11 of these tests had been
 * failing against endpoints that answer 404. The subprocess harness is
 * still worth having, so it now covers what the server actually serves:
 * the unauthenticated surface, the auth boundary on /command and
 * /pty-session, and a standing guard that the ripped routes stay ripped.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { spawn, type Subprocess } from 'bun';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let serverProc: Subprocess | null = null;
let serverPort: number = 0;
let authToken: string = '';
let tmpDir: string = '';
let stateFile: string = '';
let queueFile: string = '';

async function api(pathname: string, opts: RequestInit & { noAuth?: boolean } = {}): Promise<Response> {
  const { noAuth, ...fetchOpts } = opts;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(fetchOpts.headers as Record<string, string> || {}),
  };
  if (!noAuth && !headers['Authorization'] && authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }
  return fetch(`http://127.0.0.1:${serverPort}${pathname}`, { ...fetchOpts, headers });
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-integ-'));
  stateFile = path.join(tmpDir, 'browse.json');
  queueFile = path.join(tmpDir, 'sidebar-queue.jsonl');

  // Ensure queue dir exists
  fs.mkdirSync(path.dirname(queueFile), { recursive: true });

  const serverScript = path.resolve(__dirname, '..', 'src', 'server.ts');
  serverProc = spawn(['bun', 'run', serverScript], {
    env: {
      ...process.env,
      BROWSE_STATE_FILE: stateFile,
      BROWSE_HEADLESS_SKIP: '1',
      BROWSE_PORT: '0',
      SIDEBAR_QUEUE_PATH: queueFile,
      BROWSE_IDLE_TIMEOUT: '300',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for state file
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (fs.existsSync(stateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
        if (state.port && state.token) {
          serverPort = state.port;
          authToken = state.token;
          break;
        }
      } catch {}
    }
    await new Promise(r => setTimeout(r, 100));
  }
  if (!serverPort) throw new Error('Server did not start in time');
}, 20000);

afterAll(() => {
  if (serverProc) { try { serverProc.kill(); } catch {} }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('unauthenticated surface', () => {
  test('/health answers without a token', async () => {
    const resp = await api('/health', { noAuth: true });
    expect(resp.status).toBe(200);
    const json = await resp.json();
    expect(typeof json.status).toBe('string');
    expect(typeof json.uptime).toBe('number');
  });
});

describe('auth boundary', () => {
  test('/command rejects a request with no token', async () => {
    const resp = await api('/command', {
      method: 'POST',
      noAuth: true,
      body: JSON.stringify({ command: 'status', args: [] }),
    });
    expect(resp.status).toBe(401);
  });

  test('/command rejects a request with the wrong token', async () => {
    const resp = await api('/command', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer wrong-token' },
      body: JSON.stringify({ command: 'status', args: [] }),
    });
    expect(resp.status).toBe(401);
  });

  test('/pty-session rejects a request with no token', async () => {
    // The PTY session token is what gets exchanged for shell access, so an
    // unauthenticated mint must never succeed. See the dual-token table in
    // docs/designs/SIDEBAR_MESSAGE_FLOW.md.
    const resp = await api('/pty-session', { method: 'POST', noAuth: true });
    expect(resp.status).toBe(401);
  });
});

describe('ripped chat-queue routes stay ripped', () => {
  // v1.14.0.0 replaced the one-shot `claude -p` queue with the interactive
  // PTY. Re-introducing any of these would mean a second, unaudited command
  // surface on the daemon, so assert their absence rather than trusting the
  // deletion to stay deleted.
  const goneEndpoints: Array<[string, string]> = [
    ['POST', '/sidebar-command'],
    ['GET', '/sidebar-chat'],
    ['POST', '/sidebar-chat/clear'],
    ['POST', '/sidebar-agent/event'],
    ['POST', '/sidebar-agent/kill'],
    ['POST', '/sidebar-agent/stop'],
    ['GET', '/sidebar-tabs'],
    ['POST', '/sidebar-tabs/switch'],
    ['POST', '/sidebar-session/new'],
  ];

  for (const [method, pathname] of goneEndpoints) {
    test(`${method} ${pathname} is gone (404 even with a valid token)`, async () => {
      const resp = await api(pathname, {
        method,
        ...(method === 'POST' ? { body: JSON.stringify({ message: 'x' }) } : {}),
      });
      expect(resp.status).toBe(404);
    });
  }
});
