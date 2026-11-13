const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { BLOCKED_URLS, blockChatGptTelemetry } = require("../electron/chatgpt-telemetry-block.cjs");

function fakeSession() {
  const calls = [];
  return { calls, webRequest: { onBeforeRequest: (filter, handler) => calls.push({ filter, handler }) } };
}

test("ChatGPT's experiment and analytics hosts are cancelled, once per session", () => {
  const session = fakeSession();
  assert.equal(blockChatGptTelemetry(session), true);
  assert.equal(blockChatGptTelemetry(session), false, "a second view on the same account adds nothing");
  assert.equal(session.calls.length, 1);
  assert.deepEqual(session.calls[0].filter, { urls: BLOCKED_URLS });
  let answer;
  session.calls[0].handler({ url: "https://ab.chatgpt.com/v1/initialize" }, (value) => { answer = value; });
  assert.deepEqual(answer, { cancel: true });
});

test("only those hosts are listed: ChatGPT itself and Cloudflare's check stay reachable", () => {
  const patterns = BLOCKED_URLS.map((glob) => new RegExp(`^${glob.replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`));
  const blocked = (url) => patterns.some((pattern) => pattern.test(url));
  for (const url of ["https://ab.chatgpt.com/v1/initialize", "https://oaistatsig.com/x", "https://events.oaistatsig.com/rgstr"]) assert.ok(blocked(url), url);
  for (const url of ["https://chatgpt.com/", "https://chatgpt.com/backend-api/me", "https://cdn.oaistatic.com/assets/app.js",
    "https://challenges.cloudflare.com/turnstile/v0/api.js", "https://chatgpt.com/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1",
    "https://auth.openai.com/log-in"]) assert.equal(blocked(url), false, url);
});

test("a session without webRequest (a test stand-in) is left alone", () => {
  assert.equal(blockChatGptTelemetry({}), false);
  assert.equal(blockChatGptTelemetry(null), false);
});

test("every Browser tab view blocks them (the GPT Browser, which did too, is gone)", () => {
  const read = (name) => fs.readFileSync(path.join(__dirname, "..", "electron", name), "utf8");
  const host = read("browser-host.cjs");
  assert.equal((host.match(/signInFriendlyUserAgent\(view\.webContents\);\r?\n\s+blockChatGptTelemetry\(view\.webContents\.session\);/g) || []).length, 4);
  assert.equal(fs.existsSync(path.join(__dirname, "..", "electron", "gpt-browser.cjs")), false);
});
