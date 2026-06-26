// core/price-history.js — PURE reconstruction of a daily per-leg price series from
// Polymarket's CLOB prices-history responses (the history-backfill foundation, I1).
//
// Why this exists: backfilling market_history when a user adds a market means rebuilding
// one daily snapshot per UTC day from each leg's historical price series
// (`GET /prices-history?market=<token>&interval=max&fidelity=1440` → `{history:[{t,p}]}`).
// Two measured facts drive the logic (see the plan's evidence):
//   • daily buckets land a few seconds past 00:00 UTC and the exact second VARIES per token,
//     so legs only align when each point is floored to its UTC DATE (matching by raw `t` fails);
//   • a leg occasionally has no point on a date, so gaps are forward-filled (carry the last
//     known price) and FLAGGED, so the assembler (I2) can degrade that day's confidence.
// No I/O here — the fetch + DB write live in I3 (lib/backfill.mjs). Kept in core/ because it
// shapes the inputs the verified builders consume, exactly like the live fetchers do.

/** Floor a unix-SECONDS timestamp to its UTC calendar date 'YYYY-MM-DD'. */
export function utcDate(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Reduce one token's raw history ([{t,p}], any order) to a Map<date,'YYYY-MM-DD' → price>,
 * keeping the LAST point per UTC date (highest `t`) and ordered ascending by date. Malformed
 * points (null/absent t or p) are dropped; null/empty input yields an empty Map.
 */
export function dailyByDate(history) {
  const byDate = new Map(); // date → { t, p } (the latest point seen for that date)
  for (const pt of history ?? []) {
    if (pt == null || pt.t == null || pt.p == null) continue;
    const date = utcDate(pt.t);
    const cur = byDate.get(date);
    if (!cur || pt.t >= cur.t) byDate.set(date, { t: pt.t, p: pt.p });
  }
  return new Map(
    [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, v]) => [date, v.p]),
  );
}

/**
 * Reconstruct a per-date cross-leg price table from multiple tokens' raw histories.
 *   tokens: [{ token_id, history: [{t,p}] }]
 * Returns { tokenIds, rows } where rows is ascending by date and each row is
 *   { date, prices: { token_id: price }, filled: { token_id: bool }, complete: bool }
 * with:
 *   • prices — the last point for that UTC date, else the last known price carried forward;
 *   • filled[token] — true when that day's value came from forward-fill (no same-day point);
 *   • complete — every token has a value (a token before its FIRST point is absent, NOT
 *     back-filled, so such early days are incomplete and the assembler can skip/degrade them).
 */
export function reconstructDailySeries(tokens) {
  const list = (tokens ?? []).filter((t) => t && t.token_id != null);
  const tokenIds = list.map((t) => t.token_id);
  const perToken = new Map(list.map((t) => [t.token_id, dailyByDate(t.history)]));

  const allDates = new Set();
  for (const m of perToken.values()) for (const d of m.keys()) allDates.add(d);
  const dates = [...allDates].sort((a, b) => a.localeCompare(b));

  const lastByToken = new Map(); // token → last known price (only after its first datapoint)
  const rows = [];
  for (const date of dates) {
    const prices = {};
    const filled = {};
    let complete = true;
    for (const tok of tokenIds) {
      const m = perToken.get(tok);
      if (m.has(date)) {
        const p = m.get(date);
        prices[tok] = p;
        filled[tok] = false;
        lastByToken.set(tok, p);
      } else if (lastByToken.has(tok)) {
        prices[tok] = lastByToken.get(tok); // carry forward
        filled[tok] = true;
      } else {
        complete = false; // no datapoint yet for this leg → not back-filled
      }
    }
    rows.push({ date, prices, filled, complete });
  }
  return { tokenIds, rows };
}
