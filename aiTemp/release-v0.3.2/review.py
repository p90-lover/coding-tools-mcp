"""Apply finalization, then explicit compilation and dependency-review corrections."""
from pathlib import Path
import runpy
import shutil
import time

root = Path.cwd().resolve()
runpy.run_path(str(root / 'aiTemp/release-v0.3.2/finalize.py'), run_name='__main__')
backup_root = root / 'aiTemp/Trash/compilation-review' / str(time.time_ns())

def replace_file(relative, replacements):
    path = root / relative
    path.resolve(strict=True).relative_to(root)
    if path.is_symlink():
        raise RuntimeError(f'refusing source symlink: {relative}')
    source = path.read_text(encoding='utf-8')
    for old, new, count in replacements:
        if source.count(old) != count:
            raise RuntimeError(f'expected {count} reviewed anchors: {old}')
        source = source.replace(old, new)
    backup = backup_root / relative
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, backup)
    path.write_text(source, encoding='utf-8')
    print('reviewed', relative)

replace_file('src-tauri/src/auth/oauth_flow.rs', [
    ('hex::encode(Sha256::digest(oauth.profile_id.as_bytes()))', 'format!("{:x}", Sha256::digest(oauth.profile_id.as_bytes()))', 1),
    ('hex::encode(hash.finalize())', 'format!("{:x}", hash.finalize())', 1),
])
replace_file('src-tauri/src/auth/http_security.rs', [
    ('Result<OwnedSemaphorePermit, Response>', 'Result<OwnedSemaphorePermit, Box<Response>>', 1),
    ('.map_err(|_| secure_response((StatusCode::SERVICE_UNAVAILABLE, [("retry-after", "1")], "Tool worker capacity reached").into_response()))', '.map_err(|_| Box::new(secure_response((StatusCode::SERVICE_UNAVAILABLE, [("retry-after", "1")], "Tool worker capacity reached").into_response())))', 1),
])
for relative in ['src-tauri/src/mcp/listener.rs', 'src-tauri/src/actions/listener.rs']:
    replace_file(relative, [('Ok(permit) => permit, Err(response) => return response,', 'Ok(permit) => permit, Err(response) => return *response,', 1)])
replace_file('src-tauri/tauri.conf.json', [('connect-src ipc:', "connect-src 'self' ipc:", 2)])
# SvelteKit still declares cookie ^0.6.0. Version 0.7.2 keeps parse/serialize
# while fixing GHSA-pxg6-pf52-xh8x; do not force npm's obsolete Kit downgrade.
replace_file('package.json', [('  "license": "Apache-2.0",', '  "license": "Apache-2.0",\n  "overrides": {\n    "cookie": "0.7.2"\n  },', 1)])
path=root/'tests/cookie-security-contract.test.mjs'
if path.exists():
    saved=backup_root/path.relative_to(root)
    saved.parent.mkdir(parents=True,exist_ok=True)
    shutil.copy2(path,saved)
path.write_text('''import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.resolve("@sveltejs/kit/package.json"));
const { parse, serialize } = require("cookie");

test("patched cookie preserves normal serialization and rejects attribute injection", () => {
  assert.equal(require("cookie/package.json").version, "0.7.2");
  assert.equal(parse("session=ok; theme=light").session, "ok");
  assert.equal(serialize("session", "ok", { httpOnly: true, sameSite: "lax", path: "/" }),
    "session=ok; Path=/; HttpOnly; SameSite=Lax");
  assert.throws(() => serialize("session; injected", "ok"));
  assert.throws(() => serialize("session", "ok", { path: "/; injected=value" }));
  assert.throws(() => serialize("session", "ok", { domain: "example.com; injected=value" }));
});
''',encoding='utf-8')
print('Applied reviewed compilation, CSP and cookie security fixes without disabling checks.')
