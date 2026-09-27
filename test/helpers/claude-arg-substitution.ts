/**
 * Claude Code's skill-argument substitution, and a detector for the forms it
 * rewrites.
 *
 * When a skill is invoked with arguments (`/skill a b c`, or a Skill-tool call
 * with `args`), Claude Code rewrites the WHOLE skill body before the agent
 * reads it: prose and fenced code alike. Measured 2026-09-27 on Claude Code
 * 2.1.274 (CLI) and 2.1.281 (Desktop) with a throwaway skill under a scratch
 * CLAUDE_CONFIG_DIR, and read back from the substitution function in the
 * 2.1.281 binary:
 *
 *   rewritten                        left alone
 *   ---------------------------      -----------------------------------
 *   $0 $1 ... $10 ... (0-indexed,    ${1} ${10} $@ "$@" $* $# ${ARGUMENTS}
 *     digits not followed by a       $1abc $1_x (digits followed by a word
 *     word char: $1.json, $1/,         character)
 *     $1-x, x$1, $$1 all rewrite)    an index past the last argument
 *   $ARGUMENTS[N]                    $arguments
 *   $ARGUMENTS as a bare substring   \$HOME (backslash kept: not a form)
 *     ($ARGUMENTSX -> "<args>X")
 *   $<name> for each name in the
 *     frontmatter `arguments:` key
 *
 * Arguments are shell-parsed: quotes group words, a `(...)` group is dropped,
 * and `;` ends the list. A backslash before a rewritten form (`\$1`) makes it
 * a literal `$1`, but only Claude Code strips that backslash; every other host
 * would hand the agent `\$1`, so an escape is not a fix for a shared skill.
 */

/** Sentinels Claude Code uses; kept byte-identical so the port matches. */
const ESCAPED_DOLLAR = '￿';
const VALUE_WRAP = '￾';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Port of Claude Code 2.1.281's substitution (without the trailing
 * "ARGUMENTS: <raw>" line it appends when nothing was substituted).
 * `args` is the already-parsed argument list; `raw` is the original string
 * that `$ARGUMENTS` expands to.
 */
export function substituteSkillArgs(body: string, args: string[], raw: string = args.join(' '), argNames: string[] = []): string {
  const scrub = (s: string) => s.replaceAll(ESCAPED_DOLLAR, '�').replaceAll(VALUE_WRAP, '�');
  const value = (v: string | undefined) => VALUE_WRAP + scrub(v ?? '').replaceAll('$', ESCAPED_DOLLAR) + VALUE_WRAP;
  const names = argNames
    .map((name, i) => ({ name, i }))
    .filter((n) => n.name)
    .sort((a, b) => b.name.length - a.name.length);
  const escapable = ['\\d', 'ARGUMENTS', ...names.map((n) => `${escapeRegExp(n.name)}(?![\\[\\w])`)].join('|');

  let out = scrub(body);
  out = out.replace(new RegExp(`(?<!\\\\)\\\\\\$(?=${escapable})`, 'g'), ESCAPED_DOLLAR);
  for (const { name, i } of names) {
    out = out.replace(new RegExp(`\\$${escapeRegExp(name)}(?![\\[\\w])`, 'g'), () => value(args[i]));
  }
  out = out.replace(/\$ARGUMENTS\[(\d+)\]/g, (m, n) =>
    args[Number(n)] === undefined ? ESCAPED_DOLLAR + m.slice(1) : value(args[Number(n)]),
  );
  out = out.replace(/\$(\d+)(?!\w)/g, (m, n) => (args[Number(n)] === undefined ? m : value(args[Number(n)])));
  out = out.replaceAll('$ARGUMENTS', () => value(raw));
  return out.replaceAll(ESCAPED_DOLLAR, '$').replaceAll(VALUE_WRAP, '');
}

export interface SubstitutableForm {
  /** 1-based line within the scanned text. */
  line: number;
  form: string;
  lineText: string;
}

/**
 * Every form Claude Code would rewrite, whatever the argument count. An
 * escaped form (`\$1`) is reported too: the escape only works in Claude Code.
 */
export function findSubstitutableForms(text: string, argNames: string[] = []): SubstitutableForm[] {
  const patterns = [
    /\$ARGUMENTS/g,
    /\$\d+(?!\w)/g,
    ...argNames.filter(Boolean).map((n) => new RegExp(`\\$${escapeRegExp(n)}(?![\\[\\w])`, 'g')),
  ];
  const hits: SubstitutableForm[] = [];
  text.split('\n').forEach((lineText, i) => {
    for (const re of patterns) {
      for (const m of lineText.matchAll(re)) hits.push({ line: i + 1, form: m[0], lineText });
    }
  });
  return hits;
}

export interface FencedBlock {
  /** Lowercased first word of the info string ('' for a bare fence). */
  lang: string;
  body: string;
  /** 1-based line of the opening fence within the document. */
  startLine: number;
}

/** Fenced code blocks (``` or ~~~, any length >= 3) in a Markdown document. */
export function fencedBlocks(markdown: string): FencedBlock[] {
  const lines = markdown.split('\n');
  const blocks: FencedBlock[] = [];
  let open: { fence: string; lang: string; start: number; body: string[] } | null = null;
  lines.forEach((line, i) => {
    if (!open) {
      const m = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)/);
      if (m) open = { fence: m[1], lang: m[2].toLowerCase(), start: i + 1, body: [] };
      return;
    }
    const close = line.match(/^\s*(`{3,}|~{3,})\s*$/);
    if (close && close[1][0] === open.fence[0] && close[1].length >= open.fence.length) {
      blocks.push({ lang: open.lang, body: open.body.join('\n'), startLine: open.start });
      open = null;
      return;
    }
    open.body.push(line);
  });
  return blocks;
}

const SHELL_LANGS = new Set(['bash', 'sh', 'zsh', 'shell', 'console']);

export function isShellBlock(block: FencedBlock): boolean {
  return SHELL_LANGS.has(block.lang);
}

/** Names from a skill's frontmatter `arguments:` key (string or list). */
export function frontmatterArgumentNames(markdown: string): string[] {
  const fm = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) return [];
  const lines = fm[1].split('\n');
  const at = lines.findIndex((l) => /^arguments:/.test(l));
  if (at < 0) return [];
  const inline = lines[at].replace(/^arguments:\s*/, '').trim();
  const keep = (s: string) => s !== '' && !/^\d+$/.test(s);
  if (inline.startsWith('[')) {
    return inline.replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(keep);
  }
  if (inline) return inline.split(/\s+/).filter(keep);
  const names: string[] = [];
  for (const l of lines.slice(at + 1)) {
    const item = l.match(/^\s+-\s+(.*)$/);
    if (!item) break;
    names.push(item[1].trim().replace(/^['"]|['"]$/g, ''));
  }
  return names.filter(keep);
}
