/**
 * Module: automationCatalog.ts
 * Purpose: Assign fail-closed automation metadata to every known action.
 * Dependencies: The ActionName union and shared automation contract.
 * Used by: Policy-aware execution boundaries added in later phases.
 * Key decisions: Phase 0 classifies every current action as never automatic.
 */

import type { ActionName } from './types.js';
import type { ActionAutomationDefinition, AutomationClass } from './automation.js';

const EMPTY_RESOURCE_LOCKS: readonly string[] = Object.freeze([]);

/** Returns a frozen default-deny definition for the requested automation class. */
function immutableDefinition(automation: AutomationClass): ActionAutomationDefinition {
  return Object.freeze({
    automation,
    rebootPolicy: 'never',
    requiresRollback: false,
    resourceLocks: EMPTY_RESOURCE_LOCKS,
    preflightId: null,
    postconditionId: null,
    cooldownMs: 0,
    maxAttempts: 1,
  });
}

/** Returns immutable metadata that forbids automatic execution. */
export function neverAutomatic(): ActionAutomationDefinition {
  return immutableDefinition('never');
}

/** Returns immutable safe-class metadata that still lacks required execution proofs. */
export function safeAutomatic(): ActionAutomationDefinition {
  return immutableDefinition('safe');
}

export const ACTION_AUTOMATION = Object.freeze({
  flush_dns: neverAutomatic(),
  clear_temp_files: neverAutomatic(),
  clean_recycle_bin: neverAutomatic(),
  clean_browser_cache: neverAutomatic(),
  cleanup_winsxs: neverAutomatic(),
  clean_onedrive_cache: neverAutomatic(),
  clean_teams_cache: neverAutomatic(),
  clean_discord_cache: neverAutomatic(),
  clean_spotify_cache: neverAutomatic(),
  rebuild_search_index: neverAutomatic(),
  run_sfc: neverAutomatic(),
  run_dism: neverAutomatic(),
  trim_ssd: neverAutomatic(),
  generate_system_report: neverAutomatic(),
  import_hwinfo_csv: neverAutomatic(),
  release_renew_ip: neverAutomatic(),
  reset_winsock: neverAutomatic(),
  reset_firewall: neverAutomatic(),
  open_firewall_console: neverAutomatic(),
  open_windows_security: neverAutomatic(),
  clear_stale_pending_renames: neverAutomatic(),
  disable_firewall_temporarily: neverAutomatic(),
  flush_arp_cache: neverAutomatic(),
  reset_network_adapters: neverAutomatic(),
  remap_nas: neverAutomatic(),
  restart_service: neverAutomatic(),
  restart_explorer: neverAutomatic(),
  restart_network_stack: neverAutomatic(),
  kill_process: neverAutomatic(),
  compact_docker: neverAutomatic(),
  apply_wsl_cap: neverAutomatic(),
  fix_shell_overlays: neverAutomatic(),
  disable_startup_item: neverAutomatic(),
  reset_hosts_file: neverAutomatic(),
  defender_quick_scan: neverAutomatic(),
  defender_full_scan: neverAutomatic(),
  update_defender_defs: neverAutomatic(),
  install_windows_updates: neverAutomatic(),
  install_security_updates: neverAutomatic(),
  repair_windows_update: neverAutomatic(),
  hide_kb: neverAutomatic(),
  install_kb: neverAutomatic(),
  create_shadow_copy: neverAutomatic(),
  enable_bitlocker: neverAutomatic(),
  block_ip: neverAutomatic(),
  run_mbam_scan: neverAutomatic(),
  run_dell_command_update: neverAutomatic(),
  import_occt_csv: neverAutomatic(),
  unblock_ip: neverAutomatic(),
  analyze_minidump: neverAutomatic(),
  clear_browser_caches: neverAutomatic(),
  shrink_component_store: neverAutomatic(),
  remove_feature_update_leftovers: neverAutomatic(),
  empty_recycle_bins: neverAutomatic(),
  enable_pua_protection: neverAutomatic(),
  enable_controlled_folder_access: neverAutomatic(),
  update_hosts_stevenblack: neverAutomatic(),
  run_smart_check: neverAutomatic(),
  run_malwarebytes_cli: neverAutomatic(),
  run_adwcleaner_scan: neverAutomatic(),
  run_safety_scanner: neverAutomatic(),
  run_hwinfo_log: neverAutomatic(),
  parse_hwinfo_delta: neverAutomatic(),
  disable_startup_items_batch: neverAutomatic(),
  empty_nas_recycle_bin: neverAutomatic(),
  open_nvidia_app: neverAutomatic(),
  add_lhm_to_cfa_allowlist: neverAutomatic(),
  add_pcdoctor_exclusion: neverAutomatic(),
  register_scheduled_tasks: neverAutomatic(),
  set_service_startup: neverAutomatic(),
  stop_service: neverAutomatic(),
  start_service: neverAutomatic(),
  set_process_priority: neverAutomatic(),
  set_process_affinity: neverAutomatic(),
  suspend_process: neverAutomatic(),
  resume_process: neverAutomatic(),
  create_restore_point: neverAutomatic(),
} satisfies Record<ActionName, ActionAutomationDefinition>);
