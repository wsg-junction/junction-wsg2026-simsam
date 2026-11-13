import test from 'node:test';
import assert from 'node:assert/strict';
import { discover, fetchArticle, WikiClient } from './fetch-wikipedia.mjs';

test('category discovery balances topics, deduplicates, and resumes pagination', async () => {
  let id = 1;
  const client = { async request(params) {
    const members = [{ pageid: id++, ns: 0, title: `Article ${id}` }];
    if (!params.cmcontinue) members.push({ ns: 14, title: `${params.cmtitle}/child` });
    return { query: { categorymembers: members }, ...(!params.cmcontinue ? { continue: { cmcontinue: 'next', continue: '-||' } } : {}) };
  } };
  const state = await discover(client, { limit: 8, depth: 1 });
  assert.equal(Object.keys(state.articles).length, 8);
  assert.deepEqual(state.groups.map(group => group.count), [3, 1, 4]);
  const resumed = await discover({ request() { throw new Error('Should not fetch'); } }, { limit: 8, depth: 1, state });
  assert.equal(resumed, state);
});

test('article fetch retains all link pages and caps revision history', async () => {
  const client = { async *pages(params) {
    if (params.prop === 'revisions') {
      assert.equal(params.rvstartid, '100');
      yield { query: { pages: [{ revisions: [{ revid: 100 }, { revid: 99 }, { revid: 98 }] }] } };
      return;
    }
    yield { query: { pages: [{ title: 'Finland', fullurl: 'https://en.wikipedia.org/wiki/Finland', extract: 'Article text',
      revisions: [{ revid: 100, slots: { main: { content: 'Wiki text' } } }],
      links: [{ title: 'Europe' }], categories: [{ title: 'Category:Finland' }] }] } };
    yield { query: { pages: [{ links: [{ title: 'Europe' }, { title: 'Helsinki' }] }] } };
  } };
  const article = await fetchArticle(client, { pageid: 1 }, 2);
  assert.deepEqual(article.links, ['Europe', 'Helsinki']);
  assert.equal(article.history.length, 2);
  assert.equal(article.wikitext, 'Wiki text');
  assert.equal(article.revisionUrl, 'https://en.wikipedia.org/w/index.php?oldid=100');
});

test('API client sends identification and follows continuation', async () => {
  let calls = 0;
  const client = new WikiClient({ userAgent: 'test-contact', delay: 0, fetchImpl: async (url, options) => {
    assert.equal(options.headers['User-Agent'], 'test-contact');
    assert.equal(url.searchParams.get('maxlag'), '5');
    calls++;
    if (calls === 2) assert.equal(url.searchParams.get('plcontinue'), 'next');
    return new Response(JSON.stringify(calls === 1 ? { continue: { plcontinue: 'next', continue: '||' } } : {}));
  } });
  const pages = [];
  for await (const page of client.pages({ prop: 'links' })) pages.push(page);
  assert.equal(pages.length, 2);
});
