const test = require("node:test");
const assert = require("node:assert/strict");
const { browsableUrl, cleanUserAgent } = require("../electron/browser-url.cjs");

// From gpt-browser.test.cjs: the helpers outlived the GPT Browser (2026-11-13).
test("the address bar accepts any http(s) site and defaults bare addresses to https", () => {
  assert.equal(browsableUrl("https://chatgpt.com/accept-referral?referral_context=abc"), "https://chatgpt.com/accept-referral?referral_context=abc");
  assert.equal(browsableUrl("  example.com/docs?q=1  "), "https://example.com/docs?q=1");
  assert.equal(browsableUrl("http://localhost:5173/"), "http://localhost:5173/");
  assert.equal(browsableUrl("127.0.0.1:8080"), "https://127.0.0.1:8080/");
  assert.equal(browsableUrl("HTTPS://Chatgpt.COM"), "https://chatgpt.com/");
  for (const bad of ["javascript:alert(1)", "file:///C:/Windows/win.ini", "data:text/html,x", "ftp://example.com/",
    "https://a:b@chatgpt.com/", "https://foo", "two words.com", "", null, `https://example.com/${"x".repeat(5000)}`]) {
    assert.equal(browsableUrl(bad), null, String(bad));
  }
});

test("the Electron and app tokens are removed from the sign-in user agent", () => {
  assert.equal(cleanUserAgent("Mozilla/5.0 Chrome/140.0 Electron/41.10.7 coding-tools-desktop/0.7.0 Safari/537.36"), "Mozilla/5.0 Chrome/140.0 Safari/537.36");
  // The app name Electron puts in the agent (seen live on 0.8.81).
  assert.equal(cleanUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) CodingTools/0.8.81 Chrome/156.0.8078.75 Safari/537.36"),
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.8078.75 Safari/537.36");
});
