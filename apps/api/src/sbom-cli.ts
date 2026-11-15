/**
 * Record a CycloneDX SBOM by hand (e.g. one downloaded from CRACI):
 *
 *   npm run sbom -w api -- path/to/sbom.cdx.json [--source craci] [--commit <sha>] [--run <id>]
 *
 * In CI the same thing happens over HTTP (POST /api/sbom, see the workflow).
 */
import './env.js';
import { readFile } from 'node:fs/promises';
import { migrate, pool } from './db.js';
import { ingestSbom, refreshVulns } from './sbom.js';

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const file = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!file) {
  console.error('Usage: npm run sbom -w api -- <sbom.cdx.json> [--source craci] [--commit <sha>] [--run <id>]');
  process.exit(1);
}

await migrate();
const { build, duplicate } = await ingestSbom(await readFile(file, 'utf8'), {
  source: option('source') ?? 'craci',
  commit: option('commit'),
  run: option('run'),
});
console.log(
  duplicate
    ? `Already recorded (build ${build.id}, ${build.components} components).`
    : `Recorded build ${build.id}: ${build.components} components (${build.direct} direct).`,
);
await refreshVulns().catch((err) => console.warn('Vulnerability lookup failed:', (err as Error).message));
await pool.end();
