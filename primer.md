# primer.md — resume here

> First file to read on a new session. Present-tense, thin, kept current.
> The "why" behind decisions lives in `.workflows/_knowledge/decisions.md`;
> traps that already bit us live in `.workflows/_knowledge/gotchas.md`.

## Current state
- **v1.2.0 is live:** https://ilanbenamaro-cyber.github.io/polymarket-tracker/
- Methodology **1.2.0**, schema **1.2.0**, assumptions **1.0.0** — all three embedded in every snapshot.
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
- `node --test` — unit tests (currently **19/19**: PAVA, band, anomalies, hash, firewall, rounding, analytics).
- Output lands in **`docs/api/v1/`** (`latest.json`, `history.json` lean, `history-full.json`,
  `history.csv`, `methodology.json`, `schema.json`, `snapshots/YYYY-MM-DD.json`).
- Local preview: `cd docs && python3 -m http.server 8000` (the page `fetch`es the API, so use HTTP not file://).

## VERIFIED
- Local pipeline: snapshot + backfill run clean; 176-day history; 0 negative buckets across all days.
- Dashboard + 3-page note render with **0 console errors** (favicon present); verify-hash MATCH/MISMATCH works.
- Firewall enforced: validate.js throws on a stripped/unsourced scenario assumption and on a Tier-1 leak.
- Live API serves 1.2.0 with CORS `*`; schema validates.
- node --test 19/19.

## UNVERIFIED (do these — top item FIRST)
1. **`workflow_dispatch` has NEVER been run in the Actions runner.** The cron pipeline calling
   `scripts/snapshot.js` inside CI is **unproven** (npm ci on ubuntu, git commit/push as the bot,
   schema validation in CI). **Run this first** from the GitHub Actions tab (mode: snapshot) and
   confirm it goes green + commits `docs/api/v1/**`.
2. Email/push path (`send-emails.js`) is dormant and unrun in CI (intended; guarded to skip without secrets).

## Immediate open tasks
- [ ] **Run `update.yml` via workflow_dispatch (snapshot mode)** and confirm green — see UNVERIFIED #1.
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
