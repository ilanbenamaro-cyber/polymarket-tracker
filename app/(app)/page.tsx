// app/(app)/page.tsx — Zone 2 (market detail) region. 2c.1 ships the empty shell;
// the generalized verified detail view (headline / confidence / ladder / provenance
// / freshness / resolution — generalizing docs/index.html) is built in 2c.3.
import { MarketDetail } from '@/components/zones/MarketDetail';

export default function DashboardPage() {
  return <MarketDetail />;
}
