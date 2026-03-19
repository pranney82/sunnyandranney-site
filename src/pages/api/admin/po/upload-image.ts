import type { APIRoute } from 'astro';
import { uploadToCFImages } from '@/lib/cf-images';

export const prerender = false;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5 MB

export const POST: APIRoute = async ({ request }) => {
  try {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.includes('multipart/form-data')) {
      return new Response(
        JSON.stringify({ error: 'Expected multipart/form-data' }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    const formData = await request.formData();
    const file = formData.get('image') as File | null;

    if (!file || !file.name) {
      return new Response(
        JSON.stringify({ error: 'No image file provided' }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    if (file.size > MAX_IMAGE_SIZE) {
      return new Response(
        JSON.stringify({ error: 'Image too large (max 5 MB)' }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    const buffer = await file.arrayBuffer();
    const result = await uploadToCFImages(buffer, file.name);

    return new Response(
      JSON.stringify({ url: result.url, id: result.id }),
      { headers: JSON_HEADERS },
    );
  } catch (err: any) {
    console.error('Image upload error:', err?.message);
    return new Response(
      JSON.stringify({ error: err?.message || 'Failed to upload image' }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
};
