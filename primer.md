# primer.md — resume here

> First file to read on a new session. Present-tense, thin, kept current.
> The "why" behind decisions lives in `.workflows/_knowledge/decisions.md`;
> traps that already bit us live in `.workflows/_knowledge/gotchas.md`.

## Current state
- **v1.2.1 is live:** https://ilanbenamaro-cyber.github.io/polymarket-tracker/
- Methodology **1.2.1**, schema **1.2.1**, assumptions **1.0.0** — all three embedded in every snapshot.
  (1.2.1 = source-of-record clarification + accuracy verifier + Tier-1 `derived.freshness`; additive, no formula change.)
- All work committed + pushed to `main` (repo: `ilanbenamaro-cyber/polymarket-tracker`).

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
- `node --test` — unit tests (currently **43/43**: PAVA, band, anomalies, hash, firewall, rounding,
  analytics, **freshness, accuracy-verifier zones**).
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
1. Email/push path (`send-emails.js`) is dormant and unrun in CI (intended; guarded to skip without secrets).

## Recently shipped (this session, 2026-06-08)
- [x] **Data-accuracy verifier** (`scripts/verify-accuracy.js`) — proves the feed matches Polymarket
  source (not eyeballed); two-horizon model (price-match ≤3h vs liveness >50h). See [[gotchas]].
- [x] **Canonical source of record documented** — CLOB midpoint is truth; Gamma `outcomePrices` is a
  lagging cross-check, never an input. See [[decisions]].
- [x] **Tier-1 data freshness** (`core/freshness.js`, `derived.freshness`) — as-of age + STALE badge on
  dashboard/note; 50h threshold, evaluated client-side. See [[decisions]].
- [x] **CI push made concurrency-safe** (`update.yml`: concurrency group + rebase `-X theirs` + retry +
  fetch-depth:0; actions @v5) and **proven green via workflow_dispatch**. See [[decisions]], [[gotchas]].

## Immediate open tasks
- [ ] **Wire `verify-accuracy.js --strict` as a post-snapshot CI gate** in `update.yml` — now UNBLOCKED
  (the pipeline is proven green). Canonical pattern: snapshot → verify while seconds-old → exit 0.
- [ ] **Scenario-tier precision check:** confirm the share-price band width is driven by the
  shares-outstanding `range` (1.7B–2.1B) and reads sensibly; sanity-check the round-over-round
  `+172%` rounding (1dp) isn't implying false precision on a low-confidence input.
- [ ] **Document the 0.5% confidence threshold** (`MATERIAL_ADJUSTMENT` in `core/confidence.js`) in
  `core/methodology.json` — an isotonic tweak below 0.5% is treated as immaterial and keeps tier high;
  that rule should be written down in the methodology, not just the code.

## Pointers
- Why things are the way they are → `.workflows/_knowledge/decisions.md`
- Traps already hit → `.workflows/_knowledge/gotchas.md`
- Human methodology → `METHODOLOGY.md`; API contract → `API.md`; schema → `docs/api/v1/schema.json`
- Latest task plan → `~/.claude/plans/azure-if-not-already-prancy-lemur.md` (overwritten per task; holds 1.2.0 only)
