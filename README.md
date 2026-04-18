# PCDoctor Workbench

Electron desktop app providing a comprehensive PC maintenance dashboard on top of the existing `C:\ProgramData\PCDoctor\` PowerShell diagnostic stack. Windows-only, local-only, system-tray resident.

## Features (v2.0.0)

### 📊 Dashboard
- Live KPI cards (CPU load, RAM, disks, NAS, services, uptime) with week-over-week delta indicators
- 270° SVG gauges + 7-day trend line charts (CPU load) + event-log bar chart
- SMART disk health table (per-drive wear, temp, errors)
- Services & Processes pill panel (9 key services with status dots, click to restart)
- Active Alerts with inline Fix + 🤖 Investigate buttons (live spinner + elapsed time)
- Security posture compact card (Defender, Firewall, WU, Failed Logins, BitLocker, UAC, GPU driver)
- **Clean My PC** threshold-gated suite runner with per-step progress

### 🛡 Security
- Clickable panels open detail modals with inline Fix actions
- Microsoft Defender status + Quick/Full/Offline scans + definition updates
- Windows Firewall profiles + rule count + reset
- Windows Update (pending, security-only, reboot state, stuck-update detection)
- Failed logon events with top source IPs + one-click Block IP
- BitLocker status + Enable action + Create Shadow Copy
- UAC status with explicit re-enable instructions
- GPU driver age with Nvidia latest-version check
- Persistence diff (startup, tasks, services) with Approve/Remove per item + 🤖 Investigate
- Threat indicators (cryptominer heuristics with expanded whitelist, suspicious PS, LOLBAS abuse, unusual parent-child, RDP brute-force)
- Shell handler signature audit
- Signature spot-check on processes from Temp/Downloads/AppData
- Hosts file integrity check

### 🪟 Windows Updates
- Per-KB pending list with security flagging + install buttons
- Stuck-update detection with one-click Repair
- Feature-upgrade readiness check (disk, reboot, BSODs, driver age)
- Dell Command Update integration
- Nvidia driver age via latest-version feed check
- Install-All, Security-Only, Install-KB, Hide-KB, Repair actions

### 🧰 Tools Launcher
- 20-tile grid across 6 categories (Hardware, Security, Forensics, Disk, Diagnostic, Native)
- Auto-detect via file paths + winget list fallback
- One-click install via winget (with post-install polling)
- **Install All Missing** bulk installer
- Per-tool launch presets (multi-mode dropdown)
- HWiNFO CSV + OCCT CSV import & parse (min/avg/max per sensor)

### 🧠 MemTest86 Guided Wizard
- 4-step flow: Download → Rufus → Reboot → Record outcome

### 📋 Weekly Review
- Structured Monday-morning briefing (Sun 10 PM PS task)
- Priority-grouped action items (critical/important/info) with inline Fix
- Per-item state: pending / applied / dismissed / snoozed / auto_resolved
- Historical navigation (← Prev / Next →) through all past reviews
- Progress bar showing how many items acted on
- Archive to Obsidian Vault + Print button

### 🔮 Forecast Engine
- Linear regression + EWMA over 90 days of metrics
- Projected threshold-crossing dates with confidence scoring (HIGH/MEDIUM/LOW)
- Preventive action buttons inline
- Trigger-based notifications when <7 days to critical

### 📜 Action History
- Grouped by day with per-row status icons
- Click any row → full detail modal with params + result + error
- Revert for Tier A/B actions + 🤖 Investigate for failures

### 🔔 Notifications
- Windows toast + Telegram bot
- Two-step Telegram confirmation for destructive actions
- Per-event × per-channel notification matrix in Settings
- DPAPI-encrypted Telegram bot token (Windows safeStorage)
- Quiet hours

### 🤖 Claude Code Integration
- "Open Claude Terminal" launches in Windows Terminal with system context pre-loaded
- "Investigate with Claude" buttons on alerts, persistence items, failed actions
- Claude bridge: Claude can request actions via `commands.jsonl` → user approval modal → execution → result in `responses.jsonl`

### ⚙ Settings
- Telegram setup wizard with test message
- Notification matrix (events × channels)
- Quiet hours
- **Scheduled task editor** - enable/disable/run-now for all 9 PCDoctor scheduled tasks
- **Diagnostic bundle export** - zips logs, settings (redacted), reports, and audit log for support

### 🧱 Infrastructure
- 40+ one-click actions across 8 categories with Tier A/B/C rollback
- Action parameter UI with Dry Run checkbox
- Rollback system: Windows System Restore (Tier A) + File snapshots (Tier B)
- SQLite persistence: metrics, actions_log, rollbacks, forecasts, weekly_review_states, persistence_baseline, security_scans, notification_log, seen_findings, workbench_settings
- Auto-registered scheduled tasks on first launch
- NSIS installer with XML-based autostart task registration

## Develop

```bash
npm install
npm run dev
```

## Run tests

```bash
npm test            # once
npm run test:watch  # watch
npm run typecheck
```

## Build installer

```bash
npm run build
npm run package
```

Installer produced in `release/PCDoctor Workbench-Setup-<version>.exe`.

## Troubleshooting

- **better-sqlite3 ABI mismatch:** `npx electron-rebuild -f -w better-sqlite3`
- **"No diagnostic report" banner:** run `Invoke-PCDoctor.ps1 -Mode Report` to seed `latest.json`
- **SMART tiles empty:** install smartmontools - `winget install smartmontools.smartmontools`
- **PSWindowsUpdate not needed:** we use native `Microsoft.Update.Session` COM API
- **Telegram bot not triggering actions:** ensure polling enabled and chat ID matches configured value
- **Tray icon missing color:** verify `resources/icons/tray-*.ico` present in install dir
