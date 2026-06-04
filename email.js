// email.js — Microsoft Graph API email sender (native fetch, no SDK).
//
// Why this exists: the cloud automation (GitHub Actions) needs to send HTML
// digest/alert/welcome emails without a mail server. This uses the Microsoft
// Graph client-credentials flow against a corporate Microsoft 365 tenant —
// app-only auth, no user sign-in — so it runs headless in CI.
//
// Personal Outlook.com accounts: use smtp-mail.outlook.com + nodemailer instead.
// Corporate Microsoft 365: this file is correct. SMTP AUTH is disabled by
// default on M365, so the Graph API is the only reliable path.

import 'dotenv/config';

const TOKEN_URL = (tenant) =>
  `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
const GRAPH_SENDMAIL_URL = (from) =>
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`;

// Refresh a little before the real expiry to avoid using a token mid-flight.
const EXPIRY_SKEW_MS = 60_000;

// Module-level token cache shared across calls in a single process run.
let cachedToken = null;
let tokenExpiresAt = 0; // epoch ms

/** Throw if any required env var is missing, listing all that are absent. */
function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    throw new Error(`Missing required env var(s): ${missing.join(', ')}`);
  }
}

/**
 * Get a valid Graph access token, using the module cache when still fresh.
 * Uses the OAuth2 client-credentials grant (app-only).
 */
async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - EXPIRY_SKEW_MS) {
    return cachedToken;
  }

  requireEnv(['GRAPH_TENANT_ID', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET']);

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.GRAPH_CLIENT_ID,
    client_secret: process.env.GRAPH_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
  });

  const res = await fetch(TOKEN_URL(process.env.GRAPH_TENANT_ID), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Graph token failed: ${data.error} — ${data.error_description}`
    );
  }

  cachedToken = data.access_token;
  // expires_in is seconds from now.
  tokenExpiresAt = Date.now() + Number(data.expires_in) * 1000;
  return cachedToken;
}

/**
 * Send an HTML email via Graph. `to` may be a single address or an array.
 * Returns { status: 202, recipients } on success; throws on failure.
 */
export async function sendEmail({ to, subject, text, html }) {
  requireEnv([
    'GRAPH_TENANT_ID',
    'GRAPH_CLIENT_ID',
    'GRAPH_CLIENT_SECRET',
    'MAIL_FROM',
  ]);

  const token = await getAccessToken();
  const addresses = Array.isArray(to) ? to : [to];
  const toRecipients = addresses.map((address) => ({
    emailAddress: { address },
  }));

  const payload = {
    message: {
      subject,
      body: { contentType: 'HTML', content: html ?? text ?? '' },
      toRecipients,
    },
    saveToSentItems: true,
  };

  const res = await fetch(GRAPH_SENDMAIL_URL(process.env.MAIL_FROM), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  // Graph returns 202 Accepted with no body on success.
  if (res.status === 202) {
    return { status: 202, recipients: addresses };
  }

  const errBody = await res.json().catch(() => ({}));
  const detail = errBody?.error?.message ?? res.statusText;
  throw new Error(`Graph sendMail failed (${res.status}): ${detail}`);
}
