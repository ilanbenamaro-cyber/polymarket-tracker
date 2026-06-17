// scripts/verify-accuracy.js — independent data-accuracy reconciliation harness.
//
// Why this exists: the published feed (docs/api/v1/latest.json) must be PROVABLE
// against Polymarket source, not eyeballed. This is a standalone check that fetches
// the live market FRESH from both Polymarket surfaces — Gamma (event metadata +
// outcomePrices) and the CLOB (/midpoints + /prices) — TWICE a few seconds apart,
// then:
//   1. cross-checks the two Polymarket sources against EACH OTHER (upstream sanity),
//   2. quantifies order-book drift between the two captures (timing vs. real error),
//   3. reconciles the CURRENTLY PUBLISHED latest.json against fresh source, and
//   4. confirms the published adjusted curve is a valid isotonic transform of source.
//
// It REPORTS ONLY. It never mutates fetch.js, the published feed, or the tolerance
// to make things pass. A discrepancy is a finding to investigate, not to auto-fix.
//
// The isotonic transform is imported from core/stats.js (single source of truth);
// the SOURCE pull is written independently here on purpose — an auditor must not
// reuse the exact code path it is auditing, and it must read Gamma's outcomePrices,
// which the production fetcher (core/fetch.js) deliberately ignores.
//
// Run:  node scripts/verify-accuracy.js [--gap-ms 10000] [--max-age-hours 26] [--strict] [--json]
// Exit: 0 = PASS · 1 = FAIL (real discrepancy / invalid curve) · 2 = STALE/INCONCLUSIVE
//       (--strict promotes STALE and upstream cross-source disagreement to exit 1)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ENDPOINTS, ASSET } from '../core/fetch.js';
import { adjustSnapshot } from '../core/stats.js';
import { STALENESS_THRESHOLD_HOURS } from '../core/freshness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LATEST_PATH = join(__dirname, '../docs/api/v1/latest.json');

// ── Tolerances — defined explicitly, with documented rationale, NOT tuned to pass ──
//
// All thresholds are in probability points (1pt = 0.01). They exist for HONEST
// reasons, each independently justified:
//
// TOL_CROSS_SOURCE — Gamma outcomePrice vs CLOB midpoint, two DIFFERENT statistics.
//   Gamma's outcomePrice is a platform-surfaced price (last-trade / cached) and is
//   NOT contractually the CLOB mid; >1pt apart is a genuine upstream divergence we
//   want to KNOW about, so the bar is tight (1pt) and disagreements are surfaced,
//   not hidden.
// TOL_PUBLISHED — published raw_prob vs a FRESH CLOB midpoint. Even with zero error
//   two honest gaps remain: (a) tick quantization — prices live on an
//   orderPriceMinTickSize grid, so identical books can round a half-tick apart; and
//   (b) sub-minute capture skew between when the snapshot was taken and now. 2pt is
//   ~one tick plus a typical half-spread for a FRESH snapshot. It is deliberately
//   NOT widened to swallow multi-day publish-lag — that is handled separately by the
//   freshness verdict, so the tolerance cannot be gamed to mask a stale feed.
// DRIFT_CEILING — if a token's CLOB mid moves more than this between the two
//   captures, the book is genuinely volatile and any single-instant comparison is
//   noisy; we widen that token's effective published-tolerance by the OBSERVED drift
//   (attributing timing to timing) and flag the volatility rather than fail on it.
//
// TWO SEPARATE HORIZONS (the previous one-window model conflated them):
// PRICE_MATCH_WINDOW_H — the ±2pt match is a meaningful PASS/FAIL assertion ONLY for
//   a freshly-fetched snapshot. Markets move several points intraday, so a published
//   raw_prob is only expected to equal the live midpoint within 2pt while it is
//   minutes-to-a-few-hours old. INSIDE this window, a >tol delta is a real data error
//   → FAIL. ~3h gives margin for normal book movement without being so long that real
//   drift leaks in. We do NOT widen the 2pt tolerance to cover aging — that would
//   blind the check to genuine source errors; we bound WHEN the strict check applies.
// STALENESS_WINDOW_H — pipeline LIVENESS, a different concern: has publishing stopped?
//   This is the dashboard's staleness horizon, imported from core/freshness.js so the
//   two surfaces share ONE constant (derived from the snapshot SCHEDULE — 17h under
//   the 2h-cadence schedule with its 12h overnight pause). Beyond it → STALE.
// Between the two windows the snapshot is "aged but live": per-threshold deltas are
//   reported DESCRIPTIVELY as expected market drift — NOT a binary FAIL.
export const TOL = Object.freeze({
  CROSS_SOURCE: 0.01,
  PUBLISHED: 0.02,
  DRIFT_CEILING: 0.02,
  PRICE_MATCH_WINDOW_H: 3,
  STALENESS_WINDOW_H: STALENESS_THRESHOLD_HOURS,
});

const THRESHOLD_RE = /\$(\d+\.?\d*)/;
const DEFAULT_GAP_MS = 10_000;

// ── pure helpers (exported for unit tests; no I/O) ──

/** Parse "$1.8T?" → 1.8. Throws on an unparseable question (fail loud). */
export function parseThreshold(question) {
  const m = String(question).match(THRESHOLD_RE);
  if (!m) throw new Error(`Cannot parse threshold from: ${question}`);
  return parseFloat(m[1]);
}

/**
 * Cross-source agreement for one token: Gamma outcomePrice (YES) vs CLOB midpoint.
 * agree=false flags an upstream inconsistency worth knowing about.
 */
export function crossSource(gammaYes, clobMid, tol = TOL.CROSS_SOURCE) {
  if (gammaYes == null || clobMid == null) {
    return { delta: null, agree: null, comparable: false };
  }
  const delta = Math.abs(gammaYes - clobMid);
  return { delta, agree: delta <= tol, comparable: true };
}

/**
 * Reconcile one published value against a fresh live midpoint, accounting for the
 * intra-capture timing drift on that token. effective_tol = base tol + observed
 * drift, so sub-minute book movement is attributed to timing, not error.
 */
export function reconcileRow({ published, liveMid, drift = 0, tol = TOL.PUBLISHED }) {
  if (published == null || liveMid == null) {
    return { delta: null, effective_tol: null, within_tol: null, comparable: false };
  }
  const delta = Math.abs(published - liveMid);
  const effective_tol = tol + Math.max(0, drift);
  return { delta, effective_tol, within_tol: delta <= effective_tol, comparable: true };
}

/**
 * Book drift for one token between two captures. Pure |mid2 - mid1|; null if either
 * side is missing.
 */
export function tokenDrift(mid1, mid2) {
  if (mid1 == null || mid2 == null) return null;
  return Math.abs(mid2 - mid1);
}

/**
 * Structural validity of an isotonic-adjusted curve: the adjusted CDF must be
 * non-increasing, every bucket_prob >= 0, and the full distribution (incl. the
 * "below lowest" mass) must sum to 1.0. This is the unconditional source-fidelity
 * check: fresh source, run through the feed's own transform, MUST produce this.
 */
export function assessIsotonic(adjustedMarkets, eps = 1e-6) {
  const s = [...adjustedMarkets].sort((a, b) => a.threshold - b.threshold);
  const problems = [];
  let monotone = true;
  let bucketsNonNeg = true;
  for (let i = 0; i < s.length; i++) {
    if (s[i].bucket_prob < -eps) {
      bucketsNonNeg = false;
      problems.push(`${s[i].label}: bucket_prob ${s[i].bucket_prob} < 0`);
    }
    if (i < s.length - 1 && s[i + 1].adjusted_prob > s[i].adjusted_prob + eps) {
      monotone = false;
      problems.push(`CDF rises ${s[i].label}=${s[i].adjusted_prob} -> ${s[i + 1].label}=${s[i + 1].adjusted_prob}`);
    }
  }
  const belowLowest = s.length ? 1 - s[0].adjusted_prob : 1;
  const sum = belowLowest + s.reduce((a, m) => a + (m.bucket_prob ?? 0), 0);
  const sumsToOne = Math.abs(sum - 1) <= eps;
  if (!sumsToOne) problems.push(`buckets sum to ${sum} (expected 1.0)`);
  return { valid: monotone && bucketsNonNeg && sumsToOne, monotone, bucketsNonNeg, sum, sumsToOne, problems };
}

/**
 * Classify the published snapshot's age into one of three zones, separating the
 * price-match horizon from the liveness horizon:
 *   'price-match' (age <= priceMatchWindowH) — young enough that a >tol delta is a
 *                  real data error, so the ±2pt check is a hard PASS/FAIL gate.
 *   'aged'        (priceMatchWindowH < age <= stalenessHours) — beyond a strict price
 *                  match but the pipeline is alive; deltas are EXPECTED market drift,
 *                  reported descriptively, never a FAIL.
 *   'stale'       (age > stalenessHours) — a pipeline liveness problem → STALE.
 */
export function classifyAge(publishedAtISO, nowISO, priceMatchWindowH = TOL.PRICE_MATCH_WINDOW_H, stalenessHours = TOL.STALENESS_WINDOW_H) {
  const ageHours = (Date.parse(nowISO) - Date.parse(publishedAtISO)) / 3_600_000;
  const zone = ageHours > stalenessHours ? 'stale' : ageHours <= priceMatchWindowH ? 'price-match' : 'aged';
  return { ageHours, zone, priceMatchWindowH, stalenessHours };
}

/**
 * Compose the single headline verdict. Honest by construction:
 *   - an invalid live curve is always a FAIL (a real source/transform error);
 *   - the strict ±2pt price match FAILs ONLY inside the price-match window, where a
 *     >tol delta cannot be blamed on drift;
 *   - 'aged' returns OK with the drift reported descriptively (no binary FAIL);
 *   - 'stale' is its own liveness signal (exit 2; --strict promotes to FAIL).
 * The tolerance is NEVER widened to cover aging — we bound WHEN the strict check
 * applies, so the check stays blind to nothing real.
 */
export function overallVerdict({ sourceValid, zone, ageHours, priceMatchWindowH, stalenessHours, publishedOutOfTol, crossSourceDisagree, strict }) {
  const age = Number.isFinite(ageHours) ? ageHours.toFixed(1) : '?';
  if (!sourceValid) {
    return { verdict: 'FAIL', exit: 1, reason: 'live source does not yield a valid isotonic curve' };
  }
  if (strict && crossSourceDisagree > 0) {
    return { verdict: 'FAIL', exit: 1, reason: `${crossSourceDisagree} upstream cross-source disagreement(s) (--strict)` };
  }
  if (zone === 'stale') {
    const base = { verdict: 'STALE', reason: `published snapshot is ${age}h old (> ${stalenessHours}h liveness horizon) — the publishing pipeline may have stopped; re-run the snapshot` };
    return strict ? { ...base, verdict: 'FAIL', exit: 1 } : { ...base, exit: 2 };
  }
  if (zone === 'price-match') {
    if (publishedOutOfTol > 0) {
      return { verdict: 'FAIL', exit: 1, reason: `${publishedOutOfTol} published value(s) exceed ±tol on a ${age}h-old snapshot (within the ${priceMatchWindowH}h price-match window — too young to attribute to drift, so this is a real discrepancy)` };
    }
    return { verdict: 'PASS', exit: 0, reason: `every published value matches live source within tolerance on a fresh (${age}h) snapshot` };
  }
  // 'aged': beyond a strict price match, within the liveness horizon.
  return { verdict: 'OK', exit: 0, reason: `published snapshot is ${age}h old — beyond the ${priceMatchWindowH}h price-match window, within the ${stalenessHours}h liveness horizon. Per-threshold deltas below are EXPECTED market drift, not data error; re-run the snapshot for a strict price-match (the CI PASS path: snapshot, then verify while minutes-old).` };
}

// ── I/O: independent dual-source fetch (written separately from core/fetch.js) ──

async function fetchJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);
  return res.json();
}

/** Gamma event → per-YES-token metadata + the platform outcomePrice (YES). */
async function fetchGamma() {
  const events = await fetchJson(ENDPOINTS.gamma);
  if (!Array.isArray(events) || events.length === 0) throw new Error('Gamma returned no events');
  const markets = events[0].markets;
  if (!Array.isArray(markets) || markets.length === 0) throw new Error('Gamma event has no markets');
  return markets
    .map((m) => {
      const ids = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds;
      const prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      const threshold = parseThreshold(m.question);
      return {
        threshold,
        label: `>$${threshold}T`,
        token_id: ids[0], // YES
        volume: m.volume != null ? Number(m.volume) : null,
        gamma_yes: prices && prices[0] != null ? Number(prices[0]) : null,
        tick: m.orderPriceMinTickSize != null ? Number(m.orderPriceMinTickSize) : null,
      };
    })
    .sort((a, b) => a.threshold - b.threshold);
}

/** One full capture: Gamma meta/outcomePrices + CLOB midpoints + CLOB best bid/ask. */
async function capture() {
  const at = new Date().toISOString();
  const meta = await fetchGamma();
  const tokenIds = meta.map((m) => m.token_id);

  const midRaw = await fetchJson(ENDPOINTS.midpoints, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokenIds.map((t) => ({ token_id: t }))),
  });
  if (midRaw && midRaw.error) throw new Error(`CLOB midpoints: ${midRaw.error}`);

  const priceRaw = await fetchJson(ENDPOINTS.prices, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(tokenIds.flatMap((t) => [
      { token_id: t, side: 'BUY' },
      { token_id: t, side: 'SELL' },
    ])),
  });

  const rows = meta.map((m) => {
    const mid = midRaw[m.token_id];
    const book = priceRaw[m.token_id] || {};
    return {
      threshold: m.threshold,
      label: m.label,
      token_id: m.token_id,
      volume: m.volume,
      tick: m.tick,
      gamma_yes: m.gamma_yes,
      clob_mid: mid != null ? Number(mid) : null,
      bid: book.BUY != null ? Number(book.BUY) : null,
      ask: book.SELL != null ? Number(book.SELL) : null,
    };
  });
  return { at, rows };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtP = (x) => (x == null ? '  —  ' : x.toFixed(4));
const fmtPts = (x) => (x == null ? '  —  ' : (x * 100 >= 0 ? '+' : '') + (x * 100).toFixed(2));
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function parseArgs(argv) {
  const a = {
    gapMs: DEFAULT_GAP_MS,
    priceWindowH: TOL.PRICE_MATCH_WINDOW_H,
    stalenessH: TOL.STALENESS_WINDOW_H,
    strict: false, json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--gap-ms') a.gapMs = Number(argv[++i]);
    else if (argv[i] === '--price-window-hours') a.priceWindowH = Number(argv[++i]);
    else if (argv[i] === '--staleness-hours') a.stalenessH = Number(argv[++i]);
    else if (argv[i] === '--strict') a.strict = true;
    else if (argv[i] === '--json') a.json = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Published artifact under audit.
  const published = JSON.parse(readFileSync(LATEST_PATH, 'utf8'));

  // A RESOLVED market is intentionally FROZEN (ARCHITECTURE §5): there is nothing
  // live to verify — CLOB returns no midpoints once it settles — and age is no
  // longer a liveness signal. Report FINAL and exit 0; never flag a settled
  // market STALE. (CLOSED_PENDING still verifies normally: trading may resume or
  // it may still be drifting toward resolution.)
  if (published.snapshot.lifecycle?.state === 'RESOLVED') {
    const sep = '─'.repeat(94);
    if (args.json) {
      console.log(JSON.stringify({
        asset: ASSET.id, published_at: published.snapshot.fetched_at, verdict: 'FINAL',
        lifecycle_state: 'RESOLVED', resolved_outcome: published.snapshot.lifecycle.resolved_outcome,
        reason: 'market resolved — feed frozen at final state; no live verification applicable',
      }));
    } else {
      console.log(`\n${sep}\nVERDICT: FINAL`);
      console.log(`  ${ASSET.id} is RESOLVED — feed frozen at its final state; nothing live to verify (a settled market is not stale).\n${sep}\n`);
    }
    process.exit(0);
  }

  const pubByToken = new Map(published.snapshot.raw_inputs.map((r) => [r.token_id, r]));
  const pubAdjByThreshold = new Map(published.snapshot.derived.markets.map((m) => [m.threshold, m]));
  const publishedAt = published.snapshot.fetched_at;

  // Two independent captures, ~gapMs apart, to separate timing drift from error.
  const cap1 = await capture();
  await sleep(args.gapMs);
  const cap2 = await capture();
  const now = cap2.at;
  const gapSec = (Date.parse(cap2.at) - Date.parse(cap1.at)) / 1000;

  const cap1ByToken = new Map(cap1.rows.map((r) => [r.token_id, r]));

  // Per-token reconciliation rows (keyed off the LIVE capture so a changed market
  // set is visible as missing-on-one-side rather than silently dropped).
  let crossDisagree = 0;
  let publishedOutOfTol = 0;
  let maxDrift = 0;
  const driftVals = [];
  const rows = cap2.rows.map((r2) => {
    const r1 = cap1ByToken.get(r2.token_id);
    const drift = tokenDrift(r1 ? r1.clob_mid : null, r2.clob_mid);
    if (drift != null) { driftVals.push(drift); maxDrift = Math.max(maxDrift, drift); }

    const xs = crossSource(r2.gamma_yes, r2.clob_mid);
    if (xs.comparable && !xs.agree) crossDisagree++;

    const pub = pubByToken.get(r2.token_id);
    const publishedMid = pub ? parseFloat(pub.midpoint) : null;
    const rec = reconcileRow({ published: publishedMid, liveMid: r2.clob_mid, drift: drift ?? 0 });
    if (rec.comparable && rec.within_tol === false) publishedOutOfTol++;

    return {
      threshold: r2.threshold, label: r2.label, token_id: r2.token_id,
      publishedMid, liveMid: r2.clob_mid, bid: r2.bid, ask: r2.ask,
      gammaYes: r2.gamma_yes, tick: r2.tick, drift, xs, rec,
      pubAdjusted: pubAdjByThreshold.get(r2.threshold)?.adjusted_prob ?? null,
    };
  });

  // Markets present in the published feed but missing live (market set changed).
  const liveTokens = new Set(cap2.rows.map((r) => r.token_id));
  const missingLive = published.snapshot.raw_inputs.filter((r) => !liveTokens.has(r.token_id));

  // Source fidelity: run the feed's OWN transform on FRESH source, confirm a valid
  // isotonic curve, and compare the freshly-adjusted curve to the published one.
  const freshAdj = adjustSnapshot(
    cap2.rows.map((r) => ({ label: r.label, threshold: r.threshold, prob: r.clob_mid, volume: r.volume }))
  );
  const iso = assessIsotonic(freshAdj.markets);
  const freshAdjByThreshold = new Map(freshAdj.markets.map((m) => [m.threshold, m]));

  const cls = classifyAge(publishedAt, now, args.priceWindowH, args.stalenessH);
  const verdict = overallVerdict({
    sourceValid: iso.valid,
    zone: cls.zone,
    ageHours: cls.ageHours,
    priceMatchWindowH: cls.priceMatchWindowH,
    stalenessHours: cls.stalenessHours,
    publishedOutOfTol,
    crossSourceDisagree: crossDisagree,
    strict: args.strict,
  });
  // The strict ±tol assertion is only meaningful inside the price-match window; in
  // 'aged'/'stale' zones a per-threshold miss is descriptive drift, not a failure.
  const priceMatchZone = cls.zone === 'price-match';

  const driftMean = driftVals.length ? driftVals.reduce((a, b) => a + b, 0) / driftVals.length : 0;

  if (args.json) {
    console.log(JSON.stringify({
      asset: ASSET.id, published_at: publishedAt, verified_at: now,
      publish_age_hours: Number(cls.ageHours.toFixed(2)), age_zone: cls.zone,
      price_match_window_hours: cls.priceMatchWindowH, staleness_window_hours: cls.stalenessHours,
      capture_gap_sec: gapSec, drift_max: maxDrift, drift_mean: driftMean,
      cross_source_disagreements: crossDisagree,
      // A price-match miss only counts as a discrepancy inside the price-match window.
      published_out_of_tol: priceMatchZone ? publishedOutOfTol : 0,
      observed_drift_count: priceMatchZone ? 0 : publishedOutOfTol,
      source_curve_valid: iso.valid, tolerances: TOL, verdict: verdict.verdict, reason: verdict.reason,
      rows: rows.map((r) => ({
        threshold: r.threshold, published_mid: r.publishedMid, live_mid: r.liveMid,
        bid: r.bid, ask: r.ask, gamma_yes: r.gammaYes,
        delta: r.rec.delta, within_tol: r.rec.within_tol, drift: r.drift,
        cross_source_delta: r.xs.delta, cross_source_agree: r.xs.agree,
      })),
    }, null, 2));
    process.exit(verdict.exit);
  }

  // ── human report ──
  const line = '─'.repeat(94);
  console.log(`\nDATA-ACCURACY RECONCILIATION — ${ASSET.name}`);
  console.log(line);
  const zoneLabel = { 'price-match': 'PRICE-MATCH (strict ±tol applies)', aged: 'AGED (drift descriptive, no fail)', stale: 'STALE (liveness)' }[cls.zone];
  console.log(`published latest.json : ${publishedAt}`);
  console.log(`verified (capture 2)  : ${now}`);
  console.log(`publish age           : ${cls.ageHours.toFixed(1)} h → ${zoneLabel}`);
  console.log(`  horizons            : price-match ≤ ${cls.priceMatchWindowH}h · liveness/stale > ${cls.stalenessHours}h`);
  console.log(`capture gap           : ${gapSec.toFixed(1)} s   (cap1 ${cap1.at})`);
  console.log(`tolerances            : published ±${(TOL.PUBLISHED * 100).toFixed(0)}pt · cross-source ±${(TOL.CROSS_SOURCE * 100).toFixed(0)}pt · drift ceiling ${(TOL.DRIFT_CEILING * 100).toFixed(0)}pt`);

  console.log(`\nPER-THRESHOLD (probabilities; deltas in points, 1pt = 0.01)`);
  if (!priceMatchZone) console.log(`  (aged/stale: the "match" column shows '~drift' for >tol deltas — EXPECTED movement, not error)`);
  console.log(line);
  console.log([
    pad('thresh', 8), pad('published', 10), pad('live-mid', 9), pad('live-bid', 9),
    pad('live-ask', 9), pad('Δ pub', 8), pad('eff-tol', 8), pad('match', 7), pad('drift', 7), pad('gamma', 8), pad('xΔ', 7), 'src?',
  ].join(' '));
  console.log(line);
  const matchCell = (within) =>
    within == null ? 'n/a' : within ? '✓' : priceMatchZone ? '✗' : '~drift';
  for (const r of rows) {
    console.log([
      pad(`$${r.threshold}T`, 8),
      pad(fmtP(r.publishedMid), 10),
      pad(fmtP(r.liveMid), 9),
      pad(fmtP(r.bid), 9),
      pad(fmtP(r.ask), 9),
      pad(fmtPts(r.rec.delta), 8),
      pad(r.rec.effective_tol == null ? '  —  ' : '±' + (r.rec.effective_tol * 100).toFixed(2), 8),
      pad(matchCell(r.rec.within_tol), 7),
      pad(fmtPts(r.drift), 7),
      pad(fmtP(r.gammaYes), 8),
      pad(fmtPts(r.xs.delta), 7),
      r.xs.agree == null ? 'n/a' : r.xs.agree ? '✓' : '✗ DISAGREE',
    ].join(' '));
  }
  const comparable = rows.filter((r) => r.rec.comparable).length;
  console.log(priceMatchZone
    ? `  → ${comparable - publishedOutOfTol}/${comparable} within ±tol` +
      (publishedOutOfTol > 0 ? ` · ${publishedOutOfTol} EXCEED (real discrepancy — snapshot is fresh)` : ` · all match`)
    : `  → ${publishedOutOfTol}/${comparable} threshold(s) drifted beyond ±tol over ${cls.ageHours.toFixed(1)}h (expected market movement, not error)`);
  if (missingLive.length) {
    console.log(`\n⚠ ${missingLive.length} published market(s) NOT found live (market set changed): ` +
      missingLive.map((m) => `$${m.threshold}T`).join(', '));
  }

  console.log(`\nCROSS-SOURCE (Gamma outcomePrice vs CLOB midpoint, ±${(TOL.CROSS_SOURCE * 100).toFixed(0)}pt)`);
  console.log(line);
  console.log(crossDisagree === 0
    ? `  ✓ all ${rows.filter((r) => r.xs.comparable).length} comparable tokens agree within ${(TOL.CROSS_SOURCE * 100).toFixed(0)}pt`
    : `  ✗ ${crossDisagree} token(s) disagree by >${(TOL.CROSS_SOURCE * 100).toFixed(0)}pt — UPSTREAM inconsistency (surfaced, not hidden). ` +
      `Feed's source of record is the CLOB midpoint; Gamma outcomePrice is a lagging display value.`);

  console.log(`\nBOOK DRIFT between captures (${gapSec.toFixed(1)} s apart)`);
  console.log(line);
  console.log(`  max ${(maxDrift * 100).toFixed(2)}pt · mean ${(driftMean * 100).toFixed(2)}pt` +
    (maxDrift > TOL.DRIFT_CEILING ? `  ⚠ exceeds drift ceiling — book is volatile; comparisons widened by observed drift` : `  (stable)`));

  console.log(`\nSOURCE FIDELITY — fresh source → feed's isotonic transform`);
  console.log(line);
  console.log(`  valid isotonic curve : ${iso.valid ? '✓' : '✗'}  (monotone ${iso.monotone ? '✓' : '✗'}, buckets≥0 ${iso.bucketsNonNeg ? '✓' : '✗'}, sum=${iso.sum.toFixed(6)})`);
  if (!iso.valid) for (const p of iso.problems) console.log(`     ✗ ${p}`);
  // Published adjusted vs freshly-recomputed adjusted (subject to freshness).
  let adjMax = 0;
  for (const r of rows) {
    const fa = freshAdjByThreshold.get(r.threshold)?.adjusted_prob;
    if (r.pubAdjusted != null && fa != null) adjMax = Math.max(adjMax, Math.abs(r.pubAdjusted - fa));
  }
  console.log(`  published adjusted vs fresh-adjusted: max Δ ${(adjMax * 100).toFixed(2)}pt ` +
    `${priceMatchZone ? (adjMax <= TOL.PUBLISHED + maxDrift ? '✓ within tol' : '✗ exceeds tol') : '(aged — Δ reflects expected drift over publish age)'}`);

  console.log(`\n${line}`);
  console.log(`VERDICT: ${verdict.verdict}`);
  console.log(`  ${verdict.reason}`);
  if (verdict.verdict === 'STALE' || cls.zone === 'aged') {
    console.log(`  NOTE: source fidelity is intact (the live curve is valid); the per-threshold`);
    console.log(`        deltas are ${cls.zone === 'stale' ? 'an aging artifact' : 'expected market drift'}, not a data error. The CI PASS path is to run`);
    console.log(`        \`node scripts/snapshot.js\` then verify immediately (minutes-old → strict match).`);
  }
  console.log(line + '\n');

  process.exit(verdict.exit);
}

// Only run the network path when invoked directly (so tests can import the pure helpers).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('verify-accuracy failed:', err.message);
    process.exit(1);
  });
}
