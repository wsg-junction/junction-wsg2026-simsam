// The fact-checker: checks the claims in a Wikipedia article's lead against
// independent web sources. Evidence comes from Google Search (through Gemini)
// and web search (context.dev), with Wikipedia, its sister projects and copies
// of it excluded; a separate Gemini call then judges each claim on that
// evidence alone and must cite it. Only article text is sent, never anything
// about the reader. Results are stored in MariaDB (fact_checks, keyed on
// article, claim and revision) and reused until the article has a newer revision.
import { createHash } from 'node:crypto';
import { diffWords } from 'diff';
import type { RowDataPacket } from 'mysql2/promise';
import type { DiffSegment, FactCheckClaim, FactCheckReport, FactCheckSource, FactCheckVerdict } from '@simsam/models';
import { isExcludedSite, isWikipediaCopy, searchWeb, webSearchEnabled, WIKIPEDIA_COPIES } from './context.js';
import { corpusArticles } from './corpus.js';
import { pool } from './db.js';
import { ACTION_API, wikiFetch } from './wikipedia.js';

const apiKey = process.env.GEMINI_API_KEY;
// "gemini-flash-latest" follows Google's current Flash model; pin a version with GEMINI_MODEL.
export const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() || 'gemini-flash-latest';
export const factCheckEnabled = Boolean(apiKey);

/** Claims checked per article, and how many are checked at once. */
const MAX_CLAIMS = 6;
const PARALLEL = 6;

// ---------- Gemini ----------

interface GeminiResult {
  text: string;
  /** Every web page Google Search returned for the answer, by index. */
  chunks: { uri: string; title: string }[];
  /** Which parts of the answer each page supports (indices into chunks). */
  supports: { text: string; chunks: number[] }[];
  searches: string[];
}

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string; thought?: boolean }[] };
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: { web?: { uri?: string; title?: string } }[];
      groundingSupports?: { segment?: { text?: string }; groundingChunkIndices?: number[] }[];
    };
  }[];
}

async function gemini(body: object, signal?: AbortSignal): Promise<GeminiResult> {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1500 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`Gemini responded with ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as GeminiResponse;
    const candidate = data.candidates?.[0];
    const meta = candidate?.groundingMetadata;
    return {
      text: (candidate?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? '').join(''),
      chunks: (meta?.groundingChunks ?? []).map((c) => ({ uri: c.web?.uri ?? '', title: c.web?.title ?? '' })),
      supports: (meta?.groundingSupports ?? [])
        .filter((s) => s.segment?.text && s.groundingChunkIndices?.length)
        .map((s) => ({ text: s.segment!.text!, chunks: s.groundingChunkIndices! })),
      searches: meta?.webSearchQueries ?? [],
    };
  }
}

const parseJson = (text: string): unknown => {
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start === -1 || end < start) throw new Error(`No JSON in: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
};

// ---------- The article ----------

interface ArticleText {
  title: string;
  pageId: number;
  revisionId: number;
  url: string;
  lead: string;
}

/** Wikipedia throttled the article lookup (429) even after waiting. */
export class WikipediaBusyError extends Error {}

const liveCache = new Map<string, { at: number; article: ArticleText | null }>();

/** The article's lead and revision: from MariaDB when stored, otherwise from Wikipedia (cached for 10 minutes). */
async function articleText(title: string, signal?: AbortSignal): Promise<ArticleText | null> {
  const [stored] = await corpusArticles([title]);
  if (stored) return { title: stored.title, pageId: stored.pageId, revisionId: stored.revisionId, url: stored.url, lead: stored.extract };
  const hit = liveCache.get(title);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.article;
  const article = await liveArticleText(title, signal);
  liveCache.set(title, { at: Date.now(), article });
  return article;
}

async function liveArticleText(title: string, signal?: AbortSignal): Promise<ArticleText | null> {
  const params = new URLSearchParams({
    action: 'query',
    prop: 'extracts|revisions|info',
    exintro: '1',
    explaintext: '1',
    rvprop: 'ids',
    inprop: 'url',
    redirects: '1',
    titles: title,
    format: 'json',
    formatversion: '2',
  });
  // A fact-check is slow anyway: wait out Wikipedia's throttling for longer than interactive lookups do.
  const res = await wikiFetch(`${ACTION_API}?${params}`, signal, 5);
  if (res.status === 429 || res.status === 503) throw new WikipediaBusyError(`Wikipedia responded with ${res.status}`);
  if (!res.ok) throw new Error(`Wikipedia responded with ${res.status}`);
  const data = (await res.json()) as {
    query?: { pages?: { pageid?: number; title: string; missing?: boolean; extract?: string; fullurl?: string; revisions?: { revid: number }[] }[] };
  };
  const page = data.query?.pages?.[0];
  if (!page || page.missing || !page.pageid || !page.extract?.trim() || !page.revisions?.[0]) return null;
  return {
    title: page.title,
    pageId: page.pageid,
    revisionId: page.revisions[0].revid,
    url: page.fullurl ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
    lead: page.extract.trim().slice(0, 3500),
  };
}

// ---------- Claims ----------

const EXTRACT_PROMPT = `You pick claims to fact-check from the opening of a Wikipedia article.

Pick up to ${MAX_CLAIMS} specific, checkable factual claims: dates, numbers, names, places, outcomes, firsts and records, causes stated as fact. Prefer the claims a reader would most rely on. Skip definitions, vague descriptions and opinions.

Reply with JSON only:
{"claims": [{"statement": string, "claim": string}]}

- statement: the sentence from the article that makes the claim, copied exactly.
- claim: the claim as one short sentence that stands on its own (names instead of pronouns).`;


const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const VERDICTS: FactCheckVerdict[] = ['supported', 'partly', 'contradicted', 'unverified'];

async function extractClaims(article: ArticleText, signal?: AbortSignal) {
  const { text } = await gemini(
    {
      systemInstruction: { parts: [{ text: EXTRACT_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: `Article: ${article.title}\n\n${article.lead}` }] }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
    },
    signal,
  );
  const parsed = parseJson(text) as { claims?: { statement?: unknown; claim?: unknown }[] };
  const flat = article.lead.replace(/\s+/g, ' ');
  return (Array.isArray(parsed.claims) ? parsed.claims : [])
    .map((c) => ({ statement: clean(c.statement, 600), claim: clean(c.claim, 300) }))
    .filter((c) => c.statement && c.claim)
    // Only sentences the article actually contains: the comparison quotes them as Wikipedia's.
    .filter((c) => flat.includes(c.statement) || flat.includes(c.statement.replace(/\.$/, '')))
    .slice(0, MAX_CLAIMS);
}

// ---------- Evidence ----------
// A claim is judged only on evidence gathered here, from independent sources:
// Google Search through Gemini (only the statements Google attributes to
// non-Wikipedia pages) and web search through context.dev (quoted passages).
// Wikipedia, its sister projects and sites copying it are excluded at both, and
// passages that repeat the Wikipedia sentence word for word are dropped as copies.

interface Evidence {
  title: string;
  url: string;
  site: string;
  text: string;
  via: 'google' | 'web';
}

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Whether a passage repeats eight or more consecutive words of the Wikipedia sentence: a copy, not a check. */
function copiesStatement(passage: string, statement: string) {
  const s = words(statement);
  if (s.length < 8) return false;
  const p = ` ${words(passage).join(' ')} `;
  for (let i = 0; i + 8 <= s.length; i++) {
    if (p.includes(` ${s.slice(i, i + 8).join(' ')} `)) return true;
  }
  return false;
}

const SEARCH_PROMPT = (title: string, claim: string, insist: boolean) =>
  [
    insist
      ? 'Run a Google Search for this claim now and answer only from the results, not from memory.'
      : 'Search Google for independent sources on this claim.',
    'Do not use Wikipedia, Wikidata or other Wikimedia sites, or sites that copy Wikipedia: add -wikipedia to your searches.',
    'Prefer encyclopedias, archives, museums, universities, government and scholarly sources, and quality journalism.',
    '',
    `The claim comes from the Wikipedia article "${title}":`,
    claim,
    '',
    'Report, in a few short sentences, what each source you found says about it, with its dates, figures and names. Say so if sources disagree.',
  ].join('\n');

/** What Google Search finds, kept only where Google attributes it to a page that isn't Wikipedia or a copy of it. */
async function googleEvidence(article: ArticleText, claim: string, signal?: AbortSignal) {
  const search = (insist: boolean) =>
    // Default temperature and plain prose: asked for JSON or a low temperature, the model often skips the search.
    gemini({ contents: [{ role: 'user', parts: [{ text: SEARCH_PROMPT(article.title, claim, insist) }] }], tools: [{ google_search: {} }] }, signal);
  const collect = (r: GeminiResult) => {
    const plainText = (t: string) => t.replace(/\*+|_{2,}|^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
    // Each site gets the statements Google attributes to it, most specific first:
    // a sentence backed by one page says more about that page than a summary
    // backed by five.
    const bySite = new Map<string, { url: string; texts: { text: string; spread: number }[] }>();
    for (const sup of r.supports) {
      for (const i of sup.chunks) {
        const chunk = r.chunks[i];
        if (!chunk?.uri || !chunk.title || isWikipediaCopy(chunk.title) || isExcludedSite(chunk.title)) continue;
        const entry = bySite.get(chunk.title) ?? { url: chunk.uri, texts: [] };
        entry.texts.push({ text: plainText(sup.text), spread: sup.chunks.length });
        bySite.set(chunk.title, entry);
      }
    }
    const evidence: Evidence[] = [];
    for (const [site, entry] of bySite) {
      const texts = [...new Map(entry.texts.map((t) => [t.text, t])).values()].sort((x, y) => x.spread - y.spread);
      // A site supporting only a summary shared with three or more others adds nothing of its own.
      if (texts[0].spread >= 3 && bySite.size > 2) continue;
      evidence.push({ title: site, url: entry.url, site, text: texts.map((t) => t.text.replace(/[.;:]?$/, '.')).join(' ').slice(0, 900), via: 'google' });
    }
    return evidence;
  };
  let result = await search(false);
  let evidence = collect(result);
  if (evidence.length === 0) {
    result = await search(true);
    evidence = collect(result);
  }
  return { evidence: evidence.slice(0, 5), searches: result.searches };
}

/** Passages from web search (context.dev), Wikipedia and its copies excluded. */
async function webEvidence(claim: string, statement: string, signal?: AbortSignal): Promise<Evidence[]> {
  if (!webSearchEnabled) return [];
  const results = await searchWeb(claim, signal, { exclude: WIKIPEDIA_COPIES, results: 4 }).catch(() => []);
  return results
    .filter((r) => !isWikipediaCopy(r.site) && !copiesStatement(r.text, statement))
    .map((r) => ({ title: r.title, url: r.url, site: r.site, text: r.text.slice(0, 1000), via: 'web' as const }));
}

const JUDGE_PROMPT = `You are a careful fact-checker. You judge one claim from a Wikipedia article against numbered evidence from independent web sources.

Use only the evidence below: not your own knowledge, and never Wikipedia. Ignore evidence that just repeats the Wikipedia sentence (a copy of Wikipedia proves nothing).

Reply with JSON only:
{"verdict": "supported" | "partly" | "contradicted" | "unverified", "finding": string, "explanation": string, "evidence": number[]}

- supported: the evidence states the same thing.
- partly: the evidence confirms part of it, or gives different details (a date, a figure, a name).
- contradicted: the evidence says otherwise.
- unverified: no evidence addresses the claim.
- evidence: the numbers of the items the verdict rests on. Empty only when unverified.
- finding: one sentence on what the evidence says about the same thing. Mirror the wording of the claim (not the whole Wikipedia sentence) and change only what the evidence states differently, so a word-by-word comparison shows the differences. If unverified, say what could not be confirmed.
- explanation: one plain sentence on why, naming the sources by site (e.g. "Britannica and the national archive give 1918.").`;

async function checkClaim(article: ArticleText, c: { statement: string; claim: string }, signal?: AbortSignal) {
  const [google, web] = await Promise.all([
    googleEvidence(article, c.claim, signal),
    webEvidence(c.claim, c.statement, signal),
  ]);
  const evidence = [...google.evidence, ...web];
  const searches = [...google.searches.slice(0, 3), ...(webSearchEnabled ? [c.claim] : [])];
  if (evidence.length === 0) {
    return {
      ...c,
      verdict: 'unverified' as FactCheckVerdict,
      finding: 'No independent source addressing this claim was found.',
      explanation: 'Google Search and web search found nothing on it outside Wikipedia and its copies.',
      sources: [],
      searches,
    };
  }

  const { text } = await gemini(
    {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: [
                JUDGE_PROMPT,
                '',
                `Wikipedia article: ${article.title}`,
                `Wikipedia statement: ${c.statement}`,
                `Claim to check: ${c.claim}`,
                '',
                'Evidence:',
                ...evidence.map((e, i) => `[${i + 1}] ${e.site}${e.via === 'web' ? `, "${e.title}"` : ''}: ${e.text}`),
              ].join('\n'),
            },
          ],
        },
      ],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
    },
    signal,
  );
  const parsed = parseJson(text) as { verdict?: unknown; finding?: unknown; explanation?: unknown; evidence?: unknown };
  const cited = [
    ...new Set(
      (Array.isArray(parsed.evidence) ? parsed.evidence : [])
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= evidence.length),
    ),
  ].map((n) => evidence[n - 1]);
  let verdict = VERDICTS.includes(parsed.verdict as FactCheckVerdict) ? (parsed.verdict as FactCheckVerdict) : 'unverified';
  // A verdict that cites no evidence rests on nothing we can show.
  if (cited.length === 0) verdict = 'unverified';
  return {
    ...c,
    verdict,
    finding: clean(parsed.finding, 600) || c.statement,
    explanation: clean(parsed.explanation, 400),
    sources: cited.slice(0, 6).map(
      (e): FactCheckSource => ({ title: e.title, url: e.url, site: e.site, excerpt: e.text.slice(0, 400), via: e.via }),
    ),
    searches,
  };
}

/** The claim (as Wikipedia states it) against what the evidence says, word by word. */
function compare(statement: string, finding: string): DiffSegment[] {
  return diffWords(statement, finding).map((part) => ({
    type: part.added ? 'added' : part.removed ? 'removed' : 'same',
    text: part.value,
  }));
}

const hashOf = (c: { statement: string; claim: string }) =>
  createHash('sha256').update(`${c.statement}\n${c.claim}`.toLowerCase()).digest('hex');

// ---------- Stored reports ----------

interface CheckRow extends RowDataPacket {
  claim: string;
  statement: string;
  verdict: FactCheckVerdict;
  finding: string;
  explanation: string;
  sources: string | FactCheckSource[];
  searches: string | string[];
  model: string;
  checked_at: Date;
}

const json = <T>(v: string | T): T => (typeof v === 'string' ? (JSON.parse(v) as T) : v);

async function storedReport(article: ArticleText): Promise<FactCheckReport | null> {
  const [rows] = await pool.query<CheckRow[]>(
    'SELECT * FROM fact_checks WHERE page_id = ? AND revision_id = ? ORDER BY position',
    [article.pageId, article.revisionId],
  );
  if (rows.length === 0) return null;
  return {
    title: article.title,
    pageId: article.pageId,
    revisionId: article.revisionId,
    url: article.url,
    checkedAt: rows[0].checked_at.toISOString(),
    model: rows[0].model,
    claims: rows.map((r) => ({
      claim: r.claim,
      statement: r.statement,
      verdict: r.verdict,
      finding: r.finding,
      explanation: r.explanation,
      comparison: compare(r.claim, r.finding),
      sources: json<FactCheckSource[]>(r.sources),
      searches: json<string[]>(r.searches),
    })),
  };
}

/** In-flight checks, so two readers of the same article share one run. */
const running = new Map<string, Promise<FactCheckReport | null>>();

/**
 * The article's checked claims: stored ones for its current revision, or a new
 * check (then stored). Null if the article doesn't exist.
 */
export async function factCheck(title: string, signal?: AbortSignal): Promise<FactCheckReport | null> {
  if (!apiKey) throw new Error('Fact-checking is not configured');
  const article = await articleText(title, signal);
  if (!article) return null;
  const stored = await storedReport(article);
  if (stored) return stored;

  const key = `${article.pageId}:${article.revisionId}`;
  let run = running.get(key);
  if (!run) {
    run = (async () => {
      const claims = await extractClaims(article, signal);
      const checked: Awaited<ReturnType<typeof checkClaim>>[] = [];
      const failures: string[] = [];
      for (let i = 0; i < claims.length; i += PARALLEL) {
        const batch = await Promise.allSettled(claims.slice(i, i + PARALLEL).map((c) => checkClaim(article, c, signal)));
        for (const r of batch) {
          if (r.status === 'fulfilled') checked.push(r.value);
          else failures.push(String((r.reason as Error)?.message ?? r.reason).slice(0, 300));
        }
      }
      if (failures.length) console.warn(`Fact-check of ${article.title}: ${failures.length} claims failed: ${failures.join(' | ')}`);
      if (claims.length > 0 && checked.length === 0) throw new Error(`No claim could be checked: ${failures[0]}`);
      const now = new Date();
      for (const [position, c] of checked.entries()) {
        await pool.query(
          `INSERT INTO fact_checks (page_id, claim_hash, revision_id, position, title, claim, statement, verdict,
             finding, explanation, sources, searches, model, checked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE verdict = VALUES(verdict), finding = VALUES(finding),
             explanation = VALUES(explanation), sources = VALUES(sources), searches = VALUES(searches),
             model = VALUES(model), checked_at = VALUES(checked_at)`,
          [
            article.pageId,
            hashOf(c),
            article.revisionId,
            position,
            article.title,
            c.claim,
            c.statement,
            c.verdict,
            c.finding,
            c.explanation,
            JSON.stringify(c.sources),
            JSON.stringify(c.searches),
            GEMINI_MODEL,
            now,
          ],
        );
      }
      const claimsOut: FactCheckClaim[] = checked.map((c) => ({ ...c, comparison: compare(c.claim, c.finding) }));
      return {
        title: article.title,
        pageId: article.pageId,
        revisionId: article.revisionId,
        url: article.url,
        checkedAt: now.toISOString(),
        model: GEMINI_MODEL,
        claims: claimsOut,
      };
    })().finally(() => running.delete(key));
    running.set(key, run);
  }
  return run;
}
