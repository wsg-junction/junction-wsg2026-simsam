import { useRef, useState } from 'react';
import type { ArticleHistory } from '@simsam/models';
import { Floating } from './Floating';

const formatBytes = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} kB` : `${n} B`);
const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

/**
 * The article's size after every stored version, with the important edits
 * marked. The timeline below lists the same edits in full, so this is the
 * overview; markers explain themselves on hover.
 */
export function HistoryChart({ history }: { history: ArticleHistory }) {
  const { sizes, changes } = history;
  const [tip, setTip] = useState<number | null>(null);
  const markers = useRef<(HTMLSpanElement | null)[]>([]);
  if (sizes.length < 2) return null;

  const t0 = Date.parse(sizes[0].at);
  const t1 = Math.max(Date.parse(sizes[sizes.length - 1].at), t0 + 1);
  const maxBytes = Math.max(...sizes.map((s) => s.bytes));
  const minBytes = Math.min(...sizes.map((s) => s.bytes));
  // Leave headroom so the line never touches the frame; start the scale near the minimum to show change.
  const lo = Math.max(0, minBytes - (maxBytes - minBytes) * 0.25);
  const hi = maxBytes + (maxBytes - lo) * 0.1 || 1;
  const x = (iso: string) => ((Date.parse(iso) - t0) / (t1 - t0)) * 100;
  const y = (bytes: number) => 100 - ((bytes - lo) / (hi - lo)) * 100;
  // A step line: the size holds until the next edit.
  const points = sizes.flatMap((s, i) => {
    const px = x(s.at);
    const prev = sizes[i - 1];
    return prev ? [`${px},${y(prev.bytes)}`, `${px},${y(s.bytes)}`] : [`${px},${y(s.bytes)}`];
  });
  const first = sizes[0];
  const last = sizes[sizes.length - 1];

  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-4 text-sm">
        <span className="font-semibold">Article size across {history.versions} stored versions</span>
        <span className="text-muted tabular-nums">
          {formatBytes(first.bytes)} to {formatBytes(last.bytes)}
        </span>
      </figcaption>
      <div
        role="img"
        aria-label={`Size went from ${formatBytes(first.bytes)} on ${formatDate(first.at)} to ${formatBytes(last.bytes)} on ${formatDate(last.at)}.`}
        className="relative h-32 rounded-lg border border-border bg-surface"
      >
        <div className="absolute inset-x-3 top-3 bottom-6">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden className="absolute inset-0 h-full w-full overflow-visible">
            <polyline
              points={points.join(' ')}
              fill="none"
              stroke="var(--foreground)"
              strokeOpacity={0.7}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          </svg>
          {changes.map((c, i) => (
            <span
              key={c.revisionId}
              ref={(el) => void (markers.current[i] = el)}
              aria-hidden
              onPointerEnter={() => setTip(i)}
              onPointerLeave={() => setTip((t) => (t === i ? null : t))}
              className="absolute flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center"
              style={{ left: `${x(c.at)}%`, top: `${y(c.bytesAfter)}%` }}
            >
              <span
                className={`block size-2.5 rounded-full bg-accent shadow-[0_0_0_2px_var(--surface)] transition-transform motion-reduce:transition-none ${
                  tip === i ? 'scale-150' : ''
                }`}
              />
            </span>
          ))}
        </div>
        <span className="absolute bottom-1 left-3 text-xs tabular-nums text-muted">{formatDate(first.at)}</span>
        <span className="absolute right-3 bottom-1 text-xs tabular-nums text-muted">{formatDate(last.at)}</span>
      </div>
      {tip !== null && changes[tip] && (
        <Floating anchor={markers.current[tip] ?? null} className="px-3 py-2 text-sm">
          <span className="block font-semibold">
            {formatDate(changes[tip].at)}
            <span className="ml-2 font-normal tabular-nums text-muted">
              {changes[tip].bytesAfter >= changes[tip].bytesBefore ? '+' : '−'}
              {formatBytes(Math.abs(changes[tip].bytesAfter - changes[tip].bytesBefore))}
            </span>
          </span>
          <span className="mt-0.5 line-clamp-3 block text-muted">{changes[tip].summary}</span>
        </Floating>
      )}
      <p className="text-xs text-muted">
        From {formatDate(history.from)} to {formatDate(history.to)}. The collection keeps each article’s most recent
        revisions, so earlier history isn’t shown. Marked points are the edits in the timeline.
      </p>
    </figure>
  );
}
