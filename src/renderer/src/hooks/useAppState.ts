import { useState, useEffect, useCallback, useRef } from 'react'
import { REGIONS, getMatchmakingRegionsByGeo, getMatchmakingRegionsByPing } from '../regions'
import type { RegionState, LogEntry, ExeValidationResult, InitStep, UpdateInfo, ServerStatusMap } from '../types'

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const INIT_STEPS: InitStep[] = [
  { id: 'admin',    label: 'Verifying administrator privileges', status: 'pending' },
  { id: 'settings', label: 'Loading application settings',      status: 'pending' },
  { id: 'ips',      label: 'Fetching AWS IP ranges',            status: 'pending' },
  { id: 'rules',    label: 'Reading active firewall rules',     status: 'pending' },
]

const REFRESH_COOLDOWN_MS = 60_000

export function useAppState() {
  const [regions, setRegions] = useState<RegionState[]>(
    REGIONS.map((r) => ({ ...r, status: 'active', cidrCount: 0 }))
  )
  const [logs, setLogs]                   = useState<LogEntry[]>([])
  const [isAdmin, setIsAdmin]             = useState<boolean | null>(null)
  const [globalLoading, setGlobalLoading] = useState(false)
  const [permanentRegions, setPermanentRegions] = useState<string[]>([])
  const [exePath, setExePathState]        = useState('')
  const [updateInfo, setUpdateInfo]       = useState<UpdateInfo | null>(null)
  const [serverStatus, setServerStatus]   = useState<ServerStatusMap>({})
  const [updateDownloading, setUpdateDownloading] = useState(false)
  const [updateProgress, setUpdateProgress]       = useState(0)
  const [updateReady, setUpdateReady]             = useState(false)
  const [matchmakingRegions, setMatchmakingRegions] = useState<string[]>([])
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null)

  // Init / splash state
  const [initDone, setInitDone]     = useState(false)
  const [initSteps, setInitSteps]   = useState<InitStep[]>(INIT_STEPS)
  const [needsExeSetup, setNeedsExeSetup] = useState(false)

  // Prevent double-init in React StrictMode (dev only)
  const initRanRef = useRef(false)

  // Refresh cooldown
  const lastRefreshRef = useRef<number>(0)
  const [refreshCooldown, setRefreshCooldown] = useState(0) // seconds remaining
  const cooldownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  function startCooldown() {
    lastRefreshRef.current = Date.now()
    setRefreshCooldown(60)
    if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current)
    cooldownTimerRef.current = setInterval(() => {
      const elapsed = Date.now() - lastRefreshRef.current
      const remaining = Math.ceil((REFRESH_COOLDOWN_MS - elapsed) / 1000)
      if (remaining <= 0) {
        setRefreshCooldown(0)
        if (cooldownTimerRef.current) {
          clearInterval(cooldownTimerRef.current)
          cooldownTimerRef.current = null
        }
      } else {
        setRefreshCooldown(remaining)
      }
    }, 500)
  }

  const addLog = useCallback((level: LogEntry['level'], message: string) => {
    const entry: LogEntry = {
      id: makeId(),
      timestamp: new Date().toLocaleTimeString('fr-FR', { hour12: false }),
      level,
      message
    }
    setLogs((prev) => {
      const next = [...prev, entry]
      return next.length > 500 ? next.slice(-500) : next
    })
  }, [])

  const setRegionStatus = useCallback((regionId: string, updates: Partial<RegionState>) => {
    setRegions((prev) =>
      prev.map((r) => (r.id === regionId ? { ...r, ...updates } : r))
    )
  }, [])

  const syncBlockedCount = useCallback((regionsList: RegionState[]) => {
    const count = regionsList.filter((r) => r.status === 'blocked').length
    window.api.sendBlockedCount(count)
  }, [])

  // ── Init ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    function setStep(id: string, updates: Partial<InitStep>) {
      setInitSteps(prev => prev.map(s => s.id === id ? { ...s, ...updates } : s))
    }

    if (initRanRef.current) return
    initRanRef.current = true

    async function init() {
      // Step 1 — Admin check
      setStep('admin', { status: 'running' })
      const admin = await window.api.isAdmin()
      setIsAdmin(admin)
      if (!admin) {
        addLog('error', 'Not running as administrator — firewall operations will fail. Please restart as admin.')
        setStep('admin', { status: 'error', detail: 'No admin' })
      } else {
        addLog('info', 'App started (administrator: OK)')
        setStep('admin', { status: 'done', detail: 'OK' })
      }

      // Step 2 — Load settings + validate exe path
      setStep('settings', { status: 'running' })
      const [path, permanent] = await Promise.all([
        window.api.getExePath(),
        window.api.getPermanentRegions(),
      ])
      setExePathState(path)
      setPermanentRegions(permanent)
      if (permanent.length > 0) {
        addLog('warning', `Permanent blocks loaded: ${permanent.join(', ')}`)
      }
      const exeCheck = await window.api.checkExePath()
      if (!exeCheck.ok) {
        setNeedsExeSetup(true)
        addLog('error', `DBD executable not found — please set the correct path in settings`)
        setStep('settings', { status: 'error', detail: 'Exe not found' })
      } else {
        setStep('settings', { status: 'done' })
      }

      // Step 3 — Always force-fetch IP ranges on startup
      setStep('ips', { status: 'running' })
      const diff = await window.api.refreshIps()
      startCooldown()
      const newCounts = await window.api.getCidrCounts()
      setRegions(prev => prev.map(r => ({ ...r, cidrCount: newCounts[r.id] ?? 0 })))
      const diffParts: string[] = []
      if (diff.added > 0) diffParts.push(`+${diff.added} new`)
      if (diff.removed > 0) diffParts.push(`-${diff.removed} removed`)
      const diffStr = diffParts.length > 0 ? ` (${diffParts.join(', ')})` : ' (no changes)'
      addLog('info', `IP ranges updated${diffStr}`)
      setStep('ips', { status: 'done', detail: `${REGIONS.length} regions${diffStr}` })

      // Step 4 — Read active firewall rules
      setStep('rules', { status: 'running' })
      const status = await window.api.getStatus()
      setRegions((prev) => {
        const next = prev.map((r) => ({
          ...r,
          status: status[r.id] ? ('blocked' as const) : ('active' as const),
        }))
        syncBlockedCount(next)
        return next
      })
      const blocked = Object.entries(status).filter(([, v]) => v).map(([k]) => k)
      if (blocked.length > 0) {
        addLog('warning', `Rules already active at startup: ${blocked.join(', ')}`)
      }
      setStep('rules', { status: 'done', detail: `${blocked.length} blocked` })

      setInitDone(true)

      // WFP health check — logs result to console, no UI impact
      window.api.checkFirewallHealth()

      // Check for update in background (non-blocking)
      window.api.checkForUpdate().then(info => {
        if (info.available) setUpdateInfo(info)
      }).catch(() => { /* ignore */ })

      // Fetch server status (non-blocking)
      window.api.getServerStatus().then(res => {
        if (res.ok) setServerStatus(res.data)
      }).catch(() => { /* ignore */ })

      // Step 1: Geolocation — browser API first (WiFi/network, precise), IP fallback
      function applyGeo(lat: number, lng: number, source: string) {
        setUserLocation({ lat, lng })
        const mm = getMatchmakingRegionsByGeo(lat, lng)
        setMatchmakingRegions(mm)
        addLog('info', `Matchmaking region (${source}): ${mm.join(', ')}`)
      }

      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => applyGeo(pos.coords.latitude, pos.coords.longitude, 'browser geolocation'),
          () => {
            // Browser geolocation denied/failed — fallback to IP
            fetch('https://ipapi.co/json/')
              .then(r => r.json())
              .then((data: { latitude?: number; longitude?: number }) => {
                if (data.latitude != null && data.longitude != null) {
                  applyGeo(data.latitude, data.longitude, 'IP geolocation')
                }
              })
              .catch(() => {
                fetch('http://ip-api.com/json/?fields=lat,lon')
                  .then(r => r.json())
                  .then((data: { lat?: number; lon?: number }) => {
                    if (data.lat != null && data.lon != null) {
                      applyGeo(data.lat, data.lon, 'IP geolocation')
                    }
                  })
                  .catch(() => { /* will rely on ping results instead */ })
              })
          },
          { timeout: 5000, maximumAge: 300000 }
        )
      } else {
        // No browser geolocation — IP fallback
        fetch('https://ipapi.co/json/')
          .then(r => r.json())
          .then((data: { latitude?: number; longitude?: number }) => {
            if (data.latitude != null && data.longitude != null) {
              applyGeo(data.latitude, data.longitude, 'IP geolocation')
            }
          })
          .catch(() => { /* will rely on ping results instead */ })
      }

      // Step 2: Auto-ping all regions, then refine matchmaking based on actual latency
      setRegions(prev => prev.map(r => ({ ...r, pingLoading: true, pingMs: undefined, pingIp: undefined })))
      const pingResults: Record<string, number | null> = {}
      await Promise.all(
        REGIONS.map(async (r) => {
          const result = await window.api.pingRegion(r.id)
          pingResults[r.id] = result.ms
          setRegionStatus(r.id, {
            pingLoading: false,
            pingMs: result.ms,
            pingIp: result.ip ?? undefined,
          })
        })
      )
      // Refine matchmaking using ping data (overrides geolocation if available)
      const pingMm = getMatchmakingRegionsByPing(pingResults)
      if (pingMm) {
        setMatchmakingRegions(pingMm)
        const bestId = Object.entries(pingResults)
          .filter(([, ms]) => ms != null)
          .sort(([, a], [, b]) => (a as number) - (b as number))[0]?.[0]
        const bestMs = bestId ? pingResults[bestId] : null
        addLog('success', `Matchmaking region (ping): ${pingMm.join(', ')} — lowest ping: ${bestMs}ms (${bestId})`)
      }
      addLog('info', 'Ping auto-startup complete')
    }

    init()

    return () => {
      if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current)
    }
  }, [addLog, syncBlockedCount])

  // ── Events from main process ───────────────────────────────────────────────
  useEffect(() => {
    const unsubLog = window.api.onLog((entry) => {
      setLogs((prev) => {
        const next = [...prev, entry]
        return next.length > 500 ? next.slice(-500) : next
      })
    })

    const unsubStatus = window.api.onStatusChange((regionId, blocked) => {
      setRegions((prev) => {
        const next = prev.map((r) =>
          r.id === regionId
            ? { ...r, status: blocked ? ('blocked' as const) : ('active' as const) }
            : r
        )
        syncBlockedCount(next)
        return next
      })
    })

    const unsubCidr = (window.api as any).onCidrCount?.((regionId: string, count: number) => {
      setRegions((prev) => prev.map((r) => (r.id === regionId ? { ...r, cidrCount: count } : r)))
    })

    const unsubUnblockAll = (window.api as any).onUnblockAllDone?.(() => {
      setRegions((prev) => {
        const next = prev.map((r) => ({ ...r, status: 'active' as const }))
        syncBlockedCount(next)
        return next
      })
      addLog('success', 'All regions unblocked from tray')
    })

    const unsubUpdateProgress = window.api.onUpdateDownloadProgress?.((percent) => {
      setUpdateProgress(Math.round(percent))
    })

    const unsubUpdateDownloaded = window.api.onUpdateDownloaded?.(() => {
      setUpdateDownloading(false)
      setUpdateReady(true)
    })

    return () => {
      unsubLog?.()
      unsubStatus?.()
      unsubCidr?.()
      unsubUnblockAll?.()
      unsubUpdateProgress?.()
      unsubUpdateDownloaded?.()
    }
  }, [addLog, syncBlockedCount])

  // ── Server status auto-refresh (every 20 min) ─────────────────────────────
  useEffect(() => {
    const interval = setInterval(async () => {
      const res = await window.api.getServerStatus().catch(() => null)
      if (res?.ok) setServerStatus(res.data)
    }, 20 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  // ── Firewall actions ───────────────────────────────────────────────────────
  const blockRegion = useCallback(async (regionId: string) => {
    setRegionStatus(regionId, { status: 'loading', error: undefined })
    const result = await window.api.blockRegion(regionId)
    if (result.ok) {
      setRegions((prev) => {
        const next = prev.map((r) =>
          r.id === regionId ? { ...r, status: 'blocked' as const } : r
        )
        syncBlockedCount(next)
        return next
      })
    } else {
      setRegionStatus(regionId, { status: 'error', error: result.error })
    }
  }, [setRegionStatus, syncBlockedCount])

  const unblockRegion = useCallback(async (regionId: string) => {
    setRegionStatus(regionId, { status: 'loading', error: undefined })
    const result = await window.api.unblockRegion(regionId)
    if (result.ok) {
      setRegions((prev) => {
        const next = prev.map((r) =>
          r.id === regionId ? { ...r, status: 'active' as const } : r
        )
        syncBlockedCount(next)
        return next
      })
    } else {
      setRegionStatus(regionId, { status: 'error', error: result.error })
    }
  }, [setRegionStatus, syncBlockedCount])

  const unblockAll = useCallback(async () => {
    setGlobalLoading(true)
    setRegions((prev) => prev.map((r) => ({ ...r, status: 'loading' as const })))
    await window.api.unblockAll()
    setRegions((prev) => {
      const next = prev.map((r) => ({ ...r, status: 'active' as const }))
      syncBlockedCount(next)
      return next
    })
    setGlobalLoading(false)
  }, [syncBlockedCount])

  const refreshIps = useCallback(async () => {
    const elapsed = Date.now() - lastRefreshRef.current
    if (elapsed < REFRESH_COOLDOWN_MS && lastRefreshRef.current > 0) {
      const remaining = Math.ceil((REFRESH_COOLDOWN_MS - elapsed) / 1000)
      addLog('warning', `Refresh on cooldown — please wait ${remaining}s`)
      return
    }
    addLog('info', 'Refreshing IP ranges...')
    startCooldown()
    const diff = await window.api.refreshIps()
    const counts = await window.api.getCidrCounts()
    setRegions((prev) => prev.map((r) => ({ ...r, cidrCount: counts[r.id] ?? r.cidrCount })))
    const parts: string[] = []
    if (diff.added > 0) parts.push(`+${diff.added} new`)
    if (diff.removed > 0) parts.push(`-${diff.removed} removed`)
    addLog('success', parts.length > 0 ? `IP ranges updated: ${parts.join(', ')}` : 'IP ranges up to date — no changes')
  }, [addLog])

  // ── Permanent regions ──────────────────────────────────────────────────────
  const markRegionPermanent = useCallback(async (regionId: string) => {
    await window.api.markPermanent(regionId)
    setPermanentRegions((prev) =>
      prev.includes(regionId) ? prev : [...prev, regionId]
    )
  }, [])

  const unmarkRegionPermanent = useCallback(async (regionId: string) => {
    await window.api.unmarkPermanent(regionId)
    setPermanentRegions((prev) => prev.filter(id => id !== regionId))
  }, [])

  // ── Exe path ───────────────────────────────────────────────────────────────
  const updateExePath = useCallback(async (path: string): Promise<ExeValidationResult> => {
    const result = await window.api.setExePath(path)
    if (result.ok) setExePathState(path)
    return result
  }, [])

  const browseExe = useCallback(async (): Promise<string | null> => {
    return window.api.browseExe()
  }, [])

  // ── Ping ───────────────────────────────────────────────────────────────────
  const pingRegion = useCallback(async (regionId: string) => {
    setRegionStatus(regionId, { pingLoading: true, pingMs: undefined, pingIp: undefined })
    const result = await window.api.pingRegion(regionId)
    setRegionStatus(regionId, {
      pingLoading: false,
      pingMs: result.ms,
      pingIp: result.ip ?? undefined,
    })
    if (!result.ok) {
      addLog('warning', `[${regionId}] Ping failed: ${result.error ?? 'no CIDRs cached'}`)
    }
  }, [setRegionStatus, addLog])

  const pingAll = useCallback(async () => {
    setRegions(prev => prev.map(r => ({ ...r, pingLoading: true, pingMs: undefined, pingIp: undefined })))
    const promises = REGIONS.map(async (r) => {
      const result = await window.api.pingRegion(r.id)
      setRegionStatus(r.id, {
        pingLoading: false,
        pingMs: result.ms,
        pingIp: result.ip ?? undefined,
      })
    })
    await Promise.all(promises)
    addLog('info', 'Ping All complete')
  }, [setRegionStatus, addLog])

  const downloadUpdate = useCallback(async () => {
    setUpdateDownloading(true)
    setUpdateProgress(0)
    await window.api.downloadUpdate()
  }, [])

  const installUpdate = useCallback(() => {
    window.api.installUpdate()
  }, [])

  const clearLogs = useCallback(() => setLogs([]), [])

  const blockedCount = regions.filter((r) => r.status === 'blocked').length

  return {
    regions,
    logs,
    isAdmin,
    globalLoading,
    blockedCount,
    permanentRegions,
    updateInfo,
    updateDownloading,
    updateProgress,
    updateReady,
    matchmakingRegions,
    userLocation,
    serverStatus,
    exePath,
    initDone,
    initSteps,
    needsExeSetup,
    refreshCooldown,
    blockRegion,
    unblockRegion,
    unblockAll,
    refreshIps,
    markRegionPermanent,
    unmarkRegionPermanent,
    updateExePath,
    browseExe,
    pingRegion,
    pingAll,
    downloadUpdate,
    installUpdate,
    clearLogs
  }
}
