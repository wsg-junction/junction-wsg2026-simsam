import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { makeState, historyStep, discoverStep, parseOptions, run } from './expand-wikipedia.mjs';
import { WikiClient } from './fetch-wikipedia.mjs';

const revision = (revid, parentid) => ({ revid, parentid, timestamp: `2020-01-${String(revid).padStart(2, '0')}T00:00:00Z`, slots: { main: { content: `revision ${revid}` } } });

test('migration preserves article selection and adds broad topics without exceeding target', async () => {
  const article = { pageid: 1, title: 'Existing', topics: ['computer-science'] };
  const legacy = { articles: { 1: article }, groups: [{ name: 'computer-science', count: 1, seen: [], queue: [] }] };
  const state = makeState(null, legacy, 30);
  assert.equal(state.articles[1], article);
  assert.ok(state.groups.some(group => group.name === 'gaming'));
  assert.equal(state.groups.reduce((sum, group) => sum + group.quota, 0), 30);
  const client = { request: async () => ({ query: { pages: [{ pageid: 2, ns: 0, title: 'New' }] } }) };
  while (Object.keys(state.articles).length < 2) await discoverStep(client, state, { limit: 2, depth: 3 });
  const added = await discoverStep({ request() { throw Error('Over target'); } }, state, { limit: 2, depth: 3 });
  assert.deepEqual(added, []);
});

test('history reuses cached revisions, paginates to completion, and skips completed history', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wiki-history-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const article = { pageid: 1, title: 'Example', revisionId: 5, history: [revision(5, 4), revision(4, 3)] };
  let calls = 0;
  const client = { request: async params => {
    calls++;
    if (calls === 1) {
      assert.equal(params.rvstartid, '3');
      return { query: { pages: [{ revisions: [revision(3, 2), revision(2, 1)] }] }, continue: { rvcontinue: 'cursor', continue: '||' } };
    }
    assert.equal(params.rvcontinue, 'cursor');
    assert.equal(params.rvlimit, '50');
    return { query: { pages: [{ revisions: [revision(1, 0)] }] } };
  } };
  assert.equal((await historyStep(client, article, directory)).complete, false);
  const complete = await historyStep(client, { pageid: 1 }, directory);
  assert.equal(complete.complete, true);
  assert.equal(complete.revisionCount, 5);
  await historyStep({ request() { throw Error('Should be cached'); } }, { pageid: 1 }, directory);
  assert.equal(calls, 2);
});

test('crash recovery commits an already-downloaded batch without another API request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wiki-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const article = { pageid: 1, title: 'Example', revisionId: 2, history: [revision(2, 1)] };
  await assert.rejects(historyStep({ request() { throw Error('offline'); } }, article, directory), /offline/);
  const batchPath = join(directory, 'history', '1', 'batch-000000.json.gz');
  await writeFile(batchPath, gzipSync(JSON.stringify({ pageid: 1, revisions: [revision(1, 0)], next: null })));
  const state = await historyStep({ request() { throw Error('Must reuse batch'); } }, article, directory);
  assert.equal(state.complete, true);
  assert.equal(state.revisionCount, 2);
  const stored = JSON.parse(gunzipSync(await readFile(batchPath)));
  assert.equal(stored.revisions[0].slots.main.content, 'revision 1');
});

test('failed history request preserves cursor for retry', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wiki-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const article = { pageid: 1, title: 'Example', revisionId: 2, history: [revision(2, 1)] };
  await assert.rejects(historyStep({ request() { throw Error('offline'); } }, article, directory), /offline/);
  const state = JSON.parse(await readFile(join(directory, 'history', '1', 'state.json')));
  assert.equal(state.batchCount, 0);
  assert.deepEqual(state.next, { rvstartid: '1' });
});

test('throttle shares start rate and retries 429 with common cooldown', async () => {
  const waits = [];
  let calls = 0;
  const client = new WikiClient({ userAgent: 'test', delay: 500, retries: 2,
    sleepImpl: async ms => { waits.push(ms); }, fetchImpl: async () => {
      calls++;
      return calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '2' } }) : Response.json({ query: {} });
    } });
  await client.request({ prop: 'info' });
  assert.equal(calls, 2);
  assert.ok(waits[1] >= 1900);
  assert.ok(client.cooldown > Date.now());
});

test('time budget prevents any request from starting after deadline', async () => {
  const client = new WikiClient({ userAgent: 'test', deadline: Date.now() - 1,
    fetchImpl() { throw Error('Should not reach network'); } });
  await assert.rejects(client.request({}), /Time budget/);
  assert.equal(parseOptions([]).hours, 8);
  assert.equal(parseOptions([]).limit, 30000);
  assert.throws(() => parseOptions(['--concurrency', '100']), /4 or below/);
});

test('oversized history responses reduce the batch size without committing truncated revisions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wiki-truncated-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const client = { request: async params => {
    calls++;
    if (calls === 1) return { warnings: { result: { warnings: 'This result was truncated because it would otherwise be larger than the limit.' } } };
    assert.equal(params.rvlimit, '25');
    return { query: { pages: [{ revisions: [revision(1, 0)] }] } };
  } };
  const state = await historyStep(client, { pageid: 1, title: 'Large article', revisionId: 1 }, directory);
  assert.equal(state.revisionCount, 1);
  assert.equal(state.complete, true);
  assert.equal(state.requestLimit, 25);
});

test('expansion preserves cached files byte-for-byte and resumes completed full histories without network calls', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wiki-expand-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'articles'));
  const article = { pageid: 1, title: 'Cached', topics: ['computer-science'], revisionId: 2, history: [revision(2, 1)] };
  const original = JSON.stringify(article, null, 2);
  await writeFile(join(directory, 'articles', '1.json'), original);
  let requests = 0;
  const client = { request: async () => {
    requests++;
    return { query: { pages: [{ revisions: [revision(1, 0)] }] } };
  }, pages() { throw Error('Must not redownload current article'); } };
  const options = { ...parseOptions([]), output: directory, limit: 1 };
  await run(options, { client });
  assert.equal(requests, 1);
  assert.equal(await readFile(join(directory, 'articles', '1.json'), 'utf8'), original);
  await run(options, { client: { request() { throw Error('Must not fetch completed history'); } } });
  const manifest = JSON.parse(await readFile(join(directory, 'expansion-manifest.json')));
  assert.equal(manifest.completeHistories, 1);
  assert.equal(manifest.revisions, 2);
  assert.equal(manifest.downloaded, 0);
  assert.equal(manifest.failures.length, 0);
});
