// components/zones/CategoricalDetailView.tsx — Zone 2 detail for a CATEGORICAL market.
//
// Rendered by MarketDetailView when derived.kind === 'categorical' (e.g. "How many Fed rate
// cuts in 2026?"). A categorical market is a probability distribution over NAMED outcomes —
// no median/CDF/ladder. So this view shows what the data is: the dominant outcome (headline),
// a horizontal outcome-bar chart (de-vigged probabilities, sorted desc, dominant in amber), a
// consensus meter (Shannon entropy), and a volume table. The TRUST layer (confidence,
// freshness, provenance + hash-verify) is identical to every other detail. Server component;
// canonicalizes raw_inputs server-side for the in-browser verify.
import { canonicalizeRawInputs } from '@/core/fetch.js';
import { fmtEastern } from '@/lib/format-detail.mjs';
import { HashVerify } from './HashVerify';
import { DetailFreshness } from './DetailFreshness';
import { RefreshButton } from './RefreshButton';
import { TrendHistorySection, type HistoryUI } from './TrendHistory';
import type { MarketRecord, ServeBody, ResolvedLeg, CategoricalOutcome } from './market-record';

const CONF_CLASS: Record<string, string> = { high: 'conf-high', medium: 'conf-med', low: 'conf-low' };
const LIFECYCLE_CLASS: Record<string, string> = { OPEN: 'state-open', CLOSED_PENDING: 'state-pending', RESOLVED: 'state-resolved' };
const LIFECYCLE_LABEL: Record<string, string> = { OPEN: 'OPEN', CLOSED_PENDING: 'CLOSED · PENDING', RESOLVED: 'RESOLVED' };

const pctStr = (p: number | null | undefined) => (p == null ? '—' : `${Math.round(p * 100)}%`);
const pct1 = (p: number | null | undefined) => (p == null ? '—' : `${(p * 100).toFixed(1)}%`);
const fmtVol = (v: number | null | undefined) => (v == null ? '—' : `$${Math.round(v).toLocaleString('en-US')}`);

/** Consensus descriptor from normalized Shannon entropy (0 = certain, 1 = wide open). */
function consensusLabel(entropy: number | undefined): { label: string; cls: string } {
  if (entropy == null) return { label: '—', cls: '' };
  if (entropy < 0.5) return { label: 'HIGH CONSENSUS', cls: 'conf-high' };
  if (entropy < 0.78) return { label: 'CONTESTED', cls: 'conf-med' };
  return { label: 'WIDE OPEN', cls: 'conf-low' };
}

/** The settled outcome from a RESOLVED categorical event: the leg whose price went to 1. */
function resolvedWinner(outcome: ResolvedLeg[] | undefined): string | null {
  if (!Array.isArray(outcome) || outcome.length === 0) return null;
  const won = outcome.find((o) => o.outcome && o.outcome !== 'No');
  return won ? `resolved: ${won.outcome}` : null;
}

/** Horizontal outcome-bar chart — one labeled bar per outcome, width ∝ probability, the
 *  dominant bar in amber. Hand-rolled SVG (no charting dep), single-string <text> children. */
function OutcomeBars({ outcomes }: { outcomes: CategoricalOutcome[] }) {
  if (outcomes.length === 0) return <div className="empty" data-field="outcomes-empty">No outcome data.</div>;
  const max = Math.max(0.01, ...outcomes.map((o) => o.probability));
  const rowH = 26;
  const VB_W = 480;
  const VB_H = outcomes.length * rowH + 8;
  const labelW = 150;
  const barMax = VB_W - labelW - 52; // leave room for the % at the right
  return (
    <svg className="cat-bars" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label="Outcome probability distribution" data-field="outcome-bars">
      {outcomes.map((o, i) => {
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
  );
}

export function CategoricalDetailView({ record, envelope, hist }: { record: MarketRecord; envelope: ServeBody; hist?: HistoryUI }) {
  const s = record?.snapshot ?? {};
  const d = s?.derived ?? {};
  const asset = record?.asset ?? {};
  const lifecycleState: string = s?.lifecycle?.state ?? envelope?.lifecycle_state ?? 'OPEN';
  const isFinal = lifecycleState === 'RESOLVED';
  const conf = d.confidence ?? {};
  const fresh = d.freshness ?? {};
  const outcomes = (d.outcomes ?? []) as CategoricalOutcome[];
  const consensus = consensusLabel(d.entropy);
  const rawSha: string = s?.source?.raw_sha256 ?? '';
  const canonical = Array.isArray(s?.raw_inputs) ? canonicalizeRawInputs(s.raw_inputs) : '';
  const winner = resolvedWinner(s?.lifecycle?.resolved_outcome);

  return (
    <article className="detail-view" data-zone="detail-view" data-kind="categorical" data-market-id={envelope?.market_id} data-lifecycle={lifecycleState}>
      <header className="detail-head">
        <div>
          <h1 className="detail-title" data-field="title">{asset.name ?? envelope?.market_id}</h1>
          <div className="detail-sub muted">
            {asset.platform ?? 'polymarket'}{asset.resolves ? ` · resolves ${asset.resolves}` : ''}
            {asset.market_url && <> · <a href={asset.market_url} target="_blank" rel="noopener">view market ↗</a></>}
            <> · <span className="cat-tag">CATEGORICAL</span></>
          </div>
        </div>
        <div className="detail-head-actions">
          {envelope?.market_id && <RefreshButton slug={envelope.market_id} />}
          <span className={`detail-lifecycle ${LIFECYCLE_CLASS[lifecycleState] ?? ''}`} data-field="lifecycle">
            ● {LIFECYCLE_LABEL[lifecycleState] ?? lifecycleState}
          </span>
        </div>
      </header>

      {isFinal && (
        <div className="detail-resolved" data-field="resolved-banner">
          <span className="detail-resolved-tag">RESOLVED</span>
          <span className="detail-resolved-band">{winner ?? 'settled'}</span>
          <span className="detail-resolved-note faint">final record · served from cache, not re-pulled live</span>
        </div>
      )}

      {/* HEADLINE — the dominant outcome */}
      <div className="detail-headline">
        <div className="detail-metric detail-metric-wide">
          <span className="label">Most likely outcome</span>
          <span className="detail-hero num" data-field="dominant">{d.dominant_outcome ?? '—'} <span className="faint">{pctStr(d.dominant_prob)}</span></span>
          <span className="detail-band faint">{d.implied_winner === 'no consensus' ? 'no single outcome above 50% — no consensus' : 'market consensus leader'}</span>
        </div>
        <div className="detail-metric">
          <span className="label">Consensus</span>
          <span className={`detail-conf ${consensus.cls}`} data-field="consensus">{consensus.label}</span>
          <span className="detail-band faint">{d.entropy != null ? `entropy ${d.entropy.toFixed(2)}` : ''}</span>
        </div>
        <div className="detail-metric">
          <span className="label">Confidence</span>
          <span className={`detail-conf ${conf.tier ? CONF_CLASS[conf.tier] : ''}`} data-field="confidence" title={conf.score != null ? `score ${conf.score}` : ''}>
            {conf.tier ? conf.tier.toUpperCase() : '—'}
          </span>
          <span className="detail-band faint">{conf.score != null ? `score ${conf.score}` : ''}</span>
        </div>
      </div>

      {/* TRUST BAND — identical to every other detail */}
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

      {/* OUTCOME DISTRIBUTION — the analytical centerpiece */}
      <section className="detail-section">
        <h2 className="detail-h2">Outcome distribution <span className="faint">· de-vigged, sums to 100%</span></h2>
        <OutcomeBars outcomes={outcomes} />
      </section>

      {/* VOLUME TABLE — where the conviction sits */}
      {outcomes.length > 0 && (
        <section className="detail-section">
          <h2 className="detail-h2">Outcomes <span className="faint">· current snapshot</span></h2>
          <div className="detail-table-wrap">
            <table className="detail-table num" data-field="categorical-table">
              <thead><tr><th className="tl">Outcome</th><th>Probability</th><th>Raw (pre-devig)</th><th>All-time volume</th></tr></thead>
              <tbody>
                {outcomes.map((o, i) => (
                  <tr key={i} className={i === 0 ? 'cat-row-top' : ''}>
                    <td className="tl">{o.label}</td>
                    <td>{pct1(o.probability)}</td>
                    <td className="faint">{pct1(o.raw_probability)}</td>
                    <td>{fmtVol(o.volume)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* TREND & HISTORY — dominant-outcome probability over time (Phase 1) */}
      {hist && <TrendHistorySection hist={hist} unit="" label="Dominant-outcome probability" />}

      <details className="detail-method">
        <summary>How these numbers are computed (methodology v{record.methodology_version ?? '—'})</summary>
        <ul>
          <li><b>Categorical market</b>: each named outcome is a Yes/No leg; its YES midpoint is P(outcome). The legs are mutually exclusive, so the midpoints form a PMF.</li>
          <li><b>De-vig</b>: leg midpoints carry the market-maker overround, so we normalize them to sum to 100% for display. The <b>raw</b> observed midpoints (shown in the table) are what enter raw_inputs + the hash — the hash is over truth, not the normalized presentation.</li>
          <li><b>Consensus</b> = normalized Shannon entropy (0 = one outcome certain, 1 = all outcomes equal). <b>Confidence</b> = worst of {'{'}spread, volume, last-trade fallback{'}'}. <b>Provenance</b>: re-verifiable sha256 (button above).</li>
        </ul>
      </details>
    </article>
  );
}
