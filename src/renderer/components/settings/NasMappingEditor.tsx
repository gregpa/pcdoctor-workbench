/**
 * NasMappingEditor — row-based editor for NAS drive mappings (v2.4.44, B36).
 *
 * Replaces the raw-JSON textarea that was in Settings.tsx since v2.4.6.
 * The textarea worked but required users to write valid JSON by hand;
 * a single misplaced comma produced a cryptic parse error and blocked
 * all save attempts. This component exposes the same underlying data
 * shape (`Array<{drive, share}>`) through:
 *
 *   - a drive-letter dropdown per row (A:..Z:, filtering out letters
 *     already claimed by other rows in this editor)
 *   - a plain text input for the share name
 *   - a Remove button per row
 *   - "Add mapping" button
 *   - optional collapsible "raw JSON" escape hatch for power users
 *
 * Validation runs continuously and is surfaced row-by-row. Errors are:
 *   - duplicate drive letters across rows
 *   - empty share name
 *   - forbidden characters in share name (slashes, control chars)
 *
 * The editor is fully controlled. Parent owns the mappings state + save
 * button. onChange fires on any mutation; onValidityChange fires when
 * the overall validity flips (parent disables Save when invalid).
 */
import { useEffect, useMemo, useState } from 'react';

export interface NasMapping {
  drive: string;
  share: string;
}

interface NasMappingEditorProps {
  value: NasMapping[];
  onChange: (next: NasMapping[]) => void;
  onValidityChange?: (valid: boolean) => void;
}

const ALL_DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `${c}:`);
// Drive letters that Windows typically reserves for hardware; we hide
// them from the dropdown to reduce accidental mis-selection. Users can
// still select them via raw JSON if needed.
const LIKELY_RESERVED = new Set(['A:', 'B:', 'C:']);

function validateShare(share: string): string | null {
  if (!share || !share.trim()) return 'Share name required';
  if (/[\\/]/.test(share)) return 'Slashes not allowed';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(share)) return 'Control characters not allowed';
  if (share.length > 128) return 'Too long (max 128 chars)';
  return null;
}

function validateDrive(drive: string, allDrives: string[], ownIndex: number): string | null {
  if (!/^[A-Z]:$/.test(drive)) return 'Pick a drive letter';
  const dupeIndex = allDrives.findIndex((d, i) => i !== ownIndex && d === drive);
  if (dupeIndex !== -1) return `Duplicate of row ${dupeIndex + 1}`;
  return null;
}

export function NasMappingEditor({ value, onChange, onValidityChange }: NasMappingEditorProps) {
  const [showRaw, setShowRaw] = useState(false);
  const [rawText, setRawText] = useState<string>(() => JSON.stringify(value, null, 2));
  const [rawError, setRawError] = useState<string | null>(null);

  // Recompute per-row validation every render; cheap at realistic sizes
  // (handful of mappings) and keeps the UI in lockstep with state.
  const allDrives = value.map((m) => m.drive);
  const rowErrors = useMemo(() => value.map((m, i) => ({
    drive: validateDrive(m.drive, allDrives, i),
    share: validateShare(m.share),
  })), [value, allDrives]);
  const formValid = rowErrors.every((e) => !e.drive && !e.share) && value.length > 0;

  // v2.4.44 (code-reviewer Warning 1): notify parent in useEffect, not
  // during render. Calling a parent's setState during a child's render
  // body violates React 18 rules and can trigger double-render warnings
  // in strict/concurrent mode. The one-render lag is fine: the Save
  // button is evaluated on the next render, which happens on the same
  // user interaction that caused the validity to change.
  useEffect(() => {
    onValidityChange?.(formValid);
  }, [formValid, onValidityChange]);

  function updateRow(i: number, patch: Partial<NasMapping>) {
    const next = value.map((m, idx) => (idx === i ? { ...m, ...patch } : m));
    onChange(next);
    // keep raw-json view in sync if it's open
    if (showRaw) setRawText(JSON.stringify(next, null, 2));
  }
  function addRow() {
    // Default to first un-taken letter.
    const taken = new Set(value.map((m) => m.drive));
    const firstFree = ALL_DRIVE_LETTERS.find((d) => !taken.has(d) && !LIKELY_RESERVED.has(d))
      ?? ALL_DRIVE_LETTERS.find((d) => !taken.has(d))
      ?? 'Z:';
    const next = [...value, { drive: firstFree, share: '' }];
    onChange(next);
    if (showRaw) setRawText(JSON.stringify(next, null, 2));
  }
  function removeRow(i: number) {
    const next = value.filter((_, idx) => idx !== i);
    onChange(next);
    if (showRaw) setRawText(JSON.stringify(next, null, 2));
  }
  function applyRaw() {
    setRawError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (e: any) {
      setRawError(`Invalid JSON: ${e?.message ?? e}`);
      return;
    }
    if (!Array.isArray(parsed)) {
      setRawError('Must be an array.');
      return;
    }
    const coerced: NasMapping[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const m = parsed[i] as any;
      if (!m || typeof m !== 'object' || typeof m.drive !== 'string' || typeof m.share !== 'string') {
        setRawError(`Row ${i + 1}: must be {drive, share}.`);
        return;
      }
      // v2.4.44 (code-reviewer Warning 3): also validate drive letter
      // format here so the "raw JSON" path has the same floor as the
      // dropdown. Row-level validation still catches it downstream,
      // but consistent error point = better UX.
      if (!/^[A-Z]:$/.test(m.drive)) {
        setRawError(`Row ${i + 1}: drive must be "A:" .. "Z:", got ${JSON.stringify(m.drive)}.`);
        return;
      }
      coerced.push({ drive: m.drive, share: m.share });
    }
    onChange(coerced);
  }

  return (
    <div>
      {value.length === 0 && (
        <div className="text-xs text-text-secondary italic mb-2">
          No mappings yet. Click "Add mapping" to start.
        </div>
      )}

      <div className="space-y-2 mb-3">
        {value.map((m, i) => {
          const driveErr = rowErrors[i]?.drive;
          const shareErr = rowErrors[i]?.share;
          const takenByOthers = new Set(value.filter((_, idx) => idx !== i).map((x) => x.drive));
          return (
            <div key={i} className="flex items-start gap-2">
              <div className="flex-shrink-0">
                <select
                  value={m.drive}
                  onChange={(e) => updateRow(i, { drive: e.target.value })}
                  className={`w-20 px-2 py-1.5 text-xs font-mono bg-surface-900 border rounded ${driveErr ? 'border-status-crit' : 'border-surface-600'}`}
                >
                  {/* Ensure the current value is always in the options, even if
                      it collides with another row (validation will flag it). */}
                  {!ALL_DRIVE_LETTERS.includes(m.drive) && (
                    <option value={m.drive}>{m.drive}</option>
                  )}
                  {/* v2.4.44 (code-reviewer Warning 2): also hide A:/B:/C: from
                      the dropdown options (keep them only if already selected
                      on this row). The comment at the top said "hide from
                      dropdown" but the original filter only hid them from
                      addRow defaults. Now UX matches intent. */}
                  {ALL_DRIVE_LETTERS
                    .filter((d) => d === m.drive || (!takenByOthers.has(d) && !LIKELY_RESERVED.has(d)))
                    .map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                </select>
                {driveErr && <div className="text-[10px] text-status-crit mt-0.5">{driveErr}</div>}
              </div>
              <div className="flex-grow">
                <input
                  type="text"
                  value={m.share}
                  onChange={(e) => updateRow(i, { share: e.target.value })}
                  placeholder="share name (e.g. Plex Movies)"
                  className={`w-full px-2 py-1.5 text-xs font-mono bg-surface-900 border rounded ${shareErr ? 'border-status-crit' : 'border-surface-600'}`}
                />
                {shareErr && <div className="text-[10px] text-status-crit mt-0.5">{shareErr}</div>}
              </div>
              <button
                onClick={() => removeRow(i)}
                title="Remove this mapping"
                className="flex-shrink-0 px-2 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600 hover:border-status-crit hover:text-status-crit transition"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-3 mb-3">
        <button
          onClick={addRow}
          className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600 hover:border-status-info"
        >
          + Add mapping
        </button>
        <button
          onClick={() => {
            const next = !showRaw;
            setShowRaw(next);
            if (next) setRawText(JSON.stringify(value, null, 2));
            else setRawError(null);
          }}
          className="text-[10px] text-text-secondary hover:text-text-primary underline-offset-2 hover:underline"
        >
          {showRaw ? '▾ Hide raw JSON' : '▸ Edit raw JSON (advanced)'}
        </button>
      </div>

      {showRaw && (
        <div className="mb-3">
          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={10}
            spellCheck={false}
            className="w-full px-2 py-1.5 text-xs font-mono bg-surface-900 border border-surface-600 rounded resize-y"
          />
          {rawError && (
            <div className="text-xs text-status-crit mt-1 p-2 bg-status-crit/10 border border-status-crit/40 rounded">
              {rawError}
            </div>
          )}
          <button
            onClick={applyRaw}
            className="mt-2 px-3 py-1.5 rounded-md text-xs bg-status-info/20 border border-status-info/40 text-status-info"
          >
            Apply JSON to rows
          </button>
        </div>
      )}
    </div>
  );
}
