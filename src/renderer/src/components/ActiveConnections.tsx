import { useState, useEffect, useCallback } from 'react'
import { AlertTriangle, Activity, Server, RotateCcw, Power, ShieldCheck, ShieldOff, Info } from 'lucide-react'
import { FlagIcon } from './FlagIcon'
import { OverlayToolsPromo } from './OverlayToolsPromo'
import { REGIONS } from '../regions'
import type { TrackerResult, TrackerCandidate, BlockProof } from '../types'

const RELAY_REGION = 'aws-relay'

const EMPTY: TrackerResult = {
  dbdRunning: false, current_server: null, currentIp: null, currentRegion: null, blockedRegionHit: false, viaRelay: false, estimatedRegion: null, pingedRegions: [],
  confidence: 0, candidates: [], udpPorts: [], dbdPid: 0, exitlagRunning: false,
}

const regionInfo = (id: string) => REGIONS.find((r) => r.id === id)

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100)
  const color = value >= 0.75 ? '#44FF41' : value >= 0.4 ? '#FF9800' : '#F44336'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
        <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="text-[10px] font-mono w-8 text-right" style={{ color }}>{pct}%</span>
    </div>
  )
}

function CandidateRow({ c, isTop }: { c: TrackerCandidate; isTop: boolean }) {
  const region = c.regionId ? regionInfo(c.regionId) : null
  const label = region
    ? `${region.name}${c.estimated ? ' (estimated, AWS relay)' : ''}`
    : c.regionId === RELAY_REGION ? 'AWS relay' : c.regionId ?? 'Not an AWS range'
  return (
    <div
      className="flex items-center gap-3 px-3 py-2 rounded-lg"
      style={{
        background: isTop ? 'rgba(181,121,255,0.06)' : 'rgba(255,255,255,0.02)',
        border: `1px solid ${isTop ? 'rgba(181,121,255,0.18)' : 'rgba(255,255,255,0.05)'}`,
      }}
    >
      {region
        ? <FlagIcon code={region.countryCode} style={{ width: 18, height: 'auto', borderRadius: 2 }} fallback={region.flag} />
        : <Server className="w-4 h-4 text-white/20" />}
      <span className="text-[11px] font-mono text-white/70 flex-1 truncate">{c.ip}:{c.port}</span>
      <span className="text-[10px] text-white/35">{label}</span>
    </div>
  )
}

/** Proof that blocks work: game connection attempts dropped by the filters, per blocked region. */
function BlockingCheck({ blockedRegionIds }: { blockedRegionIds: string[] }) {
  const [proof, setProof] = useState<BlockProof | null>(null)
  const [, setTick] = useState(0)

  useEffect(() => {
    window.api.getBlockProof().then(setProof).catch(() => {})
    const unsub = window.api.onBlockProof(setProof)
    const timer = setInterval(() => setTick((t) => t + 1), 15_000) // refresh "x min ago"
    return () => { unsub(); clearInterval(timer) }
  }, [])

  return (
    <section
      className="p-4 rounded-2xl"
      style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.08)' }}
    >
      <div className="flex items-center gap-2 mb-3">
        <ShieldCheck className="w-4 h-4" style={{ color: '#44FF41' }} />
        <span className="text-[13px] font-bold text-white/85">Blocking check</span>
        {proof && (proof.total ?? 0) > 0 && (
          <span className="ml-auto text-[10px] font-mono px-2 py-0.5 rounded-md"
            style={{ background: 'rgba(68,255,65,0.08)', color: '#44FF41', border: '1px solid rgba(68,255,65,0.2)' }}>
            {proof.total} attempt{proof.total > 1 ? 's' : ''} blocked
          </span>
        )}
      </div>

      {blockedRegionIds.length === 0 ? (
        <div className="text-[11px] text-white/35">No region is blocked right now.</div>
      ) : (
        <div className="space-y-1.5">
          {blockedRegionIds.map((id) => {
            const region = regionInfo(id)
            const stat = proof?.regions?.[id]
            return (
              <div key={id} className="flex items-center gap-3 px-3 py-2 rounded-lg"
                style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
                {region && <FlagIcon code={region.countryCode} style={{ width: 18, height: 'auto', borderRadius: 2 }} fallback={region.flag} />}
                <span className="text-[12px] font-semibold text-white/75 w-28 truncate">{region?.name ?? id}</span>
                {stat ? (
                  <>
                    <ShieldCheck className="w-3.5 h-3.5 shrink-0" style={{ color: '#44FF41' }} />
                    <span className="text-[11px]" style={{ color: '#44FF41' }}>
                      {stat.count} attempt{stat.count > 1 ? 's' : ''} blocked
                    </span>
                    {(stat.relayCount ?? 0) > 0 && (
                      <span className="text-[9px] font-bold uppercase tracking-[0.08em] px-1.5 py-0.5 rounded"
                        style={{ background: 'rgba(181,121,255,0.1)', color: '#B579FF', border: '1px solid rgba(181,121,255,0.25)' }}
                        title="Connections to an AWS relay of this region: a match there was prevented">
                        {stat.relayCount} via relay
                      </span>
                    )}
                    <span className="ml-auto text-[10px] font-mono text-white/25 truncate">
                      {stat.lastRemote} · {timeAgo(stat.lastAt)}
                    </span>
                  </>
                ) : (
                  <span className="text-[11px] text-white/30">No attempt yet</span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {proof && !proof.available ? (
        <div className="flex items-start gap-2 mt-3 text-[11px] leading-relaxed" style={{ color: '#FF9800' }}>
          <ShieldOff className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          Windows is not logging dropped connections on this PC, so attempts cannot be counted. Blocks still apply.
        </div>
      ) : blockedRegionIds.length > 0 && (
        <div className="text-[10px] text-white/30 leading-relaxed mt-3">
          The game contacts each region while it searches for a match. Every attempt toward a blocked region (server, ping beacon or AWS relay) is dropped by Windows and counted here.
        </div>
      )}
    </section>
  )
}

export function ActiveConnections({ blockedRegionIds }: { blockedRegionIds: string[] }) {
  const [result, setResult] = useState<TrackerResult>(EMPTY)
  const [enabled, setEnabled] = useState(false)

  // The tracker lives in the main process: restore its state when this tab is shown again.
  useEffect(() => {
    window.api.getTrackerStatus().then(({ running, result }) => {
      setEnabled(running)
      if (running) setResult(result)
    }).catch(() => {})
  }, [])

  useEffect(() => window.api.onUdpUpdate(setResult), [])

  const toggleTracker = useCallback(() => {
    if (enabled) {
      window.api.stopUdpTracker()
      setEnabled(false)
      setResult(EMPTY)
    } else {
      window.api.startUdpTracker()
      setEnabled(true)
    }
  }, [enabled])

  const shownRegionId = result.currentRegion ?? result.estimatedRegion
  const currentRegion = shownRegionId ? regionInfo(shownRegionId) : null
  const isEstimate = !result.currentRegion && !!result.estimatedRegion

  return (
    <div className="flex h-full">
      <div className="flex-1 overflow-y-auto p-6 space-y-5">

        <BlockingCheck blockedRegionIds={blockedRegionIds} />

        <div
          className="flex items-center gap-4 p-4 rounded-2xl"
          style={{
            background: enabled ? 'rgba(181,121,255,0.05)' : 'rgba(255,255,255,0.03)',
            border: `1px solid ${enabled ? 'rgba(181,121,255,0.2)' : 'rgba(255,255,255,0.08)'}`,
          }}
        >
          <button
            onClick={toggleTracker}
            className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-all hover:-translate-y-px"
            style={{
              background: enabled ? 'rgba(68,255,65,0.1)' : 'rgba(255,255,255,0.05)',
              border: `1px solid ${enabled ? 'rgba(68,255,65,0.25)' : 'rgba(255,255,255,0.1)'}`,
            }}
          >
            <Power className="w-5 h-5" style={{ color: enabled ? '#44FF41' : 'rgba(255,255,255,0.25)' }} />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[13px] font-bold text-white/80">{enabled ? 'Server tracker on' : 'Server tracker off'}</span>
              {enabled && (
                <span className="w-2 h-2 rounded-full animate-pulse block" style={{ background: '#44FF41', boxShadow: '0 0 6px rgba(68,255,65,0.8)' }} />
              )}
            </div>
            <div className="text-[11px] text-white/35">
              {enabled ? 'Shows the game server Dead by Daylight is connected to' : 'Turn it on to see the game server during a match'}
            </div>
          </div>
        </div>

        <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl"
          style={{ background: 'rgba(90,200,255,0.05)', border: '1px solid rgba(90,200,255,0.15)' }}>
          <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" style={{ color: '#5AC8FF' }} />
          <div className="text-[11px] text-white/50 leading-relaxed">
            The detected region can be imprecise: since 2026, Amazon's new GameLift security (DDoS protection) routes matches through relays that hide the real server region. The region is then estimated from the relay location.
          </div>
        </div>

        {enabled && result.exitlagRunning && (
          <div className="flex items-center gap-3 p-3 rounded-xl"
            style={{ background: 'rgba(255,152,0,0.06)', border: '1px solid rgba(255,152,0,0.2)' }}>
            <AlertTriangle className="w-4 h-4 shrink-0" style={{ color: '#FF9800' }} />
            <div className="text-[11px] text-white/50 leading-relaxed">
              <span className="font-bold" style={{ color: '#FF9800' }}>ExitLag detected</span>: the server shown may be an ExitLag relay.
            </div>
          </div>
        )}

        {enabled && result.dbdRunning && result.blockedRegionHit && (
          <div className="flex items-center gap-3 p-3 rounded-xl"
            style={{ background: 'rgba(255,64,64,0.07)', border: '1px solid rgba(255,64,64,0.25)' }}>
            <AlertTriangle className="w-4 h-4 shrink-0" style={{ color: '#FF4040' }} />
            <div className="text-[11px] text-white/55 leading-relaxed">
              <span className="font-bold" style={{ color: '#FF4040' }}>Connected to a blocked region</span> ({result.currentRegion}).
              Blocks only apply to new connections: restart Dead by Daylight.
            </div>
          </div>
        )}

        {enabled && (
          <div className="flex items-center gap-4 p-4 rounded-2xl"
            style={{
              background: result.dbdRunning ? 'rgba(68,255,65,0.05)' : 'rgba(255,255,255,0.03)',
              border: `1px solid ${result.dbdRunning ? 'rgba(68,255,65,0.2)' : 'rgba(255,255,255,0.08)'}`,
            }}>
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{
                background: result.dbdRunning ? 'rgba(68,255,65,0.1)' : 'rgba(255,255,255,0.05)',
                border: `1px solid ${result.dbdRunning ? 'rgba(68,255,65,0.25)' : 'rgba(255,255,255,0.1)'}`,
              }}>
              {result.dbdRunning ? <Activity className="w-5 h-5" style={{ color: '#44FF41' }} /> : <Server className="w-5 h-5 text-white/25" />}
            </div>
            <div className="flex-1">
              <div className="text-[13px] font-bold text-white/80 mb-0.5">
                {result.dbdRunning ? 'Dead by Daylight is running' : 'Dead by Daylight is not running'}
              </div>
              <div className="text-[11px] text-white/35">
                {result.dbdRunning
                  ? result.current_server ? 'In a match or lobby' : 'Waiting for a game server...'
                  : 'Launch the game to start monitoring'}
              </div>
            </div>
            <button
              onClick={() => window.api.resetUdpMonitor()}
              disabled={!result.current_server}
              className="w-7 h-7 flex items-center justify-center rounded-lg transition-all hover:-translate-y-px disabled:opacity-20 shrink-0"
              style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.4)' }}
              title="Clear detected server"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {enabled && result.dbdRunning && (result.pingedRegions ?? []).length > 0 && (
          <section>
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/30 mb-2">Matchmaking pings</div>
            <div className="flex flex-wrap gap-1.5 mb-1.5">
              {result.pingedRegions.map(({ region: id, blocked }) => {
                const r = regionInfo(id)
                return (
                  <span key={id} className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2 py-1 rounded-lg"
                    style={blocked
                      ? { background: 'rgba(244,67,54,0.08)', border: '1px solid rgba(244,67,54,0.3)', color: '#F44336' }
                      : { background: 'rgba(90,200,255,0.06)', border: '1px solid rgba(90,200,255,0.18)', color: 'rgba(255,255,255,0.7)' }}
                    title={blocked ? 'Ping dropped: the game sees this region as unreachable' : 'Ping reached the region'}>
                    {r && <FlagIcon code={r.countryCode} style={{ width: 14, height: 'auto', borderRadius: 2 }} fallback={r.flag} />}
                    {r?.name ?? id}
                    {blocked && <ShieldCheck className="w-3 h-3" />}
                  </span>
                )
              })}
            </div>
            <div className="text-[10px] text-white/30">
              Regions the game measured its latency to while searching. Pings toward blocked regions (red) are dropped, so the game sees them as unreachable.
            </div>
          </section>
        )}

        {enabled && result.dbdRunning && result.current_server && (
          <section>
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/30 mb-3">Current game server</div>
            <div className="flex items-center gap-4 p-4 rounded-2xl"
              style={{ background: 'rgba(68,255,65,0.05)', border: '1px solid rgba(68,255,65,0.18)' }}>
              {currentRegion && (
                <FlagIcon code={currentRegion.countryCode} style={{ width: 40, height: 'auto', borderRadius: 4, flexShrink: 0 }} fallback={currentRegion.flag} />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[14px] font-bold text-white/90 truncate">
                    {currentRegion?.name ?? (result.viaRelay ? 'Hidden behind an AWS relay' : 'Not an AWS server')}
                  </span>
                  {currentRegion && <span className="text-[10px] text-white/35">{currentRegion.country}</span>}
                  {isEstimate && (
                    <span className="text-[9px] font-bold uppercase tracking-[0.1em] px-1.5 py-0.5 rounded"
                      style={{ background: 'rgba(90,200,255,0.1)', color: '#5AC8FF', border: '1px solid rgba(90,200,255,0.25)' }}>
                      Estimated
                    </span>
                  )}
                </div>
                <div className="text-[10px] font-mono text-white/25 mb-2">
                  {result.current_server}{isEstimate ? ' · via AWS relay, location from public IP data' : ''}
                </div>
                <ConfidenceBar value={result.confidence} />
              </div>
            </div>
          </section>
        )}

        {enabled && result.dbdRunning && result.candidates.length > 1 && (
          <section>
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/30 mb-3">Other endpoints</div>
            <div className="space-y-1.5">
              {result.candidates.map((c, i) => <CandidateRow key={`${c.ip}:${c.port}`} c={c} isTop={i === 0} />)}
            </div>
          </section>
        )}
      </div>

      <div className="w-[260px] shrink-0 overflow-y-auto p-4"
        style={{ borderLeft: '1px solid rgba(255,255,255,0.06)', background: 'rgba(12,12,12,0.98)' }}>
        <OverlayToolsPromo />
      </div>
    </div>
  )
}
