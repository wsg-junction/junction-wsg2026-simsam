// The API fetches source text itself rather than trusting text sent by the
// browser, so the AI endpoint only ever reasons over real Wikipedia articles.

const ACTION_API = 'https://en.wikipedia.org/w/api.php';
// Wikimedia asks API clients to identify themselves with contact details and
// throttles generic agents harder. Set WIKIPEDIA_USER_AGENT (the same variable
// the data scripts use), e.g. "Atlas/1.0 (https://example.com; you@example.com)".
const USER_AGENT = process.env.WIKIPEDIA_USER_AGENT || 'atlas-explorer/0.1 (wikipedia research canvas)';

/** GET with up to two retries when Wikipedia throttles us (429/503), honouring Retry-After. */
async function wikiFetch(url: string, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal });
    if ((res.status !== 429 && res.status !== 503) || attempt >= 2) return res;
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 5) * 1000 : 800 * 2 ** attempt;
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

/** Lead sections for the given titles, aligned with the input (null where a page is missing). */
export async function fetchIntros(titles: string[], signal?: AbortSignal): Promise<(SourceText | null)[]> {
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
