// api.js — Polymarket API client.
//
// Why this exists: isolates all network I/O for the SpaceX-IPO market-cap
// prediction market behind a single fetchSnapshot() call so the rest of the
// tracker (and a future Jarvis daemon) never touches HTTP details. Two public
// Polymarket endpoints are used, neither requires auth:
//   1. Gamma  — event + market metadata (questions, token IDs, volume)
//   2. CLOB   — live midpoint prices (probability of YES) for each threshold

const EVENT_SLUG = 'spacex-ipo-closing-market-cap-above';
const GAMMA_EVENTS_URL = `https://gamma-api.polymarket.com/events?slug=${EVENT_SLUG}`;
const CLOB_MIDPOINTS_URL = 'https://clob.polymarket.com/midpoints';

// Threshold value lives inside the question text, e.g. "...above $1.8T?".
const THRESHOLD_RE = /\$(\d+\.?\d*)/;

// Set false after the live CLOB response shape has been confirmed in logs.
// TODO: remove this raw-response logging once structure is verified in prod.
let LOG_RAW_CLOB = true;

/**
 * Fetch event metadata from the Gamma API and normalise each market into
 * { label, threshold, yesToken, volume }. clobTokenIds arrives as a JSON
 * *string* and must be parsed; index 0 is the YES token, index 1 is NO.
 */
async function fetchMarketMeta() {
  const res = await fetch(GAMMA_EVENTS_URL);
  if (!res.ok) {
    throw new Error(`Gamma API ${res.status} ${res.statusText}`);
  }
  const events = await res.json();
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error('Gamma API returned no events for slug ' + EVENT_SLUG);
  }
  const markets = events[0].markets;
  if (!Array.isArray(markets) || markets.length === 0) {
    throw new Error('Gamma event contained no markets');
  }

  return markets.map((m) => {
    const match = m.question.match(THRESHOLD_RE);
    if (!match) {
      throw new Error(`Could not parse threshold from question: ${m.question}`);
    }
    const threshold = parseFloat(match[1]);
    // clobTokenIds may be a JSON string — always parse defensively.
    const tokenIds =
      typeof m.clobTokenIds === 'string'
        ? JSON.parse(m.clobTokenIds)
        : m.clobTokenIds;
    return {
      label: `>$${threshold}T`,
      threshold,
      yesToken: tokenIds[0], // [0] = YES, [1] = NO
      volume: m.volume != null ? parseFloat(m.volume) : null,
    };
  });
}

/**
 * Fetch live midpoint prices for the given YES token IDs.
 *
 * Note: the real CLOB endpoint is a POST taking a JSON array of
 * {token_id} objects, and returns an object keyed by token ID whose values
 * are the midpoint as a *string* (e.g. {"<id>":"0.875"}). It is NOT the GET
 * + {mid:...} shape some older docs describe. Returns a Map<tokenId, number>.
 */
async function fetchMidpoints(yesTokens) {
  const body = yesTokens.map((t) => ({ token_id: t }));
  const res = await fetch(CLOB_MIDPOINTS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`CLOB API ${res.status} ${res.statusText}`);
  }
  const raw = await res.json();

  if (LOG_RAW_CLOB) {
    console.log('[api] raw CLOB midpoints response:', JSON.stringify(raw));
    LOG_RAW_CLOB = false;
  }
  if (raw && raw.error) {
    throw new Error(`CLOB API error: ${raw.error}`);
  }

  const prices = new Map();
  for (const tokenId of yesTokens) {
    const mid = raw[tokenId];
    if (mid == null) {
      throw new Error(`CLOB response missing midpoint for token ${tokenId}`);
    }
    prices.set(tokenId, parseFloat(mid)); // mid is a string — always parseFloat
  }
  return prices;
}

/**
 * Public entry point. Returns Array<{label, threshold, prob, volume}> sorted
 * ascending by threshold, or null on any failure (logged, never thrown) so
 * the caller can abort the run cleanly.
 */
export async function fetchSnapshot() {
  try {
    const meta = await fetchMarketMeta();
    const prices = await fetchMidpoints(meta.map((m) => m.yesToken));

    return meta
      .map((m) => ({
        label: m.label,
        threshold: m.threshold,
        prob: prices.get(m.yesToken), // probability of YES, 0.0–1.0
        volume: m.volume,
      }))
      .sort((a, b) => a.threshold - b.threshold);
  } catch (err) {
    console.error('[api] fetchSnapshot failed:', err.message);
    return null;
  }
}
