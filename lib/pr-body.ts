/**
 * pr-body — the PR description as an owner-authored template plus one
 * regenerated facts block, never hand-patched (#3032: 21 python
 * search-and-replace edits and 8 `gh pr edit` calls over 19 revisions; the
 * body named a three-merges-old head for 24.5 h and other PRs' version
 * claims that went stale when those PRs merged).
 *
 *   gstack-pr-body facts   --pr <n|url> [--repo o/r] [--cwd <pr worktree>]
 *   gstack-pr-body render  --pr <n|url> [...] [--template <path>] [--out <path>]
 *   gstack-pr-body publish --pr <n|url> [...] --body <path> --yes
 *                          [--accept-live-diff] [--confirm-redaction <key,...>]
 *   gstack-pr-body check   --pr <n|url> [...]
 *
 * Volatile facts (head, base, version, merges of the base branch, the
 * code-diff fingerprint, commit count, validation, CI) live only between
 * `<!-- pr-prep:facts:begin v1 -->` and `<!-- pr-prep:facts:end -->`. Prose
 * never says "the head". No line states another PR's version claim.
 *
 * The owner's screenshot is protected by one invariant on the outgoing
 * bytes: every `user-attachments/assets/<id>` URL and every ticked
 * checklist line in the live body must also be in the body we send, wherever
 * it sits, or nothing is sent. A live body that changed since our last
 * publish (an owner web edit) needs --accept-live-diff after the owner has
 * seen the enveloped diff. GitHub keeps the last writer: an owner tab left
 * open on the description overwrites whatever is published here.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PrContextError, RELEASE_FILES, defaultGh, defaultGit, parsePrRefFor, upstreamRepoFromGh, remoteForRepo,
  pinBranch, readPr, viewerLogin, assertWritableIdentity, topicFor, prStateDir, readStateFor, writeState,
  withPrLock, receiptedSend, requireApproval, envelope,
  type GhResult, type GhRunner, type GitRunner, type PrInfo, type PrState,
} from './pr-context';
import { parseChecks, bucketClass } from './ci-gate';
import { scan, type Finding } from './redact-engine';
import { pollForWrite } from './pr-watch';

export const BODY_EXIT = { OK: 0, ERROR: 1, USAGE: 2, REFUSED: 20, REDACTION: 22, PRECONDITION: 30, LIVENESS_PENDING: 40 } as const;

export const BODY_USAGE = `gstack-pr-body <facts|render|publish|check> --pr <number|url> [options]

The PR description is an owner template plus one regenerated facts block.

  facts     measure head, base, version, merges, diff fingerprint, commits,
            validation and CI; write <state>/facts.json
  render    template + facts -> a body file; carries the live liveness
            section and ticked box 1; refuses a body that would drop a live
            attachment or ticked box, state another PR's version claim, or
            say "the head" outside the facts block
  publish   re-fetch, re-check, redaction-scan the exact bytes, then
            gh pr edit --body-file (needs --yes); read back and verify
  check     liveness: screenshot attached, box 1 ticked, no placeholder,
            every asset URL answers 200

Options:
  --pr N|URL                the upstream PR (required)
  --repo OWNER/NAME         upstream repo (default: gh repo view in --cwd)
  --cwd DIR                 the PR worktree (default: .)
  --template PATH           body template (default: <state>/body.tmpl.md)
  --out PATH                rendered body (default: <state>/pr-body-<date>.md)
  --body PATH               the rendered body to publish
  --yes                     the owner approved this publish in this turn
  --accept-live-diff        the owner saw the live-body diff and accepts replacing it
  --confirm-redaction K,..  the owner confirmed each MEDIUM finding key (id@line:col)

Exit codes: 0 ok, 1 error, 2 usage or approval missing, 20 refused (a live
attachment or ticked box would be lost, a lint rule, or an unaccepted live
diff), 22 redaction (HIGH, or MEDIUM not confirmed), 30 precondition (PR
not OPEN, pre-write gate), 40 liveness pending (check).`;

export const FACTS_BEGIN = '<!-- pr-prep:facts:begin v1 -->';
export const FACTS_END = '<!-- pr-prep:facts:end -->';
const ASSET_RE = /https:\/\/github\.com\/user-attachments\/assets\/[0-9a-fA-F-]{8,}/g;
const TICKED_RE = /^\s*[-*] \[[xX]\] .+$/gm;
const BOX1_RE = /^(\s*[-*] \[)([ xX])(\] Liveness screenshot attached.*)$/m;
const LIVENESS_HEADING_RE = /^## Liveness proof.*$/m;
const PLACEHOLDER_RE = /Screenshot to follow|Pending: the live|\[OWNER: attach/i;

// ── pure helpers ────────────────────────────────────────────────────────────

/** CRLF to LF (a web-UI save stores CRLF), trailing whitespace off each line, exactly one final newline. */
export function normalizeBody(text: string): string {
  return text.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n*$/, '\n');
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface Facts {
  at: string;
  head: string; codeSha: string; emptyCi: string[];
  baseRef: string; baseSha: string; baseVersion: string; basePr: string | null;
  version: string;
  merges: { upstream: string; version: string; pr: string | null }[];
  diff: { files: number; lines: number; patchId: string; previousPatchId: string | null };
  commits: number;
  validation: { sha: string; worst: number; summary: string } | null;
  ci: { pass: number; fail: number; pending: number; skipping: number; error: string | null };
}

const s12 = (s: string) => s.slice(0, 12);

export function renderFactsBlock(f: Facts): string {
  const lines = [FACTS_BEGIN, `**Current state** (regenerated by \`/pr-prep\` at ${f.at}):`];
  const empty = f.emptyCi.length ? `; its code is \`${s12(f.codeSha)}\`, and the ${f.emptyCi.length} commit${f.emptyCi.length > 1 ? 's' : ''} after it ${f.emptyCi.length > 1 ? 'are' : 'is an'} empty \`ci:\` re-run${f.emptyCi.length > 1 ? 's' : ''}` : '';
  lines.push(`- Head \`${s12(f.head)}\`${empty}. Base: \`${f.baseRef}\` at \`${s12(f.baseSha)}\` (v${f.baseVersion}${f.basePr ? `, ${f.basePr}` : ''}).`);
  if (f.version && f.version !== f.baseVersion) lines.push(`- \`VERSION\` ${f.version}, above \`${f.baseRef}\`'s ${f.baseVersion}.`);
  if (f.merges.length) {
    lines.push(`- Merges of \`${f.baseRef}\` (${f.merges.length}): ${f.merges.map(m => `\`${s12(m.upstream)}\` (v${m.version}${m.pr ? `, ${m.pr}` : ''})`).join(', ')}.`);
  }
  const same = f.diff.previousPatchId === null ? '' : f.diff.previousPatchId === f.diff.patchId ? ', unchanged since the last publish' : ', changed since the last publish';
  lines.push(`- PR diff without release files: ${f.diff.files} file${f.diff.files === 1 ? '' : 's'}, ${f.diff.lines} lines, patch-id \`${f.diff.patchId.slice(0, 12) || '-'}\`${same}.`);
  lines.push(`- Commits: ${f.commits} (excluding merges and the \`${f.baseRef}\` commits they bring in).`);
  const v = f.validation;
  lines.push(v && (v.sha === f.head || v.sha === f.codeSha)
    ? `- Validation at \`${s12(v.sha)}\`: ${v.summary}${v.worst ? ' (RED)' : ''}.`
    : '- Validation: not run at this head.');
  lines.push(f.ci.error
    ? `- CI at \`${s12(f.head)}\`: not read (${f.ci.error}).`
    : `- CI at \`${s12(f.head)}\`: ${f.ci.pass} pass, ${f.ci.fail} fail, ${f.ci.pending} pending, ${f.ci.skipping} skipping.`);
  lines.push(FACTS_END);
  return lines.join('\n');
}

/** Put the block at `{{FACTS}}`, or replace an existing block. */
export function spliceFacts(template: string, block: string): string {
  if (template.includes('{{FACTS}}')) return template.replace('{{FACTS}}', block);
  const a = template.indexOf(FACTS_BEGIN);
  const b = template.indexOf(FACTS_END);
  if (a >= 0 && b > a) return template.slice(0, a) + block + template.slice(b + FACTS_END.length);
  throw new PrContextError('the template has neither {{FACTS}} nor a facts block', 2);
}

export function stripFacts(body: string): string {
  const a = body.indexOf(FACTS_BEGIN);
  const b = body.indexOf(FACTS_END);
  return a >= 0 && b > a ? body.slice(0, a) + body.slice(b + FACTS_END.length) : body;
}

function section(body: string, heading: RegExp): { start: number; end: number } | null {
  const m = heading.exec(body);
  if (!m) return null;
  const next = /^## /m.exec(body.slice(m.index + m[0].length));
  return { start: m.index, end: next ? m.index + m[0].length + next.index : body.length };
}

/**
 * Carry the owner's liveness work from the live body: its `## Liveness proof`
 * section when that holds an attachment, and a ticked box 1.
 */
export function carryLiveness(next: string, live: string): string {
  let out = next;
  const liveSec = section(live, LIVENESS_HEADING_RE);
  const nextSec = section(out, LIVENESS_HEADING_RE);
  if (liveSec && nextSec) {
    const liveText = live.slice(liveSec.start, liveSec.end);
    if (liveText.match(ASSET_RE)) out = out.slice(0, nextSec.start) + liveText + out.slice(nextSec.end);
  }
  const liveBox = BOX1_RE.exec(live);
  if (liveBox && /[xX]/.test(liveBox[2])) out = out.replace(BOX1_RE, (_m, a: string, _b: string, c: string) => `${a}x${c}`);
  return out;
}

/** Every live attachment URL and ticked checklist line that the outgoing body would drop. */
export function lostOwnerContent(live: string, next: string): string[] {
  const lost: string[] = [];
  for (const url of new Set(live.match(ASSET_RE) ?? [])) if (!next.includes(url)) lost.push(`attachment ${url}`);
  for (const line of new Set((live.match(TICKED_RE) ?? []).map(l => l.trim()))) {
    if (!next.split('\n').some(n => n.trim() === line)) lost.push(`ticked: ${line}`);
  }
  return lost;
}

/** Rules for prose outside the facts block. */
export function lintBody(body: string): string[] {
  const problems: string[] = [];
  const prose = stripFacts(body).split('\n');
  prose.forEach((l, i) => {
    if (/\bclaim(s|ed|ing)?\b/i.test(l) && /\b\d+\.\d+\.\d+\.\d+\b/.test(l)) problems.push(`line ${i + 1}: states a version claim (claims go stale when other PRs merge)`);
    if (/\b(the|this PR's|previous|an earlier|earlier|current|new) head\b(?! (branch|ref|repo))/i.test(l)) problems.push(`line ${i + 1}: says "head" in prose (the facts block owns the head)`);
  });
  return problems;
}

export interface LivenessState { attached: string[]; ticked: boolean; placeholder: boolean }

export function livenessOf(body: string): LivenessState {
  const sec = section(body, LIVENESS_HEADING_RE);
  const scope = sec ? body.slice(sec.start, sec.end) : body;
  const box = BOX1_RE.exec(body);
  return { attached: [...new Set(body.match(ASSET_RE) ?? [])], ticked: !!box && /[xX]/.test(box[2]), placeholder: PLACEHOLDER_RE.test(scope) };
}

/** Versions already public in the repo: VERSION and CHANGELOG headings at the given revisions. */
export function publishedVersions(texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(/^(?:## \[)?(\d+\.\d+\.\d+\.\d+)\]?(?:\s|$)/gm)) out.add(m[1]);
  }
  return [...out].sort();
}

export const findingKey = (f: Finding) => `${f.id}@${f.line}:${f.col}`;

// ── deps ────────────────────────────────────────────────────────────────────

export type HttpStatus = (url: string) => Promise<number | null>;

export interface BodyDeps {
  gh: GhRunner; git: GitRunner; env: NodeJS.ProcessEnv; now: () => Date;
  out: (line: string) => void; http: HttpStatus;
  preWriteGate: (ctx: { gh: GhRunner; git: GitRunner; env: NodeJS.ProcessEnv; cwd: string; repo: string; number: number; state: PrState | null }) => { ok: boolean; reason: string };
}

/** An asset read (GET) is unreceipted, the same as gh's GET reads. */
const defaultHttp: HttpStatus = async url => {
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    return r.status;
  } catch {
    return null;
  }
};

/** Right before the edit: the PR is OPEN and a fresh gstack-pr-watch poll found nothing waiting for the owner. */
export const defaultBodyGate: BodyDeps['preWriteGate'] = ({ gh, git, env, cwd, repo, number }) => {
  const pr = readPr(gh, repo, number);
  if (pr.state !== 'OPEN') return { ok: false, reason: `PR #${number} is ${pr.state}` };
  return pollForWrite({ gh, git, env, now: () => new Date(), out: () => {} }, repo, number, cwd);
};

const realDeps = (): BodyDeps => ({
  gh: defaultGh, git: defaultGit, env: process.env, now: () => new Date(), out: l => process.stdout.write(l + '\n'),
  http: defaultHttp, preWriteGate: defaultBodyGate,
});

// ── context ─────────────────────────────────────────────────────────────────

interface Flags {
  sub: string; pr: string | null; repo: string | null; cwd: string; template: string | null; out: string | null;
  body: string | null; acceptLiveDiff: boolean; confirm: string[]; argv: string[];
}
const VALUE_FLAGS = ['--pr', '--repo', '--cwd', '--template', '--out', '--body', '--confirm-redaction'];

export function parseBodyArgs(argv: string[]): Flags {
  const f: Flags = { sub: argv[0] ?? '', pr: null, repo: null, cwd: process.cwd(), template: null, out: null, body: null, acceptLiveDiff: false, confirm: [], argv };
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
    else if (a === '--template') f.template = path.resolve(val());
    else if (a === '--out') f.out = path.resolve(val());
    else if (a === '--body') f.body = path.resolve(val());
    else if (a === '--confirm-redaction') f.confirm = val().split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--accept-live-diff') f.acceptLiveDiff = true;
    else if (a === '--yes') { /* requireApproval */ }
    else throw new PrContextError(`unknown option ${a}`, 2);
  }
  return f;
}

interface Ctx { d: BodyDeps; f: Flags; repo: string; pr: PrInfo; stateDir: string }

function resolveCtx(d: BodyDeps, f: Flags): Ctx {
  if (!f.pr) throw new PrContextError('--pr is required', 2);
  const repo = f.repo ?? upstreamRepoFromGh(d.gh, f.cwd);
  const pr = readPr(d.gh, repo, parsePrRefFor(f.pr, repo));
  return { d, f, repo, pr, stateDir: prStateDir({ cwd: f.cwd, topic: topicFor(pr.headRef), env: d.env }) };
}

function liveBody(c: Ctx): string {
  const r = c.d.gh(['api', `repos/${c.repo}/pulls/${c.pr.number}`, '--jq', '.body']);
  if (r.status !== 0) throw new PrContextError(`could not read PR #${c.pr.number}'s body: ${(r.error ?? r.stderr).trim().split('\n').at(-1)}`, 1);
  return normalizeBody(r.stdout === 'null\n' ? '' : r.stdout);
}

function gitOut(c: Ctx, args: string[]): string {
  const r = c.d.git(args, { cwd: c.f.cwd });
  if (r.status !== 0) throw new PrContextError(`git ${args[0]} failed: ${(r.error ?? r.stderr).trim().split('\n').at(-1)}`, 1);
  return r.stdout;
}

function freshState(pr: PrInfo): PrState {
  return {
    v: 1, topic: topicFor(pr.headRef), repo: pr.repo, number: pr.number, headRef: pr.headRef, headOwner: pr.headOwner,
    headRemote: null, upstreamRemote: null, defaultBranch: pr.baseRef, focused: null, validation: null,
    bodyStaleSince: null, lastPublishedBodySha256: null, signals: { latched: [], acked: [] }, audit: null,
  };
}

const prNum = (subject: string) => /\((#\d+)\)\s*$/.exec(subject)?.[1] ?? null;

// ── facts ───────────────────────────────────────────────────────────────────

export function collectFacts(c: Ctx): Facts {
  const { d, pr } = c;
  const headRemote = remoteForRepo(d.git, c.f.cwd, pr.headRepo);
  const upRemote = remoteForRepo(d.git, c.f.cwd, c.repo);
  if (!headRemote || !upRemote) throw new PrContextError(`no git remote in ${c.f.cwd} for ${headRemote ? c.repo : pr.headRepo}`, 30);
  const head = pinBranch(d.git, c.f.cwd, headRemote, pr.headRef).sha;
  const base = pinBranch(d.git, c.f.cwd, upRemote, pr.baseRef).sha;
  const show = (rev: string, file: string) => {
    const r = d.git(['show', `${rev}:${file}`], { cwd: c.f.cwd });
    return r.status === 0 ? r.stdout.trim() : '';
  };
  // Empty `ci:` re-run commits on top of the code.
  const emptyCi: string[] = [];
  let codeSha = head;
  for (;;) {
    const info = gitOut(c, ['log', '-1', '--format=%T %P%x00%s', codeSha]).trim();
    const [ids, subject = ''] = info.split('\0');
    const [tree, parent, second] = ids.split(' ');
    if (!parent || second || !/^ci:/.test(subject)) break;
    if (gitOut(c, ['rev-parse', `${parent}^{tree}`]).trim() !== tree) break;
    emptyCi.push(codeSha);
    codeSha = parent;
  }
  const mb = gitOut(c, ['merge-base', head, base]).trim();
  const merges = gitOut(c, ['rev-list', '--first-parent', '--merges', '--parents', `${base}..${head}`]).split('\n').filter(Boolean).reverse()
    .map(line => line.split(' ')[2])
    .filter((p): p is string => !!p)
    .map(p => ({ upstream: p, version: show(p, 'VERSION'), pr: prNum(gitOut(c, ['log', '-1', '--format=%s', p]).trim()) }));
  const exclude = RELEASE_FILES.map(f => `:(exclude)${f}`);
  const stat = gitOut(c, ['diff', '--numstat', mb, head, '--', '.', ...exclude]).split('\n').filter(Boolean);
  const lines = stat.reduce((n, l) => n + l.split('\t').slice(0, 2).reduce((a, x) => a + (Number(x) || 0), 0), 0);
  const diffText = gitOut(c, ['diff', '--no-color', mb, head, '--', '.', ...exclude]);
  const pid = diffText ? (d.git(['patch-id', '--stable'], { cwd: c.f.cwd, input: diffText }).stdout.trim().split(/\s+/)[0] ?? '') : '';
  let previous: Facts | null = null;
  try {
    previous = JSON.parse(fs.readFileSync(path.join(c.stateDir, 'facts.json'), 'utf8')) as Facts;
  } catch { /* first run */ }
  const state = readStateFor(c.stateDir, pr);
  const ciRaw = d.gh(['pr', 'checks', String(pr.number), '--repo', c.repo, '--json', 'name,bucket,link']);
  const parsed = parseChecks(ciRaw);
  const ci = { pass: 0, fail: 0, pending: 0, skipping: 0, error: null as string | null };
  if (parsed.kind === 'rows') {
    for (const row of parsed.rows) {
      if (row.bucket === 'skipping') ci.skipping++;
      else ci[bucketClass(row.bucket)]++;
    }
  } else if (parsed.kind === 'error') ci.error = parsed.cause;
  return {
    at: d.now().toISOString().replace(/\.\d+Z$/, 'Z'), head, codeSha, emptyCi, baseRef: pr.baseRef, baseSha: base,
    baseVersion: show(base, 'VERSION'), basePr: prNum(gitOut(c, ['log', '-1', '--format=%s', base]).trim()),
    version: show(head, 'VERSION'), merges,
    diff: { files: stat.length, lines, patchId: pid, previousPatchId: previous?.diff.patchId ?? null },
    commits: Number(gitOut(c, ['rev-list', '--no-merges', '--count', `${mb}..${head}`]).trim()),
    validation: state?.validation ? { sha: state.validation.sha, worst: state.validation.worst, summary: state.validation.summary } : null,
    ci,
  };
}

function cmdFacts(c: Ctx): number {
  const f = collectFacts(c);
  fs.mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(c.stateDir, 'facts.json'), JSON.stringify(f, null, 2) + '\n', { mode: 0o600 });
  c.d.out(`RESULT FACTS head=${s12(f.head)} base=${s12(f.baseSha)} version=${f.version} file=${path.join(c.stateDir, 'facts.json')}`);
  c.d.out(renderFactsBlock(f));
  return 0;
}

// ── render ──────────────────────────────────────────────────────────────────

function today(d: BodyDeps): string {
  return d.now().toISOString().slice(0, 10);
}

function cmdRender(c: Ctx): number {
  const { d } = c;
  const templatePath = c.f.template ?? path.join(c.stateDir, 'body.tmpl.md');
  if (!fs.existsSync(templatePath)) throw new PrContextError(`no template at ${templatePath} (write one from the PR's current body, with {{FACTS}} where the facts go)`, 2);
  const facts = collectFacts(c);
  fs.mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(c.stateDir, 'facts.json'), JSON.stringify(facts, null, 2) + '\n', { mode: 0o600 });
  const live = liveBody(c);
  const body = normalizeBody(carryLiveness(spliceFacts(fs.readFileSync(templatePath, 'utf8'), renderFactsBlock(facts)), live));
  const lost = lostOwnerContent(live, body);
  const lint = lintBody(body);
  const out = c.f.out ?? path.join(c.stateDir, `pr-body-${today(d)}.md`);
  fs.writeFileSync(out, body, { mode: 0o600 });
  const word = lost.length || lint.length ? 'REFUSED' : 'RENDERED';
  d.out(`RESULT ${word} body=${out} sha256=${sha256(body).slice(0, 12)} live-changed=${liveChanged(c, live) ? 'yes' : 'no'}`);
  for (const l of lost) d.out(`LOST ${l}`);
  for (const l of lint) d.out(`LINT ${l}`);
  return word === 'REFUSED' ? BODY_EXIT.REFUSED : BODY_EXIT.OK;
}

function liveChanged(c: Ctx, live: string): boolean {
  const last = readStateFor(c.stateDir, c.pr)?.lastPublishedBodySha256 ?? null;
  return last === null || last !== sha256(live);
}

// ── publish ─────────────────────────────────────────────────────────────────

function diffLines(a: string, b: string): string {
  const al = a.split('\n');
  const bl = b.split('\n');
  const out: string[] = [];
  for (const l of al) if (!bl.includes(l)) out.push(`- ${l}`);
  for (const l of bl) if (!al.includes(l)) out.push(`+ ${l}`);
  return out.join('\n');
}

function cmdPublish(c: Ctx): number {
  const { d } = c;
  requireApproval(c.f.argv, { valueFlags: VALUE_FLAGS });
  if (!c.f.body || !fs.existsSync(c.f.body)) throw new PrContextError('--body <rendered file> is required', 2);
  assertWritableIdentity(c.pr, viewerLogin(d.gh));
  // The gate polls gstack-pr-watch, which takes the PR lock itself: run it just before taking the lock.
  const gate = d.preWriteGate({ gh: d.gh, git: d.git, env: d.env, cwd: c.f.cwd, repo: c.repo, number: c.pr.number, state: readStateFor(c.stateDir, c.pr) });
  if (!gate.ok) throw new PrContextError(`pre-write gate: ${gate.reason}`, BODY_EXIT.PRECONDITION);
  return withPrLock(c.stateDir, () => {
    const raw = fs.readFileSync(c.f.body!, 'utf8');
    const body = normalizeBody(raw);
    if (body !== raw) throw new PrContextError('the body file is not normalised (render it with gstack-pr-body render)', 2);
    const live = liveBody(c);
    const lost = lostOwnerContent(live, body);
    if (lost.length) {
      for (const l of lost) d.out(`LOST ${l}`);
      d.out('RESULT REFUSED the outgoing body would drop live owner content');
      return BODY_EXIT.REFUSED;
    }
    const lint = lintBody(body);
    if (lint.length) {
      for (const l of lint) d.out(`LINT ${l}`);
      d.out('RESULT REFUSED lint');
      return BODY_EXIT.REFUSED;
    }
    if (liveChanged(c, live) && !c.f.acceptLiveDiff) {
      d.out(envelope(diffLines(live, body), `pr-${c.pr.number}-live-vs-new`));
      d.out('RESULT REFUSED the live body is not the one we last published (owner edit, or the first publish over a hand-written body): show the owner the diff above, then pass --accept-live-diff');
      return BODY_EXIT.REFUSED;
    }
    // Scan exactly the bytes that will be sent.
    const pubv = publishedVersions(gitTexts(c));
    const result = scan(body, { repoVisibility: 'public', allowlist: pubv });
    const high = result.findings.filter(f => f.severity === 'HIGH');
    const medium = result.findings.filter(f => f.severity === 'MEDIUM');
    if (high.length || result.oversize) {
      for (const f of high) d.out(`REDACTION HIGH ${findingKey(f)} ${f.description} ${f.preview}`);
      d.out('RESULT REDACTION blocked (HIGH)');
      return BODY_EXIT.REDACTION;
    }
    const unconfirmed = medium.filter(f => !c.f.confirm.includes(findingKey(f)));
    if (unconfirmed.length) {
      for (const f of unconfirmed) d.out(`REDACTION MEDIUM ${findingKey(f)} ${f.description} ${f.preview}`);
      d.out('RESULT REDACTION each MEDIUM finding needs the owner\'s confirmation: --confirm-redaction <key,...>');
      return BODY_EXIT.REDACTION;
    }
    const state = readStateFor(c.stateDir, c.pr);
    const sendFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pr-body-')), 'body.md');
    fs.writeFileSync(sendFile, body, { mode: 0o600 });
    try {
      const r: GhResult = receiptedSend({ host: 'github.com', payloadClass: 'pr-body-edit', consent: 'user ran /pr-prep', payload: Buffer.from(body), env: d.env }, () =>
        d.gh(['pr', 'edit', String(c.pr.number), '--repo', c.repo, '--body-file', sendFile]));
      if (r.status !== 0) throw new PrContextError(`gh pr edit failed: ${(r.error ?? r.stderr).trim().split('\n').at(-1)}`, 1);
    } finally {
      fs.rmSync(path.dirname(sendFile), { recursive: true, force: true });
    }
    const after = liveBody(c);
    const restore = path.join(c.stateDir, `pr-body-restore-${d.now().toISOString().replace(/[:.]/g, '-')}.md`);
    const vanished = lostOwnerContent(live, after);
    const facts = /<!-- pr-prep:facts:begin v1 -->[\s\S]*?<!-- pr-prep:facts:end -->/.exec(body)?.[0] ?? '';
    if (vanished.length || (facts && !after.includes(facts))) {
      fs.writeFileSync(restore, live, { mode: 0o600 });
      for (const v of vanished) d.out(`VANISHED ${v}`);
      d.out(`RESULT ERROR the read-back does not hold what was sent (a concurrent web edit?). The pre-publish body is saved at ${restore}; do not re-edit automatically, tell the owner.`);
      return BODY_EXIT.ERROR;
    }
    writeState(c.stateDir, { ...(state ?? freshState(c.pr)), lastPublishedBodySha256: sha256(after), bodyStaleSince: null });
    fs.copyFileSync(c.f.body!, path.join(c.stateDir, `pr-body-${today(d)}.published.md`));
    d.out(`RESULT PUBLISHED pr=${c.pr.number} sha256=${sha256(after).slice(0, 12)}`);
    d.out('WARNING if the owner has the PR description open for editing in a browser tab, they must cancel that edit: saving it overwrites this body and its screenshot.');
    return BODY_EXIT.OK;
  });
}

/** VERSION and CHANGELOG at the PR head and the base branch, from git objects only. */
function gitTexts(c: Ctx): string[] {
  const out: string[] = [];
  for (const rev of [c.pr.headOid, ...pinnedBase(c)]) {
    for (const file of ['VERSION', 'CHANGELOG.md']) {
      const r = c.d.git(['show', `${rev}:${file}`], { cwd: c.f.cwd });
      if (r.status === 0) out.push(r.stdout);
    }
  }
  return out;
}

function pinnedBase(c: Ctx): string[] {
  const up = remoteForRepo(c.d.git, c.f.cwd, c.repo);
  return up ? [pinBranch(c.d.git, c.f.cwd, up, c.pr.baseRef).sha] : [];
}

// ── check ───────────────────────────────────────────────────────────────────

async function cmdCheck(c: Ctx): Promise<number> {
  const { d } = c;
  const login = viewerLogin(d.gh);
  if (login === 'garrytan') {
    d.out('RESULT EXEMPT the PR author is the repo owner; no liveness screenshot is required');
    return BODY_EXIT.OK;
  }
  const live = livenessOf(liveBody(c));
  const statuses: string[] = [];
  let reachable = true;
  for (const url of live.attached) {
    const code = await d.http(url);
    statuses.push(`${url} -> ${code ?? 'no answer'}`);
    if (code !== 200) reachable = false;
  }
  const ok = live.attached.length > 0 && live.ticked && !live.placeholder && reachable;
  d.out(`RESULT ${ok ? 'ATTACHED' : 'PENDING'} attachments=${live.attached.length} box1=${live.ticked ? 'ticked' : 'unticked'} placeholder=${live.placeholder ? 'present' : 'gone'} reachable=${reachable ? 'yes' : 'no'}`);
  for (const s of statuses) d.out(`ASSET ${s}`);
  if (!ok) d.out('NEXT the owner attaches the live `GSTACK PR` screenshot in the Liveness proof section, ticks box 1 and deletes the placeholder, then runs `gh pr ready`; the agent never does');
  return ok ? BODY_EXIT.OK : BODY_EXIT.LIVENESS_PENDING;
}

// ── main ────────────────────────────────────────────────────────────────────

export async function bodyMain(argv: string[], deps: Partial<BodyDeps> = {}): Promise<number> {
  const d = { ...realDeps(), ...deps };
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    d.out(BODY_USAGE);
    return argv.length ? 0 : BODY_EXIT.USAGE;
  }
  try {
    const f = parseBodyArgs(argv);
    if (!['facts', 'render', 'publish', 'check'].includes(f.sub)) throw new PrContextError(`unknown subcommand ${JSON.stringify(f.sub)}`, 2);
    const c = resolveCtx(d, f);
    if (f.sub === 'facts') return cmdFacts(c);
    if (f.sub === 'render') return cmdRender(c);
    if (f.sub === 'publish') return cmdPublish(c);
    return await cmdCheck(c);
  } catch (error) {
    if (error instanceof PrContextError) {
      d.out(`RESULT ${error.code === 2 ? 'USAGE' : error.code === 30 ? 'PRECONDITION' : 'ERROR'} ${error.message}`);
      return error.code;
    }
    d.out(`RESULT ERROR ${(error as Error).message}`);
    return BODY_EXIT.ERROR;
  }
}
