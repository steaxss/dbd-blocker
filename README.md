# DBD Server Blocker

DBD Server Blocker is a Windows desktop app that controls which AWS regions `DeadByDaylight-Win64-Shipping.exe` (Steam / Epic) or `DeadByDaylight-WinGDK-Shipping.exe` (Microsoft Store / Xbox) can reach.

It adds Windows Filtering Platform (WFP) filters scoped to the game executable, keeps the AWS ranges up to date, and shows the live game server while you play.

<p align="center">
  <img src="resources/icon.png" alt="DBD Server Blocker" width="128">
</p>

## Features

- Block or unblock individual Dead by Daylight server regions (IPv4 **and IPv6**)
- Filters apply to the game executable only, nothing else on the PC is affected
- Active blocks follow AWS automatically: new ranges are added as soon as AWS publishes them (refresh at startup and every 6 hours)
- Permanent blocks survive app exit and reboots; the others end with the app
- Latency measured against the GameLift UDP ping beacons (the same endpoints matchmaking uses)
- Blocking check: counts the connection attempts of the game that Windows dropped for each blocked region, so you can see blocks working
- Live game server detection (can be imprecise since Amazon GameLift routes some matches through relays)
- Leaves nothing behind: no filter, sublayer, provider or ETW session once blocks are removed, the app is closed or uninstalled

`us-east-1` cannot be blocked: Dead by Daylight backend services (login, matchmaking, EAC) run there.

## How it works

| Piece | Details |
|---|---|
| IP ranges | `EC2` IPv4 + IPv6 prefixes of each region from `ip-ranges.amazonaws.com`, Local Zones included, covered ranges collapsed |
| Filters | one filter per range on `ALE_AUTH_CONNECT` and `ALE_AUTH_RECV_ACCEPT` (v4 / v6), condition = game executable, tagged with the region |
| Ownership | dedicated WFP provider + sublayer (weight `0xFFFF`), action right cleared so VPN / booster callouts cannot override a block |
| Atomicity | every change is one WFP transaction and is verified afterwards |
| Source of truth | WFP itself: the app lists its filters instead of trusting a side file |
| Tracker | ETW `Microsoft-Windows-Kernel-Network` UDP events (IDs 42/43/58/59) of the game process |

## Troubleshooting

**"I still get sent to a region I blocked"**

1. Restart Dead by Daylight after blocking: WFP only applies to new connections. Then check *Blocking check* in Active Connections: attempts toward the blocked region should appear while you search for a match.
2. Open the *Server Tracker*. If it says *Connected to a blocked region*, the game was started before the block.
3. Click *Refresh IPs*. Since 1.4.0, active blocks are re-synced automatically when AWS adds ranges. Before that, a block created weeks earlier missed the new GameLift ranges, which is how players ended up in Seoul or other blocked regions.
4. VPNs and routing tools (ExitLag, GearUP...) can relay traffic through other IPs. The tracker warns when the server IP is not in any AWS range.

**Remove everything manually**: *Unblock All* (window or tray) deletes every filter, the sublayer and the provider. Uninstalling does the same.

## Requirements

- Windows 10 or Windows 11 (x64)
- Windows PowerShell 5.1 (built in)
- Administrator rights (the installer requests them)
- Node.js 22.12+ for development

## Development

```bash
npm install
npm run dev
npm run typecheck
npm run test:unit   # vitest
npm test            # typecheck + unit tests + production build
```

## Packaging

```bash
npm run dist
```

The Windows installer is built with Electron Builder. `resources/installer.nsh` purges the WFP objects and the ETW session on uninstall (not on update, so permanent blocks survive upgrades).

## Project Structure

- `src/main`: Electron main process
  - `blocker.ts`: region blocking service (startup reconciliation, AWS re-sync, exit cleanup)
  - `wfp.ts`, `powershell.ts`: serialized calls to the PowerShell / WFP layer
  - `ips.ts`, `aws-ranges.ts`, `cidr.ts`: AWS ranges download, parsing and CIDR maths
  - `tracker.ts`, `ping.ts`: live server tracking and latency
- `src/preload`: secure renderer bridge
- `src/renderer`: React UI
- `scripts`: PowerShell + embedded C# for WFP (`wfp-block.ps1`) and ETW (`etw-tracker.ps1`)
- `tests`: unit tests

## License

MIT. Map data: [Natural Earth](https://www.naturalearthdata.com/) (public domain) via `world-atlas`.
