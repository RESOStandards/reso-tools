#!/bin/sh
# ---------------------------------------------------------------------------
# entrypoint-dd.sh — Wait for server, run Data Dictionary 2.0 compliance tests
# ---------------------------------------------------------------------------
set -e

SERVER_URL="${SERVER_URL:-http://server:8080}"
AUTH_TOKEN="${AUTH_TOKEN:-admin-token}"

# Load shared seed helpers (seed_count function)
. "$(dirname "$0")/seed-helpers.sh" 2>/dev/null || . /config/seed-helpers.sh

echo "Waiting for server at $SERVER_URL..."
until wget -qO- "$SERVER_URL/health" > /dev/null 2>&1; do sleep 2; done
echo "Server ready."

# Seed test data so there are records for compliance queries
PROP_COUNT=$(seed_count Property)
echo "Seeding $PROP_COUNT Property records..."
wget -qO- --post-data="{\"resource\":\"Property\",\"count\":$PROP_COUNT,\"resolveDependencies\":true,\"relatedRecords\":{\"Media\":$(seed_count Media),\"OpenHouse\":$(seed_count OpenHouse),\"Showing\":$(seed_count Showing),\"PropertyRooms\":$(seed_count PropertyRooms),\"PropertyGreenVerification\":$(seed_count PropertyGreenVerification),\"PropertyPowerProduction\":$(seed_count PropertyPowerProduction),\"PropertyUnitTypes\":$(seed_count PropertyUnitTypes)}}" \
  --header='Content-Type: application/json' --header="Authorization: Bearer $AUTH_TOKEN" \
  "$SERVER_URL/admin/data-generator" || echo "WARNING: Seed failed, continuing anyway"
echo "Seed complete."

# Substitute server URL into config template
sed "s|SERVER_URL_PLACEHOLDER|$SERVER_URL|g" /config/dd-config.json > /tmp/dd-config.json

echo "Running Data Dictionary 2.0 compliance tests..."
LIMIT_FLAG=""
if [ -n "$RECORD_LIMIT" ]; then
  LIMIT_FLAG="-l $RECORD_LIMIT"
  echo "Record limit: $RECORD_LIMIT"
fi
exec reso-certification-utils runDDTests -v 2.0 -p /tmp/dd-config.json -a $LIMIT_FLAG
