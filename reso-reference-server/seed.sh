#!/usr/bin/env bash
# RESO Reference Server — Seed Data Script
#
# Loads the committed static seed dataset (seed-data/seed.json.gz) into a running
# reference server via POST /admin/seed. The server inserts it through the DAL with
# FK links preserved. Idempotent — re-running is a no-op once the server is seeded.
# Works with both Docker and locally running server instances.
#
# Usage:
#   ./seed.sh                                    # Defaults: localhost:8080, admin-token
#   ./seed.sh http://localhost:8080               # Custom URL
#   ./seed.sh http://localhost:8080 my-admin-tok  # Custom URL and token
#   ./seed.sh http://server:8080 admin-token      # Docker internal URL

set -e

URL="${1:-http://localhost:8080}"
TOKEN="${2:-admin-token}"

echo "RESO Reference Server — Seed Data"
echo "  Server: $URL"
echo ""

# Wait for server to be ready
echo "Waiting for server..."
until curl -sf "$URL/health" > /dev/null 2>&1; do
  sleep 2
done
echo "Server is ready."
echo ""

echo "Loading static seed data (Property, Member, Office, Media and related resources)..."
curl -sf -X POST "$URL/admin/seed" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  | tee /dev/stderr | jq -r '"  \(.message): \(.loaded) records loaded"' 2>/dev/null || true
echo ""

echo "Seed complete."
