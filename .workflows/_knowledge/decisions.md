# Architectural decisions — the "why"

Durable record of decisions and what each one constrains. One entry per decision.
Newest at top. If you're about to change one of these, read the entry first.

---

## The Tier-1 / Tier-2 firewall (most important constraint)
**Decided:** Market-derived outputs (Tier 1) and assumption-based outputs (Tier 2) are
**structurally** separated, not just visually labeled. Tier 1 = pure transforms of observed
Polymarket prices, under `derived` + `derived.market.analytics`. Tier 2 = anything needing an
input the market didn't provide (shares outstanding, a prior valuation), quarantined under
`derived.scenarios`.
**Why:** A quant trusts Tier 1 *because* the assumptions are quarantined. One assumption leaking
into a market metric, or one unsourced scenario number, discredits the whole feed.
**Constrains:** `validate.js` **fails the build** if (a) any `derived.scenarios` number lacks a
non-empty `assumptions[]` with a `source` + `as_of` + `value`, or (b) an `assumptions` key appears
anywhere under `derived` outside `derived.scenarios`. Renderers must style Tier 2 distinctly
("ASSUMPTION-BASED" banner). Never relax these checks.

## No grey-market / secondary-market data in v1
**Decided:** v1 uses **public Polymarket data only**. No Forge / Caplight / EquityZen scraping or
secondary-market trade data.
**Why:** Scope discipline + legal exposure — secondary-market data carries licensing/redistribution
risk and is a different product (v2). Keeping v1 to a public, free, auth-less source keeps it clean
to ship and defend.
**Constrains:** Any feature needing a secondary-market price is out of scope. (Note: the SpaceX
shares estimate is sourced from mainstream *press* reporting of a company tender — press, not a
secondary-trading-platform feed — and is flagged low-confidence; see the assumptions entry below.)

## Never fake calibration
**Decided:** Calibration is a **scaffold only**: `status:"pending_resolution"`, `resolves:"2027-12-31"`,
plus the standing forecast recorded for later scoring. No Brier score, no accuracy number.
**Why:** The market resolves exactly once (at IPO close). A calibration/Brier score before
resolution would be fabricated precision — the exact thing this product refuses to do.
**Constrains:** Do not compute a score until the outcome is known. `core/analytics.js`
`computeCalibration()` must never emit `brier`/`score`. A test asserts their absence.

## Assumptions-as-inputs (Tier 2 sourcing)
**Decided:** Every Tier-2 external input is a registry entry in `core/assumptions.json` with
`{ value, unit, source, source_url, as_of, confidence, range:[low,high], adjustable, note }` — never
a silent constant. With no usable input, the scenario renders `status:"input_required"`, never a guess.
SpaceX `shares_outstanding` ≈ **1.9B** is a *press-derived estimate* (Reuters, Dec 13 2025: ~$800B
tender at $421/share → 800e9/421), `confidence:"low"`, `range:[1.7B, 2.1B]`. `last_round_valuation`
≈ $0.80T from the same report.
**Why:** SpaceX is private and discloses none of this. The honest move is to expose the input, its
source, its date, and its uncertainty band — and let a user adjust it — rather than bake in a number
that looks authoritative.
**Constrains:** Changing a value bumps `assumptions.json` `version`. The dashboard's user edits
recompute client-side and **must not mutate the published feed**. Bump confidence/range honestly.

## Independent semantic versioning (methodology / schema / assumptions)
**Decided:** Three independent semvers — `methodology_version`, `schema_version`,
`assumptions_version` — and **every snapshot embeds all three**.
**Why:** They change for different reasons. A formula change (breaking) is methodology; a field
addition is schema (additive); an input change is assumptions. Consumers need to know which moved.
**Constrains:** A formula change bumps methodology + adds a changelog entry. Schema changes must stay
**additive** within `/api/v1/` (breaking → `/api/v2/`). `methodology.json` and `METHODOLOGY.md` must
stay consistent.

## raw_inputs + hash recipe are FROZEN
**Decided:** `snapshot.source.raw_sha256` = sha256 over the canonical JSON of `raw_inputs`
(keys ordered `token_id, threshold, midpoint, best_bid, best_ask, volume`; ascending by threshold;
literal API string values). This recipe and the `raw_inputs` shape **do not change**.
**Why:** Every archived `snapshots/YYYY-MM-DD.json` is independently verifiable against this exact
recipe. Changing it silently breaks the verifiability of all historical archives — the core trust claim.
**Constrains:** Status flags (closed/active) and any new metadata go in side channels / `derived`,
**never** into the hashed `raw_inputs`. The browser verifier in `index.html` and `core/fetch.js`
`canonicalizeRawInputs` must stay byte-identical.

## One source of truth — core/ owns every formula
**Decided:** Every metric is computed exactly once in `core/` (metrics, stats, analytics, scenarios,
confidence, narrative). Renderers and scripts import and display; they never recompute.
**Why:** Duplicate formulas drift (that was defect D1: a delta rounded two ways read $0.19T vs $0.20T).
Single source = surfaces can't disagree.
**Constrains:** Deltas/derived numbers are computed in core and **stored**; renderers read stored
values through one formatter (`core/format.js`). A `grep` for any formula must find one definition.
The red-team has twice caught renderer re-derivation (density bars, then guarded) — keep checking.
