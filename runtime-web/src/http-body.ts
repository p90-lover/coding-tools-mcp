const MAX_ENCODED_REQUEST_BYTES = 64 * 1024 * 1024;
const MAX_DECODED_REQUEST_BYTES = 128 * 1024 * 1024;

const decodedJsonBodies = new WeakMap<Request, unknown>();

function assertWithinLimit(bytes: number, limit: number, label: string): void {
  if (bytes > limit) throw new Error(`${label} exceeds ${limit} bytes`);
}

/**
 * Attach an already decoded body to a metadata-only replacement Request. The entry is request
 * scoped and disappears automatically when the replacement Request is collected.
 */
export function primeJsonRequestBody(request: Request, body: unknown): void {
  decodedJsonBodies.set(request, body);
}

export async function readJsonRequestBody(request: Request): Promise<unknown> {
  if (decodedJsonBodies.has(request)) return decodedJsonBodies.get(request);

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength)) {
    assertWithinLimit(declaredLength, MAX_ENCODED_REQUEST_BYTES, "Encoded request body");
  }

  const encoded = new Uint8Array(await request.arrayBuffer());
  assertWithinLimit(encoded.byteLength, MAX_ENCODED_REQUEST_BYTES, "Encoded request body");

  const contentEncoding = (request.headers.get("content-encoding") ?? "identity").trim().toLowerCase();
  let decoded: Uint8Array;
  if (contentEncoding === "" || contentEncoding === "identity") {
    decoded = encoded;
  } else if (contentEncoding === "zstd") {
    decoded = await Bun.zstdDecompress(encoded);
  } else {
    throw new Error(`Unsupported Content-Encoding: ${contentEncoding}`);
  }
  assertWithinLimit(decoded.byteLength, MAX_DECODED_REQUEST_BYTES, "Decoded request body");

  const text = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  const body = JSON.parse(text) as unknown;
  decodedJsonBodies.set(request, body);
  return body;
}
