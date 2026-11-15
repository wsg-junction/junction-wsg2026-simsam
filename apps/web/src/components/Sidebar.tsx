import { Button, ScrollShadow, Spinner } from '@heroui/react';
import type { Exploration } from '@simsam/models';
import { timeAgo } from '../lib/motion';
import { ThemeToggle } from '../theme';

export type SavedState =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; items: Exploration[] };

interface Props {
  saved: SavedState;
  activeId?: number;
  onNew: () => void;
  onOpen: (exploration: Exploration) => void;
  onDelete: (exploration: Exploration) => void;
  /** Open the Health page (services and the software bill of materials). */
  onHealth?: () => void;
  healthActive?: boolean;
}

export function Brand() {
  return (
    <span className="flex items-center gap-2 font-serif text-xl">
      <span aria-hidden className="size-2.5 rounded-full border-2 border-accent" />
      Atlas
    </span>
  );
}

export function SavedList({ saved, activeId, onOpen, onDelete }: Omit<Props, 'onNew' | 'onHealth' | 'healthActive'>) {
  if (saved.status === 'loading') {
    return (
      <div className="flex justify-center py-6">
        <Spinner size="sm" aria-label="Loading saved explorations" />
      </div>
    );
  }
  if (saved.status === 'unavailable') {
    return (
      <p className="px-2 text-sm text-muted">
        Saved explorations can’t load because the server isn’t responding.
      </p>
    );
  }
  if (saved.items.length === 0) {
    return (
      <p className="px-2 text-sm text-muted">
        Nothing saved yet. Save an exploration to come back to its graph later.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {saved.items.map((item) => (
        <li key={item.id} className="group relative">
          <button
            type="button"
            onClick={() => onOpen(item)}
            aria-current={item.id === activeId ? 'page' : undefined}
            className="flex w-full flex-col gap-0.5 rounded-md py-2 pr-8 pl-2 text-left outline-none hover:bg-default focus-visible:ring-2 focus-visible:ring-focus aria-[current=page]:bg-default"
          >
            <span className="line-clamp-2 text-sm leading-snug">{item.question}</span>
            <span className="text-xs text-muted">
              {item.steps.length > 1 ? `${item.steps.length} pages` : item.focusTitle}, {timeAgo(item.createdAt)}
            </span>
          </button>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={`Remove “${item.question}” from saved`}
            onPress={() => onDelete(item)}
            className="absolute top-1.5 right-0.5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </Button>
        </li>
      ))}
    </ul>
  );
}

export function Sidebar(props: Props) {
  return (
    <nav
      aria-label="Explorations"
      className="hidden w-64 shrink-0 flex-col gap-6 border-r border-border bg-surface/60 px-3 py-5 backdrop-blur-sm md:flex"
    >
      <div className="px-2">
        <Brand />
      </div>
      <Button variant="secondary" onPress={props.onNew} fullWidth>
        New exploration
      </Button>
      <div className="flex min-h-0 flex-1 flex-col gap-2">
        <h2 className="px-2 text-sm font-semibold">Saved</h2>
        <ScrollShadow className="min-h-0 flex-1 overflow-y-auto">
          <SavedList {...props} />
        </ScrollShadow>
      </div>
      <div className="flex flex-col gap-2">
        {props.onHealth && (
          <button
            type="button"
            onClick={props.onHealth}
            aria-current={props.healthActive ? 'page' : undefined}
            className="flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm outline-none hover:bg-default focus-visible:ring-2 focus-visible:ring-focus aria-[current=page]:bg-default"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-muted">
              <path d="M3 12h4l3-8 4 16 3-8h4" />
            </svg>
            Health
          </button>
        )}
        <div className="flex items-center justify-between px-2">
          <span className="text-xs text-muted">Theme</span>
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}
