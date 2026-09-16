import { CompletionDetector } from "./completion-detector";
import type {
  AnnealTaskDefinition,
  AnnealTaskSnapshot,
  TaskObservation,
  TaskState,
} from "./task-monitor-types";

export class TaskMonitor {
  private state: TaskState = "created";
  private readonly observations = new Map<string, TaskObservation>();
  private readonly detector = new CompletionDetector();

  constructor(private readonly definition: AnnealTaskDefinition) {
    if (!definition.taskId.trim()) throw new Error("taskId is required");
    if (!definition.title.trim()) throw new Error("task title is required");
  }

  start(): AnnealTaskSnapshot {
    if (["completed", "failed", "cancelled"].includes(this.state)) {
      throw new Error(`cannot start task in ${this.state} state`);
    }
    this.state = "running";
    return this.snapshot();
  }

  observe(observation: TaskObservation): AnnealTaskSnapshot {
    if (!this.observations.has(observation.id)) {
      this.observations.set(observation.id, { ...observation });
    }
    const evaluation = this.detector.evaluate(
      this.definition.completionRules,
      [...this.observations.values()],
    );
    if (evaluation.state === "completed" || evaluation.state === "failed") {
      this.state = evaluation.state;
    } else if (this.observations.size > 0) {
      this.state = "verifying";
    }
    return this.snapshot();
  }

  wait(): AnnealTaskSnapshot {
    this.state = "waiting";
    return this.snapshot();
  }

  block(): AnnealTaskSnapshot {
    this.state = "blocked";
    return this.snapshot();
  }

  cancel(): AnnealTaskSnapshot {
    this.state = "cancelled";
    return this.snapshot();
  }

  snapshot(): AnnealTaskSnapshot {
    const observations = [...this.observations.values()].map((item) => ({ ...item }));
    return {
      ...this.definition,
      completionRules: this.definition.completionRules.map((rule) => ({ ...rule })),
      state: this.state,
      observations,
      evaluation: this.detector.evaluate(this.definition.completionRules, observations),
    };
  }
}
