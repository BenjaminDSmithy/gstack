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
import { classifyActor, signalsFrom, sizeVerdict, percentile, watchMain, pollForWrite, absorptionOf, SEED_PROXIES } from '../lib/pr-watch';
import { prStateDir, topicFor, readStateFor, writeState, defaultGit, type GhRunner } from '../lib/pr-context';

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
    expect(s.find(x => x.kind === 'closed-unmerged')).toMatchObject({ id: 'closed-unmerged:2026-10-06T23:44:13Z', at: '2026-10-06T23:44:13Z' });
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
    const sha = 'a'.repeat(40);
    expect(signalsFrom({ ...base, comments: [], absorbed: [{ sha, credit: true, cites: true }] })[0]).toMatchObject({ level: 'P0', kind: 'absorbed-with-credit' });
    expect(signalsFrom({ ...base, comments: [], absorbed: [{ sha, credit: false, cites: true }] })[0]).toMatchObject({ level: 'P0', kind: 'cited-on-base' });
    expect(signalsFrom({ ...base, comments: [], absorbed: [{ sha, credit: true, cites: false }] })[0]).toMatchObject({ level: 'P2', kind: 'credited-elsewhere' });
    // GitHub links a commit that mentions #N without the (#N) form through a `referenced` event on this PR.
    const referenced = [{ event: 'referenced', actor: { login: 'capy-ai[bot]', type: 'Bot' }, commit_id: sha }];
    expect(signalsFrom({ ...base, comments: [], timeline: referenced, absorbed: [{ sha, credit: true, cites: false }] }).find(s => s.id.startsWith('absorbed:'))).toMatchObject({ level: 'P0', kind: 'absorbed-with-credit' });
    expect(signalsFrom({ ...base, comments: [], pull: { state: 'open', mergeable_state: 'dirty', head: { sha: 'b'.repeat(40) } } })[0]).toMatchObject({ level: 'P1', kind: 'mergeable-dirty' });
    expect(signalsFrom({ ...base, comments: [], pull: { state: 'open', mergeable_state: 'blocked' } })).toEqual([]);
  });
});

describe('absorption wording and credit (absorptionOf)', () => {
  const ids = { login: 'BenjaminDSmithy', emails: ['benjamin.smith@binarysword.com'], names: ['Benjamin D. Smith'] };
  // ad8400543 (v1.69.0.0) absorbed garrytan/gstack#2640: subject, its two `Absorbed from PR` lines and
  // part of its trailer block (the owner's name-form line kept, personal addresses of others dropped).
  const ad8400543 = fs.readFileSync(path.join(FX, 'commit-ad8400543.txt'), 'utf8');

  test("ad8400543 names #2640 as `PR #2640` and credits the owner by git name and email", () => {
    expect(absorptionOf(ad8400543, 2640, ids)).toEqual({ cites: false, mentions: true, credit: true });
    expect(absorptionOf(ad8400543, 264, ids).mentions).toBe(false);
    expect(absorptionOf(ad8400543, 2640, { login: 'BenjaminDSmithy', emails: [], names: [] }).credit).toBe(false);
  });

  test('credit forms: the login as the name, the noreply address with or without its id, never a longer login', () => {
    const trailer = (t: string) => absorptionOf(`fix: x (#5)\n\nCo-authored-by: ${t}`, 5, { login: 'dgrant', emails: [], names: [] });
    expect(trailer('dgrant <dgrant@users.noreply.github.com>')).toEqual({ cites: true, mentions: false, credit: true });
    expect(trailer('D Grant <123456+DGrant@users.noreply.github.com>').credit).toBe(true);
    expect(trailer('dgrantham <dgrantham@users.noreply.github.com>').credit).toBe(false);
    expect(trailer('dgrant-bot <99+dgrant-bot@users.noreply.github.com>').credit).toBe(false);
  });

  test('signals: named with our credit is P0, named without it is P1 attention, (#N) alone is P0', () => {
    const base = { number: 1, self: 'me', proxies, maintainers, pull: { state: 'open' }, comments: [], reviews: [], timeline: [] };
    const sha = 'a'.repeat(40);
    const one = (a: { credit: boolean; cites?: boolean; mentions?: boolean }) => signalsFrom({ ...base, absorbed: [{ sha, ...a }] }).map(s => [s.level, s.kind]);
    expect(one({ credit: true, mentions: true })).toEqual([['P0', 'absorbed-with-credit']]);
    expect(one({ credit: false, mentions: true })).toEqual([['P1', 'named-on-base']]);
    expect(one({ credit: false, cites: true })).toEqual([['P0', 'cited-on-base']]);
  });

  test("the maintainer's 'Absorbed into the wave' notice on #2640 is a supersede notice (P0)", () => {
    const s = signalsFrom({ number: 2640, self: 'BenjaminDSmithy', proxies, maintainers, pull: { state: 'open' }, comments: load('comments-2640.json'), reviews: [], timeline: [], absorbed: [] });
    expect(s.map(x => [x.level, x.kind, x.id])).toEqual([['P0', 'superseded-comment', 'comment:5401509698']]);
  });
});

describe('reviews', () => {
  const review = (id: number, login: string, assoc: string, state: string, body: string) => ({ id, user: { login }, author_association: assoc, state, submitted_at: '2026-10-07T00:00:00Z', body });
  const run = (...reviews: ReturnType<typeof review>[]) => signalsFrom({ number: 1, self: 'me', proxies, maintainers, pull: { state: 'open' }, comments: [], reviews, timeline: [], absorbed: [] })
    .map(s => [s.id, s.level, s.kind]);

  test('supersede wording is P0 whatever the review state; other maintainer reviews are P1', () => {
    expect(run(
      review(5, 'garrytan', 'OWNER', 'CHANGES_REQUESTED', 'Superseded by #3057, closing.'),
      review(6, 'garrytan', 'OWNER', 'COMMENTED', 'Superseded by #3057, closing.'),
      review(7, 'garrytan', 'OWNER', 'CHANGES_REQUESTED', 'Please split this.'),
      review(8, 'capy-ai[bot]', 'CONTRIBUTOR', 'COMMENTED', 'Closing in favour of #3057.'),
      review(9, 'garrytan', 'OWNER', 'COMMENTED', 'Looks fine.'),
    )).toEqual([
      ['review:5', 'P0', 'superseded-review'], ['review:6', 'P0', 'superseded-review'], ['review:7', 'P1', 'changes-requested'],
      ['review:8', 'P0', 'superseded-review'], ['review:9', 'P1', 'maintainer-review'],
    ]);
  });
  test('an external review with supersede wording cannot raise a P0', () => {
    expect(run(review(10, 'rando', 'NONE', 'COMMENTED', 'Closing in favour of #3057.'))).toEqual([]);
  });
});

describe('cross-references', () => {
  const xref = (actor: string, src: { login: string; assoc?: string; pr?: boolean }) => ({
    event: 'cross-referenced', actor: { login: actor, type: 'User' }, created_at: '2026-10-07T00:00:00Z',
    source: { issue: { number: 50, user: { login: src.login }, author_association: src.assoc, ...(src.pr === false ? {} : { pull_request: { url: 'https://api.github.com/repos/garrytan/gstack/pulls/50' } }) } },
  });
  const run = (...timeline: unknown[]) => signalsFrom({ number: 1, self: 'me', proxies, maintainers, pull: { state: 'open' }, comments: [], reviews: [], timeline: timeline as never[], absorbed: [] })
    .filter(s => s.id === 'xref:50').map(s => [s.level, s.kind, s.who]);

  test('a maintainer who references this PR from a maintainer PR is P0, named as the actor', () => {
    expect(run(xref('garrytan', { login: 'garrytan', assoc: 'OWNER' }))).toEqual([['P0', 'maintainer-cross-reference', 'garrytan (maintainer)']]);
  });
  test('the sender decides: an external or self mention on a maintainer PR cannot raise a P0', () => {
    expect(run(xref('rando', { login: 'garrytan', assoc: 'OWNER' }))).toEqual([['P2', 'cross-reference', 'rando (external)']]);
    expect(run(xref('me', { login: 'garrytan', assoc: 'OWNER' }))).toEqual([]);
  });
  test('a maintainer mention from an issue or from another contributor\'s PR is P1', () => {
    expect(run(xref('garrytan', { login: 'garrytan', assoc: 'OWNER', pr: false }))).toEqual([['P1', 'maintainer-mention', 'garrytan (maintainer)']]);
    expect(run(xref('garrytan', { login: 'rando', assoc: 'NONE' }))).toEqual([['P1', 'maintainer-mention', 'garrytan (maintainer)']]);
  });
  test('a MEMBER\'s PR counts as a maintainer PR from its author_association, without a comment here', () => {
    expect(run(xref('colleague', { login: 'colleague', assoc: 'MEMBER' }))).toEqual([['P0', 'maintainer-cross-reference', 'colleague (maintainer)']]);
  });
});

describe('size', () => {
  test('static thresholds: #3032 RED, #3066 AMBER, a small PR GREEN, a wide one not', () => {
    expect(sizeVerdict({ churn: 4665, files: 16 }, []).verdict).toBe('RED');
    expect(sizeVerdict({ churn: 568, files: 7 }, []).verdict).toBe('AMBER');
    expect(sizeVerdict({ churn: 60, files: 3 }, []).verdict).toBe('GREEN');
    expect(sizeVerdict({ churn: 60, files: 30 }, []).verdict).toBe('AMBER'); // files count too, not churn alone
  });
  test('a live sample of twenty or more sets the green bound at its p90', () => {
    const sample = Array.from({ length: 20 }, (_, i) => ({ churn: 10 * (i + 1), files: 1 }));
    expect(percentile(sample.map(s => s.churn), 0.9)).toBe(181);
    expect(sizeVerdict({ churn: 185, files: 1 }, sample)).toMatchObject({ verdict: 'AMBER', live: true });
    expect(sizeVerdict({ churn: 180, files: 1 }, sample).verdict).toBe('GREEN');
  });
  test('a small live sample falls back to the static thresholds: one outlier is not a p90', () => {
    // upstream's merged contributor PRs among the last 200 merged, read 2026-10-08: 9 PRs, one of churn 7058.
    const churn = [36, 41, 52, 55, 66, 83, 187, 334, 7058];
    const files = [1, 2, 2, 3, 3, 4, 9, 18, 54];
    const sample = churn.map((c, i) => ({ churn: c, files: files[i] }));
    expect(sizeVerdict({ churn: 568, files: 7 }, sample)).toMatchObject({ verdict: 'AMBER', live: false });
  });
  test('the verdict never falls as a PR grows, even when the live green bound passes the static amber one', () => {
    const sample = Array.from({ length: 20 }, () => ({ churn: 3000, files: 10 }));
    expect(sizeVerdict({ churn: 2500, files: 10 }, sample).verdict).toBe('GREEN');
    expect(sizeVerdict({ churn: 1900, files: 11 }, sample).verdict).toBe('AMBER');
    expect(sizeVerdict({ churn: 3100, files: 5 }, sample).verdict).toBe('RED');
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

interface FakeData { comments?: unknown[]; reviews?: unknown[]; timeline?: unknown[]; pull?: Record<string, unknown>; failComments?: boolean; headOid?: string; merged?: unknown[] }

/** Answers list endpoints the way GitHub does: one page per call (per_page capped at 100, default 30), oldest first. */
function fakeGh(t: { fork: string }, data: FakeData): GhRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const gh = (args => {
    calls.push(args);
    const ok = (v: unknown) => ({ status: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
    const ep = args.find(a => a.startsWith('repos/')) ?? '';
    const [rawRoute, query = ''] = ep.split('?');
    const route = rawRoute.toLowerCase(); // GitHub matches owner and name without regard to case
    const page = (items: unknown[] = []) => {
      const q = new URLSearchParams(query);
      const per = Math.min(Number(q.get('per_page') ?? 30), 100);
      const p = Number(q.get('page') ?? 1);
      return ok(items.slice((p - 1) * per, p * per));
    };
    if (args[0] === 'pr' && args[1] === 'view') {
      return ok({ number: 7, state: data.pull?.state === 'closed' ? 'CLOSED' : 'OPEN', isDraft: false, headRefOid: data.headOid ?? git(t.fork, 'rev-parse', 'refs/heads/pr/w'), url: 'https://github.com/acme/gw/pull/7', headRepositoryOwner: { login: 'me' }, headRepository: { name: 'gw' }, headRefName: 'pr/w', baseRefName: 'main' });
    }
    if (args[0] === 'api' && args[1] === 'user') return ok('me\n');
    if (args[0] === 'api' && route === 'repos/acme/gw/pulls/7') return ok({ state: 'open', merged: false, mergeable_state: 'clean', head: { sha: 'x' }, ...data.pull });
    if (args[0] === 'api' && route === 'repos/acme/gw/issues/7/comments') return data.failComments ? { status: 1, stdout: '', stderr: 'HTTP 502' } : page(data.comments);
    if (args[0] === 'api' && route === 'repos/acme/gw/pulls/7/reviews') return page(data.reviews);
    if (args[0] === 'api' && route === 'repos/acme/gw/issues/7/timeline') return page(data.timeline);
    if (args[0] === 'pr' && args[1] === 'list') return ok(data.merged ?? [{ mergedBy: { login: 'app/capy-ai', is_bot: true } }]); // gh's shape for a bot merger, read 2026-10-09
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
    // The NEXT line spells the ack as <id>@<level>, the level the owner is shown.
    expect(out.find(l => l.startsWith('NEXT '))).toContain('gstack-pr-watch ack comment:11@P0');
    expect(await watchMain(argv('ack', 'comment:99@P0'), deps)).toBe(2);
    expect(await watchMain(argv('ack', 'comment:11'), deps)).toBe(2);
    out.length = 0;
    expect(await watchMain(argv('ack', 'comment:11@P0'), deps)).toBe(0);
    expect(out[0]).toBe('RESULT ACKED comment:11@P0 superseded-comment');
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

  test('an acknowledged P1 comment edited into a supersede notice latches again as P0', async () => {
    const t = topology('escalate', null);
    const env = { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') };
    const data: FakeData = { comments: [{ id: 77, user: { login: 'acme' }, author_association: 'OWNER', created_at: '2026-10-01T00:00:00Z', html_url: 'u', body: 'Can you rebase?' }] };
    const gh = fakeGh(t, data);
    const out: string[] = [];
    const argv = (sub: string, ...rest: string[]) => [sub, '--pr', '7', '--repo', 'acme/gw', '--cwd', t.clone, ...rest];
    expect(await watchMain(argv('poll'), { gh, env, out: l => out.push(l) })).toBe(11);
    expect(await watchMain(argv('ack', 'comment:77@P1'), { gh, env, out: l => out.push(l) })).toBe(0);
    data.comments = [{ ...(data.comments![0] as object), body: 'Closing in favour of #9: the fix wave rewrote the fix.' }];
    out.length = 0;
    expect(await watchMain(argv('poll'), { gh, env, out: l => out.push(l) }), out.join('\n')).toBe(10);
    expect(out.join('\n')).toContain('SIGNAL\tP0\tcomment:77\tsuperseded-comment');
    expect(pollForWrite({ gh, git: defaultGit, env, now: () => new Date(), out: () => {} }, 'acme/gw', 7, t.clone).ok).toBe(false);
    expect(await watchMain(argv('ack', 'comment:77@P0'), { gh, env, out: () => {} })).toBe(0);
    expect(await watchMain(argv('poll'), { gh, env, out: () => {} })).toBe(0);
  });

  test('an ack names the level the owner was shown: a signal that rose since is refused until shown again', async () => {
    // The owner's poll shows a P1; the comment is then edited into a supersede
    // notice and an unattended poll (the LaunchAgent, another session's write
    // gate) latches it at P0 with its output discarded.
    const t = topology('ack-level', null);
    const env = { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') };
    const data: FakeData = { comments: [{ id: 701, user: { login: 'acme' }, author_association: 'OWNER', created_at: '2026-10-01T00:00:00Z', html_url: 'u', body: 'Can you rebase?' }] };
    const gh = fakeGh(t, data);
    const argv = (sub: string, ...rest: string[]) => [sub, '--pr', '7', '--repo', 'acme/gw', '--cwd', t.clone, ...rest];
    const out: string[] = [];
    expect(await watchMain(argv('poll'), { gh, env, out: l => out.push(l) })).toBe(11);
    expect(out.join('\n')).toContain('SIGNAL\tP1\tcomment:701\tmaintainer-comment');
    data.comments = [{ ...(data.comments![0] as object), body: 'Closing in favour of #9.' }];
    expect(await watchMain(argv('poll'), { gh, env, out: () => {} })).toBe(10);
    out.length = 0;
    expect(await watchMain(argv('ack', 'comment:701@P1'), { gh, env, out: l => out.push(l) })).toBe(2);
    expect(out[0]).toMatch(/^RESULT USAGE comment:701 is latched at P0 superseded-comment, not P1/);
    expect(pollForWrite({ gh, git: defaultGit, env, now: () => new Date(), out: () => {} }, 'acme/gw', 7, t.clone).ok).toBe(false);
    expect(await watchMain(argv('ack', 'comment:701@P0'), { gh, env, out: () => {} })).toBe(0);
    expect(pollForWrite({ gh, git: defaultGit, env, now: () => new Date(), out: () => {} }, 'acme/gw', 7, t.clone)).toEqual({ ok: true, reason: 'ok' });
  });

  describe('a latch reports at its latched level when a later poll reads the signal lower', () => {
    /** Two polls of one PR; `change` edits the fake GitHub data between them. Returns the second poll and its write gate. */
    const twoPolls = async (name: string, data: FakeData, first: number, change: (d: FakeData) => void) => {
      const t = topology(name, null);
      const env = { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') };
      const gh = fakeGh(t, data);
      const argv = ['poll', '--pr', '7', '--repo', 'acme/gw', '--cwd', t.clone];
      expect(await watchMain(argv, { gh, env, out: () => {} })).toBe(first);
      change(data);
      const out: string[] = [];
      const code = await watchMain(argv, { gh, env, out: l => out.push(l) });
      return { code, text: out.join('\n'), gate: pollForWrite({ gh, git: defaultGit, env, now: () => new Date(), out: () => {} }, 'acme/gw', 7, t.clone) };
    };
    const comment = (id: number, login: string, assoc: string, body: string, type = 'User') => ({ id, user: { login, type }, author_association: assoc, created_at: '2026-10-01T00:00:00Z', html_url: 'u', body });

    test('a merge bot that has left the last 30 mergedBy still reads P0 (exit 10, never QUIET)', async () => {
      const r = await twoPolls('lower-proxy', { merged: [{ mergedBy: { login: 'app/fixbot', is_bot: true } }], comments: [comment(501, 'fixbot[bot]', 'NONE', 'Superseded by #9, closing.', 'Bot')] }, 10, d => { d.merged = []; });
      expect(r.code, r.text).toBe(10);
      expect(r.text).toMatch(/^RESULT P0 /);
      expect(r.text).toMatch(/SIGNAL\tP0\tcomment:501\tsuperseded-comment\t.*now reads P2 bot-comment/);
      expect(r.gate.reason).toContain('P0 superseded-comment [comment:501]');
    });

    test('a supersede notice edited into plain text stays P0', async () => {
      const r = await twoPolls('lower-edit', { comments: [comment(77, 'acme', 'OWNER', 'Closing in favour of #9.')] }, 10, d => { d.comments = [comment(77, 'acme', 'OWNER', 'Can you rebase?')]; });
      expect(r.code, r.text).toBe(10);
      expect(r.text).toContain('SIGNAL\tP0\tcomment:77\tsuperseded-comment');
    });

    test('a collaborator whose association drops stays P1 (exit 11)', async () => {
      const r = await twoPolls('lower-assoc', { comments: [comment(88, 'helper', 'COLLABORATOR', 'Looks close.')] }, 11, d => { d.comments = [comment(88, 'helper', 'CONTRIBUTOR', 'Looks close.')]; });
      expect(r.code, r.text).toBe(11);
      expect(r.text).toContain('SIGNAL\tP1\tcomment:88\tmaintainer-comment');
    });

    test('a lower cross-reference later in the timeline from the same issue does not hide a P0 one', async () => {
      const xref = (actor: string) => ({ event: 'cross-referenced', actor: { login: actor, type: 'User' }, created_at: '2026-10-02T00:00:00Z', source: { issue: { number: 50, user: { login: 'acme' }, author_association: 'OWNER', pull_request: { url: 'https://api.github.com/repos/acme/gw/pulls/50' } } } });
      const r = await twoPolls('lower-xref', { timeline: [xref('acme'), xref('rando')] }, 10, () => {});
      expect(r.code, r.text).toBe(10);
      expect(r.text).toContain('SIGNAL\tP0\txref:50\tmaintainer-cross-reference');
    });
  });

  test('our trailer on a base commit that cites this PR is ABSORBED-WITH-CREDIT; credit for another PR is information', async () => {
    const poll = async (name: string, msg: string) => {
      const t = topology(name, msg);
      const out: string[] = [];
      const code = await watchMain(['poll', '--pr', '7', '--repo', 'acme/gw', '--cwd', t.clone], { gh: fakeGh(t, { comments: [] }), env: { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') }, out: l => out.push(l) });
      return { code, text: out.join('\n') };
    };
    const ours = await poll('absorbed', 'fix: wave (#7)\n\nCo-authored-by: me <me@example.com>');
    expect(ours.code, ours.text).toBe(10);
    expect(ours.text).toContain('absorbed-with-credit');
    // 28f1385ea credits the owner for #3032; a poll of the owner's #1696 must not read that as #1696 absorbed.
    const elsewhere = await poll('credited-elsewhere', 'fix: wave (#99)\n\nCo-authored-by: me <me@example.com>');
    expect(elsewhere.code, elsewhere.text).toBe(0);
    expect(elsewhere.text).toMatch(/INFO\tabsorbed:[0-9a-f]{12}\tcredited-elsewhere/);
  });

  test("upstream's other absorption form, 'Absorbed from PR #N' with a name-form trailer, is ABSORBED-WITH-CREDIT", async () => {
    // ad8400543's shape: the owner credited by git name and email, the PR named as `PR #N` (no `(#N)`).
    const poll = async (name: string, msg: string) => {
      const t = topology(name, msg);
      git(t.clone, 'config', 'user.name', 'Owner Name');
      git(t.clone, 'config', 'user.email', 'owner@example.com');
      const out: string[] = [];
      const code = await watchMain(['poll', '--pr', '7', '--repo', 'acme/gw', '--cwd', t.clone], { gh: fakeGh(t, { comments: [] }), env: { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') }, out: l => out.push(l) });
      return { code, text: out.join('\n') };
    };
    const absorbed = await poll('absorbed-from', 'fix: the wave (#99)\n\nAbsorbed from PR #7 with authorship preserved.\n\nCo-authored-by: Owner Name <owner@example.com>');
    expect(absorbed.code, absorbed.text).toBe(10);
    expect(absorbed.text).toMatch(/SIGNAL\tP0\tabsorbed:[0-9a-f]{12}\tabsorbed-with-credit/);
    // A version-queue note names a PR the same way without absorbing it: attention, not SUPERSEDED.
    const queued = await poll('named-only', 'chore: queue\n\nVERSION drift: PR #7 claims v1.2.0.0');
    expect(queued.code, queued.text).toBe(11);
    expect(queued.text).toMatch(/SIGNAL\tP1\tabsorbed:[0-9a-f]{12}\tnamed-on-base/);
    // Credit is the owner's login exactly, never a login it prefixes (dgrant is not dgrantham).
    const prefix = await poll('login-prefix', 'fix: other (#99)\n\nCo-authored-by: meow <meow@users.noreply.github.com>');
    expect(prefix.code, prefix.text).toBe(0);
    expect(prefix.text).not.toContain('absorbed:');
  });

  test("a topic whose state belongs to another PR is poll's precondition exit 30, and the write gate refuses", async () => {
    // topicFor folds `pr/w` and `w` together: a fork PR me/gw `w` and the upstream PR acme/gw `pr/w` share a topic dir.
    const t = topology('foreign-state', null);
    const env = { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') };
    writeState(prStateDir({ cwd: t.clone, topic: 'w', env }), {
      v: 1, topic: 'w', repo: 'me/gw', number: 3, headRef: 'w', headOwner: 'me', headRemote: null, upstreamRemote: null, defaultBranch: 'main',
      focused: null, validation: null, bodyStaleSince: null, lastPublishedBodySha256: null, signals: { latched: [], acked: [] }, audit: null,
    });
    const gh = fakeGh(t, {});
    const out: string[] = [];
    expect(await watchMain(['poll', '--pr', '7', '--repo', 'acme/gw', '--cwd', t.clone], { gh, env, out: l => out.push(l) }), out.join('\n')).toBe(30);
    expect(out[0]).toMatch(/^RESULT ERROR .*belongs to/);
    const gate = pollForWrite({ gh, git: defaultGit, env, now: () => new Date(), out: () => {} }, 'acme/gw', 7, t.clone);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toContain('belongs to');
  });

  test('an endpoint that does not answer is UNVERIFIED, never quiet', async () => {
    const t = topology('unverified', null);
    const out: string[] = [];
    const code = await watchMain(['poll', '--pr', '7', '--repo', 'acme/gw', '--cwd', t.clone], { gh: fakeGh(t, { comments: [], failComments: true }), env: { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') }, out: l => out.push(l) });
    expect(code).toBe(12);
    expect(out[0]).toContain('RESULT UNVERIFIED');
  });

  const gateDeps = (gh: GhRunner, env: NodeJS.ProcessEnv) => ({ gh, git: defaultGit, env, now: () => new Date(), out: () => {} });

  test('the write gate refuses when an endpoint does not answer, though nothing is latched', () => {
    const t = topology('gate-unverified', null);
    const gate = pollForWrite(gateDeps(fakeGh(t, { comments: [], failComments: true }), { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') }), 'acme/gw', 7, t.clone);
    expect(gate).toMatchObject({ ok: false });
    expect(gate.reason).toContain('could not verify');
  });

  test('the write gate refuses a closed or merged PR even with every signal acknowledged', async () => {
    const t = topology('gate-closed', null);
    const env = { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') };
    const closed = fakeGh(t, { pull: { state: 'closed', merged: false } });
    expect(await watchMain(['poll', '--pr', '7', '--repo', 'acme/gw', '--cwd', t.clone], { gh: closed, env, out: () => {} })).toBe(10);
    expect(await watchMain(['ack', '--pr', '7', '--repo', 'acme/gw', '--cwd', t.clone, 'closed-unmerged@P0'], { gh: closed, env, out: () => {} })).toBe(0);
    expect(pollForWrite(gateDeps(closed, env), 'acme/gw', 7, t.clone)).toEqual({ ok: false, reason: 'PR #7 is closed' });
    expect(pollForWrite(gateDeps(fakeGh(t, { pull: { state: 'closed', merged: true } }), env), 'acme/gw', 7, t.clone)).toEqual({ ok: false, reason: 'PR #7 is merged' });
  });

  test('each unmerged close latches on its own: after an acked close, a reopen and a second close is a new P0', async () => {
    const t = topology('reclose', null);
    const env = { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') };
    const data: FakeData = { pull: { state: 'closed', merged: false, closed_at: '2026-10-01T00:00:00Z' } };
    const gh = fakeGh(t, data);
    const argv = (sub: string, ...rest: string[]) => [sub, '--pr', '7', '--repo', 'acme/gw', '--cwd', t.clone, ...rest];
    const out: string[] = [];
    expect(await watchMain(argv('poll'), { gh, env, out: l => out.push(l) })).toBe(10);
    expect(out.join('\n')).toContain('SIGNAL\tP0\tclosed-unmerged:2026-10-01T00:00:00Z\tclosed-unmerged');
    expect(await watchMain(argv('ack', 'closed-unmerged:2026-10-01T00:00:00Z@P0'), { gh, env, out: () => {} })).toBe(0);
    data.pull = { state: 'open', merged: false, closed_at: null };
    expect(await watchMain(argv('poll'), { gh, env, out: () => {} })).toBe(0);
    data.pull = { state: 'closed', merged: false, closed_at: '2026-10-03T00:00:00Z' };
    out.length = 0;
    expect(await watchMain(argv('poll'), { gh, env, out: l => out.push(l) }), out.join('\n')).toBe(10);
    expect(out[0]).toContain('new=1 unacknowledged=1');
  });

  test('a latched P1 keeps the write gate shut after its condition clears, until it is acknowledged', async () => {
    const t = topology('gate-latch', null);
    const env = { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') };
    const data: FakeData = { pull: { mergeable_state: 'dirty', head: { sha: 'b'.repeat(40) } } };
    const gh = fakeGh(t, data);
    const argv = (sub: string, ...rest: string[]) => [sub, '--pr', '7', '--repo', 'acme/gw', '--cwd', t.clone, ...rest];
    const out: string[] = [];
    expect(await watchMain(argv('poll'), { gh, env, out: l => out.push(l) })).toBe(11);
    // The next step for a conflict: the owner reads it, it is acked, then the sync mode resolves it.
    expect(out.find(l => l.startsWith('NEXT '))).toMatch(/ack.*sync/);
    data.pull = { mergeable_state: 'clean' };
    expect(await watchMain(argv('poll'), { gh, env, out: () => {} })).toBe(11);
    expect(pollForWrite(gateDeps(gh, env), 'acme/gw', 7, t.clone).ok).toBe(false);
    expect(await watchMain(argv('ack', `mergeable:dirty:${'b'.repeat(12)}@P1`), { gh, env, out: () => {} })).toBe(0);
    expect(pollForWrite(gateDeps(gh, env), 'acme/gw', 7, t.clone)).toEqual({ ok: true, reason: 'ok' });
  });

  test('a failing base scan keeps the P0 the REST reads found; with nothing found it is UNVERIFIED', async () => {
    const t = topology('noupstream', null);
    git(t.clone, 'remote', 'remove', 'upstream');
    const env = { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') };
    const out: string[] = [];
    const argv = ['poll', '--pr', '7', '--repo', 'acme/gw', '--cwd', t.clone];
    expect(await watchMain(argv, { gh: fakeGh(t, { comments: warning }), env, out: l => out.push(l) }), out.join('\n')).toBe(10);
    expect(out[0]).toMatch(/^RESULT P0 .*error=.*no git remote for acme\/gw/);
    expect(out.join('\n')).toContain('SIGNAL\tP0\tcomment:11\tsuperseded-comment');
    const t2 = topology('noupstream-quiet', null);
    git(t2.clone, 'remote', 'remove', 'upstream');
    out.length = 0;
    expect(await watchMain(argv.map(a => a === t.clone ? t2.clone : a), { gh: fakeGh(t2, { comments: [] }), env: { ...process.env, GSTACK_STATE_ROOT: path.join(t2.base, 'home') }, out: l => out.push(l) })).toBe(12);
    expect(out[0]).toContain('RESULT UNVERIFIED');
  });

  test('a closed PR whose head branch was deleted still scans the base from the local head commit', async () => {
    const t = topology('deleted', 'fix: wave (#7)');
    const oid = git(t.fork, 'rev-parse', 'refs/heads/pr/w');
    git(t.fork, 'update-ref', '-d', 'refs/heads/pr/w');
    const out: string[] = [];
    const gh = fakeGh(t, { comments: warning, headOid: oid, pull: { state: 'closed', merged: false } });
    expect(await watchMain(['poll', '--pr', '7', '--repo', 'acme/gw', '--cwd', t.clone], { gh, env: { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') }, out: l => out.push(l) }), out.join('\n')).toBe(10);
    expect(out[0]).not.toContain('error=');
    for (const kind of ['superseded-comment', 'closed-unmerged', 'cited-on-base']) expect(out.join('\n')).toContain(kind);
  });

  test('a proxy is the bot account itself: a User named like a merge bot cannot raise a P0', async () => {
    // capy-ai (type User, created 2026-01-17) is not capy-ai[bot] (type Bot); gh lists a bot merger as app/<slug>.
    expect(classifyActor({ login: 'capy-ai', type: 'User', assoc: 'NONE' }, proxies, 'me')).toBe('external');
    const t = topology('proxy-exact', null);
    const env = { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') };
    const c = (id: number, login: string, type: string) => ({ id, user: { login, type }, author_association: 'NONE', created_at: '2026-10-01T00:00:00Z', html_url: 'u', body: 'Superseded by #9.' });
    const data: FakeData = { merged: [{ mergedBy: { login: 'app/fixbot', is_bot: true } }, { mergedBy: { login: 'helper', is_bot: false } }], comments: [c(1, 'fixbot', 'User'), c(2, 'capy-ai', 'User')] };
    const gh = fakeGh(t, data);
    const argv = ['poll', '--pr', '7', '--repo', 'acme/gw', '--cwd', t.clone];
    const out: string[] = [];
    expect(await watchMain(argv, { gh, env, out: l => out.push(l) }), out.join('\n')).toBe(0);
    expect(out.filter(l => l.startsWith('INFO\tcomment:'))).toEqual(['INFO\tcomment:1\texternal-comment\tfixbot (external)', 'INFO\tcomment:2\texternal-comment\tcapy-ai (external)']);
    // The bot account that merged, and a human who merged, are proxies.
    data.comments = [c(3, 'fixbot[bot]', 'Bot'), c(4, 'helper', 'User')];
    out.length = 0;
    expect(await watchMain(argv, { gh, env, out: l => out.push(l) }), out.join('\n')).toBe(10);
    expect(out.filter(l => l.startsWith('SIGNAL'))).toEqual([
      'SIGNAL\tP0\tcomment:3\tsuperseded-comment\tfixbot[bot] (proxy)\tu',
      'SIGNAL\tP0\tcomment:4\tsuperseded-comment\thelper (proxy)\tu',
    ]);
  });

  test('maintainer logins match without regard to case, so --repo Acme/gw still sees acme', async () => {
    const t = topology('case', null);
    const xref = { event: 'cross-referenced', actor: { login: 'acme', type: 'User' }, created_at: '2026-10-02T00:00:00Z', source: { issue: { number: 99, user: { login: 'acme' }, pull_request: { url: 'https://api.github.com/repos/acme/gw/pulls/99' } } } };
    const out: string[] = [];
    const code = await watchMain(['poll', '--pr', '7', '--repo', 'Acme/gw', '--cwd', t.clone], { gh: fakeGh(t, { timeline: [xref] }), env: { ...process.env, GSTACK_STATE_ROOT: path.join(t.base, 'home') }, out: l => out.push(l) });
    expect(code, out.join('\n')).toBe(10);
    expect(out.join('\n')).toContain('SIGNAL\tP0\txref:99\tmaintainer-cross-reference');
    expect(classifyActor({ login: 'Capy-AI[bot]', type: 'Bot', assoc: 'CONTRIBUTOR' }, proxies, 'me')).toBe('proxy');
    expect(classifyActor({ login: 'Trunk-IO[bot]', type: 'Bot' }, proxies, 'me')).toBe('infra');
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

describe('enable and disable', () => {
  test('a topic holds one watch: enabling or disabling another PR there is refused, the first watch kept', async () => {
    // topicFor folds pr/x and x together, as for a fork PR and its upstream PR from one checkout.
    const home = path.join(ROOT, 'enable-home');
    const env = { ...process.env, GSTACK_STATE_ROOT: home, GSTACK_PROJECT_SLUG: 'me-gw' };
    const gh = ((args: string[]) => {
      if (args[0] !== 'pr' || args[1] !== 'view') return { status: 1, stdout: '', stderr: 'unexpected' };
      const n = Number(args[2]);
      const repo = n === 7 ? 'acme/gw' : 'me/gw';
      return { status: 0, stderr: '', stdout: JSON.stringify({ number: n, state: 'OPEN', isDraft: false, headRefOid: 'c'.repeat(40), url: `https://github.com/${repo}/pull/${n}`, headRepositoryOwner: { login: 'me' }, headRepository: { name: 'gw' }, headRefName: n === 7 ? 'pr/x' : 'x', baseRefName: 'main' }) };
    }) as GhRunner;
    const run = async (sub: string, n: number, repo: string) => {
      const out: string[] = [];
      const code = await watchMain([sub, '--pr', String(n), '--repo', repo, '--cwd', ROOT], { gh, env, out: l => out.push(l) });
      return { code, first: out[0] ?? '' };
    };
    const file = path.join(prStateDir({ cwd: ROOT, topic: 'x', env }), 'watch.json');
    expect((await run('enable', 7, 'acme/gw')).code).toBe(0);
    expect(await run('enable', 8, 'me/gw')).toMatchObject({ code: 30 });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ repo: 'acme/gw', number: 7 });
    expect((await run('disable', 8, 'me/gw')).code).toBe(30);
    expect(fs.existsSync(file)).toBe(true);
    expect((await run('enable', 7, 'acme/gw')).code).toBe(0);
    expect((await run('disable', 7, 'acme/gw')).code).toBe(0);
    expect(fs.existsSync(file)).toBe(false);
    expect((await run('disable', 7, 'acme/gw')).code).toBe(0);
  });
});

describe('size before the PR is open', () => {
  /** gh for `size` without --pr: the default branch, and a baseline that is not read (static thresholds). */
  const sizeGh = (() => (args: string[]) => {
    if (args[0] === 'repo' && args[1] === 'view') return { status: 0, stdout: 'main\n', stderr: '' };
    return { status: 1, stdout: '', stderr: 'offline' };
  }) as () => GhRunner;

  function branch(name: string, orphan: boolean) {
    const base = path.join(ROOT, name);
    const up = path.join(base, 'up', 'acme', 'gw.git');
    fs.mkdirSync(up, { recursive: true });
    git(up, 'init', '-q', '--bare', '-b', 'main');
    const clone = path.join(base, 'clone');
    fs.mkdirSync(clone, { recursive: true });
    git(clone, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(clone, 'a.txt'), 'a\n');
    git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', 'base');
    git(clone, 'remote', 'add', 'upstream', up);
    git(clone, 'push', '-q', 'upstream', 'main');
    git(clone, 'checkout', '-q', ...(orphan ? ['--orphan', 'pr/w'] : ['-b', 'pr/w']));
    fs.mkdirSync(path.join(clone, 'sub'), { recursive: true });
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(clone, i < 15 ? '' : 'sub', `f${i}.txt`), 'x\n'.repeat(100));
    git(clone, 'add', '-A'); git(clone, 'commit', '-q', '-m', 'feat: big');
    return clone;
  }
  const size = async (cwd: string) => {
    const out: string[] = [];
    const code = await watchMain(['size', '--repo', 'acme/gw', '--cwd', cwd], { gh: sizeGh(), out: l => out.push(l) });
    return { code, first: out[0] ?? '', lines: out };
  };

  test('the count covers the whole repository, whichever directory it runs from', async () => {
    const clone = branch('size-sub', false);
    const root = await size(clone);
    expect(root).toMatchObject({ code: 0 });
    // RESULT is the first line even when the live baseline is not read (the NOTE follows it).
    expect(root.first).toMatch(/^RESULT RED churn=3000 files=30 commits=1/);
    expect(root.lines.some(l => l.startsWith('NOTE baseline not read'))).toBe(true);
    expect((await size(path.join(clone, 'sub'))).first).toBe(root.first);
  });

  test('a branch with no merge base is an error, never a GREEN zero', async () => {
    const r = await size(branch('size-orphan', true));
    expect(r.code).toBe(1);
    expect(r.first).toMatch(/^RESULT ERROR .*merge-base/);
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

  test('a watch that cannot verify, or whose worktree is gone, notifies on its second failed run in a row', () => {
    const base = path.join(ROOT, 'runner-fail');
    const bin = path.join(base, 'gstack', 'bin');
    const fakeBin = path.join(base, 'fakebin');
    const root = path.join(base, 'state');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    const sh = (p: string, body: string) => { fs.writeFileSync(p, `#!/bin/bash\n${body}\n`); fs.chmodSync(p, 0o755); };
    sh(path.join(bin, 'gstack-paths'), `echo "${root}"`);
    sh(path.join(bin, 'gstack-pr-watch'), `exit "$(cat "${base}/rc-$3")"`);
    sh(path.join(fakeBin, 'osascript'), `printf '%s\\n' "$2" >> "${base}/notified"`);
    const enable = (topic: string, v: Record<string, unknown>) => {
      const d = path.join(root, 'projects', 'me-gw', 'pr-drafts', topic);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'watch.json'), JSON.stringify(v));
    };
    enable('a', { repo: 'acme/gw', number: 20, cwd: base });
    enable('b', { repo: 'acme/gw', number: 21, cwd: base });
    enable('c', { repo: 'acme/gw', number: 22, cwd: path.join(base, 'reaped') });
    const rc = (n: number, v: number) => fs.writeFileSync(path.join(base, `rc-${n}`), `${v}\n`);
    const notified = () => (fs.existsSync(path.join(base, 'notified')) ? fs.readFileSync(path.join(base, 'notified'), 'utf8').trim().split('\n') : []);
    const runOnce = () => {
      const r = spawnSync('/bin/bash', [path.join(import.meta.dir, '..', 'contrib', 'pr-watch', 'pr-watch-runner.sh')], {
        encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_DIR: path.join(base, 'gstack'), PATH: `${fakeBin}:${process.env.PATH}` },
      });
      expect(r.status).toBe(0);
    };
    rc(20, 12);
    rc(21, 1);
    runOnce();
    expect(notified()).toEqual([]);
    runOnce();
    expect(notified()).toEqual([
      'display notification "PR #20: watch could not verify (rc=12)" with title "gstack pr-watch"',
      'display notification "PR #21: watch could not verify (rc=1)" with title "gstack pr-watch"',
      'display notification "PR #22: watch stopped, its worktree is gone" with title "gstack pr-watch"',
    ]);
    runOnce();
    expect(notified()).toHaveLength(3);
    rc(20, 0);
    runOnce();
    rc(20, 12);
    runOnce();
    expect(notified().filter(l => l.includes('#20'))).toHaveLength(1);
  });
});
