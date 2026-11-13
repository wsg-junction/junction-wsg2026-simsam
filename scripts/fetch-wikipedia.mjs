#!/usr/bin/env node
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export const TOPICS = [
  { name: 'european-history', weight: 0.375, categories: ['History of Europe', 'European history by country', 'Ancient Europe', 'Medieval Europe', 'Early modern Europe', 'Modern Europe'] },
  { name: 'finland-history', weight: 0.1875, categories: ['History of Finland', 'Political history of Finland', 'Military history of Finland'] },
  { name: 'computer-science', weight: 0.4375, categories: ['Computer science', 'Algorithms', 'Programming languages', 'Artificial intelligence', 'History of computing', 'Computer scientists', 'Databases'] },
];

export class WikiClient {
  constructor({ userAgent, delay = 500, fetchImpl = fetch }) {
    this.userAgent = userAgent;
    this.delay = delay;
    this.fetchImpl = fetchImpl;
  }
  async request(params) {
    const url = new URL('https://en.wikipedia.org/w/api.php');
    url.search = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', maxlag: '5', ...params });
    for (let attempt = 0; attempt < 6; attempt++) {
      await sleep(this.delay);
      let wait = Math.min(60_000, 1000 * 2 ** attempt);
      try {
        const response = await this.fetchImpl(url, {
          headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
          signal: AbortSignal.timeout(60_000),
        });
        const retryAfter = Number(response.headers.get('retry-after'));
        if (Number.isFinite(retryAfter)) wait = Math.max(wait, retryAfter * 1000);
        if (!response.ok) {
          if (response.status !== 429 && response.status < 500) throw new Error(`HTTP ${response.status}: ${url}`);
        } else {
          const data = await response.json();
          if (!data.error) return data;
          if (!['maxlag', 'ratelimited', 'readonly'].includes(data.error.code)) {
            throw new Error(`Wikipedia API: ${data.error.code}: ${data.error.info}`);
          }
        }
      } catch (error) {
        if (error.message.startsWith('HTTP ') || error.message.startsWith('Wikipedia API:') || attempt === 5) throw error;
      }
      if (attempt === 5) throw new Error('Wikipedia API unavailable after six attempts');
      await sleep(wait);
    }
  }
  async *pages(params) {
    let continuation = {};
    do {
      const data = await this.request({ ...params, ...continuation });
      yield data;
      continuation = data.continue;
    } while (continuation);
  }
}

async function saveJson(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n');
  await rename(`${path}.tmp`, path);
}

export async function discover(client, options, checkpoint = async () => {}) {
  const { limit, depth } = options;
  const state = options.state ?? {
    articles: {},
    groups: TOPICS.map(topic => ({ name: topic.name, count: 0, seen: [], queue: topic.categories.map(title => ({ title: `Category:${title}`, depth: 0 })) })),
  };
  const quotas = TOPICS.map((topic, i) => i === TOPICS.length - 1
    ? limit - TOPICS.slice(0, i).reduce((sum, t) => sum + Math.floor(limit * t.weight), 0)
    : Math.floor(limit * topic.weight));
  let active = true;
  while (active) {
    active = false;
    for (const [index, group] of state.groups.entries()) {
      if (group.count >= quotas[index] || !group.queue.length) continue;
      active = true;
      const item = group.queue[0];
      const data = await client.request({ list: 'categorymembers', cmtitle: item.title,
        cmnamespace: '0|14', cmtype: 'page|subcat', cmlimit: '500', ...(item.continuation ?? {}) });
      for (const member of data.query?.categorymembers ?? []) {
        if (member.ns === 14 && item.depth < depth && !group.seen.includes(member.title)
          && !group.queue.some(entry => entry.title === member.title)) {
          group.queue.push({ title: member.title, depth: item.depth + 1 });
        }
        if (member.ns !== 0) continue;
        const existing = state.articles[member.pageid];
        if (existing) {
          if (!existing.topics.includes(group.name)) existing.topics.push(group.name);
        } else if (group.count < quotas[index]) {
          state.articles[member.pageid] = { pageid: member.pageid, title: member.title, topics: [group.name], discoveredVia: item.title };
          group.count++;
        }
      }
      if (data.continue) item.continuation = data.continue;
      else { group.queue.shift(); group.seen.push(item.title); }
      await checkpoint(state);
      console.log(`Discover ${group.name}: ${group.count}/${quotas[index]} (${group.queue.length} categories queued)`);
    }
  }
  return state;
}

export async function fetchArticle(client, article, historyLimit = 0) {
  let page;
  const links = new Set();
  const categories = new Set();
  for await (const data of client.pages({ pageids: String(article.pageid),
    prop: 'info|extracts|revisions|links|categories|pageprops', inprop: 'url',
    explaintext: '1', rvprop: 'ids|timestamp|sha1|content', rvslots: 'main',
    plnamespace: '0', pllimit: 'max', cllimit: 'max', clshow: '!hidden',
  })) {
    const current = data.query?.pages?.[0];
    if (!current || current.missing || current.invalid) throw new Error(`Article unavailable: ${article.title}`);
    page ??= current;
    for (const link of current.links ?? []) links.add(link.title);
    for (const category of current.categories ?? []) categories.add(category.title);
  }
  const revision = page.revisions?.[0];
  const result = { ...article, title: page.title, language: 'en', url: page.fullurl,
    revisionUrl: revision ? `https://en.wikipedia.org/w/index.php?oldid=${revision.revid}` : null,
    fetchedAt: new Date().toISOString(), revisionId: revision?.revid,
    revisionTimestamp: revision?.timestamp, sha1: revision?.sha1,
    text: page.extract ?? '', wikitext: revision?.slots?.main?.content ?? '',
    wikidataId: page.pageprops?.wikibase_item ?? null,
    isDisambiguation: Object.hasOwn(page.pageprops ?? {}, 'disambiguation'),
    links: [...links], categories: [...categories],
    attribution: { source: 'English Wikipedia', authorsUrl: `${page.fullurl}?action=history`,
      license: 'CC BY-SA 4.0', licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/' },
    history: [], historyRequested: historyLimit,
  };
  if (historyLimit) {
    // Anchor to the current revision so edits during the crawl do not shift the window.
    for await (const data of client.pages({ pageids: String(article.pageid), prop: 'revisions',
      rvstartid: String(revision.revid), rvdir: 'older', rvslots: 'main',
      rvprop: 'ids|timestamp|user|comment|sha1|content', rvlimit: String(Math.min(historyLimit, 50)) })) {
      result.history.push(...(data.query?.pages?.[0]?.revisions ?? []).slice(0, historyLimit - result.history.length));
      if (result.history.length >= historyLimit) break;
    }
  }
  return result;
}

function argumentsFrom(argv) {
  const options = { limit: 4000, depth: 3, history: 0, delay: 500, output: 'data/wikipedia-en', userAgent: process.env.WIKIPEDIA_USER_AGENT };
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (name === 'help') return null;
    if (!Object.hasOwn(options, name) || !argv[i + 1]) throw new Error(`Unknown or missing option: ${argv[i]}`);
    options[name] = ['limit', 'depth', 'history', 'delay'].includes(name) ? Number(argv[++i]) : argv[++i];
  }
  for (const name of ['limit', 'depth', 'history', 'delay']) {
    if (!Number.isInteger(options[name]) || options[name] < (name === 'limit' ? 1 : 0)) throw new Error(`Invalid --${name}`);
  }
  if (!options.userAgent) throw new Error('Set WIKIPEDIA_USER_AGENT or --userAgent to an application name and real contact URL/email.');
  return options;
}

async function main() {
  const options = argumentsFrom(process.argv.slice(2));
  if (!options) {
    console.log('Usage: node scripts/fetch-wikipedia.mjs --userAgent "YourApp/1.0 (contact URL or email)" [--limit 4000] [--depth 3] [--history 0] [--delay 500] [--output data/wikipedia-en]');
    return;
  }
  const output = resolve(options.output);
  await mkdir(join(output, 'articles'), { recursive: true });
  const client = new WikiClient(options);
  const statePath = join(output, 'discovery.json');
  let state;
  try { state = JSON.parse(await readFile(statePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = { limit: options.limit, depth: options.depth };
  if (state && JSON.stringify(state.config) !== JSON.stringify(config)) {
    throw new Error('Discovery settings differ from the saved run. Use another --output directory.');
  }
  state = await discover(client, { ...options, state }, value => saveJson(statePath, { ...value, config }));
  await saveJson(statePath, { ...state, config });
  const articles = Object.values(state.articles);
  let completed = 0;
  const failures = [];
  for (const article of articles) {
    const path = join(output, 'articles', `${article.pageid}.json`);
    try {
      let cached;
      try { cached = JSON.parse(await readFile(path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!cached || (cached.historyRequested ?? 0) < options.history) {
        await saveJson(path, await fetchArticle(client, article, options.history));
      }
      completed++;
      console.log(`Articles ${completed}/${articles.length}: ${article.title}`);
    } catch (error) {
      failures.push({ ...article, error: error.message });
      console.error(`Failed ${article.title}: ${error.message}`);
    }
  }
  await saveJson(join(output, 'manifest.json'), { createdAt: new Date().toISOString(),
    options: { ...config, history: options.history }, discovered: articles.length, completed,
    topics: state.groups.map(({ name, count }) => ({ name, count })), failures,
    coverage: 'Bounded category crawl; not exhaustive. Categories may include loosely related articles.',
    historyCoverage: 'Most recent N revisions including current; not full edit history.',
  });
  if (articles.length < options.limit) console.warn('Category queues exhausted before the requested limit. Increase --depth in a new output directory.');
  if (failures.length) process.exitCode = 1;
  console.log(`Saved ${completed} articles to ${output}. Rerun the same command to resume/retry.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
