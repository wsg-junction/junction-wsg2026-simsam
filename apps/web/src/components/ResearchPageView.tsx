import { Button, Link, Separator } from '@heroui/react';
import { sentences, type ResearchPage } from '../lib/research';
import { Cite } from './Cite';
import { Timeline } from './Timeline';

interface Props {
  page: ResearchPage;
  index: number;
  total: number;
  onDive: (title: string) => void;
  /** Show how an article changed over time (only when its history is stored). */
  onHistory?: (title: string) => void;
}

const KIND_LABEL = {
  question: 'Follow-up question',
  dive: 'Dove into a topic',
  history: 'Article history',
} as const;

/** One page of the research canvas: everything gathered for a single question or dive. */
export function ResearchPageView({ page, index, total, onDive, onHistory }: Props) {
  const [lead, ...more] = page.sources;
  const href = (n: number) => `#${page.id}-source-${n}`;
  const paragraphs = lead.extract.split(/\n+/).filter(Boolean).slice(0, 2);

  return (
    <section
      data-page={index}
      id={page.id}
      aria-labelledby={`${page.id}-title`}
      className="relative min-h-full"
    >
      <PageHeader page={page} index={index} total={total} />

      <div className={`flex flex-col gap-12 pt-8 pb-44 ${PAGE_COLUMN}`}>
        {/* The closest article, at length. */}
        <article aria-labelledby={`${page.id}-lead`} className="flex flex-col gap-4">
          {lead.image && (
            <figure className="flex flex-col gap-2">
              <img
                src={lead.image.source}
                alt=""
                width={lead.image.width}
                height={lead.image.height}
                className="max-h-80 w-full rounded-xl border border-border object-cover"
              />
              <figcaption className="text-xs text-muted">Image from the Wikipedia article on {lead.title}</figcaption>
            </figure>
          )}
          <div>
            <h3 id={`${page.id}-lead`} className="font-serif text-2xl font-normal">
              {lead.title}
            </h3>
            {lead.description && <p className="mt-1 text-sm text-muted first-letter:uppercase">{lead.description}</p>}
          </div>
          {onHistory && (
            <div>
              <Button size="sm" variant="secondary" onPress={() => onHistory(lead.title)}>
                See how this article changed
              </Button>
            </div>
          )}
          {paragraphs.map((p, i) => (
            <p key={i} className="font-serif text-[1.125rem] leading-[1.7]">
              {p}
              {i === paragraphs.length - 1 && <Cite n={1} href={href(1)} />}
            </p>
          ))}
        </article>

        {page.timeline.length >= 2 && (
          <section aria-labelledby={`${page.id}-dates`} className="flex flex-col gap-4">
            <div>
              <h3 id={`${page.id}-dates`} className="text-base font-semibold">
                Dates in these articles
              </h3>
              <p className="text-sm text-muted">
                {page.timeline[0].year} to {page.timeline[page.timeline.length - 1].year}, from the sources below
              </p>
            </div>
            <Timeline events={page.timeline} sourceHref={href} />
          </section>
        )}

        {more.length > 0 && (
          <section aria-labelledby={`${page.id}-more`} className="flex flex-col gap-4">
            <h3 id={`${page.id}-more`} className="text-base font-semibold">
              Also relevant
            </h3>
            <ul className="grid gap-x-6 gap-y-8 sm:grid-cols-2 xl:grid-cols-3">
              {more.map((article, i) => (
                <li key={article.title} className="flex flex-col gap-2">
                  {article.image ? (
                    <img
                      src={article.image.source}
                      alt=""
                      className="aspect-[4/3] w-full rounded-lg border border-border object-cover"
                    />
                  ) : (
                    <div aria-hidden className="aspect-[4/3] w-full rounded-lg border border-border bg-surface-secondary" />
                  )}
                  <h4 className="font-medium leading-snug">{article.title}</h4>
                  {article.description && (
                    <p className="text-sm text-muted first-letter:uppercase">{article.description}</p>
                  )}
                  <p className="font-serif text-[0.975rem] leading-relaxed">
                    {sentences(article.extract).slice(0, 2).join(' ')}
                    <Cite n={i + 2} href={href(i + 2)} />
                  </p>
                  <div className="mt-auto pt-1">
                    <Button size="sm" variant="secondary" onPress={() => onDive(article.title)}>
                      Dive into {article.title.length > 28 ? 'this topic' : article.title}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        <Separator />

        <section aria-labelledby={`${page.id}-sources`} className="flex flex-col gap-3">
          <h3 id={`${page.id}-sources`} className="text-sm font-semibold">
            Sources
          </h3>
          <ol className="flex flex-col gap-1.5 text-sm">
            {page.sources.map((article, i) => (
              <li key={article.url} id={`${page.id}-source-${i + 1}`} className="flex scroll-mt-28 gap-2">
                <span className="w-5 shrink-0 text-right tabular-nums text-muted">{i + 1}.</span>
                <Link
                  href={article.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground underline-offset-4 hover:underline"
                >
                  {article.title}, Wikipedia
                </Link>
              </li>
            ))}
          </ol>
          <p className="text-xs text-muted">
            Article text from Wikipedia, available under{' '}
            <Link
              href="https://creativecommons.org/licenses/by-sa/4.0/"
              target="_blank"
              rel="noreferrer"
              className="text-xs text-muted underline underline-offset-2"
            >
              CC BY-SA 4.0
            </Link>
            . Images have their own licenses on Wikipedia.
          </p>
        </section>
      </div>
    </section>
  );
}

/**
 * The reading column, centered in the canvas. The side padding is symmetric
 * and wide enough on the right for the page dots, so centering stays true.
 */
export const PAGE_COLUMN = 'mx-auto w-full max-w-3xl px-12 sm:px-16';

/** The page's sticky heading: which page this is, and the question or topic it answers. */
export function PageHeader({ page, index, total }: { page: ResearchPage; index: number; total: number }) {
  return (
    <header className="sticky top-0 z-10 border-b border-separator bg-background py-4">
      {/* The same centered column as the page below, so the heading lines up with the text. */}
      <div className={PAGE_COLUMN}>
        <p className="text-sm text-muted">
          Page {index + 1} of {total}
          {index > 0 && <span className="ml-3">{KIND_LABEL[page.step.kind]}</span>}
        </p>
        <h2
          id={`${page.id}-title`}
          className={`mt-1 font-serif text-2xl leading-snug font-normal text-balance sm:text-3xl ${
            index === 0 ? 'question-transition' : ''
          }`}
        >
          {page.step.kind === 'history' ? `How “${page.step.text}” has changed` : page.step.text}
        </h2>
      </div>
    </header>
  );
}
