/**
 * pr-context — the shared core of the /pr-prep lifecycle helpers
 * (bin/gstack-pr-sync, -validate, -body, -watch, -ci-triage, -prep-commits).
 *
 * One home for what every helper needs and must not re-derive: the gh and git
 * runners (injectable, every spawn bounded), PR identity and the checks that a
 * PR is ours to write to, the pinned remote branch, the per-PR state file and
 * its lock, the approval gate, the egress receipt around every network write,
 * and the trust envelope for tracker text.
 *
 * The exported shapes are a frozen contract (pr-drafts SPEC.md, "WP1 frozen
 * interface"); the helpers code against them. Add, never reshape.
 *
 * PrContextError codes (helpers exit with them):
 *    1  a gh or git call failed, or printed output that cannot be parsed;
 *       a state file is unreadable or not a v1 state
 *    2  usage: a bad PR reference, repo, remote, branch or topic name, an
 *       unknown consent string or bad receipt field, a non-finite lock
 *       budget, a write without approval ("WRITE_REFUSED: approval
 *       missing"), or a gh/git write outside receiptedSend()
 *   30  precondition: the PR is not OPEN, its head is not the viewer's, or
 *       its head branch is protected (PROTECTED_HEAD_RE); or the state in
 *       a topic dir belongs to another PR (assertStateFor)
 *   40  the remote branch moved: the pinned ref and `git ls-remote` still
 *       disagree after one refetch, or the branch is not on the remote
 *       (deleted, never pushed, or gone between the fetch and ls-remote)
 *   45  the per-PR lock stayed busy past its budget
 *
 * Egress: receiptedSend() is the only network-write path. defaultGh and
 * defaultGit refuse every write argv isRemoteWrite recognises outside a
 * receiptedSend() send, with code 2, before anything is spawned. That
 * catches a helper's own mistake; it is not a sandbox (see isRemoteWrite).
 * The sink is `pr-prep`, FAIL-OPEN (a dev-workflow op the user asked for;
 * precedent: the git-class user ops): the receipt is written before the
 * send, a receipt failure warns on stderr and the send proceeds, and the
 * outcome is recorded after. Reads (`gh pr view`, `gh api` GET, `git
 * fetch`, `git ls-remote`) are not receipted, the same as gstack-ci-gate
 * and gstack-next-version.
 *
 * State identity: a topic dir does not name one PR (topicFor folds feat/x,
 * feat-x and pr/feat-x; the fork's PR and the upstream PR share a head ref).
 * Helpers read state through readStateFor(dir, pr), or call assertStateFor
 * after every readState, so one PR never inherits another's validation,
 * latched signals or acks; writeState refuses to replace another PR's state.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { GhResult, GhRunner } from './ci-gate';
import { sha256Hex, writeOutcome, writeReceipt } from './egress-receipt';
import { slugFromEnvironment } from './bin-context';
import { resolveStateRoot } from './state-root';
import { wrapUntrustedTrackerContent } from './tracker-guard';

export type { GhResult, GhRunner } from './ci-gate';

export interface GitOpts { cwd: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number }
export type GitRunner = (args: string[], opts: GitOpts) => GhResult;

export class PrContextError extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = 'PrContextError';
    this.code = code;
  }
}

const MAX_BUFFER = 64 * 1024 * 1024;
const GH_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 120_000;
const FETCH_TIMEOUT_MS = 300_000;

function spawnFailure(tool: string, error: Error, timeoutMs: number): string {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return `${tool} is not installed or not on PATH`;
  if (code === 'ETIMEDOUT') return `${tool} timed out after ${timeoutMs} ms`;
  return `${tool} failed to run (${code ?? error.message})`;
}

/** gh subcommands that write to GitHub, by command group, with gh's own aliases (`pr new`, `secret remove`). */
const GH_WRITES: ReadonlyMap<string, readonly string[]> = new Map(Object.entries({
  pr: ['create', 'new', 'edit', 'merge', 'comment', 'close', 'reopen', 'ready', 'review', 'lock', 'unlock', 'update-branch', 'revert'],
  issue: ['create', 'new', 'edit', 'comment', 'close', 'reopen', 'delete', 'lock', 'unlock', 'transfer', 'pin', 'unpin', 'develop'],
  run: ['rerun', 'cancel', 'delete'],
  workflow: ['run', 'enable', 'disable'],
  release: ['create', 'new', 'edit', 'delete', 'upload', 'delete-asset'],
  repo: ['create', 'new', 'edit', 'delete', 'fork', 'rename', 'archive', 'unarchive', 'sync'],
  label: ['create', 'edit', 'delete', 'clone'],
  gist: ['create', 'new', 'edit', 'delete'],
  secret: ['set', 'delete', 'remove'],
  variable: ['set', 'delete', 'remove'],
  cache: ['delete'],
  'ssh-key': ['add', 'delete'],
  'gpg-key': ['add', 'delete'],
  project: ['create', 'edit', 'delete', 'close', 'copy', 'field-create', 'field-delete', 'item-add', 'item-archive',
    'item-create', 'item-delete', 'item-edit', 'link', 'unlink', 'mark-template'],
  codespace: ['create', 'delete', 'edit', 'stop', 'rebuild'],
}));
/** Write verbs one level below a group (`gh repo deploy-key add`). */
const GH_NESTED_WRITES: ReadonlyMap<string, readonly string[]> = new Map(Object.entries({
  'repo deploy-key': ['add', 'delete'],
  'repo autolink': ['create', 'delete'],
}));
/** gh flags that print help or the version and run nothing. */
const GH_INERT_FLAGS = new Set(['-h', '--help', '--version']);
/** `gh api` flags that take a separate value. */
const GH_API_VALUE_OPTS = new Set(['-H', '--header', '-q', '--jq', '-t', '--template', '--cache', '--hostname', '-p', '--preview']);

/** git global options that take a separate value (`git help git`, git 2.56). */
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source']);
/** git global options that take no value, or an attached `=value` only. */
const GIT_FLAG_OPTS = new Set(['-p', '--paginate', '-P', '--no-pager', '--bare', '--no-replace-objects', '--no-lazy-fetch',
  '--no-optional-locks', '--no-advice', '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs',
  '--exec-path', '--html-path', '--man-path', '--info-path']);
const GIT_ATTACHED_OPT_RE = /^--(?:git-dir|work-tree|namespace|config-env|attr-source|exec-path|list-cmds)=/;
/** git commands that send to a remote or off the machine. */
const GIT_WRITES = new Set(['push', 'send-pack', 'http-push', 'send-email', 'imap-send']);

/**
 * The git write this argv performs, named from a fixed vocabulary, or null.
 * Global options are skipped by their real arity; an option git does not
 * document is a write (what follows it cannot be told). `-c alias.X=...`
 * in argv is expanded when X is the command; a shell alias (`!...`) or one
 * set through --config-env is a write, since its text cannot be read here.
 */
function gitWriteOp(args: readonly string[], depth = 0): string | null {
  const aliases = new Map<string, string>();
  let i = 0;
  for (; i < args.length && args[i].startsWith('-'); i++) {
    const a = args[i];
    if (a === '-v' || a === '--version' || a === '-h' || a === '--help') return null; // git runs `version` or `help`
    if (a === '-c' || a === '--config-env' || a.startsWith('--config-env=')) {
      const setting = a.startsWith('--config-env=') ? a.slice('--config-env='.length) : args[++i] ?? '';
      const alias = /^alias\.([^=]+)=(.*)$/is.exec(setting);
      if (alias) aliases.set(alias[1].toLowerCase(), a === '-c' ? alias[2] : '!');
    } else if (GIT_VALUE_OPTS.has(a)) i++;
    else if (!GIT_FLAG_OPTS.has(a) && !GIT_ATTACHED_OPT_RE.test(a)) return 'git with an unrecognised global option';
  }
  const command = args[i];
  if (command === undefined) return null;
  if (GIT_WRITES.has(command)) return `git ${command}`;
  if (command.startsWith('remote-')) return 'git remote-helper';
  const expansion = aliases.get(command.toLowerCase());
  if (expansion === undefined) return null;
  if (expansion.trimStart().startsWith('!')) return 'a git shell alias';
  if (depth >= 10) return 'a git alias chain';
  return gitWriteOp([...args.slice(0, i), ...expansion.trim().split(/\s+/).filter(Boolean), ...args.slice(i + 1)], depth + 1);
}

/**
 * `gh api` (args after `api`): a method other than GET/HEAD, or fields or
 * `--input` with no method (gh then POSTs). `graphql` is a read only when
 * its query is inline in argv and says no `mutation`: a query from a file,
 * stdin or `--input` may be one.
 */
function ghApiWriteOp(rest: readonly string[]): string | null {
  let method: string | null = null;
  let fields = false;
  let input = false;
  let endpoint: string | undefined;
  const queries: { text: string; fromFile: boolean }[] = [];
  const field = (typed: boolean, setting: string) => {
    fields = true;
    const eq = setting.indexOf('=');
    if (eq >= 0 && setting.slice(0, eq) === 'query') {
      const text = setting.slice(eq + 1);
      queries.push({ text, fromFile: typed && text.startsWith('@') });
    }
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-X' || a === '--method') method = (rest[++i] ?? '').toUpperCase();
    else if (a.startsWith('--method=')) method = a.slice('--method='.length).toUpperCase();
    else if (/^-X./.test(a)) method = a.slice(2).toUpperCase();
    else if (a === '-f' || a === '--raw-field') field(false, rest[++i] ?? '');
    else if (a === '-F' || a === '--field') field(true, rest[++i] ?? '');
    else if (a.startsWith('--raw-field=')) field(false, a.slice('--raw-field='.length));
    else if (a.startsWith('--field=')) field(true, a.slice('--field='.length));
    else if (/^-f./.test(a)) field(false, a.slice(2));
    else if (/^-F./.test(a)) field(true, a.slice(2));
    else if (a === '--input' || a.startsWith('--input=')) {
      input = true;
      fields = true;
      if (a === '--input') i++;
    } else if (GH_API_VALUE_OPTS.has(a)) i++;
    else if (!a.startsWith('-') && endpoint === undefined) endpoint = a;
  }
  if (endpoint === 'graphql') {
    const inline = !input && queries.length > 0 && queries.every(q => !q.fromFile);
    return inline && !queries.some(q => /\bmutation\b/i.test(q.text)) ? null : 'gh api graphql';
  }
  if (method !== null) return method === 'GET' || method === 'HEAD' ? null : 'gh api (non-GET)';
  return fields ? 'gh api (non-GET)' : null;
}

/**
 * The gh write this argv performs, named from a fixed vocabulary, or null.
 * `-R/--repo OWNER/NAME` may sit before the group or the subcommand (gh
 * resolves both); any other flag there is a write, since what follows it
 * cannot be told.
 */
function ghWriteOp(args: readonly string[]): string | null {
  let group: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-R' || a === '--repo') i++;
    else if (/^(?:-R.|--repo=)/.test(a)) continue;
    else if (GH_INERT_FLAGS.has(a)) return null;
    else if (group === undefined) {
      if (a.startsWith('-')) return 'gh with a flag before the command';
      if (a === 'api') return ghApiWriteOp(args.slice(i + 1));
      if (!GH_WRITES.has(a)) return null;
      group = a;
    } else {
      if (a.startsWith('-')) return `gh ${group} (a flag before the subcommand)`;
      if (GH_NESTED_WRITES.has(`${group} ${a}`)) {
        group = `${group} ${a}`;
        continue;
      }
      const verbs = GH_NESTED_WRITES.get(group) ?? GH_WRITES.get(group);
      return verbs?.includes(a) ? `gh ${group} ${a}` : null;
    }
  }
  return null;
}

/**
 * Would this argv write to a remote? git: `push`, `send-pack`, `http-push`,
 * `send-email`, `imap-send` and the `remote-*` helpers, found past every
 * global option, also through an alias defined in argv. gh: the write verbs
 * of GH_WRITES (repo flags before the verb skipped), and `gh api` per
 * ghApiWriteOp. Exported so the helpers' fake runners apply the same test.
 * It catches a helper's own mistake; it is not a sandbox: what git or gh
 * runs by itself (hooks, `rebase --exec`, `-c core.sshCommand`, aliases set
 * in config files, gh aliases) is not classified.
 */
export function isRemoteWrite(tool: 'gh' | 'git', args: readonly string[]): boolean {
  return (tool === 'git' ? gitWriteOp(args) : ghWriteOp(args)) !== null;
}

/** >0 while receiptedSend() runs its send: the only time the default runners may write. */
let sendDepth = 0;

/**
 * The default runners refuse a write outside receiptedSend(): it would leave
 * no egress receipt. The message names the operation only: option values
 * (`-c http.extraHeader=...`) can hold credentials.
 */
function refuseUnreceiptedWrite(tool: 'gh' | 'git', args: readonly string[]): void {
  if (sendDepth > 0) return;
  const op = tool === 'git' ? gitWriteOp(args) : ghWriteOp(args);
  if (op) throw new PrContextError(`WRITE_REFUSED: ${op} outside receiptedSend() would send without an egress receipt`, 2);
}

export const defaultGh: GhRunner = args => {
  refuseUnreceiptedWrite('gh', args);
  const r = spawnSync('gh', args, { encoding: 'utf8', timeout: GH_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
  if (r.error) return { status: null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: spawnFailure('gh', r.error, GH_TIMEOUT_MS) };
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

/** git commands that can start a transport (ssh for an ssh remote). */
const GIT_TRANSPORTS = new Set(['fetch', 'ls-remote', 'push', 'pull', 'clone', 'remote', 'submodule', 'archive', 'fetch-pack', 'send-pack']);
/** The default ssh, bounded: a connect gives up after 30 s, a silent connection after 4 unanswered 15 s keepalives. */
const BOUNDED_SSH = 'ssh -o ConnectTimeout=30 -o ServerAliveInterval=15 -o ServerAliveCountMax=4';

/** The global options before git's command (with their values), and the command. */
function splitGitArgv(args: readonly string[]): { globals: string[]; command: string | undefined } {
  let i = 0;
  for (; i < args.length && args[i].startsWith('-'); i++) if (GIT_VALUE_OPTS.has(args[i])) i++;
  return { globals: args.slice(0, i), command: args[i] };
}

/**
 * The env a git call runs with: LC_ALL=C, no credential prompt, and, for a
 * command that can start an ssh transport, GIT_SSH_COMMAND=BOUNDED_SSH. That
 * is set only when the user chose no ssh of their own: none of GIT_SSH_COMMAND,
 * GIT_SSH or GIT_SSH_VARIANT in env, and `git config` (run with the call's
 * global options, so `-C` and `-c` count) reports neither core.sshCommand nor
 * ssh.variant. Any other answer from that check leaves the env as it is.
 */
function gitEnv(args: readonly string[], opts: GitOpts, timeout: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env), LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' };
  const { globals, command } = splitGitArgv(args);
  if (command === undefined || !GIT_TRANSPORTS.has(command)) return env;
  if (['GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_SSH_VARIANT'].some(name => env[name] !== undefined)) return env;
  const own = spawnSync('git', [...globals, 'config', '--get-regexp', '^(core\\.sshcommand|ssh\\.variant)$'], {
    cwd: opts.cwd, env, encoding: 'utf8', timeout: Math.min(timeout, 10_000), maxBuffer: 1024 * 1024,
  });
  // Exit 1 is "no such key"; a match (0) or a failure keeps the user's ssh.
  return !own.error && own.status === 1 ? { ...env, GIT_SSH_COMMAND: BOUNDED_SSH } : env;
}

/**
 * The timeout kills git itself. A transport git started (ssh for an ssh
 * remote) is not in a process group of its own and outlives it until its
 * connection ends: spawning git detached would let Ctrl-C leave git and ssh
 * running with no timeout at all. So the default ssh runs bounded (gitEnv:
 * ConnectTimeout and ServerAlive options), and an orphan ends within about a
 * minute of its connection going quiet. An ssh the user chose (GIT_SSH_COMMAND,
 * GIT_SSH, core.sshCommand, an ssh.variant) runs exactly as they set it, so
 * an orphan of theirs lives as long as their command does.
 */
export const defaultGit: GitRunner = (args, opts) => {
  refuseUnreceiptedWrite('git', args);
  const timeout = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  const r = spawnSync('git', args, {
    cwd: opts.cwd,
    input: opts.input,
    encoding: 'utf8',
    timeout,
    maxBuffer: MAX_BUFFER,
    env: gitEnv(args, opts, timeout),
  });
  if (r.error) return { status: null, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: spawnFailure('git', r.error, timeout) };
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

export const RELEASE_FILES: readonly string[] = Object.freeze(['VERSION', 'package.json', 'CHANGELOG.md', 'agents-digest/gstack-AGENTS.md']);
/**
 * Head branches no pr-prep write may touch: the trunk names, release and
 * hotfix branches, and feat/pr-prep-skill-<suffix>, the branch the fork's
 * live install serves (a sync or ci: push there would move the running
 * skills). `feat/pr-prep-skill` and `feat/pr-prep-skills-x` stay writable.
 */
export const PROTECTED_HEAD_RE = /^(main|master|develop|release\/.*|hotfix\/.*|feat\/pr-prep-skill-.+)$/;

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** One `/`-separated component of a git remote name (`origin`, `gh/up`). */
const REMOTE_PART_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TOPIC_RE = /^[A-Za-z0-9._-]+$/;

/** One line of tool stderr for an error message: control bytes gone, length capped. */
function lastLine(text: string): string {
  const line = stripControl(text).trim().split('\n').filter(Boolean).at(-1) ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}...` : line;
}

function failed(what: string, r: GhResult): PrContextError {
  const detail = r.error ?? `exit ${r.status ?? 'abnormal'}${lastLine(r.stderr) ? `: ${lastLine(r.stderr)}` : ''}`;
  return new PrContextError(`${what} failed (${detail})`, 1);
}

/** stdout of a successful call, or PrContextError(1). */
function ok(what: string, r: GhResult): string {
  if (r.error || r.status !== 0) throw failed(what, r);
  return r.stdout;
}

function assertRepo(repo: string): void {
  if (!REPO_RE.test(repo)) throw new PrContextError(`not an OWNER/NAME repository: ${JSON.stringify(repo)}`, 2);
}

/** A remote name git accepts, `/` included, and safe in argv: no leading dash, no `..`, no `.lock` or `.` ending. */
function assertRemoteName(remote: string): void {
  const safe = !remote.includes('..')
    && remote.split('/').every(part => REMOTE_PART_RE.test(part) && !part.endsWith('.lock') && !part.endsWith('.'));
  if (!safe) throw new PrContextError(`not a usable git remote name: ${JSON.stringify(remote)}`, 2);
}

/**
 * A branch name git accepts (`git check-ref-format --branch` rules: no
 * control bytes, space, `~^:?*[\`, `..`, `@{`, `//`, bare `@` or `HEAD`, component
 * starting with `.` or ending in `.lock`, trailing `/` or `.`), and safe to
 * splice into a refspec and argv: no leading `-`, `+` or `/`. So `fix#123`,
 * `feat+x`, `user@topic` and `v1,2` pass.
 */
function assertBranchName(branch: string): void {
  const safe = branch !== '' && branch !== '@' && branch !== 'HEAD' && !/[\x00-\x20\x7f~^:?*[\\]/.test(branch)
    && !branch.includes('..') && !branch.includes('@{') && !branch.includes('//')
    && !/^[-+/]/.test(branch) && !/[/.]$/.test(branch)
    && branch.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock'));
  if (!safe) throw new PrContextError(`not a usable branch name: ${JSON.stringify(branch)}`, 2);
}

/**
 * A PR reference, from `123` (repo null) or a pull URL
 * (`https://github.com/o/r/pull/123`, optionally followed by `/files`,
 * `?query` or `#anchor`; repo `o/r`). `#123` and anything else is refused
 * with code 2.
 */
export function parsePrUrl(input: string): { repo: string | null; number: number } {
  const text = input.trim();
  const bare = /^([0-9]+)$/.exec(text);
  const url = bare ? null : /^https?:\/\/[^/\s]+\/([^/\s]+\/[^/\s]+)\/pull\/([0-9]+)(?:[/?#]\S*)?$/.exec(text);
  const n = Number(bare?.[1] ?? url?.[2] ?? NaN);
  const repo = url ? url[1] : null;
  if (!Number.isSafeInteger(n) || n < 1 || (repo !== null && !REPO_RE.test(repo))) {
    throw new PrContextError(`not a PR number or pull URL: ${JSON.stringify(input)} (use 123 or https://github.com/OWNER/REPO/pull/123)`, 2);
  }
  return { repo, number: n };
}

/** The PR number alone. A pull URL's repository is dropped: use parsePrRefFor when the repo is known. */
export function parsePrRef(input: string): number {
  return parsePrUrl(input).number;
}

/**
 * The PR number for `repo` (OWNER/NAME, compared case-insensitively). A pull
 * URL naming another repository is refused with code 2, so the fork's own
 * PR #5 is never read as the upstream's #5.
 */
export function parsePrRefFor(input: string, repo: string): number {
  assertRepo(repo);
  const ref = parsePrUrl(input);
  if (ref.repo !== null && ref.repo.toLowerCase() !== repo.toLowerCase()) {
    throw new PrContextError(`${JSON.stringify(input.trim())} is a pull request in ${ref.repo}, not in ${repo}`, 2);
  }
  return ref.number;
}

/**
 * The repository gh resolves for `cwd` (`gh repo view`; in a fork checkout
 * with an `upstream` remote that is the upstream repo). GhRunner carries no
 * cwd, so the process runs from `cwd` for the call and returns afterwards.
 */
export function upstreamRepoFromGh(gh: GhRunner, cwd: string): string {
  const previous = process.cwd();
  let r: GhResult;
  try {
    process.chdir(cwd);
  } catch (error) {
    throw new PrContextError(`cannot enter ${cwd}: ${(error as Error).message}`, 1);
  }
  try {
    r = gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
  } finally {
    process.chdir(previous);
  }
  const repo = ok('gh repo view', r).trim();
  if (!REPO_RE.test(repo)) throw new PrContextError(`gh repo view printed no OWNER/NAME (got ${JSON.stringify(repo.slice(0, 80))})`, 1);
  return repo;
}

export function defaultBranchFromGh(gh: GhRunner, repo: string): string {
  assertRepo(repo);
  const branch = ok('gh repo view defaultBranchRef', gh(['repo', 'view', repo, '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])).trim();
  try {
    assertBranchName(branch);
  } catch {
    throw new PrContextError(`gh repo view printed no default branch for ${repo} (got ${JSON.stringify(branch.slice(0, 80))})`, 1);
  }
  return branch;
}

/** Does a remote URL name `repo`? https, ssh://, scp-style and local paths; `.git` and a trailing slash optional. */
function urlNamesRepo(url: string, repo: string): boolean {
  const u = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
  const want = repo.toLowerCase();
  if (!u.endsWith(want) || u.length === want.length) return false;
  const boundary = u[u.length - want.length - 1];
  return boundary === '/' || boundary === ':';
}

/**
 * The lower-cased host of a remote URL (`https://h/...`, `ssh://u@h:22/...`,
 * scp-style `u@h:path`), and whether ssh reaches it, or null for a local path.
 */
function remoteHost(url: string): { host: string; ssh: boolean } | null {
  const u = url.trim();
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)/.exec(u);
  if (scheme) {
    const kind = scheme[1].toLowerCase();
    if (kind === 'file') return null;
    const host = scheme[2].replace(/^.*@/, '').replace(/:[0-9]*$/, '').toLowerCase();
    return host ? { host, ssh: /^(?:ssh|git\+ssh|ssh\+git)$/.test(kind) } : null;
  }
  // scp-style has a colon before any slash; a one-letter "host" is a Windows drive.
  const scp = /^(?:[^@/:]+@)?([^/:]+):/.exec(u);
  return scp && scp[1].length > 1 ? { host: scp[1].toLowerCase(), ssh: true } : null;
}

/** HostName per ssh host alias, read once per process. */
const sshHostNames = new Map<string, string | null>();

/**
 * The HostName ssh connects to for `alias` (`ssh -G`, which reads
 * ~/.ssh/config and never connects), or null when ssh cannot say.
 */
function sshConfigHostName(alias: string): string | null {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(alias)) return null;
  if (!sshHostNames.has(alias)) {
    const r = spawnSync('ssh', ['-G', alias], { encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024 });
    const line = r.status === 0 ? /^hostname\s+(\S+)\s*$/m.exec(r.stdout ?? '') : null;
    sshHostNames.set(alias, line ? line[1].toLowerCase() : null);
  }
  return sshHostNames.get(alias) ?? null;
}

/**
 * The remote whose fetch URL names `repo` (ends with OWNER/NAME on a path
 * boundary), or null. Never assumes `origin`: in a fork checkout origin is
 * the fork. A remote is on `host` (github.com by default) when its URL
 * host is that host or a subdomain of it (`ssh.github.com:443`), or, for
 * an ssh URL, when its host is an ssh alias whose HostName is (`ssh -G`;
 * `sshHostName` replaces that lookup in tests). When several match, the
 * first (in `git remote` order) on `host` wins, then one that is a local
 * path. A match elsewhere (a GitLab mirror, a nested group whose path ends
 * the same way) is taken only when no remote at all is on `host`, as in a
 * GitHub Enterprise checkout; pass `host` to name that server instead.
 */
export function remoteForRepo(
  git: GitRunner, cwd: string, repo: string, host = 'github.com',
  sshHostName: (alias: string) => string | null = sshConfigHostName,
): string | null {
  assertRepo(repo);
  const want = host.toLowerCase();
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(want)) throw new PrContextError(`not a host name: ${JSON.stringify(host)}`, 2);
  const isWant = (h: string | null | undefined) => !!h && (h === want || h.endsWith(`.${want}`));
  const names = ok('git remote', git(['remote'], { cwd })).split('\n').map(s => s.trim()).filter(Boolean);
  type Remote = { name: string; at: { host: string; ssh: boolean } | null; match: boolean };
  const remotes: Remote[] = [];
  for (const name of names) {
    const r = git(['remote', 'get-url', name], { cwd });
    if (r.error || r.status !== 0) continue;
    remotes.push({ name, at: remoteHost(r.stdout), match: urlNamesRepo(r.stdout, repo) });
  }
  const literal = (x: Remote) => isWant(x.at?.host);
  // Asked only when no literal match settles it, at most once per alias.
  const resolved = new Map<string, boolean>();
  const viaAlias = (x: Remote) => {
    if (!x.at?.ssh || literal(x)) return false;
    if (!resolved.has(x.at.host)) resolved.set(x.at.host, isWant(sshHostName(x.at.host)));
    return resolved.get(x.at.host) === true;
  };
  const matches = remotes.filter(x => x.match);
  const pick = matches.find(literal) ?? matches.find(viaAlias) ?? matches.find(x => x.at === null)
    ?? (remotes.some(x => literal(x) || viaAlias(x)) ? undefined : matches[0]);
  return pick?.name ?? null;
}

/**
 * Delete earlier pins whose path nests with `ref` (`.../feat` against
 * `.../feat/x`, either way round): git cannot hold both, so the fetch would
 * fail on a stale pin of a branch the remote has since replaced. Pins are
 * private to pr-prep and read once, so nothing else depends on them.
 */
function pruneNestedPins(git: GitRunner, cwd: string, ref: string): void {
  const listed = ok('git for-each-ref refs/pr-prep/', git(['for-each-ref', '--format=%(refname)', 'refs/pr-prep/'], { cwd }));
  for (const name of listed.split('\n').map(s => s.trim()).filter(Boolean)) {
    if (name !== ref && (ref.startsWith(`${name}/`) || name.startsWith(`${ref}/`))) {
      ok(`git update-ref -d ${name}`, git(['update-ref', '-d', name], { cwd }));
    }
  }
}

/**
 * Pin `<remote>/<branch>` into the private ref `refs/pr-prep/<remote>/<branch>`
 * and return its commit. `--refmap=` keeps the fetch from also moving the
 * shared `refs/remotes/<remote>/*` refs. The pinned sha is cross-checked with
 * `git ls-remote`; on a mismatch (someone pushed in between) it refetches
 * once, then throws code 40. A branch the remote does not have is code 40
 * too. Older pins nesting with this one are dropped.
 */
export function pinBranch(git: GitRunner, cwd: string, remote: string, branch: string): { sha: string; ref: string } {
  assertRemoteName(remote);
  assertBranchName(branch);
  const ref = `refs/pr-prep/${remote}/${branch}`;
  const head = `refs/heads/${branch}`;
  pruneNestedPins(git, cwd, ref);
  let pinned = '';
  let live = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const fetched = git(['fetch', '--no-tags', '--refmap=', remote, `+${head}:${ref}`], { cwd, timeoutMs: FETCH_TIMEOUT_MS });
    // The remote answered without the branch (LC_ALL=C keeps git's wording): a moved PR head, not a tool failure.
    if (!fetched.error && fetched.status !== 0 && /couldn't find remote ref/i.test(fetched.stderr)) {
      throw new PrContextError(`${head} is gone from ${remote} (deleted, never pushed, or removed during the fetch)`, 40);
    }
    ok(`git fetch ${remote} ${head}`, fetched);
    pinned = ok(`git rev-parse ${ref}`, git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd })).trim();
    if (!SHA_RE.test(pinned)) throw new PrContextError(`git rev-parse printed no commit for ${ref}`, 1);
    const listing = ok(`git ls-remote ${remote} ${head}`, git(['ls-remote', remote, head], { cwd, timeoutMs: FETCH_TIMEOUT_MS }));
    const row = listing.split('\n').map(line => line.split('\t')).find(([, name]) => name?.trim() === head);
    if (!row) throw new PrContextError(`${head} is gone from ${remote} (it was fetched as ${pinned})`, 40);
    live = row[0].trim();
    if (live === pinned) return { sha: pinned, ref };
  }
  throw new PrContextError(`${remote} ${head} keeps moving: fetched ${pinned}, ls-remote says ${live} after a refetch`, 40);
}

export interface PrInfo {
  repo: string; number: number; state: 'OPEN' | 'CLOSED' | 'MERGED'; isDraft: boolean;
  headRef: string; headOid: string; headOwner: string; headRepo: string; baseRef: string; baseRepo: string; url: string;
}

const PR_FIELDS = 'number,state,isDraft,headRefName,headRefOid,headRepositoryOwner,headRepository,baseRefName,url';

/**
 * PR identity from `gh pr view --json` (never the body: tracker text has no
 * business here). headOwner/headRepo are '' when the head repository was
 * deleted; baseRepo comes from the PR URL, so a renamed base shows up.
 */
export function readPr(gh: GhRunner, repo: string, n: number): PrInfo {
  assertRepo(repo);
  if (!Number.isSafeInteger(n) || n < 1) throw new PrContextError(`not a PR number: ${n}`, 2);
  const text = ok(`gh pr view ${n}`, gh(['pr', 'view', String(n), '--repo', repo, '--json', PR_FIELDS]));
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new PrContextError(`gh pr view ${n} printed output that is not JSON`, 1);
  }
  const bad = (field: string) => new PrContextError(`gh pr view ${n}: missing or malformed ${field}`, 1);
  const str = (field: string): string => {
    const value = raw?.[field];
    if (typeof value !== 'string' || !value) throw bad(field);
    return value;
  };
  if (raw?.number !== n) throw bad('number');
  const state = str('state');
  if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') throw bad('state');
  if (typeof raw.isDraft !== 'boolean') throw bad('isDraft');
  const headOid = str('headRefOid');
  if (!SHA_RE.test(headOid)) throw bad('headRefOid');
  const url = str('url');
  const fromUrl = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/([0-9]+)\/?$/.exec(url);
  if (!fromUrl || Number(fromUrl[2]) !== n) throw bad('url');
  const owner = (raw.headRepositoryOwner as { login?: unknown } | null)?.login;
  const name = (raw.headRepository as { name?: unknown } | null)?.name;
  const headOwner = typeof owner === 'string' ? owner : '';
  return {
    repo, number: n, state, isDraft: raw.isDraft, headRef: str('headRefName'), headOid, headOwner,
    headRepo: headOwner && typeof name === 'string' && name ? `${headOwner}/${name}` : '',
    baseRef: str('baseRefName'), baseRepo: fromUrl[1], url,
  };
}

export function viewerLogin(gh: GhRunner): string {
  const login = ok('gh api user', gh(['api', 'user', '--jq', '.login'])).trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9_-]*[A-Za-z0-9])?(?:\[bot\])?$/.test(login)) {
    throw new PrContextError(`gh api user printed no login (got ${JSON.stringify(login.slice(0, 80))})`, 1);
  }
  return login;
}

/**
 * Refuse (code 30) unless the PR is OPEN, its head is the viewer's, and the
 * head branch is not protected (PROTECTED_HEAD_RE: main, master, develop,
 * release/*, hotfix/*, and the fork's live-install feat/pr-prep-skill-*).
 */
export function assertWritableIdentity(pr: PrInfo, viewer: string): void {
  const where = `PR #${pr.number} (${pr.repo})`;
  if (pr.state !== 'OPEN') throw new PrContextError(`${where} is ${pr.state}, not OPEN`, 30);
  if (!viewer || !pr.headOwner || pr.headOwner.toLowerCase() !== viewer.toLowerCase()) {
    throw new PrContextError(`${where} head belongs to ${pr.headOwner || 'a deleted repository'}, not to ${viewer || 'an unknown viewer'}`, 30);
  }
  if (PROTECTED_HEAD_RE.test(pr.headRef)) throw new PrContextError(`${where} head branch ${pr.headRef} is protected`, 30);
}

// ── state (one dir per PR topic) ────────────────────────────────────────────

function assertTopic(topic: string): void {
  if (!TOPIC_RE.test(topic) || /^\.*$/.test(topic)) throw new PrContextError(`not a usable PR topic: ${JSON.stringify(topic)}`, 2);
}

/** `pr/hook-check-gaps` -> `hook-check-gaps`, `feat/x y` -> `feat-x-y`. */
export function topicFor(headRef: string): string {
  const topic = headRef.replace(/^pr\//, '').replace(/[^A-Za-z0-9._-]/g, '-');
  assertTopic(topic);
  return topic;
}

/**
 * `<state root>/projects/<slug>/pr-drafts/<topic>`. The slug is gstack-slug's
 * (lib/bin-context), so the skill's bash side finds the same directory;
 * GSTACK_PROJECT_SLUG in `env` wins, as it does there, and `env` alone
 * decides it: a process-level override does not outvote the env passed in.
 * No state dir is created; the slug cache under the state root may be
 * written, as gstack-slug does. A relative `cwd` is resolved against the
 * process cwd first, as gstack-slug works from its absolute pwd.
 */
export function prStateDir(opts: { cwd: string; topic: string; env?: NodeJS.ProcessEnv }): string {
  assertTopic(opts.topic);
  const env = opts.env ?? process.env;
  const root = path.resolve(resolveStateRoot(env));
  const cwd = path.resolve(opts.cwd);
  // Ignored exactly when gstack-slug ignores it: "." and ".." would leave projects/.
  const override = (env.GSTACK_PROJECT_SLUG ?? '').trim().replace(/[^a-zA-Z0-9._-]/g, '');
  if (override && override !== '.' && override !== '..') return path.join(root, 'projects', override, 'pr-drafts', opts.topic);
  // slugFromEnvironment reads its override from process.env; `env` has none
  // (or an unusable one), so hide the process's for this synchronous call.
  const hidden = process.env.GSTACK_PROJECT_SLUG;
  delete process.env.GSTACK_PROJECT_SLUG;
  let slug: string;
  try {
    slug = slugFromEnvironment(root, cwd);
  } finally {
    if (hidden !== undefined) process.env.GSTACK_PROJECT_SLUG = hidden;
  }
  if (slug === '' || slug === '.' || slug === '..') {
    throw new PrContextError(`no usable project slug for ${cwd} (got ${JSON.stringify(slug)}); set GSTACK_PROJECT_SLUG`, 1);
  }
  return path.join(root, 'projects', slug, 'pr-drafts', opts.topic);
}

export interface PrState {
  v: 1; topic: string; repo: string; number: number | null; headRef: string; headOwner: string;
  headRemote: string | null; upstreamRemote: string | null; defaultBranch: string;
  focused: { paths: string[]; declaredAt: string } | null;
  validation: { sha: string; worst: 0 | 1; summary: string; at: string } | null;
  bodyStaleSince: string | null; lastPublishedBodySha256: string | null;
  signals: { latched: { id: string; level: 'P0' | 'P1'; kind: string; at: string; ref: string }[]; acked: string[] };
  audit: { generatedAt: string; head: string; baseSha: string; audited: { patchId: string; sha: string; bucket: string }[] } | null;
}

const STATE_FILE = 'state.json';

/** The first field that does not fit PrState, or null. Checks shape and primitive types, not meaning. */
function stateProblem(s: unknown): string | null {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return 'not an object';
  const o = s as Record<string, unknown>;
  const isStr = (v: unknown) => typeof v === 'string';
  const strOrNull = (v: unknown) => v === null || typeof v === 'string';
  const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  const strings = (v: unknown) => Array.isArray(v) && v.every(isStr);
  if (o.v !== 1) return 'v';
  for (const k of ['topic', 'repo', 'headRef', 'headOwner', 'defaultBranch']) if (!isStr(o[k])) return k;
  for (const k of ['headRemote', 'upstreamRemote', 'bodyStaleSince', 'lastPublishedBodySha256']) if (!strOrNull(o[k])) return k;
  if (o.number !== null && !(Number.isSafeInteger(o.number) && (o.number as number) > 0)) return 'number';
  if (o.focused !== null && !(obj(o.focused) && strings(o.focused.paths) && isStr(o.focused.declaredAt))) return 'focused';
  if (o.validation !== null && !(obj(o.validation) && isStr(o.validation.sha) && (o.validation.worst === 0 || o.validation.worst === 1)
    && isStr(o.validation.summary) && isStr(o.validation.at))) return 'validation';
  if (!obj(o.signals) || !strings(o.signals.acked) || !Array.isArray(o.signals.latched)
    || !o.signals.latched.every(l => obj(l) && isStr(l.id) && (l.level === 'P0' || l.level === 'P1') && isStr(l.kind) && isStr(l.at) && isStr(l.ref))) return 'signals';
  if (o.audit !== null && !(obj(o.audit) && isStr(o.audit.generatedAt) && isStr(o.audit.head) && isStr(o.audit.baseSha) && Array.isArray(o.audit.audited)
    && o.audit.audited.every(a => obj(a) && isStr(a.patchId) && isStr(a.sha) && isStr(a.bucket)))) return 'audit';
  return null;
}

/** The PR state in `dir`, or null when there is none yet. A corrupt or foreign file throws code 1. */
export function readState(dir: string): PrState | null {
  const file = path.join(dir, STATE_FILE);
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new PrContextError(`cannot read ${file}: ${(error as Error).message}`, 1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PrContextError(`${file} is not JSON; move it aside and rerun`, 1);
  }
  const problem = stateProblem(parsed);
  if (problem) throw new PrContextError(`${file} is not a v1 pr-prep state (bad ${problem}); move it aside and rerun`, 1);
  return parsed as PrState;
}

/**
 * Refuse (code 30) a state that belongs to another PR. A topic dir does not
 * name one PR: topicFor folds feat/x, feat-x and pr/feat-x together, and
 * one checkout can hold the fork's own PR and the upstream PR for the same
 * head ref. So the state's repo must equal `pr.repo` (case-insensitively),
 * its headRef `pr.headRef` exactly, and its headOwner `pr.headOwner`
 * (case-insensitively) when both name one. A PrInfo, or another PrState,
 * serves as `pr`. Helpers read through readStateFor, or call this after
 * every readState, before trusting a latched signal or a validation.
 */
export function assertStateFor(s: PrState, pr: { repo: string; headRef: string; headOwner?: string }): void {
  const sameRepo = s.repo.toLowerCase() === pr.repo.toLowerCase();
  const sameOwner = !s.headOwner || !pr.headOwner || s.headOwner.toLowerCase() === pr.headOwner.toLowerCase();
  if (sameRepo && s.headRef === pr.headRef && sameOwner) return;
  const name = (x: { repo: string; headRef: string; headOwner?: string }) =>
    JSON.stringify(`${x.repo} ${x.headRef}${x.headOwner ? ` (head owner ${x.headOwner})` : ''}`);
  throw new PrContextError(
    `the pr-prep state in topic ${JSON.stringify(s.topic)} belongs to ${name(s)}, not to ${name(pr)}; `
    + 'the two PRs share one topic dir, so move that state aside or set GSTACK_PROJECT_SLUG for one of them', 30);
}

/** readState for one PR: null when there is no state yet, code 30 when the state is another PR's (assertStateFor). */
export function readStateFor(dir: string, pr: { repo: string; headRef: string; headOwner?: string }): PrState | null {
  const s = readState(dir);
  if (s) assertStateFor(s, pr);
  return s;
}

/**
 * Atomic write: a 0600 temp file in `dir` (created 0700), then rename over
 * state.json. A state.json that is another PR's (assertStateFor against `s`)
 * is never replaced: code 30, the file left as it was. One that is missing,
 * unreadable or not a v1 state is replaced, as readState already refuses it.
 */
export function writeState(dir: string, s: PrState): void {
  const problem = stateProblem(s);
  if (problem) throw new PrContextError(`refusing to write a malformed pr-prep state (bad ${problem})`, 1);
  let current: unknown = null;
  try {
    current = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8'));
  } catch { /* none yet, unreadable, or not JSON: it names no PR to protect */ }
  if (current !== null && stateProblem(current) === null) assertStateFor(current as PrState, s);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${STATE_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, path.join(dir, STATE_FILE));
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

// ── per-PR lock ─────────────────────────────────────────────────────────────

const LOCK_DIR = '.lock';
const OWNER_RE = /^pid-([0-9]+)-[0-9a-f]+$/;
/** A lock being assembled: `<dir>/.lock.<pid>.<hex>`, renamed onto `.lock` once its pid file is in. */
const STAGING_RE = /^\.lock\.([0-9]+)\.[0-9a-f]+$/;

/** Real paths of the `.lock` dirs this process holds now; withPrLock is synchronous, so only a nested call can meet one. */
const heldLocks = new Set<string>();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'; // another user's live process
  }
}

let bootIdCache: string | null | undefined;

/**
 * This boot's id (macOS kern.bootsessionuuid, Linux boot_id), or null where
 * it cannot be read. Pid files carry it, so a lock written before a reboot
 * never passes for a live holder whose pid a new process now has.
 */
function bootId(): string | null {
  if (bootIdCache === undefined) {
    let id = '';
    try {
      if (process.platform === 'linux') id = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8');
      else if (process.platform === 'darwin') {
        const r = spawnSync('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { encoding: 'utf8', timeout: 5_000 });
        if (r.status === 0) id = r.stdout;
      }
    } catch { /* unreadable: pid files go unstamped, and no holder is judged by a stamp */ }
    id = id.trim().toLowerCase();
    bootIdCache = /^[0-9a-f-]{8,64}$/.test(id) ? id : null;
  }
  return bootIdCache;
}

/**
 * Is the holder whose pid file is `<lock>/<owner>` alive? No when its pid
 * file records another boot; for this process's own pid (not in heldLocks),
 * no when the file predates this process, since only a reused pid explains
 * it; otherwise when the pid answers kill(pid, 0). A file that vanished
 * while being read counts as alive: the next pass sees the release.
 */
function holderAlive(lock: string, owner: string, pid: number): boolean {
  let text = '';
  let writtenMs = Infinity;
  try {
    text = fs.readFileSync(path.join(lock, owner), 'utf8');
    writtenMs = fs.statSync(path.join(lock, owner)).mtimeMs;
  } catch { /* released in between */ }
  const stamped = /\bboot=([0-9a-f-]+)/.exec(text)?.[1];
  const ours = bootId();
  if (stamped && ours && stamped !== ours) return false;
  if (pid === process.pid) return writtenMs >= Date.now() - process.uptime() * 1000 - 2_000;
  return pidAlive(pid);
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Clear a lock dir that no live process holds. `ownerFile` (the releasing
 * holder's own, or a dead holder's pid file) goes first. When no other pid
 * file is present, the rest (a Finder `.DS_Store`, say) is deleted and the
 * dir removed. 'gone' when the dir no longer exists, 'held' when another pid
 * file is in it, else the entries that could not be deleted.
 *
 * Safe against racers: a holder's dir always carries its pid file (it was
 * renamed into place with it), only non-pid names are deleted, and rmdir only
 * removes an EMPTY dir, so this never takes apart a lock someone else holds.
 */
function clearLock(lock: string, ownerFile: string | null): 'gone' | 'held' | string[] {
  if (ownerFile) fs.rmSync(path.join(lock, ownerFile), { force: true });
  let names: string[];
  try {
    names = fs.readdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    throw error;
  }
  if (names.some(name => OWNER_RE.test(name))) return 'held';
  const stuck: string[] = [];
  for (const name of names) {
    try {
      fs.rmSync(path.join(lock, name), { recursive: true, force: true });
    } catch {
      stuck.push(name);
    }
  }
  if (stuck.length) return stuck;
  try {
    fs.rmdirSync(lock);
    return 'gone';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'gone';
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return 'held';
    throw error;
  }
}

/** Staging dirs left by a process that died before its rename. Best-effort tidying. */
function sweepStaging(dir: string): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch { /* the caller's mkdir already proved the dir; nothing to tidy */ }
  for (const name of names) {
    const m = STAGING_RE.exec(name);
    if (m && Number(m[1]) !== process.pid && !pidAlive(Number(m[1]))) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

/**
 * Run `fn` holding `<dir>/.lock`, a directory holding one pid file. The lock
 * is taken atomically: the pid file is written into a private staging dir,
 * which is then renamed onto `.lock`. The rename fails while `.lock` holds
 * anything, so there is never a moment when a holder's lock exists without
 * its pid file, which records the pid and this boot's id. A `.lock` with no
 * pid file (empty, or only stray files) has no holder and is cleared; one
 * whose holder is not alive (holderAlive: a dead pid, another boot, or this
 * pid from before this process started) is stale and cleared; a live one is
 * waited for up to `budgetMs` (default 10 s; a budget that is not a finite
 * number is code 2), then PrContextError(45). Not re-entrant (a nested call
 * is code 45 at once), and `fn` must be synchronous: the lock is released
 * when `fn` returns or throws. A dead holder's pid that a live process
 * reuses within the same boot still reads as alive until that process exits.
 */
export function withPrLock<T>(dir: string, fn: () => T, opts?: { budgetMs?: number }): T {
  const given = opts?.budgetMs;
  if (given !== undefined && !Number.isFinite(given)) throw new PrContextError(`withPrLock budgetMs must be a finite number of ms (got ${given})`, 2);
  const budgetMs = Math.max(0, given ?? 10_000);
  const lock = path.join(dir, LOCK_DIR);
  const tag = randomBytes(4).toString('hex');
  const mine = `pid-${process.pid}-${tag}`;
  const staging = path.join(dir, `${LOCK_DIR}.${process.pid}.${tag}`);
  const deadline = Date.now() + budgetMs;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const held = path.join(fs.realpathSync(dir), LOCK_DIR);
  if (heldLocks.has(held)) throw new PrContextError(`${lock} is already held by this process (withPrLock is not re-entrant)`, 45);
  sweepStaging(dir);
  fs.mkdirSync(staging, { mode: 0o700 });
  const boot = bootId();
  try {
    fs.writeFileSync(path.join(staging, mine), `${process.pid}${boot ? ` boot=${boot}` : ''}\n`, { mode: 0o600, flag: 'wx' });
    for (;;) {
      try {
        // Atomic take: fails while .lock holds anything; replaces an empty one.
        fs.renameSync(staging, lock);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOTDIR') throw new PrContextError(`${lock} exists and is not a directory; move it aside`, 1);
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
      }
      let names: string[];
      try {
        names = fs.readdirSync(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; // released in between: retry at once
        throw error;
      }
      const owner = names.find(name => OWNER_RE.test(name));
      const pid = owner ? Number(OWNER_RE.exec(owner)![1]) : null;
      let busy: string;
      if (owner && pid !== null && holderAlive(lock, owner, pid)) {
        busy = pid === process.pid ? `this process (pid ${pid}) outside this call: another thread, or a release that failed` : `pid ${pid}`;
      } else {
        const cleared = clearLock(lock, owner ?? null);
        if (cleared === 'gone') continue; // retry the rename at once
        busy = cleared === 'held' ? 'another process'
          : `foreign contents that could not be cleared (${cleared.map(name => path.join(lock, name)).join(', ')})`;
      }
      if (Date.now() >= deadline) throw new PrContextError(`${lock} is held by ${busy}; gave up after ${budgetMs} ms`, 45);
      sleepMs(25);
    }
  } finally {
    // Gone once renamed into place; still here if the lock was never taken.
    fs.rmSync(staging, { recursive: true, force: true });
  }
  heldLocks.add(held);
  try {
    const result = fn();
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      throw new PrContextError('withPrLock needs a synchronous fn: the lock would be released before the promise settles', 1);
    }
    return result;
  } finally {
    heldLocks.delete(held);
    try {
      clearLock(lock, mine);
    } catch { /* a lock left behind names a dead pid once we exit, and the next taker clears it */ }
  }
}

// ── egress (the only network-write path for every pr-* helper) ──────────────

export interface SendSpec { host: string; payloadClass: string; consent: string; payload?: Uint8Array; env?: NodeJS.ProcessEnv }

/** What may authorize a pr-prep write: the user's own /pr-prep run, or the watch LaunchAgent the owner installed. */
const CONSENTS = new Set(['user ran /pr-prep', 'owner installed pr-prep watch LaunchAgent']);

/**
 * Receipt, send, outcome. Fail-open: a receipt that cannot be written warns
 * on stderr and the send still runs. A caller bug is not a ledger failure:
 * an unknown consent, or a host or payloadClass that is empty, over 512
 * bytes or carries control characters, is refused with code 2 before any
 * receipt or send. `payload` is the exact bytes sent (a body file); without
 * it the receipt records 0 bytes and no hash (a subprocess such as
 * `git push` owns the bytes).
 */
export function receiptedSend(spec: SendSpec, send: () => GhResult): GhResult {
  if (!CONSENTS.has(spec.consent)) throw new PrContextError(`unknown pr-prep consent ${JSON.stringify(spec.consent)}`, 2);
  // Caller bugs are refused here, so fail-open below only ever covers ledger I/O.
  for (const [field, value] of [['host', spec.host], ['payloadClass', spec.payloadClass]] as const) {
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > 512 || /[\x00-\x1f\x7f]/.test(value)) {
      throw new PrContextError(`receiptedSend ${field} must be 1-512 bytes with no control characters (got ${JSON.stringify(String(value).slice(0, 60))})`, 2);
    }
  }
  let receipt: string | null = null;
  try {
    receipt = writeReceipt({
      sink: 'pr-prep',
      host: spec.host,
      payloadClass: spec.payloadClass,
      bytes: spec.payload ? spec.payload.byteLength : 0,
      sha256: spec.payload ? sha256Hex(spec.payload) : null,
      consent: spec.consent,
      env: spec.env,
    }).id;
  } catch (error) {
    process.stderr.write(`gstack: egress receipt could not be written for pr-prep (${(error as Error).message}); sending anyway (fail-open)\n`);
  }
  const outcome = (value: string) => {
    if (!receipt) return;
    try {
      writeOutcome({ receipt, status: value, env: spec.env });
    } catch { /* the outcome is best-effort bookkeeping; the receipt is the invariant */ }
  };
  let result: GhResult;
  sendDepth++;
  try {
    // PR-PREP SEND: the receipt above is already on disk.
    result = send();
  } catch (error) {
    outcome('threw');
    throw error;
  } finally {
    sendDepth--;
  }
  outcome(result.status === null ? 'error' : `exit:${result.status}`);
  return result;
}

// ── approval ────────────────────────────────────────────────────────────────

export const APPROVAL_FLAG = '--yes';

/**
 * Write subcommands refuse unless argv carries `--yes` exactly, as an
 * option: tokens after `--` are data, and so is the token after any flag in
 * `valueFlags` (the helper's flags that take a separate value, such as
 * `--message`), so `--message --yes` is not approval. Helpers pass their
 * value-taking flags, or only the flag tokens left after their own parsing.
 * The flag records the owner's yes given in the same turn; it is never stored.
 */
export function requireApproval(argv: string[], opts?: { valueFlags?: readonly string[] }): void {
  const valueFlags = new Set(opts?.valueFlags ?? []);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') break;
    if (argv[i] === APPROVAL_FLAG) return;
    if (valueFlags.has(argv[i])) i++;
  }
  throw new PrContextError('WRITE_REFUSED: approval missing', 2);
}

// ── untrusted text ──────────────────────────────────────────────────────────

/**
 * Terminal-safe text: OSC (`ESC ] ... BEL|ST`, unterminated runs too), CSI
 * and other escape sequences, every C0 control except `\n` and `\t`, DEL and
 * the C1 controls (U+0080-U+009F, which some terminals read as 8-bit CSI)
 * are dropped.
 */
export function stripControl(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[0-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

/** Tracker text (comments, bodies, titles, job logs) as model-safe DATA. */
export function envelope(text: string, source: string): string {
  return wrapUntrustedTrackerContent(stripControl(text), stripControl(source));
}
