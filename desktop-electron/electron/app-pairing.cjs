"use strict";

// Connect an app: another program on this PC (SHA, Shadow SHA) asks chat-agent-tools' loopback server
// to pair (POST /apps/pair). The person answers in Coding Tools' own window, which names the program that
// asked, found from the connection itself, and offers the projects it may use. Nothing is allowed
// without that answer, and the app never chooses its own project. Computer use for a connected app is
// asked the same way, per app, since an app has no chat card.

const { execFile } = require("node:child_process");
const path = require("node:path");

const MAX_PROJECTS = 6;

// The process holding the client end of a loopback connection: netstat lists established connections
// reliably (unlike listeners on some Windows builds). Local 127.0.0.1:<peer> → foreign 127.0.0.1:<server>.
function requesterPid(netstat, peerPort, serverPort) {
  for (const line of String(netstat).split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0] !== "TCP") continue;
    const [, local, foreign, , pid] = parts;
    if (local === `127.0.0.1:${peerPort}` && foreign === `127.0.0.1:${serverPort}`) {
      const value = Number(pid);
      return Number.isInteger(value) && value > 0 ? value : null;
    }
  }
  return null;
}

function runNetstat() {
  return new Promise((resolve) => {
    execFile("netstat.exe", ["-ano", "-p", "TCP"], { windowsHide: true, timeout: 10_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolve(error ? "" : String(stdout)));
  });
}

const oneLine = (value, limit = 200) => String(value ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, limit);

function createAppPairing({ dialog, getWindow, listProjects, processInfo, netstat = runNetstat, logger = null }) {
  let asking = Promise.resolve();
  // One question at a time: a second prompt never lands on top of one the person has not read.
  function serial(question) {
    const next = asking.then(question, question);
    asking = next.catch(() => undefined);
    return next;
  }

  function ownerWindow() {
    const window = getWindow?.();
    if (!window || window.isDestroyed?.()) return null;
    // Asked in front: the request came from a program the person just opened.
    if (window.isMinimized?.()) window.restore?.();
    window.show?.();
    window.focus?.();
    return window;
  }

  /** { id, name, peerPort, serverPort } → { workspaceId, root, project, program } or null. */
  async function pair({ id, name, peerPort, serverPort }) {
    const pid = requesterPid(await netstat(), peerPort, serverPort);
    if (!pid) { logger?.warn?.("app_pairing.requester_unknown", { app: id }); return null; }
    const info = await processInfo(pid).catch(() => null);
    const program = info?.executablePath && path.win32.isAbsolute(info.executablePath) ? info.executablePath : null;
    if (!program) { logger?.warn?.("app_pairing.program_unknown", { app: id }); return null; }
    const projects = (await Promise.resolve().then(listProjects).catch(() => []))
      .filter((project) => typeof project?.id === "string" && typeof project?.path === "string" && path.isAbsolute(project.path))
      .slice(0, MAX_PROJECTS);
    if (!projects.length) { logger?.warn?.("app_pairing.no_projects", { app: id }); return null; }
    return serial(async () => {
      const window = ownerWindow();
      if (!window) return null;
      const labels = projects.map((project) => oneLine(project.name || path.basename(project.path), 40));
      const { response } = await dialog.showMessageBox(window, {
        type: "question",
        title: "Coding Tools",
        message: `Connect ${oneLine(name, 60)} to Coding Tools?`,
        detail: `Program: ${oneLine(program, 300)}\n\n`
          + "It gets its own key for the project you choose: files and commands in that folder (commands ask you, as in chats) "
          + "and computer use (each app it wants to use asks you first). It never sees your chats. "
          + "Disconnect it any time in Settings > Computer use > Connected apps.\n\nChoose the project, or Don't allow.",
        buttons: [...labels, "Don't allow"],
        defaultId: labels.length,
        cancelId: labels.length,
        noLink: true,
      });
      const project = projects[response];
      if (!project) { logger?.info?.("app_pairing.denied", { app: id }); return null; }
      logger?.info?.("app_pairing.allowed", { app: id });
      return { workspaceId: project.id, root: project.path, project: oneLine(project.name || project.path, 200), program };
    });
  }

  /** computer-control's promptApp: "always" | "conversation" | "deny". */
  function promptComputer({ agent, app, window: title, project, captureOff, signal }) {
    return serial(async () => {
      if (signal?.aborted) return "deny";
      const window = ownerWindow();
      if (!window) return "deny";
      const { response } = await dialog.showMessageBox(window, {
        type: "question",
        title: "Coding Tools",
        message: `Allow ${oneLine(agent, 60)} to use ${oneLine(app, 80)}?`,
        detail: `${title ? `Window: ${oneLine(title, 200)}\n` : ""}Project: ${oneLine(project, 120)}\n\n`
          + `${oneLine(agent, 60)} is a connected app. It will see this app's windows and can click and type in them while the control bar shows.`
          + (captureOff ? " Screen capture turns on for this project." : ""),
        buttons: ["Always allow", "Allow until it disconnects", "Don't allow"],
        defaultId: 2,
        cancelId: 2,
        noLink: true,
      });
      return response === 0 ? "always" : response === 1 ? "conversation" : "deny";
    });
  }

  return { pair, promptComputer };
}

module.exports = { createAppPairing, requesterPid };
