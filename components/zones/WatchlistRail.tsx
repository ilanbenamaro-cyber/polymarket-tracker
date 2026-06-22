// components/zones/WatchlistRail.tsx — Zone 1 (watchlist rail) shell. 2c.1: empty.
// 2c.2 fills it from lib/watchlist.listVisible (personal ∪ org) as dense rows with
// a key metric + lifecycle dot, selecting a market to drive Zone 2.
export function WatchlistRail() {
  return (
    <aside className="rail" data-zone="rail">
      <div className="zone-head">Watchlist</div>
      <div className="empty">
        No markets yet.<br />Search and add one (2c.4).
      </div>
    </aside>
  );
}
