import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import type { ExplorationStep, PriorTurn } from '@simsam/models';
import { aiAvailable, fetchBrief, rewriteQuery, streamAnswer } from '../lib/ai';
import { localBrief, research, sentences, type PageAnswer, type PageBrief, type ResearchPage } from '../lib/research';
import { buildGraph, MAX_DEPTH, NoResultsError } from '../lib/wikipedia';
import { ChatCenter, type ChatEntry } from './ChatCenter';
import { withoutCitations } from './Cite';
import { GraphPanel, type GraphState } from './GraphPanel';
import { ResearchCanvas, type ResearchCanvasHandle } from './ResearchCanvas';

interface Props {
  /** Steps to replay on open: the opening question, or a saved exploration's full history. */
  initialSteps: ExplorationStep[];
  /** How many steps the saved copy holds; undefined if never saved. */
  savedSteps?: number;
  onSave: (steps: ExplorationStep[], focusTitle: string) => Promise<void>;
}

let entryId = 0;

function replyFor(page: ResearchPage, index: number) {
  const first = sentences(page.sources[0].extract)[0] ?? '';
  const dates = page.timeline.length >= 2 ? ` and ${page.timeline.length} dates` : '';
  return `${first} Page ${index + 1} gathers ${page.sources.length} articles${dates}, starting with ${page.focus}.`;
}

export type ViewMode = 'detailed' | 'compact';

function storedMode(): ViewMode {
  try {
    return localStorage.getItem('atlas-mode') === 'compact' ? 'compact' : 'detailed';
  } catch {
    return 'detailed';
  }
}

/** What the AI is asked for a step: dives become an explicit request. */
const questionFor = (step: ExplorationStep) => (step.kind === 'dive' ? `Tell me about ${step.text}.` : step.text);

export function ExplorationView({ initialSteps, savedSteps, onSave }: Props) {
  const [pages, setPages] = useState<ResearchPage[]>([]);
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [active, setActive] = useState(0);
  const [graphs, setGraphs] = useState<Record<string, GraphState>>({});
  const [graphAttempt, setGraphAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [mobileTab, setMobileTab] = useState<'research' | 'map'>('research');
  const [mode, setModeState] = useState<ViewMode>(storedMode);
  const [mapCollapsed, setMapCollapsedState] = useState(() => {
    try {
      return localStorage.getItem('atlas-map-collapsed') === '1';
    } catch {
      return false;
    }
  });
  const setMapCollapsed = (collapsed: boolean) => {
    setMapCollapsedState(collapsed);
    try {
      localStorage.setItem('atlas-map-collapsed', collapsed ? '1' : '0');
    } catch {
      /* the choice just won't persist */
    }
  };
  const modeRef = useRef(mode);
  const setMode = (next: ViewMode) => {
    modeRef.current = next;
    setModeState(next);
    try {
      localStorage.setItem('atlas-mode', next);
    } catch {
      /* the choice just won't persist */
    }
  };
  const canvas = useRef<ResearchCanvasHandle>(null);

  // Steps run one at a time so each follow-up can lean on the page (and answer) before it.
  const pagesRef = useRef<ResearchPage[]>([]);
  const queue = useRef(Promise.resolve());
  const [answers, setAnswers] = useState<Record<string, PageAnswer>>({});
  const answersRef = useRef<Record<string, PageAnswer>>({});
  const setAnswer = (pageId: string, answer: PageAnswer) => {
    answersRef.current = { ...answersRef.current, [pageId]: answer };
    setAnswers(answersRef.current);
  };
  const [briefs, setBriefs] = useState<Record<string, PageBrief>>({});
  const briefsRef = useRef<Record<string, PageBrief>>({});
  const setBrief = (pageId: string, brief: PageBrief) => {
    briefsRef.current = { ...briefsRef.current, [pageId]: brief };
    setBriefs(briefsRef.current);
  };

  /** The conversation before page `upTo`, for the AI to read follow-ups in context. */
  const priorTurns = (upTo: number): PriorTurn[] =>
    pagesRef.current.slice(0, upTo).map((page) => {
      const answer = answersRef.current[page.id];
      const brief = briefsRef.current[page.id];
      return {
        question: questionFor(page.step),
        answer:
          answer && (answer.status === 'done' || answer.status === 'writing')
            ? answer.text
            : brief?.status === 'ready'
              ? [brief.brief.headline, ...brief.brief.events.map((e) => `${e.when}: ${e.title}.`)].join(' ')
              : sentences(page.sources[0].extract).slice(0, 2).join(' '),
      };
    });

  const answerPage = useCallback(async (index: number) => {
    const page = pagesRef.current[index];
    if (!page) return;
    if (!(await aiAvailable())) {
      setAnswer(page.id, { status: 'off' });
      return;
    }
    setAnswer(page.id, { status: 'waiting' });
    let text = '';
    let failed = false;
    try {
      await streamAnswer(
        { question: questionFor(page.step), titles: page.sources.map((s) => s.title), history: priorTurns(index) },
        (event) => {
          if (event.type === 'thinking' && !text) setAnswer(page.id, { status: 'thinking' });
          if (event.type === 'text') {
            text += event.text;
            setAnswer(page.id, { status: 'writing', text });
          }
          if (event.type === 'error') {
            failed = true;
            setAnswer(page.id, { status: 'error', message: event.message });
          }
        },
      );
      if (!failed) {
        setAnswer(
          page.id,
          text.trim() ? { status: 'done', text } : { status: 'error', message: 'The answer came back empty.' },
        );
      }
    } catch {
      setAnswer(page.id, { status: 'error', message: 'The answer couldn’t be written right now.' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const briefPage = useCallback(async (index: number) => {
    const page = pagesRef.current[index];
    if (!page) return;
    setBrief(page.id, { status: 'loading' });
    const brief = (await aiAvailable())
      ? await fetchBrief({
          question: questionFor(page.step),
          titles: page.sources.map((s) => s.title),
          history: priorTurns(index),
        })
      : null;
    // Without AI (or if it fails) the brief is built from the page's own Wikipedia text.
    setBrief(page.id, brief ? { status: 'ready', brief, byAi: true } : { status: 'ready', brief: localBrief(page), byAi: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Each page gets the content its current view needs, once: a full answer in
  // detailed mode, a brief in compact mode. Switching modes fills in the rest.
  const requested = useRef(new Map<string, Promise<void>>());
  const ensureContent = useCallback(
    (index: number, forMode: ViewMode) => {
      const page = pagesRef.current[index];
      if (!page) return Promise.resolve();
      const key = `${forMode}:${page.id}`;
      let pending = requested.current.get(key);
      if (!pending) {
        pending = forMode === 'compact' ? briefPage(index) : answerPage(index);
        requested.current.set(key, pending);
      }
      return pending;
    },
    [answerPage, briefPage],
  );

  const run = useCallback((step: ExplorationStep, existingId?: number) => {
    const id = existingId ?? ++entryId;
    setEntries((list) =>
      existingId
        ? list.map((e) => (e.id === id ? { id, step, status: 'pending' } : e))
        : [...list, { id, step, status: 'pending' }],
    );
    queue.current = queue.current.then(async () => {
      try {
        const index = pagesRef.current.length;
        const previous = pagesRef.current[index - 1];
        // Let the AI turn a follow-up into a search that stands on its own.
        const query =
          step.kind === 'question' && previous && (await aiAvailable())
            ? await rewriteQuery({ question: step.text, history: priorTurns(index) })
            : null;
        const page = await research(step, previous?.focus, query ?? undefined);
        pagesRef.current = [...pagesRef.current, page];
        setPages(pagesRef.current);
        setEntries((list) =>
          list.map((e) => (e.id === id ? { id, step, status: 'done', reply: replyFor(page, index), page: index } : e)),
        );
        await ensureContent(index, modeRef.current);
      } catch (err) {
        const message =
          err instanceof NoResultsError
            ? 'No Wikipedia articles match this. Try naming the person, place or idea.'
            : 'Wikipedia didn’t respond. Check your connection.';
        setEntries((list) => list.map((e) => (e.id === id ? { id, step, status: 'error', message } : e)));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    initialSteps.forEach((step) => run(step));
  }, [initialSteps, run]);

  useEffect(() => {
    pages.forEach((_, i) => void ensureContent(i, mode));
  }, [mode, pages, ensureContent]);

  const ask = (text: string) => run({ kind: 'question', text });
  const dive = (title: string) => {
    setMobileTab('research');
    run({ kind: 'dive', text: title });
  };

  // The map follows the page in view, building it ring by ring the first time.
  const activePage = pages[Math.min(active, pages.length - 1)];
  const graphsRef = useRef(graphs);
  graphsRef.current = graphs;
  useEffect(() => {
    if (!activePage) return;
    const existing = graphsRef.current[activePage.id];
    if (existing?.status === 'ready' && !existing.growing) return;
    const controller = new AbortController();
    const set = (state: GraphState) => setGraphs((g) => ({ ...g, [activePage.id]: state }));
    if (!existing || existing.status === 'error') set({ status: 'loading' });
    buildGraph(
      { title: activePage.focus, seeds: activePage.seeds },
      (graph) => !controller.signal.aborted && set({ status: 'ready', graph, growing: graph.depth < MAX_DEPTH }),
      controller.signal,
    ).catch(() => {
      if (controller.signal.aborted) return;
      setGraphs((g) => {
        const current = g[activePage.id];
        return {
          ...g,
          [activePage.id]: current?.status === 'ready' ? { ...current, growing: false } : { status: 'error' },
        };
      });
    });
    return () => controller.abort();
  }, [activePage, graphAttempt]);

  const pending = entries.find((e) => e.status === 'pending');

  // In the chat, a page's reply is its AI answer once there is one.
  const chatEntries: ChatEntry[] = entries.map((entry) => {
    if (entry.status !== 'done') return entry;
    const page = pages[entry.page];
    if (mode === 'compact') {
      const brief = page && briefs[page.id];
      if (!brief || brief.status === 'loading') return { ...entry, reply: '', writing: true };
      return brief.byAi ? { ...entry, reply: withoutCitations(brief.brief.headline) } : entry;
    }
    const answer = page && answers[page.id];
    if (!answer || answer.status === 'off' || answer.status === 'error') return entry;
    if (answer.status === 'waiting' || answer.status === 'thinking') return { ...entry, reply: '', writing: true };
    return { ...entry, reply: withoutCitations(answer.text), writing: answer.status === 'writing' };
  });
  const steps = pages.map((p) => p.step);
  const isSaved = savedSteps !== undefined && savedSteps === steps.length;

  async function save() {
    // "Saved" stays readable rather than greyed out; pressing it again does nothing.
    if (!activePage || isSaved) return;
    setSaving(true);
    try {
      await onSave(steps, pages[pages.length - 1].focus);
    } finally {
      setSaving(false);
    }
  }

  const goToPage = (index: number) => {
    setMobileTab('research');
    canvas.current?.scrollToPage(index);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-separator bg-background px-4 py-2.5 sm:px-6">
        <h1 className="min-w-0 truncate text-sm text-muted max-sm:hidden">
          <span className="sr-only">Exploration: </span>
          {initialSteps[0].text}
        </h1>
        <div className="flex shrink-0 items-center gap-2 max-sm:w-full max-sm:justify-between">
          <div role="group" aria-label="Page style" className="flex rounded-full bg-default p-0.5">
            {(['detailed', 'compact'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={`rounded-full px-3 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                  mode === m ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted'
                }`}
              >
                {m === 'detailed' ? 'Detailed' : 'Compact'}
              </button>
            ))}
          </div>
          <div role="group" aria-label="Show" className="flex rounded-full bg-default p-0.5 lg:hidden">
            {(['research', 'map'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                aria-pressed={mobileTab === tab}
                onClick={() => setMobileTab(tab)}
                className={`rounded-full px-3 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                  mobileTab === tab ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted'
                }`}
              >
                {tab === 'research' ? 'Research' : 'Map'}
              </button>
            ))}
          </div>
          <Button size="sm" variant="secondary" onPress={save} isPending={saving}>
            {isSaved ? 'Saved' : savedSteps !== undefined ? 'Save changes' : 'Save'}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Research"
          className={`relative min-w-0 flex-1 bg-background ${mobileTab === 'map' ? 'max-lg:hidden' : ''}`}
        >
          <ResearchCanvas
            ref={canvas}
            pages={pages}
            mode={mode}
            briefs={briefs}
            answers={answers}
            onRetryAnswer={(i) => void answerPage(i)}
            pending={pending?.step}
            active={active}
            onActiveChange={setActive}
            onDive={dive}
            empty={
              <div className="flex h-full items-center justify-center px-6 pb-32 text-center">
                <p className="max-w-sm text-muted">
                  Nothing to show yet. Ask a question below to start this exploration.
                </p>
              </div>
            }
          />
          <ChatCenter entries={chatEntries} onAsk={ask} onRetry={(e) => run(e.step, e.id)} onGoToPage={goToPage} />
        </section>

        <aside
          aria-label="Topic map"
          className={`border-border bg-surface transition-[width] duration-300 motion-reduce:transition-none lg:flex lg:shrink-0 lg:flex-col lg:border-l ${
            mapCollapsed ? 'lg:w-14' : 'lg:w-[28rem] xl:w-[32rem]'
          } ${mobileTab === 'research' ? 'max-lg:hidden' : 'max-lg:flex-1'}`}
        >
          {/* Collapsed (desktop only): a slim rail that brings the map back. */}
          {mapCollapsed && (
            <div className="flex h-full flex-col items-center pt-3 max-lg:hidden">
              <button
                type="button"
                onClick={() => setMapCollapsed(false)}
                aria-label="Show map"
                className="flex flex-col items-center gap-3 rounded-lg px-2 py-3 text-sm text-muted outline-none hover:bg-default hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M15 6l-6 6 6 6" />
                </svg>
                <span className="[writing-mode:vertical-rl]">Map</span>
              </button>
            </div>
          )}
          <div className={`h-full min-w-0 flex-1 flex-col ${mapCollapsed ? 'flex lg:hidden' : 'flex'}`}>
            <GraphPanel
              state={activePage ? graphs[activePage.id] : undefined}
              onDive={dive}
              onRetry={() => setGraphAttempt((n) => n + 1)}
              onCollapse={() => setMapCollapsed(true)}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}
