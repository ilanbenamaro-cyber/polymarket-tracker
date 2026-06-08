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
// FRESHNESS_WINDOW_H — how old the published snapshot may be before its raw_prob is
//   no longer expected to match live within TOL_PUBLISHED. The cron runs ~daily on
//   weekdays, so ~26h covers a normal gap; beyond it, deltas are market drift, not
//   error, and the verdict is STALE (re-run the snapshot), not FAIL.
export const TOL = Object.freeze({
  CROSS_SOURCE: 0.01,
  PUBLISHED: 0.02,
  DRIFT_CEILING: 0.02,
  FRESHNESS_WINDOW_H: 26,
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

/** Freshness of the published snapshot relative to now. */
export function freshness(publishedAtISO, nowISO, windowH = TOL.FRESHNESS_WINDOW_H) {
  const ageHours = (Date.parse(nowISO) - Date.parse(publishedAtISO)) / 3_600_000;
  return { ageHours, fresh: ageHours <= windowH, windowH };
}

/**
 * Compose the single headline verdict from the component results. Honest by
 * construction: a fresh feed that reconciles within tolerance PASSES; a stale feed
 * whose method still reconciles is STALE (not FAIL); only a real discrepancy or an
 * invalid live curve is a FAIL. --strict promotes STALE and upstream disagreement.
 */
export function overallVerdict({ sourceValid, fresh, publishedOutOfTol, crossSourceDisagree, strict }) {
  if (!sourceValid) {
    return { verdict: 'FAIL', exit: 1, reason: 'live source does not yield a valid isotonic curve' };
  }
  if (fresh && publishedOutOfTol > 0) {
    return { verdict: 'FAIL', exit: 1, reason: `${publishedOutOfTol} published value(s) exceed tolerance on a FRESH snapshot` };
  }
  if (strict && crossSourceDisagree > 0) {
    return { verdict: 'FAIL', exit: 1, reason: `${crossSourceDisagree} upstream cross-source disagreement(s) (--strict)` };
  }
  if (!fresh) {
    const base = { verdict: 'STALE', reason: 'published snapshot is older than the freshness window; deltas reflect market drift, not error — re-run the snapshot' };
    return strict ? { ...base, verdict: 'FAIL', exit: 1 } : { ...base, exit: 2 };
  }
  return { verdict: 'PASS', exit: 0, reason: 'every published value reconciles to live source within tolerance once timing drift is accounted for' };
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
  const a = { gapMs: DEFAULT_GAP_MS, maxAgeH: TOL.FRESHNESS_WINDOW_H, strict: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--gap-ms') a.gapMs = Number(argv[++i]);
    else if (argv[i] === '--max-age-hours') a.maxAgeH = Number(argv[++i]);
    else if (argv[i] === '--strict') a.strict = true;
    else if (argv[i] === '--json') a.json = true;
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Published artifact under audit.
  const published = JSON.parse(readFileSync(LATEST_PATH, 'utf8'));
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

  const fresh = freshness(publishedAt, now, args.maxAgeH);
  const verdict = overallVerdict({
    sourceValid: iso.valid,
    fresh: fresh.fresh,
    publishedOutOfTol,
    crossSourceDisagree: crossDisagree,
    strict: args.strict,
  });

  const driftMean = driftVals.length ? driftVals.reduce((a, b) => a + b, 0) / driftVals.length : 0;

  if (args.json) {
    console.log(JSON.stringify({
      asset: ASSET.id, published_at: publishedAt, verified_at: now,
      publish_age_hours: Number(fresh.ageHours.toFixed(2)), fresh: fresh.fresh,
      capture_gap_sec: gapSec, drift_max: maxDrift, drift_mean: driftMean,
      cross_source_disagreements: crossDisagree, published_out_of_tol: publishedOutOfTol,
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
  console.log(`published latest.json : ${publishedAt}`);
  console.log(`verified (capture 2)  : ${now}`);
  console.log(`publish age           : ${fresh.ageHours.toFixed(1)} h  (freshness window ${fresh.windowH} h → ${fresh.fresh ? 'FRESH' : 'STALE'})`);
  console.log(`capture gap           : ${gapSec.toFixed(1)} s   (cap1 ${cap1.at})`);
  console.log(`tolerances            : published ±${(TOL.PUBLISHED * 100).toFixed(0)}pt · cross-source ±${(TOL.CROSS_SOURCE * 100).toFixed(0)}pt · drift ceiling ${(TOL.DRIFT_CEILING * 100).toFixed(0)}pt`);

  console.log(`\nPER-THRESHOLD (probabilities; deltas in points, 1pt = 0.01)`);
  console.log(line);
  console.log([
    pad('thresh', 8), pad('published', 10), pad('live-mid', 9), pad('live-bid', 9),
    pad('live-ask', 9), pad('Δ pub', 8), pad('eff-tol', 8), pad('ok?', 4), pad('drift', 7), pad('gamma', 8), pad('xΔ', 7), 'src?',
  ].join(' '));
  console.log(line);
  for (const r of rows) {
    console.log([
      pad(`$${r.threshold}T`, 8),
      pad(fmtP(r.publishedMid), 10),
      pad(fmtP(r.liveMid), 9),
      pad(fmtP(r.bid), 9),
      pad(fmtP(r.ask), 9),
      pad(fmtPts(r.rec.delta), 8),
      pad(r.rec.effective_tol == null ? '  —  ' : '±' + (r.rec.effective_tol * 100).toFixed(2), 8),
      pad(r.rec.within_tol == null ? ' n/a' : r.rec.within_tol ? ' ✓' : ' ✗', 4),
      pad(fmtPts(r.drift), 7),
      pad(fmtP(r.gammaYes), 8),
      pad(fmtPts(r.xs.delta), 7),
      r.xs.agree == null ? 'n/a' : r.xs.agree ? '✓' : '✗ DISAGREE',
    ].join(' '));
  }
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
    `${fresh.fresh ? (adjMax <= TOL.PUBLISHED + maxDrift ? '✓ within tol' : '✗ exceeds tol') : '(stale — Δ reflects drift over publish age)'}`);

  console.log(`\n${line}`);
  console.log(`VERDICT: ${verdict.verdict}`);
  console.log(`  ${verdict.reason}`);
  if (verdict.verdict === 'STALE') {
    console.log(`  NOTE: source fidelity is intact (the methodology reconciles to live source);`);
    console.log(`        only the published artifact is old. Run \`node scripts/snapshot.js\` to refresh.`);
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
