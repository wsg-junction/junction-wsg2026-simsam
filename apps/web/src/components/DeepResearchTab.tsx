import { useEffect, useState } from 'react';
import { Button, Form, Input, Spinner, TextField } from '@heroui/react';
import type { DeepReport } from '@simsam/models';
import { DeepReportView } from './DeepReportView';

/** A deep research in progress (or that failed). */
export type DeepRun =
  | {
      status: 'running';
      topic: string;
      web: boolean;
      startedAt: number;
      plan?: { title: string; questions: string[]; parts: { n: number; title: string; focus: string }[] };
      steps: { id: string; label: string; done: boolean; detail?: string }[];
    }
  | { status: 'error'; topic: string; web: boolean; message: string };

interface Props {
  reports: DeepReport[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  run: DeepRun | null;
  onStart: (topic: string, web: boolean) => void;
  onCancel: () => void;
  /** Suggested topic: the page in view. */
  suggestion: string | undefined;
  /** Whether web search (context.dev) is configured. */
  webAvailable: boolean;
}

/**
 * The Deep research tab: start a research on a topic, follow its progress,
 * and read the finished reports.
 */
export function DeepResearchTab({ reports, selectedId, onSelect, run, onStart, onCancel, suggestion, webAvailable }: Props) {
  const [composing, setComposing] = useState(false);
  const report = reports.find((r) => r.id === selectedId) ?? reports[reports.length - 1];

  if (run?.status === 'running') return <Progress run={run} onCancel={onCancel} />;
  if (run?.status === 'error' || composing || !report) {
    return (
      <StartForm
        key={run?.status === 'error' ? 'retry' : 'new'}
        initialTopic={run?.topic ?? suggestion ?? ''}
        initialWeb={run?.web ?? false}
        error={run?.status === 'error' ? run.message : undefined}
        webAvailable={webAvailable}
        onStart={(topic, web) => {
          setComposing(false);
          onStart(topic, web);
        }}
        onBack={report && run?.status !== 'error' ? () => setComposing(false) : undefined}
      />
    );
  }

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      {reports.length > 1 && (
        <label className="flex items-center gap-2 text-sm text-muted">
          Report
          <select
            value={report.id}
            onChange={(e) => onSelect(e.target.value)}
            className="max-w-[16rem] rounded-lg border border-border bg-surface px-2 py-1 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            {reports.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <Button size="sm" variant="ghost" onPress={() => setComposing(true)}>
        New deep research
      </Button>
    </div>
  );
  return <DeepReportView key={report.id} report={report} toolbar={toolbar} />;
}

function StartForm({
  initialTopic,
  initialWeb,
  error,
  webAvailable,
  onStart,
  onBack,
}: {
  initialTopic: string;
  initialWeb: boolean;
  error?: string;
  webAvailable: boolean;
  onStart: (topic: string, web: boolean) => void;
  onBack?: () => void;
}) {
  const [topic, setTopic] = useState(initialTopic);
  const [web, setWeb] = useState(initialWeb && webAvailable);
  const submit = (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (topic.trim()) onStart(topic.trim(), web);
  };
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-12 sm:px-8">
        <div>
          <h2 className="font-serif text-3xl font-normal">Deep research</h2>
          <p className="mt-2 leading-relaxed text-muted">
            Atlas researches a topic in depth and writes a full report: research questions, a timeline of all the
            events you can zoom into, one page per part (causes, phases, the parties involved, key themes,
            consequences) with figures and data, findings and every source. It reads the Wikipedia collection first and
            takes a few minutes.
          </p>
        </div>
        {error && (
          <p role="alert" className="rounded-lg border border-[var(--removed)] px-4 py-3 text-sm">
            {error} Try again, or try a narrower topic.
          </p>
        )}
        <Form onSubmit={submit} className="flex flex-col gap-5">
          <TextField aria-label="Topic to research" value={topic} onChange={setTopic} autoFocus>
            <Input placeholder="A topic, e.g. World War II" className="question-input font-serif text-xl" />
          </TextField>
          <div className="flex items-start gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={web}
              aria-labelledby="deep-web-label"
              aria-describedby="deep-web-hint"
              disabled={!webAvailable}
              onClick={() => setWeb((w) => !w)}
              className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 motion-reduce:transition-none ${
                web ? 'bg-accent' : 'bg-default'
              }`}
            >
              <span
                aria-hidden
                className={`absolute top-0.5 size-5 rounded-full bg-background shadow transition-transform motion-reduce:transition-none ${
                  web ? 'translate-x-[1.375rem]' : 'translate-x-0.5'
                }`}
              />
            </button>
            <div>
              <p id="deep-web-label" className="text-sm font-medium">
                Include web sources
              </p>
              <p id="deep-web-hint" className="text-sm text-muted">
                {webAvailable
                  ? 'Adds scholarly, institutional and news pages from web search (context.dev), beside Wikipedia. They’re marked as web in the report. The topic is sent to the search.'
                  : 'Web search isn’t set up on this server, so the report uses Wikipedia only.'}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" isDisabled={!topic.trim()}>
              Start deep research
            </Button>
            {onBack && (
              <Button variant="ghost" onPress={onBack}>
                Back to the report
              </Button>
            )}
          </div>
        </Form>
      </div>
    </div>
  );
}

function Progress({ run, onCancel }: { run: Extract<DeepRun, { status: 'running' }>; onCancel: () => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const seconds = Math.round((now - run.startedAt) / 1000);
  const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const stepOf = (id: string) => run.steps.find((s) => s.id === id);
  const current = [...run.steps].reverse().find((s) => !s.done);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-12 sm:px-8" aria-busy>
        <div>
          <p className="text-sm text-muted">
            Deep research{run.web ? ' with web sources' : ''}, {elapsed}
          </p>
          <h2 className="mt-1 font-serif text-3xl font-normal text-balance">{run.plan?.title ?? run.topic}</h2>
          <p aria-live="polite" className="mt-3 inline-flex items-center gap-2 text-sm text-muted">
            <Spinner size="sm" aria-hidden />
            {current?.label ?? 'Starting'}…
          </p>
        </div>

        {run.plan && (
          <>
            <div>
              <h3 className="text-sm font-semibold">Research questions</h3>
              <ol className="mt-2 flex list-decimal flex-col gap-1 pl-6 font-serif">
                {run.plan.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ol>
            </div>
            <div>
              <h3 className="text-sm font-semibold">Parts</h3>
              <ol className="mt-2 flex flex-col gap-3">
                {run.plan.parts.map((p) => {
                  const gather = stepOf(`gather-${p.n}`);
                  const write = stepOf(`write-${p.n}`);
                  const state = write?.done ? 'written' : write ? 'writing' : gather?.done ? 'gathered' : gather ? 'searching' : 'waiting';
                  return (
                    <li key={p.n} className="flex gap-3">
                      <span aria-hidden className="mt-1.5 flex size-3 shrink-0 items-center justify-center">
                        {state === 'written' ? (
                          <span className="size-2.5 rounded-full bg-accent" />
                        ) : state === 'waiting' ? (
                          <span className="size-2.5 rounded-full border-2 border-[var(--field-line)]" />
                        ) : (
                          <span className="size-2.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <p className="font-medium">
                          {p.n}. {p.title}
                        </p>
                        <p className="text-sm text-muted">
                          {
                            {
                              waiting: 'Waiting',
                              searching: 'Searching the collection',
                              gathered: `Evidence gathered${gather?.detail ? `: ${gather.detail}` : ''}`,
                              writing: 'Writing',
                              written: `Written${write?.detail ? `: ${write.detail}` : ''}`,
                            }[state]
                          }
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          </>
        )}

        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">
            You can keep reading the pages meanwhile. The report opens here when it’s ready.
          </p>
          <div>
            <Button variant="secondary" size="sm" onPress={onCancel}>
              Stop the research
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
