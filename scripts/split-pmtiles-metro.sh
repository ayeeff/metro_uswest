#!/usr/bin/env bash
# scripts/split-pmtiles-metro.sh
# Extracts granular urban layers from <slug>.pmtiles using tile-join:
# 1. water.json + water-rings.json (100% upload to fill 1,252 misses)
# 2. pois.json + landmarks.json (backfills missing)
# 3. areas.json + districts.json (backfills missing)
# 4. streets.json + streets.bin (backfills missing)
#
# Usage:
#   ./scripts/split-pmtiles-metro.sh amsterdam

set -uo pipefail

SLUG="${1:-}"
if [ -z "$SLUG" ]; then
  echo "Usage: $0 <city-slug>"
  exit 1
fi

R2_ACCOUNT_ID="${CF_ACCOUNT_ID:-${R2_DATALAKE_ACCOUNT_ID:-${R2_ACCOUNT_ID:-5d469620e5b9363beae1cb2e4e290aee}}}"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
WORKDIR="/tmp/metro-${SLUG}"
mkdir -p "$WORKDIR"

echo "=== Processing city: ${SLUG} ==="

# 1. Download source PMTiles from R2
echo "[1/4] Downloading s3://globe/data/${SLUG}-2d/${SLUG}.pmtiles..."
if ! aws s3 cp "s3://globe/data/${SLUG}-2d/${SLUG}.pmtiles" "${WORKDIR}/input.pmtiles" --endpoint-url "$ENDPOINT"; then
  echo "  [SKIP] s3://globe/data/${SLUG}-2d/${SLUG}.pmtiles not found in R2."
  rm -rf "$WORKDIR"
  exit 0
fi

# 2. Run tile-join to export granular layers to tile folder
echo "[2/4] Running tile-join to extract water, pois, places, roads..."
mkdir -p "${WORKDIR}/tiles"
tile-join -e "${WORKDIR}/tiles" \
  --layer=water \
  --layer=pois \
  --layer=places \
  --layer=roads \
  "${WORKDIR}/input.pmtiles" || true

# 3. Run Node extractor to produce JSON / BIN artifacts
echo "[3/4] Generating water, POIs, places, and street network artifacts..."
mkdir -p "${WORKDIR}/out"
node scripts/extract-pmtiles-metro.mjs \
  --tiles-dir "${WORKDIR}/tiles" \
  --out-dir "${WORKDIR}/out" \
  --city "${SLUG}" || true

# 4. Upload to R2 globe bucket
echo "[4/4] Uploading artifacts to R2 (s3://globe/data/${SLUG}-2d/)..."

# Immediate 100% Win: water.json and water-rings.json
if [ -f "${WORKDIR}/out/water.json" ]; then
  aws s3 cp "${WORKDIR}/out/water.json" "s3://globe/data/${SLUG}-2d/water.json" --endpoint-url "$ENDPOINT"
  echo "  ✓ Uploaded water.json"
fi

if [ -f "${WORKDIR}/out/water-rings.json" ]; then
  aws s3 cp "${WORKDIR}/out/water-rings.json" "s3://globe/data/${SLUG}-2d/water-rings.json" --endpoint-url "$ENDPOINT"
  echo "  ✓ Uploaded water-rings.json"
fi

# Closing the Long Tail & Street Network (backfill if missing in R2, or FORCE=true)
FORCE="${FORCE:-false}"
for FILE in pois.json landmarks.json areas.json districts.json streets.json streets.bin; do
  if [ -f "${WORKDIR}/out/${FILE}" ]; then
    if [ "$FORCE" = "true" ] || ! aws s3 ls "s3://globe/data/${SLUG}-2d/${FILE}" --endpoint-url "$ENDPOINT" >/dev/null 2>&1; then
      aws s3 cp "${WORKDIR}/out/${FILE}" "s3://globe/data/${SLUG}-2d/${FILE}" --endpoint-url "$ENDPOINT"
      echo "  ✓ Backfilled ${FILE}"
    else
      echo "  - ${FILE} already present in R2, preserving."
    fi
  fi
done

# Clean up temporary files
rm -rf "$WORKDIR"
echo "=== Done: ${SLUG} successfully updated in R2! ==="
