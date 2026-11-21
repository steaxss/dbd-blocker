// Pure IPv4 / IPv6 CIDR helpers (no Electron / Node APIs, unit-tested).

export interface ParsedCidr {
  family: 4 | 6
  /** Network address as a big integer (host bits cleared). */
  network: bigint
  prefix: number
  /** Canonical text form, e.g. "3.34.0.0/15" or "2406:da12::/36". */
  text: string
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

export function parseIpv4(ip: string): bigint | null {
  const m = IPV4_RE.exec(ip.trim())
  if (!m) return null
  let value = 0n
  for (let i = 1; i <= 4; i++) {
    const octet = Number(m[i])
    if (octet > 255 || (m[i].length > 1 && m[i].startsWith('0'))) return null
    value = (value << 8n) | BigInt(octet)
  }
  return value
}

export function parseIpv6(ip: string): bigint | null {
  let text = ip.trim().toLowerCase()
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)
  if (!/^[0-9a-f:.]+$/.test(text) || text.split('::').length > 2) return null

  // Embedded IPv4 tail (::ffff:1.2.3.4) -> rewrite as two hex groups (::ffff:102:304)
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':')
    const v4 = parseIpv4(text.slice(lastColon + 1))
    if (v4 === null) return null
    text = `${text.slice(0, lastColon + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`
  }

  const [head, rest] = text.split('::') as [string, string | undefined]
  const parseGroups = (part: string): number[] | null => {
    if (part === '') return []
    const groups = part.split(':')
    const out: number[] = []
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }
  const headGroups = parseGroups(head)
  const restGroups = rest === undefined ? [] : parseGroups(rest)
  if (!headGroups || !restGroups) return null

  const explicit = headGroups.length + restGroups.length
  let groups: number[]
  if (rest === undefined) {
    if (explicit !== 8) return null
    groups = headGroups
  } else {
    if (explicit > 7) return null
    groups = [...headGroups, ...new Array<number>(8 - explicit).fill(0), ...restGroups]
  }

  let value = 0n
  for (const g of groups) value = (value << 16n) | BigInt(g)
  return value
}

export function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((s) => Number((value >> s) & 0xffn)).join('.')
}

export function formatIpv6(value: bigint): string {
  const groups: number[] = []
  for (let i = 7; i >= 0; i--) groups.push(Number((value >> BigInt(i * 16)) & 0xffffn))
  // RFC 5952: compress the longest run (>= 2) of zero groups.
  let bestStart = -1
  let bestLen = 0
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) { i++; continue }
    let j = i
    while (j < 8 && groups[j] === 0) j++
    if (j - i > bestLen && j - i >= 2) { bestStart = i; bestLen = j - i }
    i = j
  }
  const hex = groups.map((g) => g.toString(16))
  if (bestStart < 0) return hex.join(':')
  const left = hex.slice(0, bestStart).join(':')
  const right = hex.slice(bestStart + bestLen).join(':')
  return `${left}::${right}`
}

function mask(family: 4 | 6, prefix: number): bigint {
  const bits = family === 4 ? 32 : 128
  if (prefix === 0) return 0n
  return ((1n << BigInt(bits)) - 1n) ^ ((1n << BigInt(bits - prefix)) - 1n)
}

export function parseCidr(cidr: string): ParsedCidr | null {
  const [ipPart, prefixPart, extra] = cidr.trim().split('/')
  if (extra !== undefined || !ipPart) return null
  const isV6 = ipPart.includes(':')
  const family: 4 | 6 = isV6 ? 6 : 4
  const bits = isV6 ? 128 : 32
  const ip = isV6 ? parseIpv6(ipPart) : parseIpv4(ipPart)
  if (ip === null) return null
  let prefix = bits
  if (prefixPart !== undefined) {
    if (!/^\d{1,3}$/.test(prefixPart)) return null
    prefix = Number(prefixPart)
    if (prefix > bits) return null
  }
  const network = ip & mask(family, prefix)
  const text = `${isV6 ? formatIpv6(network) : formatIpv4(network)}/${prefix}`
  return { family, network, prefix, text }
}

export function cidrContains(outer: ParsedCidr, inner: ParsedCidr): boolean {
  if (outer.family !== inner.family || outer.prefix > inner.prefix) return false
  return (inner.network & mask(outer.family, outer.prefix)) === outer.network
}

/**
 * Normalizes, de-duplicates and drops every range already covered by a broader one.
 * Invalid entries are ignored. Output is sorted (IPv4 first, then IPv6, by address).
 */
export function collapseCidrs(cidrs: Iterable<string>): string[] {
  const parsed: ParsedCidr[] = []
  const seen = new Set<string>()
  for (const raw of cidrs) {
    const p = parseCidr(raw)
    if (!p || seen.has(p.text)) continue
    seen.add(p.text)
    parsed.push(p)
  }
  parsed.sort((a, b) =>
    a.family !== b.family ? a.family - b.family :
    a.network !== b.network ? (a.network < b.network ? -1 : 1) :
    a.prefix - b.prefix
  )
  const kept: ParsedCidr[] = []
  for (const p of parsed) {
    const last = kept[kept.length - 1]
    // Sorted by address then prefix: a covering range always precedes the ranges it contains.
    if (last && cidrContains(last, p)) continue
    kept.push(p)
  }
  return kept.map((p) => p.text)
}

export function parseIp(ip: string): { family: 4 | 6; value: bigint } | null {
  const trimmed = ip.trim()
  if (trimmed.includes(':')) {
    const v = parseIpv6(trimmed)
    if (v === null) return null
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) -> treat as IPv4
    if (v >> 32n === 0xffffn) return { family: 4, value: v & 0xffffffffn }
    return { family: 6, value: v }
  }
  const v = parseIpv4(trimmed)
  return v === null ? null : { family: 4, value: v }
}

/** Longest-prefix matcher from an IP to a label (region id). */
export class CidrMatcher<T extends string = string> {
  private readonly entries: Array<{ cidr: ParsedCidr; label: T }> = []

  add(label: T, cidrs: Iterable<string>): void {
    for (const raw of cidrs) {
      const cidr = parseCidr(raw)
      if (cidr) this.entries.push({ cidr, label })
    }
    this.entries.sort((a, b) => b.cidr.prefix - a.cidr.prefix)
  }

  match(ip: string): T | null {
    const parsed = parseIp(ip)
    if (!parsed) return null
    for (const { cidr, label } of this.entries) {
      if (cidr.family !== parsed.family) continue
      if ((parsed.value & mask(cidr.family, cidr.prefix)) === cidr.network) return label
    }
    return null
  }

  get size(): number {
    return this.entries.length
  }
}

/** Set difference helper used to report AWS range drift. */
export function diffCidrs(before: Iterable<string>, after: Iterable<string>): { added: string[]; removed: string[] } {
  const b = new Set(before)
  const a = new Set(after)
  return {
    added: [...a].filter((c) => !b.has(c)),
    removed: [...b].filter((c) => !a.has(c)),
  }
}
