#!/bin/sh
set -e

# ---------------------------------------------------------------------------
# MCP server smoke test
#
# Verifies the reso-mcp-server Docker image starts, responds to MCP
# initialize and tools/list, and successfully calls the metadata, query,
# and parse-filter tools against the reference server.
#
# Exit code 0 = all checks pass, non-zero = at least one check failed.
# ---------------------------------------------------------------------------

SERVER_URL="${SERVER_URL:-http://server:8080}"
AUTH_TOKEN="${AUTH_TOKEN:-admin-token}"

echo "============================================"
echo " RESO MCP Server Smoke Test"
echo "============================================"
echo "Server: $SERVER_URL"
echo ""

# Wait for the reference server to be reachable
echo "Waiting for server..."
until wget -qO- "$SERVER_URL/health" > /dev/null 2>&1; do sleep 2; done
echo "Server is up."
echo ""

# Seed the static dataset so the query tools return something
echo "Loading static seed data..."
wget -qO- --post-data='{}' \
  --header="Content-Type: application/json" \
  --header="Authorization: Bearer $AUTH_TOKEN" \
  "$SERVER_URL/admin/seed" > /dev/null || true
echo "Seed complete."
echo ""

# Run JSON-RPC requests through the MCP server, capture all responses
echo "Running MCP smoke test..."
RESULT=$({
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"metadata\",\"arguments\":{\"url\":\"$SERVER_URL\",\"authToken\":\"$AUTH_TOKEN\"}}}"
  printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"query\",\"arguments\":{\"url\":\"$SERVER_URL\",\"resource\":\"Property\",\"authToken\":\"$AUTH_TOKEN\",\"top\":1,\"select\":\"ListingKey\"}}}"
  printf '%s\n' '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"parse-filter","arguments":{"filter":"ListPrice gt 200000"}}}'
} | node /app/dist/index.js 2>&1)

# Verify each expected response is present in the output. Each MCP response is
# a single JSON line; we extract by id then check for required content/no error.
FAILED=0
check() {
  label=$1
  id=$2
  required=$3
  line=$(echo "$RESULT" | grep "\"id\":$id" || true)
  if [ -z "$line" ]; then
    echo "  FAIL  $label — no response with id=$id"
    FAILED=$((FAILED + 1))
    return
  fi
  if echo "$line" | grep -q '"error"'; then
    echo "  FAIL  $label — JSON-RPC error: $(echo "$line" | head -c 200)"
    FAILED=$((FAILED + 1))
    return
  fi
  if ! echo "$line" | grep -q "$required"; then
    echo "  FAIL  $label — missing expected content '$required'"
    FAILED=$((FAILED + 1))
    return
  fi
  echo "  PASS  $label"
}

check "initialize"        1 "protocolVersion"
check "tools/list"        2 '"name":"metadata-report"'
check "metadata tool"     3 "ListingKey"
check "query tool"        4 "ListingKey"
check "parse-filter tool" 5 "comparison"

echo ""
if [ $FAILED -eq 0 ]; then
  echo "All MCP smoke tests passed."
  exit 0
else
  echo "$FAILED check(s) failed."
  echo ""
  echo "--- Full output ---"
  echo "$RESULT"
  exit 1
fi
