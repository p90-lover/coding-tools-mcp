import { verifyTree } from './lib/upstream-manifest.mjs';

const PIN = Object.freeze({
  repository: 'miuuyy/codex-chatgpt-web',
  tag: 'v6.1.12',
  commit: 'cdfceafd51df9ab6f19818c145eac5a99c593a3d',
  tunnelClientVersion: '0.0.16',
});

const result = await verifyTree(
  'vendor/codex-chatgpt-web-v6.1.12',
  'vendor/codex-chatgpt-web-v6.1.12/UPSTREAM_MANIFEST.json',
  PIN,
);
console.log(`UPSTREAM_VENDOR_PASS ${JSON.stringify(result)}`);
