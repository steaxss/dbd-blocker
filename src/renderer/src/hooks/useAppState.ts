import { useState, useEffect, useCallback, useRef } from 'react'
import { REGIONS, getMatchmakingRegionsByGeo, getMatchmakingRegionsByPing } from '../regions'
import type {
  RegionState,
  LogEntry,
  ExeValidationResult,
  InitStep,
  UpdateInfo,
  ServerStatusMap,
  FirewallHealthResult,
  ActionResult,
} from '../types'

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const INIT_STEPS: InitStep[] = [
  { id: 'admin', label: 'Verifying administrator privileges', status: 'pending' },
  { id: 'settings', label: 'Loading application settings', status: 'pending' },
  { id: 'ips', label: 'Fetching AWS IP ranges', status: 'pending' },
  { id: 'rules', label: 'Reading active firewall rules', status: 'pending' },
]

const REFRESH_COOLDOWN_MS = 60_000

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

export function useAppState() {
  const [regions, setRegions] = useState<RegionState[]>(
    REGIONS.map((r) => ({ ...r, status: 'active', cidrCount: 0 }))
  )
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null)
  const [globalLoading, setGlobalLoading] = useState(false)
  const [permanentRegions, setPermanentRegions] = useState<string[]>([])
  const [exePath, setExePathState] = useState('')
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [serverStatus, setServerStatus] = useState<ServerStatusMap>({})
  const [updateDownloading, setUpdateDownloading] = useState(false)
  const [updateProgress, setUpdateProgress] = useState(0)
  const [updateReady, setUpdateReady] = useState(false)
  const [matchmakingRegions, setMatchmakingRegions] = useState<string[]>([])
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null)
  const [wfpHealth, setWfpHealth] = useState<FirewallHealthResult | null>(null)
  const [criticalError, setCriticalError] = useState<string | null>(null)

  const [initDone, setInitDone] = useState(false)
  const [initSteps, setInitSteps] = useState<InitStep[]>(INIT_STEPS)
  const [needsExeSetup, setNeedsExeSetup] = useState(false)

  const initRanRef = useRef(false)
  const lastRefreshRef = useRef<number>(0)
  const [refreshCooldown, setRefreshCooldown] = useState(0)
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

  const lockUsage = useCallback((message: string) => {
    setCriticalError(message)
    addLog('error', message)
  }, [addLog])

  const recheckFirewallHealth = useCallback(async () => {
    try {
      const health = await window.api.checkFirewallHealth()
      setWfpHealth(health)

      if (!health.ok) {
        const message = `Windows Filtering Platform is unavailable. ${health.error ?? 'Health check failed.'}`.trim()
        setCriticalError(message)
        addLog('error', message)
      } else {
        setCriticalError(null)
        addLog('success', 'WFP health check passed')
      }

      return health
    } catch (error) {
      const message = `Windows Filtering Platform health check failed: ${getErrorMessage(error)}`
      setWfpHealth({ ok: false, details: [], error: message })
      setCriticalError(message)
      addLog('error', message)
      return { ok: false, details: [], error: message } as FirewallHealthResult
    }
  }, [addLog])

  useEffect(() => {
    function setStep(id: string, updates: Partial<InitStep>) {
      setInitSteps((prev) => prev.map((s) => (s.id === id ? { ...s, ...updates } : s)))
    }

    if (initRanRef.current) return
    initRanRef.current = true

    async function loadGeoAndPing() {
      function applyGeo(lat: number, lng: number, source: string) {
        setUserLocation({ lat, lng })
        const mm = getMatchmakingRegionsByGeo(lat, lng)
        setMatchmakingRegions(mm)
        addLog('info', `Matchmaking region (${source}): ${mm.join(', ')}`)
      }

      const handleIpFallback = () => {
        fetch('https://ipapi.co/json/')
          .then((r) => r.json())
          .then((data: { latitude?: number; longitude?: number }) => {
            if (data.latitude != null && data.longitude != null) {
              applyGeo(data.latitude, data.longitude, 'IP geolocation')
            }
          })
          .catch(() => {
            fetch('http://ip-api.com/json/?fields=lat,lon')
              .then((r) => r.json())
              .then((data: { lat?: number; lon?: number }) => {
                if (data.lat != null && data.lon != null) {
                  applyGeo(data.lat, data.lon, 'IP geolocation')
                }
              })
              .catch(() => {
                addLog('warning', 'Unable to determine your location automatically')
              })
          })
      }

      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => applyGeo(pos.coords.latitude, pos.coords.longitude, 'browser geolocation'),
          () => handleIpFallback(),
          { timeout: 5000, maximumAge: 300000 }
        )
      } else {
        handleIpFallback()
      }

      setRegions((prev) => prev.map((r) => ({ ...r, pingLoading: true, pingMs: undefined, pingIp: undefined })))

      const pingResults: Record<string, number | null> = {}
      await Promise.allSettled(
        REGIONS.map(async (r) => {
          try {
            const result = await window.api.pingRegion(r.id)
            pingResults[r.id] = result.ms
            setRegionStatus(r.id, {
              pingLoading: false,
              pingMs: result.ms,
              pingIp: result.ip ?? undefined,
            })
          } catch (error) {
            pingResults[r.id] = null
            setRegionStatus(r.id, {
              pingLoading: false,
              pingMs: null,
              pingIp: undefined,
            })
            addLog('warning', `[${r.id}] Ping startup failed: ${getErrorMessage(error)}`)
          }
        })
      )

      const pingMm = getMatchmakingRegionsByPing(pingResults)
      if (pingMm) {
        setMatchmakingRegions(pingMm)
        const bestId = Object.entries(pingResults)
          .filter(([, ms]) => ms != null)
          .sort(([, a], [, b]) => (a as number) - (b as number))[0]?.[0]
        const bestMs = bestId ? pingResults[bestId] : null
        addLog('success', `Matchmaking region (ping): ${pingMm.join(', ')} -> lowest ping: ${bestMs}ms (${bestId})`)
      }
      addLog('info', 'Ping auto-startup complete')
    }

    async function init() {
      try {
        setStep('admin', { status: 'running' })
        try {
          const admin = await window.api.isAdmin()
          setIsAdmin(admin)
          if (!admin) {
            addLog('error', 'Not running as administrator -> firewall operations will fail. Please restart as admin.')
            setStep('admin', { status: 'error', detail: 'No admin' })
          } else {
            addLog('info', 'App started (administrator: OK)')
            setStep('admin', { status: 'done', detail: 'OK' })
          }
        } catch (error) {
          setIsAdmin(false)
          addLog('error', `Admin check failed: ${getErrorMessage(error)}`)
          setStep('admin', { status: 'error', detail: 'Check failed' })
        }

        setStep('settings', { status: 'running' })
        try {
          const [path, permanent, exeCheck] = await Promise.all([
            window.api.getExePath(),
            window.api.getPermanentRegions(),
            window.api.checkExePath(),
          ])
          setExePathState(path)
          setPermanentRegions(permanent)
          if (permanent.length > 0) {
            addLog('warning', `Permanent blocks loaded: ${permanent.join(', ')}`)
          }
          if (!exeCheck.ok) {
            setNeedsExeSetup(true)
            addLog('error', 'DBD executable not found -> please set the correct path in settings')
            setStep('settings', { status: 'error', detail: 'Exe not found' })
          } else {
            setStep('settings', { status: 'done' })
          }
        } catch (error) {
          addLog('error', `Settings load failed: ${getErrorMessage(error)}`)
          setStep('settings', { status: 'error', detail: 'Load failed' })
        }

        setStep('ips', { status: 'running' })
        try {
          const diff = await window.api.refreshIps()
          startCooldown()
          const newCounts = await window.api.getCidrCounts()
          setRegions((prev) => prev.map((r) => ({ ...r, cidrCount: newCounts[r.id] ?? 0 })))
          const diffParts: string[] = []
          if (diff.added > 0) diffParts.push(`+${diff.added} new`)
          if (diff.removed > 0) diffParts.push(`-${diff.removed} removed`)
          const diffStr = diffParts.length > 0 ? ` (${diffParts.join(', ')})` : ' (no changes)'
          addLog('info', `IP ranges updated${diffStr}`)
          setStep('ips', { status: 'done', detail: `${REGIONS.length} regions${diffStr}` })
        } catch (error) {
          addLog('error', `AWS IP refresh failed: ${getErrorMessage(error)}`)
          setStep('ips', { status: 'error', detail: 'Refresh failed' })
        }

        setStep('rules', { status: 'running' })
        try {
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
        } catch (error) {
          addLog('error', `Firewall state read failed: ${getErrorMessage(error)}`)
          setStep('rules', { status: 'error', detail: 'Read failed' })
        }

        await recheckFirewallHealth()

        window.api.checkForUpdate()
          .then((info) => {
            if (info.available) setUpdateInfo(info)
          })
          .catch((error) => {
            addLog('warning', `Update check failed: ${getErrorMessage(error)}`)
          })

        window.api.getServerStatus()
          .then((res) => {
            if (res.ok) setServerStatus(res.data)
          })
          .catch((error) => {
            addLog('warning', `Server status fetch failed: ${getErrorMessage(error)}`)
          })

        void loadGeoAndPing()
      } catch (error) {
        addLog('error', `Initialization failed: ${getErrorMessage(error)}`)
      } finally {
        setInitDone(true)
      }
    }

    void init()

    return () => {
      if (cooldownTimerRef.current) clearInterval(cooldownTimerRef.current)
    }
  }, [addLog, recheckFirewallHealth, setRegionStatus, syncBlockedCount])

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

  useEffect(() => {
    const interval = setInterval(async () => {
      const res = await window.api.getServerStatus().catch(() => null)
      if (res?.ok) setServerStatus(res.data)
    }, 20 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  const handleCriticalActionFailure = useCallback((result: ActionResult, fallbackMessage: string) => {
    if (result.code === 'wfp_verification_failed') {
      lockUsage(`Windows Filtering Platform verification failed. ${result.error ?? fallbackMessage}`)
      void recheckFirewallHealth()
    }
  }, [lockUsage, recheckFirewallHealth])

  const blockRegion = useCallback(async (regionId: string) => {
    if (criticalError) return
    setRegionStatus(regionId, { status: 'loading', error: undefined })
    try {
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
        handleCriticalActionFailure(result, 'Unable to block region.')
      }
    } catch (error) {
      const message = getErrorMessage(error)
      setRegionStatus(regionId, { status: 'error', error: message })
      addLog('error', `[${regionId}] Block failed: ${message}`)
    }
  }, [addLog, criticalError, handleCriticalActionFailure, setRegionStatus, syncBlockedCount])

  const unblockRegion = useCallback(async (regionId: string) => {
    if (criticalError) return
    setRegionStatus(regionId, { status: 'loading', error: undefined })
    try {
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
    } catch (error) {
      const message = getErrorMessage(error)
      setRegionStatus(regionId, { status: 'error', error: message })
      addLog('error', `[${regionId}] Unblock failed: ${message}`)
    }
  }, [addLog, criticalError, setRegionStatus, syncBlockedCount])

  const unblockAll = useCallback(async () => {
    if (criticalError) return
    const previousRegions = regions
    setGlobalLoading(true)
    setRegions((prev) => prev.map((r) => ({ ...r, status: 'loading' as const })))
    try {
      const result = await window.api.unblockAll()
      if (!result.ok) {
        throw new Error(result.error ?? 'Unblock All failed')
      }
      setRegions((prev) => {
        const next = prev.map((r) => ({ ...r, status: 'active' as const }))
        syncBlockedCount(next)
        return next
      })
    } catch (error) {
      setRegions(previousRegions)
      syncBlockedCount(previousRegions)
      addLog('error', `Unblock All failed: ${getErrorMessage(error)}`)
    } finally {
      setGlobalLoading(false)
    }
  }, [addLog, criticalError, regions, syncBlockedCount])

  const refreshIps = useCallback(async () => {
    if (criticalError) return
    const elapsed = Date.now() - lastRefreshRef.current
    if (elapsed < REFRESH_COOLDOWN_MS && lastRefreshRef.current > 0) {
      const remaining = Math.ceil((REFRESH_COOLDOWN_MS - elapsed) / 1000)
      addLog('warning', `Refresh on cooldown -> please wait ${remaining}s`)
      return
    }
    addLog('info', 'Refreshing IP ranges...')
    try {
      const diff = await window.api.refreshIps()
      startCooldown()
      const counts = await window.api.getCidrCounts()
      setRegions((prev) => prev.map((r) => ({ ...r, cidrCount: counts[r.id] ?? r.cidrCount })))
      const parts: string[] = []
      if (diff.added > 0) parts.push(`+${diff.added} new`)
      if (diff.removed > 0) parts.push(`-${diff.removed} removed`)
      addLog('success', parts.length > 0 ? `IP ranges updated: ${parts.join(', ')}` : 'IP ranges up to date -> no changes')
    } catch (error) {
      addLog('error', `IP refresh failed: ${getErrorMessage(error)}`)
    }
  }, [addLog, criticalError])

  const markRegionPermanent = useCallback(async (regionId: string) => {
    try {
      await window.api.markPermanent(regionId)
      setPermanentRegions((prev) =>
        prev.includes(regionId) ? prev : [...prev, regionId]
      )
    } catch (error) {
      addLog('error', `[${regionId}] Failed to mark permanent: ${getErrorMessage(error)}`)
    }
  }, [addLog])

  const unmarkRegionPermanent = useCallback(async (regionId: string) => {
    try {
      await window.api.unmarkPermanent(regionId)
      setPermanentRegions((prev) => prev.filter((id) => id !== regionId))
    } catch (error) {
      addLog('error', `[${regionId}] Failed to remove permanent flag: ${getErrorMessage(error)}`)
    }
  }, [addLog])

  const updateExePath = useCallback(async (path: string): Promise<ExeValidationResult> => {
    try {
      const result = await window.api.setExePath(path)
      if (result.ok) setExePathState(path)
      return result
    } catch (error) {
      return { ok: false, error: getErrorMessage(error) }
    }
  }, [])

  const browseExe = useCallback(async (): Promise<string | null> => {
    try {
      return await window.api.browseExe()
    } catch {
      return null
    }
  }, [])

  const pingRegion = useCallback(async (regionId: string) => {
    setRegionStatus(regionId, { pingLoading: true, pingMs: undefined, pingIp: undefined })
    try {
      const result = await window.api.pingRegion(regionId)
      setRegionStatus(regionId, {
        pingLoading: false,
        pingMs: result.ms,
        pingIp: result.ip ?? undefined,
      })
      if (!result.ok) {
        addLog('warning', `[${regionId}] Ping failed: ${result.error ?? 'Unknown error'}`)
      }
    } catch (error) {
      const message = getErrorMessage(error)
      setRegionStatus(regionId, {
        pingLoading: false,
        pingMs: null,
        pingIp: undefined,
      })
      addLog('warning', `[${regionId}] Ping failed: ${message}`)
    }
  }, [addLog, setRegionStatus])

  const pingAll = useCallback(async () => {
    if (criticalError) return
    setRegions((prev) => prev.map((r) => ({ ...r, pingLoading: true, pingMs: undefined, pingIp: undefined })))
    const results = await Promise.allSettled(
      REGIONS.map(async (r) => {
        const result = await window.api.pingRegion(r.id)
        setRegionStatus(r.id, {
          pingLoading: false,
          pingMs: result.ms,
          pingIp: result.ip ?? undefined,
        })
        return result
      })
    )

    let failures = 0
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failures += 1
        setRegionStatus(REGIONS[index].id, {
          pingLoading: false,
          pingMs: null,
          pingIp: undefined,
        })
      }
    })

    addLog('info', failures > 0 ? `Ping All complete with ${failures} failure(s)` : 'Ping All complete')
  }, [addLog, criticalError, setRegionStatus])

  const downloadUpdate = useCallback(async () => {
    try {
      setUpdateDownloading(true)
      setUpdateProgress(0)
      await window.api.downloadUpdate()
    } catch (error) {
      setUpdateDownloading(false)
      addLog('error', `Update download failed: ${getErrorMessage(error)}`)
    }
  }, [addLog])

  const installUpdate = useCallback(async () => {
    try {
      await window.api.installUpdate()
    } catch (error) {
      addLog('error', `Update install failed: ${getErrorMessage(error)}`)
    }
  }, [addLog])

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
    wfpHealth,
    criticalError,
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
    clearLogs,
    recheckFirewallHealth,
  }
}
