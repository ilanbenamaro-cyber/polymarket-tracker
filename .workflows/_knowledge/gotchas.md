# Gotchas — traps that already bit us

Concrete failure modes hit during development. Check here before diagnosing a
"weird" symptom. Newest at top.

---

## A missing CLOB midpoint means an EMPTY book (not a one-sided book) — fall back to last_trade
**Symptom:** `core/fetch.js` threw `No midpoint for token X` and failed the WHOLE market
when ANY single rung lacked a midpoint — breaking live, active commodity ladders (Silver
XAGUSD, WTI) that have one or more illiquid rungs.
**Reality (measured against live CLOB):** when `/midpoints` omits a token, the orderbook is
**empty** — `/prices` returns NO best_bid AND NO best_ask, `/midpoint` → "No orderbook
exists", `/book` is empty. The intuitive fallback `(bid+ask)/2` almost never applies (there's
no bid/ask). Across WTI+Silver weekly+WTI monthly, **all 9 no-midpoint rungs had only a
`last-trade-price`** (deep ITM/OTM near-settled rungs, e.g. >$75 WTI pinned at 0.999). So the
fix's load-bearing tier is **`last_trade_price`**, not bid/ask. Priority: `clob_midpoint` →
`bid_ask_mean` → single side → **`last_trade`** → skip the rung → fail only if ALL rungs are
dead. Skipping a *middle* rung punches a hole in the CDF, so `last_trade` (keeps the rung) is
tried before skip.
**Provenance tradeoff (deliberate):** `raw_inputs` records `midpoint_source` (+ `last_trade_price`
when used) so an auditor sees exactly how each midpoint was derived — but these fields are
**NOT** in `canonicalizeRawInputs`, so the **hash recipe is untouched** and the **frozen SpaceX
`raw_sha256` stays byte-identical** (`c1be52e4…b89003`; SpaceX is cache-final and never
recomputed, and all its rungs are real midpoints → no fallback branch runs). Consequence: the
resolved midpoint **value** is tamper-evident (it IS hashed), but the **source label** is
metadata (not hashed). Accepted to keep the recipe stable. Confidence degrades honestly:
"N rung(s) priced from last trade (no live book)" / "M rung(s) excluded (no price)".
**Lesson:** don't assume a missing midpoint leaves a usable book — it usually doesn't. When
adding provenance fields to `raw_inputs`, keep them OUT of the canonicalizer or you silently
break every stored hash. Verify the frozen parity gate after ANY `core/fetch.js` change.

---

## SVG `<text>`/`<title>` with adjacent dynamic+static children mis-hydrates — use ONE string child
**Symptom:** the 2c.3 detail page threw React **"Hydration failed because the server rendered HTML didn't
match the client"**, the tree bottoming out at a distribution-SVG `<title>` (`+ {"<$1"}`). It rendered fine
visually (React regenerates the subtree client-side) but logged a console error every load. Easy to misread
as the **stale-`.next`/stale-tab** noise that appears alongside it (versioned `_next/static/*.js?v=…` 404s) —
those vanish on a clean reload; the hydration error did NOT, so it was real.
**Reality:** SVG `<text>`/`<title>` with MULTIPLE adjacent children mixing expressions and literals
(`{g}%`, `median ${m}{unit}`, `{label}{unit} · {pct}%`) serialize with text-segment markers that the browser's
SVG text-node parsing normalizes differently than React's client render → node-count mismatch → hydration
fails. The values were fully deterministic (no Date/random) — the structure, not the data, was the bug.
**Lesson:** inside SVG `<text>`/`<title>` (and the same family: `<option>`, `<textarea>`), make the content a
**single string child** — one template literal: `{`median $${m}${unit}`}` not `median ${m}{unit}`. To triage a
hydration error: clean-reload first to clear stale-asset 404 noise; if it persists, read the tree path React
prints — it names the exact offending node. (Caught by the Playwright console check, not the build — `next
build`/tsc are both clean with this latent bug. Same stale-artifact-vs-real-bug discrimination as the edge/
.next family above.)

## Vercel's @vercel/next builder does NOT honor `outputFileTracingIncludes` — bundle data, don't readFileSync
**Symptom:** a Next route handler (`app/api/market/route.ts`) ran `core/` which `readFileSync`'d
`core/methodology.json` at runtime. `next.config` had `outputFileTracingIncludes: { '/api/market':
['./core/**', …] }`. Locally everything looked right — the route's `.nft.json` listed the files AND
`output:'standalone'` copied them into the deployable output. But the **deployed Vercel function 500'd**
with `ENOENT … /vercel/path0/core/methodology.json`. Two next.config attempts (key, then
`outputFileTracingRoot` pin) both failed on deploy while passing locally.
**Reality:** Vercel's `@vercel/next` builder packages functions differently from `next build` /
`output:standalone` — it does **not** reliably bundle the extra files declared in
`outputFileTracingIncludes`. So a local trace/standalone check is **NOT** a faithful proxy for what
Vercel deploys. (The 2a raw-function `vercel.json functions.includeFiles` worked, but that mechanism
does not carry over to Next-managed route handlers.)
**Lesson (durable fix):** for serverless route handlers, **don't `readFileSync` at runtime — `import`
the data so the bundler inlines it into the JS** (`import x from './x.json' with { type: 'json' }`).
Dynamic `readdirSync` over a dir → a static manifest module that imports each file
(`core/markets/manifest.mjs`). Then there is no file read → no trace dependency → no ENOENT, on any
platform. Confirm locally by grepping the built `.next/server/app/**/route.js` for the inlined data and
that **no `readFileSync`** of it remains (the `.nft.json` may still *list* the source file — harmless,
since nothing opens it). Preserve fresh-object-per-call semantics with `structuredClone` (verify the
frozen parity hash is unchanged — it was). See [[decisions]] Phase 2c.

## Stale `.next` runs old middleware/build — `rm -rf .next` when switching build↔dev or changing runtime
**Symptom:** added `export const config = { runtime: 'nodejs' }` to `middleware.ts`; `next build`
produced a correct Node middleware bundle, but `next dev` still ran it on **edge-server** (env undefined,
500). Earlier in the same saga, env/runtime fixes "didn't take" until `.next` was cleared. Cost several
round-trips chasing config when the code was already right.
**Reality:** `next dev` compiles middleware lazily and **reuses a stale `.next`**; interleaving
`next build` and `next dev` in the same `.next` leaves mixed/stale artifacts (stale edge middleware,
stale env inlining). The config was correct the whole time.
**Lesson:** after changing middleware **runtime**/config, env wiring, or `next.config`, **`rm -rf .next`
then restart** — don't trust a warm `.next`. Confirm the middleware runtime with a temp
`console.log(process.env.NEXT_RUNTIME)` (expect `nodejs`) **before** running gates, rather than
discovering via a 500. This is the **same stale-artifact family** as the Vercel-edge-replay, the
http.server browser cache, and the deploy-timing traps — when a config change "doesn't take," suspect a
stale build cache before the config.

## Vercel edge-caches `public, max-age` responses and replays them — the function never runs
**Symptom:** Phase 2a live verify C2 failed: a 2nd `/api/market` call within TTL returned
`cached:false` on a market that was genuinely OPEN — but with the SAME `fetched_at` as call #1 and
NO new snapshot row. By elimination from the committed code, NO serve path can emit
`OPEN + cached:false + same-fetched_at + no-new-row` — the function did **not run** on call #2.
**Reality:** `api/market.mjs` set `Cache-Control: public, max-age=30` on 200s. **Vercel's Edge Network
caches a `public, max-age` response and replays it** (confirmed by `x-vercel-cache: HIT` on call #2,
`MISS` on call #1). Call #1 was a miss → ran the function → returned `cached:false` → the edge cached
THAT response for 30s → every repeat within the window got the replayed body, function skipped. The
Supabase cache, serve path, and `cached` flag were all CORRECT — only the CDN layer lied.
**The real danger isn't the flag — it's resolution correctness:** edge-replaying a response **bypasses
the per-call resolution probe** (`decideBeforeProbe → PROBE → probeLifecycle`), so a market that
resolved after caching could be served as **OPEN** for the whole cache window — the exact stale-live
gap C4 exists to prevent. Unacceptable for a fund-facing feed even at 30s.
**Lesson:** `/api/market` must **NOT** be HTTP-cached — set `Cache-Control: no-store`. The Supabase
cache (server-side, consulted on every real invocation) is the cost layer; the per-call probe is the
correctness layer; HTTP caching skips both. When a REPEAT call behaves suspiciously, **check
`x-vercel-cache`** before suspecting your logic. **Third instance** of caching-masquerading-as-logic-bug
(see "Playwright verified a STALE page" and "Deploy timing masquerades as a data bug").

## A Postgres VIEW bypasses table RLS unless security_invoker=on (Supabase "Unrestricted")
**Symptom:** `markets`/`market_snapshots` show RLS-locked, but Supabase flags the `market_latest`
VIEW as "Unrestricted" — and `anon` can read every underlying row through it via PostgREST.
**Reality:** A view runs with its OWNER's privileges by default (security-definer style). Created in the
SQL editor → owned by `postgres`, which owns the base tables, and **RLS is not enforced for a table's
owner** → the view sees all rows. Combined with Supabase's default `anon` SELECT grant on new `public`
objects, anon reads the whole table through the view. RLS on the base table only protects DIRECT
access by non-owner roles (anon), not access via an owner-run view.
**Lesson:** Add `with (security_invoker = on)` to every view over an RLS table (PG 15+) so it runs as
the QUERYING role and inherits the table's RLS. Then anon→0 rows, service-role→all rows, and a later
public-SELECT policy flows through automatically. Fix in the migration; patch a live view with
`alter view public.<v> set (security_invoker = on);`. (Fallback on PG<15: revoke anon/authenticated
SELECT on the view.)

## Vercel functions need core/ JSON files bundled (readFileSync at runtime)
**Symptom (anticipated):** a deployed `api/market.mjs` could 500 with ENOENT — `core/validate.js`
(`docs/api/v1/schema.json`) and `core/market-config.js` (`core/markets/*.json`,
`core/methodology.json`, `core/assumptions.json`) read those files via `readFileSync` at runtime, and
Vercel's bundler won't trace a dynamic `readdirSync`/templated path.
**Fix:** `vercel.json` `functions["api/market.mjs"].includeFiles = "{core/**,docs/api/v1/schema.json}"`
bundles them. If you add a function that imports `core/`, add the same includeFiles. Confirm on the
first deploy (call the function; an ENOENT means the glob missed a file). `pinnedConfigFor` wraps its
`readdirSync` in try/catch → falls back to the generic default rather than crashing.

## A RESOLVED Polymarket market returns NO CLOB midpoints — classify before fetching prices
**Symptom:** `scripts/snapshot.js` crashed live with `No midpoint for token …`; the old v1 cron had
been failing on every run. (2026-06-17, when SpaceX actually resolved.)
**Reality:** Once a market resolves, trading ends and `POST /midpoints` returns `{}` — `fetch.js`
threw on the first missing midpoint. Gamma still serves the event with `closed:true` +
`umaResolutionStatus:"resolved"` + settled `outcomePrices` (["1","0"]/["0","1"]); only CLOB is empty.
Note `active` stays `true` and `endDate` can be far-future even after resolution — they are NOT
resolution signals.
**Lesson:** Classify lifecycle from **gamma meta BEFORE any CLOB call** (`fetchEventStatus` →
`classifyLifecycle`); if the market is not OPEN, **freeze** the prior record instead of price-fetching
it. Use `closed` + `umaResolutionStatus` (not `active`/`endDate`). The realized outcome is the rung
where `outcomePrices` settled to "1" (SpaceX: >$2T Yes, >$2.2T No → cap in $2.0–2.2T). See
[[decisions]] two-stage resolution.

## Playwright "verified" a STALE page — browsers heuristically cache python http.server
**Symptom:** Edited `docs/index.html`, navigated to it via Playwright, ran a behavior test — and the
NEW code wasn't there (`load.toString()` showed the pre-edit function). The failure-semantics test
"failed" against code that didn't contain the fix. Cost real time (2026-06-12).
**Reality:** `python3 -m http.server` sends no cache headers, so the browser applies HEURISTIC
caching and can serve the previously-loaded page on re-navigation. The disk file was correct the
whole time.
**Lesson:** After editing a served file, verify on a FRESH port (or with a cache-busting query) and
*assert the code under test is actually present* (`/silent && LATEST/.test(load.toString())`) before
trusting any behavioral result. Source-level node tests (test/dashboard-contract.test.js) don't have
this problem — trust them over a possibly-cached browser when they disagree.

## "Re-run jobs" replays the workflow at the ORIGINAL commit — not your YAML fix
**Symptom:** Fixed a bug in `.github/workflows/update.yml`, pushed it, then clicked GitHub's
**"Re-run jobs" / "Re-run failed jobs"** on the failed run — and it failed the **same way**, as if the
fix never landed. (Cost real time today.)
**Reality:** Re-running a run replays the workflow **at the exact commit SHA the original run used**, with
the original workflow file and event payload. A workflow YAML change pushed afterward is **not** picked
up by re-running — re-run is "retry this historical run", not "run latest".
**Lesson:** After editing a workflow file, trigger a **fresh** run, never "Re-run jobs":
`gh workflow run update.yml -f mode=snapshot` (or the **Run workflow** button on the Actions tab). The
fresh dispatch checks out the latest `main` and uses the updated YAML. Verify the run's commit SHA is
your fix, not the old one.

## Verifier: price-match window ≠ liveness window (two different horizons)
**Symptom:** `scripts/verify-accuracy.js` returned **FAIL** on a correct, recently-published snapshot
because one thin mid-tail threshold (`$2.6T`) had drifted ~5pt since publish.
**Reality:** The first cut used **one** 26h window and asserted the published raw_prob should match the
live CLOB midpoint within ±2pt for anything <26h old. But markets move several points intraday — a 2pt
match is only meaningful while a snapshot is **minutes-to-a-few-hours** old. The fix splits two
distinct horizons: **price-match** (≤ ~3h, `PRICE_MATCH_WINDOW_H` — strict ±2pt is a hard PASS/FAIL)
vs **liveness/stale** (> `STALENESS_WINDOW_H`, shared with the dashboard via `core/freshness.js`;
50h under the old daily cadence, **17h** since the 2026-06-12 2h-cadence migration — derived from
the schedule, see [[decisions]]).
Between them ("aged") deltas are reported **descriptively as expected market drift, never a FAIL**.
**Lesson:** Don't conflate "is the price still accurate?" (hours) with "is the pipeline alive?" (days).
And **never widen the ±2pt tolerance** to make aged data pass — that blinds the check to real source
errors; bound *when* the strict check applies instead. Canonical green path: **snapshot, then verify
while seconds-old** → tight match → exit 0 (the CI pattern). See [[decisions]] freshness policy.

## memory.sh prints a stale hardcoded "ASTROPHYSICS APPLET" briefing
**Symptom:** At session start, `bash ~/.claude/memory.sh` printed a project-status block for a
DIFFERENT project — "ASTROPHYSICS APPLET", `vlbi-react/`, "Prof. Cardenas-Avendano", an angular-size
meeting — none of which exist in polymarket-tracker.
**Reality:** `~/.claude/memory.sh` reads THIS repo's real git state (branch/commits are correct) but
then echoes a **hardcoded prose block** left over from a previous project. The git facts are live; the
narrative is contaminated/stale.
**Lesson:** Trust `primer.md` + `.workflows/_knowledge/*` for project state, **not** the memory.sh
prose block. The script's static "PROJECT STATUS" text needs fixing (it's in `~/.claude/`, outside this
repo). Don't act on the astrophysics briefing — it's not this project.

## Deploy timing masquerades as a data bug
**Symptom:** Dashboard showed "Unable to load current data" / "Run backfill to populate history."
**Reality:** Not a data bug — GitHub Pages was mid-deploy and briefly serving a 404 for
`data.json`/the API; the local files and repo were correct the whole time.
**Lesson:** Before diagnosing a "broken data" report, fetch the LIVE artifact and check HTTP status,
and **wait for Pages to propagate** (poll `latest.json` until the new `methodology_version`/content
appears — usually <90s). Also: `load()` now separates fetch failure from render failure so a render
bug can't masquerade as a load failure.

## Pinned dep versions can be unbuildable on the local Node
**Symptom:** `npm install` failed compiling `better-sqlite3` 9.x against Node 25.
**Fix:** Bumped to `better-sqlite3` 12.x (has prebuilds for current Node). Same class of risk for any
native module.
**Lesson:** Pin exact versions, but **verify `npm ci` is clean on the actual Node in use** before
trusting a pin. A spec's pinned version may predate your runtime.

## The cron bot commits to main — rebase before pushing
**Symptom:** `git push` rejected ("fetch first"); the automated snapshot bot
(`polymarket-tracker[bot]`, "chore: snapshot …") had committed to `main` while you worked.
**Fix:** `git fetch` → `git rebase origin/main`; conflicts are only in **generated** files
(`docs/api/v1/**`, baked `docs/index.html`/`note.html`) → take your version
(`git checkout --theirs <file>` during rebase) → `git rebase --continue` → **re-run
`node scripts/snapshot.js`** to regenerate a consistent state → amend → push.
**Lesson:** Always `git fetch`/rebase before pushing. Snapshot cron is **every 2h, 12:00–00:00 UTC**
(`0 0,12,14,16,18,20,22 * * *`, since 2026-06-12 — was daily 14:00); the 14:30 + 21:00 runs are
**weekday-only** email runs (`* * 1-5`). At 7 bot commits/day the rebase-before-push discipline
matters MORE, not less.
**RESOLVED in CI (2026-06-08):** `update.yml`'s commit step now **self-heals** — it fetches +
`git rebase -X theirs FETCH_HEAD` + pushes, retrying up to 5×, and a `concurrency: snapshot-commit`
group serializes runs (proven green, run 27154304762). You still rebase manually for your OWN pushes.

## pm2 was decommissioned — do NOT re-add it
**Symptom:** (Would cause) duplicate daily runs / double commits.
**Reality:** Production scheduling moved from local **pm2** to **GitHub Actions** (`update.yml`,
3 crons). `ecosystem.config.cjs` remains only as a local fallback artifact.
**Lesson:** Don't `pm2 start` the tracker on the server expecting it to be "the" scheduler — Actions
owns it. Re-adding pm2 = two schedulers = duplicate snapshots.

## Snapshot bakes the HTML — re-read before editing index.html/note.html
**Symptom:** `Edit` failed with "File has been modified since read" right after running
`node scripts/snapshot.js`.
**Reality:** `renderers/dashboard.js` `bakeFallback()` rewrites the `<!--BAKE:…-->` regions of
`docs/index.html` and `docs/note.html` on every snapshot run.
**Lesson:** If you run snapshot, **re-Read** those HTML files before the next Edit. Also: bake uses a
**function** replacement (not a string) so a value containing `$` (e.g. "$2.19T") isn't mangled as a
regex backreference — don't revert that.

## Validation that recomputes invariants from inputs can be tautological
**Symptom:** A "bucket probabilities sum to 1.0" check passed even on corrupted data.
**Reality:** Recomputing buckets from `prob` always telescopes to 1.0 — it caught nothing.
**Lesson:** Validate the **stored** values (`bucket_prob`) and their **consistency** with `prob`, not
a fresh recomputation. (Fixed in `core/validate.js`.)
