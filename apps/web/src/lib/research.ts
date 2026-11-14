import type { ArticleHistory, Brief, ExplorationStep } from '@simsam/models';
import {
  getArticles,
  NoResultsError,
  related,
  search,
  searchCorpus,
  storedTitle,
  toSearchQuery,
  type Article,
  type Topic,
} from './wikipedia';

// Turns one step (a question or a dive) into a research page built from
// Wikipedia articles. Everything here is extractive: each passage shown is
// quoted from an article and cites it. An AI layer can later write the
// answer from the same sources without changing the page shape.

export interface TimelineEvent {
  year: number;
  text: string;
  /** Index into the page's sources. */
  source: number;
}

export interface ResearchPage {
  id: string;
  step: ExplorationStep;
  /** The article the page (and its map) centers on. */
  focus: string;
  sources: Article[];
  timeline: TimelineEvent[];
  /** Other search matches, used as the map's first ring. */
  seeds: Topic[];
  /** For "how has this article changed" pages: the article's stored history. */
  history?: ArticleHistory;
}

/** The article isn't in the local collection, so there's no stored history to read. */
export class HistoryUnavailableError extends Error {}

/**
 * "How has this article changed over time?": questions about an article's
 * edit history rather than its subject. Needs a word like "article" or an
 * explicit "edit history", so "how has computing changed?" stays a normal question.
 */
const HISTORY_INTENT =
  /\b(article|page|entry|wikipedia)\b.*\b(chang|evolv|edit|revis|develop|grown|grew)|\b(chang|evolv|edit|revis)\w*\b.*\b(article|page|entry)\b|\b(edit|revision|version) history\b/i;

export const isHistoryQuestion = (text: string) => HISTORY_INTENT.test(text);

const HISTORY_WORDS =
  /\b(how|has|have|had|did|does|do|is|was|the|this|that|its|it|of|on|about|for|in|over|time|article|page|entry|wikipedia|changed?|changes|evolved?|developed?|been|edited|edits?|revisions?|revised|versions?|history|grown|grew|throughout|years?|show|me|tell|see)\b/gi;

/**
 * Which article a history question is about: one it names ("how has the
 * article on the Hanseatic League changed?"), or else the page before it.
 */
export async function historyTarget(question: string, previousFocus: string | undefined, signal?: AbortSignal) {
  const subject = question
    .replace(HISTORY_WORDS, ' ')
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (subject.length >= 3) {
    // An exact title first: it works for every stored article, embedded or not.
    const exact = await storedTitle(subject, signal);
    if (exact) return exact;
    const [hit] = await searchCorpus(subject, 1, signal);
    if (hit) return hit.title;
  }
  return previousFocus;
}

async function fetchHistory(title: string, signal?: AbortSignal): Promise<ArticleHistory> {
  const res = await fetch('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
    signal,
  });
  if (res.status === 404) throw new HistoryUnavailableError(title);
  if (!res.ok) throw new Error(`History request failed with ${res.status}`);
  return (await res.json()) as ArticleHistory;
}

const editDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** A page about how an article changed: its important edits are the page's sources. */
async function historyPage(step: ExplorationStep, signal?: AbortSignal): Promise<ResearchPage> {
  const history = await fetchHistory(step.text, signal);
  return {
    id: `page-${++pageCounter}`,
    step: { kind: 'history', text: history.title },
    focus: history.title,
    // With no edits to show (a single stored version), the article itself is the source.
    sources: history.changes.length
      ? history.changes.map((c) => ({
          title: `Edit of ${editDate(c.at)}${c.editor ? ` by ${c.editor}` : ''}`,
          description: c.summary,
          extract: c.summary,
          url: c.diffUrl,
        }))
      : [{ title: history.title, description: 'Current version', extract: history.brief.headline, url: history.url }],
    timeline: [],
    seeds: [],
    history,
  };
}

const SOURCES_PER_PAGE = 4;
const MAX_EVENTS = 10;

/** Follow-ups like "what happened to him after that?" need the previous topic to search well. */
const REFERS_BACK =
  /\b(it|its|he|him|his|she|her|hers|they|them|their|this|that|these|those|there|then|after|before)\b/i;

export function sentences(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const YEAR = /\b(1[0-9]{3}|20[0-9]{2})\b/;

function buildTimeline(sources: Article[]): TimelineEvent[] {
  const thisYear = new Date().getFullYear();
  const events: TimelineEvent[] = [];
  const seen = new Set<string>();
  sources.forEach((article, source) => {
    let fromThis = 0;
    for (const sentence of sentences(article.extract)) {
      const match = sentence.match(YEAR);
      if (!match) continue;
      const year = Number(match[1]);
      if (year > thisYear || seen.has(`${year}`)) continue;
      seen.add(`${year}`);
      events.push({ year, text: sentence.length > 220 ? `${sentence.slice(0, 217).trimEnd()}…` : sentence, source });
      if (++fromThis >= 4) break;
    }
  });
  return events.sort((a, b) => a.year - b.year).slice(0, MAX_EVENTS);
}

let pageCounter = 0;

/** After restoring saved pages, new pages must not reuse their ids. */
export function reservePageIds(ids: string[]) {
  for (const id of ids) pageCounter = Math.max(pageCounter, Number(id.replace(/^page-/, '')) || 0);
}

/**
 * @param query A ready-made search query (e.g. a follow-up the AI rewrote to
 *   stand on its own). Without one, the question is turned into a query here.
 */
export async function research(
  step: ExplorationStep,
  previousFocus: string | undefined,
  query?: string,
  signal?: AbortSignal,
): Promise<ResearchPage> {
  if (step.kind === 'history') return historyPage(step, signal);

  let titles: string[];
  let seeds: Topic[];

  if (step.kind === 'dive') {
    const near = await related(step.text, signal);
    titles = [step.text, ...near.slice(0, SOURCES_PER_PAGE - 1).map((t) => t.title)];
    seeds = [];
  } else if (query) {
    let results = await search(query, 8, signal);
    if (results.length === 0) results = await search(toSearchQuery(step.text), 8, signal);
    if (results.length === 0) throw new NoResultsError();
    titles = results.slice(0, SOURCES_PER_PAGE).map((t) => t.title);
    seeds = results.slice(1);
  } else {
    const base = toSearchQuery(step.text);
    const needsContext = previousFocus && (REFERS_BACK.test(step.text) || base.split(' ').length <= 3);
    let results = await search(needsContext ? `${base} ${previousFocus}` : base, 8, signal);
    if (results.length === 0 && previousFocus && !needsContext) {
      results = await search(`${base} ${previousFocus}`, 8, signal);
    }
    if (results.length === 0) throw new NoResultsError();
    titles = results.slice(0, SOURCES_PER_PAGE).map((t) => t.title);
    seeds = results.slice(1);
  }

  const sources = await getArticles(titles, signal);
  if (sources.length === 0) throw new NoResultsError();

  return {
    id: `page-${++pageCounter}`,
    step,
    focus: sources[0].title,
    sources,
    timeline: buildTimeline(sources),
    seeds,
  };
}

/** The AI-written answer for a page, as it streams in. */
export type PageAnswer =
  | { status: 'off' } // no AI on this server: the page shows Wikipedia text only
  | { status: 'waiting' }
  | { status: 'thinking' }
  | { status: 'writing' | 'done'; text: string }
  | { status: 'error'; message: string };

/** A page's compact brief. Without AI (or if it fails) one is built from the page itself. */
export type PageBrief = { status: 'loading' } | { status: 'ready'; brief: Brief; byAi: boolean };

const clip = (text: string, max: number) => {
  const words = text.split(/\s+/);
  return words.length > max ? `${words.slice(0, max).join(' ')}…` : text;
};

/** A brief made from the page's own Wikipedia text: its dates if it has enough, otherwise its articles. */
export function localBrief(page: ResearchPage): Brief {
  const lead = page.sources[0];
  const headline = `${sentences(lead.extract)[0] ?? lead.title} [1]`;
  if (page.timeline.length >= 3) {
    return {
      layout: 'timeline',
      headline,
      events: page.timeline.slice(0, 8).map((e) => ({
        year: e.year,
        when: String(e.year),
        title: clip(e.text, 12),
        detail: '',
        sources: [e.source + 1],
      })),
      points: [],
    };
  }
  return {
    layout: 'points',
    headline,
    events: [],
    points: page.sources.map((s, i) => ({
      title: s.title,
      detail: clip(s.description ? `${s.description[0].toUpperCase()}${s.description.slice(1)}.` : sentences(s.extract)[0] ?? '', 25),
      sources: [i + 1],
    })),
  };
}
