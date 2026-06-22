'use client';
// lib/supabase/client.ts — BROWSER Supabase client (Client Components only).
// Anon key + the user's session cookie → runs as the `authenticated` role; RLS
// enforces. This is the client passed into lib/watchlist.mjs for watchlist CRUD.
// NO service-role here, ever (only NEXT_PUBLIC_* is exposed to the browser).
import { createBrowserClient } from '@supabase/ssr';

export function createClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error('Supabase browser client: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY missing');
  }
  return createBrowserClient(url, anon);
}
