"use strict";

const { fetchOffThread } = require("./off-thread-run.cjs");

const IMAGE_MODEL = /^gpt-image-[a-z0-9][a-z0-9.-]{0,63}$/;
const SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"];
const QUALITIES = ["auto", "low", "medium", "high"];
const MAX_REPLY_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

const IMAGE_TOOL_DEFS = Object.freeze([{
  name: "generate_image", title: "Generate an image",
  description: "Generate an image through the configured CPA Images API and return it inline. Use this tool for image generation "
    + "instead of a chat model's hosted image_generation tool: image requests have their own model and never inherit the chat's "
    + "reasoning effort or complexity. Uses the configured provider's image allowance; do not repeat a failed call automatically. "
    + "No image is saved to disk. Use a file-writing tool separately if the user requests a saved file.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["prompt"],
    properties: {
      prompt: { type: "string", minLength: 1, maxLength: 12000, description: "Describe the image to generate" },
      model: { type: "string", default: "gpt-image-2", description: "An image model served by CPA, not the chat model" },
      size: { type: "string", enum: SIZES, default: "1024x1024" },
      quality: { type: "string", enum: QUALITIES, default: "auto" },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}]);

class ImageGenerationError extends Error {
  constructor(message, executionStatus = "not_started") {
    super(message);
    this.executionStatus = executionStatus;
  }
}

function imageRequest(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)
    || Object.keys(args).some(key => !["prompt", "model", "size", "quality"].includes(key))) {
    throw new ImageGenerationError("Use only prompt, model, size and quality; image generation takes no chat effort or complexity.");
  }
  const { prompt, model = "gpt-image-2", size = "1024x1024", quality = "auto" } = args;
  if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 12000) {
    throw new ImageGenerationError("Give an image prompt of 1 to 12000 characters.");
  }
  if (typeof model !== "string" || !IMAGE_MODEL.test(model)) throw new ImageGenerationError("Choose a gpt-image model, not a chat model or an effort suffix.");
  if (!SIZES.includes(size) || !QUALITIES.includes(quality)) throw new ImageGenerationError("Choose a supported image size and quality.");
  return { model, prompt, size, quality, n: 1, response_format: "b64_json" };
}

async function readReply(response) {
  if (!response.body) throw new ImageGenerationError("The image provider returned no image.", "failed");
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_REPLY_BYTES) {
        await reader.cancel();
        throw new ImageGenerationError("The image provider's response exceeded the image size limit.", "failed");
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  let reply;
  try { reply = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new ImageGenerationError("The image provider returned an invalid image response.", "failed"); }
  const data = reply?.data?.[0]?.b64_json;
  if (typeof data !== "string" || !data || data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4
    || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
    throw new ImageGenerationError("The image provider did not return a supported inline image.", "failed");
  }
  const image = Buffer.from(data, "base64");
  if (!image.length || image.length > MAX_IMAGE_BYTES || image.toString("base64") !== data) {
    throw new ImageGenerationError("The image provider returned invalid image bytes.", "failed");
  }
  const mimeType = image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
    : image[0] === 255 && image[1] === 216 && image[2] === 255 ? "image/jpeg"
      : image.subarray(0, 4).toString() === "RIFF" && image.subarray(8, 12).toString() === "WEBP" ? "image/webp" : null;
  if (!mimeType) throw new ImageGenerationError("The image provider returned an unsupported image format.", "failed");
  return { data, mimeType };
}

// The request to CPA is made from a worker (fetchOffThread), never with Node's fetch on main: a
// socket connect to CPA that the network filter held froze every window for 43.7 s (2026-11-12
// 09:38Z, "socket.connect 127.0.0.1:8317"). The worker keeps the same size cap as readReply.
const offThread = (url, init) => fetchOffThread(url, { maxBytes: MAX_REPLY_BYTES, ...init });

function createChatImageGenerator({ connection, fetchImpl = offThread, timeoutMs = 120000 } = {}) {
  if (typeof connection !== "function") throw new Error("A configured CPA connection is required");
  return async (args, { signal } = {}) => {
    const body = imageRequest(args);
    const active = await connection();
    if (!active?.baseUrl || !active?.proxyApiKey) throw new ImageGenerationError("Start CPA and connect an image-capable account before generating an image.");
    const endpoint = new URL(active.baseUrl);
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !(endpoint.protocol === "https:" || endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname))) {
      throw new ImageGenerationError("The configured CPA endpoint must use HTTPS or loopback HTTP.");
    }
    endpoint.pathname = `${endpoint.pathname.replace(/\/(?:v1\/?)?$/, "")}/v1/images/generations`;
    const cancellation = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
    cancellation.throwIfAborted();
    try {
      // Images create billable work. Neither redirects nor a failed response may replay this POST.
      const response = await fetchImpl(endpoint, {
        method: "POST", redirect: "manual", signal: cancellation,
        headers: { Authorization: `Bearer ${active.proxyApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ImageGenerationError(`Image generation failed (HTTP ${response.status}); it was not retried. Check CPA's image model and account allowance.`, "failed");
      }
      const image = await readReply(response);
      cancellation.throwIfAborted();
      return { ...image, model: body.model };
    } catch (error) {
      if (error instanceof ImageGenerationError) throw error;
      if (error?.code === "ERR_RESPONSE_TOO_LARGE") {
        throw new ImageGenerationError("The image provider's response exceeded the image size limit.", "failed");
      }
      throw new ImageGenerationError(cancellation.aborted
        ? "The image request was cancelled or timed out; its upstream outcome is unknown. It was not retried."
        : "The image provider connection failed; its upstream outcome is unknown. It was not retried.", "unknown");
    }
  };
}

module.exports = { createChatImageGenerator, IMAGE_TOOL_DEFS, imageRequest };
