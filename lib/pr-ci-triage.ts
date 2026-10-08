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
 * "GetQueuedCompletionStatusEx: (735) ERROR_ABANDONED_WAIT_0" or "(6) The
 * handle is invalid." at the end of the shard-log artifact (a Bun abort on
 * Windows); a hang to the shard's
 * deadline with every test of the in-flight file passed; and a GLib abort
 * (exit 9). The step log does not show any of this; the artifacts do.
 *
 * A draft is written ONLY for a CRASH whose signature, exit code, empty
 * failingFiles and clean log all agree, or a HANG whose shard passed on an
 * earlier run of the identical tree, and in both cases only when the
 * runner's own count says the missing summary was the only failure. A failure that names a test is REAL
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
import { classifyBunTestOutputLine, stripAnsiLine } from '../scripts/lib/shard-engine';

export const TRIAGE_EXIT = { DRAFTED: 0, ERROR: 1, USAGE: 2, NO_DRAFT: 10, NOTHING: 11 } as const;

export const TRIAGE_USAGE = `gstack-pr-ci-triage <run|onset> [options]

  run     triage the newest failed Windows Free Tests run on the PR's head
          (or --run <id>): per failed shard, read windows-result-<n>, and
          for a no-failing-test exit the shard-log artifact; classify REAL,
          CRASH (IOCP or GLib signature), HANG, INFRA, AGGREGATE or UNKNOWN
  onset   count failed shards per UTC day across recent runs (disclosure
          only; never clears a run)

A ci: commit message is drafted only for a CRASH whose signature, exit
code (3 or 9), empty failingFiles and log (no "(fail)" or "✗" line, no
unhandled error) agree, or a HANG whose shard passed on an earlier run of
the same tree; in both, the runner must count the missing summary as the
only unattributed failure. And only when the run has finished, is for the
PR's current head (cross-checked against the head remote when this
checkout has one) and has no newer run; a stale run's artifacts are never
downloaded.

Exit codes: 0 drafted, 1 error, 2 usage, 10 triaged without a draft
(REAL, UNKNOWN, a stale run, or evidence missing), 11 nothing failed.`;

export const SHARD_JOB_RE = /^windows-free-shard \((\d+)(?:, \d+)?\)$/;
/**
 * Bun's Windows event loop aborting in its IOCP wait. The error code varies:
 * 735 (ERROR_ABANDONED_WAIT_0) and 6 (ERROR_INVALID_HANDLE) are both measured
 * on upstream runs, so the call is the signature, not one code. Only the
 * digits are kept: the rest of the line is log text.
 */
const IOCP_RE = /GetQueuedCompletionStatusEx: \((\d{1,10})\)/;
const IOCP_NAMES: Record<string, string> = { 6: 'ERROR_INVALID_HANDLE', 735: 'ERROR_ABANDONED_WAIT_0' };
const GLIB_RE = /GLib-ERROR[^\n]*g_system_thread_free/;

export type ShardClass = 'REAL' | 'CRASH' | 'HANG' | 'INFRA' | 'UNKNOWN';

/**
 * The windows-result-<n> outcome (scripts/test-free-shards.ts). The runner
 * adds 1 to unattributedFailures for a missing terminal summary and more for
 * an unhandled error between tests, an unreported failure or lost capture.
 */
export interface ShardOutcome {
  status?: string; exitCode?: number | null; elapsedMs?: number; failingFiles?: string[] | null;
  unattributedFailures?: number; summary?: { sawTerminalSummary?: boolean | null } | null;
}

export interface ShardTriage {
  shard: number; klass: ShardClass; signature: 'IOCP' | 'GLib' | null; inFlight: string | null;
  /** Test failure lines (`(fail)` or `✗`) and `# Unhandled error between tests` lines in the log. */
  failLines: number; unhandled: number; logRead: boolean;
  outcome: ShardOutcome | null; why: string; sameTreeGreen: string | null;
}

/** Failure evidence in a shard log, read with the free runner's own line classifier. */
export function logFailureEvidence(log: string): { failLines: number; unhandled: number } {
  let failLines = 0;
  let unhandled = 0;
  for (const raw of log.split('\n')) {
    const kind = classifyBunTestOutputLine(raw);
    const line = stripAnsiLine(raw).replace(/\r+$/, '');
    if (kind === 'failed-test' || /^(?:\(fail\)|✗)\s/.test(line)) failLines++;
    else if (kind === 'unhandled-between-tests' || line.startsWith('# Unhandled error')) unhandled++;
  }
  return { failLines, unhandled };
}

/**
 * A repo-relative test file path, or null. Text from a CI artifact or log
 * reaches the trusted output lines and the ci: draft only through this
 * check (any test can print a `::group::` line); everything else from CI
 * is printed inside the untrusted envelope, or not at all.
 */
export function safeTestPath(raw: string): string | null {
  const p = stripControl(raw).replace(/\\/g, '/').trim();
  if (p.length > 200 || p.split('/').some(part => part === '' || part === '..')) return null;
  return /^[A-Za-z0-9_@][A-Za-z0-9_@./-]*\.test\.[cm]?[jt]sx?$/.test(p) ? p : null;
}

/** The last `::group::<file>:` line opened in the log: the test file bun was in when it stopped (null when it is not a test path). */
export function inFlightFile(log: string): string | null {
  const groups = [...log.matchAll(/^::group::(.+?):?\s*$/gm)];
  const last = groups.at(-1);
  if (!last) return null;
  const after = log.slice(last.index! + last[0].length);
  return /^::endgroup::/m.test(after) ? null : safeTestPath(last[1]);
}

/**
 * The windows-result-<n> artifact's outcome, with every field type-checked:
 * a malformed failingFiles counts as a named failure (never drafted), a
 * missing one stays undefined (missing evidence).
 */
export function parseOutcome(text: string): ShardOutcome | null {
  let raw: unknown;
  try {
    raw = (JSON.parse(text) as { outcome?: unknown } | null)?.outcome;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const ff = o.failingFiles;
  const summary = o.summary && typeof o.summary === 'object' ? (o.summary as Record<string, unknown>) : null;
  return {
    status: typeof o.status === 'string' ? o.status : undefined,
    exitCode: typeof o.exitCode === 'number' ? o.exitCode : null,
    elapsedMs: typeof o.elapsedMs === 'number' ? o.elapsedMs : undefined,
    failingFiles: ff === undefined ? undefined : Array.isArray(ff) ? ff.map(x => (typeof x === 'string' ? x : '(not a string)')) : ['(malformed failingFiles)'],
    unattributedFailures: typeof o.unattributedFailures === 'number' ? o.unattributedFailures : undefined,
    summary: summary ? { sawTerminalSummary: typeof summary.sawTerminalSummary === 'boolean' ? summary.sawTerminalSummary : null } : null,
  };
}

const statusWord = (v: unknown): string => (typeof v === 'string' && /^[a-z-]{1,20}$/.test(v) ? v : 'unrecognised');
const exitWord = (v: unknown): string => (Number.isInteger(v) ? String(v) : '?');
const seconds = (ms: unknown): string => (typeof ms === 'number' && Number.isFinite(ms) ? String(Math.round(ms / 1000)) : '?');

/** failingFiles entries that are not test paths: printed only inside the envelope. */
export const unprintableFailing = (o: ShardOutcome | null): string[] => (o?.failingFiles ?? []).filter(f => !safeTestPath(f));

/** Pure: classify one failed shard from its result artifact and (when read) its log. */
export function classifyShard(shard: number, outcome: ShardOutcome | null, log: string | null): ShardTriage {
  const evidence = log !== null ? logFailureEvidence(log) : { failLines: 0, unhandled: 0 };
  const base = { shard, outcome, signature: null, inFlight: log ? inFlightFile(log) : null, ...evidence, logRead: log !== null, sameTreeGreen: null };
  if (!outcome) return { ...base, klass: 'UNKNOWN', why: 'no windows-result artifact' };
  const failing = outcome.failingFiles ?? [];
  if (outcome.status === 'passed') return { ...base, klass: 'INFRA', why: 'the shard passed but its job failed: read the failing setup step' };
  if (outcome.status === 'failed' && failing.length) {
    const shown = failing.map(safeTestPath).filter((f): f is string => !!f);
    const hidden = failing.length - shown.length;
    return { ...base, klass: 'REAL', why: `failing: ${shown.join(', ') || '(no printable test path)'}${hidden ? `; ${hidden} more entr${hidden === 1 ? 'y' : 'ies'}, printed as data below` : ''}` };
  }
  if (outcome.status === 'timed-out' && failing.length === 0) return { ...base, klass: 'HANG', why: `timed out after ${seconds(outcome.elapsedMs)} s` };
  if (outcome.status === 'failed' && (outcome.exitCode === 3 || outcome.exitCode === 9) && failing.length === 0) {
    if (!log) return { ...base, klass: 'UNKNOWN', why: `exit ${outcome.exitCode} with no failing test, but no shard log to read` };
    const iocp = IOCP_RE.exec(log);
    const signature = iocp ? 'IOCP' : GLIB_RE.test(log) ? 'GLib' : null;
    if (!signature) return { ...base, klass: 'UNKNOWN', why: `exit ${outcome.exitCode} with no failing test and no known abort signature` };
    const code = iocp ? String(Number(iocp[1])) : '';
    return { ...base, signature, klass: 'CRASH', why: iocp ? `Bun aborted: GetQueuedCompletionStatusEx error ${code}${IOCP_NAMES[code] ? ` (${IOCP_NAMES[code]})` : ''}` : 'GLib abort in g_system_thread_free' };
  }
  return { ...base, klass: 'UNKNOWN', why: `status ${statusWord(outcome.status)} exit ${exitWord(outcome.exitCode)} failing ${failing.length}` };
}

/**
 * Pure: may this shard earn an empty ci: commit? Only when the abort or the
 * hang is the shard's sole failure evidence: the log was read and holds no
 * failed test and no unhandled error, and the runner counted exactly one
 * unattributed failure, the terminal summary it never saw. An artifact
 * without those fields is missing evidence, not a pass.
 */
export function draftable(t: ShardTriage): boolean {
  const o = t.outcome;
  const onlyMissingSummary = o?.unattributedFailures === 1 && o.summary?.sawTerminalSummary === false;
  const clean = t.logRead && t.failLines === 0 && t.unhandled === 0 && Array.isArray(o?.failingFiles) && o.failingFiles.length === 0 && onlyMissingSummary;
  if (t.klass === 'CRASH') return clean && !!t.signature && (o?.exitCode === 3 || o?.exitCode === 9);
  return t.klass === 'HANG' && clean && o?.status === 'timed-out' && !!t.sameTreeGreen;
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

/** A GitHub enum value (status, conclusion) as printable text: anything else is dropped. */
const word = (v: string | undefined): string => (v && /^[a-z_]{1,32}$/.test(v) ? v : '');

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
  const stale: string[] = [];
  // gh's headRefOid is cross-checked against the head remote when one is configured here.
  const headRemote = pr.headRepo ? remoteForRepo(d.git, f.cwd, pr.headRepo) : null;
  if (headRemote) {
    const pin = pinBranch(d.git, f.cwd, headRemote, pr.headRef);
    if (pin.sha !== pr.headOid) stale.push(`${headRemote}/${pr.headRef} is at ${pin.sha.slice(0, 12)}, but the PR reports ${pr.headOid.slice(0, 12)}: the head moved`);
  }
  const onHead = ghJson<RunInfo[]>(d, ['run', 'list', '-R', repo, '--workflow', 'windows-free-tests.yml', '--commit', pr.headOid, '--limit', '20', '--json', RUN_FIELDS], 'gh run list');
  const runId = f.run ?? onHead.find(r => r.conclusion === 'failure')?.databaseId ?? null;
  if (runId === null) {
    d.out(`RESULT NOTHING no failed Windows Free Tests run on ${pr.headOid.slice(0, 12)}`);
    return TRIAGE_EXIT.NOTHING;
  }
  const run = ghJson<RunInfo>(d, ['run', 'view', String(runId), '-R', repo, '--json', `${RUN_FIELDS},jobs`], 'gh run view');
  if (run.headSha !== pr.headOid) stale.push(`run ${runId} is for ${run.headSha.slice(0, 12)}, not the PR head ${pr.headOid.slice(0, 12)}`);
  const newer = onHead.filter(r => r.databaseId > runId);
  if (newer.length) stale.push(`a newer run on the head exists (${newer.map(r => `${r.databaseId} ${word(r.status)}/${word(r.conclusion)}`).join(', ')})`);
  // A shard still running could yet fail for real, and the ci: push would cancel it (cancel-in-progress).
  const pending = (run.jobs ?? []).filter(j => !j.conclusion).length;
  if (run.status !== 'completed') stale.push(`run ${runId} is still ${word(run.status) || 'queued'}: wait for every shard to finish`);
  else if (pending) stale.push(`run ${runId} has ${pending} unfinished job(s): wait for every shard to finish`);
  if (stale.length) {
    // Checked before any artifact is downloaded: nothing from a stale run is read or printed.
    for (const s of stale) d.out(`STALE ${s}`);
    d.out(`RESULT NO_DRAFT run=${runId} stale: triage the newest finished run on the current head`);
    return TRIAGE_EXIT.NO_DRAFT;
  }
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
    const outcome = resFile ? parseOutcome(fs.readFileSync(resFile, 'utf8')) : null;
    const needsLog = outcome && outcome.status !== 'passed' && (outcome.failingFiles ?? []).length === 0;
    const logFile = needsLog ? download(d, repo, runId, `windows-free-test-shard-logs-${n}`) : null;
    const log = logFile ? fs.readFileSync(logFile, 'utf8') : null;
    const t = classifyShard(n, outcome, log);
    if (t.klass === 'HANG') t.sameTreeGreen = sameTreeGreen(d, f.cwd, repo, pr, run, n);
    triaged.push(t);
    d.out(`SHARD\t${n}\t${t.klass}${t.signature ? `(${t.signature})` : ''}\t${t.why}${t.inFlight ? `\tin-flight ${t.inFlight}` : ''}${t.klass === 'HANG' ? `\tsame-tree-green ${t.sameTreeGreen ?? 'none'}` : ''}`);
    const hidden = unprintableFailing(t.outcome);
    if (hidden.length) d.out(envelope(hidden.join('\n'), `ci-run-${runId}-shard-${n}-failing`));
    if (log) d.out(envelope(log.split('\n').slice(-12).join('\n'), `ci-run-${runId}-shard-${n}`));
  }
  const ok = triaged.filter(draftable);
  if (ok.length !== triaged.length) {
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
        const outcome = res ? parseOutcome(fs.readFileSync(res, 'utf8')) : null;
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
