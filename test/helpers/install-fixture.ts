/**
 * Real-setup fixtures for the install conformance kit (test/host-conformance.test.ts)
 * and the install-registry tests (test/setup-install-registry.test.ts).
 *
 * A fixture is a throwaway gstack checkout (the working tree's tracked and
 * untracked-but-not-ignored files, so uncommitted changes are under test) plus
 * a clean HOME. Binaries are stubbed and `bun run build` is refused, so setup
 * runs its real registration path without compiling (GSTACK_SKIP_PLAYWRIGHT,
 * GSTACK_SETUP_SKIP_CSO_BUILD, GSTACK_SKIP_FONTS). Every write the test makes
 * goes through `put`, which refuses paths outside the fixture root.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export const ROOT = resolve(import.meta.dir, '../..');
const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 });
if (listed.status !== 0) throw new Error(listed.stderr);
const SOURCE_FILES = listed.stdout.split('\0').filter(rel => rel && !/^(?:test|docs|browse\/test|\.github|node_modules)\//.test(rel) && existsSync(join(ROOT, rel)));
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export interface Fixture { dir: string; home: string; commands: string; env: Record<string, string> }

const roots: string[] = [];

/** `target` is `base` or below it, compared by the platform's own path rules (separators, Windows drive case). */
const within = (base: string, target: string) => {
  const rel = relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/** Write inside the fixture only (never through a link out of it). */
export function put(file: string, content: string | Buffer, mode = 0o644) {
  const root = roots.find(r => file !== r && within(r, file));
  if (!root) throw new Error(`fixture write outside a fixture root: ${file}`);
  mkdirSync(dirname(file), { recursive: true });
  if (!within(realpathSync(root), realpathSync(dirname(file)))) throw new Error(`fixture write escapes its root: ${file}`);
  writeFileSync(file, content, { mode });
}

export function makeFixture(): Fixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gstack-install-')));
  roots.push(dir);
  const home = join(dir, 'home');
  const commands = join(dir, 'commands');
  mkdirSync(home, { recursive: true });
  put(join(commands, 'bun'), `#!/usr/bin/env bash
case "$*" in
  'install --frozen-lockfile') exit 0 ;;
  'run build') echo 'Unexpected build in an install fixture' >&2; exit 90 ;;
  *) exec ${quote(process.execPath)} "$@" ;;
esac
`, 0o755);
  put(join(home, '.gstack/config.yaml'), 'telemetry: off\nartifacts_sync: off\n');
  const env: Record<string, string> = {
    PATH: `${commands}:${process.env.PATH}`, HOME: home, USERPROFILE: home,
    TMPDIR: dir, TMP: dir, TEMP: dir, LANG: 'C.UTF-8',
    GSTACK_SKIP_PLAYWRIGHT: '1', GSTACK_SETUP_SKIP_CSO_BUILD: '1', GSTACK_SKIP_FONTS: '1',
    GSTACK_SKIP_COREUTILS: '1', GSTACK_SKIP_ASIDE: '1',
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(tmpdir(), 'gstack-install-fixture-bun-cache'),
  };
  return { dir, home, commands, env };
}

/** A gstack checkout at `dest` (inside the fixture) with stubbed binaries. */
export function makeSource(f: Fixture, dest: string, version?: string): string {
  for (const rel of SOURCE_FILES) {
    const from = join(ROOT, rel);
    const to = join(dest, rel);
    mkdirSync(dirname(to), { recursive: true });
    if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to);
  }
  for (const rel of ['browse/dist/browse', 'design/dist/design', 'make-pdf/dist/pdf', 'browse/dist/.build-complete']) {
    put(join(dest, rel), '#!/bin/sh\nexit 0\n', 0o755);
    utimesSync(join(dest, rel), new Date('2040-01-01'), new Date('2040-01-01'));
  }
  if (version) put(join(dest, 'VERSION'), `${version}\n`);
  return dest;
}

export function setVersion(source: string, version: string) {
  put(join(source, 'VERSION'), `${version}\n`);
}

/** One ./setup run. Setup sweeps the tree with the hook parse gate before it installs anything, which costs seconds more under load; the bound only catches a hang. */
export function runSetup(f: Fixture, setupPath: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): SpawnSyncReturns<string> {
  return spawnSync('bash', [setupPath, ...args, '--no-plan-tune-hooks'], {
    cwd: opts.cwd ?? f.home, env: { ...f.env, ...opts.env }, encoding: 'utf8', timeout: 120_000, input: '',
  });
}

export function registryRows(f: Fixture, stateRoot = join(f.home, '.gstack')): string[][] {
  const file = join(stateRoot, 'installs.tsv');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split('\t'));
}

/**
 * Path → link target / sha256 / subtree, for "nothing changed" assertions.
 * `.capy` is skipped: Capy cloud machines wrap git with a shim that logs to
 * $HOME/.capy, which is the machine's write, not gstack's.
 */
export function tree(dir: string): unknown {
  const stat = lstatSync(dir, { throwIfNoEntry: false });
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { link: readlinkSync(dir) };
  if (stat.isDirectory()) return Object.fromEntries(readdirSync(dir).filter(name => name !== '.capy').sort().map(name => [name, tree(join(dir, name))]));
  return createHash('sha256').update(readFileSync(dir)).digest('hex');
}

export function cleanupFixtures() {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
}
