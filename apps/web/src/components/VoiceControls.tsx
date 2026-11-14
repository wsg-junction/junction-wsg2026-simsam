import { useEffect, useRef, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import {
  setVoiceThreshold,
  THRESHOLD_RANGE,
  useSharedHandsFree,
  useVoiceThreshold,
  type HandsFreeState,
} from '../lib/handsfree';
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
          onCalibrate={handsFree.calibrate}
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

/** Hands-free: what it's doing, the live level against the threshold, and controls. */
function HandsFreeStatus({
  state,
  subscribeLevel,
  onTurnOff,
  onDismiss,
  onCalibrate,
  className,
}: {
  state: Exclude<HandsFreeState, { status: 'off' }>;
  subscribeLevel: (fn: (level: number) => void) => () => void;
  onTurnOff: () => void;
  onDismiss: () => void;
  onCalibrate: () => void;
  className: string;
}) {
  const [adjusting, setAdjusting] = useState(false);
  const threshold = useVoiceThreshold();
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
    <div data-handsfree={state.status} className={`flex flex-col gap-3 text-sm ${className}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {state.status !== 'error' && (
          <LevelMeter subscribe={subscribeLevel} threshold={threshold} active={state.status === 'hearing'} />
        )}
        <span aria-live="polite" className={state.status === 'listening' ? 'text-muted' : ''}>
          {state.status === 'transcribing' && <Spinner size="sm" aria-hidden className="mr-2 align-middle" />}
          {message}
        </span>
        {state.status === 'error' ? (
          <button type="button" onClick={onDismiss} className={link}>
            Dismiss
          </button>
        ) : (
          <>
            <button
              type="button"
              aria-expanded={adjusting}
              aria-controls="voice-threshold"
              onClick={() => setAdjusting((a) => !a)}
              className={link}
            >
              {adjusting ? 'Done' : 'Adjust'}
            </button>
            <button type="button" onClick={onTurnOff} className={link}>
              Turn off
            </button>
          </>
        )}
      </div>

      {adjusting && state.status !== 'error' && (
        <div id="voice-threshold" className="flex flex-col gap-2">
          <label htmlFor="voice-threshold-range" className="font-medium">
            Only listen to voices louder than the marker
          </label>
          <div className="flex items-center gap-3">
            <span className="text-xs text-muted">Quiet</span>
            <input
              id="voice-threshold-range"
              type="range"
              min={THRESHOLD_RANGE.min}
              max={THRESHOLD_RANGE.max}
              step={1}
              value={threshold}
              onChange={(e) => setVoiceThreshold(Number(e.target.value))}
              aria-valuetext={`${threshold} decibels`}
              className="w-48 accent-[var(--accent)]"
            />
            <span className="text-xs text-muted">Loud</span>
            <span className="w-14 text-right text-xs tabular-nums text-muted">{threshold} dB</span>
          </div>
          <p className="text-muted">
            Speak normally and watch the bar: it should cross the marker when you talk and stay below it when
            you don’t.{' '}
            <button type="button" onClick={onCalibrate} className={link}>
              Set from room noise
            </button>
          </p>
        </div>
      )}
    </div>
  );
}

/** The microphone level as a bar, with the threshold marked; updated outside React to stay cheap. */
function LevelMeter({
  subscribe,
  threshold,
  active,
}: {
  subscribe: (fn: (level: number) => void) => () => void;
  threshold: number;
  active: boolean;
}) {
  const fill = useRef<HTMLSpanElement>(null);
  const thresholdRef = useRef(threshold);
  thresholdRef.current = threshold;
  useEffect(
    () =>
      subscribe((level) => {
        const db = 20 * Math.log10(Math.max(level, 1e-5));
        const el = fill.current;
        if (!el) return;
        el.style.transform = `scaleX(${meterPosition(db)})`;
        el.dataset.loud = db >= thresholdRef.current ? 'true' : 'false';
      }),
    [subscribe],
  );
  return (
    <span aria-hidden className="relative inline-block h-2 w-28 overflow-hidden rounded-full bg-[var(--field-line)]/40">
      <span
        ref={fill}
        data-loud="false"
        className={`absolute inset-y-0 left-0 w-full origin-left rounded-full bg-[var(--field-line)] data-[loud=true]:bg-accent ${
          active ? 'bg-accent' : ''
        }`}
        style={{ transform: 'scaleX(0)' }}
      />
      <span
        className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-foreground"
        style={{ left: `${meterPosition(threshold) * 100}%` }}
      />
    </span>
  );
}

/** Where a level sits on the meter: -70 dBFS (silence) at the left, -10 dBFS at the right. */
const meterPosition = (db: number) => Math.max(0, Math.min(1, (db + 70) / 60));

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
