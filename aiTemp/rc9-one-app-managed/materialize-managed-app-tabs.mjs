import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(process.cwd());

function read(relative) {
  return fs.readFileSync(path.join(root, relative), "utf8");
}

function write(relative, value) {
  fs.writeFileSync(path.join(root, relative), value, "utf8");
  process.stdout.write(`patched ${relative}\n`);
}

function replaceOnce(relative, oldValue, newValue, sentinel = newValue) {
  const current = read(relative);
  if (current.includes(sentinel)) {
    process.stdout.write(`already patched ${relative}\n`);
    return;
  }
  const count = current.split(oldValue).length - 1;
  if (count !== 1) {
    throw new Error(`Expected one anchor in ${relative}, found ${count}: ${oldValue.slice(0, 120)}`);
  }
  write(relative, current.replace(oldValue, newValue));
}

function replaceAllExact(relative, oldValue, newValue, expected) {
  const current = read(relative);
  if (current.includes(newValue) && !current.includes(oldValue)) {
    process.stdout.write(`already patched ${relative}\n`);
    return;
  }
  const count = current.split(oldValue).length - 1;
  if (count !== expected) {
    throw new Error(`Expected ${expected} anchors in ${relative}, found ${count}: ${oldValue.slice(0, 120)}`);
  }
  write(relative, current.split(oldValue).join(newValue));
}

replaceOnce(
  "desktop-electron/src/types.ts",
  'export type Surface = "browser" | "setup" | "mcp" | "providers" | "integrations" | "paseo" | "anneal" | "network" | "activity" | "settings";',
  'export type Surface = "browser" | "setup" | "mcp" | "apps" | "providers" | "integrations" | "paseo" | "anneal" | "network" | "activity" | "settings";',
  '| "apps" |',
);

replaceOnce(
  "desktop-electron/src/App.tsx",
  'import { ExternalServicesSurface } from "./features/ExternalServicesSurface";\nimport { McpLiveToolsPanel } from "./features/McpLiveToolsPanel";',
  'import { ExternalServicesSurface } from "./features/ExternalServicesSurface";\nimport { ManagedAppsSurface, type ManagedAppTabId } from "./features/ManagedAppsSurface";\nimport { McpLiveToolsPanel } from "./features/McpLiveToolsPanel";',
  'ManagedAppsSurface, type ManagedAppTabId',
);

replaceOnce(
  "desktop-electron/src/App.tsx",
  '  const [surface, setSurface] = useState<Surface>(\n    firstRunZeroRiskSetup ? "mcp" : interactionSetupComplete ? "browser" : "setup",\n  );\n  const devProfile = snapshot.profile === "development";',
  '  const [surface, setSurface] = useState<Surface>(\n    firstRunZeroRiskSetup ? "mcp" : interactionSetupComplete ? "browser" : "setup",\n  );\n  const [managedAppTab, setManagedAppTab] = useState<ManagedAppTabId>("cpa");\n  const devProfile = snapshot.profile === "development";',
  'useState<ManagedAppTabId>("cpa")',
);

replaceOnce(
  "desktop-electron/src/App.tsx",
  '  const extraSurfaceActive = surface === "providers"\n    || surface === "integrations"\n    || surface === "paseo"\n    || surface === "anneal"\n    || surface === "network";',
  '  const extraSurfaceActive = surface === "apps"\n    || surface === "providers"\n    || surface === "integrations"\n    || surface === "paseo"\n    || surface === "anneal"\n    || surface === "network";',
  'const extraSurfaceActive = surface === "apps"',
);

replaceOnce(
  "desktop-electron/src/App.tsx",
  `                <SidebarItem
                  active={surface === "providers"}
                  icon="providers"
                  label={copy.providers}
                  onClick={() => navigateSurface("providers")}
                />
                <SidebarItem
                  active={surface === "integrations"}
                  icon="globe"
                  label={copy.integrations}
                  onClick={() => navigateSurface("integrations")}
                />
                <SidebarItem
                  active={surface === "paseo"}
                  icon="orchestrator"
                  label={language === "zh-TW" ? "Paseo 協調器" : copy.paseoOrchestrator}
                  onClick={() => navigateSurface("paseo")}
                />
                <SidebarItem
                  active={surface === "anneal"}
                  icon="activity"
                  label={language === "zh-TW" ? "Anneal 任務" : copy.annealTasks}
                  onClick={() => navigateSurface("anneal")}
                />`,
  `                <SidebarItem
                  active={surface === "apps"}
                  icon="providers"
                  label={language === "zh-TW" ? "應用程式" : "Managed Apps"}
                  onClick={() => navigateSurface("apps")}
                />`,
  'label={language === "zh-TW" ? "應用程式" : "Managed Apps"}',
);

replaceOnce(
  "desktop-electron/src/App.tsx",
  `            {surface === "providers" ? (
              <ProviderCenterSurface language={language} setError={setError} />
            ) : null}`,
  `            {surface === "apps" ? (
              <ManagedAppsSurface
                language={language}
                onSelectedTabChange={setManagedAppTab}
                selectedTab={managedAppTab}
                setError={setError}
              />
            ) : null}
            {surface === "providers" ? (
              <ProviderCenterSurface language={language} setError={setError} />
            ) : null}`,
  'selectedTab={managedAppTab}',
);

replaceOnce(
  "desktop-electron/src/App.tsx",
  `                openAnneal={() => navigateSurface("anneal")}
                openPaseo={() => navigateSurface("paseo")}
                openProviders={() => navigateSurface("providers")}`,
  `                openAnneal={() => {
                  setManagedAppTab("anneal");
                  navigateSurface("apps");
                }}
                openPaseo={() => {
                  setManagedAppTab("paseo");
                  navigateSurface("apps");
                }}
                openProviders={() => {
                  setManagedAppTab("cpa");
                  navigateSurface("apps");
                }}`,
  'setManagedAppTab("anneal")',
);

replaceOnce(
  "desktop-electron/src/features/ExternalServicesSurface.tsx",
  `interface ExternalServicesSurfaceProps {
  language: Language;
  setError: (error: string | null) => void;
  openProviders: () => void;
  openPaseo: () => void;
  openAnneal: () => void;
}`,
  `interface ExternalServicesSurfaceProps {
  language: Language;
  setError: (error: string | null) => void;
  openProviders: () => void;
  openPaseo: () => void;
  openAnneal: () => void;
  preferredServiceId?: ExternalServiceId;
}`,
  'preferredServiceId?: ExternalServiceId',
);

replaceOnce(
  "desktop-electron/src/features/ExternalServicesSurface.tsx",
  `export function ExternalServicesSurface({
  language,
  setError,
  openProviders,
  openPaseo,
  openAnneal,
}: ExternalServicesSurfaceProps) {`,
  `export function ExternalServicesSurface({
  language,
  setError,
  openProviders,
  openPaseo,
  openAnneal,
  preferredServiceId,
}: ExternalServicesSurfaceProps) {`,
  '  preferredServiceId,\n}: ExternalServicesSurfaceProps)',
);

replaceOnce(
  "desktop-electron/src/features/ExternalServicesSurface.tsx",
  '  const [selectedId, setSelectedId] = useState<ExternalServiceId>("codex-router");',
  '  const [selectedId, setSelectedId] = useState<ExternalServiceId>(preferredServiceId ?? "codex-router");',
  'useState<ExternalServiceId>(preferredServiceId ?? "codex-router")',
);

replaceOnce(
  "desktop-electron/src/features/ExternalServicesSurface.tsx",
  `  )), [services, commandCodeAccounts, commandCodeModels]);

  const refresh = async () => {`,
  `  )), [services, commandCodeAccounts, commandCodeModels]);

  useEffect(() => {
    if (preferredServiceId) setSelectedId(preferredServiceId);
  }, [preferredServiceId]);

  const refresh = async () => {`,
  'if (preferredServiceId) setSelectedId(preferredServiceId);',
);

replaceAllExact(
  "desktop-electron/src/features/ExternalServicesSurface.tsx",
  'serviceSnapshot.services.find((service) => service.id === selectedId)',
  'serviceSnapshot.services.find((service) => service.id === (preferredServiceId ?? selectedId))',
  1,
);

replaceAllExact(
  "desktop-electron/src/features/ExternalServicesSurface.tsx",
  'nextServices.services.find((service) => service.id === selectedId)',
  'nextServices.services.find((service) => service.id === (preferredServiceId ?? selectedId))',
  1,
);

replaceOnce(
  "desktop-electron/src/features/ExternalServicesSurface.tsx",
  '  }, [api, selectedId, setError]);',
  '  }, [api, preferredServiceId, selectedId, setError]);',
  '[api, preferredServiceId, selectedId, setError]',
);

process.stdout.write("managed app tab materialization complete\n");
