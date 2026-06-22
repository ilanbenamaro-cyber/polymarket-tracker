// app/(app)/page.tsx — Zone 2 region. Reads the rail's ?m=<market_id> selection
// server-side and runs the AUTHORITATIVE probed serve for that one market (2c.3).
// No ?m= → empty state; the fetch is suspended (keyed by m) so a skeleton streams
// while the resolution probe runs on selection.
import { Suspense } from 'react';
import { DetailData, DetailEmpty, DetailSkeleton } from '@/components/zones/MarketDetailView';

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ m?: string }> }) {
  const { m } = await searchParams;
  if (!m) return <DetailEmpty />;
  return (
    <Suspense key={m} fallback={<DetailSkeleton />}>
      <DetailData id={m} />
    </Suspense>
  );
}
