/**
 * Runs the generated /pr-prep SKILL.md bash blocks against stub `gh` and
 * `codex` binaries, under bash and (when installed) zsh — the shell the
 * skill actually runs in on macOS.
 *
 * Step 3: a failed `gh ... list` must surface as FETCH FAILED / UNVERIFIED,
 *   never as an "(empty body)" envelope. The guard envelopes whatever reaches
 *   its stdin, so a bare `gh | jq | guard` pipe turned 24 failed fetches into
 *   24 "(empty body)" envelopes — a false CLEAN (observed 2026-09-26).
 * Step 4.4: the second opinion runs through `codex exec -` (prompt on stdin,
 *   sandbox from gstack-codex-probe, result through the shared validator),
 *   never `codex review "<prompt>"` (a bare prompt reviews the uncommitted
 *   tree; `--base`/`--commit` reject a prompt), and a usage-limit error is a
 *   loud skip, not a silent pass.
 *
 * Free and deterministic — no network, no model calls.
 */
import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SKILL_MD = fs.readFileSync(path.join(ROOT, 'pr-prep', 'SKILL.md'), 'utf-8');
const GUARD = path.join(ROOT, 'bin', 'gstack-issue-guard');
const ENVELOPE = 'BEGIN UNTRUSTED TRACKER CONTENT';

// Each fetch case starts the Bun issue guard 4 times; on a loaded box that
// alone outruns bun's 5s default.
setDefaultTimeout(120_000);

/** First ```bash block after the given heading, or throw. */
function bashBlockAfter(heading: string): string {
  const at = SKILL_MD.indexOf(heading);
  if (at < 0) throw new Error(`heading not found in pr-prep/SKILL.md: ${heading}`);
  const m = SKILL_MD.slice(at).match(/```bash\n([\s\S]*?)\n```/);
  if (!m) throw new Error(`no bash block after: ${heading}`);
  return m[1];
}

function sectionAfter(heading: string): string {
  const at = SKILL_MD.indexOf(heading);
  if (at < 0) throw new Error(`heading not found in pr-prep/SKILL.md: ${heading}`);
  const next = SKILL_MD.indexOf('\n## ', at + heading.length);
  return SKILL_MD.slice(at, next < 0 ? undefined : next);
}

const FETCH_BLOCK = bashBlockAfter('## Step 3:').replaceAll('~/.claude/skills/gstack/bin/gstack-issue-guard', GUARD);
const CODEX_BLOCK = bashBlockAfter('## Step 4.4:')
  .replaceAll('~/.claude/skills/gstack/bin/gstack-codex-probe', path.join(ROOT, 'bin', 'gstack-codex-probe'))
  .replaceAll('~/.claude/skills/gstack/lib/outside-review-result.ts', path.join(ROOT, 'lib', 'outside-review-result.ts'));

const SHELLS = ['bash', 'zsh'].filter((s) => Bun.which(s));
const HAVE_JQ = Bun.which('jq') !== null;
const TOOL_DIRS = [...new Set(['git', 'jq'].map((t) => Bun.which(t)).filter((p): p is string => !!p).map((p) => path.dirname(p)))];

let tmp: string;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-prep-blocks-'));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function stubDir(name: string, script: string): string {
  const dir = fs.mkdtempSync(path.join(tmp, 'stub-'));
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return dir;
}

function run(shell: string, block: string, opts: { stub: string; cwd?: string; env?: Record<string, string> }) {
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const args = shell === 'zsh' ? ['-f', '-c', block] : ['--noprofile', '--norc', '-c', block];
  const r = spawnSync(shell, args, {
    cwd: opts.cwd ?? tmp,
    encoding: 'utf-8',
    timeout: 90_000,
    env: {
      // The runner's own git/jq dirs come first: /usr/bin/git on macOS is an
      // xcrun shim that is slow on a fresh HOME.
      PATH: [opts.stub, path.dirname(process.execPath), ...TOOL_DIRS, '/usr/bin', '/bin'].join(':'),
      HOME: home,
      TMPDIR: tmp,
      LANG: 'C.UTF-8',
      ...opts.env,
    },
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n[spawn error] ${r.error}` : ''}` };
}

describe('pr-prep Step 3: fetch health is checked before the guard', () => {
  test('block checks gh exit status and JSON shape before piping to the guard', () => {
    expect(FETCH_BLOCK).toContain(`jq -e 'type == "array"'`);
    expect(FETCH_BLOCK).toContain('FETCH_STATUS:');
    expect(sectionAfter('## Step 3:')).toContain('An envelope proves only that the guard ran, not that the fetch ran');
    expect(sectionAfter('## Step 3:')).toMatch(/zsh does NOT word-split/);
  });

  for (const shell of SHELLS) {
    describe.skipIf(!HAVE_JQ)(`under ${shell}`, () => {
      const env = { REPO: 'acme/widgets', QUERY: 'synopsis truncate' };

      test('failed gh -> FETCH FAILED x4, UNVERIFIED, and NO envelope', () => {
        const stub = stubDir('gh', `echo 'unknown command "issue open" for "gh"' >&2\nexit 1`);
        const r = run(shell, FETCH_BLOCK, { stub, env });
        expect(r.out).toContain('FETCH_STATUS: FAILED (4 of 4)');
        expect(r.out).toContain('UNVERIFIED');
        expect(r.out).toContain('unknown command "issue open"');
        expect(r.out).not.toContain(ENVELOPE);
        expect(r.out).not.toContain('(empty body)');
      });

      test('gh exit 0 with non-JSON output -> FAILED, not an empty envelope', () => {
        const stub = stubDir('gh', 'exit 0');
        const r = run(shell, FETCH_BLOCK, { stub, env });
        expect(r.out).toContain('FETCH_STATUS: FAILED (4 of 4)');
        expect(r.out).not.toContain(ENVELOPE);
      });

      test('genuine zero matches -> ok (4/4) with "(empty body)" envelopes', () => {
        const stub = stubDir('gh', `echo '[]'`);
        const r = run(shell, FETCH_BLOCK, { stub, env });
        expect(r.out).toContain('FETCH_STATUS: ok (4/4)');
        expect(r.out.split(ENVELOPE).length - 1).toBe(4);
        expect(r.out).toContain('(empty body)');
        expect(r.out).not.toContain('FETCH FAILED');
      });

      test('hits are enveloped and REPO/QUERY reach gh as separate arguments', () => {
        const argLog = path.join(tmp, `gh-args-${shell}.log`);
        const stub = stubDir(
          'gh',
          `for a in "$@"; do printf '[%s]' "$a"; done >> "${argLog}"; echo >> "${argLog}"\n` +
            `echo '[{"number":913,"title":"reindex cli fix","url":"https://example.com/913"}]'`,
        );
        const r = run(shell, FETCH_BLOCK, { stub, env });
        expect(r.out).toContain('FETCH_STATUS: ok (4/4)');
        expect(r.out).toContain('#913 reindex cli fix https://example.com/913');
        const calls = fs.readFileSync(argLog, 'utf-8').trim().split('\n');
        // Full argv per call: each _pp_fetch input is a named variable, so a
        // misspelt one would reach gh as an empty argument.
        const q = '[--repo][acme/widgets]';
        const s = '[--search][synopsis truncate]';
        expect(calls).toEqual([
          `[issue][list]${q}[--state][open]${s}[--limit][8][--json][number,title,url,labels]`,
          `[pr][list]${q}[--state][open]${s}[--limit][8][--json][number,title,url,headRefName,author]`,
          `[issue][list]${q}[--state][closed]${s}[--limit][5][--json][number,title,url,closedAt]`,
          `[pr][list]${q}[--state][merged]${s}[--limit][5][--json][number,title,url,mergedAt]`,
        ]);
        const rawDir = r.out.match(/raw fetches: (\S+)/)?.[1];
        expect(rawDir).toBeDefined();
        expect(fs.readdirSync(rawDir!).filter((f) => f.endsWith('.json')).sort()).toEqual(
          ['issues-closed.json', 'issues-open.json', 'prs-merged.json', 'prs-open.json'],
        );
      });
    });
  }
});

describe('pr-prep Step 4.4: codex second opinion', () => {
  test('never uses `codex review "<prompt>"`; uses codex exec with the prompt on stdin and the shared sandbox', () => {
    // Prose may name the anti-pattern; no executable block may run it.
    const blocks = [...SKILL_MD.matchAll(/```bash\n([\s\S]*?)\n```/g)].map((m) => m[1]);
    expect(blocks.length).toBeGreaterThan(5);
    for (const b of blocks) {
      expect(b).not.toMatch(/codex review\s+"/);
      expect(b).not.toMatch(/codex review\s+--(base|commit)\s+\S+\s+"/);
    }
    expect(CODEX_BLOCK).toContain('codex exec - -C "$_REPO_ROOT" -s "${_GSTACK_CODEX_SANDBOX:?}"');
    expect(CODEX_BLOCK).toContain('< "$_CX/$sha.prompt"');
    expect(CODEX_BLOCK).toContain('outside-review-result.ts');
    expect(CODEX_BLOCK).not.toMatch(/for sha in \$/);
    expect(sectionAfter('## Step 4.4:')).toMatch(/usage limit/i);
  });

  let repo: string;
  let shas: string[];
  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(tmp, 'repo-'));
    const git = (...a: string[]) =>
      spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...a], {
        cwd: repo,
        encoding: 'utf-8',
        timeout: 30_000,
      });
    git('init', '-q', '-b', 'main');
    for (const n of ['one', 'two']) {
      fs.writeFileSync(path.join(repo, `${n}.txt`), n);
      git('add', `${n}.txt`);
      git('commit', '-q', '-m', `feat: add ${n}`);
    }
    shas = git('log', '--format=%H', '-2').stdout.trim().split('\n').reverse();
  });

  // Stub: logs one CALL line per invocation, swallows stdin the way real
  // `codex exec` does when stdin is piped, then acts per CODEX_STUB_MODE.
  const REVIEW = `P2: one.txt:1 ${'looks fine; '.repeat(50)}`;
  const codexStub = (log: string) =>
    stubDir(
      'codex',
      [
        `echo "CALL $1 $2 $3" >> "${log}"`,
        'out=""',
        'while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done',
        'cat > /dev/null',
        'case "$CODEX_STUB_MODE" in',
        `  ok) printf '%s\\n' "${REVIEW}" > "$out"; exit 0;;`,
        `  limit) echo "ERROR: You've hit your usage limit. Try again later." >&2; exit 1;;`,
        `  limit0) echo "You've hit your usage limit." | tee "$out" >&2; exit 0;;`,
        `  untagged) printf '%s\\n' "${'the change reads well; '.repeat(30)}" > "$out"; exit 0;;`,
        '  *) echo "boom" >&2; exit 2;;',
        'esac',
      ].join('\n'),
    );

  for (const shell of SHELLS) {
    describe(`under ${shell}`, () => {
      const calls = (log: string) =>
        fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean) : [];

      test('reviews every CLEAN commit via `codex exec` (newline- or space-separated SHAs)', () => {
        for (const sep of ['\n', ' ']) {
          const log = path.join(tmp, `codex-ok-${shell}-${sep === ' ' ? 'sp' : 'nl'}.log`);
          const r = run(shell, CODEX_BLOCK, {
            stub: codexStub(log),
            cwd: repo,
            env: { CODEX_STUB_MODE: 'ok', CLEAN_COMMIT_SHAS: shas.join(sep) },
          });
          expect(calls(log)).toEqual(['CALL exec - -C', 'CALL exec - -C']);
          for (const sha of shas) expect(r.out).toContain(`=== codex review ${sha} ===`);
          expect(r.out).not.toContain('CODEX SKIPPED');
          expect(r.out).not.toContain('CODEX FAILED');
        }
      });

      test('usage limit (non-zero exit) -> loud SKIPPED, stops calling codex', () => {
        const log = path.join(tmp, `codex-limit-${shell}.log`);
        const r = run(shell, CODEX_BLOCK, {
          stub: codexStub(log),
          cwd: repo,
          env: { CODEX_STUB_MODE: 'limit', CLEAN_COMMIT_SHAS: shas.join('\n') },
        });
        expect(r.out).toContain(`CODEX SKIPPED: usage limit hit at ${shas[0]}`);
        expect(r.out).toContain('This is NOT a pass');
        expect(r.out).not.toContain('=== codex review');
        expect(calls(log)).toHaveLength(1);
      });

      test('usage limit returned as an exit-0 "review" -> still SKIPPED, not printed as a review', () => {
        const log = path.join(tmp, `codex-limit0-${shell}.log`);
        const r = run(shell, CODEX_BLOCK, {
          stub: codexStub(log),
          cwd: repo,
          env: { CODEX_STUB_MODE: 'limit0', CLEAN_COMMIT_SHAS: shas.join('\n') },
        });
        expect(r.out).toContain('CODEX SKIPPED: usage limit');
        expect(r.out).not.toContain('=== codex review');
      });

      test('a review with no severity tag and no NO_FINDINGS -> CODEX FAILED, never printed as a review', () => {
        const log = path.join(tmp, `codex-untagged-${shell}.log`);
        const r = run(shell, CODEX_BLOCK, {
          stub: codexStub(log),
          cwd: repo,
          env: { CODEX_STUB_MODE: 'untagged', CLEAN_COMMIT_SHAS: shas.join('\n') },
        });
        for (const sha of shas) expect(r.out).toContain(`CODEX FAILED: ${sha} (exit 0, untagged_review)`);
        expect(r.out).not.toContain('=== codex review');
      });

      test('other codex failure -> CODEX FAILED per commit, never a pass', () => {
        const log = path.join(tmp, `codex-fail-${shell}.log`);
        const r = run(shell, CODEX_BLOCK, {
          stub: codexStub(log),
          cwd: repo,
          env: { CODEX_STUB_MODE: 'boom', CLEAN_COMMIT_SHAS: shas.join('\n') },
        });
        for (const sha of shas) expect(r.out).toContain(`CODEX FAILED: ${sha} (exit 2`);
        expect(r.out).not.toContain('=== codex review');
        expect(calls(log)).toHaveLength(2);
      });
    });
  }
});
