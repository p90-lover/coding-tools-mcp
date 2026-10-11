const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { randomUUID } = require("node:crypto");

function load(file, imports = {}) {
  const exports = {};
  const absolute = path.resolve(__dirname, "../src/features", file);
  if (!fs.existsSync(absolute)) return exports;
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(absolute, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, crypto: { randomUUID }, structuredClone, require: name => imports[name] ?? {} });
  return exports;
}
const roles = load("AgentOrchestratorRoleEditor.tsx");
const teamEditor = load("AgentOrchestratorTeam.tsx", { "./AgentOrchestratorRoleEditor": roles });
// The canvas's pure helpers (link routing, link points), without its React component.
function canvasHelpers() {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorCanvas.tsx"), "utf8");
  const start = source.indexOf("export type WireBox"), end = source.indexOf("export function AgentOrchestratorCanvas");
  const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const helpers = {}; new Function("exports", code)(helpers);
  return helpers;
}
const teams = load("AgentOrchestratorTeamsSurface.tsx", { "./AgentOrchestratorRoleEditor": roles, "./AgentOrchestratorTeam": teamEditor, "./AgentOrchestratorCanvas": canvasHelpers() });
const fixture = () => roles.defaultTeam("workspace-a", roles.workerRoute(roles.DEFAULT_WORKER_HARNESS, roles.DEFAULT_WORKER_MODEL));

test("a mission editor never replaces its own snapshot with an unrelated default team", () => {
  const original = fixture(), other = fixture();
  original.name = "Original";
  other.name = "Other default";
  const mission = { id: "run", workspace_id: "workspace-a", nodes: [], team: original };
  const draft = roles.teamForMission(mission, other);
  assert.equal(draft.id, original.id);
  draft.nodes[0].settings.name = "Changed draft";
  assert.notEqual(mission.team.nodes[0].settings.name, "Changed draft");
});

test("duplicating a team keeps role configuration and layout, not default status or revisions", () => {
  assert.equal(typeof teams.duplicateTeam, "function");
  const original = fixture();
  original.revision = 4; original.is_default = true;
  original.nodes[1].positioned = true; original.nodes[1].x = 190; original.nodes[1].y = 215;
  original.nodes[1].settings.role_name = "Security auditor";
  const before = structuredClone(original);
  const copy = teams.duplicateTeam(original);
  assert.notEqual(copy.id, original.id);
  assert.equal(copy.workspace_id, original.workspace_id);
  assert.equal(copy.revision, 0);
  assert.equal(copy.is_default, false);
  assert.equal(copy.nodes[1].x, 190);
  assert.equal(copy.nodes[1].settings.role_name, "Security auditor");
  assert.equal(JSON.stringify(original), JSON.stringify(before));
});

test("team graph helper roles preserve explicit worker chains and add the review split only when needed", () => {
  assert.equal(typeof teams.prepareTeamGraph, "function");
  const original = fixture();
  const next = structuredClone(original);
  next.nodes.push({ ...structuredClone(next.nodes[1]), id: "worker-2", parents: ["worker"] });
  let prepared = teams.prepareTeamGraph(next, original);
  assert.deepEqual(Array.from(prepared.nodes.find(n => n.id === "worker-2").parents), ["worker"]);
  assert.equal(prepared.editable_graph, true);
  const before = structuredClone(prepared);
  prepared.nodes.push({ ...structuredClone(prepared.nodes[2]), id: "sub", role: "sub_reviewer", parents: ["lead"] });
  prepared = teams.prepareTeamGraph(prepared, before);
  const split = prepared.nodes.find(n => n.role === "review_split");
  assert.ok(split);
  assert.ok(prepared.nodes.find(n => n.id === "sub").parents.includes(split.id));
  assert.ok(prepared.nodes.find(n => n.role === "reviewer").parents.includes("sub"));
  assert.deepEqual(Array.from(prepared.nodes.find(n => n.id === "worker-2").parents), ["worker"]);
});

test("the Runtime team manager reuses the overview canvas and hides execution tabs in template mode", () => {
  const app = fs.readFileSync(path.resolve(__dirname, "../src/App.tsx"), "utf8");
  assert.match(app, /label="Orchestrator Team"/);
  assert.match(app, /surface === "agent-orchestrator-teams"/);
  const absolute = path.resolve(__dirname, "../src/features/AgentOrchestratorTeamsSurface.tsx");
  assert.ok(fs.existsSync(absolute));
  const source = fs.readFileSync(absolute, "utf8");
  assert.match(source, /<AgentOrchestratorCanvas/);
  assert.match(source, /<AgentOrchestratorRoleEditor/);
  assert.match(source, /template/);
});

test("the team page has a left palette of roles and preset workers, and an explicit save beside auto-save", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorTeamsSurface.tsx"), "utf8");
  assert.match(source, /<aside className="ao-teams-palette" aria-label="Add roles">/);
  for (const role of ["worker", "approver", "sub_reviewer", "retry"]) assert.ok(source.includes(`add("${role}")`), role);
  for (const preset of ["Frontend", "Backend", "Tester", "Researcher", "Security auditor", "Docs writer", "DevOps"]) assert.match(source, new RegExp(`roleName: "${preset}"`));
  assert.match(source, /role_name: preset\.roleName, specialty: preset\.specialty/, "a preset worker carries its role name and specialty");
  assert.match(source, /\{saving \? "Saving…" : dirty \? "Save team" : "Saved"\}/);
});

test("the team page keeps saving after a reload or a save elsewhere, shows no run state, and offers real model tuning", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorTeamsSurface.tsx"), "utf8");
  // A kept draft moves onto the stored revision; a stale one was refused by every later save.
  assert.match(source, /stored && stored\.revision !== current\.revision \? \{ \.\.\.current, revision: stored\.revision \} : current/);
  // A conflict reloads and rebases (the automatic save then goes again) only when the stored revision moved.
  assert.match(source, /\/revision changed\/i\.test\(message\)/);
  assert.match(source, /if \(stored && stored\.revision !== sent\.revision\) \{ accept\(latest, sent\.id, true\); return; \}/);
  // A saved team is a template: no "Pending" on its cards.
  assert.match(source, /<AgentOrchestratorCanvas [^>]*showState=\{false\}/);
  const canvas = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorCanvas.tsx"), "utf8");
  assert.match(canvas, /\{showState \? <span className="ao-canvas-state">/);
  // The model catalog keeps its capabilities, so effort and context window are offered.
  assert.match(source, /result\.capabilities \? \{ models: names, capabilities: result\.capabilities/);
});

test("a saved team can be deleted from the team page; the last team stays and chats keep their copy", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorTeamsSurface.tsx"), "utf8");
  assert.ok(source.includes('operation: "delete_team", team_id: saved.id, expected_revision: saved.revision'));
  assert.ok(source.includes("teams.length < 2"), "the last team cannot be deleted");
  assert.ok(source.includes("Existing chats keep their own copy of it."), "deletion is confirmed");
  const workflow = fs.readFileSync(path.resolve(__dirname, "../electron/agent-orchestrator-workflow.cjs"), "utf8");
  assert.ok(workflow.includes('["save_team", "delete_team", "apply_team", "set_limits"]'));
});

test("links go around cards: a direct orchestrator-to-reviewer link no longer runs through a worker", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorCanvas.tsx"), "utf8");
  const start = source.indexOf("export type WireBox"), end = source.indexOf("export function AgentOrchestratorCanvas");
  const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const canvas = {}; new Function("exports", code)(canvas);
  const card = (x, y) => ({ x, y, w: 212, h: 76 });
  const lead = card(400, 0), workers = [card(0, 200), card(400, 200), card(800, 200)], reviewer = card(400, 420);
  const numbers = d => d.match(/-?\d+(\.\d+)?/g).map(Number);
  // Straight down past the middle worker: detour to a side lane clear of it.
  const around = canvas.wirePath(lead, reviewer, workers);
  assert.match(around, /Q/, "a detour with rounded corners");
  const points = []; const all = numbers(around); for (let i = 0; i + 1 < all.length; i += 2) points.push([all[i], all[i + 1]]);
  const inside = (box, [x, y]) => x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h;
  assert.ok(points.every(point => workers.every(worker => !inside(worker, point))), "no point of the link is inside a worker");
  const lane = points.find(([x, y], i) => y < 200 && points[i + 1]?.[0] === x && points[i + 1][1] > 276);
  assert.ok(lane && workers.every(worker => lane[0] < worker.x || lane[0] > worker.x + worker.w), "a side lane passes the worker row between cards");
  // Nothing in the way: the usual curve.
  assert.match(canvas.wirePath(lead, workers[1], []), /^M506,76 C/);
  // A child above its parent (a link back up): routed around, never a straight crossing.
  assert.match(canvas.wirePath(reviewer, lead, workers), /Q/);
});

test("routed links keep clear of every card, take their own lanes and fan into a card side by side", () => {
  const canvas = canvasHelpers();
  const card = (x, y) => ({ x, y, w: 212, h: 76 });
  // The team from the user's screenshot: three workers, a review split with a sub-reviewer, a reviewer.
  const boxes = new Map(Object.entries({ orch: card(470, 40), w1: card(240, 270), w2: card(510, 290), w3: card(730, 300),
    split: card(495, 430), sub: card(460, 690), rev: card(810, 660) }));
  const links = [["orch", "w1"], ["orch", "w2"], ["orch", "w3"], ["w1", "split"], ["w2", "split"], ["w3", "split"], ["split", "sub"],
    ["w1", "rev"], ["w2", "rev"], ["w3", "rev"], ["sub", "rev"], ["orch", "rev"]].map(([from, to]) => ({ key: `${from}>${to}`, from, to }));
  links.push({ key: "loop", from: "rev", to: "orch" });
  const ports = canvas.linkPorts(boxes, links);
  const intoReviewer = links.filter(link => link.to === "rev").map(link => [link.from, ports.get(link.key).into]);
  assert.equal(new Set(intoReviewer.map(([, x]) => x)).size, intoReviewer.length, "each link into the reviewer has its own point");
  const byX = [...intoReviewer].sort((a, b) => a[1] - b[1]).map(([from]) => from);
  const centre = id => boxes.get(id).x + 106;
  assert.deepEqual(byX, [...byX].sort((a, b) => centre(a) - centre(b)), "points are ordered by where each link comes from");

  const started = Date.now();
  const shapes = canvas.routeLinks(boxes, links);
  assert.ok(Date.now() - started < 1000, "routing a team this size is quick");
  assert.equal(shapes.size, links.length);
  const numbers = d => d.match(/-?\d+(\.\d+)?/g).map(Number);
  const pairs = d => { const all = numbers(d), out = []; for (let i = 0; i + 1 < all.length; i += 2) out.push([all[i], all[i + 1]]); return out; };
  for (const link of links) {
    for (const [x, y] of pairs(shapes.get(link.key))) for (const [id, box] of boxes) {
      if (id === link.from || id === link.to) continue;
      assert.ok(!(x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h), `${link.key} passes through ${id}`);
    }
  }
  // A routed link's corners are its Q control points: rebuild each polyline and check lanes.
  const routed = links.filter(link => shapes.get(link.key).includes("Q")).map(link => {
    const d = shapes.get(link.key), corners = [...d.matchAll(/Q(-?[\d.]+),(-?[\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])]);
    const start = pairs(d)[0], end = pairs(d).at(-1);
    return { key: link.key, points: [start, ...corners, end] };
  });
  assert.ok(routed.length >= 3, "links that would cross cards are routed around them");
  const runs = routed.flatMap(({ key, points }) => points.slice(1, -2).map((a, i) => ({ key, a, b: points[i + 2] })));
  for (const one of runs) for (const other of runs) {
    if (one.key === other.key) continue;
    const vertical = one.a[0] === one.b[0] && other.a[0] === other.b[0] && one.a[0] === other.a[0];
    const horizontal = one.a[1] === one.b[1] && other.a[1] === other.b[1] && one.a[1] === other.a[1];
    const span = (s, axis) => [Math.min(s.a[axis], s.b[axis]), Math.max(s.a[axis], s.b[axis])];
    if (vertical) { const [a1, a2] = span(one, 1), [b1, b2] = span(other, 1); assert.ok(Math.min(a2, b2) - Math.max(a1, b1) <= 0, `${one.key} and ${other.key} share a lane`); }
    if (horizontal) { const [a1, a2] = span(one, 0), [b1, b2] = span(other, 0); assert.ok(Math.min(a2, b2) - Math.max(a1, b1) <= 0, `${one.key} and ${other.key} share a lane`); }
  }
  // Every link is drawn the same way: right angles with rounded corners, never a free curve.
  for (const link of links) assert.doesNotMatch(shapes.get(link.key), / C/, `${link.key} is orthogonal`);
  // A link whose ends nearly line up runs straight down, both ends on one x.
  const straight = canvas.routeLinks(new Map([["a", card(400, 0)], ["b", card(420, 200)]]), [{ key: "a>b", from: "a", to: "b" }]);
  assert.match(straight.get("a>b"), /^M(\d+),76 L\1,200$/);
  // A link going down (its child starts below its parent) never climbs back up on the way (no loops).
  const below = link => boxes.get(link.to).y > boxes.get(link.from).y + boxes.get(link.from).h + 40;
  for (const link of links.filter(below)) {
    const ys = pairs(shapes.get(link.key)).map(([, y]) => y);
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] >= ys[i - 1] - 1, `${link.key} climbs from ${ys[i - 1]} to ${ys[i]}`);
  }
  // A pulled link keeps its point.
  const pulled = canvas.routeLinks(boxes, [{ key: "orch>rev", from: "orch", to: "rev", via: { x: 1100, y: 400 } }]);
  assert.match(pulled.get("orch>rev"), / 1100,400 S/);
});

test("every card can be removed: optional ones go, required ones are replaced, the split takes its sub-reviewers", () => {
  const team = fixture();
  const planner = team.nodes.find(node => node.role === "planner"), worker = team.nodes.find(node => node.role === "worker");
  const reviewer = team.nodes.find(node => node.role === "reviewer");
  const defaults = fixture();
  // A sub-reviewer brings the split pass; removing the last one drops the split and the main reviewer
  // goes back to the workers (it used to fall back to the orchestrator, which the service refuses).
  const sub = { ...structuredClone(worker), id: "sub-1", role: "sub_reviewer", parents: [planner.id], settings: { ...worker.settings, name: "Sub-reviewer 1" } };
  const withSub = teamEditor.prepareTeamGraph({ ...team, nodes: [...team.nodes, sub] }, team);
  const split = withSub.nodes.find(node => node.role === "review_split");
  assert.ok(split, "a split pass comes with the first sub-reviewer");
  const removedSub = teams.removeFromTeam(withSub, "sub-1", defaults);
  assert.equal(removedSub.confirm, undefined, "an optional card goes without asking");
  const after = teamEditor.prepareTeamGraph(removedSub.team, withSub);
  assert.equal(after.nodes.some(node => node.role === "review_split" || node.role === "sub_reviewer"), false);
  const reviewerParents = [...after.nodes.find(node => node.id === reviewer.id).parents];
  assert.ok(reviewerParents.includes(worker.id), "the main reviewer reconnects to the workers through the removed split");
  assert.ok(reviewerParents.every(id => after.nodes.some(node => node.id === id)), "no link to a removed card is left behind");
  // The split goes with all of its sub-reviewers, after asking.
  const splitRemoval = teams.removeFromTeam(withSub, split.id, defaults);
  assert.match(splitRemoval.confirm, /removes the sub-reviewer too/);
  assert.equal(splitRemoval.team.nodes.some(node => ["review_split", "sub_reviewer"].includes(node.role)), false);
  // A card the team can't run without is replaced by a fresh default in its place, keeping its links.
  for (const id of [planner.id, reviewer.id, worker.id]) {
    const changed = structuredClone(team);
    changed.nodes.find(node => node.id === id).settings.name = "Customised";
    const outcome = teams.removeFromTeam(changed, id, defaults);
    assert.match(outcome.confirm, /A team needs (an orchestrator|a main reviewer|at least one worker)/);
    const fresh = outcome.team.nodes.find(node => node.id === id);
    assert.notEqual(fresh.settings.name, "Customised");
    assert.deepEqual([...fresh.parents], [...changed.nodes.find(node => node.id === id).parents]);
    assert.equal(outcome.team.nodes.length, changed.nodes.length);
  }
  // A second worker is optional.
  const twoWorkers = { ...team, nodes: [...team.nodes, { ...structuredClone(worker), id: "w2" }] };
  assert.equal(teams.removeFromTeam(twoWorkers, "w2", defaults).confirm, undefined);
  assert.equal(teams.removeFromTeam(team, "missing", defaults), null);
});

test("a card's right-click menu names why it can't be removed", () => {
  const canvas = canvasHelpers();
  const node = (id, role) => ({ id, role, parents: [], state: "pending", x: 0, y: 0, task_id: "", route: { model: "" } });
  const nodes = [node("lead", "planner"), node("w", "worker"), node("rev", "reviewer"), node("split", "review_split")];
  assert.match(canvas.removalReason(nodes[0], nodes), /orchestrator/);
  assert.match(canvas.removalReason(nodes[2], nodes), /main reviewer/);
  assert.match(canvas.removalReason(nodes[3], nodes), /sub-reviewers/);
  assert.match(canvas.removalReason(nodes[1], nodes), /at least one worker/);
});

test("a Shift-dragged link passes through its point, and a loop back to the orchestrator goes around the cards", () => {
  const canvas = canvasHelpers();
  const card = (x, y) => ({ x, y, w: 212, h: 76 });
  const lead = card(400, 0), workers = [card(0, 200), card(400, 200), card(800, 200)], reviewer = card(400, 420);
  const pulled = canvas.wirePath(lead, workers[1], [], 0, { x: 300, y: 150 });
  assert.match(pulled, /^M506,76 C506,/);
  assert.match(pulled, / 300,150 S/, "the link reaches the pulled point, then continues to its child");
  assert.match(pulled, / 506,200$/);
  // The loop from the reviewer up to the orchestrator: no point of it inside a worker.
  const loop = canvas.wirePath(reviewer, lead, workers);
  const all = loop.match(/-?\d+(\.\d+)?/g).map(Number); const points = [];
  for (let i = 0; i + 1 < all.length; i += 2) points.push([all[i], all[i + 1]]);
  assert.ok(points.every(([x, y]) => workers.every(w => !(x > w.x && x < w.x + w.w && y > w.y && y < w.y + w.h))));
  assert.deepEqual(canvas.scenePoint(250, 180, { left: 50, top: 30 }, { x: 100, y: 50, scale: 2 }), { x: 50, y: 50 });
  assert.equal(canvas.linkPointKey("lead", "worker"), "lead>worker");
});

test("a looping team draws the reviewer's way back, and link points follow the team's links", () => {
  const team = fixture();
  const planner = team.nodes.find(node => node.role === "planner"), reviewer = team.nodes.find(node => node.role === "reviewer");
  assert.equal(teams.teamLoop(team), null, "no loop until the team turns it on");
  team.review_loop = true;
  assert.deepEqual({ ...teams.teamLoop(team) }, { from: reviewer.id, to: planner.id });
  const worker = team.nodes.find(node => node.role === "worker" && node.parents.includes(planner.id));
  const key = `${planner.id}>${worker.id}`;
  team.link_points = { "gone>link": { x: 1, y: 1 }, loop: { x: 9, y: 9 } };
  const bent = teams.bentLinks(team, key, { x: 10.4, y: -3.6 });
  assert.deepEqual(JSON.parse(JSON.stringify(bent)), { loop: { x: 9, y: 9 }, [key]: { x: 10, y: -4 } }, "stale points drop; the new one is rounded");
  assert.deepEqual(JSON.parse(JSON.stringify(teams.bentLinks({ ...team, link_points: bent }, key, null))), { loop: { x: 9, y: 9 } }, "Shift-double-click resets a link");
  assert.deepEqual(JSON.parse(JSON.stringify(teams.bentLinks(team, "not>a-link", { x: 1, y: 1 }))), { loop: { x: 9, y: 9 } }, "a point for a missing link is not kept");
});

test("a block's role editor opens as a popover beside it, survives autosaves and closes on a press outside", () => {
  const source = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorTeamsSurface.tsx"), "utf8");
  // An automatic save reloads the team; the open role stays open while its block still exists.
  assert.match(source, /setSelectedId\(current => chosen\?\.nodes\.some\(node => node\.id === current\) \? current : ""\)/);
  // A popover anchored to the clicked block, inside the page (so the orchestrator's styles still apply).
  assert.match(source, /querySelector\(`\[data-ao-node="\$\{CSS\.escape\(selectedId\)\}"\]`\)/);
  assert.match(source, /<div className="ao-team-popover" role="dialog" aria-label="Team role editor"/);
  assert.ok(!source.includes('<aside className="ao-teams-inspector"'), "the fixed side panel is gone");
  // Outside presses close it; presses on another block switch to that block; Escape closes.
  assert.match(source, /target\.closest\("\.ao-team-popover, \[data-ao-node\]"\)/);
  assert.match(source, /if \(event\.key === "Escape"\) setSelectedId\(""\)/);
  const canvas = fs.readFileSync(path.resolve(__dirname, "../src/features/AgentOrchestratorCanvas.tsx"), "utf8");
  assert.match(canvas, /if \(!selectedId\) setSelected\(current => current\.size \? new Set\(\) : current\)/);
});
test("the chat and Team pages keep asking for the harness list while AO is still starting", () => {
  const read = name => fs.readFileSync(path.resolve(__dirname, "../src/features", name), "utf8");
  const surface = read("AgentOrchestratorSurface.tsx");
  const watch = surface.slice(surface.indexOf("export function watchHarnesses"), surface.indexOf("/** Per-viewer chat list state"));
  assert.ok(watch.includes("if (!notice) return;"), "it stops once AO answers without a notice");
  assert.ok(watch.includes("attempt < 20"), "and gives up after a few minutes");
  for (const page of ["AgentOrchestratorSurface.tsx", "AgentOrchestratorTeamsSurface.tsx"]) {
    assert.ok(read(page).includes("const stopHarnesses = watchHarnesses("), page);
    assert.ok(read(page).includes("stopHarnesses(); };"), page + " stops asking when it closes");
  }
});
