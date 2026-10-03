/**
 * Static pins for the v1.68 wave's prose-tier behaviors — the coverage audit
 * flagged these as the only surfaces a future template edit could silently
 * revert without failing anything.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

describe('gstack-upgrade template: the gated fast-forward precedes the gated reset (#2517)', () => {
  const tmpl = read('gstack-upgrade/SKILL.md.tmpl');
  const reset = () => tmpl.indexOf('git reset --hard "$INCOMING"');

  test('the hook-gated fast-forward runs before any reset --hard', () => {
    const ff = tmpl.indexOf('gstack-gate-incoming" --fast-forward "$INSTALL_DIR" origin/main');
    expect(ff).toBeGreaterThan(-1);
    expect(reset()).toBeGreaterThan(-1);
    expect(ff).toBeLessThan(reset());
  });

  test('no git pull: a pull switches the tree in before anything can check it', () => {
    // Hooks run from the install by path; see docs/hook-syntax-gate.md.
    expect(tmpl).not.toMatch(/git pull\b/);
    expect(tmpl).not.toContain('git reset --hard origin/main');
  });

  test('the fallback re-gates origin/main before it stashes or resets', () => {
    const fallback = tmpl.slice(tmpl.indexOf('The block re-gates `origin/main`'));
    const gate = fallback.indexOf('gstack-gate-incoming" "$INSTALL_DIR" "$INCOMING"');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(fallback.indexOf('git stash'));
    expect(gate).toBeLessThan(fallback.indexOf('git reset --hard "$INCOMING"'));
  });

  test('the vendored path gates the clone before it replaces the install', () => {
    const vendored = tmpl.slice(tmpl.indexOf('**For vendored installs**'));
    const gate = vendored.indexOf('gstack-gate-incoming" "$TMP_DIR/gstack" HEAD');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(vendored.indexOf('mv "$INSTALL_DIR" "$INSTALL_DIR.bak"'));
  });

  test('the ff path carries the FF_OK success gate that skips the fallback', () => {
    expect(tmpl).toContain('FF_OK');
    expect(tmpl.indexOf('FF_OK')).toBeLessThan(reset());
  });

  test('the destructive fallback is gated on unpushed commits, not just a clean tree', () => {
    // A clean tree with unpushed local commits is NOT safe for reset --hard.
    expect(tmpl).toContain('git rev-list origin/main..HEAD');
    expect(tmpl.indexOf('git rev-list origin/main..HEAD')).toBeLessThan(reset());
  });
});

describe('untrusted-content warning injection points (#2441)', () => {
  test('scrape and skillify templates carry the shared token', () => {
    // The wording lives in ONE exported const (resolvers/browse.ts); these
    // pins keep the injection POINTS from silently disappearing.
    expect(read('scrape/SKILL.md.tmpl')).toContain('{{UNTRUSTED_CONTENT_WARNING}}');
    expect(read('skillify/SKILL.md.tmpl')).toContain('{{UNTRUSTED_CONTENT_WARNING}}');
  });
});

describe('brain-uninstall removes the spool queue', () => {
  test('uninstall cleans .brain-queue.d alongside the legacy queue file', () => {
    const src = read('bin/gstack-brain-uninstall');
    expect(src).toContain('.brain-queue.d');
    expect(src).toContain('.brain-queue.jsonl');
  });
});
