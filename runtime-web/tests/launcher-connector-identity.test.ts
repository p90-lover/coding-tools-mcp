import { expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { resolveInteractionConnectorIdentities } from '../src/config';

const { CURRENT_CONNECTOR_NAME, DEV_CONNECTOR_NAME, requireCurrentRuntimeConnectorName } =
  createRequire(import.meta.url)('../../desktop-electron/electron/connector-identity.cjs');

test('runtime setup emits the connector identity accepted by the Coding Tools launcher', () => {
  const automatic = resolveInteractionConnectorIdentities('automatic');
  expect(automatic.appName).toBe(CURRENT_CONNECTOR_NAME);
  expect(requireCurrentRuntimeConnectorName(automatic.appName)).toBe(CURRENT_CONNECTOR_NAME);
  expect(resolveInteractionConnectorIdentities('automatic', 'development').appName).toBe(DEV_CONNECTOR_NAME);
  const manual = resolveInteractionConnectorIdentities('manual');
  expect(manual.appName).toBe('Codex Zero Risk');
  expect(manual.automaticAppName).toBe(CURRENT_CONNECTOR_NAME);
});
