import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("OAuth rejects unconfigured clients and unsafe redirects", async () => {
  const source = await read("src-tauri/src/auth/oauth_flow.rs");
  assert.match(source, /OAUTH_MAX_PENDING_CODES/);
  assert.match(source, /redirect_uri_allowed/);
  const clientGuard = source.match(/pub fn client_id_allowed\([^]*?\n {4}\}/)?.[0];
  assert.ok(clientGuard, "the concrete client-ID validation function must exist");
  assert.match(clientGuard, /if self\.client_id\.is_empty\(\)\s*\{\s*return false;/);
  assert.doesNotMatch(clientGuard, /return true;/);
});

test("listeners are bounded and do not expose permissive CORS", async () => {
  for (const path of [
    "src-tauri/src/mcp/listener.rs",
    "src-tauri/src/actions/listener.rs",
  ]) {
    const source = await read(path);
    assert.match(source, /DefaultBodyLimit/);
    assert.match(source, /http_security::guard/);
    assert.match(source, /http_security::acquire_tool_worker/);
    assert.doesNotMatch(source, /CorsLayer::permissive/);
  }
});

test("shared HTTP guard enforces admission, origins and timeout", async () => {
  const source = await read("src-tauri/src/auth/http_security.rs");
  assert.match(source, /try_acquire_owned/);
  assert.match(source, /tokio::time::timeout/);
  assert.match(source, /allowed_origin/);
  assert.match(source, /secure_response/);
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

test("Codex permission controls use canonical sandbox and approval values", async () => {
  const runtime = await read("src/lib/components/RuntimePolicyForm.svelte");
  const actions = await read("src/lib/components/ActionsPolicyForm.svelte");
  const types = await read("src/lib/types.ts");

  for (const source of [runtime, actions]) {
    assert.match(source, /value:\s*"read-only"/);
    assert.match(source, /value:\s*"workspace-write"/);
    assert.match(source, /value:\s*"danger-full-access"/);
    assert.doesNotMatch(source, /value:\s*"(?:safe|trusted|dangerous)"/);
  }
  assert.match(runtime, /value:\s*"on-request"/);
  assert.match(runtime, /value:\s*"never"/);
  assert.doesNotMatch(runtime, /value:\s*"auto-workspace"/);
  assert.match(runtime, /value === "safe" \|\| value === "read-only"/);
  assert.match(runtime, /value === "dangerous" \|\| value === "danger-full-access"/);
  assert.match(types, /permission_mode:\s*"workspace-write"/);
});
