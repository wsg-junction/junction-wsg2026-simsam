import { useMemo, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import type { DeepReport, ReportDataset, ReportPart, ReportSource } from '@simsam/models';
import { figureLabel, methodText, referenceText, reportMarkdown } from '../lib/report';
import { prefersReducedMotion } from '../lib/motion';
import { CitedText } from './Cite';
import { TimelineExplorer } from './TimelineExplorer';

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * A deep research report as a canvas: abstract, research questions, the
 * zoomable timeline, one page per part (sections, key facts, data, figures),
 * findings, limitations, method and references. A contents list on the left
 * on wide screens.
 */
export function DeepReportView({ report, toolbar }: { report: DeepReport; toolbar?: React.ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const id = (part: string) => `rep-${report.id}-${part}`;
  const src = (n: number) => `#${id(`src-${n}`)}`;
  const count = report.sources.length;

  const goTo = (part: string) => {
    const el = scroller.current?.querySelector<HTMLElement>(`#${CSS.escape(id(part))}`);
    if (!el || !scroller.current) return;
    scroller.current.scrollTo({ top: el.offsetTop - 16, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  };

  const contents: { key: string; label: string }[] = [
    { key: 'abstract', label: 'Abstract' },
    { key: 'questions', label: 'Research questions' },
    { key: 'timeline', label: 'Timeline' },
    ...report.parts.map((p) => ({ key: `part-${p.n}`, label: `${p.n}. ${p.title}` })),
    { key: 'findings', label: 'Findings' },
    { key: 'limitations', label: 'Limitations' },
    { key: 'method', label: 'Method' },
    { key: 'references', label: 'References' },
  ];

  const download = () => {
    const blob = new Blob([reportMarkdown(report)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${report.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 80) || 'report'}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const event = report.events.find((e) => e.id === selected);
  const kinds = useMemo(() => {
    const c = { wikipedia: 0, figure: 0, web: 0 };
    for (const s of report.sources) c[s.kind]++;
    return c;
  }, [report.sources]);

  return (
    <div ref={scroller} className="relative h-full overflow-y-auto" style={{ paddingBottom: 120 }}>
      <div className="mx-auto flex max-w-6xl gap-10 px-4 sm:px-8">
        <nav aria-label="Report contents" className="sticky top-0 hidden max-h-screen w-56 shrink-0 self-start overflow-y-auto py-8 xl:block">
          <p className="mb-2 text-xs font-medium text-muted">Contents</p>
          <ol className="flex flex-col gap-0.5 text-sm">
            {contents.map((c) => (
              <li key={c.key}>
                <button
                  type="button"
                  onClick={() => goTo(c.key)}
                  className="w-full rounded px-2 py-1 text-left text-muted outline-none hover:bg-default hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
                >
                  {c.label}
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <article className="min-w-0 flex-1 py-8">
          <header className="flex flex-col gap-3 border-b border-separator pb-6">
            <p className="text-sm text-muted">Deep research report</p>
            <h2 className="font-serif text-3xl leading-tight font-normal text-balance sm:text-4xl">{report.title}</h2>
            <p className="text-sm text-muted">
              {formatDate(report.createdAt)}. {report.parts.length} parts, {report.events.length} dated events, {count} cited sources:{' '}
              {kinds.wikipedia} Wikipedia passages, {kinds.figure} figures{report.web ? `, ${kinds.web} web pages` : ''}.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onPress={download}>
                Download as Markdown
              </Button>
              {toolbar}
            </div>
          </header>

          <Section id={id('abstract')} title="Abstract">
            <div className="flex flex-col gap-3">
              <CitedText text={report.abstract} sourceCount={count} href={src} className="font-serif text-lg leading-relaxed" />
            </div>
            <p className="mt-3 text-xs text-muted">Written by AI from the parts below. Check the citations.</p>
          </Section>

          <Section id={id('questions')} title="Research questions">
            <ol className="flex list-decimal flex-col gap-1.5 pl-6 font-serif text-lg">
              {report.questions.map((q, i) => (
                <li key={i} className="pl-1">
                  {q}
                </li>
              ))}
            </ol>
            <button
              type="button"
              onClick={() => goTo('findings')}
              className="mt-3 rounded text-sm text-muted underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
            >
              Go to the findings
            </button>
          </Section>

          <Section id={id('timeline')} title="Timeline">
            {report.events.length > 0 ? (
              <>
                <TimelineExplorer
                  events={report.events}
                  eras={report.eras}
                  parts={report.parts}
                  selected={selected}
                  onSelect={setSelected}
                />
                {event ? (
                  <div className="mt-3 rounded-lg border border-accent bg-surface p-4" aria-live="polite">
                    <p className="text-sm text-muted">
                      {event.when}.{' '}
                      <button type="button" onClick={() => goTo(`part-${event.part}`)} className="underline underline-offset-4 hover:text-foreground">
                        Part {event.part}: {report.parts.find((p) => p.n === event.part)?.title}
                      </button>
                    </p>
                    <h4 className="mt-1 font-serif text-xl">{event.title}</h4>
                    <div className="mt-1 flex flex-col gap-2">
                      <CitedText
                        text={event.detail + (/\[\d+\]/.test(event.detail) ? '' : event.sources.map((n) => `[${n}]`).join(''))}
                        sourceCount={count}
                        href={src}
                        className="leading-relaxed"
                      />
                    </div>
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted">Select an event to read about it.</p>
                )}
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer rounded text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus">
                    All {report.events.length} events as a list
                  </summary>
                  <ol className="mt-2 flex flex-col gap-1">
                    {report.events.map((e) => (
                      <li key={e.id}>
                        <button
                          type="button"
                          onClick={() => setSelected(e.id)}
                          className="text-left outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
                        >
                          <span className="tabular-nums text-muted">{e.when}</span>: {e.title}
                          {e.importance === 1 && <span className="text-muted"> (turning point)</span>}
                        </button>
                      </li>
                    ))}
                  </ol>
                </details>
              </>
            ) : (
              <p className="text-sm text-muted">The evidence had no dated events.</p>
            )}
          </Section>

          {report.parts.map((part) => (
            <PartView key={part.n} part={part} total={report.parts.length} id={id(`part-${part.n}`)} sources={report.sources} src={src} />
          ))}

          <Section id={id('findings')} title="Findings">
            <ol className="flex flex-col gap-5">
              {report.questions.map((q, i) => {
                const answer = report.answers.find((a) => a.question === i + 1);
                return (
                  <li key={i} className="flex flex-col gap-1.5">
                    <h4 className="font-serif text-lg font-medium">
                      {i + 1}. {q}
                    </h4>
                    {answer ? (
                      <div className="flex flex-col gap-2">
                        <CitedText text={answer.text} sourceCount={count} href={src} className="leading-relaxed" />
                      </div>
                    ) : (
                      <p className="text-sm text-muted">The parts don’t settle this question.</p>
                    )}
                  </li>
                );
              })}
            </ol>
            <p className="mt-3 text-xs text-muted">Answers written by AI from the parts. Check the citations.</p>
          </Section>

          <Section id={id('limitations')} title="Limitations">
            <p className="leading-relaxed">{report.limitations || 'None noted.'}</p>
          </Section>

          <Section id={id('method')} title="Method">
            <p className="leading-relaxed">{methodText(report)}</p>
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer rounded text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus">
                The {new Set(report.method.queries).size} search queries
              </summary>
              <ul className="mt-2 flex flex-col gap-0.5 text-muted">
                {[...new Set(report.method.queries)].map((q) => (
                  <li key={q}>“{q}”</li>
                ))}
              </ul>
            </details>
          </Section>

          <Section id={id('references')} title="References">
            <ol className="flex flex-col gap-2 text-sm">
              {report.sources.map((s) => (
                <li key={s.n} id={id(`src-${s.n}`)} className="flex scroll-mt-4 gap-2">
                  <span className="w-7 shrink-0 text-right tabular-nums text-muted">{s.n}.</span>
                  <span className="min-w-0">
                    <a href={s.url} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
                      {referenceText(s)}
                    </a>{' '}
                    <span className="text-xs text-muted">
                      {s.kind === 'web' ? 'Web' : s.kind === 'figure' ? 'Figure' : s.stored ? 'Collection' : 'Live Wikipedia'}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-4 text-xs text-muted">
              Wikipedia text is available under CC BY-SA 4.0. Web passages belong to their publishers.
            </p>
          </Section>
        </article>
      </div>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-4 border-b border-separator py-8">
      <h3 id={`${id}-h`} className="mb-4 text-sm font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

function PartView({
  part,
  total,
  id,
  sources,
  src,
}: {
  part: ReportPart;
  total: number;
  id: string;
  sources: ReportSource[];
  src: (n: number) => string;
}) {
  const count = sources.length;
  const figures = part.figures.map((n) => sources[n - 1]).filter((s): s is ReportSource => Boolean(s));
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-4 border-b border-separator py-10">
      <p className="text-sm text-muted">
        Part {part.n} of {total}
      </p>
      <h3 id={`${id}-h`} className="mt-1 font-serif text-2xl leading-snug font-normal sm:text-3xl">
        {part.title}
      </h3>
      <p className="mt-1 text-muted">{part.focus}</p>
      <div className="mt-5 flex flex-col gap-3">
        <CitedText text={part.summary} sourceCount={count} href={src} className="font-serif text-lg leading-relaxed" />
      </div>

      {part.facts.length > 0 && (
        <dl className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {part.facts.map((f, i) => (
            <div key={i} className="rounded-lg border border-border bg-surface px-4 py-3">
              <dt className="text-xs text-muted">{f.label}</dt>
              <dd className="mt-0.5 font-serif text-lg leading-snug">
                {f.value}
                <CitedInline ns={f.sources} src={src} count={count} />
              </dd>
            </div>
          ))}
        </dl>
      )}

      {part.sections.map((s, i) => (
        <div key={i} className="mt-8">
          <h4 className="mb-2 font-serif text-xl font-medium">{s.heading}</h4>
          <div className="flex flex-col gap-3">
            <CitedText text={s.text} sourceCount={count} href={src} className="font-serif text-[1.05rem] leading-[1.7]" />
          </div>
          {/* The data chart sits after the first section, where the numbers are discussed. */}
          {i === 0 && part.dataset && <DatasetChart data={part.dataset} src={src} count={count} />}
        </div>
      ))}
      {part.sections.length === 0 && part.dataset && <DatasetChart data={part.dataset} src={src} count={count} />}

      {figures.length > 0 && (
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {figures.map((f) => (
            <FigureCard key={f.n} source={f} src={src} />
          ))}
        </div>
      )}
    </section>
  );
}

function CitedInline({ ns, src, count }: { ns: number[]; src: (n: number) => string; count: number }) {
  return (
    <>
      {ns
        .filter((n) => n >= 1 && n <= count)
        .map((n) => (
          <sup key={n} className="ml-0.5 font-sans text-[0.7em]">
            <a href={src(n)} aria-label={`Source ${n}`} className="rounded px-0.5 text-accent no-underline hover:underline">
              [{n}]
            </a>
          </sup>
        ))}
    </>
  );
}

/** Comparable figures from the evidence as horizontal bars, values written out. */
function DatasetChart({ data, src, count }: { data: ReportDataset; src: (n: number) => string; count: number }) {
  const max = Math.max(...data.items.map((i) => Math.abs(i.value)), 1);
  return (
    <figure className="mt-6 rounded-lg border border-border bg-surface p-4">
      <figcaption className="mb-3 text-sm font-medium">
        {data.title}
        {data.unit && <span className="font-normal text-muted"> ({data.unit})</span>}
        <CitedInline ns={data.sources} src={src} count={count} />
      </figcaption>
      <table className="w-full border-separate border-spacing-y-1.5 text-sm">
        <thead className="sr-only">
          <tr>
            <th>Item</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((item, i) => (
            <tr key={i}>
              <th scope="row" className="w-[38%] pr-3 text-left align-middle font-normal text-muted">
                {item.label}
              </th>
              <td className="align-middle">
                <div className="flex items-center gap-2">
                  <div className="h-4 min-w-0 flex-1">
                    <div
                      className="h-full rounded-r bg-[var(--chart-bar)]"
                      style={{ width: `${Math.max((Math.abs(item.value) / max) * 100, 0.8)}%` }}
                      title={`${item.label}: ${item.value.toLocaleString('en-GB')}${data.unit ? ` ${data.unit}` : ''}`}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right tabular-nums">{item.value.toLocaleString('en-GB')}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted">Figures as stated in the sources, gathered by AI. They may use different counting methods.</p>
    </figure>
  );
}

/** A figure from the evidence: the image (or the table or infobox itself) with what it shows. */
function FigureCard({ source, src }: { source: ReportSource; src: (n: number) => string }) {
  const label = figureLabel(source);
  const content = source.content ?? '';
  const isTable = source.mediaKind === 'table';
  const isInfobox = source.mediaKind === 'infobox';
  const rows = isTable ? content.split('\n').map((l) => l.split(' | ')) : [];
  return (
    <figure className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
      {source.imageUrl && !isTable && !isInfobox && (
        <a href={source.imageUrl} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md bg-white">
          <img src={source.imageUrl} alt={`${label}: ${source.caption ?? source.title}`} loading="lazy" className="max-h-80 w-full object-contain" />
        </a>
      )}
      {isTable && rows.length > 1 && (
        <div className="max-h-80 overflow-auto rounded-md border border-separator">
          <table className="w-full text-xs">
            <thead className="bg-default">
              <tr>
                {rows[0].map((c, i) => (
                  <th key={i} className="px-2 py-1 text-left font-medium">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((r, i) => (
                <tr key={i} className="border-t border-separator">
                  {r.map((c, j) => (
                    <td key={j} className="px-2 py-1 align-top">
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {isInfobox && (
        <dl className="grid max-h-80 grid-cols-[auto_1fr] gap-x-3 gap-y-1 overflow-auto text-xs">
          {content
            .split('\n')
            .slice(0, 16)
            .map((line, i) => {
              const at = line.indexOf(': ');
              return (
                <div key={i} className="contents">
                  <dt className="text-muted">{at === -1 ? '' : line.slice(0, at)}</dt>
                  <dd>{at === -1 ? line : line.slice(at + 2)}</dd>
                </div>
              );
            })}
        </dl>
      )}
      <figcaption className="text-sm">
        <span className="font-medium">{label}</span>
        {source.caption ? `: ${source.caption}` : ''}{' '}
        <a href={src(source.n)} className="text-accent no-underline hover:underline" aria-label={`Source ${source.n}`}>
          [{source.n}]
        </a>
        <span className="block text-xs text-muted">From the Wikipedia article “{source.title}”.</span>
      </figcaption>
      {source.imageUrl && !isTable && !isInfobox && content && (
        <details className="text-xs">
          <summary className="cursor-pointer rounded text-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus">
            What it shows (read from the image by AI)
          </summary>
          <p className="mt-1 whitespace-pre-line text-muted">{content}</p>
        </details>
      )}
    </figure>
  );
}
