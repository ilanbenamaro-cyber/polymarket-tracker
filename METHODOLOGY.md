# Methodology

**Version 1.0.0** · asset `spacex-ipo-market-cap` · source: Polymarket (public market data only)

This is the human-readable companion to [`core/methodology.json`](core/methodology.json)
(served at [`/api/v1/methodology.json`](docs/api/v1/methodology.json)). Every published
snapshot embeds the `methodology_version` it was computed under. **A formula change is a
breaking change**: bump the version and add a changelog entry.

All metrics are derived from the implied **survival function** `P(cap > X)` — the
Polymarket YES midpoint price of each "closing market cap above $X?" market.

## Metrics

### Implied median — *robust*
The valuation where `P(cap > X)` crosses **0.50**, by linear interpolation between the two
bracketing thresholds. Depends only on the two thresholds straddling 50%, not on tail shape.

### Implied mean (approx) — *assumption-sensitive*
Bucket-weighted expected value: `Σ (bucket probability × bucket midpoint)`. Tail assumptions:
- below-lowest bucket midpoint = `lowest_threshold − $0.15T`
- above-highest bucket midpoint = `highest_threshold + $0.40T`

The two tail offsets materially affect the result when tail probabilities are non-trivial.
**Treat as approximate**; the median is the more reliable central estimate.

### 50% confidence band (IQR) — *robust*
The `p25`/`p75` valuations = thresholds where `P(cap > X)` crosses **0.75** and **0.25**.
Either bound is `null` when it would fall outside the quoted threshold range.

### Bucket probability
`P(> this threshold) − P(> next threshold)`; the top bucket = `P(> top)`. A `< lowest`
bucket (`1 − P(> lowest)`) completes the distribution. **All buckets sum to 1.0**, asserted
at build time by `core/validate.js` — a snapshot that violates this is never published.

### Confidence — `{ tier, score, reasons[] }`
The **worst** of three signals (a single bad signal caps trust):

| Signal | high | medium | low |
|---|---|---|---|
| Active thresholds | ≥ 12 | 8–11 | < 8 |
| Monotonicity violations (`P(>X)` rising as X rises) | 0 | ≤ 2 | > 2 |
| Mean bid−ask spread | < 0.04 | 0.04–0.08 | > 0.08 |

Backfilled history has **no order book**, so spread is unknown: those days are flagged
`price-only (no spread data)` and **capped at medium**. `score` is a smooth 0–1 blend of the
three signals for sorting/at-a-glance use.

## Provenance — `raw_sha256`
Each snapshot stores `raw_inputs` (one row per threshold: `token_id`, `threshold`, and the
API's **literal string** `midpoint`/`best_bid`/`best_ask`, plus `volume`). `raw_sha256` is the
SHA-256 of the canonical JSON of `raw_inputs` (fixed key order, ascending by threshold). Any
consumer — including the dashboard's **verify hash** button — re-serializes the stored
`raw_inputs` and reproduces the hash, proving the derived numbers came from those exact,
unaltered inputs.

## Scope
**v1 covers public Polymarket data only.** No grey-market / secondary-market (Forge, Caplight,
EquityZen) data — that is out of scope for v1.

## Changelog
- **1.0.0** (2026-06-05) — Initial published methodology: median, mean (with tail
  assumptions), IQR band, bucket probabilities, three-signal confidence, raw_sha256 provenance.
