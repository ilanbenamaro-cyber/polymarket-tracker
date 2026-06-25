// components/zones/kbd.ts — the keyboard-shortcut event bus (Enh 8).
//
// One global key handler (KeyboardShortcuts) maps keys → these window CustomEvents; the
// rail / refresh / hash / search islands each listen for the one they care about. A bus
// (not prop-drilling or a context) because the listeners live in unrelated subtrees and
// the producer is a single layout-level component. Client-only (emit touches window).

export const KBD = {
  nav: 'kbd:nav', // detail: { dir: 1 | -1 } — move the rail focus cursor
  open: 'kbd:open', // open the focused rail row in the detail
  refresh: 'kbd:refresh', // force-recompute the current market
  hash: 'kbd:hash', // run the in-browser hash verification
  escape: 'kbd:escape', // close the search overlay / clear rail focus
} as const;

/** Dispatch a bus event. Guarded for SSR (no-op if window is absent). */
export function emit(name: string, detail?: unknown): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}
