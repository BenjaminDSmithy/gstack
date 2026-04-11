#!/usr/bin/env bash
# Build a Node.js-compatible server bundle for Windows.
#
# On Windows, Bun can't launch or connect to Playwright's Chromium
# (oven-sh/bun#4253, #9911). This script produces a server bundle
# that runs under Node.js with Bun API polyfills.
#
# The bundle is ONLY needed on Windows. On macOS and Linux, bun drives
# Playwright directly, so running this step is wasted work and (per #960)
# also currently fails under newer bun versions because `bun build
# --outfile` cannot emit multi-file output. Guard with an OS check and
# exit cleanly on non-Windows platforms so the rest of `bun run build`
# continues uninterrupted.

set -e

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    # Windows: fall through and build the bundle
    ;;
  *)
    echo "Skipping Node-compatible server bundle (non-Windows platform)"
    exit 0
    ;;
esac

GSTACK_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_DIR="$GSTACK_DIR/browse/src"
DIST_DIR="$GSTACK_DIR/browse/dist"

echo "Building Node-compatible server bundle..."

# Step 1: Transpile server.ts to a single .mjs bundle (externalize runtime deps)
bun build "$SRC_DIR/server.ts" \
  --target=node \
  --outfile "$DIST_DIR/server-node.mjs" \
  --external playwright \
  --external playwright-core \
  --external diff \
  --external "bun:sqlite"

# Step 2: Post-process
# Replace import.meta.dir with a resolvable reference
perl -pi -e 's/import\.meta\.dir/__browseNodeSrcDir/g' "$DIST_DIR/server-node.mjs"
# Stub out bun:sqlite (macOS-only cookie import, not needed on Windows)
perl -pi -e 's|import { Database } from "bun:sqlite";|const Database = null; // bun:sqlite stubbed on Node|g' "$DIST_DIR/server-node.mjs"

# Step 3: Create the final file with polyfill header injected after the first line
{
  head -1 "$DIST_DIR/server-node.mjs"
  echo '// ── Windows Node.js compatibility (auto-generated) ──'
  echo 'import { fileURLToPath as _ftp } from "node:url";'
  echo 'import { dirname as _dn } from "node:path";'
  echo 'const __browseNodeSrcDir = _dn(_dn(_ftp(import.meta.url))) + "/src";'
  echo '{ const _r = createRequire(import.meta.url); _r("./bun-polyfill.cjs"); }'
  echo '// ── end compatibility ──'
  tail -n +2 "$DIST_DIR/server-node.mjs"
} > "$DIST_DIR/server-node.tmp.mjs"

mv "$DIST_DIR/server-node.tmp.mjs" "$DIST_DIR/server-node.mjs"

# Step 4: Copy polyfill to dist/
cp "$SRC_DIR/bun-polyfill.cjs" "$DIST_DIR/bun-polyfill.cjs"

echo "Node server bundle ready: $DIST_DIR/server-node.mjs"
