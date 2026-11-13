import { useEffect, useRef } from 'react';
import { Button, Spinner } from '@heroui/react';
import { useSharedHandsFree, type HandsFreeState } from '../lib/handsfree';
import { useVoiceAvailable, useVoiceQuestion, type VoiceQuestionState } from '../lib/voice';

/**
 * Asking by voice, wherever there's a question box: push-to-talk for this box,
 * plus the app-wide hands-free mode (which keeps listening across screens).
 * `onText` is what a spoken question does here: start an exploration, ask a follow-up.
 */
export function useVoiceControls(onText: (text: string) => void) {
  const available = useVoiceAvailable();
  const voice = useVoiceQuestion(onText);
  const handsFree = useSharedHandsFree(onText);
  const recording = voice.state.status === 'recording';

  // Escape throws a push-to-talk recording away.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && voice.cancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [recording, voice]);

  return { available, voice, handsFree, recording };
}

type Controls = ReturnType<typeof useVoiceControls>;

/** The two voice buttons: push-to-talk (hidden while hands-free is on) and the hands-free toggle. */
export function VoiceButtons({ controls, size = 'sm' }: { controls: Controls; size?: 'sm' | 'md' | 'lg' }) {
  const { available, voice, handsFree, recording } = controls;
  if (!available) return null;
  return (
    <>
      {!handsFree.on && (
        <Button
          isIconOnly
          size={size}
          variant={recording ? 'primary' : 'ghost'}
          aria-label={recording ? 'Stop and ask' : 'Ask by voice'}
          isPending={voice.state.status === 'transcribing'}
          onPress={recording ? voice.stop : voice.start}
        >
          {recording ? <StopIcon /> : <MicIcon />}
        </Button>
      )}
      <Button
        isIconOnly
        size={size}
        variant={handsFree.on ? 'primary' : 'ghost'}
        aria-pressed={handsFree.on}
        aria-label="Hands-free: ask without pressing a button"
        isDisabled={recording}
        onPress={handsFree.toggle}
      >
        <WaveIcon />
      </Button>
    </>
  );
}

/** Status lines for whichever voice input is active. `rowClassName` styles each line for its container. */
export function VoiceStatusRows({ controls, rowClassName }: { controls: Controls; rowClassName: string }) {
  const { voice, handsFree } = controls;
  return (
    <>
      {voice.state.status !== 'idle' && (
        <VoiceStatus state={voice.state} onCancel={voice.cancel} onDismiss={voice.dismiss} className={rowClassName} />
      )}
      {handsFree.state.status !== 'off' && (
        <HandsFreeStatus
          state={handsFree.state}
          subscribeLevel={handsFree.subscribeLevel}
          onTurnOff={handsFree.toggle}
          onDismiss={handsFree.dismiss}
          className={rowClassName}
        />
      )}
    </>
  );
}

const link =
  'rounded font-medium text-accent underline underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-focus';

/** Push-to-talk: listening, transcribing, or why it couldn't. */
function VoiceStatus({
  state,
  onCancel,
  onDismiss,
  className,
}: {
  state: Exclude<VoiceQuestionState, { status: 'idle' }>;
  onCancel: () => void;
  onDismiss: () => void;
  className: string;
}) {
  return (
    <div aria-live="polite" className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-sm ${className}`}>
      {state.status === 'recording' && (
        <>
          <span className="inline-flex items-center gap-2">
            <span aria-hidden className="size-2.5 rounded-full bg-danger motion-safe:animate-pulse" />
            Listening
            <span className="tabular-nums text-muted">
              {Math.floor(state.seconds / 60)}:{String(state.seconds % 60).padStart(2, '0')}
            </span>
          </span>
          <span className="text-muted">Press stop when you’re done.</span>
          <button type="button" onClick={onCancel} className={link}>
            Cancel
          </button>
        </>
      )}
      {state.status === 'transcribing' && (
        <span className="inline-flex items-center gap-2 text-muted">
          <Spinner size="sm" aria-hidden />
          Transcribing your question…
        </span>
      )}
      {state.status === 'error' && (
        <>
          <span>{state.message}</span>
          <button type="button" onClick={onDismiss} className={link}>
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}

/** Hands-free: what it's doing, a live microphone meter, and a way to turn it off. */
function HandsFreeStatus({
  state,
  subscribeLevel,
  onTurnOff,
  onDismiss,
  className,
}: {
  state: Exclude<HandsFreeState, { status: 'off' }>;
  subscribeLevel: (fn: (level: number) => void) => () => void;
  onTurnOff: () => void;
  onDismiss: () => void;
  className: string;
}) {
  const message =
    state.status === 'starting'
      ? 'Starting the microphone…'
      : state.status === 'hearing'
        ? 'Hearing you…'
        : state.status === 'transcribing'
          ? 'Transcribing…'
          : state.status === 'listening'
            ? (state.note ?? 'Hands-free is on. Just ask; you can also talk over the reading to interrupt it.')
            : state.message;
  return (
    <div data-handsfree={state.status} className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-sm ${className}`}>
      {state.status !== 'error' && <LevelMeter subscribe={subscribeLevel} active={state.status === 'hearing'} />}
      <span aria-live="polite" className={state.status === 'listening' ? 'text-muted' : ''}>
        {state.status === 'transcribing' && <Spinner size="sm" aria-hidden className="mr-2 align-middle" />}
        {message}
      </span>
      {state.status === 'error' ? (
        <button type="button" onClick={onDismiss} className={link}>
          Dismiss
        </button>
      ) : (
        <button type="button" onClick={onTurnOff} className={link}>
          Turn off
        </button>
      )}
    </div>
  );
}

/** Five bars following the microphone level, updated outside React to stay cheap. */
function LevelMeter({ subscribe, active }: { subscribe: (fn: (level: number) => void) => () => void; active: boolean }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(
    () =>
      subscribe((level) => {
        const db = 20 * Math.log10(Math.max(level, 1e-4)); // about -80 (silence) to 0
        const fill = Math.max(0, Math.min(1, (db + 60) / 45));
        bars.current.forEach((bar, i) => {
          if (bar) bar.style.transform = `scaleY(${Math.max(0.2, Math.min(1, fill * (1 - Math.abs(i - 2) * 0.18)))})`;
        });
      }),
    [subscribe],
  );
  return (
    <span aria-hidden className="inline-flex h-4 items-center gap-0.5">
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          ref={(el) => void (bars.current[i] = el)}
          className={`block h-4 w-1 origin-center rounded-full ${active ? 'bg-accent' : 'bg-[var(--field-line)]'}`}
          style={{ transform: 'scaleY(0.2)' }}
        />
      ))}
    </span>
  );
}

function WaveIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M3 12h1M7 8v8M11 5v14M15 9v6M19 7v10M22 12h-1" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0014 0M12 18v3" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}
