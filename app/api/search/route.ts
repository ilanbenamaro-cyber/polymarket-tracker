// app/api/search/route.ts — Zone 3 search: proxy Polymarket's public gamma search
// server-side. Why a proxy (not a direct browser→gamma fetch): avoids browser CORS
// fragility, keeps the gamma URL/response shape out of the client, and normalizes the
// heavy event payload down to the few fields the overlay needs. Read-only, public data,
// no secrets, no auth — but it IS behind the app's middleware like every other route.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GAMMA_SEARCH = 'https://gamma-api.polymarket.com/public-search';
const MIN_Q = 2;
const LIMIT = 8;

interface GammaEvent {
  slug?: string;
  title?: string;
  closed?: boolean;
  active?: boolean;
  volume?: number;
}
export interface SearchResult {
  slug: string;
  title: string;
  closed: boolean;
  active: boolean;
  volume: number | null;
}

export async function GET(req: Request): Promise<Response> {
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim();
  if (q.length < MIN_Q) return json({ results: [] });

  let events: GammaEvent[] = [];
  try {
    const res = await fetch(`${GAMMA_SEARCH}?q=${encodeURIComponent(q)}&limit_per_type=${LIMIT}`, {
      signal: AbortSignal.timeout(6000),
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return json({ results: [], error: `gamma ${res.status}` }, 502);
    const data: unknown = await res.json();
    const ev = (data as { events?: unknown })?.events;
    events = Array.isArray(ev) ? (ev as GammaEvent[]) : [];
  } catch {
    // upstream timeout / network — surface, don't pretend success
    return json({ results: [], error: 'search upstream unavailable' }, 502);
  }

  const results: SearchResult[] = events
    .map((e) => ({
      slug: e.slug ?? '',
      title: e.title ?? '',
      closed: !!e.closed,
      active: !!e.active,
      volume: typeof e.volume === 'number' ? e.volume : null,
    }))
    .filter((r) => r.slug && r.title)
    .slice(0, LIMIT);

  return json({ results });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
