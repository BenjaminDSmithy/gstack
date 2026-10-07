/**
 * gstack-pr-validate: the env it hands bun, the selection rules, the
 * per-file verdict (a run with no "Ran N tests" line is cut short, never
 * green), and the recorded verdict gstack-pr-sync push gates on.
 * Real bun runs on tiny fixture tests; gh is faked in-process.
 */
import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validationEnv, selectTests, judgeBunRun, bunPinFrom, macosNamedFrom, validateMain, defaultTool } from '../lib/pr-validate';
import { prStateDir, topicFor, readStateFor, type GhRunner } from '../lib/pr-context';

setDefaultTimeout(180_000);

let ROOT = '';
beforeAll(() => {
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-validate-')));
});
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function write(dir: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

describe('validationEnv', () => {
  test('drops agent markers and provider credentials, sets CI git default, real TMPDIR and the seed base', () => {
    const env = validationEnv({
      PATH: '/usr/bin', HOME: '/h', CLAUDECODE: '1', AI_AGENT: 'claude', CLAUDE_CODE_X: 'y', GSTACK_SKIP_RENDER_HOOK: '1',
      EVALS: '1', EVALS_ALL: '1', GH_TOKEN: 't', GITHUB_TOKEN: 't', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k',
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: 'c',
    }, '/real/tmp', 'abc');
    for (const gone of ['CLAUDECODE', 'AI_AGENT', 'CLAUDE_CODE_X', 'GSTACK_SKIP_RENDER_HOOK', 'EVALS', 'EVALS_ALL', 'GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
      expect(env[gone], gone).toBeUndefined();
    }
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/h', TMPDIR: '/real/tmp/', GSTACK_FREE_SEED_BASE: 'abc', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_KEY_1: 'init.defaultBranch', GIT_CONFIG_VALUE_1: 'main' });
  });
});

describe('selectTests', () => {
  const universe = ['test/a.test.ts', 'test/b.test.ts', 'test/gen-skill-docs.test.ts', 'test/skill-validation.test.ts', 'test/egress-receipt-wiring.test.ts',
    'test/spawnsync-timeout-tripwire.test.ts', 'test/agents-digest.test.ts', 'test/gstack-version-bump.test.ts'];
  const src: Record<string, string> = { 'test/b.test.ts': "spawnSync(path.join(ROOT, 'bin', 'gstack-thing'))", 'test/a.test.ts': "import '../lib/foo';" };
  const sel = (changed: string[], extra: Partial<Parameters<typeof selectTests>[0]> = {}) =>
    selectTests({ changed, universe, declared: [], pkgVersionOnly: true, source: f => src[f] ?? '', ...extra });

  test('each rule names why a file runs', () => {
    const s = sel(['test/a.test.ts', 'bin/gstack-thing', 'x/SKILL.md.tmpl', 'VERSION']);
    const rules = Object.fromEntries(s.files.map(f => [f.file, f.rules]));
    expect(rules['test/a.test.ts']).toContain('changed');
    expect(rules['test/b.test.ts']).toEqual(['names:gstack-thing']);
    expect(rules['test/gen-skill-docs.test.ts']).toEqual(['class:skill(x/SKILL.md.tmpl)']);
    expect(rules['test/egress-receipt-wiring.test.ts']).toEqual(['class:code(bin/gstack-thing)']);
    expect(rules['test/spawnsync-timeout-tripwire.test.ts']).toEqual(['class:test(test/a.test.ts)']);
    expect(rules['test/agents-digest.test.ts']).toEqual(['class:release(VERSION)']);
    expect(s.full).toEqual([]);
  });

  test('a path named in a test source selects it; release files never do', () => {
    expect(sel(['lib/foo']).files.map(f => f.file)).toContain('test/a.test.ts');
    expect(sel(['CHANGELOG.md']).files.map(f => f.file)).not.toContain('test/a.test.ts');
  });

  test('dependency and runner changes need the full suite; a version-only package.json does not', () => {
    expect(sel(['bun.lock']).full).toEqual(['bun.lock']);
    expect(sel(['tsconfig.test.json', 'scripts/test-free-shards.ts']).full).toHaveLength(2);
    expect(sel(['package.json'], { pkgVersionOnly: false }).full).toEqual(['package.json']);
    expect(sel(['package.json']).full).toEqual([]);
  });

  test('declared files always run; files outside the free universe never do', () => {
    expect(sel([], { declared: ['test/b.test.ts', 'test/skill-e2e-paid.test.ts'] }).files).toEqual([{ file: 'test/b.test.ts', rules: ['declared'] }]);
  });
});

describe('judgeBunRun on real bun runs', () => {
  const run = (name: string, body: string) => {
    const dir = path.join(ROOT, 'judge');
    write(dir, `${name}.test.ts`, `import { test, expect } from 'bun:test';\n${body}\n`);
    const env = validationEnv(process.env, ROOT, null);
    return judgeBunRun(name, defaultTool('bun', ['test', path.join(dir, `${name}.test.ts`)], { cwd: dir, env, timeoutMs: 120_000 }));
  };

  test('green needs exit 0, no (fail) and a Ran line', () => {
    expect(run('passes', "test('a', () => expect(1).toBe(1));")).toMatchObject({ ok: true, pass: 1, fail: 0, ran: true });
  });
  test('a failing test is red', () => {
    expect(run('fails', "test('b', () => expect(1).toBe(2));")).toMatchObject({ ok: false, fail: 1 });
  });
  test('a run cut short by process.exit(0) is red even though bun exits 0', () => {
    const v = run('truncated', "test('c', () => { process.exit(0); });\ntest('d', () => expect(1).toBe(1));");
    expect(v.rc).toBe(0);
    expect(v.ok).toBe(false);
    expect(v.why).toContain('cut short');
  });
});

describe('workflow parsing', () => {
  const wf = `jobs:\n  free:\n    steps:\n      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: 1.4.2\n  macos-named-regressions:\n    steps:\n      - run: |\n          files=(test/one.test.ts browse/test/two.test.ts)\n`;
  test('reads the Bun pin and the macOS named regressions', () => {
    expect(bunPinFrom(wf)).toBe('1.4.2');
    expect(macosNamedFrom(wf)).toEqual(['test/one.test.ts', 'browse/test/two.test.ts']);
    expect(bunPinFrom(null)).toBeNull();
    expect(macosNamedFrom('jobs: {}')).toEqual([]);
  });
});

describe('run, select and declare against a fixture PR tree', () => {
  function fixture(name: string, testBody: string) {
    const base = path.join(ROOT, name);
    const up = path.join(base, 'acme', 'fx.git');
    const tree = path.join(base, 'tree');
    fs.mkdirSync(up, { recursive: true });
    git(up, 'init', '-q', '--bare', '-b', 'main');
    fs.mkdirSync(tree, { recursive: true });
    git(tree, 'init', '-q', '-b', 'main');
    write(tree, 'lib/y.ts', 'export const y = 1;\n');
    write(tree, 'test/x.test.ts', "import { test, expect } from 'bun:test';\ntest('x', () => expect(1).toBe(1));\n");
    write(tree, 'test/z.test.ts', "import { test, expect } from 'bun:test';\ntest('z', () => expect(1).toBe(1));\n");
    git(tree, 'add', '-A');
    git(tree, 'commit', '-q', '-m', 'base');
    git(tree, 'remote', 'add', 'upstream', up);
    git(tree, 'push', '-q', 'upstream', 'main');
    git(tree, 'checkout', '-q', '-b', 'pr/v');
    write(tree, 'lib/y.ts', 'export const y = 2;\n');
    write(tree, 'test/x.test.ts', `import { test, expect } from 'bun:test';\n// covers lib/y.ts\n${testBody}\n`);
    git(tree, 'add', '-A');
    git(tree, 'commit', '-q', '-m', 'change y');
    const gh = ((args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view') {
        return { status: 0, stderr: '', stdout: JSON.stringify({ number: 5, state: 'OPEN', isDraft: false, headRefOid: git(tree, 'rev-parse', 'HEAD'), url: 'https://github.com/acme/fx/pull/5', headRepositoryOwner: { login: 'me' }, headRepository: { name: 'fx' }, headRefName: 'pr/v', baseRefName: 'main' }) };
      }
      return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
    }) as GhRunner;
    const env = { ...process.env, GSTACK_STATE_ROOT: path.join(base, 'home') };
    const out: string[] = [];
    const deps = { gh, env, out: (l: string) => out.push(l), universe: () => ['test/x.test.ts', 'test/z.test.ts'], tempRoot: () => ROOT, which: () => false };
    const call = (argv: string[]) => validateMain([...argv, '--pr', '5', '--repo', 'acme/fx', '--cwd', tree], deps);
    const dir = prStateDir({ cwd: tree, topic: topicFor('pr/v'), env });
    return { tree, out, call, dir };
  }
  const pr = { repo: 'acme/fx', number: 5, headRef: 'pr/v', headOwner: 'me' };

  test('select prints only the touched test with its rule', async () => {
    const f = fixture('sel', "test('x', () => expect(2).toBe(2));");
    expect(await f.call(['select'])).toBe(0);
    expect(f.out.filter(l => l.startsWith('SELECT'))).toEqual(['SELECT\ttest/x.test.ts\tchanged,names:lib/y.ts']);
  });

  test('a green run records the verdict for the exact commit; a red one records worst=1', async () => {
    const g = fixture('green', "test('x', () => expect(2).toBe(2));");
    expect(await g.call(['run'])).toBe(0);
    const st = readStateFor(g.dir, pr)!;
    expect(st.validation).toMatchObject({ sha: git(g.tree, 'rev-parse', 'HEAD'), worst: 0 });
    const summary = fs.readFileSync(path.join(g.dir, 'validate', st.validation!.sha.slice(0, 12), 'summary.txt'), 'utf8');
    expect(summary.trim().split('\n').at(-1)).toBe('VALIDATE-END worst=0');
    expect(summary).toContain('test/x.test.ts rc=0 1 pass 0 fail 0 skip ran=1 ok');
    expect(summary).not.toContain('test/z.test.ts');

    const r = fixture('red', "test('x', () => expect(2).toBe(3));");
    expect(await r.call(['run'])).toBe(1);
    expect(readStateFor(r.dir, pr)!.validation).toMatchObject({ worst: 1 });
  });

  test('a runner/dependency change keeps the run red unless the owner accepts the full-suite risk', async () => {
    const f = fixture('full', "test('x', () => expect(2).toBe(2));");
    write(f.tree, 'tsconfig.test.json', '{}\n');
    git(f.tree, 'add', '-A');
    git(f.tree, 'commit', '-q', '-m', 'tsconfig');
    expect(await f.call(['run'])).toBe(1);
    expect(f.out.join('\n')).toContain('selection FULL (tsconfig.test.json)');
    expect(await f.call(['run', '--accept-full-risk'])).toBe(0);
  });

  test('declare adds a test that always runs; a dirty tree is refused', async () => {
    const f = fixture('decl', "test('x', () => expect(2).toBe(2));");
    expect(await f.call(['declare', 'test/z.test.ts'])).toBe(0);
    expect(readStateFor(f.dir, pr)!.focused?.paths).toEqual(['test/z.test.ts']);
    f.out.length = 0;
    await f.call(['select']);
    expect(f.out).toContain('SELECT\ttest/z.test.ts\tdeclared');
    expect(await f.call(['declare', 'test/nope.test.ts'])).toBe(2);
    write(f.tree, 'lib/y.ts', 'export const y = 3;\n');
    expect(await f.call(['run'])).toBe(30);
  });
});
