// core/touch.js — directional-touch market core (WTI/Silver "(LOW)/(HIGH) hit $X").
//
// These markets price the probability that the price TOUCHES a level before expiry —
// P(max ≥ X) for a HIGH leg, P(min ≤ X) for a LOW leg. That is NOT a settlement
// distribution: there is no survival curve and no implied median (forcing one was the old
// bug). The honest, useful signal is the IMPLIED RANGE — the band between the two 50%
// crossovers: the HIGH series (decreasing) crossing 0.5 is the upper bound (50% chance of
// breaking above), the LOW series (increasing) crossing 0.5 is the lower bound (50% chance
// of breaking below). Pure; values are absolute dollars (core/money.parseMoney).

import { parseMoney } from './money.js';

const SIDE_RE = /\((LOW|HIGH)\)/i;

/** A touch leg's question → { side:'HIGH'|'LOW', level } in absolute $, or null. */
export function parseTouchLeg(question) {
  if (question == null) return null;
  const s = String(question);
  const side = s.match(SIDE_RE);
  const money = parseMoney(s);
  if (!side || !money) return null;
  return { side: side[1].toUpperCase(), level: money.value };
}

/** Interpolated level where a DECREASING series first crosses below S (or null). */
function crossDown(series, S) {
  const s = [...series].sort((a, b) => a.level - b.level);
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i].prob >= S && s[i + 1].prob < S) {
      return s[i].level + ((s[i + 1].level - s[i].level) * (s[i].prob - S)) / (s[i].prob - s[i + 1].prob);
    }
  }
  return null;
}

/** Interpolated level where an INCREASING series first crosses above S (or null). */
function crossUp(series, S) {
  const s = [...series].sort((a, b) => a.level - b.level);
  for (let i = 0; i < s.length - 1; i++) {
    if (s[i].prob <= S && s[i + 1].prob > S) {
      return s[i].level + ((s[i + 1].level - s[i].level) * (S - s[i].prob)) / (s[i + 1].prob - s[i].prob);
    }
  }
  return null;
}

/**
 * Implied trading range from the touch series, at confidence S (default 0.5).
 *   highSeries: [{ level, prob:P(touch ≥ level) }]  (decreasing → upper bound)
 *   lowSeries:  [{ level, prob:P(touch ≤ level) }]  (increasing → lower bound)
 * A bound is null when its series never crosses S (no false precision — Bug 5 ethos).
 */
export function impliedRange(highSeries, lowSeries, S = 0.5) {
  return { low: crossUp(lowSeries, S), high: crossDown(highSeries, S), confidence: S };
}
