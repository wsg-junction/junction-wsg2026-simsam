import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@heroui/react';

/** Phones and tablets: a finger is the main pointer, so the camera is worth offering by name. */
const touchDevice = () => {
  try {
    return window.matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
};

/**
 * Search with a photo. On a computer it opens the file picker. On a phone it
 * first asks: take a photo now (the camera app) or choose one from the library.
 * Without that choice, some phones only offer the library.
 */
export function PhotoButton({
  onFile,
  size = 'sm',
  isPending,
  isDisabled,
}: {
  onFile: (file: File) => void;
  size?: 'sm' | 'md' | 'lg';
  isPending?: boolean;
  isDisabled?: boolean;
}) {
  const library = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const [asking, setAsking] = useState(false);

  const picked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) onFile(file);
  };

  return (
    <>
      <input ref={library} type="file" accept="image/*" hidden tabIndex={-1} onChange={picked} />
      {/* capture="environment" opens the back camera directly. */}
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden tabIndex={-1} onChange={picked} />
      <Button
        isIconOnly
        size={size}
        variant="ghost"
        aria-label="Search with a photo"
        aria-haspopup={touchDevice() ? 'dialog' : undefined}
        isPending={isPending}
        isDisabled={isDisabled}
        onPress={() => (touchDevice() ? setAsking(true) : library.current?.click())}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M14.5 4h-5L8 6H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3z" />
          <circle cx="12" cy="13" r="3.5" />
        </svg>
      </Button>
      {asking && (
        <Sheet
          onClose={() => setAsking(false)}
          onTake={() => {
            setAsking(false);
            camera.current?.click();
          }}
          onChoose={() => {
            setAsking(false);
            library.current?.click();
          }}
        />
      )}
    </>
  );
}

/** A bottom sheet (portal into body, so the chat card's clipping can't cut it). */
function Sheet({ onClose, onTake, onChoose }: { onClose: () => void; onTake: () => void; onChoose: () => void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const row =
    'flex w-full items-center gap-3 rounded-xl px-4 py-3.5 text-left text-base outline-none hover:bg-default focus-visible:ring-2 focus-visible:ring-focus';
  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-end justify-center" role="presentation">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search with a photo"
        className="relative m-3 w-full max-w-md rounded-2xl border border-border bg-surface p-2 shadow-2xl motion-safe:animate-[sheet-in_160ms_ease-out]"
        style={{ marginBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        <button ref={first} type="button" onClick={onTake} className={row}>
          <CameraIcon />
          Take a photo
        </button>
        <button type="button" onClick={onChoose} className={row}>
          <ImageIcon />
          Choose from your photos
        </button>
        <button type="button" onClick={onClose} className={`${row} justify-center text-muted`}>
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
}

const icon = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;

function CameraIcon() {
  return (
    <svg {...icon}>
      <path d="M14.5 4h-5L8 6H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg {...icon}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}
