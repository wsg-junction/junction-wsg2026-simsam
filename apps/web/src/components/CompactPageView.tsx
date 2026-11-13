import { useEffect, useMemo, useRef } from 'react';
import { Button, Link, Skeleton } from '@heroui/react';
import type { Brief } from '@simsam/models';
import type { PageBrief, ResearchPage } from '../lib/research';
import { pacedNarrator, usePlayback, type Playback } from '../lib/playback';
import { setVoiceOn, useVoiceAvailable, useVoicePreference, voiceNarrator } from '../lib/voice';
import { prefersReducedMotion } from '../lib/motion';
import { CitedText, withoutCitations } from './Cite';
import { PageHeader } from './ResearchPageView';

interface Props {
  page: ResearchPage;
  index: number;
  total: number;
  brief?: PageBrief;
  /** The page is the one in view; playback only runs then. */
  isActive: boolean;
}

/**
 * Compact page: a one-sentence headline and a visual brief (a timeline for
 * history, key points otherwise) that plays in one beat at a time. Each beat
 * is plain text the narrator can read out.
 */
export function CompactPageView({ page, index, total, brief, isActive }: Props) {
  return (
    <section
      data-page={index}
      id={page.id}
      aria-labelledby={`${page.id}-title`}
      className="relative min-h-full snap-start"
    >
      <PageHeader page={page} index={index} total={total} />
      <div className="flex max-w-3xl flex-col gap-8 px-6 pt-8 pb-44 pr-14 sm:px-10 sm:pr-16">
        {!brief || brief.status === 'loading' ? (
          <BriefSkeleton />
        ) : (
          <BriefPlayer page={page} brief={brief.brief} byAi={brief.byAi} isActive={isActive} />
        )}
      </div>
    </section>
  );
}

function BriefSkeleton() {
  return (
    <div aria-busy aria-label="Preparing the brief" className="flex flex-col gap-4">
      <Skeleton className="h-8 w-11/12 rounded" />
      <Skeleton className="h-8 w-2/3 rounded" />
      <div className="mt-6 flex flex-col gap-6 border-l-2 border-separator pl-6">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-6 w-20 rounded" />
            <Skeleton className="h-5 w-3/4 rounded" />
            <Skeleton className="h-4 w-full rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** What gets read out for each beat: the headline, then each event or point. */
function beatsFor(brief: Brief) {
  const items =
    brief.layout === 'timeline'
      ? brief.events.map((e) => `${e.when}. ${e.title}. ${e.detail}`)
      : brief.points.map((p) => `${p.title}. ${p.detail}`);
  return [withoutCitations(brief.headline), ...items];
}

function BriefPlayer({ page, brief, byAi, isActive }: { page: ResearchPage; brief: Brief; byAi: boolean; isActive: boolean }) {
  const beats = useMemo(() => beatsFor(brief), [brief]);
  const voiceAvailable = useVoiceAvailable();
  const voiceOn = useVoicePreference();
  const reading = voiceAvailable && voiceOn;
  // Switching voice on or off mid-play restarts the current beat with the new narrator.
  const playback = usePlayback(beats, { active: isActive, narrator: reading ? voiceNarrator : pacedNarrator });
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const href = (n: number) => `#${page.id}-source-${n}`;

  // Keep the beat being read in view while playing (not while the reader browses).
  useEffect(() => {
    if (!playback.playing || playback.current < 1) return;
    itemRefs.current[playback.current - 1]?.scrollIntoView({
      block: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [playback.current, playback.playing]);

  const state = (beat: number) =>
    beat > playback.revealed ? 'hidden' : beat === playback.current && playback.playing ? 'current' : 'shown';

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted">
          {byAi ? 'Brief written by AI from the sources below. Check the citations.' : 'Brief from the Wikipedia articles below.'}
        </p>
        <Controls playback={playback} count={beats.length} voice={voiceAvailable ? voiceOn : undefined} />
      </div>

      <div data-beat={state(0)} className="beat">
        <CitedText
          text={brief.headline}
          sourceCount={page.sources.length}
          href={href}
          className="font-serif text-[1.6rem] leading-snug text-balance sm:text-[1.85rem]"
        />
      </div>

      {brief.layout === 'timeline' ? (
        <TimelineBrief page={page} brief={brief} state={state} playback={playback} itemRefs={itemRefs} />
      ) : (
        <PointsBrief page={page} brief={brief} state={state} itemRefs={itemRefs} />
      )}

      <SourceChips page={page} />
    </>
  );
}

/** `voice` is undefined when the server can't read aloud, so the toggle is hidden. */
function Controls({ playback, count, voice }: { playback: Playback; count: number; voice?: boolean }) {
  const finished = !playback.playing && playback.revealed >= count - 1;
  return (
    <div className="flex items-center gap-2">
      {voice !== undefined && (
        <button
          type="button"
          aria-pressed={voice}
          onClick={() => setVoiceOn(!voice)}
          className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus ${
            voice ? 'border-accent text-foreground' : 'border-border text-muted hover:text-foreground'
          }`}
        >
          {voice ? <SpeakerIcon /> : <MutedIcon />}
          Read aloud
        </button>
      )}
      <Button size="sm" variant="secondary" onPress={playback.playing ? playback.pause : playback.play}>
        {playback.playing ? <PauseIcon /> : <PlayIcon />}
        {playback.playing ? 'Pause' : finished ? 'Play again' : 'Play'}
      </Button>
      {!finished && (
        <Button size="sm" variant="ghost" onPress={playback.showAll}>
          Show all
        </Button>
      )}
    </div>
  );
}

type BeatState = 'hidden' | 'shown' | 'current';

const yearLabel = (year: number) => (year < 0 ? `${-year} BC` : String(year));

interface LayoutProps {
  page: ResearchPage;
  brief: Brief;
  state: (beat: number) => BeatState;
  itemRefs: React.RefObject<(HTMLElement | null)[]>;
}

function TimelineBrief({ page, brief, state, playback, itemRefs }: LayoutProps & { playback: Playback }) {
  const events = brief.events;
  const min = events[0].year;
  const max = Math.max(events[events.length - 1].year, min + 1);
  // Place markers by date, unless one long gap (say 9000 BC, then the 1800s)
  // would squash the rest together; then space them evenly in order.
  const gaps = events.slice(1).map((e, i) => e.year - events[i].year);
  const toScale = Math.max(...gaps) <= (max - min) * 0.5;
  const x = (i: number) =>
    toScale ? ((events[i].year - min) / (max - min)) * 100 : (i / Math.max(events.length - 1, 1)) * 100;
  // Show each source's picture once, on the first event that cites it.
  const shownImages = new Set<string>();

  return (
    <section aria-label="Timeline" className="flex flex-col gap-8">
      {/* Overview: where each event sits in time; markers fill in as they're reached. */}
      <div className="relative mx-3 h-12">
        <div className="absolute inset-x-0 top-4 border-t border-[var(--field-line)]" />
        {events.map((e, i) => {
          const s = state(i + 1);
          return (
            <button
              key={i}
              type="button"
              onClick={() => playback.jumpTo(i + 1)}
              aria-label={`${e.when}: ${e.title}`}
              className="absolute top-4 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-focus"
              style={{ left: `${x(i)}%` }}
            >
              <span
                className={`block rounded-full border-2 shadow-[0_0_0_2px_var(--background)] transition-all duration-300 motion-reduce:transition-none ${
                  s === 'current'
                    ? 'size-3.5 border-accent bg-accent'
                    : s === 'shown'
                      ? 'size-2.5 border-accent bg-accent'
                      : 'size-2.5 border-[var(--field-line)] bg-background'
                }`}
              />
            </button>
          );
        })}
        <span className="absolute top-7 left-0 -translate-x-1/2 text-xs tabular-nums text-muted">{yearLabel(events[0].year)}</span>
        <span className="absolute top-7 right-0 translate-x-1/2 text-xs tabular-nums text-muted">{yearLabel(events[events.length - 1].year)}</span>
      </div>

      <ol className="flex flex-col">
        {events.map((e, i) => {
          const s = state(i + 1);
          const image = e.sources
            .map((n) => page.sources[n - 1])
            .find((src) => src?.image && !shownImages.has(src.title));
          if (image) shownImages.add(image.title);
          return (
            <li
              key={i}
              ref={(el) => void (itemRefs.current[i] = el)}
              data-beat={s}
              aria-hidden={s === 'hidden' || undefined}
              className="beat relative grid scroll-mt-32 scroll-mb-48 grid-cols-[1.25rem_1fr] gap-x-4 pb-8 last:pb-0"
            >
              {/* The rail: a dot for the event and a line down to the next one. */}
              <span aria-hidden className="relative flex justify-center">
                <span
                  className={`relative z-[1] mt-2 block size-3 rounded-full border-2 ${
                    s === 'current' ? 'border-accent bg-accent' : 'border-accent bg-background'
                  }`}
                />
                {i < events.length - 1 && <span className="rail absolute top-5 -bottom-2 w-0.5 bg-[var(--field-line)]" />}
              </span>
              <div
                className={`flex gap-4 rounded-xl px-4 py-3 transition-colors duration-300 motion-reduce:transition-none ${
                  s === 'current' ? 'bg-surface-secondary' : ''
                }`}
              >
                <div className="min-w-0 flex-1">
                  <p className="font-serif text-2xl leading-none tabular-nums">{e.when}</p>
                  <h3 className="mt-2 text-lg leading-snug font-medium">{e.title}</h3>
                  {e.detail && <p className="mt-1 text-muted">{e.detail}</p>}
                  <SourceRefs page={page} sources={e.sources} />
                </div>
                {image?.image && (
                  <img
                    src={image.image.source}
                    alt=""
                    className="hidden size-24 shrink-0 rounded-lg border border-border object-cover sm:block"
                  />
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function PointsBrief({ page, brief, state, itemRefs }: LayoutProps) {
  return (
    <ul aria-label="Key points" className="grid gap-5 sm:grid-cols-2">
      {brief.points.map((p, i) => {
        const s = state(i + 1);
        const image = p.sources.map((n) => page.sources[n - 1]).find((src) => src?.image)?.image;
        return (
          <li
            key={i}
            ref={(el) => void (itemRefs.current[i] = el)}
            data-beat={s}
            aria-hidden={s === 'hidden' || undefined}
            className={`beat flex scroll-mt-32 scroll-mb-48 flex-col overflow-hidden rounded-xl border transition-colors duration-300 motion-reduce:transition-none ${
              s === 'current' ? 'border-accent bg-surface-secondary' : 'border-border bg-surface'
            }`}
          >
            {image && <img src={image.source} alt="" className="aspect-[16/9] w-full object-cover" />}
            <div className="flex flex-col gap-1 p-4">
              <h3 className="text-lg leading-snug font-medium">{p.title}</h3>
              <p className="text-muted">{p.detail}</p>
              <SourceRefs page={page} sources={p.sources} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Small source links under an item: the number and the article it comes from. */
function SourceRefs({ page, sources }: { page: ResearchPage; sources: number[] }) {
  if (sources.length === 0) return null;
  return (
    <p className="mt-2 flex flex-wrap gap-1.5">
      {sources.map((n) => {
        const source = page.sources[n - 1];
        return (
          <a
            key={n}
            href={`#${page.id}-source-${n}`}
            className="inline-flex max-w-full items-center gap-1 truncate rounded-full border border-border px-2 py-0.5 text-xs text-muted outline-none hover:border-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
          >
            <span className="text-accent tabular-nums">{n}</span>
            {source.title}
          </a>
        );
      })}
    </p>
  );
}

function SourceChips({ page }: { page: ResearchPage }) {
  return (
    <section aria-labelledby={`${page.id}-sources`} className="flex flex-col gap-2 border-t border-separator pt-6">
      <h3 id={`${page.id}-sources`} className="text-sm font-semibold">
        Sources
      </h3>
      <ol className="flex flex-col gap-1 text-sm">
        {page.sources.map((article, i) => (
          <li key={article.title} id={`${page.id}-source-${i + 1}`} className="flex scroll-mt-28 gap-2">
            <span className="w-5 shrink-0 text-right tabular-nums text-muted">{i + 1}.</span>
            <Link href={article.url} target="_blank" rel="noreferrer" className="text-foreground underline-offset-4 hover:underline">
              {article.title}, Wikipedia
            </Link>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted">Article text from Wikipedia, available under CC BY-SA 4.0. Images have their own licenses.</p>
    </section>
  );
}

function SpeakerIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5L6 9H2v6h4l5 4V5z" />
      <path d="M15.5 8.5a5 5 0 010 7M19 5a10 10 0 010 14" />
    </svg>
  );
}

function MutedIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5L6 9H2v6h4l5 4V5z" />
      <path d="M22 9l-6 6M16 9l6 6" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 5v14l12-7z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6 5h4v14H6zM14 5h4v14h-4z" />
    </svg>
  );
}
