import './env.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type {
  AnswerEvent,
  ArticleHistory,
  ArticleTimeline,
  RevisionDiff,
  AnswerRequest,
  Brief,
  Exploration,
  ExplorationStep,
  Health,
  NewExploration,
  RewriteRequest,
  SavedExploration,
  RewriteResponse,
  SourcePlan,
  ContextRequest,
  ContextResponse,
} from '@simsam/models';
import { aiEnabled, createBrief, planSources, rewriteQuery, streamAnswer, summarizeContext } from './ai.js';
import { searchWeb, webSearchEnabled } from './context.js';
import { corpusArticles, corpusAvailable, corpusGraph, type CorpusGraph, relatedInCorpus, searchCorpus, type CorpusArticle, type CorpusHit, type RankedHit, type SearchCandidate } from './corpus.js';
import { articleHistory } from './history.js';
import { articleTimeline, revisionDiff } from './timeline.js';
import { SpeechError, speechEnabled, synthesize, transcribe } from './speech.js';
import { pool, migrate } from './db.js';

interface ExplorationRow extends RowDataPacket {
  id: number;
  question: string;
  focus_title: string;
  /** JSON text in MariaDB; NULL for rows saved before follow-ups existed. */
  steps: string | ExplorationStep[] | null;
  created_at: Date;
  /** Only selected where it's needed: it can be large. */
  snapshot?: string | null;
  has_snapshot?: number;
}

const toExploration = (row: ExplorationRow): Exploration => ({
  id: row.id,
  question: row.question,
  focusTitle: row.focus_title,
  // MariaDB stores JSON as text; a MySQL server would hand back parsed JSON.
  steps:
    typeof row.steps === 'string'
      ? (JSON.parse(row.steps) as ExplorationStep[])
      : (row.steps ?? [{ kind: 'question', text: row.question }]),
  createdAt: row.created_at.toISOString(),
  hasSnapshot: Boolean(row.has_snapshot ?? (row.snapshot !== undefined && row.snapshot !== null)),
});

/** List columns: everything but the snapshot itself. */
const LIST_COLUMNS = 'id, question, focus_title, steps, created_at, snapshot IS NOT NULL AS has_snapshot';

/** A saved snapshot is opaque to the API: stored as given, returned as given. */
// Under MariaDB's max_allowed_packet (16 MB by default).
const MAX_SNAPSHOT_BYTES = 15 * 1024 * 1024;

const explorationBody = {
  type: 'object',
  required: ['focusTitle', 'steps'],
  additionalProperties: false,
  properties: {
    focusTitle: { type: 'string', minLength: 1, maxLength: 255 },
    steps: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: {
        type: 'object',
        required: ['kind', 'text'],
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['question', 'dive', 'history'] },
          text: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
    },
    snapshot: { type: 'object' },
  },
} as const;

const idParams = { type: 'object', properties: { id: { type: 'integer' } } } as const;

async function findExploration(id: number) {
  const [rows] = await pool.query<ExplorationRow[]>(`SELECT ${LIST_COLUMNS} FROM explorations WHERE id = ?`, [id]);
  return rows[0] ? toExploration(rows[0]) : undefined;
}

// trustProxy: behind Caddy, rate limits must key on the visitor's address, not the proxy's.
const app = Fastify({ logger: true, trustProxy: true });
await app.register(cors);
await app.register(rateLimit, { global: false });
await migrate();

app.get('/api/health', async (): Promise<Health> => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
  ai: aiEnabled,
  voice: speechEnabled,
  corpus: await corpusAvailable(),
  web: webSearchEnabled,
}));

// ---------- Speech (ElevenLabs) ----------

// Spoken follow-ups: the browser posts the raw recording (audio/webm, audio/mp4, ...).
// About a minute of compressed speech fits comfortably in 8 MB.
app.addContentTypeParser(/^audio\//, { parseAs: 'buffer', bodyLimit: 8 * 1024 * 1024 }, (_req, body, done) =>
  done(null, body),
);

app.post<{ Body: Buffer }>(
  '/api/transcribe',
  { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
  async (req, reply) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return reply.code(400).send({ error: 'Send the recording as the request body.' });
    }
    try {
      const text = await transcribe(req.body, req.headers['content-type'] ?? 'audio/webm', AbortSignal.timeout(30_000));
      return { text };
    } catch (err) {
      const status = err instanceof SpeechError ? err.status : 502;
      if (status !== 503) req.log.error(err, 'transcription failed');
      return reply.code(status).send({ error: 'The recording couldn’t be transcribed right now.' });
    }
  },
);

// Short texts only (one beat of a brief at a time) and rate limited, so the
// endpoint can't be used as a general text-to-speech service on our key.
app.post<{ Body: { text: string } }>(
  '/api/speech',
  {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['text'],
        additionalProperties: false,
        properties: { text: { type: 'string', minLength: 1, maxLength: 600 } },
      },
    },
  },
  async (req, reply) => {
    try {
      const audio = await synthesize(req.body.text.trim(), AbortSignal.timeout(30_000));
      return reply.type('audio/mpeg').header('Cache-Control', 'private, max-age=86400').send(audio);
    } catch (err) {
      const status = err instanceof SpeechError ? err.status : 502;
      if (status !== 503) req.log.error(err, 'speech failed');
      return reply.code(status).send({ error: 'Speech is unavailable right now.' });
    }
  },
);

// ---------- Local Wikipedia corpus (see ingest.ts) ----------
// Each route answers from MariaDB; an empty result tells the browser to fall
// back to the live Wikipedia API (the corpus covers three topic areas only).

// The history panel: an article's substantial changes, scanned from its recent
// revisions and stored in the system-versioned table (404 if it isn't in the corpus).
app.post<{ Body: { title: string } }>(
  '/api/article-history',
  {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        additionalProperties: false,
        properties: { title: { type: 'string', minLength: 1, maxLength: 255 } },
      },
    },
  },
  async (req, reply): Promise<ArticleTimeline | void> => {
    try {
      const timeline = await articleTimeline(req.body.title, AbortSignal.timeout(90_000));
      if (!timeline) return reply.code(404).send({ error: 'This article isn’t in the local collection.' });
      return timeline;
    } catch (err) {
      req.log.warn(err, 'article history failed');
      return reply.code(502).send({ error: 'The history couldn’t be read right now.' });
    }
  },
);

app.get<{ Querystring: { pageId: number; revisionId: number } }>(
  '/api/article-history/diff',
  {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: {
      querystring: {
        type: 'object',
        required: ['pageId', 'revisionId'],
        properties: { pageId: { type: 'integer', minimum: 1 }, revisionId: { type: 'integer', minimum: 1 } },
      },
    },
  },
  async (req, reply): Promise<RevisionDiff | void> => {
    const diff = await revisionDiff(req.query.pageId, req.query.revisionId);
    if (!diff) return reply.code(404).send({ error: 'This edit isn’t stored.' });
    return diff;
  },
);

// The topic map, built from MariaDB's vector index alone (404 without the corpus).
app.post<{ Body: { title: string; seeds?: string[]; about?: string } }>(
  '/api/graph',
  {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        additionalProperties: false,
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 255 },
          seeds: { type: 'array', maxItems: 10, items: { type: 'string', minLength: 1, maxLength: 255 } },
          // The article's opening text, for a center outside the corpus.
          about: { type: 'string', maxLength: 2000 },
        },
      },
    },
  },
  async (req, reply): Promise<CorpusGraph | void> => {
    const graph = await corpusGraph(req.body.title, req.body.seeds, req.body.about).catch((err) => {
      req.log.warn(err, 'graph failed');
      return null;
    });
    if (!graph) return reply.code(404).send({ error: 'The local collection isn’t available.' });
    return graph;
  },
);

app.post<{ Body: { query: string; limit?: number; candidates?: SearchCandidate[] } }>(
  '/api/search',
  {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['query'],
        additionalProperties: false,
        properties: {
          query: { type: 'string', minLength: 1, maxLength: 500 },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
          // Live Wikipedia search results, ranked together with the corpus.
          candidates: {
            type: 'array',
            maxItems: 10,
            items: {
              type: 'object',
              required: ['title', 'snippet'],
              additionalProperties: false,
              properties: { title: { type: 'string', maxLength: 255 }, snippet: { type: 'string', maxLength: 1000 } },
            },
          },
        },
      },
    },
  },
  async (req): Promise<{ results: RankedHit[] }> => ({
    results: await searchCorpus(req.body.query, req.body.limit ?? 8, req.body.candidates).catch((err) => {
      req.log.warn(err, 'corpus search failed');
      return [];
    }),
  }),
);

app.get<{ Querystring: { title: string; limit?: number } }>(
  '/api/related',
  {
    config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
    schema: {
      querystring: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 255 },
          limit: { type: 'integer', minimum: 1, maximum: 20 },
        },
      },
    },
  },
  async (req): Promise<{ results: CorpusHit[] }> => ({
    results: await relatedInCorpus(req.query.title, req.query.limit ?? 10).catch((err) => {
      req.log.warn(err, 'related lookup failed');
      return [];
    }),
  }),
);

app.post<{ Body: { titles: string[] } }>(
  '/api/articles',
  {
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['titles'],
        additionalProperties: false,
        properties: { titles: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', maxLength: 255 } } },
      },
    },
  },
  async (req): Promise<{ articles: (CorpusArticle | null)[] }> => ({ articles: await corpusArticles(req.body.titles) }),
);

// How an article changed over time, from its system-versioned history.
app.post<{ Body: { title: string } }>(
  '/api/history',
  {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['title'],
        additionalProperties: false,
        properties: { title: { type: 'string', minLength: 1, maxLength: 255 } },
      },
    },
  },
  async (req, reply): Promise<ArticleHistory | void> => {
    const history = await articleHistory(req.body.title, AbortSignal.timeout(60_000));
    if (!history) return reply.code(404).send({ error: 'That article’s history isn’t in the local collection.' });
    return history;
  },
);

// ---------- AI ----------

const historySchema = {
  type: 'array',
  maxItems: 8,
  items: {
    type: 'object',
    required: ['question', 'answer'],
    additionalProperties: false,
    properties: {
      question: { type: 'string', maxLength: 500 },
      answer: { type: 'string', maxLength: 4000 },
    },
  },
} as const;

app.post<{ Body: RewriteRequest }>(
  '/api/rewrite',
  {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['question', 'history'],
        additionalProperties: false,
        properties: { question: { type: 'string', minLength: 1, maxLength: 500 }, history: historySchema },
      },
    },
  },
  async (req, reply): Promise<RewriteResponse | void> => {
    if (!aiEnabled) return reply.code(503).send({ error: 'AI is not configured' });
    const query = await rewriteQuery(req.body.question, req.body.history, AbortSignal.timeout(15_000));
    return { query: query || req.body.question };
  },
);

// The AI picks its sources by calling tools: a Wikipedia search, and a web search
// (context.dev) when the question needs more than encyclopedia intros.
app.post<{ Body: RewriteRequest }>(
  '/api/plan',
  {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['question', 'history'],
        additionalProperties: false,
        properties: { question: { type: 'string', minLength: 1, maxLength: 500 }, history: historySchema },
      },
    },
  },
  async (req, reply): Promise<SourcePlan | void> => {
    if (!aiEnabled) return reply.code(503).send({ error: 'AI is not configured' });
    try {
      return await planSources(req.body.question, req.body.history, AbortSignal.timeout(15_000));
    } catch (err) {
      req.log.warn(err, 'source planning failed');
      return reply.code(502).send({ error: 'Sources could not be planned right now.' });
    }
  },
);

/** A web query for a context question: the page's topic is added unless the question already names it. */
function contextQuery(question: string, topic: string) {
  const q = question.trim().replace(/[?.!]+$/, '');
  const topicWords = topic.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
  const named = topicWords.length > 0 && topicWords.some((w) => q.toLowerCase().includes(w));
  return named ? q : `${topic} ${q}`;
}

// Context panel: web search (context.dev), kept apart from the Wikipedia page,
// with a short AI summary of what the web adds.
app.post<{ Body: ContextRequest }>(
  '/api/context',
  {
    // Each search costs context.dev credits.
    config: { rateLimit: { max: 15, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['question', 'topic'],
        additionalProperties: false,
        properties: {
          question: { type: 'string', minLength: 1, maxLength: 500 },
          topic: { type: 'string', minLength: 1, maxLength: 255 },
          query: { type: 'string', minLength: 1, maxLength: 300 },
        },
      },
    },
  },
  async (req, reply): Promise<ContextResponse | void> => {
    if (!webSearchEnabled) return reply.code(503).send({ error: 'Web search is not configured' });
    const { question, topic } = req.body;
    const query = req.body.query ?? contextQuery(question, topic);
    let sources;
    try {
      sources = await searchWeb(query, AbortSignal.timeout(20_000));
    } catch (err) {
      req.log.warn(err, 'web search failed');
      return reply.code(502).send({ error: 'Web search failed.' });
    }
    let summary: string | null = null;
    if (aiEnabled && sources.length > 0) {
      summary = await summarizeContext(question, topic, sources, AbortSignal.timeout(30_000)).catch((err) => {
        req.log.warn(err, 'context summary failed');
        return null;
      });
    }
    return { query, sources, summary };
  },
);

const answerBody = {
  type: 'object',
  required: ['question', 'titles', 'history'],
  additionalProperties: false,
  properties: {
    question: { type: 'string', minLength: 1, maxLength: 500 },
    titles: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string', minLength: 1, maxLength: 255 } },
    history: historySchema,
  },
} as const;

// The compact, visual version of an answer (see Brief in @simsam/models).
app.post<{ Body: AnswerRequest }>(
  '/api/brief',
  { config: { rateLimit: { max: 20, timeWindow: '1 minute' } }, schema: { body: answerBody } },
  async (req, reply): Promise<Brief | void> => {
    if (!aiEnabled) return reply.code(503).send({ error: 'AI is not configured' });
    const { question, titles, history } = req.body;
    // Models occasionally return malformed JSON; one retry fixes most of those.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await createBrief(question, titles, history, AbortSignal.timeout(45_000));
      } catch (err) {
        req.log.warn(err, 'brief attempt failed');
      }
    }
    return reply.code(502).send({ error: 'The brief could not be written right now.' });
  },
);

// Streams the answer as server-sent events so it can appear as it's written.
app.post<{ Body: AnswerRequest }>(
  '/api/answer',
  {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    schema: { body: answerBody },
  },
  async (req, reply) => {
    if (!aiEnabled) return reply.code(503).send({ error: 'AI is not configured' });

    // Stop generating (and paying for tokens) when the reader goes away.
    const controller = new AbortController();
    reply.raw.on('close', () => controller.abort());

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: AnswerEvent) => reply.raw.write(`data: ${JSON.stringify(event)}

`);
    try {
      const { question, titles, history } = req.body;
      for await (const event of streamAnswer(question, titles, history, controller.signal)) send(event);
    } catch (err) {
      if (!controller.signal.aborted) {
        req.log.error(err, 'answer failed');
        send({ type: 'error', message: 'The answer couldn’t be written right now.' });
      }
    }
    reply.raw.end();
    return reply;
  },
);

app.get('/api/explorations', async (): Promise<Exploration[]> => {
  const [rows] = await pool.query<ExplorationRow[]>(
    `SELECT ${LIST_COLUMNS} FROM explorations ORDER BY created_at DESC, id DESC LIMIT 100`,
  );
  return rows.map(toExploration);
});

// One saved exploration with its snapshot, to open it as it was.
app.get<{ Params: { id: number } }>(
  '/api/explorations/:id',
  { schema: { params: idParams } },
  async (req, reply): Promise<SavedExploration | void> => {
    const [rows] = await pool.query<ExplorationRow[]>('SELECT * FROM explorations WHERE id = ?', [req.params.id]);
    if (!rows[0]) return reply.code(404).send({ error: 'Not Found' });
    const snapshot = rows[0].snapshot ? (JSON.parse(rows[0].snapshot) as unknown) : null;
    return { ...toExploration(rows[0]), snapshot };
  },
);

const snapshotText = (snapshot: unknown) => (snapshot === undefined ? null : JSON.stringify(snapshot));

app.post<{ Body: NewExploration }>(
  '/api/explorations',
  { schema: { body: explorationBody }, bodyLimit: MAX_SNAPSHOT_BYTES },
  async (req, reply): Promise<Exploration> => {
    const { focusTitle, steps, snapshot } = req.body;
    const [result] = await pool.execute<ResultSetHeader>(
      'INSERT INTO explorations (question, focus_title, steps, snapshot) VALUES (?, ?, ?, ?)',
      [steps[0].text, focusTitle, JSON.stringify(steps), snapshotText(snapshot)],
    );
    reply.code(201);
    return (await findExploration(result.insertId))!;
  },
);

// Saving again after follow-ups replaces the steps of the same exploration.
app.put<{ Params: { id: number }; Body: NewExploration }>(
  '/api/explorations/:id',
  { schema: { params: idParams, body: explorationBody }, bodyLimit: MAX_SNAPSHOT_BYTES },
  async (req, reply) => {
    const { focusTitle, steps, snapshot } = req.body;
    const [result] = await pool.execute<ResultSetHeader>(
      'UPDATE explorations SET question = ?, focus_title = ?, steps = ?, snapshot = ? WHERE id = ?',
      [steps[0].text, focusTitle, JSON.stringify(steps), snapshotText(snapshot), req.params.id],
    );
    if (result.affectedRows === 0) return reply.code(404).send({ error: 'Not Found' });
    return findExploration(req.params.id);
  },
);

app.delete<{ Params: { id: number } }>(
  '/api/explorations/:id',
  { schema: { params: idParams } },
  async (req, reply) => {
    await pool.execute('DELETE FROM explorations WHERE id = ?', [req.params.id]);
    reply.code(204).send();
  },
);

// In production the API also serves the built frontend.
const webDist = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) =>
    req.method === 'GET' && !req.url.startsWith('/api')
      ? reply.sendFile('index.html')
      : reply.code(404).send({ error: 'Not Found' }),
  );
}

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
