import { EMBEDDING_DIMENSIONS } from './db.js';

// Embeddings from NVIDIA's API catalog (same key as the chat model).
const apiKey = process.env.NVIDIA_API_KEY;
const MODEL = process.env.NVIDIA_EMBEDDING_MODEL || 'nvidia/nemotron-3.5-embed-1b';

export const embeddingsEnabled = Boolean(apiKey);

/**
 * The API refused the input itself (422, e.g. "input rejected by content safety
 * screening"). Retrying won't help; one bad text rejects the whole batch.
 */
export class EmbeddingRejectedError extends Error {}

/**
 * Embed texts. `passage` for stored text, `query` for search queries: the
 * model is trained asymmetrically, so mixing them up hurts retrieval.
 * Retries throttling (429) and transient server errors with backoff.
 */
export async function embed(texts: string[], inputType: 'passage' | 'query', signal?: AbortSignal): Promise<number[][]> {
  if (!apiKey) throw new Error('NVIDIA_API_KEY is not set');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://integrate.api.nvidia.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        input: texts,
        input_type: inputType,
        encoding_format: 'float',
        truncate: 'END',
        dimensions: EMBEDDING_DIMENSIONS,
      }),
      signal,
    });
    if (res.ok) {
      const data = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    }
    if (res.status === 422) throw new EmbeddingRejectedError((await res.text()).slice(0, 300));
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 5) {
      throw new Error(`Embedding request failed with ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const retryAfter = Number(res.headers.get('retry-after'));
    const wait = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
    // The backoff ends early when the caller gives up (e.g. an interactive search's time limit).
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(resolve, wait);
      signal?.addEventListener('abort', () => (clearTimeout(timer), reject(signal.reason)), { once: true });
    });
  }
}

/**
 * Like embed, but when the API rejects a batch, splits it in half until the
 * rejected texts are found, and returns null for just those.
 */
export async function embedSkippingRejected(
  texts: string[],
  inputType: 'passage' | 'query',
  signal?: AbortSignal,
): Promise<(number[] | null)[]> {
  try {
    return await embed(texts, inputType, signal);
  } catch (err) {
    if (!(err instanceof EmbeddingRejectedError)) throw err;
    if (texts.length === 1) return [null];
    const mid = Math.ceil(texts.length / 2);
    return [
      ...(await embedSkippingRejected(texts.slice(0, mid), inputType, signal)),
      ...(await embedSkippingRejected(texts.slice(mid), inputType, signal)),
    ];
  }
}

// Searches repeat (follow-ups, the same live results for similar queries), so
// interactive embeddings are cached in memory.
const cache = new Map<string, number[] | null>();
const CACHE_SIZE = 5000;

/** embedSkippingRejected with an in-memory cache, for interactive search. */
export async function embedCached(
  texts: string[],
  inputType: 'passage' | 'query',
  signal?: AbortSignal,
): Promise<(number[] | null)[]> {
  const key = (t: string) => `${inputType}\u0000${t}`;
  const missing = [...new Set(texts.filter((t) => !cache.has(key(t))))];
  if (missing.length > 0) {
    const vectors = await embedSkippingRejected(missing, inputType, signal);
    missing.forEach((t, i) => {
      if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value!);
      cache.set(key(t), vectors[i]);
    });
  }
  return texts.map((t) => cache.get(key(t)) ?? null);
}

/** MariaDB's VECTOR columns take the text form produced by VEC_FromText('[...]'). */
export const vectorText = (v: number[]) => `[${v.join(',')}]`;
