/**
 * Cloudflare R2 Storage Integration
 * Provides permanent image storage for mosaic tiles.
 * All new imports are uploaded to R2 and the public URL is stored in the DB.
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID ?? "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID ?? "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME ?? "mosaicprint-tiles";
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL ?? "").replace(/\/$/, "");

let _s3: S3Client | null = null;

function getS3(): S3Client | null {
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) return null;
  if (!_s3) {
    _s3 = new S3Client({
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
      region: "auto",
    });
  }
  return _s3;
}

export function isR2Configured(): boolean {
  return !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_PUBLIC_URL);
}

/**
 * Upload a tile image to R2 and return the permanent public URL.
 * Key format: tiles/{id}.jpg
 * Returns null if R2 is not configured or upload fails.
 */
export async function uploadTileToR2(
  tileId: number,
  imageBuffer: Buffer,
  contentType = "image/jpeg"
): Promise<string | null> {
  const s3 = getS3();
  if (!s3 || !R2_PUBLIC_URL) return null;

  const key = `tiles/${tileId}.jpg`;

  try {
    await s3.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: imageBuffer,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable", // 1 year cache
    }));
    return `${R2_PUBLIC_URL}/${key}`;
  } catch (err) {
    console.error(`[R2] Upload failed for tile ${tileId}:`, err);
    return null;
  }
}

/**
 * Check if a tile already exists in R2.
 */
export async function tileExistsInR2(tileId: number): Promise<boolean> {
  const s3 = getS3();
  if (!s3) return false;

  const key = `tiles/${tileId}.jpg`;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the R2 public URL for a tile (without checking if it exists).
 */
export function getTileR2Url(tileId: number): string | null {
  if (!R2_PUBLIC_URL) return null;
  return `${R2_PUBLIC_URL}/tiles/${tileId}.jpg`;
}

/**
 * Download an image from a URL and upload it to R2.
 * Returns the permanent R2 URL or null on failure.
 */
export async function downloadAndUploadToR2(
  tileId: number,
  sourceUrl: string,
  resizeBuffer?: Buffer // pre-resized 128px buffer
): Promise<string | null> {
  if (!isR2Configured()) return null;

  try {
    let imgBuffer: Buffer;

    if (resizeBuffer) {
      imgBuffer = resizeBuffer;
    } else {
      // Download from source URL
      const resp = await fetch(sourceUrl, {
        headers: { "User-Agent": "MosaicPrint/1.0" },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) return null;
      imgBuffer = Buffer.from(await resp.arrayBuffer());
    }

    return await uploadTileToR2(tileId, imgBuffer);
  } catch (err) {
    console.error(`[R2] downloadAndUpload failed for tile ${tileId}:`, err);
    return null;
  }
}
