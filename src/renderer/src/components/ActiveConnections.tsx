import { useState, useEffect, useCallback } from 'react'
import { AlertTriangle, Activity, Server, RotateCcw, Cpu, Power } from 'lucide-react'
import { FlagIcon } from './FlagIcon'
import { REGIONS } from '../regions'
import type { TrackerResult, TrackerCandidate } from '../types'

const EMPTY: TrackerResult = {
  dbdRunning: false, current_server: null, currentRegion: null,
  confidence: 0, candidates: [], udpPorts: [], dbdPid: 0, exitlagRunning: false,
}

function ConfidenceBar({ value }: { value: number }) {
  const pct   = Math.round(Math.min(1, Math.max(0, value)) * 100)
  const color = value >= 0.75 ? '#44FF41' : value >= 0.4 ? '#FF9800' : '#F44336'
  return (
    <div className="flex items-center gap-2">
      <div
        className="flex-1 h-1.5 rounded-full overflow-hidden"
        style={{ background: 'rgba(255,255,255,0.06)' }}
      >
        <div
          className="h-full rounded-full transition-all duration-300"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="text-[10px] font-mono w-8 text-right" style={{ color }}>{pct}%</span>
    </div>
  )
}

function CandidateRow({ c, isTop }: { c: TrackerCandidate; isTop: boolean }) {
  const region = c.regionId ? REGIONS.find(r => r.id === c.regionId) : null
  const pct    = Math.round(Math.min(1, Math.max(0, c.score)) * 100)
  const color  = isTop ? '#B579FF' : 'rgba(255,255,255,0.3)'

  return (
    <div
      className="flex items-center gap-3 px-3 py-2 rounded-xl"
      style={{
        background: isTop ? 'rgba(181,121,255,0.06)' : 'rgba(255,255,255,0.02)',
        border: `1px solid ${isTop ? 'rgba(181,121,255,0.2)' : 'rgba(255,255,255,0.05)'}`,
      }}
    >
      {region ? (
        <FlagIcon
          code={region.countryCode}
          style={{ width: 22, height: 'auto', borderRadius: 3, flexShrink: 0 }}
          fallback={region.flag}
        />
      ) : (
        <div className="w-5 h-4 rounded bg-white/10 shrink-0" />
      )}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="text-[11px] font-mono text-white/70 truncate">{c.ip}:{c.port}</span>
          {isTop && (
            <span className="text-[8px] font-bold px-1.5 py-px rounded shrink-0"
              style={{ background: 'rgba(181,121,255,0.15)', color: '#B579FF' }}>TOP</span>
          )}
        </div>
        <div className="text-[9px] text-white/25 font-mono">
          {region?.name ?? (c.regionId ?? 'Unknown region')} · hits={c.count}
        </div>
      </div>

      {/* Score bar */}
      <div className="flex items-center gap-1.5 shrink-0">
        <div className="w-16 h-1 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
        </div>
        <span className="text-[9px] font-mono w-7 text-right" style={{ color }}>{pct}%</span>
      </div>
    </div>
  )
}

export function ActiveConnections() {
  const [result, setResult]         = useState<TrackerResult>(EMPTY)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [enabled, setEnabled]       = useState(false)

  // Subscribe to push events from main process
  useEffect(() => {
    const unsub = window.api.onUdpUpdate((data) => {
      setResult(data)
      setLastUpdate(new Date())
    })
    return unsub
  }, [])

  const toggleTracker = useCallback(() => {
    if (enabled) {
      window.api.stopUdpTracker()
      setEnabled(false)
      setResult(EMPTY)
      setLastUpdate(null)
    } else {
      window.api.startUdpTracker()
      setEnabled(true)
    }
  }, [enabled])

  const regionInfo    = (id: string) => REGIONS.find(r => r.id === id)
  const currentRegion = result.currentRegion ? regionInfo(result.currentRegion) : null

  return (
    <div className="flex h-full">

      {/* ── Main panel ── */}
      <div className="flex-1 overflow-y-auto p-6 space-y-5">

        {/* Enable/Disable toggle */}
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
              <span className="text-[13px] font-bold text-white/80">
                {enabled ? 'Server Tracker Active' : 'Server Tracker Disabled'}
              </span>
              {enabled && (
                <span className="w-2 h-2 rounded-full animate-pulse block"
                  style={{ background: '#44FF41', boxShadow: '0 0 6px rgba(68,255,65,0.8)' }} />
              )}
            </div>
            <div className="text-[11px] text-white/35">
              {enabled
                ? 'ETW kernel tracing is capturing UDP events from DBD'
                : 'Click to start real-time game server detection'
              }
            </div>
          </div>
        </div>

        {/* ExitLag warning */}
        {enabled && result.exitlagRunning && (
          <div
            className="flex items-center gap-3 p-3 rounded-xl"
            style={{ background: 'rgba(255,152,0,0.06)', border: '1px solid rgba(255,152,0,0.2)' }}
          >
            <AlertTriangle className="w-4 h-4 shrink-0" style={{ color: '#FF9800' }} />
            <div className="text-[11px] text-white/50 leading-relaxed">
              <span className="font-bold" style={{ color: '#FF9800' }}>ExitLag detected</span> — server shown may be an ExitLag relay, not the actual game server. Check ExitLag for accurate server info.
            </div>
          </div>
        )}

        {/* DBD status banner (only when tracker is enabled) */}
        {enabled && (
          <div
            className="flex items-center gap-4 p-4 rounded-2xl"
            style={{
              background: result.dbdRunning ? 'rgba(68,255,65,0.05)' : 'rgba(255,255,255,0.03)',
              border: `1px solid ${result.dbdRunning ? 'rgba(68,255,65,0.2)' : 'rgba(255,255,255,0.08)'}`,
            }}
          >
            <div
              className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{
                background: result.dbdRunning ? 'rgba(68,255,65,0.1)' : 'rgba(255,255,255,0.05)',
                border: `1px solid ${result.dbdRunning ? 'rgba(68,255,65,0.25)' : 'rgba(255,255,255,0.1)'}`,
              }}
            >
              {result.dbdRunning
                ? <Activity className="w-5 h-5" style={{ color: '#44FF41' }} />
                : <Server className="w-5 h-5 text-white/25" />
              }
            </div>

            <div className="flex-1">
              <div className="flex items-center gap-2 mb-0.5">
                {result.dbdRunning && (
                  <span className="w-2 h-2 rounded-full animate-pulse block"
                    style={{ background: '#44FF41', boxShadow: '0 0 6px rgba(68,255,65,0.8)' }} />
                )}
                <span className="text-[13px] font-bold text-white/80">
                  {result.dbdRunning ? 'Dead by Daylight is running' : 'Dead by Daylight is not running'}
                </span>
                {result.dbdRunning && result.dbdPid > 0 && (
                  <span className="text-[9px] font-mono text-white/25">PID {result.dbdPid}</span>
                )}
              </div>
              <div className="text-[11px] text-white/35">
                {result.dbdRunning
                  ? result.current_server
                    ? `Tracking ${result.candidates.length} endpoint${result.candidates.length !== 1 ? 's' : ''}`
                    : 'Waiting for game server connection...'
                  : 'Launch the game to start monitoring'
                }
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

        {/* Current server (no block/unblock) */}
        {enabled && result.dbdRunning && result.current_server && (
          <section>
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/30 mb-3">
              Current Game Server
            </div>

            <div
              className="flex items-center gap-4 p-4 rounded-2xl"
              style={{
                background: 'rgba(68,255,65,0.05)',
                border: '1px solid rgba(68,255,65,0.18)',
              }}
            >
              {currentRegion && (
                <FlagIcon
                  code={currentRegion.countryCode}
                  style={{ width: 40, height: 'auto', borderRadius: 4, flexShrink: 0 }}
                  fallback={currentRegion.flag}
                />
              )}

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[14px] font-bold text-white/90 truncate">
                    {currentRegion?.name ?? result.currentRegion ?? 'Unknown Region'}
                  </span>
                  {currentRegion && (
                    <span className="text-[10px] text-white/35">{currentRegion.country}</span>
                  )}
                </div>

                <div className="text-[10px] font-mono text-white/25 mb-2">
                  {result.current_server} · {result.currentRegion}
                </div>

                <ConfidenceBar value={result.confidence} />
              </div>
            </div>
          </section>
        )}

        {/* Candidates / scoring table */}
        {enabled && result.dbdRunning && result.candidates.length > 0 && (
          <section>
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/30 mb-3">
              All Endpoints · Scoring Window
            </div>
            <div className="space-y-1.5">
              {result.candidates.map((c, i) => (
                <CandidateRow key={`${c.ip}:${c.port}`} c={c} isTop={i === 0} />
              ))}
            </div>
          </section>
        )}

        {/* UDP sockets */}
        {enabled && result.dbdRunning && result.udpPorts.length > 0 && (
          <section>
            <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/30 mb-2">
              DBD Local UDP Sockets
            </div>
            <div className="flex flex-wrap gap-1.5">
              {result.udpPorts.map(p => (
                <span key={p}
                  className="text-[9px] font-mono px-2 py-0.5 rounded"
                  style={{ background: 'rgba(181,121,255,0.08)', color: '#B579FF', border: '1px solid rgba(181,121,255,0.15)' }}
                >
                  :{p}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Empty state — DBD running but no connections yet */}
        {enabled && result.dbdRunning && !result.current_server && (
          <div
            className="flex flex-col items-center justify-center py-12 rounded-2xl text-center"
            style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <Cpu className="w-8 h-8 text-white/10 mb-3" />
            <div className="text-[12px] font-semibold text-white/25 mb-1">No game server detected yet</div>
            <div className="text-[11px] text-white/15">Join a lobby or match — UDP game server will appear here</div>
          </div>
        )}

        {/* Disabled state */}
        {!enabled && (
          <div
            className="flex flex-col items-center justify-center py-16 rounded-2xl text-center"
            style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}
          >
            <Cpu className="w-10 h-10 text-white/8 mb-4" />
            <div className="text-[13px] font-semibold text-white/20 mb-1.5">Server Tracker is off</div>
            <div className="text-[11px] text-white/12 max-w-[280px] leading-relaxed">
              Enable the tracker above to detect the game server you're connected to in real-time via ETW kernel tracing.
            </div>
          </div>
        )}
      </div>

      {/* ── Right info panel ── */}
      <div
        className="w-[220px] shrink-0 flex flex-col p-4 gap-4"
        style={{ borderLeft: '1px solid rgba(255,255,255,0.06)', background: 'rgba(12,12,12,0.98)' }}
      >
        <div>
          <div className="gradient-title text-[10px] font-bold uppercase tracking-[0.14em] mb-3">How it works</div>
          <div className="space-y-2.5">
            {[
              { icon: Cpu,      text: 'ETW (Event Tracing for Windows) captures real-time UDP events from the kernel — zero overhead on game traffic' },
              { icon: Activity, text: 'UDP events reveal the actual game server IP and port from DBD process traffic' },
              { icon: Server,   text: 'Highest-scored AWS IP determines which region your match is running in' },
            ].map(({ icon: Icon, text }, i) => (
              <div key={i} className="flex gap-2.5">
                <Icon className="w-3.5 h-3.5 shrink-0 mt-0.5 text-white/25" />
                <span className="text-[11px] text-white/35 leading-relaxed">{text}</span>
              </div>
            ))}
          </div>
        </div>

        <div
          className="p-3 rounded-xl"
          style={{ background: 'rgba(181,121,255,0.06)', border: '1px solid rgba(181,121,255,0.15)' }}
        >
          <div className="text-[10px] font-bold uppercase tracking-wider mb-1.5" style={{ color: '#B579FF' }}>
            Scoring formula
          </div>
          <code className="text-[9px] leading-relaxed text-white/40 block">
            score = freq×0.7 + recency×0.3
          </code>
          <p className="text-[10px] text-white/30 leading-relaxed mt-1.5">
            freq = hits / max_hits<br />
            recency = 1 - age/window
          </p>
        </div>

        <div
          className="p-3 rounded-xl"
          style={{ background: 'rgba(68,255,65,0.04)', border: '1px solid rgba(68,255,65,0.12)' }}
        >
          <div className="flex items-center gap-2 mb-1.5">
            <Cpu className="w-3 h-3 shrink-0" style={{ color: '#44FF41' }} />
            <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: '#44FF41' }}>Performance</span>
          </div>
          <p className="text-[10px] text-white/35 leading-relaxed">
            ETW is a passive kernel observer — it adds no latency to network traffic and has negligible CPU impact. Your ping and FPS are unaffected.
          </p>
        </div>

        {lastUpdate && (
          <div className="mt-auto text-[10px] font-mono text-white/20 text-center">
            Updated {lastUpdate.toLocaleTimeString('fr-FR', { hour12: false })}
          </div>
        )}
      </div>
    </div>
  )
}
