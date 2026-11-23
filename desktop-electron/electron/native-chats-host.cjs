"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const unavailable = Object.freeze({ available: false, ready: false, engine: "orchestrator-native", contractVersion: 1 });
const within = (parent, child) => {
  const relative = path.relative(parent, child);
  return Boolean(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

function createNativeChatsHost({ enabled, profileRoot, env = process.env } = {}) {
  const { CODING_TOOLS_CHATS_SOURCE: source, CODING_TOOLS_CHATS_ENDPOINT: endpoint, CODING_TOOLS_CHATS_PROTOCOL: protocol,
    CODING_TOOLS_CHATS_MODEL: model, CODING_TOOLS_CHATS_TOKEN: token } = env;
  const configured = enabled && typeof source === "string" && path.isAbsolute(source) && !!endpoint && protocol === "openai-completions" && !!model;
  let runtime, opening, closing = false;
  async function bind() {
    const profile = await fs.realpath(profileRoot);
    if (process.platform === "win32" && path.parse(profile).root.toUpperCase() === `${(env.SystemDrive || "C:").toUpperCase()}\\`) {
      throw new Error("The isolated Chats profile must be off the system drive");
    }
    const workspaceRoot = await fs.realpath(path.join(profile, "chats-workspace"));
    if (!within(profile, workspaceRoot) || !(await fs.stat(workspaceRoot)).isDirectory()) throw new Error("Choose a private chats-workspace inside the isolated profile");
    const sourceRoot = await fs.realpath(source);
    const entry = await fs.realpath(path.join(sourceRoot, "src", "chats-provider.cjs"));
    if (!within(sourceRoot, entry)) throw new Error("The Chats engine source must stay inside the trusted checkout");
    const dataRoot = path.join(profile, "native-chats");
    const existing = await fs.lstat(dataRoot).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || await fs.realpath(dataRoot) !== dataRoot)) throw new Error("Native Chats storage must not link outside its isolated profile");
    for (const name of existing ? await fs.readdir(dataRoot) : []) {
      const file = await fs.lstat(path.join(dataRoot, name));
      if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) throw new Error("Native Chats storage must contain only private regular files");
    }
    const { CHAT_CONTRACT_VERSION, createChatsProvider } = require(entry);
    if (CHAT_CONTRACT_VERSION !== 1 || typeof createChatsProvider !== "function") throw new Error("The selected Chats engine has an incompatible contract");
    runtime = createChatsProvider({ workspaceId: "native-chats", workspaceRoot, dataRoot, endpoint, protocol, model, token });
    return runtime;
  }
  return Object.freeze({
    async call(input) {
      if (["status", "open"].includes(input?.action) && Object.keys(input).length !== 1) throw new Error("Choose a supported native Chats action");
      if (input?.action === "status" && (!configured || closing)) return unavailable;
      if (!configured || closing) throw new Error("Native Chats requires a separately configured development profile");
      if (input?.action === "status") return runtime?.call("chats", input) ?? { ...unavailable, available: true, model };
      if (input?.action === "open" && !runtime) {
        opening ??= bind().catch(() => { throw new Error("Could not open the isolated native Chats binding; check the source and profile configuration"); }).finally(() => { opening = null; });
        await opening;
      }
      if (!runtime || closing) throw new Error("Open the native Chats workspace first");
      try { return await runtime.call("chats", input); }
      catch (error) {
        if (input?.action === "send" && ["CHATS_BUSY", "CHATS_INPUT", "CHATS_INPUT_ID", "CHATS_REATTACH_REQUIRED", "CHATS_SESSION_SCOPE", "CHATS_WORKSPACE_SCOPE"].includes(error?.code)) {
          return { rejected: true, reason: error.message };
        }
        throw new Error(typeof error?.code === "string" && /^CHATS_[A-Z_]+$/.test(error.code) ? error.message
          : "Native Chats could not confirm this operation. Check its receipt before sending anything again.");
      }
    },
    async close() {
      closing = true;
      await opening?.catch(() => {});
      await runtime?.close();
    },
  });
}

module.exports = { createNativeChatsHost };
