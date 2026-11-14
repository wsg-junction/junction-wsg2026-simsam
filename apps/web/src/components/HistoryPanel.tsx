import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Link, Skeleton, Spinner } from '@heroui/react';
import type { ArticleTimeline, HistoryChange, RevisionDiff } from '@simsam/models';
import { fetchRevisionDiff } from '../lib/history';
import { prefersReducedMotion } from '../lib/motion';
import { Floating } from './Floating';

export type TimelineState =
  | { status: 'loading' }
  | { status: 'ready'; timeline: ArticleTimeline }
  | { status: 'unavailable' }
  | { status: 'error' };

interface Props {
  title: string | undefined;
  state: TimelineState | undefined;
  onRetry: () => void;
}

const formatDate = (iso: string, month: 'short' | 'long' = 'short') =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month, year: 'numeric', timeZone: 'UTC' });
const formatBytes = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)} kB` : `${n} B`);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

/**
 * The article's history beside the research canvas: its substantial changes
 * (no typo fixes, formatting, bots or reverted vandalism), an AI overview of
 * the most impactful ones, a section-by-section timeline, and each change's
 * diff on demand so it can be checked.
 */
export function HistoryPanel({ title, state, onRetry }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => setSelected(null), [title]);
  const listRef = useRef<HTMLOListElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const select = (n: number) => {
    setSelected((s) => (s === n ? null : n));
    // Scroll only the panel (scrollIntoView would also move the page around it).
    requestAnimationFrame(() => {
      const item = listRef.current?.querySelector<HTMLElement>(`[data-change="${n}"]`);
      const scroller = scrollRef.current;
      if (!item || !scroller) return;
      const top = item.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 12;
      scroller.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-5 pt-3 pb-2">
        <h2 className="pt-1.5 text-sm font-semibold">{title ? `How “${title}” changed` : 'Article history'}</h2>
        {state?.status === 'ready' && (
          <p className="text-sm text-muted">
            {plural(state.timeline.scanned, 'edit')} scanned, {formatDate(state.timeline.from)} to{' '}
            {formatDate(state.timeline.to)}. Small fixes, bots and reverted edits are left out.
          </p>
        )}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-8">
        {!title && <p className="text-sm text-muted">Ask a question to see how its main article changed.</p>}
        {title && (!state || state.status === 'loading') && (
          <div aria-live="polite" className="flex flex-col gap-3">
            <p className="inline-flex items-center gap-2 text-sm text-muted">
              <Spinner size="sm" aria-hidden />
              Reading the edit history. The first time takes a few seconds.
            </p>
            <Skeleton className="h-3.5 w-full rounded" />
            <Skeleton className="h-3.5 w-4/5 rounded" />
            <Skeleton className="mt-2 h-40 w-full rounded-lg" />
          </div>
        )}
        {state?.status === 'unavailable' && (
          <p className="text-sm text-muted">
            “{title}” isn’t in the local collection, so its history isn’t stored. Histories cover European history,
            Finnish history and computer science articles.
          </p>
        )}
        {state?.status === 'error' && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <p className="text-muted">The edit history couldn’t be read right now.</p>
            <Button size="sm" variant="secondary" onPress={onRetry}>
              Try again
            </Button>
          </div>
        )}
        {state?.status === 'ready' && state.timeline.changes.length === 0 && (
          <p className="text-sm text-muted">
            No substantial changes in the scanned edits: they only fixed small details.
          </p>
        )}
        {state?.status === 'ready' && state.timeline.changes.length > 0 && (
          <div className="flex flex-col gap-6">
            {state.timeline.overview && (
              <div className="flex flex-col gap-1.5">
                <p className="font-serif leading-relaxed">
                  <Overview text={state.timeline.overview} onCite={select} />
                </p>
                <p className="text-xs text-muted">Overview written by AI from the changes below. Open a change to check it.</p>
              </div>
            )}
            <SectionTimeline timeline={state.timeline} selected={selected} onSelect={select} />
            <ol ref={listRef} className="flex flex-col gap-2" aria-label="Substantial changes">
              {state.timeline.changes.map((change) => (
                <ChangeItem
                  key={change.revisionId}
                  pageId={state.timeline.pageId}
                  change={change}
                  open={selected === change.n}
                  onToggle={() => select(change.n)}
                />
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}

/** The overview, with each [n] a button that opens that change. */
function Overview({ text, onCite }: { text: string; onCite: (n: number) => void }) {
  return (
    <>
      {text.split(/(\[\d+\])/).map((part, i) => {
        const m = part.match(/^\[(\d+)\]$/);
        if (!m) return <Fragment key={i}>{part}</Fragment>;
        const n = Number(m[1]);
        return (
          <button
            key={i}
            type="button"
            onClick={() => onCite(n)}
            aria-label={`Open change ${n}`}
            className="mx-px align-super text-[0.7em] text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
          >
            [{n}]
          </button>
        );
      })}
    </>
  );
}

// ---------- Section timeline ----------

const SIZE_H = 44;
const NUM_H = 22;
const LANE_H = 26;
const AXIS_H = 20;
const MAX_LANES = 8;
const MIN_GAP = 18;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Time runs left to right; each row is a section of the article, so the chart
 * shows where each change landed. Marks are sized by words changed: filled
 * where more was added, hollow where more was removed. The band on top is the
 * article's size over every scanned edit.
 */
function SectionTimeline({
  timeline,
  selected,
  onSelect,
}: {
  timeline: ArticleTimeline;
  selected: number | null;
  onSelect: (n: number) => void;
}) {
  const [box, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<number | null>(null);
  const columns = useRef<(HTMLButtonElement | null)[]>([]);
  const { changes, sizes } = timeline;

  // Lanes: the lead first, then the most-changed sections; the rest share one row.
  const lanes = useMemo(() => {
    const totals = new Map<string, number>();
    for (const c of changes) for (const s of c.sections) totals.set(s.section, (totals.get(s.section) ?? 0) + s.added + s.removed);
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
    const top = ranked.slice(0, ranked.length > MAX_LANES ? MAX_LANES - 1 : MAX_LANES);
    const ordered = [...top.filter((s) => s === 'Lead'), ...top.filter((s) => s !== 'Lead')];
    return { names: ordered, other: ranked.length > top.length };
  }, [changes]);
  const laneNames = lanes.other ? [...lanes.names, 'Other sections'] : lanes.names;

  const labelW = Math.min(132, Math.max(90, width * 0.3));
  const plotW = Math.max(width - labelW - 14, 60);
  const t0 = Date.parse(timeline.from);
  const t1 = Math.max(Date.parse(timeline.to), t0 + 1);
  const xOf = (iso: string) => ((Date.parse(iso) - t0) / (t1 - t0)) * plotW;

  // Changes close in time get spread apart so each stays readable and clickable.
  const xs = useMemo(() => {
    const raw = changes.map((c) => xOf(c.at));
    const out = [...raw];
    for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + MIN_GAP);
    const over = out[out.length - 1] - plotW;
    if (over > 0) {
      out[out.length - 1] = plotW;
      for (let i = out.length - 2; i >= 0; i--) out[i] = Math.min(out[i], out[i + 1] - MIN_GAP);
    }
    return out.map((x) => Math.max(0, x));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changes, plotW, t0, t1]);

  const lanesTop = SIZE_H + NUM_H;
  const height = lanesTop + laneNames.length * LANE_H + AXIS_H;

  const wordsIn = (c: HistoryChange, lane: string) => {
    if (lane === 'Other sections') {
      const rest = c.sections.filter((s) => !lanes.names.includes(s.section));
      return { added: rest.reduce((n, s) => n + s.added, 0), removed: rest.reduce((n, s) => n + s.removed, 0) };
    }
    const s = c.sections.find((x) => x.section === lane);
    return { added: s?.added ?? 0, removed: s?.removed ?? 0 };
  };

  // The size band: a step line over every scanned edit.
  const maxB = Math.max(...sizes.map((s) => s.bytes));
  const minB = Math.min(...sizes.map((s) => s.bytes));
  const lo = Math.max(0, minB - (maxB - minB) * 0.2);
  const yOf = (b: number) => 6 + (1 - (b - lo) / Math.max(maxB - lo, 1)) * (SIZE_H - 14);
  const sizePoints = sizes.flatMap((s, i) => {
    const x = xOf(s.at);
    const prev = sizes[i - 1];
    return prev ? [`${x},${yOf(prev.bytes)}`, `${x},${yOf(s.bytes)}`] : [`${x},${yOf(s.bytes)}`];
  });

  // Year ticks, thinned to fit.
  const ticks = useMemo(() => {
    const y0 = new Date(t0).getUTCFullYear() + 1;
    const y1 = new Date(t1).getUTCFullYear();
    const years: number[] = [];
    for (let y = y0; y <= y1; y++) years.push(y);
    const every = Math.max(1, Math.ceil(years.length / Math.max(1, Math.floor(plotW / 56))));
    return years.filter((_, i) => i % every === 0).map((y) => ({ y, x: ((Date.UTC(y, 0, 1) - t0) / (t1 - t0)) * plotW }));
  }, [t0, t1, plotW]);

  const tipChange = tip !== null ? changes[tip] : null;

  return (
    <figure className="flex flex-col gap-2">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span className="font-semibold">Where each change landed</span>
        <span className="text-xs text-muted">Select a change to see its diff</span>
      </figcaption>
      <div ref={box} className="relative w-full select-none" style={{ height }}>
        {width > 0 && (
          <>
            {/* Row labels. */}
            <span className="absolute left-0 text-xs text-muted" style={{ top: 6, width: labelW - 8 }}>
              Article size
            </span>
            {laneNames.map((name, i) => (
              <span
                key={name}
                title={name}
                className="absolute left-0 truncate text-xs"
                style={{ top: lanesTop + i * LANE_H + 5, width: labelW - 8 }}
              >
                {name}
              </span>
            ))}

            <div className="absolute top-0" style={{ left: labelW, width: plotW, height }}>
              <svg width={plotW} height={height} className="absolute inset-0 overflow-visible" aria-hidden>
                {/* Lane guides. */}
                {laneNames.map((name, i) => (
                  <line
                    key={name}
                    x1={0}
                    x2={plotW}
                    y1={lanesTop + i * LANE_H + LANE_H / 2}
                    y2={lanesTop + i * LANE_H + LANE_H / 2}
                    stroke="var(--separator)"
                  />
                ))}
                <polyline points={sizePoints.join(' ')} fill="none" stroke="var(--chart-node)" strokeWidth={1.5} strokeLinejoin="round" />
                {/* One hairline per change, through every lane. */}
                {changes.map((c, i) => (
                  <line
                    key={c.n}
                    x1={xs[i]}
                    x2={xs[i]}
                    y1={SIZE_H + NUM_H - 4}
                    y2={height - AXIS_H}
                    stroke={selected === c.n || tip === i ? 'var(--accent)' : 'var(--border)'}
                    strokeWidth={selected === c.n ? 2 : 1}
                  />
                ))}
                {/* Where a spread-out change sits on the size band. */}
                {changes.map((c, i) => (
                  <line key={`l${c.n}`} x1={xOf(c.at)} x2={xs[i]} y1={yOf(c.bytesAfter)} y2={SIZE_H + 4} stroke="var(--border)" strokeDasharray="2 2" />
                ))}
                {/* Section marks. */}
                {changes.map((c, i) =>
                  laneNames.map((lane, li) => {
                    const { added, removed } = wordsIn(c, lane);
                    if (added + removed === 0) return null;
                    const r = Math.min(10, Math.max(3, 2 + Math.sqrt(added + removed) * 0.6));
                    const more = added >= removed;
                    return (
                      <circle
                        key={`${c.n}-${lane}`}
                        cx={xs[i]}
                        cy={lanesTop + li * LANE_H + LANE_H / 2}
                        r={r}
                        fill={more ? 'var(--added)' : 'var(--surface)'}
                        stroke={more ? 'var(--surface)' : 'var(--removed)'}
                        strokeWidth={more ? 1.5 : 2}
                      />
                    );
                  }),
                )}
                {ticks.map((t) => (
                  <text key={t.y} x={t.x} y={height - 5} textAnchor="middle" fontSize={11} fill="var(--muted)">
                    {t.y}
                  </text>
                ))}
              </svg>

              {/* Each change is one button over its column: the number on top, the whole height clickable. */}
              {changes.map((c, i) => (
                <button
                  key={c.n}
                  ref={(el) => void (columns.current[i] = el)}
                  type="button"
                  aria-label={`Change ${c.n}, ${formatDate(c.at, 'long')}: ${c.title}`}
                  aria-pressed={selected === c.n}
                  onClick={() => onSelect(c.n)}
                  onPointerEnter={() => setTip(i)}
                  onPointerLeave={() => setTip((t) => (t === i ? null : t))}
                  onFocus={() => setTip(i)}
                  onBlur={() => setTip((t) => (t === i ? null : t))}
                  className="group absolute flex -translate-x-1/2 justify-center rounded outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  style={{ left: xs[i], top: SIZE_H, width: MIN_GAP, height: height - SIZE_H - AXIS_H }}
                >
                  <span
                    className={`mt-0.5 flex size-[18px] items-center justify-center rounded-full text-[11px] tabular-nums ${
                      selected === c.n
                        ? 'bg-accent font-semibold text-accent-foreground'
                        : 'bg-default text-foreground group-hover:bg-accent group-hover:text-accent-foreground'
                    }`}
                  >
                    {c.n}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      {tipChange && (
        <Floating anchor={columns.current[tip!] ?? null} className="max-w-72 px-3 py-2 text-sm">
          <span className="block font-semibold">{tipChange.title}</span>
          <span className="block text-muted">
            {formatDate(tipChange.at)} · +{tipChange.wordsAdded} / −{tipChange.wordsRemoved} words
          </span>
        </Floating>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-hidden>
        <span className="inline-flex items-center gap-1.5">
          <svg width="10" height="10"><circle cx="5" cy="5" r="4" fill="var(--added)" /></svg>
          More text added
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width="10" height="10"><circle cx="5" cy="5" r="3.5" fill="none" stroke="var(--removed)" strokeWidth="2" /></svg>
          More text removed
        </span>
        <span>Larger mark, more words changed</span>
        <span>
          Size {formatBytes(sizes[0]?.bytes ?? 0)} to {formatBytes(sizes[sizes.length - 1]?.bytes ?? 0)}
        </span>
      </div>
    </figure>
  );
}

// ---------- Changes and their diffs ----------

function ChangeItem({
  pageId,
  change,
  open,
  onToggle,
}: {
  pageId: number;
  change: HistoryChange;
  open: boolean;
  onToggle: () => void;
}) {
  const panelId = `history-change-${change.revisionId}`;
  return (
    <li data-change={change.n} className={`scroll-mt-4 rounded-lg border ${open ? 'border-accent' : 'border-border'} bg-surface`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
        className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus"
      >
        <span
          className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] tabular-nums ${
            open ? 'bg-accent text-accent-foreground' : 'bg-default'
          }`}
        >
          {change.n}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium leading-snug">{change.title}</span>
          <span className="block text-xs text-muted">
            {formatDate(change.at)}
            {change.editor ? ` by ${change.editor}` : ''}
          </span>
          <span className="mt-1 block text-sm text-muted">{change.summary}</span>
        </span>
        <span className="shrink-0 text-right text-xs tabular-nums">
          <span className="block text-[var(--added)]">+{change.wordsAdded}</span>
          <span className="block text-[var(--removed)]">−{change.wordsRemoved}</span>
          <span className="sr-only">words</span>
        </span>
      </button>
      {open && (
        <div id={panelId} className="border-t border-border px-3 pt-3 pb-3">
          <DiffView pageId={pageId} change={change} />
        </div>
      )}
    </li>
  );
}

function DiffView({ pageId, change }: { pageId: number; change: HistoryChange }) {
  const [diff, setDiff] = useState<RevisionDiff | null | 'error'>(null);
  useEffect(() => {
    let live = true;
    setDiff(null);
    fetchRevisionDiff(pageId, change.revisionId)
      .then((d) => live && setDiff(d))
      .catch(() => live && setDiff('error'));
    return () => {
      live = false;
    };
  }, [pageId, change.revisionId]);

  return (
    <div className="flex flex-col gap-3 text-sm">
      {change.comment && (
        <p className="text-xs text-muted">
          Edit summary: <span className="italic">“{change.comment}”</span>
        </p>
      )}
      {diff === null && (
        <div className="flex flex-col gap-2" aria-live="polite">
          <Skeleton className="h-3.5 w-full rounded" />
          <Skeleton className="h-3.5 w-3/4 rounded" />
        </div>
      )}
      {diff === 'error' && <p className="text-muted">The diff couldn’t be loaded. Open it on Wikipedia instead.</p>}
      {diff && diff !== 'error' && diff.hunks.length === 0 && (
        <p className="text-muted">The text change here is in lists, tables or references; open it on Wikipedia to see it.</p>
      )}
      {diff && diff !== 'error' && diff.hunks.length > 0 && (
        <ol className="flex flex-col gap-3">
          {diff.hunks.map((hunk, i) => (
            <li key={i} className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted">{hunk.section}</span>
              <p className="font-serif leading-relaxed">
                {hunk.segments.map((seg, j) =>
                  seg.type === 'added' ? (
                    <ins key={j} className="rounded-sm bg-[var(--added-bg)] px-0.5 text-[var(--added-fg)] no-underline">
                      <span className="sr-only">[added: </span>
                      {seg.text}
                      <span className="sr-only">]</span>
                    </ins>
                  ) : seg.type === 'removed' ? (
                    <del key={j} className="rounded-sm bg-[var(--removed-bg)] px-0.5 text-[var(--removed-fg)]">
                      <span className="sr-only">[removed: </span>
                      {seg.text}
                      <span className="sr-only">]</span>
                    </del>
                  ) : (
                    <span key={j} className="text-muted">
                      {seg.text}
                    </span>
                  ),
                )}
              </p>
            </li>
          ))}
        </ol>
      )}
      {diff && diff !== 'error' && diff.truncated && <p className="text-xs text-muted">More changed than is shown here.</p>}
      <Link href={change.diffUrl} target="_blank" rel="noreferrer" className="text-sm text-foreground underline underline-offset-4">
        Open this diff on Wikipedia
      </Link>
    </div>
  );
}
