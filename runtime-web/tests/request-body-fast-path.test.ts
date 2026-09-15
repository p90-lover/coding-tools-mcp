import { expect, test } from "bun:test";
import {
  cachedEncodedJsonRequestBody,
  primeJsonRequestBody,
  readJsonRequestBody,
} from "../src/http-body";
import { forwardNativeCodexRequest } from "../src/native-passthrough";

function zstdRequest(body: Record<string, unknown>): {
  request: Request;
  encoded: Uint8Array;
} {
  const encoded = Bun.zstdCompressSync(Buffer.from(JSON.stringify(body)));
  const bytes = new ArrayBuffer(encoded.byteLength);
  new Uint8Array(bytes).set(encoded);
  return {
    request: new Request("http://127.0.0.1:17841/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer codex-oauth-token",
        "content-type": "application/json",
        "content-encoding": "zstd",
      },
      body: bytes,
    }),
    encoded,
  };
}

test("retains the exact encoded bytes after bounded JSON decoding", async () => {
  const body = { model: "chatgpt-web/pro", input: [{ role: "user", content: "goal context" }] };
  const { request, encoded } = zstdRequest(body);

  expect(await readJsonRequestBody(request)).toEqual(body);
  expect(request.bodyUsed).toBe(true);
  expect(Buffer.from(cachedEncodedJsonRequestBody(request)!)).toEqual(Buffer.from(encoded));
});

test("primed bodyless requests expose decoded JSON without inventing encoded bytes", async () => {
  const body = { model: "chatgpt-web/pro", input: [] };
  const request = new Request("http://127.0.0.1:17841/router/v1/responses", {
    method: "POST",
  });

  primeJsonRequestBody(request, body);

  expect(await readJsonRequestBody(request)).toEqual(body);
  expect(cachedEncodedJsonRequestBody(request)).toBeUndefined();
});

test("native passthrough reuses cached bytes after the parser consumes the request", async () => {
  const body = { model: "gpt-5.6-sol", stream: true, input: [{ role: "user", content: "continue" }] };
  const { request, encoded } = zstdRequest(body);
  const parsed = await readJsonRequestBody(request);
  let forwarded: Request | undefined;

  const response = await forwardNativeCodexRequest(request, "responses", async input => {
    forwarded = input;
    return Response.json({ ok: true });
  }, parsed);

  expect(response.status).toBe(200);
  expect(forwarded).toBeDefined();
  expect(forwarded!.headers.get("content-encoding")).toBe("zstd");
  expect(Buffer.from(await forwarded!.arrayBuffer())).toEqual(Buffer.from(encoded));
});

test("bodyless decoded requests fall back to canonical JSON without stale encoding", async () => {
  const body = { model: "gpt-5.6-sol", stream: false, input: [] };
  const request = new Request("http://127.0.0.1:17841/v1/responses", {
    method: "POST",
    headers: {
      authorization: "Bearer codex-oauth-token",
      "content-type": "application/json",
      "content-encoding": "zstd",
    },
  });
  primeJsonRequestBody(request, body);
  let forwarded: Request | undefined;

  await forwardNativeCodexRequest(request, "responses", async input => {
    forwarded = input;
    return Response.json({ ok: true });
  }, body);

  expect(forwarded).toBeDefined();
  expect(forwarded!.headers.get("content-encoding")).toBeNull();
  expect(await forwarded!.json()).toEqual(body);
});
