#!/bin/sh
set -e

# ---------------------------------------------------------------------------
# Web API Core compliance entrypoint
#
# 1. Seed test data via the data generator
# 2. Run the reso-cert core pipeline (handles health check, metadata,
#    field sampling, scenario execution, and reports)
# ---------------------------------------------------------------------------

SERVER_URL="${SERVER_URL:-http://server:8080}"
AUTH_TOKEN="${AUTH_TOKEN:-admin-token}"

# Load shared seed helpers (seed_count function)
. "$(dirname "$0")/seed-helpers.sh" 2>/dev/null || . /config/seed-helpers.sh

echo "============================================"
echo " RESO Web API Core Compliance Test"
echo "============================================"
echo "Server: $SERVER_URL"
echo ""

# --- 1. Seed test data ---
echo "Waiting for server..."
until wget -qO- "$SERVER_URL/health" > /dev/null 2>&1; do sleep 2; done

echo "Loading static seed data..."
wget -qO- --post-data='{}' \
  --header='Content-Type: application/json' \
  --header="Authorization: Bearer $AUTH_TOKEN" \
  "$SERVER_URL/admin/seed" || true
echo "Seed complete."
echo ""

# --- 2. Run compliance pipeline ---
exec node /app/dist/cli/index.js core \
  --url "$SERVER_URL" \
  --auth-token "$AUTH_TOKEN" \
  --verbose \
  --output-dir /tmp/compliance-results
