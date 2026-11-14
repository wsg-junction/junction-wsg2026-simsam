// The history panel: an article's substantial changes over its recent history.
//
// 1. Scan revision metadata (no content) from the Wikipedia API, up to a few
//    thousand edits back, into article_revisions. Later scans only add newer edits.
// 2. Drop noise: minor edits, bots, reverts and edits that were later reverted
//    (Wikipedia tags those), and small byte changes.
// 3. Fetch the content of the biggest remaining edits and their parents, and
//    store it in the system-versioned article_content table as history rows at
//    the original edit times (system_versioning_insert_history), next to the
//    revisions the ingest replayed.
// 4. Measure what each edit changed in prose, section by section, with moved
//    text discounted, and keep the edits that changed real content.
// 5. Have the AI write an overview and name each change. The report is kept in
//    history_reports until the article gets a newer revision.
import { diffArrays, diffWords } from 'diff';
import type { RowDataPacket } from 'mysql2/promise';
import type { ArticleTimeline, DiffHunk, DiffSegment, HistoryChange, RevisionDiff, SectionChange } from '@simsam/models';
import { aiEnabled, describeTimeline, type TimelineInput } from './ai.js';
import { pool } from './db.js';
import { ACTION_API, wikiFetch } from './wikipedia.js';
import { leadOf, plain, sectionsOf } from './wikitext.js';

/** Revisions of metadata scanned per article (500 per request). */
const MAX_SCAN = 2500;
/** Edits whose content is fetched and measured. */
const CANDIDATES = 18;
/** Substantial changes shown. */
const MAX_CHANGES = 10;
/** Prose words an edit must change (added + removed, moves excluded) to count as substantial. */
const MIN_WORDS = 40;
const REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const NOISE_TAGS = new Set(['mw-reverted', 'mw-rollback', 'mw-undo', 'mw-manual-revert']);
const REVERT_COMMENT = /\b(revert(ed)?|rvv?|undid|undo|rollback|vandal)/i;
const BOT = /bot\b/i;

interface Meta {
  revisionId: number;
  parentId: number;
  at: Date;
  editor: string | null;
  comment: string | null;
  bytes: number;
  minor: boolean;
  tags: string[];
}

const toSql = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '');

// ---------- 1. Revision metadata ----------

async function scanRevisions(pageId: number, signal?: AbortSignal) {
  const [[known]] = await pool.query<RowDataPacket[]>(
    'SELECT MAX(revision_id) AS newest, COUNT(*) AS n FROM article_revisions WHERE page_id = ?',
    [pageId],
  );
  const newest = known?.newest ? Number(known.newest) : 0;
  const haveFullScan = Number(known?.n ?? 0) > 0;
  const fresh: Meta[] = [];
  let cont: Record<string, string> = {};
  // Newest first; stop at what's stored, or at MAX_SCAN on the first scan.
  scan: while (fresh.length < MAX_SCAN) {
    const params = new URLSearchParams({
      action: 'query',
      prop: 'revisions',
      pageids: String(pageId),
      rvprop: 'ids|timestamp|user|comment|size|flags|tags',
      rvlimit: '500',
      format: 'json',
      formatversion: '2',
      ...cont,
    });
    const res = await wikiFetch(`${ACTION_API}?${params}`, signal);
    if (!res.ok) throw new Error(`Wikipedia revisions responded with ${res.status}`);
    const data = (await res.json()) as {
      continue?: Record<string, string>;
      query?: { pages?: { revisions?: Record<string, unknown>[] }[] };
    };
    for (const r of data.query?.pages?.[0]?.revisions ?? []) {
      const revisionId = Number(r.revid);
      if (revisionId <= newest) break scan;
      fresh.push({
        revisionId,
        parentId: Number(r.parentid ?? 0),
        at: new Date(String(r.timestamp)),
        editor: typeof r.user === 'string' ? r.user : null,
        comment: typeof r.comment === 'string' ? r.comment : null,
        bytes: Number(r.size ?? 0),
        minor: r.minor === true,
        tags: Array.isArray(r.tags) ? (r.tags as string[]) : [],
      });
    }
    if (!data.continue || (haveFullScan && fresh.length >= MAX_SCAN)) break;
    cont = data.continue;
  }
  if (fresh.length > 0) {
    await pool.query(
      `INSERT IGNORE INTO article_revisions (revision_id, page_id, parent_id, edited_at, editor, edit_comment, byte_size, minor, tags)
       VALUES ?`,
      [fresh.map((m) => [m.revisionId, pageId, m.parentId || null, toSql(m.at), m.editor, m.comment, m.bytes, m.minor, JSON.stringify(m.tags)])],
    );
  }
  // Everything known, oldest first, capped to the most recent MAX_SCAN.
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT * FROM (
       SELECT revision_id, parent_id, edited_at, editor, edit_comment, byte_size, minor, tags
       FROM article_revisions WHERE page_id = ? ORDER BY revision_id DESC LIMIT ?
     ) recent ORDER BY revision_id`,
    [pageId, MAX_SCAN],
  );
  return rows.map(
    (r): Meta => ({
      revisionId: Number(r.revision_id),
      parentId: Number(r.parent_id ?? 0),
      at: new Date(`${String(r.edited_at instanceof Date ? r.edited_at.toISOString() : r.edited_at).replace(' ', 'T').replace(/Z?$/, 'Z')}`),
      editor: r.editor,
      comment: r.edit_comment,
      bytes: Number(r.byte_size),
      minor: Boolean(r.minor),
      tags: typeof r.tags === 'string' ? (JSON.parse(r.tags) as string[]) : (r.tags as string[]),
    }),
  );
}

// ---------- 2. Candidates ----------

function candidates(revs: Meta[]) {
  const bytesOf = new Map(revs.map((r) => [r.revisionId, r.bytes]));
  return revs
    .filter((r) => r.parentId && bytesOf.has(r.parentId))
    .filter((r) => !r.minor && !BOT.test(r.editor ?? '') && !r.tags.some((t) => NOISE_TAGS.has(t)))
    .filter((r) => !REVERT_COMMENT.test(r.comment ?? ''))
    .map((r) => ({ meta: r, delta: r.bytes - bytesOf.get(r.parentId)! }))
    .filter(({ meta, delta }) => Math.abs(delta) >= Math.max(300, meta.bytes * 0.004))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, CANDIDATES);
}

// ---------- 3. Content, stored as history rows ----------

async function storedTexts(pageId: number, ids: number[]) {
  if (ids.length === 0) return new Map<number, string>();
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT revision_id, wikitext FROM article_content FOR SYSTEM_TIME ALL WHERE page_id = ? AND revision_id IN (?)',
    [pageId, ids],
  );
  return new Map(rows.map((r) => [Number(r.revision_id), String(r.wikitext)]));
}

async function fetchTexts(ids: number[], signal?: AbortSignal) {
  const out = new Map<number, string>();
  for (let i = 0; i < ids.length; i += 50) {
    const params = new URLSearchParams({
      action: 'query',
      prop: 'revisions',
      revids: ids.slice(i, i + 50).join('|'),
      rvprop: 'ids|content',
      rvslots: 'main',
      format: 'json',
      formatversion: '2',
    });
    const res = await wikiFetch(`${ACTION_API}?${params}`, signal);
    if (!res.ok) throw new Error(`Wikipedia content responded with ${res.status}`);
    const data = (await res.json()) as {
      query?: { pages?: { revisions?: { revid: number; slots?: { main?: { content?: string } } }[] }[] };
    };
    for (const page of data.query?.pages ?? []) {
      for (const r of page.revisions ?? []) {
        const text = r.slots?.main?.content;
        if (typeof text === 'string') out.set(r.revid, text);
      }
    }
  }
  return out;
}

/**
 * Store fetched revisions in article_content as history rows at their original
 * times: each row lasts from its edit until the next edit.
 */
async function storeHistoryRows(pageId: number, texts: Map<number, string>, revs: Meta[]) {
  if (texts.size === 0) return;
  const index = new Map(revs.map((r, i) => [r.revisionId, i]));
  const conn = await pool.getConnection();
  try {
    await conn.query('SET @@system_versioning_insert_history = 1');
    for (const [revisionId, wikitext] of texts) {
      const i = index.get(revisionId);
      const next = i === undefined ? undefined : revs[i + 1];
      if (i === undefined || !next) continue; // the newest revision is the current row already
      const meta = revs[i];
      const end = new Date(Math.max(next.at.getTime(), meta.at.getTime() + 1));
      await conn.query(
        `INSERT INTO article_content (page_id, revision_id, parent_revision_id, editor, edit_comment, byte_size, sections, lead, wikitext, row_start, row_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          pageId,
          revisionId,
          meta.parentId || null,
          meta.editor,
          meta.comment,
          Buffer.byteLength(wikitext),
          JSON.stringify(sectionsOf(wikitext)),
          leadOf(wikitext),
          wikitext,
          toSql(meta.at),
          toSql(end),
        ],
      ).catch((err: { code?: string }) => {
        // Two rows may not share an end time; a duplicate is already stored.
        if (err.code !== 'ER_DUP_ENTRY') throw err;
      });
    }
  } finally {
    await conn.query('SET @@system_versioning_insert_history = 0').catch(() => {});
    conn.release();
  }
}

// ---------- 4. What an edit changed ----------

/** Plain text by section ("Lead" before the first heading), each split into sentences. */
function sectionSentences(wikitext: string) {
  const out = new Map<string, string[]>();
  const parts = wikitext.split(/^(={2,6})\s*(.+?)\s*\1\s*$/m);
  // split with two capture groups: [lead, '==', title, body, '==', title, body, ...]
  const add = (title: string, body: string) => {
    const sentences = plain(body)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('|') && !l.startsWith('!') && !l.startsWith('*') && l.length > 1)
      .join(' ')
      .split(/(?<=[.!?])\s+(?=[A-Z0-9"“(])/)
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 2);
    const key = out.has(title) ? `${title} (${out.size})` : title;
    out.set(key, sentences);
  };
  add('Lead', parts[0] ?? '');
  for (let i = 1; i + 2 < parts.length + 1; i += 3) add(plain(parts[i + 1] ?? '').trim() || 'Untitled section', parts[i + 2] ?? '');
  return out;
}

const words = (s: string) => (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;

interface Measured {
  sections: SectionChange[];
  wordsAdded: number;
  wordsRemoved: number;
  addedSample: string;
  removedSample: string;
}

/** Words added and removed per section; sentences that only moved (anywhere in the article) don't count. */
function measure(before: string, after: string): Measured {
  const a = sectionSentences(before);
  const b = sectionSentences(after);
  const allBefore = new Set([...a.values()].flat());
  const allAfter = new Set([...b.values()].flat());
  const sections: SectionChange[] = [];
  const addedSentences: string[] = [];
  const removedSentences: string[] = [];
  for (const title of new Set([...a.keys(), ...b.keys()])) {
    let added = 0;
    let removed = 0;
    const parts = diffArrays(a.get(title) ?? [], b.get(title) ?? []);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part.added && !part.removed) continue;
      const gone = part.removed ? part.value.filter((s) => !allAfter.has(s)) : [];
      const came = (part.removed && parts[i + 1]?.added ? parts[++i].value : part.added ? part.value : []).filter(
        (s) => !allBefore.has(s),
      );
      if (gone.length && came.length) {
        // Sentences rewritten in place: count only the words that changed, so a
        // comma or a reworded phrase doesn't count as a whole new sentence.
        for (const w of diffWords(gone.join(' '), came.join(' '))) {
          if (w.added) added += words(w.value);
          else if (w.removed) removed += words(w.value);
        }
      } else {
        added += came.reduce((n, s) => n + words(s), 0);
        removed += gone.reduce((n, s) => n + words(s), 0);
      }
      addedSentences.push(...came);
      removedSentences.push(...gone);
    }
    if (added + removed > 0) sections.push({ section: title, added, removed });
  }
  sections.sort((x, y) => y.added + y.removed - (x.added + x.removed));
  const sample = (list: string[]) => list.slice(0, 3).join(' ').slice(0, 320);
  return {
    sections,
    wordsAdded: sections.reduce((n, s) => n + s.added, 0),
    wordsRemoved: sections.reduce((n, s) => n + s.removed, 0),
    addedSample: sample(addedSentences),
    removedSample: sample(removedSentences),
  };
}

function plainTitle(c: { sections: SectionChange[]; sectionsAdded: string[]; sectionsRemoved: string[]; wordsAdded: number; wordsRemoved: number }) {
  if (c.sectionsAdded.length) return `Added section “${c.sectionsAdded[0]}”`;
  if (c.sectionsRemoved.length) return `Removed section “${c.sectionsRemoved[0]}”`;
  const top = c.sections[0]?.section ?? 'the article';
  if (c.wordsAdded > 2 * c.wordsRemoved) return `Expanded “${top}”`;
  if (c.wordsRemoved > 2 * c.wordsAdded) return `Cut from “${top}”`;
  return `Rewrote “${top}”`;
}

// ---------- 5. The report ----------

const inFlight = new Map<number, Promise<ArticleTimeline | null>>();

/** The history panel's report for a stored article, or null if it isn't in the corpus. */
export function articleTimeline(title: string, signal?: AbortSignal): Promise<ArticleTimeline | null> {
  return (async () => {
    const [[article]] = await pool.query<RowDataPacket[]>('SELECT page_id, title, url FROM articles WHERE title = ?', [title]);
    if (!article) return null;
    const pageId = Number(article.page_id);
    let pending = inFlight.get(pageId);
    if (!pending) {
      pending = buildTimeline(pageId, String(article.title), String(article.url), signal).finally(() => inFlight.delete(pageId));
      inFlight.set(pageId, pending);
    }
    return pending;
  })();
}

async function buildTimeline(pageId: number, title: string, url: string, signal?: AbortSignal): Promise<ArticleTimeline> {
  // A recent report for the same latest revision is reused (a check for newer edits is cheap).
  const revs = await scanRevisions(pageId, signal);
  const latest = revs[revs.length - 1]?.revisionId ?? 0;
  const [[cached]] = await pool.query<RowDataPacket[]>('SELECT latest_revision_id, report, created_at FROM history_reports WHERE page_id = ?', [pageId]);
  if (cached && Number(cached.latest_revision_id) === latest && Date.now() - new Date(cached.created_at).getTime() < REPORT_TTL_MS) {
    return (typeof cached.report === 'string' ? JSON.parse(cached.report) : cached.report) as ArticleTimeline;
  }

  const picked = candidates(revs);
  const ids = [...new Set(picked.flatMap(({ meta }) => [meta.revisionId, meta.parentId]))];
  const texts = await storedTexts(pageId, ids);
  const missing = ids.filter((id) => !texts.has(id));
  const fetched = await fetchTexts(missing, signal);
  await storeHistoryRows(pageId, fetched, revs);
  for (const [id, t] of fetched) texts.set(id, t);

  const measured = picked
    .map(({ meta }) => {
      const before = texts.get(meta.parentId);
      const after = texts.get(meta.revisionId);
      if (before === undefined || after === undefined) return null;
      const m = measure(before, after);
      const was = new Set(sectionsOf(before).map((s) => s.title));
      const now = new Set(sectionsOf(after).map((s) => s.title));
      return {
        meta,
        before: Buffer.byteLength(before),
        ...m,
        sectionsAdded: [...now].filter((s) => !was.has(s)),
        sectionsRemoved: [...was].filter((s) => !now.has(s)),
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null)
    // Substantial: real prose changed, or a whole section with some prose came or went.
    .filter((m) => m.wordsAdded + m.wordsRemoved >= MIN_WORDS || ((m.sectionsAdded.length || m.sectionsRemoved.length) && m.wordsAdded + m.wordsRemoved >= 15))
    .sort((x, y) => y.wordsAdded + y.wordsRemoved - (x.wordsAdded + x.wordsRemoved))
    .slice(0, MAX_CHANGES)
    .sort((x, y) => x.meta.at.getTime() - y.meta.at.getTime());

  const changes: HistoryChange[] = measured.map((m, i) => ({
    n: i + 1,
    revisionId: m.meta.revisionId,
    parentId: m.meta.parentId,
    at: m.meta.at.toISOString(),
    editor: m.meta.editor,
    comment: m.meta.comment,
    bytesBefore: m.before,
    bytesAfter: m.meta.bytes,
    wordsAdded: m.wordsAdded,
    wordsRemoved: m.wordsRemoved,
    sections: m.sections.slice(0, 8),
    sectionsAdded: m.sectionsAdded,
    sectionsRemoved: m.sectionsRemoved,
    title: '',
    summary: '',
    diffUrl: `https://en.wikipedia.org/w/index.php?diff=${m.meta.revisionId}&oldid=${m.meta.parentId}`,
  }));
  for (const c of changes) {
    c.title = plainTitle(c);
    const where = c.sections.slice(0, 3).map((s) => s.section).join(', ');
    c.summary = `${c.wordsAdded} words added and ${c.wordsRemoved} removed, in ${where || 'the article'}.${c.comment ? ` Edit summary: “${c.comment.slice(0, 120)}”.` : ''}`;
  }

  const from = revs[0]?.at.toISOString() ?? new Date().toISOString();
  const to = revs[revs.length - 1]?.at.toISOString() ?? from;
  let overview: string | null = null;
  if (aiEnabled && changes.length > 0) {
    const input: TimelineInput[] = changes.map((c, i) => ({
      n: c.n,
      at: c.at,
      editor: c.editor,
      comment: c.comment,
      sections: c.sections,
      sectionsAdded: c.sectionsAdded,
      sectionsRemoved: c.sectionsRemoved,
      addedSample: measured[i].addedSample,
      removedSample: measured[i].removedSample,
    }));
    const described = await describeTimeline(title, from, to, input, signal).catch(() => null);
    if (described) {
      overview = described.overview;
      for (const c of changes) {
        const d = described.byN.get(c.n);
        if (d) Object.assign(c, d);
      }
    }
  }

  // Size over time, thinned to at most ~240 points.
  const step = Math.max(1, Math.ceil(revs.length / 240));
  const sizes = revs.filter((_, i) => i % step === 0 || i === revs.length - 1).map((r) => ({ at: r.at.toISOString(), bytes: r.bytes }));

  const report: ArticleTimeline = { title, pageId, url, scanned: revs.length, from, to, sizes, changes, overview };
  await pool.query(
    `INSERT INTO history_reports (page_id, latest_revision_id, report, created_at) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE latest_revision_id = VALUES(latest_revision_id), report = VALUES(report), created_at = VALUES(created_at)`,
    [pageId, latest, JSON.stringify(report), toSql(new Date())],
  );
  return report;
}

// ---------- Diff ----------

const MAX_HUNKS = 14;
const CONTEXT = 1;
const clipText = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** What one edit added and removed, from the two versions stored in article_content. */
export async function revisionDiff(pageId: number, revisionId: number): Promise<RevisionDiff | null> {
  const [[row]] = await pool.query<RowDataPacket[]>(
    'SELECT parent_revision_id FROM article_content FOR SYSTEM_TIME ALL WHERE page_id = ? AND revision_id = ? LIMIT 1',
    [pageId, revisionId],
  );
  if (!row?.parent_revision_id) return null;
  const parentId = Number(row.parent_revision_id);
  const texts = await storedTexts(pageId, [revisionId, parentId]);
  const before = texts.get(parentId);
  const after = texts.get(revisionId);
  if (before === undefined || after === undefined) return null;

  const a = sectionSentences(before);
  const b = sectionSentences(after);
  const allBefore = new Set([...a.values()].flat());
  const allAfter = new Set([...b.values()].flat());
  const hunks: DiffHunk[] = [];
  let truncated = false;

  for (const section of new Set([...a.keys(), ...b.keys()])) {
    const parts = diffArrays(a.get(section) ?? [], b.get(section) ?? []);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part.added && !part.removed) continue;
      // A removed block followed by an added one is a rewrite: show it word by word.
      const removed = part.removed ? part.value.filter((s) => !allAfter.has(s)) : [];
      const nextAdded = part.removed && parts[i + 1]?.added ? parts[++i].value : part.added ? part.value : [];
      const added = nextAdded.filter((s) => !allBefore.has(s));
      if (removed.length === 0 && added.length === 0) continue; // only moved
      if (hunks.length >= MAX_HUNKS) {
        truncated = true;
        break;
      }
      const segments: DiffSegment[] = [];
      const prev = parts.slice(0, i).reverse().find((p) => !p.added && !p.removed);
      if (prev) segments.push({ type: 'same', text: `${clipText(prev.value.slice(-CONTEXT).join(' '), 240)} ` });
      if (removed.length && added.length) {
        for (const w of diffWords(removed.join(' '), added.join(' '))) {
          segments.push({ type: w.added ? 'added' : w.removed ? 'removed' : 'same', text: w.value });
        }
      } else if (removed.length) {
        segments.push({ type: 'removed', text: clipText(removed.join(' '), 1600) });
      } else {
        segments.push({ type: 'added', text: clipText(added.join(' '), 1600) });
      }
      const next = parts.slice(i + 1).find((p) => !p.added && !p.removed);
      if (next) segments.push({ type: 'same', text: ` ${clipText(next.value.slice(0, CONTEXT).join(' '), 240)}` });
      hunks.push({ section, segments });
    }
    if (truncated) break;
  }
  return { revisionId, parentId, hunks, truncated };
}
