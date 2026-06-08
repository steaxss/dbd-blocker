import { Check, Loader2, AlertCircle } from 'lucide-react'
import type { InitStep } from '../types'

interface SplashScreenProps {
  steps: InitStep[]
  exiting: boolean
}

export function SplashScreen({ steps, exiting }: SplashScreenProps) {
  const total    = steps.length
  const done     = steps.filter(s => s.status === 'done' || s.status === 'error').length
  const progress = total > 0 ? (done / total) * 100 : 0
  const isActive = progress > 0 && progress < 100

  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col items-center justify-center titlebar-drag"
      style={{
        background:  '#0a0a0a',
        opacity:     exiting ? 0 : 1,
        transition:  'opacity 0.55s ease',
        pointerEvents: exiting ? 'none' : 'all',
      }}
    >
      <div className="animated-bg" />

      <div className="relative z-10 w-[400px] no-drag">

        <div className="text-center mb-12">
          <h1 className="gradient-header text-[1.7rem] font-bold tracking-[0.14em] uppercase mb-3">
            DBD Server Blocker
          </h1>
          <p className="text-[10px] text-white/20 font-mono uppercase tracking-[0.22em]">
            Initializing system
          </p>
        </div>

        <div className="mb-8">
          <div
            className="relative h-[2px] rounded-full overflow-hidden"
            style={{ background: 'rgba(255,255,255,0.07)' }}
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full"
              style={{
                width:      `${progress}%`,
                background: 'linear-gradient(90deg, #7046DA 0%, #B579FF 60%, #5AC8FF 100%)',
                boxShadow:  '0 0 10px rgba(181,121,255,0.5)',
                transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
              }}
            />
            {isActive && (
              <div
                className="absolute inset-y-0"
                style={{
                  left:       0,
                  width:      `${progress}%`,
                  background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.35) 50%, transparent 100%)',
                  animation:  'progress-shimmer 1.6s ease-in-out infinite',
                }}
              />
            )}
          </div>

          <div className="flex justify-end mt-1.5">
            <span
              className="text-[10px] font-mono transition-colors duration-300"
              style={{ color: progress === 100 ? '#44FF41' : 'rgba(255,255,255,0.2)' }}
            >
              {Math.round(progress)}%
            </span>
          </div>
        </div>

        <div className="space-y-3.5">
          {steps.map((step) => {
            const isDone    = step.status === 'done'
            const isRunning = step.status === 'running'
            const isError   = step.status === 'error'
            const isPending = step.status === 'pending'

            return (
              <div key={step.id} className="flex items-center gap-3">
                <div className="shrink-0 w-[18px] h-[18px] flex items-center justify-center">
                  {isDone ? (
                    <div
                      className="w-[18px] h-[18px] rounded-full flex items-center justify-center"
                      style={{ background: 'rgba(68,255,65,0.12)', border: '1px solid rgba(68,255,65,0.35)' }}
                    >
                      <Check className="w-2.5 h-2.5" style={{ color: '#44FF41' }} />
                    </div>
                  ) : isError ? (
                    <div
                      className="w-[18px] h-[18px] rounded-full flex items-center justify-center"
                      style={{ background: 'rgba(244,67,54,0.12)', border: '1px solid rgba(244,67,54,0.35)' }}
                    >
                      <AlertCircle className="w-2.5 h-2.5" style={{ color: '#F44336' }} />
                    </div>
                  ) : isRunning ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: '#B579FF' }} />
                  ) : (
                    <div
                      className="w-[18px] h-[18px] rounded-full"
                      style={{ border: '1px solid rgba(255,255,255,0.1)' }}
                    />
                  )}
                </div>

                <span
                  className="flex-1 text-[12px] font-semibold transition-all duration-300"
                  style={{
                    color: isDone    ? 'rgba(255,255,255,0.55)'
                         : isError   ? '#F44336'
                         : isRunning ? '#fff'
                         : 'rgba(255,255,255,0.2)',
                  }}
                >
                  {step.label}
                </span>

                {step.detail && (
                  <span
                    className="text-[10px] font-mono shrink-0 px-1.5 py-0.5 rounded"
                    style={{
                      color:      isError ? '#F44336' : isDone ? '#44FF41' : 'rgba(255,255,255,0.3)',
                      background: isError ? 'rgba(244,67,54,0.1)' : isDone ? 'rgba(68,255,65,0.08)' : 'rgba(255,255,255,0.05)',
                    }}
                  >
                    {step.detail}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
