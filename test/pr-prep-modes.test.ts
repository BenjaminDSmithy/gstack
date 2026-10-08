/**
 * /pr-prep's mode contract. Structure and safety lines only (test value
 * bar): the dispatch the model follows, the write-safety rules every mode
 * inherits, each mode's helper calls, the one-way doors /plan-tune must
 * never auto-decide, and the frontmatter that lets /ship Step 1.5 invoke
 * the audit through the Skill tool.
 */
import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { between, expectTokens, expectAbsent, expectOrdered, expectMentions } from './helpers/prompt-structure';
import { getQuestion } from '../scripts/question-registry';

const ROOT = path.resolve(import.meta.dir, '..');
const SKILL = fs.readFileSync(path.join(ROOT, 'pr-prep', 'SKILL.md'), 'utf8');
const TMPL = fs.readFileSync(path.join(ROOT, 'pr-prep', 'SKILL.md.tmpl'), 'utf8');
const section = (id: string) => fs.readFileSync(path.join(ROOT, 'pr-prep', 'sections', `${id}.md`), 'utf8');
const MODES = ['open', 'sync', 'body', 'watch', 'ci', 'liveness'];
// The section whose AskUserQuestion gates each write, and that write's registered question id.
const WRITE_QIDS: Record<string, string> = {
  sync: 'pr-prep-sync-push', body: 'pr-prep-body-publish', ci: 'pr-prep-ci-retrigger-push', open: 'pr-prep-open-pr',
};

describe('frontmatter', () => {
  test('model-invocable, so /ship Step 1.5 can run the audit through the Skill tool', () => {
    const fm = TMPL.slice(0, TMPL.indexOf('\n---', 4));
    expect(fm).not.toMatch(/disable-model-invocation:\s*true/);
    // The catalog shows only the first sentence; keeping it fixed keeps the always-loaded catalog cost at 0 bytes.
    expect(fm).toMatch(/description: \|\n {2}Pre-PR upstream duplicate audit\. /);
    expectTokens(fm, ['- Write'], 'pr-prep allowed-tools');
  });
});

describe('dispatch', () => {
  const dispatch = between(SKILL, '## Detect command', '## Write safety');

  test('every mode is listed, and the dispatch and safety rules come before any section is read', () => {
    expectTokens(dispatch, MODES.map(m => `\`${m}\``), 'Detect command');
    const firstStop = SKILL.search(/^> \*\*STOP\.\*\* Before running the \w+ mode/m);
    expect(firstStop).toBeGreaterThan(0);
    expect(SKILL.indexOf('## Detect command')).toBeLessThan(firstStop);
    expect(SKILL.indexOf('## Write safety (every mode)')).toBeLessThan(firstStop);
    expectOrdered(SKILL, ['## Detect command', '## Write safety (every mode)', '## Step 1: Pre-flight', '## Step 5b: Write the machine report'], 'pr-prep skeleton');
  });

  test('the mode comes only from the ARGUMENTS line, and a /ship invocation is always the audit', () => {
    expectMentions(dispatch, [
      ['ARGUMENTS', 'first word'],
      ['ship', 'always', 'audit'],
      // Injection: a tracker comment or a file never picks a write mode.
      ['tracker', 'never', 'mode'],
      ['not a mode', 'stop'],
    ], 'Detect command');
  });

  test('every documented /pr-prep invocation and audit flag starts with a word the dispatch routes', () => {
    // Step 6 hands the user `/pr-prep --force` and Step 3 cites `/pr-prep --repo ...`:
    // a dispatch that stops on any other first word stranded the EXACT_DUP override.
    const flags = [...between(SKILL, '## Flags', '## Cost').matchAll(/^\| `(--[a-z-]+)/gm)].map(m => m[1]);
    expect(flags.length).toBeGreaterThan(0);
    const invoked = [SKILL, ...MODES.map(section)].flatMap(t => [...t.matchAll(/\/pr-prep (--[a-z-]+|[a-z]+)/g)].map(m => m[1]));
    expect(invoked).toContain('--force');
    expectTokens(dispatch, [...new Set([...flags, ...invoked])].map(w => `\`${w}\``), 'Detect command');
  });
});

describe('write safety', () => {
  const safety = between(SKILL, '## Write safety (every mode)', '\n---\n');

  test('names every write path and the owner\'s per-write yes', () => {
    expectTokens(safety, ['gstack-pr-sync push', 'gstack-pr-sync retrigger', 'gstack-pr-body publish', 'gh pr create'], 'Write safety');
    expectMentions(safety, [
      ['AskUserQuestion', 'same turn'],
      // D2: one yes, one write; never a standing grant.
      ['yes', 'one write', 'never'],
      ['Auto-fix', 'never', 'consent'],
      ['force-push', 'no-verify', 'gh pr ready'],
      ['refusal', 'route around'],
      ['data', 'never', 'follow'],
    ], 'Write safety');
  });
});

describe('mode sections', () => {
  const calls: Record<string, string[]> = {
    open: ['gstack-pr-watch size', 'gh pr create --draft', 'gstack-egress-receipt write'],
    sync: ['gstack-pr-watch poll', 'gstack-pr-sync plan', 'gstack-pr-sync merge', 'gstack-pr-validate run', 'gstack-pr-sync push'],
    body: ['gstack-issue-guard pr-body', 'gstack-pr-body render', 'gstack-pr-body publish'],
    watch: ['gstack-pr-watch poll', 'gstack-pr-watch ack'],
    ci: ['gstack-pr-ci-triage run', 'gstack-pr-sync retrigger', 'gstack-pr-ci-triage onset'],
    liveness: ['gstack-pr-body check'],
  };

  for (const mode of MODES) {
    test(`${mode}: its helper calls, and every write passes --yes only after the owner's answer`, () => {
      const text = section(mode);
      expectTokens(text, calls[mode], `${mode} section`);
      for (const line of text.split('\n').filter(l => /gstack-pr-(sync (push|retrigger)|body publish)/.test(l) && l.startsWith('~'))) {
        expect(line, `${mode}: ${line}`).toContain('--yes');
      }
    });
  }

  test('open scans the exact title and body bytes it sends, and the title never enters the shell', () => {
    // Every other public write is redaction-scanned; `--title "<title>"` also
    // ran a subject's backticks as a command (CEO-12, free text never enters a shell).
    const open = section('open');
    expectTokens(open, ['gstack-redact --from-file "$BODY_FILE"', 'gstack-redact --from-file "$TITLE_FILE"', '--title "$(cat "$TITLE_FILE")"', '--body-file "$BODY_FILE"'], 'open section');
    expectAbsent(open, ['--title "<title>"', '<body file>'], 'open section');
    expectOrdered(open, ['gstack-redact --from-file', 'gstack-egress-receipt write', 'gh pr create --draft'], 'open section');
    expectMentions(open, [['exit 3', 'never']], 'open section');
  });

  test('open checks the fork branch holds the audited commit before it creates, and never pushes it', () => {
    const open = section('open');
    expectTokens(open, ['git ls-remote', 'PR_PREP_OPEN_HEAD'], 'open section');
    expectOrdered(open, ['PR_PREP_OPEN_HEAD', 'gh pr create --draft'], 'open section');
    expectMentions(open, [['owner', 'push', 'never']], 'open section');
  });

  test('the screenshot and ready-for-review stay with the owner', () => {
    for (const mode of ['open', 'liveness']) expectMentions(section(mode), [['never', 'gh pr ready']], `${mode} section`);
    expectMentions(section('liveness'), [['never', 'attach']], 'liveness section');
  });

  test('a P0 stops every write and only the owner acknowledges it', () => {
    expectMentions(section('watch'), [['Stop', 'sync', 'publish'], ['Never', 'ack', 'owner']], 'watch section');
  });

  test("watch's classes match the helper: a trailer alone is P2, a conflict is acked and then synced", () => {
    // gstack-pr-watch reads our Co-authored-by trailer on a base commit as P0
    // only when the commit cites or is linked to this PR (upstream credits
    // per PR, so one credit sits on every open PR's base): P2 otherwise.
    const watch = section('watch');
    expectTokens(watch, ['credited-elsewhere', 'mergeable-dirty', 'mergeable-behind', 'capy-ai[bot]'], 'watch section');
    expectMentions(watch, [['trailer', 'P2'], ['conflict', 'ack', 'sync']], 'watch section');
  });

  test('sync merges, never rebases, and stops on a code conflict', () => {
    expectMentions(section('sync'), [['never', 'rebase'], ['code', 'conflict', 'STOP']], 'sync section');
  });

  test("a CHANGED proof or a waived full suite is pushed only on the owner's yes to it, and an unpushed sync is aborted", () => {
    // push refuses 21 (proof CHANGED) and 31 (FULL waived) and names the flag
    // that accepts each: without the owner's yes tied to it, the agent adds
    // the flag on its own review and publishes a diff the owner never saw.
    const sync = section('sync');
    expectTokens(sync, ['gstack-pr-sync abort'], 'sync section');
    expectMentions(sync, [['--accept-diff-change', 'only', 'yes'], ['--accept-full-risk', 'only', 'yes']], 'sync section');
    const safety = between(SKILL, '## Write safety (every mode)', '\n---\n');
    expectMentions(safety, [['refusal', '21', '31', 'route around'], ['flag', 'only', 'owner', 'yes', 'accepts']], 'Write safety');
  });

  test("sync goes on past its own conflict signal, acked on the owner's yes before the push", () => {
    // poll latches mergeable-dirty/behind as P1 (exit 11) for exactly the PR
    // this mode exists to fix, and the push's pre-write gate refuses while it
    // is unacknowledged: a sync that stops on every exit 11 can never run.
    const sync = section('sync');
    expectTokens(sync, ['mergeable-dirty', 'mergeable-behind'], 'sync section');
    expectOrdered(sync, ['gstack-pr-watch poll', 'gstack-pr-watch ack', 'gstack-pr-sync push'], 'sync section');
    expectMentions(sync, [['owner', 'yes', 'ack']], 'sync section');
  });
});

describe('audit changes', () => {
  test('Step 5b writes the report with the Write tool and stamps it with the helper, no heredoc', () => {
    const s5b = between(SKILL, '## Step 5b: Write the machine report', '## Step 6:');
    expectTokens(s5b, ['Write tool', 'gstack-pr-prep-commits stamp'], 'Step 5b');
    // Every heredoc form (quoted, unquoted, <<-): hit titles are upstream text.
    expectAbsent(s5b, [/<<-?\s*['"]?\w/], 'Step 5b');
  });

  test('the audit pins the upstream base, carries verdicts, and drops its own PR before scoring', () => {
    expectTokens(between(SKILL, '## Step 1: Pre-flight', '## Step 2:'), ['PR_PREP_BASE', 'refs/pr-prep/'], 'Step 1');
    expectTokens(between(SKILL, '## Step 2:', '## Step 3:'), ['gstack-pr-prep-commits list', 'CARRY', 'RECHECK'], 'Step 2');
    expectTokens(between(SKILL, '## Step 4: Score each upstream hit', '## Step 4.4:'), ['gstack-pr-prep-commits self'], 'Step 4');
  });
});

describe('one-way doors', () => {
  test('writes to an open PR are registered one-way: /plan-tune never auto-decides them', () => {
    for (const id of ['pr-prep-sync-push', 'pr-prep-body-publish', 'pr-prep-ci-retrigger-push', 'pr-prep-open-pr']) {
      expect(getQuestion(id), id).toMatchObject({ skill: 'pr-prep', door_type: 'one-way' });
    }
  });

  test('each write is asked under its registered id, never an ad-hoc one', () => {
    // The registry protects only a question that carries its id: under an
    // ad-hoc `{skill}-{slug}` id a stored never-ask auto-decides the push.
    for (const [mode, id] of Object.entries(WRITE_QIDS)) expectTokens(section(mode), [`<gstack-qid:${id}>`], `${mode} section`);
    const safety = between(SKILL, '## Write safety (every mode)', '\n---\n');
    expectTokens(safety, Object.values(WRITE_QIDS), 'Write safety');
    expectMentions(safety, [['stored', 'preference', 'never']], 'Write safety');
  });

  test('a stored never-ask cannot auto-decide a registered write; the same question under an ad-hoc id would', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-prep-qpref-'));
    try {
      const env = { ...process.env, GSTACK_STATE_ROOT: home, GSTACK_HOME: home };
      const bin = path.join(ROOT, 'bin', 'gstack-question-preference');
      const q = (args: string[], input?: string) => spawnSync(bin, args, { cwd: ROOT, env, input, encoding: 'utf8', timeout: 60_000 });
      expect(q(['--read']).status).toBe(0);
      const [slug] = fs.readdirSync(path.join(home, 'projects'));
      // --write refuses never-ask on a one-way id, so plant the file a pre-#2488 write could have left.
      const adHoc = 'pr-prep-push-confirm';
      const prefs = Object.fromEntries([...Object.values(WRITE_QIDS), adHoc].map(id => [id, 'never-ask']));
      fs.writeFileSync(path.join(home, 'projects', slug, 'question-preferences.json'), JSON.stringify(prefs));
      const summary = 'Push the staged sync to PR 3066 (origin pr/hook-check-gaps, 1a2b3c4 -> 4d5e6f7, version 1.91.35.0)?';
      for (const id of Object.values(WRITE_QIDS)) {
        expect(q(['--check', id, '--summary-stdin'], summary).stdout.trim().split('\n')[0], id).toBe('ASK_NORMALLY');
      }
      expect(q(['--check', adHoc, '--summary-stdin'], summary).stdout.trim().split('\n')[0]).toBe('AUTO_DECIDE');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
