// Thin client for the public Wikipedia APIs. This is the source layer the
// AI features will build on: every topic and passage shown links back here.

const ACTION_API = 'https://en.wikipedia.org/w/api.php';
const REST_API = 'https://en.wikipedia.org/api/rest_v1';

export interface Topic {
  title: string;
  /** Plain-text search snippet; empty when the topic wasn't found via search. */
  snippet: string;
}

export interface Summary {
  title: string;
  description?: string;
  extract: string;
  url: string;
  thumbnail?: { source: string; width: number; height: number };
}

export interface GraphNode extends Topic {
  /** Hops from the center: 0 is the center, MAX_DEPTH the outermost ring. */
  depth: number;
  /** The node this one was discovered from (absent for the center). */
  parent?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** "tree" edges lead outward from the center; "cross" edges join two topics already on the map. */
  kind: 'tree' | 'cross';
}

export interface TopicGraph {
  center: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Deepest ring that has finished loading. */
  depth: number;
}

export const MAX_DEPTH = 5;
/** How many new topics each node branches into, by the depth of that node. */
const BRANCHING = [6, 2, 1, 1, 1];
/** Parallel requests while expanding a ring; keeps us polite to Wikipedia. */
const CONCURRENCY = 4;

export class NoResultsError extends Error {}

export const articleUrl = (title: string) =>
  `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;

const QUESTION_WORDS =
  /^(how|why|what|who|whom|when|where|which|did|do|does|is|are|was|were|can|could|should|would)$/i;

/** Drop leading interrogatives so search focuses on the subject of the question. */
export function toSearchQuery(question: string) {
  const words = question.replace(/[?!.]+$/g, '').trim().split(/\s+/);
  while (words.length > 1 && QUESTION_WORDS.test(words[0])) words.shift();
  return words.join(' ');
}

function plainText(html: string) {
  return new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim() ?? '';
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { 'Api-User-Agent': 'atlas-explorer/0.1' } });
  if (!res.ok) throw new Error(`Wikipedia responded with ${res.status}`);
  return res.json() as Promise<T>;
}

async function liveSearch(query: string, limit: number, signal?: AbortSignal): Promise<Topic[]> {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: String(limit),
    srprop: 'snippet',
    format: 'json',
    origin: '*',
  });
  const data = await getJson<{ query?: { search: { title: string; snippet: string }[] } }>(
    `${ACTION_API}?${params}`,
    signal,
  );
  return (data.query?.search ?? []).map((r) => ({ title: r.title, snippet: plainText(r.snippet) }));
}

const relatedCache = new Map<string, Promise<Topic[]>>();

/**
 * Articles related to this one, cached per title: neighbours in the local
 * corpus's vector index, or Wikipedia's related-article search ("morelike:")
 * for articles outside it.
 */
export function related(title: string, signal?: AbortSignal): Promise<Topic[]> {
  let pending = relatedCache.get(title);
  if (!pending) {
    pending = localRelated(title, signal).then((local) =>
      local.length >= 3 ? local : liveSearch(`morelike:${title}`, 10, signal),
    );
    relatedCache.set(title, pending);
    pending.catch(() => relatedCache.delete(title));
  }
  return pending;
}

async function eachLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]);
  });
  await Promise.all(workers);
}

/** Start from a question, or from an article with optional first-ring topics (e.g. a page's other sources). */
export type GraphRoot = { question: string } | { title: string; seeds?: Topic[]; about?: string };

/**
 * Map a question (or a known article) out to MAX_DEPTH rings. The first ring
 * comes from search; every further ring from each topic's related articles.
 * `onProgress` receives a fresh snapshot after each ring so the map can grow.
 */
export async function buildGraph(
  root: GraphRoot,
  onProgress: (graph: TopicGraph) => void,
  signal?: AbortSignal,
): Promise<TopicGraph> {
  // With the corpus loaded, the whole map comes from MariaDB's vector index in
  // one request; the live API below is only for servers without it.
  if ('title' in root) {
    const fromDb = await postJson<TopicGraph>(
      '/api/graph',
      { title: root.title, seeds: (root.seeds ?? []).slice(0, 10).map((s) => s.title), about: root.about?.slice(0, 2000) },
      signal,
    );
    if (fromDb && fromDb.nodes.length > 1) {
      onProgress(fromDb);
      return fromDb;
    }
  }

  let center: Topic;
  let firstRing: Topic[];
  if ('question' in root) {
    const results = await search(toSearchQuery(root.question), 10, signal);
    if (results.length === 0) throw new NoResultsError();
    [center, ...firstRing] = results;
  } else {
    center = { title: root.title, snippet: '' };
    firstRing = [...(root.seeds ?? []), ...(await related(root.title, signal))];
  }

  const nodes = new Map<string, GraphNode>([[center.title, { ...center, depth: 0 }]]);
  const edges: GraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const link = (source: string, target: string, kind: GraphEdge['kind']) => {
    const key = [source, target].sort().join('\u0000');
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ source, target, kind });
  };

  const addChildren = (parent: GraphNode, candidates: Topic[]) => {
    let added = 0;
    let crossLinks = 0;
    for (const topic of candidates) {
      if (topic.title === parent.title || topic.title === parent.parent) continue;
      const existing = nodes.get(topic.title);
      if (existing) {
        // One extra connection per topic shows the web without cluttering it.
        if (crossLinks < 1 && parent.depth > 0) {
          link(parent.title, existing.title, 'cross');
          crossLinks++;
        }
        continue;
      }
      if (added >= BRANCHING[parent.depth]) continue;
      nodes.set(topic.title, { ...topic, depth: parent.depth + 1, parent: parent.title });
      link(parent.title, topic.title, 'tree');
      added++;
    }
  };

  const snapshot = (depth: number): TopicGraph => ({
    center: center.title,
    nodes: [...nodes.values()],
    edges: [...edges],
    depth,
  });

  addChildren(nodes.get(center.title)!, firstRing);
  onProgress(snapshot(1));

  for (let depth = 1; depth < MAX_DEPTH; depth++) {
    const ring = [...nodes.values()].filter((n) => n.depth === depth);
    await eachLimited(ring, CONCURRENCY, async (node) => {
      try {
        addChildren(node, await related(node.title, signal));
      } catch (err) {
        if (signal?.aborted) throw err;
        // One topic failing shouldn't sink the whole map; it just doesn't branch.
      }
    });
    onProgress(snapshot(depth + 1));
  }

  return snapshot(MAX_DEPTH);
}

const summaryCache = new Map<string, Summary>();

/** A topic's summary: from MariaDB when the article is stored, from the live API otherwise. */
export async function getSummary(title: string, signal?: AbortSignal): Promise<Summary> {
  const cached = summaryCache.get(title);
  if (cached) return cached;
  const stored = (await postJson<{ articles: (CorpusArticle | null)[] }>('/api/articles', { titles: [title] }, signal))
    ?.articles[0];
  if (stored) {
    const summary: Summary = { title: stored.title, extract: stored.extract.split(/\n+/)[0], url: stored.url };
    summaryCache.set(title, summary);
    return summary;
  }
  const data = await getJson<{
    title: string;
    description?: string;
    extract: string;
    content_urls?: { desktop?: { page?: string } };
    thumbnail?: Summary['thumbnail'];
  }>(`${REST_API}/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, signal);
  const summary: Summary = {
    title: data.title,
    description: data.description,
    extract: data.extract,
    url: data.content_urls?.desktop?.page ?? articleUrl(title),
    thumbnail: data.thumbnail,
  };
  summaryCache.set(title, summary);
  return summary;
}

export interface Article {
  title: string;
  description?: string;
  /** Plain-text introduction (the lead section). */
  extract: string;
  url: string;
  image?: { source: string; width: number; height: number };
}

/** Lead sections, descriptions and images from the live API, in the order asked. */
async function liveArticles(titles: string[], signal?: AbortSignal): Promise<Article[]> {
  if (titles.length === 0) return [];
  const params = new URLSearchParams({
    action: 'query',
    prop: 'extracts|pageimages|description|info',
    exintro: '1',
    explaintext: '1',
    exlimit: 'max',
    piprop: 'thumbnail',
    pithumbsize: '800',
    inprop: 'url',
    redirects: '1',
    titles: titles.join('|'),
    format: 'json',
    formatversion: '2',
    origin: '*',
  });
  const data = await getJson<{
    query?: {
      normalized?: { from: string; to: string }[];
      redirects?: { from: string; to: string }[];
      pages: {
        title: string;
        missing?: boolean;
        extract?: string;
        description?: string;
        fullurl?: string;
        thumbnail?: { source: string; width: number; height: number };
      }[];
    };
  }>(`${ACTION_API}?${params}`, signal);
  const query = data.query;
  if (!query) return [];
  const renamed = new Map([...(query.normalized ?? []), ...(query.redirects ?? [])].map((r) => [r.from, r.to]));
  const resolve = (t: string) => {
    let cur = t;
    for (let i = 0; i < 3 && renamed.has(cur); i++) cur = renamed.get(cur)!;
    return cur;
  };
  const pages = new Map(query.pages.filter((pg) => !pg.missing && pg.extract).map((pg) => [pg.title, pg]));
  const seen = new Set<string>();
  return titles.flatMap((t) => {
    const pg = pages.get(resolve(t));
    if (!pg || seen.has(pg.title)) return [];
    seen.add(pg.title);
    return [
      {
        title: pg.title,
        description: pg.description,
        extract: pg.extract!.trim(),
        url: pg.fullurl ?? articleUrl(pg.title),
        image: pg.thumbnail,
      },
    ];
  });
}

// ---------- The local corpus (MariaDB, served by our API) ----------
//
// Articles collected into data/wikipedia-en are loaded into MariaDB with
// embeddings (see apps/api/src/ingest.ts). Searches and article text come from
// there first; the live Wikipedia API covers everything outside the corpus.

interface CorpusHit {
  title: string;
  snippet: string;
  distance: number;
  /** The query names this article by its full title. */
  titleMatch?: boolean;
  /** Stored in MariaDB with embeddings. */
  stored?: boolean;
}

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    return res.ok ? ((await res.json()) as T) : null;
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
}

async function localRelated(title: string, signal?: AbortSignal): Promise<Topic[]> {
  try {
    const res = await fetch(`/api/related?${new URLSearchParams({ title, limit: '10' })}`, { signal });
    if (!res.ok) return [];
    const { results } = (await res.json()) as { results: CorpusHit[] };
    return results.map((r) => ({ title: r.title, snippet: r.snippet }));
  } catch (err) {
    if (signal?.aborted) throw err;
    return [];
  }
}

/**
 * Search, ranked by vectors in MariaDB: the server runs vector search over the
 * corpus's embedded passages and ranks Wikipedia's own search results (sent as
 * candidates, for topics the corpus lacks) by the same embedding distance, with
 * articles the query names by title boosted. Without the corpus, or if the
 * server can't rank, Wikipedia's own order is used.
 */
export async function search(query: string, limit: number, signal?: AbortSignal): Promise<Topic[]> {
  const live = await liveSearch(query, limit, signal).catch((err) => {
    if (signal?.aborted) throw err;
    return [] as Topic[];
  });
  const ranked = await postJson<{ results: CorpusHit[] }>(
    '/api/search',
    { query, limit, candidates: live.map((t) => ({ title: t.title, snippet: t.snippet.slice(0, 1000) })) },
    signal,
  );
  const hits = ranked?.results ?? [];
  return hits.length > 0 ? hits.map((r) => ({ title: r.title, snippet: r.snippet })) : live;
}

/** Search only the local corpus (e.g. to find an article whose history is stored). */
export async function searchCorpus(query: string, limit: number, signal?: AbortSignal): Promise<Topic[]> {
  const local = await postJson<{ results: CorpusHit[] }>('/api/search', { query, limit }, signal);
  return (local?.results ?? []).map((r) => ({ title: r.title, snippet: r.snippet }));
}

interface CorpusArticle {
  title: string;
  url: string;
  revisionId: number;
  extract: string;
}

/**
 * Articles for a research page: text from the local corpus where stored, the
 * live API for the rest, and pictures and short descriptions from the live
 * API for all of them (the collection has no images). Works without the live
 * API for stored articles, just without pictures.
 */
/** The stored article with exactly this title (ignoring case), if the local collection has one. */
export async function storedTitle(title: string, signal?: AbortSignal): Promise<string | null> {
  const res = await postJson<{ articles: (CorpusArticle | null)[] }>('/api/articles', { titles: [title] }, signal);
  return res?.articles[0]?.title ?? null;
}

export async function getArticles(titles: string[], signal?: AbortSignal): Promise<Article[]> {
  if (titles.length === 0) return [];
  const [local, live] = await Promise.all([
    postJson<{ articles: (CorpusArticle | null)[] }>('/api/articles', { titles }, signal),
    liveArticles(titles, signal).catch((err) => {
      if (signal?.aborted) throw err;
      return [] as Article[];
    }),
  ]);
  const liveByTitle = new Map(live.map((a) => [a.title.toLowerCase(), a]));
  const seen = new Set<string>();
  return titles.flatMap((t, i) => {
    const stored = local?.articles[i];
    const fromLive = liveByTitle.get((stored?.title ?? t).toLowerCase()) ?? live.find((a) => a.title === t);
    const article: Article | undefined = stored
      ? {
          title: stored.title,
          description: fromLive?.description,
          extract: stored.extract,
          url: `https://en.wikipedia.org/w/index.php?oldid=${stored.revisionId}`,
          image: fromLive?.image,
        }
      : fromLive;
    if (!article || seen.has(article.title)) return [];
    seen.add(article.title);
    return [article];
  });
}
