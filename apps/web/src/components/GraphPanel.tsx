import { useEffect, useState } from 'react';
import { Alert, Button, Link, Skeleton, Spinner } from '@heroui/react';
import { articleUrl, getSummary, MAX_DEPTH, type Summary, type TopicGraph as Graph } from '../lib/wikipedia';
import { TopicGraph } from './TopicGraph';

export type GraphState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; graph: Graph; growing: boolean };

interface Props {
  state: GraphState | undefined;
  onDive: (title: string) => void;
  onRetry: () => void;
  /** Collapse the panel to a slim rail (desktop). */
  onCollapse?: () => void;
}

/** The map beside the research canvas. It follows whichever page is in view. */
export function GraphPanel({ state, onDive, onRetry, onCollapse }: Props) {
  const center = state?.status === 'ready' ? state.graph.center : undefined;
  const [selected, setSelected] = useState('');
  useEffect(() => setSelected(center ?? ''), [center]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-start justify-between gap-3 px-5 pt-3">
        <h2 className="pt-1.5 text-sm font-semibold">{center ? `Map around ${center}` : 'Topic map'}</h2>
        <div className="flex shrink-0 items-center gap-2">
          {state?.status === 'ready' && state.growing && (
            <span aria-live="polite" className="inline-flex items-center gap-2 text-sm text-muted">
              <Spinner size="sm" aria-hidden />
              Mapping step {state.graph.depth + 1} of {MAX_DEPTH}
            </span>
          )}
          {onCollapse && (
            <Button isIconOnly size="sm" variant="ghost" aria-label="Collapse map" onPress={onCollapse} className="max-lg:hidden">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M9 6l6 6-6 6" />
              </svg>
            </Button>
          )}
        </div>
      </header>
      {center && (
        <p className="px-5 text-sm text-muted">
          Lines join related topics. Drag to pan or move a topic, scroll to zoom.
        </p>
      )}

      <div className="relative min-h-0 flex-1">
        {(!state || state.status === 'loading') && (
          <div className="flex h-full min-h-[20rem] items-center justify-center">
            <Spinner aria-label="Mapping topics" />
          </div>
        )}
        {state?.status === 'error' && (
          <div className="flex h-full min-h-[20rem] items-center justify-center p-6">
            <Alert status="danger">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>The topic map didn’t load from Wikipedia.</Alert.Title>
                <Alert.Description>Check your connection, then try again.</Alert.Description>
              </Alert.Content>
              <Button size="sm" variant="secondary" onPress={onRetry}>
                Try again
              </Button>
            </Alert>
          </div>
        )}
        {state?.status === 'ready' && (
          <TopicGraph key={state.graph.center} graph={state.graph} selected={selected} onSelect={setSelected} />
        )}
      </div>

      {center && selected && selected !== center && (
        <TopicPreview title={selected} onDive={onDive} onClose={() => setSelected(center)} />
      )}
    </div>
  );
}

function TopicPreview({ title, onDive, onClose }: { title: string; onDive: (t: string) => void; onClose: () => void }) {
  const [summary, setSummary] = useState<Summary | null | 'error'>(null);

  useEffect(() => {
    const controller = new AbortController();
    setSummary(null);
    getSummary(title, controller.signal)
      .then(setSummary)
      .catch(() => !controller.signal.aborted && setSummary('error'));
    return () => controller.abort();
  }, [title]);

  return (
    <section aria-labelledby="preview-title" className="border-t border-border bg-surface px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="preview-title" className="font-serif text-xl leading-snug">
            {title}
          </h3>
          {summary && summary !== 'error' && summary.description && (
            <p className="text-sm text-muted first-letter:uppercase">{summary.description}</p>
          )}
        </div>
        <Button isIconOnly size="sm" variant="ghost" aria-label="Close preview" onPress={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </Button>
      </div>
      <div aria-live="polite" className="mt-2">
        {summary === null && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-3.5 w-full rounded" />
            <Skeleton className="h-3.5 w-4/5 rounded" />
          </div>
        )}
        {summary === 'error' && <p className="text-sm text-muted">The summary didn’t load from Wikipedia.</p>}
        {summary && summary !== 'error' && (
          <p className="line-clamp-4 font-serif leading-relaxed">{summary.extract}</p>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <Button size="sm" onPress={() => onDive(title)}>
          Dive into this topic
        </Button>
        <Link
          href={summary && summary !== 'error' ? summary.url : articleUrl(title)}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-foreground underline underline-offset-4"
        >
          Read on Wikipedia
        </Link>
      </div>
    </section>
  );
}
