import { describe, it, expect } from 'vitest';
import { ACTIONS, QUICK_ACTIONS, type ConfirmLevel, type RollbackTier } from '../../src/shared/actions.js';
import type { ActionCategory } from '../../src/shared/types.js';

// v2.4.23: 'info' tier added - neutral pre-click modal for safe actions.
const VALID_CONFIRM_LEVELS: ConfirmLevel[] = ['none', 'info', 'risky', 'destructive'];
const VALID_ROLLBACK_TIERS: RollbackTier[] = ['A', 'B', 'C', 'none'];
const VALID_CATEGORIES: ActionCategory[] = ['cleanup', 'repair', 'network', 'service', 'perf', 'security', 'update', 'hardening', 'disk', 'diagnostic', 'internal'];

describe('ACTIONS catalog', () => {
  it('is non-empty', () => {
    expect(Object.keys(ACTIONS).length).toBeGreaterThan(0);
  });

  it('every action has a non-empty label', () => {
    for (const [name, def] of Object.entries(ACTIONS)) {
      expect(def.label, `${name} missing label`).toBeTruthy();
      expect(def.label.length, `${name} label too short`).toBeGreaterThan(0);
    }
  });

  it('every action has a ps_script path', () => {
    for (const [name, def] of Object.entries(ACTIONS)) {
      expect(def.ps_script, `${name} missing ps_script`).toMatch(/^actions\/.+\.ps1$/i);
    }
  });

  it('every action has a valid confirm_level', () => {
    for (const [name, def] of Object.entries(ACTIONS)) {
      expect(VALID_CONFIRM_LEVELS, `${name} has invalid confirm_level "${def.confirm_level}"`).toContain(def.confirm_level);
    }
  });

  it('every action has a valid rollback_tier', () => {
    for (const [name, def] of Object.entries(ACTIONS)) {
      expect(VALID_ROLLBACK_TIERS, `${name} has invalid rollback_tier "${def.rollback_tier}"`).toContain(def.rollback_tier);
    }
  });

  it('every action has a valid category', () => {
    for (const [name, def] of Object.entries(ACTIONS)) {
      expect(VALID_CATEGORIES, `${name} has invalid category "${def.category}"`).toContain(def.category);
    }
  });

  it('every action has a positive estimated_duration_s', () => {
    for (const [name, def] of Object.entries(ACTIONS)) {
      expect(typeof def.estimated_duration_s, `${name} estimated_duration_s must be number`).toBe('number');
      expect(def.estimated_duration_s, `${name} estimated_duration_s must be > 0`).toBeGreaterThan(0);
    }
  });

  it('every action has an icon string', () => {
    for (const [name, def] of Object.entries(ACTIONS)) {
      expect(def.icon.length, `${name} missing icon`).toBeGreaterThan(0);
    }
  });

  it('every action has a tooltip >= 20 chars', () => {
    for (const [name, def] of Object.entries(ACTIONS)) {
      expect(def.tooltip.length, `${name} empty tooltip`).toBeGreaterThan(20);
    }
  });

  it('action name field matches its key', () => {
    for (const [name, def] of Object.entries(ACTIONS)) {
      expect(def.name).toBe(name);
    }
  });

  it('Tier A actions declare restore_point_description', () => {
    for (const [name, def] of Object.entries(ACTIONS)) {
      if (def.rollback_tier === 'A') {
        expect(def.restore_point_description, `${name} tier A missing description`).toBeDefined();
        expect(typeof def.restore_point_description).toBe('string');
        expect((def.restore_point_description as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('Tier B actions declare snapshot_paths array', () => {
    for (const [name, def] of Object.entries(ACTIONS)) {
      if (def.rollback_tier === 'B') {
        expect(def.snapshot_paths, `${name} tier B missing snapshot_paths`).toBeDefined();
        expect(Array.isArray(def.snapshot_paths)).toBe(true);
      }
    }
  });

  it('destructive actions are never confirm_level=none', () => {
    // Any action with rollback_tier A should require at minimum risky confirmation
    for (const [name, def] of Object.entries(ACTIONS)) {
      if (def.rollback_tier === 'A') {
        expect(def.confirm_level, `${name} is tier A but has no confirmation`).not.toBe('none');
      }
    }
  });

  it('params_schema entries have valid type and required fields', () => {
    for (const [name, def] of Object.entries(ACTIONS)) {
      if (!def.params_schema) continue;
      for (const [param, schema] of Object.entries(def.params_schema)) {
        expect(['string', 'number'], `${name}.${param} has invalid type "${schema.type}"`).toContain(schema.type);
        expect(typeof schema.required, `${name}.${param} required must be boolean`).toBe('boolean');
        expect(schema.description.length, `${name}.${param} missing description`).toBeGreaterThan(0);
      }
    }
  });

  it('QUICK_ACTIONS only reference valid action names', () => {
    const validNames = new Set(Object.keys(ACTIONS));
    for (const name of QUICK_ACTIONS) {
      expect(validNames.has(name), `QUICK_ACTIONS references unknown action "${name}"`).toBe(true);
    }
  });

  it('no duplicate action names (map key equals name property)', () => {
    const seen = new Set<string>();
    for (const [key, def] of Object.entries(ACTIONS)) {
      expect(seen.has(def.name), `duplicate name "${def.name}"`).toBe(false);
      expect(def.name, `key ${key} != name ${def.name}`).toBe(key);
      seen.add(def.name);
    }
  });
});
