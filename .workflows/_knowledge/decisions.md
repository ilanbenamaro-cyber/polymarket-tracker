# Architectural decisions — the "why"

Durable record of decisions and what each one constrains. One entry per decision.
Newest at top. If you're about to change one of these, read the entry first.

---

## `/api/market` is NEVER HTTP-cached (`Cache-Control: no-store`) — the probe is the correctness layer
**Decided (2026-06-18):** The serverless function (`api/market.mjs`) sets `Cache-Control: no-store` on
**every** response (was `public, max-age=30` on 200s). No edge/CDN/proxy/browser caching of
`/api/market` — every request must execute the function.
**Why:** Resolution authority is a **per-request** check. `lib/serve-market.mjs` runs the gamma-meta
resolution **probe** (`decideBeforeProbe → PROBE → probeLifecycle`) before serving a within-TTL OPEN
record, so a market that resolved *after* caching is caught and refrozen — this is the C4 guarantee. An
HTTP response cache **bypasses the function entirely** (confirmed live: `x-vercel-cache: HIT`, the
function never ran), and with it the probe — so a `public, max-age=30` response let Vercel's Edge replay
a stale **OPEN** record for up to 30s after a market resolved (the exact stale-live gap C4 exists to
prevent). It also made live-verify C2 read `cached:false` on a genuine OPEN hit (the Edge replayed
call #1's miss response). The cost savings HTTP caching would add are **already captured by the Supabase
cache** (a hit serves `cached:true` with zero Polymarket calls on every real invocation); edge-caching
only saves a warm function invocation while trading away resolution correctness — a bad trade for a
fund-facing feed. `no-store` (not `private, no-cache`) so a browser/back-button can't replay a stale
`OPEN`/`age_seconds`/`freshness` either (those are computed at function time and embedded in the body).
**Constrains:** Never reintroduce `public`/`max-age`/`s-maxage` on `/api/market` (or any endpoint whose
correctness depends on the per-call probe) to "save cost" — the Supabase cache is the cost layer, the
probe is the correctness layer, HTTP caching skips both. If a future endpoint is genuinely static
(no resolution semantics), cache *that* one explicitly, never the market-serving path. Verify the
`cache-control: no-store` response header after any deploy (it fingerprints the live build). Proven by
`scripts/verify-phase2a.mjs` 12/12 live (2026-06-18). See [[gotchas]] "Vercel edge-caches …".

## Phase 2a cache + secrets boundary (serverless verified-snapshot cache)
**Decided (2026-06-17):** The Vercel function (`api/market.mjs` → `lib/serve-market.mjs`) serves a
verified record from a Supabase cache, computing on demand via `lib/compute.mjs` → `core/` when needed.
Design rules:
- **Cache×resolution precedence (the correctness trap):** resolution state is authoritative over the
  cache. `lib/decide-cache-action.mjs` (pure, fully unit-tested): a RESOLVED cached record is served
  forever (monotonic, no probe, 0 Polymarket calls); a within-TTL OPEN/CLOSED_PENDING record is
  **gamma-meta-probed before serving** (deduped by PROBE_TTL≈60s) so a market that resolved *after*
  caching is recomputed/frozen, never served stale-live; past-TTL recomputes (which re-classifies).
  TTL = 15min (OPEN); cost is bounded by TTL, not request volume.
- **Per-market freshness:** on-demand records carry **TTL-based** `stale_after` (`buildSnapshotRecord`
  gained an optional `freshnessThresholdHours`); the cron path passes nothing → 17h, so SpaceX stays
  byte-identical. RESOLVED = `freshness.final`, never stale.
- **Secrets boundary:** the `service_role` (write) key lives ONLY in the function's server-side env
  (`SUPABASE_SERVICE_ROLE_KEY`, never `NEXT_PUBLIC_`); `lib/cache.mjs` is server-only. RLS is enabled
  with NO anon policies (anon can touch nothing) so the boundary is safe before 2b adds a browser
  client. Generalizes the PAT-exposure lesson: no write-capable credential in client-reachable code.
- **Single write path:** the ONLY writer to `market_snapshots` is `lib/cache.mjs writeRecord`, fed a
  `validateRecord`-passed record by `computeMarketRecord`/the seed — no path caches unvalidated data.
  The cache STORES `raw_sha256`, never recomputes it.
- **Schema:** `markets` (id = event slug = FK target) + `market_snapshots` (immutable archive, unique
  on (market_id, fetched_at)) + `market_latest` view. FK-ready for 2b watchlists/notifications with no
  table rewrite. Migration is reversible (`_down.sql`); cache is regenerable (no source data).
**Why:** scale the verified pipeline to many markets on managed/serverless infra without per-market
eyeballing, while the cache never reintroduces the Phase-1 resolution bug and never leaks a write key.
**Constrains:** never add an `anon`-readable write policy; never write to the cache outside
`writeRecord`; never serve a record that didn't pass `validateRecord`; keep resolution authoritative
over TTL. Deploy mechanics (Supabase/Vercel projects) are human-provisioned in browser consoles;
live-deploy verification gates "2a done". See `docs/ARCHITECTURE.md` §3/§4/§6.

## Market generalization is config-driven; SpaceX is one pinned instance (Phase 1)
**Decided (2026-06-17):** Every market-specific value lives in a per-market **MarketConfig** DATA
object (`core/markets/<id>.json`), never a code branch — `grep -ri "if.*spacex" core/` must stay
empty. `core/market-config.js` `defaultConfigForLadder(thresholds, meta)` derives scale-free defaults
(tail offsets as a fraction of the median inter-threshold gap, relative confidence count thresholds,
etc.) for any ladder; SpaceX's pinned config equals the historical constants exactly. Every `core/`
function takes the relevant config slice with a **legacy default**, so existing callers and SpaceX are
byte-identical and only generic markets take new branches.
**Why:** Generalizing to many markets without per-market eyeballing requires the tuned constants to be
data, not scattered literals — but the verified SpaceX output must not move. The dual guarantee is
enforced by a **blocking parity gate** (`test/phase1-spacex-parity.test.js`): frozen `raw_sha256`
(`c1be52e4…b89003`) + full `derived` deep-equal + 183-day history re-derive, all against an immutable
pre-generalization fixture. Proven on a second real ladder (Kraken IPO $16–28B) via the generic path.
**Constrains:** Never reintroduce a market literal into `core/` math — add a config field. Never edit
the parity fixture to make a test pass (a diff is a real regression). The frozen hash recipe stays
untouched (generalization is all downstream of `raw_inputs`). methodology 1.4.0 / schema 1.3.0
(additive). See [[gotchas]] resolved-market trap; `docs/ARCHITECTURE.md` §1.2.

## Two-stage market resolution; classify from gamma meta BEFORE any CLOB call
**Decided (2026-06-17):** A market's lifecycle (`core/lifecycle.js`, `snapshot.lifecycle`) is
**OPEN → CLOSED_PENDING → RESOLVED**, classified from gamma signals (`closed` + `umaResolutionStatus`
+ `outcomePrices`) — never `active`/`endDate` (unreliable). RESOLVED only when EVERY rung is
UMA-confirmed (a settled outcome per rung); CLOSED_PENDING when trading ended but UMA is unconfirmed —
**never claims a final outcome** (UMA can lag/dispute); else OPEN. A non-OPEN market is **frozen** (the
orchestrator preserves the last OPEN record + stamps the outcome + `freshness.final`; no live pull; a
frozen RESOLVED record is never re-pulled). Classification happens from **gamma meta before any CLOB
fetch**, because a resolved market returns no midpoints.
**Why:** v1 pulled forever — a resolved market would show a live, drifting estimate of a settled fact;
and the moment SpaceX resolved (2026-06-17) the old cron crashed on missing midpoints. `closed` alone
is not "confirmed" (disputes happen), so we split "stop showing drift" from "declare the result" — a
fund must not be told a final outcome for a still-disputed market. `validate.js` asserts RESOLVED
carries an outcome and OPEN/CLOSED_PENDING do not.
**Constrains:** Resolution notifications (a later phase) must fire ONLY on RESOLVED, never
CLOSED_PENDING. Keep classification before the price fetch. `snapshot.lifecycle` stays OUTSIDE
`derived` so an OPEN market's derived block is byte-identical. Don't use `active`/`endDate` as
resolution signals. See `docs/ARCHITECTURE.md` §5.

## PIVOT: single-market tool → multi-market hosted product (Vercel + Supabase)
**Decided (2026-06-17):** After v1 (single SpaceX market, GitHub Actions + Pages) validated with a
hedge fund, the product generalizes into a **hosted multi-market** product. Locked stack: **Vercel**
(frontend + serverless functions running `core/`), **Supabase** (DB + auth + realtime), **Polymarket**
unchanged as source of truth. First pass scopes to **threshold-ladder events** (SpaceX is one
instance); single binary markets are a deferred record type. Refresh: **on-demand + cache, cron for
followed markets only**. Full design in `docs/ARCHITECTURE.md`; built phase-by-phase (Phase 1 =
`core/` generalization + resolution guard).
**Why:** v1's trust machinery (verified pipeline, firewall, hash, validation) is the differentiator a
fund pays for; the goal is to scale it to many markets without manual per-market eyeballing, on
managed/serverless infra a solo operator can run. The fund is not using the site during the rebuild,
so we migrate cleanly (no parallel-fallback constraint).
**Constrains — THE GOVERNING PRINCIPLE: the verified pipeline runs ON THE BACKEND, on demand.** Every
served number is still isotonic-adjusted, firewall-checked, validated, and hashed by `core/` — the
client never fetches Polymarket and bypasses `core/`. The cache **stores** the frozen hash, never
recomputes it. `derived.scenarios` (Tier-2/SpaceX) becomes **optional**, attached only when a
per-market assumptions config exists — the firewall rule stays un-relaxed. Resolution state is
**authoritative over the cache** (a resolved market is never served as live data); resolution
notifications fire only on **confirmed** UMA resolution, never first sight of `closed:true`. Phase 1
has a **blocking byte-identical-hash gate**: the generalized pipeline must reproduce the SpaceX
record's `raw_sha256` exactly, proving generalization didn't chip the pipeline. See
[[spacex-multi-market-pivot]] in MEMORY if present, and `docs/ARCHITECTURE.md`.

## Staleness threshold is a DERIVED function of the snapshot schedule (never a literal)
**Decided:** With the 2h cadence (cron `0 0,12,14,16,18,20,22 * * *`, 7 runs/day, overnight pause
00:00→12:00 UTC), `core/freshness.js` exports the schedule as facts — `SCHEDULE = {CADENCE_H:2,
MAX_EXPECTED_GAP_H:12, JITTER_MARGIN_H:3}` — and computes `STALENESS_THRESHOLD_HOURS` as their sum
(**17h**). `test/schedule-coupling.test.js` re-derives the gap profile from the ACTUAL update.yml cron
(max gap == MAX_EXPECTED_GAP_H, min gap == CADENCE_H) and fails loudly on cron syntax it can't parse.
**Why:** The previous 50h literal was sized for the retired daily cadence and carried a correct,
well-written comment — which desynced anyway the moment the schedule changed (audit P0-1: at 2h
cadence, 50h ≈ 25 missed runs of silence before the STALE flag fired). Comments don't couple; a test
that re-derives the numbers from the workflow file does. Methodology bumped to **1.3.0** (minor:
published policy fields change meaning; no formula change).
**Constrains:** Changing the snapshot cron REQUIRES re-deriving `SCHEDULE` (the coupling test forces
it). Never reintroduce a free-standing threshold literal, and never widen the threshold to quiet a
STALE flag — investigate the pipeline instead. verify-accuracy.js shares the constant by import.

## CI verify gate = publish-then-alert, non-strict, last step
**Decided:** `update.yml` runs `scripts/verify-accuracy.js` (non-strict) as the LAST step, after the
push and the email steps, in all modes. Exit ≠ 0 turns the run red (alert) but can never block
publication or digests. Transport failures (output without a `VERDICT:` line) retry once; real
verdicts surface immediately.
**Why:** Seam-5 fail-mode design: a wedged feed (nothing published) is a worse failure than a
published-then-flagged snapshot — freshness disclosure already covers consumers. Non-strict because
`--strict` promotes Gamma-vs-CLOB cross-source disagreement to FAIL, and Gamma is a documented
*lagging* cross-check (see "Canonical source of record") — false reds train alert blindness. Seconds
after the snapshot the record is deep inside the 3h price-match window, so non-strict still exits 1
on any real published-vs-live mismatch, which at that age means build corruption.
**Constrains:** Do not move the gate before the push (that re-creates the wedge), do not add
`--strict` without first separating cross-source disagreement from publish-mismatch in the exit
codes, and never widen a tolerance to quiet a red run — a FAIL is a finding to investigate.

## GitHub concurrency queue-drop at 2h cadence is ACCEPTED
**Decided:** The `snapshot-commit` concurrency group keeps at most ONE pending run queued; GitHub
cancels additional pending runs even with `cancel-in-progress:false`. Under the 2h cadence (plus
email crons and manual dispatches) a third overlapping run gets cancelled. This is accepted, not
worked around.
**Why:** A cancelled queued snapshot is covered by the next scheduled run within ≤2h — well inside
the 17h staleness threshold. The serialization itself is what prevents the `rebase -X theirs` clobber
window (a queued run checks out only after the prior one pushed, so it always sees that commit).
**Constrains:** Don't remove the concurrency group to "fix" cancelled runs — it's what makes the
push path safe. If sub-2h data loss ever matters, redesign the queue, don't drop the group.

## Volume = Gamma market-level all-time cumulative `volume`
**Decided:** The per-threshold `volume` we publish is Gamma's **market-level `volume`** field — read once
in `core/fetch.js` (`m.volume`), and summed across thresholds for `derived.total_volume`. For these
SpaceX markets it equals `volumeClob` and `volume1yr` (the markets are **CLOB-only**, so AMM volume is
zero and the variants coincide). It is **all-time cumulative** volume; we take the single market-level
figure and do **not** sum the YES+NO tokens (Gamma's `volume` is already market-level). This is the
**same statistic as Polymarket's ALL-timeframe display**. The dashboard column is labeled
"**All-time volume**" with a tooltip tying it to the snapshot's `fetched_at`.
**Why:** Apparent gaps vs the Polymarket UI are **temporal staleness on a cumulative metric, not a
definition mismatch** — all-time volume only ever grows, so a UI reading taken earlier than our live
fetch is necessarily lower, by an amount proportional to each market's subsequent trading. Verified
**2026-06-11** via timeline reconstruction: for >$1.8T, >$2T and >$3T the screenshot's ALL figures all
land strictly between `now − volume1wk` (~1 week ago) and `now` (live), and the gap is largest exactly
where the last week's trading was heaviest (>$1.8T). No single window field (`volume24hr/1wk/1mo/1yr`)
matches the UI numbers; only the cumulative-with-staleness model explains all three consistently.
**Constrains:** Keep reading the market-level `volume` (not a window field, not a YES+NO sum). `volume`
stays in the frozen `raw_inputs` hash recipe (see "raw_inputs + hash recipe are FROZEN") — do not swap
the field. Relabeling/precision lives in presentation only; this is **Tier-1**, no new computation and no
version bump. Like "Canonical source of record — the CLOB midpoint", this is a canonical-definition
decision: do not re-litigate it as a bug when a stale UI tab disagrees.

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
