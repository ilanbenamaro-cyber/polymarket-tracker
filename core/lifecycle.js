// core/lifecycle.js — two-stage market-resolution classifier (ARCHITECTURE §5).
//
// Why this exists: the v1 pipeline pulled a market's prices forever — a resolved
// market kept showing a live, drifting "estimate" of a settled fact. Polymarket/
// UMA resolution can also LAG or be DISPUTED, so `closed:true` does NOT mean a
// confirmed outcome. We separate "stop showing live drift" from "declare the final
// result":
//   OPEN           — normal live processing.
//   CLOSED_PENDING — trading ended (closed) but UMA resolution unconfirmed; no
//                    final outcome is claimed (it may still move/dispute).
//   RESOLVED       — UMA confirmed (umaResolutionStatus === "resolved"); the
//                    outcome is final and frozen.
// Signals are live-probe-confirmed: `closed` + `umaResolutionStatus` +
// `outcomePrices`. We deliberately do NOT use `active` (stays true on a resolved
// market) or `endDate` (can be far-future even after early resolution). Pure.

export const LIFECYCLE = Object.freeze({
  OPEN: 'OPEN',
  CLOSED_PENDING: 'CLOSED_PENDING',
  RESOLVED: 'RESOLVED',
});

const UMA_RESOLVED = 'resolved';

/** Parse a Gamma array field that arrives as a JSON string OR an array. */
function parseArr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : null; } catch { return null; }
  }
  return null;
}

/** The winning outcome of one resolved rung: the outcome whose price settled to 1. */
function winningOutcome(rung) {
  const outcomes = parseArr(rung.outcomes);
  const prices = parseArr(rung.outcomePrices);
  if (!outcomes || !prices || outcomes.length !== prices.length) return null;
  const i = prices.findIndex((p) => Number(p) === 1);
  return i >= 0 ? outcomes[i] : null;
}

/**
 * Classify an event (a ladder of member-market rungs) into a lifecycle state.
 *   rungs: [{ threshold, closed, umaResolutionStatus, outcomes, outcomePrices }]
 * Conservative aggregation: RESOLVED only when EVERY rung is UMA-confirmed;
 * CLOSED_PENDING only when EVERY rung has stopped trading but is unconfirmed;
 * otherwise OPEN. Returns { state, resolved_outcome|null, as_of }.
 */
export function classifyLifecycle(rungs, asOf = null) {
  if (!Array.isArray(rungs) || rungs.length === 0) {
    return { state: LIFECYCLE.OPEN, resolved_outcome: null, as_of: asOf };
  }
  const allResolved = rungs.every((r) => r.umaResolutionStatus === UMA_RESOLVED);
  const allClosed = rungs.every((r) => r.closed === true);

  let state = LIFECYCLE.OPEN;
  if (allResolved) state = LIFECYCLE.RESOLVED;
  else if (allClosed) state = LIFECYCLE.CLOSED_PENDING;

  const resolved_outcome =
    state === LIFECYCLE.RESOLVED
      ? rungs
          .slice()
          .sort((a, b) => a.threshold - b.threshold)
          .map((r) => ({ threshold: r.threshold, outcome: winningOutcome(r) }))
      : null;

  return { state, resolved_outcome, as_of: asOf };
}
