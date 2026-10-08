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
 * commits and empty `ci:` re-runs carry no new work, and a commit whose
 * patch-id was audited before only needs the upstream items that are new
 * since then. Its earlier verdict carries forward, so `worst` never drops
 * because a commit was skipped. A re-run on an open PR scored the PR
 * itself as EXACT_DUP; `self` drops it before scoring.
 */

import fs from 'node:fs';
import path from 'node:path';
import { PrContextError, RELEASE_FILES, defaultGit, prStateDir, topicFor, type GitRunner } from './pr-context';

export const BUCKETS = ['CLEAN', 'SIBLING', 'OVERLAP', 'UNVERIFIED', 'EXACT_DUP'] as const;
export type Bucket = (typeof BUCKETS)[number];
const rank = (b: string) => BUCKETS.indexOf(b as Bucket);

/** The most severe bucket; an unknown one ranks as UNVERIFIED and the scan goes on. */
export function worstOf(buckets: readonly string[]): Bucket {
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
export interface AuditCommit { sha: string; subject: string; files: string[]; patchId: string; mode: Mode; since: string | null; prior: PriorEntry | null }
export interface CommitList { base: string; head: string; audit: AuditCommit[]; skipped: { sha: string; subject: string; reason: 'release-only' | 'empty' }[] }

function git(g: GitRunner, cwd: string, args: string[], input?: string): string {
  const r = g(args, { cwd, input });
  if (r.status !== 0) throw new PrContextError(`git ${args[0]} failed: ${(r.error ?? r.stderr).trim().split('\n').at(-1)}`, 1);
  return r.stdout;
}

/** Prior entries keyed by patch-id (survives a rebase or a merge of the base) and by sha. */
function priorIndex(prior: PriorReport | null): Map<string, PriorEntry> {
  const m = new Map<string, PriorEntry>();
  if (!prior) return m;
  const byShaBucket = new Map((prior.commits ?? []).map(c => [c.sha, c]));
  for (const a of prior.audited ?? []) {
    const entry = byShaBucket.get(a.sha) ?? { sha: a.sha, bucket: a.bucket };
    m.set(`p:${a.patchId}`, { ...entry, patchId: a.patchId, bucket: a.bucket });
  }
  for (const c of prior.commits ?? []) if (!m.has(`s:${c.sha}`)) m.set(`s:${c.sha}`, c);
  return m;
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
    if (files.every(f => RELEASE_FILES.includes(f))) { out.skipped.push({ sha, subject, reason: 'release-only' }); continue; }
    const diff = git(g, cwd, ['show', '--format=', '--no-color', sha]);
    const patchId = diff ? (git(g, cwd, ['patch-id', '--stable'], diff).trim().split(/\s+/)[0] ?? '') : '';
    const p = index.get(`p:${patchId}`) ?? index.get(`s:${sha}`) ?? null;
    let mode: Mode = 'NEW';
    if (p) mode = p.bucket === 'UNVERIFIED' || rank(p.bucket) < 0 ? 'RECHECK' : 'CARRY';
    out.audit.push({ sha, subject, files, patchId, mode, since: mode === 'CARRY' ? (prior?.generated_at ?? null) : null, prior: p });
  }
  return out;
}

/** `updated:>=YYYY-MM-DD` for a CARRY commit's searches; null means a full search. */
export function searchQualifier(c: AuditCommit): string | null {
  return c.mode === 'CARRY' && c.since ? `updated:>=${c.since.slice(0, 10)}` : null;
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
 * agent did not report is UNVERIFIED.
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
    if (c.mode === 'CARRY' && c.prior) bucket = worstOf([bucket, c.prior.bucket]);
    return { sha: c.sha, subject: c.subject, bucket, mode: c.mode, topScore: got[0]?.topScore ?? c.prior?.topScore ?? 0, hits: [...got.flatMap(r => (Array.isArray(r.hits) ? r.hits : [])), ...(c.mode === 'CARRY' ? (c.prior?.hits ?? []) : [])] };
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

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
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
          only items updated since, keep the old verdict), RECHECK (audited
          before as UNVERIFIED: full searches); release-only and empty
          commits are skipped and listed
  stamp   validate the agent's report (JSON file), fold CARRY verdicts in
          (worst never drops), take a commit's worst row, count rows for
          skipped commits and the report's own worst, mark unreported
          commits UNVERIFIED, refuse a row that names no listed or skipped
          commit by 7+ hex characters; stamp head, base_sha, generated_at
          and audited patch-ids; write --out (and --persist) atomically
  self    drop this branch's own open PR from a candidate list on stdin
  paths   print the default persistent report path for this branch

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
      out(JSON.stringify({ ...list, audit: list.audit.map(c => ({ ...c, qualifier: searchQualifier(c) })) }, null, 2));
      return 0;
    }
    if (sub === 'stamp') {
      if (!flags.report || !flags.out) throw new PrContextError('stamp needs --report and --out', 2);
      const report = stampReport(readJson(flags.report), list, (deps.now ?? (() => new Date()))());
      const text = JSON.stringify(report) + '\n';
      writeAtomic(flags.out, text);
      writeAtomic(flags.persist ?? persistDefault(), text);
      out(`PR_PREP_REPORT: ${flags.out} (${String(report.worst)})`);
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
