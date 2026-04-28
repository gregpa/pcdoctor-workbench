// v2.4.43 (expert review): bump libuv threadpool from default 4 -> 8 BEFORE
// any import that might touch libuv (fs, dns, crypto). Defense in depth
// against threadpool starvation if a background copyFile / readFile blocks
// on a Windows share-mode lock. With only 4 threads, 4 stuck ops block all
// subsequent fs I/O in the main process; 8 gives headroom for transient
// Defender / OneDrive locks without user-visible stalls.
if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = '8';
}

import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { access, constants as fsConstants, stat } from 'node:fs/promises';
import log from 'electron-log/main';
import { createTray, updateTraySeverity } from './tray.js';
import { registerIpcHandlers } from './ipc.js';
import { getStatus } from './pcdoctorBridge.js';
import { POLL_INTERVAL_MS, LOG_DIR } from './constants.js';

// v2.4.52 (B52-MIG-1): wire electron-log for the main process. Pre-2.4.52
// the LOG_DIR constant was defined but never used — console.warn / console.log
// flowed to nowhere observable post-launch. After v2.4.51 shipped a real
// migration-flag bug we couldn't diagnose without a single observable
// log line, so the diagnostic infra finally graduates from TODO.
//
// Output file: %APPDATA%\PCDoctor\logs\main.log (path matches LOG_DIR
// constant; pre-existing perf logs at C:\ProgramData\PCDoctor\logs\ are
// unrelated and stay separate).
//
// Default log levels: warn + above to file. The migration / ACL blocks
// below explicitly bump to info via log.info(...) so the per-step trace
// always lands regardless of the global level.
log.transports.file.resolvePathFn = () => path.join(LOG_DIR, 'main.log');
log.transports.file.maxSize = 5 * 1024 * 1024;  // 5 MB rolling
log.transports.file.level = 'info';
log.transports.console.level = 'warn';
log.initialize();
import { startTelegramPolling, stopTelegramPolling, answerCallbackQuery, editMessageText, sendTelegramMessage } from './telegramBridge.js';
import { runAction } from './actionRunner.js';
import { ACTIONS } from '@shared/actions.js';
import type { ActionName } from '@shared/types.js';
import { startClaudeBridgeWatcher } from './claudeBridgeWatcher.js';
import { flushBufferedNotifications, getDigestHour } from './notifier.js';
import { initAutoUpdater, checkForUpdates } from './autoUpdater.js';
import { registerPtyIpc, killAllPtySessions } from './ptyBridge.js';
import { startAutopilotEngine, stopAutopilotEngine, getAutopilotActivity } from './autopilotEngine.js';
import { startAutopilotLogIngestor, stopAutopilotLogIngestor } from './autopilotLogIngestor.js';
import { suppressAutopilotRule, insertAutopilotActivity } from './dataStore.js';

// Hide dock icon / single-instance check
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let pollTimer: NodeJS.Timeout | null = null;

// v2.4.47 (B46-1): the autopilot script names + the predicate that decides
// whether to fire the elevated Sync-ScriptsFromBundle.ps1 are extracted to
// taskMigrationVerify.ts so they're unit-testable without dragging in the
// Electron app boot side-effects of main.ts.

function createWindow() {
  // v2.4.6: show the window by default on launch. Previously always
  // started hidden which was fine for the scheduled-task autostart at
  // login but broke user expectation when double-clicking the desktop
  // icon (app appeared to do nothing). The scheduled task now passes
  // --hidden; only that suppresses the initial window.
  const startHidden = process.argv.includes('--hidden');
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 980,
    // v2.4.44: window locked non-resizable. Reasoning documented across
    // v2.4.37 (first lock), v2.4.40 (getStatus concurrency fix),
    // v2.4.42 (CSS contain), v2.4.43 (atomic producer + copyFile
    // consumer). Each release improved resize perf but the 56-second
    // freeze event at 02:14:05 on 2026-04-24 demonstrated that when
    // Windows Defender / OneDrive / the scanner saturate the disk,
    // the Node main-process event loop can be starved for tens of
    // seconds. Even Promise.race + setTimeout(3000) can't fire if the
    // process doesn't get CPU. User-space can't guarantee against
    // OS-level thrash.
    //
    // User decision 2026-04-24: lock it. Maximize still works.
    // Re-evaluate if/when we move to a worker-thread file read
    // (worker.terminate() is OS-enforced and bypasses the starvation).
    resizable: false,
    maximizable: true,
    minimizable: true,
    show: !startHidden,
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  }

  mainWindow.on('close', (e) => {
    // Minimize to tray instead of quit
    if (!(app as any).isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  // Reviewer P1: hard nav-guards. Any target="_blank" link opens in the
  // user's default browser rather than inside the Electron window. Any
  // in-window navigation to a non-self origin is blocked and redirected to
  // the external browser. Defense-in-depth beyond CSP (belt + suspenders).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      const devUrl = process.env.VITE_DEV_SERVER_URL;
      const allowedOrigin = devUrl ? new URL(devUrl).origin : null;
      const isSelfOrigin = allowedOrigin && parsed.origin === allowedOrigin;
      const isFile = url.startsWith('file://');
      if (!isSelfOrigin && !isFile) {
        event.preventDefault();
        shell.openExternal(url).catch(() => {});
      }
    } catch {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on('will-redirect', (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== 'file://' && !url.startsWith('file://') && !process.env.VITE_DEV_SERVER_URL) {
        event.preventDefault();
      }
    } catch { event.preventDefault(); }
  });

  // Browser-style zoom via Ctrl+=/Ctrl+-/Ctrl+0. Also supports Ctrl+scroll.
  // Persisted to the settings table so zoom survives restarts.
  const wc = mainWindow.webContents;
  const clamp = (n: number) => Math.max(-3, Math.min(5, n));

  wc.on('did-finish-load', async () => {
    try {
      const { getSetting } = await import('./dataStore.js');
      const saved = parseFloat(getSetting('ui_zoom_level') ?? '0');
      if (!isNaN(saved)) wc.setZoomLevel(clamp(saved));
    } catch { /* non-fatal */ }
  });

  const saveZoom = async (level: number) => {
    try {
      const { setSetting } = await import('./dataStore.js');
      setSetting('ui_zoom_level', String(level));
    } catch { /* non-fatal */ }
  };

  wc.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown' || !input.control) return;
    if (input.key === '=' || input.key === '+') {
      const lvl = clamp(wc.getZoomLevel() + 0.5);
      wc.setZoomLevel(lvl); saveZoom(lvl);
    } else if (input.key === '-') {
      const lvl = clamp(wc.getZoomLevel() - 0.5);
      wc.setZoomLevel(lvl); saveZoom(lvl);
    } else if (input.key === '0') {
      wc.setZoomLevel(0); saveZoom(0);
    }
  });

  wc.setVisualZoomLevelLimits(1, 1); // disable pinch-zoom; Ctrl+wheel still works
}

async function backgroundPoll() {
  try {
    const status = await getStatus();
    updateTraySeverity(status.overall_severity);
  } catch {
    // Silent - backend may not have run yet. Tray stays last-known color.
  }
}

app.whenReady().then(() => {
  registerIpcHandlers();

  // v2.4.46: extract the two sidecar-sync IIFEs into named promises so the
  // task-migration block (below) can await them. Pre-2.4.46 the migration
  // ran in parallel with the NAS / Startup config writes, which on a fast
  // SSD usually finished in time but on slow disks could race the
  // schtasks /Create -- producing a registered task that read stale
  // sidecar JSON on its first scheduled fire.

  // Bundle-sync coordination Promise. Declared up-front (before the
  // migration IIFE that awaits it) so the synchronous evaluation of
  // `bundleSyncPromise` inside the migration's `Promise.allSettled([...])`
  // expression doesn't hit a TDZ. Resolved by the bundle-sync IIFE further
  // down.
  let resolveBundleSync!: () => void;
  const bundleSyncPromise: Promise<void> = new Promise<void>((res) => { resolveBundleSync = res; });
  let bundleNeedsElevatedCopy = false;
  // v2.4.47 (B46-1): per-file mismatch list captured by the bundle-sync IIFE
  // and read by the migration IIFE after `await bundleSyncPromise`. Stored as
  // an array of relative path strings (e.g. 'Register-All-Tasks.ps1'). The
  // implicit contract: the bundle-sync IIFE writes this *before* calling
  // resolveBundleSync(), so any reader awaiting bundleSyncPromise sees a
  // settled value. Documented inline because module-scope mutable shared
  // state across IIFEs is otherwise easy to misread.
  let bundleMismatches: string[] = [];
  // v2.4.47 (B46-1): set by the bundle-sync IIFE to true if it already
  // performed the elevated Sync (whether successful or declined). The
  // migration IIFE reads this to AVOID firing a second UAC prompt for the
  // same operation -- the bundle-sync IIFE always tries first, and the
  // migration's elevated-Sync fallback is a defensive belt-and-braces for
  // the case where the bundle-sync's ACL-versioning short-circuit
  // (`last_acl_repair_version`) suppressed it.
  let bundleElevatedSyncAttempted = false;
  const bundledPsDir = app.isPackaged
    ? path.join(process.resourcesPath, 'powershell')
    : path.join(app.getAppPath(), 'powershell');

  // v2.4.6: sync NAS config (server IP + drive mappings) from the settings
  // DB to the sidecar JSON at C:\ProgramData\PCDoctor\settings\nas.json.
  // Scanner + Remap-NAS action read this file; falling back to hardcoded
  // defaults if it's missing keeps fresh installs + upgrades silent.
  const nasSyncPromise: Promise<void> = (async () => {
    try {
      const { syncNasConfigToDisk } = await import('./nasConfig.js');
      syncNasConfigToDisk();
    } catch { /* non-fatal */ }
  })();

  // v2.4.13: sync Startup config (threshold + allowlist) to sidecar JSON.
  // Invoke-PCDoctor.ps1 reads this file to decide whether to emit the
  // startup-count warning. Default threshold 20 matches the user-facing
  // "healthy under 20" language. Empty allowlist is the pre-v2.4.13
  // baseline.
  const startupSyncPromise: Promise<void> = (async () => {
    try {
      const { syncStartupConfigToDisk } = await import('./startupConfig.js');
      syncStartupConfigToDisk();
    } catch { /* non-fatal */ }
  })();

  // Auto-register PCDoctor scheduled tasks (best-effort, once per session).
  // v2.3.0 B2: on the first launch of 2.3.0, force-recreate existing tasks so
  // the user/SYSTEM context split applies. This rewrites /RU for tasks that
  // used to run as SYSTEM and need to read HKCU.
  // v2.4.45: bumped to force-recreate so the 11 Autopilot tasks swap their
  // inline action-script invocation for the Run-AutopilotScheduled.ps1
  // dispatcher wrapper. Without this, upgrading installs keep their
  // v2.4.44 task definitions and their LAST RUN column stays blank.
  // v2.4.46 (B45-1 + B45-4):
  //  - bumped TASK_MIGRATION_VERSION so every v2.4.45 install re-registers
  //    via the new /XML path (the v2.4.45 /TR path silently failed at
  //    261 chars and the migration flag was already set on every install).
  //  - await sidecar syncs + bundle-sync completion before invoking the
  //    PowerShell so newly-synced scripts are guaranteed on disk first.
  //  - parse the script's JSON return and require at least one autopilot
  //    row carry a `command` referencing `Run-AutopilotScheduled.ps1`.
  //    Only then is the flag written. If verification fails, the flag is
  //    left at its previous value and the next launch retries -- exactly
  //    the self-healing v2.4.45 lacked.
  (async () => {
    // v2.4.52 (B52-MIG-1): every step in this migration block now logs to
    // main.log (electron-log file transport). Pre-2.4.52 a real bug shipped
    // in v2.4.51 (migration ran successfully — tasks registered with v2.4.51
    // Author — but the setSetting flag write silently failed; outer
    // try/catch swallowed) and we had no way to tell which step had failed.
    // The log.info pairs let us bisect on the next occurrence.
    log.info('[migration] block start');
    try {
      // Order: NAS + Startup sidecars + ACL/bundle-sync first so that
      // Register-All-Tasks sees a fully-populated C:\ProgramData\PCDoctor\.
      await Promise.allSettled([nasSyncPromise, startupSyncPromise, bundleSyncPromise]);
      log.info('[migration] sidecar promises settled');

      const { runPowerShellScript, runElevatedPowerShellScript } = await import('./scriptRunner.js');
      const { getSetting, setSetting } = await import('./dataStore.js');
      const TASK_MIGRATION_VERSION = '2.4.51';
      const lastMigration = getSetting('last_task_migration_version');
      const isUpgrade = lastMigration !== TASK_MIGRATION_VERSION;
      log.info(`[migration] lastMigration=${JSON.stringify(lastMigration)} target=${TASK_MIGRATION_VERSION} isUpgrade=${isUpgrade}`);

      // v2.4.47 (B46-1): if (a) we are mid-upgrade, (b) the bundle-sync probe
      // said elevation is needed, AND (c) at least one of the autopilot
      // dispatcher / Register scripts is on the mismatch list, AND (d) the
      // bundle-sync IIFE did NOT already attempt the elevated copy (avoids
      // double UAC), fire our own elevated Sync BEFORE invoking
      // Register-All-Tasks. The (d) gate is what makes this defensive
      // belt-and-braces: when the bundle-sync IIFE's
      // `last_acl_repair_version` short-circuit suppresses its elevated
      // call -- which is exactly what caused B46-1 (ACL block decided
      // "already repaired this version" and skipped) -- we fire here
      // instead. When the bundle-sync IIFE DID try elevation, we trust its
      // result (success or UAC decline) and don't re-prompt.
      // No-op on steady-state launches (no version bump). No-op when the
      // autopilot scripts themselves aren't stale.
      const { shouldFireElevatedAutopilotSync } = await import('./taskMigrationVerify.js');
      if (
        !bundleElevatedSyncAttempted
        && shouldFireElevatedAutopilotSync({ isUpgrade, bundleNeedsElevatedCopy, bundleMismatches })
      ) {
        try {
          await runElevatedPowerShellScript<any>('Sync-ScriptsFromBundle.ps1', [
            '-SourceDir', bundledPsDir, '-Elevated', '-JsonOutput',
          ], { timeoutMs: 60_000 });
        } catch { /* declined / failed - migration will see stale bundle, retry next launch */ }
      }

      const args = ['-JsonOutput'];
      if (isUpgrade) {
        args.push('-ForceRecreate');
      }
      // v2.4.48 (B48-MIG-1a): on upgrade, Register-All-Tasks.ps1 MUST run
      // elevated. The /Delete /TN /F leg fails non-elevated against tasks
      // originally created elevated (root cause of Greg's box stuck at
      // last_task_migration_version='2.4.45' for two releases -- every
      // subsequent migration tried non-elevated, every /Delete returned
      // ERROR: Access is denied, /Create then collided with the still-present
      // task and reported `failed`, the `some()` predicate happened to find
      // the one row that succeeded, and the flag advanced anyway).
      //
      // UAC budget on upgrade:
      //  - Best case (1 prompt): bundle-sync IIFE did NOT already prompt
      //    (its `last_acl_repair_version` short-circuit suppressed the
      //    elevated copy), so this is the only elevation in the boot path.
      //  - Worst case (2 prompts): bundle-sync IIFE already prompted for
      //    its elevated Sync. We still need a second prompt because the
      //    sync/register pair cannot be merged after the fact -- the bundle
      //    is already on disk by the time we get here. Loud `console.warn`
      //    so the dual-prompt frequency is visible in main.log post-ship.
      //  - Steady-state launch (`isUpgrade === false`): no UAC, runs
      //    non-elevated without -ForceRecreate (existing tasks are queried
      //    via /Query, not deleted -- non-elevated is fine).
      //
      // E_UAC_CANCELLED on the elevated call leaves the migration flag
      // unwritten, so the next launch retries. Every other elevated-path
      // failure (E_ELEVATION_FAILED, E_TIMEOUT_KILLED) does the same -- we
      // catch and let the function fall through; the flag is written only
      // inside the `if (verifyAutopilotMigration(...))` guard below.
      type RegResult = import('./taskMigrationVerify.js').RegisterAllTasksResult;
      let result: RegResult;
      if (isUpgrade) {
        if (bundleElevatedSyncAttempted) {
          log.warn('[migration] dual UAC required (sync already attempted)');
        }
        log.info('[migration] elevated Register-All-Tasks.ps1 starting');
        try {
          result = await runElevatedPowerShellScript<RegResult>(
            'Register-All-Tasks.ps1', args, { timeoutMs: 120_000 },
          );
          log.info(`[migration] elevated Register-All-Tasks.ps1 returned (success=${(result as any)?.success}, results=${(result as any)?.results?.length ?? 'unknown'})`);
        } catch (err: any) {
          // Elevation declined / failed. Returns from THIS async IIFE
          // (not from app.whenReady's then-callback). Leaves the
          // migration flag unwritten so the next launch retries.
          log.warn(`[migration] elevated Register-All-Tasks.ps1 threw: code=${err?.code} message=${err?.message}`);
          return;
        }
      } else {
        log.info('[migration] non-elevated Register-All-Tasks.ps1 (steady-state, no -ForceRecreate)');
        result = await runPowerShellScript<RegResult>(
          'Register-All-Tasks.ps1', args, { timeoutMs: 60_000 },
        );
        log.info(`[migration] non-elevated Register-All-Tasks.ps1 returned (success=${(result as any)?.success})`);
      }
      if (isUpgrade) {
        // Verification (B45-4 self-heal): require at least one autopilot row
        // to be both `registered` and carry the dispatcher reference. If the
        // /XML path silently regresses again (or all 11 tasks fail), the
        // flag stays unwritten and the next launch retries with
        // -ForceRecreate. Predicate extracted to ./taskMigrationVerify.ts
        // for unit-test isolation.
        //
        // v2.4.47 (B46-1 belt-and-braces): also pass the bundled vs. deployed
        // sizes for Register-All-Tasks.ps1. If the elevated Sync above failed
        // (or was declined) and the deployed copy is still v2.4.45-stale, the
        // sizes will mismatch and verification fails -- exactly catches the
        // B46-1 silent-success-against-stale-script mode.
        const { verifyAutopilotMigration } = await import('./taskMigrationVerify.js');
        let sizes: { deployedSize?: number; bundledSize?: number } | undefined;
        try {
          const bundledRegister = path.join(bundledPsDir, 'Register-All-Tasks.ps1');
          // Sync-ScriptsFromBundle.ps1 copies bundled files into
          // C:\ProgramData\PCDoctor\ at their relative path; for top-level
          // scripts that means root, NOT a 'powershell' subdir.
          const deployedRegister = path.join('C:\\ProgramData\\PCDoctor', 'Register-All-Tasks.ps1');
          const [bundledStat, deployedStat] = await Promise.all([
            stat(bundledRegister).catch(() => null),
            stat(deployedRegister).catch(() => null),
          ]);
          if (bundledStat && deployedStat) {
            sizes = { bundledSize: bundledStat.size, deployedSize: deployedStat.size };
          }
        } catch { /* non-fatal: skip the size check on stat failure */ }

        const verified = verifyAutopilotMigration(result, sizes);
        log.info(`[migration] verifyAutopilotMigration returned ${verified} (sizes=${JSON.stringify(sizes)})`);
        if (verified) {
          try {
            setSetting('last_task_migration_version', TASK_MIGRATION_VERSION);
            log.info(`[migration] setSetting('last_task_migration_version', '${TASK_MIGRATION_VERSION}') succeeded`);
          } catch (err: any) {
            // v2.4.52 (B52-MIG-1): pre-2.4.52 this throw was silently
            // swallowed by the outer try/catch and the flag stayed at the
            // old value, leaving the migration to silently re-run + prompt
            // UAC on every launch. Surfacing the error finally lets us see
            // why on the next failure.
            log.error(`[migration] setSetting threw: code=${err?.code} message=${err?.message} stack=${err?.stack}`);
          }
        }
        // If !verified, deliberately do NOT write the flag -- next launch
        // will retry. This is the desired self-healing property.
      }
    } catch (err: any) {
      // v2.4.52 (B52-MIG-1): pre-2.4.52 this catch was a silent eraser.
      // Now it logs so a future investigation can find the failure point.
      // Still non-fatal — the migration block must never crash the app.
      log.error(`[migration] outer catch swallowed: code=${err?.code} message=${err?.message} stack=${err?.stack}`);
    }
  })();

  // v2.3.15 + v2.4.3: ACL self-healer. Two-phase:
  //   (1) Run non-elevated. If it finds files with readable ACEs but the
  //       empty "no ACEs" pattern, it repairs them directly.
  //   (2) If unreadable files remain (user can't even Get-Acl because the
  //       file has zero ACEs and no inherited read), it returns
  //       needs_elevation:true. Workbench then re-runs with -Elevated via
  //       the UAC-elevated path, which uses icacls to restore inheritance.
  //   (3) Remember the last repair_version so we don't spam UAC on every
  //       startup - only re-prompt when a new version ships.
  //
  // v2.4.6: BEFORE the ACL repair, run Sync-ScriptsFromBundle.ps1 to
  // detect missing / size-mismatched scripts (root cause of the v2.4.4/5
  // stale-deploy cascade). If any mismatches show up, we reuse the same
  // once-per-upgrade UAC prompt to copy them from the bundle.
  //
  // v2.4.46 (B45-1): split into two IIFEs so the task-migration block
  // (above) can await `bundleSyncPromise` -- it resolves as soon as the
  // Sync-ScriptsFromBundle leg has finished (probe + optional elevated
  // copy), independent of the slower ACL repair leg. This guarantees the
  // newly-bumped Run-AutopilotScheduled.ps1 + Register-All-Tasks.ps1 are
  // on disk before Register-All-Tasks.ps1 fires. The Promise + resolver
  // are declared at the top of app.whenReady (above) so the migration
  // IIFE can synchronously reference `bundleSyncPromise` without hitting
  // TDZ.

  // Bundle-sync IIFE -- probe + (optionally) elevated copy. resolveBundleSync()
  // fires regardless of outcome (elevated decline / probe error / success)
  // so the migration block isn't blocked indefinitely.
  (async () => {
    try {
      const { runPowerShellScript, runElevatedPowerShellScript } = await import('./scriptRunner.js');
      try {
        const syncResult = await runPowerShellScript<any>('Sync-ScriptsFromBundle.ps1', [
          '-SourceDir', bundledPsDir, '-JsonOutput',
        ], { timeoutMs: 20_000 });
        bundleNeedsElevatedCopy = !!syncResult?.needs_elevation;
        // v2.4.47 (B46-1): capture the per-file mismatch list so the migration
        // block can decide whether the autopilot dispatcher / Register script
        // are actually stale on disk. The script returns an array of objects
        // shaped { rel, src, dst, cause } per Sync-ScriptsFromBundle.ps1.
        if (Array.isArray(syncResult?.mismatches)) {
          bundleMismatches = syncResult.mismatches
            .map((m: any) => (typeof m?.rel === 'string' ? m.rel : null))
            .filter((s: string | null): s is string => !!s);
        }
      } catch { /* probe failed -- we'll fall through; ACL leg still runs */ }

      if (bundleNeedsElevatedCopy) {
        // Need to wait for the user's UAC decision; only THEN can we say
        // the on-disk bundle reflects the new version. Wrap in try/catch
        // so a UAC decline still resolves the promise.
        const { getSetting } = await import('./dataStore.js');
        const lastRepair = getSetting('last_acl_repair_version');
        const thisVersion = app.getVersion();
        if (lastRepair !== thisVersion) {
          // v2.4.47 (B46-1): mark the attempt regardless of UAC outcome so
          // the migration IIFE doesn't re-prompt for the same operation.
          bundleElevatedSyncAttempted = true;
          try {
            await runElevatedPowerShellScript<any>('Sync-ScriptsFromBundle.ps1', [
              '-SourceDir', bundledPsDir, '-Elevated', '-JsonOutput',
            ], { timeoutMs: 60_000 });
          } catch { /* declined / failed - migration block will see stale bundle, retry next launch */ }
        }
      }
    } finally {
      resolveBundleSync();
    }
  })();

  // ACL repair IIFE (separate from bundle sync to keep migration unblocked).
  (async () => {
    try {
      // Wait for the bundle sync to finish first so any newly-copied scripts
      // can have their ACLs inspected (zero-ACE files can't be opened by
      // the non-elevated probe).
      await bundleSyncPromise;

      const { runPowerShellScript, runElevatedPowerShellScript } = await import('./scriptRunner.js');
      const { getSetting, setSetting } = await import('./dataStore.js');
      const thisVersion = app.getVersion();
      const lastRepair = getSetting('last_acl_repair_version');
      log.info(`[acl] block start lastRepair=${JSON.stringify(lastRepair)} thisVersion=${thisVersion} bundleNeedsElevatedCopy=${bundleNeedsElevatedCopy}`);

      const aclResult = await runPowerShellScript<any>('Repair-ScriptAcls.ps1', ['-JsonOutput'], { timeoutMs: 30_000 });
      const aclNeedsElevation = !!aclResult?.needs_elevation;
      log.info(`[acl] aclNeedsElevation=${aclNeedsElevation}`);

      if ((bundleNeedsElevatedCopy || aclNeedsElevation) && lastRepair !== thisVersion) {
        try {
          if (aclNeedsElevation) {
            log.info('[acl] elevated Repair-ScriptAcls.ps1 starting');
            await runElevatedPowerShellScript<any>('Repair-ScriptAcls.ps1', ['-JsonOutput', '-Elevated'], { timeoutMs: 60_000 });
            log.info('[acl] elevated Repair-ScriptAcls.ps1 returned');
          }
          // v2.4.10: only mark this version repaired if the elevation chain
          // actually completed.
          setSetting('last_acl_repair_version', thisVersion);
          log.info(`[acl] setSetting('last_acl_repair_version', '${thisVersion}') succeeded (post-elevation path)`);
        } catch (err: any) {
          log.warn(`[acl] elevation/setSetting threw: code=${err?.code} message=${err?.message}`);
        }
      } else {
        try {
          setSetting('last_acl_repair_version', thisVersion);
          log.info(`[acl] setSetting('last_acl_repair_version', '${thisVersion}') succeeded (no-elevation path)`);
        } catch (err: any) {
          // v2.4.52 (B52-MIG-1): pre-2.4.52 the outer catch ate this. Log it.
          log.error(`[acl] setSetting threw: code=${err?.code} message=${err?.message} stack=${err?.stack}`);
        }
      }
    } catch (err: any) {
      // v2.4.52 (B52-MIG-1): the outer catch is no longer silent.
      log.error(`[acl] outer catch swallowed: code=${err?.code} message=${err?.message} stack=${err?.stack}`);
    }
  })();

  // v2.4.9: runtime ACL self-heal. Belt-and-suspenders on top of the
  // installer's fixed ACL phase (installer.nsh → Apply-TieredAcl.ps1)
  // and the pre-ship gate (scripts/test-installer-acl.ps1).
  //
  // Detects ACL breakage at startup by probing `reports/latest.json`:
  //   - EPERM / EACCES → ACLs corrupted, invoke elevated Heal-InstallAcls.ps1
  //   - ENOENT         → fresh install with no scan yet, skip
  //   - OK             → healthy, skip
  //
  // The heal runs the same sequence as installer steps 2-7 (takeown +
  // /reset + Apply-TieredAcl per subdir). One UAC prompt if the heal
  // needs to fire. Non-fatal on failure — user gets the EPERM UI error
  // and can run the hotfix manually.
  //
  // Why this exists: v2.4.6/7/8 all shipped with installer ACL bugs that
  // left files unreadable. Having a runtime self-heal means future
  // regressions — or external causes like malware, manual icacls misuse,
  // Windows Update side-effects — don't require a manual hotfix.
  (async () => {
    try {
      const { PCDOCTOR_ROOT } = await import('./constants.js');
      const latestJsonPath = path.join(PCDOCTOR_ROOT, 'reports', 'latest.json');

      let needsHeal = false;
      try {
        await access(latestJsonPath, fsConstants.R_OK);
      } catch (e: any) {
        // EPERM / EACCES / EBUSY = ACL breakage. ENOENT = no scan yet (fine).
        if (e?.code && e.code !== 'ENOENT') {
          needsHeal = true;
        }
      }

      if (needsHeal) {
        console.log('[self-heal] ACL breakage detected on reports/latest.json, invoking Heal-InstallAcls.ps1 elevated');
        try {
          const { runElevatedPowerShellScript } = await import('./scriptRunner.js');
          // 3-minute budget. Typical heal is ~30-60s: takeown /r on ~1000
          // files (~15s) + icacls /reset /T (~10s) + per-subdir
          // Apply-TieredAcl calls (~3-5s each, 9 subdirs = ~45s). 180s is
          // ~2x headroom for slow disks, AV interference, large trees.
          const HEAL_TIMEOUT_MS = 180_000;
          const result = await runElevatedPowerShellScript<any>('Heal-InstallAcls.ps1', ['-JsonOutput'], {
            timeoutMs: HEAL_TIMEOUT_MS,
          });
          console.log('[self-heal] result:', result?.message ?? 'ok');
          // Refresh the window so the dashboard picks up the now-readable file.
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.reload();
          }
        } catch (err: any) {
          console.warn('[self-heal] Heal-InstallAcls.ps1 failed:', err?.message ?? err);
        }
      }
    } catch { /* non-fatal */ }
  })();

  // v2.3.0 first-run self-test: fires once per major version, only if Telegram
  // is configured. Also bumps the selftest_version marker so 2.3.0 installs
  // ping the channel to confirm tokens still work after the upgrade.
  (async () => {
    try {
      const { getSetting, setSetting } = await import('./dataStore.js');
      const lastSelftest = getSetting('last_selftest_version');
      if (lastSelftest !== '2.3.0') {
        const rawToken = getSetting('telegram_bot_token');
        if (rawToken) {
          const { sendTelegramMessage, makeCallbackData } = await import('./telegramBridge.js');
          const r = await sendTelegramMessage(
            '✅ <b>PCDoctor Workbench 2.3.0 installed</b>\n\n' +
            'New: Autopilot rule editor, batch startup picker, RAM pressure panel.\n' +
            'Tap a button below to verify this channel still works.',
            [[
              { text: '✓ Working — dismiss', callback_data: makeCallbackData('selftest_confirm') },
              { text: '🔧 Open Dashboard', callback_data: makeCallbackData('selftest_dashboard') },
            ]],
          );
          if (!r.ok) {
            // Surface dashboard banner via a stored setting — the renderer can poll this
            setSetting('selftest_banner', `⚠ Telegram self-test failed: ${r.error ?? 'unknown error'}. Re-test from Settings > Notifications.`);
          }
          // Mark regardless of success so we don't spam on subsequent launches
          setSetting('last_selftest_version', '2.3.0');
        } else {
          // No Telegram configured — still stamp so we don't check every launch.
          setSetting('last_selftest_version', '2.3.0');
        }
      }
    } catch { /* non-fatal — never block startup */ }
  })();

  createWindow();
  createTray({
    getWindow: () => mainWindow,
    onQuit: async () => {
      (app as any).isQuitting = true;
      if (pollTimer) clearInterval(pollTimer);
      stopTelegramPolling();
      stopAutopilotEngine();
      // v2.4.45 (code-reviewer W3): await the ingestor's in-flight drain
      // so timer-triggered ingestOnce() can't touch better-sqlite3 after
      // the app process starts tearing down. Bounded -- the drain is
      // sub-second on healthy disks and the whole ingestOnce already
      // swallows internal errors.
      await stopAutopilotLogIngestor();
      killAllPtySessions();
      app.quit();
    },
  });

  try { registerPtyIpc(() => mainWindow); } catch (e) { console.error('pty init failed', e); }

  // Auto-updater - init + check on startup + every 6 hours
  if (app.isPackaged) {
    initAutoUpdater(() => mainWindow);
    setTimeout(() => { checkForUpdates().catch(() => {}); }, 30_000);
    setInterval(() => { checkForUpdates().catch(() => {}); }, 6 * 60 * 60 * 1000);
  }

  backgroundPoll();
  pollTimer = setInterval(backgroundPoll, POLL_INTERVAL_MS);

  // Start Telegram callback polling
  startClaudeBridgeWatcher(() => mainWindow);
  startAutopilotEngine();
  // v2.4.45: tail autopilot-scheduled-YYYYMMDD.log into autopilot_activity.
  startAutopilotLogIngestor();

  startTelegramPolling(async (q) => {
    if (!q.data) { await answerCallbackQuery(q.id, 'Invalid request'); return; }
    const parts = q.data.split('|');
    const kind = parts[0];

    if (kind === 'selftest_confirm') {
      const { setSetting } = await import('./dataStore.js');
      setSetting('last_selftest_version', '2.3.0');
      setSetting('selftest_banner', '');  // clear any failure banner
      await answerCallbackQuery(q.id, '✅ Confirmed');
      if (q.message) {
        await editMessageText(q.message.chat.id, q.message.message_id,
          '✅ Confirmed. Autopilot alerts will appear here.');
      }
      return;
    }

    if (kind === 'selftest_dashboard') {
      await answerCallbackQuery(q.id, '🔧 Open PCDoctor Workbench on your PC to view the Dashboard.');
      if (q.message) {
        await editMessageText(q.message.chat.id, q.message.message_id,
          '🔧 Open <b>PCDoctor Workbench</b> on your PC to view the Dashboard.\n\n' +
          'The app lives in your system tray (bottom-right). Click it to open.');
      }
      return;
    }

    if (kind === 'tgtest_ok') {
      // Callback for api:sendTelegramTestFull "✓ Received" button
      const { setSetting } = await import('./dataStore.js');
      setSetting('telegram_last_good_ts', String(Date.now()));
      await answerCallbackQuery(q.id, '✅ Telegram verified');
      if (q.message) {
        await editMessageText(q.message.chat.id, q.message.message_id, '✅ Telegram verified.');
      }
      return;
    }

    if (kind === 'tgtest_fail') {
      // Callback for api:sendTelegramTestFull "❌ Buttons don't work" button
      const { startActionLog, finishActionLog } = await import('./dataStore.js');
      const logId = startActionLog({
        action_name: 'telegram_test' as any,
        action_label: 'Telegram full round-trip test',
        status: 'running',
        triggered_by: 'user',
      });
      finishActionLog(logId, {
        status: 'error',
        duration_ms: 0,
        result: { telegram_callback_failed: true },
        error_message: 'User reported button callback failure',
      });
      await answerCallbackQuery(q.id, '⚠ Recorded — check dashboard');
      if (q.message) {
        await editMessageText(q.message.chat.id, q.message.message_id,
          '⚠ Failure recorded. Check Settings > Notifications in PCDoctor Workbench.');
      }
      return;
    }

    if (kind === 'dismiss') {
      await answerCallbackQuery(q.id, '✓ Dismissed');
      if (q.message) {
        await editMessageText(q.message.chat.id, q.message.message_id, '✖ <i>Dismissed from Telegram</i>');
      }
      return;
    }

    // ---- Autopilot inline keyboard callbacks (v2.2.0) ----

    if (kind === 'autopilot') {
      const actionName = parts[1] as ActionName;
      const ruleId = parts[2] ?? '';
      const def = ACTIONS[actionName];
      if (!def) { await answerCallbackQuery(q.id, 'Unknown action'); return; }
      await answerCallbackQuery(q.id, `Running ${def.label}…`);
      try {
        const result = await runAction({ name: actionName, triggered_by: 'telegram' });
        insertAutopilotActivity({
          rule_id: ruleId || `manual:${actionName}`,
          tier: 3,
          action_name: actionName,
          outcome: result.success ? 'auto_run' : 'error',
          duration_ms: result.duration_ms,
          message: result.success ? 'ran from Telegram button' : (result.error?.message ?? 'error'),
        });
        const bytes = (result.result as any)?.bytes_freed;
        const bytesTxt = typeof bytes === 'number' ? ` (${(bytes / 1024 / 1024).toFixed(1)} MB freed)` : '';
        const msg = result.success
          ? `✓ <b>${def.label}</b> completed${bytesTxt}`
          : `✗ <b>${def.label}</b> failed: ${result.error?.message ?? 'unknown'}`;
        if (q.message) {
          await editMessageText(q.message.chat.id, q.message.message_id, msg);
        }
      } catch (e: any) {
        if (q.message) {
          await editMessageText(q.message.chat.id, q.message.message_id, `✗ Error: ${e?.message ?? 'unknown'}`);
        }
      }
      return;
    }

    if (kind === 'ap_snooze') {
      const ruleId = parts[1] ?? '';
      const until = Date.now() + 24 * 60 * 60 * 1000;
      suppressAutopilotRule(ruleId, until);
      insertAutopilotActivity({
        rule_id: ruleId,
        tier: 3,
        outcome: 'suppressed',
        message: 'snoozed 24h from Telegram',
      });
      await answerCallbackQuery(q.id, '⏸ Snoozed 24h');
      if (q.message) {
        await editMessageText(q.message.chat.id, q.message.message_id, '⏸ <i>Snoozed 24h</i>');
      }
      return;
    }

    if (kind === 'ap_dismiss') {
      const ruleId = parts[1] ?? '';
      insertAutopilotActivity({
        rule_id: ruleId,
        tier: 3,
        outcome: 'suppressed',
        message: 'dismissed from Telegram',
      });
      await answerCallbackQuery(q.id, '✓ Dismissed');
      if (q.message) {
        await editMessageText(q.message.chat.id, q.message.message_id, '✓ <i>Dismissed</i>');
      }
      return;
    }

    if (kind === 'act') {
      const actionName = parts[1] as ActionName;
      const findingHash = parts[2];
      const def = ACTIONS[actionName];
      if (!def) { await answerCallbackQuery(q.id, 'Unknown action'); return; }
      if (def.confirm_level === 'destructive') {
        // Send a confirmation message rather than executing
        await answerCallbackQuery(q.id, '⚠ Destructive - confirm required');
        if (q.message) {
          const { sendTelegramMessage, makeCallbackData } = await import('./telegramBridge.js');
          await sendTelegramMessage(
            `⚠️ <b>Confirm destructive action</b>\n\n<b>${def.label}</b>\n${def.tooltip}\n\n` +
            `Rollback: Tier ${def.rollback_tier}\n` +
            `Tap <b>Confirm</b> below to proceed, or Cancel to skip.`,
            [[
              { text: `✓ Confirm ${def.label}`, callback_data: makeCallbackData('act_confirmed', actionName, findingHash) },
              { text: '✖ Cancel', callback_data: makeCallbackData('dismiss', findingHash) },
            ]]
          );
        }
        return;
      }
      await answerCallbackQuery(q.id, `Running ${def.label}…`);
      try {
        const result = await runAction({ name: actionName, triggered_by: 'telegram' });
        const msg = result.success
          ? `✓ <b>${def.label}</b> completed in ${result.duration_ms}ms`
          : `✗ <b>${def.label}</b> failed: ${result.error?.message ?? 'unknown'}`;
        if (q.message) {
          await editMessageText(q.message.chat.id, q.message.message_id, msg);
        }
      } catch (e: any) {
        if (q.message) {
          await editMessageText(q.message.chat.id, q.message.message_id, `✗ Error: ${e?.message ?? 'unknown'}`);
        }
      }
      return;
    }

    // (autopilot handlers continued — act_confirmed below is pre-existing)

    if (kind === 'act_confirmed') {
      const actionName = parts[1] as ActionName;
      const def = ACTIONS[actionName];
      if (!def) { await answerCallbackQuery(q.id, 'Unknown action'); return; }
      await answerCallbackQuery(q.id, `Running ${def.label}…`);
      try {
        const result = await runAction({ name: actionName, triggered_by: 'telegram' });
        const msg = result.success
          ? `✓ <b>${def.label}</b> completed in ${result.duration_ms}ms`
          : `✗ <b>${def.label}</b> failed: ${result.error?.message ?? 'unknown'}`;
        if (q.message) {
          await editMessageText(q.message.chat.id, q.message.message_id, msg);
        }
      } catch (e: any) {
        if (q.message) {
          await editMessageText(q.message.chat.id, q.message.message_id, `✗ Error: ${e?.message ?? 'unknown'}`);
        }
      }
      return;
    }
  }, async (m) => {
    // Text message handler — we only care about /status (and its aliases).
    if (!m.text) return;
    const cmd = m.text.trim().toLowerCase();
    if (cmd === '/status' || cmd === 'status') {
      try {
        const s = await getStatus();
        const activity = getAutopilotActivity(7);
        const autoRuns = activity.filter(a => a.outcome === 'auto_run').length;
        const alerts = activity.filter(a => a.outcome === 'alerted').length;
        const bytesFreed = activity.reduce((sum, a) => sum + (a.bytes_freed ?? 0), 0);
        const critCount = s.findings.filter(f => f.severity === 'critical').length;
        const warnCount = s.findings.filter(f => f.severity === 'warning').length;
        const reply =
          `<b>PCDoctor status — ${s.host}</b>\n` +
          `Overall: <b>${s.overall_label}</b> (${s.overall_severity})\n` +
          `Findings: ${critCount} crit · ${warnCount} warn\n\n` +
          `<b>Autopilot (7d):</b>\n` +
          `• Auto-runs: ${autoRuns}\n` +
          `• Alerts: ${alerts}\n` +
          `• Freed: ${(bytesFreed / 1024 / 1024).toFixed(1)} MB\n` +
          `\nGenerated ${new Date(s.generated_at * 1000).toLocaleString()}`;
        await sendTelegramMessage(reply);
      } catch (e: any) {
        await sendTelegramMessage(`⚠ Status unavailable: ${e?.message ?? 'unknown'}`);
      }
    }
  });

  // Morning digest flush timer - runs every minute, triggers when hour matches digest_hour
  let lastFlushHour = -1;
  setInterval(async () => {
    const now = new Date();
    const hour = now.getHours();
    const digestHour = getDigestHour();
    if (hour === digestHour && lastFlushHour !== hour) {
      lastFlushHour = hour;
      try { await flushBufferedNotifications(); } catch {}
    }
    // Reset at next day
    if (hour !== digestHour) lastFlushHour = -1;
  }, 60_000);
});

app.on('window-all-closed', () => {
  // Don't quit - tray keeps app alive.
});

app.on('second-instance', () => {
  mainWindow?.show();
  mainWindow?.focus();
});
