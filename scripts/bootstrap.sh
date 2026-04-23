#!/bin/bash
# Bootstrap — builds all packages in dependency order.
# Usage: ./scripts/bootstrap.sh
#
# This is the one command that takes a fresh clone to a working state.
# Each package is installed and built only if its dist/ directory is
# missing or the --force flag is passed.

set -e

FORCE=false
if [ "$1" = "--force" ]; then
  FORCE=true
  echo "Force rebuild: all packages will be rebuilt"
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

needs_build() {
  local pkg=$1
  local check_dir=$2
  if [ "$FORCE" = true ]; then return 0; fi
  if [ ! -d "$pkg/$check_dir" ]; then return 0; fi
  return 1
}

build_pkg() {
  local pkg=$1
  local check_dir=${2:-dist}
  if needs_build "$pkg" "$check_dir"; then
    echo "Building $pkg..."
    cd "$ROOT/$pkg"
    npm install --ignore-scripts
    npm run build
    cd "$ROOT"
    echo "  ✓ $pkg"
  else
    echo "  ✓ $pkg (already built)"
  fi
}

echo "============================================"
echo " RESO Tools Bootstrap"
echo "============================================"
echo ""

# Layer 1: shared libraries (no internal deps)
echo "── Shared Libraries ──"
build_pkg odata-expression-parser
build_pkg reso-validation
build_pkg reso-client
build_pkg reso-data-generator

# Layer 2: server and cert (depend on shared libs)
echo ""
echo "── Server & Certification ──"
build_pkg reso-reference-server
build_pkg reso-web-api-proxy
build_pkg reso-certification

# Layer 3: web client (standalone build)
echo ""
echo "── Web Client ──"
build_pkg reso-web-client

# Layer 4: desktop client (depends on everything above)
echo ""
echo "── Desktop Client ──"
cd "$ROOT/reso-desktop-client"
npm install --ignore-scripts
# electron-rebuild is needed locally but may fail in CI — non-fatal
npm run postinstall 2>/dev/null || true
npm run build
npm run build:server-bundle
npm run build:cert-worker
cd "$ROOT"
echo "  ✓ reso-desktop-client"

echo ""
echo "============================================"
echo " Bootstrap complete"
echo "============================================"
echo ""
echo "To start the desktop client:"
echo "  cd reso-desktop-client && npm run dev"
echo ""
echo "To run tests:"
echo "  npm test"
