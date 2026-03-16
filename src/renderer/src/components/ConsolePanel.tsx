import { useEffect, useRef, useState, useCallback } from 'react'
import { Trash2, Copy, Check, ChevronDown, ChevronUp } from 'lucide-react'
import type { LogEntry } from '../types'

interface ConsolePanelProps {
  logs: LogEntry[]
  onClear: () => void
}

const LEVEL_COLOR: Record<string, string> = {
  info:    'rgba(255,255,255,0.45)',
  success: '#44FF41',
  warning: '#FF9800',
  error:   '#F44336',
  step:    'rgba(255,255,255,0.2)',
}

const LEVEL_TAG: Record<string, string> = {
  info:    'INFO',
  success: 'OK',
  warning: 'WARN',
  error:   'ERR',
  step:    '›',
}

const MIN_HEIGHT = 120
const MAX_HEIGHT = 520
const DEFAULT_HEIGHT = 200

export function ConsolePanel({ logs, onClear }: ConsolePanelProps) {
  const bottomRef    = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const stickRef     = useRef(true)
  const [copied, setCopied] = useState(false)
  const [height, setHeight] = useState(DEFAULT_HEIGHT)
  const [collapsed, setCollapsed] = useState(false)

  // drag-to-resize
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragRef.current = { startY: e.clientY, startH: height }
    const onMove = (ev: MouseEvent) => {
      if (!dragRef.current) return
      const delta = dragRef.current.startY - ev.clientY
      setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, dragRef.current.startH + delta)))
    }
    const onUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [height])

  const copyLogs = () => {
    const text = logs.map(e => `[${e.timestamp}] ${LEVEL_TAG[e.level] ?? '?'} ${e.message}`).join('\n')
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  useEffect(() => {
    if (stickRef.current) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  const onScroll = () => {
    const el = containerRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  const errorCount   = logs.filter(l => l.level === 'error').length
  const warningCount = logs.filter(l => l.level === 'warning').length

  return (
    <div
      className="shrink-0 flex flex-col border-t border-white/[0.06] relative z-10"
      style={{ height: collapsed ? 33 : height, background: 'rgba(10, 10, 10, 0.98)', transition: 'height 0.15s ease' }}
    >
      {/* Drag handle */}
      {!collapsed && (
        <div
          onMouseDown={onDragStart}
          className="absolute top-0 left-0 right-0 h-[5px] cursor-ns-resize z-20 group"
          style={{ marginTop: -2 }}
        >
          <div className="absolute inset-x-0 top-[2px] h-[1px] bg-white/[0.06] group-hover:bg-white/20 transition-colors" />
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between px-5 border-b border-white/[0.05]" style={{ height: 33, minHeight: 33 }}>
        <div className="flex items-center gap-2">
          <span className="gradient-title text-[10px] font-bold uppercase tracking-[0.14em]">
            Console
          </span>
          {logs.length > 0 && (
            <span className="text-[9px] text-white/20 font-mono">{logs.length}</span>
          )}
          {errorCount > 0 && (
            <span className="text-[9px] font-bold font-mono" style={{ color: '#F44336' }}>
              {errorCount}E
            </span>
          )}
          {warningCount > 0 && (
            <span className="text-[9px] font-bold font-mono" style={{ color: '#FF9800' }}>
              {warningCount}W
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={copyLogs}
            disabled={logs.length === 0}
            className="flex items-center gap-1 text-[10px] text-white/25 hover:text-white/60 transition-colors uppercase tracking-wider font-semibold disabled:opacity-30"
          >
            {copied ? <Check className="w-3 h-3" style={{ color: '#44FF41' }} /> : <Copy className="w-3 h-3" />}
            {copied ? <span style={{ color: '#44FF41' }}>Copied</span> : 'Copy'}
          </button>
          <button
            onClick={onClear}
            className="flex items-center gap-1 text-[10px] text-white/25 hover:text-white/60 transition-colors uppercase tracking-wider font-semibold"
          >
            <Trash2 className="w-3 h-3" />
            Clear
          </button>
          <button
            onClick={() => setCollapsed(c => !c)}
            className="flex items-center text-white/25 hover:text-white/60 transition-colors"
          >
            {collapsed ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Logs */}
      {!collapsed && (
        <div
          ref={containerRef}
          onScroll={onScroll}
          className="flex-1 overflow-y-auto px-5 py-2.5 space-y-0.5 font-mono"
        >
          {logs.length === 0 ? (
            <p className="text-[10px] text-white/15 pt-0.5">No output</p>
          ) : (
            logs.map((entry) => (
              <div key={entry.id} className="flex items-baseline gap-3 text-[10px] leading-[1.9]">
                <span className="text-white/20 tabular-nums shrink-0">{entry.timestamp}</span>
                <span
                  className="font-bold shrink-0 w-7"
                  style={{ color: LEVEL_COLOR[entry.level] ?? 'rgba(255,255,255,0.4)' }}
                >
                  {LEVEL_TAG[entry.level] ?? '?'}
                </span>
                <span
                  className="break-all"
                  style={{ color: LEVEL_COLOR[entry.level] ?? 'rgba(255,255,255,0.4)' }}
                >
                  {entry.message}
                </span>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  )
}
