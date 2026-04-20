import { describe, it, expect } from 'vitest';
import { ACTIONS } from '../../src/shared/actions.js';
import type { ActionName } from '../../src/shared/types.js';

// The seven Tier-1 actions shipped in v2.1.4.
const V214_ACTIONS: ReadonlyArray<{ name: ActionName; script: string }> = [
  { name: 'clear_browser_caches',             script: 'actions/Clear-BrowserCaches.ps1' },
  { name: 'shrink_component_store',           script: 'actions/Shrink-ComponentStore.ps1' },
  { name: 'remove_feature_update_leftovers',  script: 'actions/Remove-FeatureUpdateLeftovers.ps1' },
  { name: 'empty_recycle_bins',               script: 'actions/Empty-RecycleBins.ps1' },
  { name: 'enable_pua_protection',            script: 'actions/Enable-PUAProtection.ps1' },
  { name: 'enable_controlled_folder_access',  script: 'actions/Enable-ControlledFolderAccess.ps1' },
  { name: 'update_hosts_stevenblack',         script: 'actions/Update-HostsFromStevenBlack.ps1' },
];

describe('v2.1.4 actions registry', () => {
  for (const { name, script } of V214_ACTIONS) {
    it(`${name} is registered with the correct ps_script path`, () => {
      const def = ACTIONS[name];
      expect(def, `${name} must be registered in ACTIONS`).toBeDefined();
      expect(def.name).toBe(name);
      expect(def.ps_script).toBe(script);
    });
  }

  it('Tier A v2.1.4 actions have a restore_point_description', () => {
    for (const { name } of V214_ACTIONS) {
      const def = ACTIONS[name];
      if (def.rollback_tier === 'A') {
        expect(def.restore_point_description, `${name} tier A missing description`).toBeTruthy();
      }
    }
  });

  it('Tier B v2.1.4 actions declare snapshot_paths', () => {
    for (const { name } of V214_ACTIONS) {
      const def = ACTIONS[name];
      if (def.rollback_tier === 'B') {
        expect(def.snapshot_paths, `${name} tier B missing snapshot_paths`).toBeDefined();
        expect(Array.isArray(def.snapshot_paths)).toBe(true);
      }
    }
  });

  it('destructive v2.1.4 actions all request confirmation', () => {
    const destructive: ActionName[] = [
      'shrink_component_store',
      'remove_feature_update_leftovers',
      'empty_recycle_bins',
      'update_hosts_stevenblack',
    ];
    for (const name of destructive) {
      expect(ACTIONS[name].confirm_level, `${name} must not be confirm_level=none`).not.toBe('none');
    }
  });

  it('v2.1.4 hardening actions land in the hardening category', () => {
    const hardening: ActionName[] = [
      'enable_pua_protection',
      'enable_controlled_folder_access',
      'update_hosts_stevenblack',
    ];
    for (const name of hardening) {
      expect(ACTIONS[name].category).toBe('hardening');
    }
  });

  it('v2.1.4 deep-clean actions land in the disk or cleanup category', () => {
    const cleanup: ActionName[] = [
      'clear_browser_caches',
      'shrink_component_store',
      'remove_feature_update_leftovers',
      'empty_recycle_bins',
    ];
    for (const name of cleanup) {
      expect(['disk', 'cleanup']).toContain(ACTIONS[name].category);
    }
  });
});
