import type { Severity } from '@shared/types.js';
import { severityStrokeHex } from '@renderer/lib/thresholds.js';

interface GaugeProps {
  /** Value in range 0–100 (values >100 clamp to 100). */
  value: number;
  /** Large text shown in the centre (e.g., "82°C"). */
  display: string;
  /** Small text shown below display (e.g., "THROTTLING" or "19.5 / 32 GB"). */
  subtext: string;
  severity: Severity;
  /** Label shown at the top of the gauge (e.g., "CPU Temperature"). */
  label: string;
}

// 270° arc starting at 135° (7 o'clock position) going clockwise to 45° (5 o'clock).
// circle r=70 → circumference = 2π*70 = 439.823
// 270° arc = 75% of circumference = 329.867
// 90° gap = 25% = 109.956
const BG_ARC_LENGTH = 329.867;
const GAP_LENGTH = 109.956;
const ROTATION = 135;
const RADIUS = 70;
const CENTRE_X = 100;
const CENTRE_Y = 95;

export function Gauge({ value, display, subtext, severity, label }: GaugeProps) {
  const clamped = Math.max(0, Math.min(100, value));
  const fillLength = (clamped / 100) * BG_ARC_LENGTH;
  const remaining = BG_ARC_LENGTH + GAP_LENGTH - fillLength;
  const stroke = severityStrokeHex[severity];

  return (
    <div className="text-center">
      <div className="text-[9.5px] text-text-secondary uppercase tracking-wider mb-1">{label}</div>
      <svg viewBox="0 0 200 155" className="w-full">
        {/* Background arc */}
        <circle
          cx={CENTRE_X}
          cy={CENTRE_Y}
          r={RADIUS}
          fill="none"
          stroke="#21262d"
          strokeWidth={13}
          strokeDasharray={`${BG_ARC_LENGTH} ${GAP_LENGTH}`}
          strokeLinecap="round"
          transform={`rotate(${ROTATION} ${CENTRE_X} ${CENTRE_Y})`}
        />
        {/* Value arc */}
        <circle
          cx={CENTRE_X}
          cy={CENTRE_Y}
          r={RADIUS}
          fill="none"
          stroke={stroke}
          strokeWidth={13}
          strokeDasharray={`${fillLength} ${remaining}`}
          strokeLinecap="round"
          transform={`rotate(${ROTATION} ${CENTRE_X} ${CENTRE_Y})`}
        />
        <text x={CENTRE_X} y="100" textAnchor="middle" fill={stroke} fontSize="28" fontWeight="800" fontFamily="sans-serif">
          {display}
        </text>
        <text x={CENTRE_X} y="118" textAnchor="middle" fill="#8b949e" fontSize="10" fontFamily="sans-serif">
          {subtext}
        </text>
      </svg>
    </div>
  );
}
