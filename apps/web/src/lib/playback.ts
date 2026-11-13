import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { prefersReducedMotion } from './motion';

/**
 * Plays a page's content one beat at a time: each beat is revealed, then
 * "narrated" before the next one appears.
 *
 * The narrator is the seam for voice: today it just waits long enough to read
 * the beat; a voice narrator would speak `text` and resolve when it finishes.
 * It must reject (or resolve early) when `signal` aborts, which happens on
 * pause, when the page scrolls out of view, and on unmount.
 */
export interface Narrator {
  narrate(text: string, signal: AbortSignal): Promise<void>;
  /** Optional: get the next beat ready (e.g. fetch its audio) while the current one plays. */
  prepare?(text: string): void;
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

/** Holds each beat for roughly the time it takes to read it. */
export const pacedNarrator: Narrator = {
  narrate: (text, signal) => wait(Math.min(4500, Math.max(1500, 600 + text.length * 26)), signal),
};

const interruptListeners = new Set<() => boolean>();
const resumeListeners = new Set<() => void>();

/**
 * Pause every page's playback, e.g. when someone starts talking. Returns
 * whether anything was actually playing.
 */
export function interruptPlayback() {
  let wasPlaying = false;
  interruptListeners.forEach((listener) => {
    if (listener()) wasPlaying = true;
  });
  return wasPlaying;
}

/** Carry on with whatever `interruptPlayback` paused (if it's still in view). */
export function resumePlayback() {
  resumeListeners.forEach((listener) => listener());
}

interface Options {
  /** Only plays while the page is in view. */
  active: boolean;
  narrator?: Narrator;
}

export interface Playback {
  /** The beat being narrated (highlighted), or -1 before playback starts. */
  current: number;
  /** Beats up to this index are visible. */
  revealed: number;
  playing: boolean;
  play: () => void;
  pause: () => void;
  replay: () => void;
  showAll: () => void;
  /** Move to a beat (e.g. a clicked timeline marker) and pause there. */
  jumpTo: (index: number) => void;
}

export function usePlayback(beats: string[], { active, narrator = pacedNarrator }: Options): Playback {
  const reduced = useMemo(prefersReducedMotion, []);
  const [current, setCurrent] = useState(-1);
  const [revealed, setRevealed] = useState(-1);
  const [playing, setPlaying] = useState(false);
  // Bumped by play/replay so a run already in progress restarts from the new position.
  const [run, setRun] = useState(0);
  const currentRef = useRef(current);
  currentRef.current = current;
  const beatsRef = useRef(beats);
  beatsRef.current = beats;

  const goTo = useCallback((i: number) => {
    currentRef.current = i;
    setCurrent(i);
    setRevealed((r) => Math.max(r, i));
  }, []);

  const playingRef = useRef(playing);
  playingRef.current = playing;
  const activeRef = useRef(active);
  activeRef.current = active;
  const interrupted = useRef(false);

  useEffect(() => {
    const stop = () => {
      if (!playingRef.current) return false;
      interrupted.current = true;
      playingRef.current = false;
      setPlaying(false);
      return true;
    };
    const resume = () => {
      if (!interrupted.current || !activeRef.current) return;
      interrupted.current = false;
      setPlaying(true);
      setRun((n) => n + 1);
    };
    interruptListeners.add(stop);
    resumeListeners.add(resume);
    return () => {
      interruptListeners.delete(stop);
      resumeListeners.delete(resume);
    };
  }, []);

  // First time the content is ready and in view: play it, or (with reduced
  // motion) show everything at once and let the reader start it themselves.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !active || beats.length === 0) return;
    started.current = true;
    if (reduced) setRevealed(beats.length - 1);
    else setPlaying(true);
  }, [active, beats.length, reduced]);

  useEffect(() => {
    if (!playing || !active) return;
    const controller = new AbortController();
    (async () => {
      // Resume on the beat that was interrupted, or start from the top.
      for (let i = Math.max(currentRef.current, 0); i < beatsRef.current.length; i++) {
        goTo(i);
        const next = beatsRef.current[i + 1];
        if (next) narrator.prepare?.(next);
        await narrator.narrate(beatsRef.current[i], controller.signal);
      }
      setPlaying(false);
    })().catch(() => {
      /* aborted: paused, scrolled away or unmounted */
    });
    return () => controller.abort();
  }, [playing, active, run, narrator, goTo]);

  return {
    current,
    revealed,
    playing,
    play: () => {
      interrupted.current = false;
      if (currentRef.current >= beatsRef.current.length - 1) goTo(0);
      setPlaying(true);
      setRun((n) => n + 1);
    },
    pause: () => {
      interrupted.current = false;
      setPlaying(false);
    },
    replay: () => {
      setRevealed(-1);
      goTo(0);
      setPlaying(true);
      setRun((n) => n + 1);
    },
    showAll: () => {
      setPlaying(false);
      setRevealed(beatsRef.current.length - 1);
    },
    jumpTo: (i) => {
      setPlaying(false);
      goTo(i);
    },
  };
}
