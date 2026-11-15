#!/usr/bin/env node
// Record the build's SBOM in the running app (the Health page, MariaDB, search).
//
// Run from CI in a job after the deploy. Where the SBOM comes from, in order:
//   SBOM_FILE            a CycloneDX JSON file on disk
//   CRACI_SBOM_URL       any URL that returns the CycloneDX SBOM ({sha}, {run} and
//                        {digest} are replaced)
//   CRACI_SBOM_DIGEST    the digest (sha256:...) of the image the build pushed: the
//                        SBOM of that image, from CRACI's API
//                        (GET /v1experimental1/sbom/oci_manifest), covering every job
//                        that contributed to it. CRACI answers 409 until those jobs
//                        have finished, so this must run in a later job; it retries.
// CRACI requests carry CRACI_API_TOKEN as a bearer token. The SBOM is posted to
// APP_URL/api/sbom with SBOM_INGEST_TOKEN (the same value the server has). The app
// may still be restarting after a deploy, so that retries too.
import { readFile } from 'node:fs/promises';

const env = (name) => process.env[name]?.trim() || undefined;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CRACI_API = 'https://api.craci.com';
/** CRACI's SBOM for an OCI image manifest or index. */
export const craciImageSbomUrl = (digest, base = CRACI_API) =>
  `${base}/v1experimental1/sbom/oci_manifest?${new URLSearchParams({ digest })}`;

/** Statuses that mean "not yet": the jobs are still finishing, or the service is busy. */
const NOT_YET = new Set([404, 409, 429, 503]);

export async function loadSbom({ file, url, digest, token, sha, run, attempts = 20, waitMs = 10_000 }, fetchImpl = fetch) {
  if (file) return readFile(file, 'utf8');
  const target = (url ?? (digest ? craciImageSbomUrl(digest) : undefined))
    ?.replaceAll('{sha}', sha ?? '')
    .replaceAll('{run}', run ?? '')
    .replaceAll('{digest}', encodeURIComponent(digest ?? ''));
  if (!target) throw new Error('Set SBOM_FILE, CRACI_SBOM_DIGEST or CRACI_SBOM_URL.');
  let last = 'no attempt made';
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchImpl(target, {
        headers: { Accept: 'application/vnd.cyclonedx+json, application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (res.ok) return res.text();
      last = `CRACI answered ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if (!NOT_YET.has(res.status)) break;
    } catch (err) {
      last = err.message;
    }
    if (i < attempts) await sleep(waitMs);
  }
  throw new Error(`The SBOM could not be fetched: ${last}`);
}

export async function publish({ appUrl, ingestToken, sbom, sha, run, source = 'craci', attempts = 10, waitMs = 6000 }, fetchImpl = fetch) {
  const target = new URL('/api/sbom', appUrl);
  target.searchParams.set('source', source);
  if (sha) target.searchParams.set('commit', sha);
  if (run) target.searchParams.set('run', run);
  let last = 'no attempt made';
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetchImpl(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ingestToken}` },
        body: sbom,
      });
      if (res.ok) return res.json();
      last = `the app answered ${res.status}: ${(await res.text()).slice(0, 200)}`;
      // A refused document or token won't get better by waiting.
      if (res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 429) break;
    } catch (err) {
      last = err.message;
    }
    if (i < attempts) await sleep(waitMs);
  }
  throw new Error(`The SBOM could not be recorded: ${last}`);
}

if (process.argv[1]?.endsWith('publish-sbom.mjs')) {
  const sha = env('GITHUB_SHA');
  const run = env('GITHUB_RUN_ID');
  const appUrl = env('APP_URL');
  const ingestToken = env('SBOM_INGEST_TOKEN');
  if (!appUrl || !ingestToken) {
    console.error('APP_URL and SBOM_INGEST_TOKEN are required.');
    process.exit(1);
  }
  const sbom = await loadSbom({
    file: env('SBOM_FILE'),
    url: env('CRACI_SBOM_URL'),
    digest: env('CRACI_SBOM_DIGEST'),
    token: env('CRACI_API_TOKEN'),
    sha,
    run,
  });
  const { build, duplicate } = await publish({ appUrl, ingestToken, sbom, sha, run });
  console.log(duplicate ? `Already recorded (build ${build.id}).` : `Recorded build ${build.id}: ${build.components} components.`);
}
