import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@heroui/react';
import type { DeepReport, ExplorationStep, PriorTurn } from '@simsam/models';
import {
  aiAvailable,
  fetchBrief,
  fetchContext,
  fetchFactCheck,
  planSources,
  rewriteQuery,
  routeQuestion,
  serverFeatures,
  streamAnswer,
  streamDeepReport,
} from '../lib/ai';
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
import { PhotoError, preparePhoto, searchByPhoto } from '../lib/image';
import { fetchArticleTimeline, TimelineUnavailableError } from '../lib/history';
import { buildGraph, MAX_DEPTH, NoResultsError } from '../lib/wikipedia';
import { ChatCenter, ChatComposer, ChatLog, type AskMode, type ChatEntry } from './ChatCenter';
import { ContextPanel, type ContextEntry } from './ContextPanel';
import { FactCheckPanel, type FactCheckState } from './FactCheckPanel';
import { DeepResearchTab, type DeepRun } from './DeepResearchTab';
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
  /** Open on the Deep research tab with this topic ready to research (from the opening screen). */
  initialDeep?: string;
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

export function ExplorationView({ initialSteps, snapshot, saved, onSave, initialDeep }: Props) {
  // The main area: the research pages, or deep research reports.
  const [mainTab, setMainTab] = useState<'pages' | 'deep'>(() => snapshot?.mainTab ?? (initialDeep ? 'deep' : 'pages'));
  const [reports, setReports] = useState<DeepReport[]>(() => snapshot?.reports ?? []);
  const [reportId, setReportId] = useState<string | null>(() => snapshot?.reports?.at(-1)?.id ?? null);
  const [deepRun, setDeepRun] = useState<DeepRun | null>(null);
  const deepAbort = useRef<AbortController | null>(null);
  const startDeep = (topic: string, web: boolean) => {
    deepAbort.current?.abort();
    const controller = new AbortController();
    deepAbort.current = controller;
    setMainTab('deep');
    setMobileTab('research');
    let current: DeepRun = { status: 'running', topic, web, startedAt: Date.now(), steps: [], evidence: {}, drafts: {} };
    setDeepRun(current);
    const update = (next: DeepRun) => {
      if (deepAbort.current !== controller) return;
      current = next;
      setDeepRun(next);
    };
    let finished = false;
    streamDeepReport(
      { topic, web },
      (event) => {
        if (current.status !== 'running') return;
        if (event.type === 'plan') update({ ...current, plan: { title: event.title, questions: event.questions, parts: event.parts } });
        // Sources found, and the text as the model writes it: shown live while the research runs.
        if (event.type === 'evidence') {
          update({ ...current, evidence: { ...current.evidence, [event.part]: [...(current.evidence[event.part] ?? []), ...event.items] } });
        }
        if (event.type === 'draft') {
          update({ ...current, drafts: { ...current.drafts, [event.part]: { summary: event.summary, sections: event.sections } } });
        }
        if (event.type === 'synthesis') update({ ...current, abstract: event.abstract });
        if (event.type === 'step') {
          const steps = current.steps.some((x) => x.id === event.step.id)
            ? current.steps.map((x) => (x.id === event.step.id ? event.step : x))
            : [...current.steps, event.step];
          update({ ...current, steps });
        }
        if (event.type === 'error') {
          finished = true;
          update({ status: 'error', topic, web, message: event.message });
        }
        if (event.type === 'report') {
          finished = true;
          if (deepAbort.current !== controller) return;
          setReports((list) => [...list, event.report]);
          setReportId(event.report.id);
          setDeepRun(null);
        }
      },
      controller.signal,
    )
      .then(() => {
        if (!finished) update({ status: 'error', topic, web, message: 'The research stopped before it finished.' });
      })
      .catch(() => {
        if (!controller.signal.aborted) update({ status: 'error', topic, web, message: 'The research couldn’t be started right now.' });
      });
  };
  const cancelDeep = () => {
    deepAbort.current?.abort();
    deepAbort.current = null;
    setDeepRun(null);
  };
  useEffect(() => () => deepAbort.current?.abort(), []);

  const [pages, setPages] = useState<ResearchPage[]>(() => snapshot?.pages ?? []);
  const [entries, setEntries] = useState<ChatEntry[]>(() => snapshot?.entries ?? []);
  const [active, setActive] = useState(() => snapshot?.active ?? 0);
  const [graphs, setGraphs] = useState<Record<string, GraphState>>(() => snapshot?.graphs ?? {});
  const [graphAttempt, setGraphAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [mobileTab, setMobileTab] = useState<'research' | 'side'>('research');
  const [sideTab, setSideTab] = useState<SideTab>('map');
  const [chatDock, setChatDockState] = useState<'center' | 'side'>(() => {
    try {
      return localStorage.getItem('atlas-chat-dock') === 'side' ? 'side' : 'center';
    } catch {
      return 'center';
    }
  });
  const [askMode, setAskModeState] = useState<AskMode>(() => {
    try {
      const v = localStorage.getItem('atlas-ask-mode');
      return v === 'articles' || v === 'context' ? v : 'auto';
    } catch {
      return 'auto';
    }
  });
  const setAskMode = (next: AskMode) => {
    setAskModeState(next);
    try {
      localStorage.setItem('atlas-ask-mode', next);
    } catch {
      /* the choice just won't persist */
    }
  };
  // The side panel exists beside the canvas only on wide screens.
  const [desktop, setDesktop] = useState(() => window.matchMedia('(min-width: 1024px)').matches);
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const [resizingPanel, setResizingPanel] = useState(false);
  useEffect(() => {
    const m = window.matchMedia('(min-width: 1024px)');
    const on = () => setDesktop(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
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
        ? list.map((e) => (e.id === id ? { id, step, status: 'pending', photo: e.photo } : e))
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
          list.map((e) => (e.id === id ? { id, step, status: 'done', reply: replyFor(page, index), page: index, photo: e.photo } : e)),
        );
        await ensureContent(index, modeRef.current);
      } catch (err) {
        const message =
          err instanceof HistoryUnavailableError
            ? `“${err.message}” isn’t in the local collection, so its edit history isn’t stored. Try an article from European history, Finnish history or computer science.`
            : err instanceof NoResultsError
              ? 'No Wikipedia articles match this. Try naming the person, place or idea.'
              : 'Wikipedia didn’t respond. Check your connection.';
        setEntries((list) => list.map((e) => (e.id === id ? { id, step, status: 'error', message, photo: e.photo } : e)));
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
  const [deepOn, setDeepOn] = useState(false);
  const [factOn, setFactOn] = useState(false);
  const [imageOn, setImageOn] = useState(false);
  useEffect(() => {
    let live = true;
    serverFeatures().then((h) => {
      if (!live) return;
      setCorpusOn(h?.corpus === true);
      setWebOn(h?.web === true);
      setDeepOn(h?.deep === true);
      setFactOn(h?.factcheck === true);
      setImageOn(h?.image === true);
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

  // The canvas shows a placeholder page only once a question is going to articles;
  // while Auto is still deciding, the question waits in the chat alone.
  const pending = entries.find((e) => e.status === 'pending' && !e.routing);
  const activeContexts = (activePage && contexts[activePage.id]) || [];

  // The chat sits in the middle of the canvas, or in the side panel to leave the
  // canvas for reading. Docked only beside the canvas (wide screens, panel open).
  const chatDocked = chatDock === 'side' && desktop && !mapCollapsed;
  const toggleDock = () => {
    const next = chatDock === 'side' ? 'center' : 'side';
    setChatDockState(next);
    try {
      localStorage.setItem('atlas-chat-dock', next);
    } catch {
      /* the choice just won't persist */
    }
    if (next === 'side') {
      setSideTab('chat');
      setMapCollapsed(false);
    }
  };
  const revealSide = (tab: SideTab) => {
    setSideTab(tab);
    setMapCollapsed(false);
    if (!desktop) setMobileTab('side');
  };

  const activeRef = useRef(activePage);
  activeRef.current = activePage;
  const askContext = (text: string, page: ResearchPage, query: string | null, existingId?: number) => {
    const cid = ++contextId;
    const id = existingId ?? ++entryId;
    const entry: ChatEntry = {
      id,
      step: { kind: 'question', text },
      status: 'context',
      page: pagesRef.current.indexOf(page),
      pageId: page.id,
      contextId: cid,
    };
    setEntries((list) => (list.some((e) => e.id === id) ? list.map((e) => (e.id === id ? { ...entry, photo: e.photo } : e)) : [...list, entry]));
    loadContext(page, { id: cid, question: text, auto: false, state: { status: 'loading' } }, query ?? undefined);
    revealSide('context');
  };
  const ask = async (text: string, how: AskMode) => {
    const page = activeRef.current;
    if (how === 'context' && page) return askContext(text, page, null);
    if (chatDocked) setSideTab('chat');
    if (how === 'auto' && webOn && page) {
      // Show the question at once; the AI decides where it goes in about a second.
      const id = ++entryId;
      setEntries((list) => [...list, { id, step: { kind: 'question', text }, status: 'pending', routing: true }]);
      const routed = await routeQuestion({ question: text, topic: page.focus, history: priorTurns(pagesRef.current.length) });
      if (routed?.route === 'context') return askContext(text, page, routed.query, id);
      return run({ kind: 'question', text }, id);
    }
    run({ kind: 'question', text });
  };
  // Searching by photo: the server keeps it in object storage and has the AI read it;
  // what it saw then goes on as a normal question (or a context request).
  const photos = useRef(new Map<number, { blob: Blob; how: AskMode }>());
  const readPhoto = async (id: number, blob: Blob, how: AskMode) => {
    setEntries((list) =>
      list.map((e) => (e.id === id ? { id, step: e.step, photo: e.photo, status: 'pending', routing: true, reading: true } : e)),
    );
    try {
      const seen = await searchByPhoto(blob);
      photos.current.delete(id);
      const page = activeRef.current;
      if (how === 'context' && page) return askContext(seen.query, page, null, id);
      return run({ kind: 'question', text: seen.query }, id);
    } catch (err) {
      const message = err instanceof PhotoError ? err.message : 'The photo couldn’t be read right now.';
      setEntries((list) => list.map((e) => (e.id === id ? { id, step: e.step, photo: e.photo, status: 'error', message } : e)));
    }
  };
  const askPhoto = async (file: File, how: AskMode) => {
    if (chatDocked) setSideTab('chat');
    const id = ++entryId;
    const step = { kind: 'question', text: 'Photo' } as const;
    try {
      const { blob, thumbnail } = await preparePhoto(file);
      photos.current.set(id, { blob, how });
      setEntries((list) => [...list, { id, step, photo: thumbnail, status: 'pending', routing: true, reading: true }]);
      void readPhoto(id, blob, how);
    } catch (err) {
      const message = err instanceof PhotoError ? err.message : 'This image couldn’t be opened.';
      setEntries((list) => [...list, { id, step, status: 'error', message, canRetry: false }]);
    }
  };
  const retry = (entry: ChatEntry) => {
    const photo = photos.current.get(entry.id);
    if (photo) return void readPhoto(entry.id, photo.blob, photo.how);
    if (entry.status === 'context') {
      const page = pagesRef.current.find((p) => p.id === entry.pageId);
      const ctx = contexts[entry.pageId]?.find((c) => c.id === entry.contextId);
      if (page && ctx) loadContext(page, ctx);
      return;
    }
    run(entry.step, entry.id);
  };

  const sideTabs: SideTab[] = [
    ...(chatDocked ? (['chat'] as const) : []),
    'map',
    ...(webOn ? (['context'] as const) : []),
    ...(factOn ? (['factcheck'] as const) : []),
    ...(corpusOn ? (['history'] as const) : []),
  ];
  const shownTab: SideTab = sideTabs.includes(sideTab) ? sideTab : 'map';
  // Every tab, also while the panel is collapsed (the chat counts when it's set to dock there).
  const railTabs: SideTab[] = [
    ...(chatDock === 'side' && desktop ? (['chat'] as const) : []),
    'map',
    ...(webOn ? (['context'] as const) : []),
    ...(factOn ? (['factcheck'] as const) : []),
    ...(corpusOn ? (['history'] as const) : []),
  ];
  const openTab = (tab: SideTab) => {
    setSideTab(tab);
    setMapCollapsed(false);
    if (!desktop) setMobileTab('side');
  };
  // Alt+1, Alt+2, ... open the side panel's tabs, collapsed or not.
  const railRef = useRef({ railTabs, openTab });
  railRef.current = { railTabs, openTab };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || !/^Digit[1-9]$/.test(e.code)) return;
      const tab = railRef.current.railTabs[Number(e.code.slice(5)) - 1];
      if (!tab) return;
      e.preventDefault();
      railRef.current.openTab(tab);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const shortcutOf = (tab: SideTab) => {
    const i = railTabs.indexOf(tab);
    return i === -1 ? undefined : `Alt+${i + 1}`;
  };
  // The fact-check follows the page in view like the history panel, but only
  // runs once its tab is open (each new check costs several web searches).
  const [factChecks, setFactChecks] = useState<Record<string, FactCheckState>>(() => snapshot?.factChecks ?? {});
  const factChecksRef = useRef(factChecks);
  factChecksRef.current = factChecks;
  const [factAttempt, setFactAttempt] = useState(0);
  const factTitle = activePage?.focus;
  const factVisible = shownTab === 'factcheck' && (desktop ? !mapCollapsed : mobileTab === 'side');
  useEffect(() => {
    if (!factOn || !factVisible || !factTitle) return;
    const existing = factChecksRef.current[factTitle];
    if (existing && existing.status !== 'error') return;
    const set = (state: FactCheckState) => setFactChecks((all) => ({ ...all, [factTitle]: state }));
    set({ status: 'loading' });
    fetchFactCheck(factTitle)
      .then((report) => set(report ? { status: 'ready', report } : { status: 'missing' }))
      .catch((err: Error) => set({ status: 'error', message: err.message.startsWith('Fact-check failed') ? undefined : err.message }));
  }, [factOn, factVisible, factTitle, factAttempt]);
  const activeFactCheck = factTitle ? factChecks[factTitle] : undefined;

  const sideName = sideTabs.length === 1 ? 'Map' : sideTabs.map((t) => SIDE_LABEL[t].toLowerCase()).join(', ').replace(/^m/, 'M').replace(/, ([^,]*)$/, ' and $1');

  // The chat carries the AI: in detailed mode each page's full answer (cited)
  // appears here, not on the page, so the Wikipedia text never waits for it.
  const chatEntries: ChatEntry[] = entries.map((entry) => {
    if (entry.status === 'context') {
      return { ...entry, state: contexts[entry.pageId]?.find((c) => c.id === entry.contextId)?.state };
    }
    if (entry.status !== 'done') return entry;
    const page = pages[entry.page];
    if (page?.history) return { ...entry, reply: withoutCitations(page.history.brief.headline) };
    if (mode === 'compact') {
      const brief = page && briefs[page.id];
      if (!brief || brief.status === 'loading') return { ...entry, reply: '', writing: true };
      return brief.byAi ? { ...entry, reply: withoutCitations(brief.brief.headline) } : entry;
    }
    return { ...entry, answer: page && answers[page.id], pageId: page?.id, sourceCount: page?.sources.length };
  });
  const chatBusy = chatEntries.some(
    (e) =>
      e.status === 'pending' ||
      (e.status === 'done' && (e.writing || (e.answer && ['waiting', 'thinking', 'writing'].includes(e.answer.status)))),
  );
  /** A dot on a tab when it has something for the page in view; it pulses while loading. */
  const sideBadges: Partial<Record<SideTab, { busy: boolean; count: number }>> = {
    chat: { busy: chatBusy, count: 0 },
    context: { busy: activeContexts.some((e) => e.state.status === 'loading'), count: activeContexts.length },
    factcheck: {
      busy: activeFactCheck?.status === 'loading',
      count: activeFactCheck?.status === 'ready' ? activeFactCheck.report.claims.length : 0,
    },
    history: {
      busy: activeTimeline?.status === 'loading',
      count: activeTimeline?.status === 'ready' ? activeTimeline.timeline.changes.length : 0,
    },
  };
  const logProps = {
    entries: chatEntries,
    onRetry: retry,
    onRetryAnswer: (i: number) => void answerPage(i),
    onGoToPage: (i: number) => goToPage(i),
    onOpenContext: () => revealSide('context'),
  };
  const composerProps = {
    onAsk: (q: string, how: AskMode) => void ask(q, how),
    onPhoto: imageOn ? (file: File, how: AskMode) => void askPhoto(file, how) : undefined,
    mode: askMode,
    onModeChange: setAskMode,
    modes: (webOn ? ['auto', 'articles', 'context'] : ['articles']) as AskMode[],
    onToggleDock: toggleDock,
  };
  const steps = pages.map((p) => p.step);
  // Saved means: nothing finished since the last save (a new page, answer, map, context or history).
  const state: ExplorationState = { pages, entries, answers, briefs, graphs, contexts, timelines, factChecks, reports, mainTab, active };
  const signature = contentSignature(state);
  const [savedSignature, setSavedSignature] = useState(() =>
    snapshot && saved ? contentSignature({ ...snapshot, factChecks: snapshot.factChecks ?? {}, reports: snapshot.reports ?? [], mainTab: snapshot.mainTab ?? "pages" }) : undefined,
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

  // Phones and tablets: one strip of views instead of stacked controls.
  const [styleMenu, setStyleMenu] = useState(false);
  useEffect(() => {
    if (!styleMenu) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setStyleMenu(false);
        document.querySelector<HTMLButtonElement>('[aria-controls="page-style-menu"]')?.focus();
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [styleMenu]);
  useEffect(() => setStyleMenu(false), [mobileTab, mainTab, desktop]);
  const mobileViews: { key: string; label: string; current: boolean; busy?: boolean; open: () => void }[] = [
    {
      key: 'pages',
      label: 'Pages',
      current: mobileTab === 'research' && mainTab === 'pages',
      open: () => {
        setMainTab('pages');
        setMobileTab('research');
      },
    },
    ...(deepOn
      ? [
          {
            key: 'deep',
            label: 'Deep research',
            current: mobileTab === 'research' && mainTab === 'deep',
            busy: deepRun?.status === 'running',
            open: () => {
              setMainTab('deep');
              setMobileTab('research');
            },
          },
        ]
      : []),
    ...sideTabs
      .filter((t) => t !== 'chat')
      .map((t) => ({
        key: t,
        label: SIDE_LABEL[t],
        current: mobileTab === 'side' && sideTab === t,
        busy: sideBadges[t]?.busy,
        open: () => {
          setMobileTab('side');
          setSideTab(t);
        },
      })),
  ];

  const goToPage = (index: number) => {
    setMobileTab('research');
    canvas.current?.scrollToPage(index);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-separator bg-background">
        {/* Wide screens: the exploration's question, the main view, the page style and Save. */}
        <div className="flex items-center justify-between gap-3 px-6 py-2.5 max-lg:hidden">
          <h1 className="min-w-0 truncate text-sm text-muted">
            <span className="sr-only">Exploration: </span>
            {initialSteps[0].text}
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            {deepOn && (
              <div role="group" aria-label="Main view" className="flex rounded-full bg-default p-0.5">
                {(['pages', 'deep'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={mainTab === t}
                    onClick={() => setMainTab(t)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                      mainTab === t ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted'
                    }`}
                  >
                    {t === 'pages' ? 'Pages' : 'Deep research'}
                    {t === 'deep' && deepRun?.status === 'running' && (
                      <span aria-label="(researching)" className="size-2 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />
                    )}
                  </button>
                ))}
              </div>
            )}
            <div role="group" aria-label="Page style" className={`flex rounded-full bg-default p-0.5 ${mainTab === 'deep' ? 'hidden' : ''}`}>
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
            <Button size="sm" variant="secondary" onPress={save} isPending={saving}>
              {isSaved ? 'Saved' : saved ? 'Save changes' : 'Save'}
            </Button>
          </div>
        </div>

        {/*
          Phones and tablets: one row. Every view is a tab in a strip that scrolls
          sideways (pages, deep research, then the side panels), with Save and a
          menu for the page style at the end.
        */}
        <div className="flex items-center gap-1 py-1.5 pr-2 pl-1 lg:hidden">
          <nav aria-label="Views" className="min-w-0 flex-1">
            <ul className="flex overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {mobileViews.map((v) => (
                <li key={v.key} className="shrink-0">
                  <button
                    type="button"
                    aria-current={v.current ? 'page' : undefined}
                    onClick={v.open}
                    className={`relative inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                      v.current ? 'bg-default font-medium text-foreground' : 'text-muted'
                    }`}
                  >
                    {v.label}
                    {v.busy && <span aria-label="(working)" className="size-1.5 animate-pulse rounded-full bg-accent motion-reduce:animate-none" />}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          <Button size="sm" variant="secondary" onPress={save} isPending={saving} className="shrink-0">
            {isSaved ? 'Saved' : 'Save'}
          </Button>
          {mainTab === 'pages' && mobileTab === 'research' && (
            <div className="relative shrink-0">
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label="Page style"
                aria-expanded={styleMenu}
                aria-controls="page-style-menu"
                onPress={() => setStyleMenu((o) => !o)}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <circle cx="5" cy="12" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="19" cy="12" r="1.8" />
                </svg>
              </Button>
              {styleMenu && (
                <>
                  <div className="fixed inset-0 z-40" aria-hidden onClick={() => setStyleMenu(false)} />
                  <div
                    id="page-style-menu"
                    role="group"
                    aria-label="Page style"
                    className="absolute top-full right-0 z-50 mt-1 flex w-44 flex-col rounded-lg border border-border bg-overlay p-1 shadow-lg"
                  >
                    {(['detailed', 'compact'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        aria-pressed={mode === m}
                        onClick={() => {
                          setMode(m);
                          setStyleMenu(false);
                        }}
                        className={`flex items-center justify-between rounded-md px-3 py-2 text-left text-sm outline-none hover:bg-default focus-visible:ring-2 focus-visible:ring-focus ${
                          mode === m ? 'font-medium text-foreground' : 'text-muted'
                        }`}
                      >
                        {m === 'detailed' ? 'Detailed pages' : 'Compact pages'}
                        {mode === m && <span aria-hidden>✓</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <section
          aria-label="Research"
          className={`relative min-w-0 flex-1 bg-background ${mobileTab === 'side' ? 'max-lg:hidden' : ''}`}
        >
          {mainTab === 'deep' && (
            <DeepResearchTab
              reports={reports}
              selectedId={reportId}
              onSelect={setReportId}
              run={deepRun}
              onStart={startDeep}
              onCancel={cancelDeep}
              suggestion={initialDeep ?? activePage?.focus ?? initialSteps[0]?.text}
              webAvailable={webOn}
            />
          )}
          <div className={mainTab === 'deep' ? 'hidden' : 'contents'}>
          <ResearchCanvas
            ref={canvas}
            pages={pages}
            mode={mode}
            briefs={briefs}
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
          {!chatDocked && <ChatCenter log={logProps} composer={composerProps} />}
          </div>
        </section>

        <aside
          aria-label={sideTabs.length === 1 ? 'Topic map' : sideName}
          style={desktop && !mapCollapsed ? { width: panelWidth ?? undefined, maxWidth: 'calc(100% - 320px)' } : undefined}
          className={`relative border-border bg-surface ${resizingPanel ? 'select-none' : 'transition-[width] duration-300 motion-reduce:transition-none'} lg:flex lg:shrink-0 lg:flex-col lg:border-l ${
            mapCollapsed ? 'lg:w-14' : 'lg:w-[28rem] xl:w-[32rem]'
          } ${mobileTab === 'research' ? 'max-lg:hidden' : 'max-lg:flex-1'}`}
        >
          {!mapCollapsed && (
            <div
              role="separator"
              aria-label="Resize side panel"
              aria-orientation="vertical"
              aria-valuemin={280}
              aria-valuenow={panelWidth ?? (window.innerWidth >= 1280 ? 512 : 448)}
              tabIndex={0}
              title="Drag to resize; use arrow keys when focused"
              className="absolute inset-y-0 -left-1 z-40 hidden w-2 touch-none cursor-col-resize items-center justify-center outline-none hover:bg-accent/20 focus-visible:bg-accent/20 lg:flex"
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                setResizingPanel(true);
              }}
              onPointerMove={(event) => {
                if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                const panel = event.currentTarget.parentElement!;
                const max = Math.max(280, panel.parentElement!.clientWidth - 320);
                setPanelWidth(Math.min(max, Math.max(280, panel.getBoundingClientRect().right - event.clientX)));
              }}
              onPointerUp={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                setResizingPanel(false);
              }}
              onLostPointerCapture={() => setResizingPanel(false)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
                event.preventDefault();
                const panel = event.currentTarget.parentElement!;
                const max = Math.max(280, panel.parentElement!.clientWidth - 320);
                const change = event.key === 'ArrowLeft' ? 24 : -24;
                setPanelWidth(Math.min(max, Math.max(280, panel.getBoundingClientRect().width + change)));
              }}
            >
              <span aria-hidden className="h-8 w-0.5 rounded-full bg-border" />
            </div>
          )}
          {/* Collapsed (desktop only): a slim rail with every tab, each opening the panel on that tab. */}
          {mapCollapsed && (
            <nav aria-label="Side panel" className="flex h-full flex-col items-center gap-1 pt-3 max-lg:hidden">
              <button
                type="button"
                onClick={() => setMapCollapsed(false)}
                aria-label={`Expand the side panel (${sideName.toLowerCase()})`}
                title="Expand the side panel"
                className="mb-1 flex size-9 items-center justify-center rounded-lg text-muted outline-none hover:bg-default hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M15 6l-6 6 6 6" />
                </svg>
              </button>
              {railTabs.map((tab) => {
                const badge = sideBadges[tab];
                return (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => openTab(tab)}
                    aria-label={`Open ${SIDE_LABEL[tab]}`}
                    aria-keyshortcuts={shortcutOf(tab)}
                    title={`${SIDE_LABEL[tab]} (${shortcutOf(tab)})`}
                    className={`relative flex flex-col items-center gap-2 rounded-lg px-2 py-2.5 text-sm outline-none hover:bg-default hover:text-foreground focus-visible:ring-2 focus-visible:ring-focus ${
                      tab === shownTab ? 'text-foreground' : 'text-muted'
                    }`}
                  >
                    <SideIcon tab={tab} />
                    <span className="[writing-mode:vertical-rl]">{SIDE_LABEL[tab]}</span>
                    {badge && (badge.busy || badge.count > 0) && (
                      <span
                        aria-hidden
                        className={`absolute top-1.5 right-1.5 size-2 rounded-full bg-accent ${badge.busy ? 'animate-pulse motion-reduce:animate-none' : ''}`}
                      />
                    )}
                  </button>
                );
              })}
            </nav>
          )}
          <div className={`h-full min-w-0 flex-1 flex-col ${mapCollapsed ? 'flex lg:hidden' : 'flex'}`}>
            {sideTabs.length > 1 && (
              <SideTabs
                tabs={sideTabs}
                tab={shownTab}
                onTab={setSideTab}
                badges={sideBadges}
                shortcut={shortcutOf}
                onCollapse={() => setMapCollapsed(true)}
              />
            )}
            {chatDocked && shownTab === 'chat' && (
              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
                <h2 className="sr-only">Questions and answers</h2>
                <ChatLog {...logProps} />
              </div>
            )}
            <div className={`min-h-0 flex-1 flex-col ${shownTab === 'map' || sideTabs.length === 1 ? 'flex' : 'hidden'}`}>
              <GraphPanel
                state={activePage ? graphs[activePage.id] : undefined}
                onDive={dive}
                onRetry={() => setGraphAttempt((n) => n + 1)}
                onCollapse={sideTabs.length > 1 ? undefined : () => setMapCollapsed(true)}
              />
            </div>
            {corpusOn && shownTab === 'history' && (
              <HistoryPanel
                title={historyTitle}
                state={activeTimeline}
                onRetry={() => {
                  if (historyTitle) setTimelines(({ [historyTitle]: _, ...rest }) => rest);
                  setTimelineAttempt((n) => n + 1);
                }}
              />
            )}
            {factOn && shownTab === 'factcheck' && (
              <FactCheckPanel
                title={factTitle}
                state={activeFactCheck}
                onRetry={() => {
                  if (factTitle) setFactChecks(({ [factTitle]: _, ...rest }) => rest);
                  setFactAttempt((n) => n + 1);
                }}
              />
            )}
            {webOn && shownTab === 'context' && (
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
            {/* Docked: the one input stays at the bottom of the side panel, whichever tab is open. */}
            {chatDocked && (
              <div className="border-t border-separator bg-surface">
                <ChatComposer {...composerProps} docked />
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

type SideTab = 'chat' | 'map' | 'context' | 'factcheck' | 'history';
const SIDE_LABEL: Record<SideTab, string> = {
  chat: 'Chat',
  map: 'Map',
  context: 'Context',
  factcheck: 'Fact-check',
  history: 'History',
};

/** Map | Context | History, at the top of the side panel, with the collapse control. */
function SideTabs({
  tabs,
  tab,
  onTab,
  badges,
  shortcut,
  onCollapse,
}: {
  tabs: SideTab[];
  shortcut: (tab: SideTab) => string | undefined;
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
              aria-keyshortcuts={shortcut(t)}
              title={shortcut(t) ? `${SIDE_LABEL[t]} (${shortcut(t)})` : undefined}
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

/** Small icons for the collapsed rail. */
function SideIcon({ tab }: { tab: SideTab }) {
  const paths: Record<SideTab, string> = {
    chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
    map: 'M4 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0M16 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M16 18a2 2 0 1 0 4 0a2 2 0 1 0-4 0M8 11l8-4M8 13l8 4',
    context: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z',
    factcheck: 'M12 3l7 3v5c0 4.5-3 8.3-7 10c-4-1.7-7-5.5-7-10V6l7-3zM8.8 12.2l2.2 2.2l4.2-4.4',
    history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  };
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={paths[tab]} />
    </svg>
  );
}
