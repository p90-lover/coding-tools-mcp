"use strict";
require("./support/temp-dirs.cjs"); // removes the temp folders this file makes when it ends

// A const read during render before its declaration throws "Cannot access 'x' before
// initialization" and unmounts the whole window (2026-10-20: the approval filter read
// `selectedRun` 400 lines before it was declared). TypeScript reports such a read only at the top
// level of a scope, never inside a callback, so this test resolves every identifier with the
// checker and flags reads of a later const/let that run synchronously: directly, or inside array
// methods, useMemo/useState/useReducer initializers and IIFEs. Event handlers and effects run
// later and are ignored.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require(require.resolve("typescript", { paths: [path.resolve(__dirname, "..")] }));

const SYNC_METHODS = new Set(["filter", "map", "some", "every", "find", "findIndex", "findLast", "forEach", "reduce", "flatMap", "sort", "toSorted"]);
const SYNC_HOOKS = new Set(["useMemo", "useState", "useReducer"]);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(tsx?|jsx?)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [full] : [];
  });
}

function renderTimeTdzReads(files) {
  const program = ts.createProgram(files, {
    jsx: ts.JsxEmit.ReactJSX, noEmit: true, skipLibCheck: true, allowJs: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
  });
  const checker = program.getTypeChecker();
  const findings = [];
  const runsNow = (fn) => {
    const parent = fn.parent;
    if (ts.isParenthesizedExpression(parent) && ts.isCallExpression(parent.parent) && parent.parent.expression === parent) return true;
    if (!ts.isCallExpression(parent) || !parent.arguments.includes(fn)) return false;
    const callee = parent.expression;
    if (ts.isPropertyAccessExpression(callee) && SYNC_METHODS.has(callee.name.text)) return true;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
    return SYNC_HOOKS.has(name);
  };
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    const visitBody = (body) => {
      const declared = new Map();
      for (const statement of body.statements) {
        if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & (ts.NodeFlags.Const | ts.NodeFlags.Let))) continue;
        for (const declaration of statement.declarationList.declarations) {
          const collect = (binding) => {
            if (ts.isIdentifier(binding)) declared.set(binding.text, { at: statement.getStart(), declaration });
            else for (const element of binding.elements) if (!ts.isOmittedExpression(element)) collect(element.name);
          };
          collect(declaration.name);
        }
      }
      if (!declared.size) return;
      const check = (node, deferred) => {
        if (ts.isFunctionLike(node) && node !== body.parent) {
          node.forEachChild((child) => check(child, deferred || !runsNow(node)));
          return;
        }
        const entry = ts.isIdentifier(node) ? declared.get(node.text) : undefined;
        if (!deferred && entry && node.getStart() < entry.at) {
          const symbol = checker.getSymbolAtLocation(node);
          const same = symbol?.declarations?.some((item) => item.getStart() >= entry.declaration.getStart() && item.getEnd() <= entry.declaration.getEnd());
          const parent = node.parent;
          const propertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node);
          if (same && !propertyName) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart());
            findings.push(`${path.relative(path.resolve(__dirname, ".."), file)}:${line + 1} reads '${node.text}' before its declaration (line ${source.getLineAndCharacterOfPosition(entry.at).line + 1})`);
          }
        }
        node.forEachChild((child) => check(child, deferred));
      };
      for (const statement of body.statements) check(statement, false);
    };
    const walk = (node) => {
      if (ts.isFunctionLike(node) && node.body && ts.isBlock(node.body)) visitBody(node.body);
      node.forEachChild(walk);
    };
    walk(source);
  }
  return findings;
}

test("no renderer code reads a const during render before its declaration", () => {
  assert.deepEqual(renderTimeTdzReads(sourceFiles(path.resolve(__dirname, "../src"))), []);
});

test("the scan catches the read that crashed the window: a filter callback using a later const", () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "render-tdz-"));
  try {
    const file = path.join(dir, "Probe.tsx");
    fs.writeFileSync(file, [
      "export function Probe({ items, runs }: { items: { id: string }[]; runs: { id: string }[] }) {",
      "  const shown = items.filter((item) => !selected?.id.startsWith(item.id));",
      "  const later = () => selected;", // deferred: fine
      "  const selected = runs[0];",
      "  return shown.length + String(later());",
      "}",
    ].join("\n"));
    const findings = renderTimeTdzReads([file]);
    assert.equal(findings.length, 1);
    assert.match(findings[0], /reads 'selected' before its declaration/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
