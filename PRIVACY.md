# Privacy Policy — PCDoctor Workbench

**Last updated:** 2026-04-30 (v2.5.15)

PCDoctor Workbench is a local-only Windows diagnostic tool. This document describes exactly what data it collects, where that data is stored, and what (if anything) leaves your machine.

The short version: **nothing leaves your machine unless you explicitly opt in to a specific feature.**

---

## What's stored locally

PCDoctor Workbench stores everything at `C:\ProgramData\PCDoctor\`:

| Path | Contents | Retention |
|---|---|---|
| `C:\ProgramData\PCDoctor\workbench.db` | SQLite database: settings, action history, persistence baseline, metric history (90 days rolling), notifications log | Until you uninstall or manually delete |
| `C:\ProgramData\PCDoctor\reports\` | Latest scan output (`latest.json`) + dated subfolders for each scheduled scan | 30 days rolling, pruned by scheduled task |
| `C:\ProgramData\PCDoctor\logs\` | Daily rolling logs: `perf-YYYYMMDD.log` (main-process timing), `render-perf-YYYYMMDD.log` (renderer-process timing), `autopilot-scheduled-YYYYMMDD.log` (autopilot rule fires) | 30 days rolling |
| `C:\ProgramData\PCDoctor\snapshots\` | File-level rollback snapshots created before destructive Tier B actions | Pruned per-action; old snapshots removed by `Prune-Rollbacks` scheduled task |
| `C:\ProgramData\PCDoctor\exports\` | User-initiated diagnostic export bundles (`.zip`) | Until you delete |
| `C:\ProgramData\PCDoctor\baseline\` | Persistence-baseline snapshots for diff detection (security feature) | Last 7 baselines, pruned by scheduled task |

The SQLite DB is locked down via NTFS ACLs (`Users:Modify` only on data files, `Users:Read+Execute` on script files) so a non-admin process can't tamper with the audit log.

### What's in `workbench.db` specifically

| Setting key | Sensitivity | What it is |
|---|---|---|
| `telegram_bot_token` | **Encrypted at rest** via Windows DPAPI when written through the Settings UI. Decrypted on demand only by the main process. Never returned to the renderer in plaintext (always masked in `api.getSettings`). | Telegram bot token, optional |
| `telegram_chat_id` | Plaintext, low sensitivity (just an ID number) | Optional |
| All other settings | Plaintext, no PII | Quiet hours, digest preferences, allowlist toggles |
| Action history | Plaintext | Every PCDoctor action you've run: name, timestamp, success/fail, parameters, rollback ID |
| Metric history | Plaintext | 90 days of CPU/RAM/disk/temp samples for the forecast engine |
| Notifications log | Plaintext | Every alert sent (Windows toast or Telegram), with delivery confirmation status |

---

## What goes outbound (only on explicit opt-in)

PCDoctor Workbench makes outbound network calls in only these specific cases. None happen silently in the background.

### 1. Auto-updater check (always on)

- **Endpoint:** `https://api.github.com/repos/gregpa/pcdoctor-workbench/releases/latest`
- **What's transmitted:** the request itself contains the running app version in the User-Agent string. No other data.
- **Why:** to detect new releases. If a newer version is available, the user is prompted to download it (downloads themselves come from GitHub Releases CDN).
- **Disabling:** there's no UI to turn off auto-update checks. To fully disable, block `api.github.com` for the PCDoctor process via Windows Firewall, or run with the network unavailable.

### 2. Telegram bot (opt-in)

- **Endpoint:** `https://api.telegram.org` (specifically `getMe`, `sendMessage`, `editMessageText`, `getUpdates`, `answerCallbackQuery`)
- **What's transmitted:** notification text (e.g. "🟡 RAM 89%, action recommended"), and your bot token + chat ID for authentication. **Never** raw scan output, system metrics, or PII unless you choose to message it manually.
- **Why:** if you configured a Telegram bot in Settings, alerts go there.
- **Disabling:** Settings → Notifications → set Telegram to "Off". Or remove the bot token entirely.

### 3. Tool update checks (opt-in)

- **Endpoint:** Microsoft's winget package registry (when you click "Check for updates" on the Tools page).
- **What's transmitted:** the names of the tools we check (HWiNFO, OCCT, Malwarebytes, etc.).
- **Why:** to surface available updates for tools the app launches.
- **Disabling:** don't click "Check for updates". The check is manual; nothing fires automatically.

### 4. Nvidia driver staleness check (opt-in via Updates page)

- **Endpoint:** `https://www.nvidia.com/Download/processFind.aspx` (when you visit the Updates page)
- **What's transmitted:** your GPU model identifier (parsed from local Windows GPU info) so the page returns the correct driver version.
- **Why:** to surface "X days behind latest" on the Updates page.
- **Disabling:** don't visit the Updates page, or block the Nvidia URL via firewall.

### 5. Embedded Claude Code terminal (opt-in)

- **Endpoint:** `https://api.anthropic.com` and related (only when you launch the embedded terminal AND your Claude API key is configured)
- **What's transmitted:** whatever you type into the Claude terminal. The terminal is just a host for `claude` CLI; PCDoctor doesn't intercept or transmit anything itself.
- **Why:** Claude Code CLI is a third-party developer tool you can use from inside PCDoctor.
- **Disabling:** don't launch the embedded terminal, or don't configure a Claude API key.

---

## What does NOT happen

To be explicit about things PCDoctor Workbench does **not** do:

- ❌ No usage telemetry / analytics
- ❌ No crash reporting (no Sentry, no Bugsnag, no equivalent)
- ❌ No "improve the product" data collection
- ❌ No A/B testing or feature flags pulled from a remote server
- ❌ No license-server check-in
- ❌ No phone-home on install, launch, scan, or any other event
- ❌ No data sent to me, the project author, ever
- ❌ No third-party SDKs that themselves transmit data

The only third-party JavaScript dependencies that touch the network at runtime are: `electron-updater` (GitHub Releases auto-update, see #1 above) and Node's built-in `https` module (used for the explicit features in #2-#5).

---

## Reporting bugs

When you open a GitHub Issue and paste perf log lines, those lines may contain:

- **Timestamps** of when scans/refreshes ran
- **Scan-result severity counts** (e.g. "findings: 2")
- **Hostname strings** (your computer's name, e.g. "ALIENWARE-R11")
- **Disk drive letters and free-space percentages**
- **Service names** (Windows service identifiers, like "Cloudflared", "BITS")

If any of those concern you, **redact before pasting** — the issue tracker is public.

The perf logs do **not** contain:

- Files or directories outside `C:\ProgramData\PCDoctor\`
- Document content, browser history, or any user-data
- Telegram tokens or chat IDs
- Telegram message content
- Network credentials, BitLocker keys, or any secrets
- Personal identifiers beyond your computer's hostname

---

## License compliance for transmitted data

When PCDoctor uses the GitHub Releases API, Telegram Bot API, or any other third-party endpoint, that endpoint's privacy policy governs what those services do with the request. PCDoctor itself doesn't retain or log the network responses beyond what's needed to act on them.

GitHub: https://docs.github.com/en/site-policy/privacy-policies/github-privacy-statement
Telegram: https://telegram.org/privacy
Microsoft (winget): https://privacy.microsoft.com/en-us/privacystatement
Nvidia (driver lookup): https://www.nvidia.com/en-us/about-nvidia/privacy-policy/

---

## Changes to this policy

This policy applies to the version of PCDoctor Workbench listed at the top. Future versions may add or remove outbound endpoints; check this file at the version you're running for the accurate state.

If a future version adds a new outbound network call, that change will be noted in:
- This file
- The release notes for that version
- Probably the migration migration entry in `src/main/dataStore.ts` if the change requires settings migration

---

## Questions

GitHub Issues — but don't include sensitive data. The repo is public.
