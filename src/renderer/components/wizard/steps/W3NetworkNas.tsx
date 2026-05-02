/**
 * W3 Network & NAS -- third step of the first-run wizard (index 2).
 *
 * Auto-detects mapped network drives via getNasDrives(), extracts the
 * NAS server hostname/IP from UNC paths, and lets the user configure
 * drive mappings and NAS brand. Saves config on unmount (step change).
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useWizard } from '../WizardContext.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NasDrive {
  letter: string;
  unc: string | null;
  volume_name: string | null;
  kind: 'network' | 'local' | 'removable';
  used_bytes: number | null;
  free_bytes: number | null;
  total_bytes: number | null;
  recycle_bytes: number | null;
  reachable: boolean;
}

interface DriveMapping {
  drive: string;
  share: string;
  source: 'detected' | 'manual';
}

type NasBrand = 'qnap' | 'synology' | 'other';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract server hostname/IP from a UNC path like \\192.168.50.226\share */
function parseServer(unc: string): string | null {
  const m = unc.match(/^\\\\([^\\]+)/);
  return m ? m[1] : null;
}

/** Extract share name from a UNC path like \\192.168.50.226\Plex Movies */
function parseShare(unc: string): string | null {
  const m = unc.match(/^\\\\[^\\]+\\(.+)/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ToggleButtons({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex gap-2">
      <button
        type="button"
        onClick={() => onChange(true)}
        className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${
          value
            ? 'bg-status-info text-white'
            : 'bg-surface-700 text-text-secondary border border-surface-600 hover:bg-surface-600'
        }`}
      >
        Yes
      </button>
      <button
        type="button"
        onClick={() => onChange(false)}
        className={`px-4 py-1.5 rounded-md text-sm font-medium transition ${
          !value
            ? 'bg-status-info text-white'
            : 'bg-surface-700 text-text-secondary border border-surface-600 hover:bg-surface-600'
        }`}
      >
        No
      </button>
    </div>
  );
}

function BrandRadio({
  value,
  onChange,
}: {
  value: NasBrand;
  onChange: (v: NasBrand) => void;
}) {
  const options: Array<{ id: NasBrand; label: string }> = [
    { id: 'qnap', label: 'QNAP' },
    { id: 'synology', label: 'Synology' },
    { id: 'other', label: 'Other' },
  ];
  return (
    <div className="flex gap-3">
      {options.map((o) => (
        <label key={o.id} className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="radio"
            name="nas-brand"
            value={o.id}
            checked={value === o.id}
            onChange={() => onChange(o.id)}
            className="accent-status-info"
          />
          <span className="text-sm text-text-primary">{o.label}</span>
        </label>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function W3NetworkNas() {
  const { dispatch, markComplete } = useWizard();

  // Loading / error
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // NAS toggle
  const [nasEnabled, setNasEnabled] = useState(false);

  // Config fields
  const [server, setServer] = useState('');
  const [brand, setBrand] = useState<NasBrand>('other');
  const [mappings, setMappings] = useState<DriveMapping[]>([]);

  // Track whether auto-detection populated values (for defaulting toggle)
  const autoDetectedRef = useRef(false);

  // ── Fetch drives on mount ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.api.getNasDrives();
        if (cancelled) return;
        if (result.ok) {
          const networkDrives = result.data.filter(
            (d: NasDrive) => d.kind === 'network' && d.unc,
          );

          if (networkDrives.length > 0) {
            autoDetectedRef.current = true;
            setNasEnabled(true);

            // Extract server from first UNC path
            const firstServer = parseServer(networkDrives[0].unc!);
            if (firstServer) setServer(firstServer);

            // Build drive mappings
            const detected: DriveMapping[] = networkDrives.map((d: NasDrive) => ({
              drive: d.letter,
              share: parseShare(d.unc!) ?? '',
              source: 'detected' as const,
            }));
            setMappings(detected);
          } else {
            setNasEnabled(false);
          }
        } else {
          setError(result.error?.message ?? 'Failed to detect network drives.');
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to detect network drives.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Add manual mapping ──
  const addMapping = useCallback(() => {
    setMappings((prev) => [...prev, { drive: '', share: '', source: 'manual' }]);
  }, []);

  // ── Remove mapping ──
  const removeMapping = useCallback((index: number) => {
    setMappings((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // ── Update mapping field ──
  const updateMapping = useCallback(
    (index: number, field: 'drive' | 'share', value: string) => {
      setMappings((prev) =>
        prev.map((m, i) => (i === index ? { ...m, [field]: value } : m)),
      );
    },
    [],
  );

  // ── Save on unmount ──
  const saveConfig = useCallback(async () => {
    try {
      // Always save nas_enabled
      await window.api.setSetting('nas_enabled', nasEnabled ? '1' : '0');
      await window.api.setSetting('nas_brand', brand);

      if (nasEnabled && server.trim()) {
        const nasMappings = mappings
          .filter((m) => m.drive.trim() && m.share.trim())
          .map((m) => ({ drive: m.drive.trim(), share: m.share.trim() }));

        await window.api.setNasConfig({
          nas_server: server.trim(),
          nas_mappings: nasMappings,
        });

        dispatch({
          type: 'SET_NAS_CONFIG',
          payload: { nasServer: server.trim(), nasMappings },
        });
      }
    } catch {
      // Non-fatal -- NAS config can be adjusted later in Settings.
    }
  }, [nasEnabled, server, brand, mappings, dispatch]);

  useEffect(() => {
    return () => {
      void saveConfig();
      markComplete(2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveConfig]);

  // ── Loading state ──
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-4">
        <div className="w-8 h-8 border-2 border-status-info border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-text-secondary">Detecting network drives&hellip;</p>
      </div>
    );
  }

  // ── Error state (non-blocking -- show toggle anyway) ──
  // We still allow manual config even if detection failed.

  return (
    <div className="flex flex-col gap-5 py-2">
      {/* Header */}
      <div>
        <h2 className="text-lg font-bold text-text-primary">Network & NAS</h2>
        <p className="text-sm text-text-secondary mt-0.5">
          Configure your NAS (network-attached storage) for drive mapping and @Recycle cleanup.
        </p>
      </div>

      {/* Error banner (if detection failed but we still show the form) */}
      {error && (
        <div className="rounded-lg border border-status-warn/30 bg-status-warn/10 px-4 py-3">
          <p className="text-sm text-status-warn">
            Could not auto-detect network drives. You can configure NAS settings manually.
          </p>
          <p className="text-xs text-text-secondary mt-1">{error}</p>
        </div>
      )}

      {/* NAS Toggle */}
      <div className="flex items-center gap-4">
        <span className="text-sm text-text-primary font-medium">
          Do you have a NAS?
        </span>
        <ToggleButtons value={nasEnabled} onChange={setNasEnabled} />
      </div>

      {/* ── NAS Disabled ── */}
      {!nasEnabled && (
        <div className="rounded-lg border border-surface-600 bg-surface-700/50 px-4 py-3">
          <p className="text-sm text-text-secondary">
            NAS features (drive mapping, @Recycle cleanup) will be hidden. You can enable them later in Settings.
          </p>
        </div>
      )}

      {/* ── NAS Enabled ── */}
      {nasEnabled && (
        <>
          {/* Server IP */}
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">
              Server IP / Hostname
            </label>
            <input
              type="text"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              placeholder="e.g. 192.168.1.100"
              className="w-full px-3 py-2 rounded-md border border-surface-600 bg-surface-800 text-text-primary text-sm placeholder:text-text-secondary/50"
              aria-label="NAS server address"
            />
          </div>

          {/* NAS Brand */}
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1.5">
              NAS Brand
            </label>
            <BrandRadio value={brand} onChange={setBrand} />
          </div>

          {/* Drive Mappings Table */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-semibold text-text-primary">
                Drive Mappings
              </h3>
              <button
                type="button"
                onClick={addMapping}
                className="px-3 py-1 rounded-md text-xs font-medium bg-surface-700 border border-surface-600 text-text-secondary hover:bg-surface-600 transition"
              >
                + Add Mapping
              </button>
            </div>

            {mappings.length === 0 ? (
              <p className="text-xs text-text-secondary italic">
                No drive mappings configured.
              </p>
            ) : (
              <div className="border border-surface-600 rounded-lg overflow-hidden">
                {/* Table header */}
                <div className="grid grid-cols-[80px_1fr_90px_40px] gap-2 px-3 py-2 bg-surface-700/80 text-xs font-semibold text-text-secondary uppercase tracking-wide">
                  <span>Drive</span>
                  <span>Share Name</span>
                  <span>Source</span>
                  <span />
                </div>
                {/* Table rows */}
                {mappings.map((m, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[80px_1fr_90px_40px] gap-2 px-3 py-2 border-t border-surface-600 items-center"
                  >
                    <input
                      type="text"
                      value={m.drive}
                      onChange={(e) => updateMapping(i, 'drive', e.target.value)}
                      placeholder="M:"
                      className="px-2 py-1 rounded border border-surface-600 bg-surface-800 text-text-primary text-sm"
                      aria-label={`Drive letter row ${i + 1}`}
                    />
                    <input
                      type="text"
                      value={m.share}
                      onChange={(e) => updateMapping(i, 'share', e.target.value)}
                      placeholder="Share name"
                      className="px-2 py-1 rounded border border-surface-600 bg-surface-800 text-text-primary text-sm"
                      aria-label={`Share name row ${i + 1}`}
                    />
                    <span className="text-xs text-text-secondary">
                      {m.source === 'detected' ? (
                        <span className="inline-flex items-center gap-1 text-status-good">
                          Detected
                        </span>
                      ) : (
                        'Manual'
                      )}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeMapping(i)}
                      className="text-text-secondary hover:text-status-warn transition text-sm"
                      aria-label={`Remove mapping row ${i + 1}`}
                    >
                      X
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Summary */}
            <p className="text-xs text-text-secondary mt-2">
              {mappings.length} drive{mappings.length !== 1 ? 's' : ''} configured
            </p>
          </div>
        </>
      )}
    </div>
  );
}
