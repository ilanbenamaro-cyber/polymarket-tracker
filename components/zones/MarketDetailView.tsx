// components/zones/MarketDetailView.tsx — Zone 2 (market detail), 2c.3.
//
// PORT-AND-GENERALIZE of docs/index.html into the terminal detail pane, fed by the
// authoritative probed serve for the ONE selected market. DetailData runs serveMarket
// DIRECTLY (same shared DEPS as /api/market — no drift, behavior-identical, no HTTP
// hop) — the correctness layer, opposite of the rail's cached read. Render order puts
// the TRUST band high (a fund's "can I trust this number" is co-equal with the number).
// History-dependent sections (trends/Δ-columns/movers) are cut: /api/market carries no
// history; analytics.velocity conveys movement. Tier-2 scenarios cut (locked 2c scope).
// Defensive: optional-chaining + per-section fallbacks so a thin record degrades, never throws.
import { serveMarket } from '@/lib/serve-market.mjs';
import { DEPS } from '@/lib/market-deps.mjs';
import { canonicalizeRawInputs } from '@/core/fetch.js';
import { readHistory, headlineValue, deriveVelocity, deriveDispersion } from '@/lib/market-history.mjs';
import { unitFromLadder, fmtMoney, fmtRange, fmtEastern } from '@/lib/format-detail.mjs';
import { DistributionSVG } from './DistributionSVG';
import { SettlementConsensus } from './SettlementConsensus';
import { TrendHistorySection, type HistoryUI, type VelocityResult, type DispersionResult } from './TrendHistory';
import { HashVerify } from './HashVerify';
import { DetailFreshness } from './DetailFreshness';
import { RefreshButton } from './RefreshButton';
import { BinaryDetailView } from './BinaryDetailView';
import { TouchDetailView } from './TouchDetailView';
import { CategoricalDetailView } from './CategoricalDetailView';
import type { MarketRecord, ServeBody, Analytics, ResolvedLeg, LadderRow } from './market-record';

// Shape for the Phase 1 history rows (lib/market-history.mjs is untyped JS; this types the
// boundary readHistory returns). The derived velocity/dispersion/UI types live in TrendHistory.
interface HistoryRow {
  snapshot_date: string; kind: string;
  implied_median: number | null; probability: number | null;
  touch_range_lo: number | null; touch_range_hi: number | null;
  record: MarketRecord;
}

const CONF_CLASS: Record<string, string> = { high: 'conf-high', medium: 'conf-med', low: 'conf-low' };
const LIFECYCLE_CLASS: Record<string, string> = { OPEN: 'state-open', CLOSED_PENDING: 'state-pending', RESOLVED: 'state-resolved' };
const LIFECYCLE_LABEL: Record<string, string> = { OPEN: 'OPEN', CLOSED_PENDING: 'CLOSED · PENDING', RESOLVED: 'RESOLVED' };

const pct = (p: number | null | undefined) => (p == null ? '—' : `${Math.round(p * 100)}%`);
const pct1 = (p: number | null | undefined) => (p == null ? '—' : `${(p * 100).toFixed(1)}%`);
const fmtVol = (v: number | null | undefined) => (v == null ? '—' : `$${Math.round(v).toLocaleString('en-US')}`);

/** The realized band from a RESOLVED outcome ladder: highest Yes → first No. */
function resolvedBand(outcome: ResolvedLeg[] | undefined, unit: string): string | null {
  if (!Array.isArray(outcome) || outcome.length === 0) return null;
  const yes = outcome.filter((o) => o.outcome === 'Yes').map((o) => o.threshold);
  const no = outcome.filter((o) => o.outcome === 'No').map((o) => o.threshold);
  const lastYes = yes.length ? Math.max(...yes) : null;
  const firstNo = no.length ? Math.min(...no) : null;
  if (lastYes != null && firstNo != null) return `settled in $${lastYes}–${firstNo}${unit}  (>$${lastYes}${unit} Yes · >$${firstNo}${unit} No)`;
  if (lastYes != null) return `settled above $${lastYes}${unit}`;
  if (firstNo != null) return `settled below $${firstNo}${unit}`;
  return null;
}

/* ── async data boundary: the authoritative serve for one market ── */
export async function DetailData({ id }: { id: string }) {
  const { status, body } = (await serveMarket({ id, deps: DEPS })) as { status: number; body: ServeBody };
  if (status !== 200 || !body?.record) {
    return <DetailError id={id} status={status} message={body?.error} />;
  }
  // History layer (Phase 1): read the stored daily series and derive trend analytics +
  // a LEAN chart series (the heavy record JSONB never ships to the client). Additive —
  // a read failure degrades to empty, never breaking the authoritative serve.
  const dk = body.record?.snapshot?.derived?.kind;
  const chartKind = dk === 'binary' ? 'binary'
    : dk === 'categorical' ? 'categorical'
    : dk === 'directional_touch' ? 'directional_touch' : 'ladder';
  let rows: HistoryRow[] = [];
  try { rows = (await readHistory(id, 90)) as HistoryRow[]; } catch { rows = []; }
  const hist: HistoryUI = {
    velocity: deriveVelocity(rows) as VelocityResult,
    dispersion: deriveDispersion(rows) as DispersionResult,
    points: rows.map((r) => ({ date: r.snapshot_date, value: headlineValue(r) as number })).filter((p) => p.value != null),
    kind: chartKind,
  };
  return <MarketDetailView record={body.record} envelope={body} hist={hist} />;
}

function MarketDetailView({ record, envelope, hist }: { record: MarketRecord; envelope: ServeBody; hist: HistoryUI }) {
  // Binary (Yes/No) markets get a distinct, simpler layout — no CDF/ladder/analytics.
  if (record?.snapshot?.derived?.kind === 'binary') {
    return <BinaryDetailView record={record} envelope={envelope} hist={hist} />;
  }
  // Directional-touch (WTI/Silver "hit $X") markets: implied range + touch table, no CDF.
  if (record?.snapshot?.derived?.kind === 'directional_touch') {
    return <TouchDetailView record={record} envelope={envelope} hist={hist} />;
  }
  // Categorical (named outcomes, e.g. Fed rate cuts): outcome distribution, no CDF.
  if (record?.snapshot?.derived?.kind === 'categorical') {
    return <CategoricalDetailView record={record} envelope={envelope} hist={hist} />;
  }
  const s = record?.snapshot ?? {};
  const d = s?.derived ?? {};
  const asset = record?.asset ?? {};
  const lifecycleState: string = s?.lifecycle?.state ?? envelope?.lifecycle_state ?? 'OPEN';
  const isFinal = lifecycleState === 'RESOLVED';
  const unit = unitFromLadder(d.markets);
  const conf = d.confidence ?? {};
  const fresh = d.freshness ?? {};
  const analytics = d?.market?.analytics ?? null;
  const rawSha: string = s?.source?.raw_sha256 ?? '';
  const canonical = Array.isArray(s?.raw_inputs) ? canonicalizeRawInputs(s.raw_inputs) : '';
  const band = resolvedBand(s?.lifecycle?.resolved_outcome, unit);
  const near = d.near_settlement === true && lifecycleState === 'OPEN'; // amber NEAR SETTLEMENT (Bug 3)

  return (
    <article className="detail-view" data-zone="detail-view" data-market-id={envelope?.market_id} data-lifecycle={lifecycleState}>
      {/* HEADER */}
      <header className="detail-head">
        <div>
          <h1 className="detail-title" data-field="title">{asset.name ?? envelope?.market_id}</h1>
          <div className="detail-sub muted">
            {asset.platform ?? 'polymarket'}{asset.resolves ? ` · resolves ${asset.resolves}` : ''}
            {asset.market_url && <> · <a href={asset.market_url} target="_blank" rel="noopener">view market ↗</a></>}
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

      {/* RESOLVED banner — prominent, frozen outcome, no live pull */}
      {isFinal && (
        <div className="detail-resolved" data-field="resolved-banner">
          <span className="detail-resolved-tag">RESOLVED</span>
          <span className="detail-resolved-band">{band ?? 'settled'}</span>
          <span className="detail-resolved-note faint">final record · served from cache, not re-pulled live</span>
        </div>
      )}

      {/* HEADLINE */}
      <div className="detail-headline">
        <div className="detail-metric">
          <span className="label">Implied median</span>
          <span className="detail-hero num" data-field="median">{fmtMoney(d.implied_median, unit)}</span>
          <span className="detail-band faint">{fmtRange(d.median, unit) ? `range ${fmtRange(d.median, unit)} · bid/ask` : 'point estimate'}</span>
        </div>
        <div className="detail-metric">
          <span className="label">Implied mean <span className="faint">(approx)</span></span>
          <span className="detail-sec num" data-field="mean">{fmtMoney(d.implied_mean, unit)}</span>
          <span className="detail-band faint">{d.mean?.tail_insensitive ? 'tail-insensitive (±<$0.01)' : (fmtRange(d.mean, unit) ? `range ${fmtRange(d.mean, unit)} · tail` : '')}</span>
        </div>
        <div className="detail-metric">
          <span className="label">50% band</span>
          <span className="detail-sec num" data-field="iqr">{d.iqr ? `${fmtMoney(d.iqr.p25, unit)} – ${fmtMoney(d.iqr.p75, unit)}` : '—'}</span>
          <span className="detail-band faint">p25–p75 valuation</span>
        </div>
        <div className="detail-metric">
          <span className="label">Confidence</span>
          <span className={`detail-conf ${conf.tier ? CONF_CLASS[conf.tier] : ''}`} data-field="confidence" title={conf.score != null ? `score ${conf.score}` : ''}>
            {conf.tier ? conf.tier.toUpperCase() : '—'}
          </span>
          <span className="detail-band faint">{conf.score != null ? `score ${conf.score}` : ''}</span>
        </div>
      </div>

      {/* TRUST BAND — prominent, before the distribution */}
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
          {rawSha && canonical
            ? <HashVerify canonical={canonical} publishedHash={rawSha} />
            : <span className="faint">unavailable</span>}
        </div>
      </div>

      {/* NARRATIVE */}
      {d.narrative && <p className="detail-narrative" data-field="narrative">{d.narrative}</p>}

      {/* DISTRIBUTION — the analytical centerpiece. Near settlement the CDF is a step from
          1→0 with no remaining signal, so swap it for the settlement-consensus view (Bug 6). */}
      <section className="detail-section">
        <h2 className="detail-h2">{near ? 'Settlement consensus' : 'Distribution'}</h2>
        {near
          ? <SettlementConsensus markets={d.markets} impliedMedian={d.implied_median ?? null} unit={unit} />
          : <DistributionSVG markets={d.markets} impliedMedian={d.implied_median ?? null} unit={unit} />}
      </section>

      {/* TREND & HISTORY — the daily series (Phase 1). Velocity/dispersion show an explicit
          "Collecting" state until enough days accrue; never dashes. */}
      <TrendHistorySection hist={hist} unit={unit} label="Implied median" />

      {/* TIER-1 ANALYTICS — always rendered (real data, "—" per missing field, or an
          explicit insufficient-data state); never silently absent. */}
      <AnalyticsCards analytics={analytics} unit={unit} />

      {/* ALL THRESHOLDS (current columns only — no history in /api/market) */}
      {Array.isArray(d.markets) && d.markets.length > 0 && (
        <section className="detail-section">
          <h2 className="detail-h2">All thresholds <span className="faint">· current snapshot</span></h2>
          <div className="detail-table-wrap">
            <table className="detail-table num" data-field="ladder">
              <thead><tr><th className="tl">Threshold</th><th>P(&gt;X)</th><th>Bucket %</th><th>All-time volume</th></tr></thead>
              <tbody>
                {d.markets.map((m: LadderRow, i: number) => {
                  const adj = m.raw_prob != null && Math.abs(m.raw_prob - m.adjusted_prob) > 0.005;
                  return (
                    <tr key={`${m.threshold}-${i}`} className={m.volume_tier === 'low' ? 'thin' : ''}>
                      <td className="tl">{m.label}{adj && <span className="adjmark" title={`isotonic-adjusted from raw ${pct(m.raw_prob)}`}> △</span>}</td>
                      <td>{pct(m.prob)}</td>
                      <td>{pct1(m.bucket_prob)}</td>
                      <td><span className={`vdot v-${m.volume_tier ?? 'na'}`} />{fmtVol(m.volume)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* METHODOLOGY disclosure */}
      <details className="detail-method">
        <summary>How these numbers are computed (methodology v{record.methodology_version ?? '—'})</summary>
        <ul>
          <li><b>Arbitrage adjustment</b>: each &ldquo;above $X&rdquo; book is separate, so raw midpoints can violate monotonicity. We apply volume-weighted isotonic regression (PAVA) to a non-increasing CDF; every metric uses the adjusted curve, raw_prob preserved (△ marks an adjusted row).</li>
          <li><b>Implied median</b> = adjusted CDF crosses 50%. <b>Bucket %</b> = P(&gt;this) − P(&gt;next); buckets ≥ 0 and sum to 100%.</li>
          <li><b>Confidence</b> = worst of {'{'}threshold count, monotonicity, spread, thin liquidity, anomalies{'}'}; reasons shown above.</li>
          <li><b>Provenance</b>: every snapshot stores raw inputs + a sha256 you can re-verify (button above).</li>
        </ul>
      </details>
    </article>
  );
}

function AnalyticsCards({ analytics, unit }: { analytics: Analytics | null; unit: string }) {
  if (!analytics) {
    return (
      <section className="detail-section">
        <h2 className="detail-h2">Market analytics <span className="tier1-tag">Tier 1 · market-derived</span></h2>
        <div className="empty" data-field="analytics-insufficient">Analytics pending — insufficient history for this market.</div>
      </section>
    );
  }
  const sh = analytics.shape ?? {};
  const di = analytics.dispersion ?? {};
  const ve = analytics.velocity ?? {};
  const skew = sh.skew_bowley == null ? '—' : `${sh.skew_bowley > 0.1 ? 'right (upside)' : sh.skew_bowley < -0.1 ? 'left (downside)' : '~symmetric'} (${sh.skew_bowley.toFixed(2)})`;
  const consensus = sh.entropy == null ? '—' : `${sh.entropy < 0.5 ? 'tight' : sh.entropy < 0.78 ? 'moderate' : 'wide'} (${sh.entropy.toFixed(2)})`;
  const disp = di.trend ? `${di.trend} · width ${di.iqr_width != null ? `$${di.iqr_width.toFixed(2)}${unit}` : '—'}` : '—';
  const drift = ve.drift_30d_annualized != null ? `${ve.drift_30d_annualized > 0 ? '+' : ''}${ve.drift_30d_annualized.toFixed(2)} $${unit}/yr` : '—';
  const cards = [
    { l: 'Shape (skew)', v: skew, s: sh.fat_tail != null ? `fat-tail ${sh.fat_tail.toFixed(2)}×` : '' },
    { l: 'Consensus (entropy)', v: consensus, s: sh.dominant_bucket?.label ? `mass at ${sh.dominant_bucket.label}` : '' },
    { l: 'Dispersion (25–75)', v: disp, s: di.trend === 'converging' ? 'narrowing → more certain' : di.trend === 'diverging' ? 'widening → less certain' : 'stable' },
    { l: 'Velocity', v: ve.acceleration ?? '—', s: `median drift ${drift}` },
  ];
  return (
    <section className="detail-section">
      <h2 className="detail-h2">Market analytics <span className="tier1-tag">Tier 1 · market-derived</span></h2>
      <div className="detail-analytics" data-field="analytics">
        {cards.map((c) => (
          <div key={c.l} className="acard">
            <div className="label">{c.l}</div>
            <div className="acard-v">{c.v}</div>
            <div className="acard-s faint">{c.s}</div>
          </div>
        ))}
      </div>
      {analytics.descriptor && <p className="detail-analytics-desc faint">{analytics.descriptor}</p>}
    </section>
  );
}

/* ── states ── */
export function DetailEmpty() {
  return (
    <div className="empty" data-zone="detail-empty">
      Select a market from the watchlist,<br />or search to add one.
    </div>
  );
}

export function DetailSkeleton() {
  return (
    <div className="detail-view" data-zone="detail-skeleton" aria-hidden="true">
      <div className="wl-skel-bar" style={{ width: '46%', height: 18, marginBottom: 18 }} />
      <div className="wl-skel-bar" style={{ width: '70%', height: 40, marginBottom: 12 }} />
      <div className="wl-skel-bar" style={{ width: '90%', height: 12, marginBottom: 24 }} />
      <div className="wl-skel-bar" style={{ width: '100%', height: 160 }} />
    </div>
  );
}

function DetailError({ id, status, message }: { id: string; status: number; message?: string }) {
  return (
    <div className="empty wl-error" data-zone="detail-error" data-status={status}>
      Couldn’t load <code>{id}</code> (status {status}).<br />
      <span className="faint">{message ?? 'Try another market, or retry shortly.'}</span>
    </div>
  );
}
