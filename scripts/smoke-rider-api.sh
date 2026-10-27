#!/usr/bin/env bash
# Smoke: login → me → orders → route → location
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
IDENTIFIER="${RIDER_IDENTIFIER:?set RIDER_IDENTIFIER}"
PASSWORD="${RIDER_PASSWORD:?set RIDER_PASSWORD}"

echo "== login =="
LOGIN=$(curl -sS -X POST "$BASE_URL/api/v1/rider/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"identifier\":\"$IDENTIFIER\",\"password\":\"$PASSWORD\"}")
echo "$LOGIN" | head -c 400
echo

TOKEN=$(node -e "const j=JSON.parse(process.argv[1]); if(!j.success) process.exit(1); process.stdout.write(j.data.accessToken)" "$LOGIN")

echo "== me =="
curl -sS "$BASE_URL/api/v1/rider/auth/me" -H "Authorization: Bearer $TOKEN" | head -c 400
echo

echo "== orders =="
curl -sS "$BASE_URL/api/v1/rider/orders" -H "Authorization: Bearer $TOKEN" | head -c 400
echo

echo "== route =="
curl -sS "$BASE_URL/api/v1/rider/route" -H "Authorization: Bearer $TOKEN" | head -c 400
echo

echo "== location =="
curl -sS -X POST "$BASE_URL/api/v1/rider/location" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"latitude\":24.86,\"longitude\":67.00,\"recordedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"isOnDuty\":true}" | head -c 400
echo

echo "OK"
