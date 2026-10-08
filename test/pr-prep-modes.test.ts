/**
 * /pr-prep's mode contract. Structure and safety lines only (test value
 * bar): the dispatch the model follows, the write-safety rules every mode
 * inherits, each mode's helper calls, the one-way doors /plan-tune must
 * never auto-decide, and the frontmatter that lets /ship Step 1.5 invoke
 * the audit through the Skill tool.
 */
import { describe, test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { between, expectTokens, expectAbsent, expectOrdered, expectMentions } from './helpers/prompt-structure';
import { getQuestion } from '../scripts/question-registry';

const ROOT = path.resolve(import.meta.dir, '..');
const SKILL = fs.readFileSync(path.join(ROOT, 'pr-prep', 'SKILL.md'), 'utf8');
const TMPL = fs.readFileSync(path.join(ROOT, 'pr-prep', 'SKILL.md.tmpl'), 'utf8');
const section = (id: string) => fs.readFileSync(path.join(ROOT, 'pr-prep', 'sections', `${id}.md`), 'utf8');
const MODES = ['open', 'sync', 'body', 'watch', 'ci', 'liveness'];

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
    expectMentions(dispatch, [['ARGUMENTS', 'first word'], ['ship', 'always', 'audit']], 'Detect command');
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

  test('the screenshot and ready-for-review stay with the owner', () => {
    for (const mode of ['open', 'liveness']) expectMentions(section(mode), [['never', 'gh pr ready']], `${mode} section`);
    expectMentions(section('liveness'), [['never', 'attach']], 'liveness section');
  });

  test('a P0 stops every write and only the owner acknowledges it', () => {
    expectMentions(section('watch'), [['Stop', 'sync', 'publish'], ['Never', 'ack', 'owner']], 'watch section');
  });

  test('sync merges, never rebases, and stops on a code conflict', () => {
    expectMentions(section('sync'), [['never', 'rebase'], ['code', 'conflict', 'STOP']], 'sync section');
  });
});

describe('audit changes', () => {
  test('Step 5b writes the report with the Write tool and stamps it with the helper, no heredoc', () => {
    const s5b = between(SKILL, '## Step 5b: Write the machine report', '## Step 6:');
    expectTokens(s5b, ['Write tool', 'gstack-pr-prep-commits stamp'], 'Step 5b');
    expectAbsent(s5b, ['<<\''], 'Step 5b');
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
});
