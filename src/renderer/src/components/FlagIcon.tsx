import * as Flags from 'country-flag-icons/react/3x2'
import type { ComponentType, SVGProps } from 'react'

type FlagProps = SVGProps<SVGSVGElement> & { title?: string }

const flagMap = Flags as unknown as Record<string, ComponentType<FlagProps>>

interface FlagIconProps {
  code: string
  className?: string
  style?: React.CSSProperties
  fallback?: string
}

export function FlagIcon({ code, className, style, fallback }: FlagIconProps) {
  const Flag = flagMap[code.toUpperCase()]
  if (!Flag) {
    return <span style={style}>{fallback ?? code}</span>
  }
  return <Flag className={className} style={style} />
}
