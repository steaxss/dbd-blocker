import { useState, useEffect, useCallback } from 'react'
import { AlertTriangle, Activity, Server, RotateCcw, Power, ShieldCheck, ShieldOff, Info, Check, Sparkles } from 'lucide-react'
import { FlagIcon } from './FlagIcon'
import { REGIONS } from '../regions'
import type { TrackerResult, TrackerCandidate, BlockProof } from '../types'

const DISCORD_URL = 'https://discord.com/invite/aVdT8rRJKc'
const RELAY_REGION = 'aws-relay'

const EMPTY: TrackerResult = {
  dbdRunning: false, current_server: null, currentIp: null, currentRegion: null, blockedRegionHit: false, viaRelay: false,
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
  const label = region?.name ?? (c.regionId === RELAY_REGION ? 'AWS relay' : c.regionId ?? 'Not an AWS range')
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
          The game contacts each region while it searches for a match. Every attempt toward a blocked region is dropped by Windows and counted here.
        </div>
      )}
    </section>
  )
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M20.32 4.37A19.8 19.8 0 0 0 15.4 2.85a.07.07 0 0 0-.08.04c-.21.38-.45.87-.61 1.25a18.3 18.3 0 0 0-5.43 0 12.6 12.6 0 0 0-.62-1.25.08.08 0 0 0-.08-.04 19.7 19.7 0 0 0-4.88 1.52.07.07 0 0 0-.03.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.06 19.9 19.9 0 0 0 5.99 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.23-2a.08.08 0 0 0-.04-.11 13.1 13.1 0 0 1-1.87-.89.08.08 0 0 1 0-.13l.37-.29a.07.07 0 0 1 .08-.01c3.93 1.79 8.18 1.79 12.06 0a.07.07 0 0 1 .08.01l.37.29a.08.08 0 0 1 0 .13 12.3 12.3 0 0 1-1.87.89.08.08 0 0 0-.04.11c.36.7.77 1.37 1.23 2a.08.08 0 0 0 .08.03 19.8 19.8 0 0 0 6-3.03.08.08 0 0 0 .03-.06c.5-5.18-.84-9.67-3.55-13.66a.06.06 0 0 0-.03-.03ZM8.02 15.33c-1.18 0-2.16-1.09-2.16-2.42s.96-2.42 2.16-2.42c1.21 0 2.18 1.1 2.16 2.42 0 1.33-.96 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.15-1.09-2.15-2.42s.95-2.42 2.15-2.42c1.21 0 2.18 1.1 2.16 2.42 0 1.33-.95 2.42-2.16 2.42Z" />
    </svg>
  )
}

const PREMIUM_FEATURES = [
  'Killer & Survivor streak overlays',
  'Tournament & scrim overlays',
  'Dual match timer',
  'Perk timers (BT, DS, Hook stage...)',
  'Map overlay with auto-detection',
  'DBDL ladder display',
]

function OverlayToolsPromo() {
  return (
    <div className="relative rounded-2xl p-[1px] overflow-hidden"
      style={{ background: 'linear-gradient(150deg, rgba(181,121,255,0.75), rgba(112,70,218,0.25) 45%, rgba(68,255,65,0.35))' }}>
      <div className="relative rounded-2xl p-4 overflow-hidden" style={{ background: 'linear-gradient(170deg, #17121f 0%, #0d0b12 60%, #0b0b0d 100%)' }}>
        <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(181,121,255,0.35), transparent 70%)' }} />

        <div className="relative flex items-center gap-2.5 mb-3">
          <svg viewBox="0 0 64 64" className="w-9 h-9 shrink-0" aria-hidden="true">
            <defs>
              <linearGradient id="ot-g" x1="10" y1="8" x2="54" y2="58" gradientUnits="userSpaceOnUse">
                <stop stopColor="#B579FF" />
                <stop offset="1" stopColor="#7046DA" />
              </linearGradient>
            </defs>
            <rect width="64" height="64" rx="14" fill="#060608" stroke="rgba(181,121,255,0.35)" />
            <path fill="url(#ot-g)" d="M18 12h10c12 0 20 8 20 20s-8 20-20 20H18V12Zm9 11v18h2c5.5 0 8.8-3.4 8.8-9S34.5 23 29 23h-2Z" />
            <path fill="#fff" d="M15 18h6v28h-6V18Zm33 0h6v28h-6V18Z" opacity=".9" />
          </svg>
          <div className="min-w-0">
            <div className="text-[13px] font-extrabold text-white leading-tight">DBD OverlayTools</div>
            <div className="inline-flex items-center gap-1 mt-0.5 text-[9px] font-black uppercase tracking-[0.16em] px-1.5 py-0.5 rounded"
              style={{ background: 'linear-gradient(90deg, #B579FF, #7046DA)', color: '#fff' }}>
              <Sparkles className="w-2.5 h-2.5" /> Premium
            </div>
          </div>
        </div>

        <p className="relative text-[11px] text-white/55 leading-relaxed mb-3">
          Stream overlays built for Dead by Daylight. Always on top and ready for OBS.
        </p>

        <ul className="relative space-y-1.5 mb-4">
          {PREMIUM_FEATURES.map((f) => (
            <li key={f} className="flex items-start gap-2 text-[11px] text-white/70">
              <Check className="w-3 h-3 shrink-0 mt-0.5" style={{ color: '#44FF41' }} />
              {f}
            </li>
          ))}
        </ul>

        <a
          href={DISCORD_URL}
          target="_blank"
          rel="noreferrer"
          className="relative flex items-center justify-center gap-2 w-full py-2.5 rounded-xl text-[12px] font-bold text-white transition-all hover:-translate-y-px hover:brightness-110"
          style={{ background: 'linear-gradient(90deg, #B579FF, #7046DA)', boxShadow: '0 6px 20px rgba(181,121,255,0.3)' }}
        >
          <DiscordIcon className="w-4 h-4" />
          Join the Discord
        </a>
      </div>
    </div>
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

  const currentRegion = result.currentRegion ? regionInfo(result.currentRegion) : null

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
            The detected region can be imprecise: since 2026, Amazon's new GameLift security (DDoS protection) routes some matches through relays that hide the real server region.
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
                </div>
                <div className="text-[10px] font-mono text-white/25 mb-2">{result.current_server}</div>
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
