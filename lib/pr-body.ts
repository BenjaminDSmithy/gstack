/**
 * pr-body — the PR description as an owner-authored template plus one
 * regenerated facts block, never hand-patched (#3032: 21 python
 * search-and-replace edits and 8 `gh pr edit` calls over 19 revisions; the
 * body named a three-merges-old head for 24.5 h and other PRs' version
 * claims that went stale when those PRs merged).
 *
 *   gstack-pr-body facts   --pr <n|url> [--repo o/r] [--cwd <pr worktree>]
 *   gstack-pr-body render  --pr <n|url> [...] [--template <path>] [--out <path>]
 *   gstack-pr-body publish --pr <n|url> [...] --body <path> --body-sha256 <hex> --yes
 *                          [--accept-live-diff <live sha256>] [--confirm-redaction <key,...>]
 *                          [--accept-rewritten-stale <stale push sha>]
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
 * publish (an owner web edit) needs --accept-live-diff <live-diff> after
 * the owner has seen the enveloped diff of exactly that live body against
 * exactly this outgoing body (live-diff is the sha256 of the pair); the yes
 * (--yes) is bound to the body's sha256 (--body-sha256), so neither carries
 * over to bytes the owner did not see. GitHub keeps the last writer: an
 * owner tab left open on the description overwrites whatever is published
 * here.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PrContextError, RELEASE_FILES, defaultGh, defaultGit, parsePrRefFor, upstreamRepoFromGh, remoteForRepo,
  pinBranch, readPr, viewerLogin, assertWritableIdentity, topicFor, prStateDir, readStateFor, writeState,
  withPrLock, receiptedSend, requireApproval, envelope, stripControl,
  type GhResult, type GhRunner, type GitRunner, type PrInfo, type PrState,
} from './pr-context';
import { parseChecks, bucketClass } from './ci-gate';
import { scan, type Finding } from './redact-engine';
import { writeOutcome, writeReceipt } from './egress-receipt';
import { pollForWrite, refuseUnackedLatches } from './pr-watch';

/**
 * Exit codes. 40 means two things by subcommand: check's liveness pending,
 * and (facts, render, publish) pinBranch's "remote moved or branch gone";
 * check never pins a branch, and bodyMain maps any other 40 from check to
 * 1, so a caller reading check's 40 always reads a pending screenshot.
 */
export const BODY_EXIT = { OK: 0, ERROR: 1, USAGE: 2, REFUSED: 20, REDACTION: 22, PRECONDITION: 30, LIVENESS_PENDING: 40, REMOTE_MOVED: 40, LOCK_BUSY: 45 } as const;

export const BODY_USAGE = `gstack-pr-body <facts|render|publish|check> --pr <number|url> [options]

The PR description is an owner template plus one regenerated facts block.

  facts     measure head, base, version, merges, diff fingerprint, commits,
            validation and CI; write <state>/facts.json
  render    template + facts -> a body file; carries the live liveness
            section and ticked box 1; refuses a body that would drop a live
            attachment or ticked box, state another PR's version claim, or
            say "the head" outside the facts block
  publish   re-fetch, re-check (the facts block must be the one facts or
            render last generated for the head), redaction-scan the exact
            bytes, then gh pr edit --body-file (needs --yes and
            --body-sha256); read back and verify, whatever gh exited
            with. A live body that already is the outgoing body (an
            earlier edit whose read-back failed) is recorded with no
            edit: RESULT PUBLISHED ... already-live=yes
  check     liveness: screenshot attached, box 1 ticked, no placeholder,
            every asset URL answers 200; exempt when the PR's author is
            garrytan

Options:
  --pr N|URL                the upstream PR (required)
  --repo OWNER/NAME         upstream repo (default: gh repo view in --cwd)
  --cwd DIR                 the PR worktree (default: .)
  --template PATH           body template (default: <state>/body.tmpl.md)
  --out PATH                rendered body (default: <state>/pr-body-<date>.md)
  --body PATH               the rendered body to publish
  --yes                     the owner approved this publish in this turn
  --body-sha256 HEX         the body sha256 (12+ hex, from render's RESULT line)
                            the owner approved; publish refuses other bytes
  --accept-live-diff HEX    the live-diff value (12+ hex) printed with the diff
                            the owner saw and accepted; it binds that live body
                            to this outgoing body, so a change to either one
                            gets a new diff and a new value
  --accept-rewritten-stale HEX
                            the stale push (12+ hex) publish named as missing
                            from the PR head's history after a force-push or
                            rebase; only on the owner's yes, after they saw it.
                            The body must still name the current head
  --confirm-redaction K,..  the owner confirmed each MEDIUM finding key
                            (id@line:col#<line hash>, as REDACTION printed it)

Exit codes: 0 ok, 1 error, 2 usage or approval missing, 20 refused (a live
attachment or ticked box would be lost, a lint rule, an unaccepted live
diff, a body that is not the approved sha256, or a facts block that is
not the generated one), 22 redaction (HIGH, or MEDIUM not confirmed),
30 precondition (PR not OPEN, the pre-write gate or a gate older than
60 s, facts naming an older head, or a body_stale_since push outside the
head's history without --accept-rewritten-stale for it), 40 for check: liveness pending; for facts, render and
publish: the PR's head or base branch is gone from its remote or kept
moving while it was fetched (fetch, then run again), 45 another pr-prep
run holds this PR's state lock (publish; wait for it, then run again).
Once the PR is resolved, every RESULT line of every subcommand, refusals
and errors included, reports body-stale-since=<sha|none>.`;

export const FACTS_BEGIN = '<!-- pr-prep:facts:begin v1 -->';
export const FACTS_END = '<!-- pr-prep:facts:end -->';
const ASSET_RE = /https:\/\/github\.com\/user-attachments\/assets\/[0-9a-fA-F-]{8,}/g;
// GitHub task-list items as GFM renders them checked: `-`, `*` or `+`
// bullets and `1.`/`1)` numbers, any run of spaces or tabs around the box,
// inside blockquotes too; `[x]` or `[X]`. A single-space-only pattern missed
// `-  [x] a`, `- [x]<TAB>a` and `> - [x] a`, so their loss was never refused.
const TICKED_RE = /^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+\[[xX]\][ \t]+\S.*$/gm;
const TICK_PREFIX_RE = /^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+\[[xX]\][ \t]+/;
const BOX1_RE = /^([ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\][ \t]+Liveness screenshot attached.*)$/m;
const LIVENESS_HEADING_RE = /^## Liveness proof.*$/m;
const PLACEHOLDER_RE = /Screenshot to follow|Pending: the live|\[OWNER: attach/i;

// ── pure helpers ────────────────────────────────────────────────────────────

/** CRLF to LF (a web-UI save stores CRLF), trailing whitespace off each line, exactly one final newline. */
export function normalizeBody(text: string): string {
  return text.replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/[ \t]+$/, '')).join('\n').replace(/\n*$/, '\n');
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * What --accept-live-diff names: one live body paired with one outgoing
 * body. The live body's sha256 alone let an acceptance given for the diff
 * live -> A publish a later render B, whose diff from the live body (what
 * B deletes from it) the owner never saw.
 */
export const liveDiffKey = (live: string, outgoing: string) => sha256(`${live}\0${outgoing}`);

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

/** Compare two 4-part versions numerically; null when either is not one. */
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

export function renderFactsBlock(f: Facts): string {
  const lines = [FACTS_BEGIN, `**Current state** (regenerated by \`/pr-prep\` at ${f.at}):`];
  const empty = f.emptyCi.length ? `; its code is \`${s12(f.codeSha)}\`, and the ${f.emptyCi.length} commit${f.emptyCi.length > 1 ? 's' : ''} after it ${f.emptyCi.length > 1 ? 'are' : 'is an'} empty \`ci:\` re-run${f.emptyCi.length > 1 ? 's' : ''}` : '';
  lines.push(`- Head \`${s12(f.head)}\`${empty}. Base: \`${f.baseRef}\` at \`${s12(f.baseSha)}\` (v${f.baseVersion}${f.basePr ? `, ${f.basePr}` : ''}).`);
  if (f.version) {
    const order = compareVersions(f.version, f.baseVersion);
    if (order === null) lines.push(`- \`VERSION\` ${f.version}; \`${f.baseRef}\` has ${f.baseVersion || 'none'}.`);
    else if (order > 0) lines.push(`- \`VERSION\` ${f.version}, above \`${f.baseRef}\`'s ${f.baseVersion}.`);
    else lines.push(`- \`VERSION\` ${f.version}, at or below \`${f.baseRef}\`'s ${f.baseVersion} (needs a sync).`);
  }
  if (f.merges.length) {
    lines.push(`- Merges of \`${f.baseRef}\` (${f.merges.length}): ${f.merges.map(m => `\`${s12(m.upstream)}\` (v${m.version}${m.pr ? `, ${m.pr}` : ''})`).join(', ')}.`);
  }
  // previousPatchId is the 12-hex patch-id the last PUBLISHED facts block printed ('' for an empty diff).
  // A blank id is an empty diff; over a non-empty one it proves nothing, so no verdict.
  const unknown = f.diff.previousPatchId === null || (!f.diff.patchId && (f.diff.files > 0 || f.diff.lines > 0));
  const same = unknown ? '' : f.diff.previousPatchId!.slice(0, 12) === f.diff.patchId.slice(0, 12) ? ', unchanged since the last publish' : ', changed since the last publish';
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

export const FACTS_MARKER = '<!-- pr-prep:facts -->';
const FACTS_BLOCK_RE = /<!-- pr-prep:facts:begin v1 -->[\s\S]*?<!-- pr-prep:facts:end -->/g;
const count = (text: string, needle: string) => text.split(needle).length - 1;

/**
 * Put the block at `<!-- pr-prep:facts -->`, or in place of the one existing
 * block. A text with no slot, or with more than one (a marker beside an old
 * block, two blocks), is refused: a second block would publish a stale
 * "Current state" next to the fresh one. The block is inserted by slicing,
 * never as a `replace` pattern, so `$'` or `$&` in a fact copies nothing.
 */
export function spliceFacts(template: string, block: string): string {
  const markers = count(template, FACTS_MARKER);
  const blocks = count(template, FACTS_BEGIN);
  if (markers + blocks !== 1 || count(template, FACTS_END) !== blocks) {
    throw new PrContextError(`the template must hold exactly one facts slot (${FACTS_MARKER} or one facts block); it has ${markers} marker(s) and ${blocks} block(s)`, 2);
  }
  if (markers) {
    const i = template.indexOf(FACTS_MARKER);
    return template.slice(0, i) + block + template.slice(i + FACTS_MARKER.length);
  }
  const a = template.indexOf(FACTS_BEGIN);
  const b = template.indexOf(FACTS_END);
  if (b < a) throw new PrContextError('the template\'s facts block ends before it begins', 2);
  return template.slice(0, a) + block + template.slice(b + FACTS_END.length);
}

/** The body without any facts block. */
export function stripFacts(body: string): string {
  return body.replace(FACTS_BLOCK_RE, () => '');
}

function section(body: string, heading: RegExp): { start: number; end: number } | null {
  const m = heading.exec(body);
  if (!m) return null;
  const next = /^## /m.exec(body.slice(m.index + m[0].length));
  return { start: m.index, end: next ? m.index + m[0].length + next.index : body.length };
}

const SLOT_RE = /(\n*)(<!-- pr-prep:facts:begin v1 -->[\s\S]*?<!-- pr-prep:facts:end -->|<!-- pr-prep:facts -->)(\n*)/g;
const hasSlot = (text: string) => text.includes(FACTS_MARKER) || text.includes(FACTS_BEGIN);

/** Where the template's own `## Liveness proof` section holds the facts slot. */
function slotInLiveness(template: string): boolean {
  const sec = section(template, LIVENESS_HEADING_RE);
  return !!sec && hasSlot(template.slice(sec.start, sec.end));
}

/**
 * Carry the owner's liveness work from the live body: its `## Liveness proof`
 * section when that holds an attachment, and a ticked box 1. The carried
 * section's facts block is an old one, and the template decides where the
 * fresh one goes: when its own Liveness section holds the slot, the first
 * carried block becomes the marker; otherwise every carried block goes, so
 * the template's slot elsewhere is the only one (an owner who moved the
 * marker out of that section was otherwise refused for ever, told to move
 * it out).
 */
export function carryLiveness(next: string, live: string): string {
  let out = next;
  const liveSec = section(live, LIVENESS_HEADING_RE);
  const nextSec = section(out, LIVENESS_HEADING_RE);
  if (liveSec && nextSec) {
    const liveText = live.slice(liveSec.start, liveSec.end);
    if (liveText.match(ASSET_RE)) {
      let keep = slotInLiveness(out);
      const carried = liveText.replace(SLOT_RE, (_m, lead: string, _slot: string, trail: string) => {
        if (keep) {
          keep = false;
          return lead + FACTS_MARKER + trail;
        }
        const n = Math.max(lead.length, trail.length);
        return '\n'.repeat(lead && trail ? Math.min(n, 2) : n);
      });
      out = out.slice(0, nextSec.start) + carried + out.slice(nextSec.end);
    }
  }
  const liveBox = BOX1_RE.exec(live);
  // The owner's own box character: `[X]` stays `[X]`.
  if (liveBox && /[xX]/.test(liveBox[2])) out = out.replace(BOX1_RE, (_m, a: string, _b: string, c: string) => `${a}${liveBox[2]}${c}`);
  return out;
}

/** A ticked line as compared: trimmed, any quote, bullet or number as `-`, the box as `[x]`, one space either side. */
const tickKey = (line: string) => line.trim().replace(TICK_PREFIX_RE, '- [x] ');

/** Every live attachment URL and ticked checklist line that the outgoing body would drop. */
export function lostOwnerContent(live: string, next: string): string[] {
  const lost: string[] = [];
  for (const url of new Set(live.match(ASSET_RE) ?? [])) if (!next.includes(url)) lost.push(`attachment ${url}`);
  const kept = new Set((next.match(TICKED_RE) ?? []).map(tickKey));
  const seen = new Set<string>();
  for (const line of (live.match(TICKED_RE) ?? []).map(l => l.trim())) {
    if (seen.has(tickKey(line))) continue;
    seen.add(tickKey(line));
    if (!kept.has(tickKey(line))) lost.push(`ticked: ${line}`);
  }
  return lost;
}

/**
 * Print lostOwnerContent's items. An attachment URL is bounded by ASSET_RE
 * (hex and hyphens), so it stays on a machine line. A ticked line is live
 * PR text anyone who can edit the description wrote: only its count goes on
 * a machine line, and the lines themselves go in one envelope, control
 * bytes stripped.
 */
function printOwnerContent(d: BodyDeps, word: 'LOST' | 'VANISHED', items: string[], pr: number): void {
  const ticks: string[] = [];
  for (const item of items) {
    if (item.startsWith('ticked: ')) ticks.push(item.slice('ticked: '.length));
    else d.out(`${word} ${item}`);
  }
  if (!ticks.length) return;
  d.out(`${word} ticked ${ticks.length} (the lines follow inside the envelope)`);
  d.out(envelope(ticks.join('\n'), `pr-${pr}-${word.toLowerCase()}-ticks`));
}

/**
 * What lint knows about the PR: `shas` are this PR's commits (base..head,
 * so the head, the code commit and earlier heads), `prNumber` its own
 * number, `released` the versions the base branch has published, `version`
 * this PR's own VERSION (naming it beside an issue number is no claim).
 */
export interface LintCtx { shas?: string[]; prNumber?: number; released?: string[]; version?: string }

const VERSION4_RE = /\b\d+\.\d+\.\d+\.\d+\b/g;
// Ways prose names a PR: `#3033` (not an HTML entity such as `&#8594;`),
// `PR 3033`/`PR #3033`/`PR#3033`, `pull request 3033`, `pull/3033` (a URL's too)
// and `owner/repo#3033`.
const PR_REF_RES: readonly RegExp[] = [/(?<![&\w])#(\d+)\b/g, /\bPR\s*#?(\d+)\b/gi, /\bpull request\s+#?(\d+)\b/gi, /\bpull\/(\d+)\b/g, /\b[\w.-]+\/[\w.-]+#(\d+)\b/g];

/** Every PR number a line names, in order of first appearance. */
export function prRefs(line: string): number[] {
  const found: { at: number; n: number }[] = [];
  for (const re of PR_REF_RES) for (const m of line.matchAll(re)) found.push({ at: m.index!, n: Number(m[1]) });
  return [...new Set(found.sort((a, b) => a.at - b.at).map(x => x.n))];
}
const HEAD_PHRASE_RE = /\b(?:the|this|our|its|latest|old|stale|previous|an earlier|earlier|current|new|PR'?s|PR)\s+head\b(?!\s+(?:branch|ref|repo))/i;

/**
 * Rules for prose outside the facts block, reported at the body's own line
 * numbers (each block is blanked, not removed):
 * - a version claim (a claim word beside a 4-part version);
 * - another PR's number beside a version the base has not released (a
 *   claim in other words: it goes stale when that PR merges or moves);
 * - "the head" and its variants;
 * - a 7-40 hex literal that is a prefix of one of this PR's commits,
 *   outside a fenced evidence block (the #3032 stale-head defect).
 */
export function lintBody(body: string, ctx: LintCtx = {}): string[] {
  const problems: string[] = [];
  const prose = body.replace(FACTS_BLOCK_RE, block => block.replace(/[^\n]/g, '')).split('\n');
  const shas = (ctx.shas ?? []).map(s => s.toLowerCase());
  const released = new Set(ctx.released ?? []);
  let fenced = false;
  prose.forEach((l, i) => {
    const at = `line ${i + 1}`;
    if (/^\s*(```|~~~)/.test(l)) {
      fenced = !fenced;
      return;
    }
    const versions = l.match(VERSION4_RE) ?? [];
    const others = prRefs(l).filter(n => n !== ctx.prNumber);
    if (/\bclaim(s|ed|ing)?\b/i.test(l) && versions.length) problems.push(`${at}: states a version claim (claims go stale when other PRs merge)`);
    else if (others.length && versions.some(v => !released.has(v) && v !== ctx.version)) problems.push(`${at}: names #${others[0]} beside an unreleased version (another PR's version goes stale when it merges)`);
    if (HEAD_PHRASE_RE.test(l)) problems.push(`${at}: says "head" in prose (the facts block owns the head)`);
    if (fenced || !shas.length) return;
    for (const m of l.matchAll(/\b[0-9a-fA-F]{7,40}\b/g)) {
      const token = m[0].toLowerCase();
      if (shas.some(s => s.startsWith(token))) {
        problems.push(`${at}: names \`${m[0]}\`, a commit of this PR, in prose (commit ids move; the facts block owns them)`);
        break;
      }
    }
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

/**
 * The redaction scan of the exact outgoing bytes, with the versions the repo
 * already published allowlisted. A finding that starts inside a git object
 * id the facts block printed (a backticked hex token that is a prefix of
 * one of `ids`, the facts' commit ids and patch-id) is dropped by
 * POSITION: an all-digit 12-hex prefix reads as a phone number to
 * pii.phone.e164 (39 of 2000 random facts blocks), which would ask the owner
 * to confirm a commit id. The same digits anywhere else, and a backticked
 * number in the block that is none of those ids (a card or phone number in
 * a validation summary), are still findings.
 */
export function scanOutgoing(body: string, published: string[], ids: string[]): ReturnType<typeof scan> {
  const result = scan(body, { repoVisibility: 'public', allowlist: published });
  const known = ids.map(i => i.toLowerCase()).filter(Boolean);
  const spans: [number, number][] = [];
  for (const block of body.matchAll(FACTS_BLOCK_RE)) {
    for (const m of block[0].matchAll(/`([0-9a-f]{7,40})`/g)) {
      if (!known.some(id => id.startsWith(m[1]))) continue;
      const start = block.index! + m.index! + 1;
      spans.push([start, start + m[1].length]);
    }
  }
  const lineStart = [0];
  for (let i = 0; i < body.length; i++) if (body[i] === '\n') lineStart.push(i + 1);
  const findings = result.findings.filter(f => {
    const at = (lineStart[f.line - 1] ?? 0) + f.col - 1;
    return !spans.some(([a, b]) => at >= a && at < b);
  });
  const counts = { HIGH: 0, MEDIUM: 0, LOW: 0, WARN: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return { ...result, findings, counts };
}

/**
 * The key the owner confirms a MEDIUM finding with: id, position, and the
 * first 8 hex of the flagged line's sha256. The engine shows at most 4
 * characters of a finding, so two values at one position (8.8.8.8, then
 * 9.9.9.9 after a re-render) look alike; the line hash makes the key, and
 * so the owner's yes, name the text they were shown.
 */
export function findingKey(f: Finding, body: string): string {
  return `${f.id}@${f.line}:${f.col}#${sha256(body.split('\n')[f.line - 1] ?? '').slice(0, 8)}`;
}

// ── deps ────────────────────────────────────────────────────────────────────

export type HttpStatus = (url: string) => Promise<number | null>;

export interface BodyDeps {
  gh: GhRunner; git: GitRunner; env: NodeJS.ProcessEnv; now: () => Date;
  out: (line: string) => void; http: HttpStatus;
  preWriteGate: (ctx: { gh: GhRunner; git: GitRunner; env: NodeJS.ProcessEnv; cwd: string; repo: string; number: number; state: PrState | null }) => { ok: boolean; reason: string };
}

/** An asset GET; cmdCheck receipts it (receiptedAssetGet). */
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
  body: string | null; bodySha: string | null; acceptLiveDiff: string | null; acceptRewrittenStale: string | null; confirm: string[]; argv: string[];
}
const VALUE_FLAGS = ['--pr', '--repo', '--cwd', '--template', '--out', '--body', '--body-sha256', '--accept-live-diff', '--accept-rewritten-stale', '--confirm-redaction'];
const SHA_PREFIX_RE = /^[0-9a-f]{12,64}$/;

export function parseBodyArgs(argv: string[]): Flags {
  const f: Flags = { sub: argv[0] ?? '', pr: null, repo: null, cwd: process.cwd(), template: null, out: null, body: null, bodySha: null, acceptLiveDiff: null, acceptRewrittenStale: null, confirm: [], argv };
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
    else if (a === '--body-sha256' || a === '--accept-live-diff') {
      const v = val().toLowerCase();
      if (!SHA_PREFIX_RE.test(v)) throw new PrContextError(`${a} needs a sha256 or its first 12+ hex characters`, 2);
      if (a === '--body-sha256') f.bodySha = v;
      else f.acceptLiveDiff = v;
    }
    else if (a === '--accept-rewritten-stale') {
      const v = val().toLowerCase();
      if (!SHA_PREFIX_RE.test(v)) throw new PrContextError(`${a} needs the stale push's commit id, at least its first 12 hex characters`, 2);
      f.acceptRewrittenStale = v;
    }
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
  const c: Ctx = { d, f, repo, pr, stateDir: prStateDir({ cwd: f.cwd, topic: topicFor(pr.headRef), env: d.env }) };
  // Every RESULT line from here on, refusals and errors included, says
  // whether a sync or ci: push left the body stale.
  c.d = { ...d, out: line => d.out(line.startsWith('RESULT ') && !line.includes(' body-stale-since=') ? `${line} ${staleFieldOrUnknown(c)}` : line) };
  return c;
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

/**
 * The PR diff without the release files, anchored at the repository root:
 * a plain `.` and `:(exclude)` resolve against --cwd, so a run from a
 * subdirectory measured only that subtree (other counts, another patch-id,
 * a false "changed since the last publish").
 */
const CODE_PATHSPEC: readonly string[] = [':(top)', ...RELEASE_FILES.map(f => `:(top,exclude)${f}`)];

/**
 * git's own patch whatever the owner's config says: diff.external (difftastic
 * and the like) replaced the patch with the tool's output, which patch-id
 * reads as no patch at all, a blank id that equalled the blank id of the last
 * publish ("unchanged" after a real push); textconv rewrites what is
 * compared, and diff.relative narrows the diff to --cwd again.
 */
const PLAIN_DIFF: readonly string[] = ['--no-color', '--no-ext-diff', '--no-textconv', '--no-relative'];

const numstatLines = (rows: string[]) => rows.reduce((n, l) => n + l.split('\t').slice(0, 2).reduce((a, x) => a + (Number(x) || 0), 0), 0);

/** package.json's text with its top-level `version` value blanked; the text as it is when that cannot be done exactly. */
export function manifestWithoutVersion(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || typeof (parsed as { version?: unknown }).version !== 'string') return text;
  const out = text.replace(/^([ \t]*"version"[ \t]*:[ \t]*)"(?:[^"\\\n]|\\.)*"/m, (_m, key: string) => `${key}"-"`);
  try {
    // The first "version" line could belong to a nested object: then keep the text.
    return (JSON.parse(out) as { version?: unknown }).version === '-' ? out : text;
  } catch {
    return text;
  }
}

/**
 * package.json's changes between two revisions with its top-level version
 * held equal. RELEASE_FILES keeps package.json out of the code diff because
 * a sync re-versions it, but a dependency, a script or a bin entry is code:
 * excluding the whole file published "unchanged since the last publish"
 * after a push that only added a postinstall script. The two manifests go
 * through `git diff --no-index` in a scratch directory, and the header
 * names are rewritten to package.json's own, so the patch-id input is the
 * patch git prints for the file when only the version is set aside.
 */
function manifestDiff(c: Ctx, from: string, to: string): { files: number; lines: number; text: string } {
  const read = (rev: string) => {
    const r = c.d.git(['show', `${rev}:package.json`], { cwd: c.f.cwd });
    return r.status === 0 ? r.stdout : null;
  };
  const a = read(from);
  const b = read(to);
  const none = { files: 0, lines: 0, text: '' };
  if (a === b) return none;
  const na = manifestWithoutVersion(a ?? '');
  const nb = manifestWithoutVersion(b ?? '');
  if (na === nb) return none;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pr-body-manifest-'));
  try {
    for (const [side, text] of [['a', na], ['b', nb]]) {
      fs.mkdirSync(path.join(dir, side));
      fs.writeFileSync(path.join(dir, side, 'package.json'), text);
    }
    const diff = (extra: string[]) => {
      const r = c.d.git(['diff', '--no-index', ...PLAIN_DIFF, ...extra, '--', 'a/package.json', 'b/package.json'], { cwd: dir });
      // --no-index exits 1 when the files differ.
      if (r.status !== 0 && r.status !== 1) throw new PrContextError(`git diff of package.json failed: ${(r.error ?? r.stderr).trim().split('\n').at(-1)}`, 1);
      return r.stdout;
    };
    const text = diff(['--binary']).split('\n').map(l => (/^(?:diff --git|--- |\+\+\+ )/.test(l) ? l.replace(' a/a/', ' a/').replace(' b/b/', ' b/') : l)).join('\n');
    return { files: text ? 1 : 0, lines: numstatLines(diff(['--numstat']).split('\n').filter(Boolean)), text };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * `git patch-id --stable` of a diff ('' for an empty one). A failed run or
 * a non-empty diff without an id is an error, never a blank fingerprint.
 * The diff is taken with --binary: without it every change to one binary
 * file prints the same "Binary files differ" line, and so the same id.
 */
function patchIdOf(c: Ctx, diffText: string): string {
  if (!diffText) return '';
  const r = c.d.git(['patch-id', '--stable'], { cwd: c.f.cwd, input: diffText });
  const id = r.stdout.trim().split(/\s+/)[0] ?? '';
  if (r.status !== 0 || !/^[0-9a-f]{40}$/.test(id)) {
    throw new PrContextError(`git patch-id failed on the PR diff: ${(r.error ?? r.stderr).trim().split('\n').at(-1) || 'no id printed'}`, 1);
  }
  return id;
}

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
  // A merge of the base branch: its merged parent is in the pinned base's
  // history. A merge of a side branch is not one, whatever it carries.
  const inBase = (sha: string) => {
    const r = d.git(['merge-base', '--is-ancestor', sha, base], { cwd: c.f.cwd });
    if (r.status === 0 || r.status === 1) return r.status === 0;
    throw new PrContextError(`git merge-base --is-ancestor failed: ${(r.error ?? r.stderr).trim().split('\n').at(-1)}`, 1);
  };
  const merges = gitOut(c, ['rev-list', '--first-parent', '--merges', '--parents', `${base}..${head}`]).split('\n').filter(Boolean).reverse()
    .map(line => line.split(' ')[2])
    .filter((p): p is string => !!p && inBase(p))
    .map(p => ({ upstream: p, version: show(p, 'VERSION'), pr: prNum(gitOut(c, ['log', '-1', '--format=%s', p]).trim()) }));
  const stat = gitOut(c, ['diff', ...PLAIN_DIFF, '--numstat', mb, head, '--', ...CODE_PATHSPEC]).split('\n').filter(Boolean);
  const manifest = manifestDiff(c, mb, head);
  const lines = numstatLines(stat) + manifest.lines;
  const pid = patchIdOf(c, gitOut(c, ['diff', ...PLAIN_DIFF, '--binary', mb, head, '--', ...CODE_PATHSPEC]) + manifest.text);
  const previous = readPublishedFacts(c.stateDir);
  const state = readStateFor(c.stateDir, pr);
  const ci = readCiAt(c, head);
  return {
    at: d.now().toISOString().replace(/\.\d+Z$/, 'Z'), head, codeSha, emptyCi, baseRef: pr.baseRef, baseSha: base,
    baseVersion: show(base, 'VERSION'), basePr: prNum(gitOut(c, ['log', '-1', '--format=%s', base]).trim()),
    version: show(head, 'VERSION'), merges,
    diff: { files: stat.length + manifest.files, lines, patchId: pid, previousPatchId: previous ? previous.patchId : null },
    commits: Number(gitOut(c, ['rev-list', '--no-merges', '--count', `${mb}..${head}`]).trim()),
    validation: state?.validation ? { sha: state.validation.sha, worst: state.validation.worst, summary: state.validation.summary } : null,
    ci,
  };
}

/**
 * Check counts for exactly `head`, the pinned head the facts block names.
 * `gh pr checks` reads GitHub's current PR head, which lags a fresh push, so
 * GitHub's head is read before (at resolveCtx) and after the checks, the way
 * gstack-ci-gate --expect-head does; either one off the pinned head means
 * the counts belong to another commit and the line says "not read".
 */
function readCiAt(c: Ctx, head: string): Facts['ci'] {
  const { d, pr } = c;
  const ci = { pass: 0, fail: 0, pending: 0, skipping: 0, error: null as string | null };
  const offHead = (seen: string) => `GitHub's PR head is ${s12(seen)}, not the pinned head ${s12(head)}; re-run facts once GitHub has the push`;
  if (pr.headOid !== head) return { ...ci, error: offHead(pr.headOid) };
  const parsed = parseChecks(d.gh(['pr', 'checks', String(pr.number), '--repo', c.repo, '--json', 'name,bucket,link']));
  let after = '';
  try {
    after = readPr(d.gh, c.repo, pr.number).headOid;
  } catch {
    return { ...ci, error: 'could not re-read the PR head after the checks' };
  }
  if (after !== head) return { ...ci, error: offHead(after) };
  if (parsed.kind === 'rows') {
    for (const row of parsed.rows) {
      if (row.bucket === 'skipping') ci.skipping++;
      else ci[bucketClass(row.bucket)]++;
    }
  } else if (parsed.kind === 'error') ci.error = parsed.cause;
  return ci;
}

function cmdFacts(c: Ctx): number {
  const f = collectFacts(c);
  fs.mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(c.stateDir, 'facts.json'), JSON.stringify(f, null, 2) + '\n', { mode: 0o600 });
  c.d.out(`RESULT FACTS head=${s12(f.head)} base=${s12(f.baseSha)} version=${f.version} ${staleField(c)} file=${path.join(c.stateDir, 'facts.json')}`);
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
  if (!fs.existsSync(templatePath)) throw new PrContextError(`no template at ${templatePath} (write one from the PR's current body, with <!-- pr-prep:facts --> where the facts go)`, 2);
  const facts = collectFacts(c);
  fs.mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(c.stateDir, 'facts.json'), JSON.stringify(facts, null, 2) + '\n', { mode: 0o600 });
  const live = liveBody(c);
  const template = fs.readFileSync(templatePath, 'utf8');
  const block = renderFactsBlock(facts);
  spliceFacts(template, block); // the template itself holds exactly one slot, or this is a usage error
  // Carry the owner's liveness work first, then fill the slot: a slot inside
  // the carried section (its old block, from the live body) gets the fresh facts.
  const carried = carryLiveness(template, live);
  let body = '';
  const slotProblems: string[] = [];
  try {
    body = normalizeBody(spliceFacts(carried, block));
  } catch (error) {
    if (!(error instanceof PrContextError)) throw error;
    body = normalizeBody(carried);
    slotProblems.push(slotInLiveness(template)
      ? `the template's facts slot sits in the "## Liveness proof" section, which render takes from the live body to keep the owner's screenshot, and that live section holds no facts slot: move ${FACTS_MARKER} out of that section`
      : `the live "## Liveness proof" section render carried left the body without exactly one facts slot (${error.message})`);
  }
  const lost = lostOwnerContent(live, body);
  const lint = lintBody(body, lintContext(c, facts.head, facts.baseSha));
  const out = c.f.out ?? path.join(c.stateDir, `pr-body-${today(d)}.md`);
  fs.writeFileSync(out, body, { mode: 0o600 });
  const word = lost.length || lint.length || slotProblems.length ? 'REFUSED' : 'RENDERED';
  d.out(`RESULT ${word} body=${out} sha256=${sha256(body).slice(0, 12)} live-changed=${liveChanged(c, live) ? 'yes' : 'no'} ${staleField(c)}`);
  for (const l of slotProblems) d.out(`FACTS ${l}`);
  printOwnerContent(d, 'LOST', lost, c.pr.number);
  for (const l of lint) d.out(`LINT ${l}`);
  return word === 'REFUSED' ? BODY_EXIT.REFUSED : BODY_EXIT.OK;
}

function liveChanged(c: Ctx, live: string): boolean {
  const last = readStateFor(c.stateDir, c.pr)?.lastPublishedBodySha256 ?? null;
  return last === null || last !== sha256(live);
}

// ── publish ─────────────────────────────────────────────────────────────────

/**
 * A line diff of `a` to `b` in hunks: `- ` removed, `+ ` added, two lines of
 * `  ` context, each hunk headed `@@ live line N, new line M @@`. Moved
 * sections and dropped duplicate lines show, which a set difference of
 * lines hid (a reordered body diffed as empty). The middle between the
 * common prefix and suffix is aligned by LCS; past 4M cells it is shown as
 * all removed then all added, coarse but never missing a line. Empty only
 * when the texts are equal.
 */
export function lineDiff(a: string, b: string): string {
  if (a === b) return '';
  const x = a.split('\n');
  const y = b.split('\n');
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  const xm = x.slice(pre, x.length - suf);
  const ym = y.slice(pre, y.length - suf);
  const n = xm.length;
  const m = ym.length;
  const mid: ('=' | '-' | '+')[] = [];
  if (n * m <= 4_000_000) {
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = xm[i] === ym[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && xm[i] === ym[j]) { mid.push('='); i++; j++; }
      else if (j >= m || (i < n && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) { mid.push('-'); i++; }
      else { mid.push('+'); j++; }
    }
  } else {
    mid.push(...Array<'-'>(n).fill('-'), ...Array<'+'>(m).fill('+'));
  }
  const ops = [...Array<'='>(pre).fill('='), ...mid, ...Array<'='>(suf).fill('=')];
  const rows: { op: '=' | '-' | '+'; text: string; ai: number; bi: number }[] = [];
  let ai = 0;
  let bi = 0;
  for (const op of ops) {
    if (op === '=') rows.push({ op, text: x[ai], ai: ai++, bi: bi++ });
    else if (op === '-') rows.push({ op, text: x[ai], ai: ai++, bi });
    else rows.push({ op, text: y[bi], ai, bi: bi++ });
  }
  const show = new Array<boolean>(rows.length).fill(false);
  rows.forEach((r, k) => {
    if (r.op === '=') return;
    for (let t = Math.max(0, k - 2); t <= Math.min(rows.length - 1, k + 2); t++) show[t] = true;
  });
  const out: string[] = [];
  rows.forEach((r, k) => {
    if (!show[k]) return;
    if (k === 0 || !show[k - 1]) out.push(`@@ live line ${r.ai + 1}, new line ${r.bi + 1} @@`);
    out.push(`${r.op === '=' ? ' ' : r.op} ${r.text}`);
  });
  return out.join('\n');
}

/**
 * What the last verified publish put in the PR: its facts block's head and
 * patch-id (12 hex; '' for an empty diff). facts and render rewrite
 * facts.json on every run, refusals included, so "since the last publish"
 * reads this file, which only a verified publish writes.
 */
interface PublishedFacts { v: 1; at: string; head: string; patchId: string; bodySha256: string }
const PUBLISHED_FACTS = 'published-facts.json';

function readPublishedFacts(dir: string): PublishedFacts | null {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(dir, PUBLISHED_FACTS), 'utf8')) as PublishedFacts;
    return p && p.v === 1 && typeof p.patchId === 'string' ? p : null;
  } catch {
    return null;
  }
}

/** Every git object id and the patch-id a facts block prints. */
function factIds(f: Facts): string[] {
  return [f.head, f.codeSha, ...f.emptyCi, f.baseSha, ...f.merges.map(m => m.upstream), f.validation?.sha ?? '', f.diff.patchId];
}

/** The facts facts/render last wrote (<state>/facts.json), or null when absent or unreadable. */
function readGeneratedFacts(dir: string): Facts | null {
  try {
    const f = JSON.parse(fs.readFileSync(path.join(dir, 'facts.json'), 'utf8')) as Facts;
    return f && typeof f.head === 'string' && f.diff && f.ci && Array.isArray(f.emptyCi) && Array.isArray(f.merges) ? f : null;
  } catch {
    return null;
  }
}

/** The 12-hex head the body's facts block names (`- Head \`<sha>\``), or null. */
export function factsHeadOf(body: string): string | null {
  const block = body.match(FACTS_BLOCK_RE)?.[0] ?? '';
  return /^- Head `([0-9a-f]{12})`/m.exec(block)?.[1] ?? null;
}

function staleBody(named: string, head: string): PrContextError {
  return new PrContextError(`the body's facts name ${named}, but the PR head is ${s12(head)}: re-render with gstack-pr-body render, then publish that body`, BODY_EXIT.PRECONDITION);
}

/** `body-stale-since=<sha12|none>`: a sync or ci push set it, the next verified publish clears it. */
function staleField(c: Ctx): string {
  const stale = readStateFor(c.stateDir, c.pr)?.bodyStaleSince ?? null;
  return `body-stale-since=${stale ? s12(stale) : 'none'}`;
}

function staleFieldOrUnknown(c: Ctx): string {
  try {
    return staleField(c);
  } catch {
    return 'body-stale-since=unknown';
  }
}

/** The pre-write gate must have run within this long of the edit (plan: "within 60 s of the write"). */
export const GATE_MAX_AGE_MS = 60_000;

/**
 * Order matters. Every check that needs the network, except the live-body
 * read, runs BEFORE the pre-write gate: the base and head pins (git fetch,
 * up to 300 s each), lint against this PR's commits, the redaction scan
 * of the exact bytes (so no diff ever prints an unscanned secret). Inside
 * the lock the live body is read last, its checks are pure, and the edit
 * follows at once: a web save can still land in that window (GitHub has no
 * compare-and-swap for a PR body), but no fetch widens it. The edit is
 * refused when the gate ran more than GATE_MAX_AGE_MS before it.
 */
function cmdPublish(c: Ctx): number {
  const { d } = c;
  requireApproval(c.f.argv, { valueFlags: VALUE_FLAGS });
  if (!c.f.body || !fs.existsSync(c.f.body)) throw new PrContextError('--body <rendered file> is required', 2);
  if (!c.f.bodySha) throw new PrContextError('--body-sha256 <the sha256 the owner approved> is required', 2);
  assertWritableIdentity(c.pr, viewerLogin(d.gh));
  const raw = fs.readFileSync(c.f.body, 'utf8');
  const body = normalizeBody(raw);
  if (body !== raw) throw new PrContextError('the body file is not normalised (render it with gstack-pr-body render)', 2);
  if (!sha256(body).startsWith(c.f.bodySha)) {
    d.out(`RESULT REFUSED the body's sha256 is ${sha256(body).slice(0, 12)}, not the ${c.f.bodySha} the owner approved: show the owner this body and ask again`);
    return BODY_EXIT.REFUSED;
  }
  if (count(body, FACTS_BEGIN) !== 1 || count(body, FACTS_END) !== 1) {
    d.out(`RESULT REFUSED the body must hold exactly one facts block; it has ${count(body, FACTS_BEGIN)} (render it with gstack-pr-body render)`);
    return BODY_EXIT.REFUSED;
  }
  const factsHead = factsHeadOf(body);
  if (!factsHead) {
    d.out('RESULT REFUSED the facts block names no head (render it with gstack-pr-body render)');
    return BODY_EXIT.REFUSED;
  }
  if (!c.pr.headOid.startsWith(factsHead)) throw staleBody(factsHead, c.pr.headOid);
  const revs = pinnedRevs(c);
  const lint = lintBody(body, lintContext(c, c.pr.headOid, revs[1] ?? null));
  if (lint.length) {
    d.out('RESULT REFUSED lint');
    for (const l of lint) d.out(`LINT ${l}`);
    return BODY_EXIT.REFUSED;
  }
  // The block must be byte-equal to the one facts/render generated for this
  // head: one checked head line let a hand-patched validation or CI line go
  // out under the "regenerated by /pr-prep" banner (#3032's failure).
  const generated = readGeneratedFacts(c.stateDir);
  if (!generated || generated.head !== c.pr.headOid || body.match(FACTS_BLOCK_RE)?.[0] !== renderFactsBlock(generated)) {
    d.out(`RESULT REFUSED the body's facts block is not the one gstack-pr-body generated for head ${s12(c.pr.headOid)} (${path.join(c.stateDir, 'facts.json')}): render again, and never edit the facts block by hand`);
    return BODY_EXIT.REFUSED;
  }
  // Scan exactly the bytes that will be sent, before anything prints them.
  const result = scanOutgoing(body, publishedVersions(gitTexts(c, revs)), factIds(generated));
  const high = result.findings.filter(f => f.severity === 'HIGH');
  const medium = result.findings.filter(f => f.severity === 'MEDIUM');
  if (high.length || result.oversize) {
    d.out(`RESULT REDACTION blocked (${result.oversize ? 'too large to scan' : 'HIGH'})`);
    for (const f of high) d.out(`REDACTION HIGH ${findingKey(f, body)} ${f.description} ${f.preview}`);
    return BODY_EXIT.REDACTION;
  }
  const unconfirmed = medium.filter(f => !c.f.confirm.includes(findingKey(f, body)));
  if (unconfirmed.length) {
    d.out('RESULT REDACTION each MEDIUM finding needs the owner\'s confirmation: --confirm-redaction <key,...>');
    for (const f of unconfirmed) d.out(`REDACTION MEDIUM ${findingKey(f, body)} ${f.description} ${f.preview}`);
    return BODY_EXIT.REDACTION;
  }
  // The gate polls gstack-pr-watch, which takes the PR lock itself: run it just before taking the lock.
  const gateAt = d.now().getTime();
  const gate = d.preWriteGate({ gh: d.gh, git: d.git, env: d.env, cwd: c.f.cwd, repo: c.repo, number: c.pr.number, state: readStateFor(c.stateDir, c.pr) });
  if (!gate.ok) throw new PrContextError(`pre-write gate: ${gate.reason}`, BODY_EXIT.PRECONDITION);
  return withPrLock(c.stateDir, () => {
    const now = readPr(d.gh, c.repo, c.pr.number);
    if (now.state !== 'OPEN') throw new PrContextError(`PR #${c.pr.number} is ${now.state}`, BODY_EXIT.PRECONDITION);
    if (!now.headOid.startsWith(factsHead)) throw staleBody(factsHead, now.headOid);
    const state = readStateFor(c.stateDir, c.pr);
    refuseUnackedLatches(state);
    const stale = state?.bodyStaleSince ?? null;
    if (stale && stale !== now.headOid) {
      const r = d.git(['merge-base', '--is-ancestor', stale, now.headOid], { cwd: c.f.cwd });
      // The branch was rewritten after that push (a squash and force-push, or a rebase "Update branch"). Only
      // a publish clears the mark and sync push and retrigger refuse until then, so the owner, shown this,
      // may accept that one push by its id: the body still has to name the current head.
      const accepted = c.f.acceptRewrittenStale !== null && stale.startsWith(c.f.acceptRewrittenStale);
      if (r.status !== 0 && !accepted) {
        throw new PrContextError(`the body has been stale since the push of ${s12(stale)}, which is not in the PR head's history (${s12(now.headOid)}); find out what replaced that push, show the owner, and only on their yes publish with --accept-rewritten-stale ${s12(stale)}`, BODY_EXIT.PRECONDITION);
      }
    }
    const live = liveBody(c);
    // GitHub already holds exactly the approved bytes: an earlier publish
    // whose edit landed but whose read-back failed, or gh pr edit exiting
    // non-zero after GitHub took the body. Record it; there is nothing to send.
    if (live === body) return recordPublished(c, state, body, factsHead, stale, ['already-live=yes']);
    const lost = lostOwnerContent(live, body);
    if (lost.length) {
      d.out('RESULT REFUSED the outgoing body would drop live owner content');
      printOwnerContent(d, 'LOST', lost, c.pr.number);
      return BODY_EXIT.REFUSED;
    }
    const key = liveDiffKey(live, body);
    const pair = key.slice(0, 12);
    if (liveChanged(c, live) && !(c.f.acceptLiveDiff && key.startsWith(c.f.acceptLiveDiff))) {
      const again = c.f.acceptLiveDiff ? ' (the live body or the outgoing body changed after the diff the owner accepted)' : '';
      d.out(`RESULT REFUSED live-diff=${pair} the live body (sha256 ${sha256(live).slice(0, 12)}) is not the one we last published${again} (an owner or maintainer edit, or the first publish over a hand-written body): show the owner the diff below; on their yes pass --accept-live-diff ${pair}`);
      // Never empty: lineDiff is '' only for equal texts, handled above.
      d.out(envelope(lineDiff(live, body), `pr-${c.pr.number}-live-vs-new`));
      return BODY_EXIT.REFUSED;
    }
    const waited = d.now().getTime() - gateAt;
    if (waited > GATE_MAX_AGE_MS) {
      d.out(`RESULT PRECONDITION the pre-write gate ran ${Math.round(waited / 1000)} s before the edit (limit ${GATE_MAX_AGE_MS / 1000} s): run publish again`);
      return BODY_EXIT.PRECONDITION;
    }
    const sendFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-pr-body-')), 'body.md');
    fs.writeFileSync(sendFile, body, { mode: 0o600 });
    // A failed gh pr edit is not proof that nothing changed (a timeout or a
    // 502 after GitHub took the body), so the body is read back either way
    // and the read-back decides.
    let editFailure: string | null = null;
    try {
      const r: GhResult = receiptedSend({ host: 'github.com', payloadClass: 'pr-body-edit', consent: 'user ran /pr-prep', payload: Buffer.from(body), env: d.env }, () =>
        d.gh(['pr', 'edit', String(c.pr.number), '--repo', c.repo, '--body-file', sendFile]));
      if (r.status !== 0) editFailure = stripControl((r.error ?? r.stderr).trim().split('\n').at(-1) || `exit ${r.status}`);
    } finally {
      fs.rmSync(path.dirname(sendFile), { recursive: true, force: true });
    }
    let after: string;
    try {
      after = liveBody(c);
    } catch (error) {
      if (!(error instanceof PrContextError)) throw error;
      const restore = saveRestore(c, live);
      d.out(`RESULT ERROR the edit was sent${editFailure ? ` (gh pr edit reported: ${editFailure})` : ''} but the read-back failed (${error.message}), so what GitHub holds is unknown. The pre-publish body is saved at ${restore}. Tell the owner; with their yes, run this publish again: it records the publish with no second edit when GitHub holds exactly this body`);
      return BODY_EXIT.ERROR;
    }
    if (after === body) return recordPublished(c, state, body, factsHead, stale, [], editFailure ? [`NOTE gh pr edit reported "${editFailure}", but the read-back is exactly the body sent`] : []);
    if (editFailure && after === live) {
      d.out(`RESULT ERROR gh pr edit failed: ${editFailure}; the read-back shows the live body unchanged`);
      return BODY_EXIT.ERROR;
    }
    // The read-back must hold exactly the bytes sent. Anything else (a web
    // save or a bot edit in the window) is reported, and the stored body is
    // NOT recorded as ours, so the next publish shows the difference.
    const restore = saveRestore(c, live);
    d.out(`RESULT ERROR the read-back is not the body sent (a concurrent web edit?${editFailure ? `; gh pr edit reported: ${editFailure}` : ''}). The pre-publish body is saved at ${restore}; do not re-edit automatically, tell the owner. The difference, sent -> stored, follows.`);
    printOwnerContent(d, 'VANISHED', lostOwnerContent(live, after), c.pr.number);
    d.out(envelope(lineDiff(body, after), `pr-${c.pr.number}-sent-vs-stored`));
    return BODY_EXIT.ERROR;
  });
}

/** The live body as it was before this publish, for the owner to restore by hand. */
function saveRestore(c: Ctx, live: string): string {
  const restore = path.join(c.stateDir, `pr-body-restore-${c.d.now().toISOString().replace(/[:.]/g, '-')}.md`);
  fs.mkdirSync(c.stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(restore, live, { mode: 0o600 });
  return restore;
}

/**
 * GitHub holds exactly `body`: record it as ours (state, the published facts
 * the next "since the last publish" compares with, a copy) and clear the
 * stale mark, then print the one RESULT line.
 */
function recordPublished(c: Ctx, state: PrState | null, body: string, factsHead: string, stale: string | null, fields: string[], notes: string[] = []): number {
  const { d } = c;
  writeState(c.stateDir, { ...(state ?? freshState(c.pr)), lastPublishedBodySha256: sha256(body), bodyStaleSince: null });
  const block = body.match(FACTS_BLOCK_RE)?.[0] ?? '';
  const published: PublishedFacts = {
    v: 1, at: d.now().toISOString(), head: factsHead, patchId: /patch-id `([0-9a-f]{12})`/.exec(block)?.[1] ?? '', bodySha256: sha256(body),
  };
  fs.writeFileSync(path.join(c.stateDir, PUBLISHED_FACTS), JSON.stringify(published, null, 2) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(c.stateDir, `pr-body-${today(d)}.published.md`), body, { mode: 0o600 });
  d.out(`RESULT PUBLISHED pr=${c.pr.number} sha256=${sha256(body).slice(0, 12)} head=${factsHead} ${[...fields, 'body-stale-since=none'].join(' ')} cleared-stale=${stale ? s12(stale) : 'none'}`);
  for (const n of notes) d.out(n);
  d.out('WARNING if the owner has the PR description open for editing in a browser tab, they must cancel that edit: saving it overwrites this body and its screenshot.');
  return BODY_EXIT.OK;
}

/** VERSION and CHANGELOG at the given revisions, from git objects only. */
function gitTexts(c: Ctx, revs: string[]): string[] {
  const out: string[] = [];
  for (const rev of revs) {
    for (const file of ['VERSION', 'CHANGELOG.md']) {
      const r = c.d.git(['show', `${rev}:${file}`], { cwd: c.f.cwd });
      if (r.status === 0) out.push(r.stdout);
    }
  }
  return out;
}

/** The PR head and the pinned base (fetched now), for the published versions and lint. */
function pinnedRevs(c: Ctx): string[] {
  const up = remoteForRepo(c.d.git, c.f.cwd, c.repo);
  return [c.pr.headOid, ...(up ? [pinBranch(c.d.git, c.f.cwd, up, c.pr.baseRef).sha] : [])];
}

/** This PR's commits (base..head, plus the head itself), its VERSION and the versions the base has released. */
function lintContext(c: Ctx, head: string, base: string | null): LintCtx {
  const shas = new Set([head]);
  if (base) {
    const r = c.d.git(['rev-list', `${base}..${head}`], { cwd: c.f.cwd });
    if (r.status === 0) for (const s of r.stdout.split('\n').filter(Boolean)) shas.add(s);
  }
  const v = c.d.git(['show', `${head}:VERSION`], { cwd: c.f.cwd });
  return { shas: [...shas], prNumber: c.pr.number, released: base ? publishedVersions(gitTexts(c, [base])) : [], version: v.status === 0 ? v.stdout.trim() : undefined };
}

// ── check ───────────────────────────────────────────────────────────────────

/**
 * The PR author's login. The template's box 1 exempts a PR whose author is
 * @garrytan; who runs the check does not matter (garrytan checking an
 * external contributor's PR was told no screenshot was required).
 */
function prAuthor(c: Ctx): string {
  const r = c.d.gh(['pr', 'view', String(c.pr.number), '--repo', c.repo, '--json', 'author']);
  if (r.status !== 0) throw new PrContextError(`could not read PR #${c.pr.number}'s author: ${(r.error ?? r.stderr).trim().split('\n').at(-1)}`, 1);
  try {
    const login = (JSON.parse(r.stdout) as { author?: { login?: unknown } }).author?.login;
    if (typeof login === 'string' && login) return login;
  } catch { /* reported below */ }
  throw new PrContextError(`gh pr view returned no author login for PR #${c.pr.number}`, 1);
}

async function cmdCheck(c: Ctx): Promise<number> {
  const { d } = c;
  if (prAuthor(c) === 'garrytan') {
    d.out('RESULT EXEMPT the PR author is the repo owner; no liveness screenshot is required');
    return BODY_EXIT.OK;
  }
  const live = livenessOf(liveBody(c));
  const statuses: string[] = [];
  let reachable = true;
  for (const url of live.attached) {
    const code = await receiptedAssetGet(d, url);
    statuses.push(`${url} -> ${code ?? 'no answer'}`);
    if (code !== 200) reachable = false;
  }
  const ok = live.attached.length > 0 && live.ticked && !live.placeholder && reachable;
  d.out(`RESULT ${ok ? 'ATTACHED' : 'PENDING'} attachments=${live.attached.length} box1=${live.ticked ? 'ticked' : 'unticked'} placeholder=${live.placeholder ? 'present' : 'gone'} reachable=${reachable ? 'yes' : 'no'} ${staleField(c)}`);
  for (const s of statuses) d.out(`ASSET ${s}`);
  if (!ok) d.out('NEXT the owner attaches the live `GSTACK PR` screenshot in the Liveness proof section, ticks box 1 and deletes the placeholder, then runs `gh pr ready`; the agent never does');
  return ok ? BODY_EXIT.OK : BODY_EXIT.LIVENESS_PENDING;
}

/**
 * One asset GET, receipted (plan WP4: "each asset URL returns 200
 * (receipted GET)"). The request carries no body (0 bytes), but it is a
 * gstack-initiated send to github.com, so the receipt goes first and the
 * status after, fail-open as receiptedSend is: a ledger that cannot be
 * written warns on stderr and the GET still runs. The URL is not recorded,
 * only the host and the payload class.
 */
async function receiptedAssetGet(d: BodyDeps, url: string): Promise<number | null> {
  let receipt: string | null = null;
  try {
    receipt = writeReceipt({ sink: 'pr-prep', host: 'github.com', payloadClass: 'pr-asset-get', bytes: 0, sha256: null, consent: 'user ran /pr-prep', env: d.env }).id;
  } catch (error) {
    process.stderr.write(`gstack: egress receipt could not be written for pr-prep (${(error as Error).message}); sending anyway (fail-open)\n`);
  }
  const code = await d.http(url);
  if (receipt) {
    try {
      writeOutcome({ receipt, status: code === null ? 'no answer' : String(code), env: d.env });
    } catch { /* the outcome is best-effort bookkeeping; the receipt is the invariant */ }
  }
  return code;
}

// ── main ────────────────────────────────────────────────────────────────────

export async function bodyMain(argv: string[], deps: Partial<BodyDeps> = {}): Promise<number> {
  const d = { ...realDeps(), ...deps };
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) {
    d.out(BODY_USAGE);
    return argv.length ? 0 : BODY_EXIT.USAGE;
  }
  let c: Ctx | null = null;
  try {
    const f = parseBodyArgs(argv);
    if (!['facts', 'render', 'publish', 'check'].includes(f.sub)) throw new PrContextError(`unknown subcommand ${JSON.stringify(f.sub)}`, 2);
    c = resolveCtx(d, f);
    if (f.sub === 'facts') return cmdFacts(c);
    if (f.sub === 'render') return cmdRender(c);
    if (f.sub === 'publish') return cmdPublish(c);
    return await cmdCheck(c);
  } catch (error) {
    // Once the PR is resolved, its error lines carry body-stale-since too.
    const out = c ? c.d.out : d.out;
    if (error instanceof PrContextError) {
      out(`RESULT ${error.code === 2 ? 'USAGE' : error.code === 30 ? 'PRECONDITION' : 'ERROR'} ${error.message}`);
      // check's 40 is a pending screenshot and nothing else.
      return argv[0] === 'check' && error.code === BODY_EXIT.LIVENESS_PENDING ? BODY_EXIT.ERROR : error.code;
    }
    out(`RESULT ERROR ${(error as Error).message}`);
    return BODY_EXIT.ERROR;
  }
}
