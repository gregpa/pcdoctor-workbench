import { queryMetricTrend, saveForecasts, MetricPoint } from './dataStore.js';
import type { ForecastData, ForecastProjection } from '@shared/types.js';

interface MetricConfig {
  category: string;
  metric: string;
  label: string;
  algorithm: 'linear_regression' | 'ewma' | 'categorical';
  threshold_warn: number | null;
  threshold_critical: number | null;
  /** Direction the metric moves when BAD. If 'down', lower is worse (disk free). If 'up', higher is worse (ram peak). */
  bad_direction: 'up' | 'down';
  preventive_action?: { action_name: string; label: string };
  min_points?: number;
  min_days?: number;
}

const CONFIGS: MetricConfig[] = [
  {
    category: 'cpu', metric: 'load_pct', label: 'CPU load trend',
    algorithm: 'linear_regression',
    threshold_warn: 70, threshold_critical: 90, bad_direction: 'up',
  },
  {
    category: 'ram', metric: 'used_pct', label: 'RAM usage trend',
    algorithm: 'linear_regression',
    threshold_warn: 85, threshold_critical: 95, bad_direction: 'up',
    preventive_action: { action_name: 'apply_wsl_cap', label: 'Apply WSL Memory Cap' },
  },
  {
    category: 'disk', metric: 'free_pct', label: 'C: drive free %',
    algorithm: 'linear_regression',
    threshold_warn: 20, threshold_critical: 10, bad_direction: 'down',
    preventive_action: { action_name: 'clear_temp_files', label: 'Clear Temp Files + Recycle Bin' },
  },
  {
    category: 'events', metric: 'system_count', label: 'System event errors (7d)',
    algorithm: 'ewma',
    threshold_warn: 300, threshold_critical: 500, bad_direction: 'up',
  },
];

interface RegressionResult {
  slope: number;            // value per ms
  intercept: number;
  r_squared: number;
}

function linearRegression(points: MetricPoint[]): RegressionResult {
  const n = points.length;
  const meanX = points.reduce((a, p) => a + p.ts, 0) / n;
  const meanY = points.reduce((a, p) => a + p.value, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (const p of points) {
    const dx = p.ts - meanX;
    const dy = p.value - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const slope = denX === 0 ? 0 : num / denX;
  const intercept = meanY - slope * meanX;
  const r2 = (denX === 0 || denY === 0) ? 0 : (num * num) / (denX * denY);
  return { slope, intercept, r_squared: r2 };
}

function daysFromMs(ms: number): number { return ms / (24 * 60 * 60 * 1000); }
function msFromDays(d: number): number { return d * 24 * 60 * 60 * 1000; }

function projectThresholdCrossing(r: RegressionResult, currentValue: number, threshold: number, bad_direction: 'up' | 'down'): number | null {
  // Solve: threshold = slope * ts + intercept  →  ts = (threshold - intercept) / slope
  if (r.slope === 0) return null;
  if (bad_direction === 'up' && r.slope <= 0) return null;
  if (bad_direction === 'down' && r.slope >= 0) return null;
  const ts = (threshold - r.intercept) / r.slope;
  return ts;
}

export function generateForecasts(): ForecastData {
  const projections: ForecastProjection[] = [];
  const insufficient: Array<{ metric: string; points: number; required: number }> = [];
  const nowMs = Date.now();

  for (const cfg of CONFIGS) {
    const minPoints = cfg.min_points ?? 14;
    const minDays = cfg.min_days ?? 7;
    // Pull last 90 days
    const pts = queryMetricTrend(cfg.category, cfg.metric, 90);
    if (pts.length < minPoints) {
      insufficient.push({ metric: `${cfg.category}.${cfg.metric}`, points: pts.length, required: minPoints });
      continue;
    }
    const windowMs = pts[pts.length - 1].ts - pts[0].ts;
    if (windowMs < msFromDays(minDays)) {
      insufficient.push({ metric: `${cfg.category}.${cfg.metric}`, points: pts.length, required: minPoints });
      continue;
    }
    const current = pts[pts.length - 1].value;

    let slopePerDay: number | null = null;
    let r_sq: number | null = null;
    let projectedWarnMs: number | null = null;
    let projectedCritMs: number | null = null;

    if (cfg.algorithm === 'linear_regression') {
      const reg = linearRegression(pts);
      slopePerDay = reg.slope * msFromDays(1);
      r_sq = reg.r_squared;

      if (cfg.threshold_warn !== null) projectedWarnMs = projectThresholdCrossing(reg, current, cfg.threshold_warn, cfg.bad_direction);
      if (cfg.threshold_critical !== null) projectedCritMs = projectThresholdCrossing(reg, current, cfg.threshold_critical, cfg.bad_direction);
    }
    // EWMA — not forecasting a date, just checking current vs baseline
    // We still emit the KPI but without projected_critical_date
    if (cfg.algorithm === 'ewma') {
      const baseline = pts.slice(0, Math.floor(pts.length / 2)).reduce((a, p) => a + p.value, 0) / Math.max(1, Math.floor(pts.length / 2));
      const recent = pts.slice(-7).reduce((a, p) => a + p.value, 0) / Math.min(7, pts.length);
      slopePerDay = (recent - baseline) / Math.max(1, daysFromMs(windowMs));
    }

    // Confidence scoring
    const recencyFactor = nowMs - pts[pts.length - 1].ts < msFromDays(1) ? 1.0 : 0.6;
    const densityFactor = Math.min(1, pts.length / Math.max(minPoints * 2, 28));
    const r2Component = r_sq ?? 0.5;
    const confScore = Math.max(0, Math.min(1, r2Component * recencyFactor * densityFactor));
    const confidence: ForecastProjection['confidence'] = confScore >= 0.8 ? 'HIGH' : confScore >= 0.5 ? 'MEDIUM' : confScore >= 0.3 ? 'LOW' : 'INSUFFICIENT';

    // Severity classification by projected critical date
    let severity: ForecastProjection['severity'] = 'indicator';
    let daysUntilCritical: number | null = null;
    let projCritDate: string | null = null;
    if (projectedCritMs && projectedCritMs > nowMs) {
      daysUntilCritical = daysFromMs(projectedCritMs - nowMs);
      projCritDate = new Date(projectedCritMs).toISOString().slice(0, 10);
      if (daysUntilCritical < 7) severity = 'critical';
      else if (daysUntilCritical < 30) severity = 'important';
      else severity = 'low';
    }
    // EWMA: if recent > critical threshold, mark important
    if (cfg.algorithm === 'ewma' && cfg.threshold_critical !== null && current > cfg.threshold_critical) {
      severity = 'important';
    }

    const projWarnDate = projectedWarnMs && projectedWarnMs > nowMs
      ? new Date(projectedWarnMs).toISOString().slice(0, 10) : null;

    const proj: ForecastProjection = {
      metric: `${cfg.category}.${cfg.metric}`,
      metric_label: cfg.label,
      algorithm: cfg.algorithm,
      current_value: current,
      slope_per_day: slopePerDay,
      r_squared: r_sq,
      threshold_warn: cfg.threshold_warn,
      threshold_critical: cfg.threshold_critical,
      projected_warn_date: projWarnDate,
      projected_critical_date: projCritDate,
      days_until_critical: daysUntilCritical,
      confidence,
      confidence_score: Number(confScore.toFixed(2)),
      severity,
    };
    if (cfg.preventive_action) {
      proj.preventive_action = {
        action_name: cfg.preventive_action.action_name,
        label: cfg.preventive_action.label,
        recommended_before: projWarnDate,
      };
    }

    projections.push(proj);
  }

  // Sort: critical first, by days_until_critical asc
  projections.sort((a, b) => {
    const order = { critical: 0, important: 1, low: 2, indicator: 3 };
    const aRank = order[a.severity];
    const bRank = order[b.severity];
    if (aRank !== bRank) return aRank - bRank;
    const aDays = a.days_until_critical ?? 1e9;
    const bDays = b.days_until_critical ?? 1e9;
    return aDays - bDays;
  });

  const data: ForecastData = {
    generated_at: Math.floor(Date.now() / 1000),
    projections,
    insufficient_data: insufficient,
  };

  saveForecasts(data);
  return data;
}
