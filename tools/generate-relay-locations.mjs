// Generates src/main/relay-locations.json: where Amazon GameLift relays (EC2 ranges published with
// region "GLOBAL") are physically located, mapped to the AWS region of that city.
//
// The relay IP does not tell the region and AWS does not publish it, but each "GLOBAL" range is split
// into small blocks announced from one location. Sources (public, queried once at build time, never
// at runtime):
//   - ip-ranges.amazonaws.com: the EC2 "GLOBAL" ranges
//   - RIPEstat related-prefixes: the more specific blocks announced inside each range
//   - ipinfo.io: the city of each block
// Blocks geolocated to AWS's default location (Seattle) or to a city without a DBD region are skipped.
//
// Usage: node tools/generate-relay-locations.mjs
import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'relay-locations.json')

/** City (as reported by ipinfo) -> AWS region Dead by Daylight uses there. */
const CITY_TO_REGION = {
  'Ashburn': 'us-east-1', 'Reston': 'us-east-1',
  'Columbus': 'us-east-2', 'Hilliard': 'us-east-2', 'Dublin, US': 'us-east-2',
  'San Jose': 'us-west-1', 'Santa Clara': 'us-west-1',
  'Boardman': 'us-west-2', 'Hillsboro': 'us-west-2',
  'Montréal': 'ca-central-1', 'Montreal': 'ca-central-1',
  'Frankfurt am Main': 'eu-central-1', 'Frankfurt': 'eu-central-1',
  'Dublin': 'eu-west-1',
  'London': 'eu-west-2',
  'Mumbai': 'ap-south-1',
  'Hong Kong': 'ap-east-1',
  'Tokyo': 'ap-northeast-1',
  'Seoul': 'ap-northeast-2', 'Incheon': 'ap-northeast-2',
  'Singapore': 'ap-southeast-1',
  'Sydney': 'ap-southeast-2',
  'São Paulo': 'sa-east-1', 'Sao Paulo': 'sa-east-1',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function json(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'dbd-server-blocker-build' } })
    if (res.ok) return res.json()
    await sleep(1000 * (attempt + 1))
  }
  throw new Error(`Failed: ${url}`)
}

const ranges = await json('https://ip-ranges.amazonaws.com/ip-ranges.json')
const globalEc2 = ranges.prefixes.filter((p) => p.region === 'GLOBAL' && p.service === 'EC2').map((p) => p.ip_prefix)
console.log(`${globalEc2.length} EC2 GLOBAL ranges`)

const blocks = []
for (const parent of globalEc2) {
  const data = await json(`https://stat.ripe.net/data/related-prefixes/data.json?resource=${parent}`)
  for (const p of data.data.prefixes ?? []) if (/More Specific/.test(p.relationship)) blocks.push(p.prefix)
  await sleep(200)
}
console.log(`${blocks.length} announced blocks`)

const located = {}
const skipped = {}
for (const block of blocks) {
  const [base] = block.split('/')
  const parts = base.split('.').map(Number)
  parts[3] += 1
  const info = await json(`https://ipinfo.io/${parts.join('.')}/json`)
  const key = info.city === 'Dublin' && info.country === 'US' ? 'Dublin, US' : info.city
  const region = CITY_TO_REGION[key]
  if (region && !info.anycast) located[block] = region
  else skipped[`${info.city ?? '?'}, ${info.country ?? '?'}`] = (skipped[`${info.city ?? '?'}, ${info.country ?? '?'}`] ?? 0) + 1
  await sleep(150)
}

const sorted = Object.fromEntries(Object.entries(located).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })))
writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), source: 'RIPEstat + ipinfo.io', blocks: sorted }, null, 2) + '\n')

const perRegion = {}
for (const r of Object.values(sorted)) perRegion[r] = (perRegion[r] ?? 0) + 1
console.log('located per region:', perRegion)
console.log('skipped (unknown / no DBD region):', skipped)
console.log(`written ${OUT}`)
