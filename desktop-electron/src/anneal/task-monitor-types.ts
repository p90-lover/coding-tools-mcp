export type CompletionSource =
  | "chat"
  | "github"
  | "build"
  | "browser"
  | "web-task";

export type TaskState =
  | "created"
  | "running"
  | "waiting"
  | "verifying"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

export interface CompletionRule {
  id: string;
  source: CompletionSource;
  key: string;
}

export interface TaskObservation {
  id: string;
  source: CompletionSource;
  key: string;
  success: boolean;
  terminal?: boolean;
  message: string;
  timestamp: number;
  evidence?: unknown;
}

export interface AnnealTaskDefinition {
  taskId: string;
  title: string;
  completionRules: CompletionRule[];
}

export interface CompletionEvaluation {
  state: "verifying" | "completed" | "failed";
  satisfiedRuleIds: string[];
  missingRuleIds: string[];
  failureObservationIds: string[];
}

export interface AnnealTaskSnapshot extends AnnealTaskDefinition {
  state: TaskState;
  observations: TaskObservation[];
  evaluation: CompletionEvaluation;
}
