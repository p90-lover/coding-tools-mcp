const assert = require("node:assert/strict");
const test = require("node:test");

const { isAppMainProcess } = require("../scripts/patch-portable.cjs");

test("the patch waits for the app window, not the bridge's browser helper or Chromium children", () => {
  // Seen live: the oldest Coding Tools.exe was the bridge's helper, which outlives the app, so the
  // patch worker waited on it and timed out without applying anything.
  assert.equal(isAppMainProcess('"G:\\Apps\\Coding Tools\\Coding Tools.exe"'), true);
  assert.equal(isAppMainProcess('"G:\\Apps\\Coding Tools\\Coding Tools.exe" --profile-directory=Default'), true);
  assert.equal(isAppMainProcess('"G:\\Apps\\Coding Tools\\Coding Tools.exe" G:\\AppData\\.coding-tools\\versions\\0.7.0-rc.16-win32-x64\\app\\browser-helper.cjs'), false);
  assert.equal(isAppMainProcess('"G:\\Apps\\Coding Tools\\Coding Tools.exe" C:\\x\\worker.mjs'), false);
  assert.equal(isAppMainProcess('"G:\\Apps\\Coding Tools\\Coding Tools.exe" --type=renderer --user-data-dir=x'), false);
  assert.equal(isAppMainProcess(null), true, "an unreadable command line is not excluded");
});
