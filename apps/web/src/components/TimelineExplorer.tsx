import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import type { DeepReport, ReportEvent } from '@simsam/models';

interface Props {
  events: ReportEvent[];
  eras: DeepReport['eras'];
  parts: { n: number; title: string }[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}

const PAD = 16;
const ERA_H = 26;
const LANE_H = 72;
/** Within a lane: the part's name, the upper label row, the events, the lower label row. */
const NAME_Y = 12;
const ROW1_Y = 31;
const DOT_Y = 44;
const ROW2_Y = 64;
const AXIS_H = 30;
/** The closest zoom: about a month across the whole width. */
const MIN_SPAN = 1 / 12;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const yearLabel = (y: number) => (y < 0 ? `${-y} BCE` : String(y));

/** Readable tick positions for the span in view: centuries down to months. */
function ticks(d0: number, d1: number, plotW: number) {
  const steps = [1000, 500, 200, 100, 50, 25, 10, 5, 2, 1, 0.5, 0.25, 1 / 12];
  const fits = steps.filter((s) => (d1 - d0) / s <= plotW / 84);
  const step = fits.length ? fits[fits.length - 1] : steps[0];
  const out: { t: number; label: string }[] = [];
  for (let k = Math.ceil(d0 / step - 1e-9); k * step <= d1 + 1e-9 && out.length < 200; k++) {
    const t = k * step;
    const year = Math.floor(t + 1e-6);
    const month = Math.round((t - year) * 12) % 12;
    out.push({ t, label: step < 1 ? `${MONTHS[month]} ${yearLabel(year)}` : yearLabel(Math.round(t)) });
  }
  return out;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * The report's timeline: one lane per part, eras on top. Drag to move, scroll
 * or pinch to zoom; more events and labels appear as you zoom in (details
 * only when zoomed in). Keyboard: arrows move, + and − zoom, 0 shows all.
 */
export function TimelineExplorer({ events, eras, parts, selected, onSelect }: Props) {
  const [box, width] = useWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);

  const extent = useMemo<[number, number]>(() => {
    const lo = Math.min(...events.map((e) => e.start));
    const hi = Math.max(...events.map((e) => e.end ?? e.start));
    const pad = Math.max((hi - lo) * 0.04, 0.25);
    return [lo - pad, hi + pad];
  }, [events]);
  // It opens on the core period (where most major events are); a lone early or late
  // event (an older cause, a later legacy) stays a zoom-out away.
  const core = useMemo<[number, number]>(() => {
    const times = events
      .filter((e) => e.importance < 3)
      .flatMap((e) => [e.start, e.end ?? e.start])
      .sort((a, b) => a - b);
    if (times.length < 4) return extent;
    const q = (p: number) => times[Math.min(times.length - 1, Math.floor(p * (times.length - 1)))];
    const lo = q(0.08);
    const hi = q(0.92);
    const pad = Math.max((hi - lo) * 0.08, 0.15);
    const view: [number, number] = [Math.max(lo - pad, extent[0]), Math.min(hi + pad, extent[1])];
    return view[1] - view[0] > (extent[1] - extent[0]) * 0.6 ? extent : view;
  }, [events, extent]);
  const [domain, setDomain] = useState(core);
  useEffect(() => setDomain(core), [core]);

  const plotW = Math.max(width - PAD * 2, 1);
  const [d0, d1] = domain;
  const span = d1 - d0;
  const x = (t: number) => PAD + ((t - d0) / span) * plotW;

  const clamp = ([a, b]: [number, number]): [number, number] => {
    const full = extent[1] - extent[0];
    const s = Math.min(Math.max(b - a, MIN_SPAN), full);
    let lo = a + (b - a - s) / 2;
    lo = Math.min(Math.max(lo, extent[0]), extent[1] - s);
    return [lo, lo + s];
  };
  const domainRef = useRef(domain);
  domainRef.current = domain;
  const zoomAt = (factor: number, px: number, from = domainRef.current) => {
    const s = from[1] - from[0];
    const t = from[0] + ((px - PAD) / plotW) * s;
    setDomain(clamp([t - (t - from[0]) * factor, t - (t - from[0]) * factor + s * factor]));
  };
  const pan = (fraction: number) => {
    const [a, b] = domainRef.current;
    const shift = (b - a) * fraction;
    setDomain(clamp([a + shift, b + shift]));
  };

  // Wheel zooms around the pointer (sideways scrolling moves). Not passive, so the page doesn't scroll instead.
  const zoomRef = useRef(zoomAt);
  zoomRef.current = zoomAt;
  const panRef = useRef(pan);
  panRef.current = pan;
  // On the container, which exists from the first render (the SVG waits for its width).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) panRef.current(e.deltaX / rect.width);
      else zoomRef.current(Math.exp(e.deltaY * 0.0015), e.clientX - rect.left);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [box]);

  // Drag to move; two fingers to pinch. Capture starts only once it's a drag, so clicks still reach events.
  const pointers = useRef(new Map<number, number>());
  const gesture = useRef<{ domain: [number, number]; x: number; dist?: number; mid?: number; moved: boolean } | null>(null);
  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const left = e.currentTarget.getBoundingClientRect().left;
    pointers.current.set(e.pointerId, e.clientX - left);
    const xs = [...pointers.current.values()];
    gesture.current =
      xs.length === 2
        ? { domain: domainRef.current, x: xs[0], dist: Math.abs(xs[1] - xs[0]), mid: (xs[0] + xs[1]) / 2, moved: true }
        : { domain: domainRef.current, x: xs[0], moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(e.pointerId) || !gesture.current) return;
    const left = e.currentTarget.getBoundingClientRect().left;
    pointers.current.set(e.pointerId, e.clientX - left);
    const xs = [...pointers.current.values()];
    const g = gesture.current;
    if (xs.length === 2 && g.dist) {
      const dist = Math.max(Math.abs(xs[1] - xs[0]), 10);
      zoomAt(g.dist / dist, g.mid!, g.domain);
      return;
    }
    const dx = xs[0] - g.x;
    if (!g.moved && Math.abs(dx) < 4) return;
    if (!g.moved) {
      g.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    const s = g.domain[1] - g.domain[0];
    setDomain(clamp([g.domain[0] - (dx / plotW) * s, g.domain[1] - (dx / plotW) * s]));
  };
  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size === 0) gesture.current = null;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowLeft: () => pan(-0.15),
      ArrowRight: () => pan(0.15),
      '+': () => zoomAt(0.7, PAD + plotW / 2),
      '=': () => zoomAt(0.7, PAD + plotW / 2),
      '-': () => zoomAt(1 / 0.7, PAD + plotW / 2),
      '0': () => setDomain(extent),
      Home: () => setDomain(core),
    };
    const run = keys[e.key];
    if (run) {
      e.preventDefault();
      run();
    }
  };

  const lanes = parts.filter((p) => events.some((e) => e.part === p.n));
  const laneOf = new Map(lanes.map((p, i) => [p.n, i]));
  const height = ERA_H + lanes.length * LANE_H + AXIS_H;
  const zoom = span / (extent[1] - extent[0]);
  // Details appear once zoomed in to under half of the whole span.
  const visible = events.filter((e) => (e.importance < 3 || zoom < 0.5) && (e.end ?? e.start) >= d0 && e.start <= d1);

  // Labels: turning points first, then by date; above or below the dot, skipped where they'd overlap.
  const labels = useMemo(() => {
    const placed = new Map<string, [number, number][]>();
    const out = new Map<string, { x: number; y: number; anchor: 'start' | 'middle' | 'end' }>();
    const order = [...visible].sort((a, b) => a.importance - b.importance || a.start - b.start);
    for (const e of order) {
      if (e.importance === 3 && zoom > 0.25) continue;
      const lane = laneOf.get(e.part) ?? 0;
      const cx = x(e.start);
      const w = e.title.length * (e.importance === 1 ? 6.6 : 6.1) + 6;
      let lo = cx - w / 2;
      lo = Math.min(Math.max(lo, PAD), PAD + plotW - w);
      for (const row of [0, 1]) {
        const key = `${lane}:${row}`;
        const taken = placed.get(key) ?? [];
        if (taken.some(([a, b]) => lo < b + 8 && lo + w > a - 8)) continue;
        taken.push([lo, lo + w]);
        placed.set(key, taken);
        const laneTop = ERA_H + lane * LANE_H;
        out.set(e.id, { x: lo + w / 2, y: row === 0 ? laneTop + ROW1_Y : laneTop + ROW2_Y, anchor: 'middle' });
        break;
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, d0, d1, width, zoom]);

  const tickList = ticks(d0, d1, plotW);
  const at = (t: number) => {
    const year = Math.floor(t);
    return span < 3 ? `${MONTHS[Math.min(11, Math.floor((t - year) * 12))]} ${yearLabel(year)}` : yearLabel(year);
  };
  const range = `${at(d0)} to ${at(d1)}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p id="timeline-help" className="text-xs text-muted">
          Drag to move, scroll or pinch to zoom. Zoom in for more events. Showing {range}
          {zoom < 0.999 ? ` of ${yearLabel(Math.floor(extent[0] + 0.5))} to ${yearLabel(Math.floor(extent[1]))}` : ''}.
        </p>
        <div className="flex items-center gap-1">
          <Button size="sm" variant="ghost" isIconOnly aria-label="Zoom out" onPress={() => zoomAt(1 / 0.6, PAD + plotW / 2)}>
            <span aria-hidden className="text-lg leading-none">−</span>
          </Button>
          <Button size="sm" variant="ghost" isIconOnly aria-label="Zoom in" onPress={() => zoomAt(0.6, PAD + plotW / 2)}>
            <span aria-hidden className="text-lg leading-none">+</span>
          </Button>
          {core !== extent && (
            <Button size="sm" variant="ghost" onPress={() => setDomain(core)}>
              Main period
            </Button>
          )}
          <Button size="sm" variant="ghost" onPress={() => setDomain(extent)} isDisabled={zoom > 0.999}>
            Show all
          </Button>
        </div>
      </div>
      <div
        ref={box}
        tabIndex={0}
        role="group"
        aria-label="Timeline of the report’s events"
        aria-describedby="timeline-help"
        onKeyDown={onKeyDown}
        className="rounded-lg border border-border bg-surface outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        {width > 0 && (
          <svg
            ref={svgRef}
            width={width}
            height={height}
            className="block cursor-grab touch-none select-none active:cursor-grabbing"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onClick={(e) => e.target === e.currentTarget && onSelect(null)}
          >
            <defs>
              <clipPath id="timeline-plot">
                <rect x={PAD - 8} y={0} width={plotW + 16} height={height} />
              </clipPath>
            </defs>

            {/* Eras */}
            {eras.map((era, i) => {
              const a = Math.max(x(era.from), PAD);
              const b = Math.min(x(era.to), PAD + plotW);
              if (b <= a) return null;
              const fits = era.label.length * 6.2 + 12 < b - a;
              return (
                <g key={`${era.label}-${i}`}>
                  <rect x={a} y={2} width={b - a} height={ERA_H - 6} rx={4} fill={i % 2 ? 'var(--surface-tertiary)' : 'var(--surface-secondary)'} />
                  {fits && (
                    <text x={(a + b) / 2} y={ERA_H / 2 + 3} textAnchor="middle" fontSize={11} fill="var(--muted)">
                      {era.label}
                    </text>
                  )}
                  <title>{`${era.label}: ${yearLabel(Math.floor(era.from))} to ${yearLabel(Math.floor(era.to))}`}</title>
                </g>
              );
            })}

            {/* Grid and lanes */}
            {tickList.map((t) => (
              <line key={t.t} x1={x(t.t)} x2={x(t.t)} y1={ERA_H} y2={height - AXIS_H} stroke="var(--separator)" />
            ))}
            {lanes.map((p, i) => (
              <g key={p.n}>
                {i > 0 && <line x1={0} x2={width} y1={ERA_H + i * LANE_H} y2={ERA_H + i * LANE_H} stroke="var(--separator)" />}
                <line x1={PAD} x2={PAD + plotW} y1={ERA_H + i * LANE_H + DOT_Y} y2={ERA_H + i * LANE_H + DOT_Y} stroke="var(--chart-line)" />
              </g>
            ))}

            <g clipPath="url(#timeline-plot)">
              {/* Spans (events lasting months or years) */}
              {visible
                .filter((e) => e.end !== undefined)
                .map((e) => {
                  const cy = ERA_H + (laneOf.get(e.part) ?? 0) * LANE_H + DOT_Y;
                  return (
                    <rect
                      key={`span-${e.id}`}
                      x={x(e.start)}
                      y={cy - 3}
                      width={Math.max(x(e.end!) - x(e.start), 2)}
                      height={6}
                      rx={3}
                      fill={e.id === selected ? 'var(--accent)' : 'var(--chart-node)'}
                      opacity={e.id === selected ? 0.6 : 0.45}
                    />
                  );
                })}
              {visible.map((e) => {
                const cy = ERA_H + (laneOf.get(e.part) ?? 0) * LANE_H + DOT_Y;
                const cx = x(e.start);
                const r = e.importance === 1 ? 6 : e.importance === 2 ? 4.5 : 3.5;
                const on = e.id === selected;
                const label = labels.get(e.id);
                return (
                  <g
                    key={e.id}
                    role="button"
                    tabIndex={-1}
                    aria-label={`${e.when}: ${e.title}`}
                    onClick={() => onSelect(on ? null : e.id)}
                    className="cursor-pointer outline-none"
                  >
                    <circle cx={cx} cy={cy} r={14} fill="transparent" />
                    {on && <circle cx={cx} cy={cy} r={r + 4} fill="none" stroke="var(--accent)" strokeWidth={2} />}
                    <circle
                      cx={cx}
                      cy={cy}
                      r={r}
                      fill={on ? 'var(--accent)' : e.importance === 1 ? 'var(--foreground)' : 'var(--chart-node)'}
                      stroke="var(--surface)"
                      strokeWidth={2}
                    />
                    {label && (
                      <text
                        x={label.x}
                        y={label.y}
                        textAnchor={label.anchor}
                        fontSize={e.importance === 1 ? 12 : 11}
                        fontWeight={e.importance === 1 || on ? 600 : 400}
                        fill={on ? 'var(--foreground)' : e.importance === 1 ? 'var(--foreground)' : 'var(--muted)'}
                        stroke="var(--surface)"
                        strokeWidth={4}
                        paintOrder="stroke"
                      >
                        {e.title}
                      </text>
                    )}
                    <title>{`${e.when}: ${e.title}`}</title>
                  </g>
                );
              })}
            </g>

            {/* Lane names, over the plot */}
            {lanes.map((p, i) => (
              <text
                key={`name-${p.n}`}
                x={PAD - 6}
                y={ERA_H + i * LANE_H + NAME_Y}
                fontSize={10}
                fill="var(--muted)"
                stroke="var(--surface)"
                strokeWidth={4}
                paintOrder="stroke"
              >
                {`${p.n}. ${p.title}`}
              </text>
            ))}

            {/* Axis */}
            <line x1={PAD} x2={PAD + plotW} y1={height - AXIS_H} y2={height - AXIS_H} stroke="var(--chart-line)" />
            {tickList.map((t) => (
              <text key={`t-${t.t}`} x={x(t.t)} y={height - AXIS_H + 18} textAnchor="middle" fontSize={11} fill="var(--muted)">
                {t.label}
              </text>
            ))}
          </svg>
        )}
      </div>
    </div>
  );
}
