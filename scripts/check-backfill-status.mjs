// scripts/check-backfill-status.mjs — DEV/OPS: read a market's backfill provenance (read-only).
//
// Prints markets.backfill_status / backfilled_through + a count of market_history rows by source
// for one market id, so you can tell whether the add-time auto-backfill fired (status set) vs
// never ran (status null). Service-role read; auto-loads .env.local for the creds (values stay in
// this process — nothing is printed but the status fields).
//
//   node scripts/check-backfill-status.mjs <market_id>

import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

function loadDotenvLocal() {
  let text;
  try { text = readFileSync(new URL('../.env.local', import.meta.url), 'utf8'); } catch { return; }
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim(); // tolerate `export KEY=val` (sourceable env files)
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (k && !(k in process.env)) process.env[k] = v;
  }
}
loadDotenvLocal();

const id = process.argv[2];
if (!id) { console.error('usage: node scripts/check-backfill-status.mjs <market_id>'); process.exit(2); }
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) { console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (.env.local).'); process.exit(2); }
const db = createClient(URL, KEY, { auth: { persistSession: false } });

const mkt = await db.from('markets').select('id, kind, backfill_status, backfilled_through, last_checked_at').eq('id', id).maybeSingle();
if (mkt.error) { console.error('markets read:', mkt.error.message); process.exit(1); }
if (!mkt.data) { console.log(`(no markets row for ${id})`); process.exit(0); }

const hist = await db.from('market_history').select('source').eq('market_id', id);
if (hist.error) { console.error('history read:', hist.error.message); process.exit(1); }
const bySource = {};
for (const r of hist.data ?? []) bySource[r.source ?? '(null)'] = (bySource[r.source ?? '(null)'] ?? 0) + 1;

console.log(JSON.stringify({
  id: mkt.data.id,
  kind: mkt.data.kind,
  backfill_status: mkt.data.backfill_status ?? null,
  backfilled_through: mkt.data.backfilled_through ?? null,
  history_rows_total: (hist.data ?? []).length,
  history_rows_by_source: bySource,
}, null, 2));
