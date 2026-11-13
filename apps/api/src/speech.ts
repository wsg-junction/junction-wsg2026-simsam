// Text to speech through ElevenLabs. The key stays on the server; the browser
// sends short beats of text and gets MP3 back.

const apiKey = process.env.ELEVENLABS_API_KEY;
// "George", one of ElevenLabs' default voices. Any voice ID from your account works.
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
// Flash is ElevenLabs' low-latency model, which suits reading beats one by one.
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5';

export const speechEnabled = Boolean(apiKey);

/** Most recent audio by text, so replays don't spend credits again. */
const cache = new Map<string, Buffer>();
const CACHE_BYTES = 64 * 1024 * 1024;
let cachedBytes = 0;

function remember(text: string, audio: Buffer) {
  cache.set(text, audio);
  cachedBytes += audio.length;
  for (const [key, value] of cache) {
    if (cachedBytes <= CACHE_BYTES) break;
    cache.delete(key);
    cachedBytes -= value.length;
  }
}

export class SpeechError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function synthesize(text: string, signal?: AbortSignal): Promise<Buffer> {
  if (!apiKey) throw new SpeechError('Text to speech is not configured', 503);

  const hit = cache.get(text);
  if (hit) {
    // Refresh its place so the most used audio stays cached.
    cache.delete(text);
    cache.set(text, hit);
    return hit;
  }

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(VOICE_ID)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: MODEL_ID }),
      signal,
    },
  );
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new SpeechError(`ElevenLabs responded with ${res.status}: ${detail}`, res.status === 429 ? 429 : 502);
  }
  const audio = Buffer.from(await res.arrayBuffer());
  remember(text, audio);
  return audio;
}

// ---------- Speech to text (ElevenLabs Scribe) ----------

const STT_MODEL_ID = process.env.ELEVENLABS_STT_MODEL_ID || 'scribe_v2';

/** Transcribe a short recording (a spoken follow-up question). */
export async function transcribe(audio: Buffer, contentType: string, signal?: AbortSignal): Promise<string> {
  if (!apiKey) throw new SpeechError('Speech to text is not configured', 503);

  const form = new FormData();
  form.append('model_id', STT_MODEL_ID);
  form.append('tag_audio_events', 'false');
  // Push-to-talk records webm/ogg/mp4, hands-free sends WAV. The extension is
  // only a hint; ElevenLabs detects the format.
  const ext = ['wav', 'mp4', 'ogg'].find((e) => contentType.includes(e)) ?? 'webm';
  form.append('file', new Blob([new Uint8Array(audio)], { type: contentType }), `question.${ext}`);

  const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    body: form,
    signal,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new SpeechError(`ElevenLabs responded with ${res.status}: ${detail}`, res.status === 429 ? 429 : 502);
  }
  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
}
