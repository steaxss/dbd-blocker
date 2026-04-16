# DBD Server Blocker

Windows desktop app for controlling which AWS regions `DeadByDaylight-Win64-Shipping.exe` can reach. It uses Windows Filtering Platform (WFP) filters scoped to the game executable, plus an ETW-based tracker for live server detection.

<p align="center">
  <img src="resources/icon.png" alt="DBD Server Blocker" width="128">
</p>

## Status

Current state: release candidate for manual Windows 11 use, not fully production-certified.

The app now builds cleanly, the WFP verification path is enforced, renderer-side failure handling is stronger, and the startup AWS refresh flow is safer. It is usable as an unsigned admin-only Windows tool, but I would still not label it "public production-grade" until it has been validated on real Windows 11 target machines across install, update, block, unblock, ETW tracking, and failure scenarios.

## What The App Does

- Blocks or unblocks individual AWS regions for Dead by Daylight
- Scopes firewall filters to `DeadByDaylight-Win64-Shipping.exe`
- Persists selected blocked regions across restarts
- Fetches AWS IPv4 ranges and caches them locally
- Measures region latency from the app
- Detects the live game server region via ETW UDP tracing once connected
- Runs in the system tray and can clean up non-permanent rules on exit

## Matchmaking Region Detection

The app does not know the exact matchmaking region chosen by BHVR before a match starts.

What it does today:

- It estimates a likely matchmaking pool from browser geolocation or IP geolocation fallback
- It then refines that estimate using ping latency to the known AWS/GameLift endpoints
- The current logic picks the nearest or lowest-latency AWS region, then treats all regions on the same continent as the probable matchmaking pool

What is exact:

- Once DBD is connected, the ETW tracker can map the actual observed server IP to a known AWS region from the cached CIDR list

So the pre-match signal is an estimate, while the in-match ETW signal is the real observed server region.

## Supported Regions

| Region | Location | Region | Location |
|---|---|---|---|
| us-east-1 | Virginia | ap-south-1 | Mumbai |
| us-east-2 | Ohio | ap-east-1 | Hong Kong |
| us-west-1 | California | ap-northeast-1 | Tokyo |
| us-west-2 | Oregon | ap-northeast-2 | Seoul |
| ca-central-1 | Montreal | ap-southeast-1 | Singapore |
| eu-central-1 | Frankfurt | ap-southeast-2 | Sydney |
| eu-west-1 | Dublin | sa-east-1 | Sao Paulo |
| eu-west-2 | London | | |

`us-east-1` is treated specially because the app assumes Dead by Daylight backend services depend on it.

## Architecture

- `src/main`: Electron main process, IPC, WFP/firewall integration, AWS IP fetch, settings, updater
- `src/preload`: `window.api` bridge exposed to the renderer
- `src/renderer`: React UI, map/grid views, logs, tracker UI, geolocation/ping logic
- `scripts`: PowerShell scripts for WFP direct API access and ETW tracking

## Current Validation

The following checks pass locally:

- `npm run typecheck`
- `npm run build`
- `npm run test`

`npm run test` is currently a validation alias for type-check + build. There is still no dedicated automated runtime test suite.

## Requirements

- Windows 10 or Windows 11
- Administrator privileges
- Dead by Daylight installed locally
- PowerShell available

## Packaging Notes

- The app is intentionally unsigned
- Administrator rights are required at runtime for WFP operations
- The NSIS installer is configured for per-user install, but the application itself still requests elevation

## Remaining Gaps Before Broad Public Distribution

- No real automated runtime tests on Windows networking behavior
- No CI pipeline proving packaging and smoke-test stability
- Geolocation still depends on third-party services from the renderer
- The app still needs real-machine validation for WFP failure, ETW tracker edge cases, and packaged update flow

## Development

```bash
npm install
npm run dev
npm run typecheck
npm run build
npm run dist
```

## Practical Verdict

If the question is "can I keep using this on my own Windows 11 machine and package it as an unsigned admin tool?", the answer is yes.

If the question is "can I guarantee public production readiness with no surprises yet?", the answer is still no.

The next step is not more architecture work. It is a Windows 11 validation pass on the packaged `.exe` covering install, first launch, WFP failure, region block/unblock, ETW detection, exit cleanup, and update behavior.

## License

MIT
