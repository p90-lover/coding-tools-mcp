import type {
  CompletionEvaluation,
  CompletionRule,
  TaskObservation,
} from "./task-monitor-types";

export class CompletionDetector {
  evaluate(
    rules: readonly CompletionRule[],
    observations: readonly TaskObservation[],
  ): CompletionEvaluation {
    const failures = observations.filter(
      (observation) => observation.terminal === true && !observation.success,
    );
    if (failures.length > 0) {
      return {
        state: "failed",
        satisfiedRuleIds: [],
        missingRuleIds: rules.map((rule) => rule.id),
        failureObservationIds: failures.map((observation) => observation.id),
      };
    }

    const satisfiedRuleIds = rules
      .filter((rule) => observations.some((observation) =>
        observation.success
          && observation.source === rule.source
          && observation.key === rule.key))
      .map((rule) => rule.id);
    const satisfied = new Set(satisfiedRuleIds);
    const missingRuleIds = rules
      .filter((rule) => !satisfied.has(rule.id))
      .map((rule) => rule.id);

    return {
      state: rules.length > 0 && missingRuleIds.length === 0
        ? "completed"
        : "verifying",
      satisfiedRuleIds,
      missingRuleIds,
      failureObservationIds: [],
    };
  }
}
