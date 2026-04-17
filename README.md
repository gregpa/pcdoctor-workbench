# PCDoctor Workbench

Electron desktop app providing a live PC maintenance dashboard on top of the existing `C:\ProgramData\PCDoctor\` PowerShell stack. Windows-only, local-only, system-tray resident.

See design spec: `../docs/superpowers/specs/2026-04-17-pcdoctor-workbench-design.md`

## Plan 1 scope

- Electron shell + React/TS renderer + SQLite audit
- Tray icon with green/yellow/red status badge
- Dashboard with 6 KPI cards + 3 gauges + trend-chart placeholder
- One end-to-end action: Flush DNS
- NSIS installer that auto-registers logon task

## Develop

```bash
npm install
npm run dev
```

Opens Electron window (hidden to tray). Click the tray to reveal the dashboard.

## Run tests

```bash
npm test            # run once
npm run test:watch  # watch mode
npm run typecheck
```

## Build installer

```bash
npm run build
npm run package
```

Installer produced in `release/`.

## Files of interest

- `src/main/scriptRunner.ts` — PowerShell dispatcher with error sentinel parsing
- `src/main/pcdoctorBridge.ts` — reads `C:\ProgramData\PCDoctor\reports\latest.json`
- `src/main/dataStore.ts` — SQLite schema + audit log writer
- `src/renderer/components/dashboard/Gauge.tsx` — reusable SVG gauge
- `src/shared/actions.ts` — single source of truth for the action catalog

## Troubleshooting

- **better-sqlite3 ABI mismatch on dev:** `npx electron-rebuild -f -w better-sqlite3`
- **"No diagnostic report" banner:** run `Invoke-PCDoctor.ps1 -Mode Report` in `C:\ProgramData\PCDoctor\` to generate `latest.json`
- **Tray missing color:** verify `resources/icons/tray-*.ico` are present
