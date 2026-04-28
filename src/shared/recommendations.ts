import type { ActionName, SystemStatus, SecurityPosture } from './types.js';

export type RecommendationLevel = 'recommended' | 'consider' | 'skip' | 'blocked';

export interface ActionRecommendation {
  level: RecommendationLevel;
  reason: string;
  priority?: number; // 1 (highest) .. 10 (lowest); meaningful when level='recommended'
}

/**
 * Pure helper — caller provides last-run timestamps via this interface so this
 * module never imports dataStore directly and stays renderer-safe.
 */
export interface LastRunFetcher {
  /** Returns unix seconds of most recent successful run, or null if never run. */
  getLastRun(action: ActionName): number | null;
}

const DAY_S = 86_400;

// v2.4.52 (B52-LOW-1): defensive numeric coercion. Pre-2.4.52 these helpers
// only special-cased `null` — a value of NaN, undefined, '0' (string), or
// a millisecond-scale number from a buggy ingestor would still pass the
// guard and produce an absurd number of "days ago" downstream (e.g.
// `Math.floor((1700000000 - 1700000000000) / 86400)` yields a huge
// negative). The Codex audit flagged the Defender-scan fields specifically;
// applying the same `Number.isFinite` guard here keeps every caller safe
// without a per-callsite refactor.
function daysSince(unixSeconds: number | null | undefined, nowS: number): number | null {
  if (typeof unixSeconds !== 'number' || !Number.isFinite(unixSeconds)) return null;
  return Math.floor((nowS - unixSeconds) / DAY_S);
}

function hoursSince(unixSeconds: number | null | undefined, nowS: number): number | null {
  if (typeof unixSeconds !== 'number' || !Number.isFinite(unixSeconds)) return null;
  return Math.floor((nowS - unixSeconds) / 3600);
}

export interface SystemExtras {
  /** True when .wslconfig already contains a memory= directive */
  wslconfig_has_memory_cap?: boolean;
  /** vmmemWSL working set as a % of the configured cap (0-100) */
  vmmem_wsl_utilization_pct?: number;
}

/**
 * Returns a recommendation verdict for `action` given the current system
 * state.  Pass `null` for either status or security if the data is not yet
 * loaded; the function degrades gracefully to 'consider'.
 */
export function recommendAction(
  action: ActionName,
  status: SystemStatus | null,
  security: SecurityPosture | null,
  getLastRun?: LastRunFetcher['getLastRun'],
  systemExtras?: SystemExtras,
): ActionRecommendation {
  const nowS = Math.floor(Date.now() / 1000);
  const lastRun = getLastRun ? getLastRun(action) : null;

  // Helper: free % on disk C — KpiValue has no metric field, so match by label
  const cFree = status?.kpis.find(k =>
      k.label?.toLowerCase().includes('disk c') ||
      k.label?.toLowerCase().includes('c: free') ||
      k.label?.toLowerCase().includes('c free')
    )?.value
    ?? status?.gauges.find(g =>
      g.label?.toLowerCase().includes('disk c') ||
      g.label?.toLowerCase().includes('c: free') ||
      g.label?.toLowerCase().includes('c free')
    )?.value
    ?? null;

  switch (action) {
    // ---- Deep Clean ----

    case 'clear_browser_caches': {
      const daysSinceLast = daysSince(lastRun, nowS);
      if (daysSinceLast !== null && daysSinceLast < 14) {
        return { level: 'skip', reason: `Ran ${daysSinceLast}d ago — nothing to gain yet.` };
      }
      if (cFree !== null && cFree < 20) {
        return { level: 'recommended', reason: `C: drive is ${cFree.toFixed(0)}% free — clearing browser caches can reclaim 500 MB–2 GB.`, priority: 2 };
      }
      if (daysSinceLast !== null && daysSinceLast > 30) {
        return { level: 'recommended', reason: `Last run ${daysSinceLast}d ago — browser caches have accumulated.`, priority: 4 };
      }
      if (daysSinceLast === null) {
        return { level: 'consider', reason: 'Never run — browser caches may have accumulated.' };
      }
      return { level: 'consider', reason: `Last run ${daysSinceLast}d ago — optional cleanup.` };
    }

    case 'shrink_component_store': {
      const pendingReboot = security?.windows_update?.reboot_pending ?? false;
      if (pendingReboot) {
        return { level: 'blocked', reason: 'Pending reboot detected — complete it before shrinking the component store.' };
      }
      if (cFree !== null && cFree < 15) {
        return { level: 'recommended', reason: `C: drive only ${cFree.toFixed(0)}% free — WinSxS shrink can reclaim 5–15 GB.`, priority: 1 };
      }
      return { level: 'consider', reason: 'C: drive has adequate space — run only if you need to free significant space.' };
    }

    case 'remove_feature_update_leftovers': {
      // Check for Windows.~BT / Windows.~WS in findings
      const hasLeftovers = status?.findings.some(f =>
        f.message?.toLowerCase().includes('windows.~bt') ||
        f.message?.toLowerCase().includes('windows.~ws') ||
        f.message?.toLowerCase().includes('feature update leftover') ||
        f.area?.toLowerCase().includes('disk')
      ) ?? false;
      if (hasLeftovers) {
        return { level: 'recommended', reason: 'Feature-update leftover folders detected — typically 10–30 GB recoverable.', priority: 2 };
      }
      if (cFree !== null && cFree < 15) {
        return { level: 'consider', reason: `C: drive is ${cFree.toFixed(0)}% free — worth checking for leftover update folders.` };
      }
      return { level: 'skip', reason: 'No leftover update folders detected in current scan.' };
    }

    case 'empty_recycle_bins': {
      const daysSinceLast = daysSince(lastRun, nowS);
      if (daysSinceLast !== null && daysSinceLast < 7) {
        return { level: 'skip', reason: `Emptied ${daysSinceLast}d ago — weekly cadence is sufficient.` };
      }
      if (daysSinceLast === null || daysSinceLast >= 7) {
        return { level: 'recommended', reason: daysSinceLast === null ? 'Never emptied — Recycle Bins may hold stale files.' : `Last emptied ${daysSinceLast}d ago — weekly cleanup recommended.`, priority: 5 };
      }
      return { level: 'consider', reason: 'Consider emptying on a weekly schedule.' };
    }

    // ---- Harden ----

    case 'enable_pua_protection': {
      const pua = security?.defender?.puaprotection;
      const tamperOn = security?.defender?.tamper_protection === true;
      const unknown = !pua || pua === '';
      // v2.4.6: Get-MpPreference returns empty strings for PUAProtection /
      // EnableControlledFolderAccess / EnableNetworkProtection when run
      // non-elevated AND Tamper Protection is on (post-22H2 behavior). We
      // have no way to tell "off" from "unreadable" in that case, so don't
      // scare-recommend enabling something that may already be enabled.
      if (unknown && tamperOn) {
        return { level: 'skip', reason: 'PUA state cannot be read without elevation while Tamper Protection is on. Use "Verify Security State" in Settings if you need to confirm.' };
      }
      if (unknown || pua.toLowerCase() === 'disabled' || pua === '0') {
        return { level: 'recommended', reason: 'PUA protection is off — blocks bundled crapware and shady installers with no downside.', priority: 3 };
      }
      return { level: 'skip', reason: `PUA protection is already ${pua}.` };
    }

    case 'enable_controlled_folder_access': {
      const cfa = security?.defender?.controlled_folder_access;
      const tamperOn = security?.defender?.tamper_protection === true;
      const unknown = !cfa || cfa === '';
      // v2.4.6: same unreadable-under-Tamper caveat as PUA.
      if (unknown && tamperOn) {
        return { level: 'skip', reason: 'CFA state cannot be read without elevation while Tamper Protection is on.' };
      }
      if (cfa && cfa.toLowerCase() !== 'disabled' && cfa !== '0' && cfa !== '') {
        // v2.4.7 (E-6): stringify raw registry value. "1" / "enabled" / "block"
        // → "enabled"; "2" / "audit" → "in audit mode"; anything else shows
        // the raw value so it's still diagnosable.
        const lc = cfa.toLowerCase();
        const label = (lc === '1' || lc === 'enabled' || lc === 'block')
          ? 'enabled'
          : (lc === 'audit' || lc === '2')
            ? 'in audit mode'
            : cfa;
        return { level: 'skip', reason: `Controlled Folder Access is already ${label}.` };
      }
      // Always 'consider', never 'recommended' — can break legitimate apps
      return { level: 'consider', reason: 'Anti-ransomware protection — enable if you can allowlist apps that get blocked.' };
    }

    case 'update_hosts_stevenblack': {
      const daysSinceLast = daysSince(lastRun, nowS);
      if (daysSinceLast !== null && daysSinceLast < 25) {
        return { level: 'skip', reason: `Updated ${daysSinceLast}d ago — monthly cadence is sufficient.` };
      }
      if (daysSinceLast === null || daysSinceLast >= 30) {
        return { level: 'recommended', reason: daysSinceLast === null ? 'Never applied — StevenBlack hosts blocks ads, trackers, and malware domains.' : `Last updated ${daysSinceLast}d ago — monthly refresh recommended.`, priority: 4 };
      }
      return { level: 'consider', reason: `Updated ${daysSinceLast}d ago — refresh when it hits 30 days.` };
    }

    case 'defender_full_scan': {
      const lastScanDays = security?.defender?.last_full_scan_days ?? null;
      if (lastScanDays !== null && lastScanDays < 14) {
        return { level: 'skip', reason: `Full scan ran ${lastScanDays}d ago — not needed yet.` };
      }
      if (lastScanDays === null || lastScanDays > 30) {
        return { level: 'recommended', reason: lastScanDays === null ? 'No full scan on record — schedule one soon.' : `Full scan last ran ${lastScanDays}d ago — monthly scan recommended.`, priority: 3 };
      }
      return { level: 'consider', reason: `Full scan ran ${lastScanDays}d ago — consider running soon.` };
    }

    case 'defender_quick_scan': {
      const lastQuickHours = security?.defender?.last_quick_scan_hours ?? null;
      if (lastQuickHours !== null && lastQuickHours <= 48) {
        return { level: 'skip', reason: `Quick scan ran ${lastQuickHours}h ago — nothing to do.` };
      }
      return { level: 'recommended', reason: lastQuickHours === null ? 'No quick scan on record.' : `Quick scan ran ${lastQuickHours}h ago — 48h cadence recommended.`, priority: 2 };
    }

    // ---- Quick Actions ----

    case 'apply_wsl_cap': {
      if (!status) return { level: 'consider', reason: 'WSL cap may already be applied — verify in Settings or close heavy processes first.' };

      // v2.3.0 B4: prefer the real scanner signal (status.metrics.wsl_config)
      // when present; fall back to the legacy systemExtras passthrough for
      // tests that still use that path.
      const wsl = status.metrics?.wsl_config;
      if (wsl?.has_memory_cap && (wsl.vmmem_utilization_pct ?? 0) < 80) {
        const util = wsl.vmmem_utilization_pct ?? 0;
        return {
          level: 'skip',
          reason: `WSL already capped at ${wsl.memory_gb}GB and using ${util.toFixed(0)}% of cap. RAM pressure is from other processes — close extra Claude Code / Chrome windows instead.`,
        };
      }

      // Legacy systemExtras path (kept for back-compat tests)
      const hasCap = systemExtras?.wslconfig_has_memory_cap;
      const vmmemUtil = systemExtras?.vmmem_wsl_utilization_pct ?? null;
      if (hasCap !== undefined) {
        if (hasCap && (vmmemUtil === null || vmmemUtil < 80)) {
          const utilStr = vmmemUtil !== null ? `${vmmemUtil.toFixed(0)}%` : 'N/A';
          return {
            level: 'skip',
            reason: `WSL already capped at 8GB and using ${utilStr} of cap. RAM pressure is from other processes — close extra Claude Code / Chrome windows instead.`,
          };
        }
        if (!hasCap) {
          // Cap not applied at all — fall through to regular logic below
        }
      }

      const ramKpi = status.kpis.find(k => k.label?.toLowerCase().includes('ram') && k.unit === '%');
      const ramPct = ramKpi?.value ?? null;
      // Detect WSL/vmmem via findings (findings may carry area 'WSL' or 'Memory' with vmmem reference)
      const wslActive = status.findings.some(f =>
        f.area?.toLowerCase().includes('wsl') ||
        f.message?.toLowerCase().includes('wsl') ||
        f.message?.toLowerCase().includes('vmmem')
      );
      // No WSL distros installed heuristic: if NAS/services don't show WSL and no finding, skip
      if (!wslActive && (ramPct === null || ramPct <= 75)) {
        return { level: 'skip', reason: 'No WSL activity detected and RAM is healthy.' };
      }
      // Priority 1: RAM > 85% AND vmmem/WSL signal present
      if (ramPct !== null && ramPct > 85 && wslActive) {
        return { level: 'recommended', reason: `RAM at ${ramPct.toFixed(0)}% with WSL active — apply memory cap immediately to prevent exhaustion.`, priority: 1 };
      }
      // Priority 4: RAM > 75% with WSL active
      if (ramPct !== null && ramPct > 75 && wslActive) {
        return { level: 'recommended', reason: `RAM at ${ramPct.toFixed(0)}% with WSL running — cap WSL to protect system headroom.`, priority: 4 };
      }
      if (wslActive) {
        return { level: 'consider', reason: 'WSL cap may already be applied — verify in Settings or close heavy processes first.' };
      }
      return { level: 'consider', reason: 'Apply if WSL is consuming excessive RAM.' };
    }

    case 'rebuild_search_index': {
      const daysSinceLast = daysSince(lastRun, nowS);
      // Skip if run recently (< 30 days)
      if (daysSinceLast !== null && daysSinceLast < 30) {
        return { level: 'skip', reason: `Rebuilt ${daysSinceLast}d ago — index is fresh.` };
      }
      const searchFinding = status?.findings.some(f =>
        f.area?.toLowerCase().includes('search') ||
        f.message?.toLowerCase().includes('search index')
      ) ?? false;
      if (searchFinding) {
        return { level: 'recommended', reason: 'Search index issue detected — rebuild to restore reliable results. Note: action requires elevated Workbench (admin).', priority: 2 };
      }
      return { level: 'consider', reason: 'Rebuild only if Windows Search is returning stale or missing results. Note: action requires elevated Workbench (admin).' };
    }

    case 'fix_shell_overlays': {
      // Look for overlay count in findings detail
      const overlayFinding = status?.findings.find(f =>
        f.area?.toLowerCase().includes('overlay') ||
        f.message?.toLowerCase().includes('overlay')
      );
      if (overlayFinding) {
        const detail = overlayFinding.detail as Record<string, unknown> | undefined;
        const count = typeof detail?.count === 'number' ? detail.count : null;
        if (count !== null && count > 20) {
          return { level: 'recommended', reason: `${count} shell overlay handlers registered — Windows only uses 15, causing Explorer slowdowns.`, priority: 3 };
        }
        return { level: 'recommended', reason: 'Excess shell overlays detected — fix to improve File Explorer speed.', priority: 4 };
      }
      return { level: 'consider', reason: 'Run if File Explorer feels sluggish or overlay icons are wrong.' };
    }

    case 'run_sfc': {
      const daysSinceLast = daysSince(lastRun, nowS);
      const pendingReboot = security?.windows_update?.reboot_pending ?? false;
      if (pendingReboot) {
        return { level: 'blocked', reason: 'Reboot the pending changes first or SFC can fail mid-way.' };
      }
      const stabilityFinding = status?.findings.some(f =>
        f.area?.toLowerCase().includes('stability') ||
        f.message?.toLowerCase().includes('bsod') ||
        f.message?.toLowerCase().includes('blue screen')
      ) ?? false;
      // v2.4.3: if SFC already ran recently, stop telling the user to re-run
      // it every time they open the app. A clean SFC is proof that file
      // corruption is NOT the cause; the stability finding is then
      // pointing at drivers / thermal / hardware, not system files.
      if (stabilityFinding && daysSinceLast !== null && daysSinceLast < 7) {
        return {
          level: 'skip',
          reason: `SFC ran ${daysSinceLast}d ago — file corruption ruled out. Stability issues are likely driver/thermal/hardware, not system files.`,
        };
      }
      if (stabilityFinding) {
        return { level: 'recommended', reason: 'Stability issue detected (possible BSOD signal) — run SFC to check for corrupt system files.', priority: 2 };
      }
      if (daysSinceLast !== null && daysSinceLast < 14) {
        return { level: 'skip', reason: `SFC ran ${daysSinceLast}d ago — quarterly cadence is fine.` };
      }
      if (daysSinceLast === null || daysSinceLast > 90) {
        return { level: 'recommended', reason: daysSinceLast === null ? 'Never run — quarterly SFC scan recommended.' : `SFC last ran ${daysSinceLast}d ago — quarterly maintenance due.`, priority: 6 };
      }
      return { level: 'consider', reason: `SFC ran ${daysSinceLast}d ago — run quarterly.` };
    }

    case 'restart_explorer': {
      // Check overlay count from finding detail (area 'Overlays' or 'Explorer' with a detail.count)
      const overlayFinding = status?.findings.find(f =>
        f.area?.toLowerCase().includes('overlay') ||
        f.area?.toLowerCase().includes('explorer')
      );
      const overlayDetail = overlayFinding?.detail as Record<string, unknown> | undefined;
      const overlayCount = typeof overlayDetail?.count === 'number' ? overlayDetail.count : null;
      const overlayCountHigh = typeof overlayDetail?.shell_overlay_count === 'number'
        ? overlayDetail.shell_overlay_count > 20
        : overlayCount !== null && overlayCount > 20;

      if (overlayCountHigh) {
        return { level: 'recommended', reason: 'Shell overlay count exceeds 20 — restart Explorer to clear stuck icons and overlay glitches.', priority: 3 };
      }
      const explorerFinding = status?.findings.some(f =>
        f.area?.toLowerCase().includes('explorer') ||
        f.area?.toLowerCase().includes('overlays') ||
        f.message?.toLowerCase().includes('explorer') ||
        f.message?.toLowerCase().includes('taskbar') ||
        f.message?.toLowerCase().includes('tray')
      ) ?? false;
      if (explorerFinding) {
        return { level: 'recommended', reason: 'Explorer-related issue detected — restart to clear stuck state.', priority: 3 };
      }
      return { level: 'consider', reason: '5-second fix for stuck icons or overlay glitches.' };
    }

    case 'remap_nas': {
      // NAS KPI: value = count of mappings, severity reflects reachability + mapping count.
      // severity 'crit' = unreachable, 'warn' = reachable but no Persistent mappings, 'good' = all Persistent.
      const nasKpi = status?.kpis.find(k => k.label?.toLowerCase().includes('nas'));
      const nasFinding = status?.findings.some(f =>
        f.area?.toLowerCase().includes('nas') ||
        f.message?.toLowerCase().includes('nas') ||
        f.message?.toLowerCase().includes('network drive') ||
        f.message?.toLowerCase().includes('persistent')
      ) ?? false;
      const nasNotPersistent = nasKpi?.severity === 'warn' || nasKpi?.severity === 'crit';
      if (nasNotPersistent || nasFinding) {
        return { level: 'recommended', reason: 'NAS mapping is not Persistent — re-establish to survive reboots and network changes.', priority: 2 };
      }
      // All mappings are Persistent (good severity, value > 0)
      if (nasKpi && nasKpi.severity === 'good' && (nasKpi.value ?? 0) > 0) {
        return { level: 'skip', reason: 'All NAS mappings are Persistent — no action needed.' };
      }
      return { level: 'consider', reason: 'Use when M:, Z:, or other NAS drives show as disconnected.' };
    }

    // ---- New QUICK_ACTIONS cases ----

    case 'clear_temp_files': {
      const daysSinceLast = daysSince(lastRun, nowS);
      if (cFree !== null && cFree < 20) {
        return { level: 'recommended', reason: `Disk C: is ${cFree.toFixed(0)}% free — temp cleanup can recover 300-700 MB.`, priority: 4 };
      }
      if (daysSinceLast !== null && daysSinceLast > 30) {
        return { level: 'recommended', reason: `Last run ${daysSinceLast}d ago — temp files have accumulated.`, priority: 7 };
      }
      if (daysSinceLast === null) {
        return { level: 'consider', reason: 'Never run — temp files may have accumulated.' };
      }
      return { level: 'skip', reason: 'Ran recently and disk is healthy.' };
    }

    case 'flush_dns': {
      const dnsFinding = status?.findings.some(f =>
        f.area?.toLowerCase().includes('dns') ||
        f.message?.toLowerCase().includes('dns')
      ) ?? false;
      if (dnsFinding) {
        return { level: 'recommended', reason: 'DNS-related issue detected — flush cache to force fresh lookups.', priority: 3 };
      }
      return { level: 'consider', reason: 'Useful after DNS changes, VPN flapping, or sites misbehaving.' };
    }

    case 'flush_arp_cache': {
      const networkFinding = status?.findings.some(f =>
        f.area?.toLowerCase().includes('network') ||
        f.area?.toLowerCase().includes('arp')
      ) ?? false;
      if (networkFinding) {
        return { level: 'recommended', reason: 'Network or ARP issue detected — flush ARP cache to clear stale entries.', priority: 4 };
      }
      return { level: 'consider', reason: 'Flush when devices on your LAN are unreachable despite being online.' };
    }

    case 'compact_docker': {
      const daysSinceLast = daysSince(lastRun, nowS);
      // Check if Docker service is present and running
      const dockerRunning = status?.services?.some(s =>
        s.key === 'com.docker.service' && /run/i.test(s.status)
      ) ?? false;
      if (!dockerRunning) {
        return { level: 'skip', reason: 'Docker service is not running — nothing to compact.' };
      }
      if (daysSinceLast !== null && daysSinceLast <= 30) {
        return { level: 'skip', reason: `Compacted ${daysSinceLast}d ago — Docker is recently maintained.` };
      }
      return { level: 'recommended', reason: `Docker is running and${daysSinceLast !== null ? ` last compacted ${daysSinceLast}d ago` : ' never compacted'} — compact to reclaim vhdx space.`, priority: 6 };
    }

    case 'trim_ssd': {
      const daysSinceLast = daysSince(lastRun, nowS);
      if (daysSinceLast !== null && daysSinceLast < 25) {
        return { level: 'skip', reason: `TRIM ran ${daysSinceLast}d ago — monthly cadence is sufficient.` };
      }
      return { level: 'recommended', reason: daysSinceLast === null ? 'Never run — monthly SSD TRIM maintains long-term write performance.' : `Last TRIM ${daysSinceLast}d ago — monthly maintenance due.`, priority: 5 };
    }

    case 'run_dism': {
      const pendingReboot = security?.windows_update?.reboot_pending ?? false;
      if (pendingReboot) {
        return { level: 'blocked', reason: 'Reboot the pending changes first or DISM can fail mid-way.' };
      }
      // Heuristic: check findings for SFC 'could not repair' / CBS signals
      const sfcUnrepairable = status?.findings.some(f =>
        (f.message?.toLowerCase().includes('could not repair') ||
         f.message?.toLowerCase().includes('cbs') ||
         f.message?.toLowerCase().includes('unrepairable')) &&
        (f.area?.toLowerCase().includes('stability') || f.area?.toLowerCase().includes('sfc'))
      ) ?? false;
      if (sfcUnrepairable) {
        return { level: 'recommended', reason: 'SFC could not repair one or more files — DISM /RestoreHealth can fix the component store.', priority: 3 };
      }
      return { level: 'consider', reason: 'Run DISM /RestoreHealth after SFC reports unrepairable files, or before a major Windows update.' };
    }

    case 'kill_process': {
      return { level: 'consider', reason: 'On-demand tool — use when you\'ve identified a rogue process. Not part of routine maintenance.' };
    }

    case 'open_windows_security': {
      return { level: 'consider', reason: 'Opens the Windows Security UI. Use when Tamper Protection blocks PUA/CFA toggles and you need to change them there.' };
    }

    case 'open_firewall_console': {
      return { level: 'consider', reason: 'Opens wf.msc (Windows Firewall MMC) for manual rule review/edit.' };
    }

    case 'clear_stale_pending_renames': {
      // Surface as 'recommended' only when the scanner flagged a pending
      // reboot AND the PendingFileRename signal is present — actual
      // CBS / WU / post-install renames still need a real reboot.
      const flags = status?.metrics?.pending_reboot ?? [];
      const hasFileRename = Array.isArray(flags) && flags.includes('PendingFileRename');
      if (hasFileRename) {
        return { level: 'recommended', reason: 'PendingFileRename queued — usually browser updater leftovers. Scrub them so the "Pending Reboot" alert clears without actually rebooting.', priority: 4 };
      }
      return { level: 'skip', reason: 'No stale rename entries detected.' };
    }

    default:
      return { level: 'consider', reason: 'No state-based recommendation yet.' };
  }
}

/**
 * Returns all recommended actions from a given list, sorted by priority.
 * Useful for the "Suggested now" strip in Dashboard panels.
 */
export function getTopRecommendations(
  actions: ActionName[],
  status: SystemStatus | null,
  security: SecurityPosture | null,
  getLastRun?: LastRunFetcher['getLastRun'],
  maxCount = 3,
): Array<{ action: ActionName; rec: ActionRecommendation }> {
  return actions
    .map(action => ({ action, rec: recommendAction(action, status, security, getLastRun) }))
    .filter(({ rec }) => rec.level === 'recommended' && (rec.priority ?? 99) <= 3)
    .sort((a, b) => (a.rec.priority ?? 10) - (b.rec.priority ?? 10))
    .slice(0, maxCount);
}
