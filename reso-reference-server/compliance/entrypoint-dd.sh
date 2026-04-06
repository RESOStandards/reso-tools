#!/bin/sh
set -e

# ---------------------------------------------------------------------------
# Data Dictionary compliance entrypoint
#
# 1. Seed test data via the data generator
# 2. Run the reso-cert dd pipeline (handles health check, metadata
#    serialization, Lookup Resource merge, variations, and replication)
# ---------------------------------------------------------------------------

SERVER_URL="${SERVER_URL:-http://server:8080}"
AUTH_TOKEN="${AUTH_TOKEN:-admin-token}"
DD_VERSION="${DD_VERSION:-2.0}"

# Load shared seed helpers (seed_count function)
. "$(dirname "$0")/seed-helpers.sh" 2>/dev/null || . /config/seed-helpers.sh

echo "============================================"
echo " RESO Data Dictionary ${DD_VERSION} Compliance Test"
echo "============================================"
echo "Server: $SERVER_URL"
echo ""

# --- 1. Seed test data ---
echo "Waiting for server..."
until wget -qO- "$SERVER_URL/health" > /dev/null 2>&1; do sleep 2; done

PROP_COUNT=$(seed_count Property)
echo "Seeding $PROP_COUNT Property records..."
wget -qO- --post-data="{\"resource\":\"Property\",\"count\":$PROP_COUNT,\"resolveDependencies\":true,\"relatedRecords\":{\"Media\":$(seed_count Media),\"OpenHouse\":$(seed_count OpenHouse),\"Showing\":$(seed_count Showing),\"PropertyRooms\":$(seed_count PropertyRooms),\"PropertyGreenVerification\":$(seed_count PropertyGreenVerification),\"PropertyPowerProduction\":$(seed_count PropertyPowerProduction),\"PropertyUnitTypes\":$(seed_count PropertyUnitTypes)}}" \
  --header='Content-Type: application/json' \
  --header="Authorization: Bearer $AUTH_TOKEN" \
  "$SERVER_URL/admin/data-generator" || true
echo "Seed complete."
echo ""

# --- 2. Run compliance pipeline ---
LIMIT_FLAG=""
if [ -n "$RECORD_LIMIT" ]; then
  LIMIT_FLAG="--limit $RECORD_LIMIT"
fi

exec node /app/dist/cli/index.js dd \
  --url "$SERVER_URL" \
  --auth-token "$AUTH_TOKEN" \
  --dd-version "$DD_VERSION" \
  --verbose \
  --output-dir /tmp/compliance-results \
  $LIMIT_FLAG
