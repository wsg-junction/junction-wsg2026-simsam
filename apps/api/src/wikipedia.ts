// The API fetches source text itself rather than trusting text sent by the
// browser, so the AI endpoint only ever reasons over real Wikipedia articles.
// Articles in the local corpus (MariaDB) come from there; the live API is the
// fallback for anything outside it.
import type { RowDataPacket } from 'mysql2/promise';
import { corpusArticles } from './corpus.js';
import { pool } from './db.js';
import { imagesOf, infoboxOf, tablesOf, type Infobox, type WikiImage, type WikiTable } from './wikitext.js';

export const ACTION_API = 'https://en.wikipedia.org/w/api.php';
// Wikimedia asks API clients to identify themselves with contact details and
// throttles generic agents harder. Set WIKIPEDIA_USER_AGENT (the same variable
// the data scripts use), e.g. "Atlas/1.0 (https://example.com; you@example.com)".
const USER_AGENT = process.env.WIKIPEDIA_USER_AGENT || 'atlas-explorer/0.1 (wikipedia research canvas)';

/**
 * GET with retries when Wikipedia throttles us (429/503), honouring Retry-After.
 * Interactive lookups retry twice; `retries` lets slower features wait longer.
 */
export async function wikiFetch(url: string, signal?: AbortSignal, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal });
    if ((res.status !== 429 && res.status !== 503) || attempt >= retries) return res;
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 10) * 1000 : Math.min(800 * 2 ** attempt, 8000);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
const CACHE_MS = 60 * 60 * 1000;
const MAX_CHARS = 3000;

export interface SourceText {
  title: string;
  text: string;
}

const cache = new Map<string, { at: number; source: SourceText | null }>();

/** Lead sections from the live API, aligned with the input (null where a page is missing). */
async function fetchLiveIntros(titles: string[], signal?: AbortSignal): Promise<(SourceText | null)[]> {
  const now = Date.now();
  const missing = titles.filter((t) => {
    const hit = cache.get(t);
    return !hit || now - hit.at > CACHE_MS;
  });

  if (missing.length > 0) {
    const params = new URLSearchParams({
      action: 'query',
      prop: 'extracts',
      exintro: '1',
      explaintext: '1',
      exlimit: 'max',
      redirects: '1',
      titles: missing.join('|'),
      format: 'json',
      formatversion: '2',
    });
    const res = await wikiFetch(`${ACTION_API}?${params}`, signal);
    if (!res.ok) throw new Error(`Wikipedia responded with ${res.status}`);
    const data = (await res.json()) as {
      query?: {
        normalized?: { from: string; to: string }[];
        redirects?: { from: string; to: string }[];
        pages: { title: string; missing?: boolean; extract?: string }[];
      };
    };
    const renamed = new Map(
      [...(data.query?.normalized ?? []), ...(data.query?.redirects ?? [])].map((r) => [r.from, r.to]),
    );
    const pages = new Map((data.query?.pages ?? []).map((p) => [p.title, p]));
    for (const title of missing) {
      let resolved = title;
      for (let i = 0; i < 3 && renamed.has(resolved); i++) resolved = renamed.get(resolved)!;
      const page = pages.get(resolved);
      const text = page && !page.missing ? page.extract?.trim() : undefined;
      cache.set(title, {
        at: now,
        source: text ? { title: page!.title, text: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}…` : text } : null,
      });
    }
  }

  return titles.map((t) => cache.get(t)?.source ?? null);
}

/** Lead sections for the given titles, aligned with the input: local corpus first, then live Wikipedia. */
export async function fetchIntros(titles: string[], signal?: AbortSignal): Promise<(SourceText | null)[]> {
  const local = await corpusArticles(titles);
  const missing = titles.filter((_, i) => !local[i]);
  const live = missing.length ? await fetchLiveIntros(missing, signal) : [];
  const liveByTitle = new Map(missing.map((t, i) => [t, live[i]]));
  return titles.map((t, i) => {
    const article = local[i];
    if (article) {
      const text = article.extract.length > MAX_CHARS ? `${article.extract.slice(0, MAX_CHARS)}…` : article.extract;
      return { title: article.title, text };
    }
    return liveByTitle.get(t) ?? null;
  });
}

// ---------- Figures ----------

export interface ArticleFigures {
  title: string;
  pageId: number;
  revisionId: number;
  url: string;
  infobox: Infobox | null;
  tables: WikiTable[];
  /** Infobox images and maps first, then the article's own. */
  images: WikiImage[];
}

/** An image file as a thumbnail of about `width` pixels (SVGs come back as PNG). */
export const imageUrl = (file: string, width = 640) =>
  `https://en.wikipedia.org/wiki/Special:FilePath/${encodeURIComponent(file.replace(/ /g, '_'))}?width=${width}`;

/**
 * An article's images (with captions), infobox and tables, parsed from its
 * wikitext: the stored current revision in MariaDB, or the live article.
 */
export async function fetchArticleFigures(title: string, signal?: AbortSignal): Promise<ArticleFigures | null> {
  const [rows] = await pool
    .query<RowDataPacket[]>(
      `SELECT a.page_id, a.title, a.url, c.revision_id, c.wikitext
       FROM articles a JOIN article_content c USING (page_id) WHERE a.title = ?`,
      [title],
    )
    .catch(() => [[] as RowDataPacket[]]);
  let page: { title: string; pageId: number; revisionId: number; url: string; wikitext: string } | null = rows[0]
    ? { title: rows[0].title, pageId: Number(rows[0].page_id), revisionId: Number(rows[0].revision_id), url: rows[0].url, wikitext: rows[0].wikitext }
    : null;
  if (!page) {
    const params = new URLSearchParams({
      action: 'query',
      prop: 'revisions|info',
      rvprop: 'ids|content',
      rvslots: 'main',
      inprop: 'url',
      redirects: '1',
      titles: title,
      format: 'json',
      formatversion: '2',
    });
    const res = await wikiFetch(`${ACTION_API}?${params}`, signal);
    if (!res.ok) throw new Error(`Wikipedia responded with ${res.status}`);
    const data = (await res.json()) as {
      query?: { pages?: { pageid?: number; title: string; missing?: boolean; fullurl?: string; revisions?: { revid: number; slots?: { main?: { content?: string } } }[] }[] };
    };
    const p = data.query?.pages?.[0];
    const rev = p?.revisions?.[0];
    const wikitext = rev?.slots?.main?.content;
    if (!p || p.missing || !p.pageid || !rev || !wikitext) return null;
    page = { title: p.title, pageId: p.pageid, revisionId: rev.revid, url: p.fullurl ?? '', wikitext };
  }
  const infobox = infoboxOf(page.wikitext);
  return {
    title: page.title,
    pageId: page.pageId,
    revisionId: page.revisionId,
    url: page.url,
    infobox,
    tables: tablesOf(page.wikitext),
    images: imagesOf(page.wikitext, infobox?.images),
  };
}

/** Titles from Wikipedia's own (live) search, for topics the collection doesn't cover. */
export async function searchLiveTitles(query: string, limit: number, signal?: AbortSignal): Promise<string[]> {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srnamespace: '0',
    srlimit: String(limit),
    format: 'json',
    formatversion: '2',
  });
  const res = await wikiFetch(`${ACTION_API}?${params}`, signal);
  if (!res.ok) return [];
  const data = (await res.json()) as { query?: { search?: { title: string }[] } };
  return (data.query?.search ?? []).map((r) => r.title).filter((t) => !/\(disambiguation\)$/i.test(t));
}
