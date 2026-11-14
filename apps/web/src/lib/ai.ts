import type {
  AnswerEvent,
  AnswerRequest,
  Brief,
  ContextRequest,
  ContextResponse,
  DeepReportEvent,
  DeepReportRequest,
  FactCheckReport,
  Health,
  RewriteRequest,
  RewriteResponse,
  RouteRequest,
  RouteResponse,
  SourcePlan,
} from '@simsam/models';

let features: Promise<Health | null> | null = null;

/** What the server has configured (AI, voice). Checked once per visit. */
export function serverFeatures(): Promise<Health | null> {
  features ??= fetch('/api/health')
    .then((res) => (res.ok ? (res.json() as Promise<Health>) : null))
    .catch(() => null);
  return features;
}

export const aiAvailable = () => serverFeatures().then((h) => h?.ai === true);

/** A standalone search query for a follow-up, or null if the AI can't help right now. */
export async function rewriteQuery(body: RewriteRequest, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch('/api/rewrite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) return null;
    const { query } = (await res.json()) as RewriteResponse;
    return query.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Let the AI choose the sources for a question (by tool calls): a Wikipedia
 * query, and a web query when it needs more. Null if the AI can't help right now.
 */
export async function planSources(body: RewriteRequest, signal?: AbortSignal): Promise<SourcePlan | null> {
  try {
    const res = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    return res.ok ? ((await res.json()) as SourcePlan) : null;
  } catch {
    return null;
  }
}

/** Web context for the context panel (context.dev), apart from the Wikipedia page. Throws if it fails. */
export async function fetchContext(body: ContextRequest, signal?: AbortSignal): Promise<ContextResponse> {
  const res = await fetch('/api/context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`Context request failed with ${res.status}`);
  return (await res.json()) as ContextResponse;
}

/** Stream an answer, calling `onEvent` for each server-sent event. Throws if the request fails outright. */
export function streamAnswer(body: AnswerRequest, onEvent: (event: AnswerEvent) => void, signal?: AbortSignal) {
  return streamEvents('/api/answer', body, onEvent, signal);
}

/** A deep research run: its progress, plan and finally the report. Throws if the request fails outright. */
export function streamDeepReport(body: DeepReportRequest, onEvent: (event: DeepReportEvent) => void, signal?: AbortSignal) {
  return streamEvents('/api/deep-report', body, onEvent, signal);
}

/** The article's claims checked against the web. Null if no such article; throws if the check fails. */
export async function fetchFactCheck(title: string, signal?: AbortSignal): Promise<FactCheckReport | null> {
  const res = await fetch('/api/fact-check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
    signal,
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const reason = await res.json().then((b: { error?: string }) => b.error).catch(() => undefined);
    throw new Error(reason ?? `Fact-check failed with ${res.status}`);
  }
  return (await res.json()) as FactCheckReport;
}

/** POST a JSON body and read server-sent events from the response. */
async function streamEvents<T>(path: string, body: unknown, onEvent: (event: T) => void, signal?: AbortSignal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`${path} failed with ${res.status}`);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      for (const line of block.split('\n')) {
        if (line.startsWith('data: ')) onEvent(JSON.parse(line.slice(6)) as T);
      }
    }
  }
}

/** The compact, visual brief for a page, or null if the AI can't write one right now. */
export async function fetchBrief(body: AnswerRequest, signal?: AbortSignal): Promise<Brief | null> {
  try {
    const res = await fetch('/api/brief', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    return res.ok ? ((await res.json()) as Brief) : null;
  } catch {
    return null;
  }
}

/** Where a typed question goes (articles or context), or null if the AI can't decide right now. */
export async function routeQuestion(body: RouteRequest, signal?: AbortSignal): Promise<RouteResponse | null> {
  try {
    const res = await fetch('/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    return res.ok ? ((await res.json()) as RouteResponse) : null;
  } catch {
    return null;
  }
}
