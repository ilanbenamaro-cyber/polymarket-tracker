// components/zones/ConfidenceBasis.tsx — v1 ITEM 11: the confidence basis as a tier-marked
// CHECKLIST of conditions, not a failure log. Shared by every detail view (ladder reframes it
// inline; binary/touch/categorical render this). For HIGH the stored reasons ARE the passing
// conditions (✓); MEDIUM marks caveats (·); LOW marks the conditions that failed (✗). The reason
// TEXT stays pipeline-generated — the display only reframes presentation by tier, it does not
// re-derive the conditions. Renders nothing when there are no reasons.

export function ConfidenceBasis({ reasons, tier }: { reasons?: string[] | null; tier?: string | null }) {
  if (!Array.isArray(reasons) || reasons.length === 0) return null;
  const mark = tier === 'high' ? '✓' : tier === 'low' ? '✗' : '·';
  return (
    <div className="trust-reasons" data-field="confidence-basis">
      <span className="label">Confidence basis</span>
      {reasons.map((r, i) => (
        <span key={i} className={`trust-chip conf-chip-${tier ?? 'medium'}`}>{mark} {r}</span>
      ))}
    </div>
  );
}
