import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(repo, relativePath), 'utf8');

test('CPA management key is copied by privileged Rust code and never returned to renderer JavaScript', () => {
  const cargo = read('src-tauri/Cargo.toml');
  const lock = read('src-tauri/Cargo.lock');
  const headlessLock = read('rust-core/coding-tools-headless/Cargo.lock');
  const app = read('src-tauri/src/lib.rs');
  const command = read('src-tauri/src/commands/five_stack.rs');
  const panel = read('src/lib/components/control-center/OriginalUiPanel.svelte');

  assert.match(cargo, /tauri-plugin-clipboard-manager\s*=\s*"=2\.3\.3"/);
  assert.match(lock, /name = "tauri-plugin-clipboard-manager"\nversion = "2\.3\.3"/);
  assert.match(headlessLock, /name = "tauri-plugin-clipboard-manager"\nversion = "2\.3\.3"/);
  assert.match(app, /\.plugin\(tauri_plugin_clipboard_manager::init\(\)\)/);
  assert.match(command, /use tauri_plugin_clipboard_manager::ClipboardExt;/);
  assert.match(command, /pub struct CpaClipboardResult/);
  assert.match(command, /window\.clipboard\(\)\.write_text\(key\)/);
  assert.match(command, /AppResult<CpaClipboardResult>/);
  assert.match(command, /Ok\(CpaClipboardResult \{\s*copied: true,\s*length,/);
  assert.doesNotMatch(command, /five_stack_copy_cpa_management_key[\s\S]{0,300}AppResult<String>/);
  assert.doesNotMatch(command, /println!\([^\n]*key|tracing::[^\n]*key/);

  assert.match(panel, /invoke<\{ copied: boolean; length: number \}>\('five_stack_copy_cpa_management_key'\)/);
  assert.doesNotMatch(panel, /invoke<string>\('five_stack_copy_cpa_management_key'\)/);
  assert.doesNotMatch(panel, /navigator\.clipboard\.writeText\(copied\)/);
});

test('Electron retains the same privileged clipboard boundary', () => {
  const controller = read('desktop-electron/electron/original-ui.cjs');
  const surface = read('desktop-electron/src/features/OriginalUiSurface.tsx');

  assert.match(controller, /function copyCpaManagementKey\(clipboard\)/);
  assert.match(controller, /clipboard\.writeText\(value\)/);
  assert.match(controller, /return \{ copied: true, length \}/);
  assert.doesNotMatch(surface, /navigator\.clipboard\.writeText\([^)]*management/i);
});
