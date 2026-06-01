# CLAUDE.md — PCDoctor Workbench

Guidance for Claude Code (and humans) working in this repo. Keep it lean; link
out to the long-form docs rather than duplicating them.

## What this is

A **Windows-only** tray-resident Electron diagnostic/maintenance dashboard on
top of a PowerShell scanner+action stack deployed to `C:\ProgramData\PCDoctor\`.
It is a **personal tool** for one machine (Alienware Aurora R11, Win 11 Pro) —
see `README.md` for the hardcoded assumptions (NAS IP, drive letters, AWCC).
The primary user is **Greg**.

## Architecture map

| Path | Role |
|------|------|
| `src/main/` | Electron main process (Node). IPC surface (`ipc.ts`), `dataStore.ts` (better-sqlite3), `actionRunner.ts` / `scriptRunner.ts`, `autopilotEngine.ts`, `elevatedWorker.ts` (batched UAC), bridges (claude/pcdoctor/telegram), `autoUpdater.ts`, `tray.ts`. |
| `src/preload/` | contextBridge — the only main↔renderer channel. |
| `src/renderer/` | React 18 + React Router UI: `pages/`, `components/`, `hooks/`, `lib/`. |
| `src/shared/` | Types + logic shared by main & renderer: `types.ts`, `actions.ts`, `tools.ts`, `recommendations.ts`, `errors.ts`. |
| `powershell/` | The scanner/action stack (deployed to `C:\ProgramData\PCDoctor\`). |
| `tests/` | vitest (`main/`, `renderer/`, `shared/`); PowerShell test scripts live in `scripts/`. |

## Commands

```
npm run dev          # vite dev server
npm run build        # vite build + emit cjs package.json shim
npm run typecheck    # tsc main + renderer, --noEmit   (must be clean)
npm test             # vitest run
npm run lint         # eslint src  (green baseline; warnings = ratchet backlog)
npm run package      # full electron-builder install (rebuilds better-sqlite3)
```

PowerShell gates (**Windows + pwsh only**): `npm run test:ps51` (PS 5.1 syntax),
`scripts/test-worker-smoke.ps1`, `npm run test:tasks`, `npm run test:bundle-sync`.

## The "Gates" ritual — run before every commit

This is the verification sequence recorded in every commit message:

1. `npm run typecheck`  → must be clean
2. `npm test`           → record pass count (e.g. `vitest 897/897`)
3. `npm run test:ps51`  → PS 5.1 syntax (e.g. `PS5.1 126/126`)
4. `scripts/test-worker-smoke.ps1` → pwsh 7 + PS 5.1 worker smoke

The `/gates` slash command (`.claude/commands/gates.md`) runs this for you.

> ⚠ **Tests need Windows + a native `better-sqlite3` build.** On Linux / a fresh
> clone without `npm run verify:abi`, expect ~70 vitest failures that are
> *environment artifacts* (missing native `.node` binary, Win32 path
> assumptions) — **not** real regressions. The real result is the Windows run.

## Landmines — read before touching these

- **ACL / `icacls` code** (`scripts/installer.nsh`, `powershell/Apply-TieredAcl.ps1`,
  `powershell/Repair-ScriptAcls.ps1`, `Heal-InstallAcls.ps1`): read
  [`docs/DEVELOPER_WARNINGS.md`](docs/DEVELOPER_WARNINGS.md) FIRST. The
  `(OI)(CI)` recursive-grant bug has shipped zero-ACE trees three times.
- **PS-sentinel pattern**: action scripts signal success/failure via sentinel
  output, not just exit codes — see `scriptRunner.ts` and
  `scriptRunnerSentinelPrecedence.test.ts`. Don't "simplify" to exit-code-only.
- **IPC allow-list**: renderer can only invoke allow-listed channels in
  `ipc.ts`. New actions must be added there *and* covered by an allow-list test.
- **UAC elevation**: actions elevate per-action via the batched elevated worker.
  Don't add `detached: true` to spawn opts — it has broken elevation before
  (see v2.5.33).

## Conventions

- **Commit messages**: `vX.Y.Z: <one-line summary>` then a body with
  **Symptom / Fix / Gates / Out-of-scope**. Always record gate counts in the
  body. Keep this format — it's the project's audit trail.
- **No new deps** without a clear reason; this app ships to one machine.
- Long-form planning/review artifacts live in `docs/superpowers/`.
