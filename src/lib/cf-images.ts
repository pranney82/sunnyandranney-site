/**
 * Cloudflare Images upload helper.
 * Uploads images to CF Images for use as product photos.
 */
import { env } from 'cloudflare:workers';

export interface CFImageResult {
  id: string;
  url: string;
  variants: string[];
}

/** Upload a file buffer to CF Images */
export async function uploadToCFImages(
  fileBuffer: ArrayBuffer,
  filename: string,
): Promise<CFImageResult> {
  const accountId = env.CF_ACCOUNT_ID;
  const token = env.CF_IMAGES_TOKEN;
  if (!accountId || !token) {
    throw new Error('CF_ACCOUNT_ID or CF_IMAGES_TOKEN not configured');
  }

  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer]), filename);

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error('CF Images upload error:', response.status, errorText);
    throw new Error(`CF Images upload failed: ${response.status}`);
  }

  const result = await response.json() as {
    success: boolean;
    result: { id: string; variants: string[] };
    errors: Array<{ message: string }>;
  };

  if (!result.success) {
    throw new Error(`CF Images error: ${result.errors.map(e => e.message).join(', ')}`);
  }

  return {
    id: result.result.id,
    url: result.result.variants[0] || '',
    variants: result.result.variants,
  };
}

/** Upload an image from a URL to CF Images */
export async function uploadUrlToCFImages(
  imageUrl: string,
  filename: string,
): Promise<CFImageResult> {
  const accountId = env.CF_ACCOUNT_ID;
  const token = env.CF_IMAGES_TOKEN;
  if (!accountId || !token) {
    throw new Error('CF_ACCOUNT_ID or CF_IMAGES_TOKEN not configured');
  }

  const formData = new FormData();
  formData.append('url', imageUrl);

  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/images/v1`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error('CF Images URL upload error:', response.status, errorText);
    throw new Error(`CF Images URL upload failed: ${response.status}`);
  }

  const result = await response.json() as {
    success: boolean;
    result: { id: string; variants: string[] };
    errors: Array<{ message: string }>;
  };

  if (!result.success) {
    throw new Error(`CF Images error: ${result.errors.map(e => e.message).join(', ')}`);
  }

  return {
    id: result.result.id,
    url: result.result.variants[0] || '',
    variants: result.result.variants,
  };
}
