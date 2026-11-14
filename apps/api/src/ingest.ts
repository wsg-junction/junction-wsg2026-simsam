/**
 * Load the collected Wikipedia articles (data/wikipedia-en, see scripts/) into
 * MariaDB:
 *
 *   articles         metadata and current plain text
 *   article_content  system-versioned content: each article's revisions are
 *                    replayed at their original edit times (SET timestamp), so
 *                    the table's history is the article's Wikipedia history
 *   article_chunks   passages of the current text with VECTOR embeddings
 *   article_vectors  one vector per article (mean of its passages), for the topic map
 *
 * Usage (from the repo root):
 *   npm run ingest -w api                       # everything
 *   npm run ingest -w api -- --limit 50         # a trial run
 *   npm run ingest -w api -- --skip-embeddings  # tables and history only
 *   npm run ingest -w api -- --article-vectors  # only fill article_vectors from stored passages
 *   npm run ingest -w api -- --media            # only read figures into article_media (vision model)
 *   npm run ingest -w api -- --media --limit 50 # figures of a few articles
 *   npm run ingest -w api -- --data path/to/wikipedia-en
 *
 * It's resumable: articles whose current revision is already stored are
 * skipped, and chunks are only embedded for articles that don't have them yet.
 */
import './env.js';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { migrate, pool } from './db.js';
import { backfillArticleVectors, writeArticleVector } from './articleVectors.js';
import { embedSkippingRejected, vectorText } from './embeddings.js';
import { leadOf, sectionsOf } from './wikitext.js';
import { aiEnabled } from './ai.js';
import { ensureMedia, MAX_IMAGES } from './media.js';

interface Revision {
  revid: number;
  parentid?: number;
  user?: string;
  timestamp: string;
  comment?: string;
  slots?: { main?: { content?: string } };
}

interface ArticleFile {
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

// ---------- Options ----------

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const dataDir = path.resolve(repoRoot, option('data') ?? 'data/wikipedia-en');
const limit = option('limit') ? Number(option('limit')) : Infinity;
const skipEmbeddings = flag('skip-embeddings');

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

async function storeArticle(article: ArticleFile) {
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

interface Chunk {
  pageId: number;
  revisionId: number;
  index: number;
  section: string | null;
  content: string;
}

/** Split the plain text into passages of about CHUNK_CHARS, never across sections. */
function chunksOf(article: ArticleFile): Chunk[] {
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
const embeddingInput = (title: string, c: Chunk) => `${title}${c.section ? ` — ${c.section}` : ''}\n\n${c.content}`;

async function embedPending(articles: ArticleFile[]) {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT page_id, MAX(revision_id) AS revision_id FROM article_chunks GROUP BY page_id',
  );
  const done = new Map(rows.map((r) => [Number(r.page_id), Number(r.revision_id)]));
  const pending = articles.filter((a) => done.get(a.pageid) !== a.revisionId && !a.isDisambiguation);
  console.log(`Embedding ${pending.length} articles (${articles.length - pending.length} already done)…`);

  const BATCH = 48;
  const CONCURRENCY = 3;
  let embeddedArticles = 0;
  let embeddedChunks = 0;
  let skippedChunks = 0;
  let failedArticles = 0;
  const rejectedTitles = new Set<string>();
  const started = Date.now();

  // Embedding requests run in parallel, but writes go through one at a time:
  // concurrent inserts into the HNSW vector index deadlock each other.
  let writes = Promise.resolve();
  function writeArticleChunks(article: ArticleFile, items: { chunk: Chunk; vector: number[] }[]) {
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

  async function writeOnce(article: ArticleFile, items: { chunk: Chunk; vector: number[] }[]) {
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

  // Embed article by article (so a crash leaves whole articles, never half of one),
  // but batch several articles' chunks into each request.
  let next = 0;
  async function worker() {
    while (next < pending.length) {
      const group: ArticleFile[] = [];
      let size = 0;
      while (next < pending.length && size < BATCH) {
        const a = pending[next++];
        group.push(a);
        size += Math.max(1, chunksOf(a).length);
      }
      const items = group.flatMap((a) => chunksOf(a).map((chunk) => ({ article: a, chunk })));
      if (items.length === 0) continue;
      try {
        const vectors: (number[] | null)[] = [];
        for (let i = 0; i < items.length; i += BATCH) {
          const slice = items.slice(i, i + BATCH);
          vectors.push(
            ...(await embedSkippingRejected(slice.map((it) => embeddingInput(it.article.title, it.chunk)), 'passage')),
          );
        }
        // Passages the API's content screening rejected are left out; the rest of the article is stored.
        const rejected = items.filter((_, i) => vectors[i] === null);
        if (rejected.length) {
          skippedChunks += rejected.length;
          for (const t of new Set(rejected.map((it) => it.article.title))) rejectedTitles.add(t);
        }
        for (const a of group) {
          const mine = items
            .map((it, i) => ({ ...it, vector: vectors[i] }))
            .filter((it): it is typeof it & { vector: number[] } => it.article === a && it.vector !== null);
          if (mine.length) await writeArticleChunks(a, mine);
        }
        embeddedChunks += items.length - rejected.length;
      } catch (err) {
        // Don't let one bad batch end the run: these articles are retried next time.
        failedArticles += group.length;
        process.stdout.write(`\n  Skipped ${group.length} articles (${group[0].title}…): ${(err as Error).message}\n`);
      }
      embeddedArticles += group.length;
      const rate = embeddedArticles / ((Date.now() - started) / 1000);
      process.stdout.write(
        `\r  ${embeddedArticles}/${pending.length} articles, ${embeddedChunks} chunks, ` +
          `~${Math.round((pending.length - embeddedArticles) / Math.max(rate, 0.01) / 60)} min left   `,
      );
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write('\n');
  if (skippedChunks) {
    console.log(
      `${skippedChunks} passages were rejected by the embedding API's content screening and left out, from: ` +
        `${[...rejectedTitles].slice(0, 20).join(', ')}${rejectedTitles.size > 20 ? `, and ${rejectedTitles.size - 20} more` : ''}.`,
    );
  }
  if (failedArticles) console.log(`${failedArticles} articles failed and will be retried on the next run.`);
}

// ---------- Figures ----------

/**
 * Read every stored article's figures into article_media: the infobox and data
 * tables from the wikitext, and up to MAX_IMAGES images (likely charts and maps
 * first) through the vision model, once each. Resumable: articles whose current
 * revision was already scanned are skipped.
 */
async function ingestMedia() {
  if (!aiEnabled) console.log('No AI configured (NVIDIA_API_KEY or NVIDIA_BASE_URL): storing infoboxes and tables only.');
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT a.title FROM articles a JOIN article_content c USING (page_id)
     LEFT JOIN article_media_scans s ON s.page_id = a.page_id
     WHERE s.page_id IS NULL OR s.revision_id <> c.revision_id
     ORDER BY a.page_id`,
  );
  const titles = rows.map((r) => String(r.title)).slice(0, limit);
  console.log(`Reading the figures of ${titles.length} articles (up to ${MAX_IMAGES} images each through the vision model).`);
  let done = 0;
  let figures = 0;
  let failed = 0;
  const started = Date.now();
  let next = 0;
  const worker = async () => {
    while (next < titles.length) {
      const title = titles[next++];
      try {
        figures += await ensureMedia(title, AbortSignal.timeout(180_000));
      } catch (err) {
        failed++;
        process.stdout.write(`\n  ${title}: ${(err as Error).message.slice(0, 200)}\n`);
      }
      done++;
      const rate = done / ((Date.now() - started) / 1000);
      process.stdout.write(
        `\r  ${done}/${titles.length} articles, ${figures} figures, ~${Math.round((titles.length - done) / Math.max(rate, 0.01) / 60)} min left   `,
      );
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  process.stdout.write('\n');
  if (failed) console.log(`${failed} articles failed and will be retried on the next run.`);
}

// ---------- Main ----------

async function main() {
  await migrate();
  if (flag('article-vectors')) {
    const n = await backfillArticleVectors();
    console.log(n ? `Stored ${n} article vectors.` : 'Every embedded article already has its article vector.');
    await pool.end();
    return;
  }
  if (flag('media')) {
    await ingestMedia();
    await pool.end();
    return;
  }
  const files = (await readdir(path.join(dataDir, 'articles'))).filter((f) => f.endsWith('.json')).sort();
  const selected = files.slice(0, limit);
  console.log(`Reading ${selected.length} of ${files.length} articles from ${dataDir}`);

  const articles: ArticleFile[] = [];
  let revisionsWritten = 0;
  let skipped = 0;
  const started = Date.now();
  for (const [i, file] of selected.entries()) {
    const article = JSON.parse(await readFile(path.join(dataDir, 'articles', file), 'utf8')) as ArticleFile;
    const written = await storeArticle(article);
    revisionsWritten += written;
    if (written === 0) skipped++;
    // Embedding only needs the title, revision and plain text: keep just those,
    // so memory stays small however many articles there are.
    articles.push({
      pageid: article.pageid,
      title: article.title,
      revisionId: article.revisionId,
      text: article.text,
      isDisambiguation: article.isDisambiguation,
    } as ArticleFile);
    if ((i + 1) % 50 === 0 || i === selected.length - 1) {
      process.stdout.write(
        `\r  ${i + 1}/${selected.length} articles, ${revisionsWritten} revisions written, ${skipped} already current   `,
      );
    }
  }
  process.stdout.write('\n');
  console.log(`History stored in ${Math.round((Date.now() - started) / 1000)} s.`);

  if (skipEmbeddings) console.log('Skipping embeddings (--skip-embeddings).');
  else await embedPending(articles);
  // Articles embedded before article vectors existed (or by an older run).
  await backfillArticleVectors();

  const [[counts]] = await pool.query<RowDataPacket[]>(
    `SELECT (SELECT COUNT(*) FROM articles) AS articles,
            (SELECT COUNT(*) FROM article_content FOR SYSTEM_TIME ALL) AS versions,
            (SELECT COUNT(*) FROM article_chunks) AS chunks`,
  );
  console.log(`Database now holds ${counts.articles} articles, ${counts.versions} content versions, ${counts.chunks} embedded chunks.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
