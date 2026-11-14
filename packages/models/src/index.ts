export interface Health {
  status: 'ok';
  timestamp: string;
  /** Whether the AI answer endpoints are configured on this server. */
  ai: boolean;
  /** Whether ElevenLabs is configured: reading aloud (POST /api/speech) and spoken questions (POST /api/transcribe). */
  voice: boolean;
  /** Whether the local Wikipedia corpus (MariaDB, with embeddings) is loaded. */
  corpus: boolean;
  /** Whether web search (context.dev) is configured, so the AI can pull in context beyond Wikipedia. */
  web: boolean;
  /** Whether deep research reports are available: AI plus the corpus. */
  deep: boolean;
  /** Whether the fact-checker (Gemini with Google Search grounding) is configured. */
  factcheck: boolean;
  /** Whether searching by photo is available (POST /api/image-search): the vision model is configured. */
  image: boolean;
}

/** A passage from a web page found by web search (context.dev), used as a source next to Wikipedia. */
export interface WebSource {
  title: string;
  url: string;
  /** The site's domain, e.g. "imf.org". */
  site: string;
  /** The passages of the page that match the search. */
  text: string;
}

/**
 * One step of an exploration: a question the user asked, a topic they dove
 * into from the map, or an article whose edit history they looked at (text is
 * the article title for dives and histories).
 */
export interface ExplorationStep {
  kind: 'question' | 'dive' | 'history';
  text: string;
}

/** A saved exploration: every step in order, plus the topic the last page centered on. */
export interface Exploration {
  id: number;
  /** The opening question (same as steps[0].text). */
  question: string;
  focusTitle: string;
  steps: ExplorationStep[];
  createdAt: string;
  /** Whether everything it showed was saved too (GET /api/explorations/:id returns it). */
  hasSnapshot: boolean;
}

/** GET /api/explorations/:id: a saved exploration with its snapshot. */
export interface SavedExploration extends Exploration {
  /** What the web app saved (its own format, see ExplorationSnapshot there); null for older saves. */
  snapshot: unknown;
}

export interface NewExploration {
  focusTitle: string;
  steps: ExplorationStep[];
  snapshot?: unknown;
}

/** An earlier question and its answer, so follow-ups can be understood in context. */
export interface PriorTurn {
  question: string;
  answer: string;
}

export interface AnswerRequest {
  question: string;
  /** Wikipedia titles to answer from, numbered [1], [2], ... in this order. */
  titles: string[];
  history: PriorTurn[];
}

/** Streamed as server-sent events from POST /api/answer. */
export type AnswerEvent =
  | { type: 'thinking' }
  | { type: 'text'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface RewriteRequest {
  question: string;
  history: PriorTurn[];
}

export interface RewriteResponse {
  /** A standalone Wikipedia search query for the question. */
  query: string;
}

/**
 * Which sources the AI chose to gather for a question (POST /api/plan, same body
 * as RewriteRequest). Each is null when it decided that tool isn't needed.
 */
export interface SourcePlan {
  /** A standalone Wikipedia search query. */
  wikipediaQuery: string | null;
  /**
   * A web search query for the context panel (beside the Wikipedia page), when
   * the question needs more than article intros: impacts, data, analysis, recent news.
   */
  webQuery: string | null;
}

/** POST /api/route: where something typed in the chat goes. */
export interface RouteRequest {
  question: string;
  /** The topic of the page in view, if any. */
  topic?: string;
  history: PriorTurn[];
}

export interface RouteResponse {
  /** "articles" builds a new research page; "context" fills the context panel. */
  route: 'articles' | 'context';
  /** For context: a web query naming the topic and angle. */
  query: string | null;
}

/** POST /api/context: web context for a page, kept apart from its Wikipedia content. */
export interface ContextRequest {
  /** What to find context on, e.g. "consequences for the financial sector". */
  question: string;
  /** The page's topic (its focus article), added to the search when the question doesn't name it. */
  topic: string;
  /** A ready-made web query (from the planner); otherwise one is built from question and topic. */
  query?: string;
}

export interface ContextResponse {
  query: string;
  sources: WebSource[];
  /** A short summary of the sources with [n] citations, or null without AI. */
  summary: string | null;
}

/** A dated event in a compact brief. `sources` are 1-based excerpt numbers. */
export interface BriefEvent {
  /** For ordering; negative for BCE. */
  year: number;
  /** How the date reads, e.g. "6 December 1917" or "1809". */
  when: string;
  title: string;
  detail: string;
  sources: number[];
}

export interface BriefPoint {
  title: string;
  detail: string;
  sources: number[];
}

/** The compact, visual version of an answer: a headline plus a timeline or key points. */
export interface Brief {
  layout: 'timeline' | 'points';
  headline: string;
  events: BriefEvent[];
  points: BriefPoint[];
}

/** One important edit in an article's stored history (from the system-versioned table). */
export interface ArticleChange {
  /** 1-based; the history brief cites changes by this number. */
  n: number;
  revisionId: number;
  /** When the edit was made on Wikipedia (ISO 8601). */
  at: string;
  editor: string | null;
  comment: string | null;
  bytesBefore: number;
  bytesAfter: number;
  sectionsAdded: string[];
  sectionsRemoved: string[];
  /** How much of the lead was rewritten, 0 (unchanged) to 1 (entirely new). */
  leadChange: number;
  /** The article as it was right after this edit. */
  url: string;
  /** What this edit changed, on Wikipedia. */
  diffUrl: string;
  /** A one-line plain description built from the data above. */
  summary: string;
}

/** How much one edit changed one section, in words (moved text doesn't count). */
export interface SectionChange {
  /** "Lead" for the text before the first heading. */
  section: string;
  added: number;
  removed: number;
}

/** A substantial edit in the history panel: real prose changes, not typo fixes, formatting, bots or reverted vandalism. */
export interface HistoryChange {
  /** 1-based, in date order; the overview cites changes by this number. */
  n: number;
  revisionId: number;
  parentId: number;
  at: string;
  editor: string | null;
  comment: string | null;
  bytesBefore: number;
  bytesAfter: number;
  wordsAdded: number;
  wordsRemoved: number;
  /** Sections this edit changed, most changed first. */
  sections: SectionChange[];
  sectionsAdded: string[];
  sectionsRemoved: string[];
  /** A few words naming the change, and one sentence on it (by AI when available). */
  title: string;
  summary: string;
  diffUrl: string;
}

/** POST /api/article-history: an article's substantial changes across its recent history. */
export interface ArticleTimeline {
  title: string;
  pageId: number;
  url: string;
  /** Revisions scanned (metadata of up to a few thousand recent edits). */
  scanned: number;
  from: string;
  to: string;
  /** Article size over the scanned period, thinned to a few hundred points. */
  sizes: { at: string; bytes: number }[];
  changes: HistoryChange[];
  /** The most impactful changes in a few sentences, citing changes as [n]; null without AI. */
  overview: string | null;
}

/** A run of diff text: unchanged context, or words added or removed. */
export interface DiffSegment {
  type: 'same' | 'added' | 'removed';
  text: string;
}

export interface DiffHunk {
  section: string;
  segments: DiffSegment[];
}

/** GET /api/article-history/diff: what one edit added and removed, from the stored versions. */
export interface RevisionDiff {
  revisionId: number;
  parentId: number;
  hunks: DiffHunk[];
  /** More changed than is shown. */
  truncated: boolean;
}

/** How an article changed across its stored versions, with the most important edits picked out. */
export interface ArticleHistory {
  title: string;
  pageId: number;
  url: string;
  /** Number of stored versions (the collection keeps the most recent revisions, not all of them). */
  versions: number;
  from: string;
  to: string;
  /** Article size after every stored version, oldest first. */
  sizes: { at: string; bytes: number; revisionId: number }[];
  changes: ArticleChange[];
  brief: Brief;
  byAi: boolean;
}

// ---------- Figures (article_media) ----------

/** What a stored figure is: an image the vision model read (chart, map, diagram, photo) or text parsed from wikitext (infobox, table). */
export type MediaKind = 'chart' | 'map' | 'diagram' | 'photo' | 'infobox' | 'table';

// ---------- Deep research reports ----------

/** POST /api/deep-report: research a topic in depth into a full report. */
export interface DeepReportRequest {
  topic: string;
  /** Also search the web (context.dev) beside the Wikipedia collection. */
  web: boolean;
}

/** Something the report cites as [n]. */
export interface ReportSource {
  n: number;
  /** A Wikipedia passage (from the collection, or live for articles outside it), a figure, or a web page. */
  kind: 'wikipedia' | 'figure' | 'web';
  title: string;
  url: string;
  section?: string;
  /** Web pages: the site's domain. */
  site?: string;
  /** Wikipedia passages: whether the article is in the MariaDB collection. */
  stored?: boolean;
  /** Figures: what kind, its caption, its image (charts, maps, diagrams, photos) and what it shows (text read by the vision model, or the table/infobox text). */
  mediaKind?: MediaKind;
  caption?: string;
  imageUrl?: string;
  content?: string;
}

/** An event on the report's timeline. Dates are fractional years (1939.67 is about September 1939; negative for BCE). */
export interface ReportEvent {
  id: string;
  start: number;
  end?: number;
  /** How the date reads, e.g. "1 September 1939". */
  when: string;
  title: string;
  detail: string;
  /** 1: a turning point of the whole topic; 2: major within its part; 3: a detail (shown when zoomed in). */
  importance: 1 | 2 | 3;
  /** The part (1-based) it belongs to: its lane on the timeline. */
  part: number;
  sources: number[];
}

export interface ReportFact {
  label: string;
  value: string;
  sources: number[];
}

/** Comparable figures from the evidence, drawn as a bar chart. */
export interface ReportDataset {
  title: string;
  unit: string;
  items: { label: string; value: number }[];
  sources: number[];
}

/** One part of the report: its own page. */
export interface ReportPart {
  n: number;
  title: string;
  focus: string;
  /** 2 or 3 sentences, cited. */
  summary: string;
  /** Paragraphs separated by blank lines, cited with [n]. */
  sections: { heading: string; text: string }[];
  facts: ReportFact[];
  dataset: ReportDataset | null;
  /** Source numbers of the figures shown with this part. */
  figures: number[];
}

export interface DeepReport {
  id: string;
  topic: string;
  title: string;
  createdAt: string;
  web: boolean;
  model: string;
  /** 4 to 6 sentences, cited. */
  abstract: string;
  questions: string[];
  /** One answer per research question (1-based), cited. */
  answers: { question: number; text: string }[];
  parts: ReportPart[];
  events: ReportEvent[];
  /** Consecutive periods over the timeline. */
  eras: { from: number; to: number; label: string }[];
  limitations: string;
  method: {
    queries: string[];
    passages: number;
    articles: number;
    liveArticles: number;
    figures: number;
    webPages: number;
    seconds: number;
  };
  /** Cited sources, numbered in order of first citation. */
  sources: ReportSource[];
}

/** Progress of a deep research run, streamed as server-sent events from POST /api/deep-report. */
export type DeepReportEvent =
  | { type: 'step'; step: { id: string; label: string; done: boolean; detail?: string } }
  | { type: 'plan'; title: string; questions: string[]; parts: { n: number; title: string; focus: string }[] }
  | { type: 'report'; report: DeepReport }
  | { type: 'error'; message: string };

// ---------- Fact-check ----------

/** POST /api/fact-check: check the claims in an article's lead against the web. */
export interface FactCheckRequest {
  title: string;
}

/**
 * supported: web sources agree. partly: they agree on some of it, or give
 * different details (a date, a figure). contradicted: they say otherwise.
 * unverified: no source addressed it.
 */
export type FactCheckVerdict = 'supported' | 'partly' | 'contradicted' | 'unverified';

/** Independent evidence a verdict rests on (never Wikipedia, its sister projects or copies of it). */
export interface FactCheckSource {
  title: string;
  url: string;
  /** The site's domain, e.g. "britannica.com". */
  site?: string;
  /** What this source says about the claim: quoted (web search) or as Google Search attributed it. */
  excerpt?: string;
  /** How it was found: Google Search (through Gemini) or web search (context.dev). */
  via?: 'google' | 'web';
}

export interface FactCheckClaim {
  /** The claim as checked, standing on its own. */
  claim: string;
  /** The sentence in the Wikipedia article that makes it, quoted. */
  statement: string;
  verdict: FactCheckVerdict;
  /** What the web sources say, written to compare with the statement. */
  finding: string;
  /** One sentence on why. */
  explanation: string;
  /** Word-level comparison: "removed" only in the Wikipedia statement, "added" only in the web finding. */
  comparison: DiffSegment[];
  /** Pages the check was grounded on (Google Search). */
  sources: FactCheckSource[];
  /** What was searched for. */
  searches: string[];
}

export interface FactCheckReport {
  title: string;
  pageId: number;
  /** The revision the claims were taken from; results are reused until a newer one exists. */
  revisionId: number;
  url: string;
  checkedAt: string;
  model: string;
  claims: FactCheckClaim[];
}

/** POST /api/image-search (the photo as the request body, image/jpeg|png|webp): what the vision model saw, as a search. */
export interface ImageSearchResponse {
  /** A Wikipedia search query naming what the photo shows. */
  query: string;
  /** One or two plain sentences on what the photo shows. */
  description: string;
  /** Whether the photo was also kept in object storage. */
  stored: boolean;
}
