const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { PRODUCT_IDENTITY } = require('../electron/product.cjs');

test('uses Coding Tools identities without impersonating upstream', () => {
  assert.deepEqual(PRODUCT_IDENTITY, {
    appId: 'dev.codingtools.fullharness',
    productName: 'Coding Tools',
    version: '0.6.0-rc.1',
    protocolVersion: 1,
    connectorName: 'Coding Tools Native2',
    devConnectorName: 'Coding Tools Native2 DEV',
    modelNamespace: 'chatgpt-web/',
  });
  assert.notEqual(PRODUCT_IDENTITY.appId, 'dev.codexwebgpt.launcher');
  assert.notEqual(PRODUCT_IDENTITY.productName, 'Codex Web GPT');
});

test('materialized workspaces retain an exact upstream mapping', () => {
  const mappingPath = path.resolve(__dirname, '../upstream/MATERIALIZATION.json');
  const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
  assert.equal(mapping.schema, 1);
  assert.equal(mapping.upstream.repository, 'miuuyy/codex-chatgpt-web');
  assert.equal(mapping.upstream.commit, 'e85e3693fdb4e3e033348c08df0298c20fcdb612');
  assert.ok(mapping.launcherFiles > 20);
  assert.ok(mapping.runtimeFiles > 100);
  assert.equal(mapping.deletedFiles, 0);
});
