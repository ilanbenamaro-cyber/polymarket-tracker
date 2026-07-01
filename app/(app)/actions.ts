'use server';
// app/(app)/actions.ts — Zone 3 mutations: the compute-then-add flow + remove.
//
// Server actions run server-side with the right identity for each step: the COMPUTE
// uses the service-role DEPS (writeRecord — never exposed to the client); the ADD/REMOVE
// use the cookie-bound user client so RLS is the guard (lib/watchlist surfaces the DB's
// decision as typed errors). After a mutation, revalidatePath('/', 'layout') re-renders
// the LAYOUT segment — where the watchlist rail (a Server Component) lives — so the new
// or removed market appears without a full reload or a client-state layer.
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { headers } from 'next/headers';
import { createClient } from '@/lib/supabase/server';
import { serveMarket } from '@/lib/serve-market.mjs';
import { DEPS } from '@/lib/market-deps.mjs';
import { readCache, writeRecord } from '@/lib/cache.mjs';
import { computeMarketRecord } from '@/lib/compute.mjs';
import { addPersonal, addOrg, removePersonal, removeOrg, MarketNotInCatalogError } from '@/lib/watchlist.mjs';

export interface ActionResult {
  ok: boolean;
  slug?: string;
  error?: string;
}

const msg = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

/**
 * Compute-then-add. The ordering is load-bearing: serveMarket() runs the verified
 * pipeline which, on a miss/recompute, populates `markets` (+ `market_snapshots`) via
 * writeRecord — so the watchlist FK is satisfied when the add runs. orgId null = personal.
 */
export async function addMarket(slug: string, orgId: string | null): Promise<ActionResult> {
  const id = (slug ?? '').trim();
  if (!id) return { ok: false, error: 'no market selected' };

  // 1. compute (catalog side-effect). Non-200 = not a usable ladder / upstream / etc.
  const { status, body } = (await serveMarket({ id, deps: DEPS })) as { status: number; body: { error?: string } };
  if (status !== 200) {
    const why = status === 404 ? 'not a supported threshold-ladder market' : (body?.error ?? `compute failed (${status})`);
    return { ok: false, error: why };
  }

  // 2. add as the signed-in user (RLS enforces). Idempotent.
  const supabase = await createClient();
  try {
    if (orgId) await addOrg(supabase, orgId, id);
    else await addPersonal(supabase, id);
  } catch (e) {
    // With compute sequenced first this should NOT fire — if it does, it's a real
    // inconsistency, not the happy path. Surface it; never swallow.
    if (e instanceof MarketNotInCatalogError) {
      return { ok: false, error: 'computed, but the catalog row is missing — please retry' };
    }
    return { ok: false, error: msg(e, 'could not add to watchlist') };
  }

  revalidatePath('/', 'layout'); // rail (layout-level Server Component) re-renders

  // 3. Backfill market_history from CLOB price history — fire-and-forget AFTER the response
  // flushes (the user already sees the market). The dedicated /api/backfill route ACKs 202 and
  // owns the (minutes-long) rebuild in its own budget, so this trigger returns fast.
  //
  // Capture the request host/proto NOW (request scope), not inside the after() callback: Next 15
  // does allow headers() inside after() for a Server Function, but reading request data before the
  // deferred callback is the documented-robust pattern (and lets triggerBackfill be unit-tested
  // without a request context). See https://nextjs.org/docs/app/api-reference/functions/after.
  const h = await headers();
  const host = h.get('host');
  const proto = h.get('x-forwarded-proto') ?? (host?.startsWith('localhost') ? 'http' : 'https');
  after(() => triggerBackfill(id, host, proto));
  return { ok: true, slug: id };
}

/** Kick the backfill route for a freshly added market. Fire-and-forget: gated by CRON_SECRET
 *  (skips when unset — fails closed, never runs the job open), and any failure here NEVER affects
 *  the add (history simply backfills later, or via the cron retry of a 'failed' status). */
async function triggerBackfill(id: string, host: string | null, proto: string): Promise<void> {
  // Audit F2 + observability pass: every skip/failure here used to be SILENT, so a market added
  // before CRON_SECRET was set (or any trigger failure) left market_history empty with NO trace.
  // Now EVERY call emits a structured `attempt` line followed by exactly one outcome — `skipped`
  // (with reason), `success`, or `failure` — so a missed backfill is observable in Vercel logs
  // (and the cron retries markets left at backfill_status null/'failed'). All lines share the
  // `[backfill-trigger]` tag + an `event` field for grep/alerting.
  const log = (level: 'log' | 'warn', event: string, extra: Record<string, unknown> = {}) =>
    console[level]('[backfill-trigger]', JSON.stringify({ id, event, ...extra }));

  log('log', 'attempt');
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    log('warn', 'skipped', { reason: 'CRON_SECRET unset' }); // fail-closed: never run the job open
    return;
  }
  if (!host) {
    log('warn', 'skipped', { reason: 'no host header' });
    return;
  }
  try {
    const res = await fetch(`${proto}://${host}/api/backfill?id=${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
      cache: 'no-store',
    });
    if (res.ok) log('log', 'success', { route_status: res.status });
    else log('warn', 'failure', { route_status: res.status });
  } catch (e) {
    // fire-and-forget: a trigger failure NEVER affects the add — but log it (the cron retries later).
    log('warn', 'failure', { error: (e as Error).message });
  }
}

/** Remove a market from the rail. orgId null = personal; otherwise the org's shared list. */
export async function removeMarket(marketId: string, orgId: string | null): Promise<ActionResult> {
  const id = (marketId ?? '').trim();
  if (!id) return { ok: false, error: 'no market specified' };

  const supabase = await createClient();
  try {
    if (orgId) await removeOrg(supabase, orgId, id);
    else await removePersonal(supabase, id);
  } catch (e) {
    return { ok: false, error: msg(e, 'could not remove from watchlist') };
  }

  revalidatePath('/', 'layout');
  return { ok: true, slug: id };
}

/**
 * Force a FRESH compute for one market, bypassing the cache TTL. computeMarketRecord
 * always re-fetches (it doesn't consult the TTL — that's serveMarket's job), so calling
 * it directly + writeRecord stores a new snapshot with as-of = now. revalidatePath('/',
 * 'page') re-renders ONLY the detail page segment — NOT the layout — so the rail is not
 * re-fetched (per the scope-the-revalidation constraint).
 */
export async function refreshMarket(slug: string): Promise<ActionResult> {
  const id = (slug ?? '').trim();
  if (!id) return { ok: false, error: 'no market selected' };
  try {
    const { snapshot } = await readCache(id); // prior, for the RESOLVED freeze path
    const prior = snapshot?.record ?? null;
    const { record, lifecycle, config } = await computeMarketRecord({ id, prior });
    await writeRecord(id, record, lifecycle, config);
  } catch (e) {
    return { ok: false, error: msg(e, 'could not refresh market') };
  }
  revalidatePath('/', 'page'); // detail only — rail (layout) untouched
  return { ok: true, slug: id };
}
