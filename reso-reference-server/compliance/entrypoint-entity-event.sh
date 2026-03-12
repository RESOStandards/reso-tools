#!/bin/sh
set -e

# ---------------------------------------------------------------------------
# EntityEvent (RCP-027) compliance entrypoint
#
# 1. Wait for the server to be healthy
# 2. Seed test data via the data generator (creates EntityEvent records)
# 3. Run EntityEvent compliance tests in full mode (create/update/delete canary)
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

# --- 1. Wait for server ---
echo "Waiting for server at $SERVER_URL..."
until wget -qO- "$SERVER_URL/health" > /dev/null 2>&1; do sleep 2; done
echo "Server is ready."

# --- 2. Seed test data ---
PROP_COUNT=$(seed_count Property)
echo "Seeding $PROP_COUNT Property records (creates EntityEvent records)..."
wget -qO- --post-data="{\"resource\":\"Property\",\"count\":$PROP_COUNT,\"resolveDependencies\":true,\"relatedRecords\":{\"Media\":$(seed_count Media),\"OpenHouse\":$(seed_count OpenHouse),\"PropertyRooms\":$(seed_count PropertyRooms)}}" \
  --header='Content-Type: application/json' \
  --header="Authorization: Bearer $AUTH_TOKEN" \
  "$SERVER_URL/admin/data-generator" || true
echo ""
echo "Seed complete."

# --- 3. Generate payloads for full mode canary writes ---
PAYLOADS_DIR="/tmp/entity-event-payloads"
mkdir -p "$PAYLOADS_DIR"

cat > "$PAYLOADS_DIR/create-succeeds.json" << PAYLOAD
{
  "ListPrice": 275000.00,
  "BedroomsTotal": 3,
  "BathroomsTotalInteger": 2,
  "City": "EntityEvent Test City",
  "StateOrProvince": "TX",
  "PostalCode": "78701",
  "Country": "US"
}
PAYLOAD

echo "Generated payloads in $PAYLOADS_DIR"
echo ""

# --- 4. Run EntityEvent compliance ---
echo "Running EntityEvent compliance tests..."
echo "--------------------------------------------"

REPORT_PATH="/tmp/entity-event-compliance-report.json"

FAILED=0
node /app/dist/cli/index.js entity-event \
  --url "$SERVER_URL" \
  --auth-token "$AUTH_TOKEN" \
  --mode "$MODE" \
  --writable-resource "$WRITABLE_RESOURCE" \
  --payloads-dir "$PAYLOADS_DIR" \
  --max-events 1000 \
  --batch-size 100 \
  --poll-interval 5000 \
  --poll-timeout 30000 \
  --output console \
  --compliance-report "$REPORT_PATH" \
  || FAILED=1

echo ""
echo "============================================"
if [ "$FAILED" -eq 0 ]; then
  echo " All EntityEvent tests passed."
else
  echo " Some EntityEvent tests FAILED."
fi
echo "============================================"

if [ -f "$REPORT_PATH" ]; then
  echo ""
  echo "Compliance Report:"
  cat "$REPORT_PATH"
  echo ""
fi

exit $FAILED
