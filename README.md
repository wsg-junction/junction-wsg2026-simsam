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

Set `CONTEXT_DEV_API_KEY` to add a **Context** panel beside the map, with web
context from [context.dev](https://docs.context.dev). The research pages and
their answers stay Wikipedia only; the panel is kept apart. For every question
the model plans its sources by calling tools: `search_wikipedia` for the page,
and `search_web` when the question needs more than encyclopedia intros (a war's
impact on the financial sector, figures, analysis, recent events). A web search
fills the Context panel in the background with the pages found and a short,
cited AI summary of them. You can also ask the panel for context on any angle
of the page's topic.

### Saved explorations

Saving stores everything the exploration showed, not just its questions: the
pages and their Wikipedia sources, the chat, the AI answers and briefs, the
maps, and the Context and History panels (`explorations.snapshot`, compressed
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

The topic map comes from MariaDB alone (`POST /api/graph`): each topic's
neighbours are its nearest articles in `article_vectors`, expanded five steps
out and laid out left to right by step, with no Wikipedia API calls. Articles
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

## Deployment (Verda + GitHub Actions)

On push to `main`, `.github/workflows/ci.yml` builds and tests, builds the Docker
image, pushes it to Verda's registry (`vccr.io`), then SSHes into a Verda instance
and runs `docker compose up -d` with `deploy/compose.yml`. The API serves the built
frontend; Caddy sits in front and serves it over HTTPS at `DOMAIN`.

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
