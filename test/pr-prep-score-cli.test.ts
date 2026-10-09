/**
 * CLI contract for bin/gstack-pr-prep-score, the wrapper the /pr-prep skill
 * runs in Step 4 over lib/pr-prep-score.ts.
 *
 * Kept apart from test/pr-prep-score.test.ts on purpose: the bin path below
 * matches the "spawns bin/ shebang script" rule in
 * scripts/lib/windows-curation.ts, which drops a whole file from the curated
 * Windows lane. The pure scorer cases live in their own file so they keep
 * running there.
 */
import { describe, test, expect, setDefaultTimeout } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { score, type ScoreInput } from '../lib/pr-prep-score';

setDefaultTimeout(120_000);

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
