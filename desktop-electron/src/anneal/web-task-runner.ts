export type WebTaskAction =
  | 'open_url'
  | 'extract'
  | 'click'
  | 'verify';

export interface WebTaskStep {
  action: WebTaskAction;
  value?: string;
}

export interface WebTaskDefinition {
  id: string;
  name: string;
  enabled: boolean;
  steps: WebTaskStep[];
}

export class WebTaskRunner {
  run(task: WebTaskDefinition) {
    return {
      taskId: task.id,
      status: 'queued',
      steps: task.steps,
    };
  }
}
