"use strict";

const fs = require("node:fs");
const path = require("node:path");

function prepareBrowserDebugging(app) {
  if (app.isReady()) throw new Error("Browser automation must be configured before Electron is ready.");
  const portFile = path.join(app.getPath("userData"), "DevToolsActivePort");
  let previous;
  try { previous = fs.readFileSync(portFile, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }

  // Chromium must receive these before startup yields to runtime preparation.
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", "0");
  // The debugging port alone makes Chromium mark every page as automated (navigator.webdriver is
  // true), which Cloudflare treats as a bot and answers with its "Just a moment..." check (11-03).
  app.commandLine.appendSwitch("disable-blink-features", "AutomationControlled");
  return async () => {
    await app.whenReady();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      let current;
      try { current = await fs.promises.readFile(portFile, "utf8"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (current !== undefined && current !== previous) {
        const record = /^([1-9]\d{0,4})\r?\n\/devtools\/browser\/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\r?\n?$/i.exec(current);
        if (!record || Number(record[1]) > 65535) {
          throw new Error("The browser automation port record is invalid. Restart Coding Tools.");
        }
        return Number(record[1]);
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error("The browser automation endpoint did not start. Restart Coding Tools.");
  };
}

module.exports = { prepareBrowserDebugging };
