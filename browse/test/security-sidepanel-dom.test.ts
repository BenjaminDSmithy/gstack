/**
 * Sidepanel security indicator — current state of the wiring.
 *
 * This file used to drive the SEC shield and the injection banner in a real
 * Chromium: load extension/sidepanel.html over file://, stub window.fetch to
 * serve /health and /sidebar-chat, push security_event entries through the
 * chat poll, and assert the banner rendered, expanded, and dismissed.
 *
 * That transport is gone. The chat queue was ripped in v1.14.0.0 when the
 * interactive PTY replaced it, and sidepanel.js says so at the point where the
 * shield used to be updated:
 *
 *   // The SEC shield used to drive off /health.security via the chat
 *   // path's classifier; with the chat path ripped, the indicator is
 *   // not driven yet. Leaving the shield element hidden by default.
 *
 * So the six DOM tests were not catching a regression — they were asserting a
 * feature nothing wires up any more, and the surface they exercised (a
 * /sidebar-chat poll) answers 404. Keeping them red made the gate unusable;
 * skipping them would have hidden the fact that the indicator is dark.
 *
 * What is left here is deliberately small: the markup a re-wiring would attach
 * to, and a tripwire that fails the moment someone drives the shield again —
 * at which point the DOM coverage deleted here should come back against
 * whatever the new transport is. The classifier and verdict logic behind the
 * indicator is covered by security.test.ts, content-security.test.ts and
 * security-bench-ensemble.test.ts regardless of whether the UI shows it.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const EXTENSION_DIR = path.resolve(import.meta.dir, '..', '..', 'extension');
const HTML = fs.readFileSync(path.join(EXTENSION_DIR, 'sidepanel.html'), 'utf-8');
const JS = fs.readFileSync(path.join(EXTENSION_DIR, 'sidepanel.js'), 'utf-8');
const CSS = fs.readFileSync(path.join(EXTENSION_DIR, 'sidepanel.css'), 'utf-8');

describe('sidepanel security indicator markup', () => {
  test('the shield element still ships, hidden by default', () => {
    // A re-wiring needs something to attach to, and "hidden" is the honest
    // default while nothing drives it — a visible shield stuck on "unknown"
    // would be worse than no shield.
    expect(HTML).toContain('id="security-shield"');
    const el = HTML.match(/<div class="security-shield"[^>]*>/)?.[0] ?? '';
    expect(el).toContain('display:none');
    expect(el).toContain('role="status"');
    expect(el).toContain('aria-label=');
  });

  test('its styles are still present', () => {
    expect(CSS).toContain('.security-shield');
  });
});

describe('sidepanel security indicator wiring (tripwire)', () => {
  test('nothing drives the shield yet — restore DOM coverage when that changes', () => {
    // When someone wires the indicator to the PTY-era transport, this test
    // fails on purpose. The fix is not to delete it: it is to bring back the
    // shield/banner DOM tests (git show the revision that removed this file's
    // Chromium harness) pointed at the new transport, and drop this tripwire.
    expect(JS).not.toContain("getElementById('security-shield').setAttribute");
    expect(JS).not.toContain('renderSecurityBanner');
    expect(JS).not.toContain("data-status");
    // The comment that records why, so a reader lands on the explanation
    // rather than concluding the indicator was forgotten.
    expect(JS).toContain('the indicator is');
    expect(JS).toContain('not driven yet');
  });
});
