import { useEffect, useRef, useState } from 'react';
import { Button, Form, Input, Spinner, TextField } from '@heroui/react';
import type { ExplorationStep } from '@simsam/models';
import { useVoiceControls, VoiceButtons, VoiceStatusRows } from './VoiceControls';

export type ChatEntry = {
  id: number;
  step: ExplorationStep;
} & (
  | { status: 'pending' }
  | { status: 'error'; message: string }
  | { status: 'done'; reply: string; page: number; /** The AI answer is still streaming in. */ writing?: boolean }
);

interface Props {
  entries: ChatEntry[];
  onAsk: (question: string) => void;
  onRetry: (entry: ChatEntry) => void;
  onGoToPage: (index: number) => void;
}

/**
 * The action center at the bottom of the research canvas: ask follow-ups here.
 * It expands into the full log of what was asked and what each answer added.
 */
export function ChatCenter({ entries, onAsk, onRetry, onGoToPage }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const logEnd = useRef<HTMLLIElement>(null);
  const latest = entries[entries.length - 1];
  const voice = useVoiceControls(onAsk);

  useEffect(() => {
    if (open) logEnd.current?.scrollIntoView({ block: 'end' });
  }, [open, entries]);

  function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    const q = text.trim();
    if (!q) return;
    onAsk(q);
    setText('');
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-3 sm:px-6 sm:pb-5">
      <div className="pointer-events-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_12px_40px_-12px_rgb(0_0_0/0.45)]">
        {open ? (
          <div id="chat-history" className="max-h-[min(55vh,30rem)] overflow-y-auto border-b border-separator px-5 py-4">
            <h2 className="sr-only">Questions and answers</h2>
            <ol className="flex flex-col gap-6">
              {entries.map((entry) => (
                <li key={entry.id}>
                  <EntryView entry={entry} onRetry={onRetry} onGoToPage={onGoToPage} />
                </li>
              ))}
              <li ref={logEnd} aria-hidden />
            </ol>
          </div>
        ) : (
          latest && (
            <div className="border-b border-separator px-5 py-3">
              <Status entry={latest} onRetry={onRetry} onGoToPage={onGoToPage} compact />
            </div>
          )
        )}

        <VoiceStatusRows controls={voice} rowClassName="border-b border-separator px-5 py-3" />

        <Form onSubmit={submit} className="flex items-center gap-2 p-2 pl-3">
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={open ? 'Hide questions and answers' : `Show all questions and answers (${entries.length})`}
            aria-expanded={open}
            aria-controls="chat-history"
            onPress={() => setOpen((o) => !o)}
          >
            <ChevronIcon up={!open} />
          </Button>
          <TextField aria-label="Ask a follow-up question" value={text} onChange={setText} className="min-w-0 flex-1">
            <Input placeholder="Ask a follow-up question" className="chat-input text-base" />
          </TextField>
          <VoiceButtons controls={voice} />
          <Button type="submit" size="sm" className="shrink-0">
            Ask
          </Button>
        </Form>
      </div>
    </div>
  );
}

function EntryView({ entry, onRetry, onGoToPage }: Omit<Props, 'entries' | 'onAsk'> & { entry: ChatEntry }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-muted">{entry.step.kind === 'dive' ? 'You dove into' : 'You asked'}</p>
      <p className="font-serif text-lg leading-snug">{entry.step.text}</p>
      <div className="mt-1 border-l-2 border-accent pl-3">
        <Status entry={entry} onRetry={onRetry} onGoToPage={onGoToPage} />
      </div>
    </div>
  );
}

function Status({
  entry,
  onRetry,
  onGoToPage,
  compact,
}: Omit<Props, 'entries' | 'onAsk'> & { entry: ChatEntry; compact?: boolean }) {
  return (
    // Streaming text would be announced word by word, so the live region waits for the finished answer.
    <div aria-live={entry.status === 'done' && entry.writing ? 'off' : 'polite'} className="text-sm leading-relaxed">
      {entry.status === 'pending' && (
        <span className="inline-flex items-center gap-2 text-muted">
          <Spinner size="sm" aria-hidden />
          Researching {compact ? `“${entry.step.text}”` : 'on Wikipedia'}…
        </span>
      )}
      {entry.status === 'error' && (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{entry.message}</span>
          <button
            type="button"
            onClick={() => onRetry(entry)}
            className="rounded font-medium text-accent underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            Try again
          </button>
        </span>
      )}
      {entry.status === 'done' && entry.writing && !entry.reply && (
        <span className="inline-flex items-center gap-2 text-muted">
          <Spinner size="sm" aria-hidden />
          Writing the answer…
        </span>
      )}
      {entry.status === 'done' && entry.reply && (
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className={compact ? 'line-clamp-2' : ''}>{entry.reply}</span>
          <button
            type="button"
            onClick={() => onGoToPage(entry.page)}
            className="shrink-0 rounded font-medium text-accent underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            Go to page {entry.page + 1}
          </button>
        </span>
      )}
    </div>
  );
}

function ChevronIcon({ up }: { up: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={up ? 'M6 15l6-6 6 6' : 'M6 9l6 6 6-6'} />
    </svg>
  );
}
