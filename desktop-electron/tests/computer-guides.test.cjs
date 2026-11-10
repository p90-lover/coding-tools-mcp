"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { appKey, createComputerGuides, GUIDE_TOOL_DEFS, TOPICS } = require("../electron/computer-guides.cjs");

test("an app is named by its program, whatever form the agent gives", () => {
  assert.equal(appKey("C:\\Program Files\\Google\\Chrome\\Application\\Chrome.EXE"), "chrome");
  assert.equal(appKey("notepad.exe"), "notepad");
  assert.equal(appKey("Notepad"), "notepad");
  assert.equal(appKey("..\\..\\secrets"), "secrets", "only the base name, so a note is always a file in the notes folder");
  assert.equal(appKey(""), null);
  assert.equal(appKey("<script>"), null);
  assert.deepEqual(GUIDE_TOOL_DEFS[0].inputSchema.properties.topic.enum, [...TOPICS]);
});

test("the guide teaches the loop, each method's parameters, how to find a control and the browser's quick routes", async () => {
  const guides = createComputerGuides();
  const workflow = await guides.guide();
  assert.match(workflow, /computer_select_window \{window_id, pid\}: the person is asked/);
  assert.match(workflow, /returns only once they answered/);
  assert.match(workflow, /APPROVAL_DECLINED/);
  const methods = await guides.guide({ topic: "methods" });
  for (const method of ["get_window_state", "click", "set_value", "type_text", "press_key", "scroll", "drag", "perform_secondary_action", "activate_window"]) {
    assert.match(methods, new RegExp(`^- ${method} \\{`, "m"), method);
  }
  assert.match(await guides.guide({ topic: "locate" }), /1\. Accessibility index[\s\S]*2\. UI Automation[\s\S]*3\. Vision/);
  assert.match(await guides.guide({ topic: "browser" }), /preview_read/);
  assert.match(await guides.guide({ topic: "keys" }), /Control_L/);
  await assert.rejects(guides.guide({ topic: "everything" }), /topic must be one of/);
  await assert.rejects(guides.guide({ app: "<script>" }), /app must be a program name/);
});

test("the person's notes for an app or a topic join the built-in guide, read fresh on each call", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "computer-guides-"));
  try {
    const guides = createComputerGuides({ notesDir: folder, logger: { warn() {} } });
    const unknown = await guides.guide({ app: "acme-editor" });
    assert.match(unknown, /## acme-editor\nNothing specific is known/);
    assert.doesNotMatch(unknown, /The person's notes:/);

    fs.writeFileSync(path.join(folder, "chrome.md"), "Use the Work profile, never Personal.");
    fs.writeFileSync(path.join(folder, "locate.md"), "Prefer automation ids in our app.");
    fs.writeFileSync(path.join(folder, "huge.md"), "x".repeat(20_000));
    const chrome = await guides.guide({ topic: "locate", app: "Chrome.exe" });
    assert.match(chrome, /## The person's notes on locate\nPrefer automation ids/);
    assert.match(chrome, /## chrome\nThis is a web browser/);
    assert.match(chrome, /## The person's notes on chrome\nUse the Work profile, never Personal\./);
    assert.match(chrome, /The person's notes: chrome, huge, locate\./);
    const huge = await guides.guide({ app: "huge" });
    assert.match(huge, /\(cut at 16 KB\)/);
    assert.ok(huge.length < 20_000);

    const brief = await guides.brief("C:\\Windows\\notepad.exe");
    assert.match(brief, /^Notepad: the document is one large edit element/);
    assert.match(brief, /computer_guide \{app: "notepad"\}/);
    assert.match(await guides.brief("chrome.exe"), /The person's notes on chrome: Use the Work profile/);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
