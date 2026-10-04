# metro_uswest

Stations and route geometry for every `*-metro-train-atlas` page in the osm_uswest region (54 cities, 22 jobs).

Per city this produces:
- `transit-stations.json` - every named station as a GeoJSON Point, coloured by mode on the atlas
- `transit-lines.json` - every rail route as a LineString, coloured from the OSM `colour` tag where a mapper set one

No ranking and no top-N: OSM carries no ridership for stations, so nothing here claims to be the busiest or most important anything.

Split out of `ayeeff/osm_uswest` because that pipeline early-returns when neighbourhoods come back empty, which silently skipped the transit step: green jobs, zero files. This job never consults neighbourhoods.

Sourced from staged R2 extracts only (`sources/osm/<extract>-latest.osm.pbf`). Never a public Overpass mirror.
