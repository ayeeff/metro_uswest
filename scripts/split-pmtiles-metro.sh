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

# 2. Run tile-join to export granular layers (water, pois, places, roads, landuse)
echo "[2/4] Running tile-join to extract water, pois, places, roads, landuse..."
mkdir -p "${WORKDIR}/tiles"
tile-join -e "${WORKDIR}/tiles" \
  --layer=water \
  --layer=pois \
  --layer=places \
  --layer=roads \
  --layer=landuse \
  "${WORKDIR}/input.pmtiles" || true

# Strip landuse & building layers from base PMTiles (shrinks base archive by up to 50%-70%)
echo "  [OPTIMIZE] Stripping landuse and building layers from base PMTiles..."
if tile-join --exclude-layer=landuse --exclude-layer=building -o "${WORKDIR}/stripped.pmtiles" "${WORKDIR}/input.pmtiles" 2>/dev/null; then
  if [ -s "${WORKDIR}/stripped.pmtiles" ]; then
    cp "${WORKDIR}/stripped.pmtiles" "${WORKDIR}/out/${SLUG}.pmtiles"
    echo "  ✓ Generated stripped PMTiles without landuse/building."
  fi
fi

# 3. Run Node extractor to produce JSON / BIN artifacts
echo "[3/4] Generating water, POIs, places, street network, and landuse artifacts..."
mkdir -p "${WORKDIR}/out"
node scripts/extract-pmtiles-metro.mjs \
  --tiles-dir "${WORKDIR}/tiles" \
  --out-dir "${WORKDIR}/out" \
  --city "${SLUG}" || true

# 4. Upload to R2 globe bucket
echo "[4/4] Uploading artifacts to R2 (s3://globe/data/${SLUG}-2d/)..."

# Upload optimized PMTiles if generated
if [ -f "${WORKDIR}/out/${SLUG}.pmtiles" ]; then
  aws s3 cp "${WORKDIR}/out/${SLUG}.pmtiles" "s3://globe/data/${SLUG}-2d/${SLUG}.pmtiles" --endpoint-url "$ENDPOINT"
  echo "  ✓ Uploaded optimized s3://globe/data/${SLUG}-2d/${SLUG}.pmtiles (landuse stripped)"
fi

# Immediate 100% Win: water.json and water-rings.json
if [ -f "${WORKDIR}/out/water.json" ]; then
  aws s3 cp "${WORKDIR}/out/water.json" "s3://globe/data/${SLUG}-2d/water.json" --endpoint-url "$ENDPOINT"
  echo "  ✓ Uploaded water.json"
fi

if [ -f "${WORKDIR}/out/water-rings.json" ]; then
  aws s3 cp "${WORKDIR}/out/water-rings.json" "s3://globe/data/${SLUG}-2d/water-rings.json" --endpoint-url "$ENDPOINT"
  echo "  ✓ Uploaded water-rings.json"
fi

# Landuse & Parks Artifacts
for FILE in parks.json landuse.json landuse.bin; do
  if [ -f "${WORKDIR}/out/${FILE}" ]; then
    aws s3 cp "${WORKDIR}/out/${FILE}" "s3://globe/data/${SLUG}-2d/${FILE}" --endpoint-url "$ENDPOINT"
    echo "  ✓ Uploaded ${FILE}"
  fi
done

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
