import type { ArticleTimeline, RevisionDiff } from '@simsam/models';

/** The article isn't in the local collection, so the history panel has nothing to scan. */
export class TimelineUnavailableError extends Error {}

/** An article's substantial changes (scanned on the server, then cached there). */
export async function fetchArticleTimeline(title: string, signal?: AbortSignal): Promise<ArticleTimeline> {
  const res = await fetch('/api/article-history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title }),
    signal,
  });
  if (res.status === 404) throw new TimelineUnavailableError(title);
  if (!res.ok) throw new Error(`History request failed with ${res.status}`);
  return (await res.json()) as ArticleTimeline;
}

const diffCache = new Map<string, Promise<RevisionDiff>>();

/** What one edit added and removed, from the versions stored in MariaDB. */
export function fetchRevisionDiff(pageId: number, revisionId: number): Promise<RevisionDiff> {
  const key = `${pageId}:${revisionId}`;
  let pending = diffCache.get(key);
  if (!pending) {
    pending = fetch(`/api/article-history/diff?${new URLSearchParams({ pageId: String(pageId), revisionId: String(revisionId) })}`).then(
      (res) => {
        if (!res.ok) throw new Error(`Diff request failed with ${res.status}`);
        return res.json() as Promise<RevisionDiff>;
      },
    );
    diffCache.set(key, pending);
    pending.catch(() => diffCache.delete(key));
  }
  return pending;
}
