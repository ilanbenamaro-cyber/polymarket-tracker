// templates.js — Outlook-compatible HTML email templates.
//
// Why this exists: email clients (especially desktop Outlook, which renders via
// Word's HTML engine) strip <style> blocks, flexbox, grid, and CSS variables.
// So every template here is built from nested tables with ALL styles inline,
// fixed 600px width, Arial, px units only, and no border-radius. Do not
// "modernise" these into semantic CSS — it will break in Outlook.

// Palette (plain constants — NOT CSS custom properties; those don't work in email).
const BG_DARK = '#111110';
const BG_CARD = '#1c1c1a';
const AMBER = '#BA7517';
const AMBER_BG = '#2a2218';
const BLUE = '#185FA5';
const TEXT_MAIN = '#e8e6df';
const TEXT_MUTED = '#9a9890';
const GREEN = '#15803D';
const RED = '#B91C1C';
const YELLOW_BG = '#2a2210';

const FONT = 'Arial, Helvetica, sans-serif';
const MARKET_URL =
  'https://polymarket.com/event/spacex-ipo-closing-market-cap-above';
const RESOLVES = 'Dec 31, 2027';
// Thresholds surfaced prominently in amber, matching the terminal digest.
const TRACKED = new Set([1.8, 2.4]);
const SIGNIFICANT_DELTA = 0.05;

// ── small formatting helpers ────────────────────────────────────────────────

function pct(p) {
  return p == null ? '—' : `${Math.round(p * 100)}%`;
}

function medianStr(m) {
  return m == null ? 'n/a' : `$${m.toFixed(2)}T`;
}

/** HTML-escape user/string content before embedding in markup. */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Coloured median-delta fragment vs a prior value. */
function medianDeltaHtml(impliedMedian, priorMedian) {
  if (impliedMedian == null) return '';
  if (priorMedian == null) {
    return `<span style="color:${TEXT_MUTED};font-size:13px;"> (no prior data)</span>`;
  }
  const shift = Number((impliedMedian - priorMedian).toFixed(2));
  if (shift === 0) {
    return `<span style="color:${TEXT_MUTED};font-size:13px;"> (flat vs prior)</span>`;
  }
  const color = shift > 0 ? GREEN : RED;
  const arrow = shift > 0 ? '↑ +' : '↓ ';
  return `<span style="color:${color};font-size:13px;font-weight:bold;"> ${arrow}$${Math.abs(
    shift
  ).toFixed(2)}T</span>`;
}

/** One coloured probability-delta cell (returns inner HTML for a <td>). */
function deltaCellHtml(delta) {
  if (delta == null) return `<span style="color:${TEXT_MUTED};">—</span>`;
  const pp = Math.round(delta * 100);
  if (pp === 0) return `<span style="color:${TEXT_MUTED};">—</span>`;
  const color = pp > 0 ? GREEN : RED;
  const arrow = pp > 0 ? '↑ +' : '↓ ';
  return `<span style="color:${color};font-weight:bold;">${arrow}${Math.abs(
    pp
  )}%</span>`;
}

/** Map a prior markets array into a threshold→prob lookup. */
function priorLookup(prior) {
  const map = new Map();
  for (const m of prior ?? []) map.set(m.threshold, m.prob);
  return map;
}

// ── shared chrome ───────────────────────────────────────────────────────────

/** Wrap inner table rows in the 600px centered outer/inner table shell. */
function shell(innerRows) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
</head>
<body style="margin:0;padding:0;background-color:${BG_DARK};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${BG_DARK};">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background-color:${BG_DARK};font-family:${FONT};">
${innerRows}
</table>
</td></tr>
</table>
</body>
</html>`;
}

function headerRow(badgeBg, badgeColor, badgeText, dateText) {
  return `<tr><td style="padding:20px;background-color:${BG_DARK};">
  <div style="font-family:${FONT};font-size:18px;font-weight:bold;color:${TEXT_MAIN};">SpaceX IPO Market Cap</div>
  <div style="font-family:${FONT};font-size:12px;color:${TEXT_MUTED};padding-top:2px;">Polymarket</div>
  <div style="padding-top:10px;">
    <span style="display:inline-block;padding:3px 10px;background-color:${badgeBg};color:${badgeColor};font-family:${FONT};font-size:11px;font-weight:bold;letter-spacing:0.5px;">${badgeText}</span>
  </div>
  <div style="font-family:${FONT};font-size:12px;color:${TEXT_MUTED};padding-top:8px;">${esc(
    dateText
  )}</div>
</td></tr>`;
}

function footerRow() {
  return `<tr><td style="padding:16px 20px;background-color:#0d0d0c;">
  <div style="font-family:${FONT};font-size:12px;"><a href="${MARKET_URL}" style="color:${BLUE};text-decoration:none;">View market on Polymarket</a></div>
  <div style="font-family:${FONT};font-size:11px;color:${TEXT_MUTED};padding-top:6px;">● = actively tracked &nbsp;·&nbsp; Resolves ${RESOLVES}</div>
  <div style="font-family:${FONT};font-size:11px;color:${TEXT_MUTED};padding-top:6px;">To unsubscribe, reply to this email with "unsubscribe".</div>
</td></tr>`;
}

/** The data table (THRESHOLD | TODAY | PRIOR | Δ). */
function dataTableRows(markets, prior) {
  const priorMap = priorLookup(prior);
  const header = `<tr style="background-color:#1a1a18;">
    <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:11px;font-weight:bold;text-transform:uppercase;color:${TEXT_MUTED};">Threshold</th>
    <th align="right" style="padding:8px 12px;font-family:${FONT};font-size:11px;font-weight:bold;text-transform:uppercase;color:${TEXT_MUTED};">Today</th>
    <th align="right" style="padding:8px 12px;font-family:${FONT};font-size:11px;font-weight:bold;text-transform:uppercase;color:${TEXT_MUTED};">Prior</th>
    <th align="right" style="padding:8px 12px;font-family:${FONT};font-size:11px;font-weight:bold;text-transform:uppercase;color:${TEXT_MUTED};">&Delta;</th>
  </tr>`;

  const rows = markets
    .map((m, i) => {
      const priorProb = priorMap.has(m.threshold)
        ? priorMap.get(m.threshold)
        : null;
      const delta = priorProb == null ? null : m.prob - priorProb;
      const tracked = TRACKED.has(m.threshold);
      const significant = delta != null && Math.abs(delta) >= SIGNIFICANT_DELTA;

      // Row background: significant > tracked > alternating default.
      let rowBg = i % 2 === 0 ? BG_DARK : '#151513';
      if (tracked) rowBg = AMBER_BG;
      if (significant) rowBg = YELLOW_BG;

      const labelColor = tracked ? AMBER : TEXT_MAIN;
      const probColor = tracked ? AMBER : TEXT_MAIN;
      const labelWeight = tracked ? 'bold' : 'normal';
      const dot = tracked ? '● ' : '';

      return `<tr style="background-color:${rowBg};">
      <td align="left" style="padding:8px 12px;font-family:${FONT};font-size:13px;color:${labelColor};font-weight:${labelWeight};">${dot}${esc(
        m.label
      )}</td>
      <td align="right" style="padding:8px 12px;font-family:${FONT};font-size:13px;color:${probColor};font-weight:bold;">${pct(
        m.prob
      )}</td>
      <td align="right" style="padding:8px 12px;font-family:${FONT};font-size:13px;color:${TEXT_MUTED};">${pct(
        priorProb
      )}</td>
      <td align="right" style="padding:8px 12px;font-family:${FONT};font-size:13px;">${deltaCellHtml(
        delta
      )}</td>
    </tr>`;
    })
    .join('\n');

  return `<tr><td style="padding:0 20px 20px 20px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
    ${header}
    ${rows}
  </table>
</td></tr>`;
}

function medianRow(impliedMedian, priorMedian) {
  return `<tr><td style="padding:20px;background-color:${BG_CARD};">
  <div style="font-family:${FONT};font-size:12px;color:${TEXT_MUTED};">Implied median valuation</div>
  <div style="padding-top:4px;">
    <span style="font-family:${FONT};font-size:32px;font-weight:bold;color:${BLUE};">${medianStr(
    impliedMedian
  )}</span>${medianDeltaHtml(impliedMedian, priorMedian)}
  </div>
</td></tr>`;
}

// ── public builders ─────────────────────────────────────────────────────────

/**
 * Daily digest email. mode is 'market-open' | 'market-close'.
 * Returns { subject, html, text }.
 */
export function buildDigestEmail({
  mode,
  date,
  markets,
  prior,
  impliedMedian,
  priorMedian,
}) {
  const isOpen = mode === 'market-open';
  const badgeText = isOpen ? 'MARKET OPEN' : 'MARKET CLOSE';
  const badgeBg = isOpen ? '#0d2a4a' : '#1a2a0d';
  const badgeColor = isOpen ? '#5B9BD5' : '#4a9a4a';
  const subject = `SpaceX IPO Market · ${
    isOpen ? 'Market Open' : 'Market Close'
  } · ${date}`;

  const html = shell(
    headerRow(badgeBg, badgeColor, badgeText, `${date} · 9:00 AM ET`) +
      medianRow(impliedMedian, priorMedian) +
      dataTableRows(markets, prior) +
      footerRow()
  );

  const text =
    `SpaceX IPO Market — ${badgeText} — ${date}\n` +
    `Implied median: ${medianStr(impliedMedian)}\n` +
    markets.map((m) => `${m.label}: ${pct(m.prob)}`).join('\n');

  return { subject, html, text };
}

/**
 * Alert email for significant moves. moves is
 * Array<{label, before, after, delta}>. Returns { subject, html, text }.
 */
export function buildAlertEmail({ date, moves }) {
  const subject = `⚑ SpaceX IPO Market · ${moves.length} significant move${
    moves.length === 1 ? '' : 's'
  } · ${date}`;

  const rows = moves
    .map((mv) => {
      const delta = mv.after - mv.before;
      return `<tr style="background-color:${YELLOW_BG};">
      <td align="left" style="padding:8px 12px;font-family:${FONT};font-size:13px;color:${TEXT_MAIN};font-weight:bold;">${esc(
        mv.label
      )}</td>
      <td align="right" style="padding:8px 12px;font-family:${FONT};font-size:13px;color:${TEXT_MUTED};">${pct(
        mv.before
      )} → ${pct(mv.after)}</td>
      <td align="right" style="padding:8px 12px;font-family:${FONT};font-size:13px;">${deltaCellHtml(
        delta
      )}</td>
    </tr>`;
    })
    .join('\n');

  const html = shell(
    headerRow('#2a2210', AMBER, 'MOVEMENT ALERT', `${date} · ${moves.length} threshold(s) moved ≥5%`) +
      `<tr><td style="padding:20px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">
        <tr style="background-color:#1a1a18;">
          <th align="left" style="padding:8px 12px;font-family:${FONT};font-size:11px;font-weight:bold;text-transform:uppercase;color:${TEXT_MUTED};">Threshold</th>
          <th align="right" style="padding:8px 12px;font-family:${FONT};font-size:11px;font-weight:bold;text-transform:uppercase;color:${TEXT_MUTED};">Move</th>
          <th align="right" style="padding:8px 12px;font-family:${FONT};font-size:11px;font-weight:bold;text-transform:uppercase;color:${TEXT_MUTED};">&Delta;</th>
        </tr>
        ${rows}
        </table>
      </td></tr>` +
      footerRow()
  );

  const text =
    `SpaceX IPO Market — MOVEMENT ALERT — ${date}\n` +
    moves
      .map(
        (mv) =>
          `${mv.label}: ${pct(mv.before)} → ${pct(mv.after)} (${
            mv.after - mv.before >= 0 ? '+' : ''
          }${Math.round((mv.after - mv.before) * 100)}%)`
      )
      .join('\n');

  return { subject, html, text };
}

/** Welcome / subscription-confirmation email. Returns { subject, html, text }. */
export function buildWelcomeEmail({ email }) {
  const subject = 'Subscribed · SpaceX IPO Market Tracker';
  const html = shell(
    headerRow('#0d2a4a', '#5B9BD5', 'SUBSCRIBED', 'Welcome') +
      `<tr><td style="padding:20px;background-color:${BG_CARD};">
        <div style="font-family:${FONT};font-size:14px;color:${TEXT_MAIN};line-height:20px;">
          You're subscribed to the SpaceX IPO market-cap tracker.
        </div>
        <div style="font-family:${FONT};font-size:13px;color:${TEXT_MUTED};line-height:20px;padding-top:12px;">
          You'll receive a digest at <b style="color:${TEXT_MAIN};">market open (9:30 AM ET)</b> and
          <b style="color:${TEXT_MAIN};">market close (4:00 PM ET)</b> on weekdays, plus an immediate
          alert whenever any threshold moves by 5% or more.
        </div>
        <div style="font-family:${FONT};font-size:12px;color:${TEXT_MUTED};line-height:18px;padding-top:12px;">
          Subscribed address: ${esc(email)}
        </div>
      </td></tr>` +
      footerRow()
  );
  const text =
    `You're subscribed to the SpaceX IPO market-cap tracker (${email}).\n` +
    `Digests at market open (9:30 AM ET) and close (4:00 PM ET) on weekdays, ` +
    `plus alerts on any ≥5% threshold move.`;
  return { subject, html, text };
}

/** Static sample email used to verify the Graph + template pipeline end-to-end. */
export function buildTestEmail() {
  const markets = [
    { label: '>$1.8T', threshold: 1.8, prob: 0.62, volume: 100000 },
    { label: '>$2T', threshold: 2.0, prob: 0.41, volume: 80000 },
    { label: '>$2.4T', threshold: 2.4, prob: 0.22, volume: 50000 },
  ];
  const built = buildDigestEmail({
    mode: 'market-open',
    date: new Date().toISOString().split('T')[0],
    markets,
    prior: null,
    impliedMedian: 1.91,
    priorMedian: null,
  });
  return {
    subject: '[TEST] SpaceX IPO Market Tracker · Email Config Check',
    html: built.html,
    text: built.text,
  };
}
