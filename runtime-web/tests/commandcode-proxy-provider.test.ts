import { describe, expect, test } from "bun:test";
import {
  commandCodeProxyRegistrationPlan,
  renderCommandCodeProxyPlan,
} from "../scripts/commandcode-proxy-provider";

describe("CommandCode Proxy provider bootstrap", () => {
  test("builds the Codex Router generic-provider registration and curation sequence", () => {
    const plan = commandCodeProxyRegistrationPlan({
      baseUrl: "http://127.0.0.1:3050/v1/",
      routerCli: "./bin/model-router",
      curateCli: "./bin/curate-models",
    });

    expect(plan.provider).toEqual({
      id: "commandcode-proxy",
      name: "CommandCode Proxy",
      baseUrl: "http://127.0.0.1:3050/v1",
      adapter: "openai-chat",
      modelEndpoint: "/models",
    });
    expect(plan.commands).toEqual([
      [
        "./bin/model-router", "codex", "providers", "generic", "add", "commandcode-proxy",
        "--name", "CommandCode Proxy",
        "--base-url", "http://127.0.0.1:3050/v1",
        "--adapter", "openai-chat",
        "--allow-private",
      ],
      ["./bin/model-router", "codex", "providers", "generic", "credential", "commandcode-proxy", "set"],
      ["./bin/model-router", "codex", "providers", "generic", "enable", "commandcode-proxy"],
      ["./bin/curate-models", "commandcode-proxy"],
    ]);
    expect(plan.credentialPromptRequired).toBe(true);
  });

  test("does not request private-network permission for an HTTPS proxy", () => {
    const plan = commandCodeProxyRegistrationPlan({
      baseUrl: "https://cc-proxy.example/v1",
      routerCli: "model-router",
      curateCli: "curate-models",
    });
    expect(plan.commands[0]).not.toContain("--allow-private");
  });

  test("renders commands without accepting or exposing a CommandCode user key", () => {
    const secret = "user_SUPER_SECRET_MUST_NOT_APPEAR";
    const plan = commandCodeProxyRegistrationPlan({
      baseUrl: "http://localhost:3050/v1",
      routerCli: "model-router",
      curateCli: "curate-models",
    });
    const output = renderCommandCodeProxyPlan(plan);

    expect(output).toContain("providers generic credential commandcode-proxy set");
    expect(output).toContain("hidden credential prompt");
    expect(output).not.toContain(secret);
    expect(JSON.stringify(plan)).not.toContain("user_");
  });
});
