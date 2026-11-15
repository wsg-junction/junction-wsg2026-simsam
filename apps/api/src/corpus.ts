// Reading the local Wikipedia corpus (filled by ingest.ts): semantic search over
// embedded passages, related articles, and article text. Every function
// returns nothing (rather than throwing) for articles that aren't stored, so
// callers can fall back to the live Wikipedia API.
import type { RowDataPacket } from 'mysql2/promise';
import { pool } from './db.js';
import type { MediaKind } from '@simsam/models';
import { embedCached, EmbeddingRejectedError, embeddingsEnabled, vectorText } from './embeddings.js';
import { figureSnippet, nearestFigures } from './media.js';

/** Cosine distance above which a passage isn't considered relevant at all. */
const MAX_DISTANCE = 0.68;

export interface CorpusHit {
  title: string;
  pageId: number;
  snippet: string;
  /** Cosine distance of the best-matching passage (lower is closer). */
  distance: number;
  /** Set when the best match is one of the article's figures (a chart, map, infobox or table) rather than its prose. */
  figure?: { kind: MediaKind; caption: string | null; imageUrl: string | null };
}

let available: Promise<boolean> | null = null;
/** Whether the corpus tables exist and hold embedded passages. Re-checked every minute. */
export function corpusAvailable(): Promise<boolean> {
  available ??= pool
    .query<RowDataPacket[]>('SELECT 1 FROM article_chunks LIMIT 1')
    .then(([rows]) => embeddingsEnabled && rows.length > 0)
    .catch(() => false);
  setTimeout(() => (available = null), 60_000).unref();
  return available;
}

const snippetOf = (content: string) => {
  const flat = content.replace(/\s+/g, ' ').trim();
  return flat.length > 220 ? `${flat.slice(0, 217).trimEnd()}…` : flat;
};

/** Nearest passages to a vector, best passage per article, closest articles first. */
async function nearestArticles(vector: number[], limit: number, excludePageId?: number): Promise<CorpusHit[]> {
  const v = vectorText(vector);
  // The vector index answers ORDER BY distance LIMIT n; over-fetch passages so
  // that grouping them by article still leaves enough articles.
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT c.page_id, a.title, c.content, VEC_DISTANCE_COSINE(c.embedding, VEC_FromText(?)) AS distance
     FROM article_chunks c JOIN articles a USING (page_id)
     ORDER BY VEC_DISTANCE_COSINE(c.embedding, VEC_FromText(?))
     LIMIT ?`,
    [v, v, limit * 8],
  );
  const best = new Map<number, CorpusHit>();
  for (const r of rows) {
    const pageId = Number(r.page_id);
    const distance = Number(r.distance);
    if (pageId === excludePageId || distance > MAX_DISTANCE || best.has(pageId)) continue;
    best.set(pageId, { title: r.title, pageId, snippet: snippetOf(r.content), distance });
  }
  return [...best.values()].slice(0, limit);
}

/**
 * Articles fetched on demand (acquire.ts) closest to a vector, by scanning their
 * passages directly. MariaDB's vector index can leave a newly inserted article
 * on a topic far from the rest of the collection out of its nearest-neighbour
 * results, so those articles are searched here instead and merged in by the
 * callers. Cheap while on-demand articles number in the thousands.
 */
async function freshPages(vector: number[], limit: number, maxDistance = MAX_DISTANCE): Promise<number[]> {
  const [rows] = await pool
    .query<RowDataPacket[]>(
      `SELECT c.page_id, MIN(VEC_DISTANCE_COSINE(c.embedding, VEC_FromText(?))) AS distance
       FROM article_chunks c JOIN articles a USING (page_id)
       WHERE a.discovered_via = 'on-demand'
       GROUP BY c.page_id ORDER BY distance`,
      [vectorText(vector)],
    )
    .catch(() => [[] as RowDataPacket[]]);
  return rows.filter((r) => Number(r.distance) <= maxDistance).slice(0, limit).map((r) => Number(r.page_id));
}

/** How much closer an article counts when the query names it by its full title. */
const TITLE_BOOST = 0.1;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Stored articles whose whole title appears in the query, on word boundaries
 * ("World War II economic impact" names "World War II"). Shorter titles inside
 * a longer match ("World War" inside "World War II") don't count.
 */
async function titlesNamedIn(query: string): Promise<{ pageId: number; title: string }[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT page_id, title FROM articles
     WHERE CHAR_LENGTH(title) >= 4 AND ? LIKE CONCAT('%', REPLACE(REPLACE(title, '%', '\\\\%'), '_', '\\\\_'), '%')
     LIMIT 50`,
    [query],
  );
  const named = rows
    .map((r) => ({ pageId: Number(r.page_id), title: String(r.title) }))
    .filter(({ title }) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(title)}($|[^\\p{L}\\p{N}])`, 'iu').test(query));
  return named.filter((a) => !named.some((b) => b !== a && b.title.length > a.title.length && b.title.toLowerCase().includes(a.title.toLowerCase())));
}

/** A result from Wikipedia's own (live) search, to be ranked together with the corpus. */
export interface SearchCandidate {
  title: string;
  snippet: string;
}

export interface RankedHit {
  title: string;
  snippet: string;
  /** Cosine distance to the query: of the best stored passage, or of title and snippet for live results. */
  distance: number;
  /** The query names this article by its full title. */
  titleMatch: boolean;
  /** Stored in MariaDB with embeddings (its text comes from the corpus). */
  stored: boolean;
  /** The best match is one of its figures. */
  figure?: CorpusHit['figure'];
}

/** Stored articles get a small edge over equally close live ones: their full text is local. */
const STORED_BONUS = 0.02;

const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'and', 'or', 'to', 'for', 'by', 'with', 'from', 'at', 'as', 'is', 'was']);
const contentWords = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOPWORDS.has(w));

const cosineDistance = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return 1 - dot / (Math.sqrt(na * nb) || 1);
};

const namesTitle = (query: string, title: string) => {
  const name = title.replace(/\s*\([^)]*\)$/, '');
  return name.length >= 4 && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(name)}($|[^\\p{L}\\p{N}])`, 'iu').test(query);
};

/**
 * Hybrid search, ranked by one vector model:
 * - MariaDB vector search over the embedded passages (best passage per article);
 * - articles the query names by title, boosted (pure vector ranking lets an
 *   article that merely discusses a topic outrank the topic's own article:
 *   "History of the European Union" above "World War II");
 * - live Wikipedia search results (`candidates`) for what the corpus lacks:
 *   stored ones are measured on their passages, the rest on title and snippet.
 */
export async function searchCorpus(query: string, limit: number, candidates: SearchCandidate[] = []): Promise<RankedHit[]> {
  if (!(await corpusAvailable())) return [];
  try {
    // Interactive: don't sit in rate-limit backoff. Without a query vector the caller uses Wikipedia's order.
    const [[vector], named] = await Promise.all([
      embedCached([query], 'query', AbortSignal.timeout(6_000)),
      titlesNamedIn(query),
    ]);
    if (!vector) return [];
    const [hits, figures, fresh] = await Promise.all([
      nearestArticles(vector, limit * 2),
      // What charts, maps, infoboxes and tables show (article_media), next to the prose.
      nearestFigures(vector, limit * 2).catch(() => []),
      freshPages(vector, limit),
    ]);
    for (const fig of figures) {
      const distance = fig.distance ?? 1;
      if (distance > MAX_DISTANCE) continue;
      const figure = { kind: fig.kind, caption: fig.caption, imageUrl: fig.imageUrl };
      const hit = hits.find((h) => h.pageId === fig.pageId);
      if (!hit) hits.push({ title: fig.title, pageId: fig.pageId, snippet: figureSnippet(fig), distance, figure });
      else if (distance < hit.distance) Object.assign(hit, { distance, snippet: figureSnippet(fig), figure });
    }
    const has = (title: string) => hits.some((h) => h.title.toLowerCase() === title.toLowerCase());

    // Named or live-found articles that are stored but weren't among the nearest: measure their passages.
    const [storedCandidates] =
      candidates.length > 0
        ? await pool.query<RowDataPacket[]>('SELECT page_id, title FROM articles WHERE title IN (?)', [candidates.map((c) => c.title)])
        : [[] as RowDataPacket[]];
    const toMeasure = [
      ...named.map((n) => n.pageId),
      ...fresh,
      ...storedCandidates.map((r) => Number(r.page_id)),
    ].filter((id) => !hits.some((h) => h.pageId === id));
    if (toMeasure.length > 0) {
      const [rows] = await pool.query<RowDataPacket[]>(
        `SELECT c.page_id, a.title, c.content, VEC_DISTANCE_COSINE(c.embedding, VEC_FromText(?)) AS distance
         FROM article_chunks c JOIN articles a USING (page_id)
         WHERE c.page_id IN (?) ORDER BY distance`,
        [vectorText(vector), [...new Set(toMeasure)]],
      );
      for (const r of rows) {
        if (has(r.title)) continue;
        hits.push({ title: r.title, pageId: Number(r.page_id), snippet: snippetOf(r.content), distance: Number(r.distance) });
      }
    }
    const ranked: RankedHit[] = hits.map((h) => ({ ...h, titleMatch: namesTitle(query, h.title), stored: true }));

    // Live results the corpus doesn't hold (or hasn't embedded yet): embed title and snippet.
    const live = candidates.filter((c) => !has(c.title) && !/\(disambiguation\)$/i.test(c.title)).slice(0, 10);
    if (live.length > 0) {
      const vectors = await embedCached(
        live.map((c) => `${c.title}\n\n${c.snippet}`),
        'passage',
        AbortSignal.timeout(5_000),
      ).catch(() => null);
      live.forEach((c, i) => {
        const v = vectors?.[i];
        // If they couldn't be embedded in time, live results keep Wikipedia's order, mid-table.
        const distance = v ? cosineDistance(vector, v) : 0.55 + i * 0.01;
        ranked.push({ title: c.title, snippet: c.snippet, distance, titleMatch: namesTitle(query, c.title), stored: false });
      });
    }

    // A title boost in proportion to how much of the query the title is: all of
    // it for "World War II", a quarter for "Napoleon" in "Napoleon invasion of Russia".
    const queryWords = contentWords(query).length || 1;
    const boost = (h: RankedHit) =>
      h.titleMatch
        ? TITLE_BOOST * Math.min(1, contentWords(h.title.replace(/\s*\([^)]*\)$/, '')).length / queryWords)
        : 0;
    const score = (h: RankedHit) => h.distance - boost(h) - (h.stored ? STORED_BONUS : 0);
    return ranked
      .filter((h) => h.distance <= MAX_DISTANCE || h.titleMatch)
      .sort((a, b) => score(a) - score(b))
      .slice(0, limit);
  } catch (err) {
    // A query the embedding API refuses just has no local matches; callers fall back to live search.
    if (err instanceof EmbeddingRejectedError) return [];
    throw err;
  }
}

/** Articles close to this one: neighbours of its opening passage. */
export async function relatedInCorpus(title: string, limit: number): Promise<CorpusHit[]> {
  if (!(await corpusAvailable())) return [];
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT c.page_id, VEC_ToText(c.embedding) AS v FROM article_chunks c JOIN articles a USING (page_id)
     WHERE a.title = ? ORDER BY c.chunk_index LIMIT 1`,
    [title],
  );
  if (rows.length === 0) return [];
  return nearestArticles(JSON.parse(rows[0].v) as number[], limit, Number(rows[0].page_id));
}

export interface CorpusArticle {
  title: string;
  pageId: number;
  url: string;
  revisionId: number;
  /** The lead section of the current text. */
  extract: string;
}

/** The lead: everything before the first section heading, shortened at a paragraph. */
function leadOf(text: string, maxChars = 3000) {
  const cut = text.search(/^==[^=]/m);
  const lead = (cut === -1 ? text : text.slice(0, cut)).trim();
  if (lead.length <= maxChars) return lead;
  const para = lead.lastIndexOf('\n', maxChars);
  return `${lead.slice(0, para > maxChars / 2 ? para : maxChars).trimEnd()}…`;
}

/** Stored articles by title, aligned with the input (null where not stored). */
export async function corpusArticles(titles: string[]): Promise<(CorpusArticle | null)[]> {
  if (titles.length === 0) return [];
  const [rows] = await pool
    .query<RowDataPacket[]>(
      `SELECT a.page_id, a.title, a.url, a.text, c.revision_id
       FROM articles a JOIN article_content c USING (page_id) WHERE a.title IN (?)`,
      [titles],
    )
    .catch(() => [[] as RowDataPacket[]]);
  const byTitle = new Map(rows.map((r) => [String(r.title).toLowerCase(), r]));
  return titles.map((t) => {
    const r = byTitle.get(t.toLowerCase());
    return r
      ? { title: r.title, pageId: Number(r.page_id), url: r.url, revisionId: Number(r.revision_id), extract: leadOf(r.text) }
      : null;
  });
}

// ---------- Topic map, from MariaDB only ----------

export interface CorpusGraphNode {
  title: string;
  snippet: string;
  /** Steps from the center: 0 is the center. */
  depth: number;
  /** The topic this one was found from (absent for the center). */
  parent?: string;
}

export interface CorpusGraph {
  center: string;
  nodes: CorpusGraphNode[];
  edges: { source: string; target: string; kind: 'tree' | 'cross' }[];
  depth: number;
}

export const GRAPH_DEPTH = 5;
/** How many new topics each node branches into, by the depth of that node. */
const GRAPH_BRANCHING = [6, 2, 1, 1, 1];
/** Vector queries in flight while expanding a layer. */
const GRAPH_CONCURRENCY = 4;

/** Each article's opening passage vector (its first embedded chunk). */
async function leadVectors(pageIds: number[]): Promise<Map<number, number[]>> {
  if (pageIds.length === 0) return new Map();
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT c.page_id, VEC_ToText(c.embedding) AS v
     FROM article_chunks c
     JOIN (SELECT page_id, MIN(chunk_index) AS first FROM article_chunks WHERE page_id IN (?) GROUP BY page_id) f
       ON f.page_id = c.page_id AND f.first = c.chunk_index`,
    [pageIds],
  );
  return new Map(rows.map((r) => [Number(r.page_id), JSON.parse(r.v) as number[]]));
}

/** Each article's whole-article vector (article_vectors), falling back to its opening passage. */
async function nodeVectors(pageIds: number[]): Promise<Map<number, number[]>> {
  if (pageIds.length === 0) return new Map();
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT page_id, VEC_ToText(embedding) AS v FROM article_vectors WHERE page_id IN (?)',
    [pageIds],
  );
  const found = new Map(rows.map((r) => [Number(r.page_id), JSON.parse(r.v) as number[]]));
  const rest = pageIds.filter((id) => !found.has(id));
  for (const [id, v] of await leadVectors(rest)) found.set(id, v);
  return found;
}

/** Nearest whole articles in the article_vectors index. */
async function nearestWholeArticles(vector: number[], limit: number, excludePageId?: number): Promise<CorpusHit[]> {
  const v = vectorText(vector);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT v.page_id, a.title, VEC_DISTANCE_COSINE(v.embedding, VEC_FromText(?)) AS distance
     FROM article_vectors v JOIN articles a USING (page_id)
     ORDER BY VEC_DISTANCE_COSINE(v.embedding, VEC_FromText(?))
     LIMIT ?`,
    [v, v, limit + 1],
  );
  return rows
    .filter((r) => Number(r.page_id) !== excludePageId)
    .map((r) => ({ title: String(r.title), pageId: Number(r.page_id), snippet: '', distance: Number(r.distance) }))
    .slice(0, limit);
}

let wholeArticleIndex: Promise<boolean> | null = null;
/**
 * Whether to draw the map from article_vectors (re-checked every minute): as
 * soon as it has rows. Articles without a vector yet just aren't offered as
 * neighbours until the next ingest (or --article-vectors) fills them in; the
 * passage index is only the fallback for a database that has none at all,
 * because searching it per topic is many times slower.
 */
function useWholeArticles(): Promise<boolean> {
  wholeArticleIndex ??= pool
    .query<RowDataPacket[]>('SELECT EXISTS (SELECT 1 FROM article_vectors) AS any_rows')
    .then(([[r]]) => Number(r.any_rows) === 1)
    .catch(() => false);
  setTimeout(() => (wholeArticleIndex = null), 60_000).unref();
  return wholeArticleIndex;
}

const graphCache = new Map<string, { at: number; graph: Promise<CorpusGraph | null> }>();
const GRAPH_TTL = 10 * 60_000;

/**
 * The topic map, built entirely in MariaDB: each topic's neighbours are the
 * articles nearest to it in the vector index (whole-article vectors, or the
 * opening passage until those are filled). A topic already on the map becomes
 * a cross link instead (at most one per topic). A center outside the corpus
 * starts from the stored articles nearest to its title. Cached for a while.
 */
export function corpusGraph(title: string, seeds: string[] = [], about = ''): Promise<CorpusGraph | null> {
  const key = `${title}\u0000${seeds.join('\u0001')}\u0000${about.slice(0, 200)}`;
  const hit = graphCache.get(key);
  if (hit && Date.now() - hit.at < GRAPH_TTL) return hit.graph;
  const graph = buildCorpusGraph(title, seeds, about);
  graphCache.set(key, { at: Date.now(), graph });
  graph.then((g) => g ?? graphCache.delete(key), () => graphCache.delete(key));
  if (graphCache.size > 300) graphCache.delete(graphCache.keys().next().value!);
  return graph;
}

async function buildCorpusGraph(title: string, seeds: string[], about: string): Promise<CorpusGraph | null> {
  if (!(await corpusAvailable())) return null;
  const whole = await useWholeArticles();
  const neighbours = (v: number[], limit: number, exclude?: number) =>
    whole ? nearestWholeArticles(v, limit, exclude) : nearestArticles(v, limit, exclude);
  const [[centerRow]] = await pool.query<RowDataPacket[]>('SELECT page_id, title FROM articles WHERE title = ?', [title]);
  const center = centerRow ? String(centerRow.title) : title;

  const nodes = new Map<string, CorpusGraphNode & { pageId?: number }>([[center, { title: center, snippet: '', depth: 0, pageId: centerRow ? Number(centerRow.page_id) : undefined }]]);
  const edges: CorpusGraph['edges'] = [];
  const edgeKeys = new Set<string>();
  const link = (source: string, target: string, kind: 'tree' | 'cross') => {
    const key = [source, target].sort().join('\u0000');
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ source, target, kind });
  };
  const addChildren = (parent: CorpusGraphNode, candidates: CorpusHit[]) => {
    let added = 0;
    let crossLinks = 0;
    for (const hit of candidates) {
      if (hit.title === parent.title || hit.title === parent.parent) continue;
      const existing = nodes.get(hit.title);
      if (existing) {
        if (crossLinks < 1 && parent.depth > 0) {
          link(parent.title, existing.title, 'cross');
          crossLinks++;
        }
        continue;
      }
      if (added >= GRAPH_BRANCHING[parent.depth]) continue;
      nodes.set(hit.title, { title: hit.title, snippet: hit.snippet, depth: parent.depth + 1, parent: parent.title, pageId: hit.pageId });
      link(parent.title, hit.title, 'tree');
      added++;
    }
  };

  // First ring: stored seeds (the page's other sources) first, then the center's neighbours.
  const centerNode = nodes.get(center)!;
  const [seedRows] =
    seeds.length > 0
      ? await pool.query<RowDataPacket[]>('SELECT page_id, title FROM articles WHERE title IN (?)', [seeds])
      : [[] as RowDataPacket[]];
  const seedHits: CorpusHit[] = seeds
    .map((s) => seedRows.find((r) => String(r.title).toLowerCase() === s.toLowerCase()))
    .filter((r): r is RowDataPacket => Boolean(r))
    .map((r) => ({ title: String(r.title), pageId: Number(r.page_id), snippet: '', distance: 0 }));
  let centerVector = centerNode.pageId ? (await nodeVectors([centerNode.pageId])).get(centerNode.pageId) : undefined;
  if (!centerVector) {
    // A center outside the corpus: its opening text says what it is ("Alan Turing"
    // alone lands near the Alans); the bare title only when there's no text.
    const [v] = await (about
      ? embedCached([`${center}\n\n${about.slice(0, 1500)}`], 'passage', AbortSignal.timeout(6_000))
      : embedCached([center], 'query', AbortSignal.timeout(6_000))
    ).catch(() => [null]);
    centerVector = v ?? undefined;
  }
  const near = centerVector ? await neighbours(centerVector, 12, centerNode.pageId) : [];
  addChildren(centerNode, [...seedHits, ...near]);

  for (let depth = 1; depth < GRAPH_DEPTH; depth++) {
    const layer = [...nodes.values()].filter((n) => n.depth === depth && n.pageId !== undefined);
    const vectors = await nodeVectors(layer.map((n) => n.pageId!));
    const found = new Map<string, CorpusHit[]>();
    let next = 0;
    await Promise.all(
      Array.from({ length: GRAPH_CONCURRENCY }, async () => {
        while (next < layer.length) {
          const node = layer[next++];
          const v = vectors.get(node.pageId!);
          if (v) found.set(node.title, await neighbours(v, 8, node.pageId));
        }
      }),
    );
    // Expand in layer order, so the result doesn't depend on which query finished first.
    for (const node of layer) addChildren(node, found.get(node.title) ?? []);
  }

  // Snippets for seeds (found by title, not by passage).
  const missing = [...nodes.values()].filter((n) => !n.snippet && n.pageId !== undefined);
  if (missing.length > 0) {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT c.page_id, c.content FROM article_chunks c
       JOIN (SELECT page_id, MIN(chunk_index) AS first FROM article_chunks WHERE page_id IN (?) GROUP BY page_id) f
         ON f.page_id = c.page_id AND f.first = c.chunk_index`,
      [missing.map((n) => n.pageId)],
    );
    const byId = new Map(rows.map((r) => [Number(r.page_id), snippetOf(String(r.content))]));
    for (const n of missing) n.snippet = byId.get(n.pageId!) ?? '';
  }

  return {
    center,
    nodes: [...nodes.values()].map(({ pageId: _pageId, ...n }) => n),
    edges,
    depth: GRAPH_DEPTH,
  };
}

// ---------- Passages (deep research reports) ----------

export interface Passage {
  chunkId: number;
  pageId: number;
  title: string;
  url: string;
  section: string | null;
  content: string;
  distance: number;
}

/**
 * The passages nearest to a vector (vector index), at most `perArticle` from
 * any one article, so the evidence for a question comes from several articles.
 */
export async function nearestPassages(vector: number[], limit: number, perArticle = 2, maxDistance = 0.6): Promise<Passage[]> {
  const v = vectorText(vector);
  // Two steps: the vector index answers a plain ORDER BY distance LIMIT n (about
  // 0.2 s), but not when the same query also joins articles and reads the text
  // (a full scan of every passage, ~20 s). So find the nearest passages first,
  // then read just those rows.
  const [nearest] = await pool.query<RowDataPacket[]>(
    `SELECT c.id, VEC_DISTANCE_COSINE(c.embedding, VEC_FromText(?)) AS distance
     FROM article_chunks c
     ORDER BY VEC_DISTANCE_COSINE(c.embedding, VEC_FromText(?))
     LIMIT ?`,
    [v, v, limit * 5],
  );
  const distanceOf = new Map(nearest.map((r) => [Number(r.id), Number(r.distance)]));
  const [found] = nearest.length
    ? await pool.query<RowDataPacket[]>(
        `SELECT c.id, c.page_id, a.title, a.url, c.section, c.content
         FROM article_chunks c JOIN articles a USING (page_id) WHERE c.id IN (?)`,
        [nearest.map((r) => Number(r.id))],
      )
    : [[] as RowDataPacket[]];
  const rows = found
    .map((r) => ({ ...r, distance: distanceOf.get(Number(r.id)) ?? 1 }))
    .sort((a, b) => a.distance - b.distance) as RowDataPacket[];
  // Articles fetched on demand may be missing from the index's results (see freshPages).
  const fresh = await freshPages(vector, limit, maxDistance);
  if (fresh.length) {
    const [extra] = await pool.query<RowDataPacket[]>(
      `SELECT c.id, c.page_id, a.title, a.url, c.section, c.content, VEC_DISTANCE_COSINE(c.embedding, VEC_FromText(?)) AS distance
       FROM article_chunks c JOIN articles a USING (page_id) WHERE c.page_id IN (?)`,
      [v, fresh],
    );
    const have = new Set(rows.map((r) => Number(r.id)));
    rows.push(...extra.filter((r) => !have.has(Number(r.id))));
    rows.sort((a, b) => Number(a.distance) - Number(b.distance));
  }
  const perPage = new Map<number, number>();
  const out: Passage[] = [];
  for (const r of rows) {
    const distance = Number(r.distance);
    const pageId = Number(r.page_id);
    if (distance > maxDistance || (perPage.get(pageId) ?? 0) >= perArticle) continue;
    perPage.set(pageId, (perPage.get(pageId) ?? 0) + 1);
    out.push({ chunkId: Number(r.id), pageId, title: r.title, url: r.url, section: r.section ?? null, content: r.content, distance });
    if (out.length >= limit) break;
  }
  return out;
}
