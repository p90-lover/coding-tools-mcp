import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panel = readFileSync(new URL('../src/lib/components/CodexRuntimePanel.svelte', import.meta.url), 'utf8');
const registry = readFileSync(new URL('../src-tauri/src/tools/registry_definitions.rs', import.meta.url), 'utf8');

test('native Codex long-session UI keeps lifetime and close state honest', () => {
  assert.match(panel, /lifetime > 0 && lifetime < 30/);
  assert.match(panel, /operation === 'close'[\s\S]*selectedThread = ''[\s\S]*answer = null/);
});

test('native Codex control advertises bounded replay retention', () => {
  assert.doesNotMatch(registry, /repeats never replay/);
  assert.match(registry, /90-minute/);
  assert.match(registry, /fresh request_id/);
});
