import 'server-only';
// lib/supabase/server.ts — SERVER Supabase client (Server Components / Route
// Handlers / Server Actions). Cookie-bound session via @supabase/ssr.
//
// `import 'server-only'` is the build-time fence: importing this module from a
// Client Component is a BUILD FAILURE — it can never reach the browser bundle.
// It still uses the ANON key (acts as the logged-in user via the session cookie);
// the service-role key is NEVER used here and NEVER prefixed NEXT_PUBLIC_, so it
// cannot be inlined into client code (the PAT lesson at framework scale).
import { createServerClient, type SetAllCookies } from '@supabase/ssr';
import { cookies } from 'next/headers';

export async function createClient() {
  const cookieStore = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error('Supabase server client: NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY missing');
  }
  return createServerClient(
    url,
    anon,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: Parameters<SetAllCookies>[0]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // setAll from a Server Component is a no-op (read-only cookies);
            // middleware.ts refreshes the session cookie instead.
          }
        },
      },
    },
  );
}
