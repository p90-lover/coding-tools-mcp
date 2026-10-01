"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const filename = path.join(__dirname, "..", "src", "features", "PaseoOrchestratorSurface.tsx");
const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: filename,
});
const moduleUnderTest = { exports: {} };
Function("require", "module", "exports", compiled.outputText)(
  (specifier) => specifier === "./execution-surface-utils"
    ? { object: (value) => value && typeof value === "object" && !Array.isArray(value) ? value : undefined }
    : {},
  moduleUnderTest,
  moduleUnderTest.exports,
);

test("reopen reconstructs durable planner, worker, reviewer status and owned output", () => {
  const { paseoDurableRuns } = moduleUnderTest.exports;
  const mission = (id, phase, output, outputAgent = `${id}-agent`) => {
    const worker = id.includes("worker");
    return {
      binding_generation: `${id}-generation`,
      start_message_id: `${id}-start`,
      mission: {
        phase,
        record_id: `${id}-agent`,
        spec: {
          mission_id: id,
          task_id: `${id}-task`,
          title: id,
          provider: worker ? "cliproxyapi-antigravity" : "chatgpt-web",
          account_id: worker ? "cpa-main" : "chatgpt-main",
      model: worker ? "gemini-3.8-flash-high" : "chatgpt-web/high",
        },
      },
      output: output ? {
        agent_id: outputAgent,
        text: output,
        turn_id: `${id}-turn`,
        epoch: "epoch-1",
        seq_start: 1,
        seq_end: 2,
      } : null,
    };
  };
  const view = {
    execution: {
      orchestrations: [{
        id: "run-42",
        task_id: "parent-task",
        status: "planning",
        planner_mission_id: "run-42-planner",
        planner_binding_generation: "run-42-planner-generation",
        planner_request_key: "run-42-planner-start",
        worker_mission_ids: ["run-42-worker-1", "run-42-worker-2"],
        worker_task_ids: ["worker-task-1", "worker-task-2"],
        worker_binding_generations: ["run-42-worker-1-generation", "run-42-worker-2-generation"],
        worker_request_keys: ["run-42-worker-1-start", "run-42-worker-2-start"],
        reviewer_mission_id: "run-42-reviewer",
        reviewer_task_id: "reviewer-task",
        reviewer_binding_generation: "run-42-reviewer-generation",
        reviewer_request_key: "run-42-reviewer-start",
      }],
      missions: [
        mission("run-42-planner", "accepted", "Use worker 1, then worker 2."),
        mission("run-42-worker-1", "review_required", "Implemented the focused change."),
        mission("run-42-worker-2", "running", "must stay hidden", "another-agent"),
        mission("run-42-reviewer", "draft"),
      ],
    },
  };

  assert.deepEqual(paseoDurableRuns(view), [{
    id: "run-42",
    taskId: "parent-task",
    status: "executing",
    planner: {
      id: "run-42-planner",
      recordId: "run-42-planner-agent",
      taskId: "run-42-planner-task",
      title: "run-42-planner",
      phase: "accepted",
      providerId: "chatgpt-web",
      accountId: "chatgpt-main",
      model: "chatgpt-web/high",
      output: "Use worker 1, then worker 2.",
      permission: "",
      pendingWrite: false,
    },
    workers: [{
      id: "run-42-worker-1",
      recordId: "run-42-worker-1-agent",
      taskId: "worker-task-1",
      title: "run-42-worker-1",
      phase: "review_required",
      providerId: "cliproxyapi-antigravity",
      accountId: "cpa-main",
      model: "gemini-3.8-flash-high",
      output: "Implemented the focused change.",
      permission: "",
      pendingWrite: false,
    }, {
      id: "run-42-worker-2",
      recordId: "run-42-worker-2-agent",
      taskId: "worker-task-2",
      title: "run-42-worker-2",
      phase: "running",
      providerId: "cliproxyapi-antigravity",
      accountId: "cpa-main",
      model: "gemini-3.8-flash-high",
      output: "",
      permission: "",
      pendingWrite: false,
    }],
    reviewer: {
      id: "run-42-reviewer",
      recordId: "run-42-reviewer-agent",
      taskId: "reviewer-task",
      title: "run-42-reviewer",
      phase: "draft",
      providerId: "chatgpt-web",
      accountId: "chatgpt-main",
      model: "chatgpt-web/high",
      output: "",
      permission: "",
      pendingWrite: false,
    },
  }]);

  view.execution.missions[2] = mission(
    "run-42-worker-2",
    "review_required",
    "Implemented the second focused change.",
  );
  view.execution.missions[3] = mission(
    "run-42-reviewer",
    "review_required",
    '{"verdict":"pass","findings":[],"route":"wrong"}',
  );
  assert.equal(paseoDurableRuns(view)[0].status, "review_ready");
  view.execution.missions[3].mission.phase = "closed";
  assert.equal(paseoDurableRuns(view)[0].status, "review_ready");
  view.execution.missions[2].mission.pending = "write-1";
  view.execution.missions[2].mission.receipts = { "write-1": { state: "reserved" } };
  assert.equal(paseoDurableRuns(view)[0].workers[1].pendingWrite, true);
});

test("source refresh waits for a confirmed running mission", () => {
  const { shouldRefreshPaseoStep } = moduleUnderTest.exports;
  const step = (phase, recordId = "agent-1", pendingWrite = false) => ({ phase, recordId, pendingWrite });

  assert.deepEqual(
    ["creating", "ready", "running"].map((phase) => shouldRefreshPaseoStep(step(phase))),
    [false, false, true],
  );
  assert.equal(shouldRefreshPaseoStep(step("running", "")), false);
  assert.equal(shouldRefreshPaseoStep(step("running", "agent-1", true)), false);
});

test("failed or closed stages stop a run before a five-minute follow", () => {
  const { paseoDurableRuns, paseoTerminalStep } = moduleUnderTest.exports;
  const stage = (id, phase) => ({
    binding_generation: `${id}-generation`,
    start_message_id: `${id}-start`,
    mission: { phase, spec: { mission_id: id } },
  });
  const view = {
    execution: {
      orchestrations: [{
        id: "run-failed",
        planner_mission_id: "planner",
        planner_binding_generation: "planner-generation",
        planner_request_key: "planner-start",
        worker_mission_ids: ["worker"],
        worker_binding_generations: ["worker-generation"],
        worker_request_keys: ["worker-start"],
        reviewer_mission_id: "reviewer",
        reviewer_binding_generation: "reviewer-generation",
        reviewer_request_key: "reviewer-start",
      }],
      missions: [stage("planner", "failed"), stage("worker", "draft"), stage("reviewer", "draft")],
    },
  };
  for (const [index, phase, expected] of [
    [0, "failed", "planner"],
    [1, "closed", "worker"],
    [2, "cancelled", "reviewer"],
  ]) {
    view.execution.missions = [stage("planner", "ready"), stage("worker", "ready"), stage("reviewer", "ready")];
    view.execution.missions[index] = stage(expected, phase);
    const run = paseoDurableRuns(view)[0];
    assert.equal(run.status, "failed");
    assert.equal(paseoTerminalStep(run)?.id, expected);
  }
});

test("review handoff belongs only to the selected run after switching sessions", () => {
  const { paseoVerifiedReviewStatus } = moduleUnderTest.exports;
  const review = {
    id: "run-1-review",
    runId: "run-1",
    status: "needs_changes",
    liveModelCompletion: true,
    findings: [{ title: "Fix this" }],
  };
  assert.equal(paseoVerifiedReviewStatus("run-1", review), "needs_changes");
  assert.equal(paseoVerifiedReviewStatus("run-2", review), "");
  assert.equal(paseoVerifiedReviewStatus("run-1", { ...review, liveModelCompletion: false }), "");
});

test("reload keeps a backend-verified terminal review and only shows owned findings", () => {
  const { paseoDurableRuns, paseoDurableFindings } = moduleUnderTest.exports;
  const mission = (id, output) => ({
    binding_generation: `${id}-generation`,
    start_message_id: `${id}-start`,
    mission: { phase: "review_required", record_id: `${id}-agent`, spec: { mission_id: id } },
    output: {
      agent_id: `${id}-agent`, text: output, turn_id: `${id}-turn`,
      epoch: "epoch-1", seq_start: 1, seq_end: 2,
    },
  });
  const view = { execution: {
    orchestrations: [{
      id: "run-reviewed", status: "reviewing",
      planner_mission_id: "planner", planner_binding_generation: "planner-generation", planner_request_key: "planner-start",
      worker_mission_ids: ["worker"], worker_binding_generations: ["worker-generation"], worker_request_keys: ["worker-start"],
      reviewer_mission_id: "reviewer", reviewer_binding_generation: "reviewer-generation", reviewer_request_key: "reviewer-start",
    }],
    missions: [
      mission("planner", "Plan"),
      mission("worker", "Result"),
      mission("reviewer", '{"verdict":"needs_changes","findings":[{"title":"Fix login","detail":"Check session refresh"}]}'),
    ],
  } };
  let run = paseoDurableRuns(view)[0];
  assert.equal(run.status, "review_ready");
  assert.deepEqual(paseoDurableFindings(run), []);

  view.execution.orchestrations[0].status = "needs_changes";
  run = paseoDurableRuns(view)[0];
  assert.equal(run.status, "needs_changes");
  assert.deepEqual(paseoDurableFindings(run), [{ title: "Fix login", detail: "Check session refresh" }]);

  view.execution.missions[2].output.agent_id = "unrelated-agent";
  run = paseoDurableRuns(view)[0];
  assert.equal(run.status, "needs_changes");
  assert.deepEqual(paseoDurableFindings(run), []);
  view.execution.missions[2].output.agent_id = "reviewer-agent";
  view.execution.missions[2].output.text = '{"verdict":"pass","findings":[]}';
  assert.deepEqual(paseoDurableFindings(paseoDurableRuns(view)[0]), []);
});
