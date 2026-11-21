import { Check, Sparkles } from 'lucide-react'
import logo from '../assets/overlaytools-logo.png'

const DISCORD_URL = 'https://discord.com/invite/aVdT8rRJKc'

const FEATURES = [
  'Killer & Survivor streak overlays',
  'Tournament & scrim overlays',
  'Dual match timer',
  'Perk timers (BT, DS, Hook stage...)',
  'Map overlay with auto-detection',
  'DBDL ladder display',
]

const SHORT_FEATURES = ['Streak overlays', 'Tournaments', 'Match timer', 'Perk timers', 'Map detection']

const BORDER = 'linear-gradient(135deg, rgba(181,121,255,0.8), rgba(112,70,218,0.25) 45%, rgba(68,255,65,0.4))'
const SURFACE = 'linear-gradient(160deg, #17121f 0%, #0d0b12 60%, #0b0b0d 100%)'
const CTA = 'linear-gradient(90deg, #B579FF, #7046DA)'

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d="M20.32 4.37A19.8 19.8 0 0 0 15.4 2.85a.07.07 0 0 0-.08.04c-.21.38-.45.87-.61 1.25a18.3 18.3 0 0 0-5.43 0 12.6 12.6 0 0 0-.62-1.25.08.08 0 0 0-.08-.04 19.7 19.7 0 0 0-4.88 1.52.07.07 0 0 0-.03.03C.53 9.05-.32 13.58.1 18.06a.08.08 0 0 0 .03.06 19.9 19.9 0 0 0 5.99 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.23-2a.08.08 0 0 0-.04-.11 13.1 13.1 0 0 1-1.87-.89.08.08 0 0 1 0-.13l.37-.29a.07.07 0 0 1 .08-.01c3.93 1.79 8.18 1.79 12.06 0a.07.07 0 0 1 .08.01l.37.29a.08.08 0 0 1 0 .13 12.3 12.3 0 0 1-1.87.89.08.08 0 0 0-.04.11c.36.7.77 1.37 1.23 2a.08.08 0 0 0 .08.03 19.8 19.8 0 0 0 6-3.03.08.08 0 0 0 .03-.06c.5-5.18-.84-9.67-3.55-13.66a.06.06 0 0 0-.03-.03ZM8.02 15.33c-1.18 0-2.16-1.09-2.16-2.42s.96-2.42 2.16-2.42c1.21 0 2.18 1.1 2.16 2.42 0 1.33-.96 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.15-1.09-2.15-2.42s.95-2.42 2.15-2.42c1.21 0 2.18 1.1 2.16 2.42 0 1.33-.95 2.42-2.16 2.42Z" />
    </svg>
  )
}

function PremiumBadge() {
  return (
    <span className="inline-flex items-center gap-1 text-[9px] font-black uppercase tracking-[0.16em] px-1.5 py-0.5 rounded"
      style={{ background: CTA, color: '#fff' }}>
      <Sparkles className="w-2.5 h-2.5" /> Premium
    </span>
  )
}

function DiscordButton({ compact = false }: { compact?: boolean }) {
  return (
    <a
      href={DISCORD_URL}
      target="_blank"
      rel="noreferrer"
      className={`flex items-center justify-center gap-2 rounded-xl text-[12px] font-bold text-white whitespace-nowrap transition-all hover:-translate-y-px hover:brightness-110 ${compact ? 'px-4 py-2.5' : 'w-full py-2.5'}`}
      style={{ background: CTA, boxShadow: '0 6px 20px rgba(181,121,255,0.3)' }}
    >
      <DiscordIcon className="w-4 h-4" />
      Join the Discord
    </a>
  )
}

/** Promotion for DBD OverlayTools Premium. `card` for side columns, `banner` above content. */
export function OverlayToolsPromo({ variant = 'card' }: { variant?: 'card' | 'banner' }) {
  if (variant === 'banner') {
    return (
      <div className="rounded-2xl p-[1px]" style={{ background: BORDER }}>
        <div className="relative rounded-2xl px-5 py-4 overflow-hidden flex items-center gap-5" style={{ background: SURFACE }}>
          <div className="absolute -left-10 -top-20 w-56 h-56 rounded-full pointer-events-none"
            style={{ background: 'radial-gradient(circle, rgba(181,121,255,0.22), transparent 70%)' }} />
          <img src={logo} alt="DBD OverlayTools" className="relative w-14 h-14 shrink-0 drop-shadow-[0_4px_14px_rgba(181,121,255,0.35)]" />
          <div className="relative flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[15px] font-extrabold text-white">DBD OverlayTools</span>
              <PremiumBadge />
            </div>
            <div className="text-[11px] text-white/55 mb-2">Stream overlays built for Dead by Daylight. Always on top and ready for OBS.</div>
            <div className="flex flex-wrap gap-1.5">
              {SHORT_FEATURES.map((f) => (
                <span key={f} className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
                  style={{ background: 'rgba(181,121,255,0.08)', border: '1px solid rgba(181,121,255,0.2)', color: 'rgba(255,255,255,0.7)' }}>
                  <Check className="w-2.5 h-2.5" style={{ color: '#44FF41' }} /> {f}
                </span>
              ))}
            </div>
          </div>
          <div className="relative shrink-0">
            <DiscordButton compact />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-2xl p-[1px]" style={{ background: BORDER }}>
      <div className="relative rounded-2xl p-4 overflow-hidden" style={{ background: SURFACE }}>
        <div className="absolute -top-16 -right-16 w-40 h-40 rounded-full pointer-events-none"
          style={{ background: 'radial-gradient(circle, rgba(181,121,255,0.35), transparent 70%)' }} />
        <div className="relative flex items-center gap-3 mb-3">
          <img src={logo} alt="DBD OverlayTools" className="w-11 h-11 shrink-0 drop-shadow-[0_4px_12px_rgba(181,121,255,0.35)]" />
          <div className="min-w-0">
            <div className="text-[13px] font-extrabold text-white leading-tight mb-1">DBD OverlayTools</div>
            <PremiumBadge />
          </div>
        </div>
        <p className="relative text-[11px] text-white/55 leading-relaxed mb-3">
          Stream overlays built for Dead by Daylight. Always on top and ready for OBS.
        </p>
        <ul className="relative space-y-1.5 mb-4">
          {FEATURES.map((f) => (
            <li key={f} className="flex items-start gap-2 text-[11px] text-white/70">
              <Check className="w-3 h-3 shrink-0 mt-0.5" style={{ color: '#44FF41' }} />
              {f}
            </li>
          ))}
        </ul>
        <div className="relative"><DiscordButton /></div>
      </div>
    </div>
  )
}
