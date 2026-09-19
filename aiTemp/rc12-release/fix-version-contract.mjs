import fs from 'node:fs';

function replaceExactlyOnce(file, from, to) {
  const source = fs.readFileSync(file, 'utf8');
  if (source.includes(to) && !source.includes(from)) {
    process.stdout.write(`already patched: ${file}\n`);
    return false;
  }
  const count = source.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`RC12_PATCH_ANCHOR_COUNT:${file}:${count}:${from}`);
  }
  fs.writeFileSync(file, source.replace(from, to), 'utf8');
  process.stdout.write(`patched: ${file}\n`);
  return true;
}

replaceExactlyOnce(
  'desktop-electron/tests/bundled-five-stack-runtime.test.cjs',
  'assert.equal(manifest.productVersion, "0.7.0-rc.11");',
  'assert.equal(manifest.productVersion, "0.7.0-rc.12");',
);

replaceExactlyOnce(
  'aiTemp/rc12-release/run-windows-release.mjs',
  "focused Provider Center, Paseo, Anneal, proxy, localization, and rc.11 identity contracts",
  "focused Provider Center, Paseo, Anneal, proxy, localization, and rc.12 identity contracts",
);

replaceExactlyOnce(
  'aiTemp/rc12-release/run-windows-release.mjs',
  "publish and read back rc.11 prerelease",
  "publish and read back rc.12 prerelease",
);
