# MariaDB Wikipedia Challenge

English Wikipedia data fetcher: see [scripts/README.md](scripts/README.md) for
collecting European history, Finnish history, and computer science articles.

npm workspaces monorepo.

```
apps/api         Fastify API (TypeScript, run with tsx) — http://localhost:3000
apps/web         React + Vite frontend — http://localhost:5173 (proxies /api → :3000)
packages/models  Shared TypeScript types (@simsam/models)
deploy/          Production docker compose stack (app + MariaDB)
```

## Local development

Requires Docker for MariaDB.

```sh
npm install
npm run db:up      # MariaDB on localhost:3306 (user/pass/db: simsam)
npm run dev        # starts api + web
npm run typecheck
npm run build
```

The API reads `DATABASE_URL` (default `mysql://simsam:simsam@localhost:3306/simsam`)
and creates its tables on startup.

### AI answers

Answers are written by an NVIDIA-hosted model (OpenAI-compatible API) from the
Wikipedia articles on each page, with numbered citations. Copy `.env.example` to
`.env` in the repo root and set `NVIDIA_API_KEY`; the API loads it on start.
Without a key the app still works and shows Wikipedia text only.

Set `ELEVENLABS_API_KEY` too to have compact briefs read aloud with ElevenLabs
text to speech (voice and model are configurable, see `.env.example`). The same
key lets you ask follow-up questions by voice (ElevenLabs Scribe speech to text).

Research pages show Wikipedia only; the AI answer for each page appears in the
chat, so the articles never wait for it. The chat sits at the bottom of the
canvas or, with "Move to side panel", in the side panel as a Chat tab with the
input below every tab. It has one input with **Auto | Articles | Context**:
Articles makes a new research page, Context fills the Context panel, and Auto
lets the model decide with a tool call (`POST /api/route`).

`NVIDIA_BASE_URL` moves the chat and vision model off NVIDIA's catalog onto any
OpenAI-compatible server, for example Nemotron 3.5 Super VL served with vLLM or
NIM on a Verda GPU instance (`http://<instance>:8000/v1`); set `NVIDIA_MODEL` to
the name that server uses. Embeddings stay on the catalog.

Set `CONTEXT_DEV_API_KEY` to add a **Context** panel beside the map, with web
context from [context.dev](https://docs.context.dev). The research pages and
their answers stay Wikipedia only; the panel is kept apart. For every question
the model plans its sources by calling tools: `search_wikipedia` for the page,
and `search_web` when the question needs more than encyclopedia intros (a war's
impact on the financial sector, figures, analysis, recent events). A web search
fills the Context panel in the background with the pages found and a short,
cited AI summary of them. You can also ask the panel for context on any angle
of the page's topic.

### Deep research

With the corpus loaded, explorations get a second main tab, **Deep research**
(also started from the opening screen), that researches a topic in depth into a
full report (`apps/api/src/report.ts`, `POST /api/deep-report`, streamed):

1. **Plan**: the model sets 3 to 5 research questions and splits the topic into
   4 to 7 parts (causes, phases or theatres, the parties involved, themes such
   as the Holocaust, consequences), each with search queries.
2. **Gather, MariaDB first**: per part, vector search over the passages of the
   collection (several articles per query), live Wikipedia where the collection
   is thin, the figures of its main articles (maps, charts, tables, infoboxes,
   read by the vision model once and stored), and, with **Include web sources**,
   context.dev pages (Wikipedia and its copies excluded).
3. **Write** each part from its own numbered evidence only: sections, key facts,
   a data chart when the evidence has comparable numbers, dated events, figures.
4. **Synthesise**: abstract, an answer per research question, limitations, and
   the eras of the timeline. Citations are renumbered in reading order.

Model replies use structured output (`response_format: json_schema`), so they are
always valid JSON. The report shows the abstract, the research questions, a
timeline of all events (one lane per part, eras on top; drag to move, scroll or
pinch to zoom, details appear when zoomed in), one page per part, findings,
limitations, method and numbered references, and downloads as Markdown. A run
takes about 2 to 4 minutes; reports are saved with the exploration.

### Figures (article_media)

Each article's infobox and data tables are parsed from its wikitext, and up to
four images (likely charts and maps first) are read once by the vision model
(Nemotron 3.5 Super VL) into text: a chart's values, a map's regions and fronts.
Every figure is embedded into `article_media` (`VECTOR(1024)` with its own
cosine index), so `searchCorpus` matches what figures show, not just the prose.
Figures are read lazily the first time a deep research uses an article, or in
bulk:

```sh
npm run ingest -w api -- --media              # every article (resumable; up to 4 vision calls each)
npm run ingest -w api -- --media --limit 50   # a few
```

### Fact-check

Set `GEMINI_API_KEY` to add a **Fact-check** side panel. It follows the page in
view: Gemini picks up to six checkable claims from the article's opening. For
each, evidence is gathered from independent sources only: Google Search through
Gemini (keeping just the statements Google attributes to non-Wikipedia pages)
and, with `CONTEXT_DEV_API_KEY`, web search through context.dev (quoted
passages). Wikipedia, its sister projects (Wikidata, Wikisource...) and sites
that copy it are excluded, and passages repeating the Wikipedia sentence word for
word are dropped as copies. A separate Gemini call then judges the claim on that
evidence alone and must cite it. Each claim shows a verdict
(confirmed, partly confirmed, contradicted, not found), the claim as Wikipedia
states it next to what the sources say with the differing words highlighted, and
the evidence it rests on with excerpts. A verdict citing no evidence is shown as
"not found". Results are
stored in `fact_checks` (keyed on article, claim and revision) and reused until
the article has a newer revision. Only the article's text is sent to Gemini.

### Saved explorations

Saving stores everything the exploration showed, not just its questions: the
pages and their Wikipedia sources, the chat, the AI answers and briefs, the
maps, deep research reports, and the Context, Fact-check and History panels (`explorations.snapshot`, compressed
JSON). Opening a save restores it as it was without searching or generating
anything again; new follow-ups continue from there. Anything still loading at
the moment of saving is fetched again on open. Saves from before snapshots
existed replay their questions.

### Wikipedia corpus in MariaDB

The articles collected into `data/wikipedia-en` (see `scripts/README.md`) are
loaded into MariaDB, and the app searches and reads them from there, using the
live Wikipedia API only for topics outside the collection.

Search is ranked by vectors (`searchCorpus` in `apps/api/src/corpus.ts`):
MariaDB vector search over the embedded passages (best passage per article),
plus Wikipedia's own search results as candidates for gaps in the collection.
Stored candidates are measured on their passages in MariaDB, the rest on their
title and snippet with the same embedding model, and everything is ranked by
cosine distance. An article the query names by title gets a boost in
proportion to how much of the query it covers, so "World War II" finds
*World War II* rather than an article that discusses it.

```sh
npm run ingest -w api                        # everything (resumable)
npm run ingest -w api -- --limit 50          # a quick trial
npm run ingest -w api -- --skip-embeddings   # tables and history only
```

It needs `NVIDIA_API_KEY` for the embeddings (`nvidia/nemotron-3.5-embed-1b`,
1024 dimensions) and creates three tables:

| Table | What's in it |
|---|---|
| `articles` | Metadata and the current plain text of each article |
| `article_content` | `WITH SYSTEM VERSIONING`: each article's revisions, replayed at their original edit times, so `ROW_START` is the Wikipedia edit time and `FOR SYSTEM_TIME AS OF '2015-01-01'` returns the article as it read then |
| `article_chunks` | Section-aware passages of the current text with a `VECTOR(1024)` embedding and an HNSW `VECTOR INDEX` (cosine) |
| `article_vectors` | One vector per article (the normalized mean of its passages) with its own `VECTOR INDEX`, for article-to-article similarity |
| `article_media` | Figures: infobox, tables, and images read by the vision model, each with a `VECTOR(1024)` embedding and its own `VECTOR INDEX` (`article_media_scans` records which revision was read) |
| `fact_checks` | Fact-check verdicts per article, claim and revision, with their grounding sources |

The topic map comes from MariaDB alone (`POST /api/graph`): each topic's
neighbours are its nearest articles in `article_vectors`, expanded five steps
out and drawn as a force-directed network, with no Wikipedia API calls. Articles
embedded before `article_vectors` existed are filled in at the end of every
ingest run, or on their own with `npm run ingest -w api -- --article-vectors`.

The **History** side panel follows the page in view and shows how its main
article changed (`apps/api/src/timeline.ts`, `POST /api/article-history`):

1. The metadata of up to 2,500 recent revisions is scanned from the Wikipedia
   API into `article_revisions` (later visits only add newer edits).
2. Noise is dropped: minor edits, bots, reverts, edits Wikipedia tagged as later
   reverted, and small byte changes.
3. The biggest remaining edits and their parents are fetched and stored in the
   system-versioned `article_content` as history rows at their original times
   (`system_versioning_insert_history`), next to the 20 revisions the ingest replayed.
4. Each edit is measured section by section in prose words (moved text and
   reworded punctuation don't count); only edits that changed real content are kept.
5. The model writes an overview of the most impactful changes and names each
   one; the report is cached in `history_reports` until the article changes.

The panel shows the overview, a timeline with one row per section and the
article's size over all scanned edits, and each change's word-level diff (read
from the two stored versions in MariaDB) to check it against.

Asking "How has this article changed over time?" still makes a history page
from the stored versions in `article_content FOR SYSTEM_TIME ALL`.

## Deployment (Verda + GitHub Actions or CRACI)

On push to `main`, `.github/workflows/ci.yml` builds and tests, builds the Docker
image, pushes it to Verda's registry (`vccr.io`), then SSHes into a Verda instance
and runs `docker compose up -d` with `deploy/compose.yml`. The API serves the built
frontend; Caddy sits in front and serves it over HTTPS at `DOMAIN`.

### Choosing the CI runner

The workflow runs on GitHub's hosted runners by default. To run it on
CRACI instead, install the CRACI GitHub App (CRACI → Settings
→ Builds → Install GitHub App) and set one repository variable; to switch back,
delete it (or set it to another runner label):

```sh
gh variable set CI_RUNNER --body craci   # use CRACI
gh variable delete CI_RUNNER             # use GitHub-hosted runners (ubuntu-latest)
```

Nothing else changes: the deploy job adds CRACI's setup step (Docker and ssh)
only when `CI_RUNNER` is `craci`.

### One-time setup

1. **Verda registry**: create registry credentials (Container Registry → Credentials).
2. **Verda instance**: create a CPU instance with an SSH key, then on it:
   ```sh
   # install Docker if the image doesn't include it
   curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER
   sudo mkdir -p /opt/simsam && sudo chown $USER /opt/simsam
   # use alphanumeric passwords (they're embedded in a connection URL)
   printf 'DOMAIN=%s\nDB_PASSWORD=%s\nDB_ROOT_PASSWORD=%s\n' app.example.com "$(openssl rand -hex 16)" "$(openssl rand -hex 16)" > /opt/simsam/.env
   chmod 600 /opt/simsam/.env
   # optional, for AI answers:
   read -rs -p 'NVIDIA API key: ' KEY && echo "NVIDIA_API_KEY=$KEY" >> /opt/simsam/.env && unset KEY
   read -rs -p 'ElevenLabs API key: ' KEY && echo "ELEVENLABS_API_KEY=$KEY" >> /opt/simsam/.env && unset KEY
   read -rs -p 'context.dev API key: ' KEY && echo "CONTEXT_DEV_API_KEY=$KEY" >> /opt/simsam/.env && unset KEY
   read -rs -p 'Gemini API key: ' KEY && echo "GEMINI_API_KEY=$KEY" >> /opt/simsam/.env && unset KEY
   # optional, Nemotron on your own GPU instance instead of NVIDIA's catalog:
   # echo 'NVIDIA_BASE_URL=http://<gpu-instance>:8000/v1' >> /opt/simsam/.env
   echo '<SECRET>' | docker login vccr.io/<PROJECT_ID> -u 'vcr-<PROJECT_ID>+<name>' --password-stdin
   ```
3. **Domain**: at your registrar, add an `A` record for `DOMAIN` → instance public IP,
   and make sure ports 80 and 443 are open on the instance. Caddy issues the
   certificate on first start once DNS resolves.
4. **GitHub repo settings** (Settings → Secrets and variables → Actions):

   | Kind     | Name                    | Value                                             |
   |----------|-------------------------|---------------------------------------------------|
   | Variable | `VERDA_PROJECT_ID`      | Verda project ID                                  |
   | Variable | `DEPLOY_HOST`           | Instance public IP                                |
   | Variable | `DEPLOY_USER`           | SSH user (e.g. `ubuntu`)                          |
   | Secret   | `VERDA_REGISTRY_USER`   | `vcr-<PROJECT_ID>+<name>`                         |
   | Secret   | `VERDA_REGISTRY_SECRET` | Registry credential secret                        |
   | Secret   | `DEPLOY_SSH_KEY`        | Private key for a deploy-only key on the instance |
   | Secret   | `DEPLOY_KNOWN_HOSTS`    | Output of `ssh-keyscan <instance IP>`             |

The MariaDB data lives in the `db-data` Docker volume on the instance; it survives
redeploys but not deleting the instance — back it up (e.g. `mariadb-dump`) if it matters.

### Loading the Wikipedia corpus on the server

The database isn't reachable from outside the instance, so run the ingest inside
the app container with the collected data mounted (the image doesn't include it):

```sh
# from your machine: copy the collection to the instance (about 1.5 GB)
rsync -az data/wikipedia-en/ <user>@<instance>:/opt/simsam/data/wikipedia-en/
# on the instance
cd /opt/simsam
docker compose run --rm -v /opt/simsam/data/wikipedia-en:/app/data/wikipedia-en:ro app npm run ingest -w api
```

It's resumable, so re-running after a new collection only adds what changed.
