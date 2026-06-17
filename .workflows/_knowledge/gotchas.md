# Gotchas — traps that already bit us

Concrete failure modes hit during development. Check here before diagnosing a
"weird" symptom. Newest at top.

---

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
