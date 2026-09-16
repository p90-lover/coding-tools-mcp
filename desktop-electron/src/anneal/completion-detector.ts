export type CompletionSource =
  | 'chat'
  | 'github'
  | 'browser'
  | 'build';

export interface CompletionObservation {
  source: CompletionSource;
  message: string;
  completed: boolean;
  timestamp: number;
}

export class CompletionDetector {
  detect(observations: CompletionObservation[]): boolean {
    return observations.some((item) => item.completed);
  }
}
