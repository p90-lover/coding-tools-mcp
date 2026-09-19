#!/usr/bin/env node

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const PORT = parseInt(process.env.PROXY_PORT || "8787", 10);
const HOST = process.env.PROXY_HOST || "0.0.0.0";
const CC_API_BASE = process.env.CC_API_BASE || "https://api.commandcode.ai";
const CC_CLI_VERSION = process.env.CC_CLI_VERSION || "0.26.3";
const PROXY_API_KEY = process.env.PROXY_API_KEY || "";
if (!PROXY_API_KEY) {
  console.error("[FATAL] PROXY_API_KEY environment variable is required. Set it to a secret key of your choice.");
  process.exit(1);
}

function loadAuthKey() {
  const authPath = join(homedir(), ".commandcode", "auth.json");
  if (!existsSync(authPath)) {
    console.error("[FATAL] No auth at " + authPath + ". Run commandcode first.");
    process.exit(1);
  }
  const auth = JSON.parse(readFileSync(authPath, "utf8"));
  if (!auth.apiKey) {
    console.error("[FATAL] auth.json has no apiKey.");
    process.exit(1);
  }
  return auth.apiKey;
}

const API_KEY = process.env.CC_API_KEY || loadAuthKey();

const MODEL_ALIASES = {
  "claude-sonnet-4-6": "claude-sonnet-4-6",
  "claude-4-sonnet": "claude-sonnet-4-6",
  "claude-sonnet-4.6": "claude-sonnet-4-6",
  "claude-sonnet-4-20250514": "claude-sonnet-4-20250514",
  "claude-opus-4-7": "claude-opus-4-7",
  "claude-4-opus": "claude-opus-4-7",
  "claude-opus-4.7": "claude-opus-4-7",
  "claude-opus-4-6": "claude-opus-4-6",
  "claude-opus-4.6": "claude-opus-4-6",
  "claude-haiku-4-5-20251001": "claude-haiku-4-5-20251001",
  "claude-haiku-4.5": "claude-haiku-4-5-20251001",
  "claude-haiku": "claude-haiku-4-5-20251001",
  "gpt-5.5": "gpt-5.5",
  "gpt-5.4": "gpt-5.4",
  "gpt-5.4-mini": "gpt-5.4-mini",
  "gpt-5.3-codex": "gpt-5.3-codex",
  "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-flash": "deepseek/deepseek-v4-flash",
  "kimi-k2.5": "moonshotai/Kimi-K2.5",
  "moonshotai/Kimi-K2.5": "moonshotai/Kimi-K2.5",
  "kimi-k2.6": "moonshotai/Kimi-K2.6",
  "moonshotai/Kimi-K2.6": "moonshotai/Kimi-K2.6",
  "glm-5": "zai-org/GLM-5",
  "zai-org/GLM-5": "zai-org/GLM-5",
  "glm-5.1": "zai-org/GLM-5.1",
  "zai-org/GLM-5.1": "zai-org/GLM-5.1",
  "minimax-m2.5": "MiniMaxAI/MiniMax-M2.5",
  "MiniMaxAI/MiniMax-M2.5": "MiniMaxAI/MiniMax-M2.5",
  "minimax-m2.7": "MiniMaxAI/MiniMax-M2.7",
  "MiniMaxAI/MiniMax-M2.7": "MiniMaxAI/MiniMax-M2.7",
  "qwen-3.6-max": "Qwen/Qwen3.6-Max-Preview",
  "Qwen/Qwen3.6-Max-Preview": "Qwen/Qwen3.6-Max-Preview",
  "qwen-3.6-plus": "Qwen/Qwen3.6-Plus",
  "Qwen/Qwen3.6-Plus": "Qwen/Qwen3.6-Plus",
  "step-3.5-flash": "stepfun/Step-3.5-Flash",
  "stepfun/Step-3.5-Flash": "stepfun/Step-3.5-Flash",
};

// Default CC model to route all requests to (override with PROXY_DEFAULT_MODEL env var)
const DEFAULT_CC_MODEL = process.env.PROXY_DEFAULT_MODEL || "deepseek/deepseek-v4-pro";

function resolveModel(model) {
  // Always remap premium Claude/GPT models to the default CC model (user's plan doesn't include them)
  if (model && (model.startsWith("claude-") || model.startsWith("claude ") || model.startsWith("gpt-"))) {
    return DEFAULT_CC_MODEL;
  }
  if (MODEL_ALIASES[model]) return MODEL_ALIASES[model];
  return model;
}

// Return the original requested model name in responses (so Claude Code doesn't reject it)
function preserveModelName(requestedModel, actualModel) {
  if (requestedModel && requestedModel.startsWith("claude-")) return requestedModel;
  return actualModel || requestedModel;
}

// Vision model for image understanding, coding model for everything else
const VISION_MODEL = process.env.PROXY_VISION_MODEL || "moonshotai/Kimi-K2.6";
const CODING_MODEL = process.env.PROXY_CODING_MODEL || DEFAULT_CC_MODEL;

// Persistent session ID so all requests from this proxy share one rate-limit bucket
const PROXY_SESSION_ID = randomUUID();

// --- Vision pre-processing: use Kimi to describe images, then DeepSeek to code ---

// Cache image descriptions by content hash to avoid re-analyzing the same image
const imageDescriptionCache = new Map();
const IMAGE_CACHE_MAX = 100;

function hashImageData(imageStr) {
  // Use first 64 + last 64 chars + length as a fast fingerprint
  const len = imageStr.length;
  if (len < 200) return imageStr;
  return imageStr.slice(0, 64) + ":" + len + ":" + imageStr.slice(-64);
}

function getCachedDescription(imageData) {
  const key = hashImageData(imageData);
  return imageDescriptionCache.get(key);
}

function setCachedDescription(imageData, description) {
  const key = hashImageData(imageData);
  if (imageDescriptionCache.size >= IMAGE_CACHE_MAX) {
    const firstKey = imageDescriptionCache.keys().next().value;
    imageDescriptionCache.delete(firstKey);
  }
  imageDescriptionCache.set(key, description);
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

function extractImageMessages(messages) {
  const imageGroups = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    const images = [];
    let contextText = "";
    for (const block of m.content) {
      if (block.type === "image" || block.type === "image_url") images.push(block);
      else if (block.type === "text" && block.text) contextText += block.text + "\n";
    }
    if (images.length > 0) {
      imageGroups.push({ msgIndex: i, images, contextText: contextText.trim() });
    }
  }
  return imageGroups;
}

async function describeImagesWithVision(imageGroups, messages) {
  const descriptions = new Map();

  for (const group of imageGroups) {
    // Build a cache key from all images in this group
    const imageKeys = [];
    const ccImages = [];
    for (const img of group.images) {
      let ccImg = null;
      if (img.type === "image" && img.image) { ccImg = img; }
      else if (img.type === "image" && img.source) { ccImg = convertImageBlockToCC(img); }
      else if (img.type === "image_url") { ccImg = convertOpenAIImageToCC(img); }
      if (ccImg) {
        ccImages.push(ccImg);
        imageKeys.push(ccImg.image || "");
      }
    }

    // Check cache first
    const cacheKey = imageKeys.join("|");
    const cached = getCachedDescription(cacheKey);
    if (cached) {
      console.log("[VISION] Cache hit for " + ccImages.length + " image(s) in message " + group.msgIndex + " (" + cached.length + " chars)");
      descriptions.set(group.msgIndex, cached);
      continue;
    }

    const visionContent = [];
    visionContent.push({
      type: "text",
      text: "You are looking at an image. Describe EXACTLY what you see. Include all visual details: colors, shapes, layout, any text, UI elements, buttons, error messages, code, file names. Do NOT say you cannot see the image - it is attached. Start your response with the description immediately." +
        (group.contextText ? "\n\nAdditional context from user: " + group.contextText : ""),
    });
    for (const ccImg of ccImages) visionContent.push(ccImg);

    const visionMessages = [{ role: "user", content: visionContent }];
    const visionBody = buildCCBody(VISION_MODEL, visionMessages, "You are an image analysis assistant. Describe images accurately and in detail for developers.", {
      max_tokens: 2048,
      temperature: 0.2,
    });

    try {
      console.log("[VISION] Sending " + ccImages.length + " image(s) to " + VISION_MODEL + " for analysis...");
      const vRes = await fetchCC(visionBody);
      const result = await collectFull(vRes);
      const desc = (result.text || result.reasoning || "").trim();
      console.log("[VISION] Got description (" + desc.length + " chars) for message " + group.msgIndex);
      descriptions.set(group.msgIndex, desc);
      if (desc.length > 0) setCachedDescription(cacheKey, desc);
    } catch (err) {
      console.error("[VISION] Failed to describe images: " + err.message);
      descriptions.set(group.msgIndex, "[Image analysis failed: " + err.message + "]");
    }
  }

  return descriptions;
}

function replaceImagesWithDescriptions(messages, descriptions) {
  return messages.map((m, i) => {
    if (!descriptions.has(i)) return m;
    const desc = descriptions.get(i);
    const newContent = [];
    let hasText = false;
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === "image" || block.type === "image_url") continue;
        if (block.type === "text") { newContent.push(block); hasText = true; }
        else newContent.push(block);
      }
    }
    newContent.push({
      type: "text",
      text: "\n\n<image_description>\n" + desc + "\n</image_description>",
    });
    return { ...m, content: newContent };
  });
}

async function visionPreprocess(messages) {
  if (!hasImageContent(messages)) return { messages, usedVision: false };

  console.log("[VISION] Images detected - routing to " + VISION_MODEL + " for analysis before " + CODING_MODEL);
  const imageGroups = extractImageMessages(messages);
  if (imageGroups.length === 0) return { messages, usedVision: false };

  const descriptions = await describeImagesWithVision(imageGroups, messages);
  const processed = replaceImagesWithDescriptions(messages, descriptions);
  return { messages: processed, usedVision: true };
}

function buildCCBody(model, messages, systemPrompt, opts) {
  return {
    config: {
      workingDir: process.env.CC_WORKING_DIR || process.cwd(),
      date: new Date().toISOString().split("T")[0],
      environment: "linux",
      structure: [],
      isGitRepo: false,
      currentBranch: "",
      mainBranch: "",
      gitStatus: "",
      recentCommits: [],
    },
    memory: "",
    taste: "",
    skills: "",
    mode: "custom-agent",
    params: {
      tools: opts.tools || [],
      messages: messages,
      model: model,
      system: systemPrompt || "You are a helpful assistant.",
      max_tokens: opts.max_tokens || 8192,
      temperature: opts.temperature !== undefined ? opts.temperature : 0.3,
      stream: true,
    },
    threadId: randomUUID(),
  };
}

async function fetchCCSingle(body) {
  const r = await fetch(CC_API_BASE + "/alpha/generate", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + API_KEY,
      "x-command-code-version": CC_CLI_VERSION,
      "x-cli-environment": "production",
      "x-session-id": PROXY_SESSION_ID,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text();
    const err = new Error("CC API " + r.status + ": " + t);
    err.status = r.status;
    throw err;
  }
  return r;
}

async function fetchCC(body) {
  const maxRetries = 5;
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fetchCCSingle(body);
    } catch (err) {
      lastErr = err;
      const status = err.status || 0;
      const retryable = status === 429 || status === 503 || (status >= 500 && status < 600);
      if (!retryable || attempt === maxRetries - 1) throw err;
      const delay = Math.min(1000 * Math.pow(2, attempt) + Math.random() * 500, 16000);
      console.log("[RETRY] attempt " + (attempt + 1) + "/" + maxRetries + " after " + Math.round(delay) + "ms (status=" + status + ")");
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function* parseEvents(response) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const ln of lines) {
      const t = ln.trim();
      if (!t) continue;
      try { yield JSON.parse(t); } catch {}
    }
  }
  if (buf.trim()) {
    try { yield JSON.parse(buf.trim()); } catch {}
  }
}

async function collectFull(response) {
  const r = { text: "", reasoning: "", usage: null, model: "", finishReason: "stop", toolCalls: [] };
  for await (const ev of parseEvents(response)) {
    if (ev.type === "error") {
      const msg = (ev.error && ev.error.message) || "Unknown CC API error";
      throw new Error(msg);
    }
    if (ev.type === "text-delta") r.text += ev.text || "";
    else if (ev.type === "reasoning-delta") r.reasoning += ev.text || "";
    else if (ev.type === "finish-step") {
      r.usage = ev.usage || null;
      r.finishReason = ev.finishReason || "stop";
      if (ev.response && ev.response.modelId) r.model = ev.response.modelId;
    } else if (ev.type === "tool-call") {
      r.toolCalls.push({ id: ev.toolCallId, name: ev.toolName, arguments: ev.args || ev.input || {} });
    }
  }
  return r;
}

function extractMessages(body) {
  const msgs = [];
  let sys = "";
  for (const m of (body.messages || [])) {
    if (m.role === "system") {
      const c = typeof m.content === "string" ? m.content : (m.content || []).map(x => x.text || "").join("\n");
      sys += (sys ? "\n" : "") + c;
    } else if (m.role === "tool") {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content || "");
      msgs.push({
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: m.tool_call_id || "",
          toolName: m.name || "",
          output: { type: "text", value: text },
        }],
      });
    } else if (m.role === "assistant") {
      const blocks = [];
      const textContent = typeof m.content === "string" ? m.content : "";
      if (textContent) blocks.push({ type: "text", text: textContent });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = tc.function || {};
          let parsedArgs = {};
          try { parsedArgs = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : (fn.arguments || {}); } catch { parsedArgs = {}; }
          blocks.push({
            type: "tool-call",
            toolCallId: tc.id || "",
            toolName: fn.name || "",
            input: parsedArgs,
          });
        }
      }
      msgs.push({ role: "assistant", content: blocks.length > 0 ? blocks : wrapContent("") });
    } else {
      const role = (m.role === "user" || m.role === "assistant") ? m.role : "user";
      if (typeof m.content === "string") {
        msgs.push({ role, content: wrapContent(m.content) });
      } else if (Array.isArray(m.content)) {
        const contentBlocks = [];
        for (const part of m.content) {
          if (part.type === "text" && part.text) contentBlocks.push({ type: "text", text: part.text });
          else if (part.type === "image_url") {
            const img = convertOpenAIImageToCC(part);
            if (img) contentBlocks.push(img);
          }
        }
        msgs.push({ role, content: contentBlocks.length > 0 ? contentBlocks : wrapContent("") });
      } else {
        msgs.push({ role, content: wrapContent(String(m.content || "")) });
      }
    }
  }
  return { messages: msgs, systemPrompt: sys };
}

function convertAnthropicContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  // Convert Anthropic content blocks to plain text + tool call structures
  const parts = [];
  for (const block of content) {
    if (typeof block === "string") { parts.push(block); continue; }
    if (block.type === "text") { parts.push(block.text || ""); }
    else if (block.type === "thinking") { parts.push(block.thinking || ""); }
    else if (block.type === "tool_use") {
      parts.push("[Tool call: " + block.name + "(" + JSON.stringify(block.input || {}) + ") id=" + block.id + "]");
    } else if (block.type === "tool_result") {
      const resultContent = typeof block.content === "string" ? block.content
        : Array.isArray(block.content) ? block.content.map(c => c.text || "").join("\n")
        : JSON.stringify(block.content || "");
      parts.push("[Tool result for " + block.tool_use_id + "]: " + resultContent);
    } else if (block.type === "image") {
      parts.push("[Image]");
    }
  }
  return parts.join("\n");
}

function wrapContent(text) {
  return [{ type: "text", text: text || "" }];
}

function convertImageBlockToCC(block) {
  // Anthropic format: {type:"image", source:{type:"base64", media_type:"image/png", data:"..."}}
  if (block.source && block.source.type === "base64") {
    return { type: "image", image: "data:" + (block.source.media_type || "image/png") + ";base64," + block.source.data };
  }
  // Anthropic URL format: {type:"image", source:{type:"url", url:"..."}}
  if (block.source && block.source.type === "url") {
    return { type: "image", image: block.source.url };
  }
  // Already a data URL
  if (block.source && block.source.data) {
    return { type: "image", image: block.source.data };
  }
  return null;
}

function convertOpenAIImageToCC(part) {
  // OpenAI format: {type:"image_url", image_url:{url:"data:image/png;base64,..."}}
  if (part.image_url && part.image_url.url) {
    return { type: "image", image: part.image_url.url };
  }
  return null;
}

function convertAnthropicMessagesToCC(messages) {
  const converted = [];
  for (const m of messages) {
    const role = m.role;

    if (typeof m.content === "string") {
      const r = (role === "user" || role === "assistant" || role === "tool") ? role : "user";
      converted.push({ role: r, content: wrapContent(m.content) });
      continue;
    }
    if (!Array.isArray(m.content)) {
      const r = (role === "user" || role === "assistant") ? role : "user";
      converted.push({ role: r, content: wrapContent(String(m.content || "")) });
      continue;
    }

    if (role === "assistant") {
      const contentBlocks = [];
      for (const block of m.content) {
        if (block.type === "text" && block.text) contentBlocks.push({ type: "text", text: block.text });
        else if (block.type === "thinking" && block.thinking) contentBlocks.push({ type: "text", text: block.thinking });
        else if (block.type === "tool_use") {
          contentBlocks.push({
            type: "tool-call",
            toolCallId: block.id || randomUUID(),
            toolName: block.name || "",
            input: block.input || {},
          });
        }
      }
      converted.push({ role: "assistant", content: contentBlocks.length > 0 ? contentBlocks : wrapContent("") });
    }
    else if (role === "user") {
      // Separate text/image content from tool_result blocks
      const userBlocks = [];
      const toolResultMsgs = [];
      for (const block of m.content) {
        if (block.type === "text" && block.text) userBlocks.push({ type: "text", text: block.text });
        else if (block.type === "image") {
          const img = convertImageBlockToCC(block);
          if (img) userBlocks.push(img);
        }
        else if (block.type === "tool_result") {
          const resultContent = typeof block.content === "string" ? block.content
            : Array.isArray(block.content) ? block.content.map(c => {
                if (typeof c === "string") return c;
                if (c.type === "image") { const img = convertImageBlockToCC(c); if (img) userBlocks.push(img); return ""; }
                return c.text || JSON.stringify(c);
              }).filter(Boolean).join("\n")
            : JSON.stringify(block.content || "");
          toolResultMsgs.push({
            role: "tool",
            content: [{
              type: "tool-result",
              toolCallId: block.tool_use_id || "",
              toolName: "",
              output: { type: "text", value: resultContent || "" },
            }],
          });
        }
      }
      // Emit tool result messages first (they respond to the previous assistant tool calls)
      for (const tr of toolResultMsgs) converted.push(tr);
      // Then emit user text/image content if any
      if (userBlocks.length > 0) converted.push({ role: "user", content: userBlocks });
      // If no content at all, still need at least an empty user message
      if (toolResultMsgs.length === 0 && userBlocks.length === 0) {
        converted.push({ role: "user", content: wrapContent("") });
      }
    }
    else {
      // system or other roles - convert to user
      const text = convertAnthropicContent(m.content);
      converted.push({ role: "user", content: wrapContent(text) });
    }
  }
  return converted;
}

function extractAnthropicMessages(body) {
  const sys = typeof body.system === "string" ? body.system
    : Array.isArray(body.system) ? body.system.map(s => typeof s === "string" ? s : (s.text || "")).join("\n")
    : "";
  const converted = convertAnthropicMessagesToCC(body.messages || []);
  return { messages: converted, systemPrompt: sys };
}

function convertTools(tools) {
  if (!tools || !tools.length) return [];
  return tools.map(t => {
    const fn = t.function || t;
    return { name: fn.name, description: fn.description || "", input_schema: fn.parameters || {} };
  });
}

async function handleOpenAIChat(body, res) {
  let { messages, systemPrompt } = extractMessages(body);
  const model = resolveModel(body.model || "deepseek/deepseek-v4-pro");
  const tools = convertTools(body.tools);
  const rid = "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 24);

  // Vision pre-processing: images → Kimi description → DeepSeek coding
  const vp = await visionPreprocess(messages);
  if (vp.usedVision) messages = vp.messages;

  const ccBody = buildCCBody(model, messages, systemPrompt, {
    tools: tools,
    max_tokens: body.max_tokens || body.max_completion_tokens || 8192,
    temperature: body.temperature,
  });
  const ccRes = await fetchCC(ccBody);

  if (!body.stream) {
    const c = await collectFull(ccRes);
    const choices = [{
      index: 0,
      message: {
        role: "assistant",
        content: c.text || null,
        ...(c.toolCalls.length ? {
          tool_calls: c.toolCalls.map((tc, i) => ({
            id: tc.id || "call_" + i,
            type: "function",
            function: { name: tc.name, arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments) }
          }))
        } : {})
      },
      finish_reason: c.finishReason === "length" ? "length" : c.finishReason === "tool-calls" ? "tool_calls" : "stop"
    }];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: rid, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: c.model || model,
      choices: choices,
      usage: c.usage ? { prompt_tokens: c.usage.inputTokens || 0, completion_tokens: c.usage.outputTokens || 0, total_tokens: c.usage.totalTokens || 0 } : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
  let sentRole = false;
  let tcIdx = 0;

  for await (const ev of parseEvents(ccRes)) {
    let chunk = null;
    if (ev.type === "error") {
      const errMsg = (ev.error && ev.error.message) || "CC API error";
      res.write("data: " + JSON.stringify({ id: rid, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model, choices: [{ index: 0, delta: { content: "[Error: " + errMsg + "]" }, finish_reason: "stop" }] }) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    if (ev.type === "text-delta") {
      const delta = { content: ev.text || "" };
      if (!sentRole) { delta.role = "assistant"; sentRole = true; }
      chunk = { id: rid, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model, choices: [{ index: 0, delta: delta, finish_reason: null }] };
    } else if (ev.type === "tool-input-start") {
      if (!sentRole) sentRole = true;
      const id = ev.id || ev.toolCallId || "call_" + tcIdx;
      chunk = { id: rid, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model,
        choices: [{ index: 0, delta: { ...(tcIdx === 0 ? { role: "assistant" } : {}), tool_calls: [{ index: tcIdx, id: id, type: "function", function: { name: ev.toolName || "", arguments: "" } }] }, finish_reason: null }]
      };
    } else if (ev.type === "tool-input-delta") {
      const partial = ev.delta || ev.inputTextDelta || "";
      if (partial) {
        chunk = { id: rid, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model,
          choices: [{ index: 0, delta: { tool_calls: [{ index: tcIdx, function: { arguments: partial } }] }, finish_reason: null }]
        };
      }
    } else if (ev.type === "tool-input-end") {
      tcIdx++;
    } else if (ev.type === "tool-call") {
      if (!sentRole) sentRole = true;
      const args = typeof ev.args === "string" ? ev.args : JSON.stringify(ev.args || ev.input || {});
      chunk = { id: rid, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model,
        choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: tcIdx, id: ev.toolCallId || "call_" + tcIdx, type: "function", function: { name: ev.toolName, arguments: args } }] }, finish_reason: null }]
      };
      tcIdx++;
    } else if (ev.type === "finish") {
      const fr = ev.finishReason === "length" ? "length" : ev.finishReason === "tool-calls" ? "tool_calls" : "stop";
      chunk = { id: rid, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: model,
        choices: [{ index: 0, delta: {}, finish_reason: fr }],
        ...(ev.totalUsage ? { usage: { prompt_tokens: ev.totalUsage.inputTokens || 0, completion_tokens: ev.totalUsage.outputTokens || 0, total_tokens: ev.totalUsage.totalTokens || 0 } } : {})
      };
    }
    if (chunk) res.write("data: " + JSON.stringify(chunk) + "\n\n");
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

async function handleAnthropicMessages(body, res) {
  let { messages, systemPrompt } = extractAnthropicMessages(body);
  const requestedModel = body.model || "claude-sonnet-4-6";
  const model = resolveModel(requestedModel);
  const responseModel = preserveModelName(requestedModel, model);
  const rid = "msg_" + randomUUID().replace(/-/g, "").slice(0, 24);
  const rawTools = body.tools || [];
  const tools = rawTools
    .filter(t => {
      if (!t.name) return false;
      if (!t.input_schema || typeof t.input_schema !== "object") return false;
      const tp = (t.type || "").toLowerCase();
      if (tp && tp !== "custom") return false;
      const nm = t.name.toLowerCase();
      if (nm.startsWith("web_search") || nm.startsWith("web_fetch")) return false;
      return true;
    })
    .map(t => ({
      name: t.name, description: t.description || "", input_schema: t.input_schema
    }));

  // Vision pre-processing: images → Kimi description → DeepSeek coding
  const vp = await visionPreprocess(messages);
  if (vp.usedVision) messages = vp.messages;

  console.log("[Anthropic] model=" + requestedModel + " -> " + model + " tools=" + tools.length + " stream=" + !!body.stream + " msgs=" + messages.length + (vp.usedVision ? " [vision-preprocessed]" : ""));
  const ccBody = buildCCBody(model, messages, systemPrompt, {
    tools: tools, max_tokens: body.max_tokens || 8192, temperature: body.temperature,
  });
  const ccRes = await fetchCC(ccBody);

  if (!body.stream) {
    const c = await collectFull(ccRes);
    const content = [];
    if (c.reasoning) content.push({ type: "thinking", thinking: c.reasoning });
    if (c.text) content.push({ type: "text", text: c.text });
    for (const tc of c.toolCalls) {
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input: typeof tc.arguments === "string" ? JSON.parse(tc.arguments) : tc.arguments });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: rid, type: "message", role: "assistant", model: responseModel, content: content,
      stop_reason: c.finishReason === "length" ? "max_tokens" : c.finishReason === "tool-calls" ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: c.usage ? { input_tokens: c.usage.inputTokens || 0, output_tokens: c.usage.outputTokens || 0 } : { input_tokens: 0, output_tokens: 0 }
    }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });

  res.write("event: message_start\ndata: " + JSON.stringify({
    type: "message_start",
    message: { id: rid, type: "message", role: "assistant", model: responseModel, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } }
  }) + "\n\n");

  let cbIdx = 0;
  let inText = false;
  let inThink = false;
  let outTok = 0;

  for await (const ev of parseEvents(ccRes)) {
    if (ev.type === "error") {
      const errMsg = (ev.error && ev.error.message) || "CC API error";
      res.write("event: error\ndata: " + JSON.stringify({ type: "error", error: { type: "api_error", message: errMsg } }) + "\n\n");
      res.end();
      return;
    }
    if (ev.type === "reasoning-delta" && ev.text) {
      if (!inThink) {
        res.write("event: content_block_start\ndata: " + JSON.stringify({ type: "content_block_start", index: cbIdx, content_block: { type: "thinking", thinking: "" } }) + "\n\n");
        inThink = true;
      }
      res.write("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: cbIdx, delta: { type: "thinking_delta", thinking: ev.text } }) + "\n\n");
    } else if (ev.type === "reasoning-end") {
      if (inThink) {
        res.write("event: content_block_stop\ndata: " + JSON.stringify({ type: "content_block_stop", index: cbIdx }) + "\n\n");
        cbIdx++; inThink = false;
      }
    } else if (ev.type === "text-delta" && ev.text) {
      if (!inText) {
        res.write("event: content_block_start\ndata: " + JSON.stringify({ type: "content_block_start", index: cbIdx, content_block: { type: "text", text: "" } }) + "\n\n");
        inText = true;
      }
      res.write("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: cbIdx, delta: { type: "text_delta", text: ev.text } }) + "\n\n");
    } else if (ev.type === "text-end") {
      if (inText) {
        res.write("event: content_block_stop\ndata: " + JSON.stringify({ type: "content_block_stop", index: cbIdx }) + "\n\n");
        cbIdx++; inText = false;
      }
    } else if (ev.type === "tool-input-start") {
      if (inText) { res.write("event: content_block_stop\ndata: " + JSON.stringify({ type: "content_block_stop", index: cbIdx }) + "\n\n"); cbIdx++; inText = false; }
      const toolId = ev.id || ev.toolCallId || "toolu_" + cbIdx;
      res.write("event: content_block_start\ndata: " + JSON.stringify({ type: "content_block_start", index: cbIdx, content_block: { type: "tool_use", id: toolId, name: ev.toolName || "", input: {} } }) + "\n\n");
    } else if (ev.type === "tool-input-delta") {
      const partial = ev.delta || ev.inputTextDelta || "";
      if (partial) res.write("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: cbIdx, delta: { type: "input_json_delta", partial_json: partial } }) + "\n\n");
    } else if (ev.type === "tool-input-end") {
      res.write("event: content_block_stop\ndata: " + JSON.stringify({ type: "content_block_stop", index: cbIdx }) + "\n\n");
      cbIdx++;
    } else if (ev.type === "tool-call") {
      if (inText) { res.write("event: content_block_stop\ndata: " + JSON.stringify({ type: "content_block_stop", index: cbIdx }) + "\n\n"); cbIdx++; inText = false; }
      const inp = typeof ev.args === "string" ? JSON.parse(ev.args) : (ev.args || ev.input || {});
      const toolId = ev.toolCallId || "toolu_" + cbIdx;
      res.write("event: content_block_start\ndata: " + JSON.stringify({ type: "content_block_start", index: cbIdx, content_block: { type: "tool_use", id: toolId, name: ev.toolName, input: {} } }) + "\n\n");
      res.write("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: cbIdx, delta: { type: "input_json_delta", partial_json: JSON.stringify(inp) } }) + "\n\n");
      res.write("event: content_block_stop\ndata: " + JSON.stringify({ type: "content_block_stop", index: cbIdx }) + "\n\n");
      cbIdx++;
    } else if (ev.type === "finish-step") {
      outTok = (ev.usage && ev.usage.outputTokens) || outTok;
    } else if (ev.type === "finish") {
      if (inText) { res.write("event: content_block_stop\ndata: " + JSON.stringify({ type: "content_block_stop", index: cbIdx }) + "\n\n"); inText = false; }
      if (inThink) { res.write("event: content_block_stop\ndata: " + JSON.stringify({ type: "content_block_stop", index: cbIdx }) + "\n\n"); inThink = false; }
      const sr = ev.finishReason === "length" ? "max_tokens" : ev.finishReason === "tool-calls" ? "tool_use" : "end_turn";
      res.write("event: message_delta\ndata: " + JSON.stringify({ type: "message_delta", delta: { stop_reason: sr, stop_sequence: null }, usage: { output_tokens: (ev.totalUsage && ev.totalUsage.outputTokens) || outTok } }) + "\n\n");
      res.write("event: message_stop\ndata: " + JSON.stringify({ type: "message_stop" }) + "\n\n");
    }
  }
  res.end();
}

const ALL_MODELS = [
  { id: "claude-sonnet-4-6", provider: "anthropic", cat: "premium" },
  { id: "claude-sonnet-4-20250514", provider: "anthropic", cat: "premium" },
  { id: "claude-opus-4-7", provider: "anthropic", cat: "premium" },
  { id: "claude-opus-4-6", provider: "anthropic", cat: "premium" },
  { id: "claude-haiku-4-5-20251001", provider: "anthropic", cat: "premium" },
  { id: "gpt-5.5", provider: "openai", cat: "premium" },
  { id: "gpt-5.4", provider: "openai", cat: "premium" },
  { id: "gpt-5.4-mini", provider: "openai", cat: "premium" },
  { id: "gpt-5.3-codex", provider: "openai", cat: "premium" },
  { id: "deepseek/deepseek-v4-pro", provider: "gateway", cat: "opensource" },
  { id: "deepseek/deepseek-v4-flash", provider: "gateway", cat: "opensource" },
  { id: "moonshotai/Kimi-K2.5", provider: "gateway", cat: "opensource" },
  { id: "moonshotai/Kimi-K2.6", provider: "gateway", cat: "opensource" },
  { id: "zai-org/GLM-5", provider: "baseten", cat: "opensource" },
  { id: "zai-org/GLM-5.1", provider: "gateway", cat: "opensource" },
  { id: "MiniMaxAI/MiniMax-M2.5", provider: "baseten", cat: "opensource" },
  { id: "MiniMaxAI/MiniMax-M2.7", provider: "gateway", cat: "opensource" },
  { id: "Qwen/Qwen3.6-Max-Preview", provider: "gateway", cat: "opensource" },
  { id: "Qwen/Qwen3.6-Plus", provider: "gateway", cat: "opensource" },
  { id: "stepfun/Step-3.5-Flash", provider: "openrouter", cat: "opensource" },
];

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve({}); } });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  console.log("[REQ] " + req.method + " " + req.url);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, anthropic-version");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const path = new URL(req.url, "http://localhost:" + PORT).pathname;

  // Auth check: require valid API key on all /v1/* endpoints
  if (path.startsWith("/v1/")) {
    const authHeader = req.headers["authorization"] || "";
    const xApiKey = req.headers["x-api-key"] || "";
    const token = authHeader.replace(/^Bearer\s+/i, "") || xApiKey;
    if (token !== PROXY_API_KEY) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Invalid API key", type: "authentication_error", code: 401 } }));
      return;
    }
  }

  // Normalize path: Claude Code with ANTHROPIC_BASE_URL=.../v1 will call /v1/v1/messages
  let rpath = path.replace(/^\/v1\/v1\//, "/v1/");

  // HEAD requests (Claude Code health check)
  if (req.method === "HEAD") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end();
    return;
  }

  try {
    if (rpath === "/v1/chat/completions" && req.method === "POST") {
      const body = await readBody(req);
      console.log("[OpenAI] model=" + (body.model || "default") + " stream=" + !!body.stream + " msgs=" + (body.messages || []).length);
      await handleOpenAIChat(body, res);
      return;
    }

    if (rpath === "/v1/models" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: ALL_MODELS.map(m => ({ id: m.id, object: "model", created: 1700000000, owned_by: m.provider })) }));
      return;
    }

    // Anthropic messages endpoint: /v1/messages or /messages (Claude Code may call either)
    if ((rpath === "/v1/messages" || rpath === "/messages") && req.method === "POST") {
      const body = await readBody(req);
      console.log("[Anthropic] model=" + (body.model || "default") + " stream=" + !!body.stream + " msgs=" + (body.messages || []).length);
      await handleAnthropicMessages(body, res);
      return;
    }

    if (path === "/" || path === "/health") {
      let whoami = null;
      let credits = null;
      try {
        whoami = await fetch(CC_API_BASE + "/alpha/whoami", { headers: { "Authorization": "Bearer " + API_KEY } }).then(r => r.json());
        credits = await fetch(CC_API_BASE + "/alpha/billing/credits", { headers: { "Authorization": "Bearer " + API_KEY } }).then(r => r.json());
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok", proxy: "commandcode-proxy", version: "1.0.0",
        endpoints: { openai_chat: "/v1/chat/completions", openai_models: "/v1/models", anthropic_messages: "/v1/messages" },
        user: (whoami && whoami.user) || null,
        credits: (credits && credits.credits) || null,
        models: ALL_MODELS.map(m => m.id + " (" + m.cat + ")")
      }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    console.error("[ERROR]", err.message || err);
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: err.message || "Proxy error", type: "proxy_error" } }));
  }
});

server.listen(PORT, HOST, () => {
  const base = process.env.PROXY_PUBLIC_URL || "http://localhost:" + PORT;
  console.log("");
  console.log("  CommandCode AI Proxy v1.0.0");
  console.log("  ===========================");
  console.log("  Listening on " + HOST + ":" + PORT);
  console.log("  Auth: ENABLED (API key required)");
  console.log("");
  console.log("  Cursor settings:");
  console.log("    Base URL : " + base + "/v1");
  console.log("    API Key  : " + PROXY_API_KEY.slice(0, 8) + "..." + PROXY_API_KEY.slice(-4));
  console.log("");
  console.log("  Claude Code:");
  console.log("    ANTHROPIC_BASE_URL=" + base + "/v1");
  console.log("    ANTHROPIC_API_KEY=<your PROXY_API_KEY>");
  console.log("");
});
