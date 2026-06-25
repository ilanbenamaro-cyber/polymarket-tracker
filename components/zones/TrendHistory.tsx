// components/zones/TrendHistory.tsx — the shared "Trend & history" section (Phase 1).
//
// Rendered by all three detail views (ladder, binary, touch) so the trend frame is
// identical everywhere. Velocity (≥7d) and dispersion (≥30d) cards show an explicit
// "Collecting — N/min days" state below the minimum — never dashes (DoD: analytics never
// blank) — and the historical chart sits below them. Extracted into its own module to
// keep MarketDetailView ⇄ Binary/Touch view imports acyclic. Server component (the chart
// itself is the only client island).

import { HistoryChart, type HistoryPoint } from './HistoryChart';

export interface VelocityResult { status: string; kind?: string; trend?: string; period?: string; change?: number; days_have?: number; days_needed?: number; }
export interface DispersionResult { status: string; direction?: string; change_pct?: number; current_width?: number; days_have?: number; days_needed?: number; }
export interface HistoryUI { velocity: VelocityResult; dispersion: DispersionResult; points: HistoryPoint[]; kind: string; }

/** Velocity card: rate/direction of the headline value over the last 7 days, or an explicit
 *  "Collecting" state below the minimum. */
function VelocityCard({ v, unit }: { v: VelocityResult; unit: string }) {
  let value = '—';
  let sub = '';
  if (v.status === 'collecting') {
    value = 'Collecting';
    sub = `${v.days_have ?? 0}/${v.days_needed ?? 7} days · populates at 7`;
  } else if (v.status === 'ok') {
    value = v.trend ?? '—';
    const ch = v.change ?? 0;
    sub = v.kind === 'binary'
      ? `${ch >= 0 ? '+' : ''}${(ch * 100).toFixed(1)}pp over ${v.period ?? '7d'}`
      : `${ch >= 0 ? '+' : ''}${ch.toFixed(2)} $${unit} over ${v.period ?? '7d'}`;
  }
  return (
    <div className="acard" data-field="velocity-card">
      <div className="label">Velocity (7d)</div>
      <div className="acard-v">{value}</div>
      <div className="acard-s faint">{sub}</div>
    </div>
  );
}

/** Dispersion card: how the 50% band has moved over ~30 days. Collecting below the minimum;
 *  not_applicable for binary/touch (no settlement distribution). */
function DispersionCard({ d, unit }: { d: DispersionResult; unit: string }) {
  let value = '—';
  let sub = '';
  if (d.status === 'not_applicable') { value = 'n/a'; sub = 'no settlement distribution'; }
  else if (d.status === 'collecting') { value = 'Collecting'; sub = `${d.days_have ?? 0}/${d.days_needed ?? 30} days · populates at 30`; }
  else if (d.status === 'ok') {
    value = d.direction ?? '—';
    const p = (d.change_pct ?? 0) * 100;
    sub = `IQR ${p >= 0 ? '+' : ''}${p.toFixed(0)}% · width ${d.current_width != null ? `$${d.current_width.toFixed(2)}${unit}` : '—'} (30d)`;
  }
  return (
    <div className="acard" data-field="dispersion-card">
      <div className="label">Dispersion (30d)</div>
      <div className="acard-v">{value}</div>
      <div className="acard-s faint">{sub}</div>
    </div>
  );
}

/** Velocity + dispersion cards above the historical trends chart. */
export function TrendHistorySection({ hist, unit, label }: { hist: HistoryUI; unit: string; label: string }) {
  return (
    <section className="detail-section" data-field="trend-history">
      <h2 className="detail-h2">Trend &amp; history <span className="tier1-tag">Tier 1 · market-derived</span></h2>
      <div className="detail-analytics">
        <VelocityCard v={hist.velocity} unit={unit} />
        <DispersionCard d={hist.dispersion} unit={unit} />
      </div>
      <HistoryChart points={hist.points} kind={hist.kind} unit={unit} label={label} />
    </section>
  );
}
