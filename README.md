# MariaDB Wikipedia Challenge

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
