"use strict";

// Adapted from AO's derived Kanban presentation at commit
// 213dae6e09abf3464e5e3e01eb8f7a85aeba1a2e (Apache-2.0).
// The old Coding Tools plan remains the durable record; lanes are computed on read.
function presentTask(task) {
  const clauses = Array.isArray(task.clauses) ? task.clauses : [];
  const done = clauses.filter((clause) => clause.state === "done").length;
  const blocked = task.state === "blocked" || clauses.some((clause) => clause.state === "blocked");
  const active = clauses.find((clause) => clause.state === "in_progress");
  const needsReview = blocked || (task.state === "done"
    ? done < clauses.length
    : clauses.length > 0 && done === clauses.length);
  const lane = task.state === "archived" ? "archive"
    : needsReview ? "needs_review"
      : task.state === "done" ? "ready"
        : task.step >= 5 || done > 0 ? "validating" : "building";
  const displayStatus = lane === "archive" ? "Archived"
    : lane === "ready" ? "Done"
      : lane === "needs_review" ? "Needs you"
        : active ? `Working: ${active.title}`
          : lane === "validating" ? "Validating" : "Planning";
  return {
    ...task,
    lane,
    displayStatus,
    clauseProgress: { done, total: clauses.length },
  };
}

module.exports = { presentTask };
