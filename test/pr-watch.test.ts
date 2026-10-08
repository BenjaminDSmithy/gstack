/**
 * gstack-pr-watch: who a signal comes from decides its weight (capy-ai[bot]
 * is CONTRIBUTOR by association yet merges and closes here), the #3032
 * warning would have latched a P0 3h17m before the close, #3066 stays
 * quiet, a P0 blocks writes until the owner acks it, an endpoint that does
 * not answer is UNVERIFIED (never quiet), and the LaunchAgent runner
 * notifies with fixed text only. Fixtures are trimmed REST responses for
 * garrytan/gstack#3032 and #3066 (read 2026-10-08).
 */
import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyActor, signalsFrom, sizeVerdict, percentile, watchMain, pollForWrite, SEED_PROXIES } from '../lib/pr-watch';
import { prStateDir, topicFor, readStateFor, defaultGit, type GhRunner } from '../lib/pr-context';

setDefaultTimeout(120_000);

const FX = path.join(import.meta.dir, 'fixtures', 'pr-watch');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(FX, f), 'utf8'));
const proxies = new Set(SEED_PROXIES);
const maintainers = new Set(['garrytan']);
const WARNING_AT = '2026-10-06T20:27:32Z';

describe('classification', () => {
  test('actors: proxy bot despite CONTRIBUTOR, infra bots, maintainer, self, external', () => {
    expect(classifyActor({ login: 'capy-ai[bot]', type: 'Bot', assoc: 'CONTRIBUTOR' }, proxies, 'me')).toBe('proxy');
    expect(classifyActor({ login: 'trunk-io[bot]', type: 'Bot', assoc: 'NONE' }, proxies, 'me')).toBe('infra');
    expect(classifyActor({ login: 'github-actions[bot]', type: 'Bot' }, proxies, 'me')).toBe('infra');
    expect(classifyActor({ login: 'garrytan', assoc: 'OWNER' }, proxies, 'me')).toBe('maintainer');
    expect(classifyActor({ login: 'BenjaminDSmithy', assoc: 'CONTRIBUTOR' }, proxies, 'benjamindsmithy')).toBe('self');
    expect(classifyActor({ login: 'someone', assoc: 'NONE' }, proxies, 'me')).toBe('external');
    expect(classifyActor({ login: 'other-bot[bot]', type: 'Bot' }, proxies, 'me')).toBe('bot');
  });

  test('#3032 as it closed: the warning, the maintainer cross-reference and the close are P0', () => {
    const s = signalsFrom({ number: 3032, self: 'BenjaminDSmithy', proxies, maintainers, pull: load('pull-3032.json'), comments: load('comments-3032.json'), reviews: load('reviews-3032.json'), timeline: load('timeline-3032.json'), absorbed: [] });
    const p0 = s.filter(x => x.level === 'P0').map(x => x.kind);
    expect(p0).toContain('superseded-comment');
    expect(p0).toContain('maintainer-cross-reference');
    expect(p0).toContain('closed-unmerged');
    expect(s.find(x => x.id === 'xref:3057')).toBeTruthy();
    expect(s.find(x => x.id === 'xref:3066')).toBeUndefined();
    expect(s.filter(x => x.kind === 'infra-comment').length).toBeGreaterThan(0);
  });

  test('#3032 at the moment of the warning, still open: P0 from the bot comment alone', () => {
    const before = (t?: string) => !!t && t <= WARNING_AT;
    const s = signalsFrom({
      number: 3032, self: 'BenjaminDSmithy', proxies, maintainers,
      pull: { ...load('pull-3032.json'), state: 'open', merged: false, mergeable_state: 'clean' },
      comments: load('comments-3032.json').filter((c: { created_at: string }) => before(c.created_at)),
      reviews: [], timeline: load('timeline-3032.json').filter((e: { created_at: string }) => before(e.created_at)), absorbed: [],
    });
    expect(s.filter(x => x.level === 'P0').map(x => x.kind)).toEqual(['superseded-comment']);
  });

  test('#3066: the trunk-io comment and the title rename are information; its merge conflict (dirty, read 2026-10-08) is P1', () => {
    const s = signalsFrom({ number: 3066, self: 'BenjaminDSmithy', proxies, maintainers, pull: load('pull-3066.json'), comments: load('comments-3066.json'), reviews: load('reviews-3066.json'), timeline: load('timeline-3066.json'), absorbed: [] });
    expect(s.filter(x => x.level === 'P0')).toEqual([]);
    expect(s.filter(x => x.level === 'P1').map(x => x.kind)).toEqual(['mergeable-dirty']);
    expect(s.filter(x => x.level === 'P2').map(x => x.kind).sort()).toEqual(['infra-comment', 'title-renamed']);
  });

  test('a maintainer comment without supersede words is P1; an external one cannot raise a P0', () => {
    const base = { number: 1, self: 'me', proxies, maintainers, pull: { state: 'open' }, reviews: [], timeline: [], absorbed: [] };
    expect(signalsFrom({ ...base, comments: [{ id: 1, user: { login: 'garrytan' }, author_association: 'OWNER', body: 'Can you rebase?' }] })[0]).toMatchObject({ level: 'P1' });
    expect(signalsFrom({ ...base, comments: [{ id: 2, user: { login: 'rando' }, author_association: 'NONE', body: 'Closing in favor of #9' }] })[0]).toMatchObject({ level: 'P2' });
    expect(signalsFrom({ ...base, comments: [], absorbed: [{ sha: 'a'.repeat(40), credit: true }] })[0]).toMatchObject({ level: 'P0', kind: 'absorbed-with-credit' });
    expect(signalsFrom({ ...base, comments: [], pull: { state: 'open', mergeable_state: 'dirty', head: { sha: 'b'.repeat(40) } } })[0]).toMatchObject({ level: 'P1', kind: 'mergeable-dirty' });
    expect(signalsFrom({ ...base, comments: [], pull: { state: 'open', mergeable_state: 'blocked' } })).toEqual([]);
  });
});

describe('size', () => {
  test('static thresholds: #3032 RED, #3066 AMBER, a small PR GREEN', () => {
    expect(sizeVerdict({ churn: 4665, files: 16 }, []).verdict).toBe('RED');
    expect(sizeVerdict({ churn: 568, files: 7 }, []).verdict).toBe('AMBER');
    expect(sizeVerdict({ churn: 60, files: 3 }, []).verdict).toBe('GREEN');
  });
  test('a live sample of five or more sets the green bound at its p90', () => {
    const sample = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map(c => ({ churn: c, files: 1 }));
    expect(percentile(sample.map(s => s.churn), 0.9)).toBe(91);
    expect(sizeVerdict({ churn: 95, files: 1 }, sample)).toMatchObject({ verdict: 'AMBER', live: true });
    expect(sizeVerdict({ churn: 90, files: 1 }, sample).verdict).toBe('GREEN');
  });
});

// ── poll / ack / gate against a topology ────────────────────────────────────

let ROOT = '';
beforeAll(() => {
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-watch-')));
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

function topology(name: string, mainMsg: string | null) {
  const base = path.join(ROOT, name);
  const up = path.join(base, 'up', 'acme', 'gw.git');
  const fork = path.join(base, 'fork', 'me', 'gw.git');
  const seed = path.join(base, 'seed');
  for (const b of [up, fork]) { fs.mkdirSync(b, { recursive: true }); git(b, 'init', '-q', '--bare', '-b', 'main'); }
  fs.mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(seed, 'a.txt'), 'a\n');
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'base');
  git(seed, 'push', '-q', up, 'main'); git(seed, 'push', '-q', fork, 'main');
  git(seed, 'checkout', '-q', '-b', 'pr/w');
  fs.writeFileSync(path.join(seed, 'b.txt'), 'b\n');
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'feat: b');
  git(seed, 'push', '-q', fork, 'pr/w');
  if (mainMsg) {
    git(seed, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(seed, 'c.txt'), 'c\n');
    git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', mainMsg);
    git(seed, 'push', '-q', up, 'main');
  }
  const clone = path.join(base, 'clone');
  git(base, 'clone', '-q', fork, clone);
  git(clone, 'remote', 'add', 'upstream', up);
  git(clone, 'checkout', '-q', 'pr/w');
  return { base, clone, fork };
}

interface FakeData { comments?: unknown[]; reviews?: unknown[]; timeline?: unknown[]; pull?: Record<string, unknown>; failComments?: boolean }

/** Answers list endpoints the way GitHub does: one page per call (per_page capped at 100, default 30), oldest first. */
function fakeGh(t: { fork: string }, data: FakeData): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const gh = (args => {
    calls.push(args);
    const ok = (v: unknown) => ({ status: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
    const ep = args.find(a => a.startsWith('repos/')) ?? '';
    const [route, query = ''] = ep.split('?');
    const page = (items: unknown[] = []) => {
      const q = new URLSearchParams(query);
      const per = Math.min(Number(q.get('per_page') ?? 30), 100);
      const p = Number(q.get('page') ?? 1);
      return ok(items.slice((p - 1) * per, p * per));
    };
    if (args[0] === 'pr' && args[1] === 'view') {
      return ok({ number: 7, state: 'OPEN', isDraft: false, headRefOid: git(t.fork, 'rev-parse', 'refs/heads/pr/w'), url: 'https://github.com/acme/gw/pull/7', headRepositoryOwner: { login: 'me' }, headRepository: { name: 'gw' }, headRefName: 'pr/w', baseRefName: 'main' });
    }
    if (args[0] === 'api' && args[1] === 'user') return ok('me\n');
    if (args[0] === 'api' && route === 'repos/acme/gw/pulls/7') return ok({ state: 'open', merged: false, mergeable_state: 'clean', head: { sha: 'x' }, ...data.pull });
    if (args[0] === 'api' && route === 'repos/acme/gw/issues/7/comments') return data.failComments ? { status: 1, stdout: '', stderr: 'HTTP 502' } : page(data.comments);
    if (args[0] === 'api' && route === 'repos/acme/gw/pulls/7/reviews') return page(data.reviews);
    if (args[0] === 'api' && route === 'repos/acme/gw/issues/7/timeline') return page(data.timeline);
    if (args[0] === 'pr' && args[1] === 'list') return ok([{ mergedBy: { login: 'capy-ai' } }]);
    return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  }) as GhRunner & { calls: string[][] };
  gh.calls = calls;
  return gh;
}

describe('poll, ack and the write gate', () => {
  const warning = [{ id: 11, user: { login: 'capy-ai[bot]', type: 'Bot' }, author_association: 'CONTRIBUTOR', created_at: WARNING_AT, html_url: 'u', body: 'The Oct 6 fix wave rewrote the fix on branch garrytan/fix-wave-oct6.' }];

  test('a P0 latches, blocks writes, prints the comment only enveloped, and clears only on ack', async () => {
    const t = topology('latch', null);
    const env = { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') };
    const out: string[] = [];
    const deps = { gh: fakeGh(t, { comments: warning }), env, out: (l: string) => out.push(l) };
    const argv = (sub: string, ...rest: string[]) => [sub, '--pr', '7', '--repo', 'acme/gw', '--cwd', t.clone, ...rest];
    expect(await watchMain(argv('poll'), deps)).toBe(10);
    expect(out.join('\n')).toContain('SIGNAL\tP0\tcomment:11\tsuperseded-comment');
    expect(out.join('\n')).toContain('BEGIN UNTRUSTED TRACKER CONTENT');
    const gate = pollForWrite({ gh: deps.gh, git: defaultGit, env, now: () => new Date(), out: () => {} }, 'acme/gw', 7, t.clone);
    expect(gate.ok).toBe(false);
    expect(await watchMain(argv('ack', 'comment:99'), deps)).toBe(2);
    expect(await watchMain(argv('ack', 'comment:11'), deps)).toBe(0);
    expect(await watchMain(argv('poll'), deps)).toBe(0);
    const dir = prStateDir({ cwd: t.clone, topic: topicFor('pr/w'), env });
    expect(readStateFor(dir, { repo: 'acme/gw', headRef: 'pr/w' })!.signals).toMatchObject({ acked: ['comment:11'] });
  });

  test('the owner still sees the enveloped comment after the LaunchAgent or a write gate latched it first', async () => {
    const t = topology('relatch', null);
    const env = { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') };
    const gh = fakeGh(t, { comments: warning });
    const argv = ['poll', '--pr', '7', '--repo', 'acme/gw', '--cwd', t.clone];
    expect(await watchMain(argv, { gh, env, out: () => {} })).toBe(10);
    const out: string[] = [];
    expect(await watchMain(argv, { gh, env, out: l => out.push(l) })).toBe(10);
    expect(out[0]).toContain('new=0 unacknowledged=1');
    expect(out.join('\n')).toContain('BEGIN UNTRUSTED TRACKER CONTENT');
    expect(out.join('\n')).toContain('fix wave rewrote the fix');
  });

  test('our trailer on upstream\'s base branch is ABSORBED-WITH-CREDIT', async () => {
    const t = topology('absorbed', 'fix: wave (#99)\n\nCo-authored-by: me <me@example.com>');
    const out: string[] = [];
    const code = await watchMain(['poll', '--pr', '7', '--repo', 'acme/gw', '--cwd', t.clone], { gh: fakeGh(t, { comments: [] }), env: { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') }, out: l => out.push(l) });
    expect(code).toBe(10);
    expect(out.join('\n')).toContain('absorbed-with-credit');
  });

  test('an endpoint that does not answer is UNVERIFIED, never quiet', async () => {
    const t = topology('unverified', null);
    const out: string[] = [];
    const code = await watchMain(['poll', '--pr', '7', '--repo', 'acme/gw', '--cwd', t.clone], { gh: fakeGh(t, { comments: [], failComments: true }), env: { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') }, out: l => out.push(l) });
    expect(code).toBe(12);
    expect(out[0]).toContain('RESULT UNVERIFIED');
  });

  test('a signal past the first hundred comments or timeline events is still read (GitHub lists oldest first)', async () => {
    // #3032 reached 91 timeline events (74 commits); its P0 cross-reference was event 87.
    const t = topology('paged', null);
    const chatter = Array.from({ length: 100 }, (_, i) => ({ id: 1000 + i, user: { login: 'rando' }, author_association: 'NONE', created_at: '2026-10-01T00:00:00Z', body: 'nice' }));
    const commits = Array.from({ length: 100 }, (_, i) => ({ event: 'committed', created_at: '2026-10-01T00:00:00Z', sha: String(i).padStart(40, '0') }));
    const xref = { event: 'cross-referenced', actor: { login: 'acme', type: 'User' }, created_at: '2026-10-02T00:00:00Z', source: { issue: { number: 99, user: { login: 'acme' }, author_association: 'OWNER', pull_request: { url: 'https://api.github.com/repos/acme/gw/pulls/99' } } } };
    const gh = fakeGh(t, { comments: [...chatter, ...warning], timeline: [...commits, xref] });
    const out: string[] = [];
    const env = { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') };
    const code = await watchMain(['poll', '--pr', '7', '--repo', 'acme/gw', '--cwd', t.clone], { gh, env, out: l => out.push(l) });
    expect(code, out.join('\n')).toBe(10);
    expect(out.join('\n')).toContain('SIGNAL\tP0\tcomment:11\tsuperseded-comment');
    expect(out.join('\n')).toContain('SIGNAL\tP0\txref:99\tmaintainer-cross-reference');
    expect(gh.calls.some(a => a.some(x => /issues\/7\/timeline\?.*page=2/.test(x)))).toBe(true);
  });
});

describe('LaunchAgent runner', () => {
  test('polls only valid enabled PRs and notifies with fixed text for P0/P1', () => {
    const base = path.join(ROOT, 'runner');
    const bin = path.join(base, 'gstack', 'bin');
    const fakeBin = path.join(base, 'fakebin');
    const root = path.join(base, 'state');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    const sh = (p: string, body: string) => { fs.writeFileSync(p, `#!/bin/bash\n${body}\n`); fs.chmodSync(p, 0o755); };
    sh(path.join(bin, 'gstack-paths'), `echo "${root}"`);
    sh(path.join(bin, 'gstack-pr-watch'), 'case "$3" in 7) exit 10 ;; 8) exit 0 ;; 9) exit 11 ;; esac; exit 1');
    sh(path.join(fakeBin, 'osascript'), `printf '%s\\n' "$2" >> "${base}/notified"`);
    const enable = (topic: string, v: Record<string, unknown>) => {
      const d = path.join(root, 'projects', 'me-gw', 'pr-drafts', topic);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'watch.json'), JSON.stringify(v));
    };
    enable('a', { repo: 'acme/gw', number: 7, cwd: base });
    enable('b', { repo: 'acme/gw', number: 8, cwd: base });
    enable('c', { repo: 'acme/gw', number: 9, cwd: base });
    enable('d', { repo: 'acme/gw', number: '7; touch pwned', cwd: base });
    enable('e', { repo: 'acme/gw"; x', number: 9, cwd: base });
    const r = spawnSync('/bin/bash', [path.join(import.meta.dir, '..', 'contrib', 'pr-watch', 'pr-watch-runner.sh')], {
      encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_DIR: path.join(base, 'gstack'), PATH: `${fakeBin}:${process.env.PATH}` },
    });
    expect(r.status).toBe(0);
    const notified = fs.readFileSync(path.join(base, 'notified'), 'utf8').trim().split('\n');
    expect(notified).toEqual(['display notification "PR #7 P0: superseded or closed" with title "gstack pr-watch"', 'display notification "PR #9 P1: needs attention" with title "gstack pr-watch"']);
    const log = fs.readFileSync(path.join(root, 'analytics', 'pr-watch.log'), 'utf8');
    expect(log.match(/skip /g)).toHaveLength(2);
    expect(fs.existsSync(path.join(base, 'pwned'))).toBe(false);
  });
});
