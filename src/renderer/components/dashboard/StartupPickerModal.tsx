/**
 * StartupPickerModal (v2.3.0 - C1; v2.4.13 - threshold + allowlist)
 *
 * Multi-select UI for disabling Windows startup entries. Pulls the list from
 * status.metrics.startup_items (emitted by Invoke-PCDoctor.ps1). Pre-checks any
 * entry NOT flagged is_essential, pre-unchecks the essential/protected ones.
 *
 * Emits the final picks via onDisable - caller wires that into the
 * `disable_startup_items_batch` action (params { items_json }).
 *
 * v2.4.13 adds two controls:
 *   - A healthy-threshold number input (stores startup_threshold setting).
 *   - A per-row "Never warn" toggle (stores startup_allowlist setting).
 * Settings changes persist immediately via api.setStartupConfig so the next
 * scan honors them without restart.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { StartupItemMetric, IpcResult } from '@shared/types.js';

export interface StartupPick {
  kind: StartupItemMetric['kind'];
  name: string;
}

export interface StartupPickerModalProps {
  items: StartupItemMetric[];
  onClose: () => void;
  onDisable: (picks: StartupPick[]) => void | Promise<void>;
  /** Threshold below which the scanner considers startup count healthy. */
  threshold?: number;
}

interface StartupConfigApi {
  getStartupConfig?: () => Promise<IpcResult<{ threshold: number; allowlist: string[] }>>;
  setStartupConfig?: (payload: { threshold: number; allowlist: string[] }) => Promise<IpcResult<{}>>;
}

function fmtSize(n?: number): string {
  if (!n || !Number.isFinite(n)) return '-';
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function locationLabel(kind: StartupItemMetric['kind']): string {
  switch (kind) {
    case 'Run': return 'HKCU\\...\\Run';
    case 'HKLM_Run': return 'HKLM\\...\\Run';
    case 'StartupFolder': return 'Startup folder';
    default: return String(kind);
  }
}

const MIN_THRESHOLD = 5;
const MAX_THRESHOLD = 200;

export function StartupPickerModal({ items, onClose, onDisable, threshold = 20 }: StartupPickerModalProps) {
  // Filter to entries not yet disabled in the registry.
  const enabled = useMemo(() => items.filter(i => !i.disabled_in_registry), [items]);

  // Preselection: check non-essential entries, uncheck essential ones.
  const initialPicks = useMemo(() => {
    const out: Record<string, boolean> = {};
    for (const it of enabled) {
      out[`${it.kind}::${it.name}`] = !it.is_essential;
    }
    return out;
  }, [enabled]);
  const [picks, setPicks] = useState<Record<string, boolean>>(initialPicks);

  // v2.4.13: threshold input + per-row allowlist state. Seeded from the
  // prop threshold + the allowlisted flags on each item, then swapped in
  // with the authoritative backend config once getStartupConfig resolves.
  //
  // W3 fix: state is a string so the user can clear the input without it
  // snapping to 0 on every keystroke. Coerced to a number on save via
  // Number(thresholdInput); empty string yields NaN and fails the validator
  // cleanly.
  const [thresholdInput, setThresholdInput] = useState<string>(String(threshold));
  const [allowlist, setAllowlist] = useState<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {};
    for (const it of enabled) {
      if (it.allowlisted) out[`${it.kind}::${it.name}`] = true;
    }
    return out;
  });
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    const api = (window as unknown as { api?: StartupConfigApi }).api;
    if (!api?.getStartupConfig) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.getStartupConfig!();
        if (cancelled || !r.ok) return;
        setThresholdInput(String(r.data.threshold));
        const nextAllow: Record<string, boolean> = {};
        for (const k of r.data.allowlist) nextAllow[k] = true;
        setAllowlist(nextAllow);
      } catch { /* keep prop-seeded values */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggleKey = (key: string) => setPicks(p => ({ ...p, [key]: !p[key] }));
  const toggleAllow = (key: string) => setAllowlist(a => {
    const next = { ...a };
    if (next[key]) delete next[key]; else next[key] = true;
    return next;
  });

  // v2.4.15: per-row "expand to see details" state. Rows collapsed by
  // default; clicking the chevron toggles an inline details row showing
  // the full location path, executable path, publisher, + a web-search
  // link so the user can research unfamiliar startup entries.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const toggleExpand = (key: string) => setExpanded(e => {
    const next = { ...e };
    if (next[key]) delete next[key]; else next[key] = true;
    return next;
  });

  const selectedCount = Object.values(picks).filter(Boolean).length;
  const remaining = enabled.length - selectedCount;
  const remainingAfterAllowlist = Math.max(0, remaining - Object.keys(allowlist).filter(k => !picks[k]).length);
  // W3: thresholdInput is a string; coerce for arithmetic comparison only.
  // Empty / NaN renders the "still above" branch, which is the safer
  // default until the user types a real number.
  const thresholdNum = Number(thresholdInput);
  const thresholdValid = Number.isFinite(thresholdNum) && thresholdNum > 0;
  const thresholdNote = thresholdValid && remainingAfterAllowlist <= thresholdNum
    ? `brings warn-counted startup to ${remainingAfterAllowlist} (under ${thresholdNum} threshold, OK)`
    : `brings warn-counted startup to ${remainingAfterAllowlist} (still above ${thresholdValid ? thresholdNum : 'threshold'})`;

  const allowlistCount = Object.keys(allowlist).length;

  async function handleSaveSettings() {
    const api = (window as unknown as { api?: StartupConfigApi }).api;
    if (!api?.setStartupConfig) { setSaveMsg('Settings API unavailable'); return; }
    // W3: thresholdInput is a string; empty / NaN / non-integer all fail
    // this guard cleanly. Number("") === 0 triggers the <MIN_THRESHOLD
    // branch rather than silently saving 0.
    const trimmed = thresholdInput.trim();
    const t = Number(trimmed);
    if (trimmed.length === 0 || !Number.isInteger(t) || t < MIN_THRESHOLD || t > MAX_THRESHOLD) {
      setSaveMsg(`Threshold must be ${MIN_THRESHOLD}-${MAX_THRESHOLD}`);
      return;
    }
    setSaving(true);
    setSaveMsg(null);
    try {
      const r = await api.setStartupConfig({ threshold: t, allowlist: Object.keys(allowlist) });
      if (r.ok) {
        setSaveMsg(`Saved. Next scan uses threshold=${t}, allowlist=${allowlistCount}.`);
      } else {
        setSaveMsg(`Save failed: ${r.error?.message ?? 'unknown error'}`);
      }
    } catch (e) {
      setSaveMsg(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleDisable() {
    const selected: StartupPick[] = enabled
      .filter(it => picks[`${it.kind}::${it.name}`])
      .map(it => ({ kind: it.kind, name: it.name }));
    if (selected.length === 0) return;
    await onDisable(selected);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Disable startup items"
    >
      <div
        className="pcd-modal w-full max-w-6xl p-5 shadow-2xl max-h-[90vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold mb-1 flex items-center gap-2">
          <span>🚫</span><span>Disable startup items</span>
        </h2>
        <div className="text-[11px] text-text-secondary mb-3">
          {enabled.length} enabled entries. Protected/essential apps are pre-unchecked;
          everything else is pre-checked. Review before disabling.
        </div>

        {/* v2.4.13: settings block - threshold + allowlist summary. */}
        <div className="mb-3 border border-surface-600 rounded-lg p-3 bg-surface-900/40">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary font-semibold mb-2">
            Alert settings
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-[11px] flex items-center gap-2">
              <span>Healthy threshold:</span>
              <input
                type="number"
                min={MIN_THRESHOLD}
                max={MAX_THRESHOLD}
                value={thresholdInput}
                onChange={(e) => setThresholdInput(e.target.value)}
                className="w-16 px-2 py-1 rounded pcd-button text-text-primary text-[11px]"
                aria-label="Healthy startup threshold"
              />
              <span className="text-text-secondary">items ({MIN_THRESHOLD}-{MAX_THRESHOLD})</span>
            </label>
            <span className="text-[11px] text-text-secondary">
              Allowlisted: <span className="font-semibold text-text-primary">{allowlistCount}</span>
              {' '}(tick the star on a row to add).
            </span>
            <button
              onClick={handleSaveSettings}
              disabled={saving}
              className="px-2 py-1 rounded-md text-[11px] bg-status-info/20 border border-status-info/50 text-status-info disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save settings'}
            </button>
            {saveMsg && (
              <span className="text-[10px] text-text-secondary italic">{saveMsg}</span>
            )}
          </div>
        </div>

        <div className="overflow-auto border border-surface-700 rounded-lg flex-1">
          <table className="w-full text-[11px]">
            <thead className="bg-surface-700 text-text-secondary text-[10px] uppercase tracking-wider sticky top-0">
              <tr>
                <th className="text-left px-2 py-1.5 w-6" title="Expand for details"></th>
                <th className="text-left px-2 py-1.5 w-8"></th>
                <th className="text-left px-2 py-1.5 w-6"></th>
                <th className="text-left px-2 py-1.5">Name</th>
                <th className="text-left px-2 py-1.5">Location</th>
                <th className="text-left px-2 py-1.5">Publisher</th>
                <th className="text-right px-2 py-1.5">Size</th>
                <th className="text-left px-2 py-1.5 w-20">Role</th>
                <th className="text-center px-2 py-1.5 w-16" title="Never warn about this item">Never warn</th>
              </tr>
            </thead>
            <tbody>
              {enabled.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-6 text-center text-text-secondary">
                    No enabled startup items found in the current scan. Run a scan first.
                  </td>
                </tr>
              )}
              {enabled.map((it) => {
                const key = `${it.kind}::${it.name}`;
                const isOpen = !!expanded[key];
                const searchQuery = encodeURIComponent(`${it.name} startup windows`);
                return (
                  <React.Fragment key={key}>
                    <tr
                      className="border-t border-surface-700 hover:bg-surface-700/40 cursor-pointer"
                      onClick={() => toggleKey(key)}
                    >
                      <td className="px-2 py-1.5 text-center" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => toggleExpand(key)}
                          title={isOpen ? 'Hide details' : 'Show details about this startup item'}
                          aria-label={isOpen ? `Collapse ${it.name} details` : `Expand ${it.name} details`}
                          aria-expanded={isOpen}
                          className="text-text-secondary hover:text-text-primary text-xs w-4"
                        >
                          {isOpen ? '▾' : '▸'}
                        </button>
                      </td>
                      <td className="px-2 py-1.5">
                        <input
                          type="checkbox"
                          aria-label={`Disable ${it.name}`}
                          checked={!!picks[key]}
                          onChange={() => toggleKey(key)}
                          onClick={(e) => e.stopPropagation()}
                        />
                      </td>
                      <td className="px-2 py-1.5 text-text-secondary">
                        {it.is_essential ? '🛡' : '•'}
                      </td>
                      <td className="px-2 py-1.5 font-mono">{it.name}</td>
                      <td className="px-2 py-1.5 text-text-secondary">{locationLabel(it.kind)}</td>
                      <td className="px-2 py-1.5 text-text-secondary truncate max-w-[160px]">{it.publisher ?? '-'}</td>
                      <td className="px-2 py-1.5 text-right text-text-secondary">{fmtSize(it.size_bytes)}</td>
                      <td className="px-2 py-1.5">
                        {it.is_essential ? (
                          <span className="text-[10px] text-status-good">protected</span>
                        ) : (
                          <span className="text-[10px] text-text-secondary">optional</span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-center" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          onClick={() => toggleAllow(key)}
                          title={allowlist[key]
                            ? 'Allowlisted - excluded from the alert count'
                            : 'Click to stop warning about this item'}
                          aria-label={allowlist[key]
                            ? `Remove ${it.name} from allowlist`
                            : `Add ${it.name} to allowlist`}
                          className={
                            allowlist[key]
                              ? 'text-status-warn text-sm'
                              : 'text-text-secondary text-sm hover:text-status-warn'
                          }
                        >
                          {allowlist[key] ? '★' : '☆'}
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-t border-surface-700 bg-surface-900/30">
                        <td colSpan={9} className="px-4 py-3">
                          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px]">
                            <span className="text-text-secondary">Name</span>
                            <span className="font-mono break-all">{it.name}</span>

                            <span className="text-text-secondary">Kind</span>
                            <span>{locationLabel(it.kind)}</span>

                            <span className="text-text-secondary">Full location</span>
                            <span className="font-mono break-all">{it.location}</span>

                            <span className="text-text-secondary">Path / command</span>
                            <span className="font-mono break-all">{it.path ?? '(not captured)'}</span>

                            <span className="text-text-secondary">Publisher</span>
                            <span>{it.publisher ?? '(unknown)'}</span>

                            <span className="text-text-secondary">Size</span>
                            <span>{fmtSize(it.size_bytes)}</span>

                            <span className="text-text-secondary">Role</span>
                            <span>
                              {it.is_essential ? (
                                <>🛡 <span className="text-status-good">protected</span> - pre-unchecked because this app has been flagged as load-bearing (Greg's essentials list: SecurityHealth, OneDrive, Teams, LGHUB, Notifiarr, PrivateVpn, GoogleDriveFS, GoldKey, Docker, Plex).</>
                              ) : (
                                <>• <span className="text-text-secondary">optional</span> - no known dependency on this running at boot.</>
                              )}
                            </span>

                            <span className="text-text-secondary">Allowlist</span>
                            <span>{allowlist[key] ? '★ pinned (warn count excludes this)' : '☆ not pinned'}</span>

                            <span className="text-text-secondary">Research</span>
                            <span>
                              <a
                                href={`https://www.google.com/search?q=${searchQuery}`}
                                target="_blank"
                                rel="noreferrer noopener"
                                className="text-status-info hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                Search the web for "{it.name}"
                              </a>
                              <span className="text-text-secondary"> - what it does, whether it's safe to disable</span>
                            </span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mt-3 text-[11px] text-text-secondary">
          Disabling <span className="font-semibold text-text-primary">{selectedCount}</span> of
          {' '}<span className="font-semibold text-text-primary">{enabled.length}</span>; {thresholdNote}
        </div>

        <div className="flex justify-end gap-2 mt-3 pt-3 border-t border-surface-700">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs pcd-button"
          >
            Cancel
          </button>
          <button
            onClick={handleDisable}
            disabled={selectedCount === 0}
            className="px-3 py-1.5 rounded-md text-xs bg-status-warn text-black font-semibold disabled:opacity-50"
          >
            Disable Selected ({selectedCount})
          </button>
        </div>
      </div>
    </div>
  );
}
