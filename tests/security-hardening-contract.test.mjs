import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("OAuth rejects unconfigured clients and unsafe redirects", async () => {
  const source = await read("src-tauri/src/auth/oauth_flow.rs");
  assert.match(source, /OAUTH_MAX_PENDING_CODES/);
  assert.match(source, /redirect_uri_allowed/);
  assert.match(source, /if self\.client_id\.is_empty\(\)[\s\S]*?return false;/);
  assert.doesNotMatch(source, /if self\.client_id\.is_empty\(\)[\s\S]*?return true;/);
});

test("listeners are bounded and do not expose permissive CORS", async () => {
  for (const path of [
    "src-tauri/src/mcp/listener.rs",
    "src-tauri/src/actions/listener.rs",
  ]) {
    const source = await read(path);
    assert.match(source, /DefaultBodyLimit/);
    assert.match(source, /ConcurrencyLimitLayer/);
    assert.match(source, /TimeoutLayer/);
    assert.doesNotMatch(source, /CorsLayer::permissive/);
  }
});

test("patch deletion is reversible", async () => {
  const source = await read("src-tauri/src/tools/patch.rs");
  const production = source.split("#[cfg(test)]", 1)[0];
  assert.match(production, /fn move_to_trash/);
  assert.match(production, /aiTemp/);
  assert.match(production, /deleted-files/);
  assert.doesNotMatch(production, /(?:std::)?fs::remove_file/);
  assert.doesNotMatch(production, /(?:std::)?fs::remove_dir_all/);
});
