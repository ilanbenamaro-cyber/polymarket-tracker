// components/zones/MarketDetail.tsx — Zone 2 (market detail) shell. 2c.1: empty
// "select a market" state. 2c.3 fetches /api/market?id= and renders the generalized
// verified record (headline metric, confidence tier, threshold ladder, provenance
// + hash verify, freshness, resolution state) — generalizing docs/index.html.
export function MarketDetail() {
  return (
    <>
      <div className="zone-head">Market detail</div>
      <div className="empty" data-zone="detail-empty">
        Select a market from the watchlist,<br />or search to add one.
      </div>
    </>
  );
}
