# CLAUDE.md

Atlas: an AI-assisted Wikipedia research canvas for the **MariaDB Wikipedia Challenge**.
You ask a question, Atlas builds a research page from Wikipedia articles, an AI
answers from those articles in the chat, and side panels add a topic map, web
context and the article's edit history.

**The core of the project is Wikipedia in MariaDB**: articles, their revision
histories in a system-versioned table, and vector search over embeddings in
`VECTOR` columns. Keep MariaDB the primary source; the live Wikipedia API and the
web (context.dev) only fill gaps.

## Product principles (decided with the user; keep them)

- **The main page is Wikipedia only.** Research pages show article text, images,
  dates and sources. The AI answer is shown **in the chat**, never on the page, so
  the page never waits for the AI.
- **Web context is kept apart** from Wikipedia: it lives only in the **Context**
  side panel, never on the page or in the page's AI answer.
- **One chat input** with **Auto | Articles | Context**. Articles builds a new
  page; Context fills the Context panel; Auto lets the model decide by a tool
  call. While Auto decides, the question waits in the chat only (nothing appears
  on the canvas until it's routed).
- **Deep research is its own main tab** (Pages | Deep research), not a chat mode:
  a full report on a topic (plan, parts, zoomable timeline, figures, data,
  findings, references), from MariaDB first, live Wikipedia for gaps, and the
  web only when the "Include web sources" toggle is on.
- **Fact-check** is a side panel beside Context: the claims in the page's main
  article checked against the web by Gemini (Google Search grounding), each with
  a verdict, a word-level comparison and sources. Only article text goes to Gemini.
- **Nothing is ever "missing".** An article the collection lacks is fetched from
  Wikipedia the moment something needs it, embedded and stored in MariaDB
  (`acquire.ts`), so the reader never sees a gap or a different behaviour.
- **History** shows only *substantial* changes (no typo/format fixes, bots,
  reverts, or vandalism that was reverted), with an AI overview, a per-section
  timeline, and a word-level diff per change so people can check it.
- **Saving stores everything** (pages, chat, AI answers/briefs, maps, context,
  history) so opening a save restores it without regenerating anything.
- The canvas scrolls freely (no scroll snapping), with page dots on the right.
  The reading column is centered.
- The topic map is a **force-directed network** (not a tree, not rings).
- Write user-facing copy in plain words; no "AI" jargon beyond labelling what AI wrote.

## Repository layout

npm workspaces monorepo (Node, TypeScript, ESM).

```
apps/api          Fastify API, run with tsx (no build step)        http://localhost:3000
apps/web          React 19 + Vite + HeroUI + Tailwind v4            http://localhost:5173 (proxies /api)
packages/models   Shared TypeScript types (@simsam/models): every API request/response type
scripts/          Wikipedia data collection (fetch-wikipedia.mjs, expand-wikipedia.mjs; see scripts/README.md)
data/wikipedia-en Collected articles (JSON per article, gitignored, ~1.5 GB, not in the Docker image)
deploy/           Production docker compose (app + MariaDB + Caddy), Caddyfile
.github/workflows/ci.yml   Build, test, push image, deploy over SSH
```

## Commands

```sh
npm install
npm run db:up                 # MariaDB 11.8 in Docker on localhost:3306 (user/pass/db: simsam)
npm run dev                   # api (tsx watch) + web (vite)
npm run typecheck             # all workspaces; run after every change
npm run build                 # web: tsc + vite build
npm run ingest -w api                         # load data/wikipedia-en into MariaDB (resumable)
npm run ingest -w api -- --limit 50           # trial
npm run ingest -w api -- --skip-embeddings    # tables + history only
npm run ingest -w api -- --article-vectors    # only fill article_vectors from stored passages
npm run ingest -w api -- --media [--limit n]  # figures into article_media (vision model, ≤4 images/article)
node --test scripts/*.test.mjs                # data-script tests
```

- The API reads `.env` (repo root) **only at startup**; `tsx watch` restarts on
  source edits, which also re-reads `.env`.
- Tables are created/migrated on API start (`migrate()` in `apps/api/src/db.ts`),
  idempotently (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`).
- There is no lint script; `typecheck` + `build` are the gates.

## Environment (`.env`, gitignored; see `.env.example`)

| Variable | Used for |
|---|---|
| `DATABASE_URL` | default `mysql://simsam:simsam@localhost:3306/simsam` |
| `NVIDIA_API_KEY` | chat model + embeddings (NVIDIA API catalog, OpenAI-compatible) |
| `NVIDIA_MODEL` | default `nvidia/nemotron-3.5-super-vl-120b-a12b` (a vision model: it also reads figures) |
| `NVIDIA_BASE_URL` + `VERDA_INFERENCE_KEY` | optional: run the chat/vision model on another OpenAI-compatible server (vLLM on Verda, e.g. `https://containers.datacrunch.io/<container>/v1`, model name as it serves it in `NVIDIA_MODEL`); unset = NVIDIA catalog. The catalog key is never sent to it. With `NVIDIA_API_KEY` also set, the catalog is the **fallback** (`ai.ts`: connection errors, timeouts, 5xx, 401/403/404/429 on the Verda server switch to the catalog model for a minute; not mid-stream). Embeddings stay on the catalog |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | the fact-checker (default model `gemini-flash-latest`) |
| `NVIDIA_EMBEDDING_MODEL` | default `nvidia/nemotron-3.5-embed-1b` (1024 dims) |
| `CONTEXT_DEV_API_KEY` | web search for the Context panel and Auto routing |
| `ELEVENLABS_API_KEY` (+ `_VOICE_ID`, `_MODEL_ID`, `_STT_MODEL_ID`) | read-aloud and voice questions |
| `WIKIPEDIA_USER_AGENT` | server-side Wikipedia requests (generic default) |

Never print `.env` values; refer to variables by name. Every feature degrades
gracefully when its key is missing (`GET /api/health` reports `ai`, `voice`,
`corpus`, `web`, `deep` (AI + corpus), `factcheck`).

## MariaDB schema (`apps/api/src/db.ts`)

| Table | Purpose |
|---|---|
| `explorations` | saved explorations: `steps` (JSON) and `snapshot` (`LONGTEXT COMPRESSED`, the whole saved state) |
| `articles` | one row per collected article: metadata + current plain text (`MEDIUMTEXT COMPRESSED`) |
| `article_content` | **`WITH SYSTEM VERSIONING`**: each article's revisions. `ROW_START` is the original Wikipedia edit time, so `FOR SYSTEM_TIME AS OF '2015-01-01 00:00:00'` returns the article as it read then |
| `article_chunks` | section-aware passages (~1,200 chars, ≤24/article) with `embedding VECTOR(1024)` + HNSW `VECTOR INDEX … DISTANCE=cosine` |
| `article_vectors` | one vector per article (normalized mean of its passages) with its own vector index: article-to-article similarity for the map |
| `article_revisions` | metadata of up to 2,500 recent revisions per article (from the Wikipedia API), for the history panel |
| `history_reports` | cached history-panel report per article, reused until a newer revision exists |
| `article_media` | figures per article: infobox and tables (parsed from wikitext) and images read once by the vision model (chart/map/diagram/photo), each with `embedding VECTOR(1024)` + its own cosine index; `source_key` = file name, "infobox", "table n" |
| `article_media_scans` | which revision's figures were read (so each image goes through the vision model once) |
| `fact_checks` | fact-check verdicts, PK (page_id, claim_hash, revision_id); reused until the article has a newer revision |

How history gets into the system-versioned table:
- **Ingest** replays each article's (≤20) collected revisions oldest first with
  `SET timestamp = <edit epoch>` (strictly increasing), so `ROW_START` = edit time.
- **History panel** adds older revisions later with
  `SET @@system_versioning_insert_history = 1` and explicit `row_start`/`row_end`
  (requires `secure_timestamp` to allow it; it does locally).

On-demand articles and the vector index: an article inserted later on a topic far from
the collection can be left out of the HNSW index's nearest-neighbour results (new nodes
get no reverse links). `freshPages` in `corpus.ts` therefore scans the passages of
`discovered_via = 'on-demand'` articles directly and merges them into `searchCorpus` and
`nearestPassages`. Cheap for thousands of such articles; past that, rebuild the vector
index (or re-run the ingest) so they join it.

Vector notes: insert with `VEC_FromText('[...]')`; query with
`ORDER BY VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) LIMIT n` so the index is
used. Concurrent inserts into one HNSW index deadlock: ingest writes through a
single serialized writer. Parallel vector queries serialize on the index, so the
map uses the small `article_vectors` index, not passages.

## API (`apps/api/src`)

| File | What it does |
|---|---|
| `index.ts` | Fastify app, all routes, JSON schemas, rate limits, serves `apps/web/dist` in production |
| `db.ts` | pool (UTC session time zone) + `migrate()` |
| `store.ts` | storing one article: row, revisions in the system-versioned table, chunking, passage embeddings + article vector (shared by ingest and acquire) |
| `acquire.ts` | on-demand fetch: a missing title is read from live Wikipedia, stored (`discovered_via = 'on-demand'`), chunked, embedded; deduplicated, 3 at a time; `acquireMissing` (waits a few s), `prefetchArticles` (background). Called by `/api/articles`, `/api/graph`, `/api/article-history`, `/api/history`, `/api/fact-check`; `/api/search` and deep reports prefetch the live results they surface |
| `ingest.ts` | loads `data/wikipedia-en`: articles, history replay, chunking, embeddings (3 workers × 48), article vectors |
| `embeddings.ts` | `embed` (retry/backoff, abortable), `embedSkippingRejected` (bisects 422 content-safety rejections), `embedCached` (in-memory, for interactive search) |
| `articleVectors.ts` | mean article vectors, backfill |
| `corpus.ts` | hybrid search (`searchCorpus`), related articles, `corpusArticles`, the DB-only topic map (`corpusGraph`, cached) |
| `wikipedia.ts` | live Wikipedia fallback (`fetchIntros` reads the corpus first), `wikiFetch`, `fetchArticleFigures` (images + captions, infobox, tables; stored wikitext first) |
| `wikitext.ts` | minimal wikitext → sections / plain text / lead; `infoboxOf`, `tablesOf`, `imagesOf`, `expandTemplates` |
| `ai.ts` | all model calls: answer stream, brief, rewrite, `planSources`, `routeQuestion`, context summary, history overview, `readFigure` (vision), `jsonCompletion` (structured output via `json_schema`, falls back if refused); `NVIDIA_BASE_URL` switch |
| `report.ts` | deep research: plan → gather per part (`nearestPassages`, live Wikipedia, figures via `ensureMedia`, optional context.dev) → write parts (3 in parallel) → synthesis; event merge, citation renumbering. **Streams its work** over SSE: `step`, `plan`, `evidence` (sources as found, per part), `draft` (a part's text as the model writes it, read out of the partial JSON by `partialJson.ts`, ≤4/s, citations left out until the end), `synthesis` (the abstract as written), then `report` |
| `media.ts` | figures: `ensureMedia` (parse + vision once + embed + store, lazy or via `--media`), `articleFigures`, `nearestFigures` (used by `searchCorpus`) |
| `factcheck.ts` | extract claims from the lead (Gemini); per claim gather evidence from Google Search via Gemini (only `groundingSupports` attributed to non-Wikipedia pages) and context.dev (`WIKIPEDIA_COPIES` excluded, verbatim copies dropped); a separate Gemini judge call decides on that evidence alone and must cite it; compare claim vs finding (`diff`); store in `fact_checks` |
| `context.ts` | context.dev web search (highlights, excludes Wikipedia and social sites) |
| `timeline.ts` | history panel: scan revisions, pick substantial edits, store them as history rows, measure per-section word changes, AI overview, diffs |
| `history.ts` | older "How has this article changed?" history *page* from stored versions |
| `speech.ts` | ElevenLabs TTS (`/api/speech`) and Scribe STT (`/api/transcribe`) |

Routes: `/api/health`, `/api/search` (hybrid, takes live `candidates`),
`/api/related`, `/api/articles`, `/api/graph`, `/api/history`,
`/api/article-history` (+ `/diff`), `/api/rewrite`, `/api/plan`, `/api/route`,
`/api/answer` (SSE), `/api/deep-report` (SSE), `/api/fact-check`, `/api/brief`, `/api/context`, `/api/speech`,
`/api/transcribe`, `/api/explorations` (+ `/:id` GET/PUT/DELETE; snapshot body ≤15 MB,
under MariaDB's 16 MB `max_allowed_packet`).

### Search (the core)

`searchCorpus` ranks everything by one embedding model:
1. MariaDB vector search over passages (best passage per article).
2. Articles the query names by title get a boost proportional to how much of the
   query the title covers (so "World War II" finds *World War II*, not an article
   that discusses it).
3. The web client sends Wikipedia's own search results as `candidates`; stored ones
   are measured on their passages, others embedded from title + snippet, all ranked
   together. Without the corpus, Wikipedia's order is used.

Calibrated cosine distances (best passage): ≤0.45 reliably on topic, 0.45–0.6 mixed.

### AI usage

- Model calls use NVIDIA's OpenAI-compatible API (`openai` SDK). Non-streamed calls
  pass `chat_template_kwargs: { enable_thinking: false }` for speed.
- **Tool calls** decide flows: `planSources` (search_wikipedia / search_web) and
  `routeQuestion` (research_articles / find_context).
- **Long JSON** (deep research plan, parts, synthesis) uses `jsonCompletion` with a
  JSON schema; without it Nemotron occasionally produced malformed JSON on long outputs.
- **Vision**: `readFigure` sends an image (data URL, ≤180 KB, downloaded via
  `Special:FilePath?width=640`) and stores the text; images are picked by
  `pickImages` (likely charts/maps first, ≤4 per article).
- **Gemini** is only for the fact-checker. Never let Wikipedia (or sister sites,
  mirrors) count as evidence; a verdict citing no evidence becomes "unverified".
  Grounded calls use plain prose and default temperature: asked for JSON or a low
  temperature, Gemini often skips the search.
- JSON outputs are parsed defensively and sanitized (`completeBrief`/`sanitizeBrief`
  repair `[1][3]`-style source lists; citations out of range are dropped).

## Web (`apps/web/src`)

| File | What it does |
|---|---|
| `App.tsx` | opening vs exploration, saved list, open/save (loads snapshots) |
| `components/ExplorationView.tsx` | the exploration: runs steps, answers/briefs, chat entries, routing, side panel tabs (Chat when docked, Map, Context, History), collapsed rail + Alt+1… shortcuts, saving |
| `components/ResearchCanvas.tsx` | freely scrolling pages + page dots |
| `components/ResearchPageView.tsx` | detailed page (Wikipedia only); `PAGE_COLUMN` = centered reading column |
| `components/CompactPageView.tsx` | compact page: AI brief as timeline/points with playback |
| `components/ChatCenter.tsx` | `ChatLog` (answers with citations, context entries), `ChatComposer` (one input + mode switch + voice + dock toggle), `ChatCenter` (floating) |
| `components/DeepResearchTab.tsx` | the Deep research tab: start form (web toggle), progress (parts, steps), report picker |
| `components/DeepReportView.tsx` | the report canvas: contents, abstract, questions, timeline + event card, parts (facts, sections, data chart, figures), findings, limitations, method, references; Markdown export (`lib/report.ts`) |
| `components/TimelineExplorer.tsx` | zoomable timeline: lanes per part, eras, drag/wheel/pinch/keyboard, importance-based detail and collision-free labels |
| `components/ContextPanel.tsx` | web context results (no input of its own) |
| `components/FactCheckPanel.tsx` | verdict counts, claims with verdict (icon + label), Wikipedia vs web word comparison, sources |
| `components/HistoryPanel.tsx` | AI overview, section timeline, changes with diffs |
| `components/GraphPanel.tsx`, `TopicGraph.tsx` | topic map: d3-force network, pan/zoom/drag, collision-free labels |
| `components/VoiceControls.tsx` | push-to-talk + hands-free (`lib/handsfree.ts`, `lib/voice.ts`) |
| `lib/wikipedia.ts` | client search (live candidates → `/api/search`), `buildGraph` (DB first), articles, summaries |
| `lib/research.ts` | turns a step into a `ResearchPage`; history-question detection |
| `lib/ai.ts`, `lib/history.ts`, `lib/api.ts` | API clients |
| `lib/snapshot.ts` | save snapshot format + "unsaved changes" signature |

Persisted UI choices (`localStorage`, always wrapped in try/catch):
`theme`, `atlas-mode` (detailed/compact), `atlas-map-collapsed`,
`atlas-chat-dock` (center/side), `atlas-ask-mode` (auto/articles/context),
`atlas-voice-threshold`.

**Design system and UI decisions: see [DESIGN.md](DESIGN.md)** (tokens, type,
layout, components, charts, motion, accessibility, decisions log).

UI conventions: colors are CSS tokens in `index.css` (light and dark), including
`--added*`/`--removed*` for diffs; tooltips use `Floating` (portal into `body`);
respect `prefers-reduced-motion`; keep phone width free of horizontal scroll;
scroll inside a panel with `scrollTo` on that panel (not `scrollIntoView`, which
moves the whole page).

## Data and attribution

- Wikipedia text is CC BY-SA 4.0; pages show attribution and source links.
- `data/wikipedia-en` is produced by `scripts/fetch-wikipedia.mjs` (European
  history, Finnish history, computer science). Each article holds its current text,
  wikitext, ≤20 recent revisions with content, links, categories, topics.
- In production, copy the data to the server and run the ingest inside the app
  container (see README, "Loading the Wikipedia corpus on the server").

## Working on this repo

- Run `npm run typecheck` (and `npm run build` for web changes) after edits.
- Verify UI changes in a real browser (the project has used headless Edge via
  `puppeteer-core`) and look at screenshots; check light and dark themes and
  phone width.
- The full ingest is long and memory-hungry: don't start it on your own; the
  user runs it. `--article-vectors` is light (reads MariaDB only). `--media` makes
  up to 4 vision calls per article; don't start it over the whole collection yourself.
- Don't commit or push unless asked. Commit messages end with the attribution
  line given in the session.
- Keep `.env` values private, and don't send personal details to external services.
- `apps/api/verify-ingest.ts` is a temporary check script from the ingest work;
  it isn't part of the app.
