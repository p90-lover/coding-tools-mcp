import { verifyTree } from './lib/upstream-manifest.mjs';

const PIN = Object.freeze({
  repository: 'miuuyy/codex-chatgpt-web',
  tag: 'v5.0.6',
  commit: 'e85e3693fdb4e3e033348c08df0298c20fcdb612',
  tunnelClientVersion: '0.0.12',
});

const result = await verifyTree(
  'vendor/codex-chatgpt-web-v5.0.6',
  'vendor/codex-chatgpt-web-v5.0.6/UPSTREAM_MANIFEST.json',
  PIN,
);
console.log(`UPSTREAM_VENDOR_PASS ${JSON.stringify(result)}`);
