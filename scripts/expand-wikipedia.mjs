#!/usr/bin/env node
// Breadth-first collection plus fair, incremental full revision-history downloads.
import { mkdir, readFile, writeFile, rename, open, unlink, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { WikiClient, fetchArticle } from './fetch-wikipedia.mjs';

export const TOPICS = [
  { name: 'european-history', weight: 2, seeds: ['History of Europe', 'Roman Empire', 'World War II'], categories: ['History of Europe', 'Ancient Europe', 'Medieval Europe', 'Modern Europe'] },
  { name: 'finland-history', weight: 1, seeds: ['History of Finland', 'Finland', 'Finnish Civil War'], categories: ['History of Finland', 'Political history of Finland', 'Military history of Finland'] },
  { name: 'computer-science', weight: 3, seeds: ['Computer science', 'Algorithm', 'Artificial intelligence'], categories: ['Computer science', 'Algorithms', 'Programming languages', 'Artificial intelligence', 'Databases'] },
  { name: 'sports', weight: 3, seeds: ['Sport', 'Association football', 'Basketball', 'Olympic Games', 'Formula One'], categories: ['Sports', 'Association football', 'Basketball', 'Olympic Games', 'Tennis', 'Motorsport', 'Ice hockey'] },
  { name: 'gaming', weight: 3, seeds: ['Video game', 'Minecraft', 'Esports', 'Chess'], categories: ['Video games', 'Video game franchises', 'Video game genres', 'Video game developers', 'Esports', 'Board games'] },
  { name: 'science', weight: 3, seeds: ['Physics', 'Chemistry', 'Mathematics', 'Astronomy'], categories: ['Physics', 'Chemistry', 'Mathematics', 'Astronomy', 'Scientific discoveries'] },
  { name: 'geography', weight: 2, seeds: ['Earth', 'Europe', 'Asia', 'Africa'], categories: ['Geography', 'Countries', 'Cities', 'Mountains', 'Rivers', 'Oceans'] },
  { name: 'technology', weight: 2, seeds: ['Technology', 'Internet', 'Space exploration'], categories: ['Technology', 'Engineering', 'Robotics', 'Spaceflight', 'Renewable energy', 'Electronics'] },
  { name: 'film-and-tv', weight: 2, seeds: ['Film', 'Television', 'Cinema of the United States'], categories: ['Films', 'Television series', 'Film directors', 'Animation', 'Film genres'] },
  { name: 'music', weight: 2, seeds: ['Music', 'Rock music', 'Hip-hop', 'Classical music'], categories: ['Music', 'Musical genres', 'Musical instruments', 'Musicians', 'Albums'] },
  { name: 'arts-and-literature', weight: 2, seeds: ['Art', 'Literature', 'Architecture', 'William Shakespeare'], categories: ['Visual arts', 'Literature', 'Novels', 'Architecture', 'Mythology'] },
  { name: 'society', weight: 2, seeds: ['Philosophy', 'Democracy', 'Economics', 'Psychology'], categories: ['Philosophy', 'Politics', 'Economics', 'Psychology', 'Sociology', 'World history'] },
  { name: 'nature-and-health', weight: 3, seeds: ['Biology', 'Evolution', 'Human body', 'Climate change'], categories: ['Biology', 'Animals', 'Plants', 'Ecology', 'Medicine', 'Human anatomy'] },
];

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomic(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value) + '\n');
  await rename(`${path}.tmp`, path);
}
async function gzipJson(path, value) {
  await writeFile(`${path}.tmp`, gzipSync(JSON.stringify(value)));
  await rename(`${path}.tmp`, path);
}
async function readGzip(path) {
  try { return JSON.parse(gunzipSync(await readFile(path))); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function makeState(previous, legacy, limit) {
  const state = previous ?? { version: 1, articles: legacy?.articles ?? {}, groups: [], turns: 0 };
  const totalWeight = TOPICS.reduce((sum, topic) => sum + topic.weight, 0);
  let allocated = 0;
  state.groups = TOPICS.map((topic, index) => {
    const old = state.groups.find(group => group.name === topic.name)
      ?? legacy?.groups?.find(group => group.name === topic.name);
    const quota = index === TOPICS.length - 1 ? limit - allocated : Math.floor(limit * topic.weight / totalWeight);
    allocated += quota;
    // Preserve old category positions while introducing explicit well-known seed pages.
    return { name: topic.name, count: old?.count ?? 0, seen: old?.seen ?? [],
      queue: old?.queue ?? topic.categories.map(title => ({ title: `Category:${title}`, depth: 0 })),
      seedsDone: old?.seedsDone ?? false, quota };
  });
  return state;
}

export async function discoverStep(client, state, options) {
  let selectedCount = Object.keys(state.articles).length;
  const total = () => selectedCount;
  let group;
  for (let i = 0; i < state.groups.length; i++) {
    const candidate = state.groups[state.turns++ % state.groups.length];
    if (candidate.count < candidate.quota && (!candidate.seedsDone || candidate.queue.length)) { group = candidate; break; }
  }
  if (!group || total() >= options.limit) return [];
  const topic = TOPICS.find(value => value.name === group.name);
  const add = members => {
    const added = [];
    for (const member of members) {
      if (member.ns !== 0 || member.missing || member.invalid) continue;
      const existing = state.articles[member.pageid];
      if (existing) {
        if (!existing.topics.includes(group.name)) existing.topics.push(group.name);
      } else if (group.count < group.quota && total() < options.limit) {
        const article = { pageid: member.pageid, title: member.title, topics: [group.name], discoveredVia: group.name };
        state.articles[member.pageid] = article;
        selectedCount++;
        group.count++;
        added.push(article);
      }
    }
    return added;
  };
  if (!group.seedsDone) {
    const data = await client.request({ titles: topic.seeds.join('|'), redirects: '1' });
    const added = add(data.query?.pages ?? []);
    group.seedsDone = true;
    return added;
  }
  const item = group.queue[0];
  const data = await client.request({ list: 'categorymembers', cmtitle: item.title,
    cmnamespace: '0|14', cmtype: 'page|subcat', cmlimit: '500', ...(item.continuation ?? {}) });
  const members = data.query?.categorymembers ?? [];
  const added = add(members);
  for (const member of members) {
    if (member.ns === 14 && item.depth < options.depth && !group.seen.includes(member.title)
      && !group.queue.some(entry => entry.title === member.title)) group.queue.push({ title: member.title, depth: item.depth + 1 });
  }
  if (data.continue) item.continuation = data.continue;
  else { group.queue.shift(); group.seen.push(item.title); }
  console.log(`Discover ${group.name}: ${group.count}/${group.quota}; total ${total()}/${options.limit}`);
  return added;
}

// Each batch is committed before its cursor: a crash between writes reuses the
// existing batch instead of downloading it again. Batch files contain next cursor.
export async function historyStep(client, article, output) {
  const directory = join(output, 'history', String(article.pageid));
  await mkdir(directory, { recursive: true });
  const statePath = join(directory, 'state.json');
  let state = await readJson(statePath);
  if (!state) {
    const oldHistory = article.history ?? [];
    const revisions = [...new Map(oldHistory.map(revision => [revision.revid, revision])).values()];
    const seedPath = join(directory, 'seed.json.gz');
    // Seed is authoritative only when accompanied by its state; atomic replacement is safe.
    await gzipJson(seedPath, { revisions });
    const oldest = revisions.at(-1);
    const hasParent = oldest && Number.isInteger(oldest.parentid);
    state = { pageid: article.pageid, title: article.title, anchorRevisionId: article.revisionId,
      revisionCount: revisions.length, batchCount: 0,
      complete: !!(hasParent && oldest.parentid === 0),
      next: { rvstartid: String(hasParent && oldest.parentid ? oldest.parentid : oldest?.revid ?? article.revisionId) },
      // When an old seed has no parentid, its last revision is an inclusive boundary.
      boundaryRevisionId: oldest && !hasParent ? oldest.revid : null,
      oldestTimestamp: oldest?.timestamp ?? null, newestTimestamp: revisions[0]?.timestamp ?? null,
      contentUnavailable: revisions.filter(revision => revision.slots?.main?.content === undefined).length,
      coverage: 'Public main-slot revisions through anchorRevisionId; deleted/suppressed content may be unavailable.' };
    if (!article.revisionId) throw new Error(`Missing anchor revision: ${article.pageid}`);
    await atomic(statePath, state);
  }
  if (state.complete) return state;
  const batchPath = join(directory, `batch-${String(state.batchCount).padStart(6, '0')}.json.gz`);
  let batch = await readGzip(batchPath);
  if (!batch) {
    let data;
    let requestLimit = state.requestLimit ?? 50;
    while (true) {
      data = await client.request({ pageids: String(article.pageid), prop: 'revisions',
        rvprop: 'ids|timestamp|user|comment|sha1|size|flags|content', rvslots: 'main',
        rvdir: 'older', rvlimit: String(requestLimit), rvstartid: String(state.anchorRevisionId), ...state.next });
      if (!data.warnings) break;
      if (/truncat|larger than the limit/i.test(JSON.stringify(data.warnings)) && requestLimit > 1) {
        requestLimit = Math.max(1, Math.floor(requestLimit / 2));
        state.requestLimit = requestLimit;
        await atomic(statePath, state);
        console.warn(`Reducing history batch for ${article.title} to ${requestLimit} revisions (API response limit).`);
        continue;
      }
      throw new Error(`History API warning: ${JSON.stringify(data.warnings)}`);
    }
    const page = data.query?.pages?.[0];
    if (!page || page.missing || page.invalid) throw new Error(`History unavailable: ${article.title}`);
    if (!Array.isArray(page.revisions)) throw new Error(`Missing revision list: ${article.title}`);
    const revisions = page.revisions.filter(revision => revision.revid !== state.boundaryRevisionId);
    if (data.continue && JSON.stringify(data.continue) === JSON.stringify(state.next)) throw new Error('History cursor did not advance');
    batch = { pageid: article.pageid, revisions, next: data.continue ?? null };
    await gzipJson(batchPath, batch);
  }
  state = { ...state, revisionCount: state.revisionCount + batch.revisions.length,
    batchCount: state.batchCount + 1, complete: !batch.next, next: batch.next,
    boundaryRevisionId: null,
    oldestTimestamp: batch.revisions.at(-1)?.timestamp ?? state.oldestTimestamp,
    newestTimestamp: state.newestTimestamp ?? batch.revisions[0]?.timestamp ?? null,
    contentUnavailable: state.contentUnavailable + batch.revisions.filter(revision => revision.slots?.main?.content === undefined).length };
  await atomic(statePath, state);
  return state;
}

export function parseOptions(argv) {
  const options = { limit: 30000, depth: 3, hours: 8, concurrency: 4, delay: 500, retries: 8,
    output: 'data/wikipedia-en', userAgent: process.env.WIKIPEDIA_USER_AGENT
      ?? 'SimsamWikipediaResearch/2.0 (https://github.com/wsg-junction/junction-wsg2026-simsam)' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--help') return null;
    const key = argv[i].replace(/^--/, '');
    if (!Object.hasOwn(options, key) || !argv[i + 1]) throw new Error(`Unknown or missing option: ${argv[i]}`);
    options[key] = ['output', 'userAgent'].includes(key) ? argv[++i] : Number(argv[++i]);
  }
  for (const key of ['limit', 'depth', 'concurrency', 'delay', 'retries']) {
    if (!Number.isInteger(options[key]) || options[key] < (['depth', 'delay'].includes(key) ? 0 : 1)) throw new Error(`Invalid --${key}`);
  }
  if (options.concurrency > 4) throw new Error('Keep --concurrency at 4 or below for the public API.');
  if (options.delay < 250) throw new Error('Keep the shared request interval at least 250ms.');
  if (!(options.hours > 0) || !Number.isFinite(options.hours)) throw new Error('Invalid --hours');
  return options;
}

export async function run(options, dependencies = {}) {
  const output = resolve(options.output);
  await mkdir(join(output, 'articles'), { recursive: true });
  const lockPath = join(output, '.expand.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = await readJson(lockPath);
    try { process.kill(owner.pid, 0); }
    catch (failure) {
      if (failure.code !== 'ESRCH') throw failure;
      await unlink(lockPath);
      lock = await open(lockPath, 'wx');
    }
    if (!lock) throw new Error(`Another expansion is running (PID ${owner.pid}).`);
  }
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const startedAt = Date.now();
  const deadline = startedAt + options.hours * 3600_000;
  const client = dependencies.client ?? new WikiClient({ ...options, deadline });
  let stopping = false;
  const stop = () => { stopping = true; console.log('Stopping after in-flight work; all saved batches can be resumed.'); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    const statePath = join(output, 'discovery-expanded.json');
    const previous = await readJson(statePath);
    if (previous && previous.depth !== options.depth) throw new Error('Changing depth requires another output directory. Increasing --limit is supported.');
    const legacy = await readJson(join(output, 'discovery.json'));
    const state = makeState(previous, legacy, options.limit);
    state.depth = options.depth;
    // Recover cached files even if they were produced by another earlier fetcher.
    const cachedIds = new Set();
    for (const file of await readdir(join(output, 'articles'))) {
      if (!/^\d+\.json$/.test(file)) continue;
      const id = file.slice(0, -5);
      cachedIds.add(id);
      if (!state.articles[id]) {
        const article = await readJson(join(output, 'articles', file));
        state.articles[id] = { pageid: article.pageid, title: article.title, topics: article.topics ?? [] };
      }
    }
    await atomic(statePath, state);
    const currentQueue = Object.values(state.articles);
    const freshQueue = [];
    const historyQueue = [];
    let currentIndex = 0, freshIndex = 0, currentTurns = 0, historyIndex = 0, turns = 0, discoveryBusy = false;
    let discoveryDone = false, active = 0, lastReport = 0, discoveryRetryAt = 0;
    const retryCounts = new Map();
    const failures = new Map();
    const counters = { cached: 0, downloaded: 0, historyArticles: 0, completeHistories: 0, revisions: 0, historyBatches: 0 };
    const reportPath = join(output, 'expansion-manifest.json');
    const canWork = () => !stopping && Date.now() < deadline;
    const currentRemaining = () => currentQueue.length - currentIndex + freshQueue.length - freshIndex;
    const report = async (final = false) => {
      await atomic(reportPath, { startedAt: new Date(startedAt).toISOString(), updatedAt: new Date().toISOString(),
        deadline: new Date(deadline).toISOString(), final, stopped: stopping || Date.now() >= deadline,
        options, selected: Object.keys(state.articles).length, ...counters,
        queuedCurrent: currentRemaining(), queuedHistory: historyQueue.length - historyIndex,
        discoveryDone, topics: state.groups.map(({ name, count, quota }) => ({ name, count, quota })),
        failures: [...failures.values()],
        historyCoverage: 'See history/<pageid>/state.json for complete status, anchor revision and oldest timestamp. Partial history is NOT complete coverage.',
        countersScope: 'Revisions and completion counts cover articles visited in this run; history state files persist across runs.' });
    };
    const take = () => {
      turns++;
      // Feed new subjects continually while reserving most work for real content/history.
      if (!discoveryBusy && !discoveryDone && Date.now() >= discoveryRetryAt
        && (turns % 6 === 0 || (currentRemaining() === 0 && historyIndex >= historyQueue.length))) {
        discoveryBusy = true;
        return { kind: 'discover' };
      }
      if (historyIndex < historyQueue.length && (turns % 4 !== 1 || currentRemaining() === 0)) {
        return { kind: 'history', article: historyQueue[historyIndex++] };
      }
      if (currentRemaining()) {
        currentTurns++;
        if (freshIndex < freshQueue.length && (currentTurns % 2 === 0 || currentIndex >= currentQueue.length)) {
          return { kind: 'current', article: freshQueue[freshIndex++] };
        }
        return { kind: 'current', article: currentQueue[currentIndex++] };
      }
      if (historyIndex < historyQueue.length) return { kind: 'history', article: historyQueue[historyIndex++] };
      return null;
    };
    const execute = async task => {
      if (task.kind === 'discover') {
        try {
          freshQueue.push(...await discoverStep(client, state, options));
          discoveryDone = Object.keys(state.articles).length >= options.limit || !state.groups.some(group =>
            group.count < group.quota && (!group.seedsDone || group.queue.length));
          await atomic(statePath, state);
          failures.delete('discover');
        } finally { discoveryBusy = false; }
      } else if (task.kind === 'current') {
        const path = join(output, 'articles', `${task.article.pageid}.json`);
        let article = cachedIds.has(String(task.article.pageid)) ? await readJson(path) : null;
        if (article) counters.cached++;
        else {
          article = await fetchArticle(client, task.article);
          await atomic(path, article);
          cachedIds.add(String(article.pageid));
          counters.downloaded++;
          console.log(`Downloaded ${counters.downloaded}: ${article.title}`);
        }
        // Queue only lightweight metadata, never thousands of full revision texts in memory.
        const historyState = await readJson(join(output, 'history', String(article.pageid), 'state.json'));
        counters.historyArticles++;
        counters.revisions += historyState?.revisionCount ?? 0;
        if (historyState?.complete) counters.completeHistories++;
        else historyQueue.push({ pageid: article.pageid, title: article.title });
      } else {
        const path = join(output, 'articles', `${task.article.pageid}.json`);
        const before = await readJson(join(output, 'history', String(task.article.pageid), 'state.json'));
        // Full article is needed only once to seed existing revision history.
        const article = before ? task.article : await readJson(path);
        const after = await historyStep(client, article, output);
        counters.revisions += after.revisionCount - (before?.revisionCount ?? 0);
        counters.historyBatches++;
        if (after.complete) {
          counters.completeHistories++;
          console.log(`History complete: ${task.article.title} (${after.revisionCount} revisions)`);
        } else historyQueue.push(task.article);
      }
    };
    const worker = async () => {
      while (canWork()) {
        const task = take();
        if (!task) {
          if (active === 0 && !discoveryBusy && discoveryDone) break;
          await new Promise(resolve => setTimeout(resolve, 100));
          continue;
        }
        active++;
        const key = `${task.kind}:${task.article?.pageid ?? ''}`;
        try {
          await execute(task);
          failures.delete(key);
          retryCounts.delete(key);
        } catch (error) {
          if (error.message === 'Time budget reached') stopping = true;
          if (['ENOSPC', 'EACCES', 'EPERM'].includes(error.code)) { stopping = true; process.exitCode = 1; }
          if (!canWork()) break;
          const count = (retryCounts.get(key) ?? 0) + 1;
          retryCounts.set(key, count);
          failures.set(key, { kind: task.kind, pageid: task.article?.pageid, title: task.article?.title, error: error.message, attempts: count });
          console.error(`Failed ${key}: ${error.message}`);
          if (task.kind === 'discover') discoveryRetryAt = Date.now() + 60_000;
          else if (count < 3) (task.kind === 'current' ? currentQueue : historyQueue).push(task.article);
        } finally { active--; }
        if (Date.now() - lastReport > 30_000) {
          lastReport = Date.now();
          console.log(`Progress: ${counters.cached} cached, ${counters.downloaded} new, ${counters.revisions} revisions, ${counters.completeHistories} complete histories`);
          // Only one worker writes the report at a time.
          await report();
        }
      }
    };
    console.log(`Starting ${options.hours}h run with ${options.concurrency} workers, shared ${options.delay}ms request interval; target ${options.limit} articles + ALL public revisions.`);
    await Promise.all(Array.from({ length: options.concurrency }, worker));
    await atomic(statePath, state);
    await report(true);
    console.log(`Finished: ${counters.downloaded} new articles, ${counters.revisions} revisions accounted for, ${counters.completeHistories} complete histories. Rerun to continue.`);
    if (failures.size && process.exitCode !== 1) process.exitCode = 1;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = parseOptions(process.argv.slice(2));
  if (!options) console.log('Usage: node scripts/expand-wikipedia.mjs [--limit 30000] [--hours 8] [--concurrency 4] [--delay 500] [--retries 8] [--depth 3] [--output data/wikipedia-en] [--userAgent "App/1.0 (contact URL)"]');
  else run(options).catch(error => { console.error(error); process.exitCode = 1; });
}
