// core/markets/manifest.mjs — STATIC manifest of pinned market configs, IMPORTED
// (bundled into the JS) so the verified pipeline reads NO files at runtime.
//
// Why: Vercel's @vercel/next builder does not reliably bundle the extras declared
// in next.config's outputFileTracingIncludes (proven: locally traced + standalone
// packaged correctly, but the deployed function ENOENT'd on core/methodology.json).
// Importing the data inlines it into the JS bundle, removing the file-tracing
// dependency entirely — the read can't ENOENT because there is no read.
//
// Add a pinned market: drop <name>.json beside this file, add an import line, and
// add it to PINNED_BY_NAME (key = filename stem = the loadMarketConfig(name) key).
import spacex from './spacex.json' with { type: 'json' };

/** Pinned configs keyed by filename stem — replaces loadMarketConfig(name)'s read. */
export const PINNED_BY_NAME = { spacex };

/** All pinned configs — replaces the readdirSync iteration in pinnedConfigFor. */
export const PINNED_CONFIGS = Object.values(PINNED_BY_NAME);
