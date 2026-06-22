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
import { createClient } from '@/lib/supabase/server';
import { serveMarket } from '@/lib/serve-market.mjs';
import { DEPS } from '@/lib/market-deps.mjs';
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
  return { ok: true, slug: id };
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
