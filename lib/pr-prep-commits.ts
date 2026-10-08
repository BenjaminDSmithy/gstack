/**
 * pr-prep-commits — the deterministic half of /pr-prep's duplicate audit:
 * which commits to audit, which earlier verdicts carry forward, which open
 * PR is this branch's own, and the stamped machine report /ship gates on.
 *
 *   gstack-pr-prep-commits list   --base <sha|ref> [--prior <report.json>] [--cwd <dir>]
 *   gstack-pr-prep-commits stamp  --base <sha|ref> --report <agent.json> --out <path>
 *                                 [--prior <report.json>] [--persist <path>] [--cwd <dir>]
 *   gstack-pr-prep-commits self   --head-ref <ref> --head-owner <login> [--pr <n>] < candidates.json
 *   gstack-pr-prep-commits paths  [--cwd <dir>]
 *
 * #3032's audit covered "the first 32 of the 42 commits" at 4 gh searches
 * per commit; the full 74 would have been about 296 calls against a search
 * secondary limit that trips at about 5 rapid calls. Merges, release-only
 * commits (a package.json change counts only when nothing but `version`
 * moved) and empty `ci:` re-runs carry no new work, and a commit whose
 * patch-id was audited before only needs the upstream items that are new
 * since then. Its earlier verdict carries forward, so `worst` never drops
 * because a commit was skipped; an UNVERIFIED or EXACT_DUP verdict is
 * searched in full again instead, since only a full search can confirm or
 * clear it, and a known EXACT_DUP stays until one runs. A re-run on an
 * open PR scored the PR itself as EXACT_DUP;
 * `self` drops it before scoring.
 */

import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteSync } from './fs-atomic';
import { PrContextError, RELEASE_FILES, defaultGit, prStateDir, topicFor, type GitRunner } from './pr-context';

export const BUCKETS = ['CLEAN', 'SIBLING', 'OVERLAP', 'UNVERIFIED', 'EXACT_DUP'] as const;
export type Bucket = (typeof BUCKETS)[number];
/**
 * The agent types its buckets by hand: `exact_dup`, `Exact-Dup` or a padded
 * `EXACT_DUP ` is still the verdict /ship blocks on, never an unknown one.
 */
const normBucket = (b: unknown) => String(b ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
const rank = (b: unknown) => BUCKETS.indexOf(normBucket(b) as Bucket);

/** The most severe bucket; an unknown one ranks as UNVERIFIED and the scan goes on. */
export function worstOf(buckets: readonly unknown[]): Bucket {
  let w = 0;
  for (const b of buckets) {
    const r = rank(b);
    w = Math.max(w, r < 0 ? rank('UNVERIFIED') : r);
  }
  return BUCKETS[w];
}

export interface PriorEntry { sha: string; patchId?: string; subject?: string; bucket: string; topScore?: number; hits?: unknown[] }
export interface PriorReport { generated_at?: string; base_sha?: string; head?: string; commits?: PriorEntry[]; audited?: { patchId: string; sha: string; bucket: string }[] }

export type Mode = 'NEW' | 'CARRY' | 'RECHECK';
/**
 * Verdicts a delta search cannot keep: UNVERIFIED was never searched, and
 * EXACT_DUP is defined over currently OPEN upstream PRs, so it must be
 * re-derived in full each run (the duplicate may have closed, or it was this
 * branch's own PR scored once because `self` could not run). Carrying it
 * would abort /ship forever.
 */
const RECHECK_BUCKETS: ReadonlySet<string> = new Set(['UNVERIFIED', 'EXACT_DUP']);
export interface AuditCommit { sha: string; subject: string; files: string[]; patchId: string; mode: Mode; since: string | null; prior: PriorEntry | null }
export interface CommitList { base: string; head: string; audit: AuditCommit[]; skipped: { sha: string; subject: string; reason: 'release-only' | 'empty' }[] }

function git(g: GitRunner, cwd: string, args: string[], input?: string): string {
  const r = g(args, { cwd, input });
  if (r.status !== 0) throw new PrContextError(`git ${args[0]} failed: ${(r.error ?? r.stderr).trim().split('\n').at(-1)}`, 1);
  return r.stdout;
}

/**
 * Prior entries keyed by patch-id (survives a rebase or a merge of the base)
 * and by sha. A key keeps every entry: a commit and its re-apply after a
 * revert share a patch-id, and neither verdict may overwrite the other.
 */
function priorIndex(prior: PriorReport | null): Map<string, PriorEntry[]> {
  const m = new Map<string, PriorEntry[]>();
  const add = (k: string, e: PriorEntry) => m.set(k, [...(m.get(k) ?? []), e]);
  if (!prior || typeof prior !== 'object') return m;
  const commits = (Array.isArray(prior.commits) ? prior.commits : []).filter(c => c && typeof c.sha === 'string');
  const bySha = new Map(commits.map(c => [c.sha, c]));
  for (const a of Array.isArray(prior.audited) ? prior.audited : []) {
    if (!a || typeof a.sha !== 'string' || typeof a.patchId !== 'string' || !a.patchId) continue;
    const c = bySha.get(a.sha);
    add(`p:${a.patchId}`, { ...(c ?? { sha: a.sha }), patchId: a.patchId, bucket: worstOf([a.bucket, ...(c ? [c.bucket] : [])]) });
  }
  for (const c of commits) add(`s:${c.sha}`, c);
  return m;
}

/** One commit's earlier entries (by its own sha and by its patch-id) folded: the worst bucket wins. */
function foldPrior(entries: PriorEntry[]): PriorEntry | null {
  if (!entries.length) return null;
  const bySha = new Map<string, PriorEntry>();
  for (const e of entries) {
    const had = bySha.get(e.sha);
    bySha.set(e.sha, had ? { ...had, bucket: worstOf([had.bucket, e.bucket]) } : e);
  }
  const all = [...bySha.values()];
  return { ...all[0], bucket: worstOf(all.map(e => e.bucket)), topScore: maxScore(all.map(e => e.topScore)), hits: dedupeHits(all.flatMap(e => (Array.isArray(e.hits) ? e.hits : []))) };
}

/** Hits once each, keyed by `ref` (or the whole hit when it has none); the first, i.e. newest, copy wins. */
function dedupeHits(hits: unknown[]): unknown[] {
  const seen = new Set<string>();
  return hits.filter(h => {
    const ref = h && typeof h === 'object' && typeof (h as { ref?: unknown }).ref === 'string' ? `r:${(h as { ref: string }).ref}` : `j:${JSON.stringify(h)}`;
    if (seen.has(ref)) return false;
    seen.add(ref);
    return true;
  });
}

function maxScore(scores: unknown[]): number {
  const n = scores.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  return n.length ? Math.max(...n) : 0;
}

/** package.json at <rev> with `version` dropped, or null when it is absent or not a JSON object. */
function manifestSansVersion(g: GitRunner, cwd: string, rev: string): string | null {
  const r = g(['show', `${rev}:package.json`], { cwd });
  if (r.status !== 0) return null;
  try {
    const o: unknown = JSON.parse(r.stdout);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    return JSON.stringify({ ...o, version: undefined });
  } catch {
    return null;
  }
}

/**
 * Only release files changed, and package.json (when touched) changed only
 * its `version`, the same rule sync's preconditions use. A package.json
 * commit that adds a script, a dependency or a bin entry is real work and
 * is audited; so is one whose manifest cannot be read on either side.
 */
function releaseOnly(g: GitRunner, cwd: string, sha: string, files: string[]): boolean {
  if (!files.every(f => RELEASE_FILES.includes(f))) return false;
  if (!files.includes('package.json')) return true;
  const after = manifestSansVersion(g, cwd, sha);
  return after !== null && after === manifestSansVersion(g, cwd, `${sha}^`);
}

export function listAuditCommits(g: GitRunner, cwd: string, base: string, prior: PriorReport | null): CommitList {
  const head = git(g, cwd, ['rev-parse', 'HEAD']).trim();
  const baseSha = git(g, cwd, ['rev-parse', `${base}^{commit}`]).trim();
  const shas = git(g, cwd, ['rev-list', '--no-merges', '--reverse', `${baseSha}..${head}`]).split('\n').filter(Boolean);
  const index = priorIndex(prior);
  const out: CommitList = { base: baseSha, head, audit: [], skipped: [] };
  for (const sha of shas) {
    const subject = git(g, cwd, ['log', '-1', '--format=%s', sha]).trim();
    const files = git(g, cwd, ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', sha]).split('\n').filter(Boolean);
    if (!files.length) { out.skipped.push({ sha, subject, reason: 'empty' }); continue; }
    if (releaseOnly(g, cwd, sha, files)) { out.skipped.push({ sha, subject, reason: 'release-only' }); continue; }
    const diff = git(g, cwd, ['show', '--format=', '--no-color', sha]);
    const patchId = diff ? (git(g, cwd, ['patch-id', '--stable'], diff).trim().split(/\s+/)[0] ?? '') : '';
    const entries = [...(index.get(`s:${sha}`) ?? []), ...(patchId ? (index.get(`p:${patchId}`) ?? []) : [])];
    const p = foldPrior(entries);
    let mode: Mode = 'NEW';
    // The search keywords come from the subject: a reworded commit (same diff,
    // new subject) was never searched under its new keywords.
    if (p) mode = RECHECK_BUCKETS.has(p.bucket) || !entries.some(e => e.subject === subject) ? 'RECHECK' : 'CARRY';
    out.audit.push({ sha, subject, files, patchId, mode, since: mode === 'CARRY' ? (prior?.generated_at ?? null) : null, prior: p });
  }
  return out;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `updated:>=YYYY-MM-DD` for a CARRY commit's searches; null means a full
 * search. `since` is when the last report was STAMPED, which is after its
 * searches ran: an audit that searched at 23:45Z and stamped at 00:05Z
 * would otherwise never search items updated in between. The window starts
 * a full day earlier, which covers any audit shorter than 24 h at the cost
 * of one extra day of results. A `since` that is not a date gives a full
 * search, never a qualifier built from its text.
 */
export function searchQualifier(c: AuditCommit): string | null {
  if (c.mode !== 'CARRY' || !c.since) return null;
  const t = Date.parse(c.since);
  return Number.isFinite(t) ? `updated:>=${new Date(t - DAY_MS).toISOString().slice(0, 10)}` : null;
}

export interface AgentReport { summary: string; worst?: string; commits: { sha: string; subject?: string; bucket: string; topScore?: number; hits?: unknown[] }[] }

const SHA_PREFIX_RE = /^[0-9a-f]{7,64}$/i;

/**
 * Validate the agent's report and stamp what the agent never types: head,
 * base, time, the audited patch-ids. Every row counts: a commit takes the
 * worst of all its rows, a row for a skipped commit still counts toward
 * `worst`, and the agent's own `worst` is a floor. A row that names no
 * commit between the base and HEAD (a typo, a wrong --base, a sha rewritten
 * since `list`) or names it by fewer than 7 hex characters refuses the whole
 * report (code 2): dropping it could hide an EXACT_DUP. A CARRY commit's
 * bucket is the worse of its prior verdict and the delta search; a commit the
 * agent did not report is UNVERIFIED, except that a RECHECK of a known
 * EXACT_DUP keeps it (and its hits) until a full search returns a verdict.
 */
export function stampReport(agent: unknown, list: CommitList, now: Date): Record<string, unknown> {
  const a = agent as AgentReport;
  if (!a || typeof a !== 'object' || typeof a.summary !== 'string' || !Array.isArray(a.commits)) {
    throw new PrContextError('the report needs {summary: string, commits: [...]}', 2);
  }
  const known = [...list.audit.map(c => c.sha), ...list.skipped.map(s => s.sha)];
  const rows = a.commits.map((r, i) => {
    if (!r || typeof r !== 'object' || typeof r.sha !== 'string' || !SHA_PREFIX_RE.test(r.sha)) {
      throw new PrContextError(`commits[${i}].sha must be 7 or more hex characters of a listed commit`, 2);
    }
    const prefix = r.sha.toLowerCase();
    const n = known.filter(s => s.startsWith(prefix)).length;
    if (n === 0) throw new PrContextError(`commits[${i}] (${prefix}) is not a commit between --base and HEAD: re-run list and audit the commits it prints`, 2);
    if (n > 1) throw new PrContextError(`commits[${i}] (${prefix}) matches ${n} commits: give more of the sha`, 2);
    return { ...r, sha: prefix };
  });
  const rowsFor = (sha: string) => rows.filter(r => sha.startsWith(r.sha));
  const commits = list.audit.map(c => {
    const got = rowsFor(c.sha);
    let bucket: string = got.length ? worstOf(got.map(r => r.bucket)) : 'UNVERIFIED';
    // A RECHECK re-derives the verdict, but only a full search that ran can
    // clear a known EXACT_DUP: a failed search (UNVERIFIED) or a missing
    // row says nothing about whether the duplicate closed.
    const keepsDup = c.mode === 'RECHECK' && c.prior?.bucket === 'EXACT_DUP' && bucket === 'UNVERIFIED';
    const carried = c.prior && (c.mode === 'CARRY' || keepsDup) ? c.prior : null;
    if (carried) bucket = worstOf([bucket, carried.bucket]);
    // The delta search's hits come first, so a re-found item keeps its newest state.
    const hits = dedupeHits([...got.flatMap(r => (Array.isArray(r.hits) ? r.hits : [])), ...(carried && Array.isArray(carried.hits) ? carried.hits : [])]);
    return { sha: c.sha, subject: c.subject, bucket, mode: c.mode, topScore: maxScore([...got.map(r => r.topScore), carried?.topScore]), hits };
  });
  const skipped = list.skipped.map(s => {
    const got = rowsFor(s.sha);
    return got.length ? { ...s, bucket: worstOf(got.map(r => r.bucket)) } : s;
  });
  const declared = a.worst === undefined || a.worst === null ? [] : [String(a.worst)];
  const worst = worstOf([...commits.map(c => c.bucket), ...skipped.flatMap(s => ('bucket' in s ? [s.bucket] : [])), ...declared]);
  return {
    summary: a.summary, worst, commits,
    skipped,
    head: list.head, base_sha: list.base, generated_at: now.toISOString(),
    audited: list.audit.map((c, i) => ({ patchId: c.patchId, sha: c.sha, bucket: commits[i].bucket })),
  };
}

export interface Candidate { number?: number; headRefName?: string; headRepositoryOwner?: { login?: string } | null; author?: { login?: string } | null }

/** Drop the branch's own open PR (by number, or by head ref plus head owner). */
export function dropSelf<T extends Candidate>(cands: T[], self: { number?: number | null; headRef: string; headOwner: string }): T[] {
  return cands.filter(c => {
    if (self.number && c.number === self.number) return false;
    const owner = c.headRepositoryOwner?.login ?? c.author?.login ?? '';
    return !(c.headRefName === self.headRef && owner.toLowerCase() === self.headOwner.toLowerCase());
  });
}

/**
 * The report lands through fs-atomic: a temp name with a random suffix (the
 * /ship --out lives in a shared /tmp, where a predictable name could be a
 * planted symlink), mode 0600, cleaned up on failure. A directory this
 * creates is 0700, the state-dir mode writeState expects; the audit usually
 * runs before any lifecycle mode, so it creates pr-drafts/<topic> first.
 */
function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  atomicWriteSync(file, text, { mode: 0o600 });
}

function readJson<T>(file: string | null): T | null {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    throw new PrContextError(`${file} is not JSON`, 2);
  }
}

export const COMMITS_USAGE = `gstack-pr-prep-commits <list|stamp|self|paths> [options]

  list    commits to audit between --base and HEAD (merges excluded):
          NEW (full searches), CARRY (audited before with a verdict: search
          only items updated since the day before that audit's stamp, keep
          the old verdict), RECHECK (audited
          before as UNVERIFIED or EXACT_DUP, or under another subject:
          full searches, the verdict is re-derived, but a known EXACT_DUP
          stays until a full search returns a verdict); release-only commits
          (only VERSION, CHANGELOG.md, the agents digest, and package.json
          with nothing but its version changed) and empty commits are
          skipped and listed
  stamp   validate the agent's report (JSON file), fold CARRY verdicts in
          (worst never drops), take a commit's worst row, count rows for
          skipped commits and the report's own worst, mark unreported
          commits UNVERIFIED, refuse a row that names no listed or skipped
          commit by 7+ hex characters; stamp head, base_sha, generated_at
          and audited patch-ids; write --out, then --persist (the next
          list's prior), atomically; a failed --persist is a WARN line,
          never a failed stamp
  self    drop this branch's own open PR from a candidate list on stdin
  paths   print the default persistent report path for this branch

list prints \`RESULT OK <n> to audit, <m> skipped\` and then the JSON;
stamp prints \`RESULT OK <worst> <out>\` and then the \`PR_PREP_REPORT:\`
line. self and paths print only their data (it is redirected to a file
or read as a path). Any failure prints \`RESULT USAGE|ERROR <why>\`.

Exit codes: 0 ok, 1 git failure, 2 usage or a malformed report.`;

export async function commitsMain(argv: string[], deps: { git?: GitRunner; out?: (l: string) => void; stdin?: () => string; env?: NodeJS.ProcessEnv; now?: () => Date } = {}): Promise<number> {
  const g = deps.git ?? defaultGit;
  const out = deps.out ?? (l => process.stdout.write(l + '\n'));
  const env = deps.env ?? process.env;
  const sub = argv[0] ?? '';
  const flags: Record<string, string> = {};
  try {
    if (!sub || argv.includes('--help')) {
      out(COMMITS_USAGE);
      return sub ? 0 : 2;
    }
    for (let i = 1; i < argv.length; i++) {
      const k = argv[i];
      if (!k.startsWith('--') || argv[i + 1] === undefined) throw new PrContextError(`bad argument ${k}`, 2);
      flags[k.slice(2)] = argv[++i];
    }
    const cwd = path.resolve(flags.cwd ?? process.cwd());
    const persistDefault = () => {
      const branch = git(g, cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
      return path.join(prStateDir({ cwd, topic: topicFor(branch), env }), 'audit.json');
    };
    if (sub === 'paths') {
      out(persistDefault());
      return 0;
    }
    if (sub === 'self') {
      if (!flags['head-ref'] || !flags['head-owner']) throw new PrContextError('self needs --head-ref and --head-owner', 2);
      const raw = (deps.stdin ?? (() => fs.readFileSync(0, 'utf8')))();
      let cands: Candidate[];
      try {
        cands = JSON.parse(raw);
      } catch {
        throw new PrContextError('stdin is not a JSON array', 2);
      }
      if (!Array.isArray(cands)) throw new PrContextError('stdin is not a JSON array', 2);
      out(JSON.stringify(dropSelf(cands, { number: flags.pr ? Number(flags.pr) : null, headRef: flags['head-ref'], headOwner: flags['head-owner'] })));
      return 0;
    }
    if (!flags.base) throw new PrContextError('--base is required', 2);
    const prior = readJson<PriorReport>(flags.prior ?? (fs.existsSync(persistDefault()) ? persistDefault() : null));
    const list = listAuditCommits(g, cwd, flags.base, prior);
    if (sub === 'list') {
      // The prior's hits hold upstream-authored titles; the model needs only
      // the carried bucket, so no tracker text is printed here at all.
      const audit = list.audit.map(c => ({
        sha: c.sha, subject: c.subject, files: c.files, patchId: c.patchId, mode: c.mode, since: c.since,
        qualifier: searchQualifier(c), prior: c.prior ? { bucket: worstOf([c.prior.bucket]) } : null,
      }));
      out(`RESULT OK ${audit.length} to audit, ${list.skipped.length} skipped`);
      out(JSON.stringify({ ...list, audit }, null, 2));
      return 0;
    }
    if (sub === 'stamp') {
      if (!flags.report || !flags.out) throw new PrContextError('stamp needs --report and --out', 2);
      const report = stampReport(readJson(flags.report), list, (deps.now ?? (() => new Date()))());
      const text = JSON.stringify(report) + '\n';
      // The /ship report first: it is what the gate reads. The persistent
      // copy only feeds the next run's carry, so its failure must not make
      // the helper (and the template) call a valid report "not written".
      writeAtomic(flags.out, text);
      let warn: string | null = null;
      try {
        writeAtomic(flags.persist ?? persistDefault(), text);
      } catch (error) {
        warn = `WARN the persistent copy was not written (${(error as Error).message.split('\n')[0]}): the next list carries from the older copy, if any, and audits the rest in full`;
      }
      out(`RESULT OK ${String(report.worst)} ${flags.out}`);
      out(`PR_PREP_REPORT: ${flags.out} (${String(report.worst)})`);
      if (warn) out(warn);
      return 0;
    }
    throw new PrContextError(`unknown subcommand ${JSON.stringify(sub)}`, 2);
  } catch (error) {
    if (error instanceof PrContextError) {
      out(`RESULT ${error.code === 2 ? 'USAGE' : 'ERROR'} ${error.message}`);
      return error.code;
    }
    out(`RESULT ERROR ${(error as Error).message}`);
    return 1;
  }
}
