import { describe, it, expect } from 'vitest';
import { ACTIONS } from '../../src/shared/actions.js';

describe('ACTIONS catalog', () => {
  it('every action has a ps_script path', () => {
    for (const [name, def] of Object.entries(ACTIONS)) {
      expect(def.ps_script, `${name} missing ps_script`).toMatch(/^actions\/.+\.ps1$/);
    }
  });

  it('every action has a tooltip >= 20 chars', () => {
    for (const [name, def] of Object.entries(ACTIONS)) {
      expect(def.tooltip.length, `${name} empty tooltip`).toBeGreaterThan(20);
    }
  });

  it('Tier A actions declare restore_point_description', () => {
    for (const [name, def] of Object.entries(ACTIONS)) {
      if (def.rollback_tier === 'A') {
        expect(def.restore_point_description, `${name} tier A missing description`).toBeDefined();
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

  it('every action has an icon string', () => {
    for (const [name, def] of Object.entries(ACTIONS)) {
      expect(def.icon.length, `${name} missing icon`).toBeGreaterThan(0);
    }
  });

  it('action name field matches its key', () => {
    for (const [name, def] of Object.entries(ACTIONS)) {
      expect(def.name).toBe(name);
    }
  });
});
