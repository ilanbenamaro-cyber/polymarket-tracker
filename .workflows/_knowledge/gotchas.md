# Gotchas — traps that already bit us

Concrete failure modes hit during development. Check here before diagnosing a
"weird" symptom. Newest at top.

---

## Verifier: price-match window ≠ liveness window (two different horizons)
**Symptom:** `scripts/verify-accuracy.js` returned **FAIL** on a correct, recently-published snapshot
because one thin mid-tail threshold (`$2.6T`) had drifted ~5pt since publish.
**Reality:** The first cut used **one** 26h window and asserted the published raw_prob should match the
live CLOB midpoint within ±2pt for anything <26h old. But markets move several points intraday — a 2pt
match is only meaningful while a snapshot is **minutes-to-a-few-hours** old. The fix splits two
distinct horizons: **price-match** (≤ ~3h, `PRICE_MATCH_WINDOW_H` — strict ±2pt is a hard PASS/FAIL)
vs **liveness/stale** (> 50h, `STALENESS_WINDOW_H`, shared with the dashboard via `core/freshness.js`).
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
**Lesson:** Always `git fetch`/rebase before pushing. The cron runs ~3×/weekday (14:00, 14:30, 21:00 UTC).

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
