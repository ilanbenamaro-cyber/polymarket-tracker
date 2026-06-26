'use client';
// components/zones/CategoricalOutcomeBars.tsx — the categorical outcome-bar chart (Bug A item 2).
//
// Hand-rolled SVG (no charting dep, same approach as the rest of the detail), one labeled bar per
// outcome, width ∝ probability, the dominant bar in amber. Shows at most MAX_BARS outcomes by
// probability; when a field has more real candidates than that, a "N more outcomes" toggle expands
// the rest (the one piece of client state, hence 'use client'). Bar scaling is fixed to the leader
// so bars don't jump when expanded. SVG <text> uses a single string child (the hydration trap).
import { useState } from 'react';
import type { CategoricalOutcome } from './market-record';

const MAX_BARS = 10;
const pct1 = (p: number | null | undefined) => (p == null ? '—' : `${(p * 100).toFixed(1)}%`);

export function CategoricalOutcomeBars({ outcomes }: { outcomes: CategoricalOutcome[] }) {
  const [expanded, setExpanded] = useState(false);
  if (outcomes.length === 0) return <div className="empty" data-field="outcomes-empty">No outcome data.</div>;

  const shown = expanded ? outcomes : outcomes.slice(0, MAX_BARS);
  const hidden = outcomes.length - shown.length;
  const max = Math.max(0.01, ...outcomes.map((o) => o.probability)); // fixed scale (leader)
  const rowH = 26;
  const VB_W = 480;
  const VB_H = shown.length * rowH + 8;
  const labelW = 150;
  const barMax = VB_W - labelW - 52;

  return (
    <div data-field="outcome-bars-wrap">
      <svg className="cat-bars" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label="Outcome probability distribution" data-field="outcome-bars">
        {shown.map((o, i) => {
          const y = i * rowH + 4;
          const w = (o.probability / max) * barMax;
          return (
            <g key={i}>
              <text className="cat-bar-label" x={labelW - 6} y={y + rowH / 2 + 3} textAnchor="end">{o.label}</text>
              <rect className={`cat-bar${i === 0 ? ' cat-bar-top' : ''}`} x={labelW} y={y + 3} width={Math.max(1, w)} height={rowH - 10} rx={2} />
              <text className="cat-bar-pct" x={labelW + Math.max(1, w) + 6} y={y + rowH / 2 + 3} textAnchor="start">{pct1(o.probability)}</text>
            </g>
          );
        })}
      </svg>
      {outcomes.length > MAX_BARS && (
        <button
          type="button"
          className="cat-more"
          data-field="outcomes-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '▴ show top 10' : `▾ ${hidden} more outcome${hidden === 1 ? '' : 's'}`}
        </button>
      )}
    </div>
  );
}
