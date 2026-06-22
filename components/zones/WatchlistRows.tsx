'use client';
// components/zones/WatchlistRows.tsx — the rail's interactive row list (Zone 1).
//
// Receives ALREADY-ASSEMBLED light scan rows (lib/market-scan.assembleScanRows) from
// the WatchlistRail Server Component — no fetching, no secrets, no raw record here.
// Responsibilities: (1) SELECTION — set ?m=<market_id> so Zone 2 (2c.3) can read it
// server-side, and visibly mark the selected row; (2) render the dense pills using the
// EXISTING globals.css semantic tokens (confidence / delta / lifecycle / stale) — no
// new colors; (3) compute FRESHNESS client-side (live `now`), mirroring docs/index.html
// renderFreshness, so the stale pill is honest and there's no SSR hydration mismatch.

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { removeMarket } from '@/app/(app)/actions';

export interface ScanRow {
  market_id: string;
  title: string;
  scopes: Array<'personal' | 'org'>;
  personal: boolean;
  org_id: string | null;
  median_display: string;
  confidence_tier: 'high' | 'medium' | 'low' | null;
  lifecycle_state: 'OPEN' | 'CLOSED_PENDING' | 'RESOLVED' | null;
  is_final: boolean;
  stale_after: string | null;
  fetched_at: string | null;
  delta_display: string | null;
  delta_dir: 'up' | 'down' | 'flat';
  has_scan: boolean;
}

const CONF_CLASS: Record<string, string> = { high: 'conf-high', medium: 'conf-med', low: 'conf-low' };
const CONF_LABEL: Record<string, string> = { high: 'HIGH', medium: 'MED', low: 'LOW' };
const LIFECYCLE_CLASS: Record<string, string> = { OPEN: 'state-open', CLOSED_PENDING: 'state-pending', RESOLVED: 'state-resolved' };

function ageLabel(hours: number): string {
  if (!isFinite(hours) || hours < 1) return 'just now';
  if (hours < 24) return `${Math.floor(hours)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Freshness is time-dependent → compute on the client (live `now`) to stay honest and
 *  avoid a hydration mismatch. RESOLVED/final rows are never stale (no stale_after). */
function Freshness({ staleAfter, fetchedAt, isFinal }: { staleAfter: string | null; fetchedAt: string | null; isFinal: boolean }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000); // keep the stale pill current
    return () => clearInterval(id);
  }, []);

  if (isFinal) return <span className="wl-fresh faint">final</span>;
  if (now == null || !fetchedAt) return <span className="wl-fresh" suppressHydrationWarning />; // pre-mount: no SSR clock
  const ageH = (now - Date.parse(fetchedAt)) / 3_600_000;
  const stale = staleAfter != null && now > Date.parse(staleAfter);
  return (
    <span className={`wl-fresh ${stale ? 'is-stale' : 'faint'}`}>
      {ageLabel(ageH)}{stale && <span className="wl-stale-pill"> stale</span>}
    </span>
  );
}

export function WatchlistRows({ rows }: { rows: ScanRow[] }) {
  const selected = useSearchParams().get('m');
  const [removing, startRemove] = useTransition();

  function remove(r: ScanRow) {
    // dual-scope/personal row → drop the personal entry (row stays via org); org-only → drop the org entry.
    const orgId = r.scopes.includes('personal') ? null : r.org_id;
    startRemove(async () => { await removeMarket(r.market_id, orgId); });
  }

  return (
    <ul className="wl-list" data-zone="rail-list">
      {rows.map((r) => {
        const isSel = r.market_id === selected;
        const confClass = r.confidence_tier ? CONF_CLASS[r.confidence_tier] : '';
        const lifeClass = r.lifecycle_state ? LIFECYCLE_CLASS[r.lifecycle_state] : 'is-flat';
        return (
          <li key={r.market_id} className="wl-li">
            <Link
              href={`/?m=${encodeURIComponent(r.market_id)}`}
              scroll={false}
              className={`wl-row${isSel ? ' wl-selected' : ''}`}
              aria-current={isSel ? 'true' : undefined}
              data-market-id={r.market_id}
              data-selected={isSel ? 'true' : undefined}
            >
              <div className="wl-row-top">
                <span className={`wl-dot ${lifeClass}`} title={r.lifecycle_state ?? 'unknown'} aria-hidden="true" />
                <span className="wl-title" title={r.title}>{r.title}</span>
                {r.scopes.includes('org') && <span className="wl-chip label" title="shared org watchlist">ORG</span>}
              </div>
              <div className="wl-row-data num">
                <span className="wl-median" data-field="median">{r.median_display}</span>
                <span className={`wl-delta is-${r.delta_dir}`} data-field="delta">{r.delta_display ?? '—'}</span>
                {r.confidence_tier && (
                  <span className={`wl-conf ${confClass}`} data-field="confidence" title={`confidence ${r.confidence_tier}`}>
                    {CONF_LABEL[r.confidence_tier]}
                  </span>
                )}
                <Freshness staleAfter={r.stale_after} fetchedAt={r.fetched_at} isFinal={r.is_final} />
              </div>
            </Link>
            <button
              type="button"
              className="wl-remove"
              onClick={() => remove(r)}
              disabled={removing}
              title="remove from watchlist"
              aria-label={`remove ${r.title}`}
              data-field="remove-btn"
              data-market-id={r.market_id}
            >
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}
