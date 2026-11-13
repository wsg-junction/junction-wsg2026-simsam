import Fastify from 'fastify';
import cors from '@fastify/cors';
import type { Health, Item } from '@simsam/models';

const app = Fastify({ logger: true });
await app.register(cors);

const items: Item[] = [
  { id: '1', name: 'First item' },
  { id: '2', name: 'Second item' },
];

app.get('/api/health', async (): Promise<Health> => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
}));

app.get('/api/items', async (): Promise<Item[]> => items);

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: '0.0.0.0' });
