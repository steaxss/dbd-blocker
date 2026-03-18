import { regionsByContinent } from '../regions'
import { RegionCard } from './RegionCard'
import type { RegionState, ServerStatusMap } from '../types'

interface RegionGridProps {
  regions: RegionState[]
  permanentRegions: string[]
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
  serverStatus,
  onBlock,
  onUnblock,
  onMarkPermanent,
  onUnmarkPermanent,
  onPing,
}: RegionGridProps) {
  const regionMap = new Map(regions.map((r) => [r.id, r]))

  return (
    <div className="space-y-7">
      {regionsByContinent.map(({ continent, regions: contRegions }) => {
        const blockedCount = contRegions.filter(r => regionMap.get(r.id)?.status === 'blocked').length

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
              {contRegions.map((r) => {
                const state = regionMap.get(r.id)
                if (!state) return null
                return (
                  <RegionCard
                    key={r.id}
                    region={state}
                    isPermanent={permanentRegions.includes(r.id)}
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
