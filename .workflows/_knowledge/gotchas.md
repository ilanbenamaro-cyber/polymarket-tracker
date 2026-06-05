# Gotchas — traps that already bit us

Concrete failure modes hit during development. Check here before diagnosing a
"weird" symptom. Newest at top.

---

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
