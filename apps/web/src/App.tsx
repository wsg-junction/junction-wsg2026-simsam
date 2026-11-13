import { useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import type { Exploration, ExplorationStep } from '@simsam/models';
import { AtlasBackdrop } from './components/AtlasBackdrop';
import { ExplorationView } from './components/ExplorationView';
import { Opening } from './components/Opening';
import { Brand, SavedList, Sidebar, type SavedState } from './components/Sidebar';
import { deleteExploration, listExplorations, saveExploration, updateExploration } from './lib/api';
import { withViewTransition } from './lib/motion';
import { ThemeToggle } from './theme';

type View =
  | { kind: 'opening' }
  | {
      kind: 'exploring';
      key: number;
      steps: ExplorationStep[];
      /** Set once saved; savedSteps is how many steps that saved copy holds. */
      savedId?: number;
      savedSteps?: number;
    };

let viewKey = 0;

export function App() {
  const [view, setView] = useState<View>({ kind: 'opening' });
  const [saved, setSaved] = useState<SavedState>({ status: 'loading' });
  const [savedOpen, setSavedOpen] = useState(false);

  useEffect(() => {
    listExplorations()
      .then((items) => setSaved({ status: 'ready', items }))
      .catch(() => setSaved({ status: 'unavailable' }));
  }, []);

  const go = useCallback((next: View) => {
    setSavedOpen(false);
    withViewTransition(() => setView(next));
  }, []);

  const explore = (question: string) =>
    go({ kind: 'exploring', key: ++viewKey, steps: [{ kind: 'question', text: question }] });

  const open = (item: Exploration) =>
    go({ kind: 'exploring', key: ++viewKey, steps: item.steps, savedId: item.id, savedSteps: item.steps.length });

  async function save(steps: ExplorationStep[], focusTitle: string) {
    if (view.kind !== 'exploring') return;
    const body = { steps, focusTitle };
    const item = view.savedId ? await updateExploration(view.savedId, body) : await saveExploration(body);
    setSaved((s) => ({
      status: 'ready',
      items: [item, ...(s.status === 'ready' ? s.items.filter((i) => i.id !== item.id) : [])],
    }));
    setView({ ...view, savedId: item.id, savedSteps: steps.length });
  }

  async function remove(item: Exploration) {
    await deleteExploration(item.id);
    setSaved((s) => (s.status === 'ready' ? { ...s, items: s.items.filter((i) => i.id !== item.id) } : s));
    if (view.kind === 'exploring' && view.savedId === item.id)
      setView({ ...view, savedId: undefined, savedSteps: undefined });
  }

  const activeId = view.kind === 'exploring' ? view.savedId : undefined;
  const listProps = { saved, activeId, onOpen: open, onDelete: remove };

  return (
    <div className="flex h-full flex-col md:flex-row">
      <Sidebar {...listProps} onNew={() => go({ kind: 'opening' })} />

      {/* Compact header on small screens */}
      <header className="flex items-center justify-between gap-2 border-b border-border bg-surface/80 px-4 py-2.5 backdrop-blur-sm md:hidden">
        <Brand />
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={savedOpen}
            aria-controls="saved-mobile"
            onPress={() => setSavedOpen((o) => !o)}
          >
            Saved
          </Button>
          <Button size="sm" variant="ghost" onPress={() => go({ kind: 'opening' })}>
            New
          </Button>
          <ThemeToggle />
        </div>
      </header>
      {savedOpen && (
        <div id="saved-mobile" className="max-h-[50vh] overflow-y-auto border-b border-border bg-surface px-3 py-3 md:hidden">
          <SavedList {...listProps} />
        </div>
      )}

      <main
        className={`relative min-h-0 flex-1 ${view.kind === 'opening' ? 'overflow-y-auto' : 'overflow-hidden'}`}
      >
        <AtlasBackdrop dimmed={view.kind === 'exploring'} />
        <div className="relative h-full">
          {view.kind === 'opening' ? (
            <Opening onExplore={explore} />
          ) : (
            <ExplorationView
              key={view.key}
              initialSteps={view.steps}
              savedSteps={view.savedSteps}
              onSave={save}
            />
          )}
        </div>
      </main>
    </div>
  );
}
