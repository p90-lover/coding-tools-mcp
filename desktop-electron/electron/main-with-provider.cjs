"use strict";

const fs = require("node:fs");
const path = require("node:path");
const electron = require("electron");
const { installProviderNetwork } = require("./provider-bootstrap.cjs");
const { resolveLauncherProfile } = require("./profile.cjs");

const launcherProfile = resolveLauncherProfile({
  appData: electron.app.getPath("appData"),
});
const integrationsHome = path.join(launcherProfile.userData, "integrations");
const aiTempHome = path.join(integrationsHome, "aiTemp");
const trashHome = path.join(integrationsHome, "Trash");

fs.mkdirSync(aiTempHome, { recursive: true, mode: 0o700 });
fs.mkdirSync(trashHome, { recursive: true, mode: 0o700 });
if (process.platform !== "win32") {
  fs.chmodSync(aiTempHome, 0o700);
  fs.chmodSync(trashHome, 0o700);
}
process.env.CODING_TOOLS_INTEGRATIONS_HOME = integrationsHome;

installProviderNetwork(electron);
require("./main.cjs");
