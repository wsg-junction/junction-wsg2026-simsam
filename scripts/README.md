# English Wikipedia collection

## Expand the existing collection with full history

```powershell
node scripts/expand-wikipedia.mjs --limit 30000 --hours 8
```

This is the recommended command for the expanded collection. It adds sports,
gaming, science, geography, technology, film/TV, music, arts/literature, society,
nature and health, while keeping European history, Finland, and computer science.
The target is 30,000 total unique articles (including existing articles), not
30,000 additional articles. These are broad category samples, not popularity rankings.

Full public main-slot revision history is always requested by this command.
Existing article JSON files are never refreshed or overwritten. Their existing
revision history seeds the historical crawl, which continues further into the past.
New article files retain the original schema; full histories live separately.

Four workers share a single 500ms request-start interval (about two requests/s),
maxlag, and a common cooldown for rate-limit/server/network failures. Each request
has up to eight attempts; failed article/history tasks get up to three queue turns.
Permanent failures are reported and retried on the next run. Category failures
preserve their cursor and retry after a cooldown. Never run the legacy and expanded
fetchers simultaneously against this directory.

Work alternates between discovery, current articles and history. History gets
three of every four available content-task turns when both queues have work;
one turn fetches up to 50 revisions, then that article goes to the back of the queue.
This prevents a heavily edited article from monopolizing the eight-hour budget.
Discovery starts with well-known topic seed pages, then explores subcategories.

`--hours` stops starting new requests at the deadline. Ctrl+C stops gracefully.
Rerun the command for another time budget; it resumes unfinished histories and
reuses completed batches and cached articles. Increasing `--limit` in the same
directory is supported; changing `--depth` is not. The default User-Agent identifies
this project's public GitHub repository; override with `--userAgent` if needed.
`--concurrency` accepts 1–4; `--delay` is a shared interval, not a per-worker delay.

Output in the same `data/wikipedia-en/` directory:

- `articles/<pageid>.json`: existing format; already-downloaded files are reused.
- `history/<pageid>/seed.json.gz`: revisions reused from the article JSON.
- `history/<pageid>/batch-000000.json.gz`, etc.: objects with `pageid`, raw
  `revisions` (including main-slot wikitext) and `next` continuation cursor.
- `history/<pageid>/state.json`: `revisionCount`, `complete`, `anchorRevisionId`,
  `oldestTimestamp`, `newestTimestamp`, `contentUnavailable`, and resume cursor.
- `discovery-expanded.json`: expanded topic discovery state; original
  `discovery.json` is preserved.
- `expansion-manifest.json`: progress every ~30 seconds and at completion,
  including failures and complete/partial coverage notes. Original manifest is preserved.

For ingestion, combine `seed.json.gz` and all `batch-*.json.gz` revision arrays;
deduplicate on revision ID. Python's `gzip`/`json` or Node's `gunzipSync`/`JSON.parse`
can read them. Use each revision's actual timestamp for historical queries.
**Only `complete: true` means the public history was exhausted** through the
cached anchor revision. Eight hours is a work budget, not a promise to finish
30,000 full histories. Partial coverage must not be presented as a complete
point-in-time account. Deleted/suppressed revisions and pre-move archived pages
may not be accessible through the API. Watch disk usage during large runs.

A `.expand.lock` prevents duplicate expansion processes. A dead process's lock is
recovered automatically. Logs can be redirected to files with the shell.

```powershell
node --test scripts/fetch-wikipedia.test.mjs scripts/expand-wikipedia.test.mjs
```

## Original small-collection fetcher

Requires Node.js 22+; no extra dependencies or API keys. Run from the repository root:

```powershell
$env:WIKIPEDIA_USER_AGENT = 'YourApp/1.0 (mailto:your-real-email@example.com)'
node scripts/fetch-wikipedia.mjs
```

Replace the example contact with your real email or project contact URL before running.
Default target: 4,000 unique English articles, allocated as 1,500 European history,
750 Finnish history, and 1,750 computer science articles. Uses the official
English Wikipedia Action API, not the challenge dataset.

Category traversal is breadth-first within each topic, round-robin between topics,
and limited to three subcategory levels. These are topic samples, not exhaustive
coverage; Wikipedia categories can drift into loosely related subjects. Each
article records its discovery category and topic labels for later filtering.
Overlapping articles are deduplicated by page ID. Topic counts reflect the group
that first selected each article; an article can have additional topic labels.
If a topic runs out of categories, the script reports a smaller collection.

## Options

```powershell
# Small trial
node scripts/fetch-wikipedia.mjs --limit 30 --output data/wiki-trial

# Include up to 20 most recent revisions per article (including current)
node scripts/fetch-wikipedia.mjs --history 20

# Larger/deeper collection in its own directory
node scripts/fetch-wikipedia.mjs --limit 6000 --depth 4 --output data/wiki-large
```

`--delay 500` sets the minimum pause between requests in milliseconds. Requests
are sequential, use maxlag, and retry transient errors with exponential backoff
and Retry-After handling. A full run can take hours, particularly with history.
Stop with Ctrl+C and rerun the same command to resume. Do not run two processes
against the same output directory. A changed limit or depth requires a different
output directory. Increasing `--history` refetches articles needing more history.
Completed article files otherwise act as a cache; use a new directory to refresh.

## Output

`data/wikipedia-en/` (ignored by Git by default):

- `articles/<pageid>.json`: full plain-text extract, raw wikitext, canonical and
  revision URLs, revision ID/timestamp/hash, Wikidata ID when available, all
  outgoing main-namespace link titles, non-hidden categories, topic labels,
  attribution, and optional raw historical revisions.
- `discovery.json`: resumable category queue and selected article IDs.
- `manifest.json`: counts, settings, coverage notes, and failed article downloads.

The plain-text extract may be empty for some pages; raw wikitext is retained.
Disambiguation pages are marked so ingestion can exclude them. Outgoing links
can target articles outside the collection; resolve link titles to page IDs
during graph ingestion, including redirect normalization.

History is **off by default**. `--history N` fetches up to N recent revisions,
not yearly snapshots or complete history. Historical content is raw wikitext;
deleted/suppressed content is unavailable. For point-in-time answers, retrieve
the revision valid at the requested date, not just the current text. This script
does not generate embeddings or import records into MariaDB.

Retain article and revision links and attribution when displaying reused text.
Article text is generally CC BY-SA 4.0; embedded third-party material can have
additional terms. See https://en.wikipedia.org/wiki/Wikipedia:Copyrights.

API references:
- https://www.mediawiki.org/wiki/API:Categorymembers
- https://www.mediawiki.org/wiki/API:Revisions
- https://www.mediawiki.org/wiki/API:Links
- https://www.mediawiki.org/wiki/Extension:TextExtracts#API
- https://www.mediawiki.org/wiki/API:Etiquette

Verify offline behavior:

```powershell
node --test scripts/fetch-wikipedia.test.mjs
```
