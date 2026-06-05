# Methodology

**Version 1.1.0** · asset `spacex-ipo-market-cap` · source: Polymarket (public market data only)

Human-readable companion to [`core/methodology.json`](core/methodology.json) (served at
[`/api/v1/methodology.json`](docs/api/v1/methodology.json)). Every snapshot embeds the
`methodology_version` it was computed under. **A formula change is a breaking change**: bump the
version and add a changelog entry.

Each "closing market cap above $X?" market is a **separate order book**, so raw YES midpoints are
*not* jointly arbitrage-constrained — `P(>1.2T)` can exceed `P(>1.4T)`, which would put **negative
mass** in a bucket. Every metric is therefore computed from an **arbitrage-adjusted** curve; raw is
preserved alongside.

## Arbitrage adjustment (isotonic regression) — *robust*
Volume-weighted **Pool Adjacent Violators (PAVA)** projects the raw midpoints onto a non-increasing
CDF. On a violation, adjacent markets pool to their **volume-weighted mean**, pulling the estimate
toward the more liquid (more trustworthy) quote. Each market stores `raw_prob` and `adjusted_prob`;
all metrics use `adjusted_prob`. Per snapshot we publish `adjustment.monotonicity_violations` and
`adjustment.max_adjustment`. Weight = volume (fallback 1 when volume is unknown, e.g. price-only
history). Guarantees: every `bucket_prob ≥ 0` and the full distribution sums to 1.0 (asserted at build).

## Implied median — *robust* (+ uncertainty band, live only)
Valuation where the adjusted CDF crosses **0.50** (interpolation). The **band** `{low, high}` is
spread-implied: the `best_bid` and `best_ask` curves are each isotonic-adjusted, each one's 0.50
crossing is taken, and the median is bounded by them. `null` when there is no two-sided book
(price-only history). Missing quotes are excluded, **never synthesized**.

## Implied mean (approx) — *assumption-sensitive* (+ sensitivity range)
Bucket-weighted EV over the adjusted distribution; tails use midpoint offsets (base case
`lowest − $0.15T`, `highest + $0.40T`). The **range** `{low, high}` spans a 3×3 grid
(below ∈ {0.10, 0.15, 0.20}, above ∈ {0.30, 0.40, 0.60}). A tight range proves robustness; a wide
range discloses fragility. The median is the more reliable central estimate.

## 50% confidence band (IQR) — *robust*
`p25`/`p75` valuations = adjusted CDF crossings at **0.75** and **0.25**.

## Bucket probability
`adjusted P(> this) − adjusted P(> next)`; top = `adjusted P(> top)`; a `< lowest` bucket
(`1 − adjusted P(> lowest)`) completes the distribution. All ≥ 0, sum to 1.0.

## Confidence — `{ tier, score, reasons[] }`
The **worst** of several signals (a single bad signal caps trust), each surfaced as a reason:

| Signal | high | medium | low |
|---|---|---|---|
| Active thresholds | ≥ 12 | 8–11 | < 8 |
| Monotonicity adjustments | 0 | ≤ 2 | > 2 |
| Mean bid−ask spread | < 0.04 | 0.04–0.08 | > 0.08 |
| Thin-liquidity breadth (share of books < $50K) | < 20% | 20–50% | > 50% |
| Anomalies | none | stale / 1–2 closed / volume drop | > 2 closed |

**Anomalies**: `stale` (raw inputs identical to the prior snapshot), `closed` (markets closed / not
accepting orders), `liquidity_drop` (total volume > 40% below the trailing-7-day median). Liquidity
breadth is **not** assessed when volume is unknown (price-only history); those days are capped at
medium with reason `price-only history (no bid/ask spread)`.

## Narrative
A deterministic, template-based reading composed **only** from stored fields (median vs 7d/30d-ago,
divergence, dominant bucket, confidence caveat). **No language model in the data path** — reproducible
from `narrative_components`; it never asserts anything not in those fields.

## Provenance — `raw_sha256`
Unchanged from 1.0.0 (so archived snapshots stay verifiable): SHA-256 over the canonical JSON of
`raw_inputs` (fixed key order, ascending by threshold, literal API strings). The dashboard's
**verify hash** button reproduces it in-browser. Market status flags (closed/active) are deliberately
**excluded** from the hashed inputs.

## Contract & scope
The canonical record conforms to [`/api/v1/schema.json`](docs/api/v1/schema.json) (JSON Schema
2020-12), validated at build. **v1 covers public Polymarket data only** — no grey-market /
secondary-market (Forge, Caplight, EquityZen) data.

## Changelog
- **1.1.0** (2026-06-05) — Volume-weighted isotonic adjustment (removes negative-probability
  artifacts; raw preserved); spread-implied median band; mean tail-sensitivity range;
  anomaly/staleness/liquidity confidence signals; deterministic narrative; published JSON Schema.
- **1.0.0** (2026-06-05) — Initial: median, mean (tail assumptions), IQR band, bucket probabilities,
  three-signal confidence, raw_sha256 provenance.
