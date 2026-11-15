/**
 * Reading text out of JSON that is still being generated, so a deep research
 * part can be shown as the model writes it. The model streams one JSON object;
 * these helpers pull the string values written so far out of the unfinished text.
 */

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '', b: '', f: '' };

/** Decode the JSON string starting just after its opening quote; `closed` is false when the text ends inside it. */
function readString(s: string, from: number): { value: string; end: number; closed: boolean } {
  let out = '';
  let i = from;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') return { value: out, end: i + 1, closed: true };
    if (ch === '\\') {
      const next = s[i + 1];
      if (next === undefined) break; // the escape is cut off
      if (next === 'u') {
        const hex = s.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16) || 63);
        i += 6;
        continue;
      }
      out += ESCAPES[next] ?? next;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return { value: out, end: s.length, closed: false };
}

/** The value of a string property ("key": "..."), possibly unfinished. Empty when it hasn't started. */
export function partialString(json: string, key: string): string {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
  return m ? readString(json, m.index + m[0].length).value : '';
}

/** The drafts leave citations out: their numbers only mean something once the report is finished. */
export const noCitations = (t: string) =>
  t
    .replace(/\s*\[\d+\]/g, '')
    // A citation still being typed ("[1", "[12") stays hidden too.
    .replace(/\s*\[\d*$/, '')
    .replace(/\s+([,.;:])/g, '$1');

/** A part as written so far: its summary and the sections (heading, text) started so far. */
export function partialPart(json: string): { summary: string; sections: { heading: string; text: string }[] } {
  const summary = noCitations(partialString(json, 'summary'));
  const sections: { heading: string; text: string }[] = [];
  const start = /"sections"\s*:\s*\[/.exec(json);
  if (start) {
    let i = start.index + start[0].length;
    const headingKey = /"heading"\s*:\s*"/g;
    const textKey = /"text"\s*:\s*"/g;
    for (;;) {
      headingKey.lastIndex = i;
      const h = headingKey.exec(json);
      if (!h) break;
      const heading = readString(json, h.index + h[0].length);
      i = heading.end;
      let text = '';
      if (heading.closed) {
        textKey.lastIndex = i;
        const t = textKey.exec(json);
        // The text must belong to this section: it comes before the next heading.
        headingKey.lastIndex = i;
        const next = headingKey.exec(json);
        if (t && (!next || t.index < next.index)) {
          const body = readString(json, t.index + t[0].length);
          text = noCitations(body.value);
          i = body.end;
        }
      }
      sections.push({ heading: heading.value.trim(), text });
      if (!heading.closed) break;
    }
  }
  return { summary, sections: sections.filter((s) => s.heading || s.text) };
}
