import { useState, useEffect } from 'react'
import { Shield, ShieldOff, Loader2, AlertCircle, Lock, Unlock, Wifi } from 'lucide-react'
import { FlagIcon } from './FlagIcon'
import type { RegionState, ServerInfo } from '../types'

interface RegionCardProps {
  region: RegionState
  isPermanent: boolean
  isBackend: boolean
  isMatchmaking: boolean
  serverInfo?: ServerInfo
  onBlock: () => void
  onUnblock: () => void
  onMarkPermanent: () => void
  onUnmarkPermanent: () => void
  onPing: () => void
}

export function RegionCard({
  region,
  isPermanent,
  isBackend,
  isMatchmaking,
  serverInfo,
  onBlock,
  onUnblock,
  onMarkPermanent,
  onUnmarkPermanent,
  onPing,
}: RegionCardProps) {
  const isBlocked = region.status === 'blocked'
  const isLoading = region.status === 'loading'
  const isError   = region.status === 'error'

  function pingColor() {
    if (region.pingMs === undefined) return 'rgba(255,255,255,0.25)'
    if (region.pingMs === null) return '#F44336'
    if (region.pingMs < 80) return '#44FF41'
    if (region.pingMs < 150) return '#FF9800'
    return '#F44336'
  }

  // Live local clock for the region's timezone
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  const localTime = new Intl.DateTimeFormat('en-GB', {
    timeZone: region.timezone,
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(now)

  const localDate = new Intl.DateTimeFormat('en-GB', {
    timeZone: region.timezone,
    weekday: 'short', day: 'numeric', month: 'short',
  }).format(now)

  function formatQueueTime(raw: string | null): string | null {
    if (!raw) return null
    const s = parseInt(raw, 10)
    if (isNaN(s)) return raw
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    const r = s % 60
    return r > 0 ? `${m}m ${r}s` : `${m}m`
  }

  function pingLabel() {
    if (region.pingLoading) return '...'
    if (region.pingMs === undefined) return 'Ping'
    if (region.pingMs === null) return 'T/O'
    return `${region.pingMs}ms`
  }

  // Card style
  const cardStyle = isBlocked
    ? {
        background:    isPermanent ? 'rgba(255, 152, 0, 0.06)' : 'rgba(244, 67, 54, 0.08)',
        outline:       isPermanent ? '1px solid rgba(255, 152, 0, 0.35)' : '1px solid rgba(244, 67, 54, 0.35)',
        outlineOffset: '-1px',
        boxShadow:     '0 8px 32px rgba(0,0,0,0.5)',
      }
    : isError
    ? {
        background:    'rgba(255, 152, 0, 0.08)',
        outline:       '1px solid rgba(255, 152, 0, 0.3)',
        outlineOffset: '-1px',
        boxShadow:     '0 8px 32px rgba(0,0,0,0.5)',
      }
    : isMatchmaking && !isBackend
    ? {
        background:    'rgba(181, 121, 255, 0.06)',
        outline:       '1px solid rgba(181, 121, 255, 0.25)',
        outlineOffset: '-1px',
        boxShadow:     '0 8px 32px rgba(0,0,0,0.5)',
      }
    : {
        background:    'rgba(255, 255, 255, 0.03)',
        outline:       '1px solid rgba(255, 255, 255, 0.10)',
        outlineOffset: '-1px',
        boxShadow:     '0 8px 32px rgba(0,0,0,0.5)',
      }

  return (
    <div
      className="group relative flex flex-col rounded-2xl p-4 backdrop-blur-sm transition-all duration-300 hover:-translate-y-0.5 hover:opacity-100"
      style={cardStyle}
    >
      {/* Top row: flag + status dot */}
      <div className="flex items-center justify-between mb-3">
        <FlagIcon
          code={region.countryCode}
          style={{ width: 32, height: 'auto', borderRadius: 3, display: 'block' }}
          fallback={region.flag}
        />

        <div className="flex items-center gap-1.5">
          {/* Backend badge */}
          {isBackend && (
            <span
              className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.35)', border: '1px solid rgba(255,255,255,0.12)' }}
            >
              BACKEND
            </span>
          )}

          {/* Matchmaking badge */}
          {isMatchmaking && !isBackend && (
            <span
              className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(181,121,255,0.15)', color: '#B579FF', border: '1px solid rgba(181,121,255,0.3)' }}
            >
              YOUR REGION
            </span>
          )}

          {/* Permanent badge */}
          {isPermanent && isBlocked && (
            <span
              className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
              style={{ background: 'rgba(255,152,0,0.15)', color: '#FF9800', border: '1px solid rgba(255,152,0,0.3)' }}
            >
              PERM
            </span>
          )}

          {isLoading ? (
            <Loader2 className="w-3.5 h-3.5 text-white/30 animate-spin" />
          ) : isBlocked ? (
            <span
              className="w-2.5 h-2.5 rounded-full block animate-pulse"
              style={{ background: '#44FF41', boxShadow: '0 0 10px rgba(68,255,65,0.9)' }}
            />
          ) : isError ? (
            <AlertCircle className="w-3.5 h-3.5" style={{ color: '#FF9800' }} />
          ) : (
            <span className="w-2.5 h-2.5 rounded-full bg-white/10 block" />
          )}
        </div>
      </div>

      {/* Region ID */}
      <div className="text-[11px] font-bold text-white/30 tracking-[0.12em] mb-1.5 uppercase">
        {region.id}
      </div>

      {/* Region name */}
      <div className="text-[18px] font-bold mb-1 gradient-title leading-tight tracking-[0.02em] uppercase">
        {region.name}
      </div>

      {/* Country */}
      <div className="text-[13px] text-white/50 font-semibold mb-2 uppercase tracking-wide">
        {region.country}
      </div>

      {/* Local clock */}
      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-[16px] font-bold tabular-nums" style={{ color: 'rgba(255,255,255,0.75)', letterSpacing: '0.02em' }}>
          {localTime}
        </span>
        <span className="text-[11px] font-medium" style={{ color: 'rgba(255,255,255,0.28)' }}>
          {localDate}
        </span>
      </div>

      {/* CIDR count */}
      {region.cidrCount > 0 && (
        <div className="text-[12px] text-white/25 mb-3">
          {region.cidrCount} IP ranges
        </div>
      )}

      {/* Game server status (deadbyqueue) — distinct from firewall block status */}
      {serverInfo !== undefined && (
        <div
          className="mb-3 rounded-xl p-2.5 flex flex-col gap-2"
          style={{
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(255,255,255,0.07)',
          }}
        >
          {/* Header row */}
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold text-white/35 tracking-wide">
              Game Server
            </span>
            <div className="flex items-center gap-1.5">
              <span
                className="w-2 h-2 rounded-full block shrink-0"
                style={{
                  background: serverInfo.online ? '#44FF41' : '#F44336',
                  boxShadow: serverInfo.online
                    ? '0 0 6px rgba(68,255,65,0.9)'
                    : '0 0 6px rgba(244,67,54,0.8)',
                }}
              />
              <span
                className="text-[12px] font-bold uppercase tracking-wider"
                style={{ color: serverInfo.online ? '#44FF41' : '#F44336' }}
              >
                {serverInfo.online ? 'Online' : 'Offline'}
              </span>
            </div>
          </div>

          {/* Queue times */}
          {serverInfo.online && (serverInfo.killerQueue || serverInfo.survivorQueue) && (
            <div className="flex flex-col gap-1.5 mt-0.5">
              {serverInfo.killerQueue && (
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-white/40">Killer queue</span>
                  <span className="text-[12px] font-bold" style={{ color: 'rgba(255,255,255,0.7)' }}>
                    {formatQueueTime(serverInfo.killerQueue)}
                  </span>
                </div>
              )}
              {serverInfo.survivorQueue && (
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium text-white/40">Survivor queue</span>
                  <span className="text-[12px] font-bold" style={{ color: 'rgba(255,255,255,0.7)' }}>
                    {formatQueueTime(serverInfo.survivorQueue)}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {isError && region.error && (
        <p className="text-[11px] mb-3 leading-relaxed" style={{ color: 'rgba(255,152,0,0.85)' }}>
          {region.error}
        </p>
      )}

      {/* ── Bottom action area ── */}
      <div className="mt-auto">
        {isLoading ? (
          <div
            className="flex items-center justify-center gap-2 py-3 rounded-xl"
            style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}
          >
            <Loader2 className="w-4 h-4 animate-spin text-white/30" />
            <span className="text-[12px] font-bold uppercase tracking-widest text-white/30">
              Loading
            </span>
          </div>
        ) : isBlocked ? (
          <button
            onClick={onUnblock}
            className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl text-[13px] font-bold uppercase tracking-widest transition-all duration-200 hover:-translate-y-px active:translate-y-0"
            style={{
              background: 'rgba(68,255,65,0.13)',
              border: '1px solid rgba(68,255,65,0.32)',
              color: '#44FF41',
            }}
          >
            <ShieldOff className="w-4 h-4" />
            Unblock
          </button>
        ) : isBackend ? (
          <div className="relative group/backend">
            <button
              disabled
              className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl text-[13px] font-bold uppercase tracking-widest cursor-not-allowed opacity-35"
              style={{
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: 'rgba(255,255,255,0.4)',
              }}
            >
              <Shield className="w-4 h-4" />
              Block
            </button>
            <div
              className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-2 opacity-0 group-hover/backend:opacity-100 transition-opacity duration-150 w-[220px] px-3 py-2 rounded-lg text-center"
              style={{
                background: 'rgba(12,12,12,0.95)',
                border: '1px solid rgba(255,255,255,0.12)',
                color: 'rgba(255,255,255,0.7)',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
              }}
            >
              <p className="text-[11px] font-semibold leading-relaxed">
                This is the DBD backend server. Blocking it would prevent the game from connecting entirely (login, matchmaking, etc.).
              </p>
            </div>
          </div>
        ) : (
          <button
            onClick={onBlock}
            className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl text-[13px] font-bold uppercase tracking-widest transition-all duration-200 hover:-translate-y-px active:translate-y-0"
            style={{
              background: 'linear-gradient(135deg, #F44336 0%, #C62828 100%)',
              border: '1px solid rgba(244,67,54,0.5)',
              color: '#fff',
              boxShadow: '0 4px 14px rgba(244,67,54,0.28)',
            }}
          >
            <Shield className="w-4 h-4" />
            Block
          </button>
        )}

        {/* Permanent control */}
        {isBlocked && !isLoading && (
          isPermanent ? (
            <button
              onClick={onUnmarkPermanent}
              className="mt-2 w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-[12px] font-semibold uppercase tracking-wider transition-colors duration-200"
              style={{ background: 'rgba(255,152,0,0.08)', border: '1px solid rgba(255,152,0,0.25)', color: '#FF9800' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,152,0,0.15)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,152,0,0.08)')}
            >
              <Unlock className="w-3 h-3" />
              Remove Permanent
            </button>
          ) : (
            <div className="relative group/perm mt-2">
              <button
                onClick={onMarkPermanent}
                className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl text-[12px] font-semibold uppercase tracking-wider transition-colors duration-200"
                style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.35)' }}
                onMouseEnter={e => {
                  e.currentTarget.style.background = 'rgba(255,152,0,0.08)'
                  e.currentTarget.style.color = '#FF9800'
                  e.currentTarget.style.borderColor = 'rgba(255,152,0,0.25)'
                }}
                onMouseLeave={e => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.04)'
                  e.currentTarget.style.color = 'rgba(255,255,255,0.35)'
                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'
                }}
              >
                <Lock className="w-3 h-3" />
                Make Permanent
              </button>
              <div
                className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-2 opacity-0 group-hover/perm:opacity-100 transition-opacity duration-150 w-[240px] px-3 py-2 rounded-lg text-center"
                style={{
                  background: 'rgba(12,12,12,0.95)',
                  border: '1px solid rgba(255,152,0,0.2)',
                  color: 'rgba(255,255,255,0.7)',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                }}
              >
                <p className="text-[11px] font-semibold leading-relaxed">
                  The block will stay active even after closing the application. The firewall rule will persist until you manually remove it.
                </p>
              </div>
            </div>
          )
        )}

        {/* Ping button */}
        {(
          <div className="relative mt-2 ping-btn-wrap">
            <button
              onClick={onPing}
              disabled={region.pingLoading}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-[13px] font-bold uppercase tracking-wider transition-all duration-200 disabled:opacity-50"
              style={{
                background: 'rgba(255,255,255,0.03)',
                border: '1px solid rgba(255,255,255,0.08)',
                color: pingColor(),
              }}
            >
              <Wifi className="w-3.5 h-3.5" />
              {pingLabel()}
            </button>
            {/* Tooltip */}
            <div
              className="ping-tooltip pointer-events-none absolute left-1/2 -translate-x-1/2 -top-8 opacity-0 transition-opacity duration-150 whitespace-nowrap px-2.5 py-1 rounded-lg text-[11px] font-semibold"
              style={{
                background: 'rgba(12,12,12,0.95)',
                border: '1px solid rgba(255,255,255,0.1)',
                color: 'rgba(255,255,255,0.7)',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
              }}
            >
              Your ping
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
