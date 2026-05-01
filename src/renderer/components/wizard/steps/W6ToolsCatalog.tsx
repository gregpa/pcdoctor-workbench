/**
 * W6 Tools Catalog — sixth step of the first-run wizard (index 5).
 *
 * Displays all available diagnostic tools grouped by category, shows
 * installed/not-installed status, and lets the user select which tools
 * they want installed. Selections are stored in wizard state; actual
 * installs happen later (from the Tools page or W10 Finish).
 */

import { useEffect, useState, useRef } from 'react';
import { useWizard } from '../WizardContext.js';
import { TOOLS, TOOL_CATEGORIES } from '@shared/tools.js';
import type { ToolStatus } from '@shared/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a set of installed tool IDs from ToolStatus[]. */
function buildInstalledSet(statuses: ToolStatus[]): Set<string> {
  const s = new Set<string>();
  for (const t of statuses) if (t.installed) s.add(t.id);
  return s;
}

/** Category display labels from TOOL_CATEGORIES keyed by category id. */
const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(
  TOOL_CATEGORIES.map((c) => [c.id, c.label]),
);

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ToolCard({
  id,
  name,
  icon,
  description,
  installed,
  selected,
  onToggle,
}: {
  id: string;
  name: string;
  icon: string;
  description: string;
  installed: boolean;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  return (
    <label
      htmlFor={`tool-${id}`}
      className={`rounded-lg border px-4 py-3 flex items-start gap-3 cursor-pointer transition ${
        selected
          ? 'border-status-info bg-status-info/10'
          : 'border-surface-600 bg-surface-700/50 hover:bg-surface-700'
      }`}
    >
      {/* Checkbox */}
      <input
        id={`tool-${id}`}
        type="checkbox"
        checked={selected}
        onChange={() => onToggle(id)}
        className="mt-1 accent-status-info"
      />

      {/* Icon */}
      <span className="text-xl leading-none mt-0.5">{icon}</span>

      {/* Body */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text-primary">{name}</span>
          {installed ? (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-status-good/20 text-status-good">
              Installed
            </span>
          ) : (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-surface-600 text-text-secondary">
              Not Installed
            </span>
          )}
        </div>
        <p className="text-xs text-text-secondary mt-0.5 line-clamp-2">{description}</p>
      </div>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function W6ToolsCatalog() {
  const { state, dispatch, markComplete } = useWizard();

  // Fetch state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installedSet, setInstalledSet] = useState<Set<string>>(new Set());

  // Selection state — initialise from wizard state if re-visiting
  const [selected, setSelected] = useState<Set<string>>(new Set(state.selectedTools));

  // Ref to track latest selected for the unmount cleanup
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // Fetch installed tool statuses on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.api.listTools();
        if (cancelled) return;
        if (result.ok) {
          const inst = buildInstalledSet(result.data);
          setInstalledSet(inst);

          // If first visit (no prior selections), pre-select not-installed tools
          if (state.selectedTools.length === 0) {
            const preSelected = new Set<string>();
            for (const [id, def] of Object.entries(TOOLS)) {
              // Pre-select tools that aren't installed and aren't native (native are always available)
              if (!inst.has(id) && def.category !== 'native') {
                preSelected.add(id);
              }
            }
            setSelected(preSelected);
          }
        } else {
          setError(result.error?.message ?? 'Unknown error checking tools.');
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to check installed tools.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist selections and mark complete on unmount
  useEffect(() => {
    return () => {
      dispatch({ type: 'SET_FIELD', field: 'selectedTools', value: [...selectedRef.current] });
      markComplete(5);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toggle a tool in the selection set
  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Group tools by category
  const toolsByCategory = TOOL_CATEGORIES.map((cat) => ({
    ...cat,
    tools: Object.values(TOOLS).filter((t) => t.category === cat.id),
  })).filter((g) => g.tools.length > 0);

  const selectedCount = [...selected].filter((id) => !installedSet.has(id)).length;

  // ── Loading state ──
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-4">
        <div className="w-8 h-8 border-2 border-status-info border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-text-secondary">Checking installed tools&hellip;</p>
      </div>
    );
  }

  // ── Error state (non-blocking — still show catalog) ──
  if (error) {
    return (
      <div className="flex flex-col gap-4 py-4">
        <div className="rounded-lg border border-status-warn/30 bg-status-warn/10 px-4 py-3">
          <p className="text-sm text-status-warn">
            Could not check installed tools. You can manage tools from the Tools page later.
          </p>
          <p className="text-xs text-text-secondary mt-1">{error}</p>
        </div>
      </div>
    );
  }

  // ── Success state ──
  return (
    <div className="flex flex-col gap-5 py-2">
      {/* Header */}
      <div>
        <h2 className="text-lg font-bold text-text-primary">Diagnostic Tools</h2>
        <p className="text-sm text-text-secondary mt-0.5">
          Select tools to install. Already-installed tools are marked with a checkmark.
        </p>
      </div>

      {/* Grouped tool cards */}
      {toolsByCategory.map((group) => (
        <div key={group.id}>
          <h3 className="text-sm font-semibold text-text-primary mb-2">
            {group.label}
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {group.tools.map((tool) => (
              <ToolCard
                key={tool.id}
                id={tool.id}
                name={tool.name}
                icon={tool.icon}
                description={tool.description}
                installed={installedSet.has(tool.id)}
                selected={selected.has(tool.id)}
                onToggle={toggle}
              />
            ))}
          </div>
        </div>
      ))}

      {/* Summary */}
      <div className="pt-2 border-t border-surface-600">
        <p className="text-sm text-text-secondary">
          {selectedCount > 0
            ? `${selectedCount} tool${selectedCount !== 1 ? 's' : ''} selected for installation.`
            : 'No new tools selected for installation.'}
        </p>
        <p className="text-xs text-text-secondary mt-1">
          Selected tools can be installed from the Tools page after setup.
        </p>
      </div>
    </div>
  );
}
