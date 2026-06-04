// scripts/add-subscriber.js — add (or reactivate) an email subscriber.
//
// Why this exists: invoked by the subscribe workflow (triggered by the public
// dashboard form via workflow_dispatch). It validates the address, upserts it
// into the private Gist's subscribers.json, and sends a welcome email so the
// subscriber gets immediate confirmation.
//
// Usage: node scripts/add-subscriber.js <email>

import 'dotenv/config';
import { sendEmail } from '../email.js';
import { buildWelcomeEmail } from '../templates.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const GIST_API = (id) => `https://api.github.com/gists/${id}`;

function gistHeaders() {
  return {
    Authorization: `Bearer ${process.env.GIST_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };
}

/** Read and parse subscribers.json from the Gist. */
async function readSubscribers() {
  const res = await fetch(GIST_API(process.env.GIST_ID), {
    headers: gistHeaders(),
  });
  if (!res.ok) throw new Error(`Gist GET ${res.status} ${res.statusText}`);
  const gist = await res.json();
  const file = gist.files?.['subscribers.json'];
  if (!file) throw new Error('subscribers.json not found in Gist');
  const parsed = JSON.parse(file.content);
  if (!Array.isArray(parsed.subscribers)) parsed.subscribers = [];
  return parsed;
}

/** Write the updated subscribers object back to the Gist. */
async function writeSubscribers(data) {
  const res = await fetch(GIST_API(process.env.GIST_ID), {
    method: 'PATCH',
    headers: gistHeaders(),
    body: JSON.stringify({
      files: {
        'subscribers.json': { content: JSON.stringify(data, null, 2) },
      },
    }),
  });
  if (!res.ok) throw new Error(`Gist PATCH ${res.status} ${res.statusText}`);
}

async function main() {
  const email = (process.argv[2] || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    console.error(`Invalid email address: "${process.argv[2]}"`);
    process.exit(1);
  }

  const data = await readSubscribers();
  const existing = data.subscribers.find((s) => s.email === email);

  if (existing && existing.active === true) {
    console.log(`Already subscribed: ${email}`);
    return;
  }

  if (existing) {
    // Reactivate a previously-unsubscribed address.
    existing.active = true;
    existing.added_at = new Date().toISOString();
  } else {
    data.subscribers.push({
      email,
      active: true,
      added_at: new Date().toISOString(),
    });
  }

  await writeSubscribers(data);

  // Welcome email is best-effort: the subscription itself already succeeded, so
  // don't fail the run if mail delivery hiccups.
  try {
    const welcome = buildWelcomeEmail({ email });
    await sendEmail({
      to: email,
      subject: welcome.subject,
      html: welcome.html,
      text: welcome.text,
    });
  } catch (err) {
    console.warn(`[add-subscriber] welcome email failed: ${err.message}`);
  }

  console.log(`✓ Subscribed: ${email}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
