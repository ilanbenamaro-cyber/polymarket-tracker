// tracker.js — main entry point for the daily Polymarket SpaceX-IPO tracker.
//
// Why this exists: orchestrates the daily pipeline — fetch live data, persist
// one snapshot per day, derive + store the digest, print it, and notify on
// significant moves. Designed to be invoked by pm2 cron and, later, imported
// piecemeal by the Jarvis daemon.

import { fetchSnapshot } from './api.js';
import {
  initDb,
  saveSnapshot,
  getSnapshotForDate,
  saveDigest,
} from './db.js';
import { generateDigest, printDigest } from './digest.js';
import { notifyIfWarranted } from './notify.js';

const DAY_MS = 86_400_000;

async function main() {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

  initDb();

  const snapshot = await fetchSnapshot();
  if (!snapshot) {
    console.error('API fetch failed — aborting run');
    process.exit(1);
  }

  if (!getSnapshotForDate(today)) {
    saveSnapshot(today, snapshot);
  } else {
    console.log(`Snapshot for ${today} already stored — skipping insert`);
  }

  const yesterday = new Date(Date.now() - DAY_MS).toISOString().split('T')[0];
  const prior = getSnapshotForDate(yesterday);

  const digest = generateDigest(today, snapshot, prior);
  saveDigest(today, digest);
  printDigest(digest);
  notifyIfWarranted(digest);
}

// Exit explicitly on success: under pm2 fork mode an IPC channel to the daemon
// stays ref'd and would otherwise keep this one-shot process "online" forever
// instead of finishing and letting the daily cron relaunch it fresh.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Tracker failed:', err.message);
    process.exit(1);
  });
