'use client';
// components/zones/RefreshButton.tsx — force a fresh compute for the current market.
// Calls the refreshMarket server action (bypasses cache TTL, recomputes, writes a new
// snapshot, revalidates the DETAIL page only — not the rail). Shows a loading state
// while the probe/compute runs; surfaces an error instead of crashing.
import { useEffect, useState, useTransition } from 'react';
import { refreshMarket } from '@/app/(app)/actions';
import { KBD } from './kbd';

export function RefreshButton({ slug }: { slug: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onRefresh() {
    setError(null);
    start(async () => {
      const res = await refreshMarket(slug);
      if (!res.ok) setError(res.error ?? 'could not refresh');
    });
  }

  // Enh 8: the global 'R' shortcut refreshes the current market (one RefreshButton mounts
  // per detail). Ignored while a refresh is already in flight.
  useEffect(() => {
    function onKbd() { if (!pending) onRefresh(); }
    window.addEventListener(KBD.refresh, onKbd);
    return () => window.removeEventListener(KBD.refresh, onKbd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, slug]);

  return (
    <span className="detail-refresh-wrap">
      <button
        type="button"
        className="detail-refresh"
        onClick={onRefresh}
        disabled={pending}
        data-field="refresh-btn"
        title="Force a fresh compute (bypass the cache)"
      >
        {pending ? 'refreshing…' : '↻ refresh'}
      </button>
      {error && <span className="detail-refresh-err" data-field="refresh-error">{error}</span>}
    </span>
  );
}
