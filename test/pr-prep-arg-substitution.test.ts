/**
 * /pr-prep's shell blocks must survive Claude Code's skill-argument
 * substitution. Invoked with args `--repo garrytan/gstack --base main
 * (branch ...)` on 2026-09-27, the Step 3 fetch helper arrived rewritten:
 * `local out="$_PP/$1.json"` as `$_PP/garrytan/gstack.json`, `gh "$2" list`
 * as `gh "--base" list`, `--state "$3"` as `--state "main"`. Run as loaded,
 * every fetch fails. The measured rules live in
 * test/helpers/claude-arg-substitution.ts.
 *
 * Free and deterministic — static text checks, no shell, no model.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import {
  fencedBlocks,
  findSubstitutableForms,
  frontmatterArgumentNames,
  isShellBlock,
  substituteSkillArgs,
} from './helpers/claude-arg-substitution';

const ROOT = path.resolve(import.meta.dir, '..');
const SKILL_MD = fs.readFileSync(path.join(ROOT, 'pr-prep', 'SKILL.md'), 'utf-8');
const SKILL_TMPL = fs.readFileSync(path.join(ROOT, 'pr-prep', 'SKILL.md.tmpl'), 'utf-8');

// The incident's args, as Claude Code parsed them: the `(...)` group is
// dropped, so four arguments reach the substitution.
const INCIDENT_RAW = '--repo garrytan/gstack --base main (branch fix/claude-code-fixture-holder-leak)';
const INCIDENT_ARGS = ['--repo', 'garrytan/gstack', '--base', 'main'];

const report = (hits: { line: number; form: string; lineText: string }[], offset = 0) =>
  hits.map((h) => `  line ${h.line + offset}: ${h.form}  in  ${h.lineText.trim()}`).join('\n');

describe('substitution port matches what Claude Code delivered', () => {
  test('reproduces the probe skill output (2.1.274 and 2.1.281, args ZERO ONE TWO THREE)', () => {
    const args = ['ZERO', 'ONE', 'TWO', 'THREE'];
    const cases: [string, string][] = [
      ['d0=[$0] d1=[$1] d3=[$3] d4=[$4] d10=[$10]', 'd0=[ZERO] d1=[ONE] d3=[THREE] d4=[$4] d10=[$10]'],
      ['brace1=[${1}] at=[$@] qat=["$@"] star=[$*] hash=[$#]', 'brace1=[${1}] at=[$@] qat=["$@"] star=[$*] hash=[$#]'],
      [
        'ARGS=[$ARGUMENTS] b=[${ARGUMENTS}] A1=[$ARGUMENTS[1]] A9=[$ARGUMENTS[9]] low=[$arguments] X=[$ARGUMENTSX]',
        'ARGS=[ZERO ONE TWO THREE] b=[${ARGUMENTS}] A1=[ONE] A9=[$ARGUMENTS[9]] low=[$arguments] X=[ZERO ONE TWO THREEX]',
      ],
      [
        'esc=[\\$1] dd=[$$1] word=[$1abc] dot=[$1.json] und=[$_1] dq=["$1"] arith=[$((1 + $2))]',
        'esc=[$1] dd=[$ONE] word=[$1abc] dot=[ONE.json] und=[$_1] dq=["ONE"] arith=[$((1 + TWO))]',
      ],
      ['escHOME=[\\$HOME] escbrace=[\\${1}] dbl=[\\\\$1]', 'escHOME=[\\$HOME] escbrace=[\\${1}] dbl=[\\\\ONE]'],
    ];
    for (const [input, expected] of cases) expect(substituteSkillArgs(input, args)).toBe(expected);
  });

  test('reproduces the incident: the pre-fix fetch helper arrives corrupted', () => {
    const preFix = [
      '  local out="$_PP/$1.json"',
      '  if gh "$2" list --repo "$REPO" --state "$3" --search "$QUERY" \\',
      '       --limit "$4" --json "$5" > "$out" 2> "$out.err" \\',
    ].join('\n');
    // Byte-for-byte what the 2026-09-27 session received.
    expect(substituteSkillArgs(preFix, INCIDENT_ARGS, INCIDENT_RAW)).toBe(
      [
        '  local out="$_PP/garrytan/gstack.json"',
        '  if gh "--base" list --repo "$REPO" --state "main" --search "$QUERY" \\',
        '       --limit "$4" --json "$5" > "$out" 2> "$out.err" \\',
      ].join('\n'),
    );
  });

  test('detector flags every rewritten form and spares the rest', () => {
    const rewritten = ['$0', '$1', '$10', '$1.json', '$1/', 'x$1', '$$1', '\\$1', '$ARGUMENTS', '$ARGUMENTS[2]', '$ARGUMENTSX'];
    const spared = ['${1}', '$@', '"$@"', '$*', '$#', '${ARGUMENTS}', '$1abc', '$1_x', '$arguments', '$_PP_STEM', '$((_PP_FAILED + 1))'];
    for (const s of rewritten) expect(findSubstitutableForms(s)).not.toHaveLength(0);
    for (const s of spared) expect(findSubstitutableForms(s)).toHaveLength(0);
  });

  test('frontmatter `arguments:` names become substitutable forms', () => {
    const md = '---\nname: x\narguments: [repo, base]\n---\n';
    const names = frontmatterArgumentNames(md);
    expect(names).toEqual(['repo', 'base']);
    expect(findSubstitutableForms('gh --repo "$repo"', names)).toHaveLength(1);
    expect(findSubstitutableForms('"$repository" "$repo_x" "$repo[0]"', names)).toHaveLength(0);
    expect(frontmatterArgumentNames('---\nname: x\narguments:\n  - repo\n  - "base"\n---\n')).toEqual(['repo', 'base']);
  });
});

describe('pr-prep carries no substitutable form', () => {
  const argNames = frontmatterArgumentNames(SKILL_MD);
  const shellBlocks = fencedBlocks(SKILL_MD).filter(isShellBlock);

  test('no shell block in pr-prep/SKILL.md contains a form Claude Code rewrites', () => {
    expect(shellBlocks.length).toBeGreaterThan(5);
    const found = shellBlocks.flatMap((b) =>
      findSubstitutableForms(b.body, argNames).map((h) => ({ ...h, line: h.line + b.startLine })),
    );
    if (found.length) {
      throw new Error(
        `pr-prep/SKILL.md shell blocks use positional parameters that Claude Code rewrites when the skill ` +
          `is invoked with args. Pass values through named variables instead:\n${report(found)}`,
      );
    }
  });

  test("the template's own text (prose included) carries none either", () => {
    // Substitution covers prose too. Only pr-prep's template is checked here:
    // the shared preamble is audited across skills separately.
    const found = findSubstitutableForms(SKILL_TMPL, frontmatterArgumentNames(SKILL_TMPL));
    if (found.length) throw new Error(`pr-prep/SKILL.md.tmpl:\n${report(found)}`);
  });

  test('the Step 3 fetch block is unchanged by the incident args, or by twelve args', () => {
    const step3 = SKILL_MD.slice(SKILL_MD.indexOf('## Step 3:'));
    const block = step3.match(/```bash\n([\s\S]*?)\n```/)?.[1];
    expect(block).toBeDefined();
    expect(block).toContain('_pp_fetch');
    expect(substituteSkillArgs(block!, INCIDENT_ARGS, INCIDENT_RAW)).toBe(block!);
    const many = Array.from({ length: 12 }, (_, i) => `arg${i}`);
    expect(substituteSkillArgs(block!, many)).toBe(block!);
  });

  test('every _pp_fetch call sets all five named inputs on its own line', () => {
    // `bash --posix` keeps prefix assignments after the call, so a call that
    // skipped one would silently reuse the previous call's value.
    const inputs = ['_PP_STEM', '_PP_KIND', '_PP_STATE', '_PP_LIMIT', '_PP_FIELDS'];
    const calls = SKILL_MD.split('\n').filter((l) => !l.trimStart().startsWith('#') && /(^|\s)_pp_fetch\s*$/.test(l));
    expect(calls).toHaveLength(4);
    for (const call of calls) {
      for (const v of inputs) expect(call).toMatch(new RegExp(`(^|\\s)${v}=\\S+`));
    }
  });
});
