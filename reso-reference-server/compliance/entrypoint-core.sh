#!/bin/sh
# ---------------------------------------------------------------------------
# entrypoint-core.sh — Wait for server, generate RESOScripts, run Web API
# Core 2.0.0 compliance tests for each resource.
# ---------------------------------------------------------------------------
set -e

SERVER_URL="${SERVER_URL:-http://server:8080}"
AUTH_TOKEN="${AUTH_TOKEN:-admin-token}"
ENUM_MODE="${ENUM_MODE:-string}"

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

# Generate RESOScripts from live server data
echo "Generating RESOScript configs from live server..."
/config/generate-resoscripts.sh "$SERVER_URL" "$AUTH_TOKEN" /tmp/resoscripts

# Determine enum flag for commander
if [ "$ENUM_MODE" = "string" ]; then
  STRING_ENUM_FLAG="-DuseStringEnums=true"
else
  STRING_ENUM_FLAG=""
fi

# Run Web API Core tests for each resource
FAILED=0
for script in /tmp/resoscripts/*.resoscript; do
  RESOURCE=$(basename "$script" .resoscript)
  echo ""
  echo "============================================"
  echo "  Testing: $RESOURCE (ENUM_MODE=$ENUM_MODE)"
  echo "============================================"
  ./gradlew --no-daemon testWebApiCore \
    -DpathToRESOScript="$script" \
    $STRING_ENUM_FLAG \
    -DuseCollections=true \
    -DshowResponses=true \
    || FAILED=1
done

if [ "$FAILED" = "1" ]; then
  echo ""
  echo "Some Web API Core tests FAILED."
  exit 1
fi

echo ""
echo "All Web API Core tests passed."
