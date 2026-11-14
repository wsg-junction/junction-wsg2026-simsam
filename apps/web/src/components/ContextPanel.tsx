import { useState } from 'react';
import { Button, Form, Input, Link, Spinner, TextField } from '@heroui/react';
import type { ContextResponse } from '@simsam/models';
import { CitedText } from './Cite';

/** One request for web context on a page: asked in the panel, or started by the AI for the page's question. */
export interface ContextEntry {
  id: number;
  question: string;
  /** Started by the AI's planner (it judged the question needs more than Wikipedia), not typed here. */
  auto: boolean;
  state: { status: 'loading' } | { status: 'ready'; result: ContextResponse } | { status: 'error' };
}

interface Props {
  /** The page's topic: context is found about it. */
  topic: string | undefined;
  /** The page's own question, offered as a one-click context search. */
  pageQuestion: string | undefined;
  entries: ContextEntry[];
  onAsk: (question: string) => void;
  onRetry: (entry: ContextEntry) => void;
}

/**
 * Web context beside the research canvas (context.dev). It follows the page in
 * view, and stays apart from the page's Wikipedia content and answer.
 */
export function ContextPanel({ topic, pageQuestion, entries, onAsk, onRetry }: Props) {
  const [text, setText] = useState('');
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = text.trim();
    if (!q) return;
    onAsk(q);
    setText('');
  };
  const newestFirst = [...entries].reverse();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-5 pt-3">
        <h2 className="pt-1.5 text-sm font-semibold">{topic ? `Context on ${topic}` : 'Context'}</h2>
        <p className="text-sm text-muted">
          From the web, beside the Wikipedia page. It doesn’t change the page or its answer.
        </p>
        <Form onSubmit={submit} className="mt-3 flex items-center gap-2">
          <TextField
            aria-label={topic ? `Find context on ${topic}` : 'Find context'}
            value={text}
            onChange={setText}
            isDisabled={!topic}
            className="min-w-0 flex-1"
          >
            <Input placeholder="e.g. impact on the financial sector" className="text-base" />
          </TextField>
          <Button type="submit" size="sm" variant="secondary" isDisabled={!topic} className="shrink-0">
            Find context
          </Button>
        </Form>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-6">
        {entries.length === 0 && (
          <div className="flex flex-col items-start gap-3 text-sm">
            <p className="text-muted">
              Wikipedia stays the main source. Ask here for what articles don’t cover: consequences in one field,
              figures, analysis or recent developments.
            </p>
            {pageQuestion && topic && (
              <Button size="sm" variant="ghost" onPress={() => onAsk(pageQuestion)} className="h-auto py-1.5 text-left whitespace-normal">
                Find context for “{pageQuestion}”
              </Button>
            )}
          </div>
        )}
        <ol className="flex flex-col gap-8">
          {newestFirst.map((entry) => (
            <li key={entry.id}>
              <EntryView entry={entry} onRetry={() => onRetry(entry)} />
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function EntryView({ entry, onRetry }: { entry: ContextEntry; onRetry: () => void }) {
  const { state } = entry;
  const anchor = (n: number) => `context-${entry.id}-${n}`;
  return (
    <article aria-labelledby={`context-${entry.id}`} aria-busy={state.status === 'loading' || undefined} className="flex flex-col gap-3">
      <div>
        <p className="text-xs text-muted">{entry.auto ? 'Found for your question' : 'You asked for context on'}</p>
        <h3 id={`context-${entry.id}`} className="font-serif text-lg leading-snug">
          {entry.question}
        </h3>
      </div>

      {state.status === 'loading' && (
        <p aria-live="polite" className="inline-flex items-center gap-2 text-sm text-muted">
          <Spinner size="sm" aria-hidden />
          Searching the web…
        </p>
      )}

      {state.status === 'error' && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <p className="text-muted">The web search didn’t respond.</p>
          <Button size="sm" variant="secondary" onPress={onRetry}>
            Try again
          </Button>
        </div>
      )}

      {state.status === 'ready' && state.result.sources.length === 0 && (
        <p className="text-sm text-muted">No web pages matched “{state.result.query}”. Try naming a more specific angle.</p>
      )}

      {state.status === 'ready' && state.result.sources.length > 0 && (
        <>
          {state.result.summary && (
            <div className="flex flex-col gap-1">
              <CitedText
                text={state.result.summary}
                sourceCount={state.result.sources.length}
                href={(n) => `#${anchor(n)}`}
                className="font-serif leading-relaxed"
              />
              <p className="text-xs text-muted">Summary written by AI from the web pages below. Check the citations.</p>
            </div>
          )}
          <ol className="flex flex-col gap-3 text-sm">
            {state.result.sources.map((source, i) => (
              <li key={source.url} id={anchor(i + 1)} className="flex scroll-mt-4 gap-2">
                <span className="w-5 shrink-0 text-right tabular-nums text-muted">{i + 1}.</span>
                <div className="min-w-0">
                  <Link
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-foreground underline-offset-4 hover:underline"
                  >
                    {source.title}
                  </Link>
                  <p className="text-xs text-muted">{source.site}</p>
                  <p className="mt-1 line-clamp-4 text-muted">{source.text}</p>
                </div>
              </li>
            ))}
          </ol>
          <p className="text-xs text-muted">
            Searched for “{state.result.query}”. Passages are quoted from the linked pages and belong to their publishers.
          </p>
        </>
      )}
    </article>
  );
}
