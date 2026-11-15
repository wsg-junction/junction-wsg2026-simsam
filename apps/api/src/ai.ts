import OpenAI from 'openai';
import type { ChatCompletionCreateParams, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type {
  AnswerEvent,
  Brief,
  BriefEvent,
  BriefPoint,
  PriorTurn,
  RouteResponse,
  SourcePlan,
  WebSource,
} from '@simsam/models';
import { webSearchEnabled } from './context.js';
import { fetchIntros } from './wikipedia.js';

// NVIDIA's hosted models speak the OpenAI chat completions API. NVIDIA_BASE_URL
// points the chat model at another OpenAI-compatible server instead, e.g.
// Nemotron served with vLLM on a Verda GPU container
// ("https://containers.datacrunch.io/<name>/v1"), authenticated with
// VERDA_INFERENCE_KEY and named by NVIDIA_MODEL. Unset, the NVIDIA API catalog
// is used (NVIDIA_API_KEY).
//
// With both configured, Verda is tried first and the catalog is the fallback:
// when the Verda server can't be reached, times out, errors (5xx) or refuses the
// key or quota, the same request is sent to the catalog, and Verda is skipped
// for a minute so a down server doesn't slow every request.
// Embeddings stay on the catalog either way (see embeddings.ts); the catalog key
// is never sent to the other server.
const CATALOG_URL = 'https://integrate.api.nvidia.com/v1';
const CATALOG_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';
const customURL = process.env.NVIDIA_BASE_URL?.trim();
const selfHosted = Boolean(customURL);
const catalogKey = process.env.NVIDIA_API_KEY?.trim();
const MODEL = process.env.NVIDIA_MODEL?.trim() || CATALOG_MODEL;

// The Verda server may not check keys; the SDK still needs a string. Its requests
// fail fast (the fallback takes over); the catalog gets the SDK's patience.
const primary = selfHosted
  ? new OpenAI({ apiKey: process.env.VERDA_INFERENCE_KEY?.trim() || 'not-needed', baseURL: customURL, timeout: 120_000, maxRetries: 1 })
  : catalogKey
    ? new OpenAI({ apiKey: catalogKey, baseURL: CATALOG_URL })
    : null;
const fallback = selfHosted && catalogKey ? new OpenAI({ apiKey: catalogKey, baseURL: CATALOG_URL }) : null;

/** Whether an error says "this server is unavailable" (try the other) rather than "this request is wrong". */
function serverUnavailable(err: unknown) {
  const status = (err as { status?: number }).status;
  return status === undefined || status >= 500 || [401, 403, 404, 408, 429].includes(status);
}

let primarySkippedUntil = 0;
type Create = OpenAI['chat']['completions']['create'];
const createWithFallback = (async (params: ChatCompletionCreateParams, options?: { signal?: AbortSignal }) => {
  if (primary && !(fallback && Date.now() < primarySkippedUntil)) {
    try {
      return await primary.chat.completions.create(params as never, options);
    } catch (err) {
      if (!fallback || options?.signal?.aborted || !serverUnavailable(err)) throw err;
      primarySkippedUntil = Date.now() + 60_000;
      console.warn(`AI server ${aiEndpoint} failed (${(err as Error).message.slice(0, 120)}); using the NVIDIA API catalog for a minute.`);
    }
  }
  return fallback!.chat.completions.create({ ...params, model: CATALOG_MODEL } as never, options);
}) as unknown as Create;

const client = primary ? { chat: { completions: { create: createWithFallback } } } : null;

export const aiEnabled = client !== null;
/** For the logs: where the chat model runs. */
export const aiEndpoint = selfHosted
  ? `${new URL(customURL!).host}${fallback ? ' (fallback: NVIDIA API catalog)' : ''}`
  : 'NVIDIA API catalog';

const ANSWER_SYSTEM = `You are Atlas, a research assistant that answers questions from numbered Wikipedia excerpts.

Rules:
- Use only the information in the excerpts. If they don't answer the question, say briefly what they do cover and what is missing.
- After every sentence that states a fact, cite the excerpt(s) it comes from with their numbers in square brackets, like [1] or [2][3].
- Write 2 to 4 short paragraphs of plain prose. No markdown, no headings, no bullet points, no bold.
- Answer the question directly in the first sentence. Prefer concrete names, dates and causes.
- Don't refer to "the excerpts" or "the sources"; just answer and cite.`;

const REWRITE_SYSTEM = `You write English Wikipedia search queries. You never answer questions.
Given the earlier questions in a conversation and a follow-up question, write the search query that would find the Wikipedia article answering the follow-up on its own. Resolve pronouns and references ("he", "that war", "after that") to the names they mean.
Reply with the query only: 2 to 8 words naming the topic, no quotes, no full sentences, no punctuation at the end.`;

function historyMessages(history: PriorTurn[]): ChatCompletionMessageParam[] {
  return history.slice(-4).flatMap((turn) => [
    { role: 'user' as const, content: turn.question },
    { role: 'assistant' as const, content: turn.answer.slice(0, 1200) },
  ]);
}

/** The articles' lead sections, numbered [1], [2], ... in the order of `titles`. */
async function numberedExcerpts(titles: string[], signal?: AbortSignal) {
  const sources = await fetchIntros(titles, signal);
  return sources
    .map((source, i) => (source ? `[${i + 1}] ${source.title}\n${source.text}` : null))
    .filter(Boolean)
    .join('\n\n');
}

/** Thinking-model options NVIDIA accepts on top of the OpenAI parameters. */
type NvidiaParams<T> = T & { chat_template_kwargs?: { enable_thinking: boolean } };

/** Rewrite a follow-up ("what happened to him later?") into a search query that stands on its own. */
export async function rewriteQuery(question: string, history: PriorTurn[], signal?: AbortSignal) {
  if (!client) throw new Error('AI is not configured');
  const params: NvidiaParams<ChatCompletionCreateParams> = {
    model: MODEL,
    // Earlier answers stay out of this prompt: shown them, the model tends to answer instead of searching.
    messages: [
      { role: 'system', content: REWRITE_SYSTEM },
      {
        role: 'user',
        content: [
          'Earlier questions:',
          ...history.slice(-4).map((t) => `- ${t.question}`),
          '',
          `Follow-up question: ${question}`,
          '',
          'Search query:',
        ].join('\n'),
      },
    ],
    temperature: 0.1,
    max_tokens: 40,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
  const completion = await client.chat.completions.create(params as ChatCompletionCreateParams & { stream: false }, {
    signal,
  });
  const query = completion.choices[0]?.message?.content?.trim().replace(/^["']|["'.?]$/g, '') ?? '';
  return query.split('\n')[0].slice(0, 200);
}

const PLAN_SYSTEM = `You are the research planner of Atlas, a Wikipedia research canvas. You never answer questions: you decide which sources to gather for the latest question by calling tools. The page itself is built from Wikipedia only; web results go to a separate context panel beside it.

- Always call search_wikipedia, with an English Wikipedia search query of 2 to 8 words naming the topic of the latest question. Resolve pronouns and references ("he", "that war", "after that") from the earlier questions. For a follow-up, name the specific aspect it asks about together with the earlier topic (e.g. "economic history of World War II", not just "World War II"), so it finds articles the earlier pages didn't already show.
- Also call search_web, to fill the context panel, when the question needs more than the intro of an encyclopedia article: specific impacts or consequences in one field (finance, economy, health, culture and so on), figures and statistics, analysis or comparisons, or anything recent. Write a specific web query that names the topic, e.g. "World War II impact on banking and financial markets".
- Don't call search_web for overviews, definitions, or who, what, where or when questions: "What happened in World War II?", "Who was Churchill?" and "When did it end?" need Wikipedia only.`;

const SEARCH_WIKIPEDIA_TOOL = {
  type: 'function' as const,
  function: {
    name: 'search_wikipedia',
    description:
      'Find English Wikipedia articles about a person, place, event, idea or field. Their intros become the main sources of the answer.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A Wikipedia search query of 2 to 8 words' } },
      required: ['query'],
    },
  },
};

const SEARCH_WEB_TOOL = {
  type: 'function' as const,
  function: {
    name: 'search_web',
    description:
      'Search the web for the context panel, beside the Wikipedia page: impacts and consequences in a specific field, economic or financial effects, statistics, analysis, recent developments.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'A specific web search query naming the topic' } },
      required: ['query'],
    },
  },
};

const cleanQuery = (q: unknown) =>
  typeof q === 'string' ? q.trim().replace(/^["']|["'.?]$/g, '').split('\n')[0].slice(0, 200) || null : null;

/**
 * Let the model pick its sources with tool calls: a Wikipedia search, plus a web
 * search when the question needs more (offered only when web search is configured).
 */
export async function planSources(question: string, history: PriorTurn[], signal?: AbortSignal): Promise<SourcePlan> {
  if (!client) throw new Error('AI is not configured');
  const params: NvidiaParams<ChatCompletionCreateParams> = {
    model: MODEL,
    // As in the rewrite, earlier answers stay out: shown them, the model starts answering.
    messages: [
      { role: 'system', content: PLAN_SYSTEM },
      {
        role: 'user',
        content: [
          ...(history.length ? ['Earlier questions:', ...history.slice(-4).map((t) => `- ${t.question}`), ''] : []),
          `Question: ${question}`,
        ].join('\n'),
      },
    ],
    tools: webSearchEnabled ? [SEARCH_WIKIPEDIA_TOOL, SEARCH_WEB_TOOL] : [SEARCH_WIKIPEDIA_TOOL],
    tool_choice: 'auto',
    temperature: 0.1,
    max_tokens: 300,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
  const completion = await client.chat.completions.create(params as ChatCompletionCreateParams & { stream: false }, {
    signal,
  });
  const plan: SourcePlan = { wikipediaQuery: null, webQuery: null };
  for (const call of completion.choices[0]?.message?.tool_calls ?? []) {
    if (call.type !== 'function') continue;
    let args: { query?: unknown } = {};
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      continue;
    }
    if (call.function.name === 'search_wikipedia') plan.wikipediaQuery ??= cleanQuery(args.query);
    if (call.function.name === 'search_web' && webSearchEnabled) plan.webQuery ??= cleanQuery(args.query);
  }
  return plan;
}

/**
 * Answer a question from the given Wikipedia articles, streaming events as they
 * arrive. Source numbers follow the order of `titles`.
 */
export async function* streamAnswer(
  question: string,
  titles: string[],
  history: PriorTurn[],
  signal: AbortSignal,
): AsyncGenerator<AnswerEvent> {
  if (!client) throw new Error('AI is not configured');

  const excerpts = await numberedExcerpts(titles, signal);
  if (!excerpts) {
    yield { type: 'error', message: 'None of the sources could be read from Wikipedia.' };
    return;
  }

  const params: NvidiaParams<ChatCompletionCreateParams> = {
    model: MODEL,
    messages: [
      { role: 'system', content: ANSWER_SYSTEM },
      ...historyMessages(history),
      { role: 'user', content: `Wikipedia excerpts:\n\n${excerpts}\n\nQuestion: ${question}` },
    ],
    temperature: 0.6,
    top_p: 0.95,
    max_tokens: 4096,
    stream: true,
    chat_template_kwargs: { enable_thinking: true },
  };
  const stream = await client.chat.completions.create(params as ChatCompletionCreateParams & { stream: true }, {
    signal,
  });

  let announcedThinking = false;
  for await (const chunk of stream) {
    // vLLM names the reasoning field "reasoning_content" (older) or "reasoning" (newer).
    const delta = chunk.choices[0]?.delta as { content?: string | null; reasoning_content?: string; reasoning?: string } | undefined;
    if ((delta?.reasoning_content || delta?.reasoning) && !announcedThinking) {
      announcedThinking = true;
      yield { type: 'thinking' };
    }
    if (delta?.content) yield { type: 'text', text: delta.content };
  }
  yield { type: 'done' };
}

// ---------- Compact briefs ----------

const BRIEF_SYSTEM = `You turn numbered Wikipedia excerpts into a compact, visual brief that answers a question. Reply with JSON only, no prose around it, matching:

{
  "layout": "timeline" | "points",
  "headline": string,
  "events": [{ "year": number, "when": string, "title": string, "detail": string, "sources": number[] }],
  "points": [{ "title": string, "detail": string, "sources": number[] }]
}

Rules:
- layout is "timeline" when the question is about history, a sequence, or how something developed over time AND the excerpts contain at least 3 dated events. Otherwise "points".
- headline: one sentence of at most 25 words that answers the question directly, ending with citations like [1] or [1][3].
- timeline: 4 to 8 events in chronological order; fill "events" and leave "points" empty. year is a number (negative for BCE). when is the date as it should read, e.g. "6 December 1917" or "1809". title: at most 8 words. detail: one sentence, at most 25 words.
- points: 3 to 6 points; fill "points" and leave "events" empty. title: at most 6 words. detail: one sentence, at most 25 words.
- sources: a JSON array of the excerpt numbers that support each item, e.g. [1, 3].
- Use only facts from the excerpts. Plain text, no markdown, no citation marks inside title or detail.`;

const clipWords = (text: string, max: number) => {
  const parts = text.replace(/\s+/g, ' ').trim().split(' ');
  return parts.length > max ? `${parts.slice(0, max).join(' ')}…` : parts.join(' ');
};

/** Check and trim the model's JSON so the client can trust its shape. */
function sanitizeBrief(raw: unknown, sourceCount: number): Brief {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const refs = (v: unknown) => [
    ...new Set(Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= sourceCount) : []),
  ];
  const noCites = (t: string) => t.replace(/\s*\[\d+\]/g, '');
  const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

  const events: BriefEvent[] = list(obj.events)
    .map((e) => ({
      year: Number(e.year),
      when: str(e.when) || String(e.year),
      title: clipWords(noCites(str(e.title)), 10),
      detail: clipWords(noCites(str(e.detail)), 32),
      sources: refs(e.sources),
    }))
    .filter((e) => Number.isFinite(e.year) && e.title)
    .sort((a, b) => a.year - b.year)
    .slice(0, 8);

  const points: BriefPoint[] = list(obj.points)
    .map((p) => ({
      title: clipWords(noCites(str(p.title)), 8),
      detail: clipWords(noCites(str(p.detail)), 32),
      sources: refs(p.sources),
    }))
    .filter((p) => p.title)
    .slice(0, 6);

  const layout = obj.layout === 'timeline' && events.length >= 3 ? 'timeline' : 'points';
  // A "timeline" with only one or two events reads better as dated key points.
  if (layout === 'points' && points.length === 0) {
    points.push(...events.map((e) => ({ title: `${e.when}: ${e.title}`, detail: e.detail, sources: e.sources })));
  }
  const headline = str(obj.headline);
  if (!headline || (layout === 'points' && points.length === 0)) throw new Error('Brief was incomplete');
  return { layout, headline, events: layout === 'timeline' ? events : [], points: layout === 'points' ? points : [] };
}

/** A compact brief for a question: a headline plus a sourced timeline or key points. */
export async function createBrief(question: string, titles: string[], history: PriorTurn[], signal?: AbortSignal) {
  const excerpts = await numberedExcerpts(titles, signal);
  if (!excerpts) throw new Error('No sources could be read');
  const user = [
    ...(history.length ? ['Earlier questions:', ...history.slice(-4).map((t) => `- ${t.question}`), ''] : []),
    'Wikipedia excerpts:',
    '',
    excerpts,
    '',
    `Question: ${question}`,
    '',
    'JSON:',
  ].join('\n');
  return completeBrief(BRIEF_SYSTEM, user, titles.length, signal);
}

/**
 * Ask the model for a brief (JSON, see BRIEF_SYSTEM) and check its shape.
 * `sourceCount` bounds the source numbers the brief may cite.
 */
export async function completeBrief(system: string, user: string, sourceCount: number, signal?: AbortSignal) {
  if (!client) throw new Error('AI is not configured');
  const params: NvidiaParams<ChatCompletionCreateParams> = {
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
    max_tokens: 2048,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
  const completion = await client.chat.completions.create(params as ChatCompletionCreateParams & { stream: false }, {
    signal,
  });
  const content = completion.choices[0]?.message?.content ?? '';
  const json = content
    .slice(content.indexOf('{'), content.lastIndexOf('}') + 1)
    // The model sometimes writes sources citation-style, "[1][3]", instead of a JSON array.
    .replace(/("sources"\s*:\s*)((?:\[[\d\s,]*\]\s*)+)/g, (_, key: string, arrays: string) => {
      const nums = arrays.match(/\d+/g) ?? [];
      return `${key}[${nums.join(', ')}]`;
    });
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`Brief wasn't valid JSON: ${json.slice(0, 1500)}`);
  }
  return sanitizeBrief(parsed, sourceCount);
}

// ---------- Context panel (web) ----------

const CONTEXT_SYSTEM = `You write the context panel of Atlas, a Wikipedia research canvas. Beside a Wikipedia page, it adds what web sources say about one angle of the topic.

Rules:
- Use only the numbered web excerpts. Cite every factual sentence with its excerpt number(s) in square brackets, like [1] or [2][3].
- Write 2 or 3 sentences, at most 80 words, of plain prose. No markdown.
- Lead with what the excerpts add on the question's angle (figures, consequences, analysis). If they don't address it, say so in one sentence.
- Leave out claims that read like opinion, marketing or speculation.`;

/** A short, cited summary of web passages for the context panel. */
export async function summarizeContext(question: string, topic: string, web: WebSource[], signal?: AbortSignal) {
  if (!client) throw new Error('AI is not configured');
  const excerpts = web.map((w, i) => `[${i + 1}] ${w.title} (${w.site})\n${w.text}`).join('\n\n');
  const params: NvidiaParams<ChatCompletionCreateParams> = {
    model: MODEL,
    messages: [
      { role: 'system', content: CONTEXT_SYSTEM },
      { role: 'user', content: `Topic of the page: ${topic}\nQuestion: ${question}\n\nWeb excerpts:\n\n${excerpts}` },
    ],
    temperature: 0.3,
    max_tokens: 400,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
  const completion = await client.chat.completions.create(params as ChatCompletionCreateParams & { stream: false }, {
    signal,
  });
  const text = completion.choices[0]?.message?.content?.trim() ?? '';
  // Drop citations to excerpts that don't exist.
  return text.replace(/\[(\d+)\]/g, (m, n: string) => (Number(n) >= 1 && Number(n) <= web.length ? m : '')) || null;
}

// ---------- History panel ----------

const TIMELINE_SYSTEM = `You explain how a Wikipedia article changed, for a history panel beside it. You get its substantial edits, numbered, with the sections they touched and samples of the text added and removed. Reply with JSON only, no prose around it, matching:

{
  "overview": string,
  "changes": [{ "n": number, "title": string, "summary": string }]
}

Rules:
- overview: 2 to 4 sentences, at most 90 words, on the most impactful changes: what content was added, removed or rewritten, and how the article's coverage shifted. Cite edits like [3] or [2][5]. Plain text.
- changes: one entry per edit, same n. title: at most 7 words naming what changed (e.g. "Added section on postwar reparations", "Lead rewritten around independence"). summary: one sentence, at most 28 words, on what the edit changed in content, using the samples. No citation marks in title or summary.
- Describe content, not mechanics: never "bytes", never "the editor made changes". Use only the data given.`;

export interface TimelineInput {
  n: number;
  at: string;
  editor: string | null;
  comment: string | null;
  sections: { section: string; added: number; removed: number }[];
  sectionsAdded: string[];
  sectionsRemoved: string[];
  addedSample: string;
  removedSample: string;
}

/** The history panel's overview and a title and summary per change. */
export async function describeTimeline(title: string, from: string, to: string, changes: TimelineInput[], signal?: AbortSignal) {
  if (!client) throw new Error('AI is not configured');
  const lines = [`Article: ${title}`, `Period: ${from.slice(0, 10)} to ${to.slice(0, 10)}`, '', 'Substantial edits:'];
  for (const c of changes) {
    lines.push(
      `[${c.n}] ${c.at.slice(0, 10)} by ${c.editor ?? 'unknown'}${c.comment ? `, summary: "${c.comment.slice(0, 160)}"` : ''}`,
      `    Sections: ${c.sections.slice(0, 4).map((s) => `${s.section} (+${s.added}/−${s.removed} words)`).join(', ')}`,
    );
    if (c.sectionsAdded.length) lines.push(`    New sections: ${c.sectionsAdded.join(', ')}`);
    if (c.sectionsRemoved.length) lines.push(`    Removed sections: ${c.sectionsRemoved.join(', ')}`);
    if (c.addedSample) lines.push(`    Added text: ${c.addedSample}`);
    if (c.removedSample) lines.push(`    Removed text: ${c.removedSample}`);
  }
  lines.push('', 'JSON:');
  const params: NvidiaParams<ChatCompletionCreateParams> = {
    model: MODEL,
    messages: [
      { role: 'system', content: TIMELINE_SYSTEM },
      { role: 'user', content: lines.join('\n') },
    ],
    temperature: 0.3,
    max_tokens: 2048,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
  const completion = await client.chat.completions.create(params as ChatCompletionCreateParams & { stream: false }, {
    signal,
  });
  const content = completion.choices[0]?.message?.content ?? '';
  const parsed = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1)) as {
    overview?: unknown;
    changes?: { n?: unknown; title?: unknown; summary?: unknown }[];
  };
  const valid = new Set(changes.map((c) => c.n));
  const overview =
    typeof parsed.overview === 'string'
      ? parsed.overview.trim().replace(/\[(\d+)\]/g, (m, n: string) => (valid.has(Number(n)) ? m : ''))
      : null;
  const byN = new Map<number, { title: string; summary: string }>();
  for (const c of Array.isArray(parsed.changes) ? parsed.changes : []) {
    const n = Number(c.n);
    if (valid.has(n) && typeof c.title === 'string' && typeof c.summary === 'string') {
      byN.set(n, { title: clipWords(c.title.replace(/\s*\[\d+\]/g, ''), 9), summary: clipWords(c.summary.replace(/\s*\[\d+\]/g, ''), 34) });
    }
  }
  return { overview: overview || null, byN };
}

// ---------- One input: articles or context ----------

const ROUTE_SYSTEM = `You route what a reader types in Atlas, a Wikipedia research canvas. The reader is on a page about a topic. Call exactly one tool:

- research_articles: they want Wikipedia articles: a new topic, a person, place, event or idea, an explanation or overview, a follow-up that moves to a different subject, or how a Wikipedia article changed. This builds a new research page.
- find_context: they want context about the current topic beyond what encyclopedia articles hold: impacts or consequences in a specific field (finance, economy, health, culture...), figures and statistics, analysis, comparisons, opinions, or recent news. This fills the context panel beside the page.

When unsure, choose research_articles.`;

const ROUTE_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'research_articles',
      description: 'Build a new research page from Wikipedia articles.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_context',
      description: 'Search the web for context on the current topic, for the context panel.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'A specific web search query naming the topic and the angle' } },
        required: ['query'],
      },
    },
  },
];

/** Where a typed question should go: a new page of articles, or the context panel. */
export async function routeQuestion(
  question: string,
  topic: string | undefined,
  history: PriorTurn[],
  signal?: AbortSignal,
): Promise<RouteResponse> {
  if (!client) throw new Error('AI is not configured');
  const params: NvidiaParams<ChatCompletionCreateParams> = {
    model: MODEL,
    messages: [
      { role: 'system', content: ROUTE_SYSTEM },
      {
        role: 'user',
        content: [
          `Current page topic: ${topic ?? 'none yet'}`,
          ...(history.length ? ['Earlier questions:', ...history.slice(-4).map((t) => `- ${t.question}`)] : []),
          '',
          `The reader typed: ${question}`,
        ].join('\n'),
      },
    ],
    tools: ROUTE_TOOLS,
    tool_choice: 'auto',
    temperature: 0,
    max_tokens: 200,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
  const completion = await client.chat.completions.create(params as ChatCompletionCreateParams & { stream: false }, {
    signal,
  });
  const call = completion.choices[0]?.message?.tool_calls?.find((c) => c.type === 'function');
  if (call?.type === 'function' && call.function.name === 'find_context') {
    let query: string | null = null;
    try {
      query = cleanQuery((JSON.parse(call.function.arguments || '{}') as { query?: unknown }).query);
    } catch {
      /* the panel builds its own query */
    }
    return { route: 'context', query };
  }
  return { route: 'articles', query: null };
}

// ---------- Figures (vision) ----------

const FIGURE_SYSTEM = `You read figures from Wikipedia articles for a search index, so that questions about what a figure shows can be answered without seeing it. Reply with JSON only:

{"kind": "chart" | "map" | "diagram" | "photo", "text": string}

- chart (graphs, plots, timelines with data): its title, axes and units, the series, and the key values read off it, as compact "label: value" lines. Give numbers as precisely as the figure allows.
- map: the area and period shown, what is marked (regions, borders, fronts, movements, places) and the legend.
- diagram: its parts and what it explains.
- photo: one sentence on what it shows.
- Write only what is visible or stated in the caption. Plain text, at most 180 words.`;

export const VISION_MODEL = MODEL;

/** What a figure shows, read once by the vision model (the result is stored in article_media). */
export async function readFigure(image: { dataUrl: string; caption: string; article: string }, signal?: AbortSignal) {
  if (!client) throw new Error('AI is not configured');
  const params: NvidiaParams<ChatCompletionCreateParams> = {
    model: MODEL,
    messages: [
      { role: 'system', content: FIGURE_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Article: ${image.article}\nCaption: ${image.caption || '(none)'}\n\nJSON:` },
          { type: 'image_url', image_url: { url: image.dataUrl } },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 700,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
  const completion = await client.chat.completions.create(params as ChatCompletionCreateParams & { stream: false }, {
    signal,
  });
  const content = completion.choices[0]?.message?.content ?? '';
  let parsed: { kind?: unknown; text?: unknown } = {};
  try {
    parsed = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
  } catch {
    // Plain text instead of JSON: keep it as the description.
    parsed = { text: content };
  }
  const kinds = ['chart', 'map', 'diagram', 'photo'] as const;
  const kind = kinds.find((k) => k === parsed.kind) ?? 'photo';
  const text = typeof parsed.text === 'string' ? parsed.text.replace(/\s+\n/g, '\n').trim().slice(0, 2000) : '';
  return text ? { kind, text } : null;
}


// ---------- Search by photo (vision) ----------

const PHOTO_SYSTEM = `A reader photographed or picked an image to look something up on Wikipedia. Work out what it shows and what they would most likely want to read about. Reply with JSON only:

{"description": string, "query": string}

- description: one or two plain sentences on what the image shows (any visible text, names, places, objects, artworks, buildings, people only if a caption or sign names them).
- query: a short Wikipedia search query (2 to 8 words) naming the most specific subject you can identify with confidence (a landmark, artwork, species, object, event, map or chart topic). If you can't identify it, name the most useful general topic.
- Never identify a person from their face. For a photo of a person, describe what they are doing or wearing and search for that, unless a caption or sign names them.
- Plain text only.`;

/** What a photo shows and a Wikipedia search for it, read by the vision model. */
export async function analyzePhoto(photo: { dataUrl: string }, signal?: AbortSignal) {
  // The model occasionally answers without usable JSON: one more try.
  return (await readPhoto(photo, signal)) ?? (await readPhoto(photo, signal));
}

async function readPhoto(photo: { dataUrl: string }, signal?: AbortSignal) {
  if (!client) throw new Error('AI is not configured');
  const params: NvidiaParams<ChatCompletionCreateParams> = {
    model: MODEL,
    messages: [
      { role: 'system', content: PHOTO_SYSTEM },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'JSON:' },
          { type: 'image_url', image_url: { url: photo.dataUrl } },
        ],
      },
    ],
    temperature: 0.1,
    max_tokens: 300,
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  };
  const completion = await client.chat.completions.create(params as ChatCompletionCreateParams & { stream: false }, {
    signal,
  });
  const content = completion.choices[0]?.message?.content ?? '';
  let parsed: { description?: unknown; query?: unknown } = {};
  try {
    parsed = JSON.parse(content.slice(content.indexOf('{'), content.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
  const description = typeof parsed.description === 'string' ? parsed.description.replace(/\s+/g, ' ').trim().slice(0, 400) : '';
  const query = cleanQuery(parsed.query);
  return query ? { description, query } : null;
}

// ---------- JSON completions (deep research reports) ----------

export const CHAT_MODEL = MODEL;

/** Whether the server accepted a JSON schema (structured output); turned off after it refuses one. */
let schemasAccepted = true;

/**
 * A JSON reply from the chat model, parsed. With `schema`, the server is asked
 * to decode to that JSON schema (structured output, supported by NVIDIA's API,
 * NIM and vLLM), so the reply is always valid JSON; a server that refuses it
 * gets the plain request. Retries once when the reply can't be parsed.
 *
 * With `onText`, the reply is streamed and the text received so far is passed
 * to it as it arrives (the JSON is still returned whole at the end).
 */
export async function jsonCompletion<T>(
  system: string,
  user: string,
  options: {
    maxTokens: number;
    temperature?: number;
    signal?: AbortSignal;
    schema?: { name: string; schema: object };
    onText?: (textSoFar: string) => void;
  },
): Promise<T> {
  if (!client) throw new Error('AI is not configured');
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const structured = Boolean(options.schema) && schemasAccepted;
    const params: NvidiaParams<ChatCompletionCreateParams> = {
      ...(structured ? { response_format: { type: 'json_schema' as const, json_schema: { name: options.schema!.name, schema: options.schema!.schema as Record<string, unknown> } } } : {}),
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens,
      stream: false,
      chat_template_kwargs: { enable_thinking: false },
    };
    let content = '';
    try {
      if (options.onText) {
        const stream = await client.chat.completions.create({ ...params, stream: true } as ChatCompletionCreateParams & { stream: true }, {
          signal: options.signal,
        });
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content;
          if (!delta) continue;
          content += delta;
          options.onText(content);
        }
      } else {
        const completion = await client.chat.completions.create(params as ChatCompletionCreateParams & { stream: false }, {
          signal: options.signal,
        });
        content = completion.choices[0]?.message?.content ?? '';
      }
    } catch (err) {
      // A server without structured output: ask again without the schema.
      if (structured && (err as { status?: number }).status === 400 && !options.signal?.aborted) {
        schemasAccepted = false;
        attempt--;
        continue;
      }
      // A stream that broke part way is asked for again once.
      if (options.onText && attempt === 0 && !options.signal?.aborted) {
        lastError = err;
        continue;
      }
      throw err;
    }
    const json = content
      .slice(content.indexOf('{'), content.lastIndexOf('}') + 1)
      // Citation-style source lists ("[1][3]") where a JSON array belongs.
      .replace(/("(?:sources|figures|evidence)"\s*:\s*)((?:\[[\d\s,]*\]\s*)+)/g, (_, key: string, arrays: string) => {
        const nums = arrays.match(/\d+/g) ?? [];
        return `${key}[${nums.join(', ')}]`;
      });
    try {
      return JSON.parse(json) as T;
    } catch (err) {
      lastError = err;
      if (options.signal?.aborted) break;
    }
  }
  throw new Error(`The model's JSON couldn't be read: ${(lastError as Error)?.message}`);
}
