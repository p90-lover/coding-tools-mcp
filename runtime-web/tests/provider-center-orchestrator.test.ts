import { afterEach, describe, expect, test } from "bun:test";
import {
  builtinProviderProfiles,
  getBuiltinProvider,
  validateProviderProfiles,
} from "../src/provider-registry";
import {
  discoverProviderModels,
  registerProviderRuntimeAdapter,
  resetProviderRuntimeState,
  resolveFallbackPolicy,
  testProvider,
} from "../src/provider-runtime";
import {
  createDefaultOrchestrator,
  normalizeOrchestrator,
  projectToAnneal,
  validateOrchestrator,
} from "../src/orchestrator-config";

afterEach(() => {
  resetProviderRuntimeState();
});

describe("provider center", () => {
  test("ships the requested provider families without embedded credentials", () => {
    expect(validateProviderProfiles()).toEqual([]);

    const required = [
      "codex-oauth",
      "claude-oauth",
      "chatgpt-web",
      "openai-api",
      "anthropic-api",
      "gemini-api",
      "commandcode-proxy",
      "ai-studio-reverse-proxy",
      "gemini-reverse-proxy",
      "aistudio-to-api",
      "cliproxyapi-antigravity",
      "custom-openai-compatible",
    ];
    for (const providerId of required) {
      expect(getBuiltinProvider(providerId), providerId).toBeDefined();
    }

    for (const profile of builtinProviderProfiles) {
      expect(profile.requiresExplicitConsent).toBe(true);
      expect(Object.hasOwn(profile, "apiKey")).toBe(false);
      expect(Object.hasOwn(profile, "secret")).toBe(false);
      expect(Object.hasOwn(profile, "token")).toBe(false);
    }
  });

  test("does not report a provider ready until a runtime adapter proves it", async () => {
    const unconfigured = await testProvider("commandcode-proxy");
    expect(unconfigured.ok).toBe(false);
    expect(unconfigured.health.status).toBe("unknown");

    registerProviderRuntimeAdapter("commandcode-proxy", {
      async test() {
        return {
          status: "ready",
          latencyMs: 12,
          models: [{ id: "claude-sonnet-4-6" }],
        };
      },
      async discoverModels() {
        return [
          { id: "claude-sonnet-4-6" },
          { id: "gpt-5.6-sol" },
        ];
      },
    });

    const configured = await testProvider("commandcode-proxy");
    expect(configured.ok).toBe(true);
    expect(configured.health.status).toBe("ready");
    expect(configured.models.map((model) => model.id)).toEqual(["claude-sonnet-4-6"]);

    const models = await discoverProviderModels("commandcode-proxy");
    expect(models.map((model) => model.id)).toEqual([
      "claude-sonnet-4-6",
      "gpt-5.6-sol",
    ]);
  });

  test("deduplicates and capability-filters fallback providers", () => {
    const policy = resolveFallbackPolicy(
      "codex-oauth",
      ["codex-oauth", "claude-oauth", "claude-oauth", "missing", "gemini-api"],
      { engine: "anneal", capability: "tools" },
    );
    expect(policy).toEqual({
      primary: "codex-oauth",
      fallback: ["claude-oauth", "gemini-api"],
    });
  });
});

describe("Anneal orchestrator", () => {
  test("normalizes and projects a valid structured staffing plan", () => {
    const definition = normalizeOrchestrator(createDefaultOrchestrator());
    expect(validateOrchestrator(definition)).toEqual([]);

    const projection = projectToAnneal(definition);
    expect(projection.schemaVersion).toBe(1);
    expect(projection.engine).toBe("anneal");
    expect(projection.staff).toHaveLength(4);
    expect(projection.staff.every((stage) => stage.maxAttempts >= 1)).toBe(true);
    expect(projection.execution.requireApproval).toBe(true);
  });

  test("rejects unknown providers before dispatch", () => {
    const definition = createDefaultOrchestrator();
    definition.stages[0]!.providerId = "unknown-provider";
    expect(() => projectToAnneal(definition)).toThrow("Unknown primary provider");
  });
});
