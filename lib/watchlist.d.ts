// lib/watchlist.d.ts — types for the client-safe watchlist module (lib/watchlist.mjs).
// TS resolves these for `import … from '@/lib/watchlist.mjs'` (sibling .d.ts), giving
// the 2c frontend typed CRUD without rewriting the proven JS module.
import type { SupabaseClient } from '@supabase/supabase-js';

export class WatchlistError extends Error {
  code?: string;
}
export class NotAuthenticatedError extends WatchlistError {}
export class MarketNotInCatalogError extends WatchlistError {
  marketId: string;
}
export class NotPermittedError extends WatchlistError {}

export interface VisibleEntry {
  scope: 'personal' | 'org';
  org_id: string | null;
  market_id: string;
  created_at: string;
}

export function addPersonal(sb: SupabaseClient, marketId: string): Promise<void>;
export function removePersonal(sb: SupabaseClient, marketId: string): Promise<{ removed: number }>;
export function addOrg(sb: SupabaseClient, orgId: string, marketId: string): Promise<void>;
export function removeOrg(sb: SupabaseClient, orgId: string, marketId: string): Promise<{ removed: number }>;
export function listVisible(sb: SupabaseClient): Promise<VisibleEntry[]>;
