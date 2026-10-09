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
// Root searches any directory, so a locked one hides nothing from it.
const IS_ROOT = process.getuid?.() === 0;
const TOOL_DIRS = [...new Set(['git', 'jq'].map((t) => Bun.which(t)).filter((p): p is string => !!p).map((p) => path.dirname(p)))];

let tmp: string;
/** Dirs a case locked; searchable again before the cleanup walks them. */
const locked: string[] = [];
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-pr-prep-gate-')));
});
afterAll(() => {
  for (const d of locked) fs.chmodSync(d, 0o755);
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
    /** Repos gh can see, as GitHub spells them (an Enterprise one as host/owner/name), each with its fork parent (null: not a fork). */
    repos?: Record<string, string | null>;
    /** The nameWithOwner gh answers for a repo it knows by a newer name (a rename redirects); by default the key's owner/name. */
    renamed?: Record<string, string>;
    /** GitHub Enterprise hosts gh has a login for. */
    hosts?: string[];
    /**
     * A gh from before `auth status --json` (2.81.0), in the words of its
     * release line: 2.40-2.80 (multi-account) or one before 2.40. The check
     * reads those words, so each line's are copied from cli/cli's
     * pkg/cmd/auth/status/status.go at v2.80.0 and v2.39.2.
     */
    old?: '2.80' | '2.39';
    /** A plain `auth status` that words a missing login in a way the check does not know (a later gh's rewording). */
    reworded?: true;
    /** No gh on PATH at all. */
    absent?: true;
    /**
     * gh is on PATH but does not run: every call fails, `--version` included
     * (a mise or asdf shim with no version set, a binary for another CPU; real
     * gh 2.102 with an unreadable config.yml or hosts.yml fails `--version` too).
     */
    crashes?: true;
    /** The hosts gh's hosts.yml (in GH_CONFIG_DIR) names; 'unreadable': there, mode 000. Left out: no file. */
    hostsYml?: string[] | 'unreadable';
    /** A dir locked once hosts.yml is written: gh's config dir, or ~/.config above it. */
    lock?: 'cfg' | 'home/.config';
    /** The locked dir's mode, by default 0o000; 0o644 can be read but not searched, 0o311 searched but not read. */
    lockMode?: number;
    /** Open PR numbers whose head branch is feat/x, per lowercase repo; a repo left out is one gh cannot find. */
    prs?: Record<string, number[]>;
    /** Lowercase repos whose PR lookup fails with a server error (gh can see them, but not now). */
    broken?: string[];
    /** gh cannot reach GitHub: every call fails (expired auth, locked keychain, network). */
    down?: true;
    /**
     * The URL `gh repo view` prints with no repo named: gh's default repo, the
     * one the bare gh commands in Steps 10, 18 and 19 act on. null: that
     * lookup fails. Left out, the check must not ask (the stub refuses).
     */
    ghDefault?: string | null;
    /** The URL `gh repo view <repo>` prints for a repo named on the command line (GH_REPO's); a repo left out is one gh cannot find. */
    urls?: Record<string, string>;
  }

  /**
   * A gh that answers the check's reads from fixture JSON through the check's
   * own -q expression (jq, as gh's gojq would), and refuses any other call.
   * An `ssh` beside it resolves the one host alias the cases use.
   */
  function gh(g: Gh): string {
    const dir = fs.mkdtempSync(path.join(tmp, 'gh-'));
    const file = (kind: string, repo: string) => path.join(dir, `${kind}-${repo.replaceAll('/', '_')}.json`);
    // The shape gh 2.102 returns for `--json nameWithOwner,parent`: the parent
    // carries `name` and `owner.login`, never `nameWithOwner` (measured
    // 2026-10-09 on BenjaminDSmithy/gstack, a fork of garrytan/gstack), and
    // nameWithOwner never carries an Enterprise host.
    for (const [repo, parent] of Object.entries(g.repos ?? {})) {
      const [login, name] = (parent ?? '/').split('/');
      fs.writeFileSync(file('repo', repo.toLowerCase()), JSON.stringify({ nameWithOwner: g.renamed?.[repo] ?? repo.split('/').slice(-2).join('/'), parent: parent === null ? null : { id: 'R_1', name, owner: { id: 'U_1', login } } }));
    }
    for (const host of g.hosts ?? []) fs.writeFileSync(path.join(dir, `host-${host}`), '');
    for (const [repo, nums] of Object.entries(g.prs ?? {})) fs.writeFileSync(file('prs', repo), JSON.stringify(nums.map((number) => ({ number }))));
    for (const repo of g.broken ?? []) fs.writeFileSync(file('broken', repo), '');
    for (const [repo, url] of Object.entries(g.urls ?? {})) fs.writeFileSync(path.join(dir, `url-${repo.replaceAll('/', '_')}`), `${url}\n`);
    fs.writeFileSync(path.join(dir, 'gh'), [
      '#!/bin/sh',
      'd=$(dirname "$0")',
      // `--json hosts` lists every host gh has a login for and exits 0 even
      // when that login fails (gh 2.102); plain `auth status` fails then.
      'case "$*" in',
      // Answered offline, so before the network-down exit below.
      `  --version) echo "gh version ${g.old ?? '2.102'}.0 (stub)"; exit 0 ;;`,
      `  "auth status --hostname "*" --json hosts --jq .hosts|length") ${g.old ? 'echo "unknown flag: --json" >&2; exit 1' : '[ -f "$d/host-$4" ] && echo 1 || echo 0; exit 0'} ;;`,
      // Plain `auth status` exits 1 both when the host has no login and when
      // its login cannot answer; only the words tell them apart.
      '  "auth status --hostname "*) h=$4',
      `    [ -f "$d/host-$h" ] || { echo ${g.reworded ? '"No session for $h"' : g.old === '2.39' ? '"Hostname \\"$h\\" not found among authenticated GitHub hosts"' : '"You are not logged into any accounts on $h"'} >&2; exit 1; }`,
      '    echo "$h"',
      `    [ -f "$d/down" ] && { echo ${g.old === '2.39' ? '"  X $h: authentication failed"' : '"  X Failed to log in to $h account me (keyring)"'}; exit 1; }`,
      `    echo ${g.old === '2.39' ? '"  ✓ Logged in to $h as me (oauth_token)"' : '"  ✓ Logged in to $h account me (keyring)"'}; exit 0 ;;`,
      'esac',
      ...(g.down ? ['echo "error connecting to api.github.com" >&2; exit 1'] : []),
      'case "$*" in',
      ...(g.ghDefault === undefined ? [] : [`  "repo view --json url -q .url") ${g.ghDefault === null ? 'echo "HTTP 502: Bad Gateway (https://api.github.com/graphql)" >&2; exit 1' : `echo '${g.ghDefault}'; exit 0`} ;;`]),
      `  "repo view "*" --json url -q .url") f="$d/url-$(printf %s "$3" | tr / _)"; [ -f "$f" ] && { cat "$f"; exit 0; }; echo "GraphQL: Could not resolve to a Repository with the name '$3'. (repository)" >&2; exit 1 ;;`,
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
      'case "$2" in github-me) echo "hostname github.com" ;; work-ghe) echo "hostname ghe.acme.test" ;; *) echo "hostname $2" ;; esac',
      'echo "port 22"',
      '',
    ].join('\n'), { mode: 0o755 });
    if (g.down) fs.writeFileSync(path.join(dir, 'down'), '');
    if (g.absent) {
      // gh sits beside git in Homebrew, so the check's PATH gets only this
      // dir and the system dirs, and git is reached through a wrapper.
      fs.rmSync(path.join(dir, 'gh'));
      fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\nexec '${Bun.which('git')}' "$@"\n`, { mode: 0o755 });
    }
    // mise 2026's words for a shim with no version selected.
    if (g.crashes) fs.writeFileSync(path.join(dir, 'gh'), '#!/bin/sh\necho "mise ERROR No version is set for shim: gh" >&2\nexit 1\n', { mode: 0o755 });
    // GH_CONFIG_DIR (run() points it here); the layout gh 2.102 writes: one top-level key per host.
    // The same dir is XDG_CONFIG_HOME/gh under xdg and ~/.config/gh under home.
    fs.mkdirSync(path.join(dir, 'cfg'));
    fs.mkdirSync(path.join(dir, 'xdg'));
    fs.symlinkSync('../cfg', path.join(dir, 'xdg', 'gh'));
    fs.mkdirSync(path.join(dir, 'home', '.config'), { recursive: true });
    fs.symlinkSync('../../cfg', path.join(dir, 'home', '.config', 'gh'));
    if (g.hostsYml) {
      const yml = path.join(dir, 'cfg', 'hosts.yml');
      fs.writeFileSync(yml, (g.hostsYml === 'unreadable' ? ['github.com'] : g.hostsYml).map((h) => `${h}:\n    git_protocol: https\n    users:\n        me:\n    user: me\n`).join(''));
      if (g.hostsYml === 'unreadable') fs.chmodSync(yml, 0o000);
    }
    if (g.lock) {
      locked.push(path.join(dir, g.lock));
      fs.chmodSync(path.join(dir, g.lock), g.lockMode ?? 0o000);
    }
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
  const noteFor = (host: string) => `UPSTREAM_PR_NOTE: gh does not run; ${host} counts only if its hosts.yml or GH_HOST names it`;
  /** `env` values may name the row's stub dir as {stub}. */
  const cases: { name: string; remotes: Record<string, string>; config?: [string, string][]; env?: Record<string, string>; gh: Gh; want: string; skip?: string[]; dflt?: string[]; note?: string[]; code: number }[] = [
    { name: 'a fork branch with no PR yet is new (a GitLab mirror is not asked)', remotes: { origin: 'https://github.com/me/gstack.git', mirror: 'git@gitlab.example.com:me/gstack.git' }, gh: { repos: { 'Me/gstack': 'Garrytan/gstack' }, prs: { 'garrytan/gstack': [] } }, want: 'UPSTREAM_PR: new garrytan/gstack', code: 0 },
    { name: 'a fork branch with an open PR is open', remotes: { origin: 'git@github.com:me/gstack.git' }, gh: { repos: FORK, prs: { 'garrytan/gstack': [3066] } }, want: 'UPSTREAM_PR: open 3066 garrytan/gstack', code: 0 },
    { name: 'two open PRs on the branch are both named', remotes: { origin: 'ssh://git@ssh.github.com:443/me/gstack' }, gh: { repos: FORK, prs: { 'garrytan/gstack': [3066, 3067] } }, want: 'UPSTREAM_PR: open 3066 3067 garrytan/gstack', code: 0 },
    { name: 'a look-alike owner is still a fork', remotes: { origin: 'https://github.com/notgarrytan/gstack/' }, gh: { repos: { 'notgarrytan/gstack': 'garrytan/gstack' }, prs: { 'garrytan/gstack': [] } }, want: 'UPSTREAM_PR: new garrytan/gstack', code: 0 },
    // No PR list here: a lookup on origin's own repo would fail the case.
    { name: 'origin is the repo itself (any case, ssh)', remotes: { origin: 'git@github.com:GarryTan/GStack.git' }, gh: { repos: { 'garrytan/gstack': null }, ghDefault: 'https://github.com/garrytan/gstack' }, want: 'UPSTREAM_PR: none', code: 0 },
    { name: 'no GitHub repo (GitLab, gh down) is none', remotes: { origin: 'git@gitlab.example.com:me/gstack.git' }, gh: { down: true }, want: 'UPSTREAM_PR: none', code: 0 },
    { name: 'a failed PR lookup stops', remotes: { origin: 'https://github.com/me/gstack.git' }, gh: { repos: FORK }, want: 'UPSTREAM_PR: lookup failed fork parent (garrytan/gstack) - STOP', code: 1 },
    { name: 'a GitHub fork with gh down stops', remotes: { origin: 'https://github.com/me/gstack.git', upstream: 'https://github.com/garrytan/gstack.git' }, gh: { down: true }, want: 'UPSTREAM_PR: lookup failed origin (me/gstack) - STOP', code: 1 },
    { name: "gh's default repo set to the fork still finds the upstream PR", remotes: { origin: 'https://github.com/me/gstack.git', upstream: 'https://github.com/garrytan/gstack.git' }, config: [['remote.origin.gh-resolved', 'base']], gh: { ghDefault: 'https://github.com/me/gstack', repos: FORK, prs: { 'garrytan/gstack': [3090] } }, want: 'UPSTREAM_PR: open 3090 garrytan/gstack', code: 0 },
    { name: 'a fork of a fork: an upstream remote past the parent is asked too', remotes: { origin: 'git@github.com:me/gstack.git', upstream: 'git@github.com:garrytan/gstack.git' }, gh: { repos: { 'me/gstack': 'garrytan-agents/gstack' }, prs: { 'garrytan-agents/gstack': [], 'garrytan/gstack': [3090] } }, want: 'UPSTREAM_PR: open 3090 garrytan/gstack', code: 0 },
    { name: 'an ssh host alias for github.com is GitHub', remotes: { origin: 'git@github-me:me/gstack.git' }, gh: { repos: FORK, prs: { 'garrytan/gstack': [3066] } }, want: 'UPSTREAM_PR: open 3066 garrytan/gstack', code: 0 },
    { name: 'your own repo with another GitHub remote and no PR there is none', remotes: { origin: 'https://github.com/me/gstack.git', fork: 'git@github.com:someone/gstack.git' }, gh: { repos: { 'me/gstack': null }, prs: { 'someone/gstack': [] }, ghDefault: 'https://github.com/me/gstack' }, want: 'UPSTREAM_PR: none', code: 0 },
    // A failed `gh repo view` is caught by its empty answer alone: the pipe's
    // status is tr's, and no other remote's lookup fails first.
    { name: 'a GitHub fork with no other remote and gh down stops', remotes: { origin: 'https://github.com/me/gstack.git' }, gh: { down: true }, want: 'UPSTREAM_PR: lookup failed origin (me/gstack) - STOP', code: 1 },
    // GitHub logins are case-insensitive; an unlowered URL fails the name check and reads as none.
    { name: 'an uppercase owner in the URL is the same fork', remotes: { origin: 'https://github.com/Me/GStack.git' }, gh: { repos: { 'Me/GStack': 'garrytan/gstack' }, prs: { 'garrytan/gstack': [3066] } }, want: 'UPSTREAM_PR: open 3066 garrytan/gstack', code: 0 },
    // A PR on origin's own repo is /ship's to update, whichever remote names that repo.
    { name: "another remote for origin's own repo is not asked", remotes: { origin: 'https://github.com/me/gstack', 'gh-ssh': 'git@github.com:me/gstack.git' }, gh: { repos: { 'me/gstack': null }, prs: { 'me/gstack': [12] }, ghDefault: 'https://github.com/me/gstack' }, want: 'UPSTREAM_PR: none', code: 0 },
    // gh cannot see a stale remote's repo, so this login cannot write a PR there: it is named and skipped, never a STOP on every run.
    { name: 'your own repo with a dead extra remote is none, and the remote is named', remotes: { origin: 'https://github.com/garrytan/gstack.git', contributor: DEAD }, gh: { repos: { 'garrytan/gstack': null }, ghDefault: 'https://github.com/garrytan/gstack' }, want: 'UPSTREAM_PR: none', skip: [DEAD_SKIP], code: 0 },
    { name: 'a fork with a dead extra remote is still new on its parent', remotes: { origin: 'https://github.com/me/gstack.git', upstream: 'https://github.com/garrytan/gstack.git', contributor: DEAD }, gh: { repos: FORK, prs: { 'garrytan/gstack': [] } }, want: 'UPSTREAM_PR: new garrytan/gstack', skip: [DEAD_SKIP], code: 0 },
    { name: 'a fork with a dead extra remote still finds the open PR', remotes: { origin: 'git@github.com:me/gstack.git', contributor: DEAD }, gh: { repos: FORK, prs: { 'garrytan/gstack': [3066] } }, want: 'UPSTREAM_PR: open 3066 garrytan/gstack', skip: [DEAD_SKIP], code: 0 },
    // GitHub Enterprise counts when gh has a login for its host; its repos carry the host, so gh asks the right server.
    { name: 'an Enterprise fork with an open upstream PR is open', remotes: { origin: 'https://ghe.acme.test/me/proj.git', upstream: 'https://ghe.acme.test/acme/proj.git' }, gh: { hosts: ['ghe.acme.test'], repos: { 'ghe.acme.test/me/proj': 'acme/proj' }, prs: { 'ghe.acme.test/acme/proj': [3066] } }, want: 'UPSTREAM_PR: open 3066 ghe.acme.test/acme/proj', code: 0 },
    { name: 'an ssh alias for an Enterprise host is a new fork PR there', remotes: { origin: 'git@work-ghe:me/proj.git' }, gh: { hosts: ['ghe.acme.test'], repos: { 'ghe.acme.test/me/proj': 'acme/proj' }, prs: { 'ghe.acme.test/acme/proj': [] } }, want: 'UPSTREAM_PR: new ghe.acme.test/acme/proj', code: 0 },
    { name: 'a gh without auth status --json still finds an Enterprise fork', remotes: { origin: 'https://ghe.acme.test/me/proj.git' }, gh: { old: '2.80', hosts: ['ghe.acme.test'], repos: { 'ghe.acme.test/me/proj': 'acme/proj' }, prs: { 'ghe.acme.test/acme/proj': [3066] } }, want: 'UPSTREAM_PR: open 3066 ghe.acme.test/acme/proj', code: 0 },
    { name: 'an Enterprise fork with gh down there stops', remotes: { origin: 'git@ghe.acme.test:me/proj.git' }, gh: { hosts: ['ghe.acme.test'], down: true }, want: 'UPSTREAM_PR: lookup failed origin (ghe.acme.test/me/proj) - STOP', code: 1 },
    // gh answers a renamed repo with its new name; a PR on it is still origin's own, whichever remote names it.
    { name: "a renamed Enterprise origin's new name is still its own repo", remotes: { origin: 'https://ghe.acme.test/me/old.git', other: 'https://ghe.acme.test/me/new.git' }, gh: { hosts: ['ghe.acme.test'], repos: { 'ghe.acme.test/me/old': null }, renamed: { 'ghe.acme.test/me/old': 'me/new' }, prs: { 'ghe.acme.test/me/new': [12] }, ghDefault: 'https://ghe.acme.test/me/new' }, want: 'UPSTREAM_PR: none', code: 0 },
    // A gh older than 2.81 fails plain `auth status` for a login that cannot answer too: that host is still GitHub, and stops.
    { name: 'a gh 2.40-2.80 whose Enterprise login cannot answer stops', remotes: { origin: 'https://ghe.acme.test/me/proj.git' }, gh: { old: '2.80', hosts: ['ghe.acme.test'], down: true }, want: 'UPSTREAM_PR: lookup failed origin (ghe.acme.test/me/proj) - STOP', code: 1 },
    { name: 'a gh before 2.40 whose Enterprise login cannot answer stops', remotes: { origin: 'git@ghe.acme.test:me/proj.git' }, gh: { old: '2.39', hosts: ['ghe.acme.test'], down: true }, want: 'UPSTREAM_PR: lookup failed origin (ghe.acme.test/me/proj) - STOP', code: 1 },
    // Only gh's own words for a missing login make a host not GitHub, so a GitLab origin stays none on every gh.
    { name: 'a gh 2.40-2.80 with no login for the host is not GitHub', remotes: { origin: 'https://gitlab.example.com/me/proj.git' }, gh: { old: '2.80', hosts: ['ghe.acme.test'] }, want: 'UPSTREAM_PR: none', code: 0 },
    { name: 'a gh before 2.40 with no login for the host is not GitHub', remotes: { origin: 'git@gitlab.example.com:me/proj.git' }, gh: { old: '2.39', hosts: ['ghe.acme.test'] }, want: 'UPSTREAM_PR: none', code: 0 },
    { name: 'a gh with --json is read from its JSON, not its words', remotes: { origin: 'https://gitlab.example.com/me/proj.git' }, gh: { reworded: true, hosts: ['ghe.acme.test'] }, want: 'UPSTREAM_PR: none', code: 0 },
    { name: 'with no gh installed a GitLab origin is none', remotes: { origin: 'https://gitlab.example.com/me/proj.git' }, gh: { absent: true }, want: 'UPSTREAM_PR: none', code: 0 },
    // A gh that does not run cannot say which hosts it has a login for, so its
    // hosts.yml (or GH_HOST) does: a GitLab origin is not stopped by gh's health,
    // and an Enterprise origin gh had a login for still stops.
    { name: 'a gh that does not run leaves a GitLab origin none, and says so', remotes: { origin: 'git@gitlab.example.com:me/proj.git' }, gh: { crashes: true, hostsYml: ['github.com'] }, want: 'UPSTREAM_PR: none', note: [noteFor('gitlab.example.com')], code: 0 },
    { name: "a host is named by its own hosts.yml key, not by another host's that contains it", remotes: { origin: 'https://acme.test/me/proj.git' }, gh: { crashes: true, hostsYml: ['github.com', 'ghe.acme.test'] }, want: 'UPSTREAM_PR: none', note: [noteFor('acme.test')], code: 0 },
    { name: 'a gh that does not run and has no hosts.yml leaves a GitLab origin none', remotes: { origin: 'https://gitlab.example.com/me/proj.git' }, gh: { crashes: true }, want: 'UPSTREAM_PR: none', note: [noteFor('gitlab.example.com')], code: 0 },
    { name: 'a gh that does not run still stops an Enterprise origin its hosts.yml names', remotes: { origin: 'https://ghe.acme.test/me/proj.git' }, gh: { crashes: true, hostsYml: ['github.com', 'ghe.acme.test'] }, want: 'UPSTREAM_PR: lookup failed origin (ghe.acme.test/me/proj) - STOP', note: [noteFor('ghe.acme.test')], code: 1 },
    { name: 'a gh that does not run reads hosts.yml under XDG_CONFIG_HOME when GH_CONFIG_DIR is empty', remotes: { origin: 'https://ghe.acme.test/me/proj.git' }, env: { GH_CONFIG_DIR: '', XDG_CONFIG_HOME: '{stub}/xdg' }, gh: { crashes: true, hostsYml: ['github.com', 'ghe.acme.test'] }, want: 'UPSTREAM_PR: lookup failed origin (ghe.acme.test/me/proj) - STOP', note: [noteFor('ghe.acme.test')], code: 1 },
    // The path everyone without either variable has; run() sets GH_CONFIG_DIR for every other row.
    { name: 'a gh that does not run reads hosts.yml under ~/.config/gh when neither GH_CONFIG_DIR nor XDG_CONFIG_HOME is set', remotes: { origin: 'https://ghe.acme.test/me/proj.git' }, env: { GH_CONFIG_DIR: '', XDG_CONFIG_HOME: '', HOME: '{stub}/home' }, gh: { crashes: true, hostsYml: ['github.com', 'ghe.acme.test'] }, want: 'UPSTREAM_PR: lookup failed origin (ghe.acme.test/me/proj) - STOP', note: [noteFor('ghe.acme.test')], code: 1 },
    { name: 'a gh that does not run still stops an Enterprise origin GH_HOST names', remotes: { origin: 'git@work-ghe:me/proj.git' }, env: { GH_HOST: 'GHE.Acme.test' }, gh: { crashes: true, hostsYml: ['github.com'] }, want: 'UPSTREAM_PR: lookup failed origin (ghe.acme.test/me/proj) - STOP', note: [noteFor('ghe.acme.test')], code: 1 },
    // GH_HOST counts only the host it names: exported for an Enterprise login, it does not stop a GitLab origin.
    { name: 'a GH_HOST naming another host leaves a GitLab origin none', remotes: { origin: 'git@gitlab.example.com:me/proj.git' }, env: { GH_HOST: 'ghe.acme.test' }, gh: { crashes: true, hostsYml: ['github.com'] }, want: 'UPSTREAM_PR: none', note: [noteFor('gitlab.example.com')], code: 0 },
    { name: 'a gh whose hosts.yml cannot be read stops even a GitLab origin', remotes: { origin: 'https://gitlab.example.com/me/proj.git' }, gh: { crashes: true, hostsYml: 'unreadable' }, want: 'UPSTREAM_PR: lookup failed origin (gitlab.example.com/me/proj) - STOP', note: [noteFor('gitlab.example.com')], code: 1 },
    // A hosts.yml behind a dir this user cannot search is one gh cannot read
    // either (gh 2.102 fails `--version` there), not a missing one: it stops.
    // Only a missing one under a dir that can be searched means no login.
    { name: 'a gh whose config dir cannot be searched still stops an Enterprise origin', remotes: { origin: 'https://ghe.acme.test/me/proj.git' }, gh: { crashes: true, hostsYml: ['github.com', 'ghe.acme.test'], lock: 'cfg' }, want: 'UPSTREAM_PR: lookup failed origin (ghe.acme.test/me/proj) - STOP', note: [noteFor('ghe.acme.test')], code: 1 },
    { name: 'a gh whose ~/.config cannot be searched still stops an Enterprise origin', remotes: { origin: 'https://ghe.acme.test/me/proj.git' }, env: { GH_CONFIG_DIR: '', XDG_CONFIG_HOME: '', HOME: '{stub}/home' }, gh: { crashes: true, hostsYml: ['github.com', 'ghe.acme.test'], lock: 'home/.config' }, want: 'UPSTREAM_PR: lookup failed origin (ghe.acme.test/me/proj) - STOP', note: [noteFor('ghe.acme.test')], code: 1 },
    // Search permission decides, not read: a dir that can be read but not
    // searched still hides hosts.yml (gh 2.102 fails `--version` under a
    // mode-644 config dir), and one that can be searched but not read still
    // shows that a missing file is missing.
    { name: 'a gh whose config dir can be read but not searched still stops an Enterprise origin', remotes: { origin: 'https://ghe.acme.test/me/proj.git' }, gh: { crashes: true, hostsYml: ['github.com', 'ghe.acme.test'], lock: 'cfg', lockMode: 0o644 }, want: 'UPSTREAM_PR: lookup failed origin (ghe.acme.test/me/proj) - STOP', note: [noteFor('ghe.acme.test')], code: 1 },
    { name: 'a gh whose config dir can be searched but not read, with no hosts.yml, leaves a GitLab origin none', remotes: { origin: 'https://gitlab.example.com/me/proj.git' }, gh: { crashes: true, lock: 'cfg', lockMode: 0o311 }, want: 'UPSTREAM_PR: none', note: [noteFor('gitlab.example.com')], code: 0 },
    { name: 'a gh whose config dir does not exist leaves a GitLab origin none', remotes: { origin: 'https://gitlab.example.com/me/proj.git' }, env: { GH_CONFIG_DIR: '{stub}/gone/gh' }, gh: { crashes: true }, want: 'UPSTREAM_PR: none', note: [noteFor('gitlab.example.com')], code: 0 },
    { name: 'a relative config dir that does not exist is looked for from the working dir, and the search ends', remotes: { origin: 'https://gitlab.example.com/me/proj.git' }, env: { GH_CONFIG_DIR: 'gone/gh' }, gh: { crashes: true }, want: 'UPSTREAM_PR: none', note: [noteFor('gitlab.example.com')], code: 0 },
    { name: 'a host gh has no login for is not GitHub', remotes: { origin: 'https://ghe.other.test/me/proj.git' }, gh: { hosts: ['ghe.acme.test'], repos: { 'ghe.other.test/me/proj': 'acme/proj' } }, want: 'UPSTREAM_PR: none', code: 0 },
    // A PR's head lives on its base's host, so origin's branch can head a PR only on origin's host: a remote on another host is not asked.
    { name: 'an Enterprise remote that cannot answer does not stop a github.com fork', remotes: { origin: 'https://github.com/me/gstack.git', work: 'https://ghe.acme.test/x/y.git' }, gh: { hosts: ['ghe.acme.test'], repos: FORK, prs: { 'garrytan/gstack': [] }, broken: ['ghe.acme.test/x/y'] }, want: 'UPSTREAM_PR: new garrytan/gstack', code: 0 },
    { name: "a github.com PR on a same-named branch is not an Enterprise fork's", remotes: { origin: 'https://ghe.acme.test/me/proj.git', oss: 'https://github.com/garrytan/gstack.git' }, gh: { hosts: ['ghe.acme.test'], repos: { 'ghe.acme.test/me/proj': 'acme/proj' }, prs: { 'ghe.acme.test/acme/proj': [], 'garrytan/gstack': [3066] } }, want: 'UPSTREAM_PR: new ghe.acme.test/acme/proj', code: 0 },
    { name: "another Enterprise host's PR is not this Enterprise fork's", remotes: { origin: 'https://ghe.acme.test/me/proj.git', mirror: 'https://ghe.other.test/acme/proj.git' }, gh: { hosts: ['ghe.acme.test', 'ghe.other.test'], repos: { 'ghe.acme.test/me/proj': 'acme/proj' }, prs: { 'ghe.acme.test/acme/proj': [], 'ghe.other.test/acme/proj': [7] } }, want: 'UPSTREAM_PR: new ghe.acme.test/acme/proj', code: 0 },
    { name: 'an extra remote on the Enterprise host whose lookup errors stops and is named', remotes: { origin: 'https://ghe.acme.test/me/proj.git', other: 'git@work-ghe:someone/proj.git' }, gh: { hosts: ['ghe.acme.test'], repos: { 'ghe.acme.test/me/proj': 'acme/proj' }, prs: { 'ghe.acme.test/acme/proj': [] }, broken: ['ghe.acme.test/someone/proj'] }, want: 'UPSTREAM_PR: lookup failed remote other (ghe.acme.test/someone/proj) - STOP', code: 1 },
    // Steps 10, 18 and 19 run bare gh, which acts on gh's default repo: without a
    // set-default, gh 2.102 in a shell that cannot prompt takes the first remote
    // ordered upstream, github, origin, whatever its host, once it has logins for
    // both (context/remote.go, factory/remote_resolver.go). `none` lets those steps
    // write, so it needs that repo to be origin's own; asked only when origin is not a fork.
    { name: "your own github.com repo with a failing Enterprise remote is none when gh's default is origin", remotes: { origin: 'https://github.com/me/gstack.git', work: 'https://ghe.acme.test/x/y.git' }, gh: { hosts: ['ghe.acme.test'], repos: { 'me/gstack': null }, broken: ['ghe.acme.test/x/y'], ghDefault: 'https://github.com/me/gstack' }, want: 'UPSTREAM_PR: none', code: 0 },
    { name: "an upstream remote on github.com is gh's default for an Enterprise origin, and its open PR is found", remotes: { origin: 'https://ghe.acme.test/me/proj.git', upstream: 'https://github.com/garrytan/gstack.git' }, gh: { hosts: ['ghe.acme.test'], repos: { 'ghe.acme.test/me/proj': null }, prs: { 'garrytan/gstack': [3066] }, ghDefault: 'https://github.com/garrytan/gstack' }, want: 'UPSTREAM_PR: open 3066 garrytan/gstack', dflt: ["UPSTREAM_PR_DEFAULT: gh's default repo is garrytan/gstack, not origin's ghe.acme.test/me/proj"], code: 0 },
    { name: "an upstream remote on an Enterprise host is gh's default for a github.com origin, and its open PR is found", remotes: { origin: 'https://github.com/me/gstack.git', upstream: 'https://ghe.acme.test/acme/proj.git' }, gh: { hosts: ['ghe.acme.test'], repos: { 'me/gstack': null }, prs: { 'ghe.acme.test/acme/proj': [7] }, ghDefault: 'https://ghe.acme.test/acme/proj' }, want: 'UPSTREAM_PR: open 7 ghe.acme.test/acme/proj', dflt: ["UPSTREAM_PR_DEFAULT: gh's default repo is ghe.acme.test/acme/proj, not origin's me/gstack"], code: 0 },
    { name: "gh's default on another repo with no PR is new, so Steps 18-19 never publish there", remotes: { origin: 'https://github.com/me/gstack.git', upstream: 'git@github.com:someone/gstack.git' }, gh: { repos: { 'me/gstack': null }, prs: { 'someone/gstack': [] }, ghDefault: 'https://github.com/someone/gstack' }, want: 'UPSTREAM_PR: new someone/gstack', dflt: ["UPSTREAM_PR_DEFAULT: gh's default repo is someone/gstack, not origin's me/gstack"], code: 0 },
    { name: "a gh default that cannot be read stops", remotes: { origin: 'https://github.com/me/gstack.git' }, gh: { repos: { 'me/gstack': null }, ghDefault: null }, want: "UPSTREAM_PR: lookup failed gh's default repo - STOP", code: 1 },
    { name: "a gh default whose PR lookup errors stops and is named", remotes: { origin: 'https://github.com/me/gstack.git', upstream: 'https://ghe.acme.test/acme/proj.git' }, gh: { hosts: ['ghe.acme.test'], repos: { 'me/gstack': null }, broken: ['ghe.acme.test/acme/proj'], ghDefault: 'https://ghe.acme.test/acme/proj' }, want: "UPSTREAM_PR: lookup failed gh's default repo (ghe.acme.test/acme/proj) - STOP", dflt: ["UPSTREAM_PR_DEFAULT: gh's default repo is ghe.acme.test/acme/proj, not origin's me/gstack"], code: 1 },
    // GH_REPO is gh's default for `gh pr` and `gh api` (cmdutil.EnableRepoOverride,
    // api.go), which Steps 10, 18 and 19 run, but not for `gh repo view`, which
    // Step 10's triage reads its repo from (gh 2.102, measured). So both are asked.
    { name: 'a GH_REPO naming another repo is asked even when gh\'s default is origin', remotes: { origin: 'https://github.com/me/gstack.git' }, env: { GH_REPO: 'someone/gstack' }, gh: { repos: { 'me/gstack': null }, ghDefault: 'https://github.com/me/gstack', urls: { 'someone/gstack': 'https://github.com/someone/gstack' }, prs: { 'someone/gstack': [5] } }, want: 'UPSTREAM_PR: open 5 someone/gstack', dflt: ["UPSTREAM_PR_DEFAULT: GH_REPO is someone/gstack, not origin's me/gstack"], code: 0 },
    { name: "a GH_REPO naming origin's own Enterprise repo is none", remotes: { origin: 'https://ghe.acme.test/me/proj.git' }, env: { GH_REPO: 'ghe.acme.test/Me/Proj' }, gh: { hosts: ['ghe.acme.test'], repos: { 'ghe.acme.test/me/proj': null }, ghDefault: 'https://ghe.acme.test/me/proj', urls: { 'ghe.acme.test/Me/Proj': 'https://ghe.acme.test/me/proj' } }, want: 'UPSTREAM_PR: none', code: 0 },
    { name: "gh's default repo is still asked when GH_REPO is origin's", remotes: { origin: 'https://github.com/me/gstack.git', upstream: 'https://github.com/someone/gstack.git' }, env: { GH_REPO: 'me/gstack' }, gh: { repos: { 'me/gstack': null }, ghDefault: 'https://github.com/someone/gstack', urls: { 'me/gstack': 'https://github.com/me/gstack' }, prs: { 'someone/gstack': [] } }, want: 'UPSTREAM_PR: new someone/gstack', dflt: ["UPSTREAM_PR_DEFAULT: gh's default repo is someone/gstack, not origin's me/gstack"], code: 0 },
    { name: 'a GH_REPO gh cannot find stops', remotes: { origin: 'https://github.com/me/gstack.git' }, env: { GH_REPO: 'someone/gone' }, gh: { repos: { 'me/gstack': null }, ghDefault: 'https://github.com/me/gstack' }, want: 'UPSTREAM_PR: lookup failed GH_REPO - STOP', code: 1 },
    // Any other failure on an extra remote still stops, and names the remote to fix or remove.
    { name: 'an extra remote whose lookup errors stops and is named', remotes: { origin: 'https://github.com/me/gstack.git', contributor: 'https://github.com/someone/gstack.git' }, gh: { repos: FORK, prs: { 'garrytan/gstack': [] }, broken: ['someone/gstack'] }, want: 'UPSTREAM_PR: lookup failed remote contributor (someone/gstack) - STOP', code: 1 },
  ];

  for (const [si, shell] of SHELLS.entries()) {
    for (const [i, c] of cases.entries()) {
      test.skipIf(IS_ROOT && !!c.gh.lock)(`under ${shell}: ${c.name}`, () => {
        const cwd = clone(`up-${si}-${i}`, c.remotes, c.config);
        const stub = gh(c.gh);
        const env: Record<string, string> = { GH_CONFIG_DIR: path.join(stub, 'cfg'), ...(c.gh.absent ? { PATH: [stub, '/usr/bin', '/bin'].join(':') } : {}) };
        for (const [k, v] of Object.entries(c.env ?? {})) env[k] = v.replaceAll('{stub}', stub);
        const r = run(shell, CHECK, cwd, env, stub);
        expect(r.out).not.toContain('unexpected');
        const lines = r.out.split('\n');
        expect(lines.filter((l) => l.startsWith('UPSTREAM_PR_NOTE:')), r.out).toEqual(c.note ?? []);
        expect(lines.filter((l) => l.startsWith('UPSTREAM_PR:')), r.out).toEqual([c.want]);
        expect(lines.filter((l) => l.startsWith('UPSTREAM_PR_SKIP:')), r.out).toEqual(c.skip ?? []);
        expect(lines.filter((l) => l.startsWith('UPSTREAM_PR_DEFAULT:')), r.out).toEqual(c.dflt ?? []);
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
      // ...but the later steps' bare gh acts on gh's default repo, so `none` needs it to be origin's.
      ['steps 10, 18 and 19', "gh's default repo", 'not a fork', '`none`', "origin's own"],
      ['handoff', "gh repo set-default <origin's repo>", "owner's to run"],
      // GH_REPO steers `gh pr` and `gh api` but not `gh repo view`, so both are asked, and the handoff can unset it.
      ['gh_repo', 'gh repo view', 'both', '`none`', "origin's own"],
      ['handoff', 'unset gh_repo'],
      // An Enterprise repo is named with its host, and its PR is the owner's to handle.
      ['enterprise', 'login', '<host>/<owner>/<name>', 'by hand'],
      // A gh that does not run cannot list its logins: its hosts.yml or GH_HOST decides, and the owner hears of it.
      ['does not run', 'hosts.yml', 'gh_host'],
      ['upstream_pr_note', 'does not run', 'hosts file'],
      ['report', 'repair gh'],
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
      ['`none`', "gh's default repo", "origin's own"],
      ['`none`', 'gh_repo', "origin's own"],
      ['new <repo>', 'open <number> <repo>', "gh's default repo", "someone else's repo"],
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

// Step 19's REST fallback fills {owner}/{repo} from gh's default repo, which a
// `none` makes origin's, but `gh api` takes its host from GH_HOST, else gh's
// only login, else github.com, never from that repo (cli/cli pkg/cmd/api/api.go
// and go-gh auth.DefaultHost, read at v2.102.0). With logins on github.com and
// an Enterprise host, an Enterprise origin's PATCH would reach the same-named
// repo on github.com.
describe("/ship Step 19: the REST fallback writes to origin's host", () => {
  test('both gh api calls name the host, and the prose says which', () => {
    const fallback = between(PR_BODY_MD, '**REST fallback:**', '**Self-check:**');
    const calls = [...fallback.matchAll(/`gh api [^`]*`/g)].map((m) => m[0]);
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c).toContain('--hostname <host>');
    expectMentions(fallback.replace(/([^\n])\n(?=[^\n])/g, '$1 '), [['<host>', "origin's host", 'enterprise', 'github.com']], 'ship Step 19 REST fallback');
  });
});
