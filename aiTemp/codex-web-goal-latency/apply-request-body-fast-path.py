from pathlib import Path


def replace_exact(path: Path, old: str, new: str, label: str) -> bool:
    text = path.read_text(encoding="utf-8")
    if new in text and old not in text:
        return False
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one old anchor, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    return True


changed = False

http_body = Path("runtime-web/src/http-body.ts")
changed |= replace_exact(
    http_body,
    "const decodedJsonBodies = new WeakMap<Request, unknown>();\n",
    "interface JsonRequestBodySnapshot {\n"
    "  body: unknown;\n"
    "  encoded?: ArrayBuffer;\n"
    "}\n\n"
    "const jsonRequestBodySnapshots = new WeakMap<Request, JsonRequestBodySnapshot>();\n",
    "http-body snapshot cache",
)
changed |= replace_exact(
    http_body,
    "export function primeJsonRequestBody(request: Request, body: unknown): void {\n"
    "  decodedJsonBodies.set(request, body);\n"
    "}\n",
    "export function primeJsonRequestBody(request: Request, body: unknown): void {\n"
    "  jsonRequestBodySnapshots.set(request, { body });\n"
    "}\n\n"
    "/** Original request bytes retained after decoding so native forwarding never needs a stream tee. */\n"
    "export function cachedEncodedJsonRequestBody(request: Request): ArrayBuffer | undefined {\n"
    "  return jsonRequestBodySnapshots.get(request)?.encoded;\n"
    "}\n",
    "http-body priming and encoded accessor",
)
changed |= replace_exact(
    http_body,
    "export async function readJsonRequestBody(request: Request): Promise<unknown> {\n"
    "  if (decodedJsonBodies.has(request)) return decodedJsonBodies.get(request);\n",
    "export async function readJsonRequestBody(request: Request): Promise<unknown> {\n"
    "  const cached = jsonRequestBodySnapshots.get(request);\n"
    "  if (cached) return cached.body;\n",
    "http-body decoded cache lookup",
)
changed |= replace_exact(
    http_body,
    "  const encoded = new Uint8Array(await request.arrayBuffer());\n"
    "  assertWithinLimit(encoded.byteLength, MAX_ENCODED_REQUEST_BYTES, \"Encoded request body\");\n",
    "  const encoded = await request.arrayBuffer();\n"
    "  assertWithinLimit(encoded.byteLength, MAX_ENCODED_REQUEST_BYTES, \"Encoded request body\");\n"
    "  const encodedBytes = new Uint8Array(encoded);\n",
    "http-body encoded byte retention",
)
changed |= replace_exact(
    http_body,
    "    decoded = encoded;\n"
    "  } else if (contentEncoding === \"zstd\") {\n"
    "    decoded = await Bun.zstdDecompress(encoded);\n",
    "    decoded = encodedBytes;\n"
    "  } else if (contentEncoding === \"zstd\") {\n"
    "    decoded = await Bun.zstdDecompress(encodedBytes);\n",
    "http-body decode source",
)
changed |= replace_exact(
    http_body,
    "  const body = JSON.parse(text) as unknown;\n"
    "  decodedJsonBodies.set(request, body);\n"
    "  return body;\n",
    "  const body = JSON.parse(text) as unknown;\n"
    "  jsonRequestBodySnapshots.set(request, { body, encoded });\n"
    "  return body;\n",
    "http-body snapshot write",
)

native = Path("runtime-web/src/native-passthrough.ts")
changed |= replace_exact(
    native,
    'import { readJsonRequestBody } from "./http-body";\n',
    'import { cachedEncodedJsonRequestBody, readJsonRequestBody } from "./http-body";\n',
    "native passthrough cache import",
)
changed |= replace_exact(
    native,
    "    const parseRequest = decodedBody === undefined ? request.clone() : undefined;\n"
    "    const originalBody = await request.arrayBuffer();\n"
    "    const parsedBody = decodedBody === undefined ? await readJsonRequestBody(parseRequest!) : decodedBody;\n",
    "    let parsedBody = decodedBody;\n"
    "    let originalBody = cachedEncodedJsonRequestBody(request);\n"
    "    if (parsedBody === undefined) {\n"
    "      parsedBody = await readJsonRequestBody(request);\n"
    "      originalBody = cachedEncodedJsonRequestBody(request);\n"
    "    } else if (originalBody === undefined && request.body !== null && !request.bodyUsed) {\n"
    "      originalBody = await request.arrayBuffer();\n"
    "    }\n",
    "native passthrough body acquisition",
)
changed |= replace_exact(
    native,
    "    if (scrubbed.changed) {\n"
    "      headers.delete(\"content-encoding\");\n"
    "      body = JSON.stringify(scrubbed.value);\n"
    "    } else {\n"
    "      body = originalBody;\n"
    "    }\n",
    "    if (scrubbed.changed) {\n"
    "      headers.delete(\"content-encoding\");\n"
    "      body = JSON.stringify(scrubbed.value);\n"
    "    } else if (originalBody !== undefined && originalBody.byteLength > 0) {\n"
    "      body = originalBody;\n"
    "    } else {\n"
    "      // A bodyless request can carry a request-scoped decoded cache. Re-encode it rather than\n"
    "      // forwarding an empty body with a stale compression header.\n"
    "      headers.delete(\"content-encoding\");\n"
    "      headers.set(\"content-type\", \"application/json\");\n"
    "      body = JSON.stringify(parsedBody);\n"
    "    }\n",
    "native passthrough exact-or-canonical body",
)

server = Path("runtime-web/src/server.ts")
server_text = server.read_text(encoding="utf-8")
old_clone = "  const nativeRequest = req.clone();\n"
if old_clone in server_text:
    if server_text.count(old_clone) != 2:
        raise SystemExit(f"server request clone declarations: expected two, found {server_text.count(old_clone)}")
    server_text = server_text.replace(old_clone, "", 2)
    changed = True
elif "forwardNativeCodexRequest(nativeRequest" in server_text:
    raise SystemExit("server request clone declarations missing while nativeRequest calls remain")

old_response_call = 'forwardNativeCodexRequest(nativeRequest, "responses", undefined, raw)'
new_response_call = 'forwardNativeCodexRequest(req, "responses", undefined, raw)'
if old_response_call in server_text:
    if server_text.count(old_response_call) != 1:
        raise SystemExit("server native responses call count changed")
    server_text = server_text.replace(old_response_call, new_response_call, 1)
    changed = True
elif new_response_call not in server_text:
    raise SystemExit("server native responses call anchor missing")

old_compact_call = 'forwardNativeCodexRequest(nativeRequest, "responses/compact", undefined, raw)'
new_compact_call = 'forwardNativeCodexRequest(req, "responses/compact", undefined, raw)'
if old_compact_call in server_text:
    if server_text.count(old_compact_call) != 1:
        raise SystemExit("server native compact call count changed")
    server_text = server_text.replace(old_compact_call, new_compact_call, 1)
    changed = True
elif new_compact_call not in server_text:
    raise SystemExit("server native compact call anchor missing")

server.write_text(server_text, encoding="utf-8")

for checked in (http_body, native, server):
    if not checked.read_text(encoding="utf-8").endswith("\n"):
        raise SystemExit(f"{checked}: missing final newline")

print(f"REQUEST_BODY_FAST_PATH_PATCH_OK changed={str(changed).lower()}")
