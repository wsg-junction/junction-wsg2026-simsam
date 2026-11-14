import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import type { ExplorationStep, PriorTurn } from '@simsam/models';
import { aiAvailable, fetchBrief, fetchContext, planSources, rewriteQuery, serverFeatures, streamAnswer } from '../lib/ai';
import {
  HistoryUnavailableError,
  historyTarget,
  isHistoryQuestion,
  localBrief,
  research,
  reservePageIds,
  sentences,
  type PageAnswer,
  type PageBrief,
  type ResearchPage,
} from '../lib/research';
import { fetchArticleTimeline, TimelineUnavailableError } from '../lib/history';
import { buildGraph, MAX_DEPTH, NoResultsError } from '../lib/wikipedia';
import { ChatCenter, type ChatEntry } from './ChatCenter';
import { ContextPanel, type ContextEntry } from './ContextPanel';
import { contentSignature, takeSnapshot, type ExplorationSnapshot, type ExplorationState } from '../lib/snapshot';
import { HistoryPanel, type TimelineState } from './HistoryPanel';
import { withoutCitations } from './Cite';
import { GraphPanel, type GraphState } from './GraphPanel';
import { ResearchCanvas, type ResearchCanvasHandle } from './ResearchCanvas';

interface Props {
  /** Steps to run on open: the opening question, or an older save's steps (saved without a snapshot). */
  initialSteps: ExplorationStep[];
  /** A saved exploration as it was: restored as is, nothing regenerated. */
  snapshot?: ExplorationSnapshot;
  /** Whether a saved copy exists. */
  saved: boolean;
  onSave: (steps: ExplorationStep[], focusTitle: string, snapshot: ExplorationSnapshot) => Promise<void>;
}

let entryId = 0;
let contextId = 0;

function replyFor(page: ResearchPage, index: number) {
  if (page.history) return page.history.brief.headline.replace(/\s*\[\d+\]/g, '');
  const first = sentences(page.sources[0]?.extract ?? '')[0] ?? '';
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
const questionFor = (step: ExplorationStep) =>
  step.kind === 'dive'
    ? `Tell me about ${step.text}.`
    : step.kind === 'history'
      ? `How has the Wikipedia article “${step.text}” changed over time?`
      : step.text;

export function ExplorationView({ initialSteps, snapshot, saved, onSave }: Props) {
  const [pages, setPages] = useState<ResearchPage[]>(() => snapshot?.pages ?? []);
  const [entries, setEntries] = useState<ChatEntry[]>(() => snapshot?.entries ?? []);
  const [active, setActive] = useState(() => snapshot?.active ?? 0);
  const [graphs, setGraphs] = useState<Record<string, GraphState>>(() => snapshot?.graphs ?? {});
  const [graphAttempt, setGraphAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [mobileTab, setMobileTab] = useState<'research' | 'side'>('research');
  const [sideTab, setSideTab] = useState<SideTab>('map');
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
  const pagesRef = useRef<ResearchPage[]>(snapshot?.pages ?? []);
  const queue = useRef(Promise.resolve());
  const [answers, setAnswers] = useState<Record<string, PageAnswer>>(() => snapshot?.answers ?? {});
  const answersRef = useRef<Record<string, PageAnswer>>(snapshot?.answers ?? {});
  const setAnswer = (pageId: string, answer: PageAnswer) => {
    answersRef.current = { ...answersRef.current, [pageId]: answer };
    setAnswers(answersRef.current);
  };
  const [briefs, setBriefs] = useState<Record<string, PageBrief>>(() => snapshot?.briefs ?? {});
  const briefsRef = useRef<Record<string, PageBrief>>(snapshot?.briefs ?? {});
  const setBrief = (pageId: string, brief: PageBrief) => {
    briefsRef.current = { ...briefsRef.current, [pageId]: brief };
    setBriefs(briefsRef.current);
  };

  // Web context (context.dev) per page, shown in the side panel, never on the page itself.
  const [contexts, setContexts] = useState<Record<string, ContextEntry[]>>(() => snapshot?.contexts ?? {});
  const updateContext = (pageId: string, entry: ContextEntry) =>
    setContexts((all) => {
      const list = all[pageId] ?? [];
      const at = list.findIndex((e) => e.id === entry.id);
      return { ...all, [pageId]: at === -1 ? [...list, entry] : list.map((e) => (e.id === entry.id ? entry : e)) };
    });
  const loadContext = (page: ResearchPage, entry: ContextEntry, query?: string) => {
    updateContext(page.id, { ...entry, state: { status: 'loading' } });
    fetchContext({ question: entry.question, topic: page.focus, query })
      .then((result) => updateContext(page.id, { ...entry, state: { status: 'ready', result } }))
      .catch(() => updateContext(page.id, { ...entry, state: { status: 'error' } }));
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
              : sentences(page.sources[0]?.extract ?? '').slice(0, 2).join(' '),
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
  // Restored answers and briefs count as already fetched, so nothing is regenerated.
  const requested = useRef(
    new Map<string, Promise<void>>([
      ...Object.keys(snapshot?.answers ?? {}).map((id) => [`detailed:${id}`, Promise.resolve()] as const),
      ...Object.keys(snapshot?.briefs ?? {}).map((id) => [`compact:${id}`, Promise.resolve()] as const),
    ]),
  );
  const ensureContent = useCallback(
    (index: number, forMode: ViewMode) => {
      const page = pagesRef.current[index];
      if (!page) return Promise.resolve();
      if (page.history) {
        if (!briefsRef.current[page.id]) {
          setBrief(page.id, { status: 'ready', brief: page.history.brief, byAi: page.history.byAi });
        }
        return Promise.resolve();
      }
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
        // "How has this article changed over time?" reads the article's stored
        // history instead of searching: the named article, or the page before.
        let target = step;
        if (step.kind === 'question' && isHistoryQuestion(step.text) && (await serverFeatures())?.corpus) {
          const title = await historyTarget(step.text, previous?.focus);
          if (title) target = { kind: 'history', text: title };
        }
        // The AI plans the sources by tool calls: a Wikipedia search for the page,
        // and, when the question needs more than encyclopedia intros (e.g. "what did
        // it mean for the banks?"), a web search that fills the context panel beside
        // it. Without web search it just rewrites follow-ups into a Wikipedia search.
        let query: string | null = null;
        let webQuery: string | null = null;
        if (target.kind === 'question' && (await aiAvailable())) {
          const features = await serverFeatures();
          if (features?.web) {
            const plan = await planSources({ question: target.text, history: priorTurns(index) });
            // First questions keep the tuned Wikipedia search; follow-ups need the rewrite.
            if (previous) {
              query = plan?.wikipediaQuery ?? (await rewriteQuery({ question: target.text, history: priorTurns(index) }));
            }
            webQuery = plan?.webQuery ?? null;
          } else if (previous) {
            query = await rewriteQuery({ question: target.text, history: priorTurns(index) });
          }
        }
        const page = await research(target, previous?.focus, query ?? undefined);
        // The web context loads on its own, so it never holds up the Wikipedia page.
        if (webQuery) loadContext(page, { id: ++contextId, question: target.text, auto: true, state: { status: 'loading' } }, webQuery);
        pagesRef.current = [...pagesRef.current, page];
        setPages(pagesRef.current);
        setEntries((list) =>
          list.map((e) => (e.id === id ? { id, step, status: 'done', reply: replyFor(page, index), page: index } : e)),
        );
        await ensureContent(index, modeRef.current);
      } catch (err) {
        const message =
          err instanceof HistoryUnavailableError
            ? `“${err.message}” isn’t in the local collection, so its edit history isn’t stored. Try an article from European history, Finnish history or computer science.`
            : err instanceof NoResultsError
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
    if (snapshot) {
      // Restored: new pages, chat entries and context requests continue the numbering.
      reservePageIds(snapshot.pages.map((p) => p.id));
      entryId = Math.max(entryId, ...snapshot.entries.map((e) => e.id));
      contextId = Math.max(contextId, ...Object.values(snapshot.contexts).flat().map((e) => e.id));
      requestAnimationFrame(() => canvas.current?.scrollToPage(snapshot.active));
      return;
    }
    initialSteps.forEach((step) => run(step));
  }, [initialSteps, run, snapshot]);

  useEffect(() => {
    pages.forEach((_, i) => void ensureContent(i, mode));
  }, [mode, pages, ensureContent]);

  const ask = (text: string) => run({ kind: 'question', text });
  const dive = (title: string) => {
    setMobileTab('research');
    run({ kind: 'dive', text: title });
  };
  // "See how this article changed" opens the History panel, which already follows the page's article.
  const showHistory = () => {
    setSideTab('history');
    setMobileTab('side');
    setMapCollapsed(false);
  };

  // Article histories exist only for the local collection; context needs web search.
  const [corpusOn, setCorpusOn] = useState(false);
  const [webOn, setWebOn] = useState(false);
  useEffect(() => {
    let live = true;
    serverFeatures().then((h) => {
      if (!live) return;
      setCorpusOn(h?.corpus === true);
      setWebOn(h?.web === true);
    });
    return () => {
      live = false;
    };
  }, []);

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
      { title: activePage.focus, seeds: activePage.seeds, about: activePage.sources[0]?.extract },
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

  // The history panel follows the page in view: its main article's substantial
  // changes load in the background (the server caches them).
  const [timelines, setTimelines] = useState<Record<string, TimelineState>>(() => snapshot?.timelines ?? {});
  const timelinesRef = useRef(timelines);
  timelinesRef.current = timelines;
  const [timelineAttempt, setTimelineAttempt] = useState(0);
  const historyTitle = activePage?.focus;
  useEffect(() => {
    if (!corpusOn || !historyTitle) return;
    const existing = timelinesRef.current[historyTitle];
    if (existing && existing.status !== 'error') return;
    const set = (state: TimelineState) => setTimelines((t) => ({ ...t, [historyTitle]: state }));
    set({ status: 'loading' });
    fetchArticleTimeline(historyTitle)
      .then((timeline) => set({ status: 'ready', timeline }))
      .catch((err) => set(err instanceof TimelineUnavailableError ? { status: 'unavailable' } : { status: 'error' }));
  }, [corpusOn, historyTitle, timelineAttempt]);
  const activeTimeline = historyTitle ? timelines[historyTitle] : undefined;

  const pending = entries.find((e) => e.status === 'pending');
  const activeContexts = (activePage && contexts[activePage.id]) || [];
  const sideTabs: SideTab[] = ['map', ...(webOn ? (['context'] as const) : []), ...(corpusOn ? (['history'] as const) : [])];
  const sideName = sideTabs.length === 1 ? 'Map' : sideTabs.map((t) => SIDE_LABEL[t].toLowerCase()).join(', ').replace(/^m/, 'M').replace(/, ([^,]*)$/, ' and $1');

  // In the chat, a page's reply is its AI answer once there is one.
  const chatEntries: ChatEntry[] = entries.map((entry) => {
    if (entry.status !== 'done') return entry;
    const page = pages[entry.page];
    if (page?.history) return { ...entry, reply: withoutCitations(page.history.brief.headline) };
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
  // Saved means: nothing finished since the last save (a new page, answer, map, context or history).
  const state: ExplorationState = { pages, entries, answers, briefs, graphs, contexts, timelines, active };
  const signature = contentSignature(state);
  const [savedSignature, setSavedSignature] = useState(() =>
    snapshot && saved ? contentSignature({ ...snapshot }) : undefined,
  );
  const isSaved = savedSignature !== undefined && savedSignature === signature;

  async function save() {
    // "Saved" stays readable rather than greyed out; pressing it again does nothing.
    if (!activePage || isSaved) return;
    setSaving(true);
    try {
      await onSave(steps, pages[pages.length - 1].focus, takeSnapshot(state));
      setSavedSignature(signature);
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
        <div className="flex shrink-0 items-center gap-2 max-sm:w-full max-sm:flex-wrap max-sm:justify-between max-sm:gap-y-2">
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
            {(['research', ...sideTabs] as const).map((tab) => {
              const pressed = tab === 'research' ? mobileTab === 'research' : mobileTab === 'side' && sideTab === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  aria-pressed={pressed}
                  onClick={() => {
                    if (tab === 'research') return setMobileTab('research');
                    setMobileTab('side');
                    setSideTab(tab);
                  }}
                  className={`rounded-full px-3 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                    pressed ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted'
                  }`}
                >
                  {tab === 'research' ? 'Research' : SIDE_LABEL[tab]}
                </button>
              );
            })}
          </div>
          <Button size="sm" variant="secondary" onPress={save} isPending={saving}>
            {isSaved ? 'Saved' : saved ? 'Save changes' : 'Save'}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Research"
          className={`relative min-w-0 flex-1 bg-background ${mobileTab === 'side' ? 'max-lg:hidden' : ''}`}
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
            onHistory={corpusOn ? showHistory : undefined}
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
          aria-label={sideTabs.length === 1 ? 'Topic map' : sideName}
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
                aria-label={`Show ${sideName.toLowerCase()}`}
                className="flex flex-col items-center gap-3 rounded-lg px-2 py-3 text-sm text-muted outline-none hover:bg-default hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M15 6l-6 6 6 6" />
                </svg>
                <span className="[writing-mode:vertical-rl]">{sideName}</span>
              </button>
            </div>
          )}
          <div className={`h-full min-w-0 flex-1 flex-col ${mapCollapsed ? 'flex lg:hidden' : 'flex'}`}>
            {sideTabs.length > 1 && (
              <SideTabs
                tabs={sideTabs}
                tab={sideTab}
                onTab={setSideTab}
                badges={{
                  context: { busy: activeContexts.some((e) => e.state.status === 'loading'), count: activeContexts.length },
                  history: {
                    busy: activeTimeline?.status === 'loading',
                    count: activeTimeline?.status === 'ready' ? activeTimeline.timeline.changes.length : 0,
                  },
                }}
                onCollapse={() => setMapCollapsed(true)}
              />
            )}
            <div className={`min-h-0 flex-1 flex-col ${sideTab === 'map' || sideTabs.length === 1 ? 'flex' : 'hidden'}`}>
              <GraphPanel
                state={activePage ? graphs[activePage.id] : undefined}
                onDive={dive}
                onRetry={() => setGraphAttempt((n) => n + 1)}
                onCollapse={sideTabs.length > 1 ? undefined : () => setMapCollapsed(true)}
              />
            </div>
            {corpusOn && sideTab === 'history' && (
              <HistoryPanel
                title={historyTitle}
                state={activeTimeline}
                onRetry={() => {
                  if (historyTitle) setTimelines(({ [historyTitle]: _, ...rest }) => rest);
                  setTimelineAttempt((n) => n + 1);
                }}
              />
            )}
            {webOn && sideTab === 'context' && (
              <ContextPanel
                topic={activePage?.history ? undefined : activePage?.focus}
                pageQuestion={activePage && !activePage.history ? questionFor(activePage.step) : undefined}
                entries={activeContexts}
                onAsk={(question) =>
                  activePage &&
                  loadContext(activePage, { id: ++contextId, question, auto: false, state: { status: 'loading' } })
                }
                onRetry={(entry) => activePage && loadContext(activePage, entry)}
              />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

type SideTab = 'map' | 'context' | 'history';
const SIDE_LABEL: Record<SideTab, string> = { map: 'Map', context: 'Context', history: 'History' };

/** Map | Context | History, at the top of the side panel, with the collapse control. */
function SideTabs({
  tabs,
  tab,
  onTab,
  badges,
  onCollapse,
}: {
  tabs: SideTab[];
  tab: SideTab;
  onTab: (tab: SideTab) => void;
  /** A dot when a tab has something for the page in view; it pulses while loading. */
  badges: Partial<Record<SideTab, { busy: boolean; count: number }>>;
  onCollapse: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-separator px-4 py-2 max-lg:hidden">
      <div role="group" aria-label="Side panel" className="flex rounded-full bg-default p-0.5">
        {tabs.map((t) => {
          const badge = badges[t];
          return (
            <button
              key={t}
              type="button"
              aria-pressed={tab === t}
              onClick={() => onTab(t)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                tab === t ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted'
              }`}
            >
              {SIDE_LABEL[t]}
              {badge && (badge.busy || badge.count > 0) && (
                <span
                  aria-label={badge.busy ? '(loading)' : `(${badge.count})`}
                  className={`size-2 rounded-full bg-accent ${badge.busy ? 'animate-pulse motion-reduce:animate-none' : ''}`}
                />
              )}
            </button>
          );
        })}
      </div>
      <Button isIconOnly size="sm" variant="ghost" aria-label="Collapse side panel" onPress={onCollapse}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M9 6l6 6-6 6" />
        </svg>
      </Button>
    </div>
  );
}
