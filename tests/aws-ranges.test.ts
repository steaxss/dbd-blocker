import { describe, expect, it } from 'vitest'
import { countFamilies, extractAllRegions, extractGlobalEc2Ranges, extractRegionRanges, validateAwsRanges } from '../src/main/aws-ranges'
import { parseJsonOutput } from '../src/main/powershell'

const fixture = validateAwsRanges({
  syncToken: '1795274825',
  createDate: '2026-11-21-15-27-05',
  prefixes: [
    { ip_prefix: '3.34.0.0/15', region: 'ap-northeast-2', service: 'AMAZON' },
    { ip_prefix: '3.34.0.0/15', region: 'ap-northeast-2', service: 'EC2' },
    { ip_prefix: '3.35.10.0/24', region: 'ap-northeast-2', service: 'EC2' },        // inside 3.34.0.0/15
    { ip_prefix: '43.200.0.0/14', region: 'ap-northeast-2', service: 'EC2' },
    { ip_prefix: '52.95.0.0/16', region: 'ap-northeast-2', service: 'S3' },          // not a game server range
    { ip_prefix: '15.230.0.0/16', region: 'us-east-1', service: 'EC2', network_border_group: 'us-east-1-bos-1' },
    { ip_prefix: '13.32.0.0/15', region: 'GLOBAL', service: 'CLOUDFRONT' },
    { ip_prefix: '54.115.0.0/16', region: 'GLOBAL', service: 'EC2' },                  // GameLift relays
  ],
  ipv6_prefixes: [
    { ipv6_prefix: '2406:da12::/36', region: 'ap-northeast-2', service: 'EC2' },
    { ipv6_prefix: '2406:da12:800::/40', region: 'ap-northeast-2', service: 'EC2' },  // inside the /36
    { ipv6_prefix: '2600:1f18::/33', region: 'us-east-1', service: 'AMAZON' },
  ],
})

describe('validateAwsRanges', () => {
  it('rejects malformed payloads', () => {
    expect(() => validateAwsRanges(null)).toThrow()
    expect(() => validateAwsRanges({ prefixes: [] })).toThrow()
    expect(() => validateAwsRanges({ prefixes: 'x' })).toThrow()
    expect(() => validateAwsRanges({ prefixes: [{}], ipv6_prefixes: 'x' })).toThrow()
  })
  it('defaults missing IPv6 list', () => {
    expect(validateAwsRanges({ prefixes: [{ ip_prefix: '1.0.0.0/8', region: 'x', service: 'EC2' }] }).ipv6_prefixes).toEqual([])
  })
})

describe('extractRegionRanges', () => {
  it('keeps EC2 IPv4 + IPv6 of the region, collapsed', () => {
    expect(extractRegionRanges(fixture, 'ap-northeast-2')).toEqual(['3.34.0.0/15', '43.200.0.0/14', '2406:da12::/36'])
  })
  it('includes Local Zone border groups', () => {
    expect(extractRegionRanges(fixture, 'us-east-1')).toEqual(['15.230.0.0/16'])
  })
  it('returns nothing for unknown regions', () => {
    expect(extractRegionRanges(fixture, 'xx-none-1')).toEqual([])
  })
  it('extracts every requested region', () => {
    const all = extractAllRegions(fixture, ['ap-northeast-2', 'us-east-1'])
    expect(Object.keys(all)).toEqual(['ap-northeast-2', 'us-east-1'])
  })
})

describe('extractGlobalEc2Ranges', () => {
  it('keeps EC2 GLOBAL ranges only (not CloudFront)', () => {
    expect(extractGlobalEc2Ranges(fixture)).toEqual(['54.115.0.0/16'])
  })
})

describe('countFamilies', () => {
  it('counts IPv4 / IPv6 ranges', () => {
    expect(countFamilies(['1.0.0.0/8', '2406::/16', '2.0.0.0/8'])).toEqual({ v4: 2, v6: 1 })
  })
})

describe('parseJsonOutput', () => {
  it('returns the last JSON line', () => {
    expect(parseJsonOutput<{ ok: boolean }>('WARNING: noise\n{"ok":false}\n{"ok":true}\n')).toEqual({ ok: true })
  })
  it('returns null on garbage', () => {
    expect(parseJsonOutput('nothing here')).toBeNull()
    expect(parseJsonOutput('{broken')).toBeNull()
  })
})
