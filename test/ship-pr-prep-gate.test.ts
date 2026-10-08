/**
 * /ship's side of the pr-prep gate (Step 1.5), run as the agent runs it.
 *
 * pr-prep's Step 5b writes the audit report and /ship's Step 1.5 reads it, so
 * the report path is a contract between two skills: if the two sides ever
 * compute different paths, ship reads "no report" on every run, calls it
 * UNVERIFIED, and an EXACT_DUP never blocks. The gate block itself decides
 * what a missing or malformed report means. Both are run here under every
 * shell the skill can meet; the prose rules around them are checked on
 * meaning (test/helpers/prompt-structure.ts).
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { between, expectMentions, expectOrdered } from './helpers/prompt-structure';

setDefaultTimeout(120_000);

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const SHIP_MD = read('ship/SKILL.md');
const PR_BODY_MD = read('ship/sections/pr-body.md');
const PR_PREP_MD = read('pr-prep/SKILL.md');

/** Every top-level ```bash block in `text`. */
const bashBlocks = (text: string): string[] => [...text.matchAll(/^```bash\n([\s\S]*?)\n```$/gm)].map((m) => m[1]);
const STEP_15 = between(SHIP_MD, '## Step 1.5:', '## Step 2:');
const STEP_17 = between(SHIP_MD, '## Step 17:', '## Step 18:');
const GATE_BLOCK = (() => {
  const b = bashBlocks(STEP_15).find((x) => x.includes('PR_PREP_WORST'));
  if (!b) throw new Error('no PR_PREP_WORST block in ship/SKILL.md Step 1.5');
  return b;
})();

/** Every line that sets the report path, wherever it sits (the PR-body one is indented prose). */
const REPORT_LINE = /^\s*(_PP_REPORT="\$\{GSTACK_PR_PREP_REPORT:-[^\n]*\}")\s*$/gm;
const reportLines = (text: string) => [...text.matchAll(REPORT_LINE)].map((m) => m[1]);

// The runner's bash, zsh, and macOS's /bin/bash 3.2 when it is another binary.
const SHELLS = ['bash', 'zsh', '/bin/bash']
  .filter((s) => (s.startsWith('/') ? fs.existsSync(s) : Bun.which(s)))
  .map((s) => ({ s, real: fs.realpathSync(s.startsWith('/') ? s : Bun.which(s)!) }))
  .filter((x, i, all) => all.findIndex((y) => y.real === x.real) === i)
  .map((x) => x.s);
const HAVE_JQ = Bun.which('jq') !== null;
const TOOL_DIRS = [...new Set(['git', 'jq'].map((t) => Bun.which(t)).filter((p): p is string => !!p).map((p) => path.dirname(p)))];

let tmp: string;
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-pr-prep-gate-')));
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function repo(name: string): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync('git', ['init', '-q', '-b', 'main', dir], { encoding: 'utf-8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git init: ${r.stderr}`);
  return dir;
}

function run(shell: string, script: string, cwd: string, env: Record<string, string> = {}, stub?: string) {
  const args = shell === 'zsh' ? ['-f', '-c', script] : ['--noprofile', '--norc', '-c', script];
  const r = spawnSync(shell, args, {
    cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: {
      PATH: [...(stub ? [stub] : []), ...TOOL_DIRS, '/usr/bin', '/bin'].join(':'),
      HOME: tmp,
      TMPDIR: tmp,
      LANG: 'C.UTF-8',
      ...env,
    },
  });
  return { code: r.status, stdout: r.stdout ?? '', out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n[spawn error] ${r.error}` : ''}` };
}

describe('/ship Step 1.5: the pr-prep report path', () => {
  test('ship reads the report pr-prep writes: every side resolves one path, keyed on the repo root', () => {
    const lines = [
      ...reportLines(SHIP_MD).map((l) => ({ where: 'ship/SKILL.md', l })),
      ...reportLines(PR_BODY_MD).map((l) => ({ where: 'ship/sections/pr-body.md', l })),
      ...reportLines(PR_PREP_MD).map((l) => ({ where: 'pr-prep/SKILL.md', l })),
    ];
    // The probe and the gate block (Step 1.5), the PR body's Upstream context
    // (Step 19), and pr-prep's Step 5b stamp.
    expect(lines.map((x) => x.where)).toEqual(['ship/SKILL.md', 'ship/SKILL.md', 'ship/sections/pr-body.md', 'pr-prep/SKILL.md']);
    const a = repo('wt-a');
    const b = repo('wt-b');
    for (const shell of SHELLS) {
      const resolve = (cwd: string) =>
        lines.map(({ where, l }) => {
          const r = run(shell, `${l}\nprintf '%s\\n' "$_PP_REPORT"`, cwd);
          expect(r.code, `${where} under ${shell}: ${r.out}`).toBe(0);
          return r.stdout.trim();
        });
      const inA = resolve(a);
      expect(new Set(inA).size, `${shell}: ${inA.join(' | ')}`).toBe(1);
      expect(inA[0]).toMatch(/\/ship-pr-prep-[0-9a-f]{8}\.json$/);
      // Two worktrees of one project never read each other's verdict.
      const inB = resolve(b);
      expect(new Set(inB).size).toBe(1);
      expect(inB[0]).not.toBe(inA[0]);
    }
  });
});

describe.skipIf(!HAVE_JQ)('/ship Step 1.5: the gate block', () => {
  // The block sets PR_PREP_WORST for the prose that follows it; print what it settled on.
  const gate = `${GATE_BLOCK}\nprintf 'GATE=%s\\n' "$PR_PREP_WORST"`;
  const cases: { name: string; report: string | null; want: string }[] = [
    { name: 'no report: the audit did not clear the branch', report: null, want: 'UNVERIFIED' },
    { name: 'EXACT_DUP passes through for the abort', report: '{"summary":"1 EXACT_DUP","worst":"EXACT_DUP","commits":[]}', want: 'EXACT_DUP' },
    { name: 'a report without worst', report: '{"summary":"x","commits":[]}', want: 'UNVERIFIED' },
    { name: 'an unreadable report', report: '{"worst": "CLEAN"', want: 'UNVERIFIED' },
    { name: 'CLEAN is read as CLEAN', report: '{"summary":"ok","worst":"CLEAN","commits":[]}', want: 'CLEAN' },
  ];
  for (const [si, shell] of SHELLS.entries()) {
    for (const [i, c] of cases.entries()) {
      test(`under ${shell}: ${c.name}`, () => {
        const cwd = repo(`gate-${si}-${i}`);
        const report = path.join(cwd, 'report.json');
        if (c.report !== null) fs.writeFileSync(report, c.report);
        const r = run(shell, gate, cwd, { GSTACK_PR_PREP_REPORT: report });
        expect(r.out).toContain(`GATE=${c.want}\n`);
      });
    }
  }
});

describe('/ship Step 1.5: the rules around the gate', () => {
  test('the audit runs through the Skill tool with no arguments, and EXACT_DUP aborts ship', () => {
    // Lines joined (a rule may wrap mid-phrase); a blank line still ends a sentence.
    const prose = STEP_15.replace(/([^\n])\n(?=[^\n])/g, '$1 ');
    expectMentions(prose, [
      // Any argument picks a pr-prep mode other than the audit.
      ['skill tool', 'no arguments'],
      ['exact_dup', 'abort', 'skip-pr-prep'],
      // A lost report never un-blocks a duplicate the audit found.
      ['report', 'missing', 'exact_dup'],
      // UNVERIFIED continues, but never reads as cleared.
      ['unverified', 'not', 'clear'],
    ], 'ship Step 1.5');
  });
});

// Step 19 replaced an open PR's body with a fresh one (dropping the owner's
// screenshot and ticked box 1, which upstream's PR template requires of an
// external contributor), Step 17 pushed to its head with no watch gate, and a
// new fork PR was opened by ship's own non-draft `gh pr create` (2026-10-09).
// Step 17's check decides, before any push, whether the branch is a fork PR
// to someone else's repo and whether that PR is already open.
describe('/ship Step 17: a fork PR to someone else\'s repo', () => {
  const CHECK = (() => {
    const b = bashBlocks(STEP_17).find((x) => x.includes('UPSTREAM_PR'));
    if (!b) throw new Error('no UPSTREAM_PR block in ship/SKILL.md Step 17');
    return b.replaceAll('<branch-name>', 'feat/x');
  })();

  /** A gh that answers only the two reads the check makes, and only for the expected repo and branch. */
  function gh(opts: { repo?: string; prs?: string; listFails?: boolean }): string {
    const dir = fs.mkdtempSync(path.join(tmp, 'gh-'));
    const view = opts.repo === undefined ? 'exit 1' : `echo '${opts.repo}'`;
    const list = opts.listFails ? 'exit 1' : `printf '%s' '${opts.prs ?? ''}'`;
    fs.writeFileSync(path.join(dir, 'gh'), [
      '#!/bin/sh',
      'case "$*" in',
      `  "repo view --json nameWithOwner -q .nameWithOwner") ${view} ;;`,
      `  "pr list --repo garrytan/gstack --head feat/x --state open --json number -q .[].number") ${list} ;;`,
      '  *) echo "unexpected gh $*" >&2; exit 3 ;;',
      'esac',
      '',
    ].join('\n'), { mode: 0o755 });
    return dir;
  }

  function clone(name: string, origin: string): string {
    const dir = repo(name);
    const r = spawnSync('git', ['remote', 'add', 'origin', origin], { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
    if (r.status !== 0) throw new Error(`git remote add: ${r.stderr}`);
    return dir;
  }

  const cases: { name: string; origin: string; gh: Parameters<typeof gh>[0]; want: string; code: number }[] = [
    { name: 'a fork branch with no PR yet is new', origin: 'https://github.com/me/gstack.git', gh: { repo: 'Garrytan/gstack' }, want: 'UPSTREAM_PR: new garrytan/gstack', code: 0 },
    { name: 'a fork branch with an open PR is open', origin: 'git@github.com:me/gstack.git', gh: { repo: 'garrytan/gstack', prs: '3066' }, want: 'UPSTREAM_PR: open 3066 garrytan/gstack', code: 0 },
    { name: 'two open PRs on the branch are both named', origin: 'git@github.com:me/gstack.git', gh: { repo: 'garrytan/gstack', prs: '3066\n3067' }, want: 'UPSTREAM_PR: open 3066 3067 garrytan/gstack', code: 0 },
    { name: 'a look-alike owner is still a fork', origin: 'https://github.com/notgarrytan/gstack', gh: { repo: 'garrytan/gstack' }, want: 'UPSTREAM_PR: new garrytan/gstack', code: 0 },
    { name: 'origin is the repo itself (any case, ssh)', origin: 'git@github.com:GarryTan/GStack.git', gh: { repo: 'garrytan/gstack', listFails: true }, want: 'UPSTREAM_PR: none', code: 0 },
    { name: 'no GitHub repo (GitLab, no gh) is none', origin: 'git@gitlab.example.com:me/gstack.git', gh: {}, want: 'UPSTREAM_PR: none', code: 0 },
    { name: 'a failed PR lookup stops', origin: 'https://github.com/me/gstack.git', gh: { repo: 'garrytan/gstack', listFails: true }, want: 'UPSTREAM_PR: lookup failed', code: 1 },
  ];

  for (const [si, shell] of SHELLS.entries()) {
    for (const [i, c] of cases.entries()) {
      test(`under ${shell}: ${c.name}`, () => {
        const cwd = clone(`up-${si}-${i}`, c.origin);
        const r = run(shell, CHECK, cwd, {}, gh(c.gh));
        expect(r.out).not.toContain('unexpected gh');
        expect(r.out.split('\n').filter((l) => l.startsWith('UPSTREAM_PR:'))).toEqual([c.want + (c.code ? ' - STOP' : '')]);
        expect(r.code).toBe(c.code);
      });
    }
  }

  test('the check runs before the push, and neither handoff writes to the upstream PR', () => {
    expectOrdered(STEP_17, ['UPSTREAM_PR: none', '**Credential pre-push guard', 'git push -u origin'], 'ship Step 17');
    const prose = STEP_17.replace(/([^\n])\n(?=[^\n])/g, '$1 ');
    expectMentions(prose, [
      // An open PR: no push, no body or title edit.
      ['open', 'never writes'],
      ['do not push', 'skip steps 18-19', 'screenshot'],
      ['gstack-pr-watch poll', 'exit 0', 'before', 'push'],
      ['/pr-prep body'],
      // A new one: never opened by ship.
      ['new', 'skip steps 18-19', '/pr-prep open'],
      ['lookup failed', 'stop'],
    ], 'ship Step 17');
    // Step 19, if reached anyway, says the same.
    expectMentions(PR_BODY_MD.replace(/([^\n])\n(?=[^\n])/g, '$1 '), [['upstream_pr', 'never reach', '/pr-prep']], 'ship Step 19');
  });
});
