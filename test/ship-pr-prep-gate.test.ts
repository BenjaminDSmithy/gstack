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
import { getQuestion } from '../scripts/question-registry';

setDefaultTimeout(120_000);

const ROOT = path.resolve(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const SHIP_MD = read('ship/SKILL.md');
const PR_BODY_MD = read('ship/sections/pr-body.md');
const GREPTILE_MD = read('ship/sections/greptile.md');
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
// to someone else's repo and whether that PR is already open. It reads the
// upstream from origin's URL: gh's default repo is whatever `gh repo
// set-default` last chose, and a check that asked it printed `none` for an
// open upstream PR once the default was the fork, or when gh was down.
describe.skipIf(!HAVE_JQ)('/ship Step 17: a fork PR to someone else\'s repo', () => {
  const CHECK = (() => {
    const b = bashBlocks(STEP_17).find((x) => x.includes('UPSTREAM_PR'));
    if (!b) throw new Error('no UPSTREAM_PR block in ship/SKILL.md Step 17');
    return b.replaceAll('<branch-name>', 'feat/x');
  })();

  interface Gh {
    /** Repos gh can see, as GitHub spells them, each with its fork parent (null: not a fork). */
    repos?: Record<string, string | null>;
    /** Open PR numbers whose head branch is feat/x, per lowercase repo; a repo left out is one gh cannot find. */
    prs?: Record<string, number[]>;
    /** Lowercase repos whose PR lookup fails with a server error (gh can see them, but not now). */
    broken?: string[];
    /** gh cannot reach GitHub: every call fails (expired auth, locked keychain, network). */
    down?: true;
    /** What `gh repo set-default` left as the default repo, for a check that asks it. */
    ghDefault?: string;
  }

  /**
   * A gh that answers the check's reads from fixture JSON through the check's
   * own -q expression (jq, as gh's gojq would), and refuses any other call.
   * An `ssh` beside it resolves the one host alias the cases use.
   */
  function gh(g: Gh): string {
    const dir = fs.mkdtempSync(path.join(tmp, 'gh-'));
    const file = (kind: string, repo: string) => path.join(dir, `${kind}-${repo.replace('/', '_')}.json`);
    // The shape gh 2.102 returns for `--json nameWithOwner,parent`: the parent
    // carries `name` and `owner.login`, never `nameWithOwner` (measured
    // 2026-10-09 on BenjaminDSmithy/gstack, a fork of garrytan/gstack).
    for (const [repo, parent] of Object.entries(g.repos ?? {})) {
      const [login, name] = (parent ?? '/').split('/');
      fs.writeFileSync(file('repo', repo.toLowerCase()), JSON.stringify({ nameWithOwner: repo, parent: parent === null ? null : { id: 'R_1', name, owner: { id: 'U_1', login } } }));
    }
    for (const [repo, nums] of Object.entries(g.prs ?? {})) fs.writeFileSync(file('prs', repo), JSON.stringify(nums.map((number) => ({ number }))));
    for (const repo of g.broken ?? []) fs.writeFileSync(file('broken', repo), '');
    fs.writeFileSync(path.join(dir, 'gh'), [
      '#!/bin/sh',
      'd=$(dirname "$0")',
      ...(g.down ? ['echo "error connecting to api.github.com" >&2; exit 1'] : []),
      'case "$*" in',
      `  "repo view --json nameWithOwner -q .nameWithOwner") ${g.ghDefault ? `echo '${g.ghDefault}'; exit 0` : 'exit 1'} ;;`,
      '  "repo view "*" --json nameWithOwner,parent -q "*) f="$d/repo-$(printf %s "$3" | tr / _).json"; q=$7 ;;',
      '  "pr list --repo "*" --head feat/x --state open --json number -q "*) r=$(printf %s "$4" | tr / _); f="$d/prs-$r.json"; q=${12}',
      '    [ -f "$d/broken-$r.json" ] && { echo "HTTP 502: Bad Gateway (https://api.github.com/graphql)" >&2; exit 1; } ;;',
      '  *) echo "unexpected gh $*" >&2; exit 3 ;;',
      'esac',
      // gh 2.102's words for a repo that does not exist or this login cannot see.
      `[ -f "$f" ] || { echo "GraphQL: Could not resolve to a Repository with the name 'owner/name'. (repository)" >&2; exit 1; }`,
      'exec jq -r "$q" "$f"',
      '',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'ssh'), [
      '#!/bin/sh',
      '[ "$1" = -G ] || { echo "unexpected ssh $*" >&2; exit 3; }',
      'echo "user git"',
      'case "$2" in github-me) echo "hostname github.com" ;; *) echo "hostname $2" ;; esac',
      'echo "port 22"',
      '',
    ].join('\n'), { mode: 0o755 });
    return dir;
  }

  function clone(name: string, remotes: Record<string, string>, config: [string, string][] = []): string {
    const dir = repo(name);
    const git = (args: string[]) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    };
    for (const [remote, url] of Object.entries(remotes)) git(['remote', 'add', remote, url]);
    for (const [key, value] of config) git(['config', key, value]);
    return dir;
  }

  const FORK = { 'me/gstack': 'garrytan/gstack' };
  // A remote gh cannot find: a contributor's deleted fork, or a private repo this login lost.
  const DEAD = 'https://github.com/someone/deleted-fork.git';
  const DEAD_SKIP = 'UPSTREAM_PR_SKIP: remote contributor (someone/deleted-fork) not found on GitHub; not checked';
  const cases: { name: string; remotes: Record<string, string>; config?: [string, string][]; gh: Gh; want: string; skip?: string[]; code: number }[] = [
    { name: 'a fork branch with no PR yet is new (a GitLab mirror is not asked)', remotes: { origin: 'https://github.com/me/gstack.git', mirror: 'git@gitlab.example.com:me/gstack.git' }, gh: { repos: { 'Me/gstack': 'Garrytan/gstack' }, prs: { 'garrytan/gstack': [] } }, want: 'UPSTREAM_PR: new garrytan/gstack', code: 0 },
    { name: 'a fork branch with an open PR is open', remotes: { origin: 'git@github.com:me/gstack.git' }, gh: { repos: FORK, prs: { 'garrytan/gstack': [3066] } }, want: 'UPSTREAM_PR: open 3066 garrytan/gstack', code: 0 },
    { name: 'two open PRs on the branch are both named', remotes: { origin: 'ssh://git@ssh.github.com:443/me/gstack' }, gh: { repos: FORK, prs: { 'garrytan/gstack': [3066, 3067] } }, want: 'UPSTREAM_PR: open 3066 3067 garrytan/gstack', code: 0 },
    { name: 'a look-alike owner is still a fork', remotes: { origin: 'https://github.com/notgarrytan/gstack/' }, gh: { repos: { 'notgarrytan/gstack': 'garrytan/gstack' }, prs: { 'garrytan/gstack': [] } }, want: 'UPSTREAM_PR: new garrytan/gstack', code: 0 },
    // No PR list here: a lookup on origin's own repo would fail the case.
    { name: 'origin is the repo itself (any case, ssh)', remotes: { origin: 'git@github.com:GarryTan/GStack.git' }, gh: { repos: { 'garrytan/gstack': null } }, want: 'UPSTREAM_PR: none', code: 0 },
    { name: 'no GitHub repo (GitLab, gh down) is none', remotes: { origin: 'git@gitlab.example.com:me/gstack.git' }, gh: { down: true }, want: 'UPSTREAM_PR: none', code: 0 },
    { name: 'a failed PR lookup stops', remotes: { origin: 'https://github.com/me/gstack.git' }, gh: { repos: FORK }, want: 'UPSTREAM_PR: lookup failed fork parent (garrytan/gstack) - STOP', code: 1 },
    { name: 'a GitHub fork with gh down stops', remotes: { origin: 'https://github.com/me/gstack.git', upstream: 'https://github.com/garrytan/gstack.git' }, gh: { down: true }, want: 'UPSTREAM_PR: lookup failed origin (me/gstack) - STOP', code: 1 },
    { name: "gh's default repo set to the fork still finds the upstream PR", remotes: { origin: 'https://github.com/me/gstack.git', upstream: 'https://github.com/garrytan/gstack.git' }, config: [['remote.origin.gh-resolved', 'base']], gh: { ghDefault: 'me/gstack', repos: FORK, prs: { 'garrytan/gstack': [3090] } }, want: 'UPSTREAM_PR: open 3090 garrytan/gstack', code: 0 },
    { name: 'a fork of a fork: an upstream remote past the parent is asked too', remotes: { origin: 'git@github.com:me/gstack.git', upstream: 'git@github.com:garrytan/gstack.git' }, gh: { repos: { 'me/gstack': 'garrytan-agents/gstack' }, prs: { 'garrytan-agents/gstack': [], 'garrytan/gstack': [3090] } }, want: 'UPSTREAM_PR: open 3090 garrytan/gstack', code: 0 },
    { name: 'an ssh host alias for github.com is GitHub', remotes: { origin: 'git@github-me:me/gstack.git' }, gh: { repos: FORK, prs: { 'garrytan/gstack': [3066] } }, want: 'UPSTREAM_PR: open 3066 garrytan/gstack', code: 0 },
    { name: 'your own repo with another GitHub remote and no PR there is none', remotes: { origin: 'https://github.com/me/gstack.git', fork: 'git@github.com:someone/gstack.git' }, gh: { repos: { 'me/gstack': null }, prs: { 'someone/gstack': [] } }, want: 'UPSTREAM_PR: none', code: 0 },
    // A failed `gh repo view` is caught by its empty answer alone: the pipe's
    // status is tr's, and no other remote's lookup fails first.
    { name: 'a GitHub fork with no other remote and gh down stops', remotes: { origin: 'https://github.com/me/gstack.git' }, gh: { down: true }, want: 'UPSTREAM_PR: lookup failed origin (me/gstack) - STOP', code: 1 },
    // GitHub logins are case-insensitive; an unlowered URL fails the name check and reads as none.
    { name: 'an uppercase owner in the URL is the same fork', remotes: { origin: 'https://github.com/Me/GStack.git' }, gh: { repos: { 'Me/GStack': 'garrytan/gstack' }, prs: { 'garrytan/gstack': [3066] } }, want: 'UPSTREAM_PR: open 3066 garrytan/gstack', code: 0 },
    // A PR on origin's own repo is /ship's to update, whichever remote names that repo.
    { name: "another remote for origin's own repo is not asked", remotes: { origin: 'https://github.com/me/gstack', 'gh-ssh': 'git@github.com:me/gstack.git' }, gh: { repos: { 'me/gstack': null }, prs: { 'me/gstack': [12] } }, want: 'UPSTREAM_PR: none', code: 0 },
    // gh cannot see a stale remote's repo, so this login cannot write a PR there: it is named and skipped, never a STOP on every run.
    { name: 'your own repo with a dead extra remote is none, and the remote is named', remotes: { origin: 'https://github.com/garrytan/gstack.git', contributor: DEAD }, gh: { repos: { 'garrytan/gstack': null } }, want: 'UPSTREAM_PR: none', skip: [DEAD_SKIP], code: 0 },
    { name: 'a fork with a dead extra remote is still new on its parent', remotes: { origin: 'https://github.com/me/gstack.git', upstream: 'https://github.com/garrytan/gstack.git', contributor: DEAD }, gh: { repos: FORK, prs: { 'garrytan/gstack': [] } }, want: 'UPSTREAM_PR: new garrytan/gstack', skip: [DEAD_SKIP], code: 0 },
    { name: 'a fork with a dead extra remote still finds the open PR', remotes: { origin: 'git@github.com:me/gstack.git', contributor: DEAD }, gh: { repos: FORK, prs: { 'garrytan/gstack': [3066] } }, want: 'UPSTREAM_PR: open 3066 garrytan/gstack', skip: [DEAD_SKIP], code: 0 },
    // Any other failure on an extra remote still stops, and names the remote to fix or remove.
    { name: 'an extra remote whose lookup errors stops and is named', remotes: { origin: 'https://github.com/me/gstack.git', contributor: 'https://github.com/someone/gstack.git' }, gh: { repos: FORK, prs: { 'garrytan/gstack': [] }, broken: ['someone/gstack'] }, want: 'UPSTREAM_PR: lookup failed remote contributor (someone/gstack) - STOP', code: 1 },
  ];

  for (const [si, shell] of SHELLS.entries()) {
    for (const [i, c] of cases.entries()) {
      test(`under ${shell}: ${c.name}`, () => {
        const cwd = clone(`up-${si}-${i}`, c.remotes, c.config);
        const r = run(shell, CHECK, cwd, {}, gh(c.gh));
        expect(r.out).not.toContain('unexpected');
        const lines = r.out.split('\n');
        expect(lines.filter((l) => l.startsWith('UPSTREAM_PR:')), r.out).toEqual([c.want]);
        expect(lines.filter((l) => l.startsWith('UPSTREAM_PR_SKIP:')), r.out).toEqual(c.skip ?? []);
        expect(r.code).toBe(c.code);
      });
    }
  }

  test('the check runs before the push, and neither handoff writes to the upstream PR', () => {
    expectOrdered(STEP_17, ['UPSTREAM_PR: none', '**Credential pre-push guard', 'git push -u origin'], 'ship Step 17');
    const prose = STEP_17.replace(/([^\n])\n(?=[^\n])/g, '$1 ');
    expectMentions(prose, [
      // The upstream comes from origin, whatever `gh repo set-default` chose.
      ['upstream', "origin's url", 'parent', "never from gh's default"],
      // An open PR: no push, no body or title edit.
      ['open', 'never writes'],
      ['do not push', 'skip steps 18-19', 'screenshot'],
      ['gstack-pr-watch poll', 'exit 0', 'before', 'push'],
      ['/pr-prep body'],
      // A new one: never opened by ship.
      ['new', 'skip steps 18-19', '/pr-prep open'],
      ['lookup failed', 'stop'],
      // A remote gh cannot find is skipped, never silently: the owner hears of it.
      ['unchecked', 'report', 'remove the remote'],
    ], 'ship Step 17');
    // Step 19, if reached anyway, says the same.
    expectMentions(PR_BODY_MD.replace(/([^\n])\n(?=[^\n])/g, '$1 '), [['upstream_pr', 'never reach', '/pr-prep']], 'ship Step 19');
  });
});

// Step 10 runs before Step 17, and for a fork branch whose open PR is on
// someone else's repo, review/greptile-triage.md resolves REPO and PR_NUMBER
// to that upstream PR: the "already fixed" reply posted there with "no
// AskUserQuestion needed", and a Fix-now answer posted a Fix reply. D2: every
// write to an open upstream PR needs the owner's yes in the same turn.
describe('/ship Step 10: Greptile triage on a fork PR to someone else\'s repo', () => {
  test('the upstream check runs before the dispatch and any reply; a fork PR is report-only', () => {
    expectOrdered(GREPTILE_MD, ['PR: exists', 'Upstream PR check', 'Dispatch a subagent', 'Reply using'], 'ship Step 10');
    // Lines joined, bullet indents dropped; a blank line still ends a sentence.
    const prose = GREPTILE_MD.replace(/([^\n])\n[ \t]*(?=[^\n])/g, '$1 ');
    expectMentions(prose, [
      ['new <repo>', 'open <number> <repo>', "someone else's repo"],
      ['report-only', 'print each classification', 'no reply'],
      // A reply there waits for a same-turn yes under a registered id.
      ['reply', 'only after askuserquestion', '<gstack-qid:ship-upstream-pr-reply>', 'turn'],
      ['one yes covers one reply'],
      // Nothing else in the step stands in for that yes.
      ['fix-now', 'false-positive', 'no askuserquestion needed', 'never approve'],
      ['already fixed', 'after `none`', 'no askuserquestion needed'],
      ['lookup failed', 'do not dispatch'],
      ['step 17 stops on the same check'],
    ], 'ship Step 10');
    // The fix loop's return finishes saved replies; on a fork PR each still waits for its own yes.
    expectMentions(between(prose, '**After triage:**', '---'), [['saved replies', 'after `new` or `open`', 'own yes']], 'ship Step 10 after triage');
  });

  test('that reply question is a registered one-way door: a stored preference never answers it', () => {
    expect(getQuestion('ship-upstream-pr-reply')).toMatchObject({ skill: 'ship', door_type: 'one-way' });
  });
});
