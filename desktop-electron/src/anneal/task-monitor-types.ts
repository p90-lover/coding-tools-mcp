export type TaskState =
  | "created"
  | "running"
  | "waiting"
  | "verifying"
  | "completed"
  | "failed";

export interface TaskObservation {
  source: "chat" | "github" | "browser" | "build";
  timestamp: number;
  message: string;
}

export interface AnnealTaskMonitor {
  taskId: string;
  state: TaskState;
  observations: TaskObservation[];
  addObservation(observation: TaskObservation): void;
  isComplete(): boolean;
}
