import { defineCollection, z } from 'astro:content';

/**
 * Settings collection: admin-managed JSON files in src/content/settings/.
 *
 * Each file has a distinct schema (hero, hours, kids, etc.) so we use a
 * permissive base schema here — the real validation happens in src/lib/settings.ts
 * via per-type Zod schemas. The content collection gives us:
 *  - Build-time JSON parse error detection
 *  - Astro's getEntry() API with incremental build caching
 *  - Clear build errors when files are malformed
 */
const settings = defineCollection({
  type: 'data',
  schema: z.union([z.record(z.any()), z.array(z.any())]),
});

export const collections = { settings };
