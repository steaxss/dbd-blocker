import { MapPin } from 'lucide-react'
import { regionsByContinent, REGIONS, BACKEND_REGION_ID } from '../regions'
import { RegionCard } from './RegionCard'
import type { RegionState, ServerStatusMap } from '../types'

interface RegionGridProps {
  regions: RegionState[]
  permanentRegions: string[]
  matchmakingRegions: string[]
  serverStatus: ServerStatusMap
  onBlock: (regionId: string) => void
  onUnblock: (regionId: string) => void
  onMarkPermanent: (regionId: string) => void
  onUnmarkPermanent: (regionId: string) => void
  onPing: (regionId: string) => void
}

export function RegionGrid({
  regions,
  permanentRegions,
  matchmakingRegions,
  serverStatus,
  onBlock,
  onUnblock,
  onMarkPermanent,
  onUnmarkPermanent,
  onPing,
}: RegionGridProps) {
  const regionMap = new Map(regions.map((r) => [r.id, r]))
  const mmSet = new Set(matchmakingRegions)
  const hasMatchmaking = matchmakingRegions.length > 0

  // Matchmaking region definitions (ordered like REGIONS)
  const mmRegionDefs = REGIONS.filter((r) => mmSet.has(r.id))

  return (
    <div className="space-y-7">
      {/* ── Your Matchmaking Region (shown first) ── */}
      {hasMatchmaking && (
        <section>
          <div className="flex items-center justify-between mb-3 px-0.5">
            <div className="flex items-center gap-2">
              <MapPin className="w-3.5 h-3.5" style={{ color: '#B579FF' }} />
              <span
                className="text-[10px] font-bold uppercase tracking-[0.14em]"
                style={{ color: '#B579FF' }}
              >
                Your Matchmaking Region
              </span>
            </div>
            <span
              className="text-[9px] font-medium uppercase tracking-[0.06em] px-2 py-0.5 rounded-full"
              style={{
                color: 'rgba(255,255,255,0.3)',
                background: 'rgba(181,121,255,0.08)',
                border: '1px solid rgba(181,121,255,0.15)',
              }}
            >
              Based on ping latency
            </span>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
            {mmRegionDefs.map((r) => {
              const state = regionMap.get(r.id)
              if (!state) return null
              return (
                <RegionCard
                  key={r.id}
                  region={state}
                  isPermanent={permanentRegions.includes(r.id)}
                  isBackend={r.id === BACKEND_REGION_ID}
                  isMatchmaking={true}
                  serverInfo={serverStatus[r.id]}
                  onBlock={() => onBlock(r.id)}
                  onUnblock={() => onUnblock(r.id)}
                  onMarkPermanent={() => onMarkPermanent(r.id)}
                  onUnmarkPermanent={() => onUnmarkPermanent(r.id)}
                  onPing={() => onPing(r.id)}
                />
              )
            })}
          </div>
        </section>
      )}

      {/* ── Other regions by continent (excluding matchmaking) ── */}
      {regionsByContinent.map(({ continent, regions: contRegions }) => {
        // Filter out matchmaking regions already shown above
        const filteredRegions = hasMatchmaking
          ? contRegions.filter((r) => !mmSet.has(r.id))
          : contRegions

        if (filteredRegions.length === 0) return null

        const blockedCount = filteredRegions.filter(r => regionMap.get(r.id)?.status === 'blocked').length

        return (
          <section key={continent}>
            {/* Section header */}
            <div className="flex items-center justify-between mb-3 px-0.5">
              <span className="gradient-title text-[10px] font-bold uppercase tracking-[0.14em]">
                {continent}
              </span>
              {blockedCount > 0 && (
                <span
                  className="text-[9px] font-bold uppercase tracking-[0.08em] px-2 py-0.5 rounded-full"
                  style={{
                    color:      '#F44336',
                    background: 'rgba(244,67,54,0.12)',
                    border:     '1px solid rgba(244,67,54,0.25)',
                  }}
                >
                  {blockedCount} blocked
                </span>
              )}
            </div>

            {/* Cards */}
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
              {filteredRegions.map((r) => {
                const state = regionMap.get(r.id)
                if (!state) return null
                return (
                  <RegionCard
                    key={r.id}
                    region={state}
                    isPermanent={permanentRegions.includes(r.id)}
                    isBackend={r.id === BACKEND_REGION_ID}
                    isMatchmaking={false}
                    serverInfo={serverStatus[r.id]}
                    onBlock={() => onBlock(r.id)}
                    onUnblock={() => onUnblock(r.id)}
                    onMarkPermanent={() => onMarkPermanent(r.id)}
                    onUnmarkPermanent={() => onUnmarkPermanent(r.id)}
                    onPing={() => onPing(r.id)}
                  />
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
