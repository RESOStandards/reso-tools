#!/bin/sh
set -e

# ---------------------------------------------------------------------------
# Add/Edit (RCP-010) compliance entrypoint
#
# 1. Seed the static dataset (POST /admin/seed)
# 2. Run the reso-cert add-edit pipeline (handles health check, metadata,
#    record sampling, payload generation, test execution, and reports)
# ---------------------------------------------------------------------------

SERVER_URL="${SERVER_URL:-http://server:8080}"
AUTH_TOKEN="${AUTH_TOKEN:-admin-token}"
RESOURCE="${RESOURCE:-Property}"

echo "============================================"
echo " RESO Add/Edit (RCP-010) Compliance Test"
echo "============================================"
echo "Server:   $SERVER_URL"
echo "Resource: $RESOURCE"
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
exec node /app/dist/cli/index.js add-edit \
  --url "$SERVER_URL" \
  --resource "$RESOURCE" \
  --auth-token "$AUTH_TOKEN" \
  --verbose \
  --output-dir /tmp/compliance-results \
  --spec-version "${SPEC_VERSION:-2.0.0}"
