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
    throw new Error(`Expected one anchor in ${relative}, found ${count}: ${oldValue.slice(0, 180)}`);
  }
  write(relative, current.replace(oldValue, newValue));
}

replaceOnce(
  "desktop-electron/electron/preload.cjs",
  `const { invokeContract } = require("./ipc-schema.cjs");

const codingToolsApi = Object.freeze({`,
  `const { invokeContract } = require("./ipc-schema.cjs");

function subscribeManagedApps(listener) {
  if (typeof listener !== "function") {
    throw new Error("Managed app listener must be a function");
  }
  const channels = [
    "launcher:external-services-changed",
    "launcher:provider-network-changed",
  ];
  let disposed = false;
  let queued = false;
  let refreshPromise = null;
  const refresh = () => {
    if (disposed) return;
    if (refreshPromise) {
      queued = true;
      return;
    }
    refreshPromise = invokeContract(ipcRenderer, "apps.snapshot")
      .then((snapshot) => {
        if (!disposed) listener(snapshot);
      })
      .catch(() => undefined)
      .finally(() => {
        refreshPromise = null;
        if (!disposed && queued) {
          queued = false;
          refresh();
        }
      });
  };
  for (const channel of channels) ipcRenderer.on(channel, refresh);
  return () => {
    disposed = true;
    for (const channel of channels) ipcRenderer.removeListener(channel, refresh);
  };
}

const codingToolsApi = Object.freeze({`,
  "function subscribeManagedApps(listener)",
);

replaceOnce(
  "desktop-electron/electron/preload.cjs",
  `  apps: Object.freeze({
    snapshot: () => invokeContract(ipcRenderer, "apps.snapshot"),
    invoke: (input) => invokeContract(ipcRenderer, "apps.invoke", input),
  }),`,
  `  apps: Object.freeze({
    snapshot: () => invokeContract(ipcRenderer, "apps.snapshot"),
    invoke: (input) => invokeContract(ipcRenderer, "apps.invoke", input),
    onChanged: (listener) => subscribeManagedApps(listener),
  }),`,
  "onChanged: (listener) => subscribeManagedApps(listener)",
);

replaceOnce(
  "desktop-electron/src/api/contracts.ts",
  `export interface ManagedAppSummary {
`,
  `export interface ManagedAppManagedState extends JsonObject {
  readonly state: string;
  readonly version: string;
  readonly platformMode: string;
  readonly missingInputs: readonly string[];
}

export interface ManagedAppSummary {
`,
  "export interface ManagedAppManagedState extends JsonObject",
);

replaceOnce(
  "desktop-electron/src/api/contracts.ts",
  `  readonly error: string | null;
  readonly [key: string]: JsonValue | undefined;
}`,
  `  readonly error: string | null;
  readonly managed?: ManagedAppManagedState;
  readonly [key: string]: JsonValue | undefined;
}`,
  "readonly managed?: ManagedAppManagedState;",
);

replaceOnce(
  "desktop-electron/src/api/contracts.ts",
  `  readonly apps: {
    snapshot(): Promise<ManagedAppsSnapshot>;
    invoke(input: ManagedAppInvokeInput): Promise<JsonObject>;
  };`,
  `  readonly apps: {
    snapshot(): Promise<ManagedAppsSnapshot>;
    invoke(input: ManagedAppInvokeInput): Promise<JsonObject>;
    onChanged(listener: (snapshot: ManagedAppsSnapshot) => void): () => void;
  };`,
  "onChanged(listener: (snapshot: ManagedAppsSnapshot) => void): () => void;",
);

replaceOnce(
  "desktop-electron/src/features/ManagedAppsSurface.tsx",
  `import type { ExternalServiceId, ExternalServicesSnapshot, Language, ManagedAppTabId } from "../types";`,
  `import type { ManagedAppsSnapshot } from "../api/contracts";
import type { Language, ManagedAppTabId } from "../types";`,
  'import type { ManagedAppsSnapshot } from "../api/contracts";',
);

replaceOnce(
  "desktop-electron/src/features/ManagedAppsSurface.tsx",
  `interface ManagedAppTabDefinition {
  id: ManagedAppTabId;
  english: string;
  traditionalChinese: string;
  serviceId?: ExternalServiceId;
}

const EMPTY_SERVICES: ExternalServicesSnapshot = { version: 1, services: [] };`,
  `interface ManagedAppTabDefinition {
  id: ManagedAppTabId;
  english: string;
  traditionalChinese: string;
}

const EMPTY_APPS: ManagedAppsSnapshot = { version: 1, apps: [] };`,
  "const EMPTY_APPS: ManagedAppsSnapshot",
);

replaceOnce(
  "desktop-electron/src/features/ManagedAppsSurface.tsx",
  `  {
    id: "codex-router",
    english: "Codex Router",
    traditionalChinese: "Codex Router",
    serviceId: "codex-router",
  },
  {
    id: "commandcode-proxy",
    english: "CommandCode",
    traditionalChinese: "CommandCode",
    serviceId: "commandcode-proxy",
  },
  { id: "paseo", english: "Paseo", traditionalChinese: "Paseo", serviceId: "paseo" },
  { id: "anneal", english: "Anneal", traditionalChinese: "Anneal", serviceId: "anneal" },`,
  `  {
    id: "codex-router",
    english: "Codex Router",
    traditionalChinese: "Codex Router",
  },
  {
    id: "commandcode-proxy",
    english: "CommandCode",
    traditionalChinese: "CommandCode",
  },
  { id: "paseo", english: "Paseo", traditionalChinese: "Paseo" },
  { id: "anneal", english: "Anneal", traditionalChinese: "Anneal" },`,
  '{ id: "anneal", english: "Anneal", traditionalChinese: "Anneal" },',
);

replaceOnce(
  "desktop-electron/src/features/ManagedAppsSurface.tsx",
  `  const api = window.codexWebLauncher;
  const [services, setServices] = useState<ExternalServicesSnapshot>(EMPTY_SERVICES);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.externalServicesSnapshot()
      .then((snapshot) => {
        if (!cancelled) setServices(snapshot);
      })
      .catch((cause) => setError(messageOf(cause)));
    const unsubscribe = api.onExternalServicesChanged(setServices);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, setError]);

  const serviceById = useMemo(
    () => new Map(services.services.map((service) => [service.id, service] as const)),
    [services],
  );`,
  `  const api = window.codingTools?.apps;
  const [snapshot, setSnapshot] = useState<ManagedAppsSnapshot>(EMPTY_APPS);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    void api.snapshot()
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch((cause) => setError(messageOf(cause)));
    const unsubscribe = api.onChanged(setSnapshot);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, setError]);

  const appByHandle = useMemo(
    () => new Map(snapshot.apps.map((app) => [app.handle, app] as const)),
    [snapshot],
  );`,
  "const appByHandle = useMemo(",
);

replaceOnce(
  "desktop-electron/src/features/ManagedAppsSurface.tsx",
  `        {MANAGED_APP_TABS.map((tab) => {
          const service = tab.serviceId ? serviceById.get(tab.serviceId) : null;
          const status = tab.id === "cpa" ? "ready" : service?.status ?? "unknown";
          const actionRequired = service?.managedInstall.state === "repair-required"
            || service?.managedInstall.state === "error";`,
  `        {MANAGED_APP_TABS.map((tab) => {
          const app = appByHandle.get(tab.id);
          const status = app?.status ?? "unknown";
          const managedState = app?.managed?.state;
          const actionRequired = status === "error"
            || managedState === "repair-required"
            || managedState === "error"
            || managedState === "unavailable";`,
  "const app = appByHandle.get(tab.id);",
);

process.stdout.write("managed app API UI materialization complete\n");
