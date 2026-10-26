/**
 * Gated questions: every question a gstack skill puts to the user is a
 * selection made through AskUserQuestion — two to four concrete options, the
 * recommended one first — never a prose question that waits for a typed reply
 * ("OK to proceed?", "say done", "type Y").
 *
 * Tier >= 2 skills get the rule from the preamble's AskUserQuestion Format
 * block. Tier-1 skills never render that block, so resolver and runtime text
 * that reaches them has to name the tool itself; these tests pin both halves.
 * Checks are meaning-level (docs/test-value-bar.md): reword freely, keep the
 * words.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { RESOLVERS } from '../scripts/resolvers';
import { HOST_PATHS, type TemplateContext } from '../scripts/resolvers/types';
import { generateAskUserFormat } from '../scripts/resolvers/preamble/generate-ask-user-format';
import { between, expectAbsent, expectMentions, expectOrdered } from './helpers/prompt-structure';

const ROOT = join(import.meta.dir, '..');

function context(skillName: string, preambleTier: number): TemplateContext {
  return { host: 'claude', skillName, tmplPath: '', paths: HOST_PATHS.claude, preambleTier };
}

describe('preamble: every question to the user is an AskUserQuestion', () => {
  const out = generateAskUserFormat(context('test-skill', 2));

  test('binds every ask, offer and confirmation, with 2-4 options and the recommended one first', () => {
    expectMentions(out, [
      ['every question', 'askuserquestion'],
      ['ask', 'offer', 'confirm'],
      ['2-4', 'options', 'recommended', 'first'],
    ], 'AskUserQuestion Format');
  });

  test('forbids a prose question waiting for a typed reply outside the documented fallback', () => {
    expectMentions(out, [['never', 'prose', 'typed reply']], 'AskUserQuestion Format');
  });

  test('open answers keep 2-3 likely options and take the rest through Other', () => {
    expectMentions(out, [['other', 'type', 'likely']], 'AskUserQuestion Format');
  });

  test('changes how a question is asked, never whether', () => {
    expectMentions(out, [['how', 'never whether']], 'AskUserQuestion Format');
  });
});

describe('tier-1 resolver text names AskUserQuestion itself', () => {
  const setupAsk = () => between(RESOLVERS.BROWSE_SETUP(context('browse', 1)), 'If `NEEDS_SETUP`', '2. Run');
  const fallbackAsk = () => between(RESOLVERS.BROWSE_FALLBACK(context('browse', 1)), 'If `NEEDS_SETUP`:', 'never substitute');
  const aside = () => RESOLVERS.ASIDE_SETUP(context('scrape', 1));

  test('BROWSE_SETUP asks the one-time build through AskUserQuestion', () => {
    expectMentions(setupAsk(), [['askuserquestion', 'build']], 'BROWSE_SETUP');
  });

  test('BROWSE_SETUP puts the recommended build first, then STOPs', () => {
    expectOrdered(setupAsk(), ['(recommended)', 'Skip the browser', 'STOP'], 'BROWSE_SETUP');
  });

  test('BROWSE_SETUP no longer asks "OK to proceed?" in prose', () => {
    expectAbsent(setupAsk(), ['OK to proceed?'], 'BROWSE_SETUP');
  });

  test('BROWSE_FALLBACK for a non-QA browsing skill asks the build through AskUserQuestion', () => {
    expectMentions(fallbackAsk(), [['askuserquestion', 'build']], 'BROWSE_FALLBACK');
  });

  test('BROWSE_FALLBACK puts the recommended build first and asks before ./setup', () => {
    expectOrdered(fallbackAsk(), ['(recommended)', 'Skip the browser', 'cd <SKILL_DIR> && ./setup'], 'BROWSE_FALLBACK');
  });

  test('BROWSE_FALLBACK no longer asks "OK to proceed?" in prose', () => {
    expectAbsent(fallbackAsk(), ['OK to proceed?'], 'BROWSE_FALLBACK');
  });

  test('ASIDE_SETUP asks to open Aside through AskUserQuestion', () => {
    const notRunning = between(aside(), '2. `ASIDE_NOT_RUNNING`', '3. `READY`');
    expectMentions(notRunning, [['askuserquestion', 'aside']], 'ASIDE_NOT_RUNNING');
  });

  test('ASIDE_SETUP asks about a sign-in wall through AskUserQuestion, not "tell me you\'re done"', () => {
    const signIn = between(aside(), '4. **Credentials never pass through you.**', '5. **');
    expectMentions(signIn, [['askuserquestion', 'sign']], 'sign-in wall');
    expectAbsent(signIn, ["tell me you're done"], 'sign-in wall');
  });

  for (const block of ['writing-style-migration', 'lake-intro', 'proactive-prompt']) {
    test(`gstack-skill-start ${block}, emitted at every tier, names AskUserQuestion`, () => {
      const src = readFileSync(join(ROOT, 'bin', 'gstack-skill-start'), 'utf-8');
      const body = between(src, `_emit_block ${block} <<EOI`, '\nEOI');
      expectMentions(body, [['askuserquestion']], block);
    });
  }
});
