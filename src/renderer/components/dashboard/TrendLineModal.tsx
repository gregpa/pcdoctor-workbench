import { useState, useMemo, useEffect } from 'react';
import type { Trend, Severity } from '@shared/types.js';
import { severityStrokeHex } from '@renderer/lib/thresholds.js';

interface TrendLineModalProps {
  title: string;
  trend: Trend;
  severity?: Severity;
  unit?: string;
  yDomain?: [number, number];
  onClose: () => void;
}

export function TrendLineModal({ title, trend, severity = 'info', unit = '', yDomain, onClose }: TrendLineModalProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [onClose]);

  const { points } = trend;
  const values = useMemo(() => points.map(p => p.value), [points]);
  const stats = useMemo(() => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const sum = values.reduce((a, b) => a + b, 0);
    return {
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: sum / values.length,
      median: sorted[Math.floor(sorted.length / 2)],
      current: values[values.length - 1],
      p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
    };
  }, [values]);

  if (!points.length || !stats) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
        <div className="pcd-modal p-6 max-w-md">
          <div className="text-sm">No data available for this metric.</div>
          <button onClick={onClose} className="mt-3 px-3 py-1.5 rounded-md text-xs pcd-button">Close</button>
        </div>
      </div>
    );
  }

  const W = 900;
  const H = 360;
  const padL = 50, padR = 20, padT = 20, padB = 40;
  const iw = W - padL - padR;
  const ih = H - padT - padB;

  const min = yDomain ? yDomain[0] : Math.min(...values);
  const max = yDomain ? yDomain[1] : Math.max(...values);
  const range = max - min || 1;
  const tMin = points[0].ts;
  const tMax = points[points.length - 1].ts;
  const tRange = tMax - tMin || 1;

  const x = (ts: number) => padL + (iw * (ts - tMin)) / tRange;
  const y = (v: number) => padT + ih - (ih * (v - min)) / range;

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.ts)},${y(p.value)}`).join(' ');
  const areaD = `${pathD} L${x(tMax)},${padT + ih} L${padL},${padT + ih} Z`;
  const stroke = severityStrokeHex[severity];

  const ticks = Array.from({ length: 6 }, (_, i) => min + (range * i) / 5);
  const timeTickCount = Math.min(8, Math.max(2, Math.floor(iw / 120)));
  const timeTicks = Array.from({ length: timeTickCount }, (_, i) => tMin + (tRange * i) / (timeTickCount - 1));

  const hoverPt = hoverIdx !== null ? points[hoverIdx] : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="pcd-modal w-full max-w-5xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-surface-600">
          <div>
            <h2 className="text-base font-bold">{title}</h2>
            <div className="text-[10px] uppercase tracking-wider text-text-secondary">{points.length} data points - {new Date(tMin * 1000).toLocaleString()} to {new Date(tMax * 1000).toLocaleString()}</div>
          </div>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary text-xl leading-none px-2">X</button>
        </div>

        <div className="grid grid-cols-6 gap-2 p-4 border-b border-surface-600 text-xs">
          <Stat label="Current" value={stats.current} unit={unit} color={stroke} />
          <Stat label="Min" value={stats.min} unit={unit} />
          <Stat label="Max" value={stats.max} unit={unit} />
          <Stat label="Avg" value={stats.avg} unit={unit} />
          <Stat label="Median" value={stats.median} unit={unit} />
          <Stat label="P95" value={stats.p95} unit={unit} />
        </div>

        <div className="p-4">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full"
               onMouseMove={(e) => {
                 const svg = e.currentTarget;
                 const pt = svg.createSVGPoint();
                 pt.x = e.clientX; pt.y = e.clientY;
                 const ctm = svg.getScreenCTM();
                 if (!ctm) return;
                 const svgPt = pt.matrixTransform(ctm.inverse());
                 const tx = (svgPt.x - padL) / iw * tRange + tMin;
                 let bestIdx = 0;
                 let bestDist = Infinity;
                 for (let i = 0; i < points.length; i++) {
                   const d = Math.abs(points[i].ts - tx);
                   if (d < bestDist) { bestDist = d; bestIdx = i; }
                 }
                 setHoverIdx(bestIdx);
               }}
               onMouseLeave={() => setHoverIdx(null)}>
            {ticks.map((t, i) => (
              <g key={`y${i}`}>
                <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="#30363d" strokeWidth="0.5" strokeDasharray="2,2" />
                <text x={padL - 6} y={y(t) + 4} fontSize="11" fill="#8b949e" textAnchor="end">{formatNum(t)}{unit}</text>
              </g>
            ))}
            {timeTicks.map((ts, i) => (
              <g key={`x${i}`}>
                <line x1={x(ts)} x2={x(ts)} y1={padT} y2={padT + ih} stroke="#30363d" strokeWidth="0.5" strokeDasharray="2,2" />
                <text x={x(ts)} y={padT + ih + 16} fontSize="10" fill="#8b949e" textAnchor="middle">
                  {new Date(ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })}
                </text>
              </g>
            ))}
            <path d={areaD} fill={stroke} opacity="0.12" />
            <path d={pathD} stroke={stroke} strokeWidth="2" fill="none" />
            <line x1={padL} x2={padL} y1={padT} y2={padT + ih} stroke="#8b949e" strokeWidth="0.5" />
            <line x1={padL} x2={W - padR} y1={padT + ih} y2={padT + ih} stroke="#8b949e" strokeWidth="0.5" />
            {hoverPt && (
              <>
                <line x1={x(hoverPt.ts)} x2={x(hoverPt.ts)} y1={padT} y2={padT + ih} stroke="#8b949e" strokeWidth="1" strokeDasharray="3,3" />
                <circle cx={x(hoverPt.ts)} cy={y(hoverPt.value)} r="5" fill={stroke} stroke="#0d1117" strokeWidth="2" />
                <g>
                  <rect x={x(hoverPt.ts) + 8} y={y(hoverPt.value) - 30} width="180" height="42" fill="#161b22" stroke="#30363d" rx="4" />
                  <text x={x(hoverPt.ts) + 16} y={y(hoverPt.value) - 14} fontSize="11" fill="#c9d1d9" fontWeight="bold">{formatNum(hoverPt.value)}{unit}</text>
                  <text x={x(hoverPt.ts) + 16} y={y(hoverPt.value) + 2} fontSize="10" fill="#8b949e">{new Date(hoverPt.ts * 1000).toLocaleString()}</text>
                </g>
              </>
            )}
          </svg>
        </div>

        <div className="p-4 border-t border-surface-600 flex justify-end">
          <button onClick={onClose} className="px-4 py-2 rounded-md text-xs pcd-button hover:border-surface-500">Close (Esc)</button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, unit, color }: { label: string; value: number; unit: string; color?: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-text-secondary">{label}</div>
      <div className="text-lg font-bold" style={color ? { color } : undefined}>{formatNum(value)}<span className="text-xs text-text-secondary ml-0.5">{unit}</span></div>
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1000) return Math.round(n).toLocaleString();
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(1);
}
