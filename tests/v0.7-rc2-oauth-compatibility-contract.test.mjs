import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function indexBefore(source, first, second) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.notEqual(firstIndex, -1, `missing ${first}`);
  assert.notEqual(secondIndex, -1, `missing ${second}`);
  assert.ok(firstIndex < secondIndex, `${first} must occur before ${second}`);
}

test("OAuth authorization responses validate and advertise the trusted issuer", () => {
  const authModule = read("src-tauri/src/auth/mod.rs");
  const responseModule = read("src-tauri/src/auth/oauth_authorization_response.rs");

  assert.match(authModule, /mod oauth_authorization_response;/);
  assert.match(
    authModule,
    /pub use oauth_authorization_response::\{authorization_server_metadata, authorize_post_browser\};/,
  );
  assert.match(responseModule, /authorization_response_iss_parameter_supported/);
  assert.match(responseModule, /serializer\.append_pair\("iss", issuer\)/);
  assert.match(responseModule, /query_segment_key_is_issuer/);
  indexBefore(
    responseModule,
    "let Some(issuer) = canonical_issuer(server_url)",
    "oauth_flow::authorize_post_browser(oauth, headers, form, &issuer)",
  );
});

test("MCP OAuth metadata identifies the exact path-qualified protected resource", () => {
  const authModule = read("src-tauri/src/auth/mod.rs");
  const metadataModule = read("src-tauri/src/auth/oauth_resource_metadata.rs");
  const listener = read("src-tauri/src/mcp/listener.rs");
  const transport = read("src-tauri/src/mcp/transport.rs");

  assert.match(authModule, /pub\(crate\) use oauth_resource_metadata::mcp_protected_resource_metadata;/);
  assert.match(metadataModule, /metadata\["resource"\] = Value::String\(format!\("\{base\}\/mcp"\)\)/);
  assert.match(
    listener,
    /"\/\.well-known\/oauth-protected-resource\/mcp",\s*get\(oauth_mcp_protected_resource_metadata\)/s,
  );
  assert.match(
    transport,
    /resource_metadata=\\"\{\}\/\.well-known\/oauth-protected-resource\/mcp\\"/,
  );
});
