import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const panel = readFileSync(new URL('../src/lib/components/CodexRuntimePanel.svelte', import.meta.url), 'utf8');
const registry = readFileSync(new URL('../src-tauri/src/tools/registry_definitions.rs', import.meta.url), 'utf8');

test('native Codex long-session UI keeps lifetime and close state honest', () => {
  assert.match(panel, /lifetime > 0 && lifetime < 30/);
  assert.match(panel, /operation === 'close'[\s\S]*selectedThread = ''[\s\S]*answer = null/);
});

// Guard the public replay-safety contract so client retries match bounded receipt retention.
test('native Codex control advertises bounded replay retention', () => {
  assert.doesNotMatch(registry, /repeats never replay/);
  assert.match(registry, /90-minute/);
  assert.match(registry, /fresh request_id/);
});

test('five-stack long-run reuses recovery backoff and turn-suspension sleep gaps', () => {
  const electron = readFileSync(new URL('../desktop-electron/electron/five-stack-long-run.cjs', import.meta.url), 'utf8');
  const rust = readFileSync(new URL('../src-tauri/src/integrations/long_run.rs', import.meta.url), 'utf8');
  const recovery = readFileSync(new URL('../src-tauri/src/tunnel/recovery.rs', import.meta.url), 'utf8');
  const suspension = readFileSync(new URL('../desktop-electron/electron/turn-suspension.cjs', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../desktop-electron/electron/main.cjs', import.meta.url), 'utf8');
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');

  for (const source of [electron, rust]) {
    assert.match(source, /7 \* 24 \* 60 \* 60 \* 1000/);
    assert.match(source, /30_000/);
    assert.match(source, /\[5,\s*15,\s*30,\s*60,\s*120,\s*300\]/);
    assert.match(source, /MAX_ATTEMPTS(?:: usize)? = 8/);
    assert.match(source, /long-run\.json/);
    assert.doesNotMatch(source, /managementKey|proxyApiKey|user_\*/);
  }
  assert.match(recovery, /DELAYS: \[u64; 5\] = \[5, 15, 30, 60, 120\]/);
  assert.match(suspension, /sweepGapIndicatesSuspension/);
  assert.match(electron, /sweepGapIndicatesSuspension/);
  assert.match(main, /powerMonitor\.on\("resume"/);
  assert.match(lib, /ensure_five_stack_health_loop/);
});
