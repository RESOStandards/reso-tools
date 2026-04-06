#!/bin/sh
set -e

# ---------------------------------------------------------------------------
# EntityEvent (RCP-027) compliance entrypoint
#
# 1. Seed test data via the data generator (creates EntityEvent records)
# 2. Run the reso-cert entity-event pipeline (handles health check, metadata,
#    payload generation, test execution, and reports)
# ---------------------------------------------------------------------------

SERVER_URL="${SERVER_URL:-http://server:8080}"
AUTH_TOKEN="${AUTH_TOKEN:-admin-token}"
WRITABLE_RESOURCE="${WRITABLE_RESOURCE:-Property}"
MODE="${MODE:-full}"

# Load shared seed helpers (seed_count function)
. "$(dirname "$0")/seed-helpers.sh" 2>/dev/null || . /config/seed-helpers.sh

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

PROP_COUNT=$(seed_count Property)
echo "Seeding $PROP_COUNT Property records (creates EntityEvent records)..."
wget -qO- --post-data="{\"resource\":\"Property\",\"count\":$PROP_COUNT,\"resolveDependencies\":true,\"relatedRecords\":{\"Media\":$(seed_count Media),\"OpenHouse\":$(seed_count OpenHouse),\"PropertyRooms\":$(seed_count PropertyRooms)}}" \
  --header='Content-Type: application/json' \
  --header="Authorization: Bearer $AUTH_TOKEN" \
  "$SERVER_URL/admin/data-generator" || true
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
