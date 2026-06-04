// notify.js — macOS notification wrapper (osascript).
//
// Why this exists: fires a desktop notification only when the market moved
// enough to be worth a human's attention, so the daily cron is silent on quiet
// days. Significance = any threshold moved >5% absolute, OR the implied median
// shifted by >$0.1T. Non-macOS / CI environments degrade gracefully (warn,
// never throw) so the tracker run still completes.

import { execFileSync } from 'node:child_process';

const SIGNIFICANT_DELTA = 0.05; // 5 percentage points (probability fraction)
const SIGNIFICANT_MEDIAN_SHIFT = 0.1; // $0.1T

function pct(p) {
  return `${Math.round(p * 100)}%`;
}

function medianStr(m) {
  return m == null ? 'n/a' : `$${m.toFixed(2)}T`;
}

/** Escape single quotes for safe embedding inside an osascript string. */
function escapeForOsascript(str) {
  // Replace ' with the AppleScript-safe sequence '\'' equivalent: close quote,
  // escaped quote, reopen. Simpler + robust: backslash-escape double quotes and
  // strip stray single quotes is risky; we embed in double quotes and escape ".
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Decide whether the digest warrants a notification and, if so, fire it.
 * Returns true if a notification was sent (or attempted), false otherwise.
 */
export function notifyIfWarranted(digest) {
  // Largest absolute mover among thresholds that have a prior value.
  let topMover = null;
  for (const r of digest.rows) {
    if (r.delta == null) continue;
    if (!topMover || Math.abs(r.delta) > Math.abs(topMover.delta)) {
      topMover = r;
    }
  }

  const moverSignificant =
    topMover != null && Math.abs(topMover.delta) >= SIGNIFICANT_DELTA;

  const medianShift =
    digest.impliedMedian != null && digest.impliedMedianPrior != null
      ? digest.impliedMedian - digest.impliedMedianPrior
      : null;
  const medianSignificant =
    medianShift != null && Math.abs(medianShift) >= SIGNIFICANT_MEDIAN_SHIFT;

  if (!moverSignificant && !medianSignificant) {
    return false;
  }

  const title = 'SpaceX IPO Market · Polymarket';
  const parts = [];
  if (moverSignificant) {
    parts.push(
      `⚑ ${topMover.label} moved from ${pct(topMover.priorProb)} → ${pct(
        topMover.prob
      )}`
    );
  }
  parts.push(
    `Median: ${medianStr(digest.impliedMedianPrior)}→${medianStr(
      digest.impliedMedian
    )}`
  );
  const body = parts.join(' | ');

  sendNotification(title, body);
  return true;
}

/**
 * Fire the actual osascript notification; warn (never throw) on failure.
 * Synchronous so delivery completes before the caller calls process.exit().
 */
function sendNotification(title, body) {
  const script = `display notification "${escapeForOsascript(
    body
  )}" with title "${escapeForOsascript(title)}"`;

  try {
    execFileSync('osascript', ['-e', script]);
  } catch (err) {
    console.warn('[notify] osascript failed (non-macOS?):', err.message);
  }
}
