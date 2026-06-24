// components/zones/DistributionSVG.tsx — the analytical centerpiece: the whole
// implied distribution, hand-rolled in SVG (no charting dependency). Two panels from
// the stored ladder (markets[]): the cumulative P(>X) curve with the implied-median
// marker, and the bucket-probability density. Server-rendered (static SVG, no client
// JS); colours come from existing tokens via the .dist-* classes in globals.css.
//
// Axes (so the chart reads without prior knowledge of the shape): the CDF carries a
// Y probability scale (0/25/50/75/100% + hairline grid) and a rotated X threshold
// label at every rung; the density carries a rotated X bucket label under every bar.
// The implied-median marker has an explicit text label.

import type { LadderRow as LadderPoint } from './market-record';

const VB_W = 480;
const VB_H = 210;
const PAD = { t: 12, r: 14, b: 48, l: 34 }; // generous bottom for the rotated X labels
const Y_TICKS = [0, 25, 50, 75, 100];

function xScale(t: number, lo: number, hi: number): number {
  if (hi === lo) return PAD.l;
  return PAD.l + ((t - lo) / (hi - lo)) * (VB_W - PAD.l - PAD.r);
}
function yScalePct(pct: number): number {
  return VB_H - PAD.b - (pct / 100) * (VB_H - PAD.t - PAD.b);
}
/** A rung's display tick, stripped of the leading ">"/"≥" (e.g. ">$1.8T" → "$1.8T"). */
function tickLabel(label: string | undefined): string {
  return (label ?? '').replace(/^[>≥]\s*/, '');
}

/** Cumulative curve: P(market value > X) over the thresholds, with the median marker. */
function CdfPanel({ markets, impliedMedian, unit }: { markets: LadderPoint[]; impliedMedian: number | null; unit: string }) {
  const lo = markets[0].threshold;
  const hi = markets[markets.length - 1].threshold;
  const pts = markets.map((m) => `${xScale(m.threshold, lo, hi).toFixed(1)},${yScalePct(m.prob * 100).toFixed(1)}`).join(' ');
  const medX = impliedMedian != null ? xScale(impliedMedian, lo, hi) : null;
  const tickY = VB_H - PAD.b + 9;
  return (
    <svg className="dist-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label="Cumulative probability curve" data-field="cdf">
      {/* Y probability scale + hairline grid */}
      {Y_TICKS.map((g) => (
        <g key={g}>
          <line className="dist-grid" x1={PAD.l} x2={VB_W - PAD.r} y1={yScalePct(g)} y2={yScalePct(g)} />
          {/* single string child: adjacent dynamic+static children mis-hydrate in SVG text */}
          <text className="dist-axis" x={PAD.l - 5} y={yScalePct(g) + 3} textAnchor="end">{`${g}%`}</text>
        </g>
      ))}
      <line className="dist-ref" x1={PAD.l} x2={VB_W - PAD.r} y1={yScalePct(50)} y2={yScalePct(50)} />
      <polyline className="dist-cdf-line" points={pts} fill="none" />
      {markets.map((m, i) => ( // index key: an arbitrary market's parsed thresholds aren't guaranteed unique
        <circle key={i} className="dist-cdf-dot" cx={xScale(m.threshold, lo, hi)} cy={yScalePct(m.prob * 100)} r={2.5} />
      ))}
      {/* X threshold tick label at every rung, rotated to avoid overlap */}
      <g data-field="cdf-x-labels">
        {markets.map((m, i) => {
          const x = xScale(m.threshold, lo, hi);
          return <text key={i} className="dist-tick" transform={`rotate(-45 ${x.toFixed(1)} ${tickY})`} x={x.toFixed(1)} y={tickY} textAnchor="end">{tickLabel(m.label)}</text>;
        })}
      </g>
      {medX != null && (
        <g data-field="cdf-median-marker">
          <line className="dist-median" x1={medX} x2={medX} y1={PAD.t} y2={VB_H - PAD.b} />
          <text className="dist-median-lbl" x={Math.min(medX + 4, VB_W - PAD.r - 60)} y={PAD.t + 9}>{`median $${impliedMedian?.toFixed(2)}${unit}`}</text>
        </g>
      )}
    </svg>
  );
}

/** Density: P(value in each bucket). First bar is the "<lowest" complement. */
function DensityPanel({ markets, impliedMedian, unit }: { markets: LadderPoint[]; impliedMedian: number | null; unit: string }) {
  const bars: Array<{ label: string; v: number; isMedian: boolean }> = [];
  bars.push({ label: `<$${markets[0].threshold}${unit}`, v: Math.max(0, 1 - markets[0].adjusted_prob), isMedian: impliedMedian != null && impliedMedian < markets[0].threshold });
  for (let i = 0; i < markets.length; i++) {
    const lo = markets[i].threshold;
    const hi = markets[i + 1]?.threshold ?? Infinity;
    bars.push({
      label: markets[i + 1] ? `$${lo}–${markets[i + 1].threshold}${unit}` : `>$${lo}${unit}`,
      v: markets[i].bucket_prob,
      isMedian: impliedMedian != null && impliedMedian >= lo && impliedMedian < hi,
    });
  }
  const maxV = Math.max(0.01, ...bars.map((b) => b.v));
  const innerW = VB_W - PAD.l - PAD.r;
  const bw = innerW / bars.length;
  const tickY = VB_H - PAD.b + 9;
  return (
    <svg className="dist-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label="Bucket probability density" data-field="density">
      {/* Y bucket-probability scale (0 and the peak) + baseline */}
      {[0, maxV].map((g, gi) => (
        <g key={gi}>
          <line className="dist-grid" x1={PAD.l} x2={VB_W - PAD.r} y1={yScalePct((g / maxV) * 100)} y2={yScalePct((g / maxV) * 100)} />
          <text className="dist-axis" x={PAD.l - 5} y={yScalePct((g / maxV) * 100) + 3} textAnchor="end">{`${Math.round(g * 100)}%`}</text>
        </g>
      ))}
      <g data-field="density-x-labels">
        {bars.map((b, i) => {
          const h = (b.v / maxV) * (VB_H - PAD.t - PAD.b);
          const x = PAD.l + i * bw + bw * 0.12;
          const cx = x + bw * 0.38;
          return (
            <g key={i}>
              <rect className={`dist-bar${b.isMedian ? ' dist-bar-median' : ''}`} x={x} y={VB_H - PAD.b - h} width={bw * 0.76} height={Math.max(0, h)}>
                <title>{`${b.label} · ${(b.v * 100).toFixed(1)}%`}</title>
              </rect>
              <text className="dist-tick" transform={`rotate(-45 ${cx.toFixed(1)} ${tickY})`} x={cx.toFixed(1)} y={tickY} textAnchor="end">{b.label}</text>
            </g>
          );
        })}
      </g>
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
        <DensityPanel markets={markets} impliedMedian={impliedMedian} unit={unit} />
      </div>
    </div>
  );
}
