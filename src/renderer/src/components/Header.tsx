import { useEffect, useState } from 'react'

export function Titlebar() {
  const [isMaximized, setIsMaximized] = useState(false)
  const [appVersion, setAppVersion] = useState('1.1.0')

  useEffect(() => {
    window.api.win.isMaximized().then(setIsMaximized)
    window.api.getAppVersion().then(setAppVersion).catch(() => {})
  }, [])

  return (
    <div className="titlebar-drag flex items-center h-8 shrink-0 bg-[#0a0a0a] border-b border-white/[0.06] select-none">
      <div className="flex items-center gap-2 pl-3 flex-1">
        <img src="./icon.png" alt="" style={{ width: 18, height: 18, borderRadius: 4, flexShrink: 0 }} />
        <span className="gradient-title text-[14px] font-bold">DBD Blocker</span>
        <span className="text-[11px]" style={{ fontFamily: 'Inter, sans-serif', color: 'rgba(255,255,255,0.22)' }}>{`v${appVersion} · by Steaxs`}</span>
      </div>

      <div className="flex h-full no-drag">
        <button
          onClick={() => window.api.win.minimize()}
          className="w-[46px] h-full flex items-center justify-center text-white/60 hover:bg-white/[0.08] hover:text-white transition-colors cursor-default"
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <rect x="2" y="6" width="8" height="1" fill="currentColor" />
          </svg>
        </button>

        <button
          onClick={() => { window.api.win.maximize(); setIsMaximized(v => !v) }}
          className="w-[46px] h-full flex items-center justify-center text-white/60 hover:bg-white/[0.08] hover:text-white transition-colors cursor-default"
        >
          {isMaximized ? (
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect x="3.5" y="1" width="7" height="7" rx="0.5" fill="none" stroke="currentColor" strokeWidth="1" />
              <rect x="1.5" y="3" width="7" height="7" rx="0.5" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12">
              <rect x="2" y="2" width="8" height="8" rx="0.5" fill="none" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>

        <button
          onClick={() => window.api.win.close()}
          className="w-[46px] h-full flex items-center justify-center text-white/60 hover:bg-[#F44336]/90 hover:text-white transition-colors cursor-default"
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <path d="M2 2L10 10M10 2L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  )
}
