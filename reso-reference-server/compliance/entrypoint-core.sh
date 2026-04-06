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

PROP_COUNT=$(seed_count Property)
echo "Seeding $PROP_COUNT Property records..."
wget -qO- --post-data="{\"resource\":\"Property\",\"count\":$PROP_COUNT,\"resolveDependencies\":true,\"relatedRecords\":{\"Media\":$(seed_count Media),\"OpenHouse\":$(seed_count OpenHouse),\"Showing\":$(seed_count Showing),\"PropertyRooms\":$(seed_count PropertyRooms),\"PropertyGreenVerification\":$(seed_count PropertyGreenVerification),\"PropertyPowerProduction\":$(seed_count PropertyPowerProduction),\"PropertyUnitTypes\":$(seed_count PropertyUnitTypes)}}" \
  --header='Content-Type: application/json' \
  --header="Authorization: Bearer $AUTH_TOKEN" \
  "$SERVER_URL/admin/data-generator" || true
echo "Seed complete."
echo ""

# --- 2. Run compliance pipeline ---
exec node /app/dist/cli/index.js core \
  --url "$SERVER_URL" \
  --auth-token "$AUTH_TOKEN" \
  --verbose \
  --output-dir /tmp/compliance-results
