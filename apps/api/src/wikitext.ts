// Just enough wikitext handling to compare revisions: the section outline and
// a readable version of the lead. Not a full parser; templates, tables and
// references are dropped rather than rendered.

export interface Section {
  level: number;
  title: string;
}

const HEADING = /^(={2,6})\s*(.+?)\s*\1\s*$/gm;

/** Strip markup from a heading ("[[Finland|Finnish]] history" -> "Finnish history"). */
const plainHeading = (s: string) => plain(s).replace(/\s+/g, ' ').trim();

export function sectionsOf(wikitext: string): Section[] {
  const out: Section[] = [];
  for (const m of wikitext.matchAll(HEADING)) out.push({ level: m[1].length - 1, title: plainHeading(m[2]) });
  return out;
}

/** Remove balanced {{templates}} and {| tables |}, which may nest. */
function dropBalanced(text: string, open: string, close: string) {
  let out = '';
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith(open, i)) {
      depth++;
      i += open.length - 1;
    } else if (depth > 0 && text.startsWith(close, i)) {
      depth--;
      i += close.length - 1;
    } else if (depth === 0) {
      out += text[i];
    }
  }
  return out;
}

/** Wikitext to rough plain text. */
export function plain(wikitext: string) {
  let t = wikitext.replace(/<!--[\s\S]*?-->/g, '');
  t = t.replace(/<ref[^>]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  t = dropBalanced(t, '{{', '}}');
  t = dropBalanced(t, '{|', '|}');
  // Files and categories go entirely; ordinary links keep their label.
  t = t.replace(/\[\[(?:File|Image|Category):[^[\]]*(?:\[\[[^\]]*\]\][^[\]]*)*\]\]/gi, '');
  t = t.replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1');
  t = t.replace(/\[https?:\/\/\S+\s+([^\]]*)\]/g, '$1').replace(/\[https?:\/\/[^\]]*\]/g, '');
  t = t.replace(/'''?/g, '').replace(/<[^>]+>/g, '');
  t = t.replace(/&nbsp;/g, ' ').replace(/&ndash;/g, '–').replace(/&mdash;/g, '—').replace(/&amp;/g, '&');
  return t;
}

/** The lead section (before the first heading) as plain text, shortened. */
export function leadOf(wikitext: string, maxChars = 1500) {
  const firstHeading = wikitext.search(/^==[^=]/m);
  const lead = plain(firstHeading === -1 ? wikitext : wikitext.slice(0, firstHeading))
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('|') && !l.startsWith('!'))
    .join('\n')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
  return lead.length > maxChars ? `${lead.slice(0, maxChars).trimEnd()}…` : lead;
}

// ---------- Figures: images, the infobox and tables ----------

/** The end of the balanced `open`…`close` block starting at `start`, or -1. */
function balancedEnd(text: string, start: number, open: string, close: string) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text.startsWith(open, i)) {
      depth++;
      i += open.length - 1;
    } else if (text.startsWith(close, i)) {
      depth--;
      i += close.length - 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Split on `sep` outside [[links]] and {{templates}}. */
function splitTop(text: string, sep: string) {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith('[[', i) || text.startsWith('{{', i)) {
      depth++;
      i++;
    } else if (text.startsWith(']]', i) || text.startsWith('}}', i)) {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (depth === 0 && text.startsWith(sep, i)) {
      parts.push(text.slice(last, i));
      last = i + sep.length;
      i += sep.length - 1;
    }
  }
  parts.push(text.slice(last));
  return parts;
}

const DATE_TEMPLATES = /^(start|end|birth|death|film release) date( and age)?$|^dts$|^date$/i;
const LIST_TEMPLATES = /^(plainlist|plain list|unbulleted list|ubl|hlist|flatlist|bulleted list|collapsible list)$/i;
const NAMED_PARAM = /^[\w\s-]+=/;

/**
 * Turn the templates that carry content in infoboxes and tables into text
 * (dates, lists, unit conversions, flags), innermost first; others are dropped.
 */
export function expandTemplates(text: string) {
  let t = text;
  for (let pass = 0; pass < 8; pass++) {
    const next = t.replace(/\{\{([^{}]*)\}\}/g, (_, inner: string) => {
      const [rawName, ...params] = splitTop(inner, '|').map((p) => p.trim());
      const name = rawName.replace(/_/g, ' ').trim();
      const positional = params.filter((p) => !NAMED_PARAM.test(p));
      if (DATE_TEMPLATES.test(name)) {
        const nums = positional.filter((p) => /^\d{1,4}$/.test(p)).slice(0, 3);
        return nums.map((n, i) => (i === 0 ? n : n.padStart(2, '0'))).join('-');
      }
      if (LIST_TEMPLATES.test(name)) {
        return params
          .flatMap((p) => p.split(/\n\s*\*\s*/))
          .map((p) => p.replace(/^\*\s*/, '').trim())
          .filter((p) => p && !NAMED_PARAM.test(p))
          .join('; ');
      }
      if (/^(convert|cvt)$/i.test(name)) return positional.slice(0, 2).join(' ');
      if (/^(nowrap|nobr|small|big|lang|transl)$/i.test(name)) return positional[positional.length - 1] ?? '';
      if (/^(flag|flagcountry|flagu|flag country)$/i.test(name)) return positional[0] ?? '';
      if (/^(circa|c\.)$/i.test(name)) return `c. ${positional[0] ?? ''}`;
      return '';
    });
    if (next === t) break;
    t = next;
  }
  return t;
}

/** Infobox or table cell text: content templates expanded, the rest of the markup stripped. */
const cellText = (wikitext: string) =>
  plain(expandTemplates(wikitext.replace(/<br\s*\/?>/gi, '; ')))
    // "(aged {{age|…}})" and the like leave empty brackets behind.
    .replace(/\(\s*[;,]?\s*\)/g, '')
    .replace(/\s*;\s*(;\s*)+/g, '; ')
    .replace(/\s+/g, ' ')
    .replace(/^[;,\s]+|[;,\s]+$/g, '')
    .trim();

const withoutComments = (wikitext: string) =>
  wikitext
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref[^>]*\/>/gi, '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');

export interface WikiImage {
  /** The file name without "File:". */
  file: string;
  caption: string;
}

const IMAGE_OPTION =
  /^(thumb|thumbnail|frame|framed|frameless|border|left|right|center|centre|none|upright(=.*)?|baseline|middle|sub|super|top|text-top|bottom|text-bottom|\d*x?\d+px|(alt|link|class|lang|page|upright|thumb)=.*)$/i;
const FILE_EXT = /\.(png|jpe?g|gif|svg|tiff?|webp)$/i;

/** Images in the article, with captions: infobox images and maps first, then [[File:…]] links and galleries. */
export function imagesOf(wikitext: string, infoboxImages: WikiImage[] = []): WikiImage[] {
  const found = new Map<string, WikiImage>();
  const add = (file: string, caption: string) => {
    const name = file.replace(/^(File|Image):/i, '').replace(/_/g, ' ').trim();
    if (!FILE_EXT.test(name) || found.has(name.toLowerCase())) return;
    found.set(name.toLowerCase(), { file: name, caption: cellText(caption).slice(0, 500) });
  };
  for (const img of infoboxImages) add(img.file, img.caption);
  const text = withoutComments(wikitext);
  for (const m of text.matchAll(/\[\[(?:File|Image):/gi)) {
    const end = balancedEnd(text, m.index!, '[[', ']]');
    if (end === -1) continue;
    const [file, ...params] = splitTop(text.slice(m.index! + 2, end - 2), '|');
    add(file, [...params].reverse().find((p) => !IMAGE_OPTION.test(p.trim())) ?? '');
  }
  for (const g of text.matchAll(/<gallery[^>]*>([\s\S]*?)<\/gallery>/gi)) {
    for (const line of g[1].split('\n')) {
      const [file, ...rest] = splitTop(line.trim(), '|');
      if (file) add(file, rest.filter((p) => !IMAGE_OPTION.test(p.trim())).pop() ?? '');
    }
  }
  return [...found.values()];
}

export interface Infobox {
  /** "Infobox military conflict" and the like. */
  type: string;
  /** "Key: value" lines. */
  text: string;
  images: WikiImage[];
}

const IMAGE_KEY = /(^|_)(image|map|photo)\d*$|^(image|map)(_\w+)?$/;
const SKIP_KEY = /(caption|alt|size|width|upright|style|class|module|embed|^child$|^float$)/;

/** The article's infobox as "key: value" lines, plus the images and maps it shows. */
export function infoboxOf(wikitext: string): Infobox | null {
  const text = withoutComments(wikitext);
  const start = text.search(/\{\{\s*Infobox/i);
  if (start === -1) return null;
  const end = balancedEnd(text, start, '{{', '}}');
  if (end === -1) return null;
  const [name, ...params] = splitTop(text.slice(start + 2, end - 2), '|');
  const values = new Map<string, string>();
  for (const p of params) {
    const eq = p.indexOf('=');
    if (eq !== -1) values.set(p.slice(0, eq).trim().toLowerCase(), p.slice(eq + 1).trim());
  }
  const images: WikiImage[] = [];
  const lines: string[] = [];
  for (const [key, raw] of values) {
    if (!raw) continue;
    const file = raw.replace(/^\[\[/, '').replace(/^(File|Image):/i, '').split('|')[0].trim();
    if (IMAGE_KEY.test(key) && FILE_EXT.test(file)) {
      const stem = key.replace(/_?(image|map|photo)\d*$/, '');
      const captionKey = [`${key}_caption`, key.replace(/(image|map|photo)/, 'caption'), stem ? `${stem}_caption` : 'caption'].find((k) =>
        values.get(k),
      );
      images.push({ file, caption: (captionKey && values.get(captionKey)) || key.replace(/_/g, ' ') });
      continue;
    }
    if (SKIP_KEY.test(key)) continue;
    const value = cellText(raw);
    if (value) lines.push(`${key.replace(/_/g, ' ')}: ${value}`);
  }
  const body = lines.join('\n');
  return body ? { type: name.trim().replace(/_/g, ' '), text: body.slice(0, 2500), images } : null;
}

export interface WikiTable {
  caption: string;
  /** Rows as "cell | cell | cell" lines, header first. */
  text: string;
  rows: number;
}

/** Data tables (class "wikitable") as plain rows, with their caption or the section they're in. */
export function tablesOf(wikitext: string, max = 4): WikiTable[] {
  const text = withoutComments(wikitext);
  const out: WikiTable[] = [];
  let from = 0;
  while (out.length < max) {
    const start = text.indexOf('{|', from);
    if (start === -1) break;
    const end = balancedEnd(text, start, '{|', '|}');
    if (end === -1) break;
    from = end;
    const block = text.slice(start, end);
    if (!/wikitable/i.test(block.slice(0, block.indexOf('\n')))) continue;
    const heading = [...text.slice(0, start).matchAll(/^(={2,6})\s*(.+?)\s*\1\s*$/gm)].pop()?.[2];
    // A cell is "content" or "attributes | content".
    const cell = (raw: string) => {
      const parts = splitTop(raw, '|');
      return cellText(parts.length > 1 && /=/.test(parts[0]) ? parts.slice(1).join('|') : raw);
    };
    let caption = '';
    const rows: string[][] = [];
    let row: string[] = [];
    for (const raw of block.split('\n').slice(1, -1)) {
      const line = raw.trim();
      if (line.startsWith('|+')) caption = cell(line.slice(2));
      else if (line.startsWith('|-')) {
        if (row.length) rows.push(row);
        row = [];
      } else if (line.startsWith('!')) row.push(...line.slice(1).split(/!!|\|\|/).map(cell));
      else if (line.startsWith('|')) row.push(...line.slice(1).split('||').map(cell));
      else if (row.length && line) row[row.length - 1] += ` ${cellText(line)}`;
    }
    if (row.length) rows.push(row);
    const kept = rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some(Boolean));
    if (kept.length < 2) continue;
    let body = '';
    let count = 0;
    for (const r of kept) {
      const line = r.join(' | ');
      if (body.length + line.length > 3000) break;
      body += `${line}\n`;
      count++;
    }
    out.push({ caption: caption || (heading ? `Table in “${cellText(heading)}”` : 'Table'), text: body.trim(), rows: count });
  }
  return out;
}
