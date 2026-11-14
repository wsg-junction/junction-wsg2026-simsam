import { Button, Link, Skeleton } from '@heroui/react';
import type { DiffSegment, FactCheckClaim, FactCheckReport, FactCheckVerdict } from '@simsam/models';

export type FactCheckState =
  | { status: 'loading' }
  | { status: 'ready'; report: FactCheckReport }
  /** No Wikipedia article has this title. */
  | { status: 'missing' }
  | { status: 'error'; message?: string };

interface Props {
  title: string | undefined;
  state: FactCheckState | undefined;
  onRetry: () => void;
}

const VERDICT: Record<FactCheckVerdict, { label: string; color: string; bg: string; icon: string }> = {
  supported: {
    label: 'Confirmed',
    color: 'var(--added)',
    bg: 'var(--added-bg)',
    icon: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM8 12.5l2.7 2.7L16 9.8',
  },
  partly: {
    label: 'Partly confirmed',
    color: 'var(--verdict-partly)',
    bg: 'var(--verdict-partly-bg)',
    icon: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM12 3v18',
  },
  contradicted: {
    label: 'Contradicted',
    color: 'var(--removed)',
    bg: 'var(--removed-bg)',
    icon: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM9 9l6 6M15 9l-6 6',
  },
  unverified: {
    label: 'Not found',
    color: 'var(--muted)',
    bg: 'var(--default)',
    icon: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zM9.6 9.3a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4M12 16.6v.1',
  },
};
const ORDER: FactCheckVerdict[] = ['contradicted', 'partly', 'supported', 'unverified'];

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function VerdictIcon({ verdict, size = 16 }: { verdict: FactCheckVerdict; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={VERDICT[verdict].icon} />
    </svg>
  );
}

/**
 * The fact-check beside the research canvas: the claims in the opening of the
 * page's main article, each checked against the web by AI (Gemini with Google
 * Search), with a word-by-word comparison and the sources it found.
 */
export function FactCheckPanel({ title, state, onRetry }: Props) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-5 pt-3">
        <h2 className="pt-1.5 text-sm font-semibold">{title ? `Fact-check of ${title}` : 'Fact-check'}</h2>
        <p className="text-sm text-muted">
          Claims from the opening of the article, checked against the web. It doesn’t change the page.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-6">
        {!title && <p className="text-sm text-muted">Ask a question to check the claims of its main article.</p>}
        {title && (!state || state.status === 'loading') && (
          <div className="flex flex-col gap-4" aria-busy>
            <p aria-live="polite" className="text-sm text-muted">
              Checking the claims in “{title}” against the web. The first check of an article takes a minute or two; after
              that it’s kept until the article changes.
            </p>
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex flex-col gap-2">
                <Skeleton className="h-5 w-28 rounded-full" />
                <Skeleton className="h-4 w-full rounded" />
                <Skeleton className="h-4 w-4/5 rounded" />
              </div>
            ))}
          </div>
        )}
        {state?.status === 'error' && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <p className="text-muted">{state.message ?? 'The claims couldn’t be checked right now.'}</p>
            <Button size="sm" variant="secondary" onPress={onRetry}>
              Try again
            </Button>
          </div>
        )}
        {state?.status === 'missing' && <p className="text-sm text-muted">There’s no Wikipedia article titled “{title}” to check.</p>}
        {state?.status === 'ready' && <Report report={state.report} />}
      </div>
    </div>
  );
}

function Report({ report }: { report: FactCheckReport }) {
  if (report.claims.length === 0) {
    return <p className="text-sm text-muted">The opening of “{report.title}” has no specific claims to check.</p>;
  }
  const counts = ORDER.map((v) => [v, report.claims.filter((c) => c.verdict === v).length] as const).filter(([, n]) => n > 0);
  // Contradicted and partly confirmed first: those are worth reading.
  const claims = [...report.claims].sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict));
  return (
    <div className="flex flex-col gap-6">
      <ul aria-label="Verdicts" className="flex flex-wrap gap-2">
        {counts.map(([verdict, n]) => (
          <li
            key={verdict}
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
            style={{ background: VERDICT[verdict].bg, color: VERDICT[verdict].color }}
          >
            <VerdictIcon verdict={verdict} size={14} />
            <span className="text-foreground">
              {n} {VERDICT[verdict].label.toLowerCase()}
            </span>
          </li>
        ))}
      </ul>

      <ol className="flex flex-col gap-7">
        {claims.map((claim, i) => (
          <li key={i}>
            <ClaimView claim={claim} />
          </li>
        ))}
      </ol>

      <p className="text-xs text-muted">
        Evidence comes from Google Search and web search, leaving out Wikipedia, its sister sites and sites that copy
        it. Verdicts and findings are written by AI ({report.model}) from that evidence alone and can be wrong: open the
        sources to check. Only the article’s text was sent. Checked on {formatDate(report.checkedAt)} for{' '}
        <Link href={`${report.url}?oldid=${report.revisionId}`} target="_blank" rel="noreferrer" className="text-xs text-muted underline">
          this revision
        </Link>{' '}
        of the article; it’s checked again once the article changes.
      </p>
    </div>
  );
}

function ClaimView({ claim }: { claim: FactCheckClaim }) {
  const v = VERDICT[claim.verdict];
  const differs = claim.comparison.some((s) => s.type !== 'same');
  return (
    <article className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <span className="inline-flex items-center gap-1.5 self-start text-sm font-semibold" style={{ color: v.color }}>
          <VerdictIcon verdict={claim.verdict} />
          <span className="text-foreground">{v.label}</span>
        </span>
      </div>

      <dl className="flex flex-col gap-2 text-sm">
        <div className="rounded-lg border border-separator px-3 py-2">
          <dt className="text-xs font-medium text-muted">Claim checked, from Wikipedia</dt>
          <dd className="font-serif text-base leading-relaxed">
            <Words segments={claim.comparison} side="removed" />
          </dd>
          {claim.statement.trim() !== claim.claim.trim() && (
            <dd className="mt-1.5 text-xs text-muted">In the article: “{claim.statement}”</dd>
          )}
        </div>
        <div className="rounded-lg border border-separator px-3 py-2">
          <dt className="text-xs font-medium text-muted">The web sources say</dt>
          <dd className="font-serif leading-relaxed">
            <Words segments={claim.comparison} side="added" />
          </dd>
        </div>
        <p className="text-xs text-muted">
          {differs ? 'Highlighted: the words that differ between the two.' : 'Same wording in both.'}
        </p>
      </dl>

      {claim.explanation && <p className="text-sm">{claim.explanation}</p>}

      {claim.sources.length > 0 ? (
        <div className="text-sm">
          <p className="text-xs font-medium text-muted">Evidence the verdict rests on</p>
          <ul className="mt-1.5 flex flex-col gap-2.5">
            {claim.sources.map((s) => (
              <li key={s.url} className="flex flex-col gap-0.5">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <Link href={s.url} target="_blank" rel="noreferrer" className="text-sm font-medium text-foreground underline underline-offset-4">
                    {s.via === 'web' && s.site && s.title !== s.site ? s.title : s.site ?? s.title}
                  </Link>
                  {s.via && (
                    <span className="text-xs text-muted">
                      {s.via === 'web' ? `${s.site ?? ''}, found by web search` : 'found by Google Search'}
                    </span>
                  )}
                </span>
                {s.excerpt && (
                  <p className="line-clamp-3 text-xs text-muted">
                    {s.via === 'web' ? `“${s.excerpt}”` : s.excerpt}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted">No independent source addressed this claim.</p>
      )}
      {claim.searches.length > 0 && (
        <p className="text-xs text-muted">
          Searched for{' '}
          {claim.searches.map((q, i) => (
            <span key={q}>
              {i > 0 && ', '}
              <a
                href={`https://www.google.com/search?q=${encodeURIComponent(q)}`}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                “{q}”
              </a>
            </span>
          ))}
        </p>
      )}
    </article>
  );
}

/** One side of the comparison: shared words plain, this side's own words highlighted. */
function Words({ segments, side }: { segments: DiffSegment[]; side: 'added' | 'removed' }) {
  const mine = side === 'removed' ? 'Only in Wikipedia' : 'Only in the web sources';
  return (
    <>
      {segments
        .filter((s) => s.type === 'same' || s.type === side)
        .map((s, i) =>
          s.type === 'same' ? (
            <span key={i}>{s.text}</span>
          ) : (
            <mark
              key={i}
              className={`rounded-sm px-0.5 ${
                side === 'removed' ? 'bg-[var(--removed-bg)] text-[var(--removed-fg)]' : 'bg-[var(--added-bg)] text-[var(--added-fg)]'
              }`}
            >
              <span className="sr-only">[{mine}: </span>
              {s.text}
              <span className="sr-only">]</span>
            </mark>
          ),
        )}
    </>
  );
}
