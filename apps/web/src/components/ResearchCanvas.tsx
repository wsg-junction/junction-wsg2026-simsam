import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from 'react';
import { Skeleton } from '@heroui/react';
import type { ExplorationStep } from '@simsam/models';
import type { PageAnswer, PageBrief, ResearchPage } from '../lib/research';
import { prefersReducedMotion } from '../lib/motion';
import { CompactPageView } from './CompactPageView';
import { Floating } from './Floating';
import { ResearchPageView } from './ResearchPageView';

export interface ResearchCanvasHandle {
  scrollToPage: (index: number) => void;
}

interface Props {
  pages: ResearchPage[];
  mode: 'detailed' | 'compact';
  briefs: Record<string, PageBrief>;
  answers: Record<string, PageAnswer>;
  onRetryAnswer: (pageIndex: number) => void;
  /** A step still being researched; shown as a placeholder page at the end. */
  pending?: ExplorationStep;
  active: number;
  onActiveChange: (index: number) => void;
  onDive: (title: string) => void;
  onHistory?: (title: string) => void;
  empty?: ReactNode;
}

/**
 * The research canvas: one page per question or dive, stacked vertically.
 * Scrolling snaps to the start of each page, and the dots on the right jump
 * between pages.
 */
export const ResearchCanvas = forwardRef<ResearchCanvasHandle, Props>(function ResearchCanvas(
  { pages, mode, briefs, answers, onRetryAnswer, onHistory, pending, active, onActiveChange, onDive, empty },
  ref,
) {
  const scroller = useRef<HTMLDivElement>(null);
  const dots = useRef<(HTMLButtonElement | null)[]>([]);
  const [tip, setTip] = useState<number | null>(null);
  const hideTip = (i: number) => setTip((t) => (t === i ? null : t));
  const total = pages.length + (pending ? 1 : 0);

  const scrollToPage = (index: number) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-page="${index}"]`);
    if (!el || !scroller.current) return;
    scroller.current.scrollTo({ top: el.offsetTop, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };
  useImperativeHandle(ref, () => ({ scrollToPage }));

  // Track the page that fills most of the top of the view.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = el.scrollTop + el.clientHeight * 0.4;
      let current = 0;
      el.querySelectorAll<HTMLElement>('[data-page]').forEach((page) => {
        if (page.offsetTop <= line) current = Number(page.dataset.page);
      });
      onActiveChange(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [onActiveChange]);

  // Bring each new page (or its placeholder) into view as it's added.
  const lastCount = useRef(0);
  useEffect(() => {
    if (total > lastCount.current && total > 1) scrollToPage(total - 1);
    lastCount.current = total;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total]);

  return (
    <div className="relative h-full">
      <div ref={scroller} className="relative h-full snap-y snap-mandatory overflow-y-auto">
        {pages.map((page, i) =>
          // History pages are a timeline in either mode.
          mode === 'compact' || page.history ? (
            <CompactPageView
              key={page.id}
              page={page}
              index={i}
              total={total}
              brief={briefs[page.id]}
              isActive={i === active}
              onHistory={onHistory}
            />
          ) : (
          <ResearchPageView
            key={page.id}
            page={page}
            index={i}
            total={total}
            answer={answers[page.id]}
            onDive={onDive}
            onRetryAnswer={() => onRetryAnswer(i)}
            onHistory={onHistory}
          />
          ),
        )}
        {pending && (
          <section
            data-page={pages.length}
            aria-busy
            aria-label={`Researching ${pending.text}`}
            className="min-h-full snap-start"
          >
            <header className="sticky top-0 z-10 border-b border-separator bg-background px-6 py-4 sm:px-10">
              <p className="text-sm text-muted">
                Page {pages.length + 1} of {total}
              </p>
              <h2 className="mt-1 font-serif text-2xl leading-snug font-normal sm:text-3xl">{pending.text}</h2>
            </header>
            <div className="flex max-w-3xl flex-col gap-4 px-6 pt-8 sm:px-10">
              <Skeleton className="h-64 w-full rounded-xl" />
              <Skeleton className="h-6 w-1/2 rounded" />
              <Skeleton className="h-4 w-full rounded" />
              <Skeleton className="h-4 w-11/12 rounded" />
              <Skeleton className="h-4 w-4/5 rounded" />
            </div>
          </section>
        )}
        {total === 0 && empty}
      </div>

      {total > 1 && (
        <nav aria-label="Pages" className="absolute top-1/2 right-2 z-20 -translate-y-1/2 sm:right-4">
          <ol className="flex flex-col items-center gap-1">
            {Array.from({ length: total }, (_, i) => {
              const label = i < pages.length ? pages[i].step.text : pending!.text;
              return (
                <li
                  key={i}
                  className="group"
                  onPointerEnter={() => setTip(i)}
                  onPointerLeave={() => hideTip(i)}
                >
                  <button
                    ref={(el) => void (dots.current[i] = el)}
                    type="button"
                    onFocus={(e) => e.currentTarget.matches(':focus-visible') && setTip(i)}
                    onBlur={() => hideTip(i)}
                    onClick={() => scrollToPage(i)}
                    aria-label={`Page ${i + 1}: ${label}`}
                    aria-current={i === active ? 'page' : undefined}
                    className="flex size-7 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  >
                    <span
                      className={`block rounded-full border-2 transition-all motion-reduce:transition-none ${
                        i === active
                          ? 'size-3 border-accent bg-accent'
                          : 'size-2.5 border-[var(--field-line)] bg-background group-hover:border-accent'
                      }`}
                    />
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      )}
      {tip !== null && tip < total && (
        <Floating anchor={dots.current[tip] ?? null} placement="left" className="px-2.5 py-1 text-sm">
          <span className="line-clamp-2">{tip < pages.length ? pages[tip].step.text : pending?.text}</span>
        </Floating>
      )}
    </div>
  );
});
