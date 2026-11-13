# English Wikipedia collection

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
