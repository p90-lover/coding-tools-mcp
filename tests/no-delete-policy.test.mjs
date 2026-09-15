import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const files = [
  '.github/workflows/electron-full-harness-release.yml',
  'scripts/release/verify-source-scope.mjs',
  'scripts/release/verify-assets.mjs',
  'scripts/release/publish-v0.6.0-rc.1.mjs',
  'scripts/release/verify-source-scope-v0.6.0.mjs',
  'scripts/release/verify-assets-v0.6.0.mjs',
  'scripts/release/publish-v0.6.0.mjs',
];

const forbidden = [
  /git\s+push\s+--force/i,
  /git\s+reset\s+--hard/i,
  /git\s+tag\s+-d/i,
  /rm\s+-rf/i,
  /Remove-Item\s+[^\n]*-Recurse[^\n]*-Force/i,
  /fs\.(?:rm|rmSync|unlink|unlinkSync)\s*\(/,
  /method\s*:\s*['"]DELETE['"]/,
  /--method\s+DELETE/i,
];

test('Electron prerelease files contain no destructive operation', async () => {
  const combined = (await Promise.all(files.map(async (file) => {
    const source = await fs.readFile(path.join(root, file), 'utf8');
    return `\n// ${file}\n${source}`;
  }))).join('\n');

  for (const pattern of forbidden) {
    assert.doesNotMatch(combined, pattern);
  }
});
