// components/zones/TouchDetailView.tsx — Zone 2 detail for a DIRECTIONAL-TOUCH market.
//
// Rendered by MarketDetailView when derived.kind === 'directional_touch' (WTI/Silver
// "(LOW)/(HIGH) hit $X"). These markets price P(price TOUCHES a level before expiry), not a
// settlement value — there is NO survival curve and NO implied median (forcing one was the
// bug). So this view shows what the data actually is: the IMPLIED RANGE (from the HIGH/LOW
// 50% crossovers) as a horizontal range bar, plus a touch-probability table. The TRUST layer
// (confidence, freshness, provenance + hash-verify) is identical to every other detail.
import { canonicalizeRawInputs } from '@/core/fetch.js';
import { fmtEastern, displayTitle } from '@/lib/format-detail.mjs';
import { HashVerify } from './HashVerify';
import { DetailFreshness } from './DetailFreshness';
import { RefreshButton } from './RefreshButton';
import { TrendHistorySection, type HistoryUI } from './TrendHistory';
import type { MarketRecord, ServeBody, TouchPoint } from './market-record';

const CONF_CLASS: Record<string, string> = { high: 'conf-high', medium: 'conf-med', low: 'conf-low' };
const LIFECYCLE_CLASS: Record<string, string> = { OPEN: 'state-open', CLOSED_PENDING: 'state-pending', RESOLVED: 'state-resolved' };
const LIFECYCLE_LABEL: Record<string, string> = { OPEN: 'OPEN', CLOSED_PENDING: 'CLOSED · PENDING', RESOLVED: 'RESOLVED' };

const pctStr = (p: number | null | undefined) => (p == null ? '—' : `${Math.round(p * 100)}%`);
const fmtVol = (v: number | null | undefined) => (v == null ? '—' : `$${Math.round(v).toLocaleString('en-US')}`);
const fmtLevel = (lvl: number, unit: string) => `$${lvl.toFixed(unit ? 2 : 2)}${unit}`;

/** Horizontal range bar: the implied [low, high] band within the full strike span. A null
 *  bound (50% crossover outside the quoted ladder) extends the band to that edge. */
function RangeBar({ low, high, lowLabel, highLabel, levels }: {
  low: number | null; high: number | null; lowLabel: string; highLabel: string; levels: number[];
}) {
  if (levels.length === 0) return null;
  const min = Math.min(...levels), max = Math.max(...levels);
  const span = max - min || 1;
  const W = 1000, x = (lvl: number) => ((lvl - min) / span) * W;
  const bandL = low != null ? x(low) : 0;
  const bandR = high != null ? x(high) : W;
  return (
    <svg className="touch-rangebar" viewBox="0 0 1000 80" preserveAspectRatio="none" role="img" aria-label="implied trading range" data-field="range-bar">
      {/* full strike track */}
      <line x1={0} y1={40} x2={W} y2={40} className="touch-track" />
      {/* implied band */}
      <rect x={Math.max(0, bandL)} y={28} width={Math.max(2, bandR - bandL)} height={24} className="touch-band" />
      {/* bound markers */}
      {low != null && <line x1={x(low)} y1={20} x2={x(low)} y2={60} className="touch-mark" />}
      {high != null && <line x1={x(high)} y1={20} x2={x(high)} y2={60} className="touch-mark" />}
      <text x={Math.max(0, bandL)} y={16} className="touch-axislabel" textAnchor="start">{lowLabel}</text>
      <text x={Math.min(W, bandR)} y={16} className="touch-axislabel" textAnchor="end">{highLabel}</text>
      <text x={0} y={74} className="touch-axisend" textAnchor="start">{`$${min}`}</text>
      <text x={W} y={74} className="touch-axisend" textAnchor="end">{`$${max}`}</text>
    </svg>
  );
}

export function TouchDetailView({ record, envelope, hist }: { record: MarketRecord; envelope: ServeBody; hist?: HistoryUI }) {
  const s = record?.snapshot ?? {};
  const d = s?.derived ?? {};
  const asset = record?.asset ?? {};
  const lifecycleState: string = s?.lifecycle?.state ?? envelope?.lifecycle_state ?? 'OPEN';
  const isFinal = lifecycleState === 'RESOLVED';
  const conf = d.confidence ?? {};
  const fresh = d.freshness ?? {};
  const unit = d.unit ?? d.implied_range?.unit ?? '';
  const range = d.implied_range ?? {};
  const high = (d.high_series ?? []) as TouchPoint[];
  const low = (d.low_series ?? []) as TouchPoint[];
  const rawSha: string = s?.source?.raw_sha256 ?? '';
  const canonical = Array.isArray(s?.raw_inputs) ? canonicalizeRawInputs(s.raw_inputs) : '';
  const near = d.near_settlement === true && lifecycleState === 'OPEN'; // amber NEAR SETTLEMENT

  // Merge HIGH/LOW into one table keyed by level (descending — top of the range first).
  const byLevel = new Map<number, { level: number; high?: number; low?: number; vol?: number }>();
  for (const p of high) byLevel.set(p.level, { ...(byLevel.get(p.level) ?? { level: p.level }), high: p.prob, vol: p.volume });
  for (const p of low) byLevel.set(p.level, { ...(byLevel.get(p.level) ?? { level: p.level }), low: p.prob, vol: p.volume });
  const rows = [...byLevel.values()].sort((a, b) => b.level - a.level);
  const allLevels = [...high, ...low].map((p) => p.level);

  return (
    <article className="detail-view" data-zone="detail-view" data-kind="directional_touch" data-market-id={envelope?.market_id} data-lifecycle={lifecycleState}>
      <header className="detail-head">
        <div>
          <h1 className="detail-title" data-field="title">{displayTitle(asset.name, envelope?.market_id)}</h1>
          <div className="detail-sub muted">
            {asset.platform ?? 'polymarket'}{asset.resolves ? ` · resolves ${asset.resolves}` : ''}
            {asset.market_url && <> · <a href={asset.market_url} target="_blank" rel="noopener">view market ↗</a></>}
            <> · <span className="touch-tag">TOUCH MARKET</span></>
          </div>
        </div>
        <div className="detail-head-actions">
          {envelope?.market_id && <RefreshButton slug={envelope.market_id} />}
          {near ? (
            <span className="detail-lifecycle state-pending" data-field="lifecycle" data-near-settlement="true">
              ◐ NEAR SETTLEMENT
            </span>
          ) : (
            <span className={`detail-lifecycle ${LIFECYCLE_CLASS[lifecycleState] ?? ''}`} data-field="lifecycle">
              ● {LIFECYCLE_LABEL[lifecycleState] ?? lifecycleState}
            </span>
          )}
        </div>
      </header>

      {/* what a touch market IS — so the quant knows exactly what they're reading */}
      <p className="touch-explainer faint" data-field="touch-explainer">
        This market prices the probability of the price <b>touching</b> levels before expiry — not a
        settlement value. There is no implied median; the signal is the implied trading range.
      </p>

      {/* HEADLINE — the implied range */}
      <div className="detail-headline">
        <div className="detail-metric detail-metric-wide">
          <span className="label">Implied range <span className="faint">({Math.round((range.confidence ?? 0.5) * 100)}% confidence)</span></span>
          <span className="detail-hero num" data-field="implied-range">{range.low_label ?? '—'} <span className="faint">–</span> {range.high_label ?? '—'}</span>
          <span className="detail-band faint">lower / upper 50% touch crossovers</span>
        </div>
        <div className="detail-metric">
          <span className="label">Confidence</span>
          <span className={`detail-conf ${conf.tier ? CONF_CLASS[conf.tier] : ''}`} data-field="confidence" title={conf.score != null ? `score ${conf.score}` : ''}>
            {conf.tier ? conf.tier.toUpperCase() : '—'}
          </span>
          <span className="detail-band faint">{conf.score != null ? `score ${conf.score}` : ''}</span>
        </div>
        <div className="detail-metric">
          <span className="label">Volume</span>
          <span className="detail-sec num" data-field="volume">{fmtVol(d.total_volume)}</span>
          <span className="detail-band faint">cumulative, all-time</span>
        </div>
      </div>

      {/* RANGE BAR — the band within the strike span (no CDF: there is no distribution) */}
      <section className="detail-section">
        <h2 className="detail-h2">Implied trading range</h2>
        <RangeBar low={range.low ?? null} high={range.high ?? null} lowLabel={range.low_label ?? '—'} highLabel={range.high_label ?? '—'} levels={allLevels} />
      </section>

      {/* TRUST BAND — identical to the ladder/binary detail */}
      <div className="detail-trust" data-field="trust">
        {Array.isArray(conf.reasons) && conf.reasons.length > 0 && (
          <div className="trust-reasons">
            <span className="label">Confidence basis</span>
            {conf.reasons.map((r: string, i: number) => <span key={i} className="trust-chip">{r}</span>)}
          </div>
        )}
        <div className="trust-prov">
          <span className="label">As of</span>
          <span className="num" data-field="as-of">{fmtEastern(s.fetched_at)}</span>
          <DetailFreshness asOf={fresh.as_of ?? null} staleAfter={fresh.stale_after ?? null} fetchedAt={s.fetched_at ?? null} isFinal={isFinal} />
          <span className="trust-sep">·</span>
          <span className="label">methodology</span><span className="num">v{record.methodology_version ?? '—'}</span>
          <span className="trust-sep">·</span>
          <span className="label">sha256</span>
          {rawSha && canonical ? <HashVerify canonical={canonical} publishedHash={rawSha} /> : <span className="faint">unavailable</span>}
        </div>
      </div>

      {d.narrative && <p className="detail-narrative" data-field="narrative">{d.narrative}</p>}

      {/* TOUCH PROBABILITY TABLE — P(touch ≥) for HIGH legs, P(touch ≤) for LOW legs */}
      {rows.length > 0 && (
        <section className="detail-section">
          <h2 className="detail-h2">Touch probabilities <span className="faint">· current snapshot</span></h2>
          <div className="detail-table-wrap">
            <table className="detail-table num" data-field="touch-table">
              <thead><tr><th className="tl">Level</th><th>P(touch ≥)</th><th>P(touch ≤)</th><th>All-time volume</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.level}>
                    <td className="tl">{fmtLevel(r.level, unit)}</td>
                    <td className={r.high != null && r.high >= 0.5 ? 'touch-hot' : ''}>{pctStr(r.high)}</td>
                    <td className={r.low != null && r.low >= 0.5 ? 'touch-hot' : ''}>{pctStr(r.low)}</td>
                    <td>{fmtVol(r.vol)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* TREND & HISTORY — implied-range midpoint over time (Phase 1) */}
      {hist && <TrendHistorySection hist={hist} unit={unit} label="Range midpoint" />}

      <details className="detail-method">
        <summary>How these numbers are computed (methodology v{record.methodology_version ?? '—'})</summary>
        <ul>
          <li><b>Touch market</b>: each leg prices P(price touches a level before expiry) — a HIGH leg is P(touch ≥ level), a LOW leg is P(touch ≤ level). These are not points on a settlement distribution, so there is no implied median or CDF.</li>
          <li><b>Implied range</b>: the lower bound is where the LOW series crosses 50% (50% chance of breaking below); the upper bound is where the HIGH series crosses 50% (50% chance of breaking above). A bound shown as &ldquo;&lt; $X&rdquo; / &ldquo;&gt; $X&rdquo; means the crossover falls outside the quoted strike ladder.</li>
          <li><b>Confidence</b> = worst of {'{'}bid-ask spread, volume, last-trade fallback{'}'}; reasons shown above. <b>Provenance</b>: raw inputs + a re-verifiable sha256 (button above).</li>
        </ul>
      </details>
    </article>
  );
}
