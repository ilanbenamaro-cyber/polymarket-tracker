// components/zones/VolumeCard.tsx — Increment 1: the windowed-volume key-metric card.
//
// All-time cumulative volume is a poor liquidity proxy (a dormant market reads identical to an
// active one), so the card leads with 24h volume — the primary recent-liquidity signal — and keeps
// 7d + all-time in the sub-line: "24h $X" over "7d $Y · all-time $Z". When a record predates the
// windowed feature (derived.liquidity absent), it degrades to the all-time total. Server component.
import { fmtVolHuman } from '@/lib/format-detail.mjs';

interface Liquidity { volume_24hr?: number | null; volume_1wk?: number | null; volume_all?: number | null }

export function VolumeCard({ liquidity, allTimeVolume }: { liquidity?: Liquidity | null; allTimeVolume?: number | null }) {
  const v24 = liquidity?.volume_24hr ?? null;
  const v7 = liquidity?.volume_1wk ?? null;
  const all = allTimeVolume ?? liquidity?.volume_all ?? null;
  const hasWindowed = v24 != null || v7 != null;
  const sub = hasWindowed
    ? [v7 != null ? `7d ${fmtVolHuman(v7)}` : null, all != null ? `all-time ${fmtVolHuman(all)}` : null].filter(Boolean).join(' · ')
    : 'cumulative, all-time';
  return (
    <div className="acard" data-field="volume-card">
      <div className="label">Volume <span className="faint">· {hasWindowed ? '24h' : 'all-time'}</span></div>
      <div className="acard-v" data-field="volume-24h">
        {hasWindowed ? (v24 != null ? fmtVolHuman(v24) : '—') : (all != null ? fmtVolHuman(all) : '—')}
      </div>
      <div className="acard-s faint" data-field="volume-windows">{sub || '—'}</div>
    </div>
  );
}
