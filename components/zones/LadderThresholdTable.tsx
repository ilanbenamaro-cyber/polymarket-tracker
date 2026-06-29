'use client';
// components/zones/LadderThresholdTable.tsx — the ALL-THRESHOLDS table with signal-to-noise collapse.
//
// A survival ladder is mostly settled rungs — P(>X) pinned at ~100% (certain YES, low strikes) or ~0%
// (certain NO, high strikes) — that bury the ACTIVE signal zone (5–95%). Increment 6 collapses the two
// settled zones: all active rows stay visible (incl. the amber at-the-money row); 2 settled rows nearest
// the active zone stay for context, the rest fold behind an expandable "N more settled legs" toggle (one
// per side, independent client state — hence 'use client'). A near-settlement market, or one with <3
// active rows, isn't collapsed (don't fold a table that's already tiny). Settled rows' Δ cells are muted.
import { useState } from 'react';
import { fmtDeltaPp, deltaSign, classifyLadderZones } from '@/lib/format-detail.mjs';
import type { LadderRow, ThresholdDelta } from './market-record';

const CONTEXT = 2; // settled rows kept nearest the active zone for context
const pct = (p: number | null | undefined) => (p == null ? '—' : `${Math.round(p * 100)}%`);
const pct1 = (p: number | null | undefined) => (p == null ? '—' : `${(p * 100).toFixed(1)}%`);
const fmtVol = (v: number | null | undefined) => (v == null ? '—' : `$${Math.round(v).toLocaleString('en-US')}`);

function DeltaCell({ delta, muted }: { delta: number | null; muted?: boolean }) {
  const cls = deltaSign(delta);
  const txt = fmtDeltaPp(delta);
  return (
    <td className={`delta-cell ${cls}${txt === '—' ? ' faint' : ''}${muted ? ' settled-delta' : ''}`} title={txt === '—' ? 'no snapshot at this horizon yet' : `${txt} percentage points`}>
      {txt}
    </td>
  );
}

function DataRow({ m, settled, dl, tracked, v24, hasVol24 }:
  { m: LadderRow; settled: boolean; dl?: ThresholdDelta; tracked: boolean; v24?: number; hasVol24: boolean }) {
  const adj = m.raw_prob != null && Math.abs(m.raw_prob - m.adjusted_prob) > 0.005;
  return (
    <tr className={`${tracked ? 'tracked ' : ''}${settled ? 'settled ' : ''}${m.volume_tier === 'low' ? 'thin' : ''}`.trim()}>
      <td className="tl">{tracked && <span className="track-dot" aria-hidden="true">● </span>}{m.label}{adj && <span className="adjmark" title={`isotonic-adjusted from raw ${pct(m.raw_prob)}`}> △</span>}</td>
      <td>{pct(m.prob)}</td>
      <td>{pct1(m.bucket_prob)}</td>
      <DeltaCell delta={dl?.d1 ?? null} muted={settled} />
      <DeltaCell delta={dl?.d7 ?? null} muted={settled} />
      <DeltaCell delta={dl?.d30 ?? null} muted={settled} />
      {hasVol24 && <td>{v24 != null ? fmtVol(v24) : <span className="faint">—</span>}</td>}
      <td><span className={`vdot v-${m.volume_tier ?? 'na'}`} />{fmtVol(m.volume)}</td>
    </tr>
  );
}

type Item =
  | { type: 'data'; m: LadderRow; settled: boolean }
  | { type: 'toggle'; dir: 'high' | 'low'; count: number; expanded: boolean };

export function LadderThresholdTable({ markets, deltas, atmThreshold, vol24ByThreshold, near }:
  { markets: LadderRow[]; deltas: ThresholdDelta[]; atmThreshold: number | null; vol24ByThreshold: Record<string, number> | null; near: boolean }) {
  const [expandHigh, setExpandHigh] = useState(false);
  const [expandLow, setExpandLow] = useState(false);
  const { settledHigh, active, settledLow } = classifyLadderZones(markets);
  const hasVol24 = !!vol24ByThreshold;
  const deltaFor = (t: number) => deltas?.find((x) => x.threshold === t);

  const items: Item[] = [];
  // Don't collapse a table that's already small (near settlement, or a thin active zone).
  if (near || active.length < 3) {
    for (const m of markets) items.push({ type: 'data', m, settled: false });
  } else {
    if (settledHigh.length > CONTEXT) items.push({ type: 'toggle', dir: 'high', count: settledHigh.length - CONTEXT, expanded: expandHigh });
    for (const m of (expandHigh ? settledHigh : settledHigh.slice(-CONTEXT))) items.push({ type: 'data', m, settled: true });
    for (const m of active) items.push({ type: 'data', m, settled: false });
    for (const m of (expandLow ? settledLow : settledLow.slice(0, CONTEXT))) items.push({ type: 'data', m, settled: true });
    if (settledLow.length > CONTEXT) items.push({ type: 'toggle', dir: 'low', count: settledLow.length - CONTEXT, expanded: expandLow });
  }
  const colSpan = hasVol24 ? 8 : 7;

  return (
    <div className="detail-table-wrap">
      <table className="detail-table num" data-field="ladder">
        <thead><tr>
          <th className="tl">Threshold</th><th>P(&gt;X)</th><th>Bucket %</th>
          <th>24h Δ</th><th>7d Δ</th><th>30d Δ</th>
          {hasVol24 && <th>24h volume</th>}
          <th>All-time volume</th>
        </tr></thead>
        <tbody>
          {items.map((it, i) => it.type === 'toggle' ? (
            <tr key={`toggle-${it.dir}`} className="ladder-toggle-row">
              <td colSpan={colSpan}>
                <button
                  type="button"
                  className="cat-more"
                  data-field={`ladder-toggle-${it.dir}`}
                  aria-expanded={it.expanded}
                  onClick={() => (it.dir === 'high' ? setExpandHigh((v) => !v) : setExpandLow((v) => !v))}
                >
                  {it.expanded
                    ? `${it.dir === 'high' ? '▾' : '▴'} show fewer`
                    : `${it.dir === 'high' ? '↑' : '↓'} ${it.count} more settled leg${it.count === 1 ? '' : 's'} (${it.dir === 'high' ? '100%' : '0%'})`}
                </button>
              </td>
            </tr>
          ) : (
            <DataRow
              key={`${it.m.threshold}-${i}`}
              m={it.m}
              settled={it.settled}
              dl={deltaFor(it.m.threshold)}
              tracked={it.m.threshold === atmThreshold}
              v24={vol24ByThreshold?.[String(it.m.threshold)]}
              hasVol24={hasVol24}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
