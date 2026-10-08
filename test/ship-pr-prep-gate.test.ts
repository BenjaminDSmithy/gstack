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
import { between, expectMentions } from './helpers/prompt-structure';

setDefaultTimeout(120_000);

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const SHIP_MD = read('ship/SKILL.md');
const PR_BODY_MD = read('ship/sections/pr-body.md');
const PR_PREP_MD = read('pr-prep/SKILL.md');

/** Every top-level ```bash block in `text`. */
const bashBlocks = (text: string): string[] => [...text.matchAll(/^```bash\n([\s\S]*?)\n```$/gm)].map((m) => m[1]);
const STEP_15 = between(SHIP_MD, '## Step 1.5:', '## Step 2:');
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

function run(shell: string, script: string, cwd: string, env: Record<string, string> = {}) {
  const args = shell === 'zsh' ? ['-f', '-c', script] : ['--noprofile', '--norc', '-c', script];
  const r = spawnSync(shell, args, {
    cwd,
    encoding: 'utf-8',
    timeout: 60_000,
    env: {
      PATH: [...TOOL_DIRS, '/usr/bin', '/bin'].join(':'),
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
  for (const shell of SHELLS) {
    for (const c of cases) {
      test(`under ${shell}: ${c.name}`, () => {
        const cwd = repo(`gate-${path.basename(shell)}-${c.want}-${c.report === null ? 'none' : c.report.length}`);
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
