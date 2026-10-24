import { expect, test } from "bun:test";
import { get_encoding } from "tiktoken";
import { estimateTokens } from "../src/lib/token-estimate";

test("counts GPT-5 text with the o200k tokenizer", () => {
  expect(estimateTokens("hello world")).toBe(2);
});

test("dense encoded context is not under-counted as prose", () => {
  let state = 0x12345678;
  const bytes = Buffer.allocUnsafe(300_000);
  for (let index = 0; index < bytes.length; index++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[index] = state >>> 24;
  }
  const encoded = bytes.toString("base64");

  expect(encoded.length).toBe(400_000);
  expect(estimateTokens(encoded)).toBeGreaterThan(256_000);
});

test("pathological repeated text is counted in bounded chunks", () => {
  expect(estimateTokens("a".repeat(32_768))).toBe(4_096);
});

test("repeated chunks reuse exact token counts within one estimate", () => {
  const tokenizer = get_encoding("o200k_base");
  const prototype = Object.getPrototypeOf(tokenizer);
  const original = prototype.encode_ordinary;
  const chunk = " ".repeat(4_096);
  const repeated = chunk.repeat(3) + "tail";
  const expected = tokenizer.encode_ordinary(chunk).length * 3 + tokenizer.encode_ordinary("tail").length;
  const unicode = "x".repeat(4_095) + "😀tail";
  const expectedUnicode = tokenizer.encode_ordinary("x".repeat(4_095)).length + tokenizer.encode_ordinary("😀tail").length;
  let calls = 0;
  prototype.encode_ordinary = function(text: string) { calls += 1; return original.call(this, text); };
  try {
    expect(estimateTokens(repeated)).toBe(expected);
    expect(calls).toBe(2);
    calls = 0;
    expect(estimateTokens(repeated)).toBe(expected);
    expect(calls).toBe(2);
    calls = 0;
    expect(estimateTokens(unicode)).toBe(expectedUnicode);
    expect(calls).toBe(2);
    expect(estimateTokens("")).toBe(0);
  } finally {
    prototype.encode_ordinary = original;
    tokenizer.free();
  }
});

test("large ordinary prose is not inflated by a character-ratio heuristic", () => {
  const prose = `${"word ".repeat(97_999)}word`;
  expect(prose.length).toBe(489_999);
  expect(estimateTokens(prose)).toBeLessThan(100_000);
});
