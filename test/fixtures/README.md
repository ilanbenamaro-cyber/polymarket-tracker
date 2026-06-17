# test/fixtures — frozen oracles (IMMUTABLE)

These files are the **pre-generalization reference** for the Phase 1 multi-market pivot
(`docs/ARCHITECTURE.md` §9). They were captured from the proven, committed v1 SpaceX output
**before any `core/` generalization** and must **never be edited** to make a test pass — a diff
against them is a real behavior change to investigate, not something to paper over.

- `spacex-reference-latest.json` — the full canonical SpaceX record (raw_inputs + derived + hash),
  copied verbatim from `docs/api/v1/latest.json` at freeze time.
  - frozen `raw_sha256`: **c1be52e4af45aa6e6d6be6e81c9bc6a96f4274990020fefa2f834449bab89003**
  - fetched_at: 2026-06-12T20:08:39.805Z · methodology 1.3.0 · schema 1.2.1 · assumptions 1.0.0
- `spacex-reference-history.json` — the 183-day full history (`docs/api/v1/history-full.json`),
  the oracle for the per-day re-derivation gate.

**The Phase 1 hard gate:** after generalization, the SpaceX config must reproduce the frozen
`raw_sha256` byte-identically AND every derived scalar must match `spacex-reference-latest.json`,
AND each frozen history day re-derived through generalized `core/` must match
`spacex-reference-history.json`. Verified at freeze time: current code reproduces the hash, the
record validates, and all 183 history days validate.
