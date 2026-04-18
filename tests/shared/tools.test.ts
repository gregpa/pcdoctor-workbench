import { describe, it, expect } from 'vitest';
import { TOOLS, TOOL_CATEGORIES, type ToolCategory } from '../../src/shared/tools.js';

const VALID_CATEGORIES: ToolCategory[] = ['hardware', 'security', 'forensics', 'disk', 'diagnostic', 'native'];

describe('TOOLS catalog', () => {
  it('is non-empty', () => {
    expect(Object.keys(TOOLS).length).toBeGreaterThan(0);
  });

  it('every tool has required identity fields', () => {
    for (const [key, def] of Object.entries(TOOLS)) {
      expect(def.id, `${key} missing id`).toBeTruthy();
      expect(def.name, `${key} missing name`).toBeTruthy();
      expect(def.description, `${key} missing description`).toBeTruthy();
      expect(def.publisher, `${key} missing publisher`).toBeTruthy();
    }
  });

  it('tool id field matches its catalog key', () => {
    for (const [key, def] of Object.entries(TOOLS)) {
      expect(def.id).toBe(key);
    }
  });

  it('every tool has a valid category', () => {
    for (const [key, def] of Object.entries(TOOLS)) {
      expect(VALID_CATEGORIES, `${key} has invalid category ${def.category}`).toContain(def.category);
    }
  });

  it('every tool has at least one detect_path', () => {
    for (const [key, def] of Object.entries(TOOLS)) {
      expect(Array.isArray(def.detect_paths), `${key} detect_paths not array`).toBe(true);
      expect(def.detect_paths.length, `${key} has empty detect_paths`).toBeGreaterThan(0);
      for (const p of def.detect_paths) {
        // Must be an absolute Windows path OR contain an env-var placeholder
        const looksAbsolute = /^[A-Za-z]:\\/.test(p) || /%[^%]+%/.test(p);
        expect(looksAbsolute, `${key} detect_path "${p}" not absolute`).toBe(true);
      }
    }
  });

  it('every tool has at least one launch_mode with id/label/args', () => {
    for (const [key, def] of Object.entries(TOOLS)) {
      expect(def.launch_modes.length, `${key} missing launch_modes`).toBeGreaterThan(0);
      for (const m of def.launch_modes) {
        expect(m.id, `${key} launch_mode missing id`).toBeTruthy();
        expect(m.label, `${key} launch_mode missing label`).toBeTruthy();
        expect(Array.isArray(m.args), `${key} launch_mode args not array`).toBe(true);
      }
    }
  });

  it('every tool has a non-empty icon', () => {
    for (const [key, def] of Object.entries(TOOLS)) {
      expect(def.icon.length, `${key} missing icon`).toBeGreaterThan(0);
    }
  });

  it('launch_mode ids are unique within a tool', () => {
    for (const [key, def] of Object.entries(TOOLS)) {
      const ids = def.launch_modes.map(m => m.id);
      const unique = new Set(ids);
      expect(unique.size, `${key} has duplicate launch_mode ids`).toBe(ids.length);
    }
  });

  it('TOOL_CATEGORIES covers every category referenced by a tool', () => {
    const declared = new Set(TOOL_CATEGORIES.map(c => c.id));
    for (const def of Object.values(TOOLS)) {
      expect(declared.has(def.category), `category ${def.category} missing from TOOL_CATEGORIES`).toBe(true);
    }
  });
});
