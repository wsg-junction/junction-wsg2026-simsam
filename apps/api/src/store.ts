/**
 * Storing one article in MariaDB, shared by the bulk ingest (ingest.ts) and by
 * on-demand fetching (acquire.ts): the article row, its revisions in the
 * system-versioned table, and its passages (chunks) with their embeddings.
 */
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { pool } from './db.js';
import { writeArticleVector } from './articleVectors.js';
import { vectorText } from './embeddings.js';
import { leadOf, sectionsOf } from './wikitext.js';

export interface Revision {
  revid: number;
  parentid?: number;
  user?: string;
  timestamp: string;
  comment?: string;
  slots?: { main?: { content?: string } };
}

export interface ArticleFile {
  pageid: number;
  title: string;
  url: string;
  wikidataId?: string;
  topics: string[];
  categories: string[];
  discoveredVia?: string;
  fetchedAt: string;
  revisionId: number;
  revisionTimestamp: string;
  text: string;
  wikitext: string;
  isDisambiguation?: boolean;
  history: Revision[];
}

// ---------- Content history ----------

const toSql = (iso: string) => iso.replace('T', ' ').replace('Z', '');
/** Seconds since the epoch, for SET timestamp (fractional seconds keep same-second edits ordered). */
const epoch = (iso: string) => Date.parse(iso) / 1000;

function contentRow(rev: Revision, wikitext: string) {
  return [
    rev.revid,
    rev.parentid || null,
    rev.user ?? null,
    rev.comment ?? null,
    Buffer.byteLength(wikitext),
    JSON.stringify(sectionsOf(wikitext)),
    leadOf(wikitext),
    wikitext,
  ];
}

/**
 * Write an article's revisions, oldest first, each at its original edit time.
 * Existing rows get only the revisions newer than what's stored.
 */
async function replayHistory(conn: PoolConnection, article: ArticleFile) {
  const [[current]] = await conn.query<RowDataPacket[]>(
    'SELECT revision_id, UNIX_TIMESTAMP(ROW_START) AS since FROM article_content WHERE page_id = ?',
    [article.pageid],
  );
  if (current && Number(current.revision_id) === article.revisionId) return 0;

  // Oldest first; the collection stores newest first. The current revision's
  // content is always available as `wikitext`, even if history is empty.
  let revisions = [...article.history]
    .filter((r) => r.slots?.main?.content !== undefined)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.revid - b.revid);
  if (!revisions.some((r) => r.revid === article.revisionId)) {
    revisions.push({
      revid: article.revisionId,
      timestamp: article.revisionTimestamp,
      slots: { main: { content: article.wikitext } },
    });
  }
  if (current) revisions = revisions.filter((r) => epoch(r.timestamp) > Number(current.since));

  let last = current ? Number(current.since) : 0;
  let exists = Boolean(current);
  for (const rev of revisions) {
    // System versioning stamps rows with the session timestamp; it must strictly
    // increase or MariaDB drops the zero-length history row.
    const at = Math.max(epoch(rev.timestamp), last + 0.000001);
    last = at;
    await conn.query('SET timestamp = ?', [at]);
    const row = contentRow(rev, rev.slots!.main!.content!);
    if (exists) {
      await conn.query(
        `UPDATE article_content SET revision_id = ?, parent_revision_id = ?, editor = ?, edit_comment = ?,
           byte_size = ?, sections = ?, lead = ?, wikitext = ? WHERE page_id = ?`,
        [...row, article.pageid],
      );
    } else {
      await conn.query(
        `INSERT INTO article_content (page_id, revision_id, parent_revision_id, editor, edit_comment,
           byte_size, sections, lead, wikitext) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [article.pageid, ...row],
      );
      exists = true;
    }
  }
  await conn.query('SET timestamp = DEFAULT');
  return revisions.length;
}

/** The article row and its revisions. Returns how many revisions were written. */
export async function storeArticle(article: ArticleFile) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO articles (page_id, title, url, wikidata_id, topics, categories, discovered_via, text, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE title = VALUES(title), url = VALUES(url), wikidata_id = VALUES(wikidata_id),
         topics = VALUES(topics), categories = VALUES(categories), discovered_via = VALUES(discovered_via),
         text = VALUES(text), fetched_at = VALUES(fetched_at)`,
      [
        article.pageid,
        article.title,
        article.url,
        article.wikidataId ?? null,
        JSON.stringify(article.topics),
        JSON.stringify(article.categories),
        article.discoveredVia ?? null,
        article.text,
        toSql(article.fetchedAt),
      ],
    );
    const replayed = await replayHistory(conn, article);
    await conn.commit();
    return replayed;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    await conn.query('SET timestamp = DEFAULT').catch(() => {});
    conn.release();
  }
}

// ---------- Chunks and embeddings ----------

const SKIP_SECTIONS = /^(references|external links|see also|further reading|notes|bibliography|sources|citations|footnotes)$/i;
const CHUNK_CHARS = 1200;
const MAX_CHUNKS = 24;

export interface Chunk {
  pageId: number;
  revisionId: number;
  index: number;
  section: string | null;
  content: string;
}

/** Split the plain text into passages of about CHUNK_CHARS, never across sections. */
export function chunksOf(article: Pick<ArticleFile, 'text' | 'pageid' | 'revisionId'>): Chunk[] {
  const sections: { title: string | null; body: string }[] = [{ title: null, body: '' }];
  for (const line of article.text.split('\n')) {
    const heading = line.match(/^=+\s*(.+?)\s*=+$/);
    if (heading) sections.push({ title: heading[1], body: '' });
    else sections[sections.length - 1].body += `${line}\n`;
  }
  const chunks: Chunk[] = [];
  for (const { title, body } of sections) {
    if (title && SKIP_SECTIONS.test(title)) continue;
    let current = '';
    const flush = () => {
      if (current.trim().length > 80) {
        chunks.push({
          pageId: article.pageid,
          revisionId: article.revisionId,
          index: chunks.length,
          section: title,
          content: current.trim(),
        });
      }
      current = '';
    };
    for (const para of body.split(/\n{2,}|\n(?=\S)/).map((p) => p.trim()).filter(Boolean)) {
      if (current && current.length + para.length > CHUNK_CHARS) flush();
      // A single very long paragraph is cut at sentence boundaries.
      if (para.length > CHUNK_CHARS * 1.5) {
        for (const sentence of para.split(/(?<=[.!?])\s+/)) {
          if (current.length + sentence.length > CHUNK_CHARS) flush();
          current += `${sentence} `;
        }
      } else {
        current += `${para}\n\n`;
      }
    }
    flush();
    if (chunks.length >= MAX_CHUNKS) break;
  }
  return chunks.slice(0, MAX_CHUNKS);
}

/** The text that gets embedded: the passage with its article and section for context. */
export const embeddingInput = (title: string, c: Chunk) => `${title}${c.section ? ` — ${c.section}` : ''}\n\n${c.content}`;

// Embedding requests run in parallel, but writes go through one at a time:
// concurrent inserts into the HNSW vector index deadlock each other.
let writes = Promise.resolve();

/** Replace an article's stored passages and its article vector (serialized across all callers). */
export function writeArticleChunks(
  article: Pick<ArticleFile, 'pageid' | 'revisionId'>,
  items: { chunk: Chunk; vector: number[] }[],
) {
  const run = writes.then(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await writeOnce(article, items);
      } catch (err) {
        if ((err as { code?: string }).code !== 'ER_LOCK_DEADLOCK' || attempt >= 3) throw err;
      }
    }
  });
  writes = run.catch(() => {});
  return run;
}

async function writeOnce(
  article: Pick<ArticleFile, 'pageid' | 'revisionId'>,
  items: { chunk: Chunk; vector: number[] }[],
) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM article_chunks WHERE page_id = ?', [article.pageid]);
    for (const { chunk, vector } of items) {
      await conn.query(
        `INSERT INTO article_chunks (page_id, revision_id, chunk_index, section, content, embedding)
         VALUES (?, ?, ?, ?, ?, VEC_FromText(?))`,
        [chunk.pageId, chunk.revisionId, chunk.index, chunk.section, chunk.content, vectorText(vector)],
      );
    }
    await writeArticleVector(conn, article.pageid, article.revisionId, items.map((it) => it.vector));
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
