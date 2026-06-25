# primer.md — resume here

> First file to read on a new session. Present-tense, thin, kept current.
> The "why" behind decisions lives in `.workflows/_knowledge/decisions.md`;
> traps that already bit us live in `.workflows/_knowledge/gotchas.md`.
> **Knowledge layout (this repo):** `primer.md` is the resume-here file (it plays the
> SESSION-CONTINUITY role); the only `_knowledge/` files are `decisions.md` + `gotchas.md`.
> There is **no `.workflows/_system/` dir, no `codebase.md`/`MEMORY.md`** — the global `/sync`
> skill tolerates their absence (updated 2026-06-18); don't be alarmed when it skips them.

## ⮕ DIRECTION (2026-06-25): Phase 1b — CATEGORICAL MODEL — DONE on `feature/history-system` (live-verified)
- **Categorical markets now COMPUTE** (was a 422 gate). `core/categorical.js` (de-vig
  `normalizeProbabilities`, `shannonEntropy`, `consensusStrength`, `scoreCategoricalConfidence`,
  `buildCategoricalRecord`) + `core/fetch.js` `fetchCategoricalMeta/Status/Snapshot` (YES-leg PMF
  via the shared Phase-1 fallback chain) + `computeCategoricalRecord` (route in `compute.mjs`,
  replacing the 422). **RAW observed midpoints stay in raw_inputs (threshold=leg index); de-vig is
  display-only → hash recipe UNCHANGED** (constraint #2). schema.json categorical `allOf` branch +
  `validate.js` skip + **migration 0007** (kind check) + methodology.json recipe doc.
- **`CategoricalDetailView.tsx`** (dominant headline + entropy consensus meter + SVG outcome bars +
  volume table + trust/hash-verify + trend chart), routed in MarketDetailView; HistoryChart treats
  categorical as a 0–100% dominant-prob axis. `market-history` fineKind/headlineValue/dispersion updated.
- **LIVE-VERIFIED** (`node scripts/verify-categorical.mjs`, network-only, no DB): `how-many-fed-rate-cuts-in-2026`
  → 13 outcomes sum 1.0, dominant "0 (0 bps)" 80%, entropy 0.291→HIGH, hash re-verifies. **SpaceX parity 3/3.**
  node --test **194/194** (+13), tsc clean, next build clean. Commit `e916207`.
- **⚠ OPERATOR:** apply **migration 0007** to DEV (+ PROD at standup). Categorical adds to watchlist via
  search now (no error). `scripts/verify-categorical.mjs` runnable anytime (no creds).
- **NEXT:** Phase 2 (I5+ bug cluster: Bug 3 NEAR SETTLEMENT [started on `feature/i5-confidence-near-settlement`],
  Bug 5 median labels, Bug 6, Bug 7 titles, Bug 8 analytics-collecting, Enh 1–8, signup, keyboard) → Phase 3
  (v1-parity, HARD-GATED on real history rows) → Phase 4 polish.

## ⮕ DIRECTION (2026-06-25): Phase 1 — HISTORY SYSTEM — CODE DONE on `feature/history-system` (live gate pending operator)
- **Why:** the multi-market product computes on demand + caches ONE snapshot, so every
  velocity/dispersion/trend card was empty (v1 SpaceX showed them from a stored daily series).
  This is the foundational unlock for the whole Phase-3 v1-parity roadmap. **Branch off `main`**
  (independent of + sequenced before the in-flight Bug 3 work on `feature/i5-confidence-near-settlement`).
- **Backend (`deb0e8b`):** migration **0006** `market_history` (one row/market/UTC day, upsert on
  `(market_id,snapshot_date)`); **RLS deny-all, MIRRORS market_snapshots** — service role is the only
  reader (operator-confirmed choice; NOT the prompt's authenticated-policy variant — the prompt
  self-contradicted, see the AskUserQuestion decision). `lib/market-history.mjs`: pure derive fns
  (`linregSlope`, `deriveVelocity` ≥7d, `deriveDispersion` ≥30d, `deriveDeltas`, `deriveBiggestMoves`)
  + server-only I/O (`allWatchedMarketIds`, `writeHistory`, `readHistory`, `marketsSnapshottedOn`).
  **Sub-minimum series → explicit `{status:'collecting'}`, never dashes/fabrication.** `app/api/snapshot`
  cron route: **TIMING-SAFE CRON_SECRET Bearer** (Vercel dispatcher pattern, Context7-verified), **FAILS
  CLOSED** if secret unset; one bad market never stops the batch; RESOLVED skipped (frozen); dedup guard.
  `vercel.json` crons `0 2 * * *`. `scripts/verify-history.mjs` = the live-gate harness.
- **UI (`75dc227`):** `HistoryChart.tsx` (client island, hand-rolled SVG, 7D/30D/90D/ALL toggle, binary
  0–100% axis vs value-range axis, <2 pts → "Collecting history") + `TrendHistory.tsx` (shared section
  — extracted to break the MarketDetailView⇄Binary/Touch import cycle — velocity+dispersion cards with
  collecting states) rendered on **all three** detail views. `readHistory` wired into the detail Server
  Component; lean `{date,value}` series only — heavy record JSONB never ships to client.
- **Additive — touches NO compute path. SpaceX `raw_sha256` byte-identical (parity 3/3).** Offline gates
  ALL GREEN: **node --test 181/181** (+18 new `test/market-history.test.js`), **tsc clean**, **next build clean**.
- **⚠ OPERATOR LIVE GATE (the "done" criteria I can't run — needs the console + dev creds):**
  (1) apply **migration 0006** to DEV Supabase (`dxoyxjxcfbgygvjvrrfk`); (2) set **CRON_SECRET** in
  `.env.local` (and Vercel Preview+Production at standup); (3) `rm -rf .next && npm run dev` (:3001);
  (4) run `BASE_URL=http://localhost:3001 CRON_SECRET=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=…
  NEXT_PUBLIC_SUPABASE_ANON_KEY=… node scripts/verify-history.mjs` → expect NEG 401s, POS batch summary,
  rows in `market_history`, anon-RLS 0 rows, deriveVelocity 'collecting'. To prove the chart/cards
  DISPLAY before 7 real days exist, seed fixture history rows. **PROD-STANDUP now also needs 0006 + CRON_SECRET.**
- **NEXT (sequenced):** Phase 1b categorical model → Phase 2 (I5+ bug cluster, incl. the Bug 3 NEAR
  SETTLEMENT work already started on `feature/i5-confidence-near-settlement`) → Phase 3 v1-parity
  features (**HARD-GATED on real history rows existing**) → Phase 4 polish. Full roadmap in the session prompt.

## ⮕ DIRECTION (2026-06-24): Market-type redesign — 5 shapes routed correctly — MERGED to main
- **MERGED** (`--no-ff` `8db0251`; clean topology, no cron race; **163/163** on merged main; SpaceX
  `raw_sha256` byte-identical — parity GATE 1 green). The P0 cluster (Bugs 1/2/4) is fixed AT THE ROOT:
  the pipeline no longer forces every multi-leg `$` market through the survival ladder.
- **5 shapes** — `core/fetch.js marketShapeFromMarkets`/`classifyMarketShape` → `computeMarketRecord`
  routes `binary | survival | bucket_pmf | directional_touch | categorical`, classified from gamma
  question text BEFORE any threshold parse (`kindFromMarkets` kept for the binary gate + its tests):
  - **survival** (SpaceX "above $X") — unchanged, pinned, frozen-hash.
  - **bucket_pmf** (Bitcoin/Anthropic "between $X and $Y") — `core/bucket.js`: parse intervals → de-vig
    PMF → derive survival curve + PMF mean (`computeBucketPmfRecord`). Stored kind `threshold_ladder`
    (NO migration), renders via the ladder detail view. **Bitcoin $60.98K, Anthropic $1.69T** (was
    $T / $54T). The "not IPO" categorical leg is excluded with a count.
  - **directional_touch** (WTI/Silver "(LOW)/(HIGH) hit $X") — `core/touch.js` (pure, parse+range) +
    `core/touch-record.js` (builder) + `computeTouchRecord` + `components/zones/TouchDetailView.tsx`.
    NO median — the implied 50%-crossover RANGE. **WTI $66.73–$90.00.** New `kind='directional_touch'`
    (schema `allOf` branch + migration 0005). raw_inputs use SIGNED synthetic thresholds (canonicalize
    unchanged).
- **Units (Bug 1):** `core/money.js` parseMoney (commas + K/M/B/T → absolute $) + deriveUnit; thresholds
  stored as MANTISSAS in the derived unit; detail (`unitFromLadder` now T/B/M/K/bare-$) + rail
  (`market-scan.headlineDisplay` reads the record's labels) + narrative read each market's OWN unit —
  no more "$T on everything". $T still routes through `fmtT` so the SpaceX rail string is byte-identical.
- **⚠ MIGRATION 0005** (`0005_directional_touch.sql`): widens `markets_kind_check` to add
  'directional_touch'. **APPLIED to DEV.** bucket_pmf needs none. **PROD-STANDUP now requires
  `0001`+`0002`+`0003`+`0004`+`0005`.**
- **GATE-PROVEN:** 163/163 + frozen-hash parity GATE 1 + tsc clean; live `/api/market` serve (compute →
  Supabase cache WRITE → read) for Bitcoin (bucket) + WTI (touch, post-0005); **Playwright** (dev :3001,
  `DEV_LOGIN_PASSWORD`): Bitcoin bucket detail = $60.98K full distribution, WTI touch detail = TOUCH
  MARKET badge + $66.73–$90.00 range + touch table + range bar, rail shows the WTI range — **0 console
  errors** (favicon 404 only).
- **⚠ Vercel posture UNCHANGED** — production stays erroring pre-standup (fails-closed 500). Expected.
- **⚠ Stale cache (cosmetic, NOT a bug):** watchlist rows computed by the OLD pipeline show bare-$
  medians in the rail until recomputed; every NEW compute is correct.
- **Roadmap:** `MARKET-TYPES-PLAN.md` (delete when the epic fully lands). **NEXT: I5+** — Bug 3
  (confidence recalibration + NEAR SETTLEMENT state), Bug 5 (ladder "< lowest" / "> highest" median
  labels), Bug 6 (near-settlement settlement view), Bug 8 (analytics "requires history"), Bug 7 (titles
  polish) + Enhancements 1–8 + signup form (Enh 6) + keyboard nav (Enh 8). Minor polish: touch range-bar
  labels overlap when the band is narrow. Backup branch `feature/p0-parser-units-mean` retained.

## ⮕ DIRECTION (2026-06-24): Categorical detection + UI polish — MERGED to main
- **Categorical market detection: MERGED** (`--no-ff` `174cab0`; 136/136). `core/fetch.kindFromMarkets`
  now classifies **binary / ladder / categorical** from the event shape (multi-leg + first leg's question has
  no numeric `$threshold` → categorical). `computeMarketRecord` routes categorical to a **friendly 422**
  ("This market uses categorical outcomes — numeric threshold or binary markets only") **before** any parsing,
  so the raw "Cannot parse threshold" error never reaches the UI (it surfaces in the search overlay via the
  add flow). Binary + ladder paths unaffected; frozen SpaceX parity intact. (NB: a `$`-valuation ladder like
  Anthropic still classifies 'ladder' and computes.)
- **Detail UI polish (4 items): MERGED** (`--no-ff` `6b893ec`; 137/137; presentation-only, backend untouched):
  (1) **Distribution axes** — CDF gets a Y probability scale (0/25/50/75/100% + hairline grid) + a rotated X
  threshold label at every rung; density gets rotated X bucket labels; the median marker has an explicit text
  label (`.dist-tick` token). (2) **Analytics always renders** — real cards (`—` per null field) OR an
  "Analytics pending — insufficient history" state; never silently absent. (3) **Refresh button** in the
  detail header → `refreshMarket` server action force-recomputes (bypasses TTL) + writes, then
  **`revalidatePath('/', 'page')` — DETAIL ONLY, not the layout** (rail not re-fetched). (4) **Timestamps →
  America/New_York** via `lib/format-detail.fmtEastern` (Intl `timeZoneName:'short'` → EST/EDT, DST-safe; the
  detail "As of" in both ladder+binary views). Display-only — DB / raw_inputs / raw_sha256 stay UTC.
- **⚠ Vercel posture UNCHANGED** — production stays erroring pre-standup (fails-closed 500). Expected.

## ⮕ DIRECTION (2026-06-22): Market-type work — Phase 1 (midpoint fallback) + Phase 2 (BINARY) MERGED
- **Phase 2 — BINARY (Yes/No) market support: MERGED to `main`** (`--no-ff` `a09610a`; no cron race).
  **135/135 on merged main; frozen SpaceX `raw_sha256` byte-identical** (ladder path untouched). Single Yes/No
  markets (gamma `event.markets.length === 1`) now compute alongside ladders.
  - **Detection:** `core/fetch.classifyMarketKind(slug)` — one gamma GET **before** any threshold parse (the
    parser throws on a binary question, so detection must precede it). `computeMarketRecord` branches to
    `computeBinaryRecord` → `core/binary.buildBinaryRecord` + `scoreBinaryConfidence` (spread/volume/fallback;
    no ladder math). `derived = { kind:'binary', probability, probability_no, confidence, total_volume,
    narrative, freshness }`.
  - **Provenance:** reuses `canonicalizeRawInputs` UNCHANGED (synthetic threshold 1=YES/0=NO sort key) — same
    hash recipe, binary content. Phase-1 midpoint fallback applies per token (resolver extracted to a shared
    `resolveFromBook`/`fetchLastTradePrice`).
  - **Schema:** single discriminated `schema.json` (`if kind:'binary' then …, else` the unchanged ladder
    `required` — SpaceX validates identically); `validate.js` skips `bucketErrors` for binary.
  - **UI:** `BinaryDetailView` (probability hero, trust band + hash-verify, **no SVG/ladder**); `MarketDetailView`
    branches on `kind`; rail shows the **probability %** headline (binary) vs **$median** (ladder), via a
    kind-aware `lib/market-scan` + `markets.kind`.
- **⚠ MIGRATION 0004 (the one schema change Phase 2 needed — my plan's "no migration" was WRONG):**
  `0004_phase2_binary.sql` widens `markets_kind_check` from `('threshold_ladder')` to
  `('threshold_ladder','binary')` (the binary probability reuses the **`implied_median` column** — that part
  needed no migration). **Applied to DEV.** The CHECK violation was caught in the Playwright gate (add error
  surfaced, not swallowed), fixed, re-run green. **PROD-STANDUP now requires `0001`+`0002`+`0003`+`0004`.**
- **⚠ Vercel posture UNCHANGED** — production still erroring pre-standup (fails-closed 500). Expected.
- **GATE-PROVEN:** node `scripts/verify-phase2-binary.mjs` (detection · binary compute · verify-ready hash ·
  ladder no-regression on live US-recession + WTI) + 135/135 + frozen-hash parity + tsc + build;
  **Playwright** (⌘K→search→add a real binary → rail **11%** headline → binary detail → **hash-verify ✓ VERIFIED
  in-browser** → SpaceX ladder full-distribution no-regression → 0 console errors).
- **⚠ Noted for a future parse-hardening pass (still NOT done):** the `$X` threshold parser collapses
  comma/repeated levels to duplicate thresholds (WTI monthly two rung-90). Computes fine; separate from binary.

## ⮕ DIRECTION (2026-06-22): Market-type work — Phase 1 (midpoint fallback) MERGED
- **Phase 1 — CLOB midpoint fallback: MERGED to `main`** (`--no-ff` `502933b`; no cron race). **133/133 on
  merged main.** A missing `/midpoints` value no longer fails the whole market — `core/fetch.js fetchLiveSnapshot`
  now resolves each rung via `clob_midpoint → bid_ask_mean → best_bid/best_ask → last_trade → skip → fail-all`.
  Measured truth: a missing midpoint = an EMPTY book (no bid/ask), only a last-trade price (deep ITM/OTM rungs).
  `raw_inputs` records `midpoint_source` (+ `last_trade_price`) — **NOT** in `canonicalizeRawInputs`, so the hash
  recipe is untouched and **frozen SpaceX `raw_sha256` is byte-identical** (`c1be52e4…b89003`, parity gate proves it).
  Confidence degrades via a `midpoint_fallback` signal ("N rung(s) priced from last trade…"). Silver+WTI weekly/
  monthly now compute (1/3/5 last-trade rungs, honestly low confidence). See [[gotchas]] + `core/confidence.js`.
- **⚠ Noted for a FUTURE parse-hardening pass (NOT done):** the `$X` threshold parser collapses comma-formatted
  or repeated levels to duplicate thresholds (WTI monthly had two rung-90; the 2c.3 detail key bug was the same
  family, fixed in `b08b1b1`). Computes fine; just coarser. Out of scope for the midpoint fix + binary work.
- **Next: Phase 2 — BINARY market support** (single Yes/No markets, not threshold ladders). Plan first.

## ⮕ DIRECTION (2026-06-22): Phase 2c.4 (search + add, Zone 3) — DONE & MERGED · 2c DASHBOARD COMPLETE
- **Where:** **MERGED to `main`** (`--no-ff` merge `b77e8a1`; main an ancestor of `feature/phase2c4-search-add`,
  no cron race). **132/132 on merged main.** `main` now reflects **2a+2b+2c.1+2c.2+2c.3+2c.4** — the **three-zone
  dashboard is functionally complete** (rail · detail · search/add/remove). Backend/auth/schema untouched (no migrations).
- **⚠ Vercel posture UNCHANGED** — production stays erroring **pre-standup** (fails-closed 500, Production env
  deliberately empty). Pushing 2c.4 does NOT change that; the auto-built prod deploy from `main` keeps failing — expected, don't touch.
- **What:** Zone 3 = the command-bar search + the load-bearing **compute-then-add** flow + remove-from-rail.
  - **Search:** `app/api/search/route.ts` proxies gamma `public-search` server-side (CORS-safe, normalized to
    `{slug,title,closed,active,volume}`). `MarketSearch.tsx` (client island in CommandBar): **⌘K** activate,
    debounced fetch, ↑/↓/Enter/Esc, click-outside, add-scope picker (Personal + RLS-scoped orgs).
  - **Compute-then-add** = **server actions** (`app/(app)/actions.ts`): `addMarket` runs `serveMarket` (service-role
    DEPS — the COMPUTE populates `markets`+`market_snapshots` via writeRecord), THEN `addPersonal`/`addOrg`
    (cookie-bound user client, RLS), THEN **`revalidatePath('/', 'layout')`** → the rail (layout Server Component)
    re-renders. Client auto-navigates `?m=<slug>` → detail opens. `MarketNotInCatalogError` surfaced (the FK guard,
    not the happy path); compute 404 → "not a supported threshold-ladder market" (e.g. a market with a non-`$X` leg).
  - **Remove:** `removeMarket` action + hover **×** on each rail row. `lib/market-scan` now carries `org_id` per row.
    **Dual-scope ×** drops PERSONAL — the row STAYS via org with only the ORG chip; a second × (org-only) removes it.
- **GATE-PROVEN:** node `scripts/verify-2c4-search-add.mjs` (search · **MarketNotInCatalogError guard** ·
  **compute side-effect: market_snapshots row exists after add** · add/list/remove) + no-regression (phase2a 12/12,
  rail, detail). **Playwright:** ⌘K → search → **live compute-then-add** of a real Bitcoin market (appears in rail
  post-revalidate + detail auto-opens — the live falsification, a genuinely new snapshot row) · add-error surfaced ·
  **dual-scope remove stays-via-org** · 0 console errors · 1280px screenshot. 132/132 + tsc + build clean.
- **⚠ Gotcha hit + fixed (`b08b1b1`, a latent 2c.3 bug):** the detail keyed distribution dots/density bars/ladder
  rows by `m.threshold`/`b.label` — unique for SpaceX but NOT for an arbitrary market (a Bitcoin price ladder parses
  two legs to the same threshold → two `>$56` rows → React "two children with the same key"). Fix: **index-safe keys**.
  Only 2c.4's search→add of an arbitrary market could expose it. (Same family as the 2c.3 SVG-hydration trap.)
- **Next (post-2c, deferred fast-follows):** the **signup / invite-acceptance form** (the dashboard is login-only);
  the **prod-standup checklist** (below) to take production live; optionally a **history endpoint** if the cut
  trends/Δ/movers sections are wanted back in the detail. The core 2c product is done.

## ⮕ DIRECTION (2026-06-22): Phase 2c.3 (market DETAIL, Zone 2) — DONE & MERGED to main
- **Where:** **MERGED to `main`** (`--no-ff` merge `251a853`; main an ancestor of `feature/phase2c3-detail`,
  no cron race). **132/132 on merged main.** `main` now reflects **2a+2b+2c.1+2c.2+2c.3**.
  Backend/auth/schema/rail **untouched** (the one edit to `app/api/market/route.ts` is the shared-DEPS
  extraction — behavior-identical, `verify-phase2a` 12/12 covers it).
- **⚠ Vercel posture UNCHANGED** — production stays erroring **pre-standup** (fails-closed 500, Production
  env deliberately empty). This push auto-builds a **failing prod deploy from `main`** — expected, don't chase/touch.
- **What:** Zone 2 detail = a PORT+GENERALIZE of `docs/index.html` into the React pane, fed by the rail's
  **`?m=<id>` selection** (read server-side in `app/(app)/page.tsx` via `searchParams`). It runs the
  **AUTHORITATIVE probed serve** for that one market — `serveMarket` called DIRECTLY with the **shared
  `lib/market-deps.mjs` DEPS** (same object `/api/market/route.ts` now imports — no drift, no HTTP hop). This
  is the CORRECTNESS layer (per-call resolution probe), the deliberate opposite of the rail's cached read.
- **Sections (from `record.snapshot.derived` + `record.asset`):** header (asset.name/resolves/market_url),
  TRUST band high (confidence tier+reasons, freshness, provenance sha256 + **in-browser hash-verify**),
  narrative, **distribution SVG** (hand-rolled CDF polyline + median marker + density bars — NO charting dep),
  Tier-1 analytics, current-snapshot ladder table, methodology. **RESOLVED** → prominent frozen-outcome banner
  (served cache-final, no live re-pull). Defensive optional-chaining → a thin record degrades, never throws.
- **⚠ UNIT-AWARE formatter** (`lib/format-detail.mjs`): derives T/B/M scale from the ladder labels so the
  headline reads in the market's own denomination (not hardcoded $T). Velocity delta still rendered verbatim.
- **⚠ HASH-VERIFY**: client `crypto.subtle` over the **server-canonicalized** `raw_inputs`
  (`core/fetch.js canonicalizeRawInputs` reused — can't import client-side, core untouched). Gate proved ✓ verified.
- **CUT (no source in `/api/market` — it carries no history):** trends chart, per-threshold Δ columns, movers.
  Tier-2 scenarios cut (locked scope). History is a future backend addition, not this phase.
- **GATE-PROVEN:** node `scripts/verify-2c3-detail.mjs` (RESOLVED served cache-final · field coverage ·
  verify-ready) + `verify-phase2a` 12/12 + `verify-2c2-rail` (no regression); **Playwright** (full render,
  field-match, **hash-verify → ✓ verified**, RESOLVED banner + `data-lifecycle="RESOLVED"`, SVG CDF+density+
  median marker, states: empty / bogus→error / thin→degrades, 0 console errors, 1280px screenshot);
  **132/132 `node --test`** (+7: 6 format-detail, 1 hash-verify parity) + tsc + build clean.
- **⚠ Gotcha hit + fixed (`b90184d`):** SVG `<text>`/`<title>` with adjacent dynamic+static children
  **mis-hydrate** ("Hydration failed") — consolidate each to a SINGLE template-literal child. (Caught in the
  Playwright gate, distinguished from stale-`.next` 404 noise.) Add to [[gotchas]] if not already.
- **Dev seed** (`scripts/seed-watchlist-dev.mjs`): synthetic OPEN markets are now **FULL records with a REAL
  `hashRawInputs` sha256**, so the in-browser verify passes on them too (not only SpaceX).
- **Next: 2c.4 (search + compute-then-add, Zone 3 in the command bar)** — gamma `public-search`, then
  compute-then-add (`/api/market?id=` populates `markets`, retry the watchlist add) **handling
  `MarketNotInCatalogError`**; also the deferred remove-from-rail wiring + signup form fast-follow.

## ⮕ DIRECTION (2026-06-22): Phase 2c.2 (watchlist RAIL, Zone 1) — DONE & MERGED to main
- **Where:** **MERGED to `main`** (`--no-ff` merge `fd4d1ed`; main was an ancestor of `feature/phase2c2-rail`,
  no cron race — local==origin/main at merge). **125/125 on merged main.** `main` now reflects **2a+2b+2c.1+2c.2**.
  Backend/auth/schema **untouched** (only added `lib/market-scan.mjs`, the two rail components, rail CSS, 2 scripts).
- **⚠ Vercel posture UNCHANGED** — production stays erroring **pre-standup** (the expected fails-closed 500;
  Production-scope env deliberately empty). Pushing 2c.2 to `main` does NOT change that; do not touch prod.
- **What:** Zone 1 rail = a Server Component (`components/zones/WatchlistRail.tsx`) that reads the
  **cache only** — `listVisible()` (RLS-scoped union) → `lib/market-scan.readScan()` for exactly those
  markets. **It runs NO resolution probe**: the rail is a SCAN SUMMARY on the COST layer; the
  authoritative probed serve stays in **Zone 2 / `/api/market`** for the selected market. Dense rows reuse
  existing tokens (`.conf-*`/`.is-*`/`.state-*`/`.is-stale`) — **no new design tokens**. Client freshness
  (live `now`, no hydration mismatch). Selection sets **`?m=<market_id>`** + marks `.wl-selected` — this is
  the handoff **2c.3 consumes server-side**. Suspense skeleton + real empty + caught error states.
- **⚠ KEY ARCHITECTURE DECISION (option b):** the scan fields are **already promoted to `market_latest`
  columns** (`implied_median`/`confidence_tier`/`lifecycle_state`/`is_final`/`stale_after`/`fetched_at`);
  the 24h delta lives in the record JSONB at `snapshot.derived.market.analytics.velocity.change_24h`. So the
  rail reads the cache — **no recompute, NO `/api/market` fan-out** (proven below). Rejected naive N×/api/market.
- **⚠ THE FIREWALL (load-bearing):** `readScan` uses the **service-role** key (RLS-bypassing) but takes
  **NO id list** — ids come ONLY from `listVisible()` and every query is bounded `.in('market_id', ids)`.
  A market the user can't see can't reach the rail even though service-role could read it. Lives in
  `lib/market-scan.mjs` (server-only, `cache.mjs` fence pattern); the heavy `record` is never shipped to the client.
- **GATE-PROVEN:** node gate `scripts/verify-2c2-rail.mjs` GREEN (FIREWALL cross-tenant exclusion · FIDELITY
  scan===market_latest, no drift, `median_display`===`fmtT` · DEDUP dual-scope→one merged row); **Playwright**
  GREEN (3 seeded rows + titles, confidence/lifecycle/delta pills, **STALE pill ONLY on the past-`stale_after`
  row**, ORG chip only on the org row, click→`?m=`+`.wl-selected`, **zero `/api/market` on rail load
  [architecture-falsification]**, 0 rail console errors, 1280px screenshot); **125/125 `node --test`** (6 new) +
  `tsc` clean + `next build` clean. **Empty state + no-regression re-runs (`verify-phase2a` 12/12 +
  `verify-2c1-authgate`) operator-verified separately.**
- **Seed for the rail demo:** `scripts/seed-watchlist-dev.mjs` (dev user: real SpaceX RESOLVED + synthetic
  `dev-rail-open-fresh` + `dev-rail-open-stale`; `.in`-bounded, idempotent). DEV-only fixtures.
- **Next: 2c.3 (market detail, Zone 2)** — reads the **`?m=` selection this phase wired** (server-side
  `searchParams`), fetches `/api/market?id=` (the authoritative probed serve), generalizes `docs/index.html`.

## ⮕ DIRECTION (2026-06-22): Phase 2c.1 (dashboard SHELL) — DONE & MERGED to main
- **Where:** **MERGED to `main`** (2026-06-22, `--no-ff` merge `fd97d8e`; main was an ancestor, no race).
  119/119 on merged main; frozen-hash parity GATE 1+2 reproduce (Option-A behavior-identical).
  `main` now reflects **2a + 2b + 2c.1**.
- **⚠ CODE-ON-MAIN ≠ LIVE-IN-PROD (now with a frontend).** Vercel posture is **unchanged** — previews build
  from branches, **production untouched**, prod Supabase still doesn't exist. Pointing prod Vercel at `main`
  is **blocked** on the prod-standup checklist (below) — it would build the Next app + `/api/market` against
  Production-scoped env that isn't set → middleware loud-check throws. The Option-A import-bundling is already
  in code, so *that* ENOENT mode is prod-safe; the env/Supabase prerequisites are not yet met.
- **PROD-STANDUP CHECKLIST — production goes live ONLY when ALL of these are done:** (1) prod Supabase
  project created w/ `0001`+`0002`+`0003` applied; (2) Before-User-Created hook **enabled** (created-but-
  not-enabled fails OPEN); (3) email-confirmation posture set (prod CONFIRMS, unlike dev); (4) Vercel
  Framework Preset = **Next.js** + `public` Output-Dir override cleared; (5) the **4 env vars**
  (`NEXT_PUBLIC_SUPABASE_URL`/`_ANON_KEY` + `SUPABASE_URL`/`_SERVICE_ROLE_KEY`) set in Vercel **Production**
  scope with **PROD values (NOT dev)**; (6) deployment-protection / app-auth posture decided; (7) re-run all
  gates against prod. Until ALL are done, production must NOT be treated as live.
- **✅ EXPECTED PRE-STANDUP STATE (NOT a bug — do not chase):** `polymarket-tracker-nu.vercel.app`
  (Vercel auto-built a **production** deploy from `main`) returns **500** — the middleware loud env-check
  (`NEXT_PUBLIC_SUPABASE_URL/ANON_KEY missing at runtime`). This is **correct: the gate fails CLOSED**
  because Production-scope env is deliberately **empty** (env vars are Preview-only; prod Supabase doesn't
  exist yet). **Every push to `main` will auto-build a failing production deploy until standup — this is
  fine and expected**, not something to investigate each time. Leave production erroring **as-is**; it
  becomes healthy only after the checklist above. (Confirms "code-on-main ≠ live-in-prod" empirically.)
- **What:** Next.js (App Router) on Vercel wrapping the proven backend — the SHELL only (no zones).
  Auth-gated routing (`@supabase/ssr`, **Node-runtime middleware**), institutional-terminal design tokens
  (IBM Plex Sans/Mono, `app/globals.css`), three empty zone shells (rail / detail / command-bar search).
  `/api/market` relocated to `app/api/market/route.ts` — behavior-identical (same serveMarket + no-store;
  **frozen SpaceX `raw_sha256` unchanged**). Login-only (signup/invite-acceptance = deferred fast-follow).
- **Service-role boundary:** `server-only` fence on `lib/supabase/server.ts`; key never `NEXT_PUBLIC_`;
  `lib/watchlist.mjs` is the lone client-safe lib (used by Client Components).
- **GATE-PROVEN:** local (build + auth negative/positive/logout + `verify-phase2a` 12/12 + 119 tests) AND
  **real Vercel preview build** (`verify-phase2a` 12/12, no ENOENT; `verify-2c1-authgate` unauth→/login).
- **⚠ TWO DURABLE LEARNINGS (now in [[gotchas]] — don't rediscover):**
  1. **Vercel's `@vercel/next` builder does NOT honor `outputFileTracingIncludes`** like `next build`/
     `output:standalone` do — files traced locally were missing from the deployed function (ENOENT).
     **Durable fix applied: bundle `core/` JSON via `import … with { type: 'json' }`** (+
     `core/markets/manifest.mjs` for the old `readdirSync`), so there's **no runtime file read**. Local
     trace/standalone is NOT a faithful proxy for Vercel packaging — bundle data, don't `readFileSync`.
  2. **Stale `.next` runs old middleware/build** — `next dev` ran stale **edge** middleware after a
     `next build` despite `runtime:'nodejs'`. `rm -rf .next` when switching build↔dev or changing
     runtime/config; confirm via `process.env.NEXT_RUNTIME`. (Same stale-artifact family as edge-replay.)
- **Vercel project config:** Framework Preset must be **Next.js** (the old static-site preset's `public`
  Output Directory override broke the build); `vercel.json` has `framework:nextjs` as a lock. Preview
  needs the 4 dev env vars in **Preview** scope. Wall still UP (Protection-Bypass-for-Automation for the
  verify scripts — they read `VERCEL_AUTOMATION_BYPASS_SECRET`, no-op when absent).
- **Next (2c.2 rail now DONE on branch): 2c.3** (market detail, generalizes docs/index.html) → 2c.4 (search +
  compute-then-add, where `MarketNotInCatalogError` is handled). Plus deferred: signup form, prod standup.
- **Backup:** `feature/phase2c1-shell` retained on origin (commit `b9003bc`) as an off-machine backup.

## ⮕ DEV ENVIRONMENT — fresh-context resume facts (2026-06-22)
> A new session needs these to run dev/gates; none are in the code. No secrets here (project ref + emails
> are not credentials; the 4 env-var VALUES live only in Vercel/.env.local, never in this repo).
- **Dev Supabase project:** ref **`dxoyxjxcfbgygvjvrrfk`** (`https://dxoyxjxcfbgygvjvrrfk.supabase.co`).
  All 3 migrations applied (`0001_phase2a` + `0002_phase2b` + `0003_phase2b_auth`); **Before-User-Created
  hook ENABLED**; **Confirm-email OFF** (dev only); **SpaceX seeded** (frozen RESOLVED, `raw_sha256`
  `c1be52e4…`) via `scripts/seed-spacex.mjs`.
- **Dev login (allowlisted):** **`ilanbenamaro@gmail.com`** — `admin` in org **"Dev Org"** (`allowed_emails`
  seeded). Account exists (signed up out-of-band; there is no UI signup form yet).
- **Vercel env:** the 4 vars (`NEXT_PUBLIC_SUPABASE_URL`/`_ANON_KEY` + `SUPABASE_URL`/`_SERVICE_ROLE_KEY`)
  are set in **Preview** scope with **dev values**. **Production scope is EMPTY** (deliberate → the prod 500).
- **Local:** `.env.local` (gitignored) **is NOT reliable across sessions** — don't assume it
  holds all 4 dev vars (a fresh machine had only `NEXT_PUBLIC_SUPABASE_URL`). The gate scripts
  read `process.env` directly, so the **4 dev vars must be present in the shell/env at run time**
  (export them or prefix the command). **Canonical source of the dev VALUES = Vercel Preview-scope
  env + the operator's own records, NOT a guaranteed-present `.env.local`.** Signup-fixture domain:
  `TEST_EMAIL_DOMAIN=polymarket-tracker-dev.com` (Supabase rejects `example.com`/`.test` at validation).
- **Gates all green on dev:** `verify-phase2a` 12/12, `verify-phase2b-{isolation,auth,watchlist}`,
  `verify-2c1-authgate`. Run them with the dev creds in env (+ `VERCEL_AUTOMATION_BYPASS_SECRET` if hitting
  a protected preview).

## ⮕ 2c SCOPE (locked) — dashboard; what's CUT / DEFERRED / ABANDONED
- **Product:** the 2c dashboard — **Bloomberg-dense, institutional-terminal** aesthetic (density via
  hierarchy + color-as-meaning, not clutter; IBM Plex Sans/Mono; tokens in `app/globals.css`). Quant audience.
- **Three zones:** Zone 1 watchlist rail · Zone 2 market detail · Zone 3 search+add (in the command bar).
- **Build order:** 2c.1 shell **DONE** → **2c.2 rail DONE** (`lib/watchlist.listVisible` + `lib/market-scan`,
  on branch, not merged) → **2c.3 detail (NEXT)** (generalizes `docs/index.html` via `/api/market`) →
  **2c.4 search+add** (gamma `public-search` + compute-then-add, handling `MarketNotInCatalogError`).
- **CUT entirely (do NOT build):** related-markets / "market relates to other aspects" analysis; **scenario
  analysis (Tier-2)**; anything **trading / positions / P&L**.
- **DEFERRED to 2d:** email / notifications.
- **ABANDONED:** the **news area** — `docs/ARCHITECTURE.md §8` designed a firewall to "build later"; that is
  now **dropped**, not merely deferred. (ARCHITECTURE.md §8 is superseded on this point.)
- **Deferred fast-follow:** the signup / invite-acceptance form (2c.1 is **login-only**).

## ⮕ DIRECTION (2026-06-20): Phase 2b (accounts + watchlists) — COMPLETE (2b.1+2b.2+2b.3), GATE-PROVEN on dev
- **Where:** **MERGED to `main`** — 2b.1+2b.2 via `--no-ff` `d9f1e3e`, **2b.3 via `--no-ff` `3fd4761`**
  (2a was already in main). 119/119 tests green on merged main.
- **2b.3 DONE — watchlist CRUD:** `lib/watchlist.mjs` (CLIENT-SAFE: client-direct, user-session,
  `authenticated` role, **no service-role**) — `addPersonal`/`removePersonal`, `addOrg`/`removeOrg`
  (added_by=self), `listVisible` (the `my_visible_watchlist` union). Idempotent adds; access control is
  the 2b.1 RLS firewall, surfaced as typed errors (`MarketNotInCatalogError` 23503, `NotPermittedError`
  42501) — no app-side permission checks, no schema change. Proven by `scripts/verify-phase2b-watchlist.mjs`
  (GREEN on dev); isolation gate re-run GREEN. ⚠ **`market_id` must already exist in `markets`** (FK) →
  `addPersonal/addOrg` throw `MarketNotInCatalogError`; **compute-then-add is 2c's job** (GET `/api/market?id=`
  populates `markets`, then retry). **The full accounts+watchlist BACKEND is now complete & gate-proven.**
- **⚠ CODE-ON-MAIN ≠ LIVE-IN-PROD.** `main` now carries `0002`/`0003`, but those migrations are applied
  **only on the DEV Supabase**. Production is **NOT ready**: do **not** point production Vercel at this
  stack until a **PROD Supabase exists with `0001`+`0002`+`0003` applied**, the **Before-User-Created hook
  ENABLED** (created-but-not-enabled fails OPEN — the negative gate is the proof), and a real
  **email-confirmation posture** set. Vercel production posture is **unchanged** (still the open
  deployment-protection / prod-vs-preview 2b-backlog decision). The Vercel **preview** still builds the
  branch.
- **Design (approved + built):** invite-only accounts. `organizations` + `profiles` (1:1 `auth.users`) +
  `org_membership` (M:N) + `allowed_emails` (operator allowlist) + **two** watchlist tables —
  `personal_watchlist` (private) and `org_watchlist` (shared, **any-member** curate with `added_by`) —
  plus a `security_invoker` union view `my_visible_watchlist` (= personal ∪ org). Watchlist FK →
  `markets.id` (the 2a table). Watchlist CRUD is **client-direct** via supabase-js (RLS is the guard);
  **`/api/market` stays public + `no-store` + untouched** (don't entangle the verified-data path w/ auth).
- **2b.1 SHIPPED (schema + RLS):** `0002_phase2b.sql` (+ `_down`; additive, touches no 2a table). RLS on
  every new table; `SECURITY DEFINER` helpers `is_org_member`/`shares_org` avoid policy recursion;
  membership/allowlist are client-deny (operator/trigger only). **`verify-phase2b-isolation.mjs` GREEN
  through real JWTs:** cross-tenant read/insert/delete denied (42501; no phantom row; targets survive),
  union view scoped, B-symmetry. **This gate is the RLS regression proof — re-run after ANY auth change.**
- **2b.2 SHIPPED (invite-only signup gate + provisioning):** `0003_phase2b_auth.sql` (+ `_down`).
  `hook_restrict_signup_to_allowlist` = the **"Before User Created" Auth Hook** (current Supabase
  mechanism, verified vs live docs — NOT the legacy `auth.users` trigger), **DENY BY DEFAULT** (allow
  only on explicit `allowed_emails` match; null/empty/malformed rejected). `handle_new_user`
  (after-insert) provisions `profiles` + `org_membership` from the allowlist row + stamps `consumed_at`;
  idempotent. Both functions `SECURITY DEFINER set search_path=''`. **`verify-phase2b-auth.mjs` GREEN:**
  NEGATIVE — valid-format but UNLISTED email rejected by OUR hook (403/"invite-only", NOT email-format
  validation), no `auth.users` row → invite-only **fails CLOSED**; POSITIVE — allowlisted email →
  account + profiles + `org_membership`(correct org+role) + `consumed_at` + login. Isolation re-run GREEN.
- **⚠ DEV-ONLY CONFIG used to make the gates run (does NOT apply to prod):** the hook is **enabled** in the
  dev project's Auth settings, and **"Confirm email" is OFF** on dev (so test `signUp` sends no mail).
  Test fixtures use `TEST_EMAIL_DOMAIN=polymarket-tracker-dev.com` (Supabase rejects reserved/no-MX
  domains like `example.com`/`.test` at email-deliverability validation, which runs **after** the hook).
- **⚠ PROD STANDUP CHECKLIST when a prod project is created:** (1) apply `0001`+`0002`+`0003`; (2)
  **manually ENABLE the Before-User-Created hook** (a created-but-not-enabled hook **fails OPEN** silently
  — the negative gate is the proof it's on); (3) set a real **email-confirmation posture** (prod should
  CONFIRM emails, unlike dev); (4) decide the **deployment-protection posture** (Vercel wall OFF for
  testing → gate prod via our own auth, per the 2a backlog item); (5) re-run both gates against prod.
- **Email validation ⟂ access control:** the allowlist hook runs BEFORE email-deliverability validation
  and is the ONLY access gate; the dev email-validation/confirmation relaxations change nothing about who
  can get in, and don't affect what the negative gate proved.
- **Deferred (do NOT scaffold):** dashboard UI (2c), notifications/email (2d), news, "market relates to
  other aspects" analysis (pending a concrete fund definition).

## ⮕ DIRECTION (2026-06-18): multi-market hosted product — Phase 2a DONE & LIVE-VERIFIED
- **Phase 2a (backend foundation) — SHIPPED on Vercel + Supabase.** A Vercel serverless function
  (`api/market.mjs`) serves ONE verified market on demand, backed by a Supabase cache. The verified
  pipeline runs on the backend (`lib/compute.mjs` → `core/`); the client never fetches Polymarket /
  bypasses `core/`; the cache only ever stores a `core/`-validated record (`lib/cache.mjs` `writeRecord`
  is the sole write path) and stores the frozen hash, never recomputes it. Cache×resolution precedence
  in `lib/decide-cache-action.mjs` (RESOLVED served forever; within-TTL OPEN is gamma-probed before
  serving so a since-resolved market is never served stale; TTL=15min). Auth/watchlists/notifications/
  news = **deferred** (2b/2c); schema is FK-ready. Also shipped: **R1** (CI failure → GitHub issue) +
  **R2** (fail-loud if a builder gets no MarketConfig).
- **LIVE-VERIFIED 2026-06-18: `scripts/verify-phase2a.mjs` 12/12 green against the deployed stack** —
  C1 OPEN market returns a re-hash-verified record; C2 repeat call is a TRUE Supabase cache hit
  (`cached:true`, function runs + reads cache, no Polymarket re-fetch); C3 SpaceX served frozen RESOLVED
  from the seed; C4 cache×resolution trap holds (a since-resolved market is never served stale-live).
  Supabase schema applied (`markets` + `market_snapshots`, RLS locked, `market_latest` view
  `security_invoker=on`); SpaceX seeded via `scripts/seed-spacex.mjs`.
- **⚠ LOAD-BEARING: `/api/market` sets `Cache-Control: no-store` — DO NOT add HTTP/edge caching.** The
  per-call resolution probe is the correctness layer; an edge-cached response (`x-vercel-cache: HIT`)
  skips the function and could replay a since-resolved market as OPEN (the C4 gap). Supabase is the cost
  layer. See [[gotchas]] "Vercel edge-caches …" and [[decisions]] "/api/market is never HTTP-cached".
- **Proven locally: 119 tests** (decision logic + orchestration incl. the cached-then-resolved trap);
  parity gate still green (SpaceX byte-identical).
- **Next: Phase 2b** — Supabase Auth + watchlists (FK-ready schema; no table rewrite needed).
  Plan fresh next session. Backlog to fold in:
  - [ ] **Deployment-protection posture** — Vercel deployment protection is currently **OFF** (was
    turned off for 2a live testing). Production access should be gated by **our own Supabase auth**
    (2b), **not Vercel's wall** — decide/lock this when 2b auth lands, and don't leave the preview
    open indefinitely. (Resolution correctness is already enforced server-side; this is access control.)
  - [ ] **Document the 0.5% `MATERIAL_ADJUSTMENT` threshold** (`core/confidence.js`) in
    `core/methodology.json` — an isotonic tweak below 0.5% is treated as immaterial and keeps the
    confidence tier high; that rule should be written into the methodology, not only the code.

## ⮕ DIRECTION (2026-06-17): multi-market hosted product — Phase 1 SHIPPED
- **Pivot:** generalizing from the single SpaceX market into a **hosted multi-market** product on
  **Vercel + Supabase** (Polymarket unchanged). Design: `docs/ARCHITECTURE.md` (read before rebuild
  work). Governing principle: the verified pipeline runs on the backend, on demand + cached. See
  [[decisions]] "PIVOT".
- **Phase 1 DONE (core/ generalization + resolution guard, no infra):** `core/` now processes ANY
  threshold-ladder event via a per-market **MarketConfig** (`core/markets/*.json` + `core/market-config.js`
  `defaultConfigForLadder`) — no `if spacex` anywhere. SpaceX is one pinned instance whose output is
  **byte-identical** to pre-generalization (blocking gate `test/phase1-spacex-parity.test.js`: frozen
  `raw_sha256` `c1be52e4…b89003` + full derived deep-equal + 183-day history). Proven on a 2nd real
  ladder (Kraken IPO $16–28B) via the generic defaults. Two-stage lifecycle (`core/lifecycle.js` +
  `snapshot.lifecycle`: OPEN / CLOSED_PENDING / RESOLVED) classified from gamma meta; Tier-2 scenarios
  optional. methodology **1.4.0**, schema **1.3.0**. 99/99 tests.
- **⚠ SpaceX RESOLVED (2026-06-17):** the market settled — realized cap in **$2.0–2.2T** (>$2T Yes,
  >$2.2T No), matching the last live median ~$2.1T. The feed is **frozen** (lifecycle RESOLVED,
  `freshness.final`, no live pull; re-runs skip). This also fixed a live breakage: the OLD v1 cron was
  crashing every run with "No midpoint" because a resolved market returns no CLOB midpoints (see [[gotchas]]).
- **Next:** Phase 2 (serverless compute + Supabase cache) per ARCHITECTURE §9. The v1 GitHub-Actions/
  Pages app below now serves the frozen resolved SpaceX record.

## Current state
- **Live:** https://ilanbenamaro-cyber.github.io/polymarket-tracker/
- Methodology **1.3.0**, schema **1.2.1**, assumptions **1.0.0** — all three embedded in every snapshot.
  (1.3.0 = 2h cadence + schedule-derived 17h staleness threshold + post-publish verify gate;
  policy change, NO formula change. 1.2.1 = source-of-record + verifier + freshness.)
- **Cadence (2026-06-12):** snapshots every 2h, 12:00–00:00 UTC (overnight pause 00→12 UTC = max
  12h gap → threshold 12+2+3 = **17h**, derived in `core/freshness.js` SCHEDULE; coupling test binds
  it to the update.yml cron). Dashboard auto-refreshes (10 min + visibilitychange, silent failures).
- Branch `feature/cadence-audit` carries the 2026-06-12 audit pass (8-seam directed audit:
  4 P1 fixes each with regression tests + cadence migration + verify gate). Repo: `ilanbenamaro-cyber/polymarket-tracker`.

## What this is (3 sentences)
An institutional prediction-market data product: it turns Polymarket's "SpaceX IPO closing
market cap above $X?" markets into a trustworthy valuation signal. It serves a canonical JSON
API (`docs/api/v1/`), a dashboard, and a printable research note, all projecting from one
core record. **Public Polymarket data only** — no grey-market/secondary data (that's v2, out of scope).

## How to run
- `node scripts/snapshot.js` — main entry (the cron runs this): fetch → build canonical record
  (isotonic-adjusted, analytics, scenarios, narrative) → validate (schema+invariants+firewall) →
  write API → append today to history → bake HTML fallback.
- `node scripts/backfill.js` — one-time/idempotent: rebuild full history from Polymarket price-history.
- `node scripts/verify-accuracy.js` — independent accuracy harness: dual-source fetch (Gamma + CLOB) ×2,
  cross-source + drift + published-vs-live reconciliation; report-only. Canonical green path: run
  snapshot then verify while seconds-old → PASS (exit 0). Flags: `--strict --json --price-window-hours --staleness-hours`.
- `node --test` — unit tests (currently **80/80**: PAVA, band, anomalies, hash, firewall (incl.
  numeric-0 leaves), rounding, analytics, freshness + schedule coupling, accuracy-verifier zones,
  dashboard contract (velDelta/auto-refresh), email digest inputs, full-history invariant sweep).
- Output lands in **`docs/api/v1/`** (`latest.json`, `history.json` lean, `history-full.json`,
  `history.csv`, `methodology.json`, `schema.json`, `snapshots/YYYY-MM-DD.json`).
- Local preview: `cd docs && python3 -m http.server 8000` (the page `fetch`es the API, so use HTTP not file://).

## VERIFIED
- Local pipeline: snapshot + backfill run clean; 176-day history; 0 negative buckets across all days.
- Dashboard + 3-page note render with **0 console errors** (favicon present); verify-hash MATCH/MISMATCH works.
- Firewall enforced: validate.js throws on a stripped/unsourced scenario assumption and on a Tier-1 leak.
- Live API serves 1.2.1 with CORS `*`; schema validates (incl. additive `derived.freshness`).
- **Accuracy verifier** run live: canonical path (snapshot→verify seconds-old) = PASS; price-match FAIL
  and aged-drift OK paths both confirmed; cross-source (Gamma vs CLOB) agrees live; source curve valid.
- **Freshness** verified via Playwright: fresh state shows "as-of age" muted + badge hidden; stale state
  shows red age + STALE pill; 0 console errors.
- node --test 43/43.
- **CI pipeline proven END-TO-END** ✅ — `workflow_dispatch` (mode snapshot) ran green
  (run 27154304762): npm ci on ubuntu, snapshot, schema validation, and the bot commit/push all
  succeeded. The new **concurrency-safe push** path worked (snapshot commit `01d505b` landed on
  `origin/main` via fetch→rebase→push). Was UNVERIFIED #1 — now done.

## UNVERIFIED (do these — top item FIRST)
1. **First overnight pause under the 2h cadence** — after merge, confirm the 12:00 UTC run lands and
   the dashboard never showed STALE overnight (the 12h-gap-not-stale policy, validated in production).
2. Email/push path (`send-emails.js`) is dormant and unrun in CI (intended; guarded to skip without
   secrets). Now reads `docs/api/v1/` — the deleted-data.json time bomb is fixed but the live send
   path is still unexercised.

## Recently shipped (2026-06-12 audit pass, branch feature/cadence-audit)
- [x] **8-seam directed audit** — severity-ranked ledger; 4 P1s fixed each with a regression test:
  firewall numeric-0 leaf bypass (validate.js null-checks), impliedSharePrice Infinity on zero range
  bound, velDelta D1 re-derivation (3rd occurrence — now renders stored display), send-emails read
  the deleted docs/data.json (now reads v1 API, ascending-history prior). See [[decisions]], ledger
  in the session report.
- [x] **2h cadence + schedule-derived 17h staleness threshold** (was 50h literal) + coupling test +
  methodology **1.3.0**. See [[decisions]].
- [x] **CI verify gate, publish-then-alert** (non-strict, last step, transport-aware retry) — closes
  the old "wire --strict gate" task with deliberately different semantics. See [[decisions]].
- [x] **Dashboard auto-refresh** (10 min + visibilitychange; silent failures keep the view) +
  **mobile table scroll** (375px verified, was overflowing).
- [x] **Full-history invariant sweep test** (181 days through production validators) + CSV constraint.

## Immediate open tasks
- [ ] **Document the 0.5% confidence threshold** (`MATERIAL_ADJUSTMENT` in `core/confidence.js`) in
  `core/methodology.json` — an isotonic tweak below 0.5% is treated as immaterial and keeps tier high;
  that rule should be written down in the methodology, not just the code.
- [ ] **P2 backlog from the audit** (documented, deliberately deferred): scenarios.js pct Math.round
  asymmetric on negatives vs roundT (changing alters published Tier-2 values — needs its own
  methodology note); inline money() can render $-0.00T (unreachable today); quantileValuation
  CDF-touches-0.50-at-last-node returns null (definitional).

## Pointers
- Why things are the way they are → `.workflows/_knowledge/decisions.md`
- Traps already hit → `.workflows/_knowledge/gotchas.md`
- Human methodology → `METHODOLOGY.md`; API contract → `API.md`; schema → `docs/api/v1/schema.json`
- Latest task plan → `~/.claude/plans/azure-if-not-already-prancy-lemur.md` (overwritten per task; holds 1.2.0 only)
