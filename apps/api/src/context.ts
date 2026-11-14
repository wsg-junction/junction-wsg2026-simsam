import type { WebSource } from '@simsam/models';

// Web search through context.dev (https://docs.context.dev), for context that
// Wikipedia's article intros don't hold: impacts, economic data, analysis, news.
const apiKey = process.env.CONTEXT_DEV_API_KEY;

export const webSearchEnabled = Boolean(apiKey);

/** Results kept per search, and how much of each page's matching text the AI reads. */
const RESULTS = 4;
const MAX_CHARS = 1500;

export const EXCLUDED_DOMAINS = [
  'wikipedia.org',
  'facebook.com',
  'instagram.com',
  'x.com',
  'twitter.com',
  'tiktok.com',
  'pinterest.com',
  'reddit.com',
  'quora.com',
  'youtube.com',
  'linkedin.com',
];

/**
 * Wikipedia, its sister projects, and sites that republish its articles. A
 * fact-check against any of these is Wikipedia checking itself.
 */
export const WIKIPEDIA_COPIES = [
  'wikipedia.org',
  'wikimedia.org',
  'wikidata.org',
  'wikisource.org',
  'wikiquote.org',
  'wikibooks.org',
  'wikiversity.org',
  'wikivoyage.org',
  'wiktionary.org',
  'wikiwand.com',
  'wikimili.com',
  'wikizero.com',
  'wiki2.org',
  'wikiless.org',
  'wikitia.com',
  'dbpedia.org',
  'alchetron.com',
  'everybodywiki.com',
  'infogalactic.com',
  'justapedia.org',
  'newworldencyclopedia.org',
  'kiddle.co',
  'academic-accelerator.com',
  'en-academic.com',
  'thefreedictionary.com',
  'sensagent.com',
  'fandom.com',
  'wikiaccess.org',
];

/** Whether a site is one web search leaves out anyway (social and user-generated sites). */
export const isExcludedSite = (host: string) => {
  const h = host.toLowerCase().replace(/^www\./, '');
  return EXCLUDED_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
};

/** Whether a host name (or a site title such as "en.wikipedia.org") is Wikipedia or a copy of it. */
export const isWikipediaCopy = (host: string) => {
  const h = host.toLowerCase().replace(/^www\./, '');
  return WIKIPEDIA_COPIES.some((d) => h === d || h.endsWith(`.${d}`)) || /wiki(pedia|media|data|wand|mili)/.test(h);
};

interface SearchResult {
  url: string;
  title: string;
  description: string;
  relevance: 'high' | 'medium' | 'low';
  highlights?: { highlights: string[] | null; code: string };
}

const siteOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** Highlights come as markdown with "[Page > Section]" breadcrumbs: keep just the prose. */
const clean = (text: string) =>
  text
    .replace(/\[[^\]\n]{0,160} > [^\]\n]{0,160}\]\s*/g, '')
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
    .replace(/\*\*|__|\\_|(^|\s)[>#]+(?=\s)/g, '$1')
    .replace(/\s+([:;,.])/g, '$1');

const clip = (text: string) => {
  const flat = clean(text).replace(/\s+/g, ' ').trim();
  return flat.length > MAX_CHARS ? `${flat.slice(0, MAX_CHARS - 1).trimEnd()}…` : flat;
};

/** Web pages matching the query, each with the passages that match it. Empty if web search isn't configured. */
export async function searchWeb(
  query: string,
  signal?: AbortSignal,
  options: { exclude?: string[]; results?: number } = {},
): Promise<WebSource[]> {
  const results = options.results ?? RESULTS;
  if (!apiKey) return [];
  const res = await fetch('https://api.context.dev/v1/web/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: query.slice(0, 500),
      // Over-fetch a little: low-relevance and empty results are dropped below.
      numResults: results + 2,
      languages: ['en'],
      // Wikipedia is already covered by the page's own sources; social and
      // user-generated sites make poor sources for a research answer.
      excludeDomains: [...new Set([...EXCLUDED_DOMAINS, ...(options.exclude ?? [])])],
      highlightsOptions: { enabled: true, maxCharacters: MAX_CHARS },
      timeoutOpts: { milliseconds: 15_000, behavior: 'return-partial' },
      tags: ['atlas'],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`Web search failed with ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { results?: SearchResult[] };
  return (data.results ?? [])
    .filter((r) => r.relevance !== 'low')
    .map((r) => {
      // Each passage opens with a "[Page title]" breadcrumb.
      const passages = (r.highlights?.code === 'SUCCESS' ? (r.highlights.highlights ?? []) : []).map((p) =>
        p.replace(/^\s*\[[^\n]{0,250}\]\s+/, ''),
      );
      return {
        title: r.title?.replace(/^\s*\[(PDF|DOC|PPT)\]\s*/i, '').trim() || siteOf(r.url),
        url: r.url,
        site: siteOf(r.url),
        text: clip(passages.length ? passages.join(' … ') : (r.description ?? '')),
      };
    })
    .filter((r) => r.text.length >= 80)
    .slice(0, results);
}
