import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";

// Import normalizeRemoteUrl for unit testing
// We test the script end-to-end via CLI and normalizeRemoteUrl via import
const scriptPath = join(import.meta.dir, "..", "bin", "gstack-global-discover.ts");

/**
 * A throwaway $HOME the discovery CLI can scan in full.
 *
 * These tests used to run the CLI against the developer's real home: every
 * assertion depended on whatever repos happened to sit under ~/src, and the
 * scan regularly blew past bun's 5s per-test timeout on a loaded machine
 * (the spawnSync `timeout: 30000` never applied — bun kills the test first).
 * The script reads ~/.claude/projects, ~/.codex/sessions and ~/.gemini via
 * os.homedir(), which honours $HOME, so a fixture home makes the whole scan
 * deterministic, fast, and independent of the host.
 *
 * Layout: one repo checked out twice (a Conductor-style worktree) with one
 * Claude Code session each — enough to exercise grouping, dedup by remote,
 * and the session counters.
 */
const FIXTURE_REMOTE = "https://github.com/example/fixture-repo.git";

function makeFixtureHome(): { root: string; home: string; checkouts: string[] } {
  const root = mkdtempSync(join(tmpdir(), "gstack-discover-home-"));
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  // Empty codex tree: the scanner must see "no sessions", not the host's.
  mkdirSync(join(home, ".codex", "sessions"), { recursive: true });

  const checkouts: string[] = [];
  for (const [i, dirName] of ["checkout-main", "checkout-worktree"].entries()) {
    const repoDir = join(root, dirName);
    mkdirSync(repoDir, { recursive: true });
    spawnSync("git", ["init", "-q"], { cwd: repoDir, stdio: "pipe" });
    spawnSync("git", ["remote", "add", "origin", FIXTURE_REMOTE], {
      cwd: repoDir,
      stdio: "pipe",
    });
    checkouts.push(repoDir);

    // A project dir whose name does NOT decode to a real path, so the
    // scanner falls through to the cwd recorded in the JSONL.
    const projectDir = join(home, ".claude", "projects", `-gstack-fixture-${i}`);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "session.jsonl"),
      JSON.stringify({ cwd: repoDir, type: "user" }) + "\n"
    );
  }

  return { root, home, checkouts };
}

function runDiscover(
  home: string,
  args: string[]
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bun", ["run", scriptPath, ...args], {
    encoding: "utf-8",
    timeout: 30000,
    env: {
      ...process.env,
      HOME: home,
      CODEX_SESSIONS_DIR: join(home, ".codex", "sessions"),
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("gstack-global-discover", () => {
  describe("normalizeRemoteUrl", () => {
    // Dynamically import to test the exported function
    let normalizeRemoteUrl: (url: string) => string;

    beforeEach(async () => {
      const mod = await import("../bin/gstack-global-discover.ts");
      normalizeRemoteUrl = mod.normalizeRemoteUrl;
    });

    test("strips .git suffix", () => {
      expect(normalizeRemoteUrl("https://github.com/user/repo.git")).toBe(
        "https://github.com/user/repo"
      );
    });

    test("converts SSH to HTTPS", () => {
      expect(normalizeRemoteUrl("git@github.com:user/repo.git")).toBe(
        "https://github.com/user/repo"
      );
    });

    test("converts SSH without .git to HTTPS", () => {
      expect(normalizeRemoteUrl("git@github.com:user/repo")).toBe(
        "https://github.com/user/repo"
      );
    });

    test("lowercases host", () => {
      expect(normalizeRemoteUrl("https://GitHub.COM/user/repo")).toBe(
        "https://github.com/user/repo"
      );
    });

    test("SSH and HTTPS for same repo normalize to same URL", () => {
      const ssh = normalizeRemoteUrl("git@github.com:garrytan/gstack.git");
      const https = normalizeRemoteUrl("https://github.com/garrytan/gstack.git");
      const httpsNoDotGit = normalizeRemoteUrl("https://github.com/garrytan/gstack");
      expect(ssh).toBe(https);
      expect(https).toBe(httpsNoDotGit);
    });

    test("handles local: URLs consistently", () => {
      const result = normalizeRemoteUrl("local:/tmp/my-repo");
      // local: gets parsed as a URL scheme — the important thing is consistency
      expect(result).toContain("/tmp/my-repo");
    });

    test("handles GitLab SSH URLs", () => {
      expect(normalizeRemoteUrl("git@gitlab.com:org/project.git")).toBe(
        "https://gitlab.com/org/project"
      );
    });
  });

  describe("CLI", () => {
    test("--help exits 0 and prints usage", () => {
      const result = spawnSync("bun", ["run", scriptPath, "--help"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("--since");
    });

    test("no args exits 1 with error", () => {
      const result = spawnSync("bun", ["run", scriptPath], {
        encoding: "utf-8",
        timeout: 10000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--since is required");
    });

    test("invalid window format exits 1", () => {
      const result = spawnSync("bun", ["run", scriptPath, "--since", "abc"], {
        encoding: "utf-8",
        timeout: 10000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Invalid window format");
    });

    describe("against a fixture home", () => {
      let fixture: { root: string; home: string; checkouts: string[] };

      beforeEach(() => {
        fixture = makeFixtureHome();
      });

      afterEach(() => {
        rmSync(fixture.root, { recursive: true, force: true });
      });

      test("--since 7d produces valid JSON", () => {
        const result = runDiscover(fixture.home, [
          "--since", "7d", "--format", "json",
        ]);
        expect(result.status).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json).toHaveProperty("window", "7d");
        expect(Array.isArray(json.repos)).toBe(true);
        expect(json.total_repos).toBe(1);
        expect(json.total_sessions).toBe(2);
      });

      test("--since 7d --format summary produces readable output", () => {
        const result = runDiscover(fixture.home, [
          "--since", "7d", "--format", "summary",
        ]);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain("Window: 7d");
        expect(result.stdout).toContain("Sessions:");
        expect(result.stdout).toContain("Repos:");
        expect(result.stdout).toContain("fixture-repo");
      });

      test("--since 1h picks up sessions written just now", () => {
        const result = runDiscover(fixture.home, [
          "--since", "1h", "--format", "json",
        ]);
        expect(result.status).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.total_sessions).toBe(2);
      });

      test("repos have required fields", () => {
        const result = runDiscover(fixture.home, [
          "--since", "30d", "--format", "json",
        ]);
        expect(result.status).toBe(0);
        const json = JSON.parse(result.stdout);
        expect(json.repos.length).toBe(1);

        const repo = json.repos[0];
        expect(repo.name).toBe("fixture-repo");
        // .git suffix stripped, host lowercased
        expect(repo.remote).toBe("https://github.com/example/fixture-repo");
        expect(Array.isArray(repo.paths)).toBe(true);
        expect(repo.paths.length).toBe(2);
        expect(repo.sessions).toEqual({ claude_code: 2, codex: 0, gemini: 0 });
      });

      test("tools summary matches repo data", () => {
        const result = runDiscover(fixture.home, [
          "--since", "30d", "--format", "json",
        ]);
        const json = JSON.parse(result.stdout);
        const toolTotal =
          json.tools.claude_code.total_sessions +
          json.tools.codex.total_sessions +
          json.tools.gemini.total_sessions;
        expect(json.total_sessions).toBe(toolTotal);
        expect(json.tools.claude_code.total_sessions).toBe(2);
      });

      test("deduplicates Conductor workspaces by remote", () => {
        const result = runDiscover(fixture.home, [
          "--since", "30d", "--format", "json",
        ]);
        const json = JSON.parse(result.stdout);

        // Two checkouts, one remote → one repo carrying both paths.
        const remotes = json.repos.map((r: any) => r.remote);
        expect(remotes.length).toBe(new Set(remotes).size);
        expect(json.repos.length).toBe(1);
        expect([...json.repos[0].paths].sort()).toEqual(
          [...fixture.checkouts].sort()
        );
      });

      test("an empty home reports no repos and no sessions", () => {
        const emptyHome = mkdtempSync(join(tmpdir(), "gstack-discover-empty-"));
        try {
          const result = runDiscover(emptyHome, [
            "--since", "30d", "--format", "json",
          ]);
          expect(result.status).toBe(0);
          const json = JSON.parse(result.stdout);
          expect(json.total_repos).toBe(0);
          expect(json.total_sessions).toBe(0);
        } finally {
          rmSync(emptyHome, { recursive: true, force: true });
        }
      });
    });
  });

  describe("codex large session_meta parsing", () => {
    let codexDir: string;
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "gstack-codex-test-"));
      // Build a realistic ~/.codex/sessions/YYYY/MM/DD structure
      const now = new Date();
      const y = now.getFullYear().toString();
      const m = String(now.getMonth() + 1).padStart(2, "0");
      const d = String(now.getDate()).padStart(2, "0");
      codexDir = join(tmpDir, "codex-home", "sessions", y, m, d);
      mkdirSync(codexDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeCodexSession(
      dir: string,
      cwd: string,
      baseInstructionsSize: number
    ): string {
      const padding = "x".repeat(baseInstructionsSize);
      const line = JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "session_meta",
        payload: {
          id: `test-${Date.now()}`,
          timestamp: new Date().toISOString(),
          cwd,
          originator: "codex_exec",
          cli_version: "0.118.0",
          source: "exec",
          model_provider: "openai",
          base_instructions: { text: padding },
        },
      });
      const name = `rollout-${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random().toString(36).slice(2)}.jsonl`;
      const filePath = join(dir, name);
      writeFileSync(filePath, line + "\n");
      return filePath;
    }

    test("discovers codex sessions with >4KB session_meta via CLI", () => {
      // Create a git repo as the session target
      const repoDir = join(tmpDir, "fake-repo");
      mkdirSync(repoDir);
      spawnSync("git", ["init"], { cwd: repoDir, stdio: "pipe" });
      spawnSync("git", ["commit", "--allow-empty", "-m", "init"], {
        cwd: repoDir,
        stdio: "pipe",
      });

      // Write a session with a 20KB first line (simulates Codex v0.117+)
      writeCodexSession(codexDir, repoDir, 20000);

      // Run discovery with CODEX_SESSIONS_DIR override
      const result = spawnSync(
        "bun",
        ["run", scriptPath, "--since", "1h", "--format", "json"],
        {
          encoding: "utf-8",
          timeout: 30000,
          env: {
            ...process.env,
            CODEX_SESSIONS_DIR: join(tmpDir, "codex-home", "sessions"),
          },
        }
      );

      expect(result.status).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.tools.codex.total_sessions).toBeGreaterThanOrEqual(1);
    });

    test("4KB buffer truncates session_meta, 128KB buffer parses it", () => {
      const padding = "x".repeat(20000);
      const sessionMeta = JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "session_meta",
        payload: {
          id: "test-id",
          timestamp: new Date().toISOString(),
          cwd: "/tmp/test-repo",
          originator: "codex_exec",
          cli_version: "0.118.0",
          source: "exec",
          model_provider: "openai",
          base_instructions: { text: padding },
        },
      });

      expect(sessionMeta.length).toBeGreaterThan(4096);

      const filePath = join(codexDir, "test.jsonl");
      writeFileSync(filePath, sessionMeta + "\n");

      // 4KB buffer: JSON.parse fails (the old bug)
      const { openSync, readSync, closeSync } = require("fs");
      const fd4k = openSync(filePath, "r");
      const buf4k = Buffer.alloc(4096);
      readSync(fd4k, buf4k, 0, 4096, 0);
      closeSync(fd4k);
      expect(() =>
        JSON.parse(buf4k.toString("utf-8").split("\n")[0])
      ).toThrow();

      // 128KB buffer: JSON.parse succeeds (the fix)
      const fd128k = openSync(filePath, "r");
      const buf128k = Buffer.alloc(131072);
      const bytesRead = readSync(fd128k, buf128k, 0, 131072, 0);
      closeSync(fd128k);
      const firstLine = buf128k.toString("utf-8", 0, bytesRead).split("\n")[0];
      const meta = JSON.parse(firstLine);
      expect(meta.type).toBe("session_meta");
      expect(meta.payload.cwd).toBe("/tmp/test-repo");
    });

    test("regression: session_meta beyond 128KB still needs streaming parse", () => {
      // This test documents the current limitation: 128KB buffer is a heuristic.
      // If Codex ever embeds >128KB in session_meta, this test will fail,
      // signaling that the buffer needs to increase or be replaced with streaming.
      const padding = "x".repeat(140000); // ~140KB payload
      const sessionMeta = JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "session_meta",
        payload: {
          id: "test-large",
          timestamp: new Date().toISOString(),
          cwd: "/tmp/large-test",
          originator: "codex_exec",
          cli_version: "0.200.0",
          source: "exec",
          model_provider: "openai",
          base_instructions: { text: padding },
        },
      });

      expect(sessionMeta.length).toBeGreaterThan(131072);

      const filePath = join(codexDir, "large-test.jsonl");
      writeFileSync(filePath, sessionMeta + "\n");

      // 128KB buffer: JSON.parse FAILS for >128KB lines (current limitation)
      const { openSync, readSync, closeSync } = require("fs");
      const fd = openSync(filePath, "r");
      const buf = Buffer.alloc(131072);
      readSync(fd, buf, 0, 131072, 0);
      closeSync(fd);
      expect(() =>
        JSON.parse(buf.toString("utf-8").split("\n")[0])
      ).toThrow();
      // When this test starts passing (e.g., after implementing streaming parse),
      // update it to verify correct parsing instead of documenting the limitation.
    });
  });

  describe("extractCwdFromJsonl 64KB cap (PR #1169 bug #8)", () => {
    // Regression: the old 8KB cap landed mid-line on Claude Code sessions with
    // long headers, JSON.parse threw on the truncated tail, the catch
    // `continue`d silently, and the project disappeared from discovery.
    // The fix raised the cap to 64KB AND drops the trailing partial segment
    // before parsing.
    let extractCwdFromJsonl: (filePath: string) => string | null;
    let tmpDir: string;

    beforeEach(async () => {
      const mod = await import("../bin/gstack-global-discover.ts");
      extractCwdFromJsonl = mod.extractCwdFromJsonl;
      tmpDir = mkdtempSync(join(tmpdir(), "pr1169-cwd-"));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    test("happy path: small JSONL with obj.cwd returns it (sanity)", () => {
      const filePath = join(tmpDir, "small.jsonl");
      const line = JSON.stringify({ cwd: "/tmp/repo-small", type: "header" });
      writeFileSync(filePath, line + "\n");
      expect(extractCwdFromJsonl(filePath)).toBe("/tmp/repo-small");
    });

    test("12KB first line with obj.cwd: returns cwd (old 8KB cap returned null)", () => {
      // Pad a JSONL header so the whole line is ~12KB ending in `}\n`.
      // Old 8KB read would slice mid-line; JSON.parse on the truncated tail
      // would throw, the catch would `continue`, and we'd return null.
      const padding = "x".repeat(12 * 1024);
      const line = JSON.stringify({
        cwd: "/tmp/repo-12k",
        type: "header",
        notes: padding,
      });
      expect(line.length).toBeGreaterThan(8 * 1024);
      expect(line.length).toBeLessThan(64 * 1024);

      const filePath = join(tmpDir, "header-12k.jsonl");
      writeFileSync(filePath, line + "\n");
      expect(extractCwdFromJsonl(filePath)).toBe("/tmp/repo-12k");
    });

    test("80KB single line (overflows 64KB cap): returns null without crashing", () => {
      // One line >64KB with no newline inside the read window. The 64KB read
      // captures a truncated prefix, parts.length === 1, no trailing drop
      // applies, JSON.parse throws, catch returns null. The fix's
      // trailing-partial-drop must not crash on this shape.
      const padding = "y".repeat(80 * 1024);
      const line = JSON.stringify({ cwd: "/tmp/repo-80k", type: "header", notes: padding });
      expect(line.length).toBeGreaterThan(64 * 1024);

      const filePath = join(tmpDir, "header-80k.jsonl");
      writeFileSync(filePath, line + "\n");
      // Don't throw, just return null.
      expect(extractCwdFromJsonl(filePath)).toBeNull();
    });

    test("complete line followed by partial second line: returns first line's cwd", () => {
      // Line 1 ends cleanly with `\n` well within the cap.
      // Line 2 is long enough that the 64KB read captures only its incomplete
      // beginning. The trailing-partial drop must skip the truncated line 2
      // and not poison the result.
      const line1 = JSON.stringify({ cwd: "/tmp/repo-line-1", type: "header" });
      const line2Padding = "z".repeat(80 * 1024);
      const line2 = JSON.stringify({ cwd: "/tmp/repo-line-2", notes: line2Padding });

      const filePath = join(tmpDir, "header-partial-2.jsonl");
      writeFileSync(filePath, line1 + "\n" + line2 + "\n");
      expect(extractCwdFromJsonl(filePath)).toBe("/tmp/repo-line-1");
    });

    test("missing file: returns null (file read error is swallowed)", () => {
      const filePath = join(tmpDir, "nonexistent.jsonl");
      expect(extractCwdFromJsonl(filePath)).toBeNull();
    });

    test("malformed first line then valid second line within cap: returns second", () => {
      // Both lines fully within 64KB. First line is not valid JSON; second
      // is. The function must skip first and return second's cwd.
      const filePath = join(tmpDir, "bad-then-good.jsonl");
      const good = JSON.stringify({ cwd: "/tmp/repo-skip-bad" });
      writeFileSync(filePath, "{ not valid json\n" + good + "\n");
      expect(extractCwdFromJsonl(filePath)).toBe("/tmp/repo-skip-bad");
    });
  });
});
