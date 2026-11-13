import { useRef, useState } from 'react';
import type { TimelineEvent } from '../lib/research';
import { Cite } from './Cite';
import { Floating } from './Floating';

const NICE_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500];

function ticks(min: number, max: number) {
  const step = NICE_STEPS.find((s) => (max - min) / s <= 5) ?? 1000;
  const out: number[] = [];
  for (let y = Math.ceil(min / step) * step; y <= max; y += step) out.push(y);
  return out;
}

/**
 * Dates mentioned in a page's sources: a strip that shows how they spread over
 * time, and the list beneath it carries the full text (and is what screen
 * readers get).
 */
export function Timeline({ events, sourceHref }: { events: TimelineEvent[]; sourceHref: (n: number) => string }) {
  const [active, setActive] = useState<number | null>(null);
  // The tooltip only follows the markers; hovering the list just highlights a marker.
  const [tip, setTip] = useState<number | null>(null);
  const markers = useRef<(HTMLSpanElement | null)[]>([]);
  const min = events[0].year;
  const max = Math.max(events[events.length - 1].year, min + 1);
  const pct = (year: number) => ((year - min) / (max - min)) * 100;

  // Stack markers that would touch into separate lanes.
  const lastInLane: number[] = [];
  const lanes = events.map((e) => {
    const x = pct(e.year);
    let lane = lastInLane.findIndex((last) => x - last >= 3);
    if (lane === -1) lane = lastInLane.length < 3 ? lastInLane.length : 2;
    lastInLane[lane] = x;
    return lane;
  });
  const laneCount = Math.max(...lanes) + 1;

  return (
    <div className="flex flex-col gap-5">
      <div aria-hidden className="relative mx-2" style={{ height: `${laneCount * 16 + 34}px` }}>
        {events.map((e, i) => (
          <span
            key={e.year}
            className="absolute -translate-x-1/2"
            style={{ left: `${pct(e.year)}%`, top: `${lanes[i] * 16}px` }}
            onPointerEnter={() => {
              setActive(i);
              setTip(i);
            }}
            onPointerLeave={() => {
              setActive((a) => (a === i ? null : a));
              setTip((t) => (t === i ? null : t));
            }}
          >
            {/* Generous hit area around a 10px marker with a surface ring. */}
            <span ref={(el) => void (markers.current[i] = el)} className="flex size-5 items-center justify-center">
              <span
                className={`block size-2.5 rounded-full shadow-[0_0_0_2px_var(--background)] transition-transform motion-reduce:transition-none ${
                  active === i ? 'scale-150 bg-accent' : 'bg-accent'
                }`}
              />
            </span>
          </span>
        ))}
        <div className="absolute inset-x-0 bottom-5 border-t border-[var(--field-line)]" />
        {ticks(min, max).map((y) => (
          <span
            key={y}
            className="absolute bottom-0 -translate-x-1/2 text-xs tabular-nums text-muted"
            style={{ left: `${pct(y)}%` }}
          >
            {y}
          </span>
        ))}
      </div>

      {tip !== null && (
        <Floating anchor={markers.current[tip] ?? null} className="px-3 py-2 text-sm">
          <span className="block font-semibold tabular-nums">{events[tip].year}</span>
          <span className="mt-0.5 line-clamp-4 block text-muted">{events[tip].text}</span>
        </Floating>
      )}

      <ol className="flex flex-col gap-3">
        {events.map((e, i) => (
          <li
            key={e.year}
            onPointerEnter={() => setActive(i)}
            onPointerLeave={() => setActive((a) => (a === i ? null : a))}
            className={`grid grid-cols-[3.5rem_1fr] gap-3 rounded-md px-2 py-1 transition-colors motion-reduce:transition-none ${
              active === i ? 'bg-surface-secondary' : ''
            }`}
          >
            <span className="font-semibold tabular-nums">{e.year}</span>
            <span className="font-serif leading-relaxed">
              {e.text}
              <Cite n={e.source + 1} href={sourceHref(e.source + 1)} />
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
