'use client';
// components/zones/TouchProbabilityTable.tsx — the touch-market probability table (Bug B).
//
// A touch ladder with many settled legs shows 15+ rows of 0%/0% (deep OTM/ITM legs that have
// already settled) — pure noise. Two modes:
//   • NEAR SETTLEMENT: show only the ACTIVE rows (P(HIGH touch) > 1% OR P(LOW touch) > 1%), with a
//     footer "N settled legs hidden — showing active range only" and a "show all" toggle.
//   • otherwise: keep the full table but COLLAPSE consecutive rows where both probabilities round
//     to 0% into a single "N levels at 0%" row, so the active band stays legible.
// The toggle is the only client state, hence 'use client'.
import { useState } from 'react';

export interface TouchRow { level: number; high?: number; low?: number; vol?: number }

const ACTIVE_THRESHOLD = 0.01;  // > 1% on either side = an active level (Bug B near-settlement filter)
const ZERO_THRESHOLD = 0.005;   // rounds to 0% on both sides = a settled/dead level
const pctStr = (p: number | null | undefined) => (p == null ? '—' : `${Math.round(p * 100)}%`);
const fmtVol = (v: number | null | undefined) => (v == null ? '—' : `$${Math.round(v).toLocaleString('en-US')}`);

const isActive = (r: TouchRow) => (r.high ?? 0) > ACTIVE_THRESHOLD || (r.low ?? 0) > ACTIVE_THRESHOLD;
const isZero = (r: TouchRow) => (r.high ?? 0) < ZERO_THRESHOLD && (r.low ?? 0) < ZERO_THRESHOLD;

/** Collapse consecutive all-zero rows into { collapsed: N } markers; real rows pass through. */
function collapseZeroRuns(rows: TouchRow[]): (TouchRow | { collapsed: number })[] {
  const out: (TouchRow | { collapsed: number })[] = [];
  let run = 0;
  for (const r of rows) {
    if (isZero(r)) { run++; continue; }
    if (run) { out.push({ collapsed: run }); run = 0; }
    out.push(r);
  }
  if (run) out.push({ collapsed: run });
  return out;
}

function DataRow({ r, unit }: { r: TouchRow; unit: string }) {
  return (
    <tr>
      <td className="tl">{`$${r.level.toFixed(2)}${unit}`}</td>
      <td className={r.high != null && r.high >= 0.5 ? 'touch-hot' : ''}>{pctStr(r.high)}</td>
      <td className={r.low != null && r.low >= 0.5 ? 'touch-hot' : ''}>{pctStr(r.low)}</td>
      <td>{fmtVol(r.vol)}</td>
    </tr>
  );
}

export function TouchProbabilityTable({ rows, near, unit, resolves = null }: { rows: TouchRow[]; near: boolean; unit: string; resolves?: string | null }) {
  const [showAll, setShowAll] = useState(false);
  // Increment 7: barrier-semantics tooltips on the touch columns (a touch is a path event, not settlement).
  const by = resolves ? `before ${resolves}` : 'before expiry';
  const tipHigh = `P(price touches or exceeds this level at any point ${by})`;
  const tipLow = `P(price touches or falls below this level at any point ${by})`;

  // NEAR SETTLEMENT: active-only with a show-all toggle.
  if (near) {
    const active = rows.filter(isActive);
    const hidden = rows.length - active.length;
    const body = showAll ? rows : active;
    return (
      <div className="detail-table-wrap" data-field="touch-table-wrap" data-mode="near">
        <table className="detail-table num" data-field="touch-table">
          <thead><tr><th className="tl">Level</th><th title={tipHigh} data-field="th-touch-high">P(touch ≥)</th><th title={tipLow} data-field="th-touch-low">P(touch ≤)</th><th>All-time volume</th></tr></thead>
          <tbody>{body.map((r) => <DataRow key={r.level} r={r} unit={unit} />)}</tbody>
        </table>
        {hidden > 0 && (
          <div className="touch-table-foot">
            <span className="faint" data-field="touch-hidden-note">{showAll ? `showing all ${rows.length} levels` : `${hidden} settled leg${hidden === 1 ? '' : 's'} hidden — showing active range only`}</span>
            <button type="button" className="cat-more" data-field="touch-show-all" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
              {showAll ? '▴ active only' : '▾ show all'}
            </button>
          </div>
        )}
      </div>
    );
  }

  // Otherwise: full table, consecutive 0%/0% rows collapsed.
  const items = collapseZeroRuns(rows);
  return (
    <div className="detail-table-wrap" data-field="touch-table-wrap" data-mode="full">
      <table className="detail-table num" data-field="touch-table">
        <thead><tr><th className="tl">Level</th><th title={tipHigh} data-field="th-touch-high">P(touch ≥)</th><th title={tipLow} data-field="th-touch-low">P(touch ≤)</th><th>All-time volume</th></tr></thead>
        <tbody>
          {items.map((it, i) => 'collapsed' in it
            ? <tr key={`c${i}`} className="touch-collapsed" data-field="touch-collapsed"><td className="tl faint" colSpan={4}>{`${it.collapsed} level${it.collapsed === 1 ? '' : 's'} at 0%`}</td></tr>
            : <DataRow key={it.level} r={it} unit={unit} />)}
        </tbody>
      </table>
    </div>
  );
}
