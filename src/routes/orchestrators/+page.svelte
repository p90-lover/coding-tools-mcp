<script lang="ts">
  import { onMount } from "svelte";
  import {
    GitBranch,
    Plus,
    Save,
    Play,
    ShieldCheck,
    Trash2,
  } from "@lucide/svelte";
  import { providersForEngine } from "../../../runtime-web/src/provider-runtime";
  import {
    createDefaultOrchestrator,
    normalizeOrchestrator,
    parseOrchestrator,
    projectToAnneal,
    type OrchestratorDefinition,
    type OrchestratorStage,
  } from "../../../runtime-web/src/orchestrator-config";

  const STORAGE_KEY = "coding-tools.anneal-orchestrator.v1";
  const providers = providersForEngine("anneal");
  let definition = $state<OrchestratorDefinition>(createDefaultOrchestrator());
  let preview = $state("");
  let error = $state("");
  let saved = $state(false);

  function newStage(): OrchestratorStage {
    const index = definition.stages.length + 1;
    const primary = providers[0]?.id ?? "commandcode-proxy";
    const fallback = providers.find((provider) => provider.id !== primary)?.id;
    return {
      id: `stage-${Date.now()}-${index}`,
      name: `Stage ${index}`,
      role: `stage-${index}`,
      providerId: primary,
      fallbackProviderIds: fallback ? [fallback] : [],
      model: "",
      requiredCapabilities: ["text", "reasoning"],
      maxAttempts: 3,
      timeoutMs: 10 * 60 * 1000,
      approval: "inherit",
    };
  }

  function addStage() {
    definition.stages.push(newStage());
    preview = "";
  }

  function removeStage(index: number) {
    if (definition.stages.length <= 1) return;
    definition.stages.splice(index, 1);
    preview = "";
  }

  function setFallback(stage: OrchestratorStage, providerId: string) {
    stage.fallbackProviderIds = providerId ? [providerId] : [];
    preview = "";
  }

  function buildPreview(): string {
    const normalized = normalizeOrchestrator(definition);
    const projection = projectToAnneal(normalized);
    definition = normalized;
    return JSON.stringify(projection, null, 2);
  }

  function previewPlan() {
    error = "";
    saved = false;
    try {
      preview = buildPreview();
    } catch (cause) {
      preview = "";
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  function savePlan() {
    error = "";
    saved = false;
    try {
      preview = buildPreview();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(definition));
      saved = true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  function resetPlan() {
    definition = createDefaultOrchestrator();
    preview = "";
    error = "";
    saved = false;
  }

  onMount(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    try {
      definition = parseOrchestrator(stored);
    } catch (cause) {
      error = `Saved orchestrator was not loaded: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  });
</script>

<section class="cc-page">
  <header class="cc-page-heading">
    <div>
      <h1><GitBranch size={18} /> Anneal Orchestrator Builder</h1>
      <p>Create a validated Anneal staffing plan with per-stage provider, model, fallback, retry, approval and budget controls.</p>
    </div>
    <span class="cc-inline-label"><ShieldCheck size={16} /> Execution still requires the configured permission policy</span>
  </header>

  <section class="cc-panel orchestrator-settings">
    <label>
      Name
      <input bind:value={definition.name} maxlength="120" />
    </label>
    <label>
      Budget (minutes)
      <input type="number" min="1" max="1440" bind:value={definition.maxBudgetMinutes} />
    </label>
    <label class="check-row">
      <input type="checkbox" bind:checked={definition.parallel} />
      Allow independent stages to run in parallel
    </label>
    <label class="check-row">
      <input type="checkbox" bind:checked={definition.requireApproval} />
      Require approval before dispatch
    </label>
  </section>

  <section class="cc-panel stages-panel">
    <div class="panel-heading">
      <div>
        <h2>Stages</h2>
        <p>Anneal remains the scheduler; this page produces its validated template and staffing projection.</p>
      </div>
      <button type="button" class="cc-button secondary" onclick={addStage}>
        <Plus size={14} /> Add stage
      </button>
    </div>

    <div class="stage-list">
      {#each definition.stages as stage, index (stage.id)}
        <article class="stage-card">
          <div class="stage-title">
            <strong>{index + 1}</strong>
            <input aria-label="Stage name" bind:value={stage.name} maxlength="80" />
            <button
              type="button"
              class="cc-button ghost danger"
              aria-label={`Remove ${stage.name}`}
              disabled={definition.stages.length <= 1}
              onclick={() => removeStage(index)}
            >
              <Trash2 size={14} />
            </button>
          </div>

          <div class="stage-grid">
            <label>
              Role
              <input bind:value={stage.role} maxlength="80" />
            </label>
            <label>
              Primary provider
              <select bind:value={stage.providerId}>
                {#each providers as provider}
                  <option value={provider.id}>{provider.name}</option>
                {/each}
              </select>
            </label>
            <label>
              Fallback provider
              <select
                value={stage.fallbackProviderIds[0] ?? ""}
                onchange={(event) => setFallback(stage, (event.currentTarget as HTMLSelectElement).value)}
              >
                <option value="">No fallback</option>
                {#each providers.filter((provider) => provider.id !== stage.providerId) as provider}
                  <option value={provider.id}>{provider.name}</option>
                {/each}
              </select>
            </label>
            <label>
              Model override
              <input bind:value={stage.model} placeholder="Use provider default" maxlength="160" />
            </label>
            <label>
              Maximum attempts
              <input type="number" min="1" max="10" bind:value={stage.maxAttempts} />
            </label>
            <label>
              Timeout (seconds)
              <input
                type="number"
                min="5"
                max="3600"
                value={Math.round(stage.timeoutMs / 1000)}
                onchange={(event) => {
                  stage.timeoutMs = Number((event.currentTarget as HTMLInputElement).value) * 1000;
                }}
              />
            </label>
            <label>
              Approval
              <select bind:value={stage.approval}>
                <option value="inherit">Inherit workflow policy</option>
                <option value="required">Always require approval</option>
                <option value="never">No additional stage approval</option>
              </select>
            </label>
          </div>
        </article>
      {/each}
    </div>
  </section>

  <section class="action-row">
    <button type="button" class="cc-button ghost" onclick={resetPlan}>New orchestrator</button>
    <button type="button" class="cc-button secondary" onclick={previewPlan}><Play size={14} /> Preview resolved plan</button>
    <button type="button" class="cc-button primary" onclick={savePlan}><Save size={14} /> Save locally</button>
  </section>

  {#if saved}
    <p class="success">Orchestrator saved. Provider credentials are not stored in this document.</p>
  {/if}
  {#if error}
    <p class="error" role="alert">{error}</p>
  {/if}
  {#if preview}
    <section class="cc-panel preview-panel">
      <h2>Resolved Anneal projection</h2>
      <pre>{preview}</pre>
    </section>
  {/if}
</section>

<style>
  .orchestrator-settings,
  .stage-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
  }
  label {
    display: grid;
    gap: 0.4rem;
    font-size: 0.85rem;
  }
  input,
  select {
    min-width: 0;
    padding: 0.55rem 0.65rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--surface, transparent);
    color: inherit;
  }
  .check-row {
    grid-template-columns: auto 1fr;
    align-items: center;
  }
  .panel-heading,
  .stage-title,
  .action-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .stage-list {
    display: grid;
    gap: 1rem;
    margin-top: 1rem;
  }
  .stage-card {
    padding: 1rem;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
  }
  .stage-title {
    justify-content: flex-start;
    margin-bottom: 1rem;
  }
  .stage-title input {
    flex: 1;
    font-weight: 650;
  }
  .danger {
    margin-left: auto;
  }
  .action-row {
    justify-content: flex-end;
    flex-wrap: wrap;
  }
  .success,
  .error {
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
  }
  .success {
    border: 1px solid color-mix(in srgb, #22c55e 55%, transparent);
  }
  .error {
    border: 1px solid color-mix(in srgb, #ef4444 55%, transparent);
  }
  .preview-panel pre {
    overflow: auto;
    max-height: 32rem;
    white-space: pre-wrap;
    word-break: break-word;
  }
  @media (max-width: 900px) {
    .orchestrator-settings,
    .stage-grid {
      grid-template-columns: 1fr;
    }
    .panel-heading {
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
