import type { DeepReport, ReportSource } from '@simsam/models';

const KIND: Record<string, string> = { chart: 'Chart', map: 'Map', diagram: 'Diagram', photo: 'Image', infobox: 'Infobox', table: 'Table' };

export const figureLabel = (s: ReportSource) => KIND[s.mediaKind ?? 'photo'] ?? 'Figure';

/** A reference as it reads in the list. */
export function referenceText(s: ReportSource) {
  if (s.kind === 'web') return `${s.title}. ${s.site ?? ''}.`;
  if (s.kind === 'figure') return `${figureLabel(s)}${s.caption ? `: ${s.caption}` : ''}. In “${s.title}”, Wikipedia.`;
  return `“${s.title}”${s.section ? `, section “${s.section}”` : ''}. Wikipedia${s.stored ? '' : ' (live)'}.`;
}

/** The whole report as Markdown, to keep or share as a document. */
export function reportMarkdown(r: DeepReport) {
  const out: string[] = [];
  const cite = (ns: number[]) => ns.map((n) => `[${n}]`).join('');
  out.push(`# ${r.title}`, '');
  out.push(
    `*Deep research report on “${r.topic}”, ${new Date(r.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}. Written by AI (${r.model}) from ${r.sources.length} cited sources: the Wikipedia collection in MariaDB${r.web ? ', live Wikipedia and the web' : ' and live Wikipedia'}. Check the citations.*`,
    '',
  );
  out.push('## Abstract', '', r.abstract, '');
  out.push('## Research questions', '', ...r.questions.map((q, i) => `${i + 1}. ${q}`), '');
  out.push('## Timeline', '');
  for (const e of r.events) out.push(`- **${e.when}**: ${e.title}. ${e.detail}${e.detail.includes('[') ? '' : ` ${cite(e.sources)}`}`);
  out.push('');
  for (const p of r.parts) {
    out.push(`## Part ${p.n}: ${p.title}`, '', `*${p.focus}*`, '', p.summary, '');
    if (p.facts.length) {
      out.push('**Key facts**', '');
      for (const f of p.facts) out.push(`- ${f.label}: ${f.value} ${cite(f.sources)}`);
      out.push('');
    }
    for (const s of p.sections) out.push(`### ${s.heading}`, '', s.text, '');
    if (p.dataset) {
      out.push(`**${p.dataset.title}**${p.dataset.unit ? ` (${p.dataset.unit})` : ''} ${cite(p.dataset.sources)}`, '', '| | Value |', '|---|---:|');
      for (const i of p.dataset.items) out.push(`| ${i.label} | ${i.value.toLocaleString('en-GB')} |`);
      out.push('');
    }
    for (const n of p.figures) {
      const s = r.sources[n - 1];
      if (s) out.push(`- Figure [${n}]: ${referenceText(s)}`);
    }
    if (p.figures.length) out.push('');
  }
  out.push('## Findings', '');
  for (const a of r.answers) out.push(`**${r.questions[a.question - 1]}**`, '', a.text, '');
  out.push('## Limitations', '', r.limitations, '');
  out.push('## Method', '', methodText(r), '');
  out.push('## References', '');
  for (const s of r.sources) out.push(`${s.n}. ${referenceText(s)} <${s.url}>`);
  out.push('', 'Wikipedia text is available under CC BY-SA 4.0. Web passages belong to their publishers.');
  return out.join('\n');
}

export function methodText(r: DeepReport) {
  const m = r.method;
  return [
    `The topic was split into ${r.parts.length} parts and ${r.questions.length} research questions.`,
    `For each part, ${m.queries.length} search queries in all were run by meaning (vector search) over the passages and figures of the Wikipedia collection stored in MariaDB, reading ${m.passages} passages from ${m.articles} articles${m.liveArticles ? `, plus the opening of ${m.liveArticles} articles from live Wikipedia where the collection was thin` : ''}.`,
    m.figures ? `${m.figures} figures (maps, charts, tables, infoboxes) were included; images were read by a vision model.` : '',
    r.web ? `Web search (context.dev, excluding Wikipedia and its copies) added ${m.webPages} pages.` : 'The web was not searched.',
    `Each part was written by AI (${r.model}) from its own numbered evidence only; the abstract, findings and eras were written from the parts. The research took ${Math.max(1, Math.round(m.seconds / 60))} minute${m.seconds >= 90 ? 's' : ''}.`,
  ]
    .filter(Boolean)
    .join(' ');
}
