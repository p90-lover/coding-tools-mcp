import { useState, type ReactNode } from "react";
import type { Language, OriginalUiId } from "../types";
import { copyFor } from "../i18n";
import { OriginalUiSurface } from "./OriginalUiSurface";
import "./integrated-module.css";

interface IntegratedModuleSurfaceProps {
  toolId: OriginalUiId;
  title: string;
  language: Language;
  initialSection?: string;
  controls: ReactNode;
  setError: (error: string | null) => void;
}

export function IntegratedModuleSurface({
  toolId,
  title,
  language,
  initialSection,
  controls,
  setError,
}: IntegratedModuleSurfaceProps) {
  const [activeView, setActiveView] = useState<"original" | "controls">("original");
  const [controlsOpened, setControlsOpened] = useState(false);
  const copy = copyFor(language);
  return (
    <section className="integrated-module">
      <header className="integrated-module-toolbar">
        <h1>{title}</h1>
        <nav aria-label={title}>
          <button
            aria-pressed={activeView === "original"}
            onClick={() => setActiveView("original")}
            type="button"
          >
            {copy.originalApp}
          </button>
          <button
            aria-pressed={activeView === "controls"}
            onClick={() => {
              setControlsOpened(true);
              setActiveView("controls");
            }}
            type="button"
          >
            {copy.managedControls}
          </button>
        </nav>
      </header>
      <div className="integrated-module-content">
        <div className="integrated-module-panel" hidden={activeView !== "original"}>
          <OriginalUiSurface
            initialSection={initialSection}
            language={language}
            setError={setError}
            toolId={toolId}
          />
        </div>
        {controlsOpened ? (
          <div className="integrated-module-panel is-controls" hidden={activeView !== "controls"}>{controls}</div>
        ) : null}
      </div>
    </section>
  );
}
