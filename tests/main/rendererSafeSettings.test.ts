// @vitest-environment node
//
// v2.5.15 (Item 8): regression guard for the v2.5.9 nvidia_check_cache bug.
//
// Background: that release added main-side caching of Nvidia driver check
// results via setSetting('nvidia_check_cache', JSON). The renderer hydrated
// from api.getSettings() on mount. The bug: nvidia_check_cache wasn't in the
// RENDERER_SAFE_KEYS allowlist, so the IPC filter silently dropped it. The
// feature looked correct in unit tests (which exercised dataStore directly,
// bypassing the filter), but was broken on every cold start in prod.
//
// This test exercises the FILTER chain that the renderer's getSettings
// roundtrip actually uses. Adding a new cached-by-main / read-by-renderer
// setting now requires updating RENDERER_SAFE_KEYS, and these tests will
// fail on a regression.

import { describe, it, expect } from 'vitest';
import {
  RENDERER_SAFE_KEYS,
  isRendererSafeKey,
  filterRendererSafeSettings,
} from '../../src/main/rendererSafeSettings.js';

describe('rendererSafeSettings allowlist', () => {
  describe('isRendererSafeKey', () => {
    it('accepts every key in RENDERER_SAFE_KEYS', () => {
      for (const k of RENDERER_SAFE_KEYS) {
        expect(isRendererSafeKey(k)).toBe(true);
      }
    });

    it('accepts any key starting with "event:"', () => {
      expect(isRendererSafeKey('event:smart-warning:toast')).toBe(true);
      expect(isRendererSafeKey('event:bsod-detected:telegram')).toBe(true);
      expect(isRendererSafeKey('event:foo')).toBe(true);
    });

    it('rejects unknown keys (the v2.5.9 bug class)', () => {
      expect(isRendererSafeKey('not_in_allowlist')).toBe(false);
      expect(isRendererSafeKey('hypothetical_new_cache')).toBe(false);
      expect(isRendererSafeKey('')).toBe(false);
    });

    it('rejects keys that almost-match but not exactly (no prefix matching)', () => {
      // event-like substring but not the prefix
      expect(isRendererSafeKey('xevent:foo')).toBe(false);
      expect(isRendererSafeKey('eventfoo')).toBe(false);
      // case mismatch
      expect(isRendererSafeKey('EVENT:foo')).toBe(false);
      expect(isRendererSafeKey('Telegram_Bot_Token')).toBe(false);
    });
  });

  describe('filterRendererSafeSettings', () => {
    it('passes through every allowlisted key', () => {
      const all = {
        telegram_bot_token: 'abc',
        telegram_chat_id: '12345',
        nvidia_check_cache: '{"ts":1,"latest_version":"v1"}',
        quiet_hours_start: '22:00',
      };
      const filtered = filterRendererSafeSettings(all);
      expect(filtered).toEqual(all);
    });

    it('filters out non-allowlisted keys (v2.5.9 regression guard)', () => {
      const all = {
        telegram_bot_token: 'abc',
        secret_internal_thing: 'should-not-leak',
        another_internal: 'also-blocked',
      };
      const filtered = filterRendererSafeSettings(all);
      expect(filtered.telegram_bot_token).toBe('abc');
      expect(filtered.secret_internal_thing).toBeUndefined();
      expect(filtered.another_internal).toBeUndefined();
    });

    it('passes event:* keys through alongside allowlisted keys', () => {
      const all = {
        'event:smart-warning:toast': '1',
        'event:bsod-detected:telegram': '0',
        telegram_chat_id: '999',
        not_safe: 'hidden',
      };
      const filtered = filterRendererSafeSettings(all);
      expect(filtered['event:smart-warning:toast']).toBe('1');
      expect(filtered['event:bsod-detected:telegram']).toBe('0');
      expect(filtered.telegram_chat_id).toBe('999');
      expect(filtered.not_safe).toBeUndefined();
    });

    it('returns an empty object when all keys are non-allowlisted', () => {
      const all = { foo: '1', bar: '2', baz: '3' };
      const filtered = filterRendererSafeSettings(all);
      expect(filtered).toEqual({});
    });

    it('returns an empty object when input is empty', () => {
      expect(filterRendererSafeSettings({})).toEqual({});
    });

    it('preserves nvidia_check_cache (the original v2.5.9 bug)', () => {
      // Direct regression: the v2.5.9 bug was that this exact key was
      // dropped. If RENDERER_SAFE_KEYS regresses, this test is the
      // first failure.
      const all = { nvidia_check_cache: '{"ts":12345,"installed":"v1","latest":"v2"}' };
      const filtered = filterRendererSafeSettings(all);
      expect(filtered.nvidia_check_cache).toBe(all.nvidia_check_cache);
    });

    it('does not mutate the input object', () => {
      const all = { telegram_chat_id: '12345', secret: 'x' };
      const before = JSON.stringify(all);
      filterRendererSafeSettings(all);
      expect(JSON.stringify(all)).toBe(before);
    });
  });

  describe('RENDERER_SAFE_KEYS contents', () => {
    it('contains every key currently expected to flow to the renderer', () => {
      // Snapshot test -- if a key is intentionally added or removed, this
      // test must be updated, forcing a deliberate decision instead of a
      // silent drift.
      const expected = [
        'auto_block_rdp_bruteforce',
        'digest_hour',
        'email_digest_recipient',
        // v2.5.17: first-run wizard completion flag
        'first_run_complete',
        // Configurable forecast thresholds (wizard-prep Task 3)
        'forecast_cpu_load_crit',
        'forecast_cpu_load_warn',
        'forecast_cpu_temp_crit',
        'forecast_cpu_temp_warn',
        'forecast_disk_free_crit',
        'forecast_disk_free_warn',
        'forecast_events_crit',
        'forecast_events_warn',
        'forecast_gpu_temp_crit',
        'forecast_gpu_temp_warn',
        'forecast_ram_crit_pct',
        'forecast_ram_warn_pct',
        'nvidia_check_cache',
        'obsidian_archive_dir',
        'quiet_hours_end',
        'quiet_hours_start',
        'selftest_banner',
        'telegram_bot_token',
        'telegram_chat_id',
        'telegram_enabled',
        'telegram_last_good_ts',
      ];
      const actual = Array.from(RENDERER_SAFE_KEYS).sort();
      expect(actual).toEqual(expected);
    });
  });
});
