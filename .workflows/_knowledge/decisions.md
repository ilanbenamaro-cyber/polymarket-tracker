# Architectural decisions — the "why"

Durable record of decisions and what each one constrains. One entry per decision.
Newest at top. If you're about to change one of these, read the entry first.

---

## Concurrency-safe CI commit/push (the snapshot bot races itself + humans)
**Decided:** `update.yml`'s "Commit API + baked dashboard" step is robust to a remote that advances
mid-run: a **`concurrency: { group: snapshot-commit, cancel-in-progress: false }`** serializes runs
(queued, never cancelled — no snapshot dropped); the push then does **fetch → `git rebase -X theirs
FETCH_HEAD` → push, retrying up to 5×**; `actions/checkout`/`setup-node` are **@v5** with
**`fetch-depth: 0`** so the rebase always has its merge base.
**Why:** A naive `git push` is rejected ("fetch first") whenever the bot or a human pushed after the
runner checked out `main` — this is exactly what failed run 27096553941. Rebasing our one generated-file
commit onto the latest tip integrates the advance instead of failing. `-X theirs` keeps the **freshly
built** artifacts on a generated-file conflict (during rebase "theirs" = the commit being replayed, i.e.
this snapshot — they are the authoritative current state). The concurrency group means two *snapshot*
runs can't overlap, so the retry mainly absorbs non-snapshot pushes. Proven green: run 27154304762,
commit `01d505b` landed via this path.
**Constrains:** Keep this YAML-only — never let push robustness changes touch `core/` formulas, the
schema, or `scripts/snapshot.js` (the pipeline itself was correct). When editing the workflow, trigger a
**fresh** dispatch, not "Re-run jobs" (see [[gotchas]]). The bot's `-X theirs` could in principle clobber
a *newer* concurrent snapshot — the concurrency group is what prevents that, so don't remove it.

## Canonical source of record — the CLOB midpoint
**Decided:** Two public Polymarket surfaces expose a YES price and they are **different statistics**:
the **CLOB `/midpoints`** value `(best_bid + best_ask)/2` and **Gamma**'s `outcomePrices`. The feed's
`raw_inputs.midpoint` (hence every `raw_prob` and all derived metrics) is the **CLOB midpoint** — that
is the input of truth. Gamma is used **only** for metadata (token ids, volume, threshold parsing); its
`outcomePrices` is a **lagging cross-check, never an input**.
**Why:** The CLOB midpoint is the live two-sided book (the price you could transact near), computed
from `best_bid`/`best_ask` we already publish — self-consistent. Gamma `outcomePrices` is a
platform-surfaced display value that can reflect last-trade or a cached number and **lags the book**
(observed this session: a stale published 0.9845 vs Gamma 0.993, while *live* Gamma and CLOB agreed).
Picking one source of truth and documenting it is what lets a quant trust the feed.
**Constrains:** Never feed Gamma `outcomePrices` into `raw_inputs` or any metric. On disagreement the
CLOB midpoint wins and the divergence is **reported, not silently reconciled** (see
`scripts/verify-accuracy.js` cross-source check, ±1pt). Documented in `METHODOLOGY.md` ("Source of
record") + `core/methodology.json` `metrics.source_of_record`. Keep the hash recipe over the CLOB
midpoint frozen.

## Data freshness is Tier-1, policy-baked but evaluated client-side
**Decided:** Every record carries `derived.freshness` = `{ as_of, staleness_threshold_hours,
stale_after, expected_cadence, policy }` — a pure function of the snapshot's own `fetched_at` plus one
constant (`STALENESS_THRESHOLD_HOURS = 50`, in `core/freshness.js`). The published record holds
**policy only**; the live `age`/`stale` flag is computed **client-side** (dashboard + note) as
`now > stale_after`. **50h** because the snapshot cron (`update.yml` `0 14 * * *`) runs **daily incl.
weekends** (~24h normal gap), and 50h absorbs one fully-missed run (~48h) without false-alarming.
**Why:** A silently stale number is a trust failure, so the feed must disclose its own age. But age is
inherently a **read-time** quantity — baking `stale:true/false` at build time would be a frozen lie the
moment the file sits unchanged. Publishing an absolute `stale_after` instant lets every consumer judge
staleness with one comparison and no duplicated threshold. (The "weekday-only / ~72h weekend" belief
was **wrong** — only the *email* crons are weekday-gated; the snapshot is daily.)
**Constrains:** Tier-1 (no assumption — firewall-safe). `core/freshness.js` is the **single source**
of the threshold; the browser only supplies "now". The verifier shares this same 50h constant for its
*liveness* horizon (see [[gotchas]] two-horizons). Schema change was additive (`derived.freshness`,
optional → schema 1.2.1). Don't bake a live flag into the published record.

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
