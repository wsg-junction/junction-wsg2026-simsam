// Object storage for photos people search with: Verda's S3-compatible storage.
// Optional: without these variables the photo is still analysed, just not kept.
//   VERDA_S3_ENDPOINT, VERDA_S3_BUCKET, VERDA_S3_ACCESS_KEY_ID, VERDA_S3_SECRET_ACCESS_KEY
//   (VERDA_S3_REGION, default "us-east-1": S3 clients need one, Verda ignores it)
import { randomUUID } from 'node:crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const endpoint = process.env.VERDA_S3_ENDPOINT?.trim();
const bucket = process.env.VERDA_S3_BUCKET?.trim();
const accessKeyId = process.env.VERDA_S3_ACCESS_KEY_ID?.trim();
const secretAccessKey = process.env.VERDA_S3_SECRET_ACCESS_KEY?.trim();

export const storageEnabled = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);
/** For the logs. */
export const storageEndpoint = endpoint ? new URL(endpoint).host : 'off';

const client = storageEnabled
  ? new S3Client({
      endpoint,
      region: process.env.VERDA_S3_REGION?.trim() || 'us-east-1',
      credentials: { accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
      // Most S3-compatible stores want bucket-in-path addressing.
      forcePathStyle: true,
    })
  : null;

const EXTENSION: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * Keep a searched photo in the bucket under a random key (private; nothing is
 * served from it). Returns the key, or null when storage isn't configured.
 */
export async function storePhoto(bytes: Buffer, contentType: string, signal?: AbortSignal): Promise<string | null> {
  if (!client) return null;
  const day = new Date().toISOString().slice(0, 10);
  const key = `photo-searches/${day}/${randomUUID()}.${EXTENSION[contentType] ?? 'bin'}`;
  await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: contentType }), {
    abortSignal: signal,
  });
  return key;
}
