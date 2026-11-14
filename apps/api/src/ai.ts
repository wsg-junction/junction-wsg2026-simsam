import OpenAI from 'openai';
import type { ChatCompletionCreateParams, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { AnswerEvent, Brief, BriefEvent, BriefPoint, PriorTurn, SourcePlan, WebSource } from '@simsam/models';
import { webSearchEnabled } from './context.js';
import { fetchIntros } from './wikipedia.js';

// NVIDIA's hosted models speak the OpenAI chat completions API.
const apiKey = process.env.NVIDIA_API_KEY;
const MODEL = process.env.NVIDIA_MODEL ?? 'nvidia/nemotron-3.5-super-vl-120b-a12b';

const client = apiKey ? new OpenAI({ apiKey, baseURL: 'https://integrate.api.nvidia.com/v1' }) : null;

export const aiEnabled = client !== null;

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
    const delta = chunk.choices[0]?.delta as { content?: string | null; reasoning_content?: string } | undefined;
    if (delta?.reasoning_content && !announcedThinking) {
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
