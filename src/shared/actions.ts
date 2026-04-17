import type { ActionName } from './types.js';

export type ConfirmLevel = 'none' | 'risky' | 'destructive';
export type RollbackTier = 'A' | 'B' | 'C' | 'none';

export interface ActionDefinition {
  name: ActionName;
  label: string;
  ps_script: string;              // path relative to C:\ProgramData\PCDoctor\
  confirm_level: ConfirmLevel;
  rollback_tier: RollbackTier;
  estimated_duration_s: number;
  category: 'cleanup' | 'repair' | 'network' | 'service' | 'security' | 'perf' | 'update';
  tooltip: string;
}

export const ACTIONS: Record<ActionName, ActionDefinition> = {
  flush_dns: {
    name: 'flush_dns',
    label: 'Flush DNS',
    ps_script: 'actions/Flush-DNS.ps1',
    confirm_level: 'none',
    rollback_tier: 'C',
    estimated_duration_s: 2,
    category: 'network',
    tooltip:
      'Clears the Windows DNS resolver cache (ipconfig /flushdns). Fixes stale domain lookups after VPN changes or DNS outages. Instant.',
  },
};
