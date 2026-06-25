'use client';
// components/zones/HistoryChart.tsx — the historical trends chart (Phase 1).
//
// Hand-rolled inline SVG (no charting dependency, same approach as DistributionSVG),
// fed a LEAN server-built series ({date,value}[]) so the heavy record JSONB never ships
// to the client. Phase 1 plots the single headline line per kind — survival/bucket:
// implied median; binary: YES probability; touch: implied-range midpoint — with a
// 7D/30D/90D/ALL time-range toggle (the one piece of client state, hence 'use client').
// Phase 3 layers per-threshold lines + faded low-confidence segments on this same frame.
//
// Below 2 points in the selected window it shows an explicit "Collecting history" state —
// never an empty axis, never dashes. SVG <text> uses a single string child (the adjacent
// dynamic+static hydration trap, see gotchas.md).

import { useState } from 'react';

export interface HistoryPoint { date: string; value: number }

const VB_W = 480;
const VB_H = 180;
const PAD = { t: 12, r: 14, b: 28, l: 44 };
const RANGES: { key: string; days: number | null }[] = [
  { key: '7D', days: 7 }, { key: '30D', days: 30 }, { key: '90D', days: 90 }, { key: 'ALL', days: null },
];
const DAY_MS = 86_400_000;

/** Axis-label formatter by kind: binary → %, otherwise value + unit. */
function fmtVal(v: number, kind: string, unit: string): string {
  if (kind === 'binary') return `${Math.round(v * 100)}%`;
  return `$${v.toFixed(2)}${unit}`;
}

export function HistoryChart({ points, kind, unit = '', label = 'Value' }:
  { points: HistoryPoint[]; kind: string; unit?: string; label?: string }) {
  const [range, setRange] = useState<string>('30D');
  const sel = RANGES.find((r) => r.key === range) ?? RANGES[3];

  const days = sel.days; // hoist for narrowing inside the filter closure
  const sorted = [...(points ?? [])].sort((a, b) => a.date.localeCompare(b.date));
  const lastMs = sorted.length ? Date.parse(`${sorted[sorted.length - 1].date}T00:00:00Z`) : 0;
  const visible = days == null ? sorted
    : sorted.filter((p) => Date.parse(`${p.date}T00:00:00Z`) >= lastMs - days * DAY_MS);

  return (
    <div className="hist-chart" data-field="history-chart">
      <div className="hist-head">
        <div className="label">{`${label} over time`}</div>
        <div className="hist-range" role="group" aria-label="time range">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              className={`hist-range-btn${r.key === range ? ' is-active' : ''}`}
              aria-pressed={r.key === range}
              onClick={() => setRange(r.key)}
            >{r.key}</button>
          ))}
        </div>
      </div>
      {visible.length < 2
        ? <div className="empty" data-field="history-collecting">
            {`Collecting history — the trend chart appears once ${range === 'ALL' ? '2+' : `2+ in the last ${range.toLowerCase()}`} daily snapshots exist.`}
          </div>
        : <Plot points={visible} kind={kind} unit={unit} />}
    </div>
  );
}

function Plot({ points, kind, unit }: { points: HistoryPoint[]; kind: string; unit: string }) {
  const xs = points.map((p) => Date.parse(`${p.date}T00:00:00Z`));
  const xLo = xs[0], xHi = xs[xs.length - 1];
  const ys = points.map((p) => p.value);
  // Binary uses a fixed 0–100% axis; value kinds use a padded data range.
  let yLo: number, yHi: number;
  if (kind === 'binary') { yLo = 0; yHi = 1; }
  else {
    const min = Math.min(...ys), max = Math.max(...ys);
    const pad = (max - min) * 0.1 || Math.abs(max) * 0.05 || 1;
    yLo = min - pad; yHi = max + pad;
  }
  const xScale = (ms: number) => xHi === xLo ? PAD.l : PAD.l + ((ms - xLo) / (xHi - xLo)) * (VB_W - PAD.l - PAD.r);
  const yScale = (v: number) => yHi === yLo ? VB_H - PAD.b : VB_H - PAD.b - ((v - yLo) / (yHi - yLo)) * (VB_H - PAD.t - PAD.b);
  const line = points.map((p, i) => `${xScale(xs[i]).toFixed(1)},${yScale(p.value).toFixed(1)}`).join(' ');

  const yTicks = [yLo, (yLo + yHi) / 2, yHi];
  const first = points[0], last = points[points.length - 1];

  return (
    <svg className="dist-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label="History trend chart" data-field="history-svg">
      {yTicks.map((v, i) => (
        <g key={i}>
          <line className="dist-grid" x1={PAD.l} x2={VB_W - PAD.r} y1={yScale(v)} y2={yScale(v)} />
          <text className="dist-axis" x={PAD.l - 5} y={yScale(v) + 3} textAnchor="end">{fmtVal(v, kind, unit)}</text>
        </g>
      ))}
      <polyline className="dist-cdf-line" points={line} fill="none" />
      {points.map((p, i) => (
        <circle key={i} className="dist-cdf-dot" cx={xScale(xs[i])} cy={yScale(p.value)} r={2.2}>
          <title>{`${p.date} · ${fmtVal(p.value, kind, unit)}`}</title>
        </circle>
      ))}
      <text className="dist-tick" x={PAD.l} y={VB_H - PAD.b + 16} textAnchor="start">{first.date}</text>
      <text className="dist-tick" x={VB_W - PAD.r} y={VB_H - PAD.b + 16} textAnchor="end">{last.date}</text>
    </svg>
  );
}
