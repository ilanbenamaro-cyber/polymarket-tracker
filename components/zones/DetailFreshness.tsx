'use client';
// components/zones/DetailFreshness.tsx — live data-freshness for the detail headline,
// mirroring the rail and docs/index.html renderFreshness: the POLICY (stale_after
// instant) is computed once in core/freshness.js and embedded in the record; the
// client only supplies `now` (stale = now > stale_after), so there's no duplicated
// threshold. Computed after mount to stay honest and avoid an SSR hydration mismatch.
// RESOLVED/final records are never stale (no stale_after).

import { useEffect, useState } from 'react';

function ageLabel(hours: number): string {
  if (!isFinite(hours) || hours < 1) return 'just now';
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  const d = Math.floor(hours / 24);
  const r = Math.floor(hours % 24);
  return r ? `${d}d ${r}h ago` : `${d}d ago`;
}

export function DetailFreshness({ asOf, staleAfter, fetchedAt, isFinal }: {
  asOf: string | null; staleAfter: string | null; fetchedAt: string | null; isFinal: boolean;
}) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  if (isFinal) return <span className="detail-fresh faint" data-field="freshness">final · no further updates</span>;
  if (now == null) return <span className="detail-fresh" data-field="freshness" suppressHydrationWarning />;

  const ref = Date.parse(asOf ?? fetchedAt ?? '');
  if (!Number.isFinite(ref)) return <span className="detail-fresh faint" data-field="freshness">—</span>;
  const ageH = (now - ref) / 3_600_000;
  const stale = staleAfter != null && now > Date.parse(staleAfter);
  return (
    <span className={`detail-fresh ${stale ? 'is-stale' : 'faint'}`} data-field="freshness">
      {ageLabel(ageH)}
      {stale && <span className="detail-stale-pill" data-field="stale-pill"> STALE</span>}
    </span>
  );
}
