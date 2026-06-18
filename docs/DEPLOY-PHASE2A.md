# Deploy Phase 2a — Supabase cache + Vercel function

Browser + a couple of terminal commands. ~10 min. Everything is reversible
(§ Rollback). The deploy serves the `feature/phase2a-backend` branch.

## 1. Supabase
1. [supabase.com](https://supabase.com) → **New project** (note the region + DB password).
2. **SQL Editor** → New query → paste all of `supabase/migrations/0001_phase2a.sql` → **Run**.
   Expect: `markets`, `market_snapshots`, the `market_latest` view, RLS enabled, no policies.
3. **Project Settings → API** → copy three values:
   - **Project URL** → `SUPABASE_URL`
   - **`service_role` key** (the secret one) → `SUPABASE_SERVICE_ROLE_KEY` (write-capable — keep secret)
   - (`anon` key — not used in 2a; save for 2b)

## 2. Vercel
1. [vercel.com](https://vercel.com) → **Add New → Project** → import `ilanbenamaro-cyber/polymarket-tracker`.
2. **Configure project** (exact settings):
   | Field | Value |
   |---|---|
   | Framework Preset | **Other** |
   | Root Directory | `./` (repo root) |
   | Build Command | *(leave empty / "Override" off — no build; plain functions)* |
   | Output Directory | *(leave empty)* |
   | Install Command | `npm install` (default) |
   | Production Branch | `feature/phase2a-backend` *(temporarily, for the preview)* — or import and use the branch's **Preview** deployment URL |
3. **Settings → Environment Variables** — add to **Production** and **Preview**, **plain (NOT** the
   `NEXT_PUBLIC_` checkbox — these are server-only):
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` = service_role key
4. **Deploy.** Note the deployment URL, e.g. `https://polymarket-tracker-xxx.vercel.app`.

## 3. Seed SpaceX (one-time) + verify (terminal)
Locally, with the two Supabase vars (a gitignored `.env` or inline):
```bash
SUPABASE_URL=…  SUPABASE_SERVICE_ROLE_KEY=…  node scripts/seed-spacex.mjs
# → ✓ seeded spacex-ipo-closing-market-cap-above as RESOLVED

BASE_URL=https://your-deployment.vercel.app \
SUPABASE_URL=…  SUPABASE_SERVICE_ROLE_KEY=… \
  node scripts/verify-phase2a.mjs
# → C1 OPEN verified · C2 cache-hit · C3 SpaceX frozen · C4 resolution-trap · all passed
```
First live call to `/api/market?id=<event-slug>` for an OPEN market (e.g.
`kraken-ipo-closing-market-cap-above`) should return a verified record and write a
`market_snapshots` row.

## Secrets boundary (do not violate)
`SUPABASE_SERVICE_ROLE_KEY` is write-capable and bypasses RLS. It lives ONLY in the Vercel function's
server env and your local `.env`. Never `NEXT_PUBLIC_`, never in client code, never committed. RLS is
on with no anon policies, so even the anon key can read/write nothing until 2b adds explicit policies.

## Rollback / teardown (all reversible — cache is regenerable, no user data)
- Clear cached records only: `truncate public.market_snapshots;` (Supabase SQL editor).
- Full schema reset: run `supabase/migrations/0001_phase2a_down.sql`, then re-run `0001_phase2a.sql`.
- Bad deploy: Vercel → Deployments → pick a prior one → **Instant Rollback** (or **Promote**).
- Remove the function entirely: delete the Vercel project; the GitHub Actions cron is unaffected
  (it never imports `api/`/`lib/`).
