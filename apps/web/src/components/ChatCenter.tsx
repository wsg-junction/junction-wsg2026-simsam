import { useEffect, useRef, useState } from 'react';
import { Button, Form, Input, Spinner, TextField } from '@heroui/react';
import type { ExplorationStep } from '@simsam/models';
import type { PageAnswer } from '../lib/research';
import { CitedText, withoutCitations } from './Cite';
import type { ContextEntry } from './ContextPanel';
import { PhotoButton } from './PhotoButton';
import { useVoiceControls, VoiceButtons, VoiceStatusRows } from './VoiceControls';

/** Where a typed question goes: the AI decides, a new page of articles, or the context panel. */
export type AskMode = 'auto' | 'articles' | 'context';

export type ChatEntry = {
  id: number;
  step: ExplorationStep;
  /** Asked with a photo: its thumbnail (a data URL). The step's text is what the AI saw in it. */
  photo?: string;
} & (
  | { status: 'pending'; /** The AI is deciding between articles and context. */ routing?: boolean; /** The AI is looking at the photo. */ reading?: boolean }
  | { status: 'error'; message: string; /** False when trying again can't help (the photo wasn't readable). */ canRetry?: boolean }
  | {
      status: 'done';
      reply: string;
      page: number;
      /** The AI answer is still streaming in. */
      writing?: boolean;
      /** Detailed mode: the page's AI answer, shown here rather than on the page. */
      answer?: PageAnswer;
      pageId?: string;
      sourceCount?: number;
    }
  | {
      status: 'context';
      /** The page the context is about. */
      page: number;
      pageId: string;
      contextId: number;
      /** Filled in from the context panel's state. */
      state?: ContextEntry['state'];
    }
);

interface LogProps {
  entries: ChatEntry[];
  onRetry: (entry: ChatEntry) => void;
  onRetryAnswer: (page: number) => void;
  onGoToPage: (index: number) => void;
  onOpenContext: () => void;
}

/** The conversation: every question with its AI answer (cited) or the context it found. */
export function ChatLog({ entries, ...actions }: LogProps) {
  const end = useRef<HTMLLIElement>(null);
  const last = entries[entries.length - 1];
  const lastText =
    last?.status === 'done'
      ? last.answer && 'text' in last.answer
        ? last.answer.text
        : last.reply
      : '';
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [entries.length, lastText]);

  if (entries.length === 0) {
    return <p className="text-sm text-muted">Questions and AI answers appear here.</p>;
  }
  return (
    <ol className="flex flex-col gap-6">
      {entries.map((entry) => (
        <li key={entry.id} className="flex flex-col gap-1.5">
          <p className="text-xs text-muted">
{entry.step.kind === 'dive' ? 'You dove into' : entry.photo ? 'You searched with a photo' : entry.status === 'context' ? 'You asked for context' : 'You asked'}
          </p>
          <div className="flex items-start gap-3">
            {entry.photo && <img src={entry.photo} alt="The photo you searched with" className="size-14 shrink-0 rounded-lg border border-border object-cover" />}
            {!(entry.photo && entry.status === 'pending' && entry.reading) && !(entry.status === 'error' && entry.step.text === 'Photo') && (
              <p className="font-serif text-lg leading-snug">{entry.step.text}</p>
            )}
          </div>
          <div className="mt-1 border-l-2 border-accent pl-3">
            <Status entry={entry} {...actions} />
          </div>
        </li>
      ))}
      <li ref={end} aria-hidden />
    </ol>
  );
}

function Status({
  entry,
  onRetry,
  onRetryAnswer,
  onGoToPage,
  onOpenContext,
  preview,
}: Omit<LogProps, 'entries'> & { entry: ChatEntry; /** One clamped paragraph, for the collapsed chat. */ preview?: boolean }) {
  const link =
    'shrink-0 rounded font-medium text-accent underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-focus';
  const busyLine = (text: string) => (
    <span className="inline-flex items-center gap-2 text-muted">
      <Spinner size="sm" aria-hidden />
      {text}
    </span>
  );
  const answer = entry.status === 'done' ? entry.answer : undefined;
  const streaming = answer?.status === 'writing' || (entry.status === 'done' && entry.writing);

  return (
    // Streaming text would be announced word by word, so the live region waits for the finished answer.
    <div aria-live={streaming ? 'off' : 'polite'} className="flex flex-col gap-2 text-sm leading-relaxed">
      {entry.status === 'pending' &&
        busyLine(entry.reading ? 'Looking at your photo…' : entry.routing ? 'Deciding: new articles or context…' : preview ? `Researching “${entry.step.text}”…` : 'Researching on Wikipedia…')}

      {entry.status === 'error' && (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{entry.message}</span>
          {entry.canRetry !== false && (
            <button type="button" onClick={() => onRetry(entry)} className={link}>
              Try again
            </button>
          )}
        </span>
      )}

      {entry.status === 'done' && (
        <>
          {answer && (answer.status === 'waiting' || answer.status === 'thinking') &&
            busyLine(answer.status === 'thinking' ? 'Reasoning over the sources…' : 'Reading the sources…')}
          {answer && (answer.status === 'writing' || answer.status === 'done') &&
            (preview ? (
              <p className="line-clamp-3">{withoutCitations(answer.text)}</p>
            ) : (
              <div className="flex flex-col gap-3">
                <CitedText
                  text={answer.text}
                  sourceCount={entry.sourceCount ?? 0}
                  href={(n) => `#${entry.pageId}-source-${n}`}
                  className="font-serif text-[1.02rem] leading-[1.65]"
                />
                <p className="text-xs text-muted">Written by AI from the sources on page {entry.page + 1}. Check the citations.</p>
              </div>
            ))}
          {answer?.status === 'error' && (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>{answer.message}</span>
              <button type="button" onClick={() => onRetryAnswer(entry.page)} className={link}>
                Try again
              </button>
            </span>
          )}
          {(!answer || answer.status === 'off') && entry.writing && !entry.reply && busyLine('Writing the answer…')}
          {(!answer || answer.status === 'off') && entry.reply && (
            <p className={preview ? 'line-clamp-3' : ''}>{entry.reply}</p>
          )}
          <span>
            <button type="button" onClick={() => onGoToPage(entry.page)} className={link}>
              Go to page {entry.page + 1}
            </button>
          </span>
        </>
      )}

      {entry.status === 'context' && (
        <>
          {(!entry.state || entry.state.status === 'loading') && busyLine('Searching the web for context…')}
          {entry.state?.status === 'error' && (
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>The web search didn’t respond.</span>
              <button type="button" onClick={() => onRetry(entry)} className={link}>
                Try again
              </button>
            </span>
          )}
          {entry.state?.status === 'ready' && (
            <p className={preview ? 'line-clamp-3' : ''}>
              {entry.state.result.summary
                ? withoutCitations(entry.state.result.summary)
                : entry.state.result.sources.length
                  ? `Found ${entry.state.result.sources.length} web pages.`
                  : 'No web pages matched this.'}
            </p>
          )}
          <span>
            <button type="button" onClick={onOpenContext} className={link}>
              Open in the Context panel
            </button>
          </span>
        </>
      )}

    </div>
  );
}

const MODE_LABEL: Record<AskMode, string> = { auto: 'Auto', articles: 'Articles', context: 'Context' };
const MODE_HINT: Record<AskMode, string> = {
  auto: 'The AI decides where your question goes',
  articles: 'A new page of Wikipedia articles',
  context: 'Web context in the Context panel',
};
const PLACEHOLDER: Record<AskMode, string> = {
  auto: 'Ask a question or for context',
  articles: 'Search for new articles',
  context: 'Ask for context on this topic',
};

interface ComposerProps {
  onAsk: (question: string, mode: AskMode) => void;
  /** Search with a photo (taken with the camera or picked from the device); unset when the server can't read images. */
  onPhoto?: (file: File, mode: AskMode) => void;
  mode: AskMode;
  onModeChange: (mode: AskMode) => void;
  /** The modes this server offers, in order (Auto first). One or none: no switch, questions go to articles. */
  modes: AskMode[];
  docked: boolean;
  onToggleDock: () => void;
  /** The collapsed chat's expand control (center only). */
  expand?: { open: boolean; count: number; onToggle: () => void };
}

/** The one input: questions go to a new page of articles or to the context panel. */
export function ChatComposer({ onAsk, onPhoto, mode, onModeChange, modes, docked, onToggleDock, expand }: ComposerProps) {
  const [text, setText] = useState('');
  const switchable = modes.length > 1;
  const effective: AskMode = switchable && modes.includes(mode) ? mode : 'articles';
  const modeRef = useRef(effective);
  modeRef.current = effective;
  const voice = useVoiceControls((q) => onAsk(q, modeRef.current));

  function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    const q = text.trim();
    if (!q) return;
    onAsk(q, effective);
    setText('');
  }

  return (
    <div className="flex flex-col">
      <VoiceStatusRows controls={voice} rowClassName="border-b border-separator px-5 py-3" />
      <div className="flex items-center justify-between gap-2 px-3 pt-2 max-lg:hidden">
        {switchable ? (
          <div role="radiogroup" aria-label="Send questions to" className="flex rounded-full bg-default p-0.5">
            {modes.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={effective === m}
                title={MODE_HINT[m]}
                onClick={() => onModeChange(m)}
                className={`rounded-full px-2.5 py-0.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                  effective === m ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted'
                }`}
              >
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
        ) : (
          <span />
        )}
        <button
          type="button"
          onClick={onToggleDock}
          className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-xs text-muted outline-none hover:bg-default hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus max-lg:hidden"
        >
          <DockIcon docked={docked} />
          {docked ? 'Move to the middle' : 'Move to side panel'}
        </button>
      </div>
      {/* Narrow screens: the input gets its own full-width row; mode, photo, voice and Ask sit below it. */}
      <Form onSubmit={submit} className="flex flex-wrap items-center gap-2 p-2 pl-3 max-lg:px-3 max-lg:pb-3 lg:flex-nowrap">
        {expand && (
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={expand.open ? 'Hide questions and answers' : `Show all questions and answers (${expand.count})`}
            aria-expanded={expand.open}
            aria-controls="chat-history"
            onPress={expand.onToggle}
            className="max-lg:hidden"
          >
            <ChevronIcon up={!expand.open} />
          </Button>
        )}
        {switchable && (
          <label className="relative shrink-0 lg:hidden">
            <span className="sr-only">Send questions to</span>
            <select
              value={effective}
              onChange={(e) => onModeChange(e.target.value as AskMode)}
              className="appearance-none rounded-full bg-default py-1 pr-6 pl-2.5 text-xs font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-focus"
            >
              {modes.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </select>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-muted">
              <path d="M6 9l6 6 6-6" />
            </svg>
          </label>
        )}
        <TextField aria-label={PLACEHOLDER[effective]} value={text} onChange={setText} className="min-w-0 flex-1 max-lg:order-first max-lg:basis-full">
          <Input placeholder={PLACEHOLDER[effective]} className="chat-input text-base max-lg:w-full" />
        </TextField>
        <div className="flex shrink-0 items-center gap-1.5 max-lg:ml-auto">
          {onPhoto && <PhotoButton onFile={(file) => onPhoto(file, modeRef.current)} />}
          <VoiceButtons controls={voice} />
          <Button type="submit" size="sm" className="shrink-0">
            Ask
          </Button>
        </div>
      </Form>
    </div>
  );
}

/**
 * The chat in the middle, at the bottom of the research canvas: the latest
 * answer, expanding into the whole conversation, above the one input.
 */
export function ChatCenter({ log, composer }: { log: LogProps; composer: Omit<ComposerProps, 'expand' | 'docked'> }) {
  const [open, setOpen] = useState(false);
  const latest = log.entries[log.entries.length - 1];
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-3 sm:px-6 sm:pb-5">
      <div className="pointer-events-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-[0_12px_40px_-12px_rgb(0_0_0/0.45)]">
        {latest && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-controls="chat-history"
            className="flex items-center gap-2 border-b border-separator px-4 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset lg:hidden"
          >
            <span className="min-w-0 flex-1 truncate">{open ? `Questions and answers (${log.entries.length})` : previewLine(latest)}</span>
            <span className="shrink-0 text-muted">
              <ChevronIcon up={!open} />
            </span>
          </button>
        )}
        {open ? (
          <div id="chat-history" className="max-h-[min(60vh,34rem)] overflow-y-auto border-b border-separator px-5 py-4">
            <h2 className="sr-only">Questions and answers</h2>
            <ChatLog {...log} />
          </div>
        ) : (
          latest && (
            <div className="flex flex-col gap-1 border-b border-separator px-5 py-3 max-lg:hidden">
              <Status entry={latest} {...log} preview />
              {latest.status === 'done' && latest.answer && 'text' in latest.answer && (
                <button
                  type="button"
                  onClick={() => setOpen(true)}
                  className="self-start rounded text-xs font-medium text-muted underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
                >
                  Read the full answer
                </button>
              )}
            </div>
          )
        )}
        <ChatComposer
          {...composer}
          docked={false}
          expand={{ open, count: log.entries.length, onToggle: () => setOpen((o) => !o) }}
        />
      </div>
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

function DockIcon({ docked }: { docked: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      {docked ? <path d="M7 16h10" /> : <path d="M15 4v16" />}
    </svg>
  );
}

/** The latest entry as one line, for the collapsed chat on phones. */
function previewLine(entry: ChatEntry) {
  if (entry.status === 'pending') return entry.reading ? 'Looking at your photo…' : entry.routing ? 'Deciding: new articles or context…' : `Researching “${entry.step.text}”…`;
  if (entry.status === 'error') return entry.message;
  if (entry.status === 'context') {
    if (entry.state?.status === 'ready') return entry.state.result.summary ? withoutCitations(entry.state.result.summary) : 'Web context found';
    return entry.state?.status === 'error' ? 'The web search didn’t respond.' : 'Searching the web for context…';
  }
  const a = entry.answer;
  if (a && (a.status === 'writing' || a.status === 'done')) return withoutCitations(a.text);
  if (a && (a.status === 'waiting' || a.status === 'thinking')) return 'Reading the sources…';
  return entry.reply || 'Writing the answer…';
}
