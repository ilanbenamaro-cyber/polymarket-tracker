// digest.js — builds the derived daily digest object and renders it as a
// coloured terminal report.
//
// Why this exists: keeps presentation + the small amount of analytics
// (implied median, day-over-day deltas) separate from I/O. generateDigest()
// is pure (no side effects) so it is trivially testable and reusable by a
// future Jarvis daemon; printDigest() is the only part that writes to stdout.

import chalk from 'chalk';

// Thresholds we actively track / surface prominently.
const TRACKED = new Set([1.8, 2.4]);
// A delta of this magnitude (in probability fraction) is "significant".
const SIGNIFICANT_DELTA = 0.05;
// Probability boundary used for the implied-median crossover.
const MEDIAN_P = 0.5;

/**
 * Linear interpolation of the valuation where P(above X) crosses 50%.
 * Returns null if every prob is >= 0.5 or every prob is < 0.5 (no crossover).
 */
export function computeImpliedMedian(snapshot) {
  for (let i = 0; i < snapshot.length - 1; i++) {
    const a = snapshot[i];
    const b = snapshot[i + 1];
    if (a.prob >= MEDIAN_P && b.prob < MEDIAN_P) {
      return (
        a.threshold +
        ((b.threshold - a.threshold) * (a.prob - MEDIAN_P)) / (a.prob - b.prob)
      );
    }
  }
  return null;
}

/** Probability at an exact threshold, or null if that threshold is absent. */
function probAt(snapshot, threshold) {
  const row = snapshot.find((s) => s.threshold === threshold);
  return row ? row.prob : null;
}

/**
 * Build the digest object from today's snapshot and the prior day's snapshot
 * (may be null on first run). Pure function — returns everything the DB,
 * printer, and notifier need.
 */
export function generateDigest(date, snapshot, prior) {
  const priorByThreshold = new Map(
    (prior ?? []).map((p) => [p.threshold, p.prob])
  );
  const isFirstRun = !prior || prior.length === 0;

  const rows = snapshot.map((s) => {
    const priorProb = priorByThreshold.has(s.threshold)
      ? priorByThreshold.get(s.threshold)
      : null;
    const delta = priorProb == null ? null : s.prob - priorProb;
    return {
      label: s.label,
      threshold: s.threshold,
      prob: s.prob,
      priorProb,
      delta,
      tracked: TRACKED.has(s.threshold),
    };
  });

  const impliedMedian = computeImpliedMedian(snapshot);
  const impliedMedianPrior = prior ? computeImpliedMedian(prior) : null;

  return {
    date,
    snapshot,
    rows,
    isFirstRun,
    impliedMedian,
    impliedMedianPrior,
    prob_1_8t: probAt(snapshot, 1.8) ?? 0,
    prob_2_0t: probAt(snapshot, 2) ?? 0,
    prob_2_4t: probAt(snapshot, 2.4) ?? 0,
  };
}

// ── rendering helpers ───────────────────────────────────────────────────────

const INNER = 62; // inner width of the box in visible characters

function pct(p) {
  return `${Math.round(p * 100)}%`;
}

function medianStr(m) {
  return m == null ? 'n/a' : `$${m.toFixed(2)}T`;
}

/** Render a single delta cell (already coloured) given a fraction or null. */
function deltaCell(delta) {
  if (delta == null) return chalk.dim('—');
  const pp = Math.round(delta * 100);
  if (pp === 0) return chalk.dim('—');
  if (pp > 0) return chalk.green(`↑ +${pp}%`);
  return chalk.red(`↓ ${pp}%`);
}

/**
 * Pad a string to a visible width, ignoring ANSI colour codes when measuring.
 */
function padVisible(str, width) {
  // eslint-disable-next-line no-control-regex
  const visibleLen = str.replace(/\[[0-9;]*m/g, '').length;
  const pad = Math.max(0, width - visibleLen);
  return str + ' '.repeat(pad);
}

function border(left, fill, right) {
  return left + fill.repeat(INNER) + right;
}

function line(content) {
  return `│ ${padVisible(content, INNER - 2)} │`;
}

/** Pretty date like "June 4, 2026". */
function longDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** Print the digest to stdout with chalk colours and a box-drawing frame. */
export function printDigest(digest) {
  const out = [];

  out.push(border('┌', '─', '┐'));
  out.push(line(chalk.bold('SpaceX IPO market cap — Polymarket daily digest')));
  out.push(line(chalk.dim(`${longDate(digest.date)} · 9:00 AM ET`)));
  out.push(border('├', '─', '┤'));

  // Implied median line, with day-over-day shift if available.
  let medianLine = `Implied median valuation:  ${chalk.cyan.bold(
    medianStr(digest.impliedMedian)
  )}`;
  if (
    digest.impliedMedian != null &&
    digest.impliedMedianPrior != null
  ) {
    const shift = digest.impliedMedian - digest.impliedMedianPrior;
    // Round first so a sub-cent shift reads as flat rather than "↓ -0.00T".
    const rounded = Number(shift.toFixed(2));
    const sign = rounded > 0 ? '↑ +' : rounded < 0 ? '↓ ' : '';
    const col = rounded > 0 ? chalk.green : rounded < 0 ? chalk.red : chalk.dim;
    const shiftTxt =
      rounded === 0
        ? chalk.dim('≈ flat vs yesterday')
        : col(`${sign}${rounded.toFixed(2)}T vs yesterday`);
    medianLine += `   (${shiftTxt})`;
  } else {
    medianLine += `   ${chalk.dim('(no prior day)')}`;
  }
  out.push(line(medianLine));
  out.push(border('├', '─', '┤'));

  // Table header.
  out.push(
    line(
      chalk.dim(
        `${'Threshold'.padEnd(12)}${'Today'.padEnd(9)}${'Yesterday'.padEnd(
          12
        )}Δ`
      )
    )
  );

  for (const r of digest.rows) {
    const marker = r.tracked ? chalk.cyan('●') : ' ';
    const labelCell = `${marker} ${r.label}`;
    const todayCell = pct(r.prob);
    const yCell = r.priorProb == null ? '—' : pct(r.priorProb);
    const dCell = deltaCell(r.delta);

    let content =
      padVisible(labelCell, 12) +
      padVisible(todayCell, 9) +
      padVisible(yCell, 12) +
      dCell;

    if (r.tracked) content = chalk.bold(content);
    if (r.delta != null && Math.abs(r.delta) >= SIGNIFICANT_DELTA) {
      content = chalk.yellow.bgBlackBright(
        padVisible(content, INNER - 2)
      );
    }
    out.push(line(content));
  }

  out.push(border('├', '─', '┤'));
  out.push(line(`${chalk.cyan('●')} = actively tracked threshold`));
  if (digest.isFirstRun) {
    out.push(line(chalk.dim('first run — no yesterday data to compare')));
  }
  out.push(border('└', '─', '┘'));

  console.log('\n' + out.join('\n') + '\n');
}
