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
