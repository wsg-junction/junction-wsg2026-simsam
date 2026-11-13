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
  AnswerRequest,
  Brief,
  Exploration,
  ExplorationStep,
  Health,
  NewExploration,
  RewriteRequest,
  RewriteResponse,
} from '@simsam/models';
import { aiEnabled, createBrief, rewriteQuery, streamAnswer } from './ai.js';
import { SpeechError, speechEnabled, synthesize, transcribe } from './speech.js';
import { pool, migrate } from './db.js';

interface ExplorationRow extends RowDataPacket {
  id: number;
  question: string;
  focus_title: string;
  /** JSON text in MariaDB; NULL for rows saved before follow-ups existed. */
  steps: string | ExplorationStep[] | null;
  created_at: Date;
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
});

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
          kind: { type: 'string', enum: ['question', 'dive'] },
          text: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
    },
  },
} as const;

const idParams = { type: 'object', properties: { id: { type: 'integer' } } } as const;

async function findExploration(id: number) {
  const [rows] = await pool.query<ExplorationRow[]>('SELECT * FROM explorations WHERE id = ?', [id]);
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
    'SELECT * FROM explorations ORDER BY created_at DESC, id DESC LIMIT 100',
  );
  return rows.map(toExploration);
});

app.post<{ Body: NewExploration }>(
  '/api/explorations',
  { schema: { body: explorationBody } },
  async (req, reply): Promise<Exploration> => {
    const { focusTitle, steps } = req.body;
    const [result] = await pool.execute<ResultSetHeader>(
      'INSERT INTO explorations (question, focus_title, steps) VALUES (?, ?, ?)',
      [steps[0].text, focusTitle, JSON.stringify(steps)],
    );
    reply.code(201);
    return (await findExploration(result.insertId))!;
  },
);

// Saving again after follow-ups replaces the steps of the same exploration.
app.put<{ Params: { id: number }; Body: NewExploration }>(
  '/api/explorations/:id',
  { schema: { params: idParams, body: explorationBody } },
  async (req, reply) => {
    const { focusTitle, steps } = req.body;
    const [result] = await pool.execute<ResultSetHeader>(
      'UPDATE explorations SET question = ?, focus_title = ?, steps = ? WHERE id = ?',
      [steps[0].text, focusTitle, JSON.stringify(steps), req.params.id],
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
