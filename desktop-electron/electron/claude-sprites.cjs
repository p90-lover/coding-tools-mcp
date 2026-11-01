"use strict";

// Clawd as Claude draws him: the chat pet asks for the sprite sheets of the Claude desktop app
// installed on this computer (its "Clawd Quest" engine, inside Claude's app.asar) and draws those.
// Nothing of Claude's is copied into this app or its repository; without Claude installed, or if
// its bundle changes shape, the pet keeps its own drawing. Read-only, once per app run.

const fs = require("node:fs");
const path = require("node:path");

/** The sprites the pet uses, by what it does with them. */
const WANTED = ["Walking", "Running", "Laptop", "Desktop", "Thinking", "Lightbulb", "Spark", "Waving", "Pointing",
  "JumpingHappy", "Jumping", "DancingHappy", "Excited", "Disappointed", "Facepalm", "Dizzy", "Meditating",
  "LookingAround", "LookingAroundEyesOnly", "Swaying", "Turning"];
// One sprite in the engine's catalog, read where its name starts:
// Name:{cat:"Core",w:24,h:17,fps:12,palette:[…],base:"…",deltas:[…],a0:[…]}
// Its frames ("deltas") come as an array of strings, or as one string split on "(".
const ENTRY = /\{cat:"(\w+)",w:(\d+),h:(\d+),fps:(\d+),palette:(\[[^\]]*\]),base:"([^"]*)",deltas:(\[[^\]]*\]|"[^"]*"\.split\("\("\)),a0:(\[[^\]]*\])/y;
const readDeltas = (raw) => raw.startsWith("[") ? JSON.parse(raw) : JSON.parse(raw.slice(0, raw.indexOf(".split("))).split("(");

/** The newest installed Claude desktop app's engine bundle, or null. */
function findClaudeEngine({ localAppData = process.env.LOCALAPPDATA, fsImpl = fs } = {}) {
  if (!localAppData) return null;
  const root = path.join(localAppData, "AnthropicClaude");
  let versions;
  try { versions = fsImpl.readdirSync(root).filter((name) => /^app-\d/.test(name)); } catch { return null; }
  const byVersion = (name) => name.slice(4).split(".").map((part) => Number(part) || 0);
  versions.sort((a, b) => {
    const left = byVersion(a), right = byVersion(b);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      if ((left[index] ?? 0) !== (right[index] ?? 0)) return (right[index] ?? 0) - (left[index] ?? 0);
    }
    return 0;
  });
  for (const version of versions) {
    // Electron reads inside app.asar as a folder.
    const assets = path.join(root, version, "resources", "app.asar", ".vite", "renderer", "main_window", "assets");
    try {
      const engine = fsImpl.readdirSync(assets).find((name) => /^clawdQuestEngine-[\w-]+\.js$/.test(name));
      if (engine) return path.join(assets, engine);
    } catch { /* this version has no engine; try an older one */ }
  }
  return null;
}

/** The wanted sprites from an engine bundle's source, checked; {} when it holds none we can read. */
function parseClawdSprites(source) {
  const sprites = {};
  const text = String(source);
  // Each wanted sprite is looked up by its name (a name can appear more than once; the first entry
  // that reads wins). One scan of the whole bundle lost entries to unrelated text in between.
  for (const name of WANTED) {
    for (let at = text.indexOf(`${name}:{cat:`); at >= 0 && !sprites[name]; at = text.indexOf(`${name}:{cat:`, at + 1)) {
      ENTRY.lastIndex = at + name.length + 1;
      const match = ENTRY.exec(text);
      if (!match) continue;
      const [, , w, h, fps, palette, base, deltas, a0] = match;
      try {
        const sprite = { w: Number(w), h: Number(h), fps: Number(fps), palette: JSON.parse(palette), base, deltas: readDeltas(deltas), a0: JSON.parse(a0) };
        const valid = sprite.w > 0 && sprite.w <= 64 && sprite.h > 0 && sprite.h <= 64 && base.length === sprite.w * sprite.h
          && /^[.0-9a-z]+$/.test(base) && sprite.palette.every((color) => /^#[0-9a-f]{6}$/i.test(color))
          && sprite.deltas.every((delta) => typeof delta === "string" && /^[.0-9a-z,]*$/.test(delta)) && sprite.a0.length === 4;
        if (valid) sprites[name] = sprite;
      } catch { /* a sprite that does not read is left out */ }
    }
  }
  return sprites;
}

let cached;
/** Claude's Clawd sprites, read once: { source: "claude", sprites } or { source: "none", sprites: {} }. */
function loadClawdSprites(options = {}) {
  if (cached && !options.fresh) return cached;
  const engine = findClaudeEngine(options);
  let sprites = {};
  if (engine) {
    try { sprites = parseClawdSprites((options.fsImpl ?? fs).readFileSync(engine, "utf8")); } catch { sprites = {}; }
  }
  // Walking is the one the pet cannot do without.
  cached = sprites.Walking ? { source: "claude", sprites } : { source: "none", sprites: {} };
  return cached;
}

module.exports = { WANTED, findClaudeEngine, parseClawdSprites, loadClawdSprites };
