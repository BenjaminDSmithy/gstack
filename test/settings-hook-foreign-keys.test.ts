/**
 * gstack-settings-hook: foreign top-level keys on foreign hook groups.
 *
 * Other tools mark their own hook groups with their own `_*` key so a
 * re-install updates the group in place instead of appending a second copy
 * (synapse's `_synapse_source` is the concrete case: a lost marker makes
 * `steer.hook.sh.template` fire twice per Stop and twice per SubagentStop).
 *
 * gstack must therefore never carry a foreign group through a key allowlist.
 * Every mutation verb rewrites the whole file, so a rebuild that only copied
 * `matcher` + `hooks` would silently drop every neighbour's marker. These
 * tests pin the "don't clobber your neighbours" invariant across the full
 * install sequence: heal -> register -> uninstall.
 *
 * Companion coverage: gstack-settings-hook-schema-aware.test.ts pins foreign
 * ITEM preservation (a foreign hook inside a group gstack shares). This file
 * pins foreign KEY preservation (metadata on the group object itself).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const ROOT = path.resolve(import.meta.dir, '..');
const SETTINGS_HOOK = path.join(ROOT, 'bin', 'gstack-settings-hook');
const AUQ_MATCHER = '(AskUserQuestion|mcp__.*__AskUserQuestion)';
const HOOK_NAMES = [
  'question-log-hook',
  'question-preference-hook',
  'auq-error-fallback-hook',
  'timeline-stop-hook',
];

let tmpDir: string;
let settingsFile: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-foreignkeys-'));
  settingsFile = path.join(tmpDir, 'settings.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runIso(args: string[], extraEnv: Record<string, string> = {}) {
  try {
    const stdout = execSync([SETTINGS_HOOK, ...args].map((s) => `'${s}'`).join(' '), {
      env: {
        ...process.env,
        GSTACK_SETTINGS_FILE: settingsFile,
        GSTACK_STATE_ROOT: tmpDir,
        ...extraEnv,
      },
      encoding: 'utf-8',
      timeout: 15000,
    });
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout || '', stderr: e.stderr || '', exitCode: e.status ?? 1 };
  }
}

function settings(): any {
  return JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
}

/** A fake stable install with executable hooks, under `base`. */
function mkCanon(base: string, name = 'canon'): string {
  const canon = path.join(base, name);
  fs.mkdirSync(path.join(canon, 'hosts', 'claude', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(canon, 'bin'), { recursive: true });
  for (const h of HOOK_NAMES) {
    const p = path.join(canon, 'hosts', 'claude', 'hooks', h);
    fs.writeFileSync(p, '#!/bin/sh\n');
    fs.chmodSync(p, 0o755);
  }
  const su = path.join(canon, 'bin', 'gstack-session-update');
  fs.writeFileSync(su, '#!/bin/sh\n');
  fs.chmodSync(su, 0o755);
  return canon;
}

/**
 * The observed 2026-08-20 settings.json shape: three neighbour-owned groups,
 * each carrying `_synapse_source`, alongside ordinary untagged user groups.
 * SubagentStop is deliberately included — gstack never registers there, but
 * the sweep verbs iterate every event key in the file.
 */
function seedNeighbourSettings(userHooksDir: string) {
  fs.mkdirSync(userHooksDir, { recursive: true });
  const mk = (name: string) => {
    const p = path.join(userHooksDir, name);
    fs.writeFileSync(p, '#!/bin/sh\n');
    fs.chmodSync(p, 0o755);
    return p;
  };
  const steer = mk('steer.hook.sh.template');
  const stamp = mk('session-account-stamp.hook.sh.template');
  const banner = mk('session-banner.sh');
  const guard = mk('secret-guard.sh');

  fs.writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: guard }] }],
          SessionStart: [
            { hooks: [{ type: 'command', command: banner }] },
            {
              _synapse_source: 'synapse-usage-session-account-stamp',
              hooks: [{ type: 'command', command: stamp }],
            },
          ],
          Stop: [
            { _synapse_source: 'synapse-steer', hooks: [{ type: 'command', command: steer }] },
          ],
          SubagentStop: [
            { _synapse_source: 'synapse-steer', hooks: [{ type: 'command', command: steer }] },
          ],
        },
      },
      null,
      2,
    ) + '\n',
  );
}

/** Every foreign marker still present, with its original value. */
function expectMarkersIntact(s: any) {
  expect(s.hooks.SessionStart[1]._synapse_source).toBe('synapse-usage-session-account-stamp');
  expect(s.hooks.Stop.find((e: any) => e._synapse_source)?._synapse_source).toBe('synapse-steer');
  expect(s.hooks.SubagentStop[0]._synapse_source).toBe('synapse-steer');
}

describe('foreign group keys survive gstack mutations', () => {
  test('registering the timeline Stop hook leaves neighbour groups byte-identical', () => {
    const canon = mkCanon(tmpDir);
    seedNeighbourSettings(path.join(tmpDir, 'user-hooks'));
    const before = settings();

    const r = runIso([
      'ensure-event',
      '--event', 'Stop',
      '--command', `${canon}/hosts/claude/hooks/timeline-stop-hook`,
      '--source', 'gstack-timeline-stop',
      '--timeout', '5',
    ]);
    expect(r.exitCode).toBe(0);

    const s = settings();
    expectMarkersIntact(s);
    // gstack appends its own group; the neighbour's Stop group is untouched
    // in full — marker, hooks array, key order.
    expect(JSON.stringify(s.hooks.Stop[0])).toBe(JSON.stringify(before.hooks.Stop[0]));
    expect(JSON.stringify(s.hooks.SubagentStop)).toBe(JSON.stringify(before.hooks.SubagentStop));
    expect(JSON.stringify(s.hooks.SessionStart)).toBe(JSON.stringify(before.hooks.SessionStart));
    expect(s.hooks.Stop.some((e: any) => e._gstack_source === 'gstack-timeline-stop')).toBe(true);
  });

  test('the full install sequence (heal + all registrations) preserves every marker', () => {
    const canon = mkCanon(tmpDir);
    seedNeighbourSettings(path.join(tmpDir, 'user-hooks'));
    const before = settings();

    // What ./setup runs, in order.
    runIso(['prune-stale', '--repoint', canon]);
    runIso([
      'ensure-event', '--event', 'PostToolUse', '--matcher', AUQ_MATCHER,
      '--command', `${canon}/hosts/claude/hooks/question-log-hook`,
      '--source', 'plan-tune-cathedral', '--timeout', '5',
    ]);
    runIso([
      'ensure-event', '--event', 'PreToolUse', '--matcher', AUQ_MATCHER,
      '--command', `${canon}/hosts/claude/hooks/question-preference-hook`,
      '--source', 'plan-tune-cathedral', '--timeout', '5',
    ]);
    runIso([
      'ensure-event', '--event', 'PostToolUse', '--matcher', AUQ_MATCHER,
      '--command', `${canon}/hosts/claude/hooks/auq-error-fallback-hook`,
      '--source', 'auq-error-fallback', '--timeout', '5',
    ]);
    runIso([
      'ensure-event', '--event', 'Stop',
      '--command', `${canon}/hosts/claude/hooks/timeline-stop-hook`,
      '--source', 'gstack-timeline-stop', '--timeout', '5',
    ]);

    const s = settings();
    expectMarkersIntact(s);
    expect(JSON.stringify(s.hooks.SubagentStop)).toBe(JSON.stringify(before.hooks.SubagentStop));
    // The neighbour's PreToolUse group gained no gstack metadata either.
    expect(s.hooks.PreToolUse.find((e: any) => e.matcher === 'Bash')._gstack_source).toBeUndefined();
  });

  test('a foreign marker on a group gstack SHARES survives (mixed group)', () => {
    const canon = mkCanon(tmpDir);
    const userHooks = path.join(tmpDir, 'user-hooks');
    fs.mkdirSync(userHooks, { recursive: true });
    const own = path.join(userHooks, 'my-own-hook.sh');
    fs.writeFileSync(own, '#!/bin/sh\n');
    fs.chmodSync(own, 0o755);

    // A neighbour-marked group that ALSO holds a dead gstack item: the heal
    // must re-point our item without touching the neighbour's key.
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        PostToolUse: [{
          _synapse_source: 'synapse-steer',
          matcher: AUQ_MATCHER,
          hooks: [
            { type: 'command', command: own },
            { type: 'command', command: '/dead/wt/hosts/claude/hooks/question-log-hook' },
          ],
        }],
      },
    }, null, 2));

    runIso(['prune-stale', '--repoint', canon]);
    const e = settings().hooks.PostToolUse[0];
    expect(e._synapse_source).toBe('synapse-steer');
    expect(e.hooks[0].command).toBe(own);
    expect(e.hooks[1].command).toBe(`${canon}/hosts/claude/hooks/question-log-hook`);
  });

  test('remove-source leaves neighbour groups and their markers alone', () => {
    const canon = mkCanon(tmpDir);
    seedNeighbourSettings(path.join(tmpDir, 'user-hooks'));
    runIso([
      'ensure-event', '--event', 'Stop',
      '--command', `${canon}/hosts/claude/hooks/timeline-stop-hook`,
      '--source', 'gstack-timeline-stop',
    ]);
    const before = settings();

    const r = runIso(['remove-source', '--source', 'gstack-timeline-stop']);
    expect(r.exitCode).toBe(0);

    const s = settings();
    expectMarkersIntact(s);
    expect(s.hooks.Stop.some((e: any) => e._gstack_source)).toBe(false);
    expect(JSON.stringify(s.hooks.Stop[0])).toBe(JSON.stringify(before.hooks.Stop[0]));
    expect(JSON.stringify(s.hooks.SubagentStop)).toBe(JSON.stringify(before.hooks.SubagentStop));
  });

  test('the uninstall sweep (prune-stale --all) preserves neighbour markers', () => {
    const canon = mkCanon(tmpDir);
    seedNeighbourSettings(path.join(tmpDir, 'user-hooks'));
    runIso([
      'ensure-event', '--event', 'Stop',
      '--command', `${canon}/hosts/claude/hooks/timeline-stop-hook`,
      '--source', 'gstack-timeline-stop',
    ]);

    const r = runIso(['prune-stale', '--all']);
    expect(r.exitCode).toBe(0);

    const s = settings();
    expectMarkersIntact(s);
    // gstack removed only its own group.
    expect(s.hooks.Stop).toHaveLength(1);
    expect(s.hooks.Stop[0]._gstack_source).toBeUndefined();
  });

  test('the legacy uninstall verb (remove) preserves neighbour markers', () => {
    const canon = mkCanon(tmpDir);
    seedNeighbourSettings(path.join(tmpDir, 'user-hooks'));
    // gstack's legacy SessionStart item lands in the neighbour-marked group.
    const s0 = settings();
    s0.hooks.SessionStart[1].hooks.push({
      type: 'command',
      command: `${canon}/bin/gstack-session-update`,
    });
    fs.writeFileSync(settingsFile, JSON.stringify(s0, null, 2) + '\n');

    runIso(['remove', `${canon}/bin/gstack-session-update`]);

    const s = settings();
    expectMarkersIntact(s);
    expect(s.hooks.SessionStart[1].hooks).toHaveLength(1);
    expect(s.hooks.SessionStart[1].hooks[0].command).toContain('session-account-stamp');
  });

  test('an unrecognized top-level key on a gstack-OWNED group is preserved too', () => {
    const canon = mkCanon(tmpDir);
    // Somebody else's metadata riding on the group gstack owns. gstack may
    // rewrite the payload; it must not drop keys it does not manage.
    fs.writeFileSync(settingsFile, JSON.stringify({
      hooks: {
        Stop: [{
          _gstack_source: 'gstack-timeline-stop',
          _synapse_source: 'synapse-steer',
          hooks: [{ type: 'command', command: '/dead/wt/hosts/claude/hooks/timeline-stop-hook' }],
        }],
      },
    }, null, 2));

    runIso([
      'ensure-event', '--event', 'Stop',
      '--command', `${canon}/hosts/claude/hooks/timeline-stop-hook`,
      '--source', 'gstack-timeline-stop',
    ]);

    const e = settings().hooks.Stop[0];
    expect(e.hooks[0].command).toBe(`${canon}/hosts/claude/hooks/timeline-stop-hook`);
    expect(e._synapse_source).toBe('synapse-steer');
  });
});
