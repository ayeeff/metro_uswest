// scripts/extract-pmtiles-metro.mjs
// Extracts granular urban layers from vector tiles (exported by tile-join):
// 1. water.json (GeoJSON water lines and polygons)
// 2. water-rings.json (Array of outer coordinate rings for simulation water masks)
// 3. pois.json (GeoJSON points of interest)
// 4. landmarks.json (GeoJSON filtered civic landmarks and employment hubs)
// 5. areas.json (GeoJSON neighborhoods, suburbs, quarters)
// 6. districts.json (GeoJSON boroughs and administrative districts)
// 7. streets.json (GeoJSON routable road network)
// 8. streets.bin (Packed binary vertex coordinates for pathfinding)

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { decompressSync } from 'fflate';

const require = createRequire(import.meta.url);
const { VectorTile } = require('@mapbox/vector-tile');
const PbfModule = require('pbf');
const PbfReader = PbfModule.PbfReader || PbfModule.default || PbfModule;

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i === -1 ? d : argv[i + 1];
};

const tilesDir = flag('tiles-dir', null);
const outDir = flag('out-dir', './out');
const cityName = flag('city', 'city');
const targetZoom = parseInt(flag('zoom', '14'), 10);

if (!tilesDir) {
  console.error('Error: specify --tiles-dir <path>');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });

function tileCoordsToLngLat(px, py, z, x, y, extent = 4096) {
  const n = Math.pow(2, z);
  const lon = ((x + px / extent) / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + py / extent) / n)));
  const lat = (latRad * 180) / Math.PI;
  return [Number(lon.toFixed(6)), Number(lat.toFixed(6))];
}

function findTileFiles(dir) {
  const results = [];
  function recurse(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        recurse(full);
      } else if (entry.name.endsWith('.pbf') || entry.name.endsWith('.mvt')) {
        const parts = full.replace(/\\/g, '/').split('/');
        const len = parts.length;
        const z = parseInt(parts[len - 3], 10);
        const x = parseInt(parts[len - 2], 10);
        const y = parseInt(parts[len - 1].split('.')[0], 10);
        if (!isNaN(z) && !isNaN(x) && !isNaN(y)) {
          results.push({ path: full, z, x, y });
        }
      }
    }
  }
  recurse(dir);
  return results;
}

async function main() {
  console.log(`[METRO EXTRACT] Processing granular layers for ${cityName}...`);

  const tileFiles = findTileFiles(tilesDir);
  console.log(`  Found ${tileFiles.length} tile files in ${tilesDir}`);
  if (tileFiles.length === 0) {
    console.warn('  No tile files found.');
    return;
  }

  const maxZ = Math.min(targetZoom, Math.max(...tileFiles.map(t => t.z)));
  const activeTiles = tileFiles.filter(t => t.z === maxZ);
  console.log(`  Processing ${activeTiles.length} tiles at zoom z=${maxZ}...`);

  const waterFeatures = [];
  const waterRings = [];
  const poisFeatures = [];
  const landmarksFeatures = [];
  const areasFeatures = [];
  const districtsFeatures = [];
  const streetsFeatures = [];
  const streetLines = []; // for streets.bin
  const parksFeatures = [];
  const landuseFeatures = [];
  const landuseRings = []; // for landuse.bin

  const seenPois = new Set();
  const seenPlaces = new Set();

  for (const t of activeTiles) {
    let buf = fs.readFileSync(t.path);
    try { buf = decompressSync(buf); } catch {}

    let vt;
    try {
      vt = new VectorTile(new PbfReader(buf));
    } catch {
      continue;
    }

    const { z, x, y } = t;

    // 1. WATER LAYER
    const waterLayer = vt.layers['water'];
    if (waterLayer) {
      const extent = waterLayer.extent || 4096;
      for (let i = 0; i < waterLayer.length; i++) {
        const feat = waterLayer.feature(i);
        const geom = feat.loadGeometry();
        const props = {
          name: feat.properties.name || feat.properties['name:en'] || '',
          kind: feat.properties.kind || 'water',
          kind_detail: feat.properties.kind_detail || ''
        };

        if (feat.type === 2) {
          // LineString (river, canal, stream)
          for (const line of geom) {
            if (line.length < 2) continue;
            const coords = line.map(pt => tileCoordsToLngLat(pt.x, pt.y, z, x, y, extent));
            waterFeatures.push({
              type: 'Feature',
              geometry: { type: 'LineString', coordinates: coords },
              properties: props
            });
          }
        } else if (feat.type === 3) {
          // Polygon (lake, bay, reservoir, ocean)
          const rings = [];
          for (let rIdx = 0; rIdx < geom.length; rIdx++) {
            const ring = geom[rIdx];
            if (ring.length < 3) continue;
            const coords = ring.map(pt => tileCoordsToLngLat(pt.x, pt.y, z, x, y, extent));
            rings.push(coords);
            if (rIdx === 0 && coords.length >= 4) {
              waterRings.push(coords);
            }
          }
          if (rings.length > 0) {
            waterFeatures.push({
              type: 'Feature',
              geometry: { type: 'Polygon', coordinates: rings },
              properties: props
            });
          }
        }
      }
    }

    // 2. POIS LAYER
    const poisLayer = vt.layers['pois'];
    if (poisLayer) {
      const extent = poisLayer.extent || 4096;
      for (let i = 0; i < poisLayer.length; i++) {
        const feat = poisLayer.feature(i);
        if (feat.type !== 1) continue; // Points only
        const geom = feat.loadGeometry();
        if (!geom[0] || !geom[0][0]) continue;

        const coords = tileCoordsToLngLat(geom[0][0].x, geom[0][0].y, z, x, y, extent);
        const name = feat.properties.name || feat.properties['name:en'] || '';
        const kind = feat.properties.kind || 'amenity';
        const key = `${name}|${coords[0]}|${coords[1]}`;
        if (seenPois.has(key)) continue;
        seenPois.add(key);

        const feature = {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: coords },
          properties: {
            name,
            kind,
            kind_detail: feat.properties.kind_detail || '',
            elevation: feat.properties.elevation || null,
            iata: feat.properties.iata || null
          }
        };
        poisFeatures.push(feature);

        const isLandmark = [
          'landmark', 'monument', 'museum', 'viewpoint', 'attraction',
          'aerodrome', 'railway_station', 'hospital', 'university', 'townhall',
          'castle', 'tower', 'stadium', 'theatre', 'theme_park'
        ].includes(kind);

        if (isLandmark) {
          landmarksFeatures.push(feature);
        }
      }
    }

    // 3. PLACES & BOUNDARIES LAYER
    const placesLayer = vt.layers['places'];
    if (placesLayer) {
      const extent = placesLayer.extent || 4096;
      for (let i = 0; i < placesLayer.length; i++) {
        const feat = placesLayer.feature(i);
        if (feat.type !== 1) continue;
        const geom = feat.loadGeometry();
        if (!geom[0] || !geom[0][0]) continue;

        const coords = tileCoordsToLngLat(geom[0][0].x, geom[0][0].y, z, x, y, extent);
        const name = feat.properties.name || feat.properties['name:en'] || '';
        const kind = feat.properties.kind || 'locality';
        const key = `${name}|${coords[0]}|${coords[1]}`;
        if (seenPlaces.has(key)) continue;
        seenPlaces.add(key);

        const feature = {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: coords },
          properties: {
            name,
            name_en: feat.properties['name:en'] || '',
            kind,
            kind_detail: feat.properties.kind_detail || '',
            population: feat.properties.population || null,
            wikidata: feat.properties.wikidata || null
          }
        };

        if (['neighbourhood', 'suburb', 'quarter', 'locality', 'village'].includes(kind)) {
          areasFeatures.push(feature);
        } else if (['district', 'borough', 'city', 'town'].includes(kind)) {
          districtsFeatures.push(feature);
        }
      }
    }

    // 4. ROADS LAYER
    const roadsLayer = vt.layers['roads'];
    if (roadsLayer) {
      const extent = roadsLayer.extent || 4096;
      for (let i = 0; i < roadsLayer.length; i++) {
        const feat = roadsLayer.feature(i);
        if (feat.type !== 2) continue; // LineStrings
        const geom = feat.loadGeometry();
        const props = {
          name: feat.properties.name || feat.properties['name:en'] || '',
          kind: feat.properties.kind || 'road',
          kind_detail: feat.properties.kind_detail || '',
          ref: feat.properties.ref || '',
          oneway: feat.properties.oneway === 'yes',
          is_bridge: !!feat.properties.is_bridge,
          is_tunnel: !!feat.properties.is_tunnel
        };

        for (const line of geom) {
          if (line.length < 2) continue;
          const coords = line.map(pt => tileCoordsToLngLat(pt.x, pt.y, z, x, y, extent));
          streetsFeatures.push({
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: coords },
            properties: props
          });
          streetLines.push(coords);
        }
      }
    }

    // 5. LANDUSE & PARKS LAYER
    const landuseLayer = vt.layers['landuse'];
    if (landuseLayer) {
      const extent = landuseLayer.extent || 4096;
      for (let i = 0; i < landuseLayer.length; i++) {
        const feat = landuseLayer.feature(i);
        if (feat.type !== 3) continue; // Polygons only
        const geom = feat.loadGeometry();
        const kind = feat.properties.kind || feat.properties.class || 'landuse';
        const name = feat.properties.name || feat.properties['name:en'] || '';
        const props = { name, kind, kind_detail: feat.properties.kind_detail || '' };

        const rings = [];
        for (let rIdx = 0; rIdx < geom.length; rIdx++) {
          const ring = geom[rIdx];
          if (ring.length < 3) continue;
          const coords = ring.map(pt => tileCoordsToLngLat(pt.x, pt.y, z, x, y, extent));
          rings.push(coords);
          if (rIdx === 0 && coords.length >= 4) {
            landuseRings.push(coords);
          }
        }

        if (rings.length > 0) {
          const polygonFeature = {
            type: 'Feature',
            geometry: { type: 'Polygon', coordinates: rings },
            properties: props
          };
          landuseFeatures.push(polygonFeature);

          const isPark = [
            'park', 'forest', 'meadow', 'grass', 'wood', 'nature_reserve',
            'garden', 'recreation_ground', 'pitch', 'playground', 'greenery',
            'allotments', 'village_green', 'golf_course'
          ].includes(kind);

          if (isPark) {
            parksFeatures.push(polygonFeature);
          }
        }
      }
    }
  }

  // --- WRITE WATER ARTIFACTS ---
  if (waterFeatures.length > 0) {
    const waterPath = path.join(outDir, 'water.json');
    fs.writeFileSync(waterPath, JSON.stringify({ type: 'FeatureCollection', features: waterFeatures }));
    console.log(`  ✓ Wrote water.json (${waterFeatures.length} features, ${(fs.statSync(waterPath).size / 1024).toFixed(1)} KB)`);

    const ringsPath = path.join(outDir, 'water-rings.json');
    fs.writeFileSync(ringsPath, JSON.stringify(waterRings));
    console.log(`  ✓ Wrote water-rings.json (${waterRings.length} rings, ${(fs.statSync(ringsPath).size / 1024).toFixed(1)} KB)`);
  }

  // --- WRITE POIS & LANDMARKS ---
  if (poisFeatures.length > 0) {
    const poisPath = path.join(outDir, 'pois.json');
    fs.writeFileSync(poisPath, JSON.stringify({ type: 'FeatureCollection', features: poisFeatures }));
    console.log(`  ✓ Wrote pois.json (${poisFeatures.length} features)`);
  }
  if (landmarksFeatures.length > 0) {
    const landPath = path.join(outDir, 'landmarks.json');
    fs.writeFileSync(landPath, JSON.stringify({ type: 'FeatureCollection', features: landmarksFeatures }));
    console.log(`  ✓ Wrote landmarks.json (${landmarksFeatures.length} features)`);
  }

  // --- WRITE AREAS & DISTRICTS ---
  if (areasFeatures.length > 0) {
    const areasPath = path.join(outDir, 'areas.json');
    fs.writeFileSync(areasPath, JSON.stringify({ type: 'FeatureCollection', features: areasFeatures }));
    console.log(`  ✓ Wrote areas.json (${areasFeatures.length} features)`);
  }
  if (districtsFeatures.length > 0) {
    const distPath = path.join(outDir, 'districts.json');
    fs.writeFileSync(distPath, JSON.stringify({ type: 'FeatureCollection', features: districtsFeatures }));
    console.log(`  ✓ Wrote districts.json (${districtsFeatures.length} features)`);
  }

  // --- WRITE STREETS & STREETS.BIN ---
  if (streetsFeatures.length > 0) {
    const streetsPath = path.join(outDir, 'streets.json');
    fs.writeFileSync(streetsPath, JSON.stringify({ type: 'FeatureCollection', features: streetsFeatures }));
    console.log(`  ✓ Wrote streets.json (${streetsFeatures.length} features)`);

    // Pack streets.bin (TKST binary buffer)
    let totalVerts = 0;
    let minLon = 180, minLat = 90;
    for (const line of streetLines) {
      totalVerts += line.length;
      for (const [lon, lat] of line) {
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
      }
    }

    const lineCount = streetLines.length;
    const headerSize = 32;
    const indexSize = lineCount * 4;
    const vertSize = totalVerts * 4;
    const totalBinSize = headerSize + indexSize + vertSize;

    const binBuf = Buffer.alloc(totalBinSize);
    binBuf.write('TKST', 0, 4, 'ascii');
    binBuf.writeUInt32LE(1, 4);
    binBuf.writeUInt32LE(lineCount, 8);
    binBuf.writeUInt32LE(totalVerts, 12);
    binBuf.writeInt32LE(Math.round(minLon * 1e6), 16);
    binBuf.writeInt32LE(Math.round(minLat * 1e6), 20);
    binBuf.writeInt32LE(0, 24);
    binBuf.writeInt32LE(13, 28);

    let currentOffset = 0;
    let vertByteOffset = headerSize + indexSize;
    const scale = 1e5;

    for (let i = 0; i < lineCount; i++) {
      binBuf.writeUInt32LE(currentOffset, headerSize + i * 4);
      const line = streetLines[i];
      for (const [vLon, vLat] of line) {
        const dx = Math.round((vLon - minLon) * scale);
        const dy = Math.round((vLat - minLat) * scale);
        binBuf.writeInt16LE(Math.max(-32768, Math.min(32767, dx)), vertByteOffset);
        binBuf.writeInt16LE(Math.max(-32768, Math.min(32767, dy)), vertByteOffset + 2);
        vertByteOffset += 4;
        currentOffset++;
      }
    }

    const binPath = path.join(outDir, 'streets.bin');
    fs.writeFileSync(binPath, binBuf);
    console.log(`  ✓ Wrote streets.bin (${(binBuf.length / (1024 * 1024)).toFixed(2)} MB)`);
  }

  // --- WRITE LANDUSE & PARKS ARTIFACTS ---
  if (parksFeatures.length > 0) {
    const parksPath = path.join(outDir, 'parks.json');
    fs.writeFileSync(parksPath, JSON.stringify({ type: 'FeatureCollection', features: parksFeatures }));
    console.log(`  ✓ Wrote parks.json (${parksFeatures.length} features, ${(fs.statSync(parksPath).size / 1024).toFixed(1)} KB)`);
  }
  if (landuseFeatures.length > 0) {
    const luPath = path.join(outDir, 'landuse.json');
    fs.writeFileSync(luPath, JSON.stringify({ type: 'FeatureCollection', features: landuseFeatures }));
    console.log(`  ✓ Wrote landuse.json (${landuseFeatures.length} features, ${(fs.statSync(luPath).size / 1024).toFixed(1)} KB)`);

    // Pack landuse.bin (TKLU binary format)
    let totalVerts = 0;
    let minLon = 180, minLat = 90;
    for (const ring of landuseRings) {
      totalVerts += ring.length;
      for (const [lon, lat] of ring) {
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
      }
    }

    const polyCount = landuseRings.length;
    const headerSize = 32;
    const indexSize = polyCount * 4;
    const vertSize = totalVerts * 4;
    const totalBinSize = headerSize + indexSize + vertSize;

    const binBuf = Buffer.alloc(totalBinSize);
    binBuf.write('TKLU', 0, 4, 'ascii');
    binBuf.writeUInt32LE(1, 4);
    binBuf.writeUInt32LE(polyCount, 8);
    binBuf.writeUInt32LE(totalVerts, 12);
    binBuf.writeInt32LE(Math.round(minLon * 1e6), 16);
    binBuf.writeInt32LE(Math.round(minLat * 1e6), 20);
    binBuf.writeInt32LE(0, 24);
    binBuf.writeInt32LE(13, 28);

    let currentOffset = 0;
    let vertByteOffset = headerSize + indexSize;
    const scale = 1e5;

    for (let i = 0; i < polyCount; i++) {
      binBuf.writeUInt32LE(currentOffset, headerSize + i * 4);
      const ring = landuseRings[i];
      for (const [vLon, vLat] of ring) {
        const dx = Math.round((vLon - minLon) * scale);
        const dy = Math.round((vLat - minLat) * scale);
        binBuf.writeInt16LE(Math.max(-32768, Math.min(32767, dx)), vertByteOffset);
        binBuf.writeInt16LE(Math.max(-32768, Math.min(32767, dy)), vertByteOffset + 2);
        vertByteOffset += 4;
        currentOffset++;
      }
    }

    const binPath = path.join(outDir, 'landuse.bin');
    fs.writeFileSync(binPath, binBuf);
    console.log(`  ✓ Wrote landuse.bin (${(binBuf.length / (1024 * 1024)).toFixed(2)} MB)`);
  }
}

main().catch(err => {
  console.error('[METRO EXTRACT ERROR]', err);
  process.exit(1);
});
