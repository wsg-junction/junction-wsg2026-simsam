import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { craciImageSbomUrl, loadSbom, publish } from './publish-sbom.mjs';

const listen = (handler) =>
  new Promise((resolve) => {
    const server = createServer(handler).listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });

test('posts the SBOM with the ingest token and the build metadata', async () => {
  let seen;
  const { server, url } = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = { url: req.url, auth: req.headers.authorization, body };
      res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({ build: { id: 7, components: 2 }, duplicate: false }));
    });
  });
  const result = await publish({ appUrl: url, ingestToken: 'secret', sbom: '{"components":[]}', sha: 'abc123', run: '99' });
  server.close();
  assert.equal(result.build.id, 7);
  assert.equal(seen.auth, 'Bearer secret');
  assert.equal(seen.url, '/api/sbom?source=craci&commit=abc123&run=99');
  assert.equal(seen.body, '{"components":[]}');
});

test('retries while the app is restarting, then gives up on a refused document', async () => {
  let calls = 0;
  const { server, url } = await listen((_req, res) => {
    calls++;
    res.writeHead(calls < 3 ? 502 : 200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ build: { id: 1, components: 1 } }));
  });
  const ok = await publish({ appUrl: url, ingestToken: 't', sbom: '{}', attempts: 5, waitMs: 5 });
  assert.equal(ok.build.id, 1);
  assert.equal(calls, 3);
  server.close();

  const refused = await listen((_req, res) => res.writeHead(400).end('{"error":"no components"}'));
  await assert.rejects(publish({ appUrl: refused.url, ingestToken: 't', sbom: '{}', attempts: 5, waitMs: 5 }), /answered 400/);
  refused.server.close();
});

test('fetches the SBOM from the CRACI URL with a bearer token, filling in {sha} and {run}', async () => {
  let seen;
  const { server, url } = await listen((req, res) => {
    seen = { url: req.url, auth: req.headers.authorization };
    res.writeHead(200).end('{"components":[{"name":"x"}]}');
  });
  const text = await loadSbom({ url: `${url}/runs/{run}/sbom?commit={sha}`, token: 'craci-token', sha: 'abc', run: '5' });
  server.close();
  assert.equal(seen.url, '/runs/5/sbom?commit=abc');
  assert.equal(seen.auth, 'Bearer craci-token');
  assert.match(text, /"name":"x"/);
});

test('the image SBOM is requested by digest, and CRACI saying "not finished yet" (409) is waited out', async () => {
  const digest = 'sha256:' + 'a'.repeat(64);
  assert.equal(
    craciImageSbomUrl(digest),
    'https://api.craci.com/v1experimental1/sbom/oci_manifest?digest=sha256%3A' + 'a'.repeat(64),
  );
  let calls = 0;
  let seen;
  const { server, url } = await listen((req, res) => {
    calls++;
    seen = { url: req.url, auth: req.headers.authorization };
    res.writeHead(calls < 3 ? 409 : 200).end(calls < 3 ? 'a contributing job has not finished' : '{"components":[]}');
  });
  // Point the digest URL at the local server through the {digest} placeholder form.
  const text = await loadSbom({ url: `${url}/oci?digest={digest}`, digest, token: 'tok', attempts: 5, waitMs: 5 });
  server.close();
  assert.equal(calls, 3);
  assert.equal(seen.auth, 'Bearer tok');
  assert.equal(seen.url, '/oci?digest=sha256%3A' + 'a'.repeat(64));
  assert.equal(text, '{"components":[]}');
});

test('a refused request (401) is not retried', async () => {
  let calls = 0;
  const { server, url } = await listen((_req, res) => {
    calls++;
    res.writeHead(401).end('bad token');
  });
  await assert.rejects(loadSbom({ url, token: 'x', attempts: 5, waitMs: 5 }), /answered 401/);
  server.close();
  assert.equal(calls, 1);
});
