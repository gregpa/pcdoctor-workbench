import type { Severity } from '@shared/types.js';

/** Color token classname to apply for each severity. */
export const severityColorClass: Record<Severity, string> = {
  good: 'text-status-good',
  warn: 'text-status-warn',
  crit: 'text-status-crit',
  info: 'text-status-info',
};

export const severityBorderClass: Record<Severity, string> = {
  good: 'border-status-good/30 bg-status-good/[0.04]',
  warn: 'border-status-warn/30 bg-status-warn/[0.04]',
  crit: 'border-status-crit/30 bg-status-crit/[0.04]',
  info: 'border-status-info/30 bg-status-info/[0.04]',
};

export const severityStrokeHex: Record<Severity, string> = {
  good: '#22c55e',
  warn: '#f59e0b',
  crit: '#ef4444',
  info: '#3b82f6',
};

/** Classify a percentage value for a "used" metric (higher = worse). */
export function classifyUsed(pct: number, warn: number, crit: number): Severity {
  if (pct >= crit) return 'crit';
  if (pct >= warn) return 'warn';
  return 'good';
}

/** Classify a percentage value for a "free" metric (lower = worse). */
export function classifyFree(pct: number, warnBelow: number, critBelow: number): Severity {
  if (pct <= critBelow) return 'crit';
  if (pct <= warnBelow) return 'warn';
  return 'good';
}

/** Classify a temperature value in °C (CPU/GPU). */
export function classifyTemp(c: number, warnAt: number, critAt: number): Severity {
  if (c >= critAt) return 'crit';
  if (c >= warnAt) return 'warn';
  return 'good';
}
