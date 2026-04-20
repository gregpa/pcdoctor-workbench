# PCDoctor Workbench

Electron + React + PowerShell desktop app for Windows PC maintenance. Tray-resident dashboard on top of a PowerShell diagnostic stack at `C:\ProgramData\PCDoctor\`.

---

## ⚠ Read This First — This Is A Personal Tool

**PCDoctor Workbench is built for my personal PC** (Alienware Aurora R11, Win 11 Pro, specific NAS layout). It is NOT a supported product. The public repo exists for transparency, code review, and reuse of ideas — not drop-in installation.

Specifically, today:

- **No code-signing cert.** Windows SmartScreen will warn. The auto-updater has no cryptographic signature verification — whoever controls this GitHub account can push binaries that run with your Admin consent. If you install from my releases, you are trusting my account's integrity.
- **Hardcoded personal assumptions.** NAS IP `192.168.50.226`, specific drive-letter mappings (M/Z/W/V/B/U), Alienware AWCC tool, MemTest86 USB disk enumeration — all tuned to my machine. Fresh clones will hit these as no-ops or errors.
- **No setup wizard.** First-run expects you to have HWiNFO, OCCT, Malwarebytes, AdwCleaner, Microsoft Safety Scanner, and Claude Code CLI pre-installed or at least reachable via `winget`.
- **Windows 11 only.** Some scanners parse English-language `schtasks.exe` output and Win 11 event-log schemas.

If you want to **fork and reconfigure**, see [`docs/PUBLIC_READINESS.md`](docs/PUBLIC_READINESS.md) for the work required to make this a genuinely portable tool.

If you want to **read the code** for ideas (IPC allow-lists, rollback semantics, PS-sentinel pattern, UAC-per-action elevation, scheduled-task COM API, embedded Claude terminal via node-pty), skim `src/main/` and `powershell/actions/`. The architecture is reusable.

---

## What It Does

### 📊 Dashboard
- Live KPI cards (CPU load, RAM, disks, NAS, services, uptime) with week-over-week deltas
- 270° SVG gauges + 7-day trend charts (click to expand with full hover tooltips + Min/Max/Avg/P95)
- SMART disk health table; Services & Processes health pills
- Active Alerts with inline Fix + 🤖 Investigate buttons
- **Clean My PC** threshold-gated cleanup suite

### 🛡 Security
- Windows Defender status + Quick/Full/Offline scans
- Firewall profiles + rule count + reset
- Windows Update (pending, security-only, stuck-update detection)
- Failed logon audit with top source IPs + one-click Block (routed through audit log + rollback)
- BitLocker, UAC, GPU driver age, Persistence diff, Threat indicators, Shell handler signature audit, Hosts file integrity

### 🧰 Tools Launcher
- 20-tile grid, auto-detect via filesystem probe + winget fallback
- Per-tool launch presets + HWiNFO/OCCT CSV import

### 📋 Weekly Review
- Sun 10 PM automated briefing with priority-grouped action items
- Historical navigation + Archive to Obsidian Vault

### 🔮 Forecast Engine
- Linear regression + EWMA over 90 days of metrics
- Projected threshold-crossing dates with confidence scores

### 🤖 Autopilot
- 25 default rules (Tier 1/2/3) with schedule + threshold triggers
- Export/import rule sets; per-rule enable/disable/suppress
- Tier 3 rules alert via Telegram before acting

### 🔔 Notifications
- Windows toast + Telegram bot (DPAPI-encrypted token, two-step confirmation for destructive actions)
- Quiet hours + email digest buffering + morning flush

### 🧠 Claude Code Integration
- Embedded xterm.js terminal (via node-pty) with system context pre-loaded
- External Window fallback via Windows Terminal
- "Investigate with Claude" buttons on alerts/persistence/failed actions
- Bridge file (`commands.jsonl` / `responses.jsonl`) for Claude-initiated actions with approval modal

### 🧱 Infrastructure
- ~60 one-click actions across 8 categories with Tier A/B/C rollback semantics
- **Tier A**: Windows System Restore Point (refuses to record rollback row if RP creation fails)
- **Tier B**: File-level snapshot with SHA-256 integrity verification on revert + disk-space preflight
- **Tier C**: No automatic rollback (action is destructive-but-acceptable, documented in tooltip)
- SQLite with WAL + busy_timeout + foreign_keys; user_version-based migration framework
- Auto-updater: GitHub Releases provider; benign errors classified as idle "not configured" state
- NSIS installer with ACL lockdown on `C:\ProgramData\PCDoctor\` (Users:RX on scripts, Users:M on data subdirs)

---

## Develop

```bash
git clone https://github.com/gregpa/pcdoctor-workbench
cd pcdoctor-workbench
npm install
npm run dev              # renderer + main hot-reload
```

### Tests + typecheck

```bash
npm run typecheck
npm test                 # once
npm run test:watch       # watch
```

### Build installer

```bash
npm rebuild better-sqlite3                  # for your Node (test env)
npm run build
npx @electron/rebuild -f -o better-sqlite3  # for Electron ABI
npm run package                             # writes release/PCDoctor-Workbench-Setup-X.Y.Z.exe
```

**Note on the repo path:** `node-pty` native dependency requires a path without spaces (Python `node-gyp` chokes otherwise). Keep the checkout under something like `C:\dev\pcdoctor-workbench`.

---

## Troubleshooting

- **better-sqlite3 ABI mismatch** → `npx @electron/rebuild -f -o better-sqlite3` (for the packaged Electron) or `npm rebuild better-sqlite3` (for vitest under Node).
- **"No diagnostic report" banner** → `powershell -File C:\ProgramData\PCDoctor\Invoke-PCDoctor.ps1 -Mode Report`
- **SMART tiles empty** → `winget install smartmontools.smartmontools`
- **Scheduled tasks all "Not registered"** (v2.3.3 and earlier) → upgrade; the COM-API query shipped in v2.3.4 fixes this.
- **Embedded Claude terminal unavailable** → repo checkout path contains a space. Move to a space-free location, delete `node_modules`, reinstall.
- **Auto-update "Error: not signed by publisher"** → this was a transient v2.3.7 issue. Upgrade manually to v2.3.8+ which removed the `publisherName` field; auto-updates resume.

---

## License

MIT — see [`LICENSE`](LICENSE).

Third-party tools launched by the app (HWiNFO, OCCT, Malwarebytes, AdwCleaner, Microsoft Safety Scanner, Sysinternals Autoruns, Dell Command Update, AWCC, etc.) are NOT redistributed — the app detects them via filesystem/winget and launches the user-installed copy. Each has its own license.
