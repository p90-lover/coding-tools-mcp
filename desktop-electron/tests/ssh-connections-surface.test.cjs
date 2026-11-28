"use strict";
// Connections > SSH hosts (src/features/SshConnectionsSurface.tsx): the page for the hosts the person
// approves for SSH. The module is transpiled and run on a small stand-in React (hooks per component,
// effects with their undo, refs) and a small stand-in DOM (the focus, the document's and the window's
// listeners, the page behind a dialog), with a stand-in for the app module "ssh-connections", so every
// call the page makes is checked against the build contract (operation name and arguments) without a
// browser, a network or the real profile. The safety of the two key dialogs is checked both ways: from
// what they render and from the source text.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const ROOT = path.resolve(__dirname, "..");
const SOURCE = path.join(ROOT, "src", "features", "SshConnectionsSurface.tsx");
const source = fs.readFileSync(SOURCE, "utf8");
const styles = fs.readFileSync(path.join(ROOT, "src", "features", "ssh-connections.css"), "utf8");

const plain = (value) => JSON.parse(JSON.stringify(value));
const CLIENT = { path: "C:\\Windows\\System32\\OpenSSH\\ssh.exe", version: "OpenSSH_for_Windows_9.5p2" };
// Made-up keys in the real shape: "SHA256:" and 43 base64 characters.
const FP_OLD = `SHA256:${"Ab3".repeat(14)}x`;
const FP_NEW = `SHA256:${"Zy9".repeat(14)}q`;
const FP_OTHER = `SHA256:${"Qq7".repeat(14)}m`;
const FP_OFF_BY_ONE = `${FP_NEW.slice(0, -1)}r`;
const DRAFT = { id: "0a1b2c3d4e5f", label: "Build server", host: "build.example.com", port: 22, user: "deploy", identityFile: null,
  production: false, state: "draft", key: null, candidate: null, createdAt: "2026-11-20T08:00:00.000Z" };
const PINNED = { id: "112233445566", label: "Database", host: "2001:db8::7", port: 2222, user: "admin", identityFile: "C:\\keys\\db_ed25519",
  production: true, state: "pinned", key: { type: "ssh-ed25519", fingerprint: FP_OLD, pinnedAt: "2026-11-21T09:30:00.000Z", method: "pasted" },
  candidate: null, createdAt: "2026-11-21T09:00:00.000Z" };
const CHANGED = { ...PINNED, id: "aabbccddeeff", label: "Staging", host: "staging.example.com", port: 22, production: false, state: "changed",
  candidate: { type: "ssh-ed25519", fingerprint: FP_NEW, fetchedAt: "2026-11-25T10:00:00.000Z" } };
// The one selector the dialog asks the DOM for: its controls that can take the focus.
const STOPS = "button:not(:disabled), input:not(:disabled)";

/**
 * A stand-in for electron/ssh-connections.cjs that follows the contract's "Operations" table: the
 * same results, and the same refusals for `confirm_key`. `shows` is the key the server presents.
 * As in the module, a host whose key changed stays blocked whatever a later fetch returns.
 */
function fakeModule({ client = CLIENT, hosts = [], shows = { type: "ssh-ed25519", fingerprint: FP_NEW }, refuse = {}, notice = "" } = {}) {
  const list = plain(hosts);
  const ok = (result) => ({ ok: true, moduleId: "ssh-connections", transport: "in-process", result: { ok: true, ...plain(result) } });
  const fail = (error, code) => ({ ok: false, moduleId: "ssh-connections", transport: "in-process", result: { ok: false, error, ...(code ? { code } : {}) } });
  const find = (id) => list.find((host) => host.id === id);
  // The terminals it opened (milestone 2): only these close, as in the module.
  const terminals = new Map();
  return (input) => {
    const args = input.arguments ?? {};
    if (refuse[input.operation]) return typeof refuse[input.operation] === "object" ? fail(refuse[input.operation].error, refuse[input.operation].code) : fail(refuse[input.operation]);
    if (input.operation === "list") return ok({ client, hosts: list, ...(notice ? { notice } : {}) });
    if (input.operation === "terminal_close") {
      if (!terminals.has(args.handle)) return fail("This terminal was not opened from the SSH hosts page, so it was not closed here.", "not_own");
      terminals.delete(args.handle);
      return ok({});
    }
    if (input.operation === "add") {
      const host = { id: "f0f0f0f0f0f0", label: args.label, host: args.host, port: args.port, user: args.user, identityFile: args.identityFile ?? null,
        production: args.production === true, state: "draft", key: null, candidate: null, createdAt: "2026-11-26T12:00:00.000Z" };
      list.push(host);
      return ok({ host });
    }
    const host = find(args.id);
    if (!host) return fail("That host is no longer in the list.");
    if (input.operation === "update") { if ("production" in args) host.production = args.production; if ("label" in args) host.label = args.label; return ok({ host }); }
    if (input.operation === "remove") { list.splice(list.indexOf(host), 1); return ok({ hosts: list }); }
    if (input.operation === "fetch_key") {
      host.candidate = { ...shows, fetchedAt: "2026-11-26T12:05:00.000Z" };
      if (host.state === "pinned" && host.key.fingerprint !== shows.fingerprint) {
        // As in the module: every pinned entry for the same server and port is blocked with it.
        for (const other of list) {
          if (other.state === "pinned" && other.host === host.host && other.port === host.port) { other.state = "changed"; other.candidate = host.candidate; }
        }
      }
      return ok({ host });
    }
    if (input.operation === "confirm_key") {
      if (!host.candidate || args.fingerprint !== host.candidate.fingerprint) return fail("This is not the key that was fetched. Fetch the key again.");
      if ("pasted" in args && String(args.pasted).trim() !== host.candidate.fingerprint) return fail("The pasted fingerprint does not match this server's key.");
      host.key = { type: host.candidate.type, fingerprint: host.candidate.fingerprint, pinnedAt: "2026-11-26T12:06:00.000Z", method: "pasted" in args ? "pasted" : "compared" };
      host.state = "pinned";
      return ok({ host });
    }
    if (input.operation === "terminal_open") {
      if (host.state !== "pinned") return fail("Confirm this host's key before opening a terminal to it.", "not_pinned");
      const handle = `shellterm-ssh-${terminals.size + 1}`;
      terminals.set(handle, host.id);
      return ok({ terminal: { handle, generation: "2026-11-27T10:00:00Z", title: host.label, remote: true, hostId: host.id, production: host.production } });
    }
    throw new Error(`unexpected operation ${input.operation}`);
  };
}

const walk = (nodes, visit) => { for (const node of nodes) { if (node && typeof node === "object") { visit(node); walk(node.props.children ?? [], visit); } } };
const text = (nodes) => { const out = []; const visit = (list) => { for (const node of list) { if (typeof node === "string" || typeof node === "number") out.push(String(node)); else if (node?.props) visit(node.props.children ?? []); } }; visit(nodes); return out.join(""); };
const ofType = (nodes, type) => { const found = []; walk(nodes, (node) => { if (node.type === type) found.push(node); }); return found; };
const labelOf = (button) => text([button]) || button.props["aria-label"];

/** The page, mounted on the small React and the small DOM, against `respond` (a fakeModule). */
function mount({ respond = fakeModule(), active = true, confirmRemove = true } = {}) {
  const calls = [], errors = [], prompts = [], copied = [];

  // The small React. Every component keeps its own hooks, by its place in the tree; an effect may
  // return its undo; a component that is no longer drawn (a closed dialog) is unmounted.
  const stores = new Map(), pending = [];
  let store = null, at = 0, pass = 0;
  const react = {
    useState(initial) {
      const slots = store.slots, slot = at++;
      if (!(slot in slots)) slots[slot] = initial;
      return [slots[slot], (next) => { slots[slot] = typeof next === "function" ? next(slots[slot]) : next; }];
    },
    useRef(initial) {
      const slots = store.slots, slot = at++;
      if (!(slot in slots)) slots[slot] = { current: initial };
      return slots[slot];
    },
    useCallback(fn, deps) {
      const slots = store.slots, slot = at++, kept = slots[slot];
      if (kept && deps.every((value, index) => value === kept.deps[index])) return kept.fn;
      slots[slot] = { fn, deps };
      return fn;
    },
    useEffect(work, deps) {
      const slots = store.slots, slot = at++, kept = slots[slot];
      if (kept && deps.every((value, index) => value === kept.deps[index])) return;
      pending.push(() => { slots[slot]?.undo?.(); slots[slot] = { deps, undo: work() }; });
    },
  };

  // The small DOM: one element for each drawn tag, by its place in the tree; the focus; the listeners
  // on the document and the window. <body> holds the app's page ("root") and, beside it, each portal.
  let nodes = new Map(), tree = [];
  const elements = new Map(), attached = new Map(), listeners = [];
  const within = (outer, inner) => inner === outer || (inner.startsWith(outer) && "./<".includes(inner[outer.length]));
  const portals = () => [...nodes.values()].filter((node) => node.portal);
  const root = { inert: false };
  const body = { get children() { return [root, ...portals().map((node) => elementAt(node.path))]; } };
  const listen = (on) => ({
    addEventListener(type, fn) { listeners.push({ on, type, fn }); },
    removeEventListener(type, fn) { const index = listeners.findIndex((item) => item.on === on && item.type === type && item.fn === fn); if (index >= 0) listeners.splice(index, 1); },
  });
  const fire = (on, type, event = {}) => { for (const item of listeners.filter((entry) => entry.on === on && entry.type === type)) item.fn(event); };
  const doc = { body, activeElement: body, ...listen("document") };
  /** A tag is switched off with what holds it: the app's page, or its own portal. */
  const switchedOff = (place) => { const portal = portals().find((node) => within(node.path, place)); return portal ? elementAt(portal.path).inert : root.inert; };
  const canFocus = (element) => {
    const node = element.node;
    return Boolean(node) && node.props.disabled !== true && !switchedOff(element.place) && (["button", "input"].includes(node.type) || node.props.tabIndex !== undefined);
  };
  function elementAt(place) {
    if (!elements.has(place)) {
      const element = {
        place, inert: false,
        get node() { return nodes.get(place) ?? null; },
        get isConnected() { return nodes.has(place); },
        get disabled() { return nodes.get(place)?.props.disabled === true; },
        get parentElement() { return nodes.get(place)?.portal ? body : null; },
        contains: (other) => Boolean(other && typeof other.place === "string" && nodes.has(other.place) && within(place, other.place)),
        querySelectorAll(selector) {
          assert.equal(selector, STOPS, "the one selector this DOM answers");
          return [...nodes.values()].filter((node) => node.path !== place && within(place, node.path) && ["button", "input"].includes(node.type) && node.props.disabled !== true)
            .map((node) => elementAt(node.path));
        },
        focus() { if (canFocus(element)) doc.activeElement = element; },
      };
      elements.set(place, element);
    }
    return elements.get(place);
  }

  const element = (type, props) => ({ type, props: props ?? {} });
  const modules = {
    react,
    "react/jsx-runtime": { jsx: element, jsxs: element, Fragment: "Fragment" },
    "react-dom": { createPortal: (node, container) => { assert.equal(container, body, "a dialog is drawn into <body>"); node.portal = true; return node; } },
    "../api/client": { getCodingToolsClient: () => ({ apps: { call: async (input) => { calls.push(plain(input)); return respond(input); } } }) },
    "../icons": { Icon: () => null },
    "./ssh-connections.css": {},
    // AO's native terminal view: drawn here as a tag that keeps the props the page gave it.
    "./AgentOrchestratorOriginalSurface": { AgentOrchestratorOriginalSurface: function AgentOrchestratorOriginalSurface(given) {
      const { openMissions, ...rest } = given;
      return { type: "ao-view", props: { ...plain(rest), opensMissions: typeof openMissions, missions: openMissions?.() } };
    } },
  };
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const module = { exports: {} };
  vm.runInNewContext(outputText, {
    module, exports: module.exports, document: doc,
    window: { confirm: (message) => { prompts.push(message); return confirmRemove; }, setTimeout: () => 0, clearTimeout: () => undefined, ...listen("window") },
    navigator: { clipboard: { writeText: async (value) => { copied.push(value); } } },
    require: (name) => { if (!(name in modules)) throw new Error(`unexpected import ${name}`); return modules[name]; },
  });
  const api = module.exports;
  const props = { active, setError: (error) => errors.push(error) };

  /** Draws a component's tree into plain tags, each with its place (`path`), calling function components with their own hooks. */
  function renderAt(node, place) {
    if (Array.isArray(node)) return node.flatMap((item, index) => renderAt(item, `${place}.${index}`));
    if (!node || typeof node !== "object") return node === null || node === undefined || node === false || node === true ? [] : [node];
    if (typeof node.type === "function") {
      const key = `${place}<${node.type.name}>`, outer = [store, at];
      store = stores.get(key) ?? { slots: [] };
      stores.set(key, store);
      store.pass = pass;
      at = 0;
      let drawn;
      try { drawn = node.type(node.props); } finally { [store, at] = outer; }
      return renderAt(drawn, key);
    }
    const made = { ...node, path: `${place}/${String(node.type)}`, props: { ...node.props } };
    nodes.set(made.path, made);
    made.props.children = renderAt(node.props.children, made.path);
    return [made];
  }
  const setRef = (ref, value) => { if (typeof ref === "function") ref(value); else ref.current = value; };
  const draw = () => {
    pass += 1;
    const before = nodes;
    nodes = new Map();
    tree = renderAt({ type: api.SshConnectionsSurface, props }, "root");
    // As React commits: the refs of tags that are gone are cleared and the others set; a control that
    // is gone or switched off loses the focus; a new one with autoFocus takes it.
    for (const [place, ref] of attached) if (!nodes.has(place)) { attached.delete(place); setRef(ref, null); }
    for (const node of nodes.values()) if (node.props.ref) { attached.set(node.path, node.props.ref); setRef(node.props.ref, elementAt(node.path)); }
    if (doc.activeElement !== body && !canFocus(doc.activeElement)) doc.activeElement = body;
    for (const node of nodes.values()) if (node.props.autoFocus === true && !before.has(node.path)) elementAt(node.path).focus();
    // Then the effects: the undo of every component that is gone, and the new ones.
    for (const [key, kept] of stores) if (kept.pass !== pass) { stores.delete(key); for (const slot of kept.slots) if (slot && typeof slot.undo === "function") slot.undo(); }
    for (const work of pending.splice(0)) work();
  };
  const settle = async () => { for (let round = 0; round < 2; round += 1) { await new Promise(setImmediate); await new Promise(setImmediate); draw(); } };
  const dialog = () => { let found = null; walk(tree, (node) => { if (!found && ["dialog", "alertdialog"].includes(node.props.role)) found = node; }); return found; };
  const scope = (inDialog) => { if (!inDialog) return tree; const open = dialog(); assert.ok(open, "a dialog is open"); return [open]; };
  const button = (label, inDialog = false) => ofType(scope(inDialog), "button").find((node) => labelOf(node) === label);
  const change = (name, value, inputType) => { ui.input(name).props.onChange({ target: { value }, nativeEvent: { inputType } }); draw(); };
  /** A React event that starts at `node` and goes outward through the tags around it, until one stops it. */
  const bubble = (node, handler) => {
    const event = { stopped: false, stopPropagation() { event.stopped = true; } };
    for (const item of [...nodes.values()].filter((entry) => within(entry.path, node.path)).reverse()) { if (event.stopped) break; item.props[handler]?.(event); }
  };
  const ui = {
    api, calls, errors, prompts, copied, settle, dialog,
    show(next) { Object.assign(props, next); draw(); },
    all: () => text(tree),
    tree: () => tree,
    button,
    buttons: (inDialog = false) => ofType(scope(inDialog), "button").map(labelOf),
    async click(label, inDialog = false) {
      const node = button(label, inDialog);
      assert.ok(node, `button “${label}”`);
      assert.notEqual(node.props.disabled, true, `“${label}” is disabled`);
      assert.ok(!switchedOff(node.path), `“${label}” is behind an open dialog`);
      elementAt(node.path).focus();
      await node.props.onClick();
      await settle();
    },
    /** An input of the open dialog, by its aria-label or by the text of the field row it sits in. */
    input(name) {
      const open = scope(true);
      const labelled = ofType(open, "input").find((node) => node.props["aria-label"] === name);
      if (labelled) return labelled;
      const row = ofType(open, "label").find((node) => text(ofType([node], "span").slice(0, 1)) === name);
      assert.ok(row, `field “${name}”`);
      return ofType([row], "input")[0];
    },
    /** Typed by hand into an input of the open dialog. */
    type(name, value) { change(name, value, "insertText"); },
    /** Pasted (Ctrl+V) into an input of the open dialog. */
    paste(name, value) { change(name, value, "insertFromPaste"); },
    async submit() { await ofType(scope(true), "form")[0].props.onSubmit({ preventDefault() {} }); await settle(); },
    /**
     * A key press, as the browser hands it out: first to the listeners on the document, then, unless
     * one of them stopped it, to the dialog's own React handler, which hears only a key pressed inside it.
     */
    async key(name, { shift = false } = {}) {
      const event = { key: name, shiftKey: shift, defaultPrevented: false, stopped: false,
        preventDefault() { event.defaultPrevented = true; }, stopPropagation() { event.stopped = true; } };
      fire("document", "keydown", event);
      const open = dialog();
      if (!event.stopped && open?.props.onKeyDown && elementAt(open.path).contains(doc.activeElement)) {
        event.currentTarget = elementAt(open.path);
        open.props.onKeyDown(event);
      }
      await settle();
      return event;
    },
    /** A click on a tag that is no control (text, the dimmed area): the focus goes to the nearest tag around it that takes it, else to none. */
    press(node) {
      if (switchedOff(node.path)) return;
      const takers = [...nodes.values()].filter((item) => within(item.path, node.path) && canFocus(elementAt(item.path)));
      doc.activeElement = takers.length ? elementAt(takers.at(-1).path) : body;
    },
    /** What has the focus: a control by its label, another tag by its class, "page" for none. */
    focused() {
      const node = doc.activeElement === body ? null : doc.activeElement.node;
      return !node ? "page" : ["button", "input"].includes(node.type) ? labelOf(node) : node.props.className;
    },
    hasFocus: (node) => doc.activeElement !== body && doc.activeElement.place === node.path,
    /** Whether the app's page (everything beside a dialog) is switched off. */
    pageOff: () => root.inert,
    /** Ctrl+C on a selection that starts in `node`: React's copy event, from that tag outward. */
    copyFrom(node) { bubble(node, "onCopy"); },
    /** Selected text dragged out of `node`: React's dragstart event, from that tag outward. */
    dragFrom(node) { bubble(node, "onDragStart"); },
    /** Dragged text dropped into an input of the open dialog. */
    drop(name, value) { change(name, value, "insertFromDrop"); },
    /** The person switches to another window. */
    leaveWindow() { fire("window", "blur"); },
    /** The calls made since the page opened, without the reads of the list. */
    writes: () => calls.filter((call) => call.operation !== "list"),
  };
  draw();
  return ui;
}

async function opened(options) {
  const ui = mount(options);
  await ui.settle();
  return ui;
}

test("names, badges and the fingerprint a person pastes", () => {
  const { api } = mount({ active: false });
  assert.equal(api.hostAddress({ user: "deploy", host: "build.example.com", port: 22 }), "deploy@build.example.com:22");
  assert.equal(api.hostAddress({ user: "admin", host: "2001:db8::7", port: 2222 }), "admin@[2001:db8::7]:2222", "an IPv6 address's colons are not the port's");
  assert.deepEqual(plain(["draft", "pinned", "changed"].map((state) => api.stateBadge(state).text)), ["Key not confirmed", "Approved", "Key changed, blocked"]);
  assert.equal(api.hostKeyFile("ssh-ed25519"), "/etc/ssh/ssh_host_ed25519_key.pub");
  assert.equal(api.hostKeyFile("ecdsa-sha2-nistp256"), "/etc/ssh/ssh_host_ecdsa_key.pub");
  assert.equal(api.hostKeyFile("rsa-sha2-512"), "/etc/ssh/ssh_host_rsa_key.pub");

  // ssh-keygen -lf prints a whole line; the SHA256 value in it is read out, without a look at the fetched key.
  const read = (pasted) => plain(api.pastedFingerprints(pasted));
  assert.equal(api.pastedFingerprints.length, 1, "the fetched key is not an argument: nothing is picked to fit it");
  assert.deepEqual(read(`256 ${FP_NEW} root@build (ED25519)\n`), [FP_NEW]);
  assert.deepEqual(read(`  ${FP_NEW}  `), [FP_NEW]);
  assert.deepEqual(read(`${FP_NEW}\n256 ${FP_NEW} root@build (ED25519)`), [FP_NEW], "the same value twice is one value");
  assert.deepEqual(read(`3072 ${FP_OLD} root@build (RSA)\n256 ${FP_NEW} root@build (ED25519)`), [FP_OLD, FP_NEW], "several keys stay several: the page does not choose");
  assert.deepEqual(read(FP_OFF_BY_ONE), [FP_OFF_BY_ONE], "one character off stays different");
  assert.deepEqual(read(`${FP_NEW}A`), [`${FP_NEW}A`], "a longer value is not cut down to a match");
  assert.deepEqual(read(FP_NEW.slice(0, -1)), [FP_NEW.slice(0, -1)], "a shorter value does not match");
  assert.deepEqual(read(FP_NEW.toLowerCase()), [], "case counts");
  assert.deepEqual(read("  looks fine to me  "), []);
  assert.deepEqual(read(""), []);

  assert.equal(api.reasonOf(new Error("IPC_TRANSPORT_FAILED: apps.call failed: Click into the Coding Tools window and try again")), "Click into the Coding Tools window and try again");
  assert.equal(api.reasonOf(new Error("Host: use letters, digits, dots and hyphens.")), "Host: use letters, digits, dots and hyphens.");

  // The public shape has no key blob; one sent by mistake is not kept, and an unknown state is not "approved".
  const host = plain(api.hostOf({ ...PINNED, state: "trusted", key: { ...PINNED.key, blob: "AAAAC3Nza" }, candidate: { type: "ssh-ed25519", blob: "AAAAC3Nzb", fingerprint: FP_NEW, fetchedAt: 1 } }));
  assert.equal(host.state, "draft");
  assert.ok(!("blob" in host.key) && !("blob" in host.candidate));
  assert.equal(api.hostOf({ label: "no id" }), null);
  assert.deepEqual([{ port: 2222 }, { port: "2222" }, { port: "22; id" }, {}].map((extra) => api.hostOf({ id: "a", ...extra }).port), [2222, 2222, 0, 0],
    "a port the page cannot read never shows as 22");
});

test("the list is read only while the tab is on screen, with exactly the contract's list call", async () => {
  const hidden = await opened({ active: false, respond: fakeModule({ hosts: [DRAFT] }) });
  assert.deepEqual(hidden.calls, [], "a hidden tab reads nothing");
  hidden.show({ active: true });
  await hidden.settle();
  assert.deepEqual(hidden.calls, [{ moduleId: "ssh-connections", operation: "list" }]);
  await hidden.settle();
  assert.equal(hidden.calls.length, 1, "it is read once per visit, not on every render");
  await hidden.click("Check again");
  assert.deepEqual(hidden.calls.at(-1), { moduleId: "ssh-connections", operation: "list" });
});

test("the page shows the ssh client and each host: label, address, state, key, Production and Remove", async () => {
  const ui = await opened({ respond: fakeModule({ hosts: [DRAFT, PINNED, CHANGED] }) });
  const all = ui.all();
  for (const shown of ["SSH hosts", "OpenSSH_for_Windows_9.5p2", "C:\\Windows\\System32\\OpenSSH\\ssh.exe",
    "Build server", "deploy@build.example.com:22", "Key not confirmed", "No key confirmed yet. Agents can't use this host.",
    "Database", "admin@[2001:db8::7]:2222", "Approved", `ssh-ed25519 ${FP_OLD}`, ui.api.approvalText(PINNED.key), "Key file: C:\\keys\\db_ed25519",
    "Staging", "Key changed, blocked", "The server now shows a different key. Agents can't use this host until you review the change.",
    "Production", "Every agent command on a production host waits for you."]) {
    assert.ok(all.includes(shown), shown);
  }
  assert.ok(!all.includes("No SSH client"), "no missing-client message when one is found");
  assert.match(ui.api.approvalText(PINNED.key), /^Approved .+ · pasted fingerprint matched$/);
  assert.equal(ui.api.approvalText({ ...PINNED.key, method: "compared", pinnedAt: null }), "Approved · compared by eye");

  const groups = []; walk(ui.tree(), (node) => { if (node.props.role === "group") groups.push(node); });
  assert.deepEqual(groups.map((node) => node.props["aria-label"]), ["Build server", "Database", "Staging"]);
  const actions = groups.map((node) => ofType([node], "button").map(labelOf));
  assert.deepEqual(actions, [
    ["Confirm key", "Remove", "Production: Build server"],
    ["Open terminal", "Check key", "Remove", "Production: Database"],
    ["Review key change", "Check key", "Remove", "Production: Staging"],
  ]);
  const chips = []; walk(ui.tree(), (node) => { if (String(node.props.className || "").includes("ssh-host-state")) chips.push(node.props.className); });
  assert.deepEqual(chips, ["app-plugin-chip ssh-host-state is-error", "app-plugin-chip ssh-host-state is-ok", "app-plugin-chip ssh-host-state is-blocked"]);
  const switches = ofType(ui.tree(), "button").filter((node) => node.props.role === "switch");
  assert.deepEqual(switches.map((node) => [node.props.className, node.props["aria-checked"]]), [["switch", false], ["switch is-on", true], ["switch", false]]);
  // The in-app terminal (milestone 2) is offered on the approved host only: never on a host with no
  // confirmed key or a blocked one, and nothing else on the page connects.
  assert.deepEqual(ui.buttons().filter((label) => /terminal|connect|open/i.test(label)), ["Open terminal"], ui.buttons().join(", "));
  assert.equal(ui.button("Open terminal").props.className, "button-primary");
});

test("an empty list says what approved hosts are for, and a missing ssh client is said plainly", async () => {
  const empty = await opened({ respond: fakeModule() });
  assert.ok(empty.all().includes("No hosts yet. Agents may only use SSH to hosts you approve here, and each command is still reviewed."));
  assert.deepEqual(empty.buttons(), ["Check again", "Add host"]);

  const missing = await opened({ respond: fakeModule({ client: null, hosts: [DRAFT] }) });
  assert.ok(missing.all().includes("No SSH client found"));
  assert.ok(missing.all().includes("No SSH client was found on this computer, so the app can't fetch a server's key. On Windows, add OpenSSH Client under Settings, System, Optional features, then choose Check again."));
  assert.equal(missing.button("Confirm key").props.disabled, true, "no key can be fetched without the client");

  const broken = await opened({ respond: fakeModule({ refuse: { list: "Unknown Coding Tools module: ssh-connections" } }) });
  assert.ok(broken.all().includes("SSH hosts didn't load: Unknown Coding Tools module: ssh-connections"));
  assert.equal(broken.button("Add host").props.disabled, true);

  // A saved list that could not be read shows empty; the module's notice says why, as an alert.
  const notice = "The saved SSH hosts list could not be read, so no host is approved.";
  const unreadable = await opened({ respond: fakeModule({ notice }) });
  const alerts = []; walk(unreadable.tree(), (node) => { if (node.props.role === "alert") alerts.push(text([node])); });
  assert.deepEqual(alerts, [notice]);
});

test("a changed key found through one entry shows every entry for that server blocked", async () => {
  const ROOT = { ...PINNED, id: "665544332211", label: "Database as root", user: "root" };
  const ui = await opened({ respond: fakeModule({ hosts: [PINNED, ROOT] }) });
  await ui.click("Check key");
  await ui.settle();
  const chips = []; walk(ui.tree(), (node) => { if (String(node.props.className || "").includes("ssh-host-state")) chips.push(node.props.className); });
  assert.deepEqual(chips, ["app-plugin-chip ssh-host-state is-blocked", "app-plugin-chip ssh-host-state is-blocked"], "the list was read again");
  assert.equal(ui.dialog().props.role, "alertdialog", "the warning is for the entry that was checked");
});

test("Add host sends the separate fields as the contract names them and shows the module's own error", async () => {
  const ui = await opened({ respond: fakeModule() });
  await ui.click("Add host");
  assert.equal(ui.dialog().props.role, "dialog");
  assert.equal(ui.dialog().props["aria-modal"], "true");
  assert.deepEqual(ofType([ui.dialog()], "label").map((node) => text(ofType([node], "span").slice(0, 1))), ["Label", "Host", "Port", "User", "Key file (optional)"]);
  assert.equal(ui.input("Port").props.value, "22", "the port starts at 22");
  ui.type("Label", "  Build server ");
  ui.type("Host", "build.example.com ");
  ui.type("Port", "2222");
  ui.type("User", "deploy");
  await ui.submit();
  assert.deepEqual(ui.writes(), [{ moduleId: "ssh-connections", operation: "add",
    arguments: { label: "Build server", host: "build.example.com", port: 2222, user: "deploy" } }], "no key file is sent when none was typed");
  assert.equal(ui.dialog(), null, "the dialog closes once the host is added");
  assert.ok(ui.all().includes("deploy@build.example.com:2222") && ui.all().includes("Key not confirmed"), "the new host waits for its key");

  // With a key file, and the port left at its default.
  await ui.click("Add host");
  ui.type("Label", "Database");
  ui.type("Host", "db.example.com");
  ui.type("User", "admin");
  ui.type("Key file (optional)", " C:\\keys\\db_ed25519 ");
  await ui.submit();
  assert.deepEqual(ui.writes().at(-1).arguments, { label: "Database", host: "db.example.com", port: 22, user: "admin", identityFile: "C:\\keys\\db_ed25519" });

  // What the module refuses stays in the dialog, in its words; a port that is no number goes as typed for it to refuse.
  const refused = await opened({ respond: fakeModule({ refuse: { add: "Port: use a number from 1 to 65535." } }) });
  await refused.click("Add host");
  refused.type("Label", "x");
  refused.type("Host", "x.example.com");
  refused.type("Port", "22 -oProxyCommand=calc");
  refused.type("User", "x");
  await refused.submit();
  assert.equal(refused.writes()[0].arguments.port, "22 -oProxyCommand=calc");
  assert.ok(refused.dialog(), "the dialog stays open");
  const alerts = []; walk([refused.dialog()], (node) => { if (node.props.role === "alert") alerts.push(text([node])); });
  assert.deepEqual(alerts, ["Port: use a number from 1 to 65535."]);
  assert.equal(refused.input("Host").props.value, "x.example.com", "what was typed is kept");
  assert.deepEqual(refused.errors, [], "the error is not also a toast");
  await refused.click("Cancel", true);
  assert.equal(refused.dialog(), null);
});

test("confirming a key: the fetched key is shown in full, and Cancel is the default action", async () => {
  const ui = await opened({ respond: fakeModule({ hosts: [DRAFT] }) });
  await ui.click("Confirm key");
  assert.deepEqual(ui.writes(), [{ moduleId: "ssh-connections", operation: "fetch_key", arguments: { id: DRAFT.id } }]);
  const dialog = ui.dialog();
  assert.equal(dialog.props.role, "dialog");
  assert.equal(dialog.props["aria-modal"], "true");
  // Blocking: only its own buttons and Escape close it, never a click beside it.
  for (const handler of ["onClick", "onPointerDown", "onMouseDown"]) assert.equal(dialog.props[handler], undefined, handler);
  const shown = text([dialog]);
  for (const expected of ["Confirm this server's key", "Build server", "build.example.com", "22", "ssh-ed25519",
    "Coding Tools can't tell whether this key is genuine.", "If someone is intercepting the connection, it is their key.",
    "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub", "Or read it in your hosting provider's console."]) {
    assert.ok(shown.includes(expected), expected);
  }
  const fingerprint = ui.input("Fingerprint the server sent");
  assert.equal(fingerprint.props.value, FP_NEW, "the whole fingerprint");
  assert.equal(fingerprint.props.readOnly, true);
  await ui.click("Copy", true);
  assert.deepEqual(ui.copied, [FP_NEW]);

  assert.deepEqual(ui.buttons(true), ["Copied", "I compared it myself", "Approve this key", "Cancel"]);
  const cancel = ui.button("Cancel", true);
  assert.equal(cancel.props.autoFocus, true, "Cancel has the focus when the dialog opens");
  assert.equal(cancel.props.className, "button-primary", "Cancel is the one primary button");
  const others = ofType([ui.dialog()], "button").filter((node) => node !== cancel);
  assert.equal(others.length, 3);
  assert.ok(others.every((node) => node.props.autoFocus !== true && node.props.className === "button-secondary" && node.props.type === "button"));
  assert.ok(ofType([ui.dialog()], "input").every((node) => node.props.autoFocus !== true), "the paste box does not take the focus from Cancel");
  assert.deepEqual(ofType([ui.dialog()], "form"), [], "no form: Enter in the paste box approves nothing");
  assert.ok(ofType([ui.dialog()], "input").every((node) => node.props.type !== "checkbox"), "nothing to tick and remember");
  assert.equal(ui.button("Approve this key", true).props.disabled, true, "nothing to approve by paste until a matching value is pasted");

  await ui.key("Escape");
  assert.equal(ui.dialog(), null, "Escape cancels");
  await ui.click("Confirm key");
  await ui.click("Cancel", true);
  assert.equal(ui.dialog(), null);
  assert.ok(ui.writes().every((call) => call.operation === "fetch_key"), "cancelling approves nothing");
  assert.ok(ui.all().includes("Key not confirmed"));
});

test("the paste path sends \"pasted\" and the weaker path does not", async () => {
  // Strong path: the value from the server's console, pasted as ssh-keygen prints it.
  const strong = await opened({ respond: fakeModule({ hosts: [DRAFT] }) });
  await strong.click("Confirm key");
  strong.paste("Fingerprint from the server", `256 ${FP_NEW} root@build (ED25519)`);
  assert.ok(text([strong.dialog()]).includes("It matches the key this server sent."));
  await strong.click("Approve this key", true);
  assert.deepEqual(strong.writes().at(-1), { moduleId: "ssh-connections", operation: "confirm_key",
    arguments: { id: DRAFT.id, fingerprint: FP_NEW, pasted: FP_NEW } });
  assert.equal(strong.dialog(), null);
  assert.ok(strong.all().includes("Approved") && strong.all().includes("pasted fingerprint matched"));
  assert.ok(strong.all().includes("Key approved. The pasted fingerprint matched."));

  // Weaker path: the person says they compared it; no pasted value goes along.
  const weak = await opened({ respond: fakeModule({ hosts: [DRAFT] }) });
  await weak.click("Confirm key");
  await weak.click("I compared it myself", true);
  const sent = weak.writes().at(-1);
  assert.deepEqual(sent, { moduleId: "ssh-connections", operation: "confirm_key", arguments: { id: DRAFT.id, fingerprint: FP_NEW } });
  assert.ok(!("pasted" in sent.arguments));
  assert.ok(weak.all().includes("compared by eye"));

  // A pasted value that differs closes both ways to approve.
  const off = await opened({ respond: fakeModule({ hosts: [DRAFT] }) });
  await off.click("Confirm key");
  off.paste("Fingerprint from the server", FP_OFF_BY_ONE);
  assert.ok(text([off.dialog()]).includes("It is not the key this server sent. Do not approve this key."));
  assert.equal(off.button("Approve this key", true).props.disabled, true);
  assert.equal(off.button("I compared it myself", true).props.disabled, true, "not after pasting a value that differs");
  assert.equal(off.button("Cancel", true).props.disabled, false);

  // The main process decides: its refusal is shown and nothing is approved.
  const refused = await opened({ respond: fakeModule({ hosts: [DRAFT], refuse: { confirm_key: "The pasted fingerprint does not match this server's key." } }) });
  await refused.click("Confirm key");
  refused.paste("Fingerprint from the server", FP_NEW);
  await refused.click("Approve this key", true);
  assert.ok(refused.dialog(), "the dialog stays open");
  assert.ok(text([refused.dialog()]).includes("The pasted fingerprint does not match this server's key."));
  assert.ok(refused.all().includes("Key not confirmed"));
});

test("a paste counts only when it holds one fingerprint: the page never picks the one that fits", async () => {
  // Found 2026-11-27: the page picked whichever pasted value equalled the fetched key, so a pasted list
  // of several servers' fingerprints "matched" when the address reached another of those machines, and
  // the main process, which compares again, was only ever sent the value that fitted.
  const lines = [`web1  256 ${FP_OTHER} root@web1 (ED25519)`, `db1   256 ${FP_NEW} root@db1 (ED25519)`];
  const ui = await opened({ respond: fakeModule({ hosts: [DRAFT] }) });
  await ui.click("Confirm key");
  for (const pasted of [lines.join("\n"), [...lines].reverse().join("\n")]) {
    ui.paste("Fingerprint from the server", pasted);
    const shown = text([ui.dialog()]);
    assert.ok(!shown.includes("It matches the key this server sent."), "no match is claimed");
    assert.ok(shown.includes("There is more than one fingerprint here. Paste only the line for this server's ssh-ed25519 key."), "it says what to paste instead");
    assert.ok(!shown.includes("Do not approve this key."), "and gives no verdict it has not reached");
    assert.equal(ui.button("Approve this key", true).props.disabled, true);
    assert.equal(ui.button("I compared it myself", true).props.disabled, true, "the weaker way stays shut while the box holds that");
    // Even a click that got through sends nothing.
    await ui.button("Approve this key", true).props.onClick();
    await ui.settle();
    assert.deepEqual(ui.writes().map((call) => call.operation), ["fetch_key"]);
  }
  assert.ok(ui.all().includes("Key not confirmed"));
  // The one line of this server's key counts, and the value read from it is what the main process is sent.
  ui.paste("Fingerprint from the server", lines[1]);
  assert.ok(text([ui.dialog()]).includes("It matches the key this server sent."));
  await ui.click("Approve this key", true);
  assert.deepEqual(ui.writes().at(-1).arguments, { id: DRAFT.id, fingerprint: FP_NEW, pasted: FP_NEW });

  // The same for a changed key, where the paste is the only way.
  const changed = await opened({ respond: fakeModule({ hosts: [CHANGED] }) });
  await changed.click("Review key change");
  changed.paste("New fingerprint from the server", `256 ${FP_OLD} root@staging (ED25519)\n256 ${FP_NEW} root@staging (ED25519)`);
  assert.equal(changed.button("Replace key", true).props.disabled, true, "the old and the new key pasted together replace nothing");
  assert.ok(text([changed.dialog()]).includes("There is more than one fingerprint here."));
  await changed.button("Replace key", true).props.onClick();
  await changed.settle();
  assert.deepEqual(changed.writes(), []);
});

test("a paste that is no SHA256 fingerprint is called that, not a wrong key", async () => {
  // The same key in another notation is not a different key, and the page cannot tell which it is.
  const ui = await opened({ respond: fakeModule({ hosts: [DRAFT] }) });
  await ui.click("Confirm key");
  for (const pasted of ["256 MD5:1f:2e:3d:4c:5b:6a:79:88:97:a6:b5:c4:d3:e2:f1:00 root@build (ED25519)",
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleExampleExampleExampleExampleExamp root@build", "looks fine to me"]) {
    ui.paste("Fingerprint from the server", pasted);
    const shown = text([ui.dialog()]);
    assert.ok(shown.includes("This is not a SHA256 fingerprint. Paste the line that has SHA256: in it."), pasted);
    assert.ok(!shown.includes("It is not the key this server sent."), "no verdict about the key");
    assert.ok(!shown.includes("Do not approve this key."));
    assert.equal(ui.button("Approve this key", true).props.disabled, true, "it approves nothing");
  }
  // A SHA256 value that differs keeps the verdict.
  ui.paste("Fingerprint from the server", `256 ${FP_OFF_BY_ONE} root@build (ED25519)`);
  assert.ok(text([ui.dialog()]).includes("It is not the key this server sent. Do not approve this key."));
  // An empty box says nothing.
  ui.type("Fingerprint from the server", "   ");
  const statuses = []; walk([ui.dialog()], (node) => { if (node.props.role === "status") statuses.push(text([node])); });
  assert.deepEqual(statuses, []);
});

test("the dialog's own fingerprint pasted back is not a comparison", async () => {
  // Found 2026-11-27: Copy, then paste into the box below, approved the key as "pasted fingerprint
  // matched" with no value from the server involved.
  const own = "That is the fingerprint copied from this dialog, not one you got from the server.";
  const ui = await opened({ respond: fakeModule({ hosts: [DRAFT] }) });
  await ui.click("Confirm key");
  await ui.click("Copy", true);
  ui.paste("Fingerprint from the server", FP_NEW);
  assert.ok(text([ui.dialog()]).includes(own));
  assert.ok(!text([ui.dialog()]).includes("It matches the key this server sent."));
  assert.equal(ui.button("Approve this key", true).props.disabled, true);
  await ui.button("Approve this key", true).props.onClick();
  await ui.settle();
  assert.deepEqual(ui.writes().map((call) => call.operation), ["fetch_key"], "nothing is sent as pasted");
  assert.equal(ui.button("I compared it myself", true).props.disabled, false, "the weaker way claims no more than it did");
  // A key typed after that paste, which leaves the same value in the box, does not make it the server's.
  ui.type("Fingerprint from the server", `${FP_NEW} `);
  assert.ok(text([ui.dialog()]).includes(own), "a space typed after the paste");
  assert.equal(ui.button("Approve this key", true).props.disabled, true);
  // Typed by hand, it is the person's own reading.
  ui.type("Fingerprint from the server", "");
  ui.type("Fingerprint from the server", FP_NEW);
  assert.ok(text([ui.dialog()]).includes("It matches the key this server sent."));
  // Ctrl+C in the fetched-fingerprint field counts as a copy made here too.
  ui.type("Fingerprint from the server", "");
  ui.copyFrom(ui.input("Fingerprint the server sent"));
  ui.paste("Fingerprint from the server", `256 ${FP_NEW} root@build (ED25519)`);
  assert.ok(text([ui.dialog()]).includes(own));
  // Dragged out of the fetched-fingerprint field and dropped in the box, the same.
  ui.type("Fingerprint from the server", "");
  ui.leaveWindow();
  ui.dragFrom(ui.input("Fingerprint the server sent"));
  ui.drop("Fingerprint from the server", FP_NEW);
  assert.ok(text([ui.dialog()]).includes(own), "a drop from the dialog");
  assert.equal(ui.button("Approve this key", true).props.disabled, true);
  // Once the person has been to another window, what they paste may come from the server.
  ui.type("Fingerprint from the server", "");
  ui.leaveWindow();
  ui.paste("Fingerprint from the server", FP_NEW);
  assert.ok(text([ui.dialog()]).includes("It matches the key this server sent."));
  // A copy or a drag made after the paste, or in the paste box itself, takes nothing back.
  ui.copyFrom(ui.input("Fingerprint from the server"));
  ui.paste("Fingerprint from the server", `${FP_NEW} `);
  assert.ok(text([ui.dialog()]).includes("It matches the key this server sent."), "the paste box's own text is the person's");
  ui.dragFrom(ui.input("Fingerprint from the server"));
  ui.drop("Fingerprint from the server", FP_NEW);
  assert.ok(text([ui.dialog()]).includes("It matches the key this server sent."), "and so is text dragged out of it");
  await ui.click("Copied", true);
  assert.equal(ui.button("Approve this key", true).props.disabled, false);
  await ui.click("Approve this key", true);
  assert.deepEqual(ui.writes().at(-1).arguments, { id: DRAFT.id, fingerprint: FP_NEW, pasted: FP_NEW });

  // A changed key has no weaker way: the new fingerprint, selected in the dialog and copied, replaces nothing.
  const changed = await opened({ respond: fakeModule({ hosts: [CHANGED] }) });
  await changed.click("Review key change");
  changed.copyFrom(ofType([changed.dialog()], "code").find((node) => text([node]) === FP_NEW));
  changed.paste("New fingerprint from the server", FP_NEW);
  assert.ok(text([changed.dialog()]).includes(own));
  assert.equal(changed.button("Replace key", true).props.disabled, true);
  await changed.button("Replace key", true).props.onClick();
  await changed.settle();
  assert.deepEqual(changed.writes(), []);
  // A dialog opened again starts clean, and a paste after leaving the window counts.
  await changed.click("Stay disconnected", true);
  await changed.click("Review key change");
  changed.copyFrom(ofType([changed.dialog()], "code").find((node) => text([node]) === FP_NEW));
  changed.leaveWindow();
  changed.paste("New fingerprint from the server", FP_NEW);
  assert.equal(changed.button("Replace key", true).props.disabled, false);
});

test("the confirm dialog says when the key was fetched, not \"just now\"", async () => {
  // The dialog comes back with its tab, possibly long after the fetch.
  const ui = await opened({ respond: fakeModule({ hosts: [DRAFT] }) });
  await ui.click("Confirm key");
  const fetched = ui.api.dateText("2026-11-26T12:05:00.000Z");
  assert.ok(fetched, "the fetch time reads as a date");
  for (const round of ["at once", "back with its tab"]) {
    const facts = ofType([ui.dialog()], "dl")[0];
    assert.deepEqual(ofType([facts], "dt").map((node) => text([node])), ["Host", "Port", "Key type", "Fetched"], round);
    assert.equal(text(ofType([facts], "dd").slice(-1)), fetched, round);
    assert.ok(!/just now/i.test(text([ui.dialog()])), round);
    assert.ok(text([ui.dialog()]).includes("It is only what the server at this address sent when the key was fetched."), round);
    ui.show({ active: false });
    ui.show({ active: true });
  }
});

test("a changed key: the old and new fingerprints side by side, staying disconnected by default, replaced only by paste", async () => {
  const ui = await opened({ respond: fakeModule({ hosts: [PINNED] }) });
  await ui.click("Check key");
  assert.deepEqual(ui.writes(), [{ moduleId: "ssh-connections", operation: "fetch_key", arguments: { id: PINNED.id } }]);
  const dialog = ui.dialog();
  assert.equal(dialog.props.role, "alertdialog");
  assert.equal(dialog.props["aria-modal"], "true");
  for (const handler of ["onClick", "onPointerDown", "onMouseDown"]) assert.equal(dialog.props[handler], undefined, handler);
  const shown = text([dialog]);
  for (const expected of ["This server's key changed", "Database · admin@[2001:db8::7]:2222",
    "Key you approved", FP_OLD, ui.api.approvalText(PINNED.key), "Key the server shows now", FP_NEW,
    "the server was reinstalled", "its keys were rotated", "this address now belongs to another machine",
    "someone is intercepting the connection", "Coding Tools can't tell which.",
    "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub", "Or read it in your hosting provider's console.",
    "Agents can't use this host while it is blocked."]) {
    assert.ok(shown.includes(expected), expected);
  }
  assert.ok(shown.indexOf(FP_OLD) < shown.indexOf(FP_NEW), "the approved key comes first");
  assert.ok(ui.all().includes("Key changed, blocked"), "the host is blocked on its row too");
  // The alert is read out with what happened, not only its title.
  const about = []; walk([dialog], (node) => { if (node.props.id && node.props.id === dialog.props["aria-describedby"]) about.push(text([node])); });
  assert.deepEqual(about, ["The server now shows a different key from the one you approved. Agents can't use this host while it is blocked."]);

  assert.deepEqual(ui.buttons(true), ["Replace key", "Stay disconnected"], "no way to use the host with the new key unchecked");
  const stay = ui.button("Stay disconnected", true);
  assert.equal(stay.props.autoFocus, true);
  assert.equal(stay.props.className, "button-primary");
  const replace = ui.button("Replace key", true);
  assert.equal(replace.props.className, "button-secondary");
  assert.notEqual(replace.props.autoFocus, true);
  assert.equal(replace.props.disabled, true, "replacing needs the pasted fingerprint");
  assert.deepEqual(ofType([dialog], "form"), []);
  assert.ok(ofType([dialog], "input").every((node) => node.props.type !== "checkbox" && node.props.autoFocus !== true));

  await ui.key("Escape");
  assert.equal(ui.dialog(), null, "Escape stays disconnected");
  assert.equal(ui.writes().length, 1, "nothing was sent");
  assert.ok(ui.all().includes("Key changed, blocked"));

  // Later, from the row, without fetching again.
  await ui.click("Review key change");
  assert.equal(ui.writes().length, 1);
  ui.paste("New fingerprint from the server", FP_OLD);
  assert.equal(ui.button("Replace key", true).props.disabled, true, "the old key's fingerprint replaces nothing");
  ui.paste("New fingerprint from the server", FP_NEW);
  await ui.click("Replace key", true);
  assert.deepEqual(ui.writes().at(-1), { moduleId: "ssh-connections", operation: "confirm_key",
    arguments: { id: PINNED.id, fingerprint: FP_NEW, pasted: FP_NEW } });
  assert.equal(ui.dialog(), null);
  assert.ok(ui.all().includes(`ssh-ed25519 ${FP_NEW}`) && !ui.all().includes("Key changed, blocked"));
  assert.equal(ui.button("Stay disconnected"), undefined, "no dialog is left");
});

test("a blocked host whose server shows the approved key again is told so, and unblocked only by paste", async () => {
  // Found 2026-11-27: the alert said "The server now shows a different key" over two identical
  // fingerprints. The module keeps such a host blocked on purpose; this is what an interception that
  // has ended looks like.
  const ui = await opened({ respond: fakeModule({ hosts: [CHANGED], shows: { type: "ssh-ed25519", fingerprint: FP_OLD } }) });
  assert.ok(ui.all().includes("The server now shows a different key. Agents can't use this host until you review the change."), "before the fetch the other key is the last one seen");
  await ui.click("Check key");
  const dialog = ui.dialog();
  assert.equal(dialog.props.role, "alertdialog", "still an alert: the host is blocked");
  const shown = text([dialog]);
  assert.ok(!shown.includes("The server now shows a different key"), "it does not claim a different key");
  assert.ok(!shown.includes("This server's key changed"), shown.slice(0, 80));
  for (const expected of ["This server shows the approved key again", "Staging · admin@staging.example.com:22",
    "The server shows the key you approved again. It showed a different one before. Agents can't use this host while it is blocked.",
    "Key you approved", "Key the server shows now", "the address pointed at another machine for a while",
    "someone was intercepting the connection and has stopped", "Coding Tools can't tell which.",
    "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"]) {
    assert.ok(shown.includes(expected), expected);
  }
  assert.equal(shown.split(FP_OLD).length - 1, 2, "the approved key and the one shown now are the same");
  assert.ok(!shown.includes(FP_NEW));
  const about = []; walk([dialog], (node) => { if (node.props.id && node.props.id === dialog.props["aria-describedby"]) about.push(text([node])); });
  assert.equal(about.length, 1);
  assert.match(about[0], /^The server shows the key you approved again\./);

  assert.deepEqual(ui.buttons(true), ["Unblock this host", "Stay disconnected"], "named for what it does");
  assert.equal(ui.button("Stay disconnected", true).props.autoFocus, true);
  assert.equal(ui.button("Unblock this host", true).props.disabled, true, "still only through the pasted fingerprint");
  await ui.click("Stay disconnected", true);
  assert.ok(ui.all().includes("The server showed a different key and now shows the approved one again. Agents can't use this host until you review the change."));
  assert.ok(!ui.all().includes("The server now shows a different key."), "the row does not claim a different key either");
  assert.ok(ui.all().includes("Key changed, blocked"), "and it stays blocked");

  await ui.click("Review key change");
  ui.paste("Fingerprint from the server", FP_NEW);
  assert.equal(ui.button("Unblock this host", true).props.disabled, true, "the other key unblocks nothing");
  ui.paste("Fingerprint from the server", `256 ${FP_OLD} root@staging (ED25519)`);
  await ui.click("Unblock this host", true);
  assert.deepEqual(ui.writes().at(-1), { moduleId: "ssh-connections", operation: "confirm_key",
    arguments: { id: CHANGED.id, fingerprint: FP_OLD, pasted: FP_OLD } });
  assert.equal(ui.dialog(), null);
  assert.ok(!ui.all().includes("Key changed, blocked") && ui.all().includes("Approved"));
});

test("checking an approved host whose key is unchanged only says so", async () => {
  const ui = await opened({ respond: fakeModule({ hosts: [PINNED], shows: { type: "ssh-ed25519", fingerprint: FP_OLD } }) });
  await ui.click("Check key");
  assert.equal(ui.dialog(), null);
  assert.ok(ui.all().includes("The server still shows the key you approved."));

  // A fetch that fails is said on the host's own row, with nothing to approve.
  const down = await opened({ respond: fakeModule({ hosts: [DRAFT], refuse: { fetch_key: "The server did not answer within 25 seconds." } }) });
  await down.click("Confirm key");
  assert.equal(down.dialog(), null);
  assert.ok(down.all().includes("The server did not answer within 25 seconds."));
  assert.deepEqual(down.errors, []);
});

test("Production and Remove send the contract's update and remove calls", async () => {
  const ui = await opened({ respond: fakeModule({ hosts: [DRAFT, PINNED] }) });
  await ui.click("Production: Build server");
  assert.deepEqual(ui.writes(), [{ moduleId: "ssh-connections", operation: "update", arguments: { id: DRAFT.id, production: true } }]);
  await ui.click("Production: Database");
  assert.deepEqual(ui.writes().at(-1).arguments, { id: PINNED.id, production: false });
  const switches = () => ofType(ui.tree(), "button").filter((node) => node.props.role === "switch").map((node) => node.props["aria-checked"]);
  assert.deepEqual(switches(), [true, false]);

  const group = () => { const found = []; walk(ui.tree(), (node) => { if (node.props.role === "group") found.push(node); }); return found; };
  await ofType([group()[1]], "button").find((node) => labelOf(node) === "Remove").props.onClick();
  await ui.settle();
  assert.match(ui.prompts[0], /^Remove “Database” from SSH hosts\?/);
  assert.deepEqual(ui.writes().at(-1), { moduleId: "ssh-connections", operation: "remove", arguments: { id: PINNED.id } });
  assert.deepEqual(group().map((node) => node.props["aria-label"]), ["Build server"]);

  // Declined: nothing is sent. Refused: the switch goes back and the app's error toast says why.
  const kept = await opened({ confirmRemove: false, respond: fakeModule({ hosts: [DRAFT], refuse: { update: "Click into the Coding Tools window and try again" } }) });
  await kept.click("Remove");
  assert.deepEqual(kept.writes(), []);
  await kept.click("Production: Build server");
  assert.deepEqual(kept.errors, ["Click into the Coding Tools window and try again"]);
  assert.equal(kept.button("Production: Build server").props["aria-checked"], false);
});

test("the Production switch waits for its own update, and a refused one shows what is saved", async () => {
  // Found 2026-11-27: the switch stayed live while its update was on its way. Two quick clicks, both
  // refused, left it showing On while the saved value was Off.
  const module = fakeModule({ hosts: [DRAFT] });
  const waiting = [];
  const refusal = { ok: false, moduleId: "ssh-connections", transport: "in-process", result: { ok: false, error: "Apps host is unavailable" } };
  const ui = await opened({ respond: (input) => (input.operation === "update" ? new Promise((resolve) => waiting.push(() => resolve(refusal))) : module(input)) });
  const toggle = () => ui.button("Production: Build server");
  await ui.click("Production: Build server");
  assert.equal(toggle().props["aria-checked"], true, "the change shows at once");
  // The second click of a double click: even one that gets through sends nothing.
  await toggle().props.onClick();
  await ui.settle();
  assert.deepEqual(ui.writes().map((call) => call.arguments), [{ id: DRAFT.id, production: true }], "one update at a time");
  assert.equal(toggle().props.disabled, true, "the switch waits for its update");
  assert.equal(toggle().props["aria-checked"], true);
  for (const finish of waiting.splice(0)) finish();
  await ui.settle();
  assert.equal(toggle().props["aria-checked"], false, "refused: the switch shows the saved value again");
  assert.equal(toggle().props.disabled, false);
  assert.deepEqual(ui.errors, ["Apps host is unavailable"]);
  assert.equal(module({ operation: "list" }).result.hosts[0].production, false);

  // The other way round: a refused Off goes back to On.
  const on = await opened({ respond: fakeModule({ hosts: [PINNED], refuse: { update: "Apps host is unavailable" } }) });
  await on.click("Production: Database");
  assert.equal(on.button("Production: Database").props["aria-checked"], true);
});

test("an approval on its way cannot be closed as if it were cancelled", async () => {
  const module = fakeModule({ hosts: [DRAFT] });
  let finish = () => undefined;
  const ui = await opened({ respond: (input) => (input.operation === "confirm_key"
    ? new Promise((resolve) => { finish = () => resolve(module(input)); }) : module(input)) });
  await ui.click("Confirm key");
  await ui.click("I compared it myself", true);
  assert.deepEqual(ui.buttons(true).slice(1), ["I compared it myself", "Approving…", "Cancel"]);
  assert.ok(ofType([ui.dialog()], "button").filter((node) => labelOf(node) !== "Copy").every((node) => node.props.disabled === true), "one approval at a time");
  await ui.key("Escape");
  assert.ok(ui.dialog(), "Escape does not hide an approval that was already sent");
  finish();
  await ui.settle();
  assert.equal(ui.dialog(), null);
  assert.ok(ui.all().includes("Key approved."));
  assert.equal(ui.writes().filter((call) => call.operation === "confirm_key").length, 1);
});

test("a dialog shows only while the tab is on screen", async () => {
  const ui = await opened({ respond: fakeModule({ hosts: [DRAFT] }) });
  await ui.click("Confirm key");
  assert.ok(ui.dialog());
  // The dialog is drawn into the window, not the tab: a hidden tab's dialog would cover another page.
  ui.show({ active: false });
  assert.equal(ui.dialog(), null);
  assert.equal(ui.pageOff(), false, "and the other page is not left switched off");
  ui.show({ active: true });
  assert.ok(ui.dialog(), "it is back with its tab");
});

test("the keyboard stays in an open dialog: Escape and Tab work wherever the focus is", async () => {
  // Found 2026-11-27 in the browser: the dialog heard its keys only while one of its controls had the
  // focus. After a click on its text (to select the ssh-keygen command) Escape did nothing, and
  // Shift+Tab went to the page behind.
  const ui = await opened({ respond: fakeModule({ hosts: [DRAFT, CHANGED] }) });
  await ui.click("Confirm key");
  assert.equal(ui.focused(), "Cancel", "Cancel has the focus when the dialog opens");
  assert.equal(ui.pageOff(), true, "everything beside the dialog is switched off");

  // A click on the dialog's text keeps the focus in the dialog, and Escape still cancels.
  ui.press(ofType([ui.dialog()], "code")[0]);
  assert.match(ui.focused(), /\bssh-dialog\b/, "the panel takes the focus, not the page");
  await ui.key("Escape");
  assert.equal(ui.dialog(), null, "Escape cancels after a click on the text");
  assert.equal(ui.pageOff(), false, "the page is back");
  assert.equal(ui.focused(), "Confirm key", "and the focus is back on the button the dialog came from");

  // A click on the dimmed area leaves the focus nowhere: Tab still goes into the dialog, at either end.
  await ui.click("Confirm key");
  ui.press(ui.dialog());
  assert.equal(ui.focused(), "page");
  let key = await ui.key("Tab", { shift: true });
  assert.equal(key.defaultPrevented, true, "Shift+Tab is not left to the browser, which went to the page behind");
  assert.equal(ui.focused(), "Cancel", "it goes to the dialog's last control");
  key = await ui.key("Tab");
  assert.equal(key.defaultPrevented, true);
  assert.equal(ui.focused(), "Fingerprint the server sent", "past the last control, Tab starts again at the first");
  key = await ui.key("Tab", { shift: true });
  assert.equal(ui.focused(), "Cancel", "and Shift+Tab on the first goes to the last");
  ui.press(ui.dialog());
  key = await ui.key("Tab");
  assert.equal(key.defaultPrevented, true);
  assert.equal(ui.focused(), "Fingerprint the server sent");
  key = await ui.key("Tab");
  assert.equal(key.defaultPrevented, false, "between its controls the browser moves the focus");
  ui.press(ofType([ui.dialog()], "h2")[0]);
  key = await ui.key("Tab", { shift: true });
  assert.equal(ui.focused(), "Cancel", "from the title too");
  ui.press(ui.dialog());
  await ui.key("Escape");
  assert.equal(ui.dialog(), null, "Escape cancels with the focus nowhere");
  assert.ok(ui.writes().every((call) => call.operation === "fetch_key"), "none of this approved anything");

  // The same for the warning and for Add host, and the focus goes back where each came from.
  await ui.click("Review key change");
  ui.press(ui.dialog());
  await ui.key("Escape");
  assert.equal(ui.dialog(), null);
  assert.equal(ui.focused(), "Review key change");
  await ui.click("Add host");
  assert.ok(ui.hasFocus(ui.input("Label")), "Add host starts in its first field");
  assert.equal(ui.pageOff(), true);
  ui.press(ofType([ui.dialog()], "p")[0]);
  await ui.key("Escape");
  assert.equal(ui.dialog(), null);
  assert.equal(ui.focused(), "Add host");

  // After a key is replaced its "Review key change" button is gone: the focus goes to the row's other key button.
  await ui.click("Review key change");
  ui.paste("New fingerprint from the server", FP_NEW);
  await ui.click("Replace key", true);
  assert.equal(ui.dialog(), null);
  assert.equal(ui.button("Review key change"), undefined);
  assert.equal(ui.focused(), "Check key");
});

test("nothing on the page behind an open dialog acts, and an open review is never replaced", async () => {
  // Found 2026-11-27: from behind the open "Confirm this server's key" dialog, Enter on another host's
  // "Check key" fetched that host's key and put it into the open dialog, and Space on a Production
  // switch changed that host. The page is switched off now; its actions also refuse by themselves.
  const ui = await opened({ respond: fakeModule({ hosts: [DRAFT, CHANGED] }) });
  await ui.click("Confirm key");
  const before = text([ui.dialog()]);
  assert.ok(before.includes("Confirm this server's key") && before.includes("Build server"));
  for (const label of ["Check key", "Review key change", "Production: Staging", "Remove", "Add host", "Confirm key"]) {
    await ui.button(label).props.onClick();
    await ui.settle();
    assert.equal(text([ui.dialog()]), before, `${label}: the dialog is the same one`);
  }
  assert.deepEqual(ui.writes(), [{ moduleId: "ssh-connections", operation: "fetch_key", arguments: { id: DRAFT.id } }], "nothing was sent from behind the dialog");
  assert.deepEqual(ui.prompts, [], "and nothing was asked");
  assert.equal(ofType(ui.tree(), "section").filter((node) => /\bssh-dialog\b/.test(node.props.className || "")).length, 1, "one dialog");

  // With Add host open, the same.
  await ui.click("Cancel", true);
  await ui.click("Add host");
  await ui.button("Check key").props.onClick();
  await ui.button("Production: Build server").props.onClick();
  await ui.settle();
  assert.equal(ui.writes().length, 1);
  assert.ok(text([ui.dialog()]).includes("Add host"));
});

test("every operation the page calls is in the contract, and only on the ssh-connections module", () => {
  const operations = [...source.matchAll(/\bcall\("([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(operations)].sort(), ["add", "confirm_key", "fetch_key", "list", "remove", "terminal_close", "terminal_open", "update"]);
  assert.deepEqual([...source.matchAll(/moduleId: "([^"]+)"/g)].map((match) => match[1]), ["ssh-connections"]);
  assert.match(source, /type SshOperation = "list" \| "add" \| "update" \| "remove" \| "fetch_key" \| "confirm_key" \| "terminal_open" \| "terminal_close";/);
  // The terminal: a host id to open, the handle it gave to close; nothing else goes with either.
  assert.match(source, /call\("terminal_open", \{ id: host\.id \}\)/);
  assert.equal((source.match(/call\("terminal_close", \{ handle \}\)/g) || []).length, 2, "Close terminal, and the page going away with one open");
  assert.match(source, /useEffect\(\(\) => \(\) => \{\s*const handle = openHandle\.current;\s*if \(handle\) void call\("terminal_close", \{ handle \}\)/);
  // The arguments, as the contract's table names them.
  assert.match(source, /call\("list"\)/);
  assert.match(source, /call\("fetch_key", \{ id: host\.id \}\)/);
  assert.match(source, /call\("remove", \{ id: host\.id \}\)/);
  assert.match(source, /call\("update", \{ id: host\.id, production \}\)/);
  // `pasted` is the one value read from the paste, never one chosen with the fetched key in hand.
  assert.match(source, /call\("confirm_key", byPaste\s*\? \{ id: host\.id, fingerprint: candidate\.fingerprint, pasted: pastedValue \}\s*: \{ id: host\.id, fingerprint: candidate\.fingerprint \}\)/);
  assert.match(source, /const pastedValue = found\.length === 1 \? found\[0\] : "";/);
  assert.match(source, /const found = pastedFingerprints\(pasted\);/);
  const add = /call\("add", \{([\s\S]*?)\}\);/.exec(source)[1];
  assert.deepEqual([...add.matchAll(/^\s*(?:\.\.\.\(identityFile \? \{ )?([A-Za-z]+)[:,} ]/gm)].map((match) => match[1]), ["label", "host", "port", "user", "identityFile"]);
  // It goes through the app's typed client, never around it, and holds no key material.
  assert.match(source, /getCodingToolsClient\(\)\.apps\.call\(/);
  assert.doesNotMatch(source, /codexWebLauncher|ipcRenderer|\bfetch\(|localStorage|dangerouslySetInnerHTML/);
  assert.doesNotMatch(source, /\bblob\b/);
});

test("the source offers no way around the comparison, one terminal in remote mode, and only the app's own colours", () => {
  const around = /always[\s-]+trust|trust[\s-]+always|trust[\s-]+anyway|connect[\s-]+anyway|proceed[\s-]+anyway|continue[\s-]+anyway|don['’]?t[\s-]+ask[\s-]+again|remember[\s-]+this|accept[\s-]+(?:the[\s-]+)?risk|ignore[\s-]+(?:the[\s-]+)?(?:warning|change)/i;
  assert.doesNotMatch(source, around);
  assert.doesNotMatch(styles, around);
  // The two key dialogs, as written: the safe button is the focused primary one, the others are secondary.
  assert.match(source, /<button autoFocus className="button-primary" disabled=\{confirming\} onClick=\{closeReview\} type="button">Cancel<\/button>/);
  assert.match(source, /<button autoFocus className="button-primary" disabled=\{confirming\} onClick=\{closeReview\} type="button">Stay disconnected<\/button>/);
  assert.equal((source.match(/autoFocus/g) || []).length, 3, "Cancel, Stay disconnected, and the Add dialog's first field");
  assert.match(source, /<button className="button-secondary" disabled=\{confirming \|\| differs\} onClick=\{\(\) => void confirmKey\(reviewHost, false\)\} type="button">I compared it myself<\/button>/);
  assert.equal((source.match(/confirmKey\(reviewHost, false\)/g) || []).length, 1, "the weaker way is offered once, for a first key only");
  assert.equal((source.match(/confirmKey\(reviewHost, true\)/g) || []).length, 2, "the paste way: a first key and a replaced one");
  for (const match of source.matchAll(/disabled=\{([^}]*)\} onClick=\{\(\) => void confirmKey\(reviewHost, true\)\}/g)) {
    assert.equal(match[1], "confirming || !matches", "approving by paste needs a pasted value that matches");
  }
  // Escape is read on the document, so it cancels wherever the focus is, and the page behind is switched off.
  assert.match(source, /if \(event\.key === "Escape"\) \{ event\.preventDefault\(\); event\.stopPropagation\(\); cancel\(\); return; \}/);
  assert.match(source, /document\.addEventListener\("keydown", onKeyDown, true\);/);
  assert.match(source, /for \(const node of beside\) node\.inert = true;/);
  // The terminal (milestone 2): one button opens it, for an approved host only, and AO shows it in
  // its remote mode, always. No other terminal, no note about one to come.
  assert.doesNotMatch(source, /coming soon|new terminal|>\s*Terminal\s*</i);
  assert.equal((source.match(/"Open terminal"/g) || []).length, 1);
  assert.match(source, /\{terminalAllowed\(host, hosts \?\? \[\]\)\s*\? <button className="button-primary" disabled=\{working \|\| !client\} onClick=\{\(\) => void openTerminal\(host\)\} ref=\{opener\(`terminal:\$\{host\.id\}`\)\} type="button">/);
  assert.match(source, /<AgentOrchestratorOriginalSurface hostbar=\{false\} openMissions=\{\(\) => undefined\}\s*terminal=\{\{ handle: terminal\.handle, generation: terminal\.generation, title: terminal\.title, remote: true \}\} \/>/);
  assert.equal((source.match(/<AgentOrchestratorOriginalSurface/g) || []).length, 1);
  // No colour of its own: tokens only.
  assert.doesNotMatch(styles, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/);
  assert.doesNotMatch(source, /style=\{\{/);
});

test("SSH hosts is registered wherever a tab is", () => {
  const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
  assert.match(read("src/types.ts"), /export type Surface = [^;]*"workspace-auth" \| "ssh-connections" \| /);
  assert.match(read("src/features/ActionTimesPanel.tsx"), /"ssh-connections": "SSH hosts",/);
  const contracts = read("src/api/contracts.ts");
  assert.match(contracts, /call\(input: \{\s*readonly moduleId: "cpa" \| "paseo" \| "anneal" \| "agent-orchestrator" \| "antigravity-cli" \| "ssh-connections";/);
  // Both copies of the App layout map list the tab, with the same words, and the tab can be opened from it.
  const layoutSurface = read("src/features/AppLayoutSurface.tsx");
  assert.match(layoutSurface, /const KNOWN_SURFACES = new Set<string>\(\[[^\]]*"ssh-connections",/);
  const { DEFAULT_APP_LAYOUT } = require("../electron/app-layout.cjs");
  const item = DEFAULT_APP_LAYOUT.categories.find((category) => category.id === "tools-mcp-permissions").items.find((entry) => entry.surfaceId === "ssh-connections");
  assert.ok(item, "electron/app-layout.cjs lists SSH hosts");
  for (const words of [item.id, item.title, item.summary, ...item.bullets]) assert.ok(layoutSurface.includes(`"${words}"`), words);
  const sidebarRow = DEFAULT_APP_LAYOUT.layers.find((layer) => layer.id === "sidebar").rows.find((row) => row.id === "sidebar-tools-mcp");
  assert.match(sidebarRow.currentLocation, /Connections › Workspace Auth \/ SSH hosts/);
  const line = sidebarRow.items.find((entry) => entry.includes("ssh-connections"));
  assert.ok(line && layoutSurface.includes(`"${line}"`) && layoutSurface.includes(`"${sidebarRow.currentLocation}"`));
});

// ---------------------------------------------------------------------------------------------
// The in-app terminal (milestone 2)

test("an approved host opens in the terminal panel, in AO's remote mode, and Close terminal shows the list again", async () => {
  const ui = await opened({ respond: fakeModule({ hosts: [DRAFT, PINNED, CHANGED] }) });
  assert.equal(ofType(ui.tree(), "ao-view").length, 0, "no terminal until one is opened");
  await ui.click("Open terminal");
  assert.deepEqual(ui.writes(), [{ moduleId: "ssh-connections", operation: "terminal_open", arguments: { id: PINNED.id } }]);

  // The panel takes the list's place: the host's label, its address, the Production tag, and Close.
  const views = ofType(ui.tree(), "ao-view");
  assert.equal(views.length, 1);
  assert.deepEqual(views[0].props, { hostbar: false, terminal: { handle: "shellterm-ssh-1", generation: "2026-11-27T10:00:00Z", title: "Database", remote: true },
    opensMissions: "function", missions: undefined, children: [] }, "remote mode, always, and no Missions button of its own");
  const panel = []; walk(ui.tree(), (node) => { if (node.props.role === "group") panel.push(node); });
  assert.deepEqual(panel.map((node) => node.props["aria-label"]), ["SSH terminal: Database"]);
  const shown = ui.all();
  for (const expected of ["Database", "admin@[2001:db8::7]:2222", "Production", "Close terminal"]) assert.ok(shown.includes(expected), expected);
  assert.deepEqual(ui.buttons(), ["Close terminal"], "one terminal at a time: nothing else can be opened or changed from here");
  const chips = []; walk(ui.tree(), (node) => { if (String(node.props.className || "").includes("app-plugin-chip")) chips.push([node.props.className, text([node])]); });
  assert.deepEqual(chips, [["app-plugin-chip ssh-host-state is-error", "Production"]]);
  for (const gone of ["Build server", "Staging", "Add host", "Check key", "Fingerprint"]) assert.ok(!shown.includes(gone), gone);

  // Close terminal closes it in the module with the handle it gave, then the list is back, with
  // the focus on the row's Open terminal button (the panel's Close went with the panel).
  await ui.click("Close terminal");
  assert.deepEqual(ui.writes().at(-1), { moduleId: "ssh-connections", operation: "terminal_close", arguments: { handle: "shellterm-ssh-1" } });
  assert.equal(ofType(ui.tree(), "ao-view").length, 0);
  assert.ok(ui.all().includes("Build server") && ui.all().includes("Add host"));
  assert.deepEqual(ui.errors, []);
  assert.equal(ui.focused(), "Open terminal");
  const focusedRow = []; walk(ui.tree(), (node) => { if (node.props.role === "group" && ofType([node], "button").some((button) => ui.hasFocus(button))) focusedRow.push(node.props["aria-label"]); });
  assert.deepEqual(focusedRow, ["Database"], "that host's row");

  // A host that is not production has no tag.
  const plainHost = { ...PINNED, id: "778899aabbcc", label: "Plain", host: "plain.example.com", port: 22, production: false };
  const other = await opened({ respond: fakeModule({ hosts: [plainHost] }) });
  await other.click("Open terminal");
  assert.ok(other.all().includes("deploy") === false && other.all().includes("admin@plain.example.com:22"));
  assert.ok(!other.all().includes("Production"));
});

test("Open terminal shows for approved hosts only, waits while busy, and needs the ssh client", async () => {
  const ui = await opened({ respond: fakeModule({ hosts: [DRAFT, PINNED, CHANGED] }) });
  assert.deepEqual(ui.buttons().filter((label) => label === "Open terminal").length, 1);
  const groups = []; walk(ui.tree(), (node) => { if (node.props.role === "group") groups.push(node); });
  assert.deepEqual(groups.map((node) => ofType([node], "button").some((button) => labelOf(button) === "Open terminal")), [false, true, false]);
  const missing = await opened({ respond: fakeModule({ client: null, hosts: [PINNED] }) });
  assert.equal(missing.button("Open terminal").props.disabled, true, "no ssh client, no terminal");

  // While it opens, it and every other action wait; a second click sends nothing more.
  const module = fakeModule({ hosts: [PINNED] });
  let finish = () => undefined;
  const slow = await opened({ respond: (input) => (input.operation === "terminal_open" ? new Promise((resolve) => { finish = () => resolve(module(input)); }) : module(input)) });
  await slow.click("Open terminal");
  assert.equal(slow.button("Opening…").props.disabled, true);
  assert.equal(slow.button("Check key").props.disabled, true);
  await slow.button("Opening…").props.onClick();
  assert.equal(slow.writes().length, 1);
  finish();
  await slow.settle();
  assert.ok(slow.button("Close terminal"));

  // From behind an open dialog nothing opens.
  const behind = await opened({ respond: fakeModule({ hosts: [DRAFT, PINNED] }) });
  await behind.click("Confirm key");
  await behind.button("Open terminal").props.onClick();
  await behind.settle();
  assert.deepEqual(behind.writes().map((call) => call.operation), ["fetch_key"]);
  assert.ok(behind.dialog());
});

test("a refused open says why on the host's row, in the module's words, and shows no terminal", async () => {
  const words = "OpenSSH was not found on this computer, so the terminal was not opened.";
  const ui = await opened({ respond: fakeModule({ hosts: [PINNED], refuse: { terminal_open: { error: words, code: "no_client" } } }) });
  await ui.click("Open terminal");
  assert.equal(ofType(ui.tree(), "ao-view").length, 0);
  const notes = []; walk(ui.tree(), (node) => { if (node.props.role === "status" && String(node.props.className).includes("app-plugin-detail")) notes.push([node.props.className, text([node])]); });
  assert.deepEqual(notes, [["app-plugin-detail is-error", words]]);
  assert.deepEqual(ui.errors, [], "not also a toast");
  assert.equal(ui.button("Open terminal").props.disabled, false, "it can be tried again");
});

test("a close that fails keeps the terminal with the reason; one the module does not know goes back to the list", async () => {
  const module = fakeModule({ hosts: [PINNED] });
  let closing = (input) => module(input);
  const ui = await opened({ respond: (input) => (input.operation === "terminal_close" ? closing(input) : module(input)) });
  await ui.click("Open terminal");
  closing = () => ({ ok: false, result: { ok: false, error: "The terminal could not be closed. Try again.", code: "close_failed" } });
  await ui.click("Close terminal");
  assert.equal(ofType(ui.tree(), "ao-view").length, 1, "still on screen, to be closed again");
  const alerts = []; walk(ui.tree(), (node) => { if (node.props.role === "alert") alerts.push(text([node])); });
  assert.deepEqual(alerts, ["The terminal could not be closed. Try again."]);
  closing = (input) => module(input);
  await ui.click("Close terminal");
  assert.equal(ofType(ui.tree(), "ao-view").length, 0);
  assert.ok(ui.all().includes("Add host"));

  // The module no longer knows the handle (the app's backend restarted): back to the list, said on the row.
  await ui.click("Open terminal");
  closing = () => ({ ok: false, result: { ok: false, error: "This terminal was not opened from the SSH hosts page, so it was not closed here.", code: "not_own" } });
  await ui.click("Close terminal");
  assert.equal(ofType(ui.tree(), "ao-view").length, 0);
  assert.ok(ui.all().includes("This terminal was not opened from the SSH hosts page, so it was not closed here."));
  assert.ok(ui.button("Open terminal"));
  assert.equal(ui.focused(), "Open terminal", "the focus goes back to the row here too");
});

test("a panel that closes while the tab is hidden gives the focus back once the tab is on screen", async () => {
  const module = fakeModule({ hosts: [DRAFT, PINNED] });
  let finish = () => undefined;
  const ui = await opened({ respond: (input) => (input.operation === "terminal_close" ? new Promise((resolve) => { finish = () => resolve(module(input)); }) : module(input)) });
  await ui.click("Open terminal");
  await ui.click("Close terminal");
  // The person switched to another tab before the close came back.
  ui.show({ active: false });
  finish();
  await ui.settle();
  assert.equal(ofType(ui.tree(), "ao-view").length, 0);
  assert.equal(ui.focused(), "page", "no focus is moved inside a hidden tab");
  ui.show({ active: true });
  await ui.settle();
  assert.equal(ui.focused(), "Open terminal");
  // Only once: switching tabs again moves nothing.
  ui.press(ofType(ui.tree(), "h1")[0]);
  ui.show({ active: false });
  ui.show({ active: true });
  await ui.settle();
  assert.equal(ui.focused(), "page");
});

test("the terminal is offered only where the module would open one: approved, with no other key known for the server", () => {
  const { api } = mount({ active: false });
  const host = api.hostOf(PINNED);
  assert.equal(api.terminalAllowed(host, [host]), true);
  for (const state of ["draft", "changed"]) assert.equal(api.terminalAllowed({ ...host, state }, [{ ...host, state }]), false, state);
  assert.equal(api.terminalAllowed({ ...host, key: null }, [{ ...host, key: null }]), false, "no confirmed key");
  // Another entry for the same server and port approved with another key: ssh would accept either.
  const root = { ...host, id: "665544332211", user: "root", key: { ...host.key, fingerprint: FP_OTHER } };
  assert.equal(api.terminalAllowed(host, [host, root]), false);
  assert.equal(api.terminalAllowed(host, [host, { ...root, port: 22 }]), true, "another port is another server");
  assert.equal(api.terminalAllowed(host, [host, { ...root, key: host.key }]), true, "the same key through another entry");
  // A key fetched from the server since it was approved that is not this one.
  const fetchedAfter = { ...root, key: host.key, state: "draft", candidate: { type: "ssh-ed25519", fingerprint: FP_NEW, fetchedAt: "2026-11-22T09:30:00.000Z" } };
  assert.equal(api.terminalAllowed(host, [host, fetchedAfter]), false);
  assert.equal(api.terminalAllowed(host, [host, { ...fetchedAfter, candidate: { ...fetchedAfter.candidate, fetchedAt: "2026-11-20T09:30:00.000Z" } }]), true, "one fetched before it was approved");
  assert.equal(api.terminalAllowed(host, [host, { ...fetchedAfter, candidate: { ...fetchedAfter.candidate, fetchedAt: null } }]), false, "a time not recorded counts as after");

  // The module's answer, read as the page keeps it: always remote; the Production tag if either says so.
  assert.deepEqual(plain(api.terminalOf({ handle: "shellterm-ssh-1", generation: "g", title: "Database", production: false }, host)),
    { handle: "shellterm-ssh-1", generation: "g", title: "Database", hostId: host.id, label: "Database", address: "admin@[2001:db8::7]:2222", production: true });
  assert.equal(api.terminalOf({ handle: "shellterm-ssh-1" }, host).generation, "shellterm-ssh-1");
  for (const bad of [null, {}, { handle: "bad handle" }, { handle: "" }, { handle: 7 }]) assert.equal(api.terminalOf(bad, host), null, JSON.stringify(bad));
});
