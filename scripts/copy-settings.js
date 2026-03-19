/**
 * Post-build: copy committed settings JSON to dist/_settings/
 * so runtime sync endpoints can self-fetch them to seed D1.
 */
import { cpSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

const SRC = 'src/content/settings';
const DEST = 'dist/_settings';
const EXPOSE = ['specials', 'contact', 'email-signup'];

mkdirSync(DEST, { recursive: true });

for (const name of EXPOSE) {
  const src = join(SRC, `${name}.json`);
  const dest = join(DEST, `${name}.json`);
  try {
    cpSync(src, dest);
    console.log(`[copy-settings] ${name}.json → _settings/`);
  } catch {
    console.warn(`[copy-settings] ${name}.json not found, skipping`);
  }
}
