// components/zones/CommandBar.tsx — top command bar. Houses Zone 3 (search+add)
// as a terminal-style command input (keeps the detail zone maximally wide), plus
// brand + the signed-in user / logout. 2c.1: the search input is an inert shell;
// Polymarket search + compute-then-add is wired in 2c.4.
import { LogoutButton } from '@/components/LogoutButton';

export function CommandBar({ userEmail }: { userEmail: string }) {
  return (
    <header className="cmdbar cmdbar-row">
      <div className="cmdbar-brand">
        <span className="num">PM</span> TERMINAL
      </div>

      {/* Zone 3 shell — search command line (inert in 2c.1) */}
      <div className="cmdbar-search" data-zone="search" aria-disabled>
        <span className="faint mono">/</span>
        <input className="cmdbar-input mono" placeholder="search markets…  (2c.4)" disabled />
      </div>

      <div className="cmdbar-user">
        <span className="mono faint" title={userEmail}>{userEmail}</span>
        <LogoutButton />
      </div>

      <style>{`
        .cmdbar-row { display:flex; align-items:center; gap:var(--sp-4); padding:0 var(--sp-4); }
        .cmdbar-brand { font-size:var(--fs-body); font-weight:700; letter-spacing:0.5px; white-space:nowrap; }
        .cmdbar-brand .num { color:var(--accent-amber); font-family:var(--font-mono); }
        .cmdbar-search { flex:1; display:flex; align-items:center; gap:var(--sp-2);
          background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius-sm);
          padding:5px var(--sp-3); max-width:520px; }
        .cmdbar-input { flex:1; background:transparent; border:none; color:var(--text);
          font-size:var(--fs-tiny); outline:none; }
        .cmdbar-input::placeholder { color:var(--text-faint); }
        .cmdbar-user { display:flex; align-items:center; gap:var(--sp-3); margin-left:auto;
          font-size:var(--fs-tiny); max-width:40vw; overflow:hidden; }
        .cmdbar-user span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      `}</style>
    </header>
  );
}
