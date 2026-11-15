/**
 * The software bill of materials: what Atlas itself is built from.
 *
 * An SBOM is any CycloneDX JSON document; the intended source is CRACI, which
 * records every dependency a build pulls in (caches included) and exposes it
 * through its API. A CI step posts it to POST /api/sbom (or `npm run sbom -w api
 * <file>` loads one by hand), and this module:
 *
 *   - keeps the document (sbom_builds) and the components (sbom_components, a
 *     SYSTEM-VERSIONED table: upgrades, additions and removals between builds are
 *     its history rows, and FOR SYSTEM_TIME AS OF returns the tree as it was),
 *   - embeds each component with the same model and index type as the Wikipedia
 *     passages (sbom_chunks), so the SBOM is searched by meaning,
 *   - looks every component up on OSV.dev for known vulnerabilities (sbom_vulns),
 *     refreshed daily.
 *
 * The Health page reads all of it through GET /api/sbom and /api/sbom/search.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import type {
  SbomBuild,
  SbomChange,
  SbomComponent,
  SbomSearchHit,
  SbomSeverity,
  SbomSummary,
  SbomVulnerability,
} from '@simsam/models';
import { pool } from './db.js';
import { embedCached, embedSkippingRejected, embeddingsEnabled, vectorText } from './embeddings.js';

// ---------- Reading a CycloneDX document ----------

interface CdxComponent {
  components?: CdxComponent[];
  'bom-ref'?: string;
  type?: string;
  group?: string;
  name?: string;
  version?: string;
  purl?: string;
  description?: string;
  licenses?: { license?: { id?: string; name?: string }; expression?: string }[];
  externalReferences?: { type?: string; url?: string }[];
}

interface Cdx {
  serialNumber?: string;
  metadata?: { timestamp?: string; component?: CdxComponent; properties?: { name?: string; value?: string }[] };
  components?: CdxComponent[];
  dependencies?: { ref: string; dependsOn?: string[] }[];
  compositions?: { aggregate?: string }[];
}

interface Parsed {
  purl: string;
  name: string;
  version: string;
  ecosystem: string;
  description: string | null;
  license: string | null;
  homepage: string | null;
  direct: boolean;
  requiredBy: string[];
  contentHash: string;
  text: string;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** Every component of the document, including those nested inside others. */
function flatten(list: CdxComponent[] | undefined, out: CdxComponent[] = []): CdxComponent[] {
  for (const c of list ?? []) {
    out.push(c);
    flatten(c.components, out);
  }
  return out;
}

/** The components of a CycloneDX document, with who requires them and what text represents them. */
export function parseSbom(doc: Cdx) {
  const all = flatten(doc.components);
  const root = doc.metadata?.component?.['bom-ref'];
  const edges = doc.dependencies ?? [];
  const nameOfRef = new Map<string, string>();
  for (const c of all) if (c['bom-ref'] && c.name) nameOfRef.set(c['bom-ref'], c.name);
  const directRefs = new Set(edges.find((e) => root && e.ref === root)?.dependsOn ?? []);
  const parents = new Map<string, Set<string>>();
  for (const e of edges) {
    if (e.ref === root) continue;
    const parent = nameOfRef.get(e.ref);
    if (!parent) continue;
    for (const child of e.dependsOn ?? []) {
      if (!parents.has(child)) parents.set(child, new Set());
      parents.get(child)!.add(parent);
    }
  }

  const out = new Map<string, Parsed>();
  for (const c of all) {
    // Files and nameless or versionless-and-purl-less entries (a job, a placeholder) aren't packages.
    if (!c.name || c.type === 'file' || (!c.purl && !c.version)) continue;
    const name = c.group && !c.name.includes('/') ? `${c.group}/${c.name}` : c.name;
    const version = c.version ?? '';
    const purl = (c.purl ?? `pkg:generic/${encodeURIComponent(name)}@${version}`).slice(0, 400);
    const ecosystem = purl.match(/^pkg:([^/]+)\//)?.[1] ?? 'generic';
    const license =
      [
        ...new Set(
          (c.licenses ?? []).map((l) => l.license?.id ?? l.license?.name ?? l.expression).filter((l): l is string => Boolean(l)),
        ),
      ].join('; ') || null;
    const refs = c.externalReferences ?? [];
    const homepage =
      (refs.find((r) => r.type === 'website') ?? refs.find((r) => r.type === 'vcs') ?? refs[0])?.url?.slice(0, 500) ?? null;
    const direct = Boolean(c['bom-ref'] && directRefs.has(c['bom-ref']));
    const requiredBy = [...(parents.get(c['bom-ref'] ?? '') ?? [])].sort().slice(0, 6);
    const description = c.description?.replace(/\s+/g, ' ').trim().slice(0, 600) || null;
    const text =
      `${name}${description ? `: ${description}` : ''}. ` +
      `(${ecosystem} package ${version}, a ${direct ? 'direct' : 'transitive'} dependency${license ? `, license ${license}` : ''}` +
      `${requiredBy.length ? `, required by ${requiredBy.join(', ')}` : ''}.)`;
    out.set(purl, {
      purl,
      name: name.slice(0, 255),
      version: version.slice(0, 120),
      ecosystem: ecosystem.slice(0, 30),
      description,
      license: license?.slice(0, 255) ?? null,
      homepage,
      direct,
      requiredBy,
      contentHash: sha1(text),
      text,
    });
  }

  // What the producer says about the record's completeness (CycloneDX compositions).
  const aggregates = (doc.compositions ?? []).map((c) => c.aggregate).filter((a): a is string => Boolean(a));
  const counts = new Map<string, number>();
  for (const a of aggregates) counts.set(a, (counts.get(a) ?? 0) + 1);
  const completeness = counts.size ? [...counts].map(([a, n]) => `${n} ${a.replace(/_/g, ' ')}`).join(', ') : undefined;

  return {
    components: [...out.values()],
    createdAt: doc.metadata?.timestamp ? new Date(doc.metadata.timestamp) : new Date(),
    serial: doc.serialNumber?.slice(0, 120),
    completeness,
  };
}

// ---------- Recording an SBOM ----------

// Writes into the vector index go one at a time (concurrent inserts deadlock it).
let writes: Promise<unknown> = Promise.resolve();

export interface IngestMeta {
  source: string;
  commit?: string;
  run?: string;
}

/**
 * Record an SBOM (the raw CycloneDX JSON text). The same document twice is a
 * no-op. Components are synced into the versioned table, the new or changed ones
 * embedded, and the vulnerability lookup started in the background.
 */
export async function ingestSbom(raw: string, meta: IngestMeta): Promise<{ build: SbomBuild; duplicate: boolean }> {
  let doc: Cdx;
  try {
    doc = JSON.parse(raw) as Cdx;
  } catch {
    throw new SbomError('The SBOM isn’t valid JSON.');
  }
  if (!Array.isArray(doc.components)) throw new SbomError('The document has no components: is it a CycloneDX SBOM?');
  const sha = createHash('sha256').update(raw).digest('hex');
  const [existing] = await pool.query<RowDataPacket[]>('SELECT id FROM sbom_builds WHERE sha256 = ?', [sha]);
  if (existing[0]) return { build: (await builds(1, Number(existing[0].id)))[0], duplicate: true };

  const parsed = parseSbom(doc);

  const conn = await pool.getConnection();
  let buildId: number;
  try {
    await conn.beginTransaction();
    const [inserted] = await conn.query<RowDataPacket[] & { insertId: number }>(
      `INSERT INTO sbom_builds (source, commit_sha, run_id, serial_number, created_at, ingested_at, component_count, direct_count, completeness, sha256, document)
       VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?)`,
      [
        meta.source.slice(0, 40),
        meta.commit?.slice(0, 64) ?? null,
        meta.run?.slice(0, 64) ?? null,
        parsed.serial ?? null,
        parsed.createdAt,
        parsed.components.length,
        parsed.components.filter((c) => c.direct).length,
        parsed.completeness ?? null,
        sha,
        raw,
      ],
    );
    buildId = Number((inserted as unknown as { insertId: number }).insertId);

    const [current] = await conn.query<RowDataPacket[]>('SELECT purl, content_hash FROM sbom_components');
    const have = new Map(current.map((r) => [String(r.purl), String(r.content_hash)]));
    const now = new Set(parsed.components.map((c) => c.purl));
    for (const c of parsed.components) {
      if (have.get(c.purl) === c.contentHash) continue;
      await conn.query(
        `INSERT INTO sbom_components (purl, name, version, ecosystem, description, license, homepage, direct, required_by, content_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE name = VALUES(name), version = VALUES(version), description = VALUES(description),
           license = VALUES(license), homepage = VALUES(homepage), direct = VALUES(direct),
           required_by = VALUES(required_by), content_hash = VALUES(content_hash)`,
        [c.purl, c.name, c.version, c.ecosystem, c.description, c.license, c.homepage, c.direct ? 1 : 0, JSON.stringify(c.requiredBy), c.contentHash],
      );
    }
    // What left the SBOM is deleted: the versioned table keeps it as history.
    const gone = [...have.keys()].filter((p) => !now.has(p));
    if (gone.length) await conn.query('DELETE FROM sbom_components WHERE purl IN (?)', [gone]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }

  await embedComponents(parsed.components).catch((err) => console.warn('Embedding the SBOM failed:', (err as Error).message));
  void refreshVulns().catch((err) => console.warn('Vulnerability lookup failed:', (err as Error).message));
  return { build: (await builds(1, buildId))[0], duplicate: false };
}

export class SbomError extends Error {}

/** Embed the components that are new or changed (and drop the vectors of those that left). */
async function embedComponents(components: Parsed[]) {
  const run = writes.then(async () => {
    const [rows] = await pool.query<RowDataPacket[]>('SELECT purl, content_hash FROM sbom_chunks');
    const have = new Map(rows.map((r) => [String(r.purl), String(r.content_hash)]));
    const now = new Set(components.map((c) => c.purl));
    const gone = [...have.keys()].filter((p) => !now.has(p));
    if (gone.length) await pool.query('DELETE FROM sbom_chunks WHERE purl IN (?)', [gone]);
    if (!embeddingsEnabled) return;
    const pending = components.filter((c) => have.get(c.purl) !== c.contentHash);
    const BATCH = 48;
    for (let i = 0; i < pending.length; i += BATCH) {
      const slice = pending.slice(i, i + BATCH);
      const vectors = await embedSkippingRejected(slice.map((c) => c.text), 'passage');
      for (const [j, c] of slice.entries()) {
        const v = vectors[j];
        if (!v) continue;
        await pool.query(
          `INSERT INTO sbom_chunks (purl, content_hash, content, embedding) VALUES (?, ?, ?, VEC_FromText(?))
           ON DUPLICATE KEY UPDATE content_hash = VALUES(content_hash), content = VALUES(content), embedding = VALUES(embedding)`,
          [c.purl, c.contentHash, c.text, vectorText(v)],
        );
      }
    }
  });
  writes = run.catch(() => {});
  return run;
}

/** Whether a request's Authorization header carries the SBOM ingest token. */
export function sbomTokenOk(header: string | undefined) {
  const token = process.env.SBOM_INGEST_TOKEN?.trim();
  if (!token || !header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7).trim());
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

export const sbomIngestEnabled = Boolean(process.env.SBOM_INGEST_TOKEN?.trim());

// ---------- Vulnerabilities (OSV.dev) ----------

const OSV = 'https://api.osv.dev/v1';
/** purl types OSV.dev can look up by package and version (system packages need distro details it doesn't get). */
const OSV_ECOSYSTEMS = ['npm', 'pypi', 'golang', 'maven', 'cargo', 'nuget', 'gem', 'composer', 'hex', 'pub'];
let refreshing: Promise<void> | null = null;

interface OsvVuln {
  id: string;
  summary?: string;
  details?: string;
  aliases?: string[];
  published?: string;
  database_specific?: { severity?: string };
  affected?: { package?: { name?: string; ecosystem?: string }; ranges?: { events?: { fixed?: string }[] }[] }[];
}

const severityOf = (v: OsvVuln): SbomSeverity => {
  const s = v.database_specific?.severity?.toLowerCase();
  if (s === 'critical') return 'critical';
  if (s === 'high') return 'high';
  if (s === 'moderate' || s === 'medium') return 'medium';
  if (s === 'low') return 'low';
  return 'unknown';
};

async function osv<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${OSV}${path}`, { ...init, signal: AbortSignal.timeout(25_000), headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`OSV responded with ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Look up every component on OSV.dev (public package names and versions only) and
 * replace the stored vulnerabilities. Concurrent calls share one run.
 */
export function refreshVulns(): Promise<void> {
  refreshing ??= doRefresh().finally(() => (refreshing = null));
  return refreshing;
}

async function doRefresh() {
  const [comps] = await pool.query<RowDataPacket[]>('SELECT purl, name FROM sbom_components WHERE ecosystem IN (?)', [OSV_ECOSYSTEMS]);
  if (comps.length === 0) return;
  const found = new Map<string, string[]>(); // purl -> osv ids
  // A batch OSV refuses (one purl it can't read) is split until the bad one is alone, then skipped.
  const lookup = async (slice: RowDataPacket[]): Promise<void> => {
    try {
      const res = await osv<{ results: { vulns?: { id: string }[] }[] }>('/querybatch', {
        method: 'POST',
        body: JSON.stringify({ queries: slice.map((c) => ({ package: { purl: String(c.purl) } })) }),
      });
      res.results.forEach((r, j) => {
        if (r.vulns?.length) found.set(String(slice[j].purl), r.vulns.map((v) => v.id));
      });
    } catch (err) {
      if (slice.length === 1) return;
      const mid = Math.ceil(slice.length / 2);
      await lookup(slice.slice(0, mid));
      await lookup(slice.slice(mid));
      void err;
    }
  };
  for (let i = 0; i < comps.length; i += 500) await lookup(comps.slice(i, i + 500));
  const ids = [...new Set([...found.values()].flat())];
  const details = new Map<string, OsvVuln>();
  let next = 0;
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      while (next < ids.length) {
        const id = ids[next++];
        try {
          details.set(id, await osv<OsvVuln>(`/vulns/${encodeURIComponent(id)}`));
        } catch {
          /* an advisory that can't be read is skipped this time */
        }
      }
    }),
  );
  const nameOf = new Map(comps.map((c) => [String(c.purl), String(c.name)]));
  const rows: unknown[][] = [];
  for (const [purl, vulnIds] of found) {
    for (const id of vulnIds) {
      const v = details.get(id);
      if (!v) continue;
      const name = nameOf.get(purl);
      const fixed = v.affected
        ?.filter((a) => !a.package?.name || a.package.name === name)
        .flatMap((a) => a.ranges ?? [])
        .flatMap((r) => r.events ?? [])
        .map((e) => e.fixed)
        .find(Boolean);
      rows.push([
        purl,
        id.slice(0, 60),
        (v.summary ?? v.details ?? id).replace(/\s+/g, ' ').slice(0, 1000),
        severityOf(v),
        fixed?.slice(0, 120) ?? null,
        v.published ? new Date(v.published) : null,
        JSON.stringify((v.aliases ?? []).slice(0, 8)),
      ]);
    }
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM sbom_vulns');
    for (const r of rows) {
      await conn.query(
        'INSERT IGNORE INTO sbom_vulns (purl, osv_id, summary, severity, fixed_in, published, aliases, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())',
        r,
      );
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

/** Check for vulnerabilities at start and every few hours: advisories appear after a build. */
export function startVulnRefresh() {
  const check = async () => {
    const [[row]] = await pool.query<RowDataPacket[]>('SELECT MAX(checked_at) AS at, (SELECT COUNT(*) FROM sbom_components) AS n FROM sbom_vulns');
    const stale = !row?.at || Date.now() - new Date(row.at).getTime() > 24 * 3600 * 1000;
    if (Number(row?.n) > 0 && stale) await refreshVulns();
  };
  void check().catch(() => {});
  setInterval(() => void check().catch(() => {}), 6 * 3600 * 1000).unref();
}

// ---------- Reading ----------

async function builds(limit: number, id?: number): Promise<SbomBuild[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, source, commit_sha, run_id, created_at, ingested_at, component_count, direct_count, completeness
     FROM sbom_builds ${id ? 'WHERE id = ?' : ''} ORDER BY id DESC LIMIT ?`,
    id ? [id, limit] : [limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    source: String(r.source),
    commit: r.commit_sha ?? undefined,
    run: r.run_id ?? undefined,
    createdAt: new Date(r.created_at).toISOString(),
    ingestedAt: new Date(r.ingested_at).toISOString(),
    components: Number(r.component_count),
    direct: Number(r.direct_count),
    completeness: r.completeness ?? undefined,
  }));
}

/** The raw document of the latest SBOM (for download). */
export async function latestSbomDocument(): Promise<string | null> {
  const [rows] = await pool.query<RowDataPacket[]>('SELECT document FROM sbom_builds ORDER BY id DESC LIMIT 1');
  return rows[0]?.document ?? null;
}

type VulnMap = Map<string, SbomVulnerability[]>;

async function vulnerabilitiesByPurl(purls?: string[]): Promise<VulnMap> {
  const [rows] = purls
    ? purls.length
      ? await pool.query<RowDataPacket[]>('SELECT * FROM sbom_vulns WHERE purl IN (?)', [purls])
      : [[] as RowDataPacket[]]
    : await pool.query<RowDataPacket[]>('SELECT * FROM sbom_vulns');
  const map: VulnMap = new Map();
  for (const r of rows) {
    const list = map.get(String(r.purl)) ?? [];
    list.push({
      id: String(r.osv_id),
      summary: String(r.summary),
      severity: r.severity as SbomSeverity,
      fixedIn: r.fixed_in ?? undefined,
      published: r.published ? new Date(r.published).toISOString() : undefined,
      aliases: typeof r.aliases === 'string' ? JSON.parse(r.aliases) : (r.aliases ?? []),
      url: `https://osv.dev/vulnerability/${encodeURIComponent(String(r.osv_id))}`,
    });
    map.set(String(r.purl), list);
  }
  const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
  for (const list of map.values()) list.sort((a, b) => order[a.severity] - order[b.severity]);
  return map;
}

const toComponent = (r: RowDataPacket, vulns: VulnMap): SbomComponent => ({
  purl: String(r.purl),
  name: String(r.name),
  version: String(r.version),
  ecosystem: String(r.ecosystem),
  description: r.description ?? undefined,
  license: r.license ?? undefined,
  homepage: r.homepage ?? undefined,
  direct: Boolean(r.direct),
  requiredBy: typeof r.required_by === 'string' ? JSON.parse(r.required_by) : (r.required_by ?? []),
  vulnerabilities: vulns.get(String(r.purl)) ?? [],
});

/** Numeric comparison of dotted versions: > 0 when a is newer. */
function compareVersions(a: string, b: string) {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10));
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * What changed between SBOMs, read from the versioned components table: rows that
 * appeared (their ROW_START) and rows that left (their ROW_END) at the same moment
 * under the same name are an upgrade or downgrade. The first SBOM is the baseline,
 * not a change.
 */
async function changes(limit: number): Promise<SbomChange[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT purl, name, version, ROW_START AS s, ROW_END AS e FROM sbom_components FOR SYSTEM_TIME ALL',
  );
  const ms = (d: unknown) => new Date(d as string).getTime();
  const OPEN = Date.UTC(2100, 0, 1);
  const baseline = rows.length ? Math.min(...rows.map((r) => ms(r.s))) : 0;
  let added = rows.filter((r) => ms(r.s) - baseline > 5000).map((r) => ({ purl: String(r.purl), name: String(r.name), version: String(r.version), at: ms(r.s) }));
  let removed = rows.filter((r) => ms(r.e) < OPEN).map((r) => ({ purl: String(r.purl), name: String(r.name), version: String(r.version), at: ms(r.e) }));
  // A row rewritten in place (same package version, new description or requirers) leaves a history
  // row and a new row with the same purl at the same moment: not a change of what is shipped.
  const rewritten = new Set<string>();
  for (const r of removed) {
    const a = added.find((x) => x.purl === r.purl && Math.abs(x.at - r.at) < 5000);
    if (a) rewritten.add(`${r.purl}|${r.at}`), rewritten.add(`${a.purl}|${a.at}`);
  }
  added = added.filter((a) => !rewritten.has(`${a.purl}|${a.at}`));
  removed = removed.filter((r) => !rewritten.has(`${r.purl}|${r.at}`));
  const out: SbomChange[] = [];
  const usedAdds = new Set<number>();
  for (const r of removed) {
    const i = added.findIndex((a, k) => !usedAdds.has(k) && a.name === r.name && Math.abs(a.at - r.at) < 5000);
    if (i >= 0) {
      usedAdds.add(i);
      out.push({
        at: new Date(added[i].at).toISOString(),
        kind: compareVersions(added[i].version, r.version) >= 0 ? 'upgraded' : 'downgraded',
        name: r.name,
        from: r.version,
        to: added[i].version,
      });
    } else {
      out.push({ at: new Date(r.at).toISOString(), kind: 'removed', name: r.name, from: r.version });
    }
  }
  added.forEach((a, k) => {
    if (!usedAdds.has(k)) out.push({ at: new Date(a.at).toISOString(), kind: 'added', name: a.name, to: a.version });
  });
  return out.sort((a, b) => b.at.localeCompare(a.at) || a.name.localeCompare(b.name)).slice(0, limit);
}

/** Everything the Health page shows about the SBOM. */
export async function sbomSummary(): Promise<SbomSummary> {
  const [list, [compRows], vulns, [[embedded]], [[checked]], recent] = await Promise.all([
    builds(15),
    pool.query<RowDataPacket[]>('SELECT * FROM sbom_components ORDER BY direct DESC, name, version'),
    vulnerabilitiesByPurl(),
    pool.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM sbom_chunks'),
    pool.query<RowDataPacket[]>('SELECT MAX(checked_at) AS at FROM sbom_vulns'),
    changes(80),
  ]);
  const components = compRows.map((r) => toComponent(r, vulns));
  const tally = (key: (c: SbomComponent) => string | undefined) => {
    const m = new Map<string, number>();
    for (const c of components) m.set(key(c) ?? 'Unknown', (m.get(key(c) ?? 'Unknown') ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  };
  const severities: SbomSummary['vulnerabilities'] = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  const seen = new Set<string>();
  for (const c of components) {
    for (const v of c.vulnerabilities) {
      if (seen.has(`${c.purl}|${v.id}`)) continue;
      seen.add(`${c.purl}|${v.id}`);
      severities[v.severity]++;
    }
  }
  if (checked?.at) severities.checkedAt = new Date(checked.at).toISOString();
  return {
    build: list[0] ?? null,
    builds: list,
    components,
    licenses: tally((c) => c.license).map(([license, count]) => ({ license, count })),
    ecosystems: tally((c) => c.ecosystem).map(([ecosystem, count]) => ({ ecosystem, count })),
    vulnerabilities: severities,
    changes: recent,
    embedded: Number(embedded.n),
  };
}

// ---------- Search ----------

const STOP = new Set(['the', 'and', 'for', 'what', 'which', 'with', 'that', 'this', 'are', 'any', 'our', 'use', 'uses', 'used', 'package', 'packages', 'library', 'libraries', 'dependency', 'dependencies', 'does', 'how', 'who', 'why', 'talks', 'have', 'has', 'can', 'there', 'from', 'into', 'about']);

/**
 * Search the SBOM like the Wikipedia corpus: the question is embedded and matched
 * against the components' embeddings (vector index). A component whose name the
 * question gives exactly ("fastify", "@heroui/react") is boosted to the top; names
 * are never matched by substring, since "to" or "client" appear in half of them.
 */
export async function searchSbom(query: string, limit = 8): Promise<SbomSearchHit[]> {
  const words = [...new Set((query.toLowerCase().match(/[a-z0-9@/._-]{3,}/g) ?? []).filter((w) => !STOP.has(w)))];
  const scored = new Map<string, { score: number; distance?: number }>();

  if (words.length) {
    const [named] = await pool.query<RowDataPacket[]>(
      `SELECT purl FROM sbom_components WHERE LOWER(name) IN (?) OR SUBSTRING_INDEX(LOWER(name), '/', -1) IN (?)`,
      [words, words],
    );
    for (const r of named) scored.set(String(r.purl), { score: 0.05 });
  }
  if (embeddingsEnabled) {
    const [vector] = await embedCached([query], 'query', AbortSignal.timeout(8_000)).catch(() => [undefined]);
    if (vector) {
      const v = vectorText(vector);
      const [near] = await pool.query<RowDataPacket[]>(
        `SELECT purl, VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) AS d FROM sbom_chunks ORDER BY VEC_DISTANCE_COSINE(embedding, VEC_FromText(?)) LIMIT ?`,
        [v, v, limit * 2],
      );
      for (const r of near) {
        const d = Number(r.d);
        const prior = scored.get(String(r.purl));
        if (d > 0.78 && !prior) continue;
        scored.set(String(r.purl), { score: prior ? prior.score : d, distance: d });
      }
    }
  } else if (words.length) {
    // Without embeddings: a looser name match is all there is.
    const [loose] = await pool.query<RowDataPacket[]>(
      `SELECT purl FROM sbom_components WHERE ${words.map(() => 'LOWER(name) LIKE ?').join(' OR ')} LIMIT 40`,
      words.map((w) => `%${w.replace(/[%_]/g, '')}%`),
    );
    for (const r of loose) if (!scored.has(String(r.purl))) scored.set(String(r.purl), { score: 0.5 });
  }
  const purls = [...scored.entries()].sort((a, b) => a[1].score - b[1].score).slice(0, limit).map(([p]) => p);
  if (purls.length === 0) return [];
  const [rows] = await pool.query<RowDataPacket[]>('SELECT * FROM sbom_components WHERE purl IN (?)', [purls]);
  const vulns = await vulnerabilitiesByPurl(purls);
  const byPurl = new Map(rows.map((r) => [String(r.purl), toComponent(r, vulns)]));
  return purls.flatMap((p) => {
    const c = byPurl.get(p);
    return c ? [{ ...c, distance: scored.get(p)?.distance }] : [];
  });
}
