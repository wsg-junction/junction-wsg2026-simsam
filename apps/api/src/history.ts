// How has this article changed? Read every stored version of an article from
// the system-versioned article_content table, measure what each edit changed,
// pick the important ones, and have the model write a timeline of them.
import type { RowDataPacket } from 'mysql2/promise';
import type { ArticleChange, ArticleHistory, Brief } from '@simsam/models';
import { aiEnabled, completeBrief } from './ai.js';
import { pool } from './db.js';
import type { Section } from './wikitext.js';

const MAX_CHANGES = 8;

interface Version {
  revisionId: number;
  parentId: number | null;
  editor: string | null;
  comment: string | null;
  bytes: number;
  sections: Section[];
  lead: string;
  at: Date;
}

const words = (text: string) => new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** 0 when two texts use the same words, 1 when they share none. */
function difference(a: string, b: string) {
  const wa = words(a);
  const wb = words(b);
  if (wa.size === 0 && wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return 1 - shared / (wa.size + wb.size - shared);
}

const REVERT = /\b(revert|reverted|undid|undo|rv|rvv|vandal|restor)/i;
const ROUTINE = /\b(bot|typo|copyedit|ce\b|formatting|dashes|citation bot|ref(?:s)? fix|link fix|cleanup|clean up|category|interwiki|wikidata|tagging|archive)/i;

const formatBytes = (n: number) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)} kB` : `${n} bytes`);

function describe(c: Omit<ArticleChange, 'n' | 'summary'>) {
  const parts: string[] = [];
  const delta = c.bytesAfter - c.bytesBefore;
  parts.push(delta === 0 ? 'Same size' : `${delta > 0 ? '+' : '−'}${formatBytes(Math.abs(delta))}`);
  if (c.sectionsAdded.length) parts.push(`added sections ${c.sectionsAdded.map((s) => `“${s}”`).join(', ')}`);
  if (c.sectionsRemoved.length) parts.push(`removed sections ${c.sectionsRemoved.map((s) => `“${s}”`).join(', ')}`);
  if (c.leadChange >= 0.15) parts.push(`rewrote ${Math.round(c.leadChange * 100)}% of the lead`);
  if (c.comment) parts.push(`summary: “${c.comment.slice(0, 160)}”`);
  return parts.join('; ');
}

/** How much an edit matters for the article's story. */
function importance(c: Omit<ArticleChange, 'n' | 'summary'>) {
  const delta = Math.abs(c.bytesAfter - c.bytesBefore);
  let score = Math.log2(1 + delta / 40);
  score += 2.5 * Math.min(4, c.sectionsAdded.length + c.sectionsRemoved.length);
  score += 6 * c.leadChange;
  if (c.comment && REVERT.test(c.comment)) score *= 0.4;
  else if ((c.comment && ROUTINE.test(c.comment)) || /bot$/i.test(c.editor ?? '')) score *= 0.35;
  return score;
}

async function loadVersions(title: string) {
  const [[article]] = await pool.query<RowDataPacket[]>('SELECT page_id, title, url FROM articles WHERE title = ?', [title]);
  if (!article) return null;
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT revision_id, parent_revision_id, editor, edit_comment, byte_size, sections, lead, ROW_START AS at
     FROM article_content FOR SYSTEM_TIME ALL
     WHERE page_id = ?
     ORDER BY ROW_START`,
    [article.page_id],
  );
  const versions: Version[] = rows.map((r) => ({
    revisionId: Number(r.revision_id),
    parentId: r.parent_revision_id === null ? null : Number(r.parent_revision_id),
    editor: r.editor,
    comment: r.edit_comment || null,
    bytes: Number(r.byte_size),
    sections: typeof r.sections === 'string' ? JSON.parse(r.sections) : r.sections,
    lead: r.lead,
    at: r.at as Date,
  }));
  return { pageId: Number(article.page_id), title: String(article.title), url: String(article.url), versions };
}

function changesBetween(versions: Version[]) {
  const all = versions.slice(1).map((cur, i) => {
    const prev = versions[i];
    const before = new Set(prev.sections.map((s) => s.title));
    const after = new Set(cur.sections.map((s) => s.title));
    const change = {
      revisionId: cur.revisionId,
      at: cur.at.toISOString(),
      editor: cur.editor,
      comment: cur.comment,
      bytesBefore: prev.bytes,
      bytesAfter: cur.bytes,
      sectionsAdded: [...after].filter((s) => !before.has(s)),
      sectionsRemoved: [...before].filter((s) => !after.has(s)),
      leadChange: Math.round(difference(prev.lead, cur.lead) * 100) / 100,
      url: `https://en.wikipedia.org/w/index.php?oldid=${cur.revisionId}`,
      diffUrl: `https://en.wikipedia.org/w/index.php?diff=${cur.revisionId}&oldid=${prev.revisionId}`,
    };
    return { change, score: importance(change) };
  });
  // Small edits with no summary, sections or lead changes score below this.
  const important = all.filter((c) => c.score > 1.5);
  // An article whose stored edits are all small still gets its biggest few, so there's something to show.
  const picked = important.length > 0 ? important : all.filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 3);
  // The most important edits, back in the order they happened.
  return picked
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CHANGES)
    .sort((a, b) => a.change.at.localeCompare(b.change.at))
    .map(({ change }, i): ArticleChange => ({ ...change, n: i + 1, summary: describe(change) }));
}

const HISTORY_SYSTEM = `You explain how a Wikipedia article has changed over time, from data about its most important edits. Reply with JSON only, no prose around it, matching:

{
  "layout": "timeline",
  "headline": string,
  "events": [{ "year": number, "when": string, "title": string, "detail": string, "sources": number[] }],
  "points": []
}

Rules:
- headline: one sentence of at most 30 words on how the article evolved over the period covered (for example grew, was restructured, had its lead rewritten), ending with citations like [2][5].
- events: one per important edit, in chronological order, 3 to 8 of them; skip edits that only fix formatting. year is the year of the edit; when reads like "14 March 2017". title: at most 8 words naming what changed (e.g. "History section added", "Lead rewritten"). detail: one sentence of at most 30 words on what changed, and why if the edit summary says so.
- sources: a JSON array with the number of the edit the event describes, e.g. [3].
- Use only the data given. Don't invent content the edits don't show. Plain text, no markdown.`;

function promptFor(title: string, versions: Version[], changes: ArticleChange[]) {
  const first = versions[0];
  const last = versions[versions.length - 1];
  const lines = [
    `Article: ${title}`,
    `Stored versions: ${versions.length}, from ${first.at.toISOString().slice(0, 10)} to ${last.at.toISOString().slice(0, 10)}.`,
    `Size went from ${formatBytes(first.bytes)} to ${formatBytes(last.bytes)}.`,
    `Sections at the start: ${first.sections.map((s) => s.title).join(', ') || 'none'}.`,
    `Sections now: ${last.sections.map((s) => s.title).join(', ') || 'none'}.`,
    '',
    'Important edits:',
  ];
  for (const c of changes) {
    lines.push(`[${c.n}] ${c.at.slice(0, 10)} by ${c.editor ?? 'unknown'}: ${c.summary}`);
    if (c.leadChange >= 0.15) {
      const i = versions.findIndex((v) => v.revisionId === c.revisionId);
      lines.push(`    Lead before: ${versions[i - 1].lead.slice(0, 400)}`);
      lines.push(`    Lead after: ${versions[i].lead.slice(0, 400)}`);
    }
  }
  lines.push('', 'JSON:');
  return lines.join('\n');
}

/** Without AI: the same timeline, written from the measurements alone. */
function plainBrief(title: string, versions: Version[], changes: ArticleChange[]): Brief {
  const first = versions[0];
  const last = versions[versions.length - 1];
  const grew = last.bytes - first.bytes;
  if (versions.length === 1 || changes.length === 0) {
    const when = last.at.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    return {
      layout: 'points',
      headline:
        versions.length === 1
          ? `Only one version of “${title}” is stored, from ${when}, so the collection has no changes to compare.`
          : `“${title}” barely changed across its ${versions.length} stored versions: the edits only fixed small details.`,
      events: [],
      points: [],
    };
  }
  const headline =
    `Across ${versions.length} stored versions from ${first.at.getUTCFullYear()} to ${last.at.getUTCFullYear()}, ` +
    `“${title}” ${grew >= 0 ? 'grew' : 'shrank'} from ${formatBytes(first.bytes)} to ${formatBytes(last.bytes)}` +
    (changes.length ? ` [${changes.map((c) => c.n).slice(0, 3).join('][')}].` : '.');
  const events = changes.map((c) => ({
    year: new Date(c.at).getUTCFullYear(),
    when: new Date(c.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
    title: c.sectionsAdded.length
      ? `Added ${c.sectionsAdded[0]}`
      : c.sectionsRemoved.length
        ? `Removed ${c.sectionsRemoved[0]}`
        : c.leadChange >= 0.15
          ? 'Lead rewritten'
          : c.bytesAfter >= c.bytesBefore
            ? 'Content expanded'
            : 'Content cut',
    detail: c.summary,
    sources: [c.n],
  }));
  return events.length >= 3
    ? { layout: 'timeline', headline, events, points: [] }
    : {
        layout: 'points',
        headline,
        events: [],
        points: events.map((e) => ({ title: `${e.when}: ${e.title}`, detail: e.detail, sources: e.sources })),
      };
}

/** The article's evolution, or null if it isn't in the local corpus. */
export async function articleHistory(title: string, signal?: AbortSignal): Promise<ArticleHistory | null> {
  const loaded = await loadVersions(title);
  if (!loaded || loaded.versions.length === 0) return null;
  const { versions } = loaded;
  const changes = changesBetween(versions);

  let brief: Brief | null = null;
  if (aiEnabled && changes.length > 0) {
    for (let attempt = 0; attempt < 2 && !brief; attempt++) {
      brief = await completeBrief(HISTORY_SYSTEM, promptFor(loaded.title, versions, changes), changes.length, signal).catch(
        () => null,
      );
    }
  }

  return {
    title: loaded.title,
    pageId: loaded.pageId,
    url: loaded.url,
    versions: versions.length,
    from: versions[0].at.toISOString(),
    to: versions[versions.length - 1].at.toISOString(),
    sizes: versions.map((v) => ({ at: v.at.toISOString(), bytes: v.bytes, revisionId: v.revisionId })),
    changes,
    brief: brief ?? plainBrief(loaded.title, versions, changes),
    byAi: brief !== null,
  };
}
