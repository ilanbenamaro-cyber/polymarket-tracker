# polymarket-tracker → multi-market hosted product — ARCHITECTURE

> Status: design, approved 2026-06-17; build proceeds phase by phase. v1 (single SpaceX market,
> GitHub Actions + Pages) validated with a hedge fund. This document generalizes it into a hosted,
> multi-market product on **Vercel + Supabase**, **without weakening the trust machinery** that made
> v1 defensible. The fund is not using the site during the rebuild, so we migrate cleanly (no
> parallel-fallback constraint). Solo operator; terminal + Claude Code workflow preserved.
>
> Locked stack: **Vercel** (frontend + serverless `core/`), **Supabase** (DB + auth + realtime),
> **Polymarket** (source of truth, unchanged). First pass scopes to **threshold-ladder events**
> (SpaceX is one instance); single binary markets are a deferred record type. Refresh model:
> **on-demand + cache, with a cron that refreshes followed markets only**.

## 0. The governing invariant
Every number served is produced by the **verified pipeline**: fetched from Polymarket, isotonic-
adjusted, metric-computed, confidence-scored, **firewall-checked, schema+invariant validated, and
sha256-hashed** — exactly as today, now **on demand and cached** instead of once-a-day to static
files. The backend runs `core/`; the client never fetches Polymarket and bypasses it. A record that
fails validation is never cached and never served. These survive the migration unchanged:
**verified pipeline · Tier-1/Tier-2 firewall · frozen hash recipe · one-source-of-truth (core/ owns
every formula) · validation gates.**

---

## 1. The `core/` pipeline as a serverless service

### 1.1 Shape today vs target
- **Today:** `scripts/snapshot.js` is a cron entrypoint — one hardcoded event (`EVENT_SLUG =
  'spacex-ipo-closing-market-cap-above'`), file-based history (`docs/api/v1/history-full.json`),
  output written to static files under `docs/api/v1/`, HTML baked.
- **Target:** a Vercel function `computeMarketRecord(marketId)` → returns the verified canonical
  record for **any** registered threshold-ladder event. Same pipeline **order** as
  `scripts/snapshot.js:main()` — fetch → anomalies → `buildSnapshotRecord` → `attachAnalytics` →
  (`attachScenarios` only if configured) → `attachNarrative` → `validateRecord` → persist — but
  market id is a parameter, priors come from Supabase (not a file), and output is a Supabase upsert.

### 1.2 `core/` inventory — agnostic vs SpaceX-specific (the precise split)
**Reuse verbatim (market-agnostic, the crown jewel):**
- `core/stats.js` — PAVA, `adjustSnapshot`, `medianBand`, `meanSensitivity`, `volumeTiers`. Pure.
- `core/metrics.js` — `quantileValuation`, median, IQR, bucket/density, mean, monotonicity. Pure
  survival-curve math.
- `core/validate.js` — schema + bucket invariants + **firewall**. The trust machinery; reused intact.
- `core/freshness.js` — schedule-derived staleness; already market-agnostic (see §3 for per-market use).
- `core/fetch.js` `canonicalizeRawInputs` + `hashRawInputs` — **FROZEN hash recipe; reused byte-for-
  byte** (the v1 verifiability guarantee depends on this not changing).

**Parameterize (carries SpaceX/event-specific constants or wiring):**
| File | SpaceX-specific element | Generalization |
|---|---|---|
| `core/fetch.js` | `EVENT_SLUG`, `ASSET` const, `THRESHOLD_RE = /\$(\d+\.?\d*)/`, `clobTokenIds[0]=YES` | Take a market identifier + a **threshold-scale descriptor** (unit, parse pattern); keep the batch CLOB calls and the frozen `raw_inputs` shape |
| `core/metrics.js` | `BELOW_TAIL_OFFSET=0.15`, `ABOVE_TAIL_OFFSET=0.4` (tuned to the $1T–$4T ladder); `$…T` labels | Derive tail offsets as a **fraction of the median inter-threshold gap** (scale-free); unit label from the scale descriptor |
| `core/stats.js` | `LIQUIDITY_FLOOR=50_000` (market-size); `MEAN_GRID` offsets ($T-scale) | Floor + grid from the scale descriptor / relative to volume distribution |
| `core/confidence.js` | `MIN_THRESHOLDS_HIGH=12`, `MIN_THRESHOLDS_MEDIUM=8` (assume ~16-rung ladder) | Make the threshold-count signal **relative to the event's own ladder size**, else any smaller event always scores low |
| `core/analytics.js` | `computeCalibration` hardcodes `resolves:'2027-12-31'`, `prob_1_8t/2_0t/2_4t` | Resolution date from the market; standing-forecast thresholds from the ladder |
| `core/narrative.js` | "SpaceX's IPO-closing cap" wording, `$…T` | Template from market metadata + scale descriptor |
| `core/snapshot.js` | `buildHistoryEntry` `probAt(…,1.8/2.0/2.4)`; `attachScenarios`; `SCHEMA_VERSION` | Generalize the history projection; scenarios become opt-in (§1.3) |
| `core/scenarios.js`, `core/assumptions.json` | **Entirely SpaceX** (shares outstanding, last round) | Per-market opt-in module (§1.3) |

**I/O shell (replace — see §10):** `scripts/snapshot.js`, `renderers/api.js`,
`renderers/dashboard.js`, `update.yml`, `email.js`/`send-emails.js`/Gist.

### 1.3 Tier-2 (scenarios) decoupling — the firewall makes this clean
Scenario analysis is SpaceX-specific and must be **cleanly absent**, not crashing, for general
markets. The mechanism is already in place:
- `core/scenarios.js` **never fabricates** — with no usable assumption it returns
  `status:"input_required"`; the firewall in `validate.js` only demands sourced assumptions for a
  scenario that carries a **numeric** output. So a market with no assumptions registry can carry
  **no `derived.scenarios` block at all** and the firewall has nothing to check.
- **Change:** make `derived.scenarios` **optional** in the v2 schema (today
  `derived.required` includes `"scenarios"`); attach it **only when a per-market assumptions config
  exists** (SpaceX keeps `assumptions.json`; general markets get none). The firewall rule itself is
  **unchanged and un-relaxed** — it simply has nothing to act on. Tier-1 (`derived.market.analytics`)
  remains required for every market.
- Full scenario rework (a general per-market assumptions system) is a **later pass**; this pass only
  guarantees general markets don't break on its absence.

---

## 2. Market generalization

### 2.1 Identity, fetch, validation
- **Canonical key:** Polymarket `conditionId` (stable, on-chain) per market; an event is tracked by
  its **event slug** + the set of member `conditionId`s. The unit of a record is the **event** (the
  threshold ladder), as today.
- **Fetch:** generalize `fetchMarketMeta` to take an event slug/id; confirm ≥2 member markets whose
  `question` parses a numeric threshold (generalized pattern), YES token resolvable, not all closed.
- **Validity gate:** an event qualifies as a `threshold_ladder` market if ≥2 thresholds parse and
  the survival curve is computable; otherwise it is rejected from the catalog (binary markets are a
  **deferred** record type).

### 2.2 Search & browse (grounded against the live Gamma API)
- **Text search:** `GET https://gamma-api.polymarket.com/public-search?q=<text>&limit_per_type=N`
  → `{ events: [...], pagination }`; each event carries `.markets`.
- **Browse/filter:** `GET https://gamma-api.polymarket.com/markets?active=true&closed=false&
  order=volume24hr&ascending=false&limit=N` → flat array.
- **Market fields available:** `id, conditionId, slug, question, outcomes, outcomePrices,
  clobTokenIds, volume, active, closed, acceptingOrders, umaResolutionStatus, resolvedBy, endDate,
  startDate, groupItemTitle, negRisk, events`.

### 2.3 Metadata: store vs fetch live
- **Store (Supabase `markets`):** conditionId/event-slug, title, kind, **threshold-scale descriptor**
  (unit, parse pattern, label template, tail-offset policy), category, end_date, resolution_status.
  Refreshed lazily / by the catalog sweep.
- **Fetch live (through `core/`):** all prices/volumes/book → the verified record. Never cache a
  Polymarket price outside a validated record.

---

## 3. Caching + freshness (accuracy AND cost control)
**Model: on-demand + cache; cron refreshes followed markets only.**
- **Read path:** view → if a cached record for the market is younger than `CACHE_TTL` (~10–15 min)
  **and the market is not resolved/closed**, serve it; else run `computeMarketRecord`, validate,
  upsert, serve. **Resolution is checked before TTL — see §3.1.**
- **Single-flight:** dedupe concurrent computes for the same market (a short `computing_until` lock
  row / advisory lock) so a burst of clicks triggers one pipeline run, not N.
- **Cron (Vercel, ~2h):** refresh the **DISTINCT set of markets in at least one watchlist** +
  resolution sweep. Unfollowed markets never auto-refresh → **cost ∝ followed markets, not catalog
  size**.
- **Rate-limit/cost controls:** TTL + single-flight + cron-only-for-followed + the already-batched
  CLOB calls in `fetch.js`. Polymarket is auth-free but we must not hammer it; the cache is the
  throttle.

### 3.1 Cache × resolution interaction (the cache must NOT reintroduce the resolution bug)
The TTL cache and the resolution guard interact by a strict precedence: **resolution state is
authoritative over the cache.** Concretely:
1. **The read path checks `markets.resolution_status` BEFORE the TTL check.** If a market is
   `closed_pending` or `resolved`, the read path serves its **frozen** record and **does not** run a
   live Polymarket fetch — regardless of cache age. A resolved market can never be re-fetched into a
   live, drifting number.
2. **A market that resolves AFTER being cached:** the cron's resolution sweep (§5) detects the state
   change, flips `resolution_status`, and writes the frozen final record (`is_final=true`). Because
   step 1 keys on `resolution_status`, the previously-cached "live" record is **never served again**
   for that market the moment its status flips — even within the old TTL window, even before its
   `stale_after`. The status flip invalidates the live cache by construction.
3. **Belt-and-braces for the gap between resolution on Polymarket and the next sweep:** the on-demand
   read path itself, on a cache miss that triggers a fetch, re-checks the live `closed` /
   `umaResolutionStatus` fields (the same guard the sweep uses) and will not write a "live" record for
   a market Polymarket reports as closed — it transitions the market instead. So both the scheduled
   sweep and incidental traffic close the window; neither can serve live data for a closed market.

### 3.2 Per-market freshness under on-demand + TTL (vs the old single scheduled cron)
v1 had one market on one cron, so a single schedule-derived staleness threshold (`core/freshness.js`,
17h) described it. Multi-market on-demand needs **two freshness regimes, chosen per market by whether
it is followed**:
- **Followed markets** (cron-refreshed ~2h): keep the **schedule-derived** model exactly as today —
  `stale_after = fetched_at + threshold`, where the threshold is derived from the cron cadence via the
  existing `SCHEDULE` struct. These markets have a guaranteed cadence, so "stale" means the pipeline
  missed runs, same semantics as v1.
- **On-demand (unfollowed) markets:** there is no cron cadence, so the schedule-derived threshold is
  the wrong model. Their record carries a **TTL-based freshness**: `as_of = fetched_at`, and the
  record is "fresh" only within `CACHE_TTL`; past it the UI shows the as-of age and silently
  recomputes on next view (the value was always computed-on-demand, never promised a cadence).
- **Implementation:** `core/freshness.js` already emits a per-record `stale_after` from that record's
  own `fetched_at` + a threshold argument — so this is a **parameter choice at call time** (cadence
  threshold for followed, TTL for on-demand), not a new formula. The freshness block records which
  regime applies (`expected_cadence` text differs) so a consumer knows whether a stale reading means
  "pipeline down" (followed) or merely "nobody has looked recently" (on-demand).

---

## 4. Data model (Supabase)
All tables RLS-enabled. The data is public → **public read** on market data; **owner-only** on
user-scoped rows; **service-role write** on snapshots (only the compute function writes them).

- `profiles` — public profile keyed to `auth.users` (Supabase Auth owns identity).
- `markets` — catalog: `id (conditionId/slug)`, `title`, `kind('threshold_ladder')`,
  `threshold_scale jsonb`, `event_slug`, `category`, `end_date`,
  `resolution_status ('open'|'closed_pending'|'resolved')`, `resolved_outcome jsonb`,
  `last_checked_at`. One row per tracked market.
- `market_snapshots` — **verified canonical records**: `market_id fk`, `fetched_at`, `raw_sha256`,
  `methodology_version`, `schema_version`, `record jsonb` (the full canonical record),
  `confidence_tier`, `implied_median`, `stale_after`, `is_final bool`. Archive = immutable rows
  (generalizes `docs/api/v1/snapshots/`). A `market_latest` view/flag gives O(1) latest.
- `watchlists` — `user_id fk`, `market_id fk`, `created_at`. RLS owner-only.
- `notifications` — `user_id`, `market_id`, `type('resolution')`, `payload jsonb`, `created_at`,
  `read_at`, `delivered_at`. RLS owner-only.
- `notification_log` — `(market_id, user_id, type, sent_at)` dedupe so a resolution fires once.

**Hash/provenance mapping (the frozen recipe is preserved):** the function computes `raw_sha256`
once via the frozen `hashRawInputs`; the cache **stores** it (`record.snapshot.source.raw_sha256`
plus a `raw_sha256` column for indexing) and **never recomputes**. A server `verify` endpoint can
re-hash `record.snapshot.raw_inputs` and compare to the stored column — the same guarantee the v1
browser verifier gives, now server-side. Archive rows are immutable.

---

## 5. Market lifecycle / resolution — the highest-priority correctness fix
**The bug:** today the pipeline always fetches and recomputes; nothing stops when a market resolves.
`countClosed()` only feeds a confidence anomaly — it never halts pulling or freezes the outcome. A
resolved market would keep showing a live, drifting "estimate" of a settled fact.

**A two-stage model — closed ≠ confirmed.** Polymarket/UMA resolution can lag or be **disputed**.
`closed:true` can precede a confirmed, undisputed outcome. Telling a fund a "final result" for a
still-disputed market is a wrong-data-to-a-trading-customer bug. So we separate *stop showing live
drift* from *declare the final outcome*:

| Signal (Gamma, live-confirmed) | State | Behavior |
|---|---|---|
| `closed === true` but `umaResolutionStatus !== "resolved"` | **`closed_pending`** | STOP live pulling; freeze display to the last record, labeled *"market closed — awaiting confirmed resolution"*; **no final-outcome notification** |
| `umaResolutionStatus === "resolved"` **and** `outcomePrices` is a clean 0/1 settlement | **`resolved`** | Freeze final record (`is_final=true`); set `resolved_outcome`; **fire resolution notifications (§7)** |

- **Do NOT use `active` or `endDate`** as signals — probed live: `active` stays `true` on a resolved
  market and `endDate` can be far-future even after early resolution. The reliable signals are
  `closed` and `umaResolutionStatus`.
- **Winner** comes from `outcomePrices` — the outcome equal to `"1"` (e.g. `["0","1"]` → "No"). For a
  threshold ladder, each rung resolves Yes/No and the realized value lands in a bucket.

**Handling:** a guard at the top of the fetch path (function + cron) short-circuits on
`closed_pending`/`resolved`, serving the frozen record; the cron resolution sweep performs the
state transitions; the UI shows the closed/resolved state, never a live number.

**Buildable early & independently:** it's a guard + the `resolution_status` enum + a resolution
sweep; no dependency on auth/watchlist/UI. **Build it in Phase 1** with the `core/` generalization —
it is the correctness fix the fund cares about most.

---

## 6. Auth (Supabase Auth — not hand-rolled)
- **Identity:** Supabase Auth (email magic-link or OAuth). Client uses `@supabase/supabase-js`;
  session in an httpOnly cookie.
- **Authorization:** Vercel functions receive the user's Supabase JWT; **RLS** enforces per-user
  watchlist/notification access at the DB layer (the function acts **as the user**, not service-role,
  for those reads/writes). The **service-role key** is used **only** by the compute function to write
  `market_snapshots`, and is never shipped to the client.
- **Gating:** market data read = **public**; follow/unfollow + notifications = **auth required**. The
  fund logs in to manage a watchlist; the verified data itself stays public-readable.

---

## 7. Notifications
- **Resolution notification — gated on CONFIRMED resolution.** Fire **only** when a market reaches
  state `resolved` (§5: `umaResolutionStatus === "resolved"` **and** a clean 0/1 `outcomePrices`).
  **Never** on first sight of `closed:true` (`closed_pending` is silent — a closed-but-disputed market
  must not send a "final result"). One row per following user, deduped via `notification_log` so it
  fires exactly once even across repeated sweeps.
- **Channels (recommended, lowest-maintenance for solo ops):** **(1) in-app** via the Supabase
  `notifications` table + Realtime subscription — zero new infra, RLS-secured. **(2) email** via a
  **managed transactional sender** (Resend/Postmark or Supabase's built-in) triggered from the cron /
  a DB webhook. **Skip web push** (service workers + token lifecycle = high maintenance) → defer.
  (The existing Microsoft-Graph `email.js` was tenant-specific; a managed API is lower-ops for a
  hosted product.)
- **Scheduled checker:** the same Vercel Cron that refreshes followed markets runs the resolution
  sweep → transition state, freeze, and enqueue notifications only on the `→ resolved` edge.

---

## 8. News area — design the firewall now, build later
News is **unverified external content** sitting next to **verified market data**; it needs the same
**structural separation** as the Tier-1/Tier-2 firewall so junk news cannot borrow the feed's
credibility.
- **Separation rule:** news lives in its **own namespace** (`news` table / a `context` block),
  **never inside the canonical `record` or `derived`, never hashed, never through `validate.js`.**
  Tagged `provenance:"unverified_external"` with a distinct visual treatment (like the Tier-2
  "ASSUMPTION-BASED" banner).
- **Direction of reference:** news may reference a `market_id`; the canonical record must **never**
  reference news. The record's hash + firewall must compute and validate with **zero news present**.
- **Defer the build.** Reserve the namespace + the rule now.

---

## 9. Migration plan (phased, dependency-ordered)
Each phase independently shippable + testable. Order: **0 → 1 → {2,3} → 4 → 5 → 6.**

- **Phase 0 — Scaffolding.** Vercel + Supabase projects; schema migrations (profiles, markets,
  market_snapshots, watchlists, notifications, notification_log) + RLS; `@supabase/supabase-js`
  wiring; env/secrets. *Verify:* tables + RLS policies tested; no behavior yet.

- **Phase 1 — `core/` generalization + resolution guard (FOUNDATIONAL — build first).**
  Parameterize `fetch.js` (market id + threshold-scale descriptor); scale-free tail offsets;
  relative confidence threshold-count; analytics calibration from market metadata; make
  `derived.scenarios` optional/decoupled; add the two-stage resolution guard (§5). `core/` stays
  pure; extend the test suite with a second real ladder event + `closed_pending` and `resolved`
  fixtures.
  - **HARD GATE (blocking — this is the definition of "Phase 1 done"):** before generalizing, capture
    a **frozen pre-migration reference record** for the SpaceX event (the current published
    `latest.json`'s `raw_inputs` + its `raw_sha256`). After generalization, the regenerated SpaceX
    record must produce a **byte-identical `raw_sha256`** to that reference. This regression test
    green is the proof that generalization did not chip the verified pipeline. It is a blocking gate,
    not a checkbox — Phase 1 does not ship until it passes.
  - *Also verify:* the generalized pipeline runs on a **second real event**; both validate + hash;
    `closed_pending` freezes-without-notifying and `resolved` freezes-and-flags.

- **Phase 2 — Serverless compute + cache.** The Vercel `computeMarketRecord` function + Supabase
  cache (TTL, single-flight, immutable archive) + the §3.1 resolution-over-cache precedence + §3.2
  per-market freshness regimes. *Verify:* cold compute → cache hit → archive immutable; hash **stored
  not recomputed**; `verify` endpoint re-hashes and matches; **a market flipped to resolved is never
  served as a live cached record even within its TTL.**

- **Phase 3 — Search/browse + market pages (public, read-only).** Search/list endpoints; a market
  page that renders the canonical record (reuse v1 dashboard render logic, generalized). *Verify:*
  search → open any event → verified record renders, no auth.

- **Phase 4 — Auth + watchlists.** Supabase Auth; follow/unfollow; RLS. *Verify:* two users'
  watchlists isolated; gated writes.

- **Phase 5 — Followed-market cron + resolution sweep + notifications.** The cron (refresh followed +
  resolution sweep), in-app + email notifications, dedupe. *Verify:* a fixture market in
  `closed_pending` sends **no** notification; on transition to `resolved` it fires **exactly one**
  notification per follower and freezes.

- **Phase 6 — News (LATER).** Build the firewalled news area per §8.

**Invariant survival through migration:**
| Invariant | How it survives |
|---|---|
| Verified pipeline | The function runs `core/`; client never bypasses it |
| Tier-1/Tier-2 firewall | `validate.js` unchanged; scenarios optional but firewall rule un-relaxed |
| Frozen hash recipe | `hashRawInputs` reused verbatim; cache **stores**, never recomputes; **Phase-1 byte-identical hash gate** enforces it |
| One-source-of-truth | `core/` remains the only formula home; cache/renderers display stored values |
| Validation gates | `validateRecord` runs in the function **before any cache write**; an invalid record is never cached or served |
| No stale-as-live | Resolution state is authoritative over the cache (§3.1); a resolved market is never served live |

---

## 10. What we KEEP from the current codebase
- **KEEP almost intact (the crown jewel):** all of `core/` — `stats.js`, `metrics.js`, `validate.js`,
  `freshness.js`, `format.js`, the `fetch.js` hash recipe, `snapshot.js` assembly, `analytics.js`,
  `narrative.js`, `scenarios.js` — plus the test suite. Six passes of hardened pipeline survive; they
  are **invoked differently** (function vs cron) and **parameterized** (market id vs hardcoded slug).
- **REWRITE/REPLACE — the I/O edges only:** `scripts/snapshot.js` (file/cron orchestration) → a
  serverless handler + Supabase; `renderers/api.js` (writes `docs/api/v1/*`) → Supabase upsert + read
  API; `renderers/dashboard.js` bake → a real frontend on Vercel; `update.yml` → Vercel Cron;
  `email.js`/`send-emails.js`/Gist → Supabase notifications + managed email.
- **Why the boundary is clean:** `core/` is already pure (no I/O); today's scripts/renderers ARE the
  I/O shell. We swap the shell, keep the engine.
