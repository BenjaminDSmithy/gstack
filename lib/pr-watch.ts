/**
 * pr-watch — notice a maintainer or bot signal on an open upstream PR before
 * it costs anything, and compare a PR's size with what upstream merges.
 *
 *   gstack-pr-watch poll    --pr <n|url> [--repo o/r] [--cwd <pr worktree>]
 *   gstack-pr-watch ack     --pr <n|url> [...] <signal id>@<level>...
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
 * Reads GitHub only (REST GETs, `gh pr list`). Git fetches the base branch,
 * and the PR head only when the checkout lacks its commit, into the private
 * refs/pr-prep namespace (pinBranch may drop an older nested pin there). It
 * writes the PR's state.json (latched signals and acks) and watch.json; no
 * receipts, the same as the other gh reads. Comment text reaches output
 * only inside the untrusted-content envelope.
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
  ack      record that the owner read these signals, each as <id>@<level>
           the way poll's NEXT line prints it; refused when a signal has
           latched at another level since (poll again and show it)
  enable   let the opt-in LaunchAgent (contrib/pr-watch) poll this PR
  disable  stop the LaunchAgent polling it
  size     churn, files and commits against contributor PRs merged among
           the last 200 merged (absorbed PRs are not sampled); under 20
           such PRs, the 2026-10-07 static thresholds

Signals: P0 SUPERSEDED (a maintainer or maintainer-proxy bot says the work
was rewritten, replaced, absorbed or will be closed; a maintainer or proxy
references it from a maintainer PR; while it is unmerged, upstream's base
branch cites it as (#N), or carries our trailer on a commit linked to it
or naming it as PR #N; closed unmerged). Our trailer is Co-authored-by
with the GitHub login as the name or its noreply address, or this
worktree's git user.name or user.email.
P1 ATTENTION (any other maintainer or proxy comment or review, a maintainer
mention from an issue or another contributor's PR, changes requested, a
merge conflict or a behind base, an owner commit referencing this PR, a
base commit naming it as PR #N without our trailer).
P2 informational (an external user's comment or cross-reference, our
trailer on a commit not linked to this PR). A latched P0/P1 keeps its
level until acknowledged, even when a later poll reads it lower (an
edited comment, a sender reclassified); its SIGNAL line then ends with
what it reads now.

Exit codes: 0 quiet (no unacknowledged P0/P1), 1 error, 2 usage,
10 unacknowledged P0, 11 unacknowledged P1, 12 UNVERIFIED (an endpoint
did not answer: never read as quiet), 30 precondition (this topic's
state or watch belongs to another PR; size: no remote for the repo),
40 size: the base branch is gone from the remote, 45 the PR lock is
busy (another poll or write is running; try again).`;

// ── classification ──────────────────────────────────────────────────────────

/**
 * Seeded maintainer proxies: bot accounts that merge, close and post closure
 * notices here, as `<app slug>[bot]`. Extended from mergedBy at poll time.
 */
export const SEED_PROXIES = ['capy-ai[bot]'];
export const INFRA_BOTS = ['github-actions', 'trunk-io', 'dependabot'];
const MAINTAINER_ASSOC = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
export const SUPERSEDE_RE = /will be closed when|clos(?:e|ed|ing) in favou?r of #\d+|superseded by #\d+|landed in v[\d.]+ via #\d+|rewr(?:ote|itten) (?:the fix|this|it)|fix[- ]wave|much smaller version|not part of the wave|replac(?:ed|es|ing) this PR|duplicate of #\d+|absorbed (?:into|from|in|by) |co-authored-by/i;

export type ActorClass = 'self' | 'maintainer' | 'proxy' | 'infra' | 'bot' | 'external';

/** GitHub logins are case-insensitive: `--repo Acme/gw` names the same owner as `acme`. */
function hasLogin(set: ReadonlySet<string> | readonly string[], login: string): boolean {
  const key = login.replace(/\[bot\]$/, '').toLowerCase();
  for (const x of set) if (x.toLowerCase() === key) return true;
  return false;
}

/**
 * What a proxy is matched on, lower-cased: a bot account as `<slug>[bot]`
 * (a `x[bot]` login, type Bot, or gh's `app/x` for a bot merger), anyone
 * else by login. The User account `capy-ai` is not the bot `capy-ai[bot]`:
 * matching on the bare name let any account named like a merge bot raise
 * a P0 with supersede wording.
 */
export function actorKey(login: string, isBot = false): string {
  const bot = isBot || /\[bot\]$/i.test(login) || /^app\//i.test(login);
  const base = login.replace(/\[bot\]$/i, '').replace(/^app\//i, '');
  return (bot ? `${base}[bot]` : base).toLowerCase();
}

export function classifyActor(a: { login?: string; type?: string; assoc?: string }, proxies: ReadonlySet<string>, self: string): ActorClass {
  const login = (a.login ?? '').replace(/\[bot\]$/, '');
  if (!login) return 'external';
  if (login.toLowerCase() === self.toLowerCase()) return 'self';
  const key = actorKey(a.login ?? '', a.type === 'Bot');
  for (const p of proxies) if (actorKey(p) === key) return 'proxy';
  if (hasLogin(INFRA_BOTS, login)) return 'infra';
  if (a.assoc && MAINTAINER_ASSOC.has(a.assoc)) return 'maintainer';
  if (a.type === 'Bot' || /\[bot\]$/.test(a.login ?? '')) return 'bot';
  return 'external';
}

export interface Signal {
  id: string; level: 'P0' | 'P1' | 'P2'; kind: string; at: string; ref: string; who: string; excerpt?: string;
  /** A latched signal that this poll reads at another level or kind: what it reads now, e.g. `P2 bot-comment`. */
  reads?: string;
}

interface Comment { id: number; user?: { login?: string; type?: string }; author_association?: string; created_at?: string; html_url?: string; body?: string }
interface Review { id: number; user?: { login?: string; type?: string }; author_association?: string; state?: string; submitted_at?: string; body?: string }
interface TimelineEvent {
  event?: string; actor?: { login?: string; type?: string } | null; created_at?: string; commit_id?: string | null;
  source?: { issue?: { number?: number; user?: { login?: string; type?: string }; author_association?: string; pull_request?: unknown } } | null;
}
interface PullState { state?: string; merged?: boolean; mergeable_state?: string; head?: { sha?: string }; closed_at?: string | null }

/**
 * A base commit that concerns this PR: `cites` the squash-merge form
 * `(#N)`, `mentions` upstream's absorption wording `PR #N` ("Absorbed from
 * PR #2640", "Contributed by @x (PR #N)", but also "VERSION drift: PR #N
 * claims v..."), `credit` our Co-authored-by trailer.
 */
export interface Absorbed { sha: string; credit: boolean; cites?: boolean; mentions?: boolean }

/**
 * Who the owner is in a Co-authored-by trailer: the GitHub login (as the
 * trailer's name, or as `[<id>+]<login>@users.noreply.github.com`), and the
 * git user.email and user.name of the PR worktree. Upstream credits both
 * ways: 28f1385ea as `BenjaminDSmithy <BenjaminDSmithy@users.noreply...>`,
 * ad8400543 (which absorbed #2640) as `Benjamin D. Smith <...@binarysword.com>`.
 */
export interface OwnerIds { login: string; emails: string[]; names: string[] }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Pure: does a commit message cite PR #n, name it as `PR #n`, and credit the owner (exact identities, never a login prefix)? */
export function absorptionOf(body: string, n: number, ids: OwnerIds): { cites: boolean; mentions: boolean; credit: boolean } {
  const cites = new RegExp(`\\(#${n}\\)`).test(body);
  const mentions = new RegExp(`\\bPR #${n}(?![0-9])`, 'i').test(body);
  const login = ids.login.toLowerCase();
  const noreply = new RegExp(`^(?:[0-9]+\\+)?${escapeRe(login)}@users\\.noreply\\.github\\.com$`, 'i');
  const emails = new Set(ids.emails.map(e => e.trim().toLowerCase()).filter(Boolean));
  const names = new Set([login, ...ids.names.map(x => x.trim().toLowerCase())].filter(Boolean));
  let credit = false;
  for (const line of body.split('\n')) {
    const m = /^\s*co-authored-by:\s*(.*?)\s*<([^<>]*)>\s*$/i.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    const name = m[1].trim().toLowerCase();
    const email = m[2].trim().toLowerCase();
    if ((login && noreply.test(email)) || emails.has(email) || names.has(name)) {
      credit = true;
      break;
    }
  }
  return { cites, mentions, credit };
}

export interface SignalInput {
  number: number; self: string; proxies: ReadonlySet<string>; maintainers: ReadonlySet<string>;
  pull: PullState; comments: Comment[]; reviews: Review[]; timeline: TimelineEvent[];
  /** Base commits since the merge base that cite `(#N)`, name `PR #N`, or carry our Co-authored-by trailer. */
  absorbed: Absorbed[];
}

const strong = (w: ActorClass) => w === 'maintainer' || w === 'proxy';

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
    // Supersede wording first: a review that requests changes and says the PR is superseded is still P0.
    if (strong(who) && SUPERSEDE_RE.test(r.body ?? '')) out.push({ ...base, level: 'P0', kind: 'superseded-review' });
    else if (r.state === 'CHANGES_REQUESTED') out.push({ ...base, level: 'P1', kind: 'changes-requested' });
    else if (strong(who)) out.push({ ...base, level: 'P1', kind: 'maintainer-review' });
  }
  for (const e of x.timeline) {
    const actor = e.actor?.login ?? '';
    const who = classifyActor({ login: actor, type: e.actor?.type, assoc: hasLogin(x.maintainers, actor) ? 'OWNER' : undefined }, x.proxies, x.self);
    const at = e.created_at ?? '';
    if (e.event === 'cross-referenced') {
      // Weighed by who made the reference (the actor), not by who wrote the
      // issue it was made in: anyone can mention #N in a comment on a
      // maintainer's PR. Only a maintainer or proxy referencing it from a
      // maintainer or proxy PR is SUPERSEDED.
      const src = e.source?.issue;
      if (!src?.number || src.number === x.number) continue;
      const srcLogin = src.user?.login ?? '';
      const srcWho = classifyActor({ login: srcLogin, type: src.user?.type, assoc: src.author_association ?? (hasLogin(x.maintainers, srcLogin) ? 'OWNER' : undefined) }, x.proxies, x.self);
      const actorWho = srcLogin && actor.toLowerCase() === srcLogin.toLowerCase() ? srcWho : who;
      const base = { id: `xref:${src.number}`, at, ref: `#${src.number}`, who: `${actor || '?'} (${actorWho})` };
      if (strong(actorWho) && strong(srcWho) && src.pull_request) out.push({ ...base, level: 'P0', kind: 'maintainer-cross-reference' });
      else if (strong(actorWho)) out.push({ ...base, level: 'P1', kind: 'maintainer-mention' });
      else if (actorWho !== 'self') out.push({ ...base, level: 'P2', kind: 'cross-reference' });
    } else if (e.event === 'referenced' && e.commit_id && (who === 'maintainer' || who === 'proxy')) {
      out.push({ id: `ref:${e.commit_id.slice(0, 12)}`, level: 'P1', kind: 'maintainer-commit-reference', at, ref: e.commit_id.slice(0, 12), who: `${actor} (${who})` });
    } else if (e.event === 'renamed') {
      out.push({ id: `renamed:${at}`, level: 'P2', kind: 'title-renamed', at, ref: '', who: `${actor} (${who})` });
    }
  }
  // Keyed on the close itself: once the owner acks one close, a reopen and a
  // second close is a new P0, not an id already acknowledged.
  if (x.pull.state === 'closed' && !x.pull.merged) {
    const at = x.pull.closed_at ?? '';
    out.push({ id: at ? `closed-unmerged:${at}` : 'closed-unmerged', level: 'P0', kind: 'closed-unmerged', at, ref: '', who: '' });
  }
  // Our trailer alone is not this PR's absorption: upstream credits the owner
  // per PR, so 28f1385ea's credit for #3032 sits on the base of every other
  // open PR too. It counts only when the commit cites (#N), names `PR #N`
  // (ad8400543: "Absorbed from PR #2640"), or GitHub linked it to this PR
  // with a `referenced` event; otherwise it is information. `PR #N` without
  // our credit is attention, not SUPERSEDED: upstream also writes version
  // queue notes that way ("VERSION drift: PR #N claims v...").
  const linked = new Set(x.timeline.filter(e => e.event === 'referenced' && e.commit_id).map(e => e.commit_id as string));
  for (const a of x.absorbed) {
    const id = `absorbed:${a.sha.slice(0, 12)}`;
    if (a.cites || (a.credit && (a.mentions || linked.has(a.sha)))) {
      out.push({ id, level: 'P0', kind: a.credit ? 'absorbed-with-credit' : 'cited-on-base', at: '', ref: a.sha.slice(0, 12), who: '' });
    } else if (a.mentions) {
      out.push({ id, level: 'P1', kind: 'named-on-base', at: '', ref: a.sha.slice(0, 12), who: '' });
    } else if (a.credit) {
      out.push({ id, level: 'P2', kind: 'credited-elsewhere', at: '', ref: a.sha.slice(0, 12), who: '' });
    }
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

/**
 * Below this many merged contributor PRs the p90 is mostly the largest one
 * (upstream's last 200 merged held 9 on 2026-10-08, one of churn 7058, which
 * lifted an interpolated p90 to churn 1679), so the static thresholds apply.
 */
export const LIVE_MIN = 20;

/**
 * GREEN within the merged-contributor p90 on churn and files; AMBER up to
 * the open-contributor p90 churn, or the green churn bound when a live one is
 * higher (so a bigger PR never reads better than a smaller one); RED beyond.
 */
export function sizeVerdict(ours: SizeSample, sample: SizeSample[]): { verdict: 'GREEN' | 'AMBER' | 'RED'; green: SizeSample; amberChurn: number; live: boolean } {
  const live = sample.length >= LIVE_MIN;
  const green = live ? { churn: percentile(sample.map(s => s.churn), 0.9), files: percentile(sample.map(s => s.files), 0.9) } : STATIC_GREEN;
  const amberChurn = Math.max(AMBER_CHURN, green.churn);
  const verdict = ours.churn <= green.churn && ours.files <= green.files ? 'GREEN' : ours.churn <= amberChurn ? 'AMBER' : 'RED';
  return { verdict, green, amberChurn, live };
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

/**
 * A read that did not answer: UNVERIFIED. Two PrContextErrors are not
 * reads and propagate with their own code: a busy PR lock (45), and a
 * topic state that belongs to another PR (30, readStateFor), which no
 * retry fixes and which the usage text documents as 30.
 */
const unverifiable = (error: unknown): boolean =>
  error instanceof UnverifiedError || (error instanceof PrContextError && error.code !== 45 && error.code !== 30);

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
const RANK = { P2: 0, P1: 1, P0: 2 } as const;

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
  const fresh = new Map<string, Signal>();
  for (const s of signals) {
    if (s.level === 'P2') continue;
    const entry = { id: s.id, level: s.level, kind: s.kind, at: s.at || now.toISOString(), ref: s.ref };
    const i = latched.findIndex(l => l.id === s.id);
    if (i === -1) {
      if (acked.includes(s.id)) continue;
      latched.push(entry);
      fresh.set(s.id, s);
    } else if (RANK[s.level] > RANK[latched[i].level]) {
      latched[i] = entry;
      acked = acked.filter(id => id !== s.id);
      fresh.set(s.id, s);
    }
  }
  return { latched, acked, fresh: [...fresh.values()] };
}

/**
 * The unacknowledged latches as this poll reports them: level, kind, time
 * and ref from the latch, which only ever rises; who and the excerpt from
 * this poll's reading of the same id, re-read each time. A later poll can
 * read a latched signal lower (its sender left the last-30 mergedBy proxy
 * window or lost COLLABORATOR, the comment was edited), and the exit code,
 * the LaunchAgent's notification and the write gate's reason must still
 * say what latched. Where ids repeat in one poll, the highest reading wins.
 */
function unackedFromLatch(latched: Latched[], acked: string[], signals: Signal[]): Signal[] {
  const byId = new Map<string, Signal>();
  for (const s of signals) {
    const cur = byId.get(s.id);
    if (!cur || RANK[s.level] > RANK[cur.level]) byId.set(s.id, s);
  }
  return latched.filter(l => !acked.includes(l.id)).map(l => {
    const cur = byId.get(l.id);
    const reads = cur && (cur.level !== l.level || cur.kind !== l.kind) ? `${cur.level} ${cur.kind}` : undefined;
    return { who: cur?.who ?? '', excerpt: cur?.excerpt, id: l.id, level: l.level, kind: l.kind, at: l.at, ref: l.ref, ...(reads ? { reads } : {}) };
  });
}

export interface PollResult { code: number; signals: Signal[]; fresh: Signal[]; unacked: Signal[]; state: string; error?: string }

/**
 * The PR head commit for the merge base: GitHub's headRefOid when this
 * checkout already has it (the usual case, and the only one left once a
 * closed PR's branch is deleted), else a pin of the head branch.
 */
function headCommit(d: WatchDeps, cwd: string, pr: PrInfo): string {
  const local = d.git(['cat-file', '-e', `${pr.headOid}^{commit}`], { cwd });
  if (!local.error && local.status === 0) return pr.headOid;
  if (!pr.headRepo) throw new UnverifiedError(`the head repository is deleted and ${pr.headOid.slice(0, 12)} is not in ${cwd}`);
  const head = remoteForRepo(d.git, cwd, pr.headRepo);
  if (!head) throw new UnverifiedError(`no git remote for ${pr.headRepo} in ${cwd}`);
  return pinBranch(d.git, cwd, head, pr.headRef).sha;
}

/** The owner's identities for the credit match: the GitHub login, plus the PR worktree's git user.email and user.name when set. */
function ownerIds(d: WatchDeps, cwd: string, login: string): OwnerIds {
  const get = (key: string) => {
    const r = d.git(['config', '--get', key], { cwd });
    return !r.error && r.status === 0 ? r.stdout.trim() : '';
  };
  const email = get('user.email');
  const name = get('user.name');
  return { login, emails: email ? [email] : [], names: name ? [name] : [] };
}

/**
 * Upstream base commits since the PR's merge base that cite `(#N)`, name
 * `PR #N`, or credit the owner. git pre-filters with two fixed strings
 * (`#N`, `co-authored-by:`), and absorptionOf reads each message exactly:
 * a fixed `co-authored-by: <login>` grep also matched longer logins
 * (dgrant hit dgrantham) and missed the name-form trailer.
 */
function absorbedOnBase(d: WatchDeps, cwd: string, repo: string, pr: PrInfo, self: string): Absorbed[] {
  const up = remoteForRepo(d.git, cwd, repo);
  if (!up) throw new UnverifiedError(`no git remote for ${repo} in ${cwd}`);
  const b = pinBranch(d.git, cwd, up, pr.baseRef).sha;
  const h = headCommit(d, cwd, pr);
  const mb = d.git(['merge-base', h, b], { cwd });
  if (mb.status !== 0) throw new UnverifiedError('git merge-base failed');
  const r = d.git(['log', '-F', '-i', `--grep=#${pr.number}`, '--grep=co-authored-by:', '--format=%H%x00%B%x1e', `${mb.stdout.trim()}..${b}`], { cwd });
  if (r.error || r.status !== 0) throw new UnverifiedError('git log failed');
  const ids = ownerIds(d, cwd, self);
  const out: Absorbed[] = [];
  for (const rec of r.stdout.split('\x1e')) {
    const at = rec.indexOf('\0');
    if (at === -1) continue;
    const sha = rec.slice(0, at).trim();
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) continue;
    const a = absorptionOf(rec.slice(at + 1), pr.number, ids);
    if (a.cites || a.mentions || a.credit) out.push({ sha, ...a });
  }
  return out;
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
    const merged = ghJson<{ mergedBy?: { login?: string; is_bot?: boolean } | null }[]>(d, ['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '30', '--json', 'mergedBy'], 'merged PRs');
    const owner = repo.split('/')[0];
    const proxies = new Set<string>(SEED_PROXIES);
    for (const m of merged) {
      const login = m.mergedBy?.login ?? '';
      if (!login) continue;
      const key = actorKey(login, m.mergedBy?.is_bot === true);
      const bare = key.replace(/\[bot\]$/, '');
      if (bare !== owner.toLowerCase() && !hasLogin(INFRA_BOTS, bare)) proxies.add(key);
    }
    const maintainers = new Set<string>([owner]);
    for (const c of [...comments, ...reviews]) if (c.author_association && MAINTAINER_ASSOC.has(c.author_association) && c.user?.login) maintainers.add(c.user.login);
    // The git half runs last and cannot discard what the REST reads found: a
    // definite P0/P1 outranks a failed scan (reported as error=), and a scan
    // failure with nothing else waiting is UNVERIFIED, never quiet.
    let absorbed: Absorbed[] = [];
    let scanError: string | undefined;
    if (!pull.merged) {
      try {
        absorbed = absorbedOnBase(d, cwd, repo, pr, self);
      } catch (error) {
        if (!unverifiable(error)) throw error;
        scanError = (error as Error).message;
      }
    }
    const signals = signalsFrom({ number: n, self, proxies, maintainers, pull, comments, reviews, timeline, absorbed });
    const dir = prStateDir({ cwd, topic: topicFor(pr.headRef), env: d.env });
    let fresh: Signal[] = [];
    let unacked: Signal[] = [];
    withPrLock(dir, () => {
      const st = readStateFor(dir, pr) ?? freshState(pr);
      const ack = latchSignals(st.signals, signals, d.now());
      fresh = ack.fresh;
      writeState(dir, { ...st, signals: { latched: ack.latched, acked: ack.acked } });
      unacked = unackedFromLatch(ack.latched, ack.acked, signals);
    });
    const code = unacked.some(s => s.level === 'P0') ? WATCH_EXIT.P0 : unacked.some(s => s.level === 'P1') ? WATCH_EXIT.P1
      : scanError ? WATCH_EXIT.UNVERIFIED : WATCH_EXIT.QUIET;
    return { code, signals, fresh, unacked, state: pull.merged ? 'merged' : (pull.state ?? '?'), error: scanError };
  } catch (error) {
    if (unverifiable(error)) {
      return { code: WATCH_EXIT.UNVERIFIED, signals: [], fresh: [], unacked: [], state: pr.state.toLowerCase(), error: (error as Error).message };
    }
    throw error;
  }
}

/** For writers: refuse unless a fresh poll answered on every endpoint, the PR is open, and nothing waits for the owner. */
export function pollForWrite(d: WatchDeps, repo: string, n: number, cwd: string): { ok: boolean; reason: string } {
  let r: PollResult;
  try {
    r = poll(d, repo, n, cwd);
  } catch (error) {
    // Another PR's state in this topic: a refusal with its reason, as before. A busy lock (45) still throws.
    if (error instanceof PrContextError && error.code === 30) return { ok: false, reason: error.message };
    throw error;
  }
  if (r.code === WATCH_EXIT.UNVERIFIED) return { ok: false, reason: `watch could not verify the PR (${r.error ?? 'unknown'})` };
  if (r.state !== 'open') return { ok: false, reason: `PR #${n} is ${r.state}` };
  if (r.unacked.length) return { ok: false, reason: `unacknowledged ${r.unacked.map(s => `${s.level} ${s.kind} [${s.id}]`).join(', ')}` };
  return { ok: true, reason: 'ok' };
}

// ── subcommands ─────────────────────────────────────────────────────────────

/** The ack token for a signal, as the NEXT line prints it: `<id>@<level>`. */
const ackToken = (s: { id: string; level: string }) => `${s.id}@${s.level}`;

function parseAckToken(token: string): { id: string; level: 'P0' | 'P1' } {
  const m = /^(.+)@(P[01])$/.exec(token);
  if (!m) throw new PrContextError(`ack ${token}: name the level the poll showed the owner, as <id>@<level> (for example ${token}@P0)`, 2);
  return { id: m[1], level: m[2] as 'P0' | 'P1' };
}

/**
 * The latch an ack token clears. An ack records what the owner was shown,
 * so it names the level too: a P1 the owner read, edited into a supersede
 * notice and latched again at P0 by a poll whose output nobody saw (the
 * LaunchAgent, another session's write gate), must not be cleared by the
 * ack of the P1. Any mismatch is refused (2) until a poll shows it again.
 */
function ackEntry(latched: Latched[], t: { id: string; level: 'P0' | 'P1' }): Latched {
  const l = latched.find(x => x.id === t.id);
  if (!l) throw new PrContextError(`not latched for this PR: ${t.id}`, 2);
  if (l.level !== t.level) {
    throw new PrContextError(`${t.id} is latched at ${l.level} ${l.kind}, not ${t.level}: poll again, show the owner the ${l.level}, then ack ${ackToken(l)}`, 2);
  }
  return l;
}

function printSignals(d: WatchDeps, r: PollResult, n: number): void {
  const word = r.code === WATCH_EXIT.P0 ? 'P0' : r.code === WATCH_EXIT.P1 ? 'P1' : r.code === WATCH_EXIT.UNVERIFIED ? 'UNVERIFIED' : 'QUIET';
  d.out(`RESULT ${word} pr=${n} state=${r.state} new=${r.fresh.length} unacknowledged=${r.unacked.length}${r.error ? ` error=${r.error}` : ''}`);
  for (const s of r.unacked) d.out(`SIGNAL\t${s.level}\t${s.id}\t${s.kind}\t${s.who}\t${s.ref}${s.reads ? `\tnow reads ${s.reads}` : ''}`);
  for (const s of r.signals.filter(x => x.level === 'P2')) d.out(`INFO\t${s.id}\t${s.kind}\t${s.who}`);
  // Every unacknowledged signal, not only this call's new ones: the LaunchAgent
  // and the write gate latch with their output discarded, so the owner's poll
  // is often not the first. The excerpt is re-read on each poll, never stored.
  for (const s of r.unacked) if (s.excerpt) d.out(envelope(s.excerpt, `pr-${n}-${s.id}`));
  // The ack names each signal at the level shown here (ackEntry refuses another).
  const ack = `gstack-pr-watch ack ${r.unacked.map(ackToken).join(' ')}`;
  if (r.unacked.some(s => s.level === 'P0')) {
    d.out(`NEXT stop every push and body publish for this PR, show the owner the signal, and suggest turning Auto-fix off; a follow-up PR is the owner's call. After the owner has read it: ${ack}`);
  } else if (r.unacked.length) {
    // A conflict latches like any P1 (the plan's pre-write gate), so it is acked
    // once the owner has seen it; only then can the sync push that fixes it pass.
    const conflict = r.unacked.some(s => s.kind.startsWith('mergeable-'));
    d.out(`NEXT show the owner each signal; writes for this PR refuse until then. After the owner has read it: ${ack}${conflict ? '; then the sync mode resolves the merge conflict or behind base' : ''}`);
  }
}

/**
 * The PR an existing watch.json names when that is another PR, else null
 * (absent, this PR, or unreadable: the runner skips an unreadable one, so
 * replacing or removing it loses nothing).
 */
function watchedElsewhere(file: string, repo: string, n: number): string | null {
  let w: { repo?: unknown; number?: unknown };
  try {
    w = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof w;
  } catch {
    return null;
  }
  if (typeof w?.repo !== 'string' || typeof w.number !== 'number') return null;
  return w.repo.toLowerCase() === repo.toLowerCase() && w.number === n ? null : `${w.repo}#${w.number}`;
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
    // Every git call is checked: a failed merge-base used to leave mb '' and
    // print a confident GREEN churn=0. The diff runs from the top level, so a
    // subdirectory cwd does not shrink the count to its own subtree.
    const run = (args: string[], cwd: string) => {
      const r = d.git(args, { cwd });
      if (r.error || r.status !== 0) throw new PrContextError(`git ${args[0]} failed: ${(r.error ?? r.stderr).trim().split('\n').at(-1) || `exit ${r.status}`}`, 1);
      return r.stdout.trim();
    };
    const top = run(['rev-parse', '--show-toplevel'], f.cwd);
    const mb = run(['merge-base', 'HEAD', base], top);
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(mb)) throw new PrContextError(`git merge-base printed no commit (got ${JSON.stringify(mb.slice(0, 80))})`, 1);
    const num = run(['diff', '--numstat', mb, 'HEAD', '--', '.', ...RELEASE_FILES.map(r => `:(exclude)${r}`)], top).split('\n').filter(Boolean);
    const commits = run(['rev-list', '--no-merges', '--count', `${mb}..HEAD`], top);
    if (!/^\d+$/.test(commits)) throw new PrContextError(`git rev-list printed no count (got ${JSON.stringify(commits.slice(0, 80))})`, 1);
    ours = {
      churn: num.reduce((s, l) => s + l.split('\t').slice(0, 2).reduce((a, x) => a + (Number(x) || 0), 0), 0),
      files: num.length,
      commits: Number(commits),
    };
  }
  const owner = repo.split('/')[0].toLowerCase();
  let sample: SizeSample[] = [];
  let note = '';
  try {
    const merged = ghJson<{ author?: { login?: string; is_bot?: boolean }; additions: number; deletions: number; changedFiles: number }[]>(
      d, ['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '200', '--json', 'author,additions,deletions,changedFiles'], 'merged PRs');
    sample = merged
      .filter(m => m.author?.login && m.author.login.toLowerCase() !== owner && !m.author.is_bot && !/^app\//.test(m.author.login))
      .map(m => ({ churn: m.additions + m.deletions, files: m.changedFiles }));
  } catch (error) {
    note = `NOTE baseline not read (${(error as Error).message}); using the 2026-10-07 static thresholds`;
  }
  const v = sizeVerdict(ours, sample);
  d.out(`RESULT ${v.verdict} churn=${ours.churn} files=${ours.files} commits=${ours.commits} (commits are shown, not scored: upstream squash-merges)`);
  if (note) d.out(note);
  d.out(`BASELINE ${v.live ? `${sample.length} merged contributor PRs` : sample.length ? `static 2026-10-07 (only ${sample.length} merged contributor PRs in the last 200 merged; a live p90 needs ${LIVE_MIN})` : 'static 2026-10-07'}: green up to churn ${Math.round(v.green.churn)} and ${Math.round(v.green.files)} files; amber up to churn ${Math.round(v.amberChurn)}`);
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
      if (!f.ids.length) throw new PrContextError('ack needs at least one signal, as <id>@<level>', 2);
      const tokens = f.ids.map(parseAckToken);
      return withPrLock(dir, () => {
        const st = readStateFor(dir, pr) ?? freshState(pr);
        const entries = tokens.map(t => ackEntry(st.signals.latched, t));
        writeState(dir, { ...st, signals: { latched: st.signals.latched, acked: [...new Set([...st.signals.acked, ...entries.map(l => l.id)])] } });
        d.out(`RESULT ACKED ${entries.map(l => `${l.id}@${l.level} ${l.kind}`).join(', ')}`);
        return 0;
      });
    }
    // One watch.json per topic dir, and topicFor folds `pr/x` and `x` together
    // (a fork PR and its upstream PR from one checkout): never replace or
    // remove a watch that names another PR.
    const watchFile = path.join(dir, 'watch.json');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return withPrLock(dir, () => {
      const other = watchedElsewhere(watchFile, repo, n);
      if (other) throw new PrContextError(`${watchFile} watches ${other}, not ${repo}#${n}; disable that one first`, 30);
      if (f.sub === 'enable') {
        fs.writeFileSync(watchFile, JSON.stringify({ v: 1, repo, number: n, cwd: f.cwd }, null, 2) + '\n', { mode: 0o600 });
        d.out(`RESULT ENABLED ${watchFile}`);
      } else {
        fs.rmSync(watchFile, { force: true });
        d.out(`RESULT DISABLED ${watchFile}`);
      }
      return 0;
    });
  } catch (error) {
    if (error instanceof PrContextError) {
      d.out(`RESULT ${error.code === 2 ? 'USAGE' : 'ERROR'} ${error.message}`);
      return error.code;
    }
    d.out(`RESULT ERROR ${(error as Error).message}`);
    return WATCH_EXIT.ERROR;
  }
}
