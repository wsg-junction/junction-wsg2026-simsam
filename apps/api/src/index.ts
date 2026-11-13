import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { Health, Item, NewItem } from '@simsam/models';
import { pool, migrate } from './db.js';

interface ItemRow extends RowDataPacket {
  id: number;
  name: string;
  created_at: Date;
}

const toItem = (row: ItemRow): Item => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at.toISOString(),
});

const app = Fastify({ logger: true });
await app.register(cors);
await migrate();

app.get('/api/health', async (): Promise<Health> => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
}));

app.get('/api/items', async (): Promise<Item[]> => {
  const [rows] = await pool.query<ItemRow[]>('SELECT * FROM items ORDER BY id');
  return rows.map(toItem);
});

app.post<{ Body: NewItem }>(
  '/api/items',
  {
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        additionalProperties: false,
        properties: { name: { type: 'string', minLength: 1, maxLength: 255 } },
      },
    },
  },
  async (req, reply): Promise<Item> => {
    const [result] = await pool.execute<ResultSetHeader>(
      'INSERT INTO items (name) VALUES (?)',
      [req.body.name],
    );
    const [rows] = await pool.query<ItemRow[]>('SELECT * FROM items WHERE id = ?', [
      result.insertId,
    ]);
    reply.code(201);
    return toItem(rows[0]);
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
