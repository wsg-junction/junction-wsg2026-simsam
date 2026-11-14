// Deep research reports: a topic researched in depth into a full report.
//
//   1. Plan: the model sets research questions and splits the topic into parts
//      (causes, phases, parties, themes, consequences), each with search queries.
//   2. Gather, per part, from MariaDB first: vector search over the passages of
//      the collection (several articles per question), live Wikipedia where the
//      collection is thin, the figures (maps, charts, tables, infoboxes, read by
//      the vision model once and stored), and, if asked, web pages (context.dev,
//      Wikipedia and its copies excluded).
//   3. Write each part from its own numbered evidence only: sections, key facts,
//      a dataset when the evidence has comparable numbers, dated events, figures.
//   4. Synthesise: abstract, answers to the research questions, limitations, and
//      the eras of the timeline. Citations are renumbered in reading order.
import type {
  DeepReport,
  DeepReportEvent,
  MediaKind,
  ReportDataset,
  ReportEvent,
  ReportFact,
  ReportPart,
  ReportSource,
} from '@simsam/models';
import { CHAT_MODEL, jsonCompletion } from './ai.js';
import { searchWeb, webSearchEnabled, WIKIPEDIA_COPIES } from './context.js';
import { nearestPassages, type Passage } from './corpus.js';
import { embedCached } from './embeddings.js';
import { articleFigures, ensureMedia, kindLabel, nearestFigures, type Figure } from './media.js';
import { fetchIntros, searchLiveTitles } from './wikipedia.js';

const PASSAGES_PER_PART = 14;
const FIGURES_PER_PART = 4;
const WEB_PER_PART = 3;
const PARALLEL_WRITERS = 3;

// ---------- Output schemas (structured output: always valid JSON) ----------

const str_ = { type: 'string' };
const ints = { type: 'array', items: { type: 'integer' } };
const strings = { type: 'array', items: str_ };
const obj = (properties: Record<string, object>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

const PLAN_SCHEMA = obj({
  title: str_,
  questions: strings,
  parts: { type: 'array', items: obj({ title: str_, focus: str_, queries: strings }) },
});

const PART_SCHEMA = obj({
  summary: str_,
  sections: { type: 'array', items: obj({ heading: str_, text: str_ }) },
  facts: { type: 'array', items: obj({ label: str_, value: str_, sources: ints }) },
  dataset: obj({ title: str_, unit: str_, items: { type: 'array', items: obj({ label: str_, value: { type: 'number' } }) }, sources: ints }),
  events: {
    type: 'array',
    items: obj({
      year: { type: 'integer' },
      month: { type: 'integer' },
      day: { type: 'integer' },
      endYear: { type: 'integer' },
      endMonth: { type: 'integer' },
      when: str_,
      title: str_,
      detail: str_,
      importance: { type: 'integer' },
      sources: ints,
    }),
  },
  figures: ints,
});

const SYNTH_SCHEMA = obj({
  abstract: str_,
  answers: { type: 'array', items: obj({ question: { type: 'integer' }, text: str_ }) },
  limitations: str_,
  eras: { type: 'array', items: obj({ from: { type: 'number' }, to: { type: 'number' }, label: str_ }) },
});

// ---------- Sources ----------

type Source = Omit<ReportSource, 'n'> & { n: number; /** What the model reads. */ text: string };

class SourceBook {
  readonly all: Source[] = [];
  private byKey = new Map<string, number>();
  add(key: string, source: Omit<Source, 'n'>) {
    const known = this.byKey.get(key);
    if (known) return known;
    const n = this.all.length + 1;
    this.all.push({ ...source, n });
    this.byKey.set(key, n);
    return n;
  }
  get(n: number) {
    return this.all[n - 1];
  }
}

const articleUrl = (title: string) => `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
const anchor = (section: string) => `#${encodeURIComponent(section.replace(/ /g, '_'))}`;
const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max).trimEnd()}…` : flat;
};
const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = <T = Record<string, unknown>>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);

/** How a source reads in the evidence given to the model. */
function evidenceLine(s: Source) {
  if (s.kind === 'wikipedia') {
    return `[${s.n}] Wikipedia: "${s.title}"${s.section ? `, section "${s.section}"` : ''}${s.stored ? '' : ' (live)'}\n${s.text}`;
  }
  if (s.kind === 'figure') {
    return `[${s.n}] Figure: ${kindLabel(s.mediaKind ?? 'photo')} in "${s.title}"${s.caption ? `, "${s.caption}"` : ''}\n${s.text}`;
  }
  return `[${s.n}] Web: ${s.site}, "${s.title}"\n${s.text}`;
}

// ---------- Plan ----------

interface Plan {
  title: string;
  questions: string[];
  parts: { n: number; title: string; focus: string; queries: string[] }[];
}

const planSystem = (web: boolean) => `You plan a deep research report, like a research lead planning a study. The research draws on a collection of Wikipedia articles searched by meaning${web ? ', live Wikipedia and the web' : ' and live Wikipedia'}. Reply with JSON only:
{"title": string, "questions": string[], "parts": [{"title": string, "focus": string, "queries": string[]}]}

- title: the report's title, specific (e.g. "World War II: Causes, Course and Consequences, 1939–1945").
- questions: 3 to 5 research questions the report answers.
- parts: 4 to 7 parts covering the topic's main aspects without overlap, in a sensible order: background and causes, the main phases or theatres, the parties and perspectives (each major party or group gets its own part where it matters, e.g. the Allies, Germany, Japan), key themes (e.g. the Holocaust, the economy, technology), and consequences.
- focus: one sentence on what the part covers.
- queries: 2 or 3 search queries naming specific events, people, places or articles for this part (e.g. "Invasion of Poland 1939", "Battle of Stalingrad").`;

async function makePlan(topic: string, web: boolean, signal: AbortSignal): Promise<Plan> {
  const raw = await jsonCompletion<Record<string, unknown>>(planSystem(web), `Topic: ${topic}\n\nJSON:`, {
    maxTokens: 1500,
    temperature: 0.3,
    signal,
    schema: { name: 'report_plan', schema: PLAN_SCHEMA },
  });
  const parts = list(raw.parts)
    .map((p) => ({
      title: str(p.title, 120),
      focus: str(p.focus, 400),
      queries: list<string>(p.queries).map((q) => str(q, 200)).filter(Boolean).slice(0, 3),
    }))
    .filter((p) => p.title)
    .slice(0, 7)
    .map((p, i) => ({ ...p, n: i + 1, queries: p.queries.length ? p.queries : [`${topic} ${p.title}`] }));
  if (parts.length < 2) throw new Error('The plan had too few parts');
  return {
    title: str(raw.title, 200) || topic,
    questions: list<string>(raw.questions).map((q) => str(q, 300)).filter(Boolean).slice(0, 5),
    parts,
  };
}

// ---------- Write a part ----------

const WRITE_SYSTEM = `You write one part of a deep research report, like a careful historian, from numbered evidence only. Reply with JSON only:
{"summary": string, "sections": [{"heading": string, "text": string}], "facts": [{"label": string, "value": string, "sources": number[]}], "dataset": {"title": string, "unit": string, "items": [{"label": string, "value": number}], "sources": number[]}, "events": [{"year": number, "month": number, "day": number, "endYear": number, "endMonth": number, "when": string, "title": string, "detail": string, "importance": 1 | 2 | 3, "sources": number[]}], "figures": number[]}

Rules:
- Use only the evidence. End every factual sentence with the numbers of its evidence, like [3] or [3][7]. Never cite a number that isn't in the evidence.
- summary: 2 or 3 sentences on what this part establishes.
- sections: 2 to 4, each with a short heading and 2 or 3 paragraphs separated by a blank line. Plain prose, no markdown. Be specific: names, dates, places, numbers, causes and consequences. Say where sources disagree.
- facts: 3 to 6 key figures or dates; value is short ("70–85 million", "1 September 1939").
- dataset: only when the evidence gives 3 or more comparable numbers for one measure (e.g. deaths by country, troops by side), values as plain numbers in the unit. Otherwise give an empty items list. Never estimate or invent numbers.
- events: 6 to 14 dated events from the evidence, for a timeline. year is a number (negative for BCE); month 1 to 12, or 0 if unknown; day, or 0 if unknown; endYear and endMonth for events lasting more than a month, otherwise 0. when: the date as it should read. title: at most 8 words. detail: one sentence. importance: 1 for turning points of the whole topic, 2 for major events within this part, 3 for details.
- figures: the numbers of Figure evidence worth showing with this part (maps, charts, tables), at most 3.
- If the evidence is thin, write less rather than padding.`;

interface WrittenPart {
  part: ReportPart;
  events: ReportEvent[];
}

const nums = (v: unknown, valid: Set<number>) => [
  ...new Set(list<unknown>(v).map(Number).filter((n) => Number.isInteger(n) && valid.has(n))),
];
const keepCitations = (text: string, valid: Set<number>) =>
  text.replace(/\[(\d+)\]/g, (m, n: string) => (valid.has(Number(n)) ? m : '')).replace(/[ \t]+(\[\d+\])/g, '$1');

async function writePart(
  topic: string,
  plan: Plan,
  part: Plan['parts'][number],
  evidence: Source[],
  signal: AbortSignal,
): Promise<WrittenPart> {
  const valid = new Set(evidence.map((s) => s.n));
  const others = plan.parts.filter((p) => p.n !== part.n).map((p) => p.title).join('; ');
  const raw = await jsonCompletion<Record<string, unknown>>(
    WRITE_SYSTEM,
    [
      `Report: ${plan.title}`,
      `This part: ${part.title}`,
      `Focus: ${part.focus}`,
      `Other parts (leave their details to them): ${others}`,
      '',
      'Evidence:',
      '',
      evidence.map(evidenceLine).join('\n\n'),
      '',
      'JSON:',
    ].join('\n'),
    { maxTokens: 5000, temperature: 0.3, signal, schema: { name: 'report_part', schema: PART_SCHEMA } },
  );

  const sections = list(raw.sections)
    .map((s) => ({ heading: str(s.heading, 120), text: keepCitations(str(s.text, 6000), valid) }))
    .filter((s) => s.heading && s.text);
  const facts: ReportFact[] = list(raw.facts)
    .map((f) => ({ label: str(f.label, 80), value: str(f.value, 80), sources: nums(f.sources, valid) }))
    .filter((f) => f.label && f.value)
    .slice(0, 6);
  let dataset: ReportDataset | null = null;
  const d = raw.dataset as Record<string, unknown> | null | undefined;
  if (d && typeof d === 'object') {
    const items = list(d.items)
      .map((i) => ({ label: str(i.label, 60), value: Number(i.value) }))
      .filter((i) => i.label && Number.isFinite(i.value))
      .slice(0, 12);
    const sources = nums(d.sources, valid);
    if (items.length >= 3 && sources.length > 0) dataset = { title: str(d.title, 120), unit: str(d.unit, 40), items, sources };
  }
  const figureNums = new Set(evidence.filter((s) => s.kind === 'figure').map((s) => s.n));
  const events: ReportEvent[] = list(raw.events)
    .map((e, i) => {
      const year = Number(e.year);
      const month = Number(e.month);
      const day = Number(e.day);
      const endYear = Number(e.endYear);
      const endMonth = Number(e.endMonth);
      const start = year + (month >= 1 && month <= 12 ? (month - 1) / 12 : 0) + (day >= 1 && day <= 31 ? (day - 1) / 365 : 0);
      const end = Number.isFinite(endYear) && endYear !== 0 && e.endYear !== null ? endYear + (endMonth >= 1 && endMonth <= 12 ? endMonth / 12 : 1) : undefined;
      const importance = [1, 2, 3].includes(Number(e.importance)) ? (Number(e.importance) as 1 | 2 | 3) : 2;
      return {
        id: `p${part.n}e${i}`,
        start,
        end: end !== undefined && end > start + 1 / 24 ? end : undefined,
        when: str(e.when, 60) || String(year),
        title: str(e.title, 90),
        detail: keepCitations(str(e.detail, 400), valid),
        importance,
        part: part.n,
        sources: nums(e.sources, valid),
      };
    })
    // Only real dates: "During the war" with a guessed year would land anywhere on the timeline.
    .filter((e) => Number.isFinite(e.start) && e.start > -10000 && e.start < 2200 && e.start !== 0 && /\d/.test(e.when) && e.title);

  return {
    part: {
      n: part.n,
      title: part.title,
      focus: part.focus,
      summary: keepCitations(str(raw.summary, 1200), valid),
      sections,
      facts,
      dataset,
      figures: nums(raw.figures, figureNums).slice(0, 3),
    },
    events,
  };
}

// ---------- Synthesis ----------

const synthSystem = (web: boolean) => `You finish a deep research report from its parts. Reply with JSON only:
{"abstract": string, "answers": [{"question": number, "text": string}], "limitations": string, "eras": [{"from": number, "to": number, "label": string}]}

- abstract: 4 to 6 sentences on the whole topic and what the report establishes, cited with the same source numbers the parts use, like [3].
- answers: one per research question (numbered as given), 2 to 4 sentences each, cited the same way. Only state what the parts support.
- limitations: 2 or 3 plain sentences on gaps and weaknesses of the evidence: aspects covered thinly, reliance on encyclopedia articles${web ? ', web sources of mixed quality' : ''}, figures that differ between sources.
- eras: 3 to 7 consecutive periods spanning the timeline's events; from and to are years (fractions allowed, e.g. 1939.67), label at most 4 words.`;

// ---------- Run ----------

/** Which titles' figures to read for a part: the article it draws on most. */
const topTitles = (passages: { title: string }[], n: number) => {
  const counts = new Map<string, number>();
  for (const p of passages) counts.set(p.title, (counts.get(p.title) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([t]) => t);
};

/** Maps, charts and diagrams first; at most one photo. */
const KIND_ORDER: Record<string, number> = { map: 0, chart: 0, diagram: 1, table: 2, infobox: 3, photo: 4 };

const words = (t: string) => new Set(t.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
const similar = (a: string, b: string) => {
  const A = words(a);
  const B = words(b);
  const shared = [...A].filter((w) => B.has(w)).length;
  return shared / Math.max(1, Math.min(A.size, B.size));
};

/** Run a deep research, yielding progress and finally the report. */
export async function* deepReport(topic: string, wantWeb: boolean, signal: AbortSignal): AsyncGenerator<DeepReportEvent> {
  const started = Date.now();
  const web = wantWeb && webSearchEnabled;
  const step = (id: string, label: string, done: boolean, detail?: string): DeepReportEvent => ({
    type: 'step',
    step: { id, label, done, detail },
  });

  // 1. Plan.
  yield step('plan', 'Planning the research questions and parts', false);
  const plan = await makePlan(topic, web, signal);
  yield { type: 'plan', title: plan.title, questions: plan.questions, parts: plan.parts.map(({ n, title, focus }) => ({ n, title, focus })) };
  yield step('plan', 'Planned the research', true, `${plan.parts.length} parts, ${plan.questions.length} research questions`);

  // 2. Gather evidence for each part.
  const book = new SourceBook();
  const queries = plan.parts.flatMap((p) => p.queries);
  const vectors = await embedCached(queries, 'query', AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
  const vectorOf = new Map(queries.map((q, i) => [q, vectors[i]]));
  // Web searches run alongside the database work.
  const webResults = plan.parts.map((p) =>
    web
      ? searchWeb(`${p.queries[0]} ${topic}`.slice(0, 300), signal, { exclude: WIKIPEDIA_COPIES, results: WEB_PER_PART }).catch(() => [])
      : Promise.resolve([]),
  );
  const evidence = new Map<number, number[]>();
  const partPassages = new Map<number, Passage[]>();
  const partLive = new Map<number, string[]>();
  const stats = { passages: 0, articles: new Set<string>(), live: new Set<string>(), figures: 0, web: 0 };

  for (const part of plan.parts) {
    yield step(`gather-${part.n}`, `Searching the collection for part ${part.n}: ${part.title}`, false);
    const found = new Map<number, Passage>();
    // Strict first; where the collection is thin, accept somewhat looser matches.
    for (const maxDistance of [0.6, 0.66]) {
      if (found.size >= 6) break;
      for (const q of part.queries) {
        const v = vectorOf.get(q);
        if (!v) continue;
        for (const p of await nearestPassages(v, 8, 2, maxDistance)) if (!found.has(p.chunkId)) found.set(p.chunkId, p);
      }
    }
    const passages = [...found.values()].sort((a, b) => a.distance - b.distance).slice(0, PASSAGES_PER_PART);
    partPassages.set(part.n, passages);
    const ids: number[] = [];
    for (const p of passages) {
      ids.push(
        book.add(`chunk:${p.chunkId}`, {
          kind: 'wikipedia',
          title: p.title,
          url: p.url + (p.section ? anchor(p.section) : ''),
          section: p.section ?? undefined,
          stored: true,
          text: clip(p.content, 1100),
        }),
      );
      stats.articles.add(p.title);
    }
    stats.passages += passages.length;

    // Thin in the collection: add article leads from live Wikipedia.
    let liveCount = 0;
    if (new Set(passages.map((p) => p.title)).size < 4) {
      const titles = [
        ...new Set(
          (await Promise.all(part.queries.slice(0, 2).map((q) => searchLiveTitles(q, 3, signal).catch(() => [])))).flat(),
        ),
      ].filter((t) => !passages.some((p) => p.title === t));
      const intros = await fetchIntros(titles.slice(0, 4), signal).catch(() => []);
      partLive.set(part.n, intros.flatMap((i) => (i ? [i.title] : [])));
      for (const intro of intros) {
        if (!intro) continue;
        ids.push(
          book.add(`live:${intro.title}`, { kind: 'wikipedia', title: intro.title, url: articleUrl(intro.title), stored: false, text: clip(intro.text, 1500) }),
        );
        stats.live.add(intro.title);
        liveCount++;
      }
    }

    const pages = await webResults[part.n - 1];
    for (const w of pages) {
      ids.push(book.add(`web:${w.url}`, { kind: 'web', title: w.title, url: w.url, site: w.site, text: clip(w.text, 1200) }));
      stats.web++;
    }
    evidence.set(part.n, ids);
    yield step(
      `gather-${part.n}`,
      `Gathered evidence for part ${part.n}: ${part.title}`,
      true,
      [
        `${passages.length} passages from ${new Set(passages.map((p) => p.title)).size} articles`,
        liveCount ? `${liveCount} live Wikipedia articles` : '',
        pages.length ? `${pages.length} web pages` : '',
      ]
        .filter(Boolean)
        .join(', '),
    );
  }

  // Figures: read the main article of each part once (stored for next time), then pick the closest.
  yield step('figures', 'Reading figures: maps, charts, tables and infoboxes', false);
  const mainsOf = (n: number) => [...topTitles(partPassages.get(n) ?? [], 2), ...(partLive.get(n) ?? []).slice(0, 1)].slice(0, 2);
  const mains = [...new Set(plan.parts.flatMap((p) => mainsOf(p.n)))];
  for (let i = 0; i < mains.length; i += 4) {
    await Promise.all(mains.slice(i, i + 4).map((t) => ensureMedia(t, AbortSignal.any([signal, AbortSignal.timeout(90_000)])).catch(() => 0)));
  }
  for (const part of plan.parts) {
    const v = vectorOf.get(part.queries[0]);
    // The part's own articles' figures (looser match), then the closest figures of the whole collection.
    const own: Figure[] = (
      await Promise.all(mainsOf(part.n).map((t) => articleFigures(t, `${part.title}: ${part.focus}`, 4).catch(() => [])))
    ).flat().filter((f) => (f.distance ?? 0) <= 0.75);
    const near: Figure[] = (v ? await nearestFigures(v, 6).catch(() => []) : []).filter((f) => (f.distance ?? 1) <= 0.6);
    const seen = new Set<number>();
    let photos = 0;
    const picked = [...own, ...near]
      .filter((f) => !seen.has(f.id) && Boolean(seen.add(f.id)))
      .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.distance ?? 1) - (b.distance ?? 1))
      .filter((f) => f.kind !== 'photo' || photos++ === 0)
      .slice(0, FIGURES_PER_PART);
    for (const f of picked) {
      evidence.get(part.n)!.push(
        book.add(`figure:${f.id}`, {
          kind: 'figure',
          title: f.title,
          url: articleUrl(f.title),
          mediaKind: f.kind as MediaKind,
          caption: f.caption ?? undefined,
          imageUrl: f.imageUrl ?? undefined,
          content: f.content,
          text: clip(f.content, 1500),
        }),
      );
      stats.figures++;
    }
  }
  yield step('figures', 'Read the figures', true, `${stats.figures} figures`);

  // 3. Write the parts, a few at a time.
  const written = new Map<number, WrittenPart>();
  const failed: string[] = [];
  for (let i = 0; i < plan.parts.length; i += PARALLEL_WRITERS) {
    const batch = plan.parts.slice(i, i + PARALLEL_WRITERS);
    for (const part of batch) yield step(`write-${part.n}`, `Writing part ${part.n}: ${part.title}`, false);
    const results = await Promise.allSettled(
      batch.map((part) => writePart(topic, plan, part, (evidence.get(part.n) ?? []).map((n) => book.get(n)), signal)),
    );
    for (const [j, r] of results.entries()) {
      const part = batch[j];
      if (r.status === 'fulfilled' && r.value.part.sections.length > 0) {
        written.set(part.n, r.value);
        yield step(`write-${part.n}`, `Wrote part ${part.n}: ${part.title}`, true, `${r.value.part.sections.length} sections, ${r.value.events.length} events`);
      } else {
        if (signal.aborted) throw new Error('aborted');
        failed.push(part.title);
        yield step(`write-${part.n}`, `Part ${part.n} couldn’t be written: ${part.title}`, true, 'Left out');
      }
    }
  }
  if (written.size === 0) throw new Error('No part could be written');

  // Merge the parts' events: the same event told by two parts appears once.
  const events: ReportEvent[] = [];
  const allEvents = [...written.values()].flatMap((w) => w.events).sort((a, b) => a.importance - b.importance);
  for (const e of allEvents) {
    const twin = events.find((x) => Math.abs(x.start - e.start) < 0.05 && similar(x.title, e.title) >= 0.5);
    if (twin) twin.sources = [...new Set([...twin.sources, ...e.sources])];
    else events.push({ ...e });
  }
  events.sort((a, b) => a.start - b.start);

  // 4. Synthesis.
  yield step('synthesis', 'Writing the abstract, answers to the research questions and the eras', false);
  const parts = plan.parts.flatMap((p) => (written.has(p.n) ? [written.get(p.n)!.part] : []));
  const valid = new Set(book.all.map((s) => s.n));
  let abstract = '';
  let answers: DeepReport['answers'] = [];
  let limitations = '';
  let eras: DeepReport['eras'] = [];
  try {
    const raw = await jsonCompletion<Record<string, unknown>>(
      synthSystem(web),
      [
        `Report: ${plan.title}`,
        '',
        'Research questions:',
        ...plan.questions.map((q, i) => `${i + 1}. ${q}`),
        '',
        ...parts.flatMap((p) => [
          `Part ${p.n}: ${p.title}`,
          `Summary: ${p.summary}`,
          `Key facts: ${p.facts.map((f) => `${f.label}: ${f.value}${f.sources.map((n) => `[${n}]`).join('')}`).join('; ')}`,
          `Sections: ${p.sections.map((s) => s.heading).join('; ')}`,
          '',
        ]),
        'Timeline:',
        ...events.slice(0, 90).map((e) => `- ${e.when}: ${e.title} (importance ${e.importance})`),
        failed.length ? `\nParts that couldn't be researched: ${failed.join('; ')}` : '',
        '',
        'JSON:',
      ].join('\n'),
      { maxTokens: 3000, temperature: 0.3, signal, schema: { name: 'report_synthesis', schema: SYNTH_SCHEMA } },
    );
    abstract = keepCitations(str(raw.abstract, 2500), valid);
    answers = list(raw.answers)
      .map((a) => ({ question: Number(a.question), text: keepCitations(str(a.text, 2000), valid) }))
      .filter((a) => Number.isInteger(a.question) && a.question >= 1 && a.question <= plan.questions.length && a.text);
    limitations = str(raw.limitations, 1500).replace(/\s*\[\d+\]/g, '');
    const first = events[0]?.start ?? 0;
    const last = Math.max(...events.map((e) => e.end ?? e.start), first + 1);
    eras = list(raw.eras)
      .map((e) => ({ from: Math.max(Number(e.from), first - 1), to: Math.min(Number(e.to), last + 1), label: str(e.label, 40) }))
      .filter((e) => Number.isFinite(e.from) && Number.isFinite(e.to) && e.to > e.from && e.label)
      .sort((a, b) => a.from - b.from)
      .slice(0, 7);
  } catch (err) {
    if (signal.aborted) throw err;
    console.warn('Deep report synthesis failed:', (err as Error).message);
    // The parts stand on their own; the overview falls back to their summaries.
    abstract = parts.map((p) => p.summary).join(' ');
  }
  if (failed.length) {
    limitations = `${limitations} ${failed.length === 1 ? 'One part' : `${failed.length} parts`} couldn’t be written: ${failed.join('; ')}.`.trim();
  }
  yield step('synthesis', 'Finished the report', true);

  // Renumber citations in reading order, keeping only cited sources.
  const order = new Map<number, number>();
  const see = (n: number) => {
    if (valid.has(n) && !order.has(n)) order.set(n, order.size + 1);
  };
  const scan = (text: string) => {
    for (const m of text.matchAll(/\[(\d+)\]/g)) see(Number(m[1]));
  };
  scan(abstract);
  answers.forEach((a) => scan(a.text));
  for (const p of parts) {
    scan(p.summary);
    p.sections.forEach((s) => scan(s.text));
    p.facts.forEach((f) => f.sources.forEach(see));
    p.dataset?.sources.forEach(see);
    p.figures.forEach(see);
  }
  events.forEach((e) => {
    scan(e.detail);
    e.sources.forEach(see);
  });
  const re = (text: string) => text.replace(/\[(\d+)\]/g, (_, n: string) => (order.has(Number(n)) ? `[${order.get(Number(n))}]` : ''));
  const reList = (ns: number[]) => ns.filter((n) => order.has(n)).map((n) => order.get(n)!);
  const sources: ReportSource[] = [...order.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([old, n]) => {
      const { text: _text, n: _old, ...rest } = book.get(old);
      return { ...rest, n };
    });

  const report: DeepReport = {
    id: `r${Date.now().toString(36)}`,
    topic,
    title: plan.title,
    createdAt: new Date().toISOString(),
    web,
    model: CHAT_MODEL,
    abstract: re(abstract),
    questions: plan.questions,
    answers: answers.map((a) => ({ ...a, text: re(a.text) })),
    parts: parts.map((p) => ({
      ...p,
      summary: re(p.summary),
      sections: p.sections.map((s) => ({ ...s, text: re(s.text) })),
      facts: p.facts.map((f) => ({ ...f, sources: reList(f.sources) })),
      dataset: p.dataset ? { ...p.dataset, sources: reList(p.dataset.sources) } : null,
      figures: reList(p.figures),
    })),
    events: events.map((e) => ({ ...e, detail: re(e.detail), sources: reList(e.sources) })),
    eras,
    limitations,
    method: {
      queries,
      passages: stats.passages,
      articles: stats.articles.size,
      liveArticles: stats.live.size,
      figures: stats.figures,
      webPages: stats.web,
      seconds: Math.round((Date.now() - started) / 1000),
    },
    sources,
  };
  yield { type: 'report', report };
}
