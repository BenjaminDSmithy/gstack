/**
 * pr-watch — notice a maintainer or bot signal on an open upstream PR before
 * it costs anything, and compare a PR's size with what upstream merges.
 *
 *   gstack-pr-watch poll    --pr <n|url> [--repo o/r] [--cwd <pr worktree>]
 *   gstack-pr-watch ack     --pr <n|url> [...] <signal id>...
 *   gstack-pr-watch enable  --pr <n|url> [...]     (the LaunchAgent polls it)
 *   gstack-pr-watch disable --pr <n|url> [...]
 *   gstack-pr-watch size    [--pr <n|url>] [--repo o/r] [--cwd <dir>]
 *
 * #3032: capy-ai[bot] (author_association CONTRIBUTOR, yet the account that
 * merges and closes) wrote that the fix wave had rewritten the fix 3h17m
 * before it closed the PR; the comment arrived during a usage-limit gap and
 * went unanswered. So signals are classified by who sent them, not only by
 * association, and a P0 latches in the PR state until the owner
 * acknowledges it: every pr-prep write refuses while one is unacknowledged.
 *
 * Reads only (REST GETs, `gh pr list`, git fetch of the pinned base); no
 * receipts are written, the same as the other gh reads. Comment text reaches
 * output only inside the untrusted-content envelope.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  PrContextError, RELEASE_FILES, defaultGh, defaultGit, parsePrRefFor, upstreamRepoFromGh, remoteForRepo,
  pinBranch, readPr, viewerLogin, topicFor, defaultBranchFromGh, prStateDir, readStateFor, writeState, withPrLock, envelope,
  type GhRunner, type GitRunner, type PrInfo, type PrState,
} from './pr-context';

export const WATCH_EXIT = { QUIET: 0, ERROR: 1, USAGE: 2, P0: 10, P1: 11, UNVERIFIED: 12 } as const;

export const WATCH_USAGE = `gstack-pr-watch <poll|ack|enable|disable|size> --pr <number|url> [options]

  poll     read comments, reviews, the timeline and the PR state (REST),
           plus upstream's base branch for commits that cite this PR or
           carry our Co-authored-by trailer; classify each signal; latch
           P0/P1 in the PR state
  ack      record that the owner acknowledged these signal ids
  enable   let the opt-in LaunchAgent (contrib/pr-watch) poll this PR
  disable  stop the LaunchAgent polling it
  size     churn, files and commits against merged contributor PRs

Signals: P0 SUPERSEDED (a maintainer or maintainer-proxy bot says the work
was rewritten, replaced or will be closed; a maintainer PR cross-references
this one; upstream's base branch cites it or carries our trailer while it
is unmerged; closed unmerged). P1 ATTENTION (any other maintainer or proxy
comment or review, changes requested, a merge conflict or a behind base,
an owner commit referencing this PR). P2 informational.

Exit codes: 0 quiet (no unacknowledged P0/P1), 1 error, 2 usage,
10 unacknowledged P0, 11 unacknowledged P1, 12 UNVERIFIED (an endpoint
did not answer: never read as quiet).`;

// ── classification ──────────────────────────────────────────────────────────

/** Seeded maintainer proxies: bots that merge, close and post closure notices here. Extended from mergedBy at poll time. */
export const SEED_PROXIES = ['capy-ai'];
export const INFRA_BOTS = ['github-actions', 'trunk-io', 'dependabot'];
const MAINTAINER_ASSOC = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
export const SUPERSEDE_RE = /will be closed when|clos(?:e|ed|ing) in favou?r of #\d+|superseded by #\d+|landed in v[\d.]+ via #\d+|rewr(?:ote|itten) (?:the fix|this|it)|fix[- ]wave|much smaller version|not part of the wave|replac(?:ed|es|ing) this PR|duplicate of #\d+|co-authored-by/i;

export type ActorClass = 'self' | 'maintainer' | 'proxy' | 'infra' | 'bot' | 'external';

export function classifyActor(a: { login?: string; type?: string; assoc?: string }, proxies: ReadonlySet<string>, self: string): ActorClass {
  const login = (a.login ?? '').replace(/\[bot\]$/, '');
  if (!login) return 'external';
  if (login.toLowerCase() === self.toLowerCase()) return 'self';
  if (proxies.has(login)) return 'proxy';
  if (INFRA_BOTS.includes(login)) return 'infra';
  if (a.assoc && MAINTAINER_ASSOC.has(a.assoc)) return 'maintainer';
  if (a.type === 'Bot' || /\[bot\]$/.test(a.login ?? '')) return 'bot';
  return 'external';
}

export interface Signal { id: string; level: 'P0' | 'P1' | 'P2'; kind: string; at: string; ref: string; who: string; excerpt?: string }

interface Comment { id: number; user?: { login?: string; type?: string }; author_association?: string; created_at?: string; html_url?: string; body?: string }
interface Review { id: number; user?: { login?: string; type?: string }; author_association?: string; state?: string; submitted_at?: string; body?: string }
interface TimelineEvent { event?: string; actor?: { login?: string; type?: string } | null; created_at?: string; commit_id?: string | null; source?: { issue?: { number?: number; user?: { login?: string } } } | null }
interface PullState { state?: string; merged?: boolean; mergeable_state?: string; head?: { sha?: string } }

export interface SignalInput {
  number: number; self: string; proxies: ReadonlySet<string>; maintainers: ReadonlySet<string>;
  pull: PullState; comments: Comment[]; reviews: Review[]; timeline: TimelineEvent[];
  absorbed: { sha: string; credit: boolean }[];
}

/** Pure: every signal in the inputs, with stable ids. */
export function signalsFrom(x: SignalInput): Signal[] {
  const out: Signal[] = [];
  for (const c of x.comments) {
    const who = classifyActor({ login: c.user?.login, type: c.user?.type, assoc: c.author_association }, x.proxies, x.self);
    const body = c.body ?? '';
    const base = { id: `comment:${c.id}`, at: c.created_at ?? '', ref: c.html_url ?? '', who: `${c.user?.login ?? '?'} (${who})`, excerpt: body.slice(0, 600) };
    if ((who === 'maintainer' || who === 'proxy') && SUPERSEDE_RE.test(body)) out.push({ ...base, level: 'P0', kind: 'superseded-comment' });
    else if (who === 'maintainer' || who === 'proxy') out.push({ ...base, level: 'P1', kind: 'maintainer-comment' });
    else if (who !== 'self') out.push({ ...base, level: 'P2', kind: `${who}-comment` });
  }
  for (const r of x.reviews) {
    const who = classifyActor({ login: r.user?.login, type: r.user?.type, assoc: r.author_association }, x.proxies, x.self);
    if (who === 'self') continue;
    const base = { id: `review:${r.id}`, at: r.submitted_at ?? '', ref: '', who: `${r.user?.login ?? '?'} (${who})`, excerpt: (r.body ?? '').slice(0, 600) };
    if (r.state === 'CHANGES_REQUESTED') out.push({ ...base, level: 'P1', kind: 'changes-requested' });
    else if ((who === 'maintainer' || who === 'proxy') && SUPERSEDE_RE.test(r.body ?? '')) out.push({ ...base, level: 'P0', kind: 'superseded-review' });
    else if (who === 'maintainer' || who === 'proxy') out.push({ ...base, level: 'P1', kind: 'maintainer-review' });
  }
  for (const e of x.timeline) {
    const actor = e.actor?.login ?? '';
    const who = classifyActor({ login: actor, type: e.actor?.type, assoc: x.maintainers.has(actor) ? 'OWNER' : undefined }, x.proxies, x.self);
    const at = e.created_at ?? '';
    if (e.event === 'cross-referenced') {
      const src = e.source?.issue;
      const srcWho = classifyActor({ login: src?.user?.login, assoc: x.maintainers.has(src?.user?.login ?? '') ? 'OWNER' : undefined }, x.proxies, x.self);
      if (src?.number && src.number !== x.number && (srcWho === 'maintainer' || srcWho === 'proxy')) {
        out.push({ id: `xref:${src.number}`, level: 'P0', kind: 'maintainer-cross-reference', at, ref: `#${src.number}`, who: `${src.user?.login ?? '?'} (${srcWho})` });
      }
    } else if (e.event === 'referenced' && e.commit_id && (who === 'maintainer' || who === 'proxy')) {
      out.push({ id: `ref:${e.commit_id.slice(0, 12)}`, level: 'P1', kind: 'maintainer-commit-reference', at, ref: e.commit_id.slice(0, 12), who: `${actor} (${who})` });
    } else if (e.event === 'renamed') {
      out.push({ id: `renamed:${at}`, level: 'P2', kind: 'title-renamed', at, ref: '', who: `${actor} (${who})` });
    }
  }
  if (x.pull.state === 'closed' && !x.pull.merged) out.push({ id: 'closed-unmerged', level: 'P0', kind: 'closed-unmerged', at: '', ref: '', who: '' });
  for (const a of x.absorbed) {
    out.push({ id: `absorbed:${a.sha.slice(0, 12)}`, level: 'P0', kind: a.credit ? 'absorbed-with-credit' : 'cited-on-base', at: '', ref: a.sha.slice(0, 12), who: '' });
  }
  const ms = x.pull.mergeable_state;
  if (x.pull.state === 'open' && (ms === 'dirty' || ms === 'behind')) {
    out.push({ id: `mergeable:${ms}:${(x.pull.head?.sha ?? '').slice(0, 12)}`, level: 'P1', kind: `mergeable-${ms}`, at: '', ref: '', who: '' });
  }
  return out;
}

// ── size ────────────────────────────────────────────────────────────────────

export interface SizeSample { churn: number; files: number }
export const STATIC_GREEN = { churn: 304, files: 24 };
export const AMBER_CHURN = 1793;

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const v = [...values].sort((a, b) => a - b);
  const idx = (v.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

export function rankOf(values: number[], x: number): number {
  return values.length ? Math.round((100 * values.filter(v => v <= x).length) / values.length) : 0;
}

/** GREEN within the merged-contributor p90 on churn and files; AMBER up to the open-contributor p90 churn; RED beyond. */
export function sizeVerdict(ours: SizeSample, sample: SizeSample[]): { verdict: 'GREEN' | 'AMBER' | 'RED'; green: SizeSample; live: boolean } {
  const live = sample.length >= 5;
  const green = live ? { churn: percentile(sample.map(s => s.churn), 0.9), files: percentile(sample.map(s => s.files), 0.9) } : STATIC_GREEN;
  const verdict = ours.churn <= green.churn && ours.files <= green.files ? 'GREEN' : ours.churn <= AMBER_CHURN ? 'AMBER' : 'RED';
  return { verdict, green, live };
}

// ── deps / context ──────────────────────────────────────────────────────────

export interface WatchDeps { gh: GhRunner; git: GitRunner; env: NodeJS.ProcessEnv; now: () => Date; out: (line: string) => void }

const realDeps = (): WatchDeps => ({ gh: defaultGh, git: defaultGit, env: process.env, now: () => new Date(), out: l => process.stdout.write(l + '\n') });

interface Flags { sub: string; pr: string | null; repo: string | null; cwd: string; ids: string[] }

function parseArgs(argv: string[]): Flags {
  const f: Flags = { sub: argv[0] ?? '', pr: null, repo: null, cwd: process.cwd(), ids: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new PrContextError(`${a} needs a value`, 2);
      return v;
    };
    if (a === '--pr') f.pr = val();
    else if (a === '--repo') f.repo = val();
    else if (a === '--cwd') f.cwd = path.resolve(val());
    else if (a.startsWith('--')) throw new PrContextError(`unknown option ${a}`, 2);
    else f.ids.push(a);
  }
  return f;
}

function ghJson<T>(d: WatchDeps, args: string[], what: string): T {
  const r = d.gh(args);
  if (r.status !== 0) throw new UnverifiedError(`${what}: ${(r.error ?? r.stderr).trim().split('\n').at(-1) ?? 'failed'}`);
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new UnverifiedError(`${what}: output is not JSON`);
  }
}

class UnverifiedError extends Error {}

const PAGE_SIZE = 100;
const MAX_PAGES = 30;

/**
 * Every item of a REST list, page by page until a short page. GitHub lists
 * comments and timeline events oldest first and `gh api` returns one page
 * per call, so a single read drops the newest items, which are the signals
 * (#3032's P0 cross-reference was timeline event 87 of 91). A list longer
 * than MAX_PAGES pages is UNVERIFIED, never a partial read reported quiet.
 */
function ghList<T>(d: WatchDeps, endpoint: string, what: string, headers: string[] = []): T[] {
  const all: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = ghJson<T[]>(d, ['api', ...headers, `${endpoint}?per_page=${PAGE_SIZE}&page=${page}`], `${what} page ${page}`);
    if (!Array.isArray(items)) throw new UnverifiedError(`${what} page ${page}: not a list`);
    all.push(...items);
    if (items.length < PAGE_SIZE) return all;
  }
  throw new UnverifiedError(`${what}: more than ${PAGE_SIZE * MAX_PAGES} items, the read stopped`);
}

function freshState(pr: PrInfo): PrState {
  return {
    v: 1, topic: topicFor(pr.headRef), repo: pr.repo, number: pr.number, headRef: pr.headRef, headOwner: pr.headOwner,
    headRemote: null, upstreamRemote: null, defaultBranch: pr.baseRef, focused: null, validation: null,
    bodyStaleSince: null, lastPublishedBodySha256: null, signals: { latched: [], acked: [] }, audit: null,
  };
}

// ── poll ────────────────────────────────────────────────────────────────────

type Latched = PrState['signals']['latched'][number];
const RANK = { P1: 1, P0: 2 } as const;

/**
 * Latch this poll's P0/P1 signals. A new id latches. An id already latched
 * at a lower level (a P1 comment edited into a supersede notice, which
 * keeps its comment id) latches again at the new level and loses its ack:
 * the owner acknowledged the P1 text, not the P0. Lower or equal levels
 * change nothing, so a latch only ever rises.
 */
function latchSignals(prev: PrState['signals'], signals: Signal[], now: Date): { latched: Latched[]; acked: string[]; fresh: Signal[] } {
  const latched: Latched[] = prev.latched.map(l => ({ ...l }));
  let acked = [...prev.acked];
  const fresh: Signal[] = [];
  for (const s of signals) {
    if (s.level === 'P2') continue;
    const entry = { id: s.id, level: s.level, kind: s.kind, at: s.at || now.toISOString(), ref: s.ref };
    const i = latched.findIndex(l => l.id === s.id);
    if (i === -1) {
      if (acked.includes(s.id)) continue;
      latched.push(entry);
      fresh.push(s);
    } else if (RANK[s.level] > RANK[latched[i].level]) {
      latched[i] = entry;
      acked = acked.filter(id => id !== s.id);
      fresh.push(s);
    }
  }
  return { latched, acked, fresh };
}

export interface PollResult { code: number; signals: Signal[]; fresh: Signal[]; unacked: Signal[]; state: string; error?: string }

/** Upstream base commits citing `(#N)` or carrying our trailer, since the PR's merge base. */
function absorbedOnBase(d: WatchDeps, cwd: string, repo: string, pr: PrInfo, self: string): { sha: string; credit: boolean }[] {
  const up = remoteForRepo(d.git, cwd, repo);
  const head = remoteForRepo(d.git, cwd, pr.headRepo);
  if (!up || !head) throw new UnverifiedError(`no git remote for ${up ? pr.headRepo : repo} in ${cwd}`);
  const b = pinBranch(d.git, cwd, up, pr.baseRef).sha;
  const h = pinBranch(d.git, cwd, head, pr.headRef).sha;
  const mb = d.git(['merge-base', h, b], { cwd });
  if (mb.status !== 0) throw new UnverifiedError('git merge-base failed');
  const log = (grep: string, fixed: boolean) => {
    const r = d.git(['log', fixed ? '-F' : '-E', '-i', `--grep=${grep}`, '--format=%H', `${mb.stdout.trim()}..${b}`], { cwd });
    if (r.status !== 0) throw new UnverifiedError('git log failed');
    return r.stdout.split('\n').filter(Boolean);
  };
  const cites = log(`\\(#${pr.number}\\)`, false);
  const credit = new Set(log(`co-authored-by: ${self}`, true));
  return [...new Set([...cites, ...credit])].map(sha => ({ sha, credit: credit.has(sha) }));
}

export function poll(d: WatchDeps, repo: string, n: number, cwd: string): PollResult {
  let pr: PrInfo;
  try {
    pr = readPr(d.gh, repo, n);
  } catch (error) {
    return { code: WATCH_EXIT.UNVERIFIED, signals: [], fresh: [], unacked: [], state: '?', error: (error as Error).message };
  }
  try {
    const self = viewerLogin(d.gh);
    const pull = ghJson<PullState>(d, ['api', `repos/${repo}/pulls/${n}`], 'pull');
    const comments = ghList<Comment>(d, `repos/${repo}/issues/${n}/comments`, 'comments');
    const reviews = ghList<Review>(d, `repos/${repo}/pulls/${n}/reviews`, 'reviews');
    const timeline = ghList<TimelineEvent>(d, `repos/${repo}/issues/${n}/timeline`, 'timeline', ['-H', 'Accept: application/vnd.github+json']);
    const merged = ghJson<{ mergedBy?: { login?: string } | null }[]>(d, ['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '30', '--json', 'mergedBy'], 'merged PRs');
    const owner = repo.split('/')[0];
    const proxies = new Set<string>(SEED_PROXIES);
    for (const m of merged) {
      const login = (m.mergedBy?.login ?? '').replace(/\[bot\]$/, '').replace(/^app\//, '');
      if (login && login.toLowerCase() !== owner.toLowerCase() && !INFRA_BOTS.includes(login)) proxies.add(login);
    }
    const maintainers = new Set<string>([owner]);
    for (const c of comments) if (c.author_association && MAINTAINER_ASSOC.has(c.author_association) && c.user?.login) maintainers.add(c.user.login);
    const absorbed = pull.merged ? [] : absorbedOnBase(d, cwd, repo, pr, self);
    const signals = signalsFrom({ number: n, self, proxies, maintainers, pull, comments, reviews, timeline, absorbed });
    const dir = prStateDir({ cwd, topic: topicFor(pr.headRef), env: d.env });
    let fresh: Signal[] = [];
    let unacked: Signal[] = [];
    withPrLock(dir, () => {
      const st = readStateFor(dir, pr) ?? freshState(pr);
      const ack = latchSignals(st.signals, signals, d.now());
      fresh = ack.fresh;
      writeState(dir, { ...st, signals: { latched: ack.latched, acked: ack.acked } });
      const byId = new Map(signals.map(s => [s.id, s]));
      unacked = ack.latched.filter(l => !ack.acked.includes(l.id)).map(l => byId.get(l.id) ?? { ...l, who: '' } as Signal);
    });
    const code = unacked.some(s => s.level === 'P0') ? WATCH_EXIT.P0 : unacked.some(s => s.level === 'P1') ? WATCH_EXIT.P1 : WATCH_EXIT.QUIET;
    return { code, signals, fresh, unacked, state: pull.merged ? 'merged' : (pull.state ?? '?') };
  } catch (error) {
    if (error instanceof UnverifiedError || (error instanceof PrContextError && error.code !== 45)) {
      return { code: WATCH_EXIT.UNVERIFIED, signals: [], fresh: [], unacked: [], state: pr.state.toLowerCase(), error: error.message };
    }
    throw error;
  }
}

/** For writers: refuse unless a fresh poll answered on every endpoint, the PR is open, and nothing waits for the owner. */
export function pollForWrite(d: WatchDeps, repo: string, n: number, cwd: string): { ok: boolean; reason: string } {
  const r = poll(d, repo, n, cwd);
  if (r.code === WATCH_EXIT.UNVERIFIED) return { ok: false, reason: `watch could not verify the PR (${r.error ?? 'unknown'})` };
  if (r.state !== 'open') return { ok: false, reason: `PR #${n} is ${r.state}` };
  if (r.unacked.length) return { ok: false, reason: `unacknowledged ${r.unacked.map(s => `${s.level} ${s.kind} [${s.id}]`).join(', ')}` };
  return { ok: true, reason: 'ok' };
}

// ── subcommands ─────────────────────────────────────────────────────────────

function printSignals(d: WatchDeps, r: PollResult, n: number): void {
  const word = r.code === WATCH_EXIT.P0 ? 'P0' : r.code === WATCH_EXIT.P1 ? 'P1' : r.code === WATCH_EXIT.UNVERIFIED ? 'UNVERIFIED' : 'QUIET';
  d.out(`RESULT ${word} pr=${n} state=${r.state} new=${r.fresh.length} unacknowledged=${r.unacked.length}${r.error ? ` error=${r.error}` : ''}`);
  for (const s of r.unacked) d.out(`SIGNAL\t${s.level}\t${s.id}\t${s.kind}\t${s.who}\t${s.ref}`);
  for (const s of r.signals.filter(x => x.level === 'P2')) d.out(`INFO\t${s.id}\t${s.kind}\t${s.who}`);
  // Every unacknowledged signal, not only this call's new ones: the LaunchAgent
  // and the write gate latch with their output discarded, so the owner's poll
  // is often not the first. The excerpt is re-read on each poll, never stored.
  for (const s of r.unacked) if (s.excerpt) d.out(envelope(s.excerpt, `pr-${n}-${s.id}`));
  if (r.unacked.some(s => s.level === 'P0')) {
    d.out('NEXT stop every push and body publish for this PR, show the owner the signal, and suggest turning Auto-fix off; a follow-up PR is the owner\'s call. After the owner has read it: gstack-pr-watch ack <id>');
  }
}

function cmdSize(d: WatchDeps, f: Flags): number {
  const repo = f.repo ?? upstreamRepoFromGh(d.gh, f.cwd);
  let ours: SizeSample & { commits: number };
  if (f.pr) {
    const n = parsePrRefFor(f.pr, repo);
    const p = ghJson<{ additions: number; deletions: number; changed_files: number; commits: number }>(d, ['api', `repos/${repo}/pulls/${n}`], 'pull');
    ours = { churn: p.additions + p.deletions, files: p.changed_files, commits: p.commits };
  } else {
    const up = remoteForRepo(d.git, f.cwd, repo);
    if (!up) throw new PrContextError(`no git remote in ${f.cwd} points at ${repo}`, 30);
    const base = pinBranch(d.git, f.cwd, up, defaultBranchFromGh(d.gh, repo)).sha;
    const mb = d.git(['merge-base', 'HEAD', base], { cwd: f.cwd }).stdout.trim();
    const num = d.git(['diff', '--numstat', mb, 'HEAD', '--', '.', ...RELEASE_FILES.map(r => `:(exclude)${r}`)], { cwd: f.cwd }).stdout.split('\n').filter(Boolean);
    ours = {
      churn: num.reduce((s, l) => s + l.split('\t').slice(0, 2).reduce((a, x) => a + (Number(x) || 0), 0), 0),
      files: num.length,
      commits: Number(d.git(['rev-list', '--no-merges', '--count', `${mb}..HEAD`], { cwd: f.cwd }).stdout.trim()),
    };
  }
  const owner = repo.split('/')[0].toLowerCase();
  let sample: SizeSample[] = [];
  try {
    const merged = ghJson<{ author?: { login?: string; is_bot?: boolean }; additions: number; deletions: number; changedFiles: number }[]>(
      d, ['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '200', '--json', 'author,additions,deletions,changedFiles'], 'merged PRs');
    sample = merged
      .filter(m => m.author?.login && m.author.login.toLowerCase() !== owner && !m.author.is_bot && !/^app\//.test(m.author.login))
      .map(m => ({ churn: m.additions + m.deletions, files: m.changedFiles }));
  } catch (error) {
    d.out(`NOTE baseline not read (${(error as Error).message}); using the 2026-10-07 static thresholds`);
  }
  const v = sizeVerdict(ours, sample);
  d.out(`RESULT ${v.verdict} churn=${ours.churn} files=${ours.files} commits=${ours.commits} (commits are shown, not scored: upstream squash-merges)`);
  d.out(`BASELINE ${v.live ? `${sample.length} merged contributor PRs` : 'static 2026-10-07'}: green up to churn ${Math.round(v.green.churn)} and ${Math.round(v.green.files)} files; amber up to churn ${AMBER_CHURN}`);
  if (sample.length) d.out(`RANK churn p${rankOf(sample.map(s => s.churn), ours.churn)}, files p${rankOf(sample.map(s => s.files), ours.files)} among merged contributor PRs`);
  return 0;
}

export async function watchMain(argv: string[], deps: Partial<WatchDeps> = {}): Promise<number> {
  const d = { ...realDeps(), ...deps };
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    d.out(WATCH_USAGE);
    return argv.length ? 0 : WATCH_EXIT.USAGE;
  }
  try {
    const f = parseArgs(argv);
    if (f.sub === 'size') return cmdSize(d, f);
    if (!['poll', 'ack', 'enable', 'disable'].includes(f.sub)) throw new PrContextError(`unknown subcommand ${JSON.stringify(f.sub)}`, 2);
    if (!f.pr) throw new PrContextError('--pr is required', 2);
    const repo = f.repo ?? upstreamRepoFromGh(d.gh, f.cwd);
    const n = parsePrRefFor(f.pr, repo);
    if (f.sub === 'poll') {
      const r = poll(d, repo, n, f.cwd);
      printSignals(d, r, n);
      return r.code;
    }
    const pr = readPr(d.gh, repo, n);
    const dir = prStateDir({ cwd: f.cwd, topic: topicFor(pr.headRef), env: d.env });
    if (f.sub === 'ack') {
      if (!f.ids.length) throw new PrContextError('ack needs at least one signal id', 2);
      return withPrLock(dir, () => {
        const st = readStateFor(dir, pr) ?? freshState(pr);
        const unknown = f.ids.filter(id => !st.signals.latched.some(l => l.id === id));
        if (unknown.length) throw new PrContextError(`not latched for this PR: ${unknown.join(', ')}`, 2);
        writeState(dir, { ...st, signals: { latched: st.signals.latched, acked: [...new Set([...st.signals.acked, ...f.ids])] } });
        d.out(`RESULT ACKED ${f.ids.join(' ')}`);
        return 0;
      });
    }
    const watchFile = path.join(dir, 'watch.json');
    if (f.sub === 'enable') {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(watchFile, JSON.stringify({ v: 1, repo, number: n, cwd: f.cwd }, null, 2) + '\n', { mode: 0o600 });
      d.out(`RESULT ENABLED ${watchFile}`);
    } else {
      fs.rmSync(watchFile, { force: true });
      d.out(`RESULT DISABLED ${watchFile}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof PrContextError) {
      d.out(`RESULT ${error.code === 2 ? 'USAGE' : 'ERROR'} ${error.message}`);
      return error.code;
    }
    d.out(`RESULT ERROR ${(error as Error).message}`);
    return WATCH_EXIT.ERROR;
  }
}
