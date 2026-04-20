# Public-Readiness Roadmap

**Current state:** PCDoctor Workbench works safely for the original author on the original machine. It is **not** safe as a drop-in for an arbitrary user who clones and installs. This document is the punch list for closing that gap while keeping the primary author's experience functional and safe.

Priorities are ordered by **blast radius of the gap**, not effort — the earlier items are the ones that cause real harm if skipped.

---

## Phase 1 — Trust & integrity (ship before any real promotion)

These gates stop a stranger who installs the app from having their PC owned by whoever controls the update feed.

### 1. Code-sign or enforce self-signed Authenticode on updates

**Why:** The auto-updater pulls installers from the public `gregpa/pcdoctor-workbench` Releases page, with no cryptographic verification of the publisher. A compromised GitHub account can ship SYSTEM-level RCE to every installed client. Three reviewers independently flagged this as the highest-priority security gap.

**Two paths:**

- **Free, minimum viable:** Generate a self-signed Authenticode cert. Sign every release installer. Set `electron-builder.yml` `win.signtoolOptions.publisherName` to the self-signed subject name. `electron-updater` will then refuse any installer not signed by that private key. SmartScreen still warns because the cert isn't CA-issued — same "More info → Run anyway" one-time click — but end-to-end update integrity is established. Attacker needs BOTH the GitHub account AND the private signing key (store the key offline or in a hardware token).

- **$60/yr, production:** Buy a DigiCert / Sectigo EV or OV code-signing cert. SmartScreen reputation builds organically; no "Run anyway" after a few hundred installs. Same electron-updater config + key management applies.

**Transition concern:** adding `publisherName` to a build that was previously unsigned breaks one auto-update cycle (the installed-version's `app-update.yml` enforces the publisher the new installer must match). Document clearly in release notes; require one manual install to bridge.

### 2. Make the update feed forkable, not locked to one account

**Why:** `electron-builder.yml` currently hardcodes `publish.owner: gregpa, repo: pcdoctor-workbench`. A fork that rebuilds without changing this gets MY updates. If MY account is compromised, every fork installed from every fork's own releases gets popped.

**Fix:** read `publish.owner` and `publish.repo` from either `.env.local` (committed example, uncommitted real) or `package.json` fields (`"publishOwner"`, `"publishRepo"`) — electron-builder supports both. First-time forkers change one file instead of having to hunt through YAML.

### 3. Licensing clarity

**Status:** Shipped in v2.3.13 — `LICENSE` file added (MIT). This section is retained as a reminder that any third-party content added later (icons, docs, PS scripts from unknown sources) needs its own license check.

### 4. Remove remaining hardcoded personal values

Audit + settings-ify:

- **NAS IP `192.168.50.226`** — currently referenced in `powershell/actions/Remap-NAS.ps1` and a few security scripts. Move to a `nas_server` setting + `nas_mappings` JSON array setting.
- **NAS drive-letter mappings** — the six-drive M/Z/W/V/B/U pattern is baked in. Same `nas_mappings` setting can drive the whole thing.
- **MemTest86 USB disk index** — Greg's USB happens to be Disk 4. The MemTest86 page mentions it in copy. Detect dynamically via `Get-Disk | Where-Object BusType -eq 'USB'`.
- **AWCC MSIX app ID** — Alienware-specific. Hide the tile when `Get-AppxPackage DellInc.AlienwareCommandCenter` returns nothing. Already infrastructure-ready via `msix_app_id` in `src/shared/tools.ts`.
- **Obsidian archive path** — fixed in v2.3.13, reads from `obsidian_archive_dir` setting. Default is `%USERPROFILE%\Documents\PCDoctor\Weekly Reviews`.

**Strategy:** first-run setup wizard. See Phase 2.

---

## Phase 2 — Usability for non-expert users

Once trust is established, the next gate is "does it actually work if a stranger follows the README?"

### 5. First-run setup wizard

A modal on first launch that:
- Detects installed companion tools (HWiNFO, OCCT, Malwarebytes, AdwCleaner, Microsoft Safety Scanner, Sysinternals Autoruns, Dell Command Update, AWCC, Claude Code CLI). Shows which are present, offers winget install for the missing ones.
- Optionally configures Telegram notifications (walk through BotFather → paste token → test → save). DPAPI-encrypts the token.
- Optionally configures the NAS mapping JSON.
- Optionally configures the Obsidian archive directory.
- Optionally enables Autopilot rules (with a clear "these will auto-run on schedule" disclosure).

Skip + "configure later" on every step. Store wizard completion in `workbench_settings` so it doesn't re-trigger.

### 6. Hardware auto-detection + graceful degradation

- Detect non-Alienware → hide AWCC tile; hide thermal-profile references in copy.
- Detect laptops → hide UPS-specific recommendations; surface battery health instead.
- Detect missing NVMe → hide Samsung firmware update recommendations.
- Detect non-RTX GPUs → hide Nvidia-specific driver-check. Add AMD + Intel equivalents.
- Detect CPU vendor → thermal thresholds are different for Intel vs AMD; current thresholds assume Intel i9.

### 7. Localization / English-independent parsing

Current scanners parse English column names from `schtasks.exe /FO TABLE` and English error messages from PowerShell. Fix:

- Use `schtasks /XML` (locale-independent XML output) instead of the table format.
- Use PowerShell error `FullyQualifiedErrorId` instead of message text for error-type matching.
- Use event-log IDs and provider names rather than rendered message text.

### 8. OS version compatibility

Test matrix:
- **Win 11 22H2/23H2/24H2/25H2** — currently only 25H2 validated. 22-24H2 likely work; needs smoke test.
- **Win 10 22H2** — several scanners reference Win 11-specific event-log schemas and `WSLService` which is Win 11 only (`LxssManager` on Win 10). The `Invoke-PCDoctor.ps1` script already falls back, but many newer tiles haven't been tested.
- **Windows Server 2022/2025** — probably broken in many places (no tray semantics, different event providers). Out of scope unless demand emerges.

Ship a compatibility matrix in the README with Tested / Likely / Unsupported columns.

---

## Phase 3 — Release operations

### 9. CI/CD pipeline (move builds off the author's machine)

Currently builds run on Greg's local dev box. For public use:

- **GitHub Actions** workflow that:
  - Runs on push of a `v*` tag
  - Installs Node + Python, runs `npm ci`, `npm run typecheck`, `npm test`
  - Runs `@electron/rebuild` for better-sqlite3 against the packaged Electron ABI
  - Runs `electron-builder` with the signing cert (stored as a GitHub secret + PFX file)
  - Uploads `release/*.exe`, `release/*.blockmap`, `release/latest.yml` to the Release
- This means: even a compromised dev machine can't inject code into an official release; the build is reproducible; the signing key never leaves the CI environment.

### 10. Reproducible builds + SBOM

- `package-lock.json` is already committed. Good.
- Add an `npm ci`-only build script in CI (rejects unlocked dep updates).
- Generate a CycloneDX or SPDX SBOM at build time, attach to releases.
- Publish the build log alongside each release so anyone can verify what went into the installer.

### 11. Issue triage + SECURITY.md

- `SECURITY.md` with a disclosure policy (email address, GPG key, 90-day embargo, hall-of-fame).
- Issue templates (bug / feature / security).
- CODE_OF_CONDUCT + CONTRIBUTING to set expectations.
- A triage schedule — even "I look at issues weekly" is better than silence.

---

## Phase 4 — Features that turn it from "utility" into "product"

These are the "real value" adds from the three code reviews that aren't in v2.3.13.

### 12. Preflight + postcondition engine (reviewer consensus)

Before any destructive action:
- Elevation path verified
- Rollback readiness verified (Tier A: VSS + System Restore enabled; Tier B: disk-space floor + target path exists)
- Free disk threshold OK
- Battery/AC check (refuse destructive actions on battery < 30%)
- Not during active Windows Update install
- Dependent services quiesced (e.g. stop indexer before Rebuild Search Index)

After action:
- Re-scan to confirm the change stuck (hosts file hash changed, registry value gone, service state matches expectation, restore point exists, firewall rule present)
- Mark action as "success-but-not-verified" if postcondition fails, so the user knows

### 13. Autopilot maturity (rule chaining + shadow mode)

- **Shadow mode:** new rules run in "would have fired" mode for 2 weeks before going live. Activity log already supports `outcome: 'skipped'` — just wire a `shadow` outcome and a UI toggle to promote.
- **Rule chaining:** Rule A produces output that feeds Rule B's guard. Example: "if TRIM hasn't run in 30d AND disk write-latency-p95 rose 40% WoW, run TRIM, wait 7d, alert if latency delta < 15%."
- **Cooldowns + circuit breakers:** per-rule minimum interval + consecutive-failure auto-disable.
- **Confidence scoring:** expose "this rule has fired 14 times with 100% success" as a UI signal.

### 14. Hardware telemetry depth (reviewer consensus)

- Per-core thermal history (not just package)
- Throttling flags (`Get-Counter '\Processor Information(_Total)\% of Maximum Frequency'`)
- WHEA correctable error counts (leading indicator for RAM/bus/CPU degradation)
- NVMe media/data-units-written trend, not just composite health
- Fan + pump RPM for liquid loops (delta-T for pump failure prediction)
- PCIe retrain / link-width-drop events
- DPC/ISR latency spikes
- PSU rail anomalies where sensors are available (MSI/ASRock Stealth Mode)

### 15. Network diagnostics beyond reset

- DNS resolver latency (per-resolver timing; flag when ISP DNS is slower than 1.1.1.1)
- Gateway jitter/loss via periodic ICMP
- NIC offload / RSS / RSC config audit against best-practice
- DHCP lease anomalies (rapid renewal = interface flap)
- MTU / path-MTU discovery
- Wi-Fi mesh/backhaul metrics via `netsh wlan show wlanreport`
- Event-log correlation for adapter resets

### 16. Cross-host baseline drift (for users with 2+ machines)

If a new persistence item appears on one machine but not the others, that's higher signal than "it appeared on all 4 at once" (the latter is probably a legit Windows Update). Infrastructure: SQLite db synced to a shared location (Dropbox / OneDrive / Syncthing). Opt-in.

### 17. Split main-process from UI (long-term)

Current architecture: one Electron process owns both DB and action execution. Long-term:
- **Windows service** (installed as `PCDoctor Agent`): owns DB + executes safe actions + audits everything
- **Electron UI**: presentation + approval-gating for non-safe actions
- **Benefit:** actions keep running when UI is closed; service survives user-logout; cleaner permission model; DB not renderer-adjacent

This is weeks of work and only makes sense if the user base grows to the point where "I closed the app and my scheduled clean didn't run" becomes a real complaint.

---

## What this DOES NOT fix

- **"Install on any Windows device and forget about it"** — even after Phase 2, this is a tool for technically-comfortable users. The advanced diagnostics (HWiNFO import, OCCT stress testing, BSOD minidump analysis) are expert-level and won't become self-explanatory.
- **Any warranty** — MIT license, `AS IS`. If this bricks someone's Windows install, that's on them. Phase 4.12 postcondition validation reduces but does not eliminate the risk.
- **Enterprise scenarios** — AD-joined machines, Group Policy-locked settings, non-local-admin users. Out of scope.

---

## Time estimate

| Phase | Effort |
|-------|--------|
| Phase 1 (trust & integrity) | 1-2 days focused work |
| Phase 2 (usability for non-experts) | 1 week including OS compat test matrix |
| Phase 3 (CI/CD + SBOM + triage infra) | 2-3 days |
| Phase 4 (feature maturity) | Open-ended — each item 2-5 days on its own |

**Minimum cut to make the repo responsibly public:** Phase 1 steps 1-4. That's the threshold where "a stranger cloned and installed from my releases" stops being a danger I created.
