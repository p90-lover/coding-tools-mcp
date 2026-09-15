import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  codexRouterProviderToml,
  routedAgentDefinition,
  syncRoutedAgentDefinitions,
} from "../src/routed-agent-catalog";

function testRoot(label: string): string {
  const root = resolve("..", "aiTemp", "tests", `routed-agent-catalog-${label}-${process.pid}-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

describe("scalable Codex Router agent types", () => {
  test("builds deterministic credential-free agent definitions", () => {
    const first = routedAgentDefinition("commandcode-proxy/claude-sonnet-4-6");
    const again = routedAgentDefinition("commandcode-proxy/claude-sonnet-4-6");
    const collision = routedAgentDefinition("commandcode-proxy/claude_sonnet_4_6");

    expect(first).toEqual(again);
    expect(first.agentName).toMatch(/^coding_tools_router_commandcode_proxy_claude_sonnet_4_6_[a-f0-9]{10}$/);
    expect(first.fileName).toMatch(/^coding-tools-router-commandcode-proxy-claude-sonnet-4-6-[a-f0-9]{10}\.toml$/);
    expect(collision.agentName).not.toBe(first.agentName);
    expect(collision.fileName).not.toBe(first.fileName);
    expect(first.contents).not.toContain("model_provider");
    expect(first.contents).toContain('model = "commandcode-proxy/claude-sonnet-4-6"');
    expect(first.contents).not.toContain("CODING_TOOLS_CODEX_ROUTER_CALLER_KEY");
    expect(first.contents).not.toContain("user_");
  });

  test("builds a bearer/env-key provider block without embedding the caller key", () => {
    const callerKey = "never_write_this_caller_key_abcdefghijklmnopqrstuvwxyz";
    const block = codexRouterProviderToml("http://127.0.0.1:4202");

    expect(block).toContain("[model_providers.codex-router]");
    expect(block).toContain('base_url = "http://127.0.0.1:4202/v1"');
    expect(block).toContain('env_key = "CODING_TOOLS_CODEX_ROUTER_CALLER_KEY"');
    expect(block).toContain('wire_api = "responses"');
    expect(block).toContain("requires_openai_auth = false");
    expect(block).toContain("supports_websockets = false");
    expect(block).not.toContain(callerKey);
    expect(() => codexRouterProviderToml("http://router.example:4202")).toThrow("loopback");
  });

  test("syncs only managed definitions and preserves stale files in Trash", () => {
    const root = testRoot("sync");
    const agentsDir = join(root, "agents");
    const trashDir = join(root, "Trash");
    mkdirSync(agentsDir, { recursive: true });

    const stale = routedAgentDefinition("deepseek/old-model");
    writeFileSync(join(agentsDir, stale.fileName), stale.contents, { mode: 0o600 });
    const userAgent = join(agentsDir, "reviewer.toml");
    writeFileSync(userAgent, 'name = "reviewer"\nmodel = "gpt-5.6-sol"\n', { mode: 0o600 });
    chmodSync(userAgent, 0o600);

    const result = syncRoutedAgentDefinitions(
      ["commandcode-proxy/claude-sonnet-4-6", "deepseek/deepseek-v4-pro"],
      { agentsDir, trashDir },
    );

    expect(result.written).toHaveLength(2);
    expect(result.preserved).toHaveLength(1);
    expect(existsSync(join(agentsDir, stale.fileName))).toBe(false);
    expect(existsSync(result.preserved[0]!.to)).toBe(true);
    expect(readFileSync(result.preserved[0]!.to, "utf8")).toBe(stale.contents);
    expect(readFileSync(userAgent, "utf8")).toContain('name = "reviewer"');

    const rerun = syncRoutedAgentDefinitions(
      ["commandcode-proxy/claude-sonnet-4-6", "deepseek/deepseek-v4-pro"],
      { agentsDir, trashDir },
    );
    expect(rerun.written).toHaveLength(0);
    expect(rerun.unchanged).toHaveLength(2);
    expect(rerun.preserved).toHaveLength(0);
  });
});
