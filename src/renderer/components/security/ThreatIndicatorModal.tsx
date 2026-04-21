/**
 * Module: ThreatIndicatorModal.tsx
 * Purpose: Click-to-detail modal for a single Security Posture threat
 *          indicator (the Event-4104-driven suspicious_powershell row,
 *          lolbas detections, cryptominer process matches, etc.).
 *          Previously the Threat Indicators panel was display-only —
 *          users could see a detection but had no way to dismiss it,
 *          investigate it, or mark it as a false positive. This modal
 *          gives those affordances.
 *
 * Dependencies:
 *   - react + react-dom/createPortal — renders at document.body so the
 *     backdrop click doesn't bubble into the Security page card.
 *   - `@renderer/lib/ipc` — typed api surface for setSetting /
 *     investigateWithClaude.
 *
 * Used by: `src/renderer/pages/Security.tsx` (state hoisted to the page,
 *          modal rendered at page root, not inside the indicator row).
 *
 * Key decisions:
 *   - State-hoist pattern matches AlertDetailModal — prevents the
 *     click-bubble flash bug v2.4.6 chased for hours.
 *   - Dismiss persisted as `threat_indicator_dismissed_<id>` in the
 *     workbench_settings table. Values are '1'. Security.tsx filters
 *     the indicator list against this set on render.
 *   - "Mark as false positive" writes a second setting (same key, value
 *     '1' plus a `false_positive_<id>` marker) to both dismiss AND
 *     signal the next scan to not re-raise. Actual scan-side suppression
 *     is a v2.4.12 item (needs Get-ThreatIndicators.ps1 to consult the
 *     setting); for v2.4.11 the "FP" action is a user-facing dismiss
 *     that gets surfaced differently in the History view.
 */

import { createPortal } from 'react-dom';
import type { ThreatIndicator } from '@shared/types.js';
import { api } from '@renderer/lib/ipc.js';

interface ThreatIndicatorModalProps {
  indicator: ThreatIndicator;
  onClose: () => void;
  /** Called after a successful dismiss / ack / FP-mark so the page can remove the row. */
  onDismissed: (id: string) => void;
}

/**
 * Compact settings-key helper so Security.tsx and this modal stay in
 * sync on the key format. If you rename, rename both.
 */
export function threatIndicatorDismissedKey(id: string): string {
  return `threat_indicator_dismissed_${id}`;
}
export function threatIndicatorFalsePositiveKey(id: string): string {
  return `threat_indicator_false_positive_${id}`;
}

export function ThreatIndicatorModal({ indicator, onClose, onDismissed }: ThreatIndicatorModalProps) {
  const severityBadge = indicator.severity === 'critical' ? 'bg-status-crit/20 text-status-crit border-status-crit/40'
                      : indicator.severity === 'high'     ? 'bg-status-warn/20 text-status-warn border-status-warn/40'
                      : 'bg-status-info/20 text-status-info border-status-info/40';
  const severityIcon = indicator.severity === 'critical' ? '🔴' : indicator.severity === 'high' ? '⚠' : 'ℹ';

  // Per-category "why this matters" text. Static on the renderer because
  // the scanner doesn't emit a `why` field for threats yet (contrast:
  // Finding.why is backend-sourced in v2.4.6 for alerts). Keep these
  // blurbs short — if the user wants deeper context they click
  // Investigate with Claude.
  const whyByCategory: Record<string, string> = {
    suspicious_powershell:
      'Windows logged a script-block event (Event ID 4104) containing an obfuscation pattern — Base64-heavy, -EncodedCommand flags, or DownloadString callouts. Most of the time this is a legitimate admin or maintenance script (PCDoctor itself triggers this when running takeown / icacls loops). The detector is working as designed — it flags ALL matches and lets you triage.',
    lolbas:
      'A Living-Off-The-Land Binary (LOLBAS) — a built-in Windows tool being used in a non-standard way often indicates an attacker evading AV by using signed Microsoft utilities (certutil, mshta, regsvr32) to execute payloads. Verify the invoking process chain.',
    cryptominer:
      'A process matched known cryptominer binary hashes or CPU-usage fingerprints. If this process is not something you installed intentionally, disconnect from the network and run a Defender full scan immediately.',
    ransomware:
      'File-modification patterns consistent with ransomware encryption — bulk renames to new extensions, rapid writes across user folders. Disconnect network immediately.',
    unusual_parent_child:
      'A process chain that is suspicious in normal user activity (winword.exe launching cmd.exe, for instance). Office macro execution is a common phishing payload carrier.',
    rdp_bruteforce:
      'Multiple failed RDP logon attempts from one or many source IPs. If RDP is not intentionally exposed, disable it (Remote Desktop settings) or firewall-limit to a VPN range.',
  };
  const why = whyByCategory[indicator.category]
    ?? 'No built-in context for this category. Click Investigate with Claude for an interpretation based on the message + detail payload.';

  async function handleDismiss(reason: 'acknowledged' | 'false_positive') {
    try {
      await api.setSetting(threatIndicatorDismissedKey(indicator.id), '1');
      if (reason === 'false_positive') {
        await api.setSetting(threatIndicatorFalsePositiveKey(indicator.id), '1');
      }
    } catch {
      // Non-fatal — worst case the user sees the indicator re-render
      // next time and dismisses again. Don't block the UI.
    }
    onDismissed(indicator.id);
    onClose();
  }

  async function handleInvestigate() {
    const ctx = [
      `Investigate this Windows security threat indicator:`,
      '',
      `Category: ${indicator.category}`,
      `Severity: ${indicator.severity}`,
      `Detected at: ${new Date(indicator.detected_at * 1000).toLocaleString()}`,
      `Message: ${indicator.message}`,
      '',
      'Full indicator payload:',
      '```json',
      JSON.stringify(indicator, null, 2),
      '```',
      '',
      'Tell me whether this looks like a true positive worth action, or benign activity I can dismiss. If action is warranted, what specifically should I do?',
    ].join('\n');
    try { await api.investigateWithClaude(ctx); } catch { /* best effort */ }
    onClose();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { e.stopPropagation(); onClose(); }}
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
    >
      <div
        className="bg-surface-800 border border-surface-600 rounded-lg w-full max-w-2xl max-h-[85vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 p-5 border-b border-surface-600">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <span className={`text-[10px] uppercase tracking-wider border rounded px-2 py-0.5 ${severityBadge}`}>
                {severityIcon} {indicator.severity}
              </span>
              <span className="text-[10px] text-text-secondary">{indicator.category}</span>
              <span className="text-[10px] text-text-secondary">
                {new Date(indicator.detected_at * 1000).toLocaleString()}
              </span>
            </div>
            <h2 className="text-base font-semibold mb-1">Threat Indicator</h2>
            <p className="text-xs text-text-secondary">{indicator.message}</p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-text-secondary hover:text-text-primary text-xl leading-none px-2"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 text-xs">
          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-text-secondary mb-1.5">Why this matters</h3>
            <p className="text-text-primary leading-relaxed">{why}</p>
          </section>

          {indicator.detail && Object.keys(indicator.detail).length > 0 && (
            <section>
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-text-secondary mb-1.5">Detection detail</h3>
              <pre className="text-[10px] text-text-secondary bg-surface-900 border border-surface-700 rounded p-2 whitespace-pre-wrap font-mono max-h-48 overflow-y-auto">
                {JSON.stringify(indicator.detail, null, 2)}
              </pre>
            </section>
          )}

          <section>
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-text-secondary mb-1.5">Your options</h3>
            <ul className="list-disc list-inside space-y-1 text-text-primary">
              <li><strong>Acknowledge</strong> — hide this indicator from the Security page. Keeps the detection in history; does not signal the scanner to stop raising identical events.</li>
              <li><strong>Mark as false positive</strong> — acknowledge + flag for future scanner suppression (v2.4.12 will teach the scanner to suppress matching events).</li>
              <li><strong>Investigate with Claude</strong> — open Claude with the full indicator payload pre-loaded for interpretation.</li>
            </ul>
          </section>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 p-4 border-t border-surface-600">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600 hover:border-status-info/40"
          >
            Close
          </button>
          <button
            onClick={handleInvestigate}
            className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600 hover:border-status-info/40"
          >
            🤖 Investigate with Claude
          </button>
          <button
            onClick={() => handleDismiss('false_positive')}
            className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600 hover:border-status-info/40"
            title="Dismiss and mark as a false positive so future identical detections are suppressed"
          >
            Mark as false positive
          </button>
          <button
            onClick={() => handleDismiss('acknowledged')}
            className="px-3 py-1.5 rounded-md text-xs bg-status-info text-black font-semibold"
          >
            Acknowledge
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
