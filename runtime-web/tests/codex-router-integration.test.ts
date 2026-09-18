import { describe, expect, test } from "bun:test";
import {
  codexRouterIntegrationPlan,
  renderCodexRouterIntegrationPlan,
  type GenericProviderSnapshot,
} from "../scripts/codex-router-integration";

const web: GenericProviderSnapshot = {
  id: "coding-tools-web",
  displayName: "Coding Tools Web",
  baseUrl: "http://127.0.0.1:17841/router/v1",
  adapter: "openai-responses",
  allowPrivate: true,
  enabled: true,
};

const commandCode: GenericProviderSnapshot = {
  id: "commandcode-proxy",
  displayName: "CommandCode Proxy",
  baseUrl: "http://127.0.0.1:3050/v1",
  adapter: "openai-chat",
  allowPrivate: true,
  enabled: true,
};

describe("Codex Router integration plan", () => {
  test("adds missing providers but never removes or edits an existing descriptor", () => {
    const plan = codexRouterIntegrationPlan({
      existingProviders: [],
      withCommandCodeProxy: true,
      routerCli: "./bin/model-router",
      curateCli: "./bin/curate-models",
    });
    const rendered = plan.commands.map(command => command.join(" "));

    expect(rendered.some(command => command.includes("providers generic add coding-tools-web"))).toBe(true);
    expect(rendered.some(command => command.includes("providers generic add commandcode-proxy"))).toBe(true);
    expect(rendered.some(command => command.includes("providers generic add cpa"))).toBe(false);
    expect(rendered.some(command => command.includes("providers generic remove"))).toBe(false);
    expect(rendered.some(command => command.includes("providers generic edit"))).toBe(false);
    expect(plan.ensureCommandCodeCredential).toBe(true);
  });

  test("skips matching descriptors and keeps enable/curate idempotent", () => {
    const plan = codexRouterIntegrationPlan({
      existingProviders: [web, commandCode],
      withCommandCodeProxy: true,
      routerCli: "model-router",
      curateCli: "curate-models",
    });
    const rendered = plan.commands.map(command => command.join(" "));

    expect(rendered.some(command => command.includes(" generic add "))).toBe(false);
    expect(rendered).toContain("model-router codex providers generic enable coding-tools-web");
    expect(rendered).toContain("curate-models coding-tools-web");
    expect(rendered).toContain("model-router codex providers generic enable commandcode-proxy");
    expect(rendered).toContain("curate-models commandcode-proxy");
    expect(plan.ensureCommandCodeCredential).toBe(true);
  });

  test("fails closed rather than overwriting a conflicting managed provider id", () => {
    expect(() => codexRouterIntegrationPlan({
      existingProviders: [{ ...web, baseUrl: "http://127.0.0.1:9999/router/v1" }],
      withCommandCodeProxy: false,
    })).toThrow("coding-tools-web");

    expect(() => codexRouterIntegrationPlan({
      existingProviders: [{ ...commandCode, adapter: "openai-responses" }],
      withCommandCodeProxy: true,
    })).toThrow("commandcode-proxy");
  });

  test("dry-run output contains no provider key or caller capability", () => {
    const plan = codexRouterIntegrationPlan({
      existingProviders: [],
      withCommandCodeProxy: true,
    });
    const output = renderCodexRouterIntegrationPlan(plan);
    expect(output).toContain("credential status");
    expect(output).toContain("hidden local prompt");
    expect(output).not.toContain("user_");
    expect(output).not.toContain("CODING_TOOLS_CODEX_ROUTER_CALLER_KEY");
  });

  test("registers in-app CPA without a credential prompt", () => {
    const plan = codexRouterIntegrationPlan({
      existingProviders: [],
      withCpa: true,
      cpaBaseUrl: "http://127.0.0.1:8317/v1",
      routerCli: "model-router",
      curateCli: "curate-models",
    });
    const rendered = plan.commands.map(command => command.join(" "));
    expect(rendered.some(command => command.includes("providers generic add cpa"))).toBe(true);
    expect(rendered.some(command => command.includes("--base-url http://127.0.0.1:8317/v1"))).toBe(true);
    expect(rendered.some(command => command.includes("credential") && command.includes("cpa"))).toBe(false);
    const output = renderCodexRouterIntegrationPlan(plan);
    expect(output).toContain("127.0.0.1:8317");
    expect(output).toContain("does not prompt");
    expect(output).not.toContain("user_");
  });
});
