// scripts/predev-guard.mjs — refuse to start a SECOND `next dev` (the two-servers-one-.next wedge).
//
// Why: if a dev server is already running, `next dev` silently falls back to the next free port
// (3000 → 3001) while BOTH instances share this project's single `.next` dir — producing
// webpack-runtime 500s + stale-404 corruption + hung routes. This trap has recurred repeatedly
// across sessions (see gotchas.md). npm runs this as the `predev` hook BEFORE `dev`, so it aborts
// the start before a second server can wedge the first.
//
// Checks (at predev time the new server hasn't started yet, so a hit means a PRE-EXISTING one):
//   • the intended PORT (default 3000) is already LISTENing, and/or
//   • a `next dev` / `next-server` process is already running.
// Bypass intentionally with DEV_GUARD=off (e.g. to run a deliberate second instance elsewhere).

import { execSync } from 'node:child_process';

if (process.env.DEV_GUARD === 'off') process.exit(0);

const PORT = process.env.PORT || '3000';

/** Run a shell command, returning trimmed stdout or '' (never throws — these probes are best-effort). */
function sh(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

const portPids = sh(`lsof -ti tcp:${PORT} -sTCP:LISTEN`).split('\n').filter(Boolean);
const nextProcs = sh('pgrep -f "next dev"').split('\n').filter(Boolean);

if (portPids.length || nextProcs.length) {
  const lines = [
    '',
    '✗ predev-guard: a dev server appears to be running already — refusing to start a second one.',
  ];
  if (portPids.length) lines.push(`  • port ${PORT} is already in use by PID(s): ${portPids.join(', ')}`);
  if (nextProcs.length) lines.push(`  • existing \`next dev\` process PID(s): ${nextProcs.join(', ')}`);
  lines.push(
    '',
    '  A second `next dev` falls back to the next port while BOTH share one .next dir →',
    '  webpack-runtime 500s + stale-404 corruption + hung routes (the recurring gotcha).',
    '',
    '  Restart cleanly instead:',
    '    pkill -f "next dev"; pkill -f "next-server"; rm -rf .next; npm run dev',
    '',
    '  (Bypass intentionally with DEV_GUARD=off npm run dev.)',
    '',
  );
  console.error(lines.join('\n'));
  process.exit(1);
}
