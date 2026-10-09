/**
 * pr-sync — keep an open upstream PR current with its base branch, the way
 * the #3032 effort did it by hand ten times: merge (never rebase, never
 * force), resolve the release files mechanically, re-version through the
 * merged tree's own bin/gstack-next-version, prove the PR's code diff did not
 * change, then push fast-forward only once the owner says yes.
 *
 *   gstack-pr-sync plan   --pr <n|url> [--repo o/r] [--cwd <pr worktree>]
 *   gstack-pr-sync merge  --pr <n|url> [...] [--worktree-root <dir>] [--fork-claims]
 *   gstack-pr-sync push   --pr <n|url> [...] --yes [--accept-diff-change] [--accept-full-risk]
 *   gstack-pr-sync abort  --pr <n|url> [...]
 *   gstack-pr-sync status --pr <n|url> [...]
 *
 * Every merge happens in a detached scratch worktree at H0 (the PR head as
 * the remote has it), `<root>/<topic>-sync`, so the owner's PR worktree is
 * never left mid-merge. `merge` leaves a committed sync in the scratch
 * worktree and a `sync.json` beside the PR state; `push` publishes exactly
 * that commit.
 *
 * Any failure after the scratch worktree exists removes it. A signal ends
 * a merge where it stands (no handler could run inside its synchronous
 * steps); `abort` then removes the scratch. Only a scratch merge made (a
 * detached worktree of this repository whose admin dir carries merge's
 * marker) is ever removed, and only through `git worktree remove`;
 * anything else at that path is left alone and named.
 *
 * gstack-shaped trees only: the merged tree must carry bin/gstack-next-version,
 * bin/gstack-version-bump, scripts/detect-bump.ts and scripts/gen-agents-digest.ts.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PrContextError, RELEASE_FILES, defaultGh, defaultGit, parsePrRefFor, upstreamRepoFromGh,
  remoteForRepo, pinBranch, readPr, viewerLogin, assertWritableIdentity, topicFor, prStateDir,
  readStateFor, writeState, withPrLock, receiptedSend, requireApproval, envelope, remoteHost, sshConfigHostName,
  type GhResult, type GhRunner, type GitRunner, type PrInfo, type PrState,
} from './pr-context';
import { pollForWrite, refuseUnackedLatches } from './pr-watch';
import { pruneDrafts, readRetriggerDraft } from './pr-ci-triage';

export const SYNC_EXIT = {
  SYNCED: 0, ERROR: 1, USAGE: 2, NOTHING: 10, CODE_CONFLICT: 20, DIFF_CHANGED: 21, PRECONDITION: 30,
  VALIDATION: 31, BODY_STALE: 32, REMOTE_MOVED: 40, HOOK_REFUSED: 41, UNVERIFIED: 42, LOCKED: 45, DIRTY: 50, VERSION_SOURCE: 60,
} as const;

export const SYNC_USAGE = `gstack-pr-sync <plan|merge|push|abort|status> --pr <number|url> [options]

Keeps an open upstream PR current with its base branch: merge (never rebase,
never force), resolve VERSION, package.json, the agents digest and the
CHANGELOG mechanically (upstream's entries byte-identical, ours on top),
re-version with the merged tree's bin/gstack-next-version, prove the PR's
code diff is unchanged (release and generated files excluded), and push
fast-forward only after the owner's yes and a green validation of the
exact commit.

  plan     read-only: pins both heads, checks the preconditions, classifies
           the conflicts a merge would hit
  merge    builds and commits the sync in a scratch worktree
           (<worktree-root>/<topic>-sync); nothing is pushed
  push     publishes the staged sync commit (needs --yes); once the PR
           reports it, fast-forwards the local PR branch and removes the
           scratch worktree. Run again after an UNVERIFIED push once the
           PR reports the commit: it records the push, sending nothing
  abort    removes the staged sync, or the scratch worktree an interrupted
           merge left; only a worktree gstack-pr-sync made is removed.
           Runs for a closed or merged PR too, to clear the sync it left
           in a topic a newer PR from its branch now uses
  status   prints the staged sync and whether it may be pushed (any state)
  retrigger  pushes ONE empty commit on top of the PR head with the
           message file gstack-pr-ci-triage drafted (needs --yes and
           --message); the tree is unchanged, so no new validation.
           Refused (30) unless the draft is in this PR's state dir,
           unedited, and bound to the head the remote holds and the
           newest Windows run on it, still a finished failure (not
           re-run since): re-run triage. A landed push or sync push
           removes every ci: draft

Options:
  --pr N|URL              the upstream PR (required)
  --repo OWNER/NAME       upstream repo (default: gh repo view in --cwd)
  --cwd DIR               the PR worktree, on the PR's head branch (default: .)
  --worktree-root DIR     scratch worktree parent (default: ~/worktrees/<repo name>)
  --fork-claims           also read open fork PRs' VERSION (advisory, <= 40 reads)
  --yes                   the owner approved this push in this turn
  --accept-diff-change    push even though the code-diff proof says CHANGED
  --accept-full-risk      push a validation that waived the full suite
                          (its summary says "FULL waived"); only with the
                          owner's yes to that waiver in this turn
  --message FILE          retrigger: the drafted ci: commit message

First line of output: RESULT <WORD> ...

Exit codes: 0 synced/pushed/ok, 1 error, 2 usage or approval missing,
10 nothing to do, 20 code conflict (resolve by hand), 21 code diff changed
(review; push needs --accept-diff-change), 30 precondition (for retrigger,
also a draft not bound to this PR's current head and newest run), 31
validation missing, red, or a waived full suite without --accept-full-risk
for the staged commit, 32 PR body still stale from an earlier push, 40 remote moved
or not fast-forward, 41 a pre-push hook or the remote refused the push
(stop and report; never --no-verify), 42 git push exited 0 but the PR
still reports the head from before it (UNVERIFIED: nothing recorded;
check the push URL), 45 lock busy, 50 a sync is already
staged, the scratch path holds something gstack-pr-sync did not make, or
the local branch has unpushed commits, 60 the version queue could not be
read (never guessed).`;

// ── pure helpers ────────────────────────────────────────────────────────────

const VERSION4_RE = /^\d+\.\d+\.\d+\.\d+$/;
const HEADING_RE = /^## \[([^\]]+)\]/;
const MARKER_RE = /^(<{7}|={7}|>{7})(?: |$)/m;
/** Generated files whose source is not a sibling `.tmpl` (CLAUDE.md, gen-skill-docs). */
const GENERATED_EXTRA = ['review/design-checklist.md', 'lib/dom-dump.js', 'gstack/llms.txt'];
/** Release tooling: if both sides changed it, the mechanical resolution is not trustworthy. */
const RELEASE_TOOLING = ['bin/gstack-next-version', 'bin/gstack-version-bump', 'lib/version-source.ts', 'scripts/gen-agents-digest.ts', 'scripts/detect-bump.ts'];
const PLATFORM_FILES = ['bin/gstack-next-version', 'bin/gstack-version-bump', 'scripts/detect-bump.ts', 'scripts/gen-agents-digest.ts'];
const DIGEST = 'agents-digest/gstack-AGENTS.md';
/** The marker gstack-pr-validate puts in a summary when --accept-full-risk let a FULL trigger pass. */
const FULL_WAIVED_RE = /\bFULL waived \(/;
/** A write follows its pre-write gate within this many seconds, or it is not sent. */
const GATE_MAX_AGE_S = 60;

export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** `git merge-tree --write-tree --name-only --no-messages`: tree, then conflicted paths up to the first blank line. */
export function parseMergeTree(stdout: string): { tree: string; conflicts: string[] } {
  const lines = stdout.replace(/\r/g, '').split('\n');
  const tree = (lines[0] ?? '').trim();
  if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new PrContextError('git merge-tree printed no tree id', 1);
  const conflicts: string[] = [];
  for (const line of lines.slice(1)) {
    if (line === '') break;
    if (!conflicts.includes(line)) conflicts.push(line);
  }
  return { tree, conflicts };
}

export function classifyConflicts(paths: readonly string[], isGenerated: (p: string) => boolean): { release: string[]; generated: string[]; code: string[] } {
  const out = { release: [] as string[], generated: [] as string[], code: [] as string[] };
  for (const p of paths) {
    if (RELEASE_FILES.includes(p)) out.release.push(p);
    else if (!p.endsWith('.tmpl') && isGenerated(p)) out.generated.push(p);
    else out.code.push(p);
  }
  return out;
}

/** Offset of the first `## [` release heading (CHANGELOG entries key on this, nothing looser). */
export function firstEntryOffset(text: string): number {
  const m = /^## \[/m.exec(text);
  return m ? m.index : text.length;
}

/**
 * The PR's CHANGELOG block: what the head inserted at the top of the base's
 * entries, and nothing else. Null when the head changed anything beyond one
 * inserted block (an older entry edited, the header changed).
 */
export function changelogBlock(base: string, head: string): { block: string; headings: string[] } | null {
  const i0 = firstEntryOffset(base);
  const j0 = firstEntryOffset(head);
  if (base.slice(0, i0) !== head.slice(0, j0)) return null;
  const n = head.length - base.length;
  if (n < 0) return null;
  const block = head.slice(j0, j0 + n);
  if (head !== base.slice(0, i0) + block + base.slice(i0)) return null;
  const headings = block.split('\n').map(l => HEADING_RE.exec(l)?.[1]).filter((v): v is string => !!v);
  return { block, headings };
}

export function rebuildChangelog(base: string, block: string): string {
  const i = firstEntryOffset(base);
  return base.slice(0, i) + block + base.slice(i);
}

/** `## [V] - <date><rest>`: the version, the date (if any) and whatever follows (a title such as `. Team Mode`). */
const HEADING_PARTS_RE = /^## \[([^\]]+)\](?: - (\d{4}-\d{2}-\d{2}))?(.*)$/;

/**
 * Re-versions the block's heading: only the `[version]` and the date
 * change, the rest of the line stays. With the version and date unchanged
 * (or no date to keep) the block comes back as it was.
 */
export function renameBlockHeading(block: string, version: string, date: string): string {
  const nl = block.indexOf('\n');
  const first = nl < 0 ? block : block.slice(0, nl);
  const m = HEADING_PARTS_RE.exec(first);
  if (!m) throw new PrContextError('the CHANGELOG block does not start with a ## [version] heading', 30);
  const [, current, currentDate, rest] = m;
  if (current === version && (currentDate === undefined || currentDate === date)) return block;
  return `## [${version}] - ${date}${rest}` + (nl < 0 ? '' : block.slice(nl));
}

function headingRest(block: string): string {
  return HEADING_PARTS_RE.exec(block.split('\n', 1)[0])?.[3] ?? '';
}

export function blockDate(block: string): string | null {
  return /^## \[[^\]]+\] - (\d{4}-\d{2}-\d{2})/.exec(block)?.[1] ?? null;
}

export function jsonSameExceptVersion(a: string, b: string): boolean {
  try {
    const ja = JSON.parse(a) as Record<string, unknown>;
    const jb = JSON.parse(b) as Record<string, unknown>;
    delete ja.version;
    delete jb.version;
    return JSON.stringify(ja) === JSON.stringify(jb);
  } catch {
    return false;
  }
}

export interface QueueAnswer { version: string; claimed: string[]; reason: string; warnings: string[] }

/** Qualify bin/gstack-next-version's JSON; anything short of a live, fork-correct answer is refused (code 60). */
export function qualifyQueue(r: GhResult, mainVersion: string): QueueAnswer {
  const refuse = (why: string) => new PrContextError(`bin/gstack-next-version unusable: ${why}`, SYNC_EXIT.VERSION_SOURCE);
  if (r.status !== 0) throw refuse(`exit ${r.status ?? 'none'}${r.error ? ` (${r.error})` : ''}: ${r.stderr.trim().split('\n').at(-1) ?? ''}`);
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(r.stdout) as Record<string, unknown>;
  } catch {
    throw refuse('output is not JSON');
  }
  // An upstream PR's queue is GitHub's open-PR list. Any other host ("unknown" for an
  // origin whose URL has no github.com, "gitlab" for a mirror) never read it, even
  // with offline:false and no fallback.
  if (j.host !== 'github') throw refuse(`host ${JSON.stringify(j.host)}: the GitHub PR queue was not read`);
  if (j.offline !== false) throw refuse('offline answer (the queue was not read)');
  if (j.fallback !== null && j.fallback !== undefined) throw refuse(`fallback "${String(j.fallback)}" reads the wrong repo for an upstream PR`);
  if (j.base_version !== mainVersion) throw refuse(`base_version ${String(j.base_version)} is not upstream's ${mainVersion}`);
  if (typeof j.version !== 'string' || !VERSION4_RE.test(j.version)) throw refuse(`version ${JSON.stringify(j.version)} is not X.Y.Z.W`);
  if (!Array.isArray(j.claimed)) throw refuse('claimed[] missing');
  const claimed = j.claimed.map(c => (c as { version?: unknown })?.version).filter((v): v is string => typeof v === 'string');
  const warnings = Array.isArray(j.warnings) ? j.warnings.filter((w): w is string => typeof w === 'string') : [];
  const unread = warnings.find(w => /queue(-awareness)? unavailable/i.test(w));
  if (unread) throw refuse(`it says the queue was unavailable (${JSON.stringify(unread.slice(0, 120))})`);
  return { version: j.version, claimed, reason: typeof j.reason === 'string' ? j.reason : '', warnings };
}

/** Keep our version when it is above main and unclaimed (CI's own rule); else take the queue's slot. */
export function pickVersion(ours: string, main: string, q: QueueAnswer): { version: string; kept: boolean } {
  if (VERSION4_RE.test(ours) && cmpVersion(ours, main) > 0 && !q.claimed.includes(ours)) return { version: ours, kept: true };
  return { version: q.version, kept: false };
}

export type ProofVerdict = 'IDENTICAL' | 'CONTEXT-ONLY' | 'CHANGED';

export interface PushOutcome { landed: boolean; code: number; why: string }

/**
 * `git push --porcelain` for one ref, classified by what git did rather than
 * by words in its stderr (a hook's own text may say anything). Once git has
 * talked to the remote it prints a status line per ref: `!` with
 * `[rejected] (...)` is git's own non-fast-forward refusal (40), and
 * `[remote rejected] (<reason>)` is the server refusing (a pre-receive hook,
 * a ruleset, a hidden ref: 41, stop and report). A failure with no status
 * line, no fatal transport error and git's "failed to push some refs" never
 * left the machine: a pre-push hook refused it (41, never --no-verify).
 * Exit status alone cannot separate the two: git 2.56 exits 1 with no
 * status line and "failed to push some refs" both for a hook and for a
 * remote helper (the https transport) that dies mid-push with "fatal:".
 * So a "fatal:" line keeps it an error (1), and the message names both.
 */
export function classifyPush(r: GhResult, ref: string): PushOutcome {
  const row = r.stdout.replace(/\r/g, '').split('\n').map(l => l.split('\t')).find(f => f.length >= 3 && f[1].endsWith(`:${ref}`));
  const flag = row?.[0];
  const summary = (row?.[2] ?? '').trim();
  if (r.status === 0 && flag !== '!') return { landed: true, code: SYNC_EXIT.SYNCED, why: summary };
  if (flag === '!' && summary.startsWith('[rejected]')) return { landed: false, code: SYNC_EXIT.REMOTE_MOVED, why: 'git refused the push as not a fast-forward: abort and re-sync' };
  if (flag === '!' && summary.startsWith('[remote rejected]')) return { landed: false, code: SYNC_EXIT.HOOK_REFUSED, why: 'the remote refused the push (its reason is in the git output below): stop and report it (never --no-verify, never force)' };
  const unsent = !row && r.status !== null && /failed to push some refs/.test(r.stderr);
  if (unsent && !/^fatal:/m.test(r.stderr)) {
    return { landed: false, code: SYNC_EXIT.HOOK_REFUSED, why: 'the local pre-push hook refused the push (its words are below): stop and report it (never --no-verify)' };
  }
  if (unsent) {
    return { landed: false, code: SYNC_EXIT.ERROR, why: `git push failed before the remote took the ref (exit ${r.status}, a "fatal:" line): the connection or the remote helper failed, or a pre-push hook printed "fatal:"; git's output is below (stop and report it; never --no-verify)` };
  }
  return { landed: false, code: SYNC_EXIT.ERROR, why: `git push failed (exit ${r.status ?? 'none'}${r.error ? `, ${r.error}` : ''}); git's output is below` };
}

// ── runners ─────────────────────────────────────────────────────────────────

export type ToolRunner = (cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string }) => GhResult;

export const defaultTool: ToolRunner = (cmd, args, opts) => {
  const timeout = opts.timeoutMs ?? 600_000;
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, input: opts.input, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { status: null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: `${cmd}: ${r.error.message}` };
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

export interface PreWriteGateCtx { gh: GhRunner; git: GitRunner; env: NodeJS.ProcessEnv; cwd: string; repo: string; number: number; expectHead: string; state: PrState | null }
export type PreWriteGate = (ctx: PreWriteGateCtx) => { ok: boolean; reason: string };

/**
 * Default gate, run right before the push: the PR is still OPEN at the head
 * we staged against, and a fresh gstack-pr-watch poll answered on every
 * endpoint with no unacknowledged P0/P1 (a maintainer may have superseded
 * the PR since the sync was staged).
 */
export const defaultPreWriteGate: PreWriteGate = ({ gh, git, env, cwd, repo, number, expectHead }) => {
  const pr = readPr(gh, repo, number);
  if (pr.state !== 'OPEN') return { ok: false, reason: `PR #${number} is ${pr.state}` };
  if (pr.headOid !== expectHead) return { ok: false, reason: `PR head moved to ${pr.headOid.slice(0, 12)} (staged against ${expectHead.slice(0, 12)})` };
  return pollForWrite({ gh, git, env, now: () => new Date(), out: () => {} }, repo, number, cwd);
};

export interface SyncDeps {
  gh: GhRunner;
  git: GitRunner;
  tool: ToolRunner;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  out: (line: string) => void;
  err: (line: string) => void;
  preWriteGate: PreWriteGate;
  /** Pause between head read-backs after a push (GitHub can lag a few seconds). */
  readbackDelayMs: number;
  /** The HostName ssh connects to for a host alias (`ssh -G`), or null. */
  sshHostName: (alias: string) => string | null;
}

const realDeps = (): SyncDeps => ({
  gh: defaultGh, git: defaultGit, tool: defaultTool, env: process.env, now: () => new Date(),
  out: l => process.stdout.write(l + '\n'), err: l => process.stderr.write(l + '\n'), preWriteGate: defaultPreWriteGate,
  readbackDelayMs: 2_000, sshHostName: sshConfigHostName,
});

// ── staged-sync record ──────────────────────────────────────────────────────

export interface StagedSync {
  v: 1; repo: string; number: number; headRef: string; kind: 'merge' | 'release-only';
  h0: string; base: string; baseRef: string; mainVersion: string; oldVersion: string; version: string;
  sha: string; proof: ProofVerdict; changedFiles: string[]; scratch: string; at: string;
}

const syncFile = (dir: string) => path.join(dir, 'sync.json');

export function readStagedSync(dir: string, pr: { repo: string; number: number }): StagedSync | null {
  let raw: string;
  try {
    raw = fs.readFileSync(syncFile(dir), 'utf8');
  } catch {
    return null;
  }
  const s = JSON.parse(raw) as StagedSync;
  if (s?.v !== 1 || s.repo !== pr.repo || s.number !== pr.number) {
    // A PR opened from a closed PR's branch shares its topic dir: name the PR whose sync it is, and the way to clear it.
    const owner = s?.v === 1 && typeof s.repo === 'string' && Number.isSafeInteger(s.number) && s.number > 0 ? `${s.repo} #${s.number}` : null;
    throw new PrContextError(owner
      ? `${syncFile(dir)} is a sync staged for ${owner}, not for ${pr.repo} #${pr.number}: push it from that PR, or clear it with \`gstack-pr-sync abort --pr ${s.number}\` (abort runs for a closed PR too)`
      : `${syncFile(dir)} belongs to another PR`, 30);
  }
  return s;
}

function writeStagedSync(dir: string, s: StagedSync): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${syncFile(dir)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, syncFile(dir));
}

export function freshState(pr: PrInfo, extra: { headRemote: string | null; upstreamRemote: string | null }): PrState {
  return {
    v: 1, topic: topicFor(pr.headRef), repo: pr.repo, number: pr.number, headRef: pr.headRef, headOwner: pr.headOwner,
    headRemote: extra.headRemote, upstreamRemote: extra.upstreamRemote, defaultBranch: pr.baseRef,
    focused: null, validation: null, bodyStaleSince: null, lastPublishedBodySha256: null,
    signals: { latched: [], acked: [] }, audit: null,
  };
}

// ── context ─────────────────────────────────────────────────────────────────

interface Flags {
  sub: string; pr: string | null; repo: string | null; cwd: string; worktreeRoot: string | null;
  forkClaims: boolean; acceptDiffChange: boolean; acceptFullRisk: boolean; message: string | null; argv: string[];
}

const VALUE_FLAGS = ['--pr', '--repo', '--cwd', '--worktree-root', '--message'];

export function parseSyncArgs(argv: string[]): Flags {
  const f: Flags = { sub: argv[0] ?? '', pr: null, repo: null, cwd: process.cwd(), worktreeRoot: null, forkClaims: false, acceptDiffChange: false, acceptFullRisk: false, message: null, argv };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') break;
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new PrContextError(`${a} needs a value`, 2);
      return v;
    };
    if (a === '--pr') f.pr = val();
    else if (a === '--repo') f.repo = val();
    else if (a === '--cwd') f.cwd = path.resolve(val());
    else if (a === '--worktree-root') f.worktreeRoot = path.resolve(val());
    else if (a === '--message') f.message = path.resolve(val());
    else if (a === '--fork-claims') f.forkClaims = true;
    else if (a === '--accept-diff-change') f.acceptDiffChange = true;
    else if (a === '--accept-full-risk') f.acceptFullRisk = true;
    else if (a === '--yes') { /* checked by requireApproval */ }
    else throw new PrContextError(`unknown option ${a}`, 2);
  }
  return f;
}

interface Ctx {
  d: SyncDeps; f: Flags; cwd: string; repo: string; pr: PrInfo; headRemote: string; upRemote: string;
  topic: string; stateDir: string;
}

function gitOk(d: SyncDeps, cwd: string, args: string[], what: string, opts: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number } = {}): string {
  const r = d.git(args, { cwd, ...opts });
  if (r.status !== 0) throw new PrContextError(`${what} failed: ${(r.error ?? r.stderr).trim().split('\n').slice(-2).join(' / ')}`, 1);
  return r.stdout;
}

function show(d: SyncDeps, cwd: string, rev: string, file: string): string | null {
  const r = d.git(['show', `${rev}:${file}`], { cwd });
  return r.status === 0 ? r.stdout : null;
}

function isAncestor(d: SyncDeps, cwd: string, a: string, b: string): boolean {
  const r = d.git(['merge-base', '--is-ancestor', a, b], { cwd });
  if (r.status === 0) return true;
  if (r.status === 1) return false;
  throw new PrContextError(`git merge-base --is-ancestor failed: ${r.stderr.trim()}`, 1);
}

function resolveCtx(d: SyncDeps, f: Flags): Ctx {
  if (!f.pr) throw new PrContextError('--pr is required', 2);
  const repo = f.repo ?? upstreamRepoFromGh(d.gh, f.cwd);
  const n = parsePrRefFor(f.pr, repo);
  const pr = readPr(d.gh, repo, n);
  // abort and status only read or remove what this tool made locally, so
  // they also run for a PR that is no longer OPEN: the way to clear a sync a
  // closed PR left staged in a topic dir a newer PR from its branch now uses.
  const local = f.sub === 'abort' || f.sub === 'status';
  assertWritableIdentity(local && pr.state !== 'OPEN' ? { ...pr, state: 'OPEN' } : pr, viewerLogin(d.gh));
  const headRemote = remoteForRepo(d.git, f.cwd, pr.headRepo, 'github.com', d.sshHostName);
  if (!headRemote) throw new PrContextError(`no git remote in ${f.cwd} points at ${pr.headRepo}`, 30);
  const upRemote = remoteForRepo(d.git, f.cwd, repo, 'github.com', d.sshHostName);
  if (!upRemote) throw new PrContextError(`no git remote in ${f.cwd} points at ${repo}`, 30);
  const branch = gitOk(d, f.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], 'git rev-parse').trim();
  if (branch !== pr.headRef) throw new PrContextError(`the PR worktree is on ${branch}, not the PR head branch ${pr.headRef} (keep the local name equal to the head ref)`, 30);
  const topic = topicFor(pr.headRef);
  return { d, f, cwd: f.cwd, repo, pr, headRemote, upRemote, topic, stateDir: prStateDir({ cwd: f.cwd, topic, env: d.env }) };
}

interface Pinned { h0: string; b: string; m0: string; mainVersion: string; oldVersion: string; baseVersion: string }

function pinHeads(c: Ctx): Pinned {
  const { d, cwd, pr } = c;
  const h0 = pinBranch(d.git, cwd, c.headRemote, pr.headRef).sha;
  if (h0 !== pr.headOid) throw new PrContextError(`${c.headRemote}/${pr.headRef} is ${h0.slice(0, 12)} but the PR reports ${pr.headOid.slice(0, 12)}: someone pushed; re-run`, SYNC_EXIT.REMOTE_MOVED);
  const b = pinBranch(d.git, cwd, c.upRemote, pr.baseRef).sha;
  const local = gitOk(d, cwd, ['rev-parse', 'HEAD'], 'git rev-parse HEAD').trim();
  if (local !== h0 && !isAncestor(d, cwd, local, h0)) {
    throw new PrContextError(`the local ${pr.headRef} has commits that are not on ${c.headRemote} (push or drop them first; a sync never carries unpublished work)`, SYNC_EXIT.DIRTY);
  }
  const m0 = gitOk(d, cwd, ['merge-base', h0, b], 'git merge-base').trim();
  const v = (rev: string) => (show(d, cwd, rev, 'VERSION') ?? '').trim();
  return { h0, b, m0, mainVersion: v(b), oldVersion: v(h0), baseVersion: v(m0) };
}

interface Pre { block: string | null; release: boolean }

/** Preconditions on the state before the sync (code 30 on any failure). */
function preconditions(c: Ctx, p: Pinned): Pre {
  const { d, cwd } = c;
  const fail = (why: string) => new PrContextError(`precondition: ${why}`, SYNC_EXIT.PRECONDITION);
  for (const file of PLATFORM_FILES) {
    if (d.git(['cat-file', '-e', `${p.b}:${file}`], { cwd }).status !== 0) throw fail(`${file} is missing upstream; gstack-pr-sync only syncs gstack-shaped trees`);
  }
  const clBase = show(d, cwd, p.m0, 'CHANGELOG.md') ?? '';
  const clHead = show(d, cwd, p.h0, 'CHANGELOG.md') ?? '';
  const cb = changelogBlock(clBase, clHead);
  if (!cb) throw fail('the PR changes CHANGELOG.md beyond one entry inserted on top (an older entry or the header was edited)');
  const pkgBase = show(d, cwd, p.m0, 'package.json');
  const pkgHead = show(d, cwd, p.h0, 'package.json');
  if (pkgBase !== null && pkgHead !== null && !jsonSameExceptVersion(pkgBase, pkgHead)) throw fail('the PR changes package.json beyond .version, so package.json is code for this PR');
  let release = true;
  if (cb.headings.length === 0) {
    if (p.oldVersion === p.baseVersion) release = false;
    else throw fail(`VERSION moved ${p.baseVersion} -> ${p.oldVersion} with no CHANGELOG entry`);
  } else if (cb.headings.length > 1) {
    throw fail(`the PR carries ${cb.headings.length} CHANGELOG entries; collapse them into one first`);
  } else if (cb.headings[0] !== p.oldVersion) {
    throw fail(`the CHANGELOG entry is [${cb.headings[0]}] but VERSION is ${p.oldVersion}`);
  }
  const ours = new Set(gitOk(d, cwd, ['diff', '--name-only', p.m0, p.h0], 'git diff').split('\n').filter(Boolean));
  const theirs = gitOk(d, cwd, ['diff', '--name-only', p.m0, p.b], 'git diff').split('\n').filter(Boolean);
  const both = RELEASE_TOOLING.filter(t => ours.has(t) && theirs.includes(t));
  if (both.length) throw fail(`release tooling changed on both sides (${both.join(', ')}); sync by hand`);
  return { block: release ? cb.block : null, release };
}

/**
 * A conflicted path is generated only when its template exists on BOTH
 * sides. When upstream introduced the template, the PR's edits to the file
 * were made by hand, and regenerating it would silently drop them: code.
 */
function isGeneratedIn(d: SyncDeps, cwd: string, revs: string[]): (p: string) => boolean {
  return p => GENERATED_EXTRA.includes(p) || revs.every(rev => d.git(['cat-file', '-e', `${rev}:${p}.tmpl`], { cwd }).status === 0);
}

/**
 * Read-only dry run: objects go to a throwaway directory, the repo is not
 * touched. It runs with the caller's whole env plus the object dirs, so it
 * finds the same git and reads the same config (HOME, GIT_CONFIG_*) as the
 * real merge: a user `merge.renames=false` conflicts in both or neither.
 */
function dryMerge(c: Ctx, p: Pinned): { tree: string; conflicts: string[]; clean: boolean } {
  const { d, cwd } = c;
  const common = path.resolve(cwd, gitOk(d, cwd, ['rev-parse', '--git-common-dir'], 'git rev-parse').trim());
  const objdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pr-sync-objects-'));
  try {
    const r = d.git(['merge-tree', '--write-tree', '--name-only', '--no-messages', p.h0, p.b], {
      cwd, env: { ...d.env, GIT_OBJECT_DIRECTORY: objdir, GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(common, 'objects') },
    });
    if (r.status !== 0 && r.status !== 1) throw new PrContextError(`git merge-tree failed: ${r.stderr.trim()}`, 1);
    return { ...parseMergeTree(r.stdout), clean: r.status === 0 };
  } finally {
    fs.rmSync(objdir, { recursive: true, force: true });
  }
}

// ── plan ────────────────────────────────────────────────────────────────────

function cmdPlan(c: Ctx): number {
  const p = pinHeads(c);
  const pre = preconditions(c, p);
  const upToDate = isAncestor(c.d, c.cwd, p.b, p.h0);
  if (upToDate) {
    c.d.out(`RESULT UP_TO_DATE head=${p.h0.slice(0, 12)} base=${p.b.slice(0, 12)} version=${p.oldVersion}`);
    c.d.out('NOTE merge would only re-check the version queue');
    return SYNC_EXIT.NOTHING;
  }
  const m = dryMerge(c, p);
  const cls = classifyConflicts(m.conflicts, isGeneratedIn(c.d, c.cwd, [p.b, p.h0]));
  const word = cls.code.length ? 'CODE_CONFLICT' : 'MECHANICAL';
  c.d.out(`RESULT ${word} head=${p.h0.slice(0, 12)} base=${p.b.slice(0, 12)} main=${p.mainVersion} ours=${p.oldVersion} release=${pre.release ? 'yes' : 'no'}`);
  for (const [k, list] of Object.entries(cls)) for (const file of list) c.d.out(`CONFLICT\t${k}\t${file}`);
  return cls.code.length ? SYNC_EXIT.CODE_CONFLICT : SYNC_EXIT.SYNCED;
}

// ── merge ───────────────────────────────────────────────────────────────────

/** Written into a scratch worktree's admin dir (`<common>/worktrees/<id>`) by merge: proof that this tool made it. */
const SCRATCH_MARKER = 'gstack-pr-sync.json';

function defaultScratch(c: Ctx): string {
  const root = c.f.worktreeRoot ?? path.join(os.homedir(), 'worktrees', c.repo.split('/')[1]);
  return path.join(root, `${c.topic}-sync`);
}

/** `p` with the symlinks of its deepest existing ancestor resolved: one spelling for a path that may be gone. */
function canonPath(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(canonPath(parent), path.basename(abs));
  }
}

/** `<common>/worktrees`, where git keeps one admin dir per linked worktree. */
function adminRoot(c: Ctx): string | null {
  const common = c.d.git(['rev-parse', '--git-common-dir'], { cwd: c.cwd });
  return common.status === 0 ? path.join(canonPath(path.resolve(c.cwd, common.stdout.trim())), 'worktrees') : null;
}

/**
 * The worktree of this repository registered at `dir`: whether it is
 * detached, and its admin dir under `<common>/worktrees/`. Null when `dir`
 * is not a worktree of this repository (another repo, a plain directory).
 */
function worktreeAt(c: Ctx, dir: string): { detached: boolean; admin: string } | null {
  const list = c.d.git(['worktree', 'list', '--porcelain'], { cwd: c.cwd });
  if (list.status !== 0) return null;
  const want = canonPath(dir);
  const block = list.stdout.split('\n\n').map(b => b.split('\n')).find(b => b[0]?.startsWith('worktree ') && canonPath(b[0].slice(9)) === want);
  if (!block) return null;
  let dotgit = '';
  try {
    dotgit = fs.readFileSync(path.join(dir, '.git'), 'utf8');
  } catch {
    return null;
  }
  const m = /^gitdir: (.+)$/m.exec(dotgit);
  const root = adminRoot(c);
  if (!m || !root) return null;
  const admin = canonPath(path.resolve(dir, m[1].trim()));
  if (path.dirname(admin) !== root) return null;
  return { detached: block.includes('detached'), admin };
}

/**
 * The admin dir of the registration whose gitdir names `<dir>/.git`, for a
 * worktree whose directory is gone (so its `.git` file cannot be read).
 * Null when no registration names it.
 */
function registrationFor(c: Ctx, dir: string): string | null {
  const root = adminRoot(c);
  if (!root) return null;
  const want = canonPath(path.join(dir, '.git'));
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const id of ids) {
    const admin = path.join(root, id);
    try {
      // gitdir is absolute, or relative to the admin dir (worktree.useRelativePaths).
      if (canonPath(path.resolve(admin, fs.readFileSync(path.join(admin, 'gitdir'), 'utf8').trim())) === want) return admin;
    } catch { /* not a worktree admin dir */ }
  }
  return null;
}

function markScratch(c: Ctx, scratch: string, h0: string): void {
  const wt = worktreeAt(c, scratch);
  if (!wt) throw new PrContextError(`git worktree add did not register ${scratch}`, 1);
  fs.writeFileSync(path.join(wt.admin, SCRATCH_MARKER), JSON.stringify({ tool: 'gstack-pr-sync', repo: c.repo, number: c.pr.number, headRef: c.pr.headRef, h0 }) + '\n');
}

/** The admin dir carries merge's marker for this PR. */
function carriesOurMarker(c: Ctx, admin: string): boolean {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(admin, SCRATCH_MARKER), 'utf8')) as Record<string, unknown>;
    return m.tool === 'gstack-pr-sync' && m.repo === c.repo && m.number === c.pr.number;
  } catch {
    return false;
  }
}

/** A detached worktree of this repository carrying merge's marker for this PR. */
function isOurScratch(c: Ctx, dir: string): boolean {
  const wt = worktreeAt(c, dir);
  return !!wt?.detached && carriesOurMarker(c, wt.admin);
}

/**
 * Remove a scratch worktree, only through `git worktree remove` and only one
 * this tool made: `made` (this run created it) or isOurScratch. Anything
 * else at the path (another repository, the owner's own worktree, a plain
 * directory) is left as it is: 'foreign'. Never a recursive delete, and
 * never `git worktree prune`, which would also drop every other worktree of
 * the repository whose directory is missing right now (a moved directory,
 * an unmounted volume) and orphan a detached one's commits. A scratch whose
 * directory is gone loses only its own registration, and only when that
 * registration is detached and carries this PR's marker.
 */
function removeScratch(c: Ctx, scratch: string, made = false): 'removed' | 'absent' | 'foreign' | 'failed' {
  if (!fs.existsSync(scratch)) {
    const admin = registrationFor(c, scratch);
    let head = '';
    try {
      head = admin ? fs.readFileSync(path.join(admin, 'HEAD'), 'utf8') : '';
    } catch { /* no HEAD: not a registration to touch */ }
    if (admin && /^[0-9a-f]{40,64}\s*$/.test(head) && carriesOurMarker(c, admin)) {
      c.d.git(['worktree', 'remove', '--force', scratch], { cwd: c.cwd });
      if (fs.existsSync(admin)) c.d.err(`gstack-pr-sync: git worktree remove left the registration of ${scratch} in place; run \`git worktree remove --force ${scratch}\``);
    }
    return 'absent';
  }
  if (!made && !isOurScratch(c, scratch)) return 'foreign';
  c.d.git(['worktree', 'remove', '--force', scratch], { cwd: c.cwd });
  if (!fs.existsSync(scratch)) return 'removed';
  c.d.err(`gstack-pr-sync: git worktree remove left ${scratch} in place; remove it by hand`);
  return 'failed';
}

function patchId(d: SyncDeps, cwd: string, a: string, b: string, file: string | null, unified: number): string {
  const args = ['diff', `-U${unified}`, '--no-color', '--no-ext-diff', a, b];
  if (file) args.push('--', file);
  const diff = d.git(args, { cwd });
  if (diff.status !== 0) throw new PrContextError(`git diff for patch-id failed: ${diff.stderr.trim()}`, 1);
  if (!diff.stdout) return '';
  const id = d.git(['patch-id', '--stable'], { cwd, input: diff.stdout });
  return (id.stdout.trim().split(/\s+/)[0] ?? '');
}

function diffNames(d: SyncDeps, cwd: string, a: string, b: string, exclude: string[]): string[] {
  const args = ['diff', '--name-only', a, b, '--', '.', ...exclude.map(e => `:(exclude)${e}`)];
  return gitOk(d, cwd, args, 'git diff --name-only').split('\n').filter(Boolean).sort();
}

/** L2: the PR's per-file diff before (M0..H0) and after (B..T2) the sync. */
export function proveDiff(d: SyncDeps, cwd: string, x: { m0: string; h0: string; b: string; t2: string; exclude: string[] }): { verdict: ProofVerdict; changed: string[]; oldId: string; newId: string } {
  const oldFiles = diffNames(d, cwd, x.m0, x.h0, x.exclude);
  const newFiles = diffNames(d, cwd, x.b, x.t2, x.exclude);
  const mainTouched = new Set(diffNames(d, cwd, x.m0, x.b, []));
  const changed: string[] = [];
  let context = false;
  for (const f of [...new Set([...oldFiles, ...newFiles])].sort()) {
    if (!oldFiles.includes(f) || !newFiles.includes(f)) { changed.push(f); continue; }
    if (patchId(d, cwd, x.m0, x.h0, f, 3) === patchId(d, cwd, x.b, x.t2, f, 3)) continue;
    if (mainTouched.has(f) && patchId(d, cwd, x.m0, x.h0, f, 0) === patchId(d, cwd, x.b, x.t2, f, 0)) { context = true; continue; }
    changed.push(f);
  }
  const verdict: ProofVerdict = changed.length ? 'CHANGED' : context ? 'CONTEXT-ONLY' : 'IDENTICAL';
  return { verdict, changed, oldId: patchId(d, cwd, x.m0, x.h0, null, 3).slice(0, 12), newId: patchId(d, cwd, x.b, x.t2, null, 3).slice(0, 12) };
}

function localDate(now: Date): string {
  const z = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${z(now.getMonth() + 1)}-${z(now.getDate())}`;
}

function readQueue(c: Ctx, scratch: string, p: Pinned, level: string): QueueAnswer {
  const r = c.d.tool(path.join(scratch, 'bin', 'gstack-next-version'), [
    '--base', c.pr.baseRef, '--bump', level, '--current-version', p.mainVersion, '--workspace-root', 'null', '--exclude-pr', String(c.pr.number),
  ], { cwd: scratch, env: { GH_REPO: c.repo }, timeoutMs: 300_000 });
  return qualifyQueue(r, p.mainVersion);
}

/** Advisory: maintainers honour fork PRs' VERSION claims that next-version cannot see. */
function forkClaims(c: Ctx, version: string): string[] {
  const notes: string[] = [];
  const list = c.d.gh(['pr', 'list', '--repo', c.repo, '--state', 'open', '--base', c.pr.baseRef, '--limit', '200', '--json', 'number,headRefOid,headRepositoryOwner,headRepository,updatedAt']);
  if (list.status !== 0) return ['fork-claim scan skipped: gh pr list failed'];
  let prs: { number: number; headRefOid: string; headRepositoryOwner?: { login?: string }; headRepository?: { name?: string }; updatedAt?: string }[];
  try {
    prs = JSON.parse(list.stdout);
  } catch {
    return ['fork-claim scan skipped: gh pr list printed no JSON'];
  }
  if (prs.length >= 200) notes.push('the open-PR listing hit its 200 limit: the queue view is truncated');
  const owner = c.repo.split('/')[0].toLowerCase();
  const forks = prs
    .filter(x => x.number !== c.pr.number && x.headRepositoryOwner?.login && x.headRepositoryOwner.login.toLowerCase() !== owner && x.headRepository?.name)
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, 40);
  for (const x of forks) {
    const r = c.d.gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${x.headRepositoryOwner?.login}/${x.headRepository?.name}/contents/VERSION?ref=${x.headRefOid}`]);
    if (r.status === 0 && r.stdout.trim() === version) notes.push(`fork PR #${x.number} also carries VERSION ${version} (advisory: maintainers honour fork claims)`);
  }
  return notes;
}

function writeFile(dir: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
}

interface MergeResult { code: number; staged: StagedSync | null }

function cmdMerge(c: Ctx): number {
  const { d } = c;
  const p = pinHeads(c);
  const pre = preconditions(c, p);
  const upToDate = isAncestor(d, c.cwd, p.b, p.h0);
  let dry: { tree: string; conflicts: string[]; clean: boolean } | null = null;
  let generatedConflicts: string[] = [];
  const isGen = isGeneratedIn(d, c.cwd, [p.b, p.h0]);
  if (!upToDate) {
    dry = dryMerge(c, p);
    const cls = classifyConflicts(dry.conflicts, isGen);
    if (cls.code.length) {
      d.out(`RESULT CODE_CONFLICT head=${p.h0.slice(0, 12)} base=${p.b.slice(0, 12)}`);
      for (const file of cls.code) d.out(`CONFLICT\tcode\t${file}`);
      return SYNC_EXIT.CODE_CONFLICT;
    }
    generatedConflicts = cls.generated;
  }
  const existing = readStagedSync(c.stateDir, c.pr);
  // Another PR's state.json (30) would refuse the record at the end: refuse it before any worktree is made.
  readStateFor(c.stateDir, c.pr);
  const scratch = defaultScratch(c);
  if (existing) throw new PrContextError(`a sync is already staged at ${existing.scratch}: push it or run \`gstack-pr-sync abort\``, SYNC_EXIT.DIRTY);
  if (fs.existsSync(scratch)) {
    if (isOurScratch(c, scratch)) throw new PrContextError(`an interrupted merge left its scratch worktree at ${scratch}: run \`gstack-pr-sync abort\` to remove it`, SYNC_EXIT.DIRTY);
    throw new PrContextError(`${scratch} already exists and is not a scratch worktree gstack-pr-sync made: move it or pass --worktree-root (nothing was touched)`, SYNC_EXIT.DIRTY);
  }
  fs.mkdirSync(path.dirname(scratch), { recursive: true });
  gitOk(d, c.cwd, ['worktree', 'add', '--detach', scratch, p.h0], 'git worktree add');
  // No signal listener: stageSync is synchronous (spawnSync throughout), so a
  // JS handler could never run before it returns, and installing one would
  // only replace the default action and swallow SIGINT/SIGTERM. A signal ends
  // the merge; `abort` removes the scratch it leaves (merge says so next time).
  try {
    markScratch(c, scratch, p.h0);
    const r = stageSync(c, p, pre, scratch, upToDate, dry, generatedConflicts);
    if (r.staged === null) removeScratch(c, scratch, true);
    return r.code;
  } catch (error) {
    removeScratch(c, scratch, true);
    throw error;
  }
}

function stageSync(c: Ctx, p: Pinned, pre: Pre, scratch: string, upToDate: boolean, dry: { tree: string; conflicts: string[] } | null, generatedConflicts: string[]): MergeResult {
  const { d } = c;
  const s = (args: string[], what: string, opts: { env?: NodeJS.ProcessEnv; input?: string } = {}) => gitOk(d, scratch, args, what, opts);
  let automerge: string | null = null;
  if (!upToDate && dry) {
    const m = d.git(['merge', '--no-ff', '--no-commit', p.b], { cwd: scratch });
    if (m.status !== 0 && m.status !== 1) throw new PrContextError(`git merge failed: ${m.stderr.trim()}`, 1);
    const unmerged = s(['diff', '--name-only', '--diff-filter=U'], 'git diff').split('\n').filter(Boolean).sort();
    if (unmerged.join('\n') !== [...dry.conflicts].sort().join('\n')) {
      throw new PrContextError(`the merge conflicted on ${unmerged.join(', ') || 'nothing'}, not the dry run's ${dry.conflicts.join(', ') || 'nothing'}`, 1);
    }
    // The automerge tree, for L1. Its objects land in the repo (unreferenced, gc-able).
    const mt = d.git(['merge-tree', '--write-tree', '--name-only', '--no-messages', p.h0, p.b], { cwd: scratch });
    if (mt.status !== 0 && mt.status !== 1) throw new PrContextError(`git merge-tree failed: ${mt.stderr.trim()}`, 1);
    automerge = parseMergeTree(mt.stdout).tree;
    for (const file of ['VERSION', 'package.json', DIGEST]) {
      const text = show(d, scratch, p.b, file);
      if (text !== null) writeFile(scratch, file, text);
    }
    writeFile(scratch, 'CHANGELOG.md', show(d, scratch, p.b, 'CHANGELOG.md') ?? '');
    s(['add', '--', ...RELEASE_FILES.filter(f => fs.existsSync(path.join(scratch, f)))], 'git add release files');
  }

  // Dependencies for every tool below, from the merged tree's own lockfile
  // (upstream may have moved it); the up-to-date path installs too.
  if (fs.existsSync(path.join(scratch, 'bun.lock'))) {
    const inst = d.tool('bun', ['install', '--frozen-lockfile'], { cwd: scratch, timeoutMs: 300_000 });
    if (inst.status !== 0) throw new PrContextError(`bun install in the scratch worktree failed: ${(inst.error ?? inst.stderr).trim().split('\n').at(-1)}`, 1);
  }

  // Version: re-check the queue on every sync, including the up-to-date path.
  // With no release of our own, VERSION is upstream's (taken with the release files).
  let version = pre.release ? p.oldVersion : p.mainVersion;
  let kept = pre.release;
  let queue: QueueAnswer | null = null;
  const advisories: string[] = [];
  if (pre.release) {
    const level = d.tool('bun', ['run', 'scripts/detect-bump.ts', p.baseVersion, p.oldVersion], { cwd: scratch, timeoutMs: 60_000 });
    const lvl = level.stdout.trim();
    if (level.status !== 0 || !/^(major|minor|patch|micro)$/.test(lvl)) throw new PrContextError(`scripts/detect-bump.ts gave no level: ${level.stderr.trim()}`, SYNC_EXIT.VERSION_SOURCE);
    if (!upToDate) writeFile(scratch, 'VERSION', `${p.mainVersion}\n`);
    queue = readQueue(c, scratch, p, lvl);
    ({ version, kept } = pickVersion(p.oldVersion, p.mainVersion, queue));
    if (c.f.forkClaims) advisories.push(...forkClaims(c, version));
  }
  if (upToDate && version === p.oldVersion) {
    d.out(`RESULT NOTHING head=${p.h0.slice(0, 12)} base=${p.b.slice(0, 12)} version=${version} (up to date, version unclaimed)`);
    for (const a of advisories) d.out(`ADVISORY ${a}`);
    return { code: SYNC_EXIT.NOTHING, staged: null };
  }

  // Generated files: regenerate when the merge conflicted on them or left them stale.
  const regenerated = new Set<string>(generatedConflicts);
  const gen = (dry: boolean) => d.tool('bun', ['run', 'gen:skill-docs', ...(dry ? ['--dry-run'] : [])], { cwd: scratch, timeoutMs: 600_000 });
  if (!upToDate && (generatedConflicts.length || gen(true).status !== 0)) {
    const g = gen(false);
    if (g.status !== 0) throw new PrContextError(`gen:skill-docs failed in the scratch worktree: ${(g.error ?? g.stderr).trim().split('\n').at(-1)}`, 1);
    // Only what the generator itself rewrote (worktree vs index); the merge's own staged files are not its doing.
    const touched = s(['diff', '--name-only'], 'git diff').split('\n').filter(Boolean);
    // The agents digest is generator output on every path: with no release of
    // our own, nothing else would stage the one gen:skill-docs just rebuilt.
    if (touched.includes(DIGEST)) s(['add', '--', DIGEST], 'git add the agents digest');
    for (const file of touched) {
      if (RELEASE_FILES.includes(file)) continue;
      if (!GENERATED_EXTRA.includes(file) && !fs.existsSync(path.join(scratch, `${file}.tmpl`))) {
        throw new PrContextError(`gen:skill-docs changed ${file}, which is not a generated file`, 1);
      }
      regenerated.add(file);
    }
    if (regenerated.size) s(['add', '--', ...regenerated], 'git add generated');
  }

  // Release files: VERSION, package.json and the digest via the merged tree's own tool, then the CHANGELOG splice.
  let newBlock = '';
  if (pre.release) {
    const bump = d.tool(path.join(scratch, 'bin', 'gstack-version-bump'), ['write', '--version', version, '--regen-digest'], { cwd: scratch, timeoutMs: 120_000 });
    let wrote: Record<string, unknown> = {};
    try {
      wrote = JSON.parse(bump.stdout) as Record<string, unknown>;
    } catch { /* checked below */ }
    if (bump.status !== 0 || wrote.wrote !== version || wrote.packageJson !== true) {
      throw new PrContextError(`bin/gstack-version-bump write --version ${version} failed (exit ${bump.status}): ${bump.stderr.trim().split('\n').at(-1) ?? ''}`, bump.status === 3 ? 1 : SYNC_EXIT.VERSION_SOURCE);
    }
    if (wrote.agentsDigest !== true) {
      const dg = d.tool('bun', ['scripts/gen-agents-digest.ts'], { cwd: scratch, timeoutMs: 120_000 });
      if (dg.status !== 0) throw new PrContextError('scripts/gen-agents-digest.ts failed', 1);
    }
    // Up to date means B is an ancestor of H0, so B is also the merge base: one formula for both paths.
    const baseCl = show(d, scratch, p.b, 'CHANGELOG.md') ?? '';
    const date = version === p.oldVersion ? (blockDate(pre.block ?? '') ?? localDate(d.now())) : localDate(d.now());
    newBlock = renameBlockHeading(pre.block ?? '', version, date);
    writeFile(scratch, 'CHANGELOG.md', rebuildChangelog(baseCl, newBlock));
    s(['add', '--', ...RELEASE_FILES.filter(f => fs.existsSync(path.join(scratch, f)))], 'git add release files');
  }
  if (!upToDate) {
    const final = gen(true);
    if (final.status !== 0) throw new PrContextError('gen:skill-docs --dry-run still reports STALE files after the sync', 1);
  }

  checkInvariants(c, p, pre, scratch, version, queue, newBlock);

  // Proof. L1: nothing outside release and generated files differs from git's own automerge.
  const t2 = s(['write-tree'], 'git write-tree').trim();
  let proof: { verdict: ProofVerdict; changed: string[]; oldId: string; newId: string } = { verdict: 'IDENTICAL', changed: [], oldId: '', newId: '' };
  if (!upToDate && automerge) {
    const exclude = proofExclusions(d, scratch, p, t2, regenerated);
    const l1 = diffNames(d, scratch, automerge, t2, exclude);
    proof = proveDiff(d, scratch, { m0: p.m0, h0: p.h0, b: p.b, t2, exclude });
    if (l1.length) proof = { ...proof, verdict: 'CHANGED', changed: [...new Set([...proof.changed, ...l1])].sort() };
  }

  const msg = commitMessage(c, p, { upToDate, release: pre.release, conflicts: dry?.conflicts ?? [], version, kept, regenerated: regenerated.size, proof });
  s(['commit', '-q', '-F', '-'], 'git commit', { input: msg });
  const sha = s(['rev-parse', 'HEAD'], 'git rev-parse').trim();
  const staged: StagedSync = {
    v: 1, repo: c.repo, number: c.pr.number, headRef: c.pr.headRef, kind: upToDate ? 'release-only' : 'merge',
    h0: p.h0, base: p.b, baseRef: c.pr.baseRef, mainVersion: p.mainVersion, oldVersion: p.oldVersion, version,
    sha, proof: proof.verdict, changedFiles: proof.changed, scratch, at: d.now().toISOString(),
  };
  withPrLock(c.stateDir, () => {
    const st = readStateFor(c.stateDir, c.pr) ?? freshState(c.pr, { headRemote: c.headRemote, upstreamRemote: c.upRemote });
    writeState(c.stateDir, st);
    writeStagedSync(c.stateDir, staged);
  });
  const code = proof.verdict === 'CHANGED' ? SYNC_EXIT.DIFF_CHANGED : SYNC_EXIT.SYNCED;
  d.out(`RESULT ${code ? 'DIFF_CHANGED' : 'STAGED'} sha=${sha.slice(0, 12)} kind=${staged.kind} version=${p.oldVersion}->${version} release=${pre.release ? 'yes' : 'no'} proof=${proof.verdict} scratch=${scratch}`);
  for (const f of proof.changed) d.out(`CHANGED\t${f}`);
  for (const a of advisories) d.out(`ADVISORY ${a}`);
  // Some next-version warnings quote another open PR's VERSION file: data, enveloped, never raw.
  const warnings = queue?.warnings ?? [];
  if (warnings.length) {
    d.out(`QUEUE_WARNINGS ${warnings.length} from bin/gstack-next-version (they can quote other PRs' VERSION files):`);
    d.out(envelope(warnings.join('\n'), 'gstack-next-version warnings'));
  }
  d.out('NEXT run gstack-pr-validate in the scratch worktree, then `gstack-pr-sync push --yes` after the owner approves');
  return { code, staged };
}

/**
 * What the code-diff proof leaves out: release files, files that were
 * already generated at the PR head (their changes come from templates,
 * which stay in), and files generated after the sync or regenerated by it,
 * unless the PR edited them by hand while they were not generated. That
 * last case is a PR change, so losing it to regeneration must read CHANGED.
 */
function proofExclusions(d: SyncDeps, cwd: string, p: Pinned, t2: string, regenerated: Set<string>): string[] {
  const genH0 = new Set(listGenerated(d, cwd, p.h0));
  const ours = new Set(diffNames(d, cwd, p.m0, p.h0, []));
  const byHand = (f: string) => ours.has(f) && !genH0.has(f);
  const later = [...listGenerated(d, cwd, t2), ...regenerated].filter(f => !byHand(f));
  return [...new Set([...RELEASE_FILES, ...genH0, ...later])];
}

/** Tracked generated files in a tree: a sibling .tmpl exists, or a known extra. */
function listGenerated(d: SyncDeps, cwd: string, tree: string): string[] {
  const files = gitOk(d, cwd, ['ls-tree', '-r', '--name-only', tree], 'git ls-tree').split('\n').filter(Boolean);
  const set = new Set(files);
  return files.filter(f => GENERATED_EXTRA.includes(f) || set.has(`${f}.tmpl`));
}

function checkInvariants(c: Ctx, p: Pinned, pre: Pre, scratch: string, version: string, queue: QueueAnswer | null, newBlock: string): void {
  const { d } = c;
  const fail = (why: string) => new PrContextError(`invariant: ${why}`, 1);
  const read = (f: string) => (fs.existsSync(path.join(scratch, f)) ? fs.readFileSync(path.join(scratch, f), 'utf8') : null);
  const base = p.b;
  if (pre.release) {
    if ((read('VERSION') ?? '').trim() !== version) throw fail('VERSION does not hold the chosen version');
    if (cmpVersion(version, p.mainVersion) <= 0) throw fail(`version ${version} is not above upstream's ${p.mainVersion}`);
    if (queue?.claimed.includes(version)) throw fail(`version ${version} is claimed`);
    const pkg = read('package.json');
    const pkgBase = show(d, scratch, base, 'package.json');
    if (pkg !== null && pkgBase !== null) {
      if (!jsonSameExceptVersion(pkg, pkgBase)) throw fail('package.json differs from upstream beyond .version');
      if ((JSON.parse(pkg) as { version?: string }).version !== version.split('.').slice(0, 3).join('.')) throw fail('package.json version does not match');
    }
    const digest = read(DIGEST);
    if (digest !== null && !digest.startsWith(`# gstack digest v${version}`)) throw fail('the agents digest does not name the new version');
  }
  if (!pre.release) {
    if ((read('VERSION') ?? '').trim() !== p.mainVersion) throw fail(`with no release of our own, VERSION must be upstream's ${p.mainVersion}`);
    if (read('package.json') !== show(d, scratch, base, 'package.json')) throw fail("with no release of our own, package.json must be upstream's");
  }
  const cl = read('CHANGELOG.md') ?? '';
  const baseCl = show(d, scratch, base, 'CHANGELOG.md') ?? '';
  if (pre.release) {
    // Upstream's part byte-identical, ours on top, our entry's body unchanged.
    if (cl !== rebuildChangelog(baseCl, newBlock)) throw fail('CHANGELOG.md is not upstream\'s file with our one entry on top');
    const bodyOf = (b: string) => b.slice(b.indexOf('\n') + 1);
    if (bodyOf(newBlock) !== bodyOf(pre.block ?? '')) throw fail('our CHANGELOG entry body changed');
    if (headingRest(newBlock) !== headingRest(pre.block ?? '')) throw fail('our CHANGELOG heading lost the text after its date');
    const top = HEADING_RE.exec(cl.slice(firstEntryOffset(cl)))?.[1];
    if (top !== version) throw fail(`the top CHANGELOG heading is [${top}], not [${version}]`);
  } else if (cl !== baseCl) {
    throw fail('CHANGELOG.md is not upstream\'s file');
  }
  const headings = cl.split('\n').map(l => HEADING_RE.exec(l)?.[1]).filter(Boolean);
  if (new Set(headings).size !== headings.length) throw fail('duplicate CHANGELOG headings');
  for (const f of RELEASE_FILES) {
    const t = read(f);
    if (t !== null && MARKER_RE.test(t)) throw fail(`${f} still holds conflict markers`);
  }
  const unmerged = gitOk(d, scratch, ['diff', '--name-only', '--diff-filter=U'], 'git diff').trim();
  if (unmerged) throw fail(`unmerged paths remain: ${unmerged.replace(/\n/g, ', ')}`);
  // The dry runs read the worktree; the commit is the index. They must be the same tree.
  // Porcelain `XY path`: Y is the worktree against the index (`?` = untracked).
  const loose = gitOk(d, scratch, ['status', '--porcelain'], 'git status').split('\n').filter(l => l.length > 3 && l[1] !== ' ');
  if (loose.length) throw fail(`the scratch worktree has changes the commit would not carry: ${loose.map(l => l.slice(3)).join(', ')}`);
}

function commitMessage(c: Ctx, p: Pinned, x: { upToDate: boolean; release: boolean; conflicts: string[]; version: string; kept: boolean; regenerated: number; proof: { verdict: ProofVerdict; changed: string[]; oldId: string; newId: string } }): string {
  const short = (s: string) => s.slice(0, 9);
  const how = x.kept ? 'kept (above upstream and unclaimed)' : 're-slotted by bin/gstack-next-version';
  if (x.upToDate) {
    return [
      `chore(release): re-version to ${x.version}`,
      '',
      `The PR is up to date with upstream ${c.pr.baseRef} (${short(p.b)}, v${p.mainVersion}), but`,
      `${p.oldVersion} can no longer be used: ${how}. VERSION, package.json, the`,
      'agents digest and the CHANGELOG heading move to the new version; no code changes.',
      '',
    ].join('\n');
  }
  const lines = [
    `Merge upstream ${c.pr.baseRef} (v${p.mainVersion}) into ${c.pr.headRef}`,
    '',
    `Upstream ${c.pr.baseRef} moved to ${short(p.b)} (v${p.mainVersion}).`,
    x.conflicts.length ? `Conflicts: ${x.conflicts.join(', ')}.` : 'No conflicts.',
    ...(x.release
      ? [
        'Release files resolved mechanically: VERSION, package.json and the agents',
        "digest from upstream, then our CHANGELOG entry on top of upstream's entries,",
        'which are byte-identical.',
        `Version: ${p.oldVersion} -> ${x.version}, ${how}.`,
      ]
      : [
        `No release of our own: VERSION (${x.version}), package.json and CHANGELOG.md`,
        "are upstream's; the agents digest is the generator's output for the merged tree.",
      ]),
  ];
  if (x.regenerated) lines.push(`Generated files regenerated: ${x.regenerated} (gen:skill-docs --dry-run clean).`);
  lines.push(`PR diff without release and generated files: ${x.proof.verdict} (patch-id ${x.proof.oldId || '-'} -> ${x.proof.newId || '-'}).`);
  if (x.proof.changed.length) lines.push(`Changed for review: ${x.proof.changed.join(', ')}.`);
  lines.push('');
  return lines.join('\n');
}

// ── push / abort / status ───────────────────────────────────────────────────

/** A refusal whose evidence (git's own output, enveloped) prints after the RESULT line. */
export class SyncError extends PrContextError {
  detail: string[];
  constructor(message: string, code: number, detail: string[]) {
    super(message, code);
    this.detail = detail;
  }
}

/** The URL names OWNER/NAME on a path boundary (https, ssh, scp form, local path), `.git` optional. */
function urlNamesRepo(url: string, repo: string): boolean {
  const u = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
  const want = repo.toLowerCase();
  return u.endsWith(want) && u.length > want.length && '/:'.includes(u[u.length - want.length - 1]);
}

const isGithub = (host: string) => host === 'github.com' || host.endsWith('.github.com');

/**
 * Where a remote URL lands: its host (an ssh alias resolved to the HostName
 * ssh connects to; github.com and its subdomains are one host), or, for a
 * local path, that path with its symlinks resolved.
 */
function urlDestination(url: string, cwd: string, sshHostName: (alias: string) => string | null): string {
  const at = remoteHost(url);
  if (!at) return `path:${canonPath(path.resolve(cwd, url.trim().replace(/^file:\/\//i, '')))}`;
  const host = at.ssh && !isGithub(at.host) ? (sshHostName(at.host) ?? at.host) : at.host;
  return `host:${isGithub(host) ? 'github.com' : host}`;
}

/**
 * The push URLs that would not reach the repository the fetch URL names:
 * each must name OWNER/NAME on a path boundary AND land where the fetch URL
 * does (the same host after ssh-alias resolution, or the same local path).
 * The path alone is not enough: a pushurl on another server with the same
 * OWNER/NAME took a probe's push while the PR head never moved.
 */
export function pushUrlsOffTarget(fetchUrl: string, pushUrls: readonly string[], repo: string, cwd: string, sshHostName: (alias: string) => string | null): string[] {
  const want = urlDestination(fetchUrl, cwd, sshHostName);
  return pushUrls.filter(u => !urlNamesRepo(u, repo) || urlDestination(u, cwd, sshHostName) !== want);
}

/**
 * The head remote was matched by its FETCH URL; `git push` uses
 * remote.<name>.pushurl and url.<base>.pushInsteadOf when set. Every URL a
 * push to it would reach (as git expands them) must name the PR's head
 * repository on the fetch URL's host (or local path), or nothing is sent
 * (30). `cwd` is where the push runs, which a relative local URL is read from.
 */
function assertPushTarget(c: Ctx, cwd: string): void {
  const fetch = c.d.git(['remote', 'get-url', c.headRemote], { cwd: c.cwd });
  if (fetch.status !== 0 || !fetch.stdout.trim()) throw new PrContextError(`git remote get-url ${c.headRemote} failed: ${(fetch.error ?? fetch.stderr).trim()}`, SYNC_EXIT.ERROR);
  const r = c.d.git(['remote', 'get-url', '--push', '--all', c.headRemote], { cwd: c.cwd });
  const urls = r.status === 0 ? r.stdout.split('\n').map(u => u.trim()).filter(Boolean) : [];
  if (!urls.length) throw new PrContextError(`git remote get-url --push ${c.headRemote} failed: ${(r.error ?? r.stderr).trim()}`, SYNC_EXIT.ERROR);
  const off = pushUrlsOffTarget(fetch.stdout.trim(), urls, c.pr.headRepo, cwd, c.d.sshHostName);
  if (off.length) throw new PrContextError(`a push to ${c.headRemote} would go to ${off.length} push URL(s) that are not ${c.pr.headRepo} where its fetch URL is (remote.${c.headRemote}.pushurl or a pushInsteadOf rule): nothing was sent`, SYNC_EXIT.PRECONDITION);
}

/**
 * The one push both writes make: `<sha>` to the PR head ref, fast-forward
 * only, to a push URL that is the head repo, within 60 s of the pre-write
 * gate, receipted, classified by classifyPush. On a refusal it throws with
 * git's whole output (the hook's or the server's reason) as untrusted data.
 */
function pushOrThrow(c: Ctx, cwd: string, sha: string, payloadClass: string, gateAt: number): void {
  assertPushTarget(c, cwd);
  // The plan's pre-write gate runs within 60 s of the write. Counted from when
  // the gate started, so a lock wait or a slow fetch after it cannot stretch it.
  const age = Math.round((c.d.now().getTime() - gateAt) / 1000);
  if (age > GATE_MAX_AGE_S) throw new PrContextError(`the pre-write gate ran ${age} s ago (limit ${GATE_MAX_AGE_S} s): nothing was sent; re-run with the owner's yes`, SYNC_EXIT.PRECONDITION);
  const ref = `refs/heads/${c.pr.headRef}`;
  const r = receiptedSend({ host: 'github.com', payloadClass, consent: 'user ran /pr-prep', env: c.d.env }, () =>
    c.d.git(['push', '--porcelain', c.headRemote, `${sha}:${ref}`], { cwd, timeoutMs: 300_000 }));
  const o = classifyPush(r, ref);
  if (o.landed) return;
  const said = [r.stderr, r.stdout, r.error ?? ''].map(x => x.trim()).filter(Boolean).join('\n');
  throw new SyncError(o.why, o.code, said ? [envelope(said, `git push ${c.headRemote} (${payloadClass})`)] : []);
}

function cmdPush(c: Ctx): number {
  const { d } = c;
  requireApproval(c.f.argv, { valueFlags: VALUE_FLAGS });
  const pending = readStagedSync(c.stateDir, c.pr);
  if (!pending) throw new PrContextError('no sync is staged: run `gstack-pr-sync merge` first', SYNC_EXIT.PRECONDITION);
  // An earlier push of this sync ended UNVERIFIED and the PR now reports it: record it, send nothing.
  if (c.pr.headOid === pending.sha) return recordLatePush(c, pending);
  // The gate polls gstack-pr-watch, which takes the PR lock itself: run it just before taking the lock.
  const gateAt = d.now().getTime();
  const gate = d.preWriteGate({ gh: d.gh, git: d.git, env: d.env, cwd: c.cwd, repo: c.repo, number: c.pr.number, expectHead: pending.h0, state: readStateFor(c.stateDir, c.pr) });
  if (!gate.ok) throw new PrContextError(`pre-write gate: ${gate.reason}`, SYNC_EXIT.PRECONDITION);
  return withPrLock(c.stateDir, () => {
    const staged = readStagedSync(c.stateDir, c.pr);
    if (!staged || staged.sha !== pending.sha) throw new PrContextError('the staged sync changed while the gate ran; re-run push', SYNC_EXIT.PRECONDITION);
    // Retargeted since the merge: pushing would add the old base's commits to the PR's diff.
    if (staged.baseRef !== c.pr.baseRef) throw new PrContextError(`the PR's base changed from ${staged.baseRef} to ${c.pr.baseRef} since the sync was staged: abort and re-sync`, SYNC_EXIT.PRECONDITION);
    const state = readStateFor(c.stateDir, c.pr);
    refuseUnackedLatches(state);
    if (state?.bodyStaleSince) throw new PrContextError(`the PR body is still stale since the push of ${state.bodyStaleSince.slice(0, 12)}: publish the body first`, SYNC_EXIT.BODY_STALE);
    if (!state?.validation || state.validation.sha !== staged.sha) throw new PrContextError(`no validation recorded for ${staged.sha.slice(0, 12)}: run gstack-pr-validate in ${staged.scratch}`, SYNC_EXIT.VALIDATION);
    if (state.validation.worst !== 0) throw new PrContextError(`validation of ${staged.sha.slice(0, 12)} is red (${state.validation.summary})`, SYNC_EXIT.VALIDATION);
    // gstack-pr-validate --accept-full-risk records "FULL waived (<files>)": green without the full suite.
    if (FULL_WAIVED_RE.test(state.validation.summary) && !c.f.acceptFullRisk) {
      throw new PrContextError(`validation of ${staged.sha.slice(0, 12)} waived the full suite (${state.validation.summary}): push it only with the owner's yes to that waiver, then pass --accept-full-risk`, SYNC_EXIT.VALIDATION);
    }
    if (staged.proof === 'CHANGED' && !c.f.acceptDiffChange) throw new PrContextError(`the code-diff proof says CHANGED (${staged.changedFiles.join(', ')}); review, then pass --accept-diff-change`, SYNC_EXIT.DIFF_CHANGED);
    if (!isOurScratch(c, staged.scratch)) throw new PrContextError(`${staged.scratch} is no longer the scratch worktree this sync was staged in: abort and re-sync`, SYNC_EXIT.PRECONDITION);
    const head = gitOk(d, staged.scratch, ['rev-parse', 'HEAD'], 'git rev-parse').trim();
    if (head !== staged.sha) throw new PrContextError(`the scratch worktree moved to ${head.slice(0, 12)} after the sync was staged`, SYNC_EXIT.PRECONDITION);
    const parent = gitOk(d, staged.scratch, ['rev-parse', `${staged.sha}^1`], 'git rev-parse').trim();
    if (parent !== staged.h0) throw new PrContextError('the staged commit is not one commit on top of the PR head', SYNC_EXIT.PRECONDITION);
    const now = pinBranch(d.git, c.cwd, c.headRemote, c.pr.headRef).sha;
    if (now !== staged.h0) throw new PrContextError(`${c.headRemote}/${c.pr.headRef} moved to ${now.slice(0, 12)}; abort and re-sync`, SYNC_EXIT.REMOTE_MOVED);
    pushOrThrow(c, staged.scratch, staged.sha, 'pr-sync-push', gateAt);
    // git exit 0. A PR that still reports H0 after every read-back did not get
    // the commit, as far as anyone can show: nothing is recorded. A failed read
    // is not that evidence, so it still records (the push most likely landed).
    const rb = readback(c, staged.sha, staged.h0);
    if (rb.stillH0) {
      d.out(`RESULT UNVERIFIED sha=${staged.sha.slice(0, 12)} pr=${c.pr.number} readback=${staged.h0.slice(0, 12)} (the head before the push)`);
      d.out(`NOTE git push exited 0 but the PR still reports ${staged.h0.slice(0, 12)}: nothing was recorded (the staged sync, its scratch and the local branch are as they were). Check where \`git remote get-url --push ${c.headRemote}\` sends it. Once the PR reports ${staged.sha.slice(0, 12)}, \`gstack-pr-sync push --yes\` records the push without sending anything; if it never does, \`gstack-pr-sync abort\` and re-sync`);
      return SYNC_EXIT.UNVERIFIED;
    }
    const done = recordPush(c, staged);
    d.out(`RESULT PUSHED sha=${staged.sha.slice(0, 12)} pr=${c.pr.number} readback=${rb.word}`);
    for (const line of [...done, ...rb.detail]) d.out(line);
    return SYNC_EXIT.SYNCED;
  });
}

/**
 * The bookkeeping of a push that reached the PR: the body is stale since
 * the staged commit, the staged sync and the ci: drafts for the old head
 * are gone, the local branch fast-forwards when it is clean, and the
 * scratch is removed. Returns the NOTE lines to print.
 */
function recordPush(c: Ctx, staged: StagedSync): string[] {
  const { d } = c;
  const st = readStateFor(c.stateDir, c.pr) ?? freshState(c.pr, { headRemote: c.headRemote, upstreamRemote: c.upRemote });
  writeState(c.stateDir, { ...st, bodyStaleSince: staged.sha });
  fs.rmSync(syncFile(c.stateDir), { force: true });
  const pruned = pruneDraftsAfterPush(c);
  let local = 'local branch not moved (dirty or diverged)';
  const clean = d.git(['status', '--porcelain', '--untracked-files=no'], { cwd: c.cwd });
  if (clean.status === 0 && !clean.stdout.trim()) {
    const ff = d.git(['merge', '--ff-only', '-q', staged.sha], { cwd: c.cwd });
    if (ff.status === 0) local = `local ${c.pr.headRef} fast-forwarded`;
  }
  const gone = removeScratch(c, staged.scratch);
  return [
    `NOTE ${local}; scratch ${gone === 'removed' || gone === 'absent' ? 'removed' : `left at ${staged.scratch}`}; the PR body is stale until gstack-pr-body publish`,
    ...(pruned ? [pruned] : []),
  ];
}

/**
 * The PR reports the staged commit as its head: an earlier push of it ended
 * UNVERIFIED (GitHub lagged past the read-backs) and has since shown up.
 * Records it once the head remote holds it too. Nothing is sent, so no gate.
 */
function recordLatePush(c: Ctx, pending: StagedSync): number {
  return withPrLock(c.stateDir, () => {
    const staged = readStagedSync(c.stateDir, c.pr);
    if (!staged || staged.sha !== pending.sha) throw new PrContextError('the staged sync changed; re-run push', SYNC_EXIT.PRECONDITION);
    const now = pinBranch(c.d.git, c.cwd, c.headRemote, c.pr.headRef).sha;
    if (now !== staged.sha) throw new PrContextError(`the PR reports ${staged.sha.slice(0, 12)} but ${c.headRemote}/${c.pr.headRef} is ${now.slice(0, 12)}: re-run push`, SYNC_EXIT.REMOTE_MOVED);
    const done = recordPush(c, staged);
    c.d.out(`RESULT PUSHED sha=${staged.sha.slice(0, 12)} pr=${c.pr.number} readback=ok (an earlier push landed; nothing sent now)`);
    for (const line of done) c.d.out(line);
    return SYNC_EXIT.SYNCED;
  });
}

/**
 * After git exit 0: does the PR report the new head? GitHub can lag a few
 * seconds, so it reads up to 5 times. `stillH0` when the last read still
 * shows the head from before the push. A failed read is reported, never
 * thrown.
 */
function readback(c: Ctx, sha: string, h0: string): { word: string; detail: string[]; stillH0: boolean } {
  let seen = '';
  for (let i = 0; i < 5; i++) {
    try {
      seen = readPr(c.d.gh, c.repo, c.pr.number).headOid;
    } catch (error) {
      return { word: 'unverified', stillH0: false, detail: ['NOTE the PR head could not be read back after the push landed (gh failed); check it with gstack-pr-watch poll', envelope((error as Error).message, 'gh pr view')] };
    }
    if (seen === sha) return { word: 'ok', detail: [], stillH0: false };
    if (i < 4) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, c.d.readbackDelayMs);
  }
  return { word: `pending (${seen.slice(0, 12)})`, detail: [], stillH0: seen === h0 };
}

/**
 * One empty `ci:` commit on top of the PR head, pushed fast-forward: the
 * re-run a fork contributor can trigger when `gh run rerun` is refused.
 * Same gates as a sync push (approval, pre-write poll, remote still at H0,
 * receipt); no validation, because the tree is the head's own. The message
 * must be a gstack-pr-ci-triage draft whose binding names this PR, the head
 * the remote holds now and the newest Windows run on it, and whose bytes are
 * the ones triage wrote; otherwise triage's evidence gates would not hold at
 * the push (30: re-run triage).
 */
function cmdRetrigger(c: Ctx): number {
  const { d } = c;
  requireApproval(c.f.argv, { valueFlags: VALUE_FLAGS });
  if (!c.f.message || !fs.existsSync(c.f.message)) throw new PrContextError('--message <drafted ci: message file> is required', 2);
  const { message: msg, binding } = readRetriggerDraft(c.f.message, { stateDir: c.stateDir, repo: c.repo, pr: c.pr.number });
  if (!/^ci: /.test(msg)) throw new PrContextError('the message must be a ci: commit message (draft it with gstack-pr-ci-triage)', 2);
  if (readStagedSync(c.stateDir, c.pr)) throw new PrContextError('a sync is staged: push or abort it first', SYNC_EXIT.DIRTY);
  const st0 = readStateFor(c.stateDir, c.pr);
  if (st0?.bodyStaleSince) throw new PrContextError(`the PR body is still stale since the push of ${st0.bodyStaleSince.slice(0, 12)}: publish the body first`, SYNC_EXIT.BODY_STALE);
  const h0 = pinBranch(d.git, c.cwd, c.headRemote, c.pr.headRef).sha;
  if (h0 !== c.pr.headOid) throw new PrContextError(`${c.headRemote}/${c.pr.headRef} is ${h0.slice(0, 12)} but the PR reports ${c.pr.headOid.slice(0, 12)}`, SYNC_EXIT.REMOTE_MOVED);
  const tree = gitOk(d, c.cwd, ['rev-parse', `${h0}^{tree}`], 'git rev-parse').trim();
  if (binding.head !== h0 || (binding.tree !== null && binding.tree !== tree)) {
    throw new PrContextError(`the draft for run ${binding.run} was triaged on head ${binding.head.slice(0, 12)}, but the PR head is ${h0.slice(0, 12)}: re-run gstack-pr-ci-triage on the current head`, SYNC_EXIT.PRECONDITION);
  }
  assertBoundRunCurrent(c, h0, binding.run);
  const gateAt = d.now().getTime();
  const gate = d.preWriteGate({ gh: d.gh, git: d.git, env: d.env, cwd: c.cwd, repo: c.repo, number: c.pr.number, expectHead: h0, state: st0 });
  if (!gate.ok) throw new PrContextError(`pre-write gate: ${gate.reason}`, SYNC_EXIT.PRECONDITION);
  return withPrLock(c.stateDir, () => {
    // A poll after the gate (the LaunchAgent, another session) may have latched a signal.
    refuseUnackedLatches(readStateFor(c.stateDir, c.pr));
    const sha = gitOk(d, c.cwd, ['commit-tree', tree, '-p', h0, '-F', '-'], 'git commit-tree', { input: msg }).trim();
    if (pinBranch(d.git, c.cwd, c.headRemote, c.pr.headRef).sha !== h0) throw new PrContextError('the remote head moved', SYNC_EXIT.REMOTE_MOVED);
    pushOrThrow(c, c.cwd, sha, 'pr-ci-retrigger-push', gateAt);
    const st = readStateFor(c.stateDir, c.pr) ?? freshState(c.pr, { headRemote: c.headRemote, upstreamRemote: c.upRemote });
    writeState(c.stateDir, { ...st, bodyStaleSince: sha });
    const pruned = pruneDraftsAfterPush(c);
    const clean = d.git(['status', '--porcelain', '--untracked-files=no'], { cwd: c.cwd });
    const ff = clean.status === 0 && !clean.stdout.trim() && d.git(['merge', '--ff-only', '-q', sha], { cwd: c.cwd }).status === 0;
    d.out(`RESULT PUSHED sha=${sha.slice(0, 12)} pr=${c.pr.number} kind=ci-retrigger`);
    d.out(`NOTE ${ff ? `local ${c.pr.headRef} fast-forwarded` : 'local branch not moved (dirty or diverged)'}; the PR body is stale until gstack-pr-body publish`);
    if (pruned) d.out(pruned);
    return SYNC_EXIT.SYNCED;
  });
}

/** A GitHub enum value (status, conclusion) as printable text; anything else prints as '?'. */
const enumWord = (v: unknown): string => (typeof v === 'string' && /^[a-z_]{1,32}$/.test(v) ? v : '?');

/**
 * The run the draft was triaged on must still be the newest Windows Free
 * Tests run on `head` (read-only gh run list) and still a finished failure.
 * A maintainer's "Re-run failed jobs" keeps the run id: in progress, the ci:
 * push would cancel it (the workflow's concurrency group cancels in
 * progress), and green, the push is pointless. Either refuses 30, as does a
 * bound run the list no longer shows; a failed read refuses 1.
 */
function assertBoundRunCurrent(c: Ctx, head: string, run: number): void {
  const r = c.d.gh(['run', 'list', '-R', c.repo, '--workflow', 'windows-free-tests.yml', '--commit', head, '--limit', '20', '--json', 'databaseId,status,conclusion']);
  let runs: unknown = null;
  try {
    runs = r.status === 0 ? JSON.parse(r.stdout) : null;
  } catch {
    runs = null;
  }
  if (!Array.isArray(runs)) throw new PrContextError(`gh run list on ${head.slice(0, 12)} failed, so run ${run} cannot be shown to be the newest: nothing was sent`, SYNC_EXIT.ERROR);
  const listed = runs as { databaseId?: unknown; status?: unknown; conclusion?: unknown }[];
  const newer = listed.map(x => x?.databaseId).filter((id): id is number => typeof id === 'number' && id > run).map(String);
  if (newer.length) throw new PrContextError(`run ${run} is no longer the newest Windows Free Tests run on ${head.slice(0, 12)} (${newer.join(', ')}): re-run gstack-pr-ci-triage`, SYNC_EXIT.PRECONDITION);
  const bound = listed.find(x => x?.databaseId === run);
  if (!bound) throw new PrContextError(`run ${run} is not listed among the Windows Free Tests runs on ${head.slice(0, 12)}: re-run gstack-pr-ci-triage`, SYNC_EXIT.PRECONDITION);
  if (bound.status !== 'completed' || bound.conclusion !== 'failure') {
    throw new PrContextError(`run ${run} is now ${enumWord(bound.status)}/${enumWord(bound.conclusion)}, not the finished failure triage saw (re-run since?): the ci: push would cancel or repeat it; re-run gstack-pr-ci-triage`, SYNC_EXIT.PRECONDITION);
  }
}

/**
 * After a push lands the head has moved, so every ci: draft in the state dir
 * is for an old head: remove them. Best effort (the push is already done):
 * a failure is a NOTE line, never an error, and retrigger refuses an old
 * draft anyway.
 */
function pruneDraftsAfterPush(c: Ctx): string | null {
  try {
    pruneDrafts(c.stateDir);
    return null;
  } catch (error) {
    return `NOTE could not remove the old ci-retrigger drafts in ${c.stateDir} (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); retrigger refuses them`;
  }
}

/**
 * Removes the staged sync, or the scratch an interrupted merge left behind.
 * Refuses (50, nothing touched) when the path holds anything this tool did
 * not make.
 */
function cmdAbort(c: Ctx): number {
  return withPrLock(c.stateDir, () => {
    const staged = readStagedSync(c.stateDir, c.pr);
    const scratch = staged?.scratch ?? defaultScratch(c);
    const gone = removeScratch(c, scratch);
    if (gone === 'foreign') throw new PrContextError(`${scratch} is not a scratch worktree gstack-pr-sync made: nothing was touched (move it away, then re-run abort)`, SYNC_EXIT.DIRTY);
    if (gone === 'failed') throw new PrContextError(`git worktree remove could not remove ${scratch}; the staged sync is kept`, SYNC_EXIT.ERROR);
    fs.rmSync(syncFile(c.stateDir), { force: true });
    c.d.out(`RESULT ABORTED scratch=${scratch} (${gone})`);
    return SYNC_EXIT.SYNCED;
  });
}

function cmdStatus(c: Ctx): number {
  const staged = readStagedSync(c.stateDir, c.pr);
  if (!staged) {
    c.d.out('RESULT NONE no sync staged');
    return SYNC_EXIT.SYNCED;
  }
  const state = readStateFor(c.stateDir, c.pr);
  const v = state?.validation?.sha === staged.sha ? state.validation : null;
  const validated = !v ? 'missing' : v.worst !== 0 ? 'red' : FULL_WAIVED_RE.test(v.summary) ? 'green-full-waived' : 'green';
  c.d.out(`RESULT STAGED sha=${staged.sha.slice(0, 12)} kind=${staged.kind} version=${staged.oldVersion}->${staged.version} proof=${staged.proof} validation=${validated} scratch=${staged.scratch}`);
  return SYNC_EXIT.SYNCED;
}

// ── main ────────────────────────────────────────────────────────────────────

export async function syncMain(argv: string[], deps: Partial<SyncDeps> = {}): Promise<number> {
  const d = { ...realDeps(), ...deps };
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    d.out(SYNC_USAGE);
    return argv.length ? SYNC_EXIT.SYNCED : SYNC_EXIT.USAGE;
  }
  try {
    const f = parseSyncArgs(argv);
    if (!['plan', 'merge', 'push', 'retrigger', 'abort', 'status'].includes(f.sub)) throw new PrContextError(`unknown subcommand ${JSON.stringify(f.sub)}`, 2);
    const c = resolveCtx(d, f);
    switch (f.sub) {
      case 'plan': return cmdPlan(c);
      case 'merge': return cmdMerge(c);
      case 'push': return cmdPush(c);
      case 'retrigger': return cmdRetrigger(c);
      case 'abort': return cmdAbort(c);
      default: return cmdStatus(c);
    }
  } catch (error) {
    if (error instanceof PrContextError) {
      const word = error.code === 2 ? 'USAGE' : error.code === 30 ? 'PRECONDITION' : error.code === 40 ? 'REMOTE_MOVED' : error.code === 41 ? 'HOOK_REFUSED' : 'ERROR';
      d.out(`RESULT ${word} ${error.message}`);
      if (error instanceof SyncError) for (const line of error.detail) d.out(line);
      return error.code;
    }
    d.out(`RESULT ERROR ${(error as Error).message}`);
    return SYNC_EXIT.ERROR;
  }
}
