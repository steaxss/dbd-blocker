# Repository Notes

## Overview

Electron + React + TypeScript desktop app for blocking Dead by Daylight AWS regions with WFP filters scoped to `DeadByDaylight-Win64-Shipping.exe`.

The codebase is small and understandable, but the current state is still beta. The app is not ready for public production deployment yet.

## Architecture

- `src/main`
  Main Electron process, IPC handlers, tray/window lifecycle, updater, WFP integration, AWS IP fetch, settings.
- `src/preload`
  `contextBridge` layer exposing `window.api` to the renderer.
- `src/renderer`
  React application, region UI, map view, console, ping/geolocation flow, tracker UI.
- `scripts`
  PowerShell scripts for WFP direct API calls and ETW UDP tracking.

## Runtime Constraints

- Windows only
- Requires Administrator privileges
- Requires PowerShell
- Operates on Windows Filtering Platform and ETW, so failures are often machine-specific

## Current Production Assessment

Verdict: not production-ready.

### Strengths

- Core feature set is already present
- Project builds successfully with `npm run build`
- Main/preload/renderer split is clear
- WFP state persistence and cleanup flow exist
- UI is already relatively mature for a beta tool

### Blocking Gaps

- Renderer resilience is weak on async failures
  Startup and action flows can get stuck or become inconsistent if IPC/network calls reject.
- Electron hardening is incomplete
  The window is created with `sandbox: false`, and the preload API surface is broad.
- Release/distribution hardening is incomplete
  Windows code signing is disabled, and updater/publish configuration still needs validation.
- Network/privacy posture is not prod-safe yet
  The renderer performs geolocation/IP lookups through third parties, and ping logic currently bypasses TLS verification.
- WFP success reporting is too optimistic
  Filter creation can warn on verification failure while still reporting success to the rest of the app.
- Observability is limited
  WFP/ETW health checks are not structured enough for reliable support or diagnostics.
- QA is insufficient
  No test suite, no lint script, and no visible CI gates around high-risk paths.

## Operational Notes

- AWS IP ranges are fetched from `https://ip-ranges.amazonaws.com/ip-ranges.json`
- Cached settings live under Electron `userData`
- Cached WFP state lives in `userData/wfp-state.json`
- Persistent regions survive app restart and normal cleanup on exit
- `us-east-1` is intentionally protected because the app assumes DBD backend services depend on it

## Commit Policy

- Do not add AI co-author trailers to commits.
- Do not add `Co-authored-by:` entries for assistants unless explicitly requested.
- If old commits already contain AI co-author trailers, that is a Git history issue and must be removed with a history rewrite, not with a file edit.

## Maintenance Priorities

1. Fix async failure handling in renderer startup and actions.
2. Remove insecure network behavior and third-party renderer-side geolocation fallbacks.
3. Tighten Electron security posture and IPC contracts.
4. Improve WFP/ETW verification and structured diagnostics.
5. Add tests, linting, and a real release checklist.
