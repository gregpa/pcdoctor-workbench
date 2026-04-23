/**
 * Autopilot policy engine (v2.2.0).
 *
 * Responsibilities:
 *   1. Seed a default rule set into `autopilot_rules` on first run.
 *   2. Evaluate threshold-based rules against the latest SystemStatus + metric
 *      history, producing AutopilotDecision objects.
 *   3. Dispatch decisions: Tier 1 / Tier 2 → run the action via actionRunner;
 *      Tier 3 → send a Telegram alert with inline keyboard.
 *   4. Record every evaluation outcome in `autopilot_activity`.
 *
 * Schedule-based rules (cron-like cadences such as "weekly:sun:03:00") are
 * delegated to Windows Task Scheduler via Register-All-Tasks.ps1 so they fire
 * even when the Electron app is not running. This engine is only responsible
 * for *threshold* evaluation from the main-process poll loop.
 */

import { getStatus } from './pcdoctorBridge.js';
import { runAction } from './actionRunner.js';
import { ACTIONS } from '@shared/actions.js';
import type { ActionName, SystemStatus } from '@shared/types.js';
import {
  upsertAutopilotRule,
  listAutopilotRules,
  insertAutopilotActivity,
  listAutopilotActivity,
  getLastAutopilotActivity,
  countAutopilotFailures,
  queryMetricTrend,
  deleteAutopilotRule,
  type AutopilotRuleRow,
} from './dataStore.js';
import { sendTelegramMessage, makeCallbackData, type InlineButton } from './telegramBridge.js';

export type Tier = 1 | 2 | 3;

export interface AutopilotDecision {
  rule_id: string;
  tier: Tier;
  description: string;
  action_name?: ActionName;
  alert?: { title: string; severity: 'critical' | 'important' | 'info'; fix_actions: ActionName[] };
  reason: string;
}

// ============================================================
// Default rule set
// ============================================================

interface DefaultRule {
  id: string;
  tier: Tier;
  description: string;
  trigger: 'schedule' | 'threshold';
  cadence?: string;
  action_name?: ActionName;
  alert?: { title: string; severity: 'critical' | 'important' | 'info'; fix_actions: ActionName[] };
}

export const DEFAULT_RULES: DefaultRule[] = [
  // ---- Tier 1: silent auto-run on schedule ----
  { id: 'empty_recycle_bins_weekly',      tier: 1, description: 'Empty recycle bins weekly',       trigger: 'schedule', cadence: 'weekly:sun:03:00', action_name: 'empty_recycle_bins' },
  { id: 'clear_browser_caches_weekly',    tier: 1, description: 'Clear browser caches weekly',     trigger: 'schedule', cadence: 'weekly:sat:03:00', action_name: 'clear_browser_caches' },
  { id: 'defender_quick_scan_daily',      tier: 1, description: 'Defender quick scan daily',       trigger: 'schedule', cadence: 'daily:02:00',      action_name: 'defender_quick_scan' },
  { id: 'update_defender_defs_daily',     tier: 1, description: 'Update Defender defs daily',      trigger: 'schedule', cadence: 'daily:06:00',      action_name: 'update_defender_defs' },
  { id: 'run_smart_check_daily',          tier: 1, description: 'SMART check daily',               trigger: 'schedule', cadence: 'daily:01:00',      action_name: 'run_smart_check' },
  { id: 'run_malwarebytes_cli_weekly',    tier: 1, description: 'Malwarebytes quick scan weekly',  trigger: 'schedule', cadence: 'weekly:mon:03:00', action_name: 'run_malwarebytes_cli' },
  { id: 'run_adwcleaner_scan_monthly',    tier: 1, description: 'AdwCleaner scan monthly',         trigger: 'schedule', cadence: 'monthly:1:04:00',  action_name: 'run_adwcleaner_scan' },
  { id: 'run_hwinfo_log_monthly',         tier: 1, description: '2-hour sensor log monthly',       trigger: 'schedule', cadence: 'monthly:1sat:23:00', action_name: 'run_hwinfo_log' },
  { id: 'shrink_component_store_monthly', tier: 1, description: 'Shrink component store monthly', trigger: 'schedule', cadence: 'monthly:2sat:04:00', action_name: 'shrink_component_store' },
  { id: 'run_safety_scanner_monthly',     tier: 1, description: 'Safety Scanner monthly',          trigger: 'schedule', cadence: 'monthly:3sat:04:00', action_name: 'run_safety_scanner' },
  { id: 'remove_feature_update_leftovers_low_disk', tier: 1, description: 'Remove feature-update leftovers when disk C <15% free', trigger: 'threshold', action_name: 'remove_feature_update_leftovers' },

  // ---- Tier 2: auto-execute + notify ----
  { id: 'apply_wsl_cap_high_ram',         tier: 2, description: 'Apply WSL cap when RAM >90% for 3 days', trigger: 'threshold', action_name: 'apply_wsl_cap' },
  { id: 'clear_browser_caches_low_disk',  tier: 2, description: 'Clear browser caches when disk C <15%',   trigger: 'threshold', action_name: 'clear_browser_caches' },
  { id: 'update_hosts_stevenblack_monthly', tier: 2, description: 'Refresh StevenBlack hosts monthly',     trigger: 'schedule', cadence: 'monthly:1sun:04:00', action_name: 'update_hosts_stevenblack' },

  // ---- Tier 3: alert only ----
  { id: 'alert_bsod_7d',                  tier: 3, description: 'BSOD detected in last 7 days', trigger: 'threshold', alert: { title: 'BSOD in last 7 days',              severity: 'critical',  fix_actions: ['analyze_minidump'] } },
  { id: 'alert_smart_warning',            tier: 3, description: 'SMART pre-fail/warning',       trigger: 'threshold', alert: { title: 'SMART warning on a drive',         severity: 'critical',  fix_actions: ['run_smart_check'] } },
  { id: 'alert_pending_reboot_7d',        tier: 3, description: 'Pending reboot older than 7d', trigger: 'threshold', alert: { title: 'Pending reboot >7 days',           severity: 'important', fix_actions: [] } },
  { id: 'alert_defender_defs_stale',      tier: 3, description: 'Defender defs >48h old',        trigger: 'threshold', alert: { title: 'Defender definitions stale (>48h)', severity: 'important', fix_actions: ['update_defender_defs'] } },
  { id: 'alert_new_persistence',          tier: 3, description: 'New persistence item added',    trigger: 'threshold', alert: { title: 'New persistence item detected',     severity: 'important', fix_actions: [] } },
  { id: 'alert_thermal_regression',       tier: 3, description: 'ΔT >5°C week-over-week',        trigger: 'threshold', alert: { title: 'Thermal regression',                severity: 'important', fix_actions: ['parse_hwinfo_delta'] } },
  { id: 'alert_old_driver',               tier: 3, description: 'GPU/chipset driver >180 days',  trigger: 'threshold', alert: { title: 'GPU/chipset driver >180 days old',  severity: 'info',      fix_actions: ['run_dell_command_update'] } },
  { id: 'alert_security_crit',            tier: 3, description: 'UAC/BitLocker/Firewall/Defender off', trigger: 'threshold', alert: { title: 'Critical security posture', severity: 'critical', fix_actions: [] } },
  { id: 'alert_forecast_critical',        tier: 3, description: 'Forecast: metric crosses critical in 30d', trigger: 'threshold', alert: { title: 'Forecasted critical metric', severity: 'important', fix_actions: [] } },
  { id: 'alert_action_repeated_failures', tier: 3, description: 'Any action failed 3x in 7d',    trigger: 'threshold', alert: { title: 'Repeated action failures',          severity: 'important', fix_actions: [] } },
];

let rulesSeeded = false;

// v2.4.34: rules renamed or removed in past versions. Deleted on seed so the
// Autopilot UI stops showing stale entries. Keep this list forever -- dropping
// an id here will let it resurrect on boxes still carrying the old row.
const OBSOLETE_RULE_IDS = ['alert_bsod_24h'];

export function seedDefaultRulesOnce(): void {
  if (rulesSeeded) return;
  for (const id of OBSOLETE_RULE_IDS) deleteAutopilotRule(id);
  for (const r of DEFAULT_RULES) {
    upsertAutopilotRule({
      id: r.id,
      tier: r.tier,
      description: r.description,
      trigger: r.trigger,
      cadence: r.cadence ?? null,
      action_name: r.action_name ?? null,
      alert_json: r.alert ? JSON.stringify(r.alert) : null,
      enabled: true,
    });
  }
  rulesSeeded = true;
}

// Test hook: reset the seed flag so tests can re-seed against a fresh DB.
export function _resetSeedFlagForTests(): void {
  rulesSeeded = false;
}

// ============================================================
// Threshold evaluation
// ============================================================

export interface MetricHistory {
  /** "is metric X sustained above threshold Y for N days?" — 80%+ of samples above threshold */
  isSustainedAbove(category: string, metric: string, threshold: number, days: number): boolean;
}

function buildMetricHistory(): MetricHistory {
  return {
    isSustainedAbove(category, metric, threshold, days) {
      const points = queryMetricTrend(category, metric, days);
      if (points.length < 3) return false;
      const above = points.filter(p => p.value > threshold).length;
      return (above / points.length) >= 0.8;
    },
  };
}

async function loadStatus(): Promise<SystemStatus | null> {
  try { return await getStatus(); }
  catch { return null; }
}

/**
 * Evaluate all enabled threshold rules against the current status + history.
 * Returns the list of decisions that should be dispatched. Schedule rules are
 * not evaluated here (delegated to Task Scheduler).
 */
export async function evaluateAutopilot(): Promise<AutopilotDecision[]> {
  seedDefaultRulesOnce();
  const rules = listAutopilotRules().filter(r => r.enabled === 1 && r.trigger === 'threshold');
  if (rules.length === 0) return [];

  const status = await loadStatus();
  if (!status) return [];

  const history = buildMetricHistory();
  const now = Date.now();
  const decisions: AutopilotDecision[] = [];

  for (const rule of rules) {
    if (rule.suppressed_until && rule.suppressed_until > now) continue;
    const decision = evaluateRule(rule, status, history);
    if (decision) decisions.push(decision);
  }
  return decisions;
}

/**
 * Pure function: matches each rule id to a concrete predicate.
 * Exported so tests can drive it without a live SystemStatus source.
 */
export function evaluateRule(
  rule: AutopilotRuleRow,
  status: SystemStatus,
  history: MetricHistory,
): AutopilotDecision | null {
  const tier = rule.tier as Tier;
  const alert = rule.alert_json ? JSON.parse(rule.alert_json) : undefined;
  const base = { rule_id: rule.id, tier, description: rule.description };

  switch (rule.id) {
    case 'remove_feature_update_leftovers_low_disk': {
      const cDisk = status.gauges.find(g => g.label.toUpperCase().startsWith('C:'));
      const cFreePct = cDisk?.value;
      if (typeof cFreePct === 'number' && cFreePct < 15) {
        return { ...base, action_name: 'remove_feature_update_leftovers', reason: `C: drive ${cFreePct}% free` };
      }
      return null;
    }

    case 'apply_wsl_cap_high_ram': {
      if (history.isSustainedAbove('ram', 'used_pct', 90, 3)) {
        return { ...base, action_name: 'apply_wsl_cap', reason: 'RAM >90% sustained 3 days' };
      }
      return null;
    }

    case 'clear_browser_caches_low_disk': {
      const cDisk = status.gauges.find(g => g.label.toUpperCase().startsWith('C:'));
      const cFreePct = cDisk?.value;
      if (typeof cFreePct === 'number' && cFreePct < 15) {
        return { ...base, action_name: 'clear_browser_caches', reason: `C: drive ${cFreePct}% free` };
      }
      return null;
    }

    case 'alert_bsod_7d': {
      // v2.4.34: match ONLY the tight BSOD finding. The scanner now emits two
      // separate Stability findings: "BSOD detected in last 7 days (count: N)"
      // (warning, gated on BugCheck 1001 or a minidump file) and
      // "Unexpected shutdown(s) in last 7 days: N" (info, Event 41 only).
      // Prior loose regex /bsod|kernel panic|bugcheck/i accidentally matched
      // the combined pre-v2.4.34 message "Unexpected shutdowns or BSODs detected"
      // when no BSOD had occurred -- Greg's box fired this alert nightly on
      // Event 41s from unclean boots that had nothing to do with BSODs.
      const hit = status.findings.find(f =>
        f.area === 'Stability' && /^BSOD detected/i.test(f.message),
      );
      if (hit) return { ...base, alert, reason: hit.message };
      return null;
    }

    case 'alert_smart_warning': {
      const bad = (status.smart ?? []).find(s => s.status_severity !== 'good' || s.health !== 'PASSED');
      if (bad) return { ...base, alert, reason: `SMART: ${bad.drive} (${bad.health})` };
      return null;
    }

    case 'alert_pending_reboot_7d': {
      // v2.4.35: rule is titled "Pending reboot >7 days" -- gate on actual
      // uptime so the matcher matches the promise. Pre-v2.4.35 this fired
      // on any pending-reboot finding regardless of uptime, which meant the
      // scanner's INFO-level finding at 18h uptime still triggered a
      // critical Telegram alert (same false-positive class as v2.4.34 BSOD).
      // Scanner emits detail = { flags: [...], uptime_hours: N }.
      const hit = status.findings.find(f => {
        if (!/pending reboot|reboot required/i.test(f.message)) return false;
        const d = f.detail as { uptime_hours?: number } | null | undefined;
        const uptime = typeof d?.uptime_hours === 'number' ? d.uptime_hours : 0;
        return uptime > 168;
      });
      if (hit) return { ...base, alert, reason: hit.message };
      return null;
    }

    case 'alert_defender_defs_stale': {
      const hit = status.findings.find(f => /defender.*def/i.test(f.message) || /def.*old/i.test(f.message));
      if (hit) return { ...base, alert, reason: hit.message };
      return null;
    }

    case 'alert_new_persistence': {
      const hit = status.findings.find(f => /persistence|autorun|new startup/i.test(f.message));
      if (hit) return { ...base, alert, reason: hit.message };
      return null;
    }

    case 'alert_thermal_regression': {
      const hit = status.findings.find(f => /thermal|temp.*regression|\b\+\d+.*°c/i.test(f.message));
      if (hit) return { ...base, alert, reason: hit.message };
      return null;
    }

    case 'alert_old_driver': {
      const hit = status.findings.find(f => /driver.*\d{3,}\s*day|driver.*outdated/i.test(f.message));
      if (hit) return { ...base, alert, reason: hit.message };
      return null;
    }

    case 'alert_security_crit': {
      const crit = status.findings.find(f => f.severity === 'critical' && /uac|bitlocker|firewall|defender/i.test(f.area + ' ' + f.message));
      if (crit) return { ...base, alert, reason: crit.message };
      return null;
    }

    case 'alert_forecast_critical': {
      const hit = status.findings.find(f => /forecast.*critical|projected.*critical/i.test(f.message));
      if (hit) return { ...base, alert, reason: hit.message };
      return null;
    }

    case 'alert_action_repeated_failures': {
      const rules = listAutopilotRules();
      for (const other of rules) {
        if (other.action_name && countAutopilotFailures(other.id, 7) >= 3) {
          return { ...base, alert, reason: `${other.action_name} failed 3+ times in 7 days` };
        }
      }
      return null;
    }

    default:
      return null;
  }
}

// ============================================================
// Dispatch
// ============================================================

/**
 * Execute a decision. For Tier 1/2, runs the action via actionRunner. For Tier 3,
 * sends a Telegram alert with inline keyboard. Every outcome is persisted in
 * autopilot_activity.
 *
 * Rate-limiting: a rule that already ran or alerted within the last `minGapMs`
 * is skipped (no new activity row written).
 */
export async function dispatchDecision(d: AutopilotDecision, minGapMs = 6 * 60 * 60 * 1000): Promise<void> {
  const last = getLastAutopilotActivity(d.rule_id);
  if (last && (Date.now() - last.ts) < minGapMs) return;

  if (d.tier === 3) {
    await dispatchAlert(d);
    return;
  }

  if (!d.action_name) {
    insertAutopilotActivity({
      rule_id: d.rule_id,
      tier: d.tier,
      outcome: 'skipped',
      message: `Tier ${d.tier} rule had no action_name`,
    });
    return;
  }

  try {
    const t0 = Date.now();
    const r = await runAction({ name: d.action_name, triggered_by: 'scheduled' });
    const bytes = (r.result as any)?.bytes_freed;
    insertAutopilotActivity({
      rule_id: d.rule_id,
      tier: d.tier,
      action_name: d.action_name,
      outcome: r.success ? 'auto_run' : 'error',
      bytes_freed: typeof bytes === 'number' ? bytes : undefined,
      duration_ms: Date.now() - t0,
      message: r.success ? ((r.result as any)?.message ?? 'ok') : (r.error?.message ?? 'error'),
      details: r.error ?? undefined,
    });

    if (d.tier === 2 && r.success) {
      const def = ACTIONS[d.action_name];
      const bytesTxt = typeof bytes === 'number' ? ` (${(bytes / 1024 / 1024).toFixed(1)} MB freed)` : '';
      void sendTelegramMessage(
        `🤖 <b>Autopilot</b> ran <b>${def.label}</b>${bytesTxt}\n<i>${d.reason}</i>`,
      );
    }
  } catch (e: any) {
    insertAutopilotActivity({
      rule_id: d.rule_id,
      tier: d.tier,
      action_name: d.action_name,
      outcome: 'error',
      message: e?.message ?? 'dispatch threw',
    });
  }
}

async function dispatchAlert(d: AutopilotDecision): Promise<void> {
  if (!d.alert) return;
  const severityIcon = d.alert.severity === 'critical' ? '🔴' : d.alert.severity === 'important' ? '🟡' : 'ℹ️';

  const buttons: InlineButton[][] = [];
  const actionRow: InlineButton[] = [];
  for (const fix of d.alert.fix_actions) {
    const def = ACTIONS[fix];
    if (!def) continue;
    actionRow.push({ text: def.label, callback_data: makeCallbackData('autopilot', fix, d.rule_id) });
  }
  if (actionRow.length > 0) buttons.push(actionRow);
  buttons.push([
    { text: 'Snooze 24h', callback_data: makeCallbackData('ap_snooze', d.rule_id) },
    { text: 'Dismiss',    callback_data: makeCallbackData('ap_dismiss', d.rule_id) },
  ]);

  const body = `${severityIcon} <b>${d.alert.title}</b>\n<i>${d.reason}</i>`;
  const send = await sendTelegramMessage(body, buttons);

  insertAutopilotActivity({
    rule_id: d.rule_id,
    tier: 3,
    outcome: send.ok ? 'alerted' : 'error',
    message: send.ok ? d.alert.title : (send.error ?? 'telegram send failed'),
    details: { severity: d.alert.severity, fix_actions: d.alert.fix_actions, reason: d.reason },
  });
}

// ============================================================
// Public helper: format activity for UI
// ============================================================

export interface AutopilotActivityEntry {
  id: number;
  ts: number;
  rule_id: string;
  tier: Tier;
  action_name: string | null;
  outcome: string;
  bytes_freed: number | null;
  duration_ms: number | null;
  message: string | null;
}

export function getAutopilotActivity(daysBack = 30): AutopilotActivityEntry[] {
  const rows = listAutopilotActivity(daysBack);
  return rows.map(r => ({
    id: r.id,
    ts: r.ts,
    rule_id: r.rule_id,
    tier: r.tier as Tier,
    action_name: r.action_name,
    outcome: r.outcome,
    bytes_freed: r.bytes_freed,
    duration_ms: r.duration_ms,
    message: r.message,
  }));
}

// ============================================================
// Engine lifecycle
// ============================================================

let evalTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the threshold-evaluation loop (60s cadence). Idempotent.
 * Safe to call on startup regardless of whether backend data is available yet.
 */
export function startAutopilotEngine(intervalMs = 60_000): void {
  seedDefaultRulesOnce();
  if (evalTimer) return;
  const tick = async () => {
    try {
      const decisions = await evaluateAutopilot();
      for (const d of decisions) {
        try { await dispatchDecision(d); } catch { /* swallow per-decision errors */ }
      }
    } catch {
      // never let evaluation crash the main process
    }
  };
  // Small initial delay so we don't hit backend before it's ready
  setTimeout(tick, 15_000);
  evalTimer = setInterval(tick, intervalMs);
}

export function stopAutopilotEngine(): void {
  if (evalTimer) { clearInterval(evalTimer); evalTimer = null; }
}
