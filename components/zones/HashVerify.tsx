'use client';
// components/zones/HashVerify.tsx — the trust-layer centerpiece: independently
// re-hash the published raw inputs IN THE BROWSER and confirm it matches the
// published sha256. The canonical string is produced SERVER-SIDE by core/fetch.js
// `canonicalizeRawInputs` (the one true recipe — reused, never re-implemented; it
// can't be imported client-side because core/fetch.js pulls node:crypto). The client
// only does the SHA-256 over that exact canonical string via crypto.subtle, so the
// check is honest (published_hash === sha256(core-canonical(raw_inputs))) without
// duplicating the recipe or touching the verified backend.

import { useEffect, useState } from 'react';
import { KBD } from './kbd';

type State = 'idle' | 'verifying' | 'ok' | 'bad' | 'error';

async function sha256Hex(str: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function HashVerify({ canonical, publishedHash }: { canonical: string; publishedHash: string }) {
  const [state, setState] = useState<State>('idle');

  async function onVerify() {
    setState('verifying');
    try {
      const got = await sha256Hex(canonical);
      setState(got === publishedHash ? 'ok' : 'bad');
    } catch {
      setState('error'); // crypto.subtle requires a secure context; surface, don't swallow
    }
  }

  // Enh 8: the global 'H' shortcut runs the in-browser hash verification for the current
  // market (one HashVerify per detail). Ignored while a verify is already in flight.
  useEffect(() => {
    function onKbd() { if (state !== 'verifying') onVerify(); }
    window.addEventListener(KBD.hash, onKbd);
    return () => window.removeEventListener(KBD.hash, onKbd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, canonical, publishedHash]);

  return (
    <span className="hashverify">
      <code className="prov-hash" title={publishedHash}>{publishedHash.slice(0, 16)}…</code>
      <button type="button" className="verify-btn" onClick={onVerify} disabled={state === 'verifying'} data-field="verify-btn">
        {state === 'verifying' ? 'verifying…' : 'verify hash'}
      </button>
      {state === 'ok' && <span className="verify-state ok" data-field="verify-state">✓ verified</span>}
      {state === 'bad' && <span className="verify-state bad" data-field="verify-state">✗ mismatch</span>}
      {state === 'error' && <span className="verify-state bad" data-field="verify-state">verify unavailable</span>}
    </span>
  );
}
