import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const MARGIN = 8;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

interface Props {
  /** The element the tooltip points at. Nothing renders while it's null. */
  anchor: HTMLElement | null;
  /** Preferred side; flips to the opposite side when there isn't room. */
  placement?: 'top' | 'left';
  offset?: number;
  id?: string;
  className?: string;
  children: ReactNode;
}

/**
 * A tooltip rendered into document.body with fixed positioning, so scrolling
 * containers can't clip it. It stays inside the viewport and follows its
 * anchor while anything scrolls or resizes.
 *
 * It's visual only (hidden from assistive tech): every place that uses it
 * already exposes the same text, as a button label or the timeline's list.
 */
export function Floating({ anchor, placement = 'top', offset = 8, id, className = '', children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!anchor || !el) return;

    const update = () => {
      const a = anchor.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const vw = document.documentElement.clientWidth;
      const vh = document.documentElement.clientHeight;
      let x: number;
      let y: number;
      if (placement === 'top') {
        x = a.left + a.width / 2 - w / 2;
        y = a.top - offset - h;
        if (y < MARGIN) y = a.bottom + offset;
      } else {
        x = a.left - offset - w;
        y = a.top + a.height / 2 - h / 2;
        if (x < MARGIN) x = a.right + offset;
      }
      setPos({ x: clamp(x, MARGIN, vw - w - MARGIN), y: clamp(y, MARGIN, vh - h - MARGIN) });
    };

    update();
    const resize = new ResizeObserver(update);
    resize.observe(el);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      resize.disconnect();
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [anchor, placement, offset]);

  if (!anchor) return null;
  return createPortal(
    <div
      ref={ref}
      id={id}
      aria-hidden
      className={`pointer-events-none fixed top-0 left-0 z-[100] w-max max-w-[min(20rem,calc(100vw-16px))] rounded-lg border border-border bg-overlay shadow-lg ${className}`}
      style={{
        transform: pos ? `translate(${pos.x}px, ${pos.y}px)` : undefined,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
