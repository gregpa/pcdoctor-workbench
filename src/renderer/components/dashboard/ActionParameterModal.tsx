import { useState } from 'react';
import type { ActionDefinition } from '@shared/actions.js';

interface ActionParameterModalProps {
  action: ActionDefinition;
  onSubmit: (params: Record<string, string>, dryRun: boolean) => void;
  onCancel: () => void;
}

export function ActionParameterModal({ action, onSubmit, onCancel }: ActionParameterModalProps) {
  const schema = action.params_schema ?? {};
  const fields = Object.entries(schema);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const [k] of fields) initial[k] = '';
    return initial;
  });
  const [dryRun, setDryRun] = useState(false);

  const canSubmit = fields.every(([k, s]) => !s.required || values[k]?.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div className="pcd-modal w-full max-w-md p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-lg">{action.icon}</span>
          <h2 className="text-base font-semibold">{action.label}</h2>
        </div>
        <div className="text-xs text-text-secondary mb-4">{action.tooltip}</div>

        {fields.length === 0 ? (
          <div className="text-xs text-text-secondary italic mb-3">No parameters required.</div>
        ) : (
          <div className="space-y-3 mb-4">
            {fields.map(([name, schema]) => (
              <div key={name}>
                <label className="block text-[10px] uppercase tracking-wider text-text-secondary mb-1">
                  {name}{schema.required ? ' *' : ''}
                </label>
                <input
                  type={schema.type === 'number' ? 'number' : 'text'}
                  value={values[name] ?? ''}
                  onChange={(e) => setValues(v => ({ ...v, [name]: e.target.value }))}
                  placeholder={schema.description}
                  className="w-full px-3 py-2 rounded-md bg-surface-900 border border-surface-600 text-xs"
                  autoFocus={name === fields[0][0]}
                />
                <div className="text-[10px] text-text-secondary mt-1">{schema.description}</div>
              </div>
            ))}
          </div>
        )}

        <label className="flex items-center gap-2 text-xs mb-3 cursor-pointer">
          <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          <span>Dry run (show what would happen, don't actually do it)</span>
        </label>

        <div className="text-[10px] text-text-secondary mb-3">
          Rollback tier: <strong>{action.rollback_tier}</strong> · Estimated duration: <strong>~{action.estimated_duration_s}s</strong>
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600">Cancel</button>
          <button
            onClick={() => canSubmit && onSubmit(values, dryRun)}
            disabled={!canSubmit}
            className="px-3 py-1.5 rounded-md text-xs bg-[#238636] text-white font-semibold disabled:opacity-50"
          >
            {dryRun ? 'Dry Run' : 'Run'}
          </button>
        </div>
      </div>
    </div>
  );
}
