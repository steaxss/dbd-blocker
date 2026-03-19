import { useState, useEffect } from 'react'
import { RefreshCw, ShieldOff, AlertTriangle, Settings, X, FolderOpen, LayoutGrid, Globe2, Wifi, Activity, Download } from 'lucide-react'
import { useAppState } from './hooks/useAppState'
import { Titlebar } from './components/Header'
import { RegionGrid } from './components/RegionGrid'
import { MapView } from './components/MapView'
import { ActiveConnections } from './components/ActiveConnections'
import { ConsolePanel } from './components/ConsolePanel'
import { SplashScreen } from './components/SplashScreen'
import { FlagIcon } from './components/FlagIcon'
import { REGIONS } from './regions'
import type { ExeValidationResult } from './types'

export default function App() {
  const {
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
    downloadUpdate,
    installUpdate,
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
    clearLogs
  } = useAppState()

  const activeCount = regions.length - blockedCount

  // View: grid | map | connections
  const [view, setView] = useState<'grid' | 'map' | 'connections'>('grid')

  // Splash screen fade-out
  const [showSplash, setShowSplash]       = useState(true)
  const [splashExiting, setSplashExiting] = useState(false)

  useEffect(() => {
    if (initDone) {
      setSplashExiting(true)
      const t = setTimeout(() => setShowSplash(false), 650)
      return () => clearTimeout(t)
    }
  }, [initDone])

  // Exe setup modal
  const [showExeSetupModal, setShowExeSetupModal] = useState(false)

  useEffect(() => {
    if (!showSplash && needsExeSetup) {
      setExePathInput(exePath)
      setExePathResult(null)
      setShowExeSetupModal(true)
    }
  }, [showSplash, needsExeSetup])

  // Tooltip hover state for status chips
  const [hoveredChip, setHoveredChip] = useState<'blocked' | 'open' | null>(null)

  // Block warning modal — shown before any block action
  const [pendingBlockAction, setPendingBlockAction] = useState<(() => Promise<void>) | null>(null)
  const [dontShowAgain, setDontShowAgain] = useState(false)

  function withBlockWarning(action: () => Promise<void>) {
    if (localStorage.getItem('blockWarningAck') === '1') {
      action()
      return
    }
    setDontShowAgain(false)
    setPendingBlockAction(() => action)
  }

  async function confirmBlock() {
    if (dontShowAgain) localStorage.setItem('blockWarningAck', '1')
    const action = pendingBlockAction
    setPendingBlockAction(null)
    if (action) await action()
  }

  function handleBlock(regionId: string) {
    withBlockWarning(() => blockRegion(regionId))
  }

  // Settings dialog
  const [showSettings, setShowSettings]           = useState(false)
  const [exePathInput, setExePathInput]           = useState('')
  const [exePathResult, setExePathResult]         = useState<ExeValidationResult | null>(null)
  const [savingExe, setSavingExe]                 = useState(false)

  function openSettings() {
    setExePathInput(exePath)
    setExePathResult(null)
    setShowSettings(true)
  }

  async function handleBrowseExe() {
    const picked = await browseExe()
    if (picked) setExePathInput(picked)
  }

  async function handleSaveExe() {
    setSavingExe(true)
    const result = await updateExePath(exePathInput)
    setExePathResult(result)
    setSavingExe(false)
    if (result.ok) setShowExeSetupModal(false)
  }

  // Derived lists for tooltip
  const blockedRegions = regions.filter(r => r.status === 'blocked')
  const openRegions    = regions.filter(r => r.status === 'active')

  const VIEW_TABS: Array<{ id: 'grid' | 'map' | 'connections'; label: string; icon: typeof LayoutGrid }> = [
    { id: 'grid',        label: 'Grid View',          icon: LayoutGrid },
    { id: 'map',         label: 'Map View',            icon: Globe2 },
    { id: 'connections', label: 'Active Connections',  icon: Activity },
  ]

  return (
    <div className="flex flex-col h-screen bg-[#0a0a0a] text-white select-none relative">

      {/* Animated radial glow background */}
      <div className="animated-bg" />

      {/* Titlebar — Windows controls */}
      <Titlebar />

      {/* Update banner */}
      {updateInfo?.available && (
        <div
          className="shrink-0 flex items-center justify-between px-6 py-2 relative z-40"
          style={{ background: 'rgba(181,121,255,0.1)', borderBottom: '1px solid rgba(181,121,255,0.25)' }}
        >
          <div className="flex items-center gap-2 text-[12px]" style={{ color: '#B579FF' }}>
            <Download className="w-3.5 h-3.5 shrink-0" />
            <span className="font-bold">v{updateInfo.version} available</span>
            {updateDownloading ? (
              <span className="text-white/40 font-medium">— downloading... {updateProgress}%</span>
            ) : updateReady ? (
              <span className="text-white/40 font-medium">— download complete, ready to install</span>
            ) : (
              <span className="text-white/40 font-medium">— a new version of DBD Server Blocker is ready</span>
            )}
          </div>
          {updateReady ? (
            <button
              onClick={installUpdate}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all hover:-translate-y-px"
              style={{ background: 'rgba(68,255,65,0.15)', border: '1px solid rgba(68,255,65,0.35)', color: '#44FF41' }}
            >
              Install & Restart
            </button>
          ) : (
            <button
              onClick={downloadUpdate}
              disabled={updateDownloading}
              className="flex items-center gap-1.5 px-3 py-1 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all hover:-translate-y-px disabled:opacity-40"
              style={{ background: 'rgba(181,121,255,0.15)', border: '1px solid rgba(181,121,255,0.35)', color: '#B579FF' }}
            >
              {updateDownloading ? `${updateProgress}%` : 'Download'}
            </button>
          )}
        </div>
      )}

      {/* Header */}
      <div
        className="shrink-0 border-b border-white/[0.06] relative z-30 titlebar-drag"
        style={{ background: 'rgba(18, 18, 18, 0.95)', boxShadow: '0 8px 32px rgba(0,0,0,0.35)' }}
      >
        {/* App title */}
        <div className="pt-5 pb-3 text-center pointer-events-none">
          <h1 className="gradient-header text-[1.55rem] font-bold tracking-[0.14em] uppercase">
            DBD Server Blocker
          </h1>
        </div>

        {/* Toolbar */}
        <div className="no-drag px-6 pb-4 flex items-center justify-between gap-4">

          {/* Status chips with hover tooltips */}
          <div className="flex items-center gap-2">

            {/* Blocked chip */}
            {blockedCount > 0 && (
              <div
                className="relative"
                onMouseEnter={() => setHoveredChip('blocked')}
                onMouseLeave={() => setHoveredChip(null)}
              >
                <div
                  className="flex items-center gap-2 rounded-full px-4 py-1.5 text-[12px] font-bold uppercase tracking-[0.08em] cursor-default"
                  style={{ background: 'rgba(244,67,54,0.15)', color: '#F44336', border: '1px solid rgba(244,67,54,0.3)' }}
                >
                  <span className="w-2 h-2 rounded-full bg-[#F44336] animate-pulse block" />
                  {blockedCount} blocked
                </div>
                {hoveredChip === 'blocked' && (
                  <div
                    className="absolute top-full left-0 mt-2 rounded-xl py-2 min-w-[180px] z-50"
                    style={{ background: 'rgba(20,20,20,0.98)', border: '1px solid rgba(244,67,54,0.25)', boxShadow: '0 8px 24px rgba(0,0,0,0.6)' }}
                  >
                    <p className="text-[9px] font-bold uppercase tracking-widest text-white/30 px-3 pb-1.5 border-b border-white/[0.06]">
                      Blocked regions
                    </p>
                    <div className="pt-1">
                      {blockedRegions.map(r => (
                        <div key={r.id} className="flex items-center gap-2 px-3 py-1">
                          <FlagIcon code={r.countryCode} style={{ width: 16, height: 'auto', borderRadius: 2, display: 'block', flexShrink: 0 }} fallback={r.flag} />
                          <span className="text-[11px] font-semibold" style={{ color: '#F44336' }}>{r.name}</span>
                          <span className="text-[10px] text-white/25 font-mono ml-auto">{r.id}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Open chip */}
            <div
              className="relative"
              onMouseEnter={() => setHoveredChip('open')}
              onMouseLeave={() => setHoveredChip(null)}
            >
              <div
                className="flex items-center gap-2 rounded-full px-4 py-1.5 text-[12px] font-semibold cursor-default"
                style={{ background: 'rgba(68,255,65,0.1)', color: '#44FF41', border: '1px solid rgba(68,255,65,0.25)' }}
              >
                <span className="w-2 h-2 rounded-full block" style={{ background: '#44FF41' }} />
                {activeCount} open
              </div>
              {hoveredChip === 'open' && (
                <div
                  className="absolute top-full left-0 mt-2 rounded-xl py-2 min-w-[180px] z-50"
                  style={{ background: 'rgba(20,20,20,0.98)', border: '1px solid rgba(68,255,65,0.2)', boxShadow: '0 8px 24px rgba(0,0,0,0.6)' }}
                >
                  <p className="text-[9px] font-bold uppercase tracking-widest text-white/30 px-3 pb-1.5 border-b border-white/[0.06]">
                    Open regions
                  </p>
                  <div className="pt-1">
                    {openRegions.map(r => (
                      <div key={r.id} className="flex items-center gap-2 px-3 py-1">
                        <FlagIcon code={r.countryCode} style={{ width: 16, height: 'auto', borderRadius: 2, display: 'block', flexShrink: 0 }} fallback={r.flag} />
                        <span className="text-[11px] font-semibold" style={{ color: '#44FF41' }}>{r.name}</span>
                        <span className="text-[10px] text-white/25 font-mono ml-auto">{r.id}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Admin warning */}
            {isAdmin === false && (
              <div
                className="flex items-center gap-1.5 rounded-full px-4 py-1.5 text-[12px] font-semibold uppercase tracking-[0.06em]"
                style={{ background: 'rgba(255,152,0,0.15)', color: '#FF9800', border: '1px solid rgba(255,152,0,0.3)' }}
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                No admin
              </div>
            )}

          </div>

          {/* View toggle */}
          <div
            className="flex rounded-[10px] overflow-hidden ml-auto mr-2"
            style={{ border: '1px solid rgba(255,255,255,0.12)' }}
          >
            {VIEW_TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setView(id)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.08em] transition-colors duration-150"
                style={view === id
                  ? { background: id === 'connections' ? 'rgba(68,255,65,0.12)' : 'rgba(255,255,255,0.1)', color: id === 'connections' ? '#44FF41' : '#fff' }
                  : { background: 'transparent', color: 'rgba(255,255,255,0.35)' }
                }
              >
                <Icon className="w-3 h-3" />
                {label}
              </button>
            ))}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2">

            {/* Settings */}
            <button
              onClick={openSettings}
              className="flex items-center justify-center w-8 h-8 rounded-lg text-[13px] font-bold uppercase tracking-[0.08em] transition-all duration-200 hover:-translate-y-px"
              style={{ background: 'rgba(255,255,255,0.05)', border: '2px solid rgba(255,255,255,0.15)', color: '#ccc' }}
            >
              <Settings className="w-3.5 h-3.5" />
            </button>

            {/* Refresh IPs with cooldown */}
            <button
              onClick={refreshIps}
              disabled={globalLoading || refreshCooldown > 0}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-[10px] text-[13px] font-bold uppercase tracking-[0.08em] transition-all duration-200 disabled:opacity-30 hover:-translate-y-px"
              style={{ background: 'rgba(255,255,255,0.05)', border: '2px solid rgba(255,255,255,0.15)', color: '#ccc' }}
              title={refreshCooldown > 0 ? `Refresh available in ${refreshCooldown}s` : 'Refresh AWS IP ranges'}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${globalLoading ? 'animate-spin' : ''}`} />
              {refreshCooldown > 0 ? `${refreshCooldown}s` : 'Refresh IPs'}
            </button>

            {/* Ping All */}
            <button
              onClick={pingAll}
              disabled={globalLoading}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-[10px] text-[13px] font-bold uppercase tracking-[0.08em] transition-all duration-200 disabled:opacity-30 hover:-translate-y-px"
              style={{ background: 'rgba(255,255,255,0.05)', border: '2px solid rgba(255,255,255,0.15)', color: '#ccc' }}
              title="Test ping on all servers"
            >
              <Wifi className="w-3.5 h-3.5" />
              Ping All
            </button>

            <button
              onClick={unblockAll}
              disabled={globalLoading || blockedCount === 0}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-[10px] text-[13px] font-bold uppercase tracking-[0.08em] transition-all duration-200 disabled:opacity-30 hover:-translate-y-px"
              style={{ background: 'rgba(255,255,255,0.05)', border: '2px solid rgba(255,255,255,0.15)', color: '#ccc' }}
            >
              <ShieldOff className="w-3.5 h-3.5" />
              Unblock All
            </button>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 overflow-hidden relative z-10" onClick={() => setHoveredChip(null)}>
        {view === 'connections' ? (
          <ActiveConnections />
        ) : view === 'map' ? (
          <MapView
            regions={regions}
            permanentRegions={permanentRegions}
            serverStatus={serverStatus}
            onBlock={handleBlock}
            onUnblock={unblockRegion}
            onPingRegion={pingRegion}
            globalLoading={globalLoading}
          />
        ) : (
          <div className="h-full overflow-y-auto">
            <div className="mx-auto max-w-5xl px-6 py-5">
              <RegionGrid
                regions={regions}
                permanentRegions={permanentRegions}
                serverStatus={serverStatus}
                onBlock={handleBlock}
                onUnblock={unblockRegion}
                onMarkPermanent={markRegionPermanent}
                onUnmarkPermanent={unmarkRegionPermanent}
                onPing={pingRegion}
              />
            </div>
          </div>
        )}
      </div>

      {/* Console */}
      <ConsolePanel logs={logs} onClear={clearLogs} />

      {/* ── Block warning modal (shown before any block action) ── */}
      {pendingBlockAction && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)' }}
        >
          <div
            className="rounded-2xl p-8 w-[520px]"
            style={{ background: 'rgba(18,18,18,0.99)', outline: '1px solid rgba(244,67,54,0.2)', outlineOffset: '-1px', boxShadow: '0 24px 80px rgba(0,0,0,0.9)' }}
          >
            {/* Header */}
            <div className="flex items-start gap-4 mb-6">
              <div
                className="w-11 h-11 rounded-xl shrink-0 flex items-center justify-center"
                style={{ background: 'rgba(244,67,54,0.1)', border: '1px solid rgba(244,67,54,0.3)' }}
              >
                <AlertTriangle className="w-5 h-5" style={{ color: '#F44336' }} />
              </div>
              <div>
                <h2 className="text-[1.2rem] font-bold text-white mb-1">Before you block</h2>
                <p className="text-[13px] text-white/40 leading-relaxed">
                  Blocking a region prevents DBD from connecting to those servers. For this to work reliably, read the following.
                </p>
              </div>
            </div>

            {/* Host requirement */}
            <div className="mb-4 p-4 rounded-xl" style={{ background: 'rgba(244,67,54,0.07)', border: '1px solid rgba(244,67,54,0.22)' }}>
              <p className="text-[13px] font-bold uppercase tracking-wider mb-2" style={{ color: '#F44336' }}>
                You must be the lobby host
              </p>
              <p className="text-[13px] text-white/45 leading-relaxed">
                Whether you play <strong className="text-white/70">survivor or killer</strong>, in <strong className="text-white/70">public or private matches</strong> — you must always be the lobby host for the block to take effect.
                <br /><br />
                In public games, <strong className="text-white/70">invite friends into your lobby</strong> rather than joining theirs. In custom games, <strong className="text-white/70">create the lobby yourself</strong>.
                <br /><br />
                If you are not the host, DBD may refuse the server connection and return you to the lobby.
              </p>
            </div>

            {/* Additional notes */}
            <div className="mb-6 p-4 rounded-xl" style={{ background: 'rgba(255,152,0,0.06)', border: '1px solid rgba(255,152,0,0.18)' }}>
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" style={{ color: '#FF9800' }} />
                <span className="text-[13px] font-bold uppercase tracking-wider" style={{ color: '#FF9800' }}>Also keep in mind</span>
              </div>
              <ul className="space-y-1.5">
                {[
                  'Restart your game after applying or removing blocks for changes to take effect.',
                  'If a blocked region\'s server is offline or disabled by BHVR, DBD will find the next available region.',
                  'Use the Ping button on a region card to check whether a server is reachable before blocking others.',
                ].map((text, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="text-[11px] font-bold mt-0.5 shrink-0" style={{ color: '#FF9800' }}>›</span>
                    <span className="text-[13px] text-white/40 leading-relaxed">{text}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* VPN note */}
            <div className="mb-6 p-4 rounded-xl" style={{ background: 'rgba(181,121,255,0.06)', border: '1px solid rgba(181,121,255,0.18)' }}>
              <p className="text-[13px] font-bold uppercase tracking-wider mb-2" style={{ color: '#B579FF' }}>
                Want to force a specific region?
              </p>
              <p className="text-[13px] text-white/40 leading-relaxed">
                This program can only <strong className="text-white/70">block</strong> regions — it cannot force you to connect to a specific one.
                DBD's matchmaking automatically picks from the remaining unblocked regions, so there is no guarantee you will land on the one you want.
                <br /><br />
                To <strong className="text-white/70">force</strong> a specific region, you need to use a <strong className="text-white/70">VPN</strong> connected to that region. The VPN routes your traffic to the targeted server, ensuring your connection goes through it.
              </p>
            </div>

            {/* Don't show again + actions */}
            <div className="flex items-center justify-between gap-3">
              <label className="flex items-center gap-2 cursor-pointer select-none group">
                <input
                  type="checkbox"
                  checked={dontShowAgain}
                  onChange={e => setDontShowAgain(e.target.checked)}
                  className="w-3.5 h-3.5 accent-[#B579FF] cursor-pointer"
                />
                <span className="text-[12px] text-white/30 group-hover:text-white/50 transition-colors">Don't show again</span>
              </label>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPendingBlockAction(null)}
                  className="px-5 py-2.5 rounded-xl text-[13px] font-bold uppercase tracking-wider transition-all hover:-translate-y-px"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '2px solid rgba(255,255,255,0.12)', color: '#999' }}
                >
                  Cancel
                </button>
                <button
                  onClick={confirmBlock}
                  className="px-6 py-2.5 rounded-xl text-[13px] font-bold uppercase tracking-wider transition-all hover:-translate-y-px active:translate-y-0"
                  style={{ background: 'linear-gradient(135deg, #F44336 0%, #C62828 100%)', border: '2px solid rgba(244,67,54,0.4)', color: '#fff', boxShadow: '0 4px 12px rgba(244,67,54,0.35)' }}
                >
                  I understand — Block
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Splash screen ── */}
      {showSplash && <SplashScreen steps={initSteps} exiting={splashExiting} />}

      {/* ── Exe Setup Modal ── */}
      {showExeSetupModal && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)' }}
        >
          <div
            className="rounded-2xl p-8 w-[540px]"
            style={{ background: 'rgba(18,18,18,0.99)', outline: '1px solid rgba(255,255,255,0.1)', outlineOffset: '-1px', boxShadow: '0 24px 80px rgba(0,0,0,0.9)' }}
          >
            <div className="flex items-start gap-4 mb-6">
              <div
                className="w-11 h-11 rounded-xl shrink-0 flex items-center justify-center"
                style={{ background: 'rgba(244,67,54,0.12)', border: '1px solid rgba(244,67,54,0.3)' }}
              >
                <AlertTriangle className="w-5 h-5" style={{ color: '#F44336' }} />
              </div>
              <div>
                <h2 className="text-[1.2rem] font-bold text-white mb-1">Executable Not Found</h2>
                <p className="text-[13px] text-white/40 leading-relaxed">
                  Dead by Daylight was not found at the configured path.<br />
                  Firewall rules cannot be applied until you set the correct executable.
                </p>
              </div>
            </div>

            <div className="mb-6 p-4 rounded-xl" style={{ background: 'rgba(255,152,0,0.07)', border: '1px solid rgba(255,152,0,0.22)' }}>
              <p className="text-[13px] font-bold uppercase tracking-wider mb-2" style={{ color: '#FF9800' }}>
                Important — Select the correct file
              </p>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgba(68,255,65,0.1)', color: '#44FF41', border: '1px solid rgba(68,255,65,0.25)' }}>✓</span>
                  <span className="text-[12px] font-mono text-white/70">DeadByDaylight-Win64-Shipping.exe</span>
                  <span className="text-[11px] text-white/35 ml-auto">the game</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-bold px-1.5 py-0.5 rounded" style={{ background: 'rgba(244,67,54,0.1)', color: '#F44336', border: '1px solid rgba(244,67,54,0.25)' }}>✗</span>
                  <span className="text-[12px] font-mono text-white/40">DeadByDaylight.exe</span>
                  <span className="text-[11px] text-white/25 ml-auto">launcher only</span>
                </div>
              </div>
              <p className="text-[11px] font-mono text-white/25 mt-3 leading-relaxed">
                ...\Dead by Daylight\DeadByDaylight\Binaries\Win64\DeadByDaylight-Win64-Shipping.exe
              </p>
            </div>

            <div className="mb-6">
              <label className="block text-[13px] font-bold uppercase tracking-widest text-white/50 mb-2">Executable Path</label>
              <div className="flex gap-2 mb-2">
                <input
                  value={exePathInput}
                  onChange={e => { setExePathInput(e.target.value); setExePathResult(null) }}
                  spellCheck={false}
                  className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-mono text-white/80 outline-none"
                  style={{ background: 'rgba(255,255,255,0.06)', border: `1px solid ${exePathResult?.ok === false ? 'rgba(244,67,54,0.5)' : exePathResult?.ok ? 'rgba(68,255,65,0.35)' : 'rgba(255,255,255,0.12)'}` }}
                  placeholder="C:\...\DeadByDaylight-Win64-Shipping.exe"
                />
                <button
                  onClick={handleBrowseExe}
                  className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-[12px] font-bold uppercase tracking-wider transition-all hover:-translate-y-px"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', color: '#ccc' }}
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  Browse
                </button>
              </div>
              {exePathResult && (
                <p className="text-[12px] mt-1.5 leading-relaxed" style={{ color: exePathResult.ok ? (exePathResult.warning ? '#FF9800' : '#44FF41') : '#F44336' }}>
                  {exePathResult.error ?? exePathResult.warning ?? '✓ Path saved successfully'}
                </p>
              )}
            </div>

            <div className="flex items-center justify-between">
              <button onClick={() => setShowExeSetupModal(false)} className="text-[12px] font-semibold text-white/25 hover:text-white/50 transition-colors">
                Skip for now
              </button>
              <button
                onClick={handleSaveExe}
                disabled={savingExe || !exePathInput}
                className="px-8 py-2.5 rounded-xl text-[13px] font-bold uppercase tracking-wider transition-all hover:-translate-y-px disabled:opacity-30"
                style={{ background: 'linear-gradient(135deg, #7046DA 0%, #2A175E 100%)', border: '2px solid rgba(181,121,255,0.35)', color: '#fff', boxShadow: '0 4px 12px rgba(112,70,218,0.3)' }}
              >
                {savingExe ? 'Saving…' : 'Save & Continue'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Settings Modal ── */}
      {showSettings && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)' }}
          onClick={e => { if (e.target === e.currentTarget) setShowSettings(false) }}
        >
          <div
            className="rounded-2xl p-8 w-[500px]"
            style={{ background: 'rgba(22,22,22,0.98)', outline: '1px solid rgba(255,255,255,0.1)', outlineOffset: '-1px', boxShadow: '0 20px 60px rgba(0,0,0,0.8)' }}
          >
            <div className="flex items-center justify-between mb-7">
              <h2 className="gradient-title text-[1.25rem] font-bold uppercase tracking-[0.1em]">Settings</h2>
              <button onClick={() => setShowSettings(false)} className="text-white/30 hover:text-white/70 transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="mb-7">
              <label className="block text-[13px] font-bold uppercase tracking-widest text-white/50 mb-3">
                Dead by Daylight Executable
              </label>
              <div className="flex gap-2 mb-2">
                <input
                  value={exePathInput}
                  onChange={e => { setExePathInput(e.target.value); setExePathResult(null) }}
                  spellCheck={false}
                  className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-mono text-white/80 outline-none"
                  style={{ background: 'rgba(255,255,255,0.06)', border: `1px solid ${exePathResult?.ok === false ? 'rgba(244,67,54,0.5)' : exePathResult?.ok ? 'rgba(68,255,65,0.35)' : 'rgba(255,255,255,0.12)'}` }}
                  placeholder="C:\...\DeadByDaylight-Win64-Shipping.exe"
                />
                <button
                  onClick={handleBrowseExe}
                  className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-[12px] font-bold uppercase tracking-wider transition-all hover:-translate-y-px"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.15)', color: '#ccc' }}
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  Browse
                </button>
              </div>
              {exePathResult && (
                <p className="text-[12px] mt-1.5 leading-relaxed" style={{ color: exePathResult.ok ? (exePathResult.warning ? '#FF9800' : '#44FF41') : '#F44336' }}>
                  {exePathResult.error ?? exePathResult.warning ?? '✓ Path saved successfully'}
                </p>
              )}
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowSettings(false)}
                className="px-6 py-2.5 rounded-xl text-[13px] font-bold uppercase tracking-wider transition-all hover:-translate-y-px"
                style={{ background: 'rgba(255,255,255,0.05)', border: '2px solid rgba(255,255,255,0.15)', color: '#ccc' }}
              >
                Close
              </button>
              <button
                onClick={handleSaveExe}
                disabled={savingExe}
                className="px-8 py-2.5 rounded-xl text-[13px] font-bold uppercase tracking-wider transition-all hover:-translate-y-px disabled:opacity-30"
                style={{ background: 'linear-gradient(135deg, #7046DA 0%, #2A175E 100%)', border: '2px solid rgba(181,121,255,0.35)', color: '#fff', boxShadow: '0 4px 12px rgba(112,70,218,0.3)' }}
              >
                {savingExe ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
