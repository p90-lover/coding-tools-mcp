"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));

const plain = (value) => JSON.parse(JSON.stringify(value));
const walk = (item) => !item || typeof item !== "object" ? [] : Array.isArray(item) ? item.flatMap(walk) : [item, ...walk(item.props?.children)];
const text = (item) => item === null || item === undefined || typeof item === "boolean" ? "" : typeof item !== "object" ? String(item)
  : Array.isArray(item) ? item.map(text).join("") : text(item.props?.children);

// A tiny hook runtime: state persists across renders by call order; effects are not run.
function mount(props) {
  const states = []; let cursor = 0;
  const react = {
    useState(initial) {
      const at = cursor++;
      if (!(at in states)) states[at] = typeof initial === "function" ? initial() : initial;
      return [states[at], (value) => { states[at] = typeof value === "function" ? value(states[at]) : value; }];
    },
    useEffect() {}, useRef: (initial) => ({ current: initial }),
  };
  const jsx = (type, props) => ({ type, props: props || {} });
  const exports = {};
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/ProjectEditDialog.tsx"), "utf8");
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText,
    { exports, document: { addEventListener() {}, removeEventListener() {} },
      require: (name) => name === "react" ? react : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : name === "./ChatMenu" ? { ChatGlyph: "Glyph" } : {} });
  return { exports, render: (next = {}) => { cursor = 0; return exports.ProjectEditDialog({ ...props, ...next }); } };
}

function fixture(extra = {}) {
  const calls = [];
  const picks = [];
  const props = {
    project: { id: "ws", name: "coding tools", path: "H:\\coding-tools-mcp", linkedProjects: [{ path: "G:\\Projects\\shared" }] },
    chooseFolder: async () => { calls.push(["choose"]); return picks.shift() ?? null; },
    onSave: async (change) => { calls.push(["save", plain(change)]); },
    onRemove: async () => { calls.push(["remove"]); },
    onClose: () => calls.push(["close"]),
    ...extra,
  };
  return { props, calls, picks };
}
const button = (tree, label) => walk(tree).find((element) => element.type === "button" && (element.props["aria-label"] === label || text(element).trim() === label));
// Click handlers start async work (`void save()`); let it settle before re-rendering.
const settle = () => new Promise((resolve) => setImmediate(resolve));
const folderRows = (tree) => walk(tree).filter((element) => element.type === "li" && element.props.className === "cx-folder-row");

test("Edit project matches Codex: title and ×, a name field with a folder icon, source folders, Add folder and the footer", () => {
  const { props } = fixture();
  const view = mount(props).render();
  const dialog = walk(view).find((element) => element.props?.role === "dialog");
  assert.equal(dialog.props["aria-modal"], "true");
  assert.equal(text(walk(view).find((element) => element.type === "h2")), "Edit project");
  assert.ok(button(view, "Close"), "a close × in the header");
  const field = walk(view).find((element) => element.props?.className === "cx-field-input");
  assert.equal(walk(field)[1].type, "Glyph", "the name field starts with a folder icon");
  assert.equal(walk(field).find((element) => element.type === "input").props.value, "coding tools");
  assert.match(text(view), /Source folders/);
  assert.deepEqual(folderRows(view).map((row) => [row.props.title, text(walk(row).find((element) => element.props?.className === "cx-folder-name"))]),
    [["H:\\coding-tools-mcp", "coding-tools-mcp"], ["G:\\Projects\\shared", "shared"]], "the primary folder first, each with its path as the tooltip");
  assert.ok(button(view, "Add folder"));
  const footer = walk(view).find((element) => element.type === "footer");
  assert.deepEqual(walk(footer).filter((element) => element.type === "button").map((element) => [text(element).trim(), element.props.className]),
    [["Remove local project", "cx-modal-button is-danger-soft"], ["Cancel", "cx-modal-button"], ["Save", "cx-modal-button is-primary"]]);
});

test("removing the primary folder makes the next one primary, and the last folder can't be removed", async () => {
  const { props, calls } = fixture();
  const dialog = mount(props);
  button(dialog.render(), "Remove coding-tools-mcp").props.onClick();
  const rows = folderRows(dialog.render());
  assert.deepEqual(rows.map((row) => row.props.title), ["G:\\Projects\\shared"]);
  assert.equal(button(dialog.render(), "Remove shared").props.disabled, true, "the list can't become empty");
  button(dialog.render(), "Save").props.onClick(); await settle();
  assert.deepEqual(calls, [["save", { name: "coding tools", path: "G:\\Projects\\shared", linkedPaths: [] }], ["close"]]);
});

test("Add folder uses the folder picker, refuses a folder already listed, and Save sends name and folders", async () => {
  const { props, calls, picks } = fixture();
  const dialog = mount(props);
  picks.push("g:\\projects\\SHARED", "G:\\Projects\\coding-tools-mcp");
  button(dialog.render(), "Add folder").props.onClick(); await settle();
  assert.match(text(walk(dialog.render()).find((element) => element.props?.role === "alert")), /SHARED is already listed/);
  button(dialog.render(), "Add folder").props.onClick(); await settle();
  button(dialog.render(), "Remove coding-tools-mcp").props.onClick();
  walk(dialog.render()).find((element) => element.type === "input").props.onChange({ target: { value: "  Coding Tools  " } });
  button(dialog.render(), "Save").props.onClick(); await settle();
  assert.deepEqual(calls, [["choose"], ["choose"],
    ["save", { name: "Coding Tools", path: "G:\\Projects\\shared", linkedPaths: ["G:\\Projects\\coding-tools-mcp"] }], ["close"]]);
});

test("a failed save keeps the dialog open with the service's reason; an unchanged Save just closes", async () => {
  const failing = fixture({ onSave: async () => { throw new Error("Another project already uses this folder as its project folder"); } });
  const dialog = mount(failing.props);
  walk(dialog.render()).find((element) => element.type === "input").props.onChange({ target: { value: "Renamed" } });
  button(dialog.render(), "Save").props.onClick(); await settle();
  assert.deepEqual(failing.calls, [], "not closed");
  assert.match(text(walk(dialog.render()).find((element) => element.props?.role === "alert")), /Another project already uses this folder/);
  assert.equal(button(dialog.render(), "Save").props.disabled, false, "Save can be retried");

  const unchanged = fixture();
  button(mount(unchanged.props).render(), "Save").props.onClick(); await settle();
  assert.deepEqual(unchanged.calls, [["close"]]);

  const empty = fixture();
  const blank = mount(empty.props);
  walk(blank.render()).find((element) => element.type === "input").props.onChange({ target: { value: "   " } });
  assert.equal(button(blank.render(), "Save").props.disabled, true, "a project needs a name");
});

test("Escape, the × and a click on the backdrop cancel; a click inside the card does not", () => {
  const { props, calls } = fixture();
  const dialog = mount(props);
  const view = dialog.render();
  const backdrop = walk(view).find((element) => element.props?.className === "cx-modal-backdrop");
  const card = walk(view).find((element) => element.props?.role === "dialog");
  backdrop.props.onMouseDown({ target: card, currentTarget: backdrop });
  assert.deepEqual(calls, []);
  backdrop.props.onMouseDown({ target: backdrop, currentTarget: backdrop });
  card.props.onKeyDown({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  card.props.onKeyDown({ key: "a", preventDefault() {}, stopPropagation() {} });
  button(view, "Close").props.onClick();
  assert.deepEqual(calls, [["close"], ["close"], ["close"]]);
});

test("Remove local project asks first, says no files are deleted, and removes on confirm", async () => {
  const { props, calls } = fixture();
  const dialog = mount(props);
  button(dialog.render(), "Remove local project").props.onClick();
  let view = dialog.render();
  assert.equal(text(walk(view).find((element) => element.type === "h2")), "Remove local project?");
  assert.match(text(view), /stay on disk and are not deleted/);
  assert.deepEqual(calls, [], "nothing is removed before the confirmation");
  button(view, "Cancel").props.onClick();
  assert.equal(text(walk(dialog.render()).find((element) => element.type === "h2")), "Edit project", "Cancel returns to the form");
  button(dialog.render(), "Remove local project").props.onClick();
  button(dialog.render(), "Remove").props.onClick(); await settle();
  assert.deepEqual(calls, [["remove"], ["close"]]);
});

test("opened from the sidebar's Remove project, the confirmation's Cancel closes; a refusal is shown", async () => {
  const refused = fixture({ initialStep: "remove", onRemove: async () => { throw new Error("Can't remove this project: a mission in this project is still running; stop it first"); } });
  const dialog = mount(refused.props);
  button(dialog.render(), "Remove").props.onClick(); await settle();
  assert.match(text(walk(dialog.render()).find((element) => element.props?.role === "alert")), /still running/);
  button(dialog.render(), "Cancel").props.onClick();
  assert.deepEqual(refused.calls, [["close"]]);
});

test("folder helpers: names, Windows case-insensitive matching and the primary-first order", () => {
  const { exports } = mount(fixture().props);
  assert.equal(exports.folderName("G:\\Projects\\coding-tools-mcp\\"), "coding-tools-mcp");
  assert.equal(exports.folderName("/home/me/app"), "app");
  assert.equal(exports.sameFolder("G:\\Projects\\App", "g:\\projects\\app\\"), true);
  assert.equal(exports.sameFolder("/home/App", "/home/app"), false);
  assert.deepEqual(plain(exports.projectFolders({ id: "x", name: "x", path: "C:\\a", linkedProjects: [{ path: "c:\\A" }, { path: "D:\\b" }] })), ["C:\\a", "D:\\b"]);
  assert.deepEqual(plain(exports.removeFolder(["C:\\a"], 0)), ["C:\\a"]);
});

test("the chat surface opens this dialog from Edit and Remove project, refreshes the list and leaves a removed open project", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorSurface.tsx"), "utf8");
  assert.match(source, /editProject: \(id\) => setProjectEdit\(\{ id, step: "edit" \}\)/);
  assert.match(source, /removeProject: \(id\) => setProjectEdit\(\{ id, step: "remove" \}\)/);
  assert.doesNotMatch(source, /editProject: \(id\) => \{[^}]*openSheet\("settings"\)/, "Edit no longer opens the old settings sheet");
  const save = source.slice(source.indexOf("const saveProjectEdit"), source.indexOf("const createWorkspace"));
  assert.match(save, /workspaces\.update\(\{ workspaceId: id, \.\.\.change, confirm: true \}\)/);
  assert.match(save, /workspaces\.remove\(\{ workspaceId: id, confirm: true \}\)/);
  assert.equal((save.match(/setWorkspaces\(/g) || []).length, 2, "save and remove both refresh the project list");
  assert.match(save, /if \(id === workspaceId\) chooseWorkspace\(items\[0\]\?\.id \?\? ""\)/);
  // The native mission board draws over HTML, so it steps aside while the dialog is open.
  assert.equal((source.match(/workspaceId && !sheet && !projectEdit/g) || []).length, 2);
});
