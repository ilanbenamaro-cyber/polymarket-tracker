// db.js — SQLite persistence layer (better-sqlite3, synchronous API).
//
// Why this exists: stores one immutable snapshot of all thresholds per day
// plus a derived daily digest, so the tracker can compute day-over-day deltas
// and a future Jarvis daemon can read history without re-hitting the API.
// Schema is intentionally brain.db-compatible for that later import.

import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, 'polymarket.db');

// Single shared connection for the process lifetime.
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

/** Create tables and indexes if they do not already exist. Idempotent. */
export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_snapshots (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      captured_at  TEXT NOT NULL,
      date         TEXT NOT NULL,
      threshold    REAL NOT NULL,
      label        TEXT NOT NULL,
      prob         REAL NOT NULL,
      volume       REAL
    );

    CREATE TABLE IF NOT EXISTS daily_digests (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      date           TEXT NOT NULL UNIQUE,
      implied_median REAL NOT NULL,
      prob_1_8t      REAL NOT NULL,
      prob_2_0t      REAL NOT NULL,
      prob_2_4t      REAL NOT NULL,
      snapshot_json  TEXT NOT NULL,
      created_at     TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_date ON market_snapshots(date);
  `);
}

/**
 * Insert one row per market for the given date. No-op if any rows already
 * exist for that date (dedup key), so re-runs on the same day are safe.
 */
export function saveSnapshot(date, markets) {
  const existing = db
    .prepare('SELECT 1 FROM market_snapshots WHERE date = ? LIMIT 1')
    .get(date);
  if (existing) {
    console.log(`[db] snapshot for ${date} already exists — skipping insert`);
    return;
  }

  const capturedAt = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO market_snapshots
      (captured_at, date, threshold, label, prob, volume)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  // Wrap in a transaction so all rows land atomically.
  const insertMany = db.transaction((rows) => {
    for (const m of rows) {
      insert.run(capturedAt, date, m.threshold, m.label, m.prob, m.volume ?? null);
    }
  });
  insertMany(markets);
}

/**
 * Return the stored snapshot for a date as
 * Array<{label, threshold, prob, volume}> sorted ascending by threshold,
 * or null if nothing is stored for that date.
 */
export function getSnapshotForDate(date) {
  const rows = db
    .prepare(
      `SELECT label, threshold, prob, volume
         FROM market_snapshots
        WHERE date = ?
        ORDER BY threshold ASC`
    )
    .all(date);
  return rows.length > 0 ? rows : null;
}

/** Upsert the derived digest for a date (date is UNIQUE). */
export function saveDigest(date, digestObj) {
  db.prepare(
    `INSERT INTO daily_digests
        (date, implied_median, prob_1_8t, prob_2_0t, prob_2_4t, snapshot_json)
     VALUES (@date, @implied_median, @prob_1_8t, @prob_2_0t, @prob_2_4t, @snapshot_json)
     ON CONFLICT(date) DO UPDATE SET
        implied_median = excluded.implied_median,
        prob_1_8t      = excluded.prob_1_8t,
        prob_2_0t      = excluded.prob_2_0t,
        prob_2_4t      = excluded.prob_2_4t,
        snapshot_json  = excluded.snapshot_json`
  ).run({
    date,
    implied_median: digestObj.impliedMedian ?? 0,
    prob_1_8t: digestObj.prob_1_8t ?? 0,
    prob_2_0t: digestObj.prob_2_0t ?? 0,
    prob_2_4t: digestObj.prob_2_4t ?? 0,
    snapshot_json: JSON.stringify(digestObj.snapshot ?? []),
  });
}

/** Return the last n daily_digests rows, newest first. */
export function getRecentDigests(n) {
  return db
    .prepare(
      `SELECT * FROM daily_digests ORDER BY date DESC LIMIT ?`
    )
    .all(n);
}
