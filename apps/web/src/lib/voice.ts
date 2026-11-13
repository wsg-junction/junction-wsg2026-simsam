import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { serverFeatures } from './ai';
import { interruptPlayback, pacedNarrator, type Narrator } from './playback';

// ---------- Audio for a beat (via the API, which calls ElevenLabs) ----------

const MAX_CACHED = 120;
/** Object URLs of fetched audio by text, oldest first. */
const audioCache = new Map<string, Promise<string>>();

function loadAudio(text: string): Promise<string> {
  const hit = audioCache.get(text);
  if (hit) return hit;
  const pending = fetch('/api/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text.slice(0, 600) }),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`Speech failed with ${res.status}`);
    return URL.createObjectURL(await res.blob());
  });
  audioCache.set(text, pending);
  pending.catch(() => audioCache.delete(text));
  while (audioCache.size > MAX_CACHED) {
    const [oldest, url] = audioCache.entries().next().value!;
    audioCache.delete(oldest);
    void url.then(URL.revokeObjectURL, () => {});
  }
  return pending;
}

const aborted = () => new DOMException('Aborted', 'AbortError');

// ---------- What the app itself is saying (so hands-free listening can ignore it) ----------

let context: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let speaking = false;
const levelBuffer = new Float32Array(1024);

/** One AudioContext for the app: reading aloud and the hands-free microphone share it. */
export function sharedAudioContext() {
  context ??= new AudioContext();
  return context;
}

/** Whether the app is reading aloud right now. */
export const isSpeaking = () => speaking;

/**
 * How loud the app's own voice is right now (RMS, 0 to 1), or null if it is
 * speaking but its level can't be measured (audio context not running yet).
 */
export function playbackLevel(): number | null {
  if (!speaking) return 0;
  if (!analyser || context?.state !== 'running') return null;
  analyser.getFloatTimeDomainData(levelBuffer);
  let sum = 0;
  for (const v of levelBuffer) sum += v * v;
  return Math.sqrt(sum / levelBuffer.length);
}

function play(url: string, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const audio = new Audio(url);
    // Route through an analyser when we can, so the listener knows our own level.
    // A suspended context would play silence, so then the audio plays directly.
    let source: MediaElementAudioSourceNode | null = null;
    const ctx = context;
    if (ctx?.state === 'running') {
      if (!analyser) {
        analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        analyser.connect(ctx.destination);
      }
      source = ctx.createMediaElementSource(audio);
      source.connect(analyser);
    }
    speaking = true;
    const stop = () => {
      audio.pause();
      speaking = false;
      source?.disconnect();
      reject(aborted());
    };
    const done = (fn: () => void) => () => {
      signal.removeEventListener('abort', stop);
      speaking = false;
      source?.disconnect();
      fn();
    };
    signal.addEventListener('abort', stop, { once: true });
    audio.addEventListener('ended', done(resolve), { once: true });
    audio.addEventListener('error', done(() => reject(new Error('Audio could not play'))), { once: true });
    audio.play().catch(done(() => reject(new Error('Playback was blocked'))));
  });
}

/**
 * Reads each beat aloud with ElevenLabs. If speech fails (no credits, offline,
 * autoplay blocked) that beat falls back to silent pacing so playback carries on.
 */
export const voiceNarrator: Narrator = {
  prepare(text) {
    loadAudio(text).catch(() => {});
  },
  async narrate(text, signal) {
    if (signal.aborted) throw aborted();
    try {
      const url = await loadAudio(text);
      if (signal.aborted) throw aborted();
      await play(url, signal);
    } catch (err) {
      if (signal.aborted) throw aborted();
      console.warn('Reading aloud failed; continuing silently.', err);
      await pacedNarrator.narrate(text, signal);
      return;
    }
    // A short breath between beats.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 300);
      signal.addEventListener('abort', () => (clearTimeout(t), reject(aborted())), { once: true });
    });
  },
};

// ---------- "Read aloud" preference, shared by every page ----------

const KEY = 'atlas-voice';
const listeners = new Set<() => void>();

function readPreference() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

let voiceOn = readPreference();

export function setVoiceOn(on: boolean) {
  voiceOn = on;
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* the choice just won't persist */
  }
  listeners.forEach((l) => l());
}

/** Whether the reader wants briefs read aloud (on by default). */
export function useVoicePreference() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => voiceOn,
  );
}

/** Whether the server can read aloud (an ElevenLabs key is configured). */
export function useVoiceAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    let live = true;
    serverFeatures().then((h) => live && setAvailable(h?.voice === true));
    return () => {
      live = false;
    };
  }, []);
  return available;
}

// ---------- Asking by voice (ElevenLabs speech to text, via the API) ----------

const MAX_RECORDING_MS = 60_000;

async function transcribeRecording(blob: Blob): Promise<string> {
  const res = await fetch('/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'audio/webm' },
    body: blob,
  });
  if (!res.ok) throw new Error(`Transcription failed with ${res.status}`);
  return ((await res.json()) as { text: string }).text.trim();
}

export type VoiceQuestionState =
  | { status: 'idle' }
  | { status: 'recording'; seconds: number }
  | { status: 'transcribing' }
  | { status: 'error'; message: string };

/**
 * Record a spoken question, transcribe it, and hand the text to `onText`.
 * `start` pauses anything being read aloud first so the microphone doesn't hear it.
 */
export function useVoiceQuestion(onText: (text: string) => void) {
  const [state, setState] = useState<VoiceQuestionState>({ status: 'idle' });
  const recorder = useRef<MediaRecorder | null>(null);
  const cancelled = useRef(false);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;

  // Release the microphone if the view goes away mid-recording.
  useEffect(
    () => () => {
      cancelled.current = true;
      if (recorder.current?.state === 'recording') recorder.current.stop();
    },
    [],
  );

  // Tick the elapsed time, and stop at the limit.
  const recording = state.status === 'recording';
  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const tick = setInterval(() => {
      const elapsed = Date.now() - started;
      if (elapsed >= MAX_RECORDING_MS) recorder.current?.stop();
      else setState({ status: 'recording', seconds: Math.floor(elapsed / 1000) });
    }, 250);
    return () => clearInterval(tick);
  }, [recording]);

  async function start() {
    interruptPlayback();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setState({ status: 'error', message: 'This browser can’t record audio. Type your question instead.' });
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const blocked = err instanceof DOMException && err.name === 'NotAllowedError';
      setState({
        status: 'error',
        message: blocked
          ? 'Microphone access is blocked. Allow it for this site to ask by voice.'
          : 'No microphone was found. Type your question instead.',
      });
      return;
    }

    const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) =>
      MediaRecorder.isTypeSupported(t),
    );
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    cancelled.current = false;
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      recorder.current = null;
      if (cancelled.current) {
        setState({ status: 'idle' });
        return;
      }
      const blob = new Blob(chunks, { type: rec.mimeType || mimeType || 'audio/webm' });
      setState({ status: 'transcribing' });
      try {
        const text = blob.size > 0 ? await transcribeRecording(blob) : '';
        if (!text) {
          setState({ status: 'error', message: 'Didn’t catch a question there. Try again, a little closer to the mic.' });
          return;
        }
        setState({ status: 'idle' });
        onTextRef.current(text);
      } catch {
        setState({ status: 'error', message: 'The recording couldn’t be transcribed. Try again or type your question.' });
      }
    };
    recorder.current = rec;
    rec.start();
    setState({ status: 'recording', seconds: 0 });
  }

  return {
    state,
    start,
    /** Stop recording and ask what was said. */
    stop: () => recorder.current?.stop(),
    /** Stop recording and throw it away. */
    cancel: () => {
      cancelled.current = true;
      recorder.current?.stop();
    },
    dismiss: () => setState({ status: 'idle' }),
  };
}
