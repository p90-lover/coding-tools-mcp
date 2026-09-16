import type { Language } from "../types";
import "./orchestration-control.css";

export function PaseoOrchestratorSurface({
  language,
  setError,
}: {
  language: Language;
  setError: (error: string | null) => void;
}) {
  void language;
  void setError;
  return <section className="control-surface"><h1>Paseo Orchestrator</h1></section>;
}
