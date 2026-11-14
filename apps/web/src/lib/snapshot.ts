import type { ChatEntry } from '../components/ChatCenter';
import type { ContextEntry } from '../components/ContextPanel';
import type { GraphState } from '../components/GraphPanel';
import type { TimelineState } from '../components/HistoryPanel';
import type { PageAnswer, PageBrief, ResearchPage } from './research';

/**
 * Everything an exploration showed, saved with it so opening it restores it
 * instead of searching and generating everything again. Only finished content
 * is kept: anything still loading when saved is fetched again on open.
 */
export interface ExplorationSnapshot {
  version: 1;
  pages: ResearchPage[];
  entries: ChatEntry[];
  answers: Record<string, PageAnswer>;
  briefs: Record<string, PageBrief>;
  graphs: Record<string, GraphState>;
  contexts: Record<string, ContextEntry[]>;
  timelines: Record<string, TimelineState>;
  /** The page that was in view. */
  active: number;
}

export interface ExplorationState extends Omit<ExplorationSnapshot, 'version'> {}

export function takeSnapshot(s: ExplorationState): ExplorationSnapshot {
  const keep = <T>(record: Record<string, T>, done: (v: T) => boolean) =>
    Object.fromEntries(Object.entries(record).filter(([, v]) => done(v)));
  return {
    version: 1,
    pages: s.pages,
    entries: s.entries.filter((e) => e.status === 'done').map((e) => (e.status === 'done' ? { ...e, writing: false } : e)),
    answers: keep(s.answers, (a) => a.status === 'done' || a.status === 'off'),
    briefs: keep(s.briefs, (b) => b.status === 'ready'),
    graphs: keep(s.graphs, (g) => g.status === 'ready' && !g.growing),
    contexts: Object.fromEntries(
      Object.entries(s.contexts)
        .map(([id, list]) => [id, list.filter((e) => e.state.status === 'ready')] as const)
        .filter(([, list]) => list.length > 0),
    ),
    timelines: keep(s.timelines, (t) => t.status === 'ready' || t.status === 'unavailable'),
    active: s.active,
  };
}

export function isSnapshot(value: unknown): value is ExplorationSnapshot {
  const v = value as Partial<ExplorationSnapshot> | null;
  return Boolean(v && v.version === 1 && Array.isArray(v.pages) && Array.isArray(v.entries));
}

/**
 * A cheap fingerprint of what's finished, to tell whether there's anything
 * new since the last save.
 */
export function contentSignature(s: ExplorationState) {
  const snap = takeSnapshot(s);
  return [
    snap.pages.map((p) => p.id).join(','),
    Object.keys(snap.answers).length,
    Object.keys(snap.briefs).length,
    Object.keys(snap.graphs).length,
    Object.values(snap.contexts).reduce((n, l) => n + l.length, 0),
    Object.keys(snap.timelines).length,
  ].join('|');
}
