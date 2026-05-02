/**
 * W7 Autopilot Rules -- seventh step of the first-run wizard (index 6).
 *
 * Lets the user review and customize which automated maintenance tasks
 * run in the background. Rules are grouped by tier:
 *   - Tier 1: Silent auto-run (no notification)
 *   - Tier 2: Auto-execute + notify
 *   - Tier 3: Alert only (no auto-action)
 *
 * On unmount: persists changed rule states via setAutopilotRuleEnabled()
 * and marks step 6 complete.
 */

import { useEffect, useState, useRef, useCallback } from 'react';
import { useWizard } from '../WizardContext.js';

// ---------------------------------------------------------------------------
// Local rule metadata (renderer-safe -- no Node imports)
// ---------------------------------------------------------------------------

interface RuleMeta {
  id: string;
  tier: 1 | 2 | 3;
  description: string;
}

/**
 * Static copy of rule metadata from autopilotEngine.ts DEFAULT_RULES.
 * IDs are stable; this avoids pulling Node.js deps into the renderer.
 */
const RULE_META: RuleMeta[] = [
  // Tier 1 -- Silent
  { id: 'empty_recycle_bins_weekly',      tier: 1, description: 'Empty recycle bins weekly' },
  { id: 'clear_browser_caches_weekly',    tier: 1, description: 'Clear browser caches weekly' },
  { id: 'defender_quick_scan_daily',      tier: 1, description: 'Defender quick scan daily' },
  { id: 'update_defender_defs_daily',     tier: 1, description: 'Update Defender defs daily' },
  { id: 'run_smart_check_daily',          tier: 1, description: 'SMART check daily' },
  { id: 'run_malwarebytes_cli_weekly',    tier: 1, description: 'Malwarebytes quick scan weekly' },
  { id: 'run_adwcleaner_scan_monthly',    tier: 1, description: 'AdwCleaner scan monthly' },
  { id: 'run_hwinfo_log_monthly',         tier: 1, description: '2-hour sensor log monthly' },
  { id: 'shrink_component_store_monthly', tier: 1, description: 'Shrink component store monthly' },
  { id: 'run_safety_scanner_monthly',     tier: 1, description: 'Safety Scanner monthly' },
  { id: 'refresh_nas_recycle_sizes_daily', tier: 1, description: 'Refresh NAS @Recycle sizes daily' },
  { id: 'remove_feature_update_leftovers_low_disk', tier: 1, description: 'Remove feature-update leftovers when disk C <15% free' },

  // Tier 2 -- Auto + Notify
  { id: 'apply_wsl_cap_high_ram',           tier: 2, description: 'Apply WSL cap when RAM >90% for 3 days' },
  { id: 'clear_browser_caches_low_disk',    tier: 2, description: 'Clear browser caches when disk C <15%' },
  { id: 'update_hosts_stevenblack_monthly', tier: 2, description: 'Refresh StevenBlack hosts monthly' },

  // Tier 3 -- Alert only
  { id: 'alert_bsod_7d',                  tier: 3, description: 'BSOD detected in last 7 days' },
  { id: 'alert_smart_warning',            tier: 3, description: 'SMART pre-fail/warning' },
  { id: 'alert_pending_reboot_7d',        tier: 3, description: 'Pending reboot older than 7d' },
  { id: 'alert_defender_defs_stale',      tier: 3, description: 'Defender defs >48h old' },
  { id: 'alert_new_persistence',          tier: 3, description: 'New persistence item added' },
  { id: 'alert_thermal_regression',       tier: 3, description: 'Temperature rise >5C week-over-week' },
  { id: 'alert_old_driver',               tier: 3, description: 'GPU/chipset driver >180 days old' },
  { id: 'alert_security_crit',            tier: 3, description: 'UAC/BitLocker/Firewall/Defender off' },
  { id: 'alert_forecast_critical',        tier: 3, description: 'Forecast: metric crosses critical in 30d' },
  { id: 'alert_action_repeated_failures', tier: 3, description: 'Any action failed 3x in 7d' },
];

const NAS_RULE_IDS = new Set(RULE_META.filter(r => r.id.includes('nas')).map(r => r.id));
const WSL_RULE_IDS = new Set(['apply_wsl_cap_high_ram']);

const TIER_SECTIONS: { tier: 1 | 2 | 3; label: string; sublabel: string }[] = [
  { tier: 1, label: 'Tier 1 — Silent',        sublabel: 'Runs automatically, no notification' },
  { tier: 2, label: 'Tier 2 — Auto + Notify',  sublabel: 'Auto-executes and sends a notification' },
  { tier: 3, label: 'Tier 3 — Alerts Only',    sublabel: 'Sends an alert; you decide what to do' },
];

const TIER_BADGE_CLASS: Record<number, string> = {
  1: 'bg-status-good/20 text-status-good',
  2: 'bg-status-info/20 text-status-info',
  3: 'bg-status-warn/20 text-status-warn',
};

// ---------------------------------------------------------------------------
// Preset detection
// ---------------------------------------------------------------------------

type Preset = 'all' | 'minimal' | 'custom';

function detectPreset(enabledMap: Map<string, boolean>): Preset {
  let allOn = true;
  let isMinimal = true;

  for (const rule of RULE_META) {
    const on = enabledMap.get(rule.id) ?? true;
    if (!on) allOn = false;
    // Minimal = only tier 3 (alerts) enabled
    if (rule.tier !== 3 && on) isMinimal = false;
    if (rule.tier === 3 && !on) isMinimal = false;
  }

  if (allOn) return 'all';
  if (isMinimal) return 'minimal';
  return 'custom';
}

// ---------------------------------------------------------------------------
// Toggle switch sub-component
// ---------------------------------------------------------------------------

function ToggleSwitch({
  checked,
  disabled,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        disabled
          ? 'opacity-40 cursor-not-allowed bg-surface-600'
          : checked
            ? 'bg-status-info cursor-pointer'
            : 'bg-surface-600 cursor-pointer'
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function W7AutopilotRules() {
  const { state, markComplete } = useWizard();
  const { nasServer, systemProfile } = state;

  const [loading, setLoading] = useState(true);
  // Map of rule id -> enabled (current UI state)
  const [enabledMap, setEnabledMap] = useState<Map<string, boolean>>(new Map());
  // Map of rule id -> enabled (loaded from DB, for diffing on unmount)
  const initialMapRef = useRef<Map<string, boolean>>(new Map());

  const hasNas = !!nasServer;
  const hasWsl = !!(systemProfile as any)?.wsl_installed;

  // Fetch current rule states on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await window.api.listAutopilotRules();
        if (cancelled) return;
        if (r.ok) {
          const map = new Map<string, boolean>();
          for (const rule of r.data as Array<{ id: string; enabled: boolean }>) {
            map.set(rule.id, rule.enabled);
          }
          setEnabledMap(new Map(map));
          initialMapRef.current = new Map(map);
        }
      } catch {
        // Non-fatal -- defaults will be used
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Save changes on unmount
  const enabledMapRef = useRef(enabledMap);
  enabledMapRef.current = enabledMap;

  useEffect(() => {
    return () => {
      const current = enabledMapRef.current;
      const initial = initialMapRef.current;
      const promises: Promise<any>[] = [];
      for (const [id, enabled] of current) {
        if (initial.get(id) !== enabled) {
          promises.push(window.api.setAutopilotRuleEnabled(id, enabled));
        }
      }
      if (promises.length > 0) {
        void Promise.all(promises);
      }
      markComplete(5);  // v2.5.25: was 6 before W6 removal
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toggle a single rule
  const toggle = useCallback((ruleId: string, value: boolean) => {
    setEnabledMap(prev => {
      const next = new Map(prev);
      next.set(ruleId, value);
      return next;
    });
  }, []);

  // Preset: Enable All
  const applyAll = useCallback(() => {
    setEnabledMap(prev => {
      const next = new Map(prev);
      for (const rule of RULE_META) next.set(rule.id, true);
      return next;
    });
  }, []);

  // Preset: Minimal (alerts only)
  const applyMinimal = useCallback(() => {
    setEnabledMap(prev => {
      const next = new Map(prev);
      for (const rule of RULE_META) {
        next.set(rule.id, rule.tier === 3);
      }
      return next;
    });
  }, []);

  // Derived
  const enabledCount = Array.from(enabledMap.values()).filter(Boolean).length;
  const totalCount = RULE_META.length;
  const preset = detectPreset(enabledMap);

  // ---- Loading ----
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-4">
        <div className="w-8 h-8 border-2 border-status-info border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-text-secondary">Loading autopilot rules&hellip;</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 py-2">
      {/* Header */}
      <div>
        <h2 className="text-lg font-bold text-text-primary">Autopilot Rules</h2>
        <p className="text-sm text-text-secondary mt-0.5">
          Automated maintenance tasks that run in the background. Rules are grouped
          into three tiers based on how they act.
        </p>
      </div>

      {/* Preset buttons + rule count */}
      <div className="flex items-center gap-3 flex-wrap">
        <PresetButton label="Enable All" active={preset === 'all'} onClick={applyAll} />
        <PresetButton label="Minimal" active={preset === 'minimal'} onClick={applyMinimal} />
        <span className={`text-xs px-2 py-1 rounded ${preset === 'custom' ? 'bg-surface-700 text-text-primary font-semibold' : 'text-text-secondary'}`}>
          Custom
        </span>

        <span className="ml-auto text-xs text-text-secondary">
          {enabledCount} of {totalCount} rules enabled
        </span>
      </div>

      {/* Tier sections */}
      {TIER_SECTIONS.map(({ tier, label, sublabel }) => {
        const rules = RULE_META.filter(r => r.tier === tier);
        return (
          <div key={tier} className="flex flex-col gap-2">
            {/* Section header */}
            <div className="flex items-center gap-2">
              <span className={`text-xs font-semibold px-2 py-0.5 rounded ${TIER_BADGE_CLASS[tier]}`}>
                {label}
              </span>
              <span className="text-xs text-text-secondary">{sublabel}</span>
            </div>

            {/* Rule list */}
            <div className="rounded-lg border border-surface-600 bg-surface-700/30 divide-y divide-surface-600">
              {rules.map(rule => {
                const isNas = NAS_RULE_IDS.has(rule.id);
                const isWsl = WSL_RULE_IDS.has(rule.id);
                const disabled = (isNas && !hasNas) || (isWsl && !hasWsl);
                const checked = disabled ? false : (enabledMap.get(rule.id) ?? true);

                return (
                  <div key={rule.id} className="flex items-center gap-3 px-4 py-2.5">
                    <ToggleSwitch
                      checked={checked}
                      disabled={disabled}
                      onChange={(v) => toggle(rule.id, v)}
                      ariaLabel={rule.description}
                    />
                    <span className={`text-sm flex-1 ${disabled ? 'text-text-secondary/50' : 'text-text-primary'}`}>
                      {rule.description}
                    </span>
                    {isNas && !hasNas && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-warn/20 text-status-warn">
                        Requires NAS
                      </span>
                    )}
                    {isWsl && !hasWsl && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-status-warn/20 text-status-warn">
                        Requires WSL
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PresetButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-xs px-3 py-1.5 rounded-md border transition ${
        active
          ? 'border-status-info bg-status-info/20 text-status-info font-semibold'
          : 'border-surface-600 text-text-secondary hover:bg-surface-700'
      }`}
    >
      {label}
    </button>
  );
}
