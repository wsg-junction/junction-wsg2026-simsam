/**
 * Articles the collection doesn't hold yet are fetched from Wikipedia the moment
 * something needs them, embedded and stored in MariaDB exactly like the bulk
 * ingest does it (store.ts), so the reader never notices the gap: the next
 * search, topic map, history or fact-check finds them in the database.
 *
 * - One fetch per article at a time: concurrent requests for the same title
 *   share the work, and at most MAX_PARALLEL articles are fetched together.
 * - Only real articles are kept (main namespace, not disambiguation pages or stubs).
 * - Needs the embedding model (NVIDIA_API_KEY); without it nothing is acquired
 *   and callers keep using the live Wikipedia API as before.
 */
import type { RowDataPacket } from 'mysql2/promise';
import { pool } from './db.js';
import { embedSkippingRejected, embeddingsEnabled } from './embeddings.js';
import { chunksOf, embeddingInput, storeArticle, writeArticleChunks, type ArticleFile } from './store.js';
import { ACTION_API, wikiFetch } from './wikipedia.js';

export interface Acquired {
  title: string;
  pageId: number;
}

const MAX_PARALLEL = 3;
/** Plain text shorter than this is a stub or a redirect-like page: not worth keeping. */
const MIN_CHARS = 300;
/** How long a title that turned out to be unusable isn't tried again. */
const NEGATIVE_MS = 10 * 60 * 1000;
const EMBED_BATCH = 48;

export const acquisitionEnabled = embeddingsEnabled;

const keyOf = (title: string) => title.trim().replace(/_/g, ' ').toLowerCase();
const inflight = new Map<string, Promise<Acquired | null>>();
const unusable = new Map<string, number>();
/** What a requested title (a redirect, another capitalization) resolved to. */
const resolved = new Map<string, string>();

let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((resume) => waiting.push(resume));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

interface LivePage {
  pageid?: number;
  ns?: number;
  title: string;
  missing?: boolean;
  invalid?: boolean;
  fullurl?: string;
  extract?: string;
  categories?: { title: string }[];
  pageprops?: { wikibase_item?: string; disambiguation?: string };
  revisions?: {
    revid: number;
    parentid?: number;
    user?: string;
    comment?: string;
    timestamp: string;
    slots?: { main?: { content?: string } };
  }[];
}

/** The article as the collection stores it: plain text, wikitext and the current revision. */
async function fetchLive(title: string, signal: AbortSignal): Promise<ArticleFile | null> {
  const params = new URLSearchParams({
    action: 'query',
    prop: 'info|extracts|revisions|categories|pageprops',
    inprop: 'url',
    explaintext: '1',
    exlimit: '1',
    rvprop: 'ids|timestamp|user|comment|content',
    rvslots: 'main',
    cllimit: 'max',
    ppprop: 'wikibase_item|disambiguation',
    redirects: '1',
    titles: title,
    format: 'json',
    formatversion: '2',
  });
  const res = await wikiFetch(`${ACTION_API}?${params}`, signal);
  if (!res.ok) throw new Error(`Wikipedia responded with ${res.status}`);
  const data = (await res.json()) as { query?: { pages?: LivePage[] } };
  const page = data.query?.pages?.[0];
  const rev = page?.revisions?.[0];
  const wikitext = rev?.slots?.main?.content;
  const text = page?.extract?.trim();
  if (!page || page.missing || page.invalid || !page.pageid || page.ns !== 0 || !rev || !wikitext || !text) return null;
  if (page.pageprops?.disambiguation !== undefined || text.length < MIN_CHARS) return null;
  return {
    pageid: page.pageid,
    title: page.title,
    url: page.fullurl ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
    wikidataId: page.pageprops?.wikibase_item,
    topics: [],
    categories: (page.categories ?? []).map((c) => c.title),
    discoveredVia: 'on-demand',
    fetchedAt: new Date().toISOString(),
    revisionId: rev.revid,
    revisionTimestamp: rev.timestamp,
    text,
    wikitext,
    history: [rev],
  };
}

/** The stored article with this title, if any (the database's collation ignores case). */
async function stored(title: string): Promise<Acquired | null> {
  const [rows] = await pool
    .query<RowDataPacket[]>('SELECT page_id, title FROM articles WHERE title = ? LIMIT 1', [title.trim().replace(/_/g, ' ')])
    .catch(() => [[] as RowDataPacket[]]);
  return rows[0] ? { title: String(rows[0].title), pageId: Number(rows[0].page_id) } : null;
}

async function acquire(title: string): Promise<Acquired | null> {
  const known = await stored(title);
  if (known) return known;
  const signal = AbortSignal.timeout(90_000);
  const article = await fetchLive(title, signal);
  if (!article) return null;
  // The title may have been a redirect to something already stored.
  const [existing] = await pool.query<RowDataPacket[]>('SELECT 1 FROM articles WHERE page_id = ?', [article.pageid]);
  if (existing.length === 0) {
    await storeArticle(article);
    const chunks = chunksOf(article);
    const vectors: (number[] | null)[] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const slice = chunks.slice(i, i + EMBED_BATCH);
      vectors.push(...(await embedSkippingRejected(slice.map((c) => embeddingInput(article.title, c)), 'passage', signal)));
    }
    // Passages the embedding API's content screening rejected are left out, as in the bulk ingest.
    const items = chunks.flatMap((chunk, i) => (vectors[i] ? [{ chunk, vector: vectors[i] as number[] }] : []));
    if (items.length) await writeArticleChunks(article, items);
  }
  return { title: article.title, pageId: article.pageid };
}

/**
 * Make sure this article is in the database, fetching, embedding and storing it
 * if it isn't. Resolves to the stored article (under its real title), or null
 * when it can't be had: not a Wikipedia article, a disambiguation page, no
 * embedding model, or Wikipedia not answering. Never throws.
 */
export function acquireArticle(title: string): Promise<Acquired | null> {
  const key = keyOf(title);
  if (!key || !acquisitionEnabled) return Promise.resolve(null);
  const shared = inflight.get(key);
  if (shared) return shared;
  const failedAt = unusable.get(key);
  if (failedAt && Date.now() - failedAt < NEGATIVE_MS) return Promise.resolve(null);

  const work = slot(() => acquire(title))
    .then((result) => {
      if (result) resolved.set(key, result.title);
      else unusable.set(key, Date.now());
      return result;
    })
    .catch((err) => {
      console.warn(`Fetching "${title}" from Wikipedia failed: ${(err as Error).message}`);
      return null;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, work);
  return work;
}

/**
 * Acquire every missing title, waiting at most `waitMs` for them (the work
 * carries on in the background after that). Returns the titles aligned with the
 * input, replaced by the stored article's real title where one resolved
 * (a redirect, another capitalization).
 */
export async function acquireMissing(titles: string[], waitMs = 12_000): Promise<string[]> {
  if (!acquisitionEnabled || titles.length === 0) return titles;
  const work = titles.map((t) => acquireArticle(t));
  await Promise.race([Promise.allSettled(work), new Promise((done) => setTimeout(done, waitMs))]);
  return titles.map((t) => resolved.get(keyOf(t)) ?? t);
}

/** Start fetching titles likely to be needed next (search results), without waiting. */
export function prefetchArticles(titles: string[]) {
  for (const title of titles) void acquireArticle(title);
}
