import type { Trend } from '@shared/types.js';

interface TrendBarProps {
  title: string;
  trend: Trend;
  /** Color each bar based on value vs threshold */
  warnAt?: number;
  critAt?: number;
  height?: number;
}

export function TrendBar({ title, trend, warnAt, critAt, height = 120 }: TrendBarProps) {
  const W = 400;
  const H = height;
  const padL = 28, padR = 10, padT = 10, padB = 22;
  const iw = W - padL - padR;
  const ih = H - padT - padB;

  const points = trend.points;
  if (points.length === 0) {
    return (
      <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
        <div className="text-[9.5px] uppercase tracking-wider text-text-secondary mb-1">{title}</div>
        <div className="h-24 flex items-center justify-center text-xs text-text-secondary">No data</div>
      </div>
    );
  }

  const max = Math.max(...points.map(p => p.value), 1);
  const barW = iw / Math.max(points.length, 1) * 0.7;
  const gap = iw / Math.max(points.length, 1) * 0.3;

  const colorOf = (v: number) => {
    if (critAt != null && v >= critAt) return '#ef4444';
    if (warnAt != null && v >= warnAt) return '#f59e0b';
    return '#22c55e';
  };

  return (
    <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
      <div className="text-[9.5px] uppercase tracking-wider text-text-secondary mb-1">{title}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <text x={padL - 4} y={padT + 6} fontSize="8" fill="#8b949e" textAnchor="end">{Math.round(max)}</text>
        <text x={padL - 4} y={padT + ih / 2 + 3} fontSize="8" fill="#8b949e" textAnchor="end">{Math.round(max / 2)}</text>
        <text x={padL - 4} y={padT + ih - 1} fontSize="8" fill="#8b949e" textAnchor="end">0</text>
        {points.map((p, i) => {
          const x = padL + (iw / points.length) * i + gap / 2;
          const barH = (ih * p.value) / max;
          const yPos = padT + ih - barH;
          const label = new Date(p.ts * 1000).toLocaleDateString(undefined, { weekday: 'short' });
          return (
            <g key={i}>
              <rect x={x} y={yPos} width={barW} height={barH} fill={colorOf(p.value)} rx="1" />
              <text x={x + barW / 2} y={H - 4} fontSize="8" fill="#8b949e" textAnchor="middle">{label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
