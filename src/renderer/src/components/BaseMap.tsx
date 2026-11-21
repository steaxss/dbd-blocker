// Offline vector basemap (Natural Earth 1:50m, public domain, via world-atlas).
// No tile server: no API key, no third-party request revealing the user's IP, works offline.
import { useMemo } from 'react'
import { GeoJSON } from 'react-leaflet'
import { feature, mesh } from 'topojson-client'
import type { GeometryCollection, Topology } from 'topojson-specification'
import type { Feature, FeatureCollection, MultiLineString, MultiPolygon, Position } from 'geojson'
import world from 'world-atlas/countries-50m.json'

const topology = world as unknown as Topology<{ countries: GeometryCollection; land: GeometryCollection }>

const LAND_STYLE = { fillColor: '#18181d', fillOpacity: 1, color: '#18181d', weight: 0, interactive: false }
const BORDER_STYLE = { color: '#2c2c35', weight: 0.7, opacity: 1, fill: false, interactive: false }

/**
 * world-atlas is meant for d3, which cuts shapes at the antimeridian. Leaflet draws a straight edge
 * from +180 to -180 instead, smearing Russia / Fiji / Antarctica across the whole map.
 * Unwrap each ring so longitudes are continuous, then add a copy shifted by 360 for the overflowing part.
 */
function unwrap(line: Position[]): Position[] {
  const out: Position[] = []
  let offset = 0
  for (let i = 0; i < line.length; i++) {
    const [lng, lat] = line[i]
    if (i > 0) {
      const delta = lng - line[i - 1][0]
      if (delta > 180) offset -= 360
      else if (delta < -180) offset += 360
    }
    out.push([lng + offset, lat])
  }
  return out
}

function shifted(lines: Position[][]): Position[][][] {
  const lngs = lines.flat().map((p) => p[0])
  const copies: Position[][][] = [lines]
  if (Math.max(...lngs) > 180) copies.push(lines.map((l) => l.map(([x, y]) => [x - 360, y])))
  if (Math.min(...lngs) < -180) copies.push(lines.map((l) => l.map(([x, y]) => [x + 360, y])))
  return copies
}

function fixPolygons(fc: FeatureCollection): FeatureCollection {
  const polygons: Position[][][] = []
  for (const f of fc.features) {
    const g = f.geometry
    const list = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []
    for (const rings of list) polygons.push(...shifted(rings.map(unwrap)))
  }
  const merged: Feature<MultiPolygon> = { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: polygons } }
  return { type: 'FeatureCollection', features: [merged] }
}

function fixLines(ml: MultiLineString): MultiLineString {
  const lines: Position[][] = []
  for (const line of ml.coordinates) for (const copy of shifted([unwrap(line)])) lines.push(...copy)
  return { type: 'MultiLineString', coordinates: lines }
}

export function BaseMap() {
  const { land, borders } = useMemo(() => ({
    land: fixPolygons(feature(topology, topology.objects.land) as unknown as FeatureCollection),
    borders: fixLines(mesh(topology, topology.objects.countries, (a, b) => a !== b) as MultiLineString),
  }), [])

  return (
    <>
      <GeoJSON data={land} style={() => LAND_STYLE} interactive={false} />
      <GeoJSON data={borders} style={() => BORDER_STYLE} interactive={false} />
    </>
  )
}
