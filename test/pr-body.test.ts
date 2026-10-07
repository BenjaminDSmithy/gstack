/**
 * gstack-pr-body: the facts block is the only home of volatile facts, the
 * owner's screenshot and ticked boxes survive every publish wherever they
 * sit (#3032 put the image at the top; #3066 in the Liveness section), a
 * live body someone else edited is never overwritten without the owner
 * seeing the diff, redaction runs on the exact bytes sent, and the
 * liveness check reads the live body. gh is faked in-process; git is real.
 */
import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeBody, renderFactsBlock, spliceFacts, carryLiveness, lostOwnerContent, lintBody, livenessOf,
  publishedVersions, bodyMain, FACTS_BEGIN, FACTS_END, sha256, type Facts,
} from '../lib/pr-body';
import { prStateDir, topicFor, readStateFor, type GhRunner } from '../lib/pr-context';
import { listReceipts } from '../lib/egress-receipt';

setDefaultTimeout(120_000);

const IMG32 = '<img width="355" height="83" alt="Screenshot" src="https://github.com/user-attachments/assets/f509953c-6960-4c43-9772-b8c581ca8276" />';
const IMG66 = '<img width="400" height="90" alt="Screenshot" src="https://github.com/user-attachments/assets/a3f4ccb0-1111-2222-3333-444455556666" />';
const BOX1_OPEN = '- [ ] Liveness screenshot attached (`GSTACK PR` typed live into a real surface) or PR author is @garrytan (owner exemption)';
const BOX1_DONE = BOX1_OPEN.replace('- [ ]', '- [x]');
const CHECKLIST = (box1: string) => `## Checklist\n\n${box1}\n- [x] This is not a generated-file-only diff (I edited the source/template and regenerated)\n`;
const LIVENESS = (inner: string) => `## Liveness proof (required for external contributors)\n\n${inner}\n\n`;

const TEMPLATE = `## Why (in your own words)\n\nBecause.\n\n## Live evidence\n\n{{FACTS}}\n\n## Scope\n\n- **Changed:** lib/x.ts\n\n${LIVENESS('Screenshot to follow from @me.')}${CHECKLIST(BOX1_OPEN)}`;

const FACTS: Facts = {
  at: '2026-10-08T01:00:00Z', head: 'c'.repeat(40), codeSha: 'b'.repeat(40), emptyCi: ['c'.repeat(40)],
  baseRef: 'main', baseSha: 'd'.repeat(40), baseVersion: '1.91.33.0', basePr: '#3059', version: '1.91.34.0',
  merges: [{ upstream: 'e'.repeat(40), version: '1.91.33.0', pr: '#3059' }],
  diff: { files: 7, lines: 568, patchId: 'f'.repeat(40), previousPatchId: 'f'.repeat(40) },
  commits: 8, validation: { sha: 'b'.repeat(40), worst: 0, summary: '15/15 selected files green' },
  ci: { pass: 46, fail: 0, pending: 0, skipping: 7, error: null },
};

describe('pure helpers', () => {
  test('normalizeBody: CRLF from a web save, trailing spaces, one final newline', () => {
    expect(normalizeBody('a  \r\nb\r\n\r\n\r\n')).toBe('a\nb\n');
    expect(normalizeBody('x')).toBe('x\n');
  });

  test('the facts block holds every volatile fact and no other PR\'s claim', () => {
    const block = renderFactsBlock(FACTS);
    expect(block.startsWith(FACTS_BEGIN) && block.endsWith(FACTS_END)).toBe(true);
    for (const s of ['cccccccccccc', 'bbbbbbbbbbbb', '1 commit after it is an empty `ci:` re-run', '`main` at `dddddddddddd` (v1.91.33.0, #3059)',
      '`VERSION` 1.91.34.0, above `main`\'s 1.91.33.0', 'Merges of `main` (1)', '7 files, 568 lines', 'unchanged since the last publish',
      'Commits: 8', 'Validation at `bbbbbbbbbbbb`: 15/15', '46 pass, 0 fail, 0 pending, 7 skipping']) {
      expect(block).toContain(s);
    }
    expect(block).not.toMatch(/claim/i);
    expect(renderFactsBlock({ ...FACTS, validation: { sha: 'a'.repeat(40), worst: 0, summary: 'x' } })).toContain('Validation: not run at this head.');
  });

  test('spliceFacts fills {{FACTS}} or replaces the previous block, and refuses a template with neither', () => {
    const once = spliceFacts(TEMPLATE, renderFactsBlock(FACTS));
    const again = spliceFacts(once, renderFactsBlock({ ...FACTS, commits: 9 }));
    expect(again).toContain('Commits: 9');
    expect(again.split(FACTS_BEGIN)).toHaveLength(2);
    expect(() => spliceFacts('no marker\n', 'x')).toThrow();
  });

  test('carryLiveness keeps the owner\'s attached section and ticked box (#3066 shape)', () => {
    const live = TEMPLATE.replace('Screenshot to follow from @me.', IMG66).replace(BOX1_OPEN, BOX1_DONE);
    const out = carryLiveness(TEMPLATE, live);
    expect(out).toContain(IMG66);
    expect(out).toContain(BOX1_DONE);
    expect(out).not.toContain('Screenshot to follow');
    expect(lostOwnerContent(live, out)).toEqual([]);
  });

  test('lostOwnerContent finds an image anywhere (#3032 put it at the top) and lost ticks', () => {
    const live = `## Liveness screenshot attached\n${IMG32}\n\n${TEMPLATE.replace(BOX1_OPEN, BOX1_DONE)}`;
    const lost = lostOwnerContent(live, TEMPLATE);
    expect(lost).toContain('attachment https://github.com/user-attachments/assets/f509953c-6960-4c43-9772-b8c581ca8276');
    expect(lost.some(l => l.startsWith('ticked: - [x] Liveness screenshot attached'))).toBe(true);
    expect(lostOwnerContent(live, live)).toEqual([]);
  });

  test('lint refuses version claims and "the head" in prose, not inside the facts block', () => {
    expect(lintBody('Version 1.91.30.0 is claimed by #3033.\n')).toHaveLength(1);
    expect(lintBody('This PR\'s head `06c53bff1` has three merges.\n')).toHaveLength(1);
    expect(lintBody('The head branch is pr/x.\n')).toEqual([]);
    expect(lintBody(spliceFacts(TEMPLATE, renderFactsBlock(FACTS)))).toEqual([]);
  });

  test('livenessOf and publishedVersions', () => {
    expect(livenessOf(TEMPLATE)).toEqual({ attached: [], ticked: false, placeholder: true });
    const done = TEMPLATE.replace('Screenshot to follow from @me.', IMG66).replace(BOX1_OPEN, BOX1_DONE);
    expect(livenessOf(done)).toMatchObject({ ticked: true, placeholder: false });
    expect(publishedVersions(['1.91.34.0\n', '# Changelog\n\n## [1.91.33.0] - 2026-10-06\n\n- x 1.2.3.4 y\n'])).toEqual(['1.91.33.0', '1.91.34.0']);
  });
});

// ── publish / render / check against a fixture PR ───────────────────────────

let ROOT = '';
beforeAll(() => {
  ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-body-')));
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

function fixture(name: string, liveInitial: string, opts: { state?: string; viewer?: string; webEditDropsImages?: boolean } = {}) {
  const base = path.join(ROOT, name);
  const up = path.join(base, 'up', 'acme', 'gx.git');
  const fork = path.join(base, 'fork', 'me', 'gx.git');
  const seed = path.join(base, 'seed');
  for (const b of [up, fork]) { fs.mkdirSync(b, { recursive: true }); git(b, 'init', '-q', '--bare', '-b', 'main'); }
  fs.mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  write(seed, 'VERSION', '1.0.0.0\n');
  write(seed, 'CHANGELOG.md', '# Changelog\n\n## [1.0.0.0] - 2026-10-01\n\n- base\n');
  write(seed, 'lib/x.ts', 'export const x = 1;\n');
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'base (#1)');
  git(seed, 'push', '-q', up, 'main'); git(seed, 'push', '-q', fork, 'main');
  git(seed, 'checkout', '-q', '-b', 'pr/b');
  write(seed, 'lib/x.ts', 'export const x = 2;\n');
  write(seed, 'VERSION', '1.0.1.0\n');
  write(seed, 'CHANGELOG.md', '# Changelog\n\n## [1.0.1.0] - 2026-10-02\n\n- ours\n\n## [1.0.0.0] - 2026-10-01\n\n- base\n');
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'feat: x');
  git(seed, 'checkout', '-q', 'main');
  write(seed, 'lib/other.ts', 'export {};\n');
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'main moves (#2)');
  git(seed, 'push', '-q', up, 'main');
  git(seed, 'checkout', '-q', 'pr/b');
  git(seed, 'merge', '-q', '--no-edit', 'main');
  git(seed, 'commit', '-q', '--allow-empty', '-m', 'ci: re-run after a Bun IOCP crash');
  git(seed, 'push', '-q', fork, 'pr/b');
  const clone = path.join(base, 'clone');
  git(base, 'clone', '-q', fork, clone);
  git(clone, 'remote', 'add', 'upstream', up);
  git(clone, 'checkout', '-q', 'pr/b');
  let live = liveInitial;
  const edits: string[] = [];
  const gh = ((args: string[]) => {
    const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });
    if (args[0] === 'pr' && args[1] === 'view') {
      return ok(JSON.stringify({ number: 9, state: opts.state ?? 'OPEN', isDraft: false, headRefOid: git(fork, 'rev-parse', 'refs/heads/pr/b'), url: 'https://github.com/acme/gx/pull/9', headRepositoryOwner: { login: 'me' }, headRepository: { name: 'gx' }, headRefName: 'pr/b', baseRefName: 'main' }));
    }
    if (args[0] === 'api' && args[1] === 'user') return ok(`${opts.viewer ?? 'me'}\n`);
    if (args[0] === 'api' && args[1] === 'repos/acme/gx/pulls/9' && args.includes('--jq')) return ok(live.endsWith('\n') ? live : `${live}\n`);
    // gstack-pr-watch's poll, run by the default pre-write gate: a quiet PR.
    if (args[0] === 'api' && args[1] === 'repos/acme/gx/pulls/9') return ok(JSON.stringify({ state: 'open', merged: false, mergeable_state: 'clean', head: { sha: 'x' } }));
    if (args[0] === 'api' && (args[1]?.startsWith('repos/acme/gx/issues/9/comments') || args[1]?.startsWith('repos/acme/gx/pulls/9/reviews'))) return ok('[]');
    if (args[0] === 'api' && args.some(a => a.startsWith('repos/acme/gx/issues/9/timeline'))) return ok('[]');
    if (args[0] === 'pr' && args[1] === 'list') return ok('[]');
    if (args[0] === 'pr' && args[1] === 'checks') return ok(JSON.stringify([{ name: 'free', bucket: 'pass', link: '' }, { name: 'win', bucket: 'fail', link: '' }, { name: 'docs', bucket: 'skipping', link: '' }]));
    if (args[0] === 'pr' && args[1] === 'edit') {
      const file = args[args.indexOf('--body-file') + 1];
      const sent = fs.readFileSync(file, 'utf8');
      edits.push(sent);
      live = opts.webEditDropsImages ? sent.replace(/<img[^>]*>/g, '') : sent;
      return ok('');
    }
    return { status: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  }) as GhRunner;
  const env = { ...process.env, GSTACK_STATE_ROOT: path.join(base, 'home') };
  const out: string[] = [];
  const http = async (url: string) => (url.includes('dead') ? 404 : 200);
  const call = (argv: string[]) => bodyMain([...argv, '--pr', '9', '--repo', 'acme/gx', '--cwd', clone], { gh, env, out: l => out.push(l), now: () => new Date('2026-10-08T01:00:00Z'), http });
  const dir = prStateDir({ cwd: clone, topic: topicFor('pr/b'), env });
  return { base, clone, out, call, dir, edits, getLive: () => live, env };
}
const prRef = { repo: 'acme/gx', number: 9, headRef: 'pr/b', headOwner: 'me' };

describe('facts and render', () => {
  test('facts measure the code commit under an empty ci: re-run, the merge of main, and CI counts', async () => {
    const f = fixture('facts', TEMPLATE);
    expect(await f.call(['facts'])).toBe(0);
    const facts = JSON.parse(fs.readFileSync(path.join(f.dir, 'facts.json'), 'utf8')) as Facts;
    expect(facts.emptyCi).toHaveLength(1);
    expect(facts.codeSha).toBe(git(f.clone, 'rev-parse', 'HEAD^'));
    expect(facts.merges).toHaveLength(1);
    expect(facts.merges[0]).toMatchObject({ version: '1.0.0.0', pr: '#2' });
    expect(facts).toMatchObject({ version: '1.0.1.0', baseVersion: '1.0.0.0', basePr: '#2', commits: 2 });
    expect(facts.diff.files).toBe(1);
    expect(facts.ci).toEqual({ pass: 1, fail: 1, pending: 0, skipping: 1, error: null });
  });

  test('render carries the attached liveness section; refuses when a live top image would be lost', async () => {
    const f = fixture('render', TEMPLATE.replace('Screenshot to follow from @me.', IMG66).replace(BOX1_OPEN, BOX1_DONE));
    fs.mkdirSync(f.dir, { recursive: true });
    fs.writeFileSync(path.join(f.dir, 'body.tmpl.md'), TEMPLATE);
    expect(await f.call(['render'])).toBe(0);
    const body = fs.readFileSync(f.out[0].match(/body=(\S+)/)![1], 'utf8');
    expect(body).toContain(IMG66);
    expect(body).toContain(BOX1_DONE);
    expect(body).toContain(FACTS_BEGIN);

    const g = fixture('render32', `## Liveness screenshot attached\n${IMG32}\n\n${TEMPLATE}`);
    fs.mkdirSync(g.dir, { recursive: true });
    fs.writeFileSync(path.join(g.dir, 'body.tmpl.md'), TEMPLATE);
    expect(await g.call(['render'])).toBe(20);
    expect(g.out.some(l => l.startsWith('LOST attachment') && l.includes('f509953c'))).toBe(true);
  });
});

describe('publish', () => {
  async function rendered(f: ReturnType<typeof fixture>, template = TEMPLATE): Promise<string> {
    fs.mkdirSync(f.dir, { recursive: true });
    fs.writeFileSync(path.join(f.dir, 'body.tmpl.md'), template);
    f.out.length = 0;
    expect(await f.call(['render'])).toBe(0);
    return f.out[0].match(/body=(\S+)/)![1];
  }

  test('needs --yes; the first publish over a hand-written body needs --accept-live-diff; then one edit, receipted', async () => {
    const f = fixture('pub', TEMPLATE.replace('Screenshot to follow from @me.', IMG66).replace(BOX1_OPEN, BOX1_DONE));
    const file = await rendered(f);
    expect(await f.call(['publish', '--body', file])).toBe(2);
    f.out.length = 0;
    expect(await f.call(['publish', '--body', file, '--yes'])).toBe(20);
    expect(f.out.join('\n')).toContain('BEGIN UNTRUSTED TRACKER CONTENT');
    expect(f.edits).toHaveLength(0);
    const home = path.join(f.base, 'home');
    expect(await f.call(['publish', '--body', file, '--yes', '--accept-live-diff'])).toBe(0);
    expect(f.edits).toHaveLength(1);
    expect(f.getLive()).toContain(IMG66);
    const st = readStateFor(f.dir, prRef)!;
    expect(st.lastPublishedBodySha256).toBe(sha256(normalizeBody(f.getLive())));
    expect(st.bodyStaleSince).toBeNull();
    expect(listReceipts(home).filter(r => r.sink === 'pr-prep').at(-1)).toMatchObject({ payload_class: 'pr-body-edit', status: 'exit:0' });
    // The second publish of an unchanged live body needs no live-diff acceptance.
    expect(await f.call(['publish', '--body', file, '--yes'])).toBe(0);
    expect(f.edits).toHaveLength(2);
  });

  test('a MEDIUM redaction finding blocks until the owner confirms its key; published versions are not findings', async () => {
    const f = fixture('redact', TEMPLATE);
    const tmpl = TEMPLATE.replace('Because.', 'Because the resolver at 8.8.8.8 and main\'s 1.0.0.0 differ.');
    const file = await rendered(f, tmpl);
    f.out.length = 0;
    expect(await f.call(['publish', '--body', file, '--yes', '--accept-live-diff'])).toBe(22);
    const keys = f.out.filter(l => l.startsWith('REDACTION MEDIUM')).map(l => l.split(' ')[2]);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toStartWith('pii.ip_public@');
    expect(f.edits).toHaveLength(0);
    expect(await f.call(['publish', '--body', file, '--yes', '--accept-live-diff', '--confirm-redaction', keys[0]])).toBe(0);
    expect(f.edits).toHaveLength(1);
  });

  test('lint, a closed PR and a read-back that lost the image all stop without a second edit', async () => {
    const f = fixture('lint', TEMPLATE);
    fs.mkdirSync(f.dir, { recursive: true });
    fs.writeFileSync(path.join(f.dir, 'body.tmpl.md'), TEMPLATE.replace('Because.', 'Because 1.0.2.0 is claimed by #12.'));
    expect(await f.call(['render'])).toBe(20);
    expect(f.out.some(l => l.startsWith('LINT') && l.includes('version claim'))).toBe(true);
    const bad = path.join(f.base, 'bad.md');
    fs.writeFileSync(bad, normalizeBody(spliceFacts(TEMPLATE.replace('Because.', 'Because 1.0.2.0 is claimed by #12.'), renderFactsBlock(FACTS))));
    expect(await f.call(['publish', '--body', bad, '--yes', '--accept-live-diff'])).toBe(20);
    expect(f.edits).toHaveLength(0);

    const closed = fixture('closed', TEMPLATE, { state: 'CLOSED' });
    const file = await rendered(closed);
    expect(await closed.call(['publish', '--body', file, '--yes', '--accept-live-diff'])).toBe(30);
    expect(closed.edits).toHaveLength(0);

    const web = fixture('web', TEMPLATE.replace('Screenshot to follow from @me.', IMG66), { webEditDropsImages: true });
    const wfile = await rendered(web);
    web.out.length = 0;
    expect(await web.call(['publish', '--body', wfile, '--yes', '--accept-live-diff'])).toBe(1);
    expect(web.edits).toHaveLength(1);
    expect(web.out.some(l => l.startsWith('VANISHED attachment'))).toBe(true);
    expect(fs.readdirSync(web.dir).some(n => n.startsWith('pr-body-restore-'))).toBe(true);
  });
});

describe('check (liveness)', () => {
  test('pending with the placeholder, attached when the image answers 200 and box 1 is ticked, exempt for the owner', async () => {
    expect(await fixture('c1', TEMPLATE).call(['check'])).toBe(40);
    const done = TEMPLATE.replace('Screenshot to follow from @me.', IMG66).replace(BOX1_OPEN, BOX1_DONE);
    expect(await fixture('c2', done).call(['check'])).toBe(0);
    expect(await fixture('c3', done.replace('a3f4ccb0-1111', 'deadbeef-dead')).call(['check'])).toBe(40);
    expect(await fixture('c4', TEMPLATE, { viewer: 'garrytan' }).call(['check'])).toBe(0);
  });
});

