import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { interruptPlayback, resumePlayback } from './playback';
import { isSpeaking, playbackLevel, sharedAudioContext } from './voice';

/*
 * Hands-free listening: no button, no wake word. The microphone stays open and
 * a voice activity detector (VAD) decides when someone is talking.
 *
 * Not hearing itself is the hard part. Three layers keep the app's own voice
 * from counting as speech:
 *   1. The browser's echo cancellation removes most of what we play from the
 *      microphone signal.
 *   2. We know how loud our own voice is at every moment (playbackLevel) and
 *      learn how much of it still leaks into the microphone. While we speak,
 *      the bar for "someone is talking" rises above that expected echo.
 *   3. Interrupting while we speak needs ~300 ms of sustained speech (vs. ~80
 *      ms when quiet), so an echo spike can't trip it.
 *
 * Audio is kept in a short ring buffer, so the first syllables before the
 * detector fires aren't lost. Each utterance is sent as 16 kHz mono WAV.
 */

const FRAME_MS = 20;
const OUT_RATE = 16_000;
const PREROLL_FRAMES = 25; // 500 ms kept from before speech was detected
const ONSET_QUIET = 8; // 160 ms of voice (within 320 ms) to start an utterance while we're quiet
const ONSET_SPEAKING = 15; // 300 ms of voice (within 600 ms) to interrupt us while we're reading aloud
const HANGOVER = 45; // 900 ms of silence ends an utterance
const MIN_SPEECH = 20; // utterances with less than 400 ms of speech are ignored
const MAX_UTTERANCE = 1500; // 30 s
const MIN_RMS = 0.012;
/** Share of a frame's energy that must sit in the speech band for it to count as voice. */
const MIN_VOICE_SHARE = 0.7;
/** Once someone is talking, their trailing syllables may fall this far below the threshold. */
const TRAIL_DB = 8;

const toDb = (rms: number) => 20 * Math.log10(Math.max(rms, 1e-5));

// ---------- The reader's threshold: only voices louder than this count ----------

export const THRESHOLD_RANGE = { min: -60, max: -15 } as const; // dBFS
const THRESHOLD_KEY = 'atlas-voice-threshold';
const thresholdListeners = new Set<() => void>();

function readThreshold() {
  try {
    const stored = Number(localStorage.getItem(THRESHOLD_KEY));
    if (stored >= THRESHOLD_RANGE.min && stored <= THRESHOLD_RANGE.max) return stored;
  } catch {
    /* fall through to the default */
  }
  return -38;
}

let thresholdDb = readThreshold();

export function setVoiceThreshold(db: number) {
  thresholdDb = Math.round(Math.min(THRESHOLD_RANGE.max, Math.max(THRESHOLD_RANGE.min, db)));
  try {
    localStorage.setItem(THRESHOLD_KEY, String(thresholdDb));
  } catch {
    /* the setting just won't persist */
  }
  thresholdListeners.forEach((l) => l());
}

/** The current voice threshold in dBFS, kept in sync across the app. */
export function useVoiceThreshold() {
  return useSyncExternalStore(
    (l) => {
      thresholdListeners.add(l);
      return () => thresholdListeners.delete(l);
    },
    () => thresholdDb,
  );
}

// Collects 20 ms frames on the audio thread and posts them to the page.
const WORKLET = `
class AtlasTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.round(sampleRate * ${FRAME_MS / 1000});
    this.buf = new Float32Array(this.size);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.size) {
          this.port.postMessage(this.buf.slice(0));
          this.n = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('atlas-tap', AtlasTap);
`;

let workletLoaded: Promise<void> | null = null;

function rms(frame: Float32Array) {
  let sum = 0;
  for (const v of frame) sum += v * v;
  return Math.sqrt(sum / frame.length);
}

/** Average down to 16 kHz (speech needs nothing higher). */
function downsample(frame: Float32Array, rate: number) {
  const ratio = rate / OUT_RATE;
  const out = new Float32Array(Math.floor(frame.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(frame.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += frame[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

function encodeWav(frames: Float32Array[]) {
  const length = frames.reduce((n, f) => n + f.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, OUT_RATE, true);
  view.setUint32(28, OUT_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, length * 2, true);
  let offset = 44;
  for (const frame of frames) {
    for (const v of frame) {
      const s = Math.max(-1, Math.min(1, v));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export type ListenerPhase = 'starting' | 'listening' | 'hearing';

interface ListenerEvents {
  onPhase: (phase: ListenerPhase) => void;
  /** Microphone level, 0 to 1, about 50 times a second (for a meter). */
  onLevel: (level: number) => void;
  /** A finished utterance; `interrupted` says whether it cut off our reading. */
  onUtterance: (audio: Blob, interrupted: boolean) => void;
}

class HandsFreeListener {
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private spectrum: Float32Array<ArrayBuffer> | null = null;

  private noise = MIN_RMS / 2;
  private echoRatio = 0.3;
  private state: 'quiet' | 'speech' = 'quiet';
  private above = 0;
  private silence = 0;
  private speechFrames = 0;
  private interrupted = false;
  /** Frames in a row with nothing voice-like. */
  private quietRun = 0;
  /** Whether each recent frame was voice, for the onset window. */
  private recent: boolean[] = [];
  private preroll: Float32Array[] = [];
  private utterance: Float32Array[] = [];

  constructor(private events: ListenerEvents) {}

  async start() {
    this.events.onPhase('starting');
    const ctx = sharedAudioContext();
    await ctx.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({
      // No automatic gain: it turns background noise up whenever the room is
      // quiet, which would make any fixed threshold meaningless.
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 },
    });
    workletLoaded ??= ctx.audioWorklet.addModule(
      URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })),
    );
    await workletLoaded;
    this.source = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'atlas-tap', { numberOfOutputs: 1 });
    // Kept connected (silently) so the browser keeps pulling audio through it.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.source.connect(this.node).connect(this.sink).connect(ctx.destination);
    // A spectrum of the microphone, to tell voice from hum and hiss.
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    this.spectrum = new Float32Array(this.analyser.frequencyBinCount);
    this.source.connect(this.analyser);
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => this.frame(e.data, ctx.sampleRate);
    this.events.onPhase('listening');
  }

  /** The background level the listener has learned, in dBFS. */
  get noiseDb() {
    return toDb(this.noise);
  }

  /**
   * Share of the current energy in the speech band (100 Hz to 4 kHz). Voices
   * sit almost entirely inside it; mains hum, rumble and hiss mostly don't.
   */
  private voiceShare(rate: number) {
    if (!this.analyser || !this.spectrum) return 1;
    this.analyser.getFloatFrequencyData(this.spectrum);
    const binHz = rate / this.analyser.fftSize;
    let voice = 0;
    let total = 0;
    for (let i = 1; i < this.spectrum.length; i++) {
      const hz = i * binHz;
      if (hz < 20 || hz > 8000) continue;
      const power = 10 ** (this.spectrum[i] / 10);
      total += power;
      if (hz >= 100 && hz <= 4000) voice += power;
    }
    return total > 0 ? voice / total : 0;
  }

  stop() {
    this.analyser?.disconnect();
    this.node?.port.close();
    this.source?.disconnect();
    this.node?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private frame(raw: Float32Array, rate: number) {
    const level = rms(raw);
    this.events.onLevel(level);
    const pcm = downsample(raw, rate);

    // How loud must the mic be to count as someone talking right now?
    const speaking = isSpeaking();
    const own = playbackLevel();
    let threshold = Math.max(MIN_RMS, this.noise * 3.2);
    if (speaking) {
      const expectedEcho = own === null ? 0.08 : own * this.echoRatio;
      threshold = Math.max(threshold, expectedEcho * 2.2);
    }

    if (this.state === 'quiet') {
      this.preroll.push(pcm);
      if (this.preroll.length > PREROLL_FRAMES) this.preroll.shift();

      // A frame counts as someone talking only if it's louder than the reader's
      // threshold, clearly above the room (and our own echo), and voice-like.
      const isVoice = level > threshold && toDb(level) >= thresholdDb && this.voiceShare(rate) >= MIN_VOICE_SHARE;

      // Speech dips between syllables, so look at a window rather than a strict
      // run: speech has started once voice fills half of it. Clicks and knocks
      // are far too short to fill it.
      this.recent.push(isVoice);
      if (this.recent.length > ONSET_SPEAKING * 2) this.recent.shift();
      const onset = speaking ? ONSET_SPEAKING : ONSET_QUIET;
      this.above = this.recent.slice(-onset * 2).filter(Boolean).length;

      if (isVoice) {
        this.quietRun = 0;
      } else {
        this.quietRun++;
        // Learn the room and our echo only from stretches with nothing voice-like
        // for 200 ms: the gaps between someone's syllables must not count, or a
        // person starting to talk would raise the bar against themselves.
        if (this.quietRun >= 10) {
          if (speaking && own) {
            // How much of our own voice leaks into the mic: rise gradually
            // towards louder leaks, relax within about half a second when less leaks.
            const leak = Math.min(level / Math.max(own, 1e-4), 1.5);
            this.echoRatio =
              leak > this.echoRatio ? this.echoRatio + (leak - this.echoRatio) * 0.05 : Math.max(leak, this.echoRatio * 0.97);
          } else if (!speaking) {
            this.noise = this.noise * 0.97 + level * 0.03;
          }
        }
      }

      if (this.above >= onset) {
        this.state = 'speech';
        // Barge-in: stop reading the moment someone talks over us.
        this.interrupted = interruptPlayback();
        this.utterance = [...this.preroll];
        this.speechFrames = this.above;
        this.silence = 0;
        this.above = 0;
        this.recent = [];
        this.preroll = [];
        this.events.onPhase('hearing');
      }
      return;
    }

    this.utterance.push(pcm);
    // While someone is talking, softer trailing syllables still count.
    if (level > threshold && toDb(level) >= thresholdDb - TRAIL_DB) {
      this.speechFrames++;
      this.silence = 0;
    } else {
      this.silence++;
    }
    if (this.silence >= HANGOVER || this.utterance.length >= MAX_UTTERANCE) {
      const enough = this.speechFrames >= MIN_SPEECH;
      const audio = enough ? encodeWav(this.utterance) : null;
      const interrupted = this.interrupted;
      this.state = 'quiet';
      this.utterance = [];
      this.interrupted = false;
      this.events.onPhase('listening');
      if (audio) this.events.onUtterance(audio, interrupted);
      else if (interrupted) resumePlayback(); // just a cough or a bump: carry on reading
    }
  }
}

async function transcribeWav(audio: Blob): Promise<string> {
  const res = await fetch('/api/transcribe', { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: audio });
  if (!res.ok) throw new Error(`Transcription failed with ${res.status}`);
  return ((await res.json()) as { text: string }).text.trim();
}

// Spoken commands for the reading itself, rather than questions.
const STOP = /^(stop|pause|wait|hold on|be quiet|quiet|shh+|enough|that's enough)[.!]*$/i;
const RESUME = /^(continue|go on|resume|keep going|carry on|play)[.!]*$/i;

export type HandsFreeState =
  | { status: 'off' }
  | { status: 'starting' }
  | { status: 'listening'; note?: string }
  | { status: 'hearing' }
  | { status: 'transcribing' }
  | { status: 'error'; message: string };

/**
 * Hands-free mode: listens continuously and asks whatever is said. "Stop" and
 * "continue" control the reading instead; noises and filler are ignored.
 */
export function useHandsFree(onAsk: (text: string) => void) {
  const [state, setState] = useState<HandsFreeState>({ status: 'off' });
  const listener = useRef<HandsFreeListener | null>(null);
  const meters = useRef(new Set<(level: number) => void>());
  const pending = useRef(0);
  const onAskRef = useRef(onAsk);
  onAskRef.current = onAsk;

  useEffect(() => () => listener.current?.stop(), []);

  async function handle(audio: Blob, interrupted: boolean) {
    pending.current++;
    setState({ status: 'transcribing' });
    let note: string | undefined;
    try {
      const text = await transcribeWav(audio);
      const words = text.split(/\s+/).filter(Boolean);
      if (STOP.test(text)) {
        note = 'Paused. Say “continue” to keep listening.';
      } else if (RESUME.test(text)) {
        resumePlayback();
      } else if (words.length < 2 && !text.includes('?')) {
        // "Hmm.", "Okay." or a noise transcribed as a word: not a question.
        if (interrupted) resumePlayback();
      } else {
        onAskRef.current(text);
        note = `Asked: “${text}”`;
      }
    } catch {
      if (interrupted) resumePlayback();
      note = 'That couldn’t be transcribed. Try again.';
    } finally {
      pending.current--;
      if (listener.current) setState(pending.current > 0 ? { status: 'transcribing' } : { status: 'listening', note });
    }
  }

  async function enable() {
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
      setState({ status: 'error', message: 'This browser can’t listen hands-free. Use the microphone button instead.' });
      return;
    }
    const l = new HandsFreeListener({
      onPhase: (phase) => {
        if (pending.current > 0 && phase === 'listening') return;
        setState(phase === 'hearing' ? { status: 'hearing' } : { status: phase });
      },
      onLevel: (level) => meters.current.forEach((m) => m(level)),
      onUtterance: (audio, interrupted) => void handle(audio, interrupted),
    });
    listener.current = l;
    try {
      await l.start();
    } catch (err) {
      l.stop();
      listener.current = null;
      const blocked = err instanceof DOMException && err.name === 'NotAllowedError';
      setState({
        status: 'error',
        message: blocked
          ? 'Microphone access is blocked. Allow it for this site to use hands-free mode.'
          : 'The microphone couldn’t be started. Try the microphone button instead.',
      });
    }
  }

  /** Put the threshold a comfortable margin above the room's background level. */
  function calibrate() {
    const noise = listener.current?.noiseDb;
    if (noise !== undefined) setVoiceThreshold(noise + 14);
  }

  function disable() {
    listener.current?.stop();
    listener.current = null;
    setState({ status: 'off' });
  }

  return {
    state,
    on: state.status !== 'off' && state.status !== 'error',
    toggle: () => (listener.current ? disable() : void enable()),
    dismiss: () => setState({ status: 'off' }),
    calibrate,
    /** Subscribe to the microphone level (for a meter that updates without re-rendering). */
    subscribeLevel: (fn: (level: number) => void) => {
      meters.current.add(fn);
      return () => {
        meters.current.delete(fn);
      };
    },
  };
}

// ---------- One hands-free listener for the whole app ----------

type HandsFree = ReturnType<typeof useHandsFree>;

const HandsFreeContext = createContext<{
  handsFree: HandsFree;
  target: MutableRefObject<((text: string) => void) | null>;
} | null>(null);

/**
 * Keeps hands-free listening across screens (the opening question leads
 * straight into the exploration without the microphone closing).
 */
export function HandsFreeProvider({ children }: { children: ReactNode }) {
  const target = useRef<((text: string) => void) | null>(null);
  const handsFree = useHandsFree((text) => target.current?.(text));
  return createElement(HandsFreeContext.Provider, { value: { handsFree, target } }, children);
}

/** The shared hands-free mode; whichever screen is showing decides what a spoken question does. */
export function useSharedHandsFree(onText: (text: string) => void): HandsFree {
  const ctx = useContext(HandsFreeContext);
  if (!ctx) throw new Error('useSharedHandsFree needs a HandsFreeProvider');
  const handler = useRef(onText);
  handler.current = onText;
  const { target } = ctx;
  useEffect(() => {
    const fn = (text: string) => handler.current(text);
    target.current = fn;
    return () => {
      if (target.current === fn) target.current = null;
    };
  }, [target]);
  return ctx.handsFree;
}
