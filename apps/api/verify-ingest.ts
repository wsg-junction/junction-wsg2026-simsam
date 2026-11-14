// Temporary verification script (delete after use).
import './src/env.js';
import { readFile } from 'node:fs/promises';
import type { RowDataPacket } from 'mysql2/promise';
import { pool } from './src/db.js';
import { embed, vectorText } from './src/embeddings.js';

const [articles] = await pool.query<RowDataPacket[]>('SELECT page_id, title FROM articles ORDER BY page_id');
let ok = 0;
const problems: string[] = [];
for (const { page_id, title } of articles) {
  const file = JSON.parse(await readFile(`../../data/wikipedia-en/articles/${page_id}.json`, 'utf8'));
  const expected = file.history
    .filter((r: { slots?: { main?: { content?: string } } }) => r.slots?.main?.content !== undefined)
    .map((r: { revid: number; timestamp: string }) => ({ revid: r.revid, at: r.timestamp.replace('Z', '') }))
    .sort((a: { at: string }, b: { at: string }) => a.at.localeCompare(b.at));
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT revision_id, DATE_FORMAT(ROW_START, '%Y-%m-%dT%H:%i:%s') AS since, ROW_END > NOW() AS is_current
     FROM article_content FOR SYSTEM_TIME ALL WHERE page_id = ? ORDER BY ROW_START`,
    [page_id],
  );
  const same =
    rows.length === expected.length &&
    rows.every((r, i) => Number(r.revision_id) === expected[i].revid && r.since === expected[i].at) &&
    rows.filter((r) => r.is_current).length === 1 &&
    Number(rows[rows.length - 1].revision_id) === file.revisionId;
  if (same) ok++;
  else problems.push(`${title}: db ${rows.length} rows vs file ${expected.length}; first db ${JSON.stringify(rows[0])} file ${JSON.stringify(expected[0])}`);
}
console.log(`History matches the files for ${ok}/${articles.length} articles`);
problems.slice(0, 5).forEach((p) => console.log('  ', p));

// AS OF: pick an article and a date between two of its revisions.
const [[sample]] = await pool.query<RowDataPacket[]>(
  `SELECT a.title, c.page_id, COUNT(*) AS versions FROM article_content FOR SYSTEM_TIME ALL c
   JOIN articles a USING (page_id) GROUP BY c.page_id ORDER BY versions DESC LIMIT 1`,
);
const [versions] = await pool.query<RowDataPacket[]>(
  `SELECT revision_id, ROW_START AS since, ROW_END AS until, byte_size FROM article_content FOR SYSTEM_TIME ALL
   WHERE page_id = ? ORDER BY ROW_START`,
  [sample.page_id],
);
const mid = versions[Math.floor(versions.length / 2)];
const probe = new Date((mid.since.getTime() + mid.until.getTime()) / 2);
const [[asOf]] = await pool.query<RowDataPacket[]>(
  'SELECT revision_id, byte_size FROM article_content FOR SYSTEM_TIME AS OF ? WHERE page_id = ?',
  [probe, sample.page_id],
);
console.log(
  `AS OF ${probe.toISOString()} for "${sample.title}" (${sample.versions} versions): revision ${asOf.revision_id},` +
    ` expected ${mid.revision_id} -> ${Number(asOf.revision_id) === Number(mid.revision_id) ? 'OK' : 'MISMATCH'}`,
);
const [[before]] = await pool.query<RowDataPacket[]>(
  'SELECT COUNT(*) AS n FROM article_content FOR SYSTEM_TIME AS OF ? WHERE page_id = ?',
  [new Date(versions[0].since.getTime() - 86400_000), sample.page_id],
);
console.log(`AS OF a day before its oldest stored revision: ${before.n} rows (expected 0)`);

// Vector search.
for (const q of ['programming language for wireless sensor networks', 'romantic melancholy in 19th century Europe']) {
  const [v] = await embed([q], 'query');
  const t0 = Date.now();
  const [hits] = await pool.query<RowDataPacket[]>(
    `SELECT a.title, c.section, VEC_DISTANCE_COSINE(c.embedding, VEC_FromText(?)) AS d
     FROM article_chunks c JOIN articles a USING (page_id)
     ORDER BY VEC_DISTANCE_COSINE(c.embedding, VEC_FromText(?)) LIMIT 3`,
    [vectorText(v), vectorText(v)],
  );
  console.log(`"${q}" (${Date.now() - t0} ms):`, hits.map((h) => `${h.title}${h.section ? ` / ${h.section}` : ''} (${Number(h.d).toFixed(3)})`).join('; '));
}
const [plan] = await pool.query<RowDataPacket[]>(
  `EXPLAIN SELECT id FROM article_chunks ORDER BY VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) LIMIT 5`,
  [vectorText(new Array(1024).fill(0.01))],
);
console.log('EXPLAIN vector search:', plan.map((p) => `${p.type} key=${p.key} ${p.Extra ?? ''}`).join(' | '));
await pool.end();
