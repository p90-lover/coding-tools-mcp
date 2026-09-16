from pathlib import Path

TARGET = Path("desktop-electron/src/features/ProviderOrchestratorSurfaces.tsx")


def replace_once(source: str, old: str, new: str, label: str) -> str:
    count = source.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one exact match, found {count}")
    return source.replace(old, new, 1)


source = TARGET.read_text(encoding="utf-8")

old_connect = '''  const connectProvider = async () => {
    const api = window.codingTools;
    if (!api) throw new Error("Coding Tools execution bridge is unavailable");
    if (!selected || !selectedDefinition) return;
    if (!workspaceId) throw new Error("Select a workspace before connecting a provider");
    if (!selected.selectedModel.trim()) throw new Error("Select or enter a model");
    if (selected.engine === "anneal"
      && (!selected.projectId.trim() || !selected.repoId.trim() || !selected.assigneeId.trim())) {
      throw new Error("Anneal requires project, repository and assigned agent IDs");
    }
    setBusy(`connect:${selected.id}`);
    setError(null);
    try {
      const current = await api.execution.read({
        workspaceId,
        missionId: null,
        refreshSource: false,
      });
      await api.execution.provider({
        workspaceId,
        operation: "configure",
        expectedRevision: executionRevision(current),
        bindingId: null,
        settings: {
          id: selected.id,
          engine: selected.engine,
          endpoint: selected.engineEndpoint,
          provider: selected.definitionId,
          model: selected.selectedModel,
          mode: selected.mode || "default",
          projectId: selected.engine === "anneal" ? selected.projectId : null,
          repoId: selected.engine === "anneal" ? selected.repoId : null,
          assigneeId: selected.engine === "anneal" ? selected.assigneeId : null,
          maxDurationMin: 120,
          allowCodex: selected.definitionId === "codex-oauth",
          confirmExternalExecution: true,
        },
        credential,
        confirm: true,
      });
      setCredential("");
      await refreshBindings();
      setNotice(text(language, `${selected.name} is connected to ${selected.engine}.`, `${selected.name} 已連線至 ${selected.engine}。`));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };
'''

new_connect = '''  const connectProvider = async () => {
    const launcher = window.codexWebLauncher;
    if (!launcher) throw new Error("Provider Hub execution bridge is unavailable");
    if (!selected || !selectedDefinition) return;
    if (!workspaceId) throw new Error("Select a workspace before connecting a provider");
    if (!selected.selectedModel.trim()) throw new Error("Select or enter a model");
    if (selected.engine === "anneal"
      && (!selected.projectId.trim() || !selected.repoId.trim() || !selected.assigneeId.trim())) {
      throw new Error("Anneal requires project, repository and assigned agent IDs");
    }
    setBusy(`connect:${selected.id}`);
    setError(null);
    try {
      const result = await launcher.configureProviderExecution({
        workspaceId,
        workload: selected.engine,
        engine: selected.engine,
        providerId: selected.definitionId,
        model: selected.selectedModel,
        allowFallback: false,
        endpoint: selected.engineEndpoint,
        mode: selected.mode || "default",
        projectId: selected.engine === "anneal" ? selected.projectId : undefined,
        repoId: selected.engine === "anneal" ? selected.repoId : undefined,
        assigneeId: selected.engine === "anneal" ? selected.assigneeId : undefined,
        maxDurationMin: 120,
        allowCodex: selected.definitionId === "codex-oauth",
        confirmExternalExecution: true,
        credential,
        confirm: true,
      });
      setCredential("");
      await refreshBindings();
      setNotice(text(
        language,
        `${result.plan.account.label} is connected to ${selected.engine}.`,
        `${result.plan.account.label} 已連線至 ${selected.engine}。`,
      ));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  };
'''

source = replace_once(source, old_connect, new_connect, "connectProvider")

old_connected = '''  const connectedIds = useMemo(() => new Set(bindings.filter((binding) => (
    binding.enabled && binding.connected && binding.current_scope_valid
  )).map((binding) => binding.id)), [bindings]);
'''

new_connected = '''  const connectedIds = useMemo(() => new Set(instances.filter((instance) => bindings.some((binding) => (
    binding.engine === instance.engine
      && binding.provider === instance.definitionId
      && binding.model === instance.selectedModel
      && binding.enabled
      && binding.connected
      && binding.current_scope_valid
  ))).map((instance) => instance.id)), [bindings, instances]);
'''

source = replace_once(source, old_connected, new_connected, "connectedIds")

old_prepare = '''  const prepareAnnealRun = async () => {
    const api = window.codingTools;
    if (!api) throw new Error("Coding Tools execution bridge is unavailable");
    if (!selected || !workspaceId || !taskId.trim()) {
      throw new Error("Select a workspace and enter an existing task ID");
    }
    if (!confirmRun) throw new Error("External Anneal execution must be approved");
    setBusy(true);
    setError(null);
    try {
      const initial = await api.execution.read({ workspaceId, missionId: null, refreshSource: false });
      const bindings = executionBindings(initial).filter((binding) => (
        binding.engine === "anneal"
        && binding.enabled
        && binding.connected
        && binding.current_scope_valid
      ));
      if (bindings.length === 0) throw new Error("Connect at least one approved Anneal provider binding first");

      const prepared: string[] = [];
      for (const stage of selected.stages) {
        const providerId = stageProvider(stage);
        const binding = bindings.find((candidate) => candidate.provider === providerId)
          ?? bindings.find((candidate) => candidate.model === stage.model?.model);
        if (!binding) throw new Error(`No connected Anneal binding for ${stage.name} (${providerId})`);

        const view = await api.execution.read({ workspaceId, missionId: null, refreshSource: false });
        const missionId = sanitizeIdentifier(`${selected.id}-${stage.id}-${crypto.randomUUID().slice(0, 8)}`);
        await api.execution.update({
          workspaceId,
          expectedRevision: boardRevision(view),
          change: {
            operation: "agent_prepare",
            binding_id: binding.id,
            task_id: taskId.trim(),
            mission_id: missionId,
          },
          confirm: true,
        });
        const preparedView = await api.execution.read({ workspaceId, missionId, refreshSource: false });
        await api.execution.update({
          workspaceId,
          expectedRevision: missionRevision(preparedView, missionId),
          change: {
            operation: "agent_control",
            mission_id: missionId,
            request_key: crypto.randomUUID(),
            action: "create",
          },
          confirm: true,
        });
        prepared.push(missionId);
      }
      setNotice(text(
        language,
        `Prepared ${prepared.length} owned Anneal stage missions. Inspect source state before starting them.`,
        `已建立 ${prepared.length} 個 Anneal 階段任務。啟動前請先核對來源狀態。`,
      ));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
'''

new_prepare = '''  const prepareAnnealRun = async () => {
    const launcher = window.codexWebLauncher;
    if (!launcher) throw new Error("Provider Hub execution bridge is unavailable");
    if (!selected || !workspaceId || !taskId.trim()) {
      throw new Error("Select a workspace and enter an existing task ID");
    }
    if (!confirmRun) throw new Error("External Anneal execution must be approved");
    setBusy(true);
    setError(null);
    try {
      const prepared: string[] = [];
      for (const stage of selected.stages) {
        const providerId = stageProvider(stage);
        const missionId = sanitizeIdentifier(`${selected.id}-${stage.id}-${crypto.randomUUID().slice(0, 8)}`);
        await launcher.dispatchProviderMission({
          workspaceId,
          workload: "anneal",
          engine: "anneal",
          providerId,
          model: stage.model?.model || undefined,
          allowFallback: false,
          taskId: taskId.trim(),
          missionId,
          requestKey: crypto.randomUUID(),
          confirm: true,
        });
        prepared.push(missionId);
      }
      setNotice(text(
        language,
        `Prepared ${prepared.length} Provider Hub-owned Anneal stage missions. Inspect source state before starting them.`,
        `已建立 ${prepared.length} 個由供應商中心管理嘅 Anneal 階段任務。啟動前請先核對來源狀態。`,
      ));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  };
'''

source = replace_once(source, old_prepare, new_prepare, "prepareAnnealRun")

if "api.execution.provider(" in source:
    raise SystemExit("direct execution.provider bypass remains")
if "configureProviderExecution(" not in source or "dispatchProviderMission(" not in source:
    raise SystemExit("planned execution calls were not materialized")

TARGET.write_text(source, encoding="utf-8")
print("PROVIDER_PLANNED_DISPATCH_APPLIED")
