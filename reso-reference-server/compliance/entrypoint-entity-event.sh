#!/bin/sh
set -e

# ---------------------------------------------------------------------------
# EntityEvent (RCP-027) compliance entrypoint
#
# 1. Seed the static dataset (POST /admin/seed; includes EntityEvent records)
# 2. Run the reso-cert entity-event pipeline (handles health check, metadata,
#    payload generation, test execution, and reports)
# ---------------------------------------------------------------------------

SERVER_URL="${SERVER_URL:-http://server:8080}"
AUTH_TOKEN="${AUTH_TOKEN:-admin-token}"
WRITABLE_RESOURCE="${WRITABLE_RESOURCE:-Property}"
MODE="${MODE:-full}"

echo "============================================"
echo " RESO EntityEvent (RCP-027) Compliance Test"
echo "============================================"
echo "Server:   $SERVER_URL"
echo "Mode:     $MODE"
echo "Resource: $WRITABLE_RESOURCE"
echo ""

# --- 1. Seed test data ---
echo "Waiting for server..."
until wget -qO- "$SERVER_URL/health" > /dev/null 2>&1; do sleep 2; done

echo "Loading static seed data (creates EntityEvent records)..."
wget -qO- --post-data='{}' \
  --header='Content-Type: application/json' \
  --header="Authorization: Bearer $AUTH_TOKEN" \
  "$SERVER_URL/admin/seed" || true
echo "Seed complete."
echo ""

# --- 2. Run compliance pipeline ---
exec node /app/dist/cli/index.js entity-event \
  --url "$SERVER_URL" \
  --auth-token "$AUTH_TOKEN" \
  --mode "$MODE" \
  --writable-resource "$WRITABLE_RESOURCE" \
  --verbose \
  --output-dir /tmp/compliance-results
