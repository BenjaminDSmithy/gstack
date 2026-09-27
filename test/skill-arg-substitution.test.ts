/**
 * Skill bodies must survive Claude Code's argument substitution (#2896).
 *
 * When a skill is invoked with arguments (`/ship bump patch`, or a Skill-tool
 * call with `args`), Claude Code rewrites `$<digits>`, `$ARGUMENTS` and any
 * declared `$name` across the WHOLE SKILL.md body before the model reads it,
 * fenced code included. /ship's idempotency check read the remote sha with
 * `awk '{print $1}'` and arrived as `awk '{print patch}'`, so an
 * already-pushed branch reported PUSH_NEEDED. The measured rules and a port
 * of the substitution live in test/helpers/claude-arg-substitution.ts.
 *
 * Scope: every repository SKILL.md except test fixtures and openclaw/ (native
 * OpenClaw skills; setup never installs them for Claude Code). `sections/*.md`
 * files load through the Read tool, which substitution never touches.
 *
 * Free and deterministic: static text checks, no shell, no model.
 */
import { describe, test, expect } from 'bun:test';
import { execFileSync } from 'child_process';
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

function skillFiles(): string[] {
  // Tracked plus new, unignored files, so a skill added in this change is
  // covered before it is committed.
  return execFileSync('git', [
    'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'SKILL.md', '**/SKILL.md',
  ], { cwd: ROOT, encoding: 'utf-8', timeout: 30_000 })
    .split('\0')
    .filter(Boolean)
    .filter((f) => !f.startsWith('test/') && !f.startsWith('openclaw/'));
}

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

  test("reproduces /ship's idempotency line as delivered (2.1.274 and 2.1.281)", () => {
    const line = (field: string) => `REMOTE=$(printf '%s\\n' "$REMOTE_REF" | awk '{print ${field}}')`;
    // A probe skill holding this line, invoked as `/shipprobe bump patch`,
    // `/shipprobe --base main` and `/shipprobe x "it's"`: the arguments as
    // Claude Code parsed them, each paired with the text it delivered.
    const cases: [string[], string][] = [
      [['bump', 'patch'], line('patch')],
      [['--base', 'main'], line('main')],
      [['x', "it's"], line("it's")],
    ];
    for (const [args, delivered] of cases) {
      expect(substituteSkillArgs(line('$1'), args)).toBe(delivered);
      expect(substituteSkillArgs(line('$(1)'), args)).toBe(line('$(1)'));
    }
  });

  test('detector flags every rewritten form and spares the rest', () => {
    const rewritten = ['$0', '$1', '$10', '$1.json', '$1/', 'x$1', '$$1', '\\$1', '$ARGUMENTS', '$ARGUMENTS[2]', '$ARGUMENTSX'];
    const spared = ['${1}', '$@', '"$@"', '$*', '$#', '${ARGUMENTS}', '$1abc', '$1_x', '$arguments', '$(1)', '$((COUNT + 1))'];
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

describe('repository skills carry no substitutable form', () => {
  const files = skillFiles();

  test('the scan sees the skill tree', () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain('SKILL.md');
    expect(files).toContain('ship/SKILL.md');
  });

  test('no SKILL.md contains a form Claude Code rewrites, in prose or code', () => {
    const found = files.flatMap((file) => {
      const md = fs.readFileSync(path.join(ROOT, file), 'utf-8');
      return findSubstitutableForms(md, frontmatterArgumentNames(md)).map(
        (h) => `  ${file}:${h.line}: ${h.form}  in  ${h.lineText.trim()}`,
      );
    });
    if (found.length) {
      throw new Error(
        'These SKILL.md lines are rewritten with the invocation\'s arguments when the skill is invoked with args. ' +
          'Fix the .tmpl source: use a named variable, awk `$(N)`, or shell `"${N}"`, then run `bun run gen:skill-docs`:\n' +
          found.join('\n'),
      );
    }
  });

  test("/ship's idempotency block is unchanged by any argument shape", () => {
    const md = fs.readFileSync(path.join(ROOT, 'ship', 'SKILL.md'), 'utf-8');
    const block = fencedBlocks(md).find((b) => isShellBlock(b) && b.body.includes('REMOTE_REF'));
    expect(block).toBeDefined();
    const argSets = [['bump', 'patch'], ['--base', 'main'], ['x', "it's"], Array.from({ length: 12 }, (_, i) => `arg${i}`)];
    for (const args of argSets) expect(substituteSkillArgs(block!.body, args)).toBe(block!.body);
  });
});
