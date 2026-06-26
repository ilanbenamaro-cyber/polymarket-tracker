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
  after(() => triggerBackfill(id));
  return { ok: true, slug: id };
}

/** Kick the backfill route for a freshly added market. Fire-and-forget: gated by CRON_SECRET
 *  (skips when unset — fails closed, never runs the job open), and any failure here NEVER affects
 *  the add (history simply backfills later, or via the cron retry of a 'failed' status). */
async function triggerBackfill(id: string): Promise<void> {
  // Audit F2: every skip/failure here used to be SILENT, so a market added before CRON_SECRET was
  // set (or any trigger failure) left market_history empty with NO trace — backfill_status stays
  // null and nothing logs. Each path now logs, so a missed backfill is observable in the server
  // logs (and the cron should retry markets where backfill_status IS NULL or 'failed').
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.warn('[backfill-trigger]', JSON.stringify({ id, skipped: 'CRON_SECRET unset' }));
    return; // fail-closed: never run the job open
  }
  try {
    const h = await headers();
    const host = h.get('host');
    if (!host) {
      console.warn('[backfill-trigger]', JSON.stringify({ id, skipped: 'no host header' }));
      return;
    }
    const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https');
    const res = await fetch(`${proto}://${host}/api/backfill?id=${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
      cache: 'no-store',
    });
    if (!res.ok) console.warn('[backfill-trigger]', JSON.stringify({ id, route_status: res.status }));
  } catch (e) {
    // fire-and-forget: a trigger failure NEVER affects the add — but log it (the cron retries later).
    console.warn('[backfill-trigger]', JSON.stringify({ id, error: (e as Error).message }));
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
