# PCDoctor Phase 4 Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a clean, inspectable PCDoctor release candidate with supported dependencies, verified downloads, deterministic packaging, complete task cleanup, and explicit signing/install/publish gates.

**Architecture:** Upgrade dependencies in isolated cohorts with the full suite after each cohort. Build only from a clean lockfile in CI/local clean state, inspect the asar/native modules/PowerShell/task manifest/NSIS behavior, generate hashes and an SBOM, and distinguish development-unsigned from release-signed artifacts. Installed validation, publishing, and updater delivery remain separate actions.

**Tech Stack:** npm, Electron/Electron Builder, GitHub Actions, NSIS, PowerShell 5.1, Authenticode, `better-sqlite3`, Vitest.

## Global Constraints

- Do not use `npm audit fix --force`.
- Electron must be within the latest three supported stable majors; the audited initial target is 43.2.0.
- Each dependency cohort gets its own lockfile diff, test run, and commit.
- Downloaded executables require fixed host, size bounds, valid Authenticode, and expected publisher before promotion/execution.
- Installer work must not leave a Defender exclusion behind.
- Unsigned artifacts may be labeled development-only; they may not be published as updater releases.
- Do not install the candidate or publish a GitHub Release without a separate direct authorization.
- No reboot.

---

## File structure

- Create `docs/DEPENDENCY-UPGRADE-2026-08.md`: exact cohort decisions and audit deltas.
- Create `scripts/verify-package.ps1`: asar/native/script/manifest/signature/hash inspection.
- Create `scripts/verify-download-signature.ps1`: fixed signer/host/size promotion gate.
- Create `scripts/verify-release-candidate.ps1`: aggregate non-install release gate.
- Create `.github/workflows/release-candidate.yml`: manual, no-publish artifact workflow.
- Modify package dependencies/config/scripts, tool downloader, Dashboard security collection, installer exclusion handling, smoke tests, release docs, and privacy/retention docs.

### Task 1: Controlled supported dependency cohorts

**Files:**
- Create: `docs/DEPENDENCY-UPGRADE-2026-08.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: Electron compatibility tests/config only when a cohort requires it

**Interfaces:**
- Produces a dependency record with before/after versions, advisory IDs/severity, compatibility notes, test commands, and rollback commit.

- [ ] **Step 1: Capture immutable baseline**

Run and save summarized JSON counts plus exact package versions:

```powershell
npm ls --depth=0 --json
npm audit --omit=dev --json
npm audit --json
npm outdated --json
```

Record the current baseline from the audit: Electron 33.4.11 EOL; production 4 high/2 moderate; full tree 2 critical/22 high/6 moderate/2 low.

- [ ] **Step 2: Upgrade runtime security patches first**

Upgrade `adm-zip`, `electron-updater`/`builder-util-runtime`, React Router, and transitive YAML packages to the minimum non-vulnerable releases reported by npm, using exact versions and no force flag. Run `npm run verify:source` and commit this cohort alone.

- [ ] **Step 3: Upgrade Electron to 43.2.0 as a separate cohort**

Run `npm install --save-dev --save-exact electron@43.2.0`, rebuild native modules, then run source, build, ABI, and unpacked launch tests. Fix only documented Electron API incompatibilities.

- [ ] **Step 4: Upgrade build tooling as a third cohort**

Upgrade Electron Builder/rebuild/Vite/Vitest/TypeScript/ESLint packages only to versions compatible with Electron 43 and Node 22. Run the entire source/package test matrix. Do not combine unrelated application refactors.

- [ ] **Step 5: Verify audit deltas and commit the record**

Production audit must contain no high/critical advisory with an available compatible fix. Any accepted residual advisory gets exact package, reachability, mitigation, and review date in the dependency record.

```powershell
git add package.json package-lock.json docs/DEPENDENCY-UPGRADE-2026-08.md
git commit -m "build: document supported dependency baseline"
```

### Task 2: Stop Dashboard collection from perturbing startup

**Files:**
- Modify: Dashboard security hook/component modules discovered by `rg "getSecurityPosture|getThreatIndicators|getRecentAuthEvents" src/renderer`
- Create: `src/main/securitySnapshotStore.ts`
- Create: `tests/main/securitySnapshotStore.test.ts`
- Create: `tests/renderer/securitySnapshotLoading.test.tsx`
- Modify: scheduled read-only security intent lifecycle

**Interfaces:**
- Produces persisted `SecuritySnapshot` with capture time, collector quality, expiry, and partial warnings.
- Renderer reads persisted state first and requests one refresh only when stale or explicit.

- [ ] **Step 1: Write one-flight/stale tests**

Mount Dashboard and assert it does not spawn four security PowerShell collectors. Test fresh cache, stale cache, partial cache, explicit refresh, concurrent refresh coalescing, timeout, and app shutdown.

- [ ] **Step 2: Implement persisted snapshots**

Write scheduled results through the main-process store. A stale request uses the Orchestrator's `readonly-security` lock and sequential bounded collectors. Renderer receives `unknown/partial` rather than healthy on failure.

- [ ] **Step 3: Verify and commit**

```powershell
npx vitest run tests/main/securitySnapshotStore.test.ts tests/renderer/securitySnapshotLoading.test.tsx
npm run typecheck
git add src/main/securitySnapshotStore.ts tests/main/securitySnapshotStore.test.ts tests/renderer/securitySnapshotLoading.test.tsx src/renderer src/main
git commit -m "perf: load persisted security snapshots"
```

### Task 3: Verify every downloaded executable before promotion

**Files:**
- Create: `scripts/verify-download-signature.ps1`
- Modify: `src/main/toolLauncher.ts`
- Modify: `src/shared/tools.ts`
- Create: `tests/main/toolDownloadTrust.test.ts`
- Modify: `tests/main/toolLauncher.test.ts`

**Interfaces:**
- Produces: `DownloadTrustPolicy` with exact HTTPS host allowlist, byte bounds, expected publisher subjects, and optional pinned SHA-256.
- Produces: download to random temp file, verify, then atomic promote.

- [ ] **Step 1: Write trust-boundary tests**

Reject HTTP, disallowed redirect host, missing/invalid signature, wrong publisher, undersized/oversized file, changed pinned hash, non-PE executable, and target replacement race. Accept the expected Microsoft Safety Scanner publisher fixture.

- [ ] **Step 2: Implement fixed trust policy**

Renderer supplies only a known tool ID. Main resolves URL/publisher/size. Follow redirects only across the tool's explicit host set. Download to a new file, flush, calculate SHA-256, call Authenticode verification, compare normalized signer subject, and atomically rename only after all checks pass.

- [ ] **Step 3: Verify and commit**

```powershell
npx vitest run tests/main/toolDownloadTrust.test.ts tests/main/toolLauncher.test.ts
powershell.exe -ExecutionPolicy Bypass -File scripts/verify-download-signature.ps1 -SyntheticOnly
git add scripts/verify-download-signature.ps1 src/main/toolLauncher.ts src/shared/tools.ts tests/main/toolDownloadTrust.test.ts tests/main/toolLauncher.test.ts
git commit -m "security: verify downloaded tool publishers"
```

### Task 4: Remove installer Defender-exclusion risk and verify cleanup

**Files:**
- Modify: `scripts/installer.nsh`
- Modify: `electron-builder.yml`
- Create: `scripts/test-installer-defender-policy.ps1`
- Modify: `scripts/test-installer-acl.ps1`
- Modify: `scripts/test-installed-smoke.ps1`

**Interfaces:**
- Installer performs bundle extraction without a broad temporary Defender exclusion.
- Uninstaller invokes manifest-driven task cleanup and verifies no current/legacy PCDoctor task remains.

- [ ] **Step 1: Write static installer assertions**

Fail if NSIS contains `Add-MpPreference -ExclusionPath`, suppresses exclusion-removal errors, omits `Unregister-All-Tasks.ps1`, or hardcodes a partial task list.

- [ ] **Step 2: Remove the exclusion path**

Delete add/remove exclusion logic rather than attempting best-effort cleanup. Keep narrowly scoped ACL installation and bundle hash verification. If packaging performance regresses, measure it; do not restore an unverifiable exclusion.

- [ ] **Step 3: Extend installed smoke checks without running them yet**

Add checks for all manifest active/deferred/remove states, hidden-window XML, no direct mutating task action, no Defender exclusion for `C:\ProgramData\PCDoctor`, correct installed version, migration version, Sentinel sample, Orchestrator global state, and `reboot_policy=never`.

- [ ] **Step 4: Verify static tests and commit**

```powershell
powershell.exe -ExecutionPolicy Bypass -File scripts/test-installer-defender-policy.ps1
npm run test:tasks
git add scripts/installer.nsh electron-builder.yml scripts/test-installer-defender-policy.ps1 scripts/test-installer-acl.ps1 scripts/test-installed-smoke.ps1
git commit -m "security: remove installer Defender exclusion"
```

### Task 5: Deterministic package, ABI, SBOM, and signing-state verification

**Files:**
- Create: `scripts/verify-package.ps1`
- Create: `scripts/verify-release-candidate.ps1`
- Create: `.github/workflows/release-candidate.yml`
- Modify: `package.json`
- Modify: `docs/SIGNING.md`
- Modify: `README.md`
- Modify: `PRIVACY.md`

**Interfaces:**
- Produces: `npm run verify:package` and `npm run verify:release-candidate`.
- Produces: `release-candidate-manifest.json` with artifact names, sizes, SHA-256, signature state, package/app version, Electron version, native ABI, task-manifest hash, SBOM path, and gate results.

- [ ] **Step 1: Write package verifier tests against good/bad fixtures**

Reject missing installer/blockmap/`latest.yml`, version mismatch, stale task manifest, missing bundled scripts, unexpected script, native ABI mismatch, unsigned release mode, signer mismatch, unsafe NSIS content, and updater metadata hash mismatch.

- [ ] **Step 2: Implement development versus release signing modes**

`verify-package.ps1 -Mode Development` records `NotSigned` and sets `publish_allowed=false` while permitting local inspection. `-Mode Release` requires valid Authenticode and exact configured publisher; it fails otherwise. Do not generate or trust a self-signed release identity automatically.

- [ ] **Step 3: Create a no-publish CI candidate workflow**

Use `workflow_dispatch`, clean Windows runner, `npm ci`, source gates, Electron rebuild/package, package verification, SBOM generation, hashes, and artifact upload. Give the workflow contents read permission only; it must not create releases, tags, or commits.

- [ ] **Step 4: Correct documentation to actual behavior**

Document unsigned development status until a protected certificate is configured, local-only telemetry, exact retention, maintenance evidence, conditional policies disabled by default, and separate install/publish gates.

- [ ] **Step 5: Verify and commit**

```powershell
npm run verify:source
npm run package
npm run verify:abi
powershell.exe -ExecutionPolicy Bypass -File scripts/verify-package.ps1 -Mode Development
git add scripts/verify-package.ps1 scripts/verify-release-candidate.ps1 .github/workflows/release-candidate.yml package.json docs/SIGNING.md README.md PRIVACY.md
git commit -m "build: verify release candidates without publishing"
```

### Task 6: Phase 4 candidate gate and explicit stop

**Files:**
- Create: `docs/superpowers/reports/phase-4-release-candidate-validation.md`

- [ ] **Step 1: Build from a clean source dependency state**

Run:

```powershell
npm ci
npm run verify:source
npm run package
npm run verify:abi
npm run verify:package
```

- [ ] **Step 2: Inspect the candidate without installing**

Verify hashes, task manifest, bundled script inventory, native ABI, updater metadata, SBOM, audit counts, and signature state. If unsigned, label the candidate development-only and `publish_allowed=false`.

- [ ] **Step 3: Preserve exact next-gate commands without running them**

After separate install authorization, the next commands are:

```powershell
# Run only after explicit install approval and installation of the exact hashed candidate
npm run test:smoke
powershell.exe -ExecutionPolicy Bypass -File scripts/test-installed-smoke.ps1
```

Publishing remains a later explicit action after installed smoke evidence and valid release signing.

- [ ] **Step 4: Record evidence and commit**

Record artifact hashes/sizes, signature state, source commit, complete gates, unresolved advisories, and the statements `installed=false`, `published=false`, `rebooted=false`.

```powershell
git add docs/superpowers/reports/phase-4-release-candidate-validation.md
git commit -m "docs: record release candidate validation"
```
