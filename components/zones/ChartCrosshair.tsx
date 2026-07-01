'use client';
// components/zones/ChartCrosshair.tsx — the ONE shared hover/crosshair overlay every chart uses.
//
// Why a single component: HistoryChart, DistributionSVG (CDF + density), the touch range bar and
// the categorical outcome bars all want the SAME interaction — a vertical crosshair that tracks the
// cursor and an edge-aware tooltip reading the exact value(s) at that x. Hand-rolling it per chart
// would drift; concentrating it here keeps the behaviour identical and the risk in one tested place.
//
// The pattern (per the plan): the underlying chart SVG stays SERVER-RENDERED and is passed as
// `children`; this client island layers a transparent, absolutely-positioned overlay SVG (same
// viewBox, preserveAspectRatio="none" so viewBox-x maps linearly onto the box) over it to capture
// pointer events, draw the crosshair line, and position an HTML tooltip. Only serializable data
// crosses the server→client boundary (numbers + pre-formatted strings) — never a function.
//
// Two modes, both driven by serializable props:
//   • snap        — discrete anchors (dates, bars); the nearest anchor's payload is shown verbatim.
//   • interpolate — continuous axes (CDF P(>X), touch P(touch)); values are linearly interpolated
//                   between the two bracketing anchors at the exact cursor x, then formatted.
// Pointer events (not mouse) unify mouse + touch: a tap/drag on mobile shows the same tooltip.

import { useRef, useState, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import { fmtNum, lerpAt, nearestAnchor, bracket } from '@/lib/chart-hover.mjs';

/** A single formatted line in the tooltip: an optional colour swatch (matching a series), a label
 *  and the value string. */
export interface TooltipRow { swatch?: string; label: string; value: string }
/** The full tooltip for one x-position: a bold title (the date/threshold) + the value rows. */
export interface TooltipPayload { title: string; rows: TooltipRow[] }
/** SNAP: one anchor per real data point. `x` is its viewBox X; `dots` (optional) draw markers on
 *  the crosshair at each series' y so the eye ties the tooltip rows to the plotted points. */
export interface SnapAnchor { x: number; payload: TooltipPayload; dots?: { y: number; color: string }[] }
/** A number→string format spec (serializable — no closures cross the RSC boundary). */
export interface NumFmt { prefix?: string; suffix?: string; digits?: number; scale?: number }
/** INTERPOLATE: one channel (tooltip row) whose value is lerped between anchors then formatted. */
export interface InterpChannel { label: string; swatch?: string; values: number[]; fmt: NumFmt }
/** INTERPOLATE config: anchorsVbX are the real points' viewBox X (ascending); the title is the
 *  interpolated domain value (threshold / price level); rows are the interpolated channels. */
export interface InterpConfig {
  anchorsVbX: number[];
  titleValues: number[];
  titleFmt: NumFmt;
  rows: InterpChannel[];
}

export interface ChartCrosshairProps {
  vbW: number; vbH: number;
  plotLeft: number; plotRight: number; plotTop: number; plotBottom: number;
  mode: 'snap' | 'interpolate';
  anchors?: SnapAnchor[];
  interp?: InterpConfig;
  ariaLabel?: string;
  children: ReactNode; // the server-rendered chart SVG
}

interface Hover { vbX: number; payload: TooltipPayload; dots?: { y: number; color: string }[] }

export function ChartCrosshair({
  vbW, vbH, plotLeft, plotRight, plotTop, plotBottom,
  mode, anchors, interp, ariaLabel, children,
}: ChartCrosshairProps) {
  const overlayRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  /** Map a client-space pointer to a resolved hover (crosshair x + tooltip), or null. */
  const resolve = (clientX: number): Hover | null => {
    const el = overlayRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) return null;
    // viewBox-x from the pointer: linear because the overlay uses preserveAspectRatio="none".
    const raw = ((clientX - rect.left) / rect.width) * vbW;
    const cursorVbX = Math.max(plotLeft, Math.min(plotRight, raw));

    if (mode === 'snap') {
      if (!anchors || anchors.length === 0) return null;
      const best = anchors[nearestAnchor(anchors.map((a) => a.x), cursorVbX)];
      return { vbX: best.x, payload: best.payload, dots: best.dots };
    }
    // interpolate: linearly blend the channels between the two bracketing anchors at the cursor
    if (!interp || interp.anchorsVbX.length === 0) return null;
    const { i, t } = bracket(interp.anchorsVbX, cursorVbX);
    const vbX = interp.anchorsVbX.length === 1 ? interp.anchorsVbX[0] : cursorVbX;
    return { vbX, payload: buildInterpPayload(interp, i, t) };
  };

  const onMove = (e: ReactPointerEvent<SVGSVGElement>) => setHover(resolve(e.clientX));
  const onLeave = () => setHover(null);

  // Tooltip horizontal placement (percent of width) with an edge flip near the right side so the
  // box never clips off the container. Anchored to the top of the plot area.
  const fx = hover ? hover.vbX / vbW : 0;
  const flip = fx > 0.6; // near the right edge → grow leftward
  const tipStyle: React.CSSProperties = hover
    ? {
        left: `${fx * 100}%`,
        top: `${(plotTop / vbH) * 100}%`,
        transform: flip ? 'translateX(calc(-100% - 8px))' : 'translateX(8px)',
      }
    : { display: 'none' };

  return (
    <div className="chart-hover" data-field="chart-hover">
      {children}
      <svg
        ref={overlayRef}
        className="chart-hover-overlay"
        viewBox={`0 0 ${vbW} ${vbH}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel ?? 'interactive chart overlay'}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={onLeave}
        onPointerCancel={onLeave}
      >
        {/* transparent capture rect over the WHOLE chart box so tracking is continuous even over
            the axis padding (the crosshair x still clamps to the plot range). touch-action:pan-y
            lets the page scroll vertically while a horizontal drag drives the crosshair. */}
        <rect className="chart-hover-capture" x={0} y={0} width={vbW} height={vbH} />
        {hover && (
          <g className="chart-hover-marks" pointerEvents="none">
            <line className="chart-cross-line" x1={hover.vbX} x2={hover.vbX} y1={plotTop} y2={plotBottom} />
            {hover.dots?.map((d, i) => (
              <circle key={i} className="chart-cross-dot" cx={hover.vbX} cy={d.y} r={2.8} style={{ fill: d.color }} />
            ))}
          </g>
        )}
      </svg>
      {hover && (
        <div className="chart-tip" style={tipStyle} role="status" aria-live="polite">
          <div className="chart-tip-title">{hover.payload.title}</div>
          {hover.payload.rows.map((r, i) => (
            <div key={i} className="chart-tip-row">
              {r.swatch && <span className="chart-tip-swatch" style={{ background: r.swatch }} />}
              <span className="chart-tip-label">{r.label}</span>
              <span className="chart-tip-value">{r.value}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Build the interpolated tooltip payload at bracket (i, t). */
function buildInterpPayload(interp: InterpConfig, i: number, t: number): TooltipPayload {
  return {
    title: fmtNum(lerpAt(interp.titleValues, i, t), interp.titleFmt),
    rows: interp.rows.map((ch) => ({
      swatch: ch.swatch,
      label: ch.label,
      value: fmtNum(lerpAt(ch.values, i, t), ch.fmt),
    })),
  };
}
