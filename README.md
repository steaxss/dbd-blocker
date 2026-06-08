# DBD Server Blocker

DBD Server Blocker is a Windows desktop app for managing the AWS regions that `DeadByDaylight-Win64-Shipping.exe` can reach.

It applies Windows Filtering Platform rules to the game executable, keeps AWS IPv4 ranges up to date locally, and shows live connection information while the game is running.

<p align="center">
  <img src="resources/icon.png" alt="DBD Server Blocker" width="128">
</p>

## Features

- Block or unblock individual Dead by Daylight server regions
- Apply rules directly to the DBD executable
- Keep selected regions blocked across app restarts
- Refresh AWS IPv4 ranges from the official AWS endpoint
- Check latency for each supported region
- Show the observed live server region during a match
- Manage active rules from the tray

`us-east-1` is kept available because DBD backend services rely on that region.

## Matchmaking Detection

Before a match starts, the app can estimate the likely matchmaking pool from location and latency signals.

During a match, the connection tracker reads local Windows network events and maps the observed server IP to the cached AWS region list.

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

## Requirements

- Windows 10 or Windows 11
- Dead by Daylight installed locally
- PowerShell 5+
- Node.js 22.12+ for development

Windows may ask for elevation when applying or removing firewall rules.

## Development

```bash
npm install
npm run dev
npm run typecheck
npm run build
npm run test
```

`npm run test` runs the TypeScript checks and production build.

## Security

The dependency tree is maintained with `npm audit`.

Current validation commands:

```bash
npm audit
npm run test
```

## Packaging

```bash
npm run dist
```

The Windows package is built with Electron Builder.

## Project Structure

- `src/main`: Electron main process, IPC, firewall integration, settings, updater
- `src/preload`: secure renderer bridge
- `src/renderer`: React UI, region views, logs, tracker UI, latency checks
- `scripts`: PowerShell integration for Windows network filtering and tracking
- `resources`: application icons

## License

MIT
