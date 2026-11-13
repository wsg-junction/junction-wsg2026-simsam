import { Fragment } from 'react';

/** A numbered citation pointing at an entry in a page's source list. */
export function Cite({ n, href }: { n: number; href: string }) {
  return (
    <sup className="ml-0.5 font-sans text-[0.7em]">
      <a
        href={href}
        aria-label={`Source ${n}`}
        className="rounded px-0.5 text-accent no-underline outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus"
      >
        [{n}]
      </a>
    </sup>
  );
}

/** Tidy model output: drop stray markdown the prompt asks it not to use. */
export function cleanAnswer(text: string) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/[ \t]+(\[\d+\])/g, '$1') // keep citation marks against their sentence
    .replace(/\[\d*$/, ''); // a citation still being streamed in
}

/** Answer text without its citation marks, for compact places like the chat log. */
export function withoutCitations(text: string) {
  return cleanAnswer(text).replace(/\s*\[\d+\]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Render answer text as paragraphs, turning "[2]" into a link to source 2.
 * Numbers outside the page's sources are dropped rather than shown as dead links.
 */
export function CitedText({
  text,
  sourceCount,
  href,
  className,
}: {
  text: string;
  sourceCount: number;
  href: (n: number) => string;
  className?: string;
}) {
  const paragraphs = cleanAnswer(text)
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i} className={className}>
          {p.split(/(\[\d+\])/).map((part, j) => {
            const match = part.match(/^\[(\d+)\]$/);
            if (!match) return <Fragment key={j}>{part}</Fragment>;
            const n = Number(match[1]);
            return n >= 1 && n <= sourceCount ? <Cite key={j} n={n} href={href(n)} /> : null;
          })}
        </p>
      ))}
    </>
  );
}
