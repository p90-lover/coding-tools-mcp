import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Since proxy.mjs has side effects (reads env, starts server), we test the
// pure logic by extracting equivalent functions here. This keeps unit tests
// fast and independent of network.

const MODEL_ALIASES = {
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-4-sonnet": "claude-sonnet-4-6",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-opus-4-7": "claude-opus-4-7",
  "claude-4-opus": "claude-opus-4-7",
  "claude-opus-4.7": "claude-opus-4-7",
  "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "kimi-k2.5": "moonshotai/Kimi-K2.5",
  "moonshotai/Kimi-K2.5": "moonshotai/Kimi-K2.5",
  "gpt-5.5": "gpt-5.5",
};

const DEFAULT_CC_MODEL = "deepseek/deepseek-v4-pro";

function resolveModel(model) {
  if (model && (model.startsWith("claude-") || model.startsWith("claude ") || model.startsWith("gpt-"))) {
    return DEFAULT_CC_MODEL;
  }
  if (MODEL_ALIASES[model]) return MODEL_ALIASES[model];
  return model;
}

function preserveModelName(requestedModel, actualModel) {
  if (requestedModel && requestedModel.startsWith("claude-")) return requestedModel;
  return actualModel || requestedModel;
}

function convertTools(tools) {
  if (!tools || !tools.length) return [];
  return tools.map((t) => {
    const fn = t.function || t;
    return { name: fn.name, description: fn.description || "", input_schema: fn.parameters || {} };
  });
}

function wrapContent(text) {
  return [{ type: "text", text: text || "" }];
}

function hashImageData(imageStr) {
  const len = imageStr.length;
  if (len < 200) return imageStr;
  return imageStr.slice(0, 64) + ":" + len + ":" + imageStr.slice(-64);
}

function hasImageContent(messages) {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) {
      if (block.type === "image" || block.type === "image_url") return true;
    }
  }
  return false;
}

describe("resolveModel", () => {
  it("remaps claude- models to default", () => {
    assert.equal(resolveModel("claude-sonnet-4-6"), DEFAULT_CC_MODEL);
    assert.equal(resolveModel("claude-opus-4-7"), DEFAULT_CC_MODEL);
    assert.equal(resolveModel("claude-haiku-4-5-20251001"), DEFAULT_CC_MODEL);
  });

  it("remaps gpt- models to default", () => {
    assert.equal(resolveModel("gpt-5.5"), DEFAULT_CC_MODEL);
    assert.equal(resolveModel("gpt-5.4-mini"), DEFAULT_CC_MODEL);
  });

  it("passes through gateway models", () => {
    assert.equal(resolveModel("deepseek/deepseek-v4-pro"), "deepseek/deepseek-v4-pro");
    assert.equal(resolveModel("moonshotai/Kimi-K2.5"), "moonshotai/Kimi-K2.5");
  });

  it("resolves aliases", () => {
    assert.equal(resolveModel("deepseek-v4-pro"), "deepseek/deepseek-v4-pro");
    assert.equal(resolveModel("kimi-k2.5"), "moonshotai/Kimi-K2.5");
  });

  it("returns unknown models as-is", () => {
    assert.equal(resolveModel("some-custom-model"), "some-custom-model");
  });

  it("handles null/undefined", () => {
    assert.equal(resolveModel(null), null);
    assert.equal(resolveModel(undefined), undefined);
  });
});

describe("preserveModelName", () => {
  it("preserves claude model names for responses", () => {
    assert.equal(preserveModelName("claude-sonnet-4-6", "deepseek/deepseek-v4-pro"), "claude-sonnet-4-6");
  });

  it("returns actual model for non-claude", () => {
    assert.equal(preserveModelName("deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-pro"), "deepseek/deepseek-v4-pro");
  });

  it("falls back to requested model if actual is falsy", () => {
    assert.equal(preserveModelName("some-model", ""), "some-model");
    assert.equal(preserveModelName("some-model", null), "some-model");
  });
});

describe("convertTools", () => {
  it("returns empty array for null/empty", () => {
    assert.deepEqual(convertTools(null), []);
    assert.deepEqual(convertTools([]), []);
  });

  it("converts OpenAI function format", () => {
    const tools = convertTools([{
      type: "function",
      function: { name: "test", description: "A test tool", parameters: { type: "object" } },
    }]);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "test");
    assert.equal(tools[0].description, "A test tool");
    assert.deepEqual(tools[0].input_schema, { type: "object" });
  });

  it("handles direct tool format (Anthropic-style)", () => {
    const tools = convertTools([{
      name: "test", description: "desc", parameters: { type: "object" },
    }]);
    assert.equal(tools[0].name, "test");
  });
});

describe("wrapContent", () => {
  it("wraps string in text block array", () => {
    assert.deepEqual(wrapContent("hello"), [{ type: "text", text: "hello" }]);
  });

  it("handles empty string", () => {
    assert.deepEqual(wrapContent(""), [{ type: "text", text: "" }]);
  });
});

describe("hashImageData", () => {
  it("returns short strings as-is", () => {
    assert.equal(hashImageData("short"), "short");
  });

  it("fingerprints long strings", () => {
    const long = "a".repeat(300);
    const hash = hashImageData(long);
    assert.ok(hash.length < long.length);
    assert.ok(hash.includes("300"));
  });
});

describe("hasImageContent", () => {
  it("returns false for text-only messages", () => {
    assert.equal(hasImageContent([{ role: "user", content: "hello" }]), false);
    assert.equal(hasImageContent([{ role: "user", content: [{ type: "text", text: "hi" }] }]), false);
  });

  it("detects image blocks", () => {
    assert.equal(hasImageContent([
      { role: "user", content: [{ type: "image", image: "data:image/png;base64,abc" }] },
    ]), true);
  });

  it("detects image_url blocks", () => {
    assert.equal(hasImageContent([
      { role: "user", content: [{ type: "image_url", image_url: { url: "http://example.com/img.png" } }] },
    ]), true);
  });
});
