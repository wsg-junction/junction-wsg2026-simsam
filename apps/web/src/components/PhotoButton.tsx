import { useRef } from 'react';
import { Button } from '@heroui/react';

/**
 * Search with a photo. No `capture` attribute: phones offer the camera, the
 * photo library and files in one sheet, so taking and picking are one button.
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
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        tabIndex={-1}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onFile(file);
        }}
      />
      <Button
        isIconOnly
        size={size}
        variant="ghost"
        aria-label="Search with a photo"
        isPending={isPending}
        isDisabled={isDisabled}
        onPress={() => input.current?.click()}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M14.5 4h-5L8 6H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3z" />
          <circle cx="12" cy="13" r="3.5" />
        </svg>
      </Button>
    </>
  );
}
