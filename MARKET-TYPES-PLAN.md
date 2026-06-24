# Market-type redesign — working plan (P0 cluster: Bugs 1/2/4)

> Working plan for `feature/p0-parser-units-mean`. The "why" lands in
> `.workflows/_knowledge/decisions.md` once each increment merges. Delete this file
> when the epic is merged to main.

## Problem (evidence from live gamma, 2026-06-24)

`kindFromMarkets` (`core/fetch.js:263`) labels anything multi-leg with a `$` in
`markets[0].question` a `'ladder'`, and `core/metrics.js` then assumes every leg is
`P(value > threshold)` (monotone survival). That is true for SpaceX and FALSE for
three other real structures, all currently mislabeled `'ladder'`:

| Type | Real example | Leg shape | Symptom under survival model |
|---|---|---|---|
| `survival_ladder` | SpaceX "cap **above** $1.4T?" | `P(>X)`, nested/monotone | correct (baseline) |
| `bucket_pmf` | Bitcoin "**between** $62,000 and $64,000", "**less than** $56,000"; Anthropic IPO "**between** $1.5T and $1.75T" + "**not IPO**" leg | disjoint interval PMF (sums to 1), sometimes + 1 categorical leg | parser takes 1st number → comma/bracket collisions (Bug 4); prob is `P(in bucket)` not `P(>X)` → median/mean wrong (Bug 2); units dropped (Bug 1); Anthropic "not IPO" leg has no `$` → `fetchMarketMeta` throws |
| `directional_touch` | WTI "(LOW) $90" + "(HIGH) $90"; Silver | `P(touch ≤X)` (LOW) / `P(touch ≥X)` (HIGH); tent-shaped, non-monotone | `(LOW)$90` & `(HIGH)$90` both → 90 (Bug 4); touch-prob fed into a CDF is not a distribution |
| `categorical` | Fed decision, "next Chancellor" | non-numeric | already gated (422) |

## Target architecture (follows the binary-type precedent exactly)

Top-level routing stays in `computeMarketRecord` (`lib/compute.mjs:67`). Detection is
gamma-meta only, BEFORE any CLOB/threshold parse. New `kind` values flow to the cache
(`markets.kind`) and the UI render branch, mirroring `kind:'binary'`.

1. **Classifier** — `ladderShapeFromMarkets(markets)` → `survival | bucket_pmf | directional_touch | categorical`, called for multi-leg `$`-events. Pure, offline-testable, locked against the real question fixtures.
2. **Money parser** — `parseMoney(str)` → absolute-dollar value, handling thousands commas (`$56,000`→56000) and unit suffixes (`$1.5T`→1.5e12, `$100B`→1e11, `$90`→90). Returns `{ value, unit }`. **Never used on SpaceX** (pinned config keeps its mantissa-only `parse_pattern` → byte-identical hash).
3. **`deriveUnit(values)`** — pick display scale (T≥1e12, B≥1e9, M≥1e6, K≥1e3, else $) from the ladder magnitude; the one formatter the detail + rail + narrative + axes all read. Replaces `unitFromLadder`'s `/[TBM]/`-only fallback-to-T (Bug 1 root).
4. **`bucket_pmf` pipeline** — `fetchBucketPmfSnapshot` parses each leg as `[lo,hi]` interval + YES prob (the PMF), excludes/discloses any non-`$` categorical leg ("not IPO"), derives the survival curve `P(>boundary)` from the PMF → reuses `computeImpliedMedian/Iqr/Density`. Mean computed directly from the PMF (`Σ midpoint·prob` + tail offsets) → no outlier blowup. Correct median/mean/units/density; no collisions. Renders via the EXISTING ladder detail view.
5. **`directional_touch` pipeline** — `fetchTouchSnapshot` parses HIGH legs (`P(touch ≥X)`) and LOW legs (`P(touch ≤X)`) as SEPARATE series (synthetic signed thresholds keep `canonicalizeRawInputs` unchanged + deterministic: HIGH=+X, LOW=−X). Derives the **implied range** from the 50% crossovers (HIGH<50% = won't reach that high; LOW<50% = won't fall that low). `buildTouchRecord` → `derived.kind='directional_touch'` with `{ implied_range:{low,high,confidence:0.5}, high_series[], low_series[], confidence, narrative, freshness }`. Confidence from spread+volume (peer to `scoreBinaryConfidence`). NEW `TouchDetailView`: touch-probability TABLE + horizontal RANGE chart (no CDF), "TOUCH MARKET" label. Full hash-verify/trust/freshness.

## Frozen-hash safety (constraint #1)

SpaceX is the only frozen record. It stays a pinned `survival_ladder` with its existing
`parse_pattern` (`spacex.json:9`, mantissa-only, single unit T, no commas) → recompute
byte-identical → `phase1-spacex-parity.test.js` green. All new parsing/types are on the
NON-pinned path. `canonicalizeRawInputs` is NOT modified (touch uses signed synthetic
thresholds for uniqueness, same trick as binary's 1=YES/0=NO).

## Sequencing (each increment: TDD → `node --test` green → parity gate → commit)

- **I1** classifier + `parseMoney` + `deriveUnit` (pure layer, this branch). ← in progress
- **I2** `bucket_pmf` end-to-end (Bitcoin + Anthropic): fetch → build → schema branch → route → ladder-view reuse → live verify. Fixes Bugs 1/2/4 for PMF markets.
- **I3** `directional_touch` end-to-end (WTI + Silver): fetch → build → schema branch → route → `TouchDetailView` → live verify.
- **I4** unit-formatter propagation (Bug 1 across rail/narrative/axes/band/velocity).
- **I5+** remaining bugs (3 confidence, 5 n/a median, 6 near-settlement view, 7 titles, 8 analytics) + enhancements 1–8, per the original spec order.

## Verification

Offline (no env): `node --test` (137 baseline → grows), `phase1-spacex-parity` gate.
Live (needs the 4 dev Supabase vars in MY shell + dev server): real WTI/Silver range
view, Bitcoin/Anthropic correct medians, Playwright before/after screenshots, 0 console
errors. Flagged not-done until run.
