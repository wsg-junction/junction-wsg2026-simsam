import { useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Spinner, TextField } from '@heroui/react';
import type { Health, SbomChange, SbomComponent, SbomSearchHit, SbomSeverity, SbomSummary } from '@simsam/models';
import { serverFeatures } from '../lib/ai';
import { timeAgo } from '../lib/motion';
import { fetchSbom, searchSbom } from '../lib/sbom';

const SERVICES: { key: keyof Health; label: string; detail: string }[] = [
  { key: 'ai', label: 'AI answers', detail: 'Nemotron: answers, briefs, routing, reading figures' },
  { key: 'corpus', label: 'Wikipedia in MariaDB', detail: 'Articles, their history and the vector index' },
  { key: 'deep', label: 'Deep research', detail: 'Full reports from the collection' },
  { key: 'web', label: 'Web context', detail: 'context.dev, kept apart from Wikipedia' },
  { key: 'factcheck', label: 'Fact-check', detail: 'Gemini with Google Search' },
  { key: 'image', label: 'Photo search', detail: 'Reads a photo, then searches' },
  { key: 'voice', label: 'Voice', detail: 'Read aloud and spoken questions' },
];

const SEVERITIES: SbomSeverity[] = ['critical', 'high', 'medium', 'low', 'unknown'];
const SEVERITY_STYLE: Record<SbomSeverity, string> = {
  critical: 'bg-[var(--removed-bg)] text-[var(--removed-fg)]',
  high: 'bg-[var(--removed-bg)] text-[var(--removed-fg)]',
  medium: 'bg-[var(--verdict-partly-bg)] text-[var(--verdict-partly)]',
  low: 'bg-default text-muted',
  unknown: 'bg-default text-muted',
};

function SeverityBadge({ severity, children }: { severity: SbomSeverity; children?: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLE[severity]}`}>
      {children ?? severity}
    </span>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="font-serif text-2xl font-normal">{title}</h2>
        {hint && <p className="mt-1 text-sm leading-relaxed text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="font-serif text-3xl leading-tight">{value}</p>
      {note && <p className="text-xs text-muted">{note}</p>}
    </div>
  );
}

/** The Health page: what Atlas is running and what it is built from (its SBOM). */
export function HealthView() {
  const [health, setHealth] = useState<Health | null | undefined>(undefined);
  const [sbom, setSbom] = useState<SbomSummary | null | 'error'>(null);
  useEffect(() => {
    const controller = new AbortController();
    serverFeatures().then(setHealth);
    fetchSbom(controller.signal)
      .then(setSbom)
      .catch((err) => !controller.signal.aborted && setSbom('error'));
    return () => controller.abort();
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-10 px-4 py-10 sm:px-8">
        <header>
          <h1 className="font-serif text-4xl font-normal">Health</h1>
          <p className="mt-2 max-w-2xl leading-relaxed text-muted">
            What Atlas is running, and what it is built from. The list of components comes from the build’s own
            software bill of materials (SBOM), kept in MariaDB like the Wikipedia articles: with its history, and
            searchable by meaning.
          </p>
        </header>

        <Section title="Services">
          {health === undefined ? (
            <Spinner size="sm" aria-label="Checking the services" />
          ) : health === null ? (
            <p role="alert" className="rounded-lg border border-[var(--removed)] px-4 py-3 text-sm">
              The server isn’t responding.
            </p>
          ) : (
            <>
              <ul className="grid gap-2 sm:grid-cols-2">
                {SERVICES.map((s) => {
                  const on = health[s.key] === true;
                  return (
                    <li key={s.key} className="flex items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3">
                      <span
                        aria-hidden
                        className="mt-1.5 size-2.5 shrink-0 rounded-full"
                        style={{ background: on ? 'var(--added)' : 'var(--field-line)' }}
                      />
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {s.label} <span className="font-normal text-muted">· {on ? 'on' : 'not set up'}</span>
                        </p>
                        <p className="text-xs text-muted">{s.detail}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="text-sm text-muted">
                {health.build?.sha ? (
                  <>
                    Running commit <code className="rounded bg-default px-1">{health.build.sha.slice(0, 7)}</code>
                    {health.build.builtAt && <>, built {timeAgo(health.build.builtAt)}</>}.
                  </>
                ) : (
                  'A development build (no commit recorded).'
                )}
              </p>
            </>
          )}
        </Section>

        {sbom === null ? (
          <Spinner size="sm" aria-label="Loading the bill of materials" />
        ) : sbom === 'error' ? (
          <p role="alert" className="rounded-lg border border-[var(--removed)] px-4 py-3 text-sm">
            The bill of materials couldn’t be loaded.
          </p>
        ) : !sbom.build ? (
          <Section title="Supply chain">
            <div className="rounded-xl border border-border bg-surface px-5 py-4 text-sm leading-relaxed">
              <p className="font-medium">No SBOM has been recorded yet.</p>
              <p className="mt-1 text-muted">
                The first build on CRACI records one: its CI step posts the build’s CycloneDX SBOM to this server. You can
                also load a file by hand with <code className="rounded bg-default px-1">npm run sbom -w api -- sbom.cdx.json</code>.
              </p>
            </div>
          </Section>
        ) : (
          <SupplyChain sbom={sbom} />
        )}
      </div>
    </div>
  );
}

function SupplyChain({ sbom }: { sbom: SbomSummary }) {
  const build = sbom.build!;
  const vulnerable = useMemo(
    () => sbom.components.filter((c) => c.vulnerabilities.length > 0).sort((a, b) => worst(a) - worst(b) || a.name.localeCompare(b.name)),
    [sbom],
  );
  const total = SEVERITIES.reduce((n, s) => n + sbom.vulnerabilities[s], 0);

  return (
    <>
      <Section
        title="Supply chain"
        hint={`Every package the software is built from, as recorded by ${build.source === 'craci' ? 'CRACI for the build' : build.source}.`}
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Components" value={build.components} note={`${build.direct} direct`} />
          <Stat label="Licenses" value={sbom.licenses.length} note={sbom.licenses[0] ? `mostly ${sbom.licenses[0].license}` : undefined} />
          <Stat
            label="Known vulnerabilities"
            value={total}
            note={total ? SEVERITIES.filter((s) => sbom.vulnerabilities[s]).map((s) => `${sbom.vulnerabilities[s]} ${s}`).join(', ') : 'none found'}
          />
          <Stat label="Searchable by meaning" value={sbom.embedded} note="embedded components" />
        </div>
        <p className="text-sm text-muted">
          Recorded {timeAgo(build.ingestedAt)}
          {build.commit && (
            <>
              {' '}
              from commit <code className="rounded bg-default px-1">{build.commit.slice(0, 7)}</code>
            </>
          )}
          {build.completeness && <>. The producer reports: {build.completeness}</>}
          {sbom.vulnerabilities.checkedAt && <>. Vulnerabilities checked {timeAgo(sbom.vulnerabilities.checkedAt)} (OSV.dev)</>}.{' '}
          <a
            href="/api/sbom/download"
            className="rounded font-medium text-foreground underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            Download the SBOM (CycloneDX)
          </a>
        </p>
      </Section>

      {vulnerable.length > 0 && (
        <Section title="Vulnerabilities" hint="Components with a known advisory. A fix version is shown when the advisory names one.">
          <ul className="flex flex-col gap-2">
            {vulnerable.map((c) => (
              <li key={c.purl} className="rounded-xl border border-border bg-surface px-4 py-3">
                <p className="text-sm font-medium">
                  {c.name} <span className="font-normal text-muted">{c.version}</span>
                  {c.direct ? '' : <span className="font-normal text-muted"> · through {c.requiredBy[0] ?? 'another package'}</span>}
                </p>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {c.vulnerabilities.slice(0, 4).map((v) => (
                    <li key={v.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
                      <SeverityBadge severity={v.severity} />
                      <a href={v.url} target="_blank" rel="noreferrer" className="rounded font-medium underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-focus">
                        {v.id}
                      </a>
                      <span className="min-w-0 text-muted">{v.summary}</span>
                      {v.fixedIn && <span className="text-xs">Fixed in {v.fixedIn}</span>}
                    </li>
                  ))}
                  {c.vulnerabilities.length > 4 && <li className="text-xs text-muted">and {c.vulnerabilities.length - 4} more</li>}
                </ul>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <AskSbom />

      <Section
        title="Changes"
        hint="Read from the versioned components table: each recorded build adds, removes or changes rows, and the table keeps what was there before."
      >
        {sbom.changes.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing has changed yet: {sbom.builds.length === 1 ? 'one build has been recorded' : `${sbom.builds.length} builds are recorded and they match`}.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-separator rounded-xl border border-border bg-surface">
            {sbom.changes.slice(0, 30).map((c, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2.5 text-sm">
                <ChangeLabel change={c} />
                <span className="font-medium">{c.name}</span>
                <span className="text-muted">
                  {c.from && c.to ? `${c.from} → ${c.to}` : (c.to ?? c.from)}
                </span>
                <span className="ml-auto text-xs text-muted">{timeAgo(c.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Components components={sbom.components} />
    </>
  );
}

const worst = (c: SbomComponent) => Math.min(...c.vulnerabilities.map((v) => SEVERITIES.indexOf(v.severity)));

function ChangeLabel({ change }: { change: SbomChange }) {
  const style =
    change.kind === 'added'
      ? 'bg-[var(--added-bg)] text-[var(--added-fg)]'
      : change.kind === 'removed'
        ? 'bg-[var(--removed-bg)] text-[var(--removed-fg)]'
        : 'bg-default text-muted';
  return <span className={`w-24 shrink-0 rounded-full px-2 py-0.5 text-center text-xs font-medium ${style}`}>{change.kind}</span>;
}

/** Ask about the dependencies in plain words: the SBOM is searched like the Wikipedia passages. */
function AskSbom() {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<{ status: 'idle' } | { status: 'loading' } | { status: 'error' } | { status: 'ready'; query: string; hits: SbomSearchHit[] }>({ status: 'idle' });
  const submit = (e: { preventDefault(): void }) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setState({ status: 'loading' });
    searchSbom(q)
      .then((hits) => setState({ status: 'ready', query: q, hits }))
      .catch(() => setState({ status: 'error' }));
  };
  return (
    <Section
      title="Ask the bill of materials"
      hint="Components are embedded and searched with the same model and vector index as the Wikipedia articles, so you can ask in plain words."
    >
      <Form onSubmit={submit} className="flex gap-2">
        <TextField aria-label="Ask about the dependencies" value={query} onChange={setQuery} className="min-w-0 flex-1">
          <Input placeholder="e.g. which package talks to the database?" className="text-base" />
        </TextField>
        <Button type="submit" isPending={state.status === 'loading'} isDisabled={!query.trim()}>
          Search
        </Button>
      </Form>
      {state.status === 'error' && <p role="alert" className="text-sm">The search didn’t work. Try again.</p>}
      {state.status === 'ready' &&
        (state.hits.length === 0 ? (
          <p className="text-sm text-muted">Nothing in the bill of materials matches “{state.query}”.</p>
        ) : (
          <ul className="flex flex-col gap-2" aria-label={`Components matching “${state.query}”`}>
            {state.hits.map((h) => (
              <li key={h.purl} className="rounded-xl border border-border bg-surface px-4 py-3">
                <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-medium">{h.name}</span>
                  <span className="text-muted">{h.version}</span>
                  <span className="rounded-full bg-default px-2 py-0.5 text-xs text-muted">{h.direct ? 'direct' : 'transitive'}</span>
                  {h.license && <span className="text-xs text-muted">{h.license}</span>}
                  {h.vulnerabilities.length > 0 && <SeverityBadge severity={h.vulnerabilities[0].severity}>{h.vulnerabilities.length} known {h.vulnerabilities.length === 1 ? 'vulnerability' : 'vulnerabilities'}</SeverityBadge>}
                </p>
                {h.description && <p className="mt-1 text-sm text-muted">{h.description}</p>}
                {!h.direct && h.requiredBy.length > 0 && <p className="mt-1 text-xs text-muted">Required by {h.requiredBy.join(', ')}</p>}
              </li>
            ))}
          </ul>
        ))}
    </Section>
  );
}

function Components({ components }: { components: SbomComponent[] }) {
  const [filter, setFilter] = useState('');
  const [all, setAll] = useState(false);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return f ? components.filter((c) => c.name.toLowerCase().includes(f) || (c.license ?? '').toLowerCase().includes(f)) : components;
  }, [components, filter]);
  const rows = all || filter ? shown : shown.slice(0, 40);
  return (
    <Section title="All components" hint={`${components.length} in the latest build. Direct dependencies first.`}>
      <TextField aria-label="Filter components by name or license" value={filter} onChange={setFilter}>
        <Input placeholder="Filter by name or license" className="text-base" />
      </TextField>
      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full min-w-[32rem] text-left text-sm">
          <thead className="text-xs text-muted">
            <tr className="border-b border-separator">
              <th className="px-4 py-2 font-medium">Package</th>
              <th className="px-2 py-2 font-medium">Version</th>
              <th className="px-2 py-2 font-medium">License</th>
              <th className="px-4 py-2 font-medium">Kind</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.purl} className="border-b border-separator last:border-0">
                <td className="px-4 py-1.5">
                  {c.homepage ? (
                    <a href={c.homepage} target="_blank" rel="noreferrer" className="rounded underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus">
                      {c.name}
                    </a>
                  ) : (
                    c.name
                  )}
                  {c.vulnerabilities.length > 0 && (
                    <span className="ml-2">
                      <SeverityBadge severity={c.vulnerabilities[0].severity}>{c.vulnerabilities.length}</SeverityBadge>
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5 text-muted">{c.version}</td>
                <td className="px-2 py-1.5 text-muted">{c.license ?? '–'}</td>
                <td className="px-4 py-1.5 text-muted">{c.direct ? 'direct' : 'transitive'}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-3 text-muted">
                  No component matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {!all && !filter && shown.length > rows.length && (
        <div>
          <Button size="sm" variant="secondary" onPress={() => setAll(true)}>
            Show all {shown.length}
          </Button>
        </div>
      )}
    </Section>
  );
}
