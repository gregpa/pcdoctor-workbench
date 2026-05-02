# First-Run Wizard v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 3-step placeholder wizard with a comprehensive, multi-step first-run experience that configures PCDoctor Workbench for any user's specific hardware, network, security preferences, and integrations — removing all Greg-specific hardcoding.

**Architecture:** Multi-step wizard rendered as a full-screen overlay (existing pattern). Each step is a self-contained React component receiving shared wizard state via props/context. Steps auto-detect what they can (hardware, installed tools, NAS drives) and prompt only for decisions. Wizard state accumulates in a single `WizardState` object; the final step writes all settings to the DB and triggers initial scan. Steps are skippable but the wizard tracks which were skipped for a "finish" summary.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Electron IPC, PowerShell scripts (existing), better-sqlite3 (existing dataStore)

---

## Wizard Step Map (10 steps)

| # | Step | What it does | Skippable? |
|---|------|-------------|-----------|
| W1 | Welcome | Brand intro, what the app does, what the wizard will configure | No |
| W2 | System Profile | Auto-detect CPU, RAM, GPU, drives, OS. Show hardware summary. User confirms or corrects. | No |
| W3 | Network & NAS | Do you have NAS drives? Auto-discover mapped network drives. Configure NAS server IP + drive mappings. | Yes |
| W4 | Security Baseline | Defender exclusion (existing), auto-block RDP toggle, review detected security posture | Yes |
| W5 | Notifications | Telegram bot setup (token + chat ID + test), email digest, quiet hours | Yes |
| W6 | Tools Catalog | Show all 22 tools, auto-detect what's already installed, let user pick which to install | Yes |
| W7 | Autopilot Rules | Show all 25 rules grouped by tier. User toggles which to enable. Sensible defaults pre-checked. | Yes |
| W8 | Integrations | Claude Code (detect install), Obsidian archive path, WSL memory cap | Yes |
| W9 | Scheduled Tasks | Register Windows Task Scheduler entries. Show what will run and when. | Yes (but recommended) |
| W10 | Initial Scan & Finish | Fire initial scan, show summary of all configured settings, list skipped steps for later. | No |

---

## Detailed Step Specifications

### W1: Welcome

**Purpose:** Explain the app and set expectations for the wizard.

**UI:**
- PCDoctor logo/icon
- Headline: "Welcome to PCDoctor Workbench"
- 4-5 bullet points explaining key features:
  - Real-time system health monitoring (CPU, RAM, disk, temps)
  - Automated security scanning and threat detection
  - NAS drive management and @Recycle cleanup
  - Autopilot maintenance (scheduled cleanup, scans, updates)
  - Weekly health reports and degradation forecasts
- "This wizard will configure the app for your specific system. It takes about 5 minutes."
- Estimated time: "~5 minutes"
- Single "Get Started" button

**Data collected:** None. Pure informational.

**Greg-specific items to remove:** None (current W1 is already generic).

---

### W2: System Profile

**Purpose:** Auto-detect hardware so forecast thresholds, RAM-related actions, and temperature alerts use the right values for THIS machine.

**Auto-detection (PowerShell/CIM, no user input needed):**
- CPU: model name, core count, TJ Max (from CIM or reasonable default per vendor)
- RAM: total physical, number of DIMMs
- GPU: model name, VRAM (from CIM Win32_VideoController)
- OS: Windows version, build, edition
- Drives: all logical disks with type, size, filesystem
- Machine: manufacturer, model (from Win32_ComputerSystem)

**UI:**
- "Your System" card showing detected hardware in a clean grid
- Each item shows detected value with a small edit icon if user needs to correct
- Temperature threshold section: "Based on your {CPU model}, we'll alert at {warn}C and {crit}C" with editable fields
- RAM section: "You have {total} GB RAM. We'll alert when usage exceeds {warn}%."

**Settings written:**
- `system_cpu_model`, `system_ram_gb`, `system_gpu_model` (new informational keys)
- `forecast_cpu_temp_warn`, `forecast_cpu_temp_crit` (new, replaces hardcoded 80/90)
- `forecast_gpu_temp_warn`, `forecast_gpu_temp_crit` (new, replaces hardcoded 80/85)
- `forecast_ram_warn_pct`, `forecast_ram_crit_pct` (new, replaces hardcoded 85/95)

**Greg-specific items to remove:**
- `forecastEngine.ts` comments referencing "i9-10900KF" and "RTX 3080" → use detected values
- Temperature thresholds become configurable settings instead of hardcoded constants

**New PowerShell script needed:** `Get-SystemProfile.ps1` — single CIM query that returns CPU, RAM, GPU, OS, drives, machine info as JSON.

---

### W3: Network & NAS

**Purpose:** Configure NAS server and drive mappings. This is the biggest Greg-specific hardcoding in the app.

**Auto-detection:**
- Run `Get-NasDrives.ps1` to discover all mapped network drives (DriveType=4)
- Parse UNC paths to extract server hostname/IP
- Check if any @Recycle folders exist (QNAP/Synology indicator)

**UI:**
- Toggle: "Do you have a NAS (network storage device)?" → Yes/No
  - If No: skip NAS config, disable NAS-related autopilot rules, hide NAS panel on dashboard
  - If Yes: show NAS config panel
- Auto-populated from detected network drives:
  - Server IP/hostname (extracted from UNC paths)
  - Drive mapping table: Letter | UNC Path | Label | Detected
  - "Add mapping" button for drives not yet mapped
- NAS brand selector: QNAP / Synology / Other (affects @Recycle path convention)

**Settings written:**
- `nas_enabled` (new: boolean, controls whether NAS panels/actions are shown)
- `nas_server` (existing, but remove hardcoded default)
- `nas_mappings` (existing, but populate from auto-detection instead of hardcoded Greg values)
- `nas_brand` (new: 'qnap' | 'synology' | 'other' — affects recycle path)

**Greg-specific items to remove:**
- `nasConfig.ts` default IP `192.168.50.226` → empty/null default
- `nasConfig.ts` default 6 drive mappings → empty array default
- `actions.ts` remap_nas tooltip "6 persistent SMB mappings to QNAP NAS" → dynamic from config
- `Settings.tsx` "Greg's QNAP at 192.168.50.226" text → generic

**Conditional effects:**
- If `nas_enabled = false`: hide NasRecycleBinPanel, disable `remap_nas` and `empty_nas_recycle_bin` actions, disable `refresh_nas_recycle_sizes_daily` autopilot rule

---

### W4: Security Baseline

**Purpose:** Set security preferences and establish the Defender exclusion.

**Auto-detection:**
- Defender status (enabled/disabled, definitions age)
- Firewall status (all profiles)
- BitLocker status (all drives)
- UAC status (enabled/disabled)
- RDP status (enabled/disabled)

**UI:**
- Security posture summary showing current state of each item with green/yellow/red indicators
- Defender exclusion offer (existing from current wizard): "Add C:\ProgramData\PCDoctor to Defender exclusions so scans don't interfere with the app's PowerShell scripts?"
  - Requires UAC elevation
  - Skip available
- Auto-block toggle: "Automatically block IP addresses that attempt RDP brute-force attacks?" (checkbox, default: off if RDP disabled, on if RDP enabled)
- Note about what each setting does in plain language

**Settings written:**
- `auto_block_rdp_bruteforce` (existing)
- Defender exclusion applied via `Add-PCDoctorExclusion.ps1` (existing)

**Greg-specific items to remove:** None (this step is already generic).

---

### W5: Notifications

**Purpose:** Set up how the user wants to be notified about events.

**Three sub-sections:**

**5A: Telegram Bot (optional)**
- Explanation: "Get push notifications on your phone when the app detects issues or completes maintenance."
- Step-by-step inline guide:
  1. "Open Telegram, search for @BotFather"
  2. "Send /newbot, follow prompts, copy the bot token"
  3. Paste token into input field
  4. "Send any message to your new bot, then click 'Detect Chat ID'"
  5. Chat ID auto-populated
  6. "Test" button → sends a test message
- Toggle: Enable/Disable Telegram notifications

**5B: Email Digest (optional)**
- "Receive a daily email summary of system health?"
- Email address input
- Digest hour selector (dropdown, default 8 AM)

**5C: Quiet Hours**
- "Suppress non-critical notifications during these hours"
- Start time / End time pickers (default: 11 PM - 7 AM)

**Settings written:**
- `telegram_bot_token`, `telegram_chat_id`, `telegram_enabled`
- `email_digest_recipient`, `digest_hour`
- `quiet_hours_start`, `quiet_hours_end`

**Greg-specific items to remove:** None (all notification settings are already generic).

---

### W6: Tools Catalog

**Purpose:** Let the user choose which third-party diagnostic tools to install.

**Auto-detection:**
- For each of the 22 tools, check `detect_paths` to see if already installed
- Check winget availability

**UI:**
- Grid of tool cards grouped by category (Hardware, Security, Forensics, Disk, Diagnostic, Windows Native)
- Each card shows: icon, name, description, install method (winget/manual), status badge (Installed/Not Installed)
- Checkboxes to select tools for batch install
- "Install Selected" button at bottom
- "Skip — I'll install tools later from the Tools page" option
- Pre-checked defaults: CrystalDiskInfo, Malwarebytes Free, TreeSize Free (broadly useful)

**Settings written:** None (tool installs are stateless — the app auto-detects on each launch).

**Actions triggered:** `winget install` for each selected tool (batched).

**Greg-specific items to remove:**
- `Tools.tsx` HWiNFO CSV default path `C:\Users\greg_\Downloads\test.CSV` → use `%USERPROFILE%\Downloads\` + file picker
- `MemTest86.tsx` "Alienware Aurora R11: Press F12" → detect manufacturer from W2 system profile, show appropriate boot key

---

### W7: Autopilot Rules

**Purpose:** Let the user review and customize which automated maintenance tasks run.

**UI:**
- Three sections by tier:
  - **Tier 1 — Silent (runs automatically, no notification):** Toggle each on/off. Defaults: all ON except NAS-specific (conditional on W3).
  - **Tier 2 — Auto-execute + Notify:** Toggle each on/off. Defaults: all ON.
  - **Tier 3 — Alert Only:** Toggle each on/off. Defaults: all ON.
- Each rule shows: name, description, schedule/trigger, what action it takes
- Preset buttons: "Enable All", "Minimal (alerts only)", "Custom"
- Tooltip explaining the tier system

**Settings written:**
- Per-rule `enabled` flag in `autopilot_rules` table (existing mechanism via `setAutopilotRuleEnabled`)

**Greg-specific items to remove:** None (rules are already generic). But NAS-related rules should auto-disable if W3 said "no NAS."

**Conditional logic:**
- If W3 `nas_enabled = false`: auto-disable `refresh_nas_recycle_sizes_daily`, `empty_nas_recycle_bin` weekly rule
- If W4 showed no RDP enabled: auto-disable RDP brute-force alert
- If WSL not installed (detected in W2): auto-disable `apply_wsl_cap_high_ram`

---

### W8: Integrations

**Purpose:** Configure optional integrations with external tools.

**Three sub-sections:**

**8A: Claude Code (optional)**
- Auto-detect: check if `claude` command is in PATH
- If found: "Claude Code detected! The Claude page will be available."
- If not found: "Claude Code not detected. You can install it later from anthropic.com/claude-code. The Claude page will be hidden until Claude Code is available."
- No user action needed — pure detection

**8B: Obsidian Archive (optional)**
- "Save weekly review reports to an Obsidian vault?"
- If Obsidian detected (check common paths): auto-suggest vault path
- If not: manual folder picker
- Toggle: Enable/Disable
- Default: disabled (most users won't have Obsidian)

**8C: WSL Memory Cap (conditional)**
- Only shown if WSL is detected on the system
- "WSL (Windows Subsystem for Linux) is installed. By default, WSL can use up to {detected_ram/2} GB of your {detected_ram} GB RAM."
- "Set a memory limit for WSL?" with slider/input
- Shows current .wslconfig memory value if one exists
- Default: skip (most users don't need this)

**Settings written:**
- `obsidian_archive_dir` (existing)
- `obsidian_enabled` (new: boolean)
- `wsl_memory_limit_gb` (new: used by apply_wsl_cap action)
- `claude_detected` (new: informational, controls page visibility)

**Greg-specific items to remove:**
- `actions.ts` WSL cap: hardcoded `C:\Users\greg_\.wslconfig` → use `%USERPROFILE%\.wslconfig`
- `actions.ts` WSL tooltip "32 GB" → use detected RAM from W2
- `ipc.ts` Obsidian fallback path → use setting or empty

---

### W9: Scheduled Tasks

**Purpose:** Register all Windows Task Scheduler entries so automated maintenance runs on schedule.

**UI:**
- Table showing all 20 tasks that will be registered:
  - Task name, schedule, what it does, requires elevation?
- "Register All Tasks" button (requires UAC for system-context tasks)
- Progress indicator as tasks are registered
- Results: green checkmark per successful registration, red X for failures
- Note: "These tasks keep your PC maintained automatically. You can review and modify them in Settings > Scheduled Tasks."

**Actions triggered:** Run `Register-All-Tasks.ps1` with elevation.

**Conditional logic:**
- If W3 `nas_enabled = false`: skip NAS-related tasks
- If W7 disabled specific rules: skip those task registrations

---

### W10: Initial Scan & Finish

**Purpose:** Populate the dashboard with initial data and summarize what was configured.

**UI:**
- Progress: "Running initial system scan..." with a progress bar
- Scan runs `Invoke-PCDoctor.ps1 -Mode Report` (existing)
- While scan runs, show a summary of all wizard decisions:
  - System: {CPU} / {RAM} GB / {GPU}
  - NAS: {enabled/disabled}, {N drives mapped}
  - Security: Defender exclusion {applied/skipped}, RDP auto-block {on/off}
  - Notifications: Telegram {configured/skipped}, Email digest {configured/skipped}
  - Tools: {N} installed, {N} skipped
  - Autopilot: {N} rules enabled out of {total}
  - Integrations: Claude {detected/not}, Obsidian {configured/skipped}, WSL cap {set/skipped}
  - Scheduled tasks: {N} registered
- List of skipped steps with "Configure later in Settings" links
- "Open Dashboard" button to complete the wizard

**Settings written:**
- `first_run_complete = '1'` (existing)
- `wizard_completed_at` (new: ISO timestamp)
- `wizard_version` (new: '2' — so future wizard versions can re-run if needed)

---

## Greg-Specific Hardcoding Removal Checklist

These changes are REQUIRED regardless of the wizard — they make the app generic:

| File | What to change | Priority |
|------|---------------|----------|
| `src/main/nasConfig.ts:23` | Default NAS IP `192.168.50.226` → `null` | P0 |
| `src/main/nasConfig.ts:32-39` | Default 6 drive mappings → empty `[]` | P0 |
| `src/shared/actions.ts:268` | remap_nas tooltip → dynamic from config | P1 |
| `src/shared/actions.ts:323` | WSL .wslconfig path → `%USERPROFILE%` | P1 |
| `src/shared/actions.ts:326` | WSL "32 GB" tooltip → detected RAM | P1 |
| `src/renderer/pages/Settings.tsx:362,374` | "Greg's QNAP" text → generic | P0 |
| `src/renderer/pages/Tools.tsx:341` | HWiNFO default CSV path → `%USERPROFILE%\Downloads\` | P1 |
| `src/renderer/pages/MemTest86.tsx:52` | "Alienware Aurora R11" → detected manufacturer | P1 |
| `src/main/ipc.ts:533` | Obsidian fallback path → use setting or disable | P1 |

---

## New Files

| File | Purpose |
|------|---------|
| `src/renderer/components/wizard/WizardShell.tsx` | Outer chrome: step indicator, nav buttons, state management |
| `src/renderer/components/wizard/WizardContext.tsx` | React context for shared wizard state |
| `src/renderer/components/wizard/steps/W1Welcome.tsx` | Welcome step |
| `src/renderer/components/wizard/steps/W2SystemProfile.tsx` | Hardware detection + display |
| `src/renderer/components/wizard/steps/W3NetworkNas.tsx` | NAS configuration |
| `src/renderer/components/wizard/steps/W4SecurityBaseline.tsx` | Security preferences |
| `src/renderer/components/wizard/steps/W5Notifications.tsx` | Telegram + email + quiet hours |
| `src/renderer/components/wizard/steps/W6ToolsCatalog.tsx` | Tool selection + batch install |
| `src/renderer/components/wizard/steps/W7AutopilotRules.tsx` | Autopilot rule review |
| `src/renderer/components/wizard/steps/W8Integrations.tsx` | Claude + Obsidian + WSL |
| `src/renderer/components/wizard/steps/W9ScheduledTasks.tsx` | Task registration |
| `src/renderer/components/wizard/steps/W10Finish.tsx` | Summary + initial scan |
| `powershell/Get-SystemProfile.ps1` | CIM hardware detection script |
| `tests/renderer/wizard/*.test.tsx` | Tests per wizard step |

---

## Existing Files to Modify

| File | Changes |
|------|---------|
| `src/renderer/components/layout/FirstRunWizard.tsx` | Replace entirely with import of new WizardShell |
| `src/main/nasConfig.ts` | Remove hardcoded defaults |
| `src/main/ipc.ts` | Add new IPC handlers: `api:getSystemProfile`, new setting keys |
| `src/main/rendererSafeSettings.ts` | Add new RENDERER_SAFE_KEYS |
| `src/main/dataStore.ts` | No schema changes needed (workbench_settings is key-value) |
| `src/shared/actions.ts` | Replace hardcoded strings with dynamic config lookups |
| `src/renderer/pages/Settings.tsx` | Remove Greg-specific text |
| `src/renderer/pages/Tools.tsx` | Fix hardcoded CSV path |
| `src/renderer/pages/MemTest86.tsx` | Use detected manufacturer |
| `src/renderer/App.tsx` | Swap FirstRunWizard import |
| `src/main/forecastEngine.ts` | Read thresholds from settings instead of hardcoded |

---

## Implementation Order

The work breaks into 3 phases:

### Phase 1: Generalization (remove Greg-specific hardcoding)
Tasks 1-3. These are prerequisites — the wizard can't configure what's still hardcoded.

### Phase 2: Wizard Infrastructure
Tasks 4-6. WizardShell, WizardContext, IPC additions.

### Phase 3: Wizard Steps
Tasks 7-16. One task per wizard step, each independently testable.

### Phase 4: Polish & Integration
Tasks 17-19. Wire everything together, test end-to-end, wizard re-run support.

---

## Task Breakdown

### Task 1: Remove hardcoded NAS defaults

**Files:**
- Modify: `src/main/nasConfig.ts`
- Modify: `src/renderer/pages/Settings.tsx`
- Modify: `src/shared/actions.ts` (remap_nas tooltip)

- [ ] **Step 1:** In `nasConfig.ts`, change default NAS IP from `'192.168.50.226'` to `null` and default mappings from the 6-drive array to `[]`.
- [ ] **Step 2:** In `Settings.tsx`, replace "Greg's QNAP at 192.168.50.226" with generic "NAS server IP address".
- [ ] **Step 3:** In `actions.ts`, change remap_nas tooltip from "6 persistent SMB mappings to QNAP NAS (M:, Z:, W:, V:, B:, U:)" to a dynamic string that reads from NAS config.
- [ ] **Step 4:** Run typecheck + vitest. Commit.

### Task 2: Remove hardcoded user paths

**Files:**
- Modify: `src/shared/actions.ts` (WSL .wslconfig path, "32 GB" tooltip)
- Modify: `src/renderer/pages/Tools.tsx` (HWiNFO CSV default path)
- Modify: `src/renderer/pages/MemTest86.tsx` (Alienware reference)
- Modify: `src/main/ipc.ts` (Obsidian fallback path)

- [ ] **Step 1:** In `actions.ts`, replace `C:\Users\greg_\.wslconfig` with `path.join(os.homedir(), '.wslconfig')` equivalent (the PS script already uses `$env:USERPROFILE`; fix the tooltip). Replace "32 GB" with a placeholder that the renderer fills from detected RAM.
- [ ] **Step 2:** In `Tools.tsx`, replace `C:\Users\greg_\Downloads\test.CSV` with a file picker that defaults to `%USERPROFILE%\Downloads\`.
- [ ] **Step 3:** In `MemTest86.tsx`, replace "Alienware Aurora R11: Press F12" with a generic "Check your motherboard manual for the boot key (commonly F2, F12, or Del)".
- [ ] **Step 4:** In `ipc.ts`, replace the Obsidian fallback path with a check for the `obsidian_archive_dir` setting; if empty, disable the feature rather than falling back to Greg's path.
- [ ] **Step 5:** Run typecheck + vitest. Commit.

### Task 3: Make forecast thresholds configurable

**Files:**
- Modify: `src/main/forecastEngine.ts`
- Modify: `src/main/ipc.ts` (add setting reads)

- [ ] **Step 1:** In `forecastEngine.ts`, read `forecast_cpu_temp_warn`, `forecast_cpu_temp_crit`, `forecast_gpu_temp_warn`, `forecast_gpu_temp_crit`, `forecast_ram_warn_pct`, `forecast_ram_crit_pct` from settings with sensible defaults (80/90, 80/85, 85/95).
- [ ] **Step 2:** Add the new keys to `RENDERER_SAFE_KEYS` so the wizard can display them.
- [ ] **Step 3:** Add the new keys to `WRITABLE_KEYS` so the wizard can set them.
- [ ] **Step 4:** Run typecheck + vitest. Commit.

### Task 4: Create Get-SystemProfile.ps1

**Files:**
- Create: `powershell/Get-SystemProfile.ps1`

- [ ] **Step 1:** Write a PS script that queries CIM for: CPU (Win32_Processor), RAM (Win32_PhysicalMemory + Win32_ComputerSystem), GPU (Win32_VideoController), OS (Win32_OperatingSystem), Machine (Win32_ComputerSystem), Drives (Win32_LogicalDisk), WSL presence (Test-Path $env:USERPROFILE\.wslconfig + wsl --status), Claude CLI presence (Get-Command claude).
- [ ] **Step 2:** Output as JSON with `-JsonOutput` flag (matching existing script convention).
- [ ] **Step 3:** Test manually. Commit.

### Task 5: Add IPC handler for system profile

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/main/preload.ts` (expose to renderer)

- [ ] **Step 1:** Add `ipcMain.handle('api:getSystemProfile', ...)` that runs `Get-SystemProfile.ps1` and returns the parsed JSON.
- [ ] **Step 2:** Expose `getSystemProfile` in the preload bridge.
- [ ] **Step 3:** Run typecheck. Commit.

### Task 6: Create WizardShell and WizardContext

**Files:**
- Create: `src/renderer/components/wizard/WizardContext.tsx`
- Create: `src/renderer/components/wizard/WizardShell.tsx`
- Modify: `src/renderer/App.tsx` (swap FirstRunWizard import)

- [ ] **Step 1:** Define `WizardState` interface covering all configurable fields from all 10 steps.
- [ ] **Step 2:** Create `WizardContext` with React context + reducer for state management.
- [ ] **Step 3:** Create `WizardShell` with: step indicator (progress dots/bar), current step component, Back/Next/Skip navigation, step validation before advancing.
- [ ] **Step 4:** Swap the import in `App.tsx` from `FirstRunWizard` to `WizardShell`.
- [ ] **Step 5:** Run typecheck. Commit.

### Task 7: W1 Welcome step

**Files:**
- Create: `src/renderer/components/wizard/steps/W1Welcome.tsx`
- Create: `tests/renderer/wizard/W1Welcome.test.tsx`

- [ ] **Step 1:** Write test: renders headline, bullets, "Get Started" button. Clicking button calls `onNext`.
- [ ] **Step 2:** Run test — verify FAIL.
- [ ] **Step 3:** Implement W1Welcome component.
- [ ] **Step 4:** Run test — verify PASS. Commit.

### Task 8: W2 System Profile step

**Files:**
- Create: `src/renderer/components/wizard/steps/W2SystemProfile.tsx`
- Create: `tests/renderer/wizard/W2SystemProfile.test.tsx`

- [ ] **Step 1:** Write test: calls `api.getSystemProfile()`, renders hardware grid, shows editable temperature thresholds.
- [ ] **Step 2:** Run test — verify FAIL.
- [ ] **Step 3:** Implement W2SystemProfile: call IPC on mount, display results in a grid, editable forecast threshold inputs with defaults from detected hardware.
- [ ] **Step 4:** Run test — verify PASS. Commit.

### Task 9: W3 Network & NAS step

**Files:**
- Create: `src/renderer/components/wizard/steps/W3NetworkNas.tsx`
- Create: `tests/renderer/wizard/W3NetworkNas.test.tsx`

- [ ] **Step 1:** Write tests: "no NAS" toggle hides config panel; auto-detected drives populate table; user can add/remove mappings.
- [ ] **Step 2:** Run tests — verify FAIL.
- [ ] **Step 3:** Implement: NAS toggle, auto-detection via `api.getNasDrives()`, editable mappings table, NAS brand selector.
- [ ] **Step 4:** Run tests — verify PASS. Commit.

### Task 10: W4 Security Baseline step

**Files:**
- Create: `src/renderer/components/wizard/steps/W4SecurityBaseline.tsx`
- Create: `tests/renderer/wizard/W4SecurityBaseline.test.tsx`

- [ ] **Step 1:** Write tests: shows security posture summary, Defender exclusion button, RDP auto-block toggle.
- [ ] **Step 2:** Run tests — verify FAIL.
- [ ] **Step 3:** Implement: read security posture from `api.getStatus()`, Defender exclusion via existing action, RDP toggle.
- [ ] **Step 4:** Run tests — verify PASS. Commit.

### Task 11: W5 Notifications step

**Files:**
- Create: `src/renderer/components/wizard/steps/W5Notifications.tsx`
- Create: `tests/renderer/wizard/W5Notifications.test.tsx`

- [ ] **Step 1:** Write tests: Telegram section with token/chatID inputs and test button; email digest section; quiet hours pickers.
- [ ] **Step 2:** Run tests — verify FAIL.
- [ ] **Step 3:** Implement three sub-sections. Telegram "Test" button calls `api.testTelegram()` (existing IPC). Quiet hours defaults to 23:00-07:00.
- [ ] **Step 4:** Run tests — verify PASS. Commit.

### Task 12: W6 Tools Catalog step

**Files:**
- Create: `src/renderer/components/wizard/steps/W6ToolsCatalog.tsx`
- Create: `tests/renderer/wizard/W6ToolsCatalog.test.tsx`

- [ ] **Step 1:** Write tests: renders tool grid with categories, shows installed/not-installed badges, checkboxes work, "Install Selected" triggers batch install.
- [ ] **Step 2:** Run tests — verify FAIL.
- [ ] **Step 3:** Implement: read tool definitions from `TOOLS` constant, detect installed via `api.getToolStatus()` (or similar), render categorized grid with selection.
- [ ] **Step 4:** Run tests — verify PASS. Commit.

### Task 13: W7 Autopilot Rules step

**Files:**
- Create: `src/renderer/components/wizard/steps/W7AutopilotRules.tsx`
- Create: `tests/renderer/wizard/W7AutopilotRules.test.tsx`

- [ ] **Step 1:** Write tests: renders rules grouped by tier, toggles work, preset buttons work, NAS rules hidden when NAS disabled.
- [ ] **Step 2:** Run tests — verify FAIL.
- [ ] **Step 3:** Implement: read rules from existing autopilot engine definitions, tier grouping, conditional visibility based on W3 NAS state.
- [ ] **Step 4:** Run tests — verify PASS. Commit.

### Task 14: W8 Integrations step

**Files:**
- Create: `src/renderer/components/wizard/steps/W8Integrations.tsx`
- Create: `tests/renderer/wizard/W8Integrations.test.tsx`

- [ ] **Step 1:** Write tests: Claude detection display, Obsidian path picker, WSL cap conditional section.
- [ ] **Step 2:** Run tests — verify FAIL.
- [ ] **Step 3:** Implement: read Claude/WSL detection from system profile (W2), Obsidian folder picker via Electron dialog, WSL memory slider.
- [ ] **Step 4:** Run tests — verify PASS. Commit.

### Task 15: W9 Scheduled Tasks step

**Files:**
- Create: `src/renderer/components/wizard/steps/W9ScheduledTasks.tsx`
- Create: `tests/renderer/wizard/W9ScheduledTasks.test.tsx`

- [ ] **Step 1:** Write tests: renders task table, "Register All" button triggers action, shows progress.
- [ ] **Step 2:** Run tests — verify FAIL.
- [ ] **Step 3:** Implement: list all tasks from Register-All-Tasks.ps1 definitions, execute registration via IPC, show per-task results.
- [ ] **Step 4:** Run tests — verify PASS. Commit.

### Task 16: W10 Initial Scan & Finish step

**Files:**
- Create: `src/renderer/components/wizard/steps/W10Finish.tsx`
- Create: `tests/renderer/wizard/W10Finish.test.tsx`

- [ ] **Step 1:** Write tests: shows progress during scan, displays config summary, writes `first_run_complete`, lists skipped steps.
- [ ] **Step 2:** Run tests — verify FAIL.
- [ ] **Step 3:** Implement: trigger scan, render summary from wizard state, write all accumulated settings to DB, set `first_run_complete = '1'`.
- [ ] **Step 4:** Run tests — verify PASS. Commit.

### Task 17: Settings persistence — write all wizard state to DB

**Files:**
- Modify: `src/main/ipc.ts`
- Modify: `src/main/rendererSafeSettings.ts`

- [ ] **Step 1:** Add all new setting keys to `WRITABLE_KEYS` and `RENDERER_SAFE_KEYS`.
- [ ] **Step 2:** Add IPC handler `api:applyWizardSettings` that accepts the full `WizardState` and writes each field to the appropriate store (workbench_settings, nasConfig, autopilot_rules).
- [ ] **Step 3:** Run typecheck + vitest. Commit.

### Task 18: Conditional UI — hide features based on wizard config

**Files:**
- Modify: `src/renderer/pages/Dashboard.tsx` (hide NAS panel if nas_enabled=false)
- Modify: `src/renderer/components/layout/Sidebar.tsx` (hide Claude page if not detected)
- Modify: `src/renderer/pages/Autopilot.tsx` (reflect wizard-disabled rules)

- [ ] **Step 1:** Dashboard: wrap NasRecycleBinPanel in a `nas_enabled` check.
- [ ] **Step 2:** Sidebar: conditionally show Claude menu item based on `claude_detected` setting.
- [ ] **Step 3:** Run typecheck + vitest. Commit.

### Task 19: Wizard re-run support

**Files:**
- Modify: `src/renderer/pages/Settings.tsx`
- Modify: `src/renderer/components/wizard/WizardShell.tsx`

- [ ] **Step 1:** Add "Re-run Setup Wizard" button to Settings page.
- [ ] **Step 2:** When triggered, clear `first_run_complete` and show WizardShell as overlay.
- [ ] **Step 3:** Wizard pre-populates all fields from current settings so the user can adjust without re-entering everything.
- [ ] **Step 4:** Run typecheck + vitest. Commit.

---

## Testing Strategy

- Each wizard step has its own test file with mocked IPC
- Integration test: full wizard flow with all steps completed
- Integration test: full wizard flow with all steps skipped
- Integration test: re-run wizard with pre-populated state
- Pre-existing 638 tests must continue passing (no regressions)

## Pre-Ship Gates

All 7 existing gates must pass before merge:
1. `tsc --noEmit` (renderer + main)
2. `vitest run` (638+ tests)
3. `test-installer-acl.ps1` (admin)
4. `test-pfro-pattern-match.ps1`
5. `test-task-registration.ps1`
6. `verify-better-sqlite3-abi.ps1`
7. `test-bundle-sync-coverage.ps1`
