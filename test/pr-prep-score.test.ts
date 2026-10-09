/**
 * Behavioral test for the /pr-prep collision scorer (bin/gstack-pr-prep-score).
 *
 * Pins the Step 4 bucketing contract from pr-prep/SKILL.md: title/file Jaccard,
 * state weighting, and the EXACT_DUP / OVERLAP / SIBLING / CLEAN precedence.
 * Pure function, deterministic, free — gate-tier.
 */
import { describe, test, expect, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { score, jaccard, type ScoreInput } from '../bin/gstack-pr-prep-score';

setDefaultTimeout(120_000);

describe('pr-prep scorer: jaccard', () => {
  test('identical sets = 1.0', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
  });
  test('disjoint sets = 0', () => {
    expect(jaccard(['a'], ['b'])).toBe(0);
  });
  test('half overlap', () => {
    // {a,b} vs {b,c}: inter=1, union=3
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 5);
  });
  test('case-insensitive, empty-safe', () => {
    expect(jaccard(['Foo'], ['foo'])).toBe(1);
    expect(jaccard([], ['a'])).toBe(0);
    expect(jaccard(undefined, ['a'])).toBe(0);
  });
});

describe('pr-prep scorer: buckets', () => {
  test('open PR with high title Jaccard -> EXACT_DUP', () => {
    const input: ScoreInput = {
      commitKeywords: ['reindex', 'cli', 'only', 'fix'],
      candidates: [{ state: 'open_pr', ref: '#913', titleKeywords: ['reindex', 'cli', 'only', 'fix'] }],
    };
    expect(score(input).bucket).toBe('EXACT_DUP');
  });

  test('open PR with high file overlap -> EXACT_DUP even on weak title', () => {
    const input: ScoreInput = {
      commitKeywords: ['unrelated', 'words'],
      changedFiles: ['src/reindex.ts', 'src/cli.ts'],
      candidates: [
        { state: 'open_pr', ref: '#913', titleKeywords: ['nothing', 'matches'], changedFiles: ['src/reindex.ts', 'src/cli.ts'] },
      ],
    };
    expect(score(input).bucket).toBe('EXACT_DUP');
  });

  test('open PR with mid score (>=0.3, <0.6) -> OVERLAP', () => {
    // titleJ {a,b,c,d} vs {a,b,e,f}: inter=2 union=6 = 0.333; openPR weight 1.0 -> 0.333
    const input: ScoreInput = {
      commitKeywords: ['a', 'b', 'c', 'd'],
      candidates: [{ state: 'open_pr', ref: '#1', titleKeywords: ['a', 'b', 'e', 'f'] }],
    };
    const r = score(input);
    expect(r.bucket).toBe('OVERLAP');
    expect(r.topScore).toBeGreaterThanOrEqual(0.3);
    expect(r.topScore).toBeLessThan(0.6);
  });

  test('three RELATED open issues -> OVERLAP even when none scores >=0.3', () => {
    // Each shares 2 tokens with a 6-token commit: Jaccard 2/7 = 0.286,
    // scored 0.286 * 0.7 = 0.2 — over the 0.15 related floor, under the 0.3
    // single-hit threshold. Three of them is the crowded-topic signal the
    // count clause exists to catch.
    const related = (ref: string) => ({
      state: 'open_issue' as const,
      ref,
      titleKeywords: ['synopsis', 'truncate', 'error'],
    });
    const input: ScoreInput = {
      commitKeywords: ['synopsis', 'truncate', 'documenttext', 'tail', 'handler', 'chat'],
      candidates: [related('#1'), related('#2'), related('#3')],
    };
    const r = score(input);
    expect(r.bucket).toBe('OVERLAP');
    expect(r.openIssueCount).toBe(3);
    expect(r.relatedOpenIssueCount).toBe(3);
    expect(r.topScore).toBeLessThan(0.3);
  });

  test('three UNRELATED open issues do NOT reach OVERLAP on count alone', () => {
    // Regression: the count clause used to count every open issue `gh`
    // full-text returned. A chore/build commit ("regenerate skill merge")
    // pulls 3+ unrelated open issues on any busy tracker and bucketed
    // OVERLAP off a topScore of 0.05, so the bucket stopped meaning anything.
    const noise = (ref: string, kw: string[]) => ({
      state: 'open_issue' as const,
      ref,
      titleKeywords: kw,
    });
    const input: ScoreInput = {
      commitKeywords: ['regenerate', 'skill', 'merge'],
      candidates: [
        noise('#2286', ['generated', 'trigger', 'vocabulary', 'frontmatter', 'router']),
        noise('#1048', ['review', 'minimal', 'diff', 'preference', 'schema']),
        noise('#349', ['support', 'custom', 'config', 'paths']),
        noise('#2595', ['windows', 'smart', 'control', 'blocks', 'browse']),
      ],
    };
    const r = score(input);
    expect(r.openIssueCount).toBe(4);
    expect(r.relatedOpenIssueCount).toBe(0);
    expect(r.bucket).not.toBe('OVERLAP');
    // Open issues with no open PR still surface as SIBLING — informational,
    // not a false all-clear.
    expect(r.bucket).toBe('SIBLING');
  });

  test('single low-score open issue, no PR -> SIBLING', () => {
    const input: ScoreInput = {
      commitKeywords: ['a', 'b'],
      candidates: [{ state: 'open_issue', ref: '#5', titleKeywords: ['zzz'] }],
    };
    expect(score(input).bucket).toBe('SIBLING');
  });

  test('merged-recently with overlap -> SIBLING', () => {
    const input: ScoreInput = {
      commitKeywords: ['a', 'b'],
      candidates: [{ state: 'merged_recent', ref: '#9', titleKeywords: ['a', 'b'] }],
    };
    expect(score(input).bucket).toBe('SIBLING');
  });

  test('only closed issues -> CLEAN', () => {
    const input: ScoreInput = {
      commitKeywords: ['a', 'b'],
      candidates: [{ state: 'closed_issue', ref: '#7', titleKeywords: ['a', 'b'] }],
    };
    const r = score(input);
    expect(r.bucket).toBe('CLEAN');
    expect(r.reasons.join(' ')).toContain('only closed issues');
  });

  test('no candidates -> CLEAN', () => {
    expect(score({ commitKeywords: ['a'], candidates: [] }).bucket).toBe('CLEAN');
  });

  test('precedence: EXACT_DUP wins over a co-present overlapping issue', () => {
    const input: ScoreInput = {
      commitKeywords: ['a', 'b', 'c'],
      candidates: [
        { state: 'open_issue', ref: '#1', titleKeywords: ['a', 'b', 'c'] },
        { state: 'open_pr', ref: '#2', titleKeywords: ['a', 'b', 'c'] },
      ],
    };
    expect(score(input).bucket).toBe('EXACT_DUP');
  });
});

describe('gstack-pr-prep-score CLI', () => {
  // The skill pipes each commit's candidate set into the bin and reads one
  // JSON line back. A wrapper that never reaches the scorer prints nothing
  // and exits 0, and input that is not JSON must not read as a clean bucket.
  const BIN = path.join(import.meta.dir, '..', 'bin', 'gstack-pr-prep-score');
  const dup: ScoreInput = {
    commitKeywords: ['reindex', 'cli', 'fix'],
    candidates: [{ state: 'open_pr', ref: '#913', titleKeywords: ['reindex', 'cli', 'fix'] }],
  };
  const run = (args: string[], input: string) =>
    spawnSync(process.execPath, [BIN, ...args], { input, encoding: 'utf8', timeout: 60_000 });

  test('scores stdin or --file <path> and prints one JSON line, exit 0', () => {
    const viaStdin = run([], JSON.stringify(dup));
    expect(viaStdin.status).toBe(0);
    expect(viaStdin.stdout.endsWith('}\n')).toBe(true);
    const out = JSON.parse(viaStdin.stdout);
    expect(out.bucket).toBe('EXACT_DUP');
    expect(out).toEqual(score(dup));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-prep-score-'));
    try {
      const file = path.join(dir, 'candidates.json');
      fs.writeFileSync(file, JSON.stringify(dup));
      const viaFile = run(['--file', file], '');
      expect(viaFile.status).toBe(0);
      expect(viaFile.stdout).toBe(viaStdin.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('input that is not JSON exits 2 with a message and prints no bucket', () => {
    const r = run([], 'not json');
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('input is not valid JSON');
  });
});
