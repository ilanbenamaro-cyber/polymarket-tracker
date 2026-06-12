// core/scenarios.js — TIER 2: scenario analysis (assumption-based).
//
// THE FIREWALL: nothing here is a market observation. Every output requires an
// external input the market did not provide (shares outstanding, a prior round
// valuation). Each scenario leaf carries an `assumptions` array sourced from
// core/assumptions.json — sourced, dated, ranged, adjustable. A scenario with no
// usable assumption renders `status:"input_required"`, NEVER a fabricated number.
// Tier-2 lives only under derived.scenarios; it never touches derived.market.

/** Project a registry assumption into the embedded, firewall-required shape. */
function assumptionView(reg, fallbackName) {
  if (!reg) return { name: fallbackName, status: 'input_required', adjustable: true };
  return {
    name: reg.name,
    value: reg.value ?? null,
    unit: reg.unit,
    source: reg.source,
    source_url: reg.source_url,
    as_of: reg.as_of,
    confidence: reg.confidence,
    adjustable: reg.adjustable === true,
    range: reg.range ?? null,
    note: reg.note,
  };
}

/**
 * Implied $/share for a market cap (in $T), given a share count and its range.
 * Pure. More shares → lower price, so the band inverts the shares range.
 * Returns { central, low, high } in USD/share (rounded to whole dollars).
 */
export function impliedSharePrice(capT, shares, sharesRange) {
  // Audit P1-4: the registry is hand-edited, so a 0/negative/non-finite shares
  // value or range bound is one keystroke away — and capUsd/0 = Infinity, which
  // JSON.stringify silently publishes as null. Guard every divisor; a bad range
  // degrades to a point estimate (low = high = central), never a fabricated band.
  const ok = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;
  if (capT == null || !Number.isFinite(capT) || !ok(shares)) {
    return { central: null, low: null, high: null };
  }
  const capUsd = capT * 1e12;
  const central = Math.round(capUsd / shares);
  let low = central, high = central;
  if (Array.isArray(sharesRange) && sharesRange.length === 2 && sharesRange.every(ok)) {
    const [sLow, sHigh] = sharesRange;
    low = Math.round(capUsd / sHigh); // most shares → lowest price
    high = Math.round(capUsd / sLow); // fewest shares → highest price
  }
  return { central, low, high };
}

/**
 * Build derived.scenarios from the current median + threshold ladder and the
 * assumptions registry. Every numeric leaf is accompanied by its assumption(s).
 */
export function buildScenarios({ median, markets, registry }) {
  const assumptions = registry?.assumptions ?? {};
  const shares = assumptions.shares_outstanding;
  const lastRound = assumptions.last_round_valuation;

  // ── Scenario 1: implied share price ──
  let share_price;
  const shareView = assumptionView(shares, 'shares_outstanding');
  if (shares && shares.value) {
    const at_median = impliedSharePrice(median, shares.value, shares.range);
    const ladder = markets.map((m) => ({
      threshold: m.threshold,
      cap_t: m.threshold,
      price: impliedSharePrice(m.threshold, shares.value, shares.range),
    }));
    share_price = {
      unit: 'USD_per_share',
      formula: 'implied_share_price = market_cap / shares_outstanding',
      at_median,
      ladder,
      assumptions: [shareView],
    };
  } else {
    share_price = {
      status: 'input_required',
      unit: 'USD_per_share',
      formula: 'implied_share_price = market_cap / shares_outstanding',
      ladder: markets.map((m) => ({ threshold: m.threshold, cap_t: m.threshold })),
      note: 'Provide shares outstanding to compute an implied share price.',
      assumptions: [shareView],
    };
  }

  // ── Scenario 2: round-over-round vs last reported valuation ──
  let round_over_round;
  const lastView = assumptionView(lastRound, 'last_round_valuation');
  if (lastRound && lastRound.value && median != null) {
    const pct = (m, base) => Math.round(((m - base) / base) * 1000) / 10; // 1dp %
    const central = pct(median, lastRound.value);
    let low = central, high = central;
    if (Array.isArray(lastRound.range) && lastRound.range.length === 2) {
      const a = pct(median, lastRound.range[0]);
      const b = pct(median, lastRound.range[1]);
      low = Math.min(a, b);
      high = Math.max(a, b);
    }
    round_over_round = {
      unit: 'percent',
      basis: 'implied IPO-close median vs last reported valuation',
      implied_change_pct: { central, low, high },
      assumptions: [lastView],
    };
  } else {
    round_over_round = {
      status: 'input_required',
      unit: 'percent',
      basis: 'implied IPO-close median vs last reported valuation',
      assumptions: [lastView],
    };
  }

  return {
    assumptions_version: registry?.version ?? null,
    share_price,
    round_over_round,
  };
}
