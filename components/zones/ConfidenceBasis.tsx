// components/zones/ConfidenceBasis.tsx — the confidence basis as a tier-marked CHECKLIST of
// conditions, not a failure log. For HIGH the stored reasons ARE the passing conditions (✓); MEDIUM
// marks caveats (·); LOW marks the conditions that failed (✗). The reason TEXT stays pipeline-
// generated — the display only reframes presentation by tier. Renders nothing when there are no
// reasons.
//
// Confidence is now TWO independent dimensions — RELIABILITY (is the number trustworthy) and
// LIQUIDITY (can you transact). ConfidenceBasisGroup renders one labelled basis row per dimension;
// ConfidenceBadges renders the headline two-badge cell. A missing dimension (legacy pre-0010 data)
// renders "—", never a fabricated tier.

import type { Confidence, ConfidenceDimension, Tier } from './market-record';

const CONF_CLASS: Record<string, string> = { high: 'conf-high', medium: 'conf-med', low: 'conf-low' };

export function ConfidenceBasis({ reasons, tier, label = 'Confidence basis', field }:
  { reasons?: string[] | null; tier?: string | null; label?: string; field?: string }) {
  if (!Array.isArray(reasons) || reasons.length === 0) return null;
  const mark = tier === 'high' ? '✓' : tier === 'low' ? '✗' : '·';
  return (
    <div className="trust-reasons" data-field={field ?? 'confidence-basis'}>
      <span className="label">{label}</span>
      {reasons.map((r, i) => (
        <span key={i} className={`trust-chip conf-chip-${tier ?? 'medium'}`}>{mark} {r}</span>
      ))}
    </div>
  );
}

/** Both basis rows (reliability + liquidity), each labelled with its own tier marks. Renders nothing
 *  when neither dimension carries reasons. */
export function ConfidenceBasisGroup({ confidence }: { confidence?: Confidence | null }) {
  const rel = confidence?.reliability, liq = confidence?.liquidity;
  if (!rel?.reasons?.length && !liq?.reasons?.length) return null;
  return (
    <>
      <ConfidenceBasis reasons={rel?.reasons} tier={rel?.tier} label="Reliability basis" field="reliability-basis" />
      <ConfidenceBasis reasons={liq?.reasons} tier={liq?.tier} label="Liquidity basis" field="liquidity-basis" />
    </>
  );
}

function Badge({ dim, label, field }: { dim?: ConfidenceDimension | null; label: string; field: string }) {
  const tier = dim?.tier as Tier | undefined;
  return (
    <span className="detail-conf-badge" data-field={field}>
      <span className="detail-conf-badge-label">{label}</span>
      <span className={`detail-conf ${tier ? CONF_CLASS[tier] : ''}`} data-field={`${field}-tier`}
        title={dim?.score != null ? `score ${dim.score}` : ''}>
        {tier ? tier.toUpperCase() : '—'}
      </span>
    </span>
  );
}

/** The headline confidence cell: two stacked badges, RELIABILITY + LIQUIDITY. */
export function ConfidenceBadges({ confidence }: { confidence?: Confidence | null }) {
  return (
    <span className="detail-conf-split" data-field="confidence">
      <Badge dim={confidence?.reliability} label="Reliability" field="reliability" />
      <Badge dim={confidence?.liquidity} label="Liquidity" field="liquidity" />
    </span>
  );
}
