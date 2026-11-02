import { verifyTree } from './lib/upstream-manifest.mjs';

const PIN = Object.freeze({
  repository: 'miuuyy/codex-chatgpt-web',
  tag: 'v6.1.17',
  commit: '860fa576eb47d9e20d7d8289235bfea94392d2fd',
  tunnelClientVersion: '0.0.16',
});

const result = await verifyTree(
  'vendor/codex-chatgpt-web-v6.1.17',
  'vendor/codex-chatgpt-web-v6.1.17/UPSTREAM_MANIFEST.json',
  PIN,
);
console.log(`UPSTREAM_VENDOR_PASS ${JSON.stringify(result)}`);
