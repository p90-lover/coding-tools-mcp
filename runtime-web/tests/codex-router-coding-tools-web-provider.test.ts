import { describe, expect, test } from "bun:test";
import {
  codingToolsWebProviderRegistrationPlan,
  renderCodingToolsWebProviderPlan,
} from "../scripts/codex-router-coding-tools-web-provider";

describe("Coding Tools Web Codex Router provider bootstrap", () => {
  test("registers the restricted loopback ingress as credentialless openai-responses", () => {
    const plan = codingToolsWebProviderRegistrationPlan({
      baseUrl: "http://127.0.0.1:17841/router/v1/",
      routerCli: "./bin/model-router",
      curateCli: "./bin/curate-models",
    });

    expect(plan.provider).toEqual({
      id: "coding-tools-web",
      name: "Coding Tools Web",
      baseUrl: "http://127.0.0.1:17841/router/v1",
      adapter: "openai-responses",
    });
    expect(plan.commands).toEqual([
      [
        "./bin/model-router", "codex", "providers", "generic", "add", "coding-tools-web",
        "--name", "Coding Tools Web",
        "--base-url", "http://127.0.0.1:17841/router/v1",
        "--adapter", "openai-responses",
        "--allow-private",
      ],
      ["./bin/model-router", "codex", "providers", "generic", "enable", "coding-tools-web"],
      ["./bin/curate-models", "coding-tools-web"],
    ]);
    expect(plan.credentialPromptRequired).toBe(false);
  });

  test("refuses a non-loopback back-provider even when it uses HTTPS", () => {
    expect(() => codingToolsWebProviderRegistrationPlan({
      baseUrl: "https://bridge.example/router/v1",
      routerCli: "model-router",
      curateCli: "curate-models",
    })).toThrow("loopback");
  });

  test("renders no credential setup or reusable secret", () => {
    const plan = codingToolsWebProviderRegistrationPlan({
      baseUrl: "http://localhost:17841/router/v1",
      routerCli: "model-router",
      curateCli: "curate-models",
    });
    const output = renderCodingToolsWebProviderPlan(plan);
    expect(output).toContain("openai-responses");
    expect(output).toContain("credentialless");
    expect(output).not.toContain("providers generic credential");
    expect(output).not.toContain("user_");
    expect(output).not.toContain("CODING_TOOLS_CODEX_ROUTER_CALLER_KEY");
  });
});
