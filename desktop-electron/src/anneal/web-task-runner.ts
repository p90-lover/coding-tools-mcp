export type WebTaskPermission = "approved" | "approval-required" | "denied";

export type WebTaskStepType = "navigate" | "extract" | "click" | "assert";

export interface WebTaskStep {
  id: string;
  type: WebTaskStepType;
  url?: string;
  selector?: string;
  expression?: string;
  value?: string;
}

export interface WebTaskDefinition {
  id: string;
  name: string;
  enabled: boolean;
  allowedOrigins: string[];
  permission: WebTaskPermission;
  maxSteps: number;
  timeoutMs: number;
  steps: WebTaskStep[];
}

export interface WebTaskStepResult {
  stepId: string;
  ok: boolean;
  evidence?: unknown;
  error?: string;
}

export interface WebTaskRunResult {
  taskId: string;
  status: "completed" | "failed";
  results: WebTaskStepResult[];
}

export interface WebTaskExecutor {
  execute(step: WebTaskStep, signal: AbortSignal): Promise<WebTaskStepResult>;
}

function normalizedOrigin(value: string): string {
  return new URL(value).origin;
}

export class WebTaskRunner {
  constructor(private readonly executor: WebTaskExecutor) {}

  async run(task: WebTaskDefinition): Promise<WebTaskRunResult> {
    this.validateTask(task);
    const allowedOrigins = new Set(task.allowedOrigins.map(normalizedOrigin));
    for (const step of task.steps) this.validateStep(step, allowedOrigins);

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<WebTaskRunResult>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error(`web task ${task.id} timed out`));
      }, task.timeoutMs);
    });

    const executionPromise = this.executeSteps(task, controller.signal);
    try {
      return await Promise.race([executionPromise, timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async executeSteps(
    task: WebTaskDefinition,
    signal: AbortSignal,
  ): Promise<WebTaskRunResult> {
    const results: WebTaskStepResult[] = [];
    for (const step of task.steps) {
      if (signal.aborted) throw new Error(`web task ${task.id} was aborted`);
      const result = await this.executor.execute(step, signal);
      results.push(result);
      if (!result.ok) {
        return { taskId: task.id, status: "failed", results };
      }
    }
    return { taskId: task.id, status: "completed", results };
  }

  private validateTask(task: WebTaskDefinition): void {
    if (!task.id.trim() || !task.name.trim()) throw new Error("web task identity is required");
    if (!task.enabled) throw new Error(`web task ${task.id} is disabled`);
    if (task.permission !== "approved") {
      throw new Error(`web task ${task.id} is not approved`);
    }
    if (!Number.isInteger(task.maxSteps) || task.maxSteps <= 0 || task.maxSteps > 100) {
      throw new Error("web task maxSteps must be between 1 and 100");
    }
    if (task.steps.length > task.maxSteps) {
      throw new Error(`web task ${task.id} exceeds its step limit`);
    }
    if (!Number.isInteger(task.timeoutMs) || task.timeoutMs <= 0 || task.timeoutMs > 300_000) {
      throw new Error("web task timeoutMs must be between 1 and 300000");
    }
    if (task.allowedOrigins.length === 0) {
      throw new Error(`web task ${task.id} requires an origin allowlist`);
    }
  }

  private validateStep(step: WebTaskStep, allowedOrigins: Set<string>): void {
    if (!step.id.trim()) throw new Error("web task step id is required");
    if (step.type === "navigate" && !step.url) {
      throw new Error(`navigate step ${step.id} requires a URL`);
    }
    if (step.url) {
      let origin: string;
      try {
        origin = normalizedOrigin(step.url);
      } catch {
        throw new Error(`web task step ${step.id} has an invalid URL`);
      }
      if (!allowedOrigins.has(origin)) {
        throw new Error(`origin is not allowed: ${origin}`);
      }
    }
  }
}
