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
 * Windows); a hang to the shard's deadline with every test of the in-flight
 * file passed; and a GLib abort (exit 9). The step log does not show any of
 * this; the artifacts do.
 *
 * A draft is written ONLY for a CRASH whose signature, exit code, empty
 * failingFiles and clean log all agree, or a HANG whose shard passed on an
 * earlier run that tested the identical tree (the revision each result
 * artifact records: the head merged into the base of the day) with the
 * same planned files, and in both cases only when the runner's own count
 * says the missing summary was the only failure. A
 * failure that names a test is REAL and gets the blame protocol instead.
 * The onset scan is disclosure only: these flakes appear on other branches
 * at a background rate, so "it also happened elsewhere" never clears a run.
 * This helper never commits or pushes; with the owner's yes,
 * `gstack-pr-sync retrigger` builds and pushes the commit from the drafted
 * message, and only while the draft's binding (repo, PR, run and its
 * attempt, head and the message's sha256) still matches the PR's current
 * head and newest run.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PrContextError, defaultGh, defaultGit, parsePrRefFor, upstreamRepoFromGh, remoteForRepo, pinBranch, readPr,
  topicFor, prStateDir, envelope, stripControl, type GhRunner, type GitRunner, type PrInfo,
} from './pr-context';
import { classifyBunTestOutputLine, stripAnsiLine } from '../scripts/lib/shard-engine';

export const TRIAGE_EXIT = { DRAFTED: 0, ERROR: 1, USAGE: 2, NO_DRAFT: 10, NOTHING: 11, HEAD_MOVED: 40 } as const;

export const TRIAGE_USAGE = `gstack-pr-ci-triage <run|onset> [options]

  run     triage the newest failed Windows Free Tests run on the PR's head
          (or --run <id>): per failed shard, read windows-result-<n>, and
          for a no-failing-test exit the shard-log artifact; classify REAL,
          CRASH (an IOCP or GLib signature as the log's last line), HANG,
          INFRA, AGGREGATE or UNKNOWN.
          When no shard log explains a failure, the job log's tail is
          printed (read-only gh api), inside the untrusted envelope
  onset   count failed shards per UTC day across recent runs (disclosure
          only; never clears a run)

A ci: commit message is drafted only for a CRASH whose signature, exit
code (3 or 9), empty failingFiles and log (no "(fail)" or "✗" line, no
unhandled error) agree, or a HANG whose shard passed on an earlier run
that tested the same tree with the same files (each result's recorded
revision, resolved by a read-only gh api GET: for a pull_request run, the
head merged into the base as it stood); in both, the runner must count the
missing summary as the only unattributed failure. And only when the run
has finished, is for the PR's current head (cross-checked against the head
remote when this checkout has one) and has no newer run; a stale run's
artifacts are never downloaded.

Exit codes: 0 drafted, 1 error, 2 usage, 10 triaged without a draft
(REAL, UNKNOWN, a stale run, or evidence missing), 11 nothing failed,
40 the PR head branch is gone from the head remote or keeps moving
(re-run once it settles).`;

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
  outcome: ShardOutcome | null; why: string;
  /** The earlier run that passed this shard on the same tested tree and files (HANG only), and, when there is none, why. */
  sameTreeGreen: string | null; sameTreeWhy?: string;
}

/**
 * What a windows-result-<n> artifact says CI tested: `revision` is the
 * commit the runner checked out (`git rev-parse HEAD`; for a pull_request
 * run that is refs/pull/N/merge, the PR head merged into the base as it
 * stood when the run started), `files` the test files the plan gave the
 * shard. Either is null when the artifact does not carry it.
 */
export interface TestedIdentity { revision: string | null; files: string[] | null }

const OBJECT_ID_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function parseTestedIdentity(text: string): TestedIdentity {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { revision: null, files: null };
  }
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const o = r.outcome && typeof r.outcome === 'object' ? (r.outcome as Record<string, unknown>) : {};
  const files = o.files;
  return {
    revision: typeof r.revision === 'string' && OBJECT_ID_RE.test(r.revision) ? r.revision : null,
    files: Array.isArray(files) && files.length > 0 && files.every(f => typeof f === 'string') ? (files as string[]) : null,
  };
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

/**
 * The log's last non-blank line, ANSI and trailing CRs stripped. An abort
 * signature counts only here: Bun prints it as it dies, so it is the final
 * line of every measured crash log (7 of 7), while a test that prints the
 * same text mid-run says nothing about how the shard ended.
 */
export function lastLogLine(log: string): string {
  const lines = log.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = stripAnsiLine(lines[i]).replace(/\r+$/, '');
    if (line.trim()) return line;
  }
  return '';
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
  if (outcome.status === 'passed') return { ...base, klass: 'INFRA', why: 'the shard passed but its job failed (a setup or upload step): see the job log tail' };
  // A named failure is REAL whatever the final status: the runner keeps it in
  // failingFiles when the shard later times out (or ends any other way).
  if (failing.length) {
    const shown = failing.map(safeTestPath).filter((f): f is string => !!f);
    const hidden = failing.length - shown.length;
    const when = outcome.status === 'timed-out' ? ' (before the shard timed out)' : '';
    return { ...base, klass: 'REAL', why: `failing: ${shown.join(', ') || '(no printable test path)'}${hidden ? `; ${hidden} more entr${hidden === 1 ? 'y' : 'ies'}, printed as data below` : ''}${when}` };
  }
  if (outcome.status === 'timed-out' && failing.length === 0) return { ...base, klass: 'HANG', why: `timed out after ${seconds(outcome.elapsedMs)} s` };
  if (outcome.status === 'failed' && (outcome.exitCode === 3 || outcome.exitCode === 9) && failing.length === 0) {
    if (!log) return { ...base, klass: 'UNKNOWN', why: `exit ${outcome.exitCode} with no failing test, but no shard log to read` };
    const last = lastLogLine(log);
    const iocp = IOCP_RE.exec(last);
    const signature = iocp ? 'IOCP' : GLIB_RE.test(last) ? 'GLib' : null;
    if (!signature) return { ...base, klass: 'UNKNOWN', why: `exit ${outcome.exitCode} with no failing test and no known abort signature at the end of the shard log` };
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

/** Pure: why draftable() refused a shard, in fixed vocabulary (REAL gets the blame step instead). */
export function noDraftReason(t: ShardTriage): string {
  if (t.klass !== 'CRASH' && t.klass !== 'HANG') return t.why;
  const o = t.outcome;
  if (!t.logRead) return 'no shard log to read';
  if (t.failLines) return `${t.failLines} failed-test line(s) in the shard log`;
  if (t.unhandled) return `${t.unhandled} unhandled error(s) between tests in the shard log`;
  if (!Array.isArray(o?.failingFiles)) return 'the result artifact has no failingFiles list';
  if (o?.unattributedFailures !== 1 || o.summary?.sawTerminalSummary !== false) {
    return `the runner counted ${exitWord(o?.unattributedFailures)} unattributed failure(s), not only the missing terminal summary`;
  }
  if (t.klass === 'HANG' && !t.sameTreeGreen) return t.sameTreeWhy ?? 'no earlier run that tested the same tree passed the shard';
  return t.why;
}

const causeOf = (t: ShardTriage): string => (t.klass === 'HANG' ? 'a hang' : t.signature === 'GLib' ? 'a GLib abort' : 'a Bun IOCP crash');

/**
 * The empty ci: commit's message: one evidence line per draftable shard (its
 * own cause, reason, in-flight file and, for a hang, the run where the same
 * tree passed). The subject names the shared cause, or "runner flakes" when
 * the shards differ. Every value in it is fixed vocabulary, a number, or a
 * path that passed safeTestPath.
 */
export function draftMessage(x: { run: number; head: string; shards: ShardTriage[] }): string {
  const causes = new Set(x.shards.map(causeOf));
  const subject = `ci: re-run CI after ${causes.size === 1 ? [...causes][0] : 'runner flakes'} on windows-free-shard (${x.shards.map(t => t.shard).join(', ')})`;
  const lines = [subject, '', `Windows Free Tests run ${x.run} on ${x.head.slice(0, 9)} failed with no failing test:`, ''];
  for (const t of x.shards) {
    const reason = t.klass === 'HANG' ? `hang, ${t.why}` : t.why;
    const passed = t.klass === 'HANG' ? `; the same tested tree passed this shard in run ${t.sameTreeGreen}` : '';
    lines.push(`- shard ${t.shard}: ${reason}${t.inFlight ? `, in ${t.inFlight}` : ''}${passed}.`);
  }
  lines.push('', 'A fork contributor cannot re-run the job, so this empty commit triggers', 'a fresh run.', '');
  return lines.join('\n');
}

// ── deps ────────────────────────────────────────────────────────────────────

export interface TriageDeps {
  gh: GhRunner; git: GitRunner; env: NodeJS.ProcessEnv; out: (line: string) => void;
  /** Notes that are not part of the machine-read report (stderr). */
  err: (line: string) => void;
  tmp: () => string;
}

const realDeps = (): Omit<TriageDeps, 'tmp'> => ({
  gh: defaultGh, git: defaultGit, env: process.env, out: l => process.stdout.write(l + '\n'), err: l => process.stderr.write(l + '\n'),
});

interface RunInfo { databaseId: number; attempt?: number; headSha: string; headBranch?: string; event?: string; conclusion?: string; createdAt?: string; status?: string; jobs?: { databaseId: number; name: string; conclusion: string }[] }

function ghJson<T>(d: TriageDeps, args: string[], what: string): T {
  const r = d.gh(args);
  if (r.status !== 0) throw new PrContextError(`${what} failed: ${(r.error ?? r.stderr).trim().split('\n').at(-1)}`, 1);
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    throw new PrContextError(`${what} printed no JSON`, 1);
  }
}

/**
 * Let a queued SIGINT/SIGTERM/SIGHUP handler run. The gh calls are
 * synchronous, so a signal that arrives during one is only handled at the
 * next turn of the event loop: after every download and before the draft
 * is written.
 */
const yieldToSignals = () => new Promise<void>(resolve => setImmediate(resolve));

async function download(d: TriageDeps, repo: string, run: number, name: string): Promise<string | null> {
  const dir = d.tmp();
  const r = d.gh(['run', 'download', String(run), '-R', repo, '-n', name, '-D', dir]);
  await yieldToSignals();
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

const RUN_FIELDS = 'databaseId,attempt,headSha,headBranch,event,conclusion,createdAt,status';

/** Lines kept from the end of a job log: the failing step's error is printed last. */
const JOB_LOG_TAIL = 30;

/**
 * The tail of one Actions job log (read-only `gh api` GET), enveloped as
 * untrusted data, or a one-line note when it cannot be read. Used only when
 * no shard log explains the failure: INFRA, a missing artifact, AGGREGATE.
 */
function jobLogTail(d: TriageDeps, repo: string, runId: number, jobId: number | undefined): string {
  if (!jobId || !Number.isSafeInteger(jobId)) return 'JOBLOG none: the job has no id';
  const r = d.gh(['api', '--allow-escape-sequences', `repos/${repo}/actions/jobs/${jobId}/logs`]);
  if (r.status !== 0) return `JOBLOG none: job ${jobId}'s log could not be read`;
  return envelope(r.stdout.replace(/\s+$/, '').split('\n').slice(-JOB_LOG_TAIL).join('\n'), `ci-run-${runId}-job-${jobId}`);
}

/** A path as one shell word (single-quoted unless plainly safe). */
const shq = (s: string): string => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

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

/**
 * The distinct shard numbers among failed jobs. A two-dimension diagnostic
 * matrix (`windows-free-shard (4, 1)` ... `(4, 10)`) is one shard with one
 * windows-result-4 artifact, so it is downloaded and counted once.
 */
export function failedShards(jobs: { name: string }[]): number[] {
  const all = jobs.map(j => Number(SHARD_JOB_RE.exec(j.name)?.[1])).filter(n => Number.isInteger(n) && n > 0);
  return [...new Set(all)].sort((a, b) => a - b);
}

const DRAFT_FILE_RE = /^ci-retrigger-\d+\.(?:txt|json)$/;

/** Remove every ci-retrigger draft (message and binding) from the PR state dir. */
export function pruneDrafts(dir: string): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) if (DRAFT_FILE_RE.test(e)) fs.rmSync(path.join(dir, e), { force: true });
}

/**
 * The machine-readable binding beside each ci: draft (ci-retrigger-<run>.json):
 * the repo, PR, run and head it was triaged on, and the sha256 of the exact
 * message bytes. `gstack-pr-sync retrigger` pushes a draft only through
 * readRetriggerDraft, so none of triage's gates can be skipped at the push.
 * `attempt` is the run's attempt triage read (null when gh gave none): a
 * maintainer's re-run keeps the run id and bumps it, and the push refuses a
 * run whose attempt moved, even one that failed again.
 */
export interface RetriggerBinding {
  v: 1; repo: string; pr: number; run: number; attempt: number | null; head: string; tree: string | null; messageSha256: string; triagedAt: string;
  shards: { shard: number; klass: ShardClass; signature: 'IOCP' | 'GLib' | null; sameTreeGreen: string | null }[];
}

const MESSAGE_FILE_RE = /^ci-retrigger-(\d+)\.txt$/;
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Write a draft pair (message, then its binding) into the PR state dir; returns both paths. */
export function writeRetriggerDraft(dir: string, x: { repo: string; pr: number; run: number; attempt: number | null; head: string; tree: string | null; message: string; shards: ShardTriage[] }): { message: string; binding: string } {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const message = path.join(dir, `ci-retrigger-${x.run}.txt`);
  fs.writeFileSync(message, x.message, { mode: 0o600 });
  const b: RetriggerBinding = {
    v: 1, repo: x.repo, pr: x.pr, run: x.run, attempt: x.attempt, head: x.head, tree: x.tree, messageSha256: sha256(x.message), triagedAt: new Date().toISOString(),
    shards: x.shards.map(t => ({ shard: t.shard, klass: t.klass, signature: t.signature, sameTreeGreen: t.sameTreeGreen })),
  };
  const binding = path.join(dir, `ci-retrigger-${x.run}.json`);
  fs.writeFileSync(binding, `${JSON.stringify(b, null, 2)}\n`, { mode: 0o600 });
  return { message, binding };
}

/**
 * A ci: draft as `gstack-pr-sync retrigger` may push it: a
 * ci-retrigger-<run>.txt in this PR's state dir, whose binding names this
 * repo, PR and run and whose bytes are the ones triage wrote. Anything else
 * throws PrContextError 30. The caller still compares binding.head (and
 * binding.tree) with the head it pinned, and pushes the returned bytes, not
 * a re-read of the file.
 */
export function readRetriggerDraft(file: string, expect: { stateDir: string; repo: string; pr: number }): { message: string; binding: RetriggerBinding } {
  const refuse = (why: string): never => {
    throw new PrContextError(`${why}: push only a draft gstack-pr-ci-triage wrote for this PR's current head (re-run it)`, 30);
  };
  let real = '';
  let dir = '';
  try {
    real = fs.realpathSync(file);
    dir = fs.realpathSync(expect.stateDir);
  } catch {
    refuse(`${file} is not a ci: draft in this PR's state dir`);
  }
  const m = MESSAGE_FILE_RE.exec(path.basename(real));
  if (path.dirname(real) !== dir || !m) refuse(`${file} is not a ci-retrigger-<run>.txt draft in this PR's state dir (${dir})`);
  const run = Number(m![1]);
  let b: Partial<RetriggerBinding> = {};
  try {
    b = JSON.parse(fs.readFileSync(path.join(dir, `ci-retrigger-${run}.json`), 'utf8')) as Partial<RetriggerBinding>;
  } catch {
    refuse(`the draft for run ${run} has no readable binding (ci-retrigger-${run}.json)`);
  }
  if (b.v !== 1 || b.repo !== expect.repo || b.pr !== expect.pr || b.run !== run || typeof b.head !== 'string' || !OBJECT_ID_RE.test(b.head)) {
    refuse(`the binding of the draft for run ${run} does not name ${expect.repo} PR ${expect.pr}, run ${run} and a head`);
  }
  const message = fs.readFileSync(real, 'utf8');
  if (sha256(message) !== b.messageSha256) refuse(`the draft for run ${run} changed after triage wrote it`);
  return { message, binding: b as RetriggerBinding };
}

function treeOf(d: TriageDeps, cwd: string, sha: string): string | null {
  const r = d.git(['rev-parse', `${sha}^{tree}`], { cwd });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The tree of a commit CI tested, by a read-only GET (a pull_request merge commit exists only on GitHub), or null. */
function testedTree(d: TriageDeps, repo: string, revision: string): string | null {
  const r = d.gh(['api', `repos/${repo}/commits/${revision}`, '--jq', '.commit.tree.sha']);
  const tree = r.status === 0 ? r.stdout.trim() : '';
  return OBJECT_ID_RE.test(tree) ? tree : null;
}

const sameFiles = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((f, i) => f === b[i]);

/**
 * An earlier run whose same shard passed on the tree this hang tested, with
 * the same planned files. A pull_request run tests refs/pull/N/merge, the
 * head merged into the base as it stood then, so two runs of one head
 * commit test different code once the base moves, and the plan packs the
 * shard from that merged tree. The comparison is therefore between the
 * revisions each windows-result-<n> records, resolved to trees. Anything
 * missing or unreadable is no evidence.
 */
async function sameTreeGreen(d: TriageDeps, repo: string, pr: PrInfo, run: RunInfo, shard: number, hung: TestedIdentity): Promise<{ green: string | null; why: string }> {
  if (!hung.revision || !hung.files) return { green: null, why: 'the shard result records no tested revision or planned files' };
  const tree = testedTree(d, repo, hung.revision);
  if (!tree) return { green: null, why: `the tested revision ${hung.revision.slice(0, 12)} could not be read from GitHub` };
  const runs = ghJson<RunInfo[]>(d, ['run', 'list', '-R', repo, '--workflow', 'windows-free-tests.yml', '--branch', pr.headRef, '--limit', '30', '--json', RUN_FIELDS], 'gh run list');
  for (const r of runs) {
    // Only an earlier run is evidence; any run of the same commit included, since the tested tree decides.
    if (!(r.databaseId < run.databaseId)) continue;
    const view = ghJson<RunInfo>(d, ['run', 'view', String(r.databaseId), '-R', repo, '--json', 'databaseId,headSha,jobs'], 'gh run view');
    const jobs = (view.jobs ?? []).filter(j => SHARD_JOB_RE.exec(j.name)?.[1] === String(shard));
    if (!jobs.length || jobs.some(j => j.conclusion !== 'success')) continue;
    const file = await download(d, repo, r.databaseId, `windows-result-${shard}`);
    const text = file ? fs.readFileSync(file, 'utf8') : '';
    if (parseOutcome(text)?.status !== 'passed') continue;
    const id = parseTestedIdentity(text);
    if (!id.revision || !id.files || !sameFiles(id.files, hung.files)) continue;
    if (id.revision === hung.revision || testedTree(d, repo, id.revision) === tree) return { green: String(r.databaseId), why: '' };
  }
  return { green: null, why: 'no earlier run that tested the same tree and files passed the shard' };
}

async function cmdRun(d: TriageDeps, f: Flags): Promise<number> {
  if (!f.pr) throw new PrContextError('--pr is required', 2);
  const repo = f.repo ?? upstreamRepoFromGh(d.gh, f.cwd);
  const pr = readPr(d.gh, repo, parsePrRefFor(f.pr, repo));
  // Every triage starts by removing earlier drafts: only this run's verdict may leave one behind.
  const dir = prStateDir({ cwd: f.cwd, topic: topicFor(pr.headRef), env: d.env });
  pruneDrafts(dir);
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
    d.out(`RESULT NO_DRAFT run=${runId} stale: triage the newest finished run on the current head`);
    for (const s of stale) d.out(`STALE ${s}`);
    return TRIAGE_EXIT.NO_DRAFT;
  }
  const failed = (run.jobs ?? []).filter(j => j.conclusion === 'failure');
  const shards = failedShards(failed);
  if (!shards.length) {
    const aggregate = failed.find(j => j.name === 'windows-free-tests');
    d.out(`RESULT ${aggregate ? 'AGGREGATE' : 'NOTHING'} run=${runId} ${aggregate ? 'windows-free-tests failed with no failed shard (plan, verify or a cancelled shard): its job log tail follows' : 'no Windows shard failed'}`);
    if (aggregate) d.out(jobLogTail(d, repo, runId, aggregate.databaseId));
    return aggregate ? TRIAGE_EXIT.NO_DRAFT : TRIAGE_EXIT.NOTHING;
  }
  // The per-shard detail is held back so the RESULT line prints first.
  const detail: string[] = [];
  const triaged: ShardTriage[] = [];
  for (const n of shards) {
    const resFile = await download(d, repo, runId, `windows-result-${n}`);
    const resText = resFile ? fs.readFileSync(resFile, 'utf8') : null;
    const outcome = resText !== null ? parseOutcome(resText) : null;
    const needsLog = outcome && outcome.status !== 'passed' && (outcome.failingFiles ?? []).length === 0;
    const logFile = needsLog ? await download(d, repo, runId, `windows-free-test-shard-logs-${n}`) : null;
    const log = logFile ? fs.readFileSync(logFile, 'utf8') : null;
    const t = classifyShard(n, outcome, log);
    if (t.klass === 'HANG') {
      const evidence = await sameTreeGreen(d, repo, pr, run, n, parseTestedIdentity(resText ?? ''));
      t.sameTreeGreen = evidence.green;
      if (!evidence.green) t.sameTreeWhy = evidence.why;
    }
    triaged.push(t);
    detail.push(`SHARD\t${n}\t${t.klass}${t.signature ? `(${t.signature})` : ''}\t${t.why}${t.inFlight ? `\tin-flight ${t.inFlight}` : ''}${t.klass === 'HANG' ? `\tsame-tree-green ${t.sameTreeGreen ?? 'none'}` : ''}`);
    const hidden = unprintableFailing(t.outcome);
    if (hidden.length) detail.push(envelope(hidden.join('\n'), `ci-run-${runId}-shard-${n}-failing`));
    if (log) detail.push(envelope(log.split('\n').slice(-12).join('\n'), `ci-run-${runId}-shard-${n}`));
    // No shard log explains it (INFRA, or an artifact missing): the job log's tail is the evidence.
    else if (t.klass !== 'REAL') detail.push(jobLogTail(d, repo, runId, failed.find(j => SHARD_JOB_RE.exec(j.name)?.[1] === String(n))?.databaseId));
  }
  const ok = triaged.filter(draftable);
  if (ok.length !== triaged.length) {
    for (const t of triaged.filter(x => !draftable(x))) {
      if (t.klass === 'REAL') detail.push(`BLAME shard ${t.shard}: run the failing file(s) on the PR head and on the base with gstack-pr-validate (declare them) before calling them pre-existing; a failure that passes on the base is this PR's`);
      else detail.push(`NO_DRAFT shard ${t.shard} ${t.klass}: ${noDraftReason(t)}`);
    }
    d.out(`RESULT NO_DRAFT run=${runId} shards=${triaged.map(t => `${t.shard}:${t.klass}`).join(',')}`);
    for (const line of detail) d.out(line);
    return TRIAGE_EXIT.NO_DRAFT;
  }
  await yieldToSignals();
  // The message and its binding: the head, run and bytes the push will be checked against.
  const { message: file, binding } = writeRetriggerDraft(dir, {
    repo, pr: pr.number, run: runId, attempt: typeof run.attempt === 'number' && Number.isInteger(run.attempt) ? run.attempt : null, head: pr.headOid, tree: treeOf(d, f.cwd, pr.headOid),
    message: draftMessage({ run: runId, head: pr.headOid, shards: triaged }), shards: triaged,
  });
  d.out(`RESULT DRAFTED run=${runId} message=${file} binding=${binding}`);
  for (const line of detail) d.out(line);
  d.out(`NEXT with the owner's yes in this turn: gstack-pr-sync retrigger --pr ${pr.number} --repo ${repo} --cwd ${shq(f.cwd)} --message ${shq(file)} --yes (it builds and pushes the empty commit; never commit or push by hand), then gstack-pr-body publish (its facts name the new head)`);
  return TRIAGE_EXIT.DRAFTED;
}

// ── onset ───────────────────────────────────────────────────────────────────

export interface DayCount { runs: number; failedRuns: number; crash: number; hang: number; real: number; other: number }

async function cmdOnset(d: TriageDeps, f: Flags): Promise<number> {
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
      for (const n of failedShards((view.jobs ?? []).filter(x => x.conclusion === 'failure'))) {
        if (downloads >= CAP) { c.other++; continue; }
        downloads++;
        const res = await download(d, repo, r.databaseId, `windows-result-${n}`);
        const outcome = res ? parseOutcome(fs.readFileSync(res, 'utf8')) : null;
        let log: string | null = null;
        if (outcome && (outcome.exitCode === 3 || outcome.exitCode === 9) && downloads < CAP) {
          downloads++;
          const lf = await download(d, repo, r.databaseId, `windows-free-test-shard-logs-${n}`);
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

const SCRATCH_PREFIX = 'gstack-ci-triage-';
const OWNER_FILE = '.owner';

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const errCode = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? (error as Error).message;

/** Remove one scratch root; a failure is a note naming the root, never a throw (cleanup must not end the triage). */
function removeScratch(root: string, warn: (line: string) => void): void {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (error) {
    warn(`NOTE could not remove the artifact scratch ${stripControl(root)} (${errCode(error)}): remove it by hand`);
  }
}

/**
 * Remove scratch roots whose recorded owner process is gone (a SIGKILL, or a
 * crash before cleanup). Best effort: only a real directory the current
 * user owns is considered (another user can plant a name in a shared /tmp);
 * a root without an owner file, or whose owner is alive, is left alone; one
 * that cannot be read or removed is named on `warn` and skipped.
 */
export function sweepOrphanScratch(parent: string, warn: (line: string) => void = l => process.stderr.write(`${l}\n`)): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(parent).filter(e => e.startsWith(SCRATCH_PREFIX));
  } catch {
    return; // no readable parent: nothing of ours to sweep
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  for (const e of entries) {
    const root = path.join(parent, e);
    let pid = NaN;
    try {
      const st = fs.lstatSync(root);
      if (!st.isDirectory() || (uid !== null && st.uid !== uid)) continue;
      pid = Number(fs.readFileSync(path.join(root, OWNER_FILE), 'utf8').trim());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn(`NOTE could not read the leftover scratch ${stripControl(root)} (${errCode(error)}): left in place`);
      continue;
    }
    if (Number.isSafeInteger(pid) && pid > 0 && !pidAlive(pid)) removeScratch(root, warn);
  }
}

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

export async function triageMain(argv: string[], deps: Partial<TriageDeps> & { scratchParent?: string } = {}): Promise<number> {
  // Artifact downloads (0.3-15 MB each) land under one scratch root that
  // records its owner pid, made at the first download. It is removed on
  // return, on SIGINT/SIGTERM/SIGHUP (then exit 128+signal), and by the next
  // run's sweep if this process is killed outright. A root that cannot be
  // made is an error the triage reports (RESULT ERROR, exit 1).
  const { scratchParent = os.tmpdir(), ...rest } = deps;
  const base = { ...realDeps(), ...rest };
  sweepOrphanScratch(scratchParent, base.err);
  let scratch: string | null = null;
  const tmp = (): string => {
    if (!scratch) {
      scratch = fs.mkdtempSync(path.join(scratchParent, SCRATCH_PREFIX));
      fs.writeFileSync(path.join(scratch, OWNER_FILE), `${process.pid}\n`);
    }
    return fs.mkdtempSync(path.join(scratch, 'a-'));
  };
  const onSignal = (sig: NodeJS.Signals) => {
    if (scratch) removeScratch(scratch, base.err);
    process.exit(128 + (os.constants.signals[sig] ?? 0));
  };
  for (const sig of SIGNALS) process.on(sig, onSignal);
  try {
    return await triage(argv, { tmp, ...base });
  } finally {
    for (const sig of SIGNALS) process.off(sig, onSignal);
    if (scratch) removeScratch(scratch, base.err);
  }
}

async function triage(argv: string[], d: TriageDeps): Promise<number> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    d.out(TRIAGE_USAGE);
    return argv.length ? 0 : TRIAGE_EXIT.USAGE;
  }
  try {
    const f = parseArgs(argv);
    if (f.sub === 'run') return await cmdRun(d, f);
    if (f.sub === 'onset') return await cmdOnset(d, f);
    throw new PrContextError(`unknown subcommand ${JSON.stringify(f.sub)}`, 2);
  } catch (error) {
    if (error instanceof PrContextError) {
      // Only the documented codes leave this helper; anything else from pr-context is an error.
      const code = error.code === 2 ? TRIAGE_EXIT.USAGE : error.code === 40 ? TRIAGE_EXIT.HEAD_MOVED : TRIAGE_EXIT.ERROR;
      d.out(`RESULT ${code === TRIAGE_EXIT.USAGE ? 'USAGE' : 'ERROR'} ${error.message}`);
      return code;
    }
    d.out(`RESULT ERROR ${(error as Error).message}`);
    return TRIAGE_EXIT.ERROR;
  }
}
