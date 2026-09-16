import type { TaskObservation, TaskState } from './task-monitor-types';

export class TaskMonitor {
  private state: TaskState = 'created';
  private observations: TaskObservation[] = [];

  observe(event: TaskObservation) {
    this.observations.push(event);
    return event;
  }

  setState(state: TaskState) {
    this.state = state;
  }

  getStatus() {
    return {
      state: this.state,
      observations: this.observations,
    };
  }
}
