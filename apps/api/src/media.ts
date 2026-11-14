// Figures of articles in MariaDB (article_media): the infobox and data tables
// parsed from the wikitext, and images read once by the vision model (charts,
// maps, diagrams, photos). Each figure is embedded, so search and Deep Research
// can find what a chart or map shows, not just what the prose says.
//
// Figures are read lazily (the first time Deep Research looks at an article)
// or in bulk by `npm run ingest -w api -- --media`.
import type { RowDataPacket } from 'mysql2/promise';
import type { MediaKind } from '@simsam/models';
import { aiEnabled, readFigure, VISION_MODEL } from './ai.js';
import { pool } from './db.js';
import { embedCached, embeddingsEnabled, embedSkippingRejected, vectorText } from './embeddings.js';
import { fetchArticleFigures, imageUrl, wikiFetch, type ArticleFigures } from './wikipedia.js';

/** Images per article sent to the vision model: the likeliest charts and maps first. */
export const MAX_IMAGES = 4;
/** The NVIDIA catalog takes inline images up to about 180 KB. */
const MAX_IMAGE_BYTES = 180_000;

export interface Figure {
  id: number;
  pageId: number;
  title: string;
  kind: MediaKind;
  caption: string | null;
  imageUrl: string | null;
  content: string;
  /** Cosine distance to the query, when ranked by one. */
  distance?: number;
}

const ICONISH = /(flag|coat[ _]of[ _]arms|logo|icon|signature|seal of|emblem|symbol|wiki|commons|question[ _]book|ambox|edit-clear|padlock|crystal[ _]clear|nuvola|portal|blank|placeholder|stub)/i;
const FIGURE_HINT = /(map|chart|graph|plot|diagram|population|gdp|statistic|growth|election|results?\b|distribution|front|campaign|territor|border|location|timeline|demograph|casualt|losses|production|economy|trade|census|share|percent|scheme|structure|layout|plan of|movements?|offensive|situation|division)/i;

/** The images worth reading: likely charts and maps first; photos only when there's nothing else. */
export function pickImages(figures: ArticleFigures, max = MAX_IMAGES) {
  const scored = figures.images
    .filter((img) => !ICONISH.test(img.file))
    .map((img, i) => ({
      img,
      i,
      score:
        (FIGURE_HINT.test(img.file) ? 3 : 0) +
        (FIGURE_HINT.test(img.caption) ? 2 : 0) +
        (/\.(svg|png|gif)$/i.test(img.file) ? 1 : 0),
    }));
  const likely = scored.filter((s) => s.score >= 2).sort((a, b) => b.score - a.score || a.i - b.i);
  return (likely.length ? likely : scored.slice(0, 1)).slice(0, max).map((s) => s.img);
}

/** The image as a data URL small enough to send inline. */
async function imageData(file: string, signal?: AbortSignal) {
  for (const width of [640, 400]) {
    const res = await wikiFetch(imageUrl(file, width), signal);
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.startsWith('image/') || type.includes('svg')) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length <= MAX_IMAGE_BYTES) return `data:${type.split(';')[0]};base64,${bytes.toString('base64')}`;
  }
  return null;
}

const KIND_LABEL: Record<MediaKind, string> = {
  chart: 'Chart',
  map: 'Map',
  diagram: 'Diagram',
  photo: 'Image',
  infobox: 'Infobox',
  table: 'Table',
};
export const kindLabel = (kind: MediaKind) => KIND_LABEL[kind];

/** What gets embedded for a figure. */
const embedText = (title: string, kind: MediaKind, caption: string | null, content: string) =>
  `${title}: ${KIND_LABEL[kind]}${caption ? `, ${caption}` : ''}\n${content}`.slice(0, 2400);

// Concurrent inserts into one HNSW index deadlock: this process writes one at a time.
let writer = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = writer.then(fn);
  writer = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function withDeadlockRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // Another process (the ingest) writing the same index at the same time.
      if ((err as { errno?: number }).errno !== 1213 || attempt >= 3) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200 * (attempt + 1)));
    }
  }
}

interface NewFigure {
  sourceKey: string;
  kind: MediaKind;
  imageUrl: string | null;
  caption: string | null;
  content: string;
  model: string | null;
}

const running = new Map<string, Promise<number>>();

/**
 * Read an article's figures into article_media, once per revision (images
 * already read for an earlier revision aren't sent to the vision model again).
 * Returns how many figures the article has stored. Without AI only the infobox
 * and tables are stored, and the article is read again once AI is available.
 */
export function ensureMedia(title: string, signal?: AbortSignal): Promise<number> {
  const key = title.toLowerCase();
  let run = running.get(key);
  if (!run) {
    run = readMedia(title, signal).finally(() => running.delete(key));
    running.set(key, run);
  }
  return run;
}

async function readMedia(title: string, signal?: AbortSignal): Promise<number> {
  if (!embeddingsEnabled) return 0;
  const figures = await fetchArticleFigures(title, signal);
  if (!figures) return 0;
  const [[scan]] = await pool.query<RowDataPacket[]>('SELECT revision_id, figures FROM article_media_scans WHERE page_id = ?', [
    figures.pageId,
  ]);
  if (scan && Number(scan.revision_id) === figures.revisionId) return Number(scan.figures);

  const [existingRows] = await pool.query<RowDataPacket[]>(
    'SELECT source_key, kind, caption, content, model FROM article_media WHERE page_id = ?',
    [figures.pageId],
  );
  const existing = new Map(existingRows.map((r) => [String(r.source_key), r]));

  const wanted: NewFigure[] = [];
  if (figures.infobox) {
    wanted.push({ sourceKey: 'infobox', kind: 'infobox', imageUrl: null, caption: figures.infobox.type, content: figures.infobox.text, model: null });
  }
  figures.tables.forEach((t, i) =>
    wanted.push({ sourceKey: `table ${i + 1}`, kind: 'table', imageUrl: null, caption: t.caption, content: t.text, model: null }),
  );
  let complete = true;
  const images = pickImages(figures);
  const toRead = images.filter((img) => !existing.has(`file:${img.file}`));
  for (const img of images) {
    const old = existing.get(`file:${img.file}`);
    if (old) {
      wanted.push({ sourceKey: `file:${img.file}`, kind: old.kind, imageUrl: imageUrl(img.file, 960), caption: img.caption || null, content: old.content, model: old.model });
    }
  }
  if (toRead.length > 0 && !aiEnabled) complete = false;
  if (aiEnabled) {
    const read = await Promise.all(
      toRead.map(async (img) => {
        try {
          const dataUrl = await imageData(img.file, signal);
          if (!dataUrl) return null;
          const seen = await readFigure({ dataUrl, caption: img.caption, article: figures.title }, signal);
          return seen
            ? ({ sourceKey: `file:${img.file}`, kind: seen.kind, imageUrl: imageUrl(img.file, 960), caption: img.caption || null, content: seen.text, model: VISION_MODEL } satisfies NewFigure)
            : null;
        } catch (err) {
          if (signal?.aborted) throw err;
          // A failed image is retried on the next scan.
          complete = false;
          return null;
        }
      }),
    );
    for (const f of read) if (f) wanted.push(f);
  }

  const vectors = await embedSkippingRejected(
    wanted.map((f) => embedText(figures.title, f.kind, f.caption, f.content)),
    'passage',
    signal,
  );
  const keep = wanted.map((f, i) => ({ f, v: vectors[i] })).filter((x): x is { f: NewFigure; v: number[] } => x.v !== null);

  await serialized(() =>
    withDeadlockRetry(async () => {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        await conn.query('DELETE FROM article_media WHERE page_id = ?', [figures.pageId]);
        for (const [position, { f, v }] of keep.entries()) {
          await conn.query(
            `INSERT INTO article_media (page_id, title, revision_id, position, source_key, kind, image_url, caption, content, model, embedding, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, VEC_FromText(?), UTC_TIMESTAMP())`,
            [figures.pageId, figures.title, figures.revisionId, position, f.sourceKey.slice(0, 255), f.kind, f.imageUrl, f.caption, f.content, f.model, vectorText(v)],
          );
        }
        if (complete) {
          await conn.query(
            `INSERT INTO article_media_scans (page_id, revision_id, figures, scanned_at) VALUES (?, ?, ?, UTC_TIMESTAMP())
             ON DUPLICATE KEY UPDATE revision_id = VALUES(revision_id), figures = VALUES(figures), scanned_at = VALUES(scanned_at)`,
            [figures.pageId, figures.revisionId, keep.length],
          );
        }
        await conn.commit();
      } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
      } finally {
        conn.release();
      }
    }),
  );
  mediaPresent = null;
  return keep.length;
}

const toFigure = (r: RowDataPacket): Figure => ({
  id: Number(r.id),
  pageId: Number(r.page_id),
  title: String(r.title),
  kind: r.kind as MediaKind,
  caption: r.caption ?? null,
  imageUrl: r.image_url ?? null,
  content: String(r.content),
  distance: r.distance === undefined ? undefined : Number(r.distance),
});

/** An article's stored figures, closest to `query` first (or in article order). */
export async function articleFigures(title: string, query?: string, limit = 4): Promise<Figure[]> {
  const vector = query ? (await embedCached([query], 'query', AbortSignal.timeout(6_000)).catch(() => [null]))[0] : null;
  const [rows] = vector
    ? await pool.query<RowDataPacket[]>(
        `SELECT *, VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) AS distance FROM article_media
         WHERE title = ? ORDER BY distance LIMIT ?`,
        [vectorText(vector), title, limit],
      )
    : await pool.query<RowDataPacket[]>('SELECT * FROM article_media WHERE title = ? ORDER BY position LIMIT ?', [title, limit]);
  return rows.map(toFigure);
}

let mediaPresent: Promise<boolean> | null = null;
/** Whether any figures are stored (re-checked every minute). */
function mediaAvailable() {
  mediaPresent ??= pool
    .query<RowDataPacket[]>('SELECT 1 FROM article_media LIMIT 1')
    .then(([rows]) => rows.length > 0)
    .catch(() => false);
  setTimeout(() => (mediaPresent = null), 60_000).unref();
  return mediaPresent;
}

/** Figures of stored articles nearest to a query vector (vector index), for search. */
export async function nearestFigures(vector: number[], limit: number): Promise<Figure[]> {
  if (!(await mediaAvailable())) return [];
  const v = vectorText(vector);
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT m.*, VEC_DISTANCE_COSINE(m.embedding, VEC_FromText(?)) AS distance
     FROM article_media m JOIN articles a USING (page_id)
     ORDER BY VEC_DISTANCE_COSINE(m.embedding, VEC_FromText(?)) LIMIT ?`,
    [v, v, limit],
  );
  return rows.map(toFigure);
}

/** A figure as a one-line search snippet. */
export const figureSnippet = (f: Figure) => {
  const text = `${KIND_LABEL[f.kind]}${f.caption ? ` (${f.caption})` : ''}: ${f.content.replace(/\s+/g, ' ')}`;
  return text.length > 220 ? `${text.slice(0, 217).trimEnd()}…` : text;
};
