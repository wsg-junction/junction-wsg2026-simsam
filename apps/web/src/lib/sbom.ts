import type { SbomSearchHit, SbomSummary } from '@simsam/models';

/** The software bill of materials Atlas is built from (what the Health page shows). */
export async function fetchSbom(signal?: AbortSignal): Promise<SbomSummary> {
  const res = await fetch('/api/sbom', { signal });
  if (!res.ok) throw new Error(`The SBOM couldn’t be loaded (${res.status}).`);
  return (await res.json()) as SbomSummary;
}

/** Components matching a question, found by meaning. */
export async function searchSbom(query: string, signal?: AbortSignal): Promise<SbomSearchHit[]> {
  const res = await fetch(`/api/sbom/search?${new URLSearchParams({ q: query, limit: '8' })}`, { signal });
  if (!res.ok) throw new Error(`The search failed (${res.status}).`);
  return ((await res.json()) as { results: SbomSearchHit[] }).results;
}
