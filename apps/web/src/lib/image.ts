import type { ImageSearchResponse } from '@simsam/models';

/** The longest side sent to the server: plenty for the vision model, small to upload. */
const MAX_SIDE = 1280;
const THUMB_SIDE = 160;

export class PhotoError extends Error {}

function draw(bitmap: ImageBitmap, side: number) {
  const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new PhotoError('This browser can’t read the photo.');
  // JPEG has no transparency: PNGs with a clear background would turn black.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * A photo ready to send: re-encoded as a smaller JPEG with its orientation
 * applied. Re-encoding also drops EXIF data, such as where a phone photo was taken.
 * Also a small thumbnail (a data URL) for the chat.
 */
export async function preparePhoto(file: File): Promise<{ blob: Blob; thumbnail: string }> {
  if (!file.type.startsWith('image/')) throw new PhotoError('Pick an image file.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new PhotoError('This image couldn’t be opened. Try a JPEG or PNG.');
  }
  try {
    const blob = await new Promise<Blob | null>((resolve) => draw(bitmap, MAX_SIDE).toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new PhotoError('This image couldn’t be prepared.');
    return { blob, thumbnail: draw(bitmap, THUMB_SIDE).toDataURL('image/jpeg', 0.7) };
  } finally {
    bitmap.close();
  }
}

/** Upload the photo; the server stores it, has the AI read it, and returns a Wikipedia search for it. */
export async function searchByPhoto(blob: Blob, signal?: AbortSignal): Promise<ImageSearchResponse> {
  let res: Response;
  try {
    res = await fetch('/api/image-search', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob, signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new PhotoError('The photo didn’t reach the server. Check your connection.');
  }
  if (!res.ok) {
    const message = ((await res.json().catch(() => null)) as { error?: string } | null)?.error;
    throw new PhotoError(message ?? 'The photo couldn’t be read right now.');
  }
  return (await res.json()) as ImageSearchResponse;
}
