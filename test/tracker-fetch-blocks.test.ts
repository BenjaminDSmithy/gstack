/**
 * Runs the generated tracker-fetch bash blocks against a stub `gh`, under bash
 * and (when installed) zsh — the shell skills actually run in on macOS.
 *
 * /spec Step 1b (issue dedupe) and /land-and-deploy 3.5c (PR body accuracy)
 * used to pipe `gh ... | gstack-issue-guard --stdin`. The guard envelopes
 * whatever reaches its stdin, so a failed gh (auth, bad args, rate limit)
 * printed the same "(empty body)" envelope as a genuine empty result: a failed
 * dedupe search read as "no duplicates", a failed PR-body fetch as "the body
 * is empty". Both blocks now call a guard fetch mode that runs gh itself, and
 * a failure must print an explicit FETCH FAILED line and NO envelope.
 *
 * Free and deterministic — no network, no model calls.
 */
import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const GUARD = path.join(ROOT, 'bin', 'gstack-issue-guard');
const ENVELOPE = 'BEGIN UNTRUSTED TRACKER CONTENT';

// Every case starts the Bun guard once; on a loaded box that alone can
// outrun bun's 5s default.
setDefaultTimeout(60_000);

/** First ```bash block after `heading` in a generated file, guard path pointed at this tree. */
function bashBlockAfter(rel: string, heading: string): string {
  const md = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
  const at = md.indexOf(heading);
  if (at < 0) throw new Error(`heading not found in ${rel}: ${heading}`);
  const m = md.slice(at).match(/```bash\n([\s\S]*?)\n```/);
  if (!m) throw new Error(`no bash block after ${heading} in ${rel}`);
  return m[1].replaceAll('~/.claude/skills/gstack/bin/gstack-issue-guard', GUARD);
}

const DEDUPE_BLOCK = bashBlockAfter('spec/SKILL.md', '**Step 1b (--dedupe is ON by default):**');
const PR_BODY_BLOCK = bashBlockAfter('land-and-deploy/sections/readiness-gate.md', '### 3.5c: PR body accuracy check');

const SHELLS = ['bash', 'zsh'].filter((s) => Bun.which(s));

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-fetch-blocks-'));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Stub gh: logs its argv as one [a][b]... line per call, prints `stdout`, exits `code`. */
function ghStub(stdout: string, code: number, stderr = ''): { dir: string; calls: () => string[] } {
  const dir = fs.mkdtempSync(path.join(tmp, 'stub-'));
  const log = path.join(dir, 'argv.log');
  fs.writeFileSync(path.join(dir, 'out.txt'), stdout);
  fs.writeFileSync(path.join(dir, 'err.txt'), stderr);
  fs.writeFileSync(
    path.join(dir, 'gh'),
    `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a"; done >> "${log}"; echo >> "${log}"\n` +
      `cat "${dir}/out.txt"\ncat "${dir}/err.txt" >&2\nexit ${code}\n`,
    { mode: 0o755 },
  );
  return {
    dir,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean) : []),
  };
}

function run(shell: string, block: string, stubDir: string, env: Record<string, string> = {}) {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const args = shell === 'zsh' ? ['-f', '-c', block] : ['--noprofile', '--norc', '-c', block];
  const r = spawnSync(shell, args, {
    cwd: tmp,
    encoding: 'utf-8',
    timeout: 45_000,
    env: {
      // bun's own dir so the guard's `#!/usr/bin/env bun` resolves.
      PATH: [stubDir, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
      HOME: home,
      TMPDIR: tmp,
      LANG: 'C.UTF-8',
      ...env,
    },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n[spawn error] ${r.error}` : ''}` };
}

describe('tracker fetch blocks: the guard runs gh, never a gh pipe into --stdin', () => {
  test('neither block feeds --stdin; each prints an explicit failure line', () => {
    for (const block of [DEDUPE_BLOCK, PR_BODY_BLOCK]) {
      expect(block).not.toContain('--stdin');
      expect(block).not.toMatch(/\bgh\s+(issue|pr)\s/);
    }
    expect(DEDUPE_BLOCK).toContain('gstack-issue-guard search issue');
    expect(DEDUPE_BLOCK).toContain('DEDUPE FETCH FAILED');
    expect(PR_BODY_BLOCK).toContain('gstack-issue-guard pr-body "$PR_NUMBER" --repo "$REPO"');
    expect(PR_BODY_BLOCK).toContain('PR BODY FETCH FAILED');
  });
});

for (const shell of SHELLS) {
  describe(`/spec dedupe block under ${shell}`, () => {
    const block = DEDUPE_BLOCK.replaceAll('<keywords>', 'widget dedupe');

    test('failed gh -> DEDUPE FETCH FAILED with the reason, NO envelope', () => {
      const gh = ghStub('', 1, 'HTTP 401: Bad credentials (https://api.github.com/graphql)');
      const r = run(shell, block, gh.dir);
      expect(r.out).toContain('DEDUPE FETCH FAILED');
      expect(r.out).toContain('This is NOT zero matches');
      expect(r.out).toContain('HTTP 401: Bad credentials');
      expect(r.out).not.toContain(ENVELOPE);
      expect(r.out).not.toContain('(empty body)');
      expect(gh.calls()).toHaveLength(1);
    });

    test('gh exit 0 with non-array output -> DEDUPE FETCH FAILED, NO envelope', () => {
      for (const out of ['', 'not json', '{"message":"API rate limit exceeded"}']) {
        const r = run(shell, block, ghStub(out, 0).dir);
        expect(r.out).toContain('DEDUPE FETCH FAILED');
        expect(r.out).not.toContain(ENVELOPE);
      }
    });

    test('genuine zero matches -> "0 matches" envelope, no failure line', () => {
      const r = run(shell, block, ghStub('[]', 0).dir);
      expect(r.out).toContain(`${ENVELOPE} ═══ (issue search: 0 matches)`);
      expect(r.out).toContain('(empty body)');
      expect(r.out).not.toContain('FETCH FAILED');
    });

    test('hits are enveloped; the keywords reach gh as ONE argument', () => {
      const gh = ghStub(JSON.stringify([{ number: 913, title: 'widget dedupe is flaky', url: 'https://example.com/913' }]), 0);
      const r = run(shell, block, gh.dir);
      expect(r.out).toContain('(issue search: 1 match)');
      expect(r.out).toContain('#913 widget dedupe is flaky');
      expect(r.out).not.toContain('FETCH FAILED');
      expect(gh.calls()).toEqual([
        '[issue][list][--search][widget dedupe][--state][open][--limit][10][--json][number,title,url]',
      ]);
    });
  });

  describe(`/land-and-deploy PR-body block under ${shell}`, () => {
    const env = { PR_NUMBER: '42', REPO: 'acme/widgets' };

    test('failed gh -> PR BODY FETCH FAILED with the reason, NO envelope', () => {
      const gh = ghStub('', 1, 'GraphQL: Could not resolve to a PullRequest with the number of 42.');
      const r = run(shell, PR_BODY_BLOCK, gh.dir, env);
      expect(r.out).toContain('PR BODY FETCH FAILED: PR #42 body was not read');
      expect(r.out).toContain('This is NOT an empty body');
      expect(r.out).toContain('Could not resolve to a PullRequest');
      expect(r.out).not.toContain(ENVELOPE);
      expect(r.out).not.toContain('(empty body)');
      expect(gh.calls()).toEqual(['[pr][view][42][--repo][acme/widgets][--json][body][--jq][.body]']);
    });

    test('unset PR_NUMBER -> failure line, gh never called', () => {
      const gh = ghStub('body', 0);
      const r = run(shell, PR_BODY_BLOCK, gh.dir, { REPO: 'acme/widgets' });
      expect(r.out).toContain('PR BODY FETCH FAILED');
      expect(r.out).not.toContain(ENVELOPE);
      expect(gh.calls()).toEqual([]);
    });

    test('a real empty body is enveloped "(empty body)", with no failure line', () => {
      const r = run(shell, PR_BODY_BLOCK, ghStub('\n', 0).dir, env);
      expect(r.out).toContain(`${ENVELOPE} ═══ (PR #42 body)`);
      expect(r.out).toContain('(empty body)');
      expect(r.out).not.toContain('FETCH FAILED');
    });

    test('a body is enveloped as data', () => {
      const r = run(shell, PR_BODY_BLOCK, ghStub('## Summary\nAdds the widget.\n', 0).dir, env);
      expect(r.out).toContain('(PR #42 body)');
      expect(r.out).toContain('Adds the widget.');
      expect(r.out).not.toContain('FETCH FAILED');
    });
  });
}
