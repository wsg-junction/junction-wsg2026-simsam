# simsam

npm workspaces monorepo.

```
apps/api         Fastify API (TypeScript, run with tsx) — http://localhost:3000
apps/web         React + Vite frontend — http://localhost:5173 (proxies /api → :3000)
packages/models  Shared TypeScript types (@simsam/models)
```

## Usage

```sh
npm install
npm run dev        # starts api + web
npm run dev:api    # api only
npm run dev:web    # web only
npm run typecheck
npm run build
```
