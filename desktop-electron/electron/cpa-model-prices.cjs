"use strict";

// ESTIMATED list prices, in USD per 1M tokens, that the CPA usage view (cpa-usage.cjs) prices a
// model's tokens with when CPA Helper's own price book has no price for it. They are the vendors'
// public pay-as-you-go API prices as far as we know them; most CPA accounts are subscriptions
// (ChatGPT, Claude, Cline Pass…) that are not billed per token, so the figure reads as "what this
// would have cost on the API", never as a bill. Edit freely: the first entry whose `pattern`
// matches the model's own name (lower-cased, without any "cpa/" or "provider/" prefix and without
// a "(high)" effort suffix) wins, so keep specific entries above general ones. A model no entry
// matches gets no estimate and shows "—".
//
// input:       per 1M uncached input tokens
// cachedInput: per 1M input tokens read from the provider's prompt cache (part of the input count)
// output:      per 1M output tokens (reasoning tokens are billed as output by every vendor here)

const MODEL_PRICES = Object.freeze([
  // Anthropic (platform.claude.com pricing). Cache writes are priced as plain input here.
  { label: "Claude Fable 5.x", pattern: /^claude-(fable|mythos)-5/, input: 10, cachedInput: 1, output: 50 },
  { label: "Claude Opus 5.5", pattern: /^claude-opus-5-5/, input: 4, cachedInput: 0.2, output: 20 },
  { label: "Claude Opus 4.5–5", pattern: /^claude-opus-(5|4-[5-9])/, input: 5, cachedInput: 0.5, output: 25 },
  { label: "Claude Opus 4 / 4.1", pattern: /^claude-(opus-4|4-opus)/, input: 15, cachedInput: 1.5, output: 75 },
  { label: "Claude Sonnet 5.x", pattern: /^claude-sonnet-5/, input: 2, cachedInput: 0.2, output: 10 },
  { label: "Claude Sonnet 3.7–4.6", pattern: /^claude-(sonnet-4|3-7-sonnet|3-5-sonnet)/, input: 3, cachedInput: 0.3, output: 15 },
  { label: "Claude Haiku 5.5", pattern: /^claude-haiku-5/, input: 0.1, cachedInput: 0.01, output: 0.5 },
  { label: "Claude Haiku 4.5", pattern: /^claude-haiku-4/, input: 1, cachedInput: 0.1, output: 5 },
  { label: "Claude Haiku 3.5", pattern: /^claude-3-5-haiku/, input: 0.8, cachedInput: 0.08, output: 4 },

  // OpenAI. Codex models are priced as their GPT-5 base model.
  { label: "GPT-5 nano", pattern: /^gpt-5(\.\d+)?-nano/, input: 0.05, cachedInput: 0.005, output: 0.4 },
  { label: "GPT-5 mini", pattern: /^gpt-5(\.\d+)?(-codex)?-mini/, input: 0.25, cachedInput: 0.025, output: 2 },
  { label: "GPT-5 / 5.1", pattern: /^gpt-5(\.1)?($|-)/, input: 1.25, cachedInput: 0.125, output: 10 },
  { label: "GPT-5.2+", pattern: /^gpt-5\.\d+/, input: 1.75, cachedInput: 0.175, output: 14 },
  { label: "codex-mini", pattern: /^codex-mini/, input: 1.5, cachedInput: 0.375, output: 6 },
  { label: "GPT-4.1", pattern: /^gpt-4\.1/, input: 2, cachedInput: 0.5, output: 8 },
  { label: "GPT-4o", pattern: /^gpt-4o/, input: 2.5, cachedInput: 1.25, output: 10 },
  { label: "o4-mini", pattern: /^o4-mini/, input: 1.1, cachedInput: 0.275, output: 4.4 },
  { label: "o3", pattern: /^o3($|-)/, input: 2, cachedInput: 0.5, output: 8 },

  // Google Gemini (prompts up to 200K tokens).
  { label: "Gemini 3 Pro", pattern: /^gemini-3(\.\d+)?-pro/, input: 2, cachedInput: 0.2, output: 12 },
  { label: "Gemini 3 Flash", pattern: /^gemini-3(\.\d+)?-flash/, input: 0.5, cachedInput: 0.05, output: 3 },
  { label: "Gemini 2.5 Pro", pattern: /^gemini-2\.5-pro/, input: 1.25, cachedInput: 0.125, output: 10 },
  { label: "Gemini 2.5 Flash-Lite", pattern: /^gemini-2\.5-flash-lite/, input: 0.1, cachedInput: 0.01, output: 0.4 },
  { label: "Gemini 2.5 Flash", pattern: /^gemini-2\.5-flash/, input: 0.3, cachedInput: 0.03, output: 2.5 },

  // xAI Grok.
  { label: "Grok fast", pattern: /^grok-(code-fast|4(\.\d+)?-fast)/, input: 0.2, cachedInput: 0.02, output: 1.5 },
  { label: "Grok 4", pattern: /^grok-4/, input: 3, cachedInput: 0.75, output: 15 },

  // Open-weight families as their makers' own APIs price them (Cline Pass serves several of these).
  { label: "DeepSeek", pattern: /^deepseek/, input: 0.28, cachedInput: 0.028, output: 0.42 },
  { label: "Qwen Max", pattern: /^qwen\d*(\.\d+)?-max/, input: 1.2, cachedInput: 0.24, output: 6 },
  { label: "Qwen Coder", pattern: /^qwen\d*(\.\d+)?-coder/, input: 1, cachedInput: 0.1, output: 5 },
  { label: "Qwen Plus", pattern: /^qwen/, input: 0.4, cachedInput: 0.08, output: 1.2 },
  { label: "Kimi K2+", pattern: /^kimi-k\d/, input: 0.6, cachedInput: 0.15, output: 2.5 },
  { label: "GLM", pattern: /^glm-[\d.]+$/, input: 0.6, cachedInput: 0.11, output: 2.2 },
  { label: "MiniMax M", pattern: /^minimax-m\d/, input: 0.3, cachedInput: 0.03, output: 1.2 },
]);

module.exports = Object.freeze({ MODEL_PRICES });
