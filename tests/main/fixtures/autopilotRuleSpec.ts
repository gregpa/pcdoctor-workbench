/**
 * Copy of the Autopilot DEFAULT_RULES catalogue, stripped of runtime imports,
 * so tests can lock in the expected shape without loading the engine module
 * (which transitively pulls in better-sqlite3 / Electron).
 *
 * When src/main/autopilotEngine.ts DEFAULT_RULES changes, mirror that change here.
 */
export interface RuleSpec {
  id: string;
  tier: 1 | 2 | 3;
  description: string;
  trigger: 'schedule' | 'threshold';
  cadence?: string;
  action_name?: string;
  alert?: { title: string; severity: 'critical' | 'important' | 'info'; fix_actions: string[] };
}

export const DEFAULT_RULES_SPEC: RuleSpec[] = [
  // Tier 1
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

  // Tier 2
  { id: 'apply_wsl_cap_high_ram',           tier: 2, description: 'Apply WSL cap when RAM >90% for 3 days', trigger: 'threshold', action_name: 'apply_wsl_cap' },
  { id: 'clear_browser_caches_low_disk',    tier: 2, description: 'Clear browser caches when disk C <15%',   trigger: 'threshold', action_name: 'clear_browser_caches' },
  { id: 'update_hosts_stevenblack_monthly', tier: 2, description: 'Refresh StevenBlack hosts monthly',       trigger: 'schedule', cadence: 'monthly:1sun:04:00', action_name: 'update_hosts_stevenblack' },

  // Tier 3
  { id: 'alert_bsod_24h',                 tier: 3, description: 'BSOD detected in last 24h',   trigger: 'threshold', alert: { title: 'BSOD in last 24h', severity: 'critical',  fix_actions: ['analyze_minidump'] } },
  { id: 'alert_smart_warning',            tier: 3, description: 'SMART pre-fail/warning',       trigger: 'threshold', alert: { title: 'SMART warning on a drive', severity: 'critical',  fix_actions: ['run_smart_check'] } },
  { id: 'alert_pending_reboot_7d',        tier: 3, description: 'Pending reboot older than 7d', trigger: 'threshold', alert: { title: 'Pending reboot >7 days',   severity: 'important', fix_actions: [] } },
  { id: 'alert_defender_defs_stale',      tier: 3, description: 'Defender defs >48h old',        trigger: 'threshold', alert: { title: 'Defender defs stale',     severity: 'important', fix_actions: ['update_defender_defs'] } },
  { id: 'alert_new_persistence',          tier: 3, description: 'New persistence item added',    trigger: 'threshold', alert: { title: 'New persistence item',    severity: 'important', fix_actions: [] } },
  { id: 'alert_thermal_regression',       tier: 3, description: 'ΔT >5°C week-over-week',        trigger: 'threshold', alert: { title: 'Thermal regression',      severity: 'important', fix_actions: ['parse_hwinfo_delta'] } },
  { id: 'alert_old_driver',               tier: 3, description: 'GPU/chipset driver >180 days',  trigger: 'threshold', alert: { title: 'Old driver',              severity: 'info',      fix_actions: ['run_dell_command_update'] } },
  { id: 'alert_security_crit',            tier: 3, description: 'UAC/BitLocker/Firewall/Defender off', trigger: 'threshold', alert: { title: 'Security crit', severity: 'critical', fix_actions: [] } },
  { id: 'alert_forecast_critical',        tier: 3, description: 'Forecast: critical in 30d',     trigger: 'threshold', alert: { title: 'Forecast critical',       severity: 'important', fix_actions: [] } },
  { id: 'alert_action_repeated_failures', tier: 3, description: 'Any action failed 3x in 7d',    trigger: 'threshold', alert: { title: 'Repeated action failures', severity: 'important', fix_actions: [] } },
];
