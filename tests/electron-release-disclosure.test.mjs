import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const releaseNotePath = path.join(root, 'docs', 'releases', 'v0.6.0-rc.1.md');

async function readReleaseNote() {
  try {
    return await fs.readFile(releaseNotePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      assert.fail(`Missing release disclosure: ${releaseNotePath}`);
    }
    throw error;
  }
}

function assertIncludesAll(source, markers) {
  for (const marker of markers) {
    assert.ok(source.includes(marker), `release disclosure is missing: ${marker}`);
  }
}

test('discloses the exact Electron candidate identity and pinned upstream source', async () => {
  const note = await readReleaseNote();
  assertIncludesAll(note, [
    '# Coding Tools v0.6.0-rc.1 — Electron Full Codex Harness prerelease',
    'Windows x64 evaluation candidate',
    'dev.codingtools.fullharness',
    'Coding Tools Native2',
    'Coding Tools Native2 DEV',
    'chatgpt-web/',
    'miuuyy/codex-chatgpt-web',
    'v5.0.6',
    'e85e3693fdb4e3e033348c08df0298c20fcdb612',
  ]);
});

test('discloses the exact publication inventory and manual acceptance boundary', async () => {
  const note = await readReleaseNote();
  assertIncludesAll(note, [
    'Coding.Tools_0.6.0-rc.1_windows_x64_setup.exe',
    'provenance.json',
    'validation-evidence.json',
    'SHA256SUMS.txt',
    'Live-account acceptance: pending manual',
    'Automated gates: required before publication',
    'exact tested source SHA',
    'asset readback',
  ]);
});

test('keeps the stable rollback and security non-goals explicit', async () => {
  const note = await readReleaseNote();
  assertIncludesAll(note, [
    'Coding Tools MCP v0.4.10 remains available as the stable rollback',
    'does not bypass ChatGPT plans, quotas, model eligibility, workspace policy, or connector restrictions',
    'does not copy cookies or browser state from Chrome, Edge, another app, or another OS account',
    'does not silently create, replace, or reauthorize ChatGPT connectors',
    'Unknown remote or local operations are not replayed automatically',
    'No historical tag, release, Tauri source, user data, or project file is deleted',
  ]);

  for (const forbidden of [
    /production-ready/i,
    /live-account acceptance:\s*passed/i,
    /all acceptance gates (?:have )?passed/i,
    /complete replacement of v0\.4\.10/i,
    /all platforms released/i,
  ]) {
    assert.doesNotMatch(note, forbidden);
  }
});

test('provides matching Traditional Chinese status and rollback disclosure', async () => {
  const note = await readReleaseNote();
  assertIncludesAll(note, [
    '## 繁體中文',
    'Windows x64 評估候選版本',
    '真實帳戶驗收：待人工完成',
    '自動化閘門：公開前必須通過',
    'Coding Tools MCP v0.4.10 仍保留作為穩定回復版本',
    '唔會繞過 ChatGPT 方案、配額、模型資格、工作區政策或 connector 限制',
    '唔會由 Chrome、Edge、其他程式或其他作業系統帳戶複製 cookie 或瀏覽器狀態',
    '唔會靜默建立、取代或重新授權 ChatGPT connector',
    '未知結果嘅遠端或本機操作唔會自動重播',
    '唔會刪除任何歷史 tag、release、Tauri 原始碼、使用者資料或專案檔案',
  ]);
});
