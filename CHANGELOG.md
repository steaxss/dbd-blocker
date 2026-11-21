# Changelog

## 1.4.0

### Fixed
- **Blocked regions could still be reached (Seoul and other regions).** A block kept the AWS ranges that existed when it was created. AWS adds EC2 ranges every week (e.g. +2 in `ap-northeast-2` and +31 in `us-east-1` between July and November 2026), and new GameLift servers landed outside the block. Active blocks are now re-synced on every AWS refresh (at startup and every 6 hours).
- IPv6 was never blocked. Every region now blocks its EC2 IPv6 ranges too.
- Inbound flows were not covered. Filters now cover `ALE_AUTH_RECV_ACCEPT` as well as `ALE_AUTH_CONNECT`.
- Removing a filter that was already gone counted as a failure (wrong `FWP_E_FILTER_NOT_FOUND` constant).
- Unblock could forget filters it had failed to delete, leaving them active and invisible in the UI.
- Non-permanent blocks survived a crash, a forced shutdown or an update restart. They no longer persist across reboots, and leftovers are removed at the next start.
- The tracker ignored every received UDP packet and never saw IPv6. Events are now matched by ID: UDP 42/43/58/59.
- The ETW session stayed active after the tracker was killed. It is now closed on stop, on app exit and if the app crashes.
- WFP health check always reported error `0x00000000`.

### Changed
- A dedicated WFP provider and sublayer own every filter. When the last block is removed, both are deleted, so nothing is left behind.
- Changes are atomic: one WFP transaction per operation, verified afterwards.
- WFP is the source of truth: `wfp-state.json` is gone.
- Filters clear the action right so VPN / booster callouts in lower sublayers cannot override them.
- Uninstalling purges the filters, sublayer, provider, ETW session and app data.
- Filters, sublayer and `ips/` cache from 1.1–1.3, plus 1.0 firewall rules (`Block_DBD_*`), are migrated automatically.
- Ping uses the GameLift UDP beacons (`gamelift-ping.<region>.api.aws:7770`), including Hong Kong.
- The tracker warns when the game is connected to a blocked region, or to an IP outside AWS.
- PowerShell, `net`, `reg` and `logman` are called by absolute path, never through `PATH`.
- IPC handlers validate their input and only answer the main window.
- The app runs as a single instance.
- Settings and cache are written atomically.
- Removed code obfuscation (the project is open source): production builds are now identical to dev builds, readable in crash reports and less prone to antivirus false positives.
- Removed the unused `udp-tracker.ps1` and dead code.
- Added unit tests (vitest).
