// Offline vector basemap (Natural Earth 1:50m, public domain, via world-atlas).
// No tile server: no API key, no third-party request revealing the user's IP, works offline.
import { useMemo, useState } from 'react'
import { GeoJSON, Marker, Pane, useMap, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import polylabel from 'polylabel'
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

// ---- country labels (English, from Natural Earth) --------------------------------------------

/** Natural Earth short forms that read poorly on a map. */
const NAME_OVERRIDES: Record<string, string> = {
  'United States of America': 'United States',
  'Dem. Rep. Congo': 'DR Congo',
  'Central African Rep.': 'Central African Republic',
  'Dominican Rep.': 'Dominican Republic',
  'Bosnia and Herz.': 'Bosnia and Herzegovina',
  'S. Sudan': 'South Sudan',
  'Eq. Guinea': 'Equatorial Guinea',
  'W. Sahara': 'Western Sahara',
  'N. Cyprus': 'Northern Cyprus',
  'Falkland Is.': 'Falkland Islands',
  'Solomon Is.': 'Solomon Islands',
  'Marshall Is.': 'Marshall Islands',
  'Fr. Polynesia': 'French Polynesia',
  'Fr. S. Antarctic Lands': 'French Southern Lands',
  'Faeroe Is.': 'Faroe Islands',
  'Antigua and Barb.': 'Antigua and Barbuda',
}

/**
 * Minimum size (approx. 1° x 1° cells at the equator, ~12,400 km²) for a label to show at a zoom level:
 * only large countries at world scale, everything once zoomed in.
 */
const MIN_AREA_BY_ZOOM: Record<number, number> = { 2: 150, 3: 30, 4: 5, 5: 0.8 }

interface CountryLabel {
  name: string
  position: [number, number] // [lat, lng]
  area: number
}

/**
 * Ring area in "equatorial square degrees": shoelace formula on the sinusoidal projection
 * (x = lng * cos(lat), y = lat), which is equal-area, so high-latitude countries are not inflated.
 */
function ringArea(ring: Position[]): number {
  const project = ([lng, lat]: Position): [number, number] => [lng * Math.cos((lat * Math.PI) / 180), lat]
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = project(ring[j])
    const [x2, y2] = project(ring[i])
    sum += x1 * y2 - x2 * y1
  }
  return Math.abs(sum / 2)
}

function computeLabels(): CountryLabel[] {
  const countries = feature(topology, topology.objects.countries) as unknown as FeatureCollection
  const labels: CountryLabel[] = []
  for (const f of countries.features) {
    const raw = (f.properties as { name?: string } | null)?.name
    if (!raw || raw === 'Antarctica') continue
    const g = f.geometry
    const polygons = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []
    let best: Position[][] | null = null
    let bestArea = 0
    let total = 0
    for (const rings of polygons) {
      const unwrapped = rings.map(unwrap)
      const a = ringArea(unwrapped[0])
      total += a
      if (a > bestArea) { bestArea = a; best = unwrapped }
    }
    if (!best) continue
    // Label inside the main landmass (pole of inaccessibility, not the centroid which can fall outside).
    const [lngRaw, lat] = polylabel(best as number[][][], 0.2)
    const lng = ((lngRaw + 540) % 360) - 180
    labels.push({ name: NAME_OVERRIDES[raw] ?? raw, position: [lat, lng], area: total })
  }
  return labels.sort((a, b) => b.area - a.area)
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

const iconCache = new Map<string, L.DivIcon>()
function labelIcon(name: string, large: boolean): L.DivIcon {
  const key = `${name}|${large}`
  let icon = iconCache.get(key)
  if (!icon) {
    icon = L.divIcon({
      className: 'country-label',
      html: `<span class="${large ? 'country-label-lg' : ''}">${escapeHtml(name)}</span>`,
      iconSize: [0, 0],
    })
    iconCache.set(key, icon)
  }
  return icon
}

function CountryLabels() {
  const map = useMap()
  const [zoom, setZoom] = useState(() => map.getZoom())
  useMapEvents({ zoomend: () => setZoom(map.getZoom()) })
  const labels = useMemo(computeLabels, [])

  const minArea = MIN_AREA_BY_ZOOM[Math.round(zoom)] ?? (zoom < 2 ? Infinity : 0)
  const visible = labels.filter((l) => l.area >= minArea)

  return (
    <Pane name="country-labels" style={{ zIndex: 450, pointerEvents: 'none' }}>
      {visible.map((l) => (
        <Marker
          key={l.name}
          position={l.position}
          icon={labelIcon(l.name, l.area >= 150)}
          pane="country-labels"
          interactive={false}
          keyboard={false}
        />
      ))}
    </Pane>
  )
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
      <CountryLabels />
    </>
  )
}
