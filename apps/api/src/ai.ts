import OpenAI from 'openai';
import type { ChatCompletionCreateParams, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { AnswerEvent, Brief, BriefEvent, BriefPoint, PriorTurn } from '@simsam/models';
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
  if (!client) throw new Error('AI is not configured');
  const excerpts = await numberedExcerpts(titles, signal);
  if (!excerpts) throw new Error('No sources could be read');

  const params: NvidiaParams<ChatCompletionCreateParams> = {
    model: MODEL,
    messages: [
      { role: 'system', content: BRIEF_SYSTEM },
      {
        role: 'user',
        content: [
          ...(history.length ? ['Earlier questions:', ...history.slice(-4).map((t) => `- ${t.question}`), ''] : []),
          'Wikipedia excerpts:',
          '',
          excerpts,
          '',
          `Question: ${question}`,
          '',
          'JSON:',
        ].join('\n'),
      },
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
  return sanitizeBrief(parsed, titles.length);
}
