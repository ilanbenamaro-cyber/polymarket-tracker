# primer.md — resume here

> First file to read on a new session. Present-tense, thin, kept current.
> The "why" behind decisions lives in `.workflows/_knowledge/decisions.md`;
> traps that already bit us live in `.workflows/_knowledge/gotchas.md`.

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
