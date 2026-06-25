'use client';
// components/zones/KeyboardShortcuts.tsx — the single global keyboard handler (Enh 8).
//
// The ONLY window keydown listener for app shortcuts (one place to map keys → bus events,
// which also keeps the legend honest). Mounted once in the app layout. Maps:
//   J / ↓  → next market · K / ↑ → prev · Enter → open focused · R → refresh ·
//   H → verify hash · Esc → close search / deselect · ? → this legend (⌘K is the
//   search island's own).
// Guards: never hijack typing (input/textarea/select/contentEditable), never override
// modifier combos (so ⌘K reaches MarketSearch), and only act on Enter when nothing
// interactive is focused (so a focused button/link keeps its native Enter).
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { KBD, emit } from './kbd';

const SHORTCUTS: Array<[string, string]> = [
  ['J  ↓', 'Next market'],
  ['K  ↑', 'Previous market'],
  ['Enter', 'Open focused market'],
  ['R', 'Refresh current market'],
  ['H', 'Verify hash'],
  ['Esc', 'Close search · deselect'],
  ['⌘K', 'Search markets'],
  ['?', 'Toggle this legend'],
];

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}
function isInteractive(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'BUTTON' || el.tagName === 'A' || isTyping(t);
}

export function KeyboardShortcuts() {
  const router = useRouter();
  const [legend, setLegend] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Legend: "?" (shift+/) or ⌘/Ctrl-/. Toggles even over a focused button, but not while typing.
      if (e.key === '?' || ((e.metaKey || e.ctrlKey) && e.key === '/')) {
        if (!isTyping(e.target)) { e.preventDefault(); setLegend((v) => !v); }
        return;
      }
      if (e.key === 'Escape') {
        if (legend) { setLegend(false); return; }
        const overlay = document.querySelector('[data-field="search-overlay"]');
        emit(KBD.escape); // close the search overlay + clear rail focus
        if (!overlay) router.push('/'); // nothing open → deselect the current market
        return;
      }
      // Leave modifier combos (⌘K …) and typing to their own handlers.
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;

      switch (e.key) {
        case 'j': case 'ArrowDown': e.preventDefault(); emit(KBD.nav, { dir: 1 }); break;
        case 'k': case 'ArrowUp': e.preventDefault(); emit(KBD.nav, { dir: -1 }); break;
        case 'r': case 'R': e.preventDefault(); emit(KBD.refresh); break;
        case 'h': case 'H': e.preventDefault(); emit(KBD.hash); break;
        case 'Enter':
          if (!isInteractive(e.target)) { e.preventDefault(); emit(KBD.open); }
          break;
        default: break;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [legend, router]);

  if (!legend) return null;
  return (
    <div className="kbd-legend-backdrop" onClick={() => setLegend(false)} data-field="kbd-legend">
      <div className="kbd-legend" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <div className="kbd-legend-head label">Keyboard shortcuts</div>
        <ul className="kbd-legend-list">
          {SHORTCUTS.map(([k, d]) => (
            <li key={k}><kbd>{k}</kbd><span>{d}</span></li>
          ))}
        </ul>
        <div className="kbd-legend-foot faint">Esc or ? to close</div>
      </div>
    </div>
  );
}
