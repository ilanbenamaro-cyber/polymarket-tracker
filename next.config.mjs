// next.config.mjs — Next.js config for the 2c dashboard.
//
// outputFileTracingIncludes is the Next equivalent of vercel.json's includeFiles
// (gotcha #2, new mechanism): the /api/market route handler runs core/ which
// readFileSync's these JSON files at runtime; Next's bundler won't trace dynamic
// readdirSync/templated paths, so they MUST be force-included or the route 500s
// with ENOENT. First deploy confirms (call /api/market; ENOENT = a glob missed).
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the file-tracing root to THIS project dir. Without it, Vercel can infer a
  // different root and DROP traced files that live outside the inferred root —
  // which is why core/methodology.json (correctly traced locally) was missing from
  // the deployed function. The included files (core/**) live under this root.
  outputFileTracingRoot: projectRoot,
  outputFileTracingIncludes: {
    // proven via .next/server/app/api/market/route.js.nft.json: this traces
    // methodology.json, assumptions.json, markets/*.json, and schema.json.
    '/api/market': ['./core/**', './docs/api/v1/schema.json'],
  },
  // Belt-and-suspenders: explicitly inline the two PUBLIC Supabase vars into
  // every bundle (incl. middleware) so middleware env can't silently differ on
  // Vercel. Values are read at config-eval (after Next loads .env*), so dev
  // inlines dev values and the Vercel build inlines prod values — correct per
  // environment, no dev values baked into prod. PUBLIC vars ONLY — the
  // service-role key is NEVER passed here (it must not reach the client bundle).
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },
};

export default nextConfig;
