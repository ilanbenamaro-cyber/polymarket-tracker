// components/zones/DistributionSVG.tsx — the analytical centerpiece: the whole
// implied distribution, hand-rolled in SVG (no charting dependency). Two panels from
// the stored ladder (markets[]): the cumulative P(>X) curve with the implied-median
// marker, and the bucket-probability density. Server-rendered (static SVG, no client
// JS); colours come from existing tokens via the .dist-* classes in globals.css.

import type { LadderRow as LadderPoint } from './market-record';

const VB_W = 480;
const VB_H = 200;
const PAD = { t: 12, r: 14, b: 28, l: 34 };

function xScale(t: number, lo: number, hi: number): number {
  if (hi === lo) return PAD.l;
  return PAD.l + ((t - lo) / (hi - lo)) * (VB_W - PAD.l - PAD.r);
}
function yScalePct(pct: number): number {
  return VB_H - PAD.b - (pct / 100) * (VB_H - PAD.t - PAD.b);
}

/** Cumulative curve: P(market value > X) over the thresholds, with the median marker. */
function CdfPanel({ markets, impliedMedian, unit }: { markets: LadderPoint[]; impliedMedian: number | null; unit: string }) {
  const lo = markets[0].threshold;
  const hi = markets[markets.length - 1].threshold;
  const pts = markets.map((m) => `${xScale(m.threshold, lo, hi).toFixed(1)},${yScalePct(m.prob * 100).toFixed(1)}`).join(' ');
  const medX = impliedMedian != null ? xScale(impliedMedian, lo, hi) : null;
  return (
    <svg className="dist-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label="Cumulative probability curve" data-field="cdf">
      {[0, 50, 100].map((g) => (
        <g key={g}>
          <line className="dist-grid" x1={PAD.l} x2={VB_W - PAD.r} y1={yScalePct(g)} y2={yScalePct(g)} />
          <text className="dist-axis" x={PAD.l - 5} y={yScalePct(g) + 3} textAnchor="end">{g}%</text>
        </g>
      ))}
      <line className="dist-ref" x1={PAD.l} x2={VB_W - PAD.r} y1={yScalePct(50)} y2={yScalePct(50)} />
      <polyline className="dist-cdf-line" points={pts} fill="none" />
      {markets.map((m) => (
        <circle key={m.threshold} className="dist-cdf-dot" cx={xScale(m.threshold, lo, hi)} cy={yScalePct(m.prob * 100)} r={2.5} />
      ))}
      {medX != null && (
        <g data-field="cdf-median-marker">
          <line className="dist-median" x1={medX} x2={medX} y1={PAD.t} y2={VB_H - PAD.b} />
          <text className="dist-median-lbl" x={Math.min(medX + 4, VB_W - PAD.r - 60)} y={PAD.t + 9}>median ${impliedMedian?.toFixed(2)}{unit}</text>
        </g>
      )}
      <text className="dist-axis" x={PAD.l} y={VB_H - 8} textAnchor="start">${lo}{unit}</text>
      <text className="dist-axis" x={VB_W - PAD.r} y={VB_H - 8} textAnchor="end">${hi}{unit}</text>
    </svg>
  );
}

/** Density: P(value in each bucket). First bar is the "<lowest" complement. */
function DensityPanel({ markets, impliedMedian }: { markets: LadderPoint[]; impliedMedian: number | null }) {
  const bars: Array<{ label: string; v: number; isMedian: boolean }> = [];
  bars.push({ label: `<$${markets[0].threshold}`, v: Math.max(0, 1 - markets[0].adjusted_prob), isMedian: impliedMedian != null && impliedMedian < markets[0].threshold });
  for (let i = 0; i < markets.length; i++) {
    const lo = markets[i].threshold;
    const hi = markets[i + 1]?.threshold ?? Infinity;
    bars.push({
      label: markets[i + 1] ? `$${lo}–${markets[i + 1].threshold}` : `>$${lo}`,
      v: markets[i].bucket_prob,
      isMedian: impliedMedian != null && impliedMedian >= lo && impliedMedian < hi,
    });
  }
  const maxV = Math.max(0.01, ...bars.map((b) => b.v));
  const innerW = VB_W - PAD.l - PAD.r;
  const bw = innerW / bars.length;
  return (
    <svg className="dist-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label="Bucket probability density" data-field="density">
      <line className="dist-grid" x1={PAD.l} x2={VB_W - PAD.r} y1={VB_H - PAD.b} y2={VB_H - PAD.b} />
      {bars.map((b, i) => {
        const h = (b.v / maxV) * (VB_H - PAD.t - PAD.b);
        const x = PAD.l + i * bw + bw * 0.12;
        return (
          <g key={b.label}>
            <rect className={`dist-bar${b.isMedian ? ' dist-bar-median' : ''}`}
              x={x} y={VB_H - PAD.b - h} width={bw * 0.76} height={Math.max(0, h)}>
              <title>{b.label}{markets[0].label.match(/[TBM]/g)?.slice(-1)[0] ?? 'T'} · {(b.v * 100).toFixed(1)}%</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

export function DistributionSVG({ markets, impliedMedian, unit }: { markets: LadderPoint[] | undefined; impliedMedian: number | null; unit: string }) {
  if (!markets || markets.length < 2) {
    return <div className="empty" data-field="distribution-empty">No distribution data for this market.</div>;
  }
  return (
    <div className="dist-grid2">
      <div className="dist-panel">
        <div className="label">Cumulative — P(value &gt; X)</div>
        <CdfPanel markets={markets} impliedMedian={impliedMedian} unit={unit} />
      </div>
      <div className="dist-panel">
        <div className="label">Density — where the market expects it to land</div>
        <DensityPanel markets={markets} impliedMedian={impliedMedian} />
      </div>
    </div>
  );
}
