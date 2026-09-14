import fs from 'node:fs/promises';

export async function readManifest(manifestPath) {
  return JSON.parse(await fs.readFile(manifestPath, 'utf8'));
}
