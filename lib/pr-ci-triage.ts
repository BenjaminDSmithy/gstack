/**
 * pr-ci-triage — decide whether a failed Windows Free Tests shard on an
 * upstream PR is a known runner flake, and only then draft the empty `ci:`
 * commit a fork contributor needs to get a fresh run (`gh run rerun` is
 * refused without admin rights on the upstream repo).
 *
 *   gstack-pr-ci-triage run   --pr <n|url> [--repo o/r] [--cwd <pr worktree>] [--run <id>]
 *   gstack-pr-ci-triage onset [--repo o/r] [--cwd <dir>] [--limit 200]
 *
 * Measured on #3032 (2026-10-05..07): exit 3 with no failing test and
 * "GetQueuedCompletionStatusEx: (735) ERROR_ABANDONED_WAIT_0" at the end of
 * the shard-log artifact (a Bun abort on Windows); a hang to the shard's
 * deadline with every test of the in-flight file passed; and a GLib abort
 * (exit 9). The step log does not show any of this; the artifacts do.
 *
 * A draft is written ONLY for a CRASH whose signature, exit code, empty
 * failingFiles and clean log all agree, or a HANG whose shard passed on an
 * earlier run of the identical tree. A failure that names a test is REAL
 * and gets the blame protocol instead. The onset scan is disclosure only:
 * these flakes appear on other branches at a background rate, so "it also
 * happened elsewhere" never clears a run. This helper never commits or
 * pushes; the commit goes through gstack-pr-sync's push path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PrContextError, defaultGh, defaultGit, parsePrRefFor, upstreamRepoFromGh, remoteForRepo, pinBranch, readPr,
  topicFor, prStateDir, envelope, stripControl, type GhRunner, type GitRunner, type PrInfo,
} from './pr-context';

export const TRIAGE_EXIT = { DRAFTED: 0, ERROR: 1, USAGE: 2, NO_DRAFT: 10, NOTHING: 11 } as const;

export const TRIAGE_USAGE = `gstack-pr-ci-triage <run|onset> [options]

  run     triage the newest failed Windows Free Tests run on the PR's head
          (or --run <id>): per failed shard, read windows-result-<n>, and
          for a no-failing-test exit the shard-log artifact; classify REAL,
          CRASH (IOCP or GLib signature), HANG, INFRA, AGGREGATE or UNKNOWN
  onset   count failed shards per UTC day across recent runs (disclosure
          only; never clears a run)

A ci: commit message is drafted only for a CRASH whose signature, exit
code (3 or 9), empty failingFiles and log (no "(fail)" before the abort)
agree, or a HANG whose shard passed on an earlier run of the same tree,
and only when the run is for the PR's current head with no newer run.

Exit codes: 0 drafted, 1 error, 2 usage, 10 triaged without a draft
(REAL, UNKNOWN, a stale run, or evidence missing), 11 nothing failed.`;

export const SHARD_JOB_RE = /^windows-free-shard \((\d+)(?:, \d+)?\)$/;
const IOCP_RE = /GetQueuedCompletionStatusEx: \(735\) ERROR_ABANDONED_WAIT_0/;
const GLIB_RE = /GLib-ERROR[^\n]*g_system_thread_free/;

export type ShardClass = 'REAL' | 'CRASH' | 'HANG' | 'INFRA' | 'UNKNOWN';

export interface ShardOutcome { status?: string; exitCode?: number | null; elapsedMs?: number; failingFiles?: string[] | null }

export interface ShardTriage {
  shard: number; klass: ShardClass; signature: 'IOCP' | 'GLib' | null; inFlight: string | null;
  failLines: number; outcome: ShardOutcome | null; why: string; sameTreeGreen: string | null;
}

/** The last `::group::<file>:` line opened in the log: the file bun was in when it stopped. */
export function inFlightFile(log: string): string | null {
  const groups = [...log.matchAll(/^::group::(.+?):?\s*$/gm)];
  const last = groups.at(-1);
  if (!last) return null;
  const after = log.slice(last.index! + last[0].length);
  return /^::endgroup::/m.test(after) ? null : last[1].replace(/\\/g, '/');
}

/** Pure: classify one failed shard from its result artifact and (when read) its log. */
export function classifyShard(shard: number, outcome: ShardOutcome | null, log: string | null): ShardTriage {
  const base = { shard, outcome, signature: null, inFlight: log ? inFlightFile(log) : null, failLines: log ? (log.match(/^\(fail\)/gm) ?? []).length : 0, sameTreeGreen: null };
  if (!outcome) return { ...base, klass: 'UNKNOWN', why: 'no windows-result artifact' };
  const failing = outcome.failingFiles ?? [];
  if (outcome.status === 'passed') return { ...base, klass: 'INFRA', why: 'the shard passed but its job failed: read the failing setup step' };
  if (outcome.status === 'failed' && failing.length) return { ...base, klass: 'REAL', why: `failing: ${failing.join(', ')}` };
  if (outcome.status === 'timed-out' && failing.length === 0) return { ...base, klass: 'HANG', why: `timed out after ${Math.round((outcome.elapsedMs ?? 0) / 1000)} s` };
  if (outcome.status === 'failed' && (outcome.exitCode === 3 || outcome.exitCode === 9) && failing.length === 0) {
    if (!log) return { ...base, klass: 'UNKNOWN', why: `exit ${outcome.exitCode} with no failing test, but no shard log to read` };
    const signature = IOCP_RE.test(log) ? 'IOCP' : GLIB_RE.test(log) ? 'GLib' : null;
    if (!signature) return { ...base, klass: 'UNKNOWN', why: `exit ${outcome.exitCode} with no failing test and no known abort signature` };
    return { ...base, signature, klass: 'CRASH', why: signature === 'IOCP' ? 'Bun aborted: GetQueuedCompletionStatusEx (735) ERROR_ABANDONED_WAIT_0' : 'GLib abort in g_system_thread_free' };
  }
  return { ...base, klass: 'UNKNOWN', why: `status ${outcome.status ?? '?'} exit ${outcome.exitCode ?? '?'} failing ${failing.length}` };
}

/** Pure: may this shard earn an empty ci: commit? */
export function draftable(t: ShardTriage): boolean {
  if (t.klass === 'CRASH') {
    return !!t.signature && (t.outcome?.exitCode === 3 || t.outcome?.exitCode === 9) && (t.outcome?.failingFiles ?? []).length === 0 && t.failLines === 0;
  }
  return t.klass === 'HANG' && !!t.sameTreeGreen;
}

export function draftMessage(x: { run: number; head: string; shard: ShardTriage; otherDrafts: number[] }): string {
  const t = x.shard;
  const what = t.klass === 'HANG' ? 'a hang' : t.signature === 'GLib' ? 'a GLib abort' : 'a Bun IOCP crash';
  const lines = [
    `ci: re-run CI after ${what} on windows-free-shard (${t.shard})`,
    '',
    `Windows Free Tests run ${x.run} on ${x.head.slice(0, 9)} failed in shard ${t.shard}`,
    `with no failing test: ${t.why}${t.inFlight ? `, in ${t.inFlight}` : ''}.`,
  ];
  if (t.klass === 'HANG') lines.push(`The same tree passed that shard in run ${t.sameTreeGreen}.`);
  if (x.otherDrafts.length) lines.push(`Shard(s) ${x.otherDrafts.join(', ')} of the same run failed the same way.`);
  lines.push('A fork contributor cannot re-run the job, so this empty commit triggers', 'a fresh run.', '');
  return lines.join('\n');
}

// ── deps ────────────────────────────────────────────────────────────────────

export interface TriageDeps { gh: GhRunner; git: GitRunner; env: NodeJS.ProcessEnv; out: (line: string) => void; tmp: () => string }

const realDeps = (): Omit<TriageDeps, 'tmp'> => ({
  gh: defaultGh, git: defaultGit, env: process.env, out: l => process.stdout.write(l + '\n'),
});

interface RunInfo { databaseId: number; headSha: string; headBranch?: string; event?: string; conclusion?: string; createdAt?: string; status?: string; jobs?: { databaseId: number; name: string; conclusion: string }[] }

function ghJson<T>(d: TriageDeps, args: string[], what: string): T {
  const r = d.gh(args);
  if (r.status !== 0) throw new PrContextError(`${what} failed: ${(r.error ?? r.stderr).trim().split('\n').at(-1)}`, 1);
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new PrContextError(`${what} printed no JSON`, 1);
  }
}

function download(d: TriageDeps, repo: string, run: number, name: string): string | null {
  const dir = d.tmp();
  const r = d.gh(['run', 'download', String(run), '-R', repo, '-n', name, '-D', dir]);
  if (r.status !== 0) return null;
  const files: string[] = [];
  const walk = (p: string) => {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) walk(q);
      else files.push(q);
    }
  };
  walk(dir);
  return files.length ? files.sort()[0] : null;
}

const RUN_FIELDS = 'databaseId,headSha,headBranch,event,conclusion,createdAt,status';

// ── run ─────────────────────────────────────────────────────────────────────

interface Flags { sub: string; pr: string | null; repo: string | null; cwd: string; run: number | null; limit: number }

function parseArgs(argv: string[]): Flags {
  const f: Flags = { sub: argv[0] ?? '', pr: null, repo: null, cwd: process.cwd(), run: null, limit: 200 };
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
    else if (a === '--run') {
      const v = val();
      if (!/^\d+$/.test(v)) throw new PrContextError('--run takes a numeric run id', 2);
      f.run = Number(v);
    } else if (a === '--limit') {
      const v = val();
      if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 500) throw new PrContextError('--limit takes 1-500', 2);
      f.limit = Number(v);
    } else throw new PrContextError(`unknown option ${a}`, 2);
  }
  return f;
}

function treeOf(d: TriageDeps, cwd: string, sha: string): string | null {
  const r = d.git(['rev-parse', `${sha}^{tree}`], { cwd });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** An earlier run, on a commit with the identical tree, whose same shard passed. */
function sameTreeGreen(d: TriageDeps, cwd: string, repo: string, pr: PrInfo, run: RunInfo, shard: number): string | null {
  const tree = treeOf(d, cwd, run.headSha);
  if (!tree) return null;
  const runs = ghJson<RunInfo[]>(d, ['run', 'list', '-R', repo, '--workflow', 'windows-free-tests.yml', '--branch', pr.headRef, '--limit', '30', '--json', RUN_FIELDS], 'gh run list');
  for (const r of runs) {
    if (r.databaseId === run.databaseId || r.headSha === run.headSha || treeOf(d, cwd, r.headSha) !== tree) continue;
    const view = ghJson<RunInfo>(d, ['run', 'view', String(r.databaseId), '-R', repo, '--json', 'databaseId,headSha,jobs'], 'gh run view');
    const job = (view.jobs ?? []).find(j => SHARD_JOB_RE.exec(j.name)?.[1] === String(shard));
    if (job?.conclusion === 'success') return String(r.databaseId);
  }
  return null;
}

function cmdRun(d: TriageDeps, f: Flags): number {
  if (!f.pr) throw new PrContextError('--pr is required', 2);
  const repo = f.repo ?? upstreamRepoFromGh(d.gh, f.cwd);
  const pr = readPr(d.gh, repo, parsePrRefFor(f.pr, repo));
  const headRemote = remoteForRepo(d.git, f.cwd, pr.headRepo);
  if (headRemote) pinBranch(d.git, f.cwd, headRemote, pr.headRef);
  const onHead = ghJson<RunInfo[]>(d, ['run', 'list', '-R', repo, '--workflow', 'windows-free-tests.yml', '--commit', pr.headOid, '--limit', '20', '--json', RUN_FIELDS], 'gh run list');
  const runId = f.run ?? onHead.find(r => r.conclusion === 'failure')?.databaseId ?? null;
  if (runId === null) {
    d.out(`RESULT NOTHING no failed Windows Free Tests run on ${pr.headOid.slice(0, 12)}`);
    return TRIAGE_EXIT.NOTHING;
  }
  const run = ghJson<RunInfo>(d, ['run', 'view', String(runId), '-R', repo, '--json', `${RUN_FIELDS},jobs`], 'gh run view');
  const stale: string[] = [];
  if (run.headSha !== pr.headOid) stale.push(`run ${runId} is for ${run.headSha.slice(0, 12)}, not the PR head ${pr.headOid.slice(0, 12)}`);
  const newer = onHead.filter(r => r.databaseId > runId);
  if (newer.length) stale.push(`a newer run on the head exists (${newer.map(r => `${r.databaseId} ${r.status ?? ''}/${r.conclusion ?? ''}`).join(', ')})`);
  const failed = (run.jobs ?? []).filter(j => j.conclusion === 'failure');
  const shards = failed.map(j => Number(SHARD_JOB_RE.exec(j.name)?.[1])).filter(n => Number.isInteger(n) && n > 0);
  if (!shards.length) {
    const aggregate = failed.some(j => j.name === 'windows-free-tests');
    d.out(`RESULT ${aggregate ? 'AGGREGATE' : 'NOTHING'} run=${runId} ${aggregate ? 'windows-free-tests failed with no failed shard: read its job log (plan, verify or a cancelled shard)' : 'no Windows shard failed'}`);
    return aggregate ? TRIAGE_EXIT.NO_DRAFT : TRIAGE_EXIT.NOTHING;
  }
  const triaged: ShardTriage[] = [];
  for (const n of shards) {
    const resFile = download(d, repo, runId, `windows-result-${n}`);
    let outcome: ShardOutcome | null = null;
    if (resFile) {
      try {
        outcome = (JSON.parse(fs.readFileSync(resFile, 'utf8')) as { outcome?: ShardOutcome }).outcome ?? null;
      } catch { /* unreadable artifact: UNKNOWN */ }
    }
    const needsLog = outcome && outcome.status !== 'passed' && (outcome.failingFiles ?? []).length === 0;
    const logFile = needsLog ? download(d, repo, runId, `windows-free-test-shard-logs-${n}`) : null;
    const log = logFile ? fs.readFileSync(logFile, 'utf8') : null;
    const t = classifyShard(n, outcome, log);
    if (t.klass === 'HANG') t.sameTreeGreen = sameTreeGreen(d, f.cwd, repo, pr, run, n);
    triaged.push(t);
    d.out(`SHARD\t${n}\t${t.klass}${t.signature ? `(${t.signature})` : ''}\t${t.why}${t.inFlight ? `\tin-flight ${t.inFlight}` : ''}${t.klass === 'HANG' ? `\tsame-tree-green ${t.sameTreeGreen ?? 'none'}` : ''}`);
    if (log) d.out(envelope(stripControl(log.split('\n').slice(-12).join('\n')), `ci-run-${runId}-shard-${n}`));
  }
  const ok = triaged.filter(draftable);
  const all = stale.length === 0 && ok.length === triaged.length;
  if (!all) {
    for (const s of stale) d.out(`STALE ${s}`);
    for (const t of triaged.filter(x => !draftable(x))) {
      if (t.klass === 'REAL') d.out(`BLAME shard ${t.shard}: run the failing file(s) on the PR head and on the base with gstack-pr-validate (declare them) before calling them pre-existing; a failure that passes on the base is this PR's`);
      else d.out(`NO_DRAFT shard ${t.shard} ${t.klass}: ${t.klass === 'HANG' ? 'no earlier run of this tree passed the shard' : t.why}`);
    }
    d.out(`RESULT NO_DRAFT run=${runId} shards=${triaged.map(t => `${t.shard}:${t.klass}`).join(',')}`);
    return TRIAGE_EXIT.NO_DRAFT;
  }
  const dir = prStateDir({ cwd: f.cwd, topic: topicFor(pr.headRef), env: d.env });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `ci-retrigger-${runId}.txt`);
  fs.writeFileSync(file, draftMessage({ run: runId, head: pr.headOid, shard: triaged[0], otherDrafts: triaged.slice(1).map(t => t.shard) }), { mode: 0o600 });
  d.out(`RESULT DRAFTED run=${runId} message=${file}`);
  d.out('NEXT with the owner\'s yes: `git commit --allow-empty -F <message>` on the PR branch (add the repo\'s trailer), then push it the same way a sync push goes (fast-forward, receipted), then publish the PR body (its facts name the new head)');
  return TRIAGE_EXIT.DRAFTED;
}

// ── onset ───────────────────────────────────────────────────────────────────

export interface DayCount { runs: number; failedRuns: number; crash: number; hang: number; real: number; other: number }

function cmdOnset(d: TriageDeps, f: Flags): number {
  const repo = f.repo ?? upstreamRepoFromGh(d.gh, f.cwd);
  const runs = ghJson<RunInfo[]>(d, ['run', 'list', '-R', repo, '--workflow', 'windows-free-tests.yml', '--limit', String(f.limit), '--json', RUN_FIELDS], 'gh run list')
    .filter(r => r.conclusion !== 'action_required' && r.conclusion !== 'cancelled' && r.status === 'completed');
  const days = new Map<string, DayCount>();
  let downloads = 0;
  const CAP = 60;
  for (const r of runs) {
    const day = (r.createdAt ?? '').slice(0, 10);
    const c = days.get(day) ?? { runs: 0, failedRuns: 0, crash: 0, hang: 0, real: 0, other: 0 };
    c.runs++;
    if (r.conclusion === 'failure') {
      c.failedRuns++;
      const view = ghJson<RunInfo>(d, ['run', 'view', String(r.databaseId), '-R', repo, '--json', 'databaseId,jobs'], 'gh run view');
      for (const j of (view.jobs ?? []).filter(x => x.conclusion === 'failure')) {
        const n = Number(SHARD_JOB_RE.exec(j.name)?.[1]);
        if (!Number.isInteger(n) || n < 1) continue;
        if (downloads >= CAP) { c.other++; continue; }
        downloads++;
        const res = download(d, repo, r.databaseId, `windows-result-${n}`);
        let outcome: ShardOutcome | null = null;
        try {
          outcome = res ? ((JSON.parse(fs.readFileSync(res, 'utf8')) as { outcome?: ShardOutcome }).outcome ?? null) : null;
        } catch { /* counted as other */ }
        let log: string | null = null;
        if (outcome && (outcome.exitCode === 3 || outcome.exitCode === 9) && downloads < CAP) {
          downloads++;
          const lf = download(d, repo, r.databaseId, `windows-free-test-shard-logs-${n}`);
          log = lf ? fs.readFileSync(lf, 'utf8') : null;
        }
        const t = classifyShard(n, outcome, log);
        if (t.klass === 'CRASH') c.crash++;
        else if (t.klass === 'HANG') c.hang++;
        else if (t.klass === 'REAL') c.real++;
        else c.other++;
      }
    }
    days.set(day, c);
  }
  d.out(`RESULT ONSET runs=${runs.length} downloads=${downloads}${downloads >= CAP ? ` (capped at ${CAP}; later shards counted as other)` : ''}`);
  for (const [day, c] of [...days.entries()].sort()) d.out(`DAY\t${day}\truns=${c.runs}\tfailed=${c.failedRuns}\tcrash=${c.crash}\thang=${c.hang}\treal=${c.real}\tother=${c.other}`);
  d.out('NOTE disclosure only: a flake rate elsewhere never clears a run on this PR');
  return 0;
}

export async function triageMain(argv: string[], deps: Partial<TriageDeps> = {}): Promise<number> {
  // Artifact downloads land under one scratch root, removed on the way out.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-ci-triage-'));
  try {
    return await triage(argv, { ...realDeps(), tmp: () => fs.mkdtempSync(path.join(scratch, 'a-')), ...deps });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

async function triage(argv: string[], d: TriageDeps): Promise<number> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    d.out(TRIAGE_USAGE);
    return argv.length ? 0 : TRIAGE_EXIT.USAGE;
  }
  try {
    const f = parseArgs(argv);
    if (f.sub === 'run') return cmdRun(d, f);
    if (f.sub === 'onset') return cmdOnset(d, f);
    throw new PrContextError(`unknown subcommand ${JSON.stringify(f.sub)}`, 2);
  } catch (error) {
    if (error instanceof PrContextError) {
      d.out(`RESULT ${error.code === 2 ? 'USAGE' : 'ERROR'} ${error.message}`);
      return error.code;
    }
    d.out(`RESULT ERROR ${(error as Error).message}`);
    return TRIAGE_EXIT.ERROR;
  }
}
