import { describe, expect, it } from 'vitest'
import {
  CidrMatcher,
  collapseCidrs,
  diffCidrs,
  formatIpv6,
  parseCidr,
  parseIp,
  parseIpv4,
  parseIpv6,
} from '../src/main/cidr'

describe('parseIpv4', () => {
  it('parses dotted quads', () => {
    expect(parseIpv4('1.2.3.4')).toBe(0x01020304n)
    expect(parseIpv4('255.255.255.255')).toBe(0xffffffffn)
  })
  it('rejects invalid input', () => {
    for (const bad of ['256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', 'a.b.c.d', '']) {
      expect(parseIpv4(bad)).toBeNull()
    }
  })
})

describe('parseIpv6 / formatIpv6', () => {
  it('round-trips canonical forms', () => {
    for (const ip of ['2406:da12::', '2a05:d014:cb9:6600:16bb:f204:e878:7aab', '::1', '::', '1::', '2600:1f18:0:1::']) {
      const v = parseIpv6(ip)
      expect(v).not.toBeNull()
      expect(formatIpv6(v!)).toBe(ip)
    }
  })
  it('compresses the longest zero run', () => {
    expect(formatIpv6(parseIpv6('2001:0db8:0000:0000:0001:0000:0000:0000')!)).toBe('2001:db8:0:0:1::')
    expect(formatIpv6(parseIpv6('2001:db8:0:1:0:0:0:1')!)).toBe('2001:db8:0:1::1')
  })
  it('handles brackets, zone ids and embedded IPv4', () => {
    expect(parseIpv6('[::1]')).toBe(1n)
    expect(parseIpv6('fe80::1%12')).toBe((0xfe80n << 112n) | 1n)
    expect(parseIpv6('::ffff:1.2.3.4')).toBe((0xffffn << 32n) | 0x01020304n)
  })
  it('rejects invalid input', () => {
    for (const bad of ['1::2::3', '12345::', 'g::1', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7']) {
      expect(parseIpv6(bad)).toBeNull()
    }
  })
})

describe('parseCidr', () => {
  it('normalizes host bits', () => {
    expect(parseCidr('3.34.12.5/15')?.text).toBe('3.34.0.0/15')
    expect(parseCidr('2406:da12:1234::/36')?.text).toBe('2406:da12:1000::/36')
  })
  it('defaults to a host route', () => {
    expect(parseCidr('1.2.3.4')?.text).toBe('1.2.3.4/32')
    expect(parseCidr('::1')?.text).toBe('::1/128')
  })
  it('rejects invalid prefixes', () => {
    for (const bad of ['1.2.3.4/33', '::/129', '1.2.3.4/', '1.2.3.4/-1', '1.2.3.4/8/9', '/24']) {
      expect(parseCidr(bad)).toBeNull()
    }
  })
})

describe('collapseCidrs', () => {
  it('removes duplicates and ranges covered by broader ones', () => {
    expect(collapseCidrs(['3.34.0.0/15', '3.35.1.0/24', '3.34.0.0/15', '52.78.0.0/16', '3.36.0.0/16'])).toEqual([
      '3.34.0.0/15',
      '3.36.0.0/16',
      '52.78.0.0/16',
    ])
  })
  it('keeps families apart and sorts IPv4 first', () => {
    expect(collapseCidrs(['2406:da12::/36', '2406:da12:1::/48', '13.124.0.0/16'])).toEqual(['13.124.0.0/16', '2406:da12::/36'])
  })
  it('ignores garbage', () => {
    expect(collapseCidrs(['nope', '1.2.3.0/24', ''])).toEqual(['1.2.3.0/24'])
  })
})

describe('CidrMatcher', () => {
  const m = new CidrMatcher()
  m.add('ap-northeast-2', ['3.34.0.0/15', '2406:da12::/36'])
  m.add('us-east-1', ['3.0.0.0/9'])

  it('matches IPv4 and IPv6', () => {
    expect(m.match('3.36.113.12')).toBe('us-east-1')
    expect(m.match('3.35.200.1')).toBe('ap-northeast-2')
    expect(m.match('2406:da12:abc::1')).toBe('ap-northeast-2')
    expect(m.match('2406:da12:abcd::1')).toBeNull()
    expect(m.match('8.8.8.8')).toBeNull()
  })
  it('prefers the most specific range', () => {
    // 3.34.0.0/15 is inside 3.0.0.0/9 -> longest prefix wins
    expect(m.match('3.34.1.1')).toBe('ap-northeast-2')
  })
  it('handles IPv4-mapped IPv6 and invalid input', () => {
    expect(m.match('::ffff:3.34.1.1')).toBe('ap-northeast-2')
    expect(m.match('not-an-ip')).toBeNull()
  })
})

describe('parseIp / diffCidrs', () => {
  it('detects families', () => {
    expect(parseIp('1.2.3.4')?.family).toBe(4)
    expect(parseIp('2a05::1')?.family).toBe(6)
  })
  it('computes added / removed ranges', () => {
    expect(diffCidrs(['a', 'b'], ['b', 'c'])).toEqual({ added: ['c'], removed: ['a'] })
  })
})
