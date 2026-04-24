import type { KeyboardEvent } from 'react';
import type { Trend, Severity } from '@shared/types.js';
import { severityStrokeHex } from '@renderer/lib/thresholds.js';

interface TrendLineProps {
  title: string;
  trend: Trend;
  severity?: Severity;
  height?: number;
  yDomain?: [number, number];
  onExpand?: () => void;
}

export function TrendLine({ title, trend, severity = 'info', height = 120, yDomain, onExpand }: TrendLineProps) {
  const { points } = trend;
  const W = 400;
  const H = height;
  const padL = 28, padR = 10, padT = 10, padB = 22;
  const iw = W - padL - padR;
  const ih = H - padT - padB;

  if (points.length < 2) {
    return (
      <div className="bg-surface-800 border border-surface-600 rounded-lg p-3 panel-contain">
        <div className="text-[9.5px] uppercase tracking-wider text-text-secondary mb-1">{title}</div>
        <div className="h-24 flex items-center justify-center text-xs text-text-secondary">
          Insufficient data · {points.length} point{points.length === 1 ? '' : 's'}
        </div>
      </div>
    );
  }

  const values = points.map(p => p.value);
  const min = yDomain ? yDomain[0] : Math.min(...values);
  const max = yDomain ? yDomain[1] : Math.max(...values);
  const range = max - min || 1;
  const tMin = points[0].ts;
  const tMax = points[points.length - 1].ts;
  const tRange = tMax - tMin || 1;

  const x = (ts: number) => padL + (iw * (ts - tMin)) / tRange;
  const y = (v: number) => padT + ih - (ih * (v - min)) / range;

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.ts)},${y(p.value)}`).join(' ');
  const stroke = severityStrokeHex[severity];
  const lastPt = points[points.length - 1];

  // Y-axis ticks at min, mid, max
  const ticks = [min, (min + max) / 2, max];

  const interactive = !!onExpand;
  const wrapperProps = interactive
    ? {
        // v2.4.42: panel-contain scopes layout recalc to this SVG panel
        // instead of letting Chromium walk the whole Dashboard tree on
        // every resize pixel. The SVG uses viewBox + w-full so paint
        // containment is safe (nothing escapes the tile).
        className: 'bg-surface-800 border border-surface-600 rounded-lg p-3 panel-contain cursor-pointer hover:border-surface-500 transition-colors group',
        onClick: onExpand,
        role: 'button' as const,
        tabIndex: 0,
        title: 'Click to expand',
        onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onExpand?.(); } },
      }
    : { className: 'bg-surface-800 border border-surface-600 rounded-lg p-3 panel-contain' };

  return (
    <div {...wrapperProps}>
      <div className="flex items-center justify-between mb-1">
        <div className="text-[9.5px] uppercase tracking-wider text-text-secondary">{title}</div>
        {interactive && (
          <div className="text-[9px] text-text-secondary opacity-0 group-hover:opacity-100 transition-opacity">Click to expand</div>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="#30363d" strokeWidth="0.5" strokeDasharray="2,2" />
            <text x={padL - 4} y={y(t) + 3} fontSize="8" fill="#8b949e" textAnchor="end">{Math.round(t)}</text>
          </g>
        ))}
        <path d={pathD} stroke={stroke} strokeWidth="2" fill="none" />
        <circle cx={x(lastPt.ts)} cy={y(lastPt.value)} r="3" fill={stroke} />
        {points.length > 1 && (
          <>
            <text x={padL} y={H - 4} fontSize="8" fill="#8b949e">{new Date(tMin * 1000).toLocaleDateString(undefined, { weekday: 'short' })}</text>
            <text x={W - padR} y={H - 4} fontSize="8" fill="#8b949e" textAnchor="end">today</text>
          </>
        )}
      </svg>
    </div>
  );
}
