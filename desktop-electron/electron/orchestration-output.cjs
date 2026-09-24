"use strict";

const MAX_OUTPUT_LENGTH = 64 * 1024;
const MAX_ROLES = 16;
const MAX_ROLE_LENGTH = 80;
const MAX_BRIEF_LENGTH = 4_000;
const MAX_FINDINGS = 32;
const MAX_TITLE_LENGTH = 200;
const MAX_DETAIL_LENGTH = 4_000;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isObject(value)) throw new Error(`${label} must be a JSON object`);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} contains unsupported keys`);
  }
}

function boundedString(value, max, label) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max) throw new Error(`${label} is required and must be at most ${max} characters`);
  return text;
}

function parseJsonOutput(text, label) {
  if (typeof text !== "string" || !text.trim()) throw new Error(`${label} output is required`);
  if (text.length > MAX_OUTPUT_LENGTH) throw new Error(`${label} output is too long`);
  const trimmed = text.trim();
  const fence = /^```json[ \t]*\r?\n([\s\S]*?)\r?\n```$/u.exec(trimmed);
  const source = fence ? fence[1].trim() : trimmed;
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error(`${label} output must be JSON or one complete JSON code fence`);
  }
  if (!isObject(parsed)) throw new Error(`${label} output must be a JSON object`);
  return parsed;
}

function parsePlannerTasks(text, selectedRoles) {
  if (!Array.isArray(selectedRoles) || selectedRoles.length === 0 || selectedRoles.length > MAX_ROLES) {
    throw new Error(`Planner selected roles must contain 1-${MAX_ROLES} roles`);
  }
  const roles = selectedRoles.map((role) => boundedString(role, MAX_ROLE_LENGTH, "Planner selected role"));
  const roleSet = new Set(roles);
  if (roleSet.size !== roles.length) throw new Error("Planner selected roles must be unique");

  const parsed = parseJsonOutput(text, "Planner");
  exactKeys(parsed, ["tasks"], "Planner output");
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length !== roles.length) {
    throw new Error("Planner output must contain exactly one task per selected role");
  }

  const seen = new Set();
  const tasks = parsed.tasks.map((task) => {
    exactKeys(task, ["role", "brief"], "Planner task");
    const role = typeof task.role === "string" ? task.role.trim() : "";
    if (!roleSet.has(role)) throw new Error("Planner task role must be a selected role");
    if (seen.has(role)) throw new Error("Planner output must contain exactly one task per selected role");
    seen.add(role);
    return { role, brief: boundedString(task.brief, MAX_BRIEF_LENGTH, "Planner task brief") };
  });
  if (seen.size !== roleSet.size) throw new Error("Planner output must contain exactly one task per selected role");
  return { tasks };
}

function parseReviewerVerdict(text) {
  const parsed = parseJsonOutput(text, "Reviewer");
  exactKeys(parsed, ["verdict", "findings"], "Reviewer output");
  if (parsed.verdict !== "pass" && parsed.verdict !== "needs_changes") {
    throw new Error("Reviewer verdict must be pass or needs_changes");
  }
  if (!Array.isArray(parsed.findings) || parsed.findings.length > MAX_FINDINGS) {
    throw new Error(`Reviewer findings must contain at most ${MAX_FINDINGS} items`);
  }
  if (parsed.verdict === "needs_changes" && parsed.findings.length === 0) {
    throw new Error("Reviewer needs_changes verdict requires at least one finding");
  }
  if (parsed.verdict === "pass" && parsed.findings.length !== 0) {
    throw new Error("Reviewer pass verdict cannot include findings");
  }
  const findings = parsed.findings.map((finding) => {
    exactKeys(finding, ["title", "detail"], "Reviewer finding");
    return {
      title: boundedString(finding.title, MAX_TITLE_LENGTH, "Reviewer finding title"),
      detail: boundedString(finding.detail, MAX_DETAIL_LENGTH, "Reviewer finding detail"),
    };
  });
  return { verdict: parsed.verdict, findings };
}

module.exports = { parsePlannerTasks, parseReviewerVerdict };
