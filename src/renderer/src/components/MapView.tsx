import 'leaflet/dist/leaflet.css'
import { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Circle, useMapEvents } from 'react-leaflet'
import L from 'leaflet'
import { Shield, ShieldOff, MousePointerClick, Wifi } from 'lucide-react'
import { REGIONS, regionsByContinent, BACKEND_REGION_ID } from '../regions'

/** Haversine distance in meters */
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
import { FlagIcon } from './FlagIcon'
import type { RegionState, ServerStatusMap } from '../types'

const DARK_TILES = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'

function MapEvents({ onInteract }: { onInteract: () => void }) {
  useMapEvents({ zoomstart: onInteract, movestart: onInteract })
  return null
}

function makeIcon(status: string, isPermanent: boolean, isSelected: boolean, isGameOffline: boolean): L.DivIcon {
  const blocked = status === 'blocked'
  const loading  = status === 'loading'

  const dotColor = isPermanent && blocked     ? '#FF9800'
                 : blocked                   ? '#F44336'
                 : loading                   ? 'rgba(255,255,255,0.3)'
                 : isGameOffline             ? '#6B7280'
                 :                             '#44FF41'

  const glow = isPermanent && blocked     ? 'rgba(255,152,0,0.75)'
             : blocked                   ? 'rgba(244,67,54,0.75)'
             : loading                   ? 'rgba(255,255,255,0.15)'
             : isGameOffline             ? 'rgba(107,114,128,0.5)'
             :                             'rgba(68,255,65,0.75)'

  const s = isSelected ? 20 : 12
  const border = isSelected
    ? '2px solid rgba(181,121,255,0.95)'
    : '1.5px solid rgba(255,255,255,0.35)'
  const outerRing = isSelected
    ? `, 0 0 0 4px rgba(181,121,255,0.18), 0 0 0 8px rgba(181,121,255,0.07)`
    : ''

  return L.divIcon({
    html: `<div style="width:${s}px;height:${s}px;border-radius:50%;background:${dotColor};border:${border};box-shadow:0 0 ${s + 4}px ${glow}${outerRing};cursor:pointer;transition:all 0.15s ease"></div>`,
    className: '',
    iconSize:   [s, s],
    iconAnchor: [s / 2, s / 2],
    tooltipAnchor: [s / 2 + 4, 0],
  })
}

interface MapViewProps {
  regions:              RegionState[]
  permanentRegions:     string[]
  matchmakingRegions:   string[]
  userLocation:         { lat: number; lng: number } | null
  serverStatus:         ServerStatusMap
  onBlock:              (id: string) => void
  onUnblock:            (id: string) => void
  onPingRegion:         (id: string) => void
  globalLoading:        boolean
}

export function MapView({
  regions,
  permanentRegions,
  matchmakingRegions,
  userLocation,
  serverStatus,
  onBlock,
  onUnblock,
  onPingRegion,
  globalLoading,
}: MapViewProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [hoveredRegion, setHoveredRegion] = useState<string | null>(null)
  const [tooltipPos, setTooltipPos] = useState({ x: 0, y: 0 })
  const [now, setNow] = useState(() => new Date())
  const mapDivRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const toggle = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  const handleMarkerClick = useCallback((id: string) => {
    toggle(id)
  }, [toggle])

  const regionMap = useMemo(() => new Map(regions.map(r => [r.id, r])), [regions])

  const blockedCount  = regions.filter(r => r.status === 'blocked').length
  const selectedCount = selected.size
  // How many selected regions can actually be blocked (excludes backend)
  const blockableSelectedCount = [...selected].filter(id => id !== BACKEND_REGION_ID).length

  function handleBlockSelected() {
    for (const id of selected) {
      if (id === BACKEND_REGION_ID) continue
      const r = regionMap.get(id)
      if (r && r.status !== 'blocked' && r.status !== 'loading') onBlock(id)
    }
  }

  function handleUnblockSelected() {
    for (const id of selected) {
      const r = regionMap.get(id)
      if (r && r.status === 'blocked') onUnblock(id)
    }
  }

  function pingColor(region: RegionState) {
    if (region.pingMs === undefined) return 'rgba(255,255,255,0.25)'
    if (region.pingMs === null) return '#F44336'
    if (region.pingMs < 80) return '#44FF41'
    if (region.pingMs < 150) return '#FF9800'
    return '#F44336'
  }

  function pingLabel(region: RegionState) {
    if (region.pingLoading) return '...'
    if (region.pingMs === undefined) return null
    if (region.pingMs === null) return 'T/O'
    return `${region.pingMs}ms`
  }

  function formatQueueTime(raw: string | null): string | null {
    if (!raw) return null
    const s = parseInt(raw, 10)
    if (isNaN(s)) return raw
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    const r = s % 60
    return r > 0 ? `${m}m ${r}s` : `${m}m`
  }

  return (
    <div className="flex h-full">

      {/* ── Map ── */}
      <div ref={mapDivRef} className="flex-1 relative" onMouseLeave={() => setHoveredRegion(null)}>
        <MapContainer
          center={[20, 15]}
          zoom={2}
          minZoom={2}
          style={{ height: '100%', width: '100%', background: '#0a0a0a' }}
          zoomControl={false}
          attributionControl={false}
        >
          <TileLayer
            url={DARK_TILES}
            attribution='&copy; OpenStreetMap contributors &copy; CARTO'
          />
          <MapEvents onInteract={() => setHoveredRegion(null)} />

          {/* User location marker */}
          {userLocation && (
            <Marker
              position={[userLocation.lat, userLocation.lng]}
              icon={L.divIcon({
                html: `<div style="width:10px;height:10px;border-radius:50%;background:#B579FF;border:2px solid rgba(255,255,255,0.8);box-shadow:0 0 12px rgba(181,121,255,0.9), 0 0 0 4px rgba(181,121,255,0.2);cursor:default"></div>`,
                className: '',
                iconSize: [10, 10],
                iconAnchor: [5, 5],
                tooltipAnchor: [8, 0],
              })}
              interactive={false}
            />
          )}

          {/* Matchmaking area circle */}
          {userLocation && matchmakingRegions.length > 0 && (() => {
            const mmRegionDefs = REGIONS.filter(r => matchmakingRegions.includes(r.id))
            let maxDist = 0
            for (const r of mmRegionDefs) {
              const d = haversineMeters(userLocation.lat, userLocation.lng, r.lat, r.lng)
              if (d > maxDist) maxDist = d
            }
            // Add 15% padding so dots sit inside the circle, minimum 500km
            const radius = Math.max(maxDist * 1.15, 500_000)
            return (
              <Circle
                center={[userLocation.lat, userLocation.lng]}
                radius={radius}
                pathOptions={{
                  color: '#B579FF',
                  weight: 1.5,
                  opacity: 0.5,
                  fillColor: '#B579FF',
                  fillOpacity: 0.06,
                  dashArray: '6 4',
                }}
              />
            )
          })()}

          {REGIONS.map(region => {
            const state    = regionMap.get(region.id)
            if (!state) return null
            const isPerm   = permanentRegions.includes(region.id)
            const isSel    = selected.has(region.id)

            const statusColor = state.status === 'blocked' ? (isPerm ? '#FF9800' : '#F44336') : '#44FF41'
            const statusLabel = isPerm && state.status === 'blocked' ? 'Permanent Block' : state.status.toUpperCase()
            const srv = serverStatus[region.id]
            const qk  = srv ? formatQueueTime(srv.killerQueue)   : null
            const qs  = srv ? formatQueueTime(srv.survivorQueue) : null

            return (
              <Marker
                key={`${region.id}-${state.status}-${isPerm}-${isSel}-${srv?.online ?? 'x'}-${srv?.killerQueue ?? ''}-${srv?.survivorQueue ?? ''}`}
                position={[region.lat, region.lng]}
                icon={makeIcon(state.status, isPerm, isSel, srv !== undefined && !srv.online && state.status !== 'blocked')}
                eventHandlers={{
                  click: () => handleMarkerClick(region.id),
                  mouseover: (e) => {
                    const rect = mapDivRef.current?.getBoundingClientRect()
                    if (rect) {
                      setTooltipPos({
                        x: rect.left + e.containerPoint.x,
                        y: rect.top  + e.containerPoint.y,
                      })
                    }
                    setHoveredRegion(region.id)
                  },
                  mouseout: () => setHoveredRegion(null),
                }}
              >
                {/* Click popup — full detail */}
                {(
                  <Popup autoPan={false} minWidth={230} maxWidth={290}>
                    <div style={{ padding: '14px 16px 12px', fontFamily: 'Poppins, sans-serif' }}>
                      {/* Server ID */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                        <span style={{ fontFamily: 'Poppins, sans-serif', fontSize: 10, fontWeight: 800, color: 'rgba(181,121,255,0.9)', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                          {region.id}
                        </span>
                        {region.id === BACKEND_REGION_ID && (
                          <span style={{ fontSize: 8, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', padding: '1px 5px', borderRadius: 3, background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)', border: '1px solid rgba(255,255,255,0.1)' }}>
                            Backend
                          </span>
                        )}
                      </div>

                      {/* Flag + city + country */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                        <FlagIcon code={region.countryCode} style={{ width: 34, height: 'auto', borderRadius: 4, display: 'block', flexShrink: 0 }} fallback={region.flag} />
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 13, color: '#fff', lineHeight: 1.2 }}>{region.name}</div>
                          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 1 }}>{region.country}</div>
                        </div>
                      </div>

                      {/* Status */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                        <div style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, boxShadow: `0 0 6px ${statusColor}`, flexShrink: 0 }} />
                        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: statusColor }}>
                          {statusLabel}
                        </span>
                        {state.cidrCount > 0 && (
                          <span style={{ marginLeft: 'auto', fontSize: 9, fontFamily: 'monospace', color: 'rgba(255,255,255,0.2)' }}>
                            {state.cidrCount} CIDRs
                          </span>
                        )}
                      </div>

                      {/* Ping result */}
                      {state.pingMs !== undefined && (
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', fontFamily: 'Inter, sans-serif', fontWeight: 500 }}>Your ping on this server</span>
                          <span style={{ fontSize: 12, fontFamily: 'Inter, sans-serif', fontWeight: 700, color: pingColor(state) }}>
                            {state.pingMs === null ? 'Timeout' : `${state.pingMs} ms`}
                          </span>
                        </div>
                      )}

                      {/* Game server status */}
                      {srv && (
                        <div style={{
                          marginBottom: 10,
                          padding: '8px 10px',
                          borderRadius: 10,
                          background: 'rgba(255,255,255,0.04)',
                          border: '1px solid rgba(255,255,255,0.08)',
                          fontFamily: 'Inter, sans-serif',
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: srv.online && (qk || qs) ? 6 : 0 }}>
                            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', fontWeight: 500 }}>Game Server</span>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              <div style={{
                                width: 7, height: 7, borderRadius: '50%',
                                background: srv.online ? '#44FF41' : '#F44336',
                                boxShadow: srv.online ? '0 0 6px rgba(68,255,65,0.9)' : '0 0 6px rgba(244,67,54,0.8)',
                                flexShrink: 0,
                              }} />
                              <span style={{ fontSize: 12, fontWeight: 700, color: srv.online ? '#44FF41' : '#F44336', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                                {srv.online ? 'Online' : 'Offline'}
                              </span>
                            </div>
                          </div>
                          {srv.online && (qk || qs) && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                              {qk && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', fontWeight: 400 }}>Killer queue</span>
                                  <span style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.7)' }}>{qk}</span>
                                </div>
                              )}
                              {qs && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', fontWeight: 400 }}>Survivor queue</span>
                                  <span style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.7)' }}>{qs}</span>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Action buttons */}
                      <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                        {/* Block / Unblock */}
                        {state.status === 'blocked' ? (
                          <button
                            onClick={() => { onUnblock(region.id) }}
                            style={{ flex: 1, padding: '6px 0', borderRadius: 8, border: '1px solid rgba(255,255,255,0.15)', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: 700, fontFamily: 'Poppins, sans-serif', textTransform: 'uppercase', letterSpacing: '0.08em', cursor: 'pointer' }}
                          >
                            Unblock
                          </button>
                        ) : region.id === BACKEND_REGION_ID ? (
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <button
                              disabled
                              style={{ width: '100%', padding: '6px 0', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)', background: 'rgba(255,255,255,0.03)', color: 'rgba(255,255,255,0.2)', fontSize: 10, fontWeight: 700, fontFamily: 'Poppins, sans-serif', textTransform: 'uppercase', letterSpacing: '0.08em', cursor: 'not-allowed', opacity: 0.5, pointerEvents: 'none' as const }}
                            >
                              Block
                            </button>
                            <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', fontFamily: 'Inter, sans-serif', lineHeight: 1.3 }}>
                              DBD backend server — blocking it would break login &amp; matchmaking.
                            </span>
                          </div>
                        ) : (
                          <button
                            onClick={() => { onBlock(region.id) }}
                            style={{ flex: 1, padding: '6px 0', borderRadius: 8, border: '1px solid rgba(244,67,54,0.4)', background: 'linear-gradient(135deg, rgba(244,67,54,0.18) 0%, rgba(198,40,40,0.18) 100%)', color: '#F44336', fontSize: 10, fontWeight: 700, fontFamily: 'Poppins, sans-serif', textTransform: 'uppercase', letterSpacing: '0.08em', cursor: 'pointer' }}
                          >
                            Block
                          </button>
                        )}

                        {/* Ping button */}
                        <button
                          onClick={() => onPingRegion(region.id)}
                          disabled={state.pingLoading}
                          style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)', color: state.pingLoading ? 'rgba(255,255,255,0.2)' : pingColor(state), fontSize: 10, fontWeight: 700, fontFamily: 'Poppins, sans-serif', textTransform: 'uppercase', letterSpacing: '0.06em', cursor: 'pointer', whiteSpace: 'nowrap' }}
                        >
                          {state.pingLoading ? '...' : 'Ping'}
                        </button>
                      </div>
                    </div>
                  </Popup>
                )}
              </Marker>
            )
          })}
        </MapContainer>

        {/* Custom hover tooltip — React overlay, position fixed above marker */}
        {hoveredRegion && (() => {
          const hr  = REGIONS.find(r => r.id === hoveredRegion)
          if (!hr) return null
          const hstate = regions.find(r => r.id === hoveredRegion)
          const hsrv = serverStatus[hr.id]
          const hqk  = hsrv ? formatQueueTime(hsrv.killerQueue)   : null
          const hqs  = hsrv ? formatQueueTime(hsrv.survivorQueue) : null
          const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: hr.timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(now)
          const localDate = new Intl.DateTimeFormat('en-GB', { timeZone: hr.timezone, weekday: 'short', day: 'numeric', month: 'short' }).format(now)
          return (
            <div
              style={{
                position: 'fixed',
                left: tooltipPos.x,
                top: tooltipPos.y - 18,
                transform: 'translate(-50%, -100%)',
                zIndex: 10000,
                pointerEvents: 'none',
                background: 'rgba(12,12,12,0.97)',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 10,
                padding: '8px 11px',
                boxShadow: '0 6px 24px rgba(0,0,0,0.7)',
                fontFamily: 'Inter, sans-serif',
                minWidth: 170,
                maxWidth: 220,
              }}
            >
              {/* Flag + name + local time on same row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 5 }}>
                <FlagIcon
                  code={hr.countryCode}
                  style={{ width: 20, height: 'auto', borderRadius: 2, display: 'block', flexShrink: 0 }}
                  fallback={hr.flag}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: '#fff', lineHeight: 1.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{hr.name}</div>
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', marginTop: 1 }}>{hr.country}</div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'rgba(255,255,255,0.7)', fontVariantNumeric: 'tabular-nums' }}>{localTime}</div>
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', marginTop: 1 }}>{localDate}</div>
                </div>
              </div>

              {/* Region ID */}
              <div style={{ fontWeight: 700, fontSize: 9, color: 'rgba(181,121,255,0.75)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>
                {hr.id}
              </div>

              {/* Game server status */}
              {hsrv && (
                <div style={{
                  borderTop: '1px solid rgba(255,255,255,0.07)',
                  paddingTop: 6,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', fontWeight: 500 }}>Game Server</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <div style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: hsrv.online ? '#44FF41' : '#6B7280',
                        boxShadow: hsrv.online ? '0 0 5px rgba(68,255,65,0.9)' : 'none',
                        flexShrink: 0,
                      }} />
                      <span style={{ fontSize: 11, fontWeight: 700, color: hsrv.online ? '#44FF41' : '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                        {hsrv.online ? 'Online' : 'Offline'}
                      </span>
                    </div>
                  </div>

                  {hsrv.online && (hqk || hqs) && (
                    <>
                      {hqk && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>Killer queue</span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.6)' }}>{hqk}</span>
                        </div>
                      )}
                      {hqs && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>Survivor queue</span>
                          <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.6)' }}>{hqs}</span>
                        </div>
                      )}
                    </>
                  )}

                  {/* Your ping — after game server block */}
                  {hstate && hstate.pingMs !== undefined && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 1 }}>
                      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>Your ping</span>
                      <span style={{ fontSize: 11, fontWeight: 700, color: pingColor(hstate) }}>
                        {hstate.pingMs === null ? 'Timeout' : `${hstate.pingMs} ms`}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* Your ping (no game server data) */}
              {!hsrv && hstate && hstate.pingMs !== undefined && (
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>Your ping</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: pingColor(hstate) }}>
                    {hstate.pingMs === null ? 'Timeout' : `${hstate.pingMs} ms`}
                  </span>
                </div>
              )}
            </div>
          )
        })()}

        {/* Map legend */}
        <div
          className="absolute bottom-4 left-4 z-[400] flex flex-col gap-1.5 px-3 py-2.5 rounded-xl"
          style={{ background: 'rgba(10,10,10,0.92)', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(8px)' }}
        >
          {[
            { color: '#44FF41',  label: 'Open' },
            { color: '#6B7280',  label: 'Game Offline', noGlow: true },
            { color: '#F44336',  label: 'Blocked' },
            { color: '#FF9800',  label: 'Permanent' },
          ].map(({ color, label, noGlow }) => (
            <div key={label} className="flex items-center gap-2">
              <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color, boxShadow: noGlow ? 'none' : `0 0 6px ${color}` }} />
              <span className="text-[10px] font-semibold text-white/50 uppercase tracking-wider">{label}</span>
            </div>
          ))}
          {userLocation && matchmakingRegions.length > 0 && (
            <>
              <div className="w-full h-px my-1" style={{ background: 'rgba(255,255,255,0.06)' }} />
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: '#B579FF', border: '1.5px solid rgba(255,255,255,0.8)', boxShadow: '0 0 6px rgba(181,121,255,0.9)' }} />
                <span className="text-[10px] font-semibold text-white/50 uppercase tracking-wider">You</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded shrink-0" style={{ border: '1.5px dashed rgba(181,121,255,0.5)', background: 'rgba(181,121,255,0.1)' }} />
                <span className="text-[10px] font-semibold text-white/50 uppercase tracking-wider">Matchmaking</span>
              </div>
            </>
          )}
        </div>

        {/* Click hint */}
        {selectedCount === 0 && (
          <div
            className="absolute top-4 left-1/2 -translate-x-1/2 z-[400] flex items-center gap-2 px-3 py-1.5 rounded-full"
            style={{ background: 'rgba(10,10,10,0.85)', border: '1px solid rgba(255,255,255,0.08)', backdropFilter: 'blur(8px)' }}
          >
            <MousePointerClick className="w-3 h-3 text-white/30" />
            <span className="text-[10px] font-semibold text-white/30 uppercase tracking-wider">Click markers to select</span>
          </div>
        )}
      </div>

      {/* ── Sidebar ── */}
      <div
        className="w-[272px] shrink-0 flex flex-col"
        style={{ background: 'rgba(12,12,12,0.98)', borderLeft: '1px solid rgba(255,255,255,0.06)' }}
      >
        {/* Header */}
        <div className="px-4 pt-4 pb-3 border-b border-white/[0.05]">
          <div className="gradient-title text-[11px] font-bold uppercase tracking-[0.14em] mb-1">
            Server Map
          </div>
          <div className="text-[11px] text-white/35">
            <span style={{ color: '#F44336' }}>{blockedCount}</span> blocked
            {' · '}
            <span style={{ color: '#44FF41' }}>{regions.length - blockedCount}</span> open
          </div>
        </div>

        {/* Selection bar */}
        <div className="px-4 py-2.5 border-b border-white/[0.05] flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-white/35">
            {selectedCount > 0
              ? `${selectedCount} selected`
              : 'None selected'}
          </span>
          <div className="flex items-center gap-1">
            {selectedCount > 0 && (
              <button
                onClick={() => setSelected(new Set())}
                className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded transition-colors hover:text-white/60"
                style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.3)', border: '1px solid rgba(255,255,255,0.08)' }}
              >
                Clear
              </button>
            )}
            <button
              onClick={() => setSelected(new Set(REGIONS.map(r => r.id)))}
              className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded transition-colors hover:text-white/60"
              style={{ background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.3)', border: '1px solid rgba(255,255,255,0.08)' }}
            >
              All
            </button>
          </div>
        </div>

        {/* Region list — grouped by continent */}
        <div className="flex-1 overflow-y-auto">
          {regionsByContinent.map(({ continent, regions: contRegions }) => (
            <div key={continent}>
              {/* Continent header */}
              <div
                className="px-4 py-1.5 text-[9px] font-bold uppercase tracking-[0.15em] sticky top-0"
                style={{
                  color: 'rgba(255,255,255,0.28)',
                  background: 'rgba(10,10,10,0.97)',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                  zIndex: 1,
                }}
              >
                {continent}
              </div>

              {contRegions.map(region => {
                const state     = regionMap.get(region.id)
                const isSel     = selected.has(region.id)
                const isPerm    = permanentRegions.includes(region.id)
                const isBlocked = state?.status === 'blocked'
                const dotColor  = isPerm && isBlocked ? '#FF9800' : isBlocked ? '#F44336' : '#44FF41'
                const ping      = pingLabel(state!)

                return (
                  <button
                    key={region.id}
                    onClick={() => toggle(region.id)}
                    className="w-full flex items-center gap-2.5 px-4 py-2 text-left transition-all duration-100"
                    style={{
                      background:   isSel ? 'rgba(181,121,255,0.07)' : 'transparent',
                      borderBottom: '1px solid rgba(255,255,255,0.03)',
                      borderLeft:   `2px solid ${isSel ? 'rgba(181,121,255,0.55)' : 'transparent'}`,
                    }}
                    onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'rgba(255,255,255,0.025)' }}
                    onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent' }}
                  >
                    {/* Checkbox */}
                    <div
                      className="shrink-0 w-3.5 h-3.5 rounded flex items-center justify-center"
                      style={{
                        border:     `1.5px solid ${isSel ? 'rgba(181,121,255,0.7)' : 'rgba(255,255,255,0.18)'}`,
                        background: isSel ? 'rgba(181,121,255,0.2)' : 'transparent',
                      }}
                    >
                      {isSel && <div style={{ width: 5, height: 5, borderRadius: 1, background: '#B579FF' }} />}
                    </div>

                    {/* Flag (SVG) */}
                    <FlagIcon
                      code={region.countryCode}
                      style={{ width: 18, height: 'auto', borderRadius: 2, display: 'block', flexShrink: 0 }}
                      fallback={region.flag}
                    />

                    {/* Name + id */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] font-bold text-white/75 truncate uppercase tracking-wide">
                          {region.name}
                        </span>
                        {region.id === BACKEND_REGION_ID && (
                          <span
                            className="text-[7px] font-bold uppercase tracking-wider px-1 py-px rounded shrink-0"
                            style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.3)', border: '1px solid rgba(255,255,255,0.08)' }}
                          >
                            Backend
                          </span>
                        )}
                      </div>
                      <div className="text-[9px] font-bold text-white/22 uppercase tracking-wider truncate">
                        {region.id}
                      </div>
                    </div>

                    {/* Ping result + status dot */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      {ping && (
                        <span
                          className="text-[9px] font-bold"
                          style={{ color: state ? pingColor(state) : 'rgba(255,255,255,0.25)' }}
                        >
                          {ping}
                        </span>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); onPingRegion(region.id) }}
                        disabled={state?.pingLoading}
                        className="w-4 h-4 flex items-center justify-center rounded transition-colors hover:text-white/60 disabled:opacity-30"
                        style={{ color: 'rgba(255,255,255,0.2)' }}
                        title="Ping server"
                      >
                        <Wifi className="w-2.5 h-2.5" />
                      </button>
                      {isPerm && isBlocked && (
                        <span className="text-[8px] font-bold px-1 py-px rounded" style={{ background: 'rgba(255,152,0,0.12)', color: '#FF9800' }}>P</span>
                      )}
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{ background: dotColor, boxShadow: `0 0 5px ${dotColor}` }}
                      />
                    </div>
                  </button>
                )
              })}
            </div>
          ))}
        </div>

        {/* Action footer */}
        <div
          className="p-3 space-y-2"
          style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
        >
          <button
            onClick={handleBlockSelected}
            disabled={blockableSelectedCount === 0 || globalLoading}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all duration-150 disabled:opacity-25"
            style={{
              background: 'linear-gradient(135deg, #F44336 0%, #C62828 100%)',
              color:      '#fff',
              border:     '1px solid rgba(244,67,54,0.35)',
              boxShadow:  blockableSelectedCount > 0 ? '0 4px 12px rgba(244,67,54,0.25)' : 'none',
            }}
          >
            <Shield className="w-3.5 h-3.5" />
            Block{blockableSelectedCount > 0 ? ` (${blockableSelectedCount})` : ''}
          </button>

          <button
            onClick={handleUnblockSelected}
            disabled={selectedCount === 0 || globalLoading}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-[11px] font-bold uppercase tracking-widest transition-all duration-150 disabled:opacity-25"
            style={{
              background: 'rgba(255,255,255,0.05)',
              color:      'rgba(255,255,255,0.65)',
              border:     '1px solid rgba(255,255,255,0.12)',
            }}
          >
            <ShieldOff className="w-3.5 h-3.5" />
            Unblock{selectedCount > 0 ? ` (${selectedCount})` : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
