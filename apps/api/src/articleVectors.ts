import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { pool } from './db.js';
import { vectorText } from './embeddings.js';

/** The normalized mean of an article's passage vectors: the article as a whole. */
export function meanVector(vectors: number[][]): number[] {
  const mean = new Array<number>(vectors[0].length).fill(0);
  for (const v of vectors) for (let i = 0; i < v.length; i++) mean[i] += v[i];
  const norm = Math.sqrt(mean.reduce((s, x) => s + x * x, 0)) || 1;
  return mean.map((x) => x / norm);
}

/** Store an article's vector (in the caller's transaction, if one is open). */
export async function writeArticleVector(conn: PoolConnection, pageId: number, revisionId: number, vectors: number[][]) {
  if (vectors.length === 0) return;
  await conn.query(
    `INSERT INTO article_vectors (page_id, revision_id, embedding) VALUES (?, ?, VEC_FromText(?))
     ON DUPLICATE KEY UPDATE revision_id = VALUES(revision_id), embedding = VALUES(embedding)`,
    [pageId, revisionId, vectorText(meanVector(vectors))],
  );
}

/**
 * Compute article vectors from stored passages for every embedded article that
 * lacks one (or whose passages are newer). Needs no embedding API: it reads the
 * passage vectors back from MariaDB.
 */
export async function backfillArticleVectors() {
  const [pending] = await pool.query<RowDataPacket[]>(
    `SELECT c.page_id, MAX(c.revision_id) AS revision_id
     FROM article_chunks c LEFT JOIN article_vectors v USING (page_id)
     GROUP BY c.page_id
     HAVING MAX(v.revision_id) IS NULL OR MAX(v.revision_id) <> MAX(c.revision_id)`,
  );
  if (pending.length === 0) return 0;
  console.log(`Computing article vectors for ${pending.length} articles…`);
  const BATCH = 50;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT page_id, VEC_ToText(embedding) AS v FROM article_chunks WHERE page_id IN (?)',
      [batch.map((p) => p.page_id)],
    );
    const byPage = new Map<number, number[][]>();
    for (const r of rows) {
      const id = Number(r.page_id);
      if (!byPage.has(id)) byPage.set(id, []);
      byPage.get(id)!.push(JSON.parse(r.v) as number[]);
    }
    // One writer: concurrent inserts into an HNSW index deadlock each other.
    const conn = await pool.getConnection();
    try {
      for (const p of batch) {
        const vectors = byPage.get(Number(p.page_id));
        if (vectors) await writeArticleVector(conn, Number(p.page_id), Number(p.revision_id), vectors);
      }
    } finally {
      conn.release();
    }
    process.stdout.write(`\r  ${Math.min(i + BATCH, pending.length)}/${pending.length} article vectors   `);
  }
  process.stdout.write('\n');
  return pending.length;
}
