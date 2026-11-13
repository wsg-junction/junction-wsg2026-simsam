import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load .env for local development: apps/api/.env first, then the repo root's.
// Values already in the environment (Docker, CI) always win.
// Imported first in index.ts so everything after sees the variables.
for (const path of ['../.env', '../../../.env']) {
  const file = fileURLToPath(new URL(path, import.meta.url));
  if (existsSync(file)) process.loadEnvFile(file);
}
