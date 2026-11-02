import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { defaultConfig } from "../src/config";
import {
  CHATGPT_WEB_LUNA_MODEL_ROUTE,
  CHATGPT_WEB_LUNA_MODEL_ROUTES,
  CHATGPT_WEB_ZERO_RISK_CONTEXT_WINDOW,
  CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE,
  CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE,
  CHATGPT_WEB_MODEL_ROUTES,
  CHATGPT_WEB_LEGACY_MODEL_ROUTES,
  availableChatGptWebModelRoutes,
  chatGptWebRouteEfforts,
  resolveChatGptWebContextLimits,
  servedChatGptWebModelRoute,
} from "../src/chatgpt-web-models";
import { augmentNativeModelCatalog, buildChatGptWebModel } from "../src/model-catalog";

function source(): Record<string, unknown> {
  return {
    models: [
      { slug: "gpt-5.5", display_name: "5.5", priority: 1, multi_agent_version: "disabled" },
      {
        slug: "gpt-5.6-sol",
        display_name: "5.6 Sol",
        description: "native",
        priority: 2,
        shell_type: "shell_command",
        visibility: "list",
        supported_in_api: true,
        multi_agent_version: "v2",
        base_instructions: "native harness",
        supported_reasoning_levels: [
          { effort: "low", description: "Low" },
          { effort: "medium", description: "Medium native" },
          { effort: "high", description: "High native" },
          { effort: "xhigh", description: "Extra high native" },
        ],
        tool_mode: "code_mode_only",
        context_window: 300_000,
        max_context_window: 320_000,
        auto_compact_token_limit: 270_000,
        comp_hash: "native-compaction-contract",
        additional_speed_tiers: [{ id: "fast" }],
        service_tiers: [{ id: "fast", name: "Fast" }],
        default_service_tier: "fast",
      },
      { slug: "gpt-5.6-terra", display_name: "5.6 Terra", priority: 3, multi_agent_version: "v2" },
    ],
  };
}

describe("native /models augmentation", () => {
  test.each([true, false])("AO catalog CLI wire preserves each Web row and its legacy first row (Sol=%s)", solAvailable => {
    const native = source();
    const config = { ...defaultConfig("full"), browserHost: "launcher" as const,
      browserHostDescriptorPath: "G:/fixture/launcher.json", experimentalBiggerContext: true,
      solAvailable, proAvailable: solAvailable, extraHighAvailable: solAvailable };
    const cliSource = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
    const start = cliSource.indexOf('    const bundled = runCommand(codex, ["debug", "models", "--bundled"]');
    const end = cliSource.indexOf('\n  }\n  else if (command === "subagents")', start);
    expect(start >= 0 && end > start).toBe(true);
    const javascript = new Bun.Transpiler({ loader: "ts" }).transformSync(cliSource.slice(start, end));
    let written = "";
    new Function("codex", "runCommand", "augmentNativeModelCatalog", "loadConfig", "freshChatGptEffortTiers", "stdout", javascript)(
      "G:/fixture/codex.exe", () => ({ status: 0, stdout: JSON.stringify(native) }),
      augmentNativeModelCatalog, () => config, () => undefined, { write: (text: string) => { written += text; } },
    );
    const wire = JSON.parse(written) as { models: Array<Record<string, unknown>>; available: string[] };
    const expected = (augmentNativeModelCatalog(native, config).models as Array<Record<string, unknown>>)
      .filter(model => String(model.slug).startsWith("chatgpt-web/"));
    expect(wire.models[0]?.slug).toBe(solAvailable ? "chatgpt-web/high" : "chatgpt-web/luna");
    expect(wire.models.map(model => model.slug).sort()).toEqual(expected.map(model => model.slug).sort());
    expect(wire.available).toEqual(expected.map(model => String(model.slug)));
    for (const model of expected) expect(wire.models.find(row => row.slug === model.slug)).toEqual(model);
    if (solAvailable) {
      expect(wire.models.find(model => model.slug === "chatgpt-web/high")).toMatchObject({ context_window: 270_000 });
      expect(wire.models.find(model => model.slug === "chatgpt-web/gpt-6-sol"))
        .toMatchObject({ context_window: 120_000, auto_compact_token_limit: 93_840, default_reasoning_level: "high" });
      const sol = wire.models.find(model => model.slug === "chatgpt-web/gpt-6-sol")!;
      expect((sol.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
        .toEqual(["medium", "high", "xhigh"]);
      expect(wire.models.find(model => model.slug === "chatgpt-web/gpt-6-pro"))
        .toMatchObject({ context_window: 270_000, auto_compact_token_limit: 204_255, default_reasoning_level: "max" });
    }
  });

  test("preserves native models, groups supported efforts, and retains hidden legacy metadata", () => {
    const native = source();
    const nativeSnapshot = structuredClone(native);
    const config = defaultConfig("full");
    config.subagentProtocol = "native";
    config.extraHighAvailable = true;
    config.proAvailable = true;
    const result = augmentNativeModelCatalog(native, config);
    const models = result.models as Array<Record<string, unknown>>;
    const originalModels = nativeSnapshot.models as Array<Record<string, unknown>>;

    expect(native).toEqual(nativeSnapshot);
    expect(models.slice(0, 3)).toEqual(originalModels);
    const web = models.slice(3).filter(model => model.visibility === "list");
    const legacy = models.slice(3).filter(model => model.visibility === "hide");
    expect(legacy.map(model => model.slug)).toEqual(CHATGPT_WEB_LEGACY_MODEL_ROUTES.map(route => route.slug));
    expect(legacy.map(model => [model.context_window, model.auto_compact_token_limit])).toEqual([
      [111_193, 80_336], [111_193, 80_336], [111_193, 80_336], [111_193, 80_336], [112_193, 81_059],
    ]);
    expect(web.map(model => model.slug)).toEqual(CHATGPT_WEB_MODEL_ROUTES.map(route => route.slug));
    expect(web.map(model => model.display_name)).toEqual(CHATGPT_WEB_MODEL_ROUTES.map(route => route.displayName));
    for (const [index, model] of web.entries()) {
      const route = CHATGPT_WEB_MODEL_ROUTES[index]!;
      const limits = resolveChatGptWebContextLimits(route.backendModel, route.adapterEffort, config);
      expect(model).toMatchObject({
        slug: route.slug,
        display_name: route.displayName,
        tool_mode: null,
        default_reasoning_level: route.codexEffort,
        multi_agent_version: "v2",
        supported_in_api: true,
        priority: 2,
        context_window: limits.contextWindow,
        max_context_window: limits.contextWindow,
        effective_context_window_percent: limits.effectiveContextWindowPercent,
        auto_compact_token_limit: limits.autoCompactTokenLimit,
        additional_speed_tiers: [],
        service_tiers: [],
        default_service_tier: null,
      });
      expect(model).not.toHaveProperty("comp_hash");
      expect((model.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
        .toEqual([...chatGptWebRouteEfforts(route, config)]);
    }
    expect((web[1]!.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
      .toEqual(["medium", "high", "xhigh"]);
    expect(() => buildChatGptWebModel(originalModels[1], {
      ...CHATGPT_WEB_MODEL_ROUTES[1]!, supportedCodexEfforts: ["low", "medium"],
    }, { ...config, proAvailable: false })).toThrow("Cannot group different context budgets");
  });

  test("a fresh effort-slider reading trims listed rows and efforts but keeps hidden legacy rows", () => {
    const config = defaultConfig("full");
    config.extraHighAvailable = true;
    config.proAvailable = true;
    const models = augmentNativeModelCatalog(source(), config, undefined, [true, true, true, false, false])
      .models as Array<Record<string, unknown>>;
    const web = models.filter(model => String(model.slug).startsWith("chatgpt-web/"));
    expect(web.filter(model => model.visibility === "list").map(model => model.slug)).toEqual([
      "chatgpt-web/gpt-6-sol-instant", "chatgpt-web/gpt-6-sol",
      "chatgpt-web/gpt-5.6-sol-instant", "chatgpt-web/gpt-5.6-sol",
    ]);
    expect(web.filter(model => model.visibility === "hide").map(model => model.slug))
      .toEqual(CHATGPT_WEB_LEGACY_MODEL_ROUTES.map(route => route.slug));
    const sol = web.find(model => model.slug === "chatgpt-web/gpt-6-sol")!;
    expect((sol.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
      .toEqual(["medium", "high"]);
  });

  test("publishes Bigger Context limits in the Codex model catalog", () => {
    const config = defaultConfig("full");
    config.extraHighAvailable = true;
    config.proAvailable = true;
    config.experimentalBiggerContext = true;
    const models = augmentNativeModelCatalog(source(), config).models as Array<Record<string, unknown>>;
    const pro = models.find(model => model.slug === "chatgpt-web/pro")!;
    expect(pro.context_window).toBe(336_579);
    expect(pro.auto_compact_token_limit).toBe(243_178);
  });

  test("publishes measured GPT-6 context by account and effort while preserving GPT-5.6 and Pro budgets", () => {
    for (const proAvailable of [false, true]) {
      const config = {
        ...defaultConfig("full"), proAvailable, extraHighAvailable: proAvailable,
        experimentalBiggerContext: true,
      };
      const models = augmentNativeModelCatalog(source(), config).models as Array<Record<string, unknown>>;
      // Windows are upstream's measurements; compaction is Coding Tools' 85% of the usable window.
      for (const [suffix, window, compact, biggerCompact] of [
        ["sol-instant", proAvailable ? 111_193 : 41_000, proAvailable ? 80_336 : 27_183, proAvailable ? 241_010 : 81_549],
        ["sol", proAvailable ? 111_193 : 90_000, proAvailable ? 80_336 : 68_085, proAvailable ? 241_010 : 204_255],
      ] as const) {
        const six = models.find(model => model.slug === `chatgpt-web/gpt-6-${suffix}`)!;
        const expanded = suffix === "sol";
        const expandedWindow = proAvailable ? 240_000 : 120_000;
        const expandedCompact = proAvailable ? 187_680 : 93_840;
        expect(six).toMatchObject({ context_window: expanded ? expandedWindow : window,
          max_context_window: expanded ? expandedWindow : window, auto_compact_token_limit: expanded ? expandedCompact : compact });
        expect(six.description).toContain(expanded ? "Plus and Pro" : "standard context");
        expect(models.find(model => model.slug === `chatgpt-web/gpt-5.6-${suffix}`)).toMatchObject({
          context_window: window * 3, auto_compact_token_limit: biggerCompact,
        });
      }
      for (const family of ["5.6", "6"]) {
        // Catalog estimates retain each named Pro route's own Max budget; admission is separate.
        expect(models.find(model => model.slug === `chatgpt-web/gpt-${family}-pro`)).toMatchObject(proAvailable
          ? { context_window: 336_579, auto_compact_token_limit: 243_178 }
          : { context_window: 270_000, auto_compact_token_limit: 204_255 });
      }
    }
  });

  test("keeps native Sol selectable in the bounded Compatibility V1 registry", () => {
    const config = defaultConfig("full");
    config.subagentProtocol = "compatibility-v1";
    config.extraHighAvailable = true;
    config.proAvailable = true;
    const models = augmentNativeModelCatalog(source(), config).models as Array<Record<string, unknown>>;
    const parent = models.find(model => model.slug === "gpt-5.6-sol")!;
    expect(parent.multi_agent_version).toBe("v1");

    // Bundled Codex 0.147.0-alpha.6.5 accepts only exact-v2 rows from a V2 parent. A V1 parent
    // accepts the readable catalog, then sorts by priority and exposes at most five overrides.
    const parentSurface = parent.multi_agent_version;
    const spawnOverrides = models
      .filter(model => model.supported_in_api === true && model.visibility === "list")
      .filter(model => parentSurface !== "v2" || model.multi_agent_version === parentSurface)
      .toSorted((left, right) => Number(left.priority) - Number(right.priority))
      .slice(0, 5)
      .map(model => model.slug);

    expect(spawnOverrides).toEqual([
      "gpt-5.6-sol",
      "chatgpt-web/gpt-6-sol",
      "chatgpt-web/gpt-5.6-sol",
      "chatgpt-web/gpt-5.6-pro",
      "chatgpt-web/gpt-6-pro",
    ]);
    expect(models.find(model => model.slug === "chatgpt-web/light")?.priority).toBe(3);
  });

  test("Compatibility V1 preserves an explicit native delegation disable while pinning supported rows", () => {
    const config = defaultConfig("full");
    config.subagentProtocol = "compatibility-v1";
    const models = augmentNativeModelCatalog(source(), config).models as Array<Record<string, unknown>>;

    expect(models.find(model => model.slug === "gpt-5.5")?.multi_agent_version).toBe("disabled");
    expect(models.find(model => model.slug === "gpt-5.6-sol")?.multi_agent_version).toBe("v1");
    expect(models.find(model => model.slug === "gpt-5.6-terra")?.multi_agent_version).toBe("v1");
  });

  test("native protocol mode preserves official native rows and gives Web rows the template surface", () => {
    const native = source();
    const snapshot = structuredClone(native);
    const nativeModels = snapshot.models as Array<Record<string, unknown>>;
    const config = defaultConfig("full");
    config.subagentProtocol = "native";
    config.extraHighAvailable = true;
    config.proAvailable = true;

    const models = augmentNativeModelCatalog(native, config).models as Array<Record<string, unknown>>;
    expect(models.slice(0, nativeModels.length)).toEqual(nativeModels);
    expect(models.slice(nativeModels.length).every(model => model.multi_agent_version === "v2")).toBe(true);
    const spawnOverrides = models
      .filter(model => model.supported_in_api === true && model.visibility === "list")
      .filter(model => model.multi_agent_version === "v2")
      .toSorted((left, right) => Number(left.priority) - Number(right.priority))
      .slice(0, 5)
      .map(model => model.slug);
    expect(spawnOverrides).toContain("gpt-5.6-sol");
  });

  test("owns only its namespace, is idempotent, and keeps named and legacy model metadata", () => {
    const config = defaultConfig("browser-only");
    config.subagentProtocol = "native";
    config.proAvailable = false;
    config.extraHighAvailable = true;
    const polluted = source();
    (polluted.models as unknown[]).push(
      { slug: "chatgpt-web/gpt-5.6-sol", display_name: "legacy generic route" },
      { slug: "chatgpt-web/pro", display_name: "stale Pro route" },
    );
    const first = augmentNativeModelCatalog(polluted, config);
    const second = augmentNativeModelCatalog(first, config);
    const models = second.models as Array<Record<string, unknown>>;
    const web = models.filter(model => String(model.slug).startsWith("chatgpt-web/"));
    // Pro metadata remains listed; its account admission is checked when a turn starts.
    expect(web.map(model => model.slug)).toEqual([
      ...CHATGPT_WEB_MODEL_ROUTES.map(route => route.slug),
      ...CHATGPT_WEB_LEGACY_MODEL_ROUTES.map(route => route.slug),
    ]);
    expect(web.every(model => model.tool_mode === null)).toBe(true);
    expect(web.every(model => model.multi_agent_version === "v2")).toBe(true);
    expect(web.filter(model => model.visibility === "hide").every(model => (model.supported_reasoning_levels as unknown[]).length === 1)).toBe(true);
    expect(web.map(model => ({
      contextWindow: model.context_window,
      effectiveContextWindowPercent: model.effective_context_window_percent,
      autoCompactTokenLimit: model.auto_compact_token_limit,
    }))).toEqual([
      // Listed: GPT-6 Instant, GPT-6 Sol, GPT-5.6 Instant, GPT-5.6 Sol, GPT-5.6 Pro, GPT-6 Pro.
      { contextWindow: 41_000, effectiveContextWindowPercent: 78, autoCompactTokenLimit: 27_183 },
      { contextWindow: 90_000, effectiveContextWindowPercent: 89, autoCompactTokenLimit: 68_085 },
      { contextWindow: 41_000, effectiveContextWindowPercent: 78, autoCompactTokenLimit: 27_183 },
      { contextWindow: 90_000, effectiveContextWindowPercent: 89, autoCompactTokenLimit: 68_085 },
      { contextWindow: 90_000, effectiveContextWindowPercent: 89, autoCompactTokenLimit: 68_085 },
      { contextWindow: 90_000, effectiveContextWindowPercent: 89, autoCompactTokenLimit: 68_085 },
      // Hidden legacy: Instant, Medium, High, Extra High, Pro (runs as Extra High).
      { contextWindow: 41_000, effectiveContextWindowPercent: 78, autoCompactTokenLimit: 27_183 },
      { contextWindow: 90_000, effectiveContextWindowPercent: 89, autoCompactTokenLimit: 68_085 },
      { contextWindow: 90_000, effectiveContextWindowPercent: 89, autoCompactTokenLimit: 68_085 },
      { contextWindow: 90_000, effectiveContextWindowPercent: 89, autoCompactTokenLimit: 68_085 },
      { contextWindow: 90_000, effectiveContextWindowPercent: 89, autoCompactTokenLimit: 68_085 },
    ]);
  });

  test("publishes Luna and Think routes when the account exposes no Sol selector", () => {
    const config = defaultConfig("full");
    config.solAvailable = false;
    const models = augmentNativeModelCatalog(source(), config).models as Array<Record<string, unknown>>;
    const web = models.filter(model => String(model.slug).startsWith("chatgpt-web/"));
    expect(web).toHaveLength(3);
    expect(web.filter(model => model.visibility === "list").map(model => model.slug)).toEqual(CHATGPT_WEB_LUNA_MODEL_ROUTES.map(route => route.slug));
    expect(web.filter(model => model.visibility === "hide").map(model => model.slug)).toEqual(["chatgpt-web/luna", "chatgpt-web/think"]);
    expect(web[0]).toMatchObject({
      slug: CHATGPT_WEB_LUNA_MODEL_ROUTE.slug,
      display_name: CHATGPT_WEB_LUNA_MODEL_ROUTE.displayName,
      default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low", description: "Ordinary Luna" }, { effort: "medium", description: "Think" }],
      context_window: 1_050_000,
      effective_context_window_percent: 100,
      auto_compact_token_limit: 1_050_000,
    });
  });

  test("Zero Risk publishes exactly one generic model without capability inference", () => {
    const config = defaultConfig("full");
    config.browserInteractionMode = "manual";
    config.solAvailable = false;
    config.proAvailable = false;
    const models = augmentNativeModelCatalog(source(), config).models as Array<Record<string, unknown>>;
    const web = models.filter(model => String(model.slug).startsWith("chatgpt-web/"));

    expect(web).toHaveLength(1);
    expect(web[0]).toMatchObject({
      slug: CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE.slug,
      display_name: CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE.displayName,
      description: CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE.description,
      input_modalities: ["text"],
      default_reasoning_level: "low",
      supported_reasoning_levels: [{ effort: "low", description: CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE.displayName }],
      context_window: CHATGPT_WEB_ZERO_RISK_CONTEXT_WINDOW,
      max_context_window: CHATGPT_WEB_ZERO_RISK_CONTEXT_WINDOW,
      effective_context_window_percent: 78,
      auto_compact_token_limit: 81_549,
    });

    config.zeroRiskProEnabled = true;
    const proModels = augmentNativeModelCatalog(source(), config).models as Array<Record<string, unknown>>;
    const proWeb = proModels.filter(model => String(model.slug).startsWith("chatgpt-web/"));
    expect(proWeb).toHaveLength(2);
    expect(proWeb[1]).toMatchObject({
      slug: CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE.slug,
      display_name: CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE.displayName,
      input_modalities: ["text"],
      context_window: 336_579,
      auto_compact_token_limit: 243_178,
    });
  });

  test("raises only native maximum windows for an explicit Codex context override", () => {
    const native = source();
    const nativeSnapshot = structuredClone(native);
    const config = defaultConfig("full");
    config.subagentProtocol = "native";
    const result = augmentNativeModelCatalog(native, config, {
      contextWindow: 371_851,
    });
    const models = result.models as Array<Record<string, unknown>>;
    const originalModels = nativeSnapshot.models as Array<Record<string, unknown>>;

    expect(native).toEqual(nativeSnapshot);
    expect(models.slice(0, 3)).toEqual([
      { ...originalModels[0], max_context_window: 371_851 },
      { ...originalModels[1], max_context_window: 371_851 },
      { ...originalModels[2], max_context_window: 371_851 },
    ]);
    expect(models[1]!.context_window).toBe(300_000);
    expect(models[1]!.auto_compact_token_limit).toBe(270_000);
    for (const [index, model] of models.slice(3).entries()) {
      const requested = availableChatGptWebModelRoutes(config, true)[index]!;
      const route = requested.interactionMode === "automatic" && requested.legacy
        ? servedChatGptWebModelRoute(requested, config) : requested;
      const limits = resolveChatGptWebContextLimits(
        route.backendModel,
        route.adapterEffort,
        config,
        route.interactionMode === "automatic" ? route.modelFamily : undefined,
      );
      expect(model.context_window).toBe(limits.contextWindow);
      expect(model.max_context_window).toBe(limits.contextWindow);
      expect(model.effective_context_window_percent).toBe(limits.effectiveContextWindowPercent);
      expect(model.auto_compact_token_limit).toBe(limits.autoCompactTokenLimit);
    }
  });

  test("never lowers a native window that already exceeds the Codex context override", () => {
    const native = source();
    const models = native.models as Array<Record<string, unknown>>;
    models[1]!.max_context_window = 1_000_000;
    const result = augmentNativeModelCatalog(native, defaultConfig("full"), {
      contextWindow: 371_851,
    });

    const overridden = (result.models as Array<Record<string, unknown>>)[1]!;
    expect(overridden.context_window).toBe(300_000);
    expect(overridden.max_context_window).toBe(1_000_000);
    expect(overridden.auto_compact_token_limit).toBe(270_000);
  });

  test("uses an available compatible official model when an account exposes a smaller catalog", () => {
    const native = source();
    const models = native.models as Array<Record<string, unknown>>;
    models.splice(1, 1);
    Object.assign(models[1]!, {
      visibility: "list",
      supported_in_api: true,
      tool_mode: "code_mode_only",
      supported_reasoning_levels: [{ effort: "high", description: "High" }],
      shell_type: "shell_command",
    });

    const result = augmentNativeModelCatalog(native, defaultConfig("full"));
    const web = (result.models as Array<Record<string, unknown>>)
      .filter(model => String(model.slug).startsWith("chatgpt-web/"));
    expect(web.length).toBe(CHATGPT_WEB_MODEL_ROUTES.length + CHATGPT_WEB_LEGACY_MODEL_ROUTES.length);
    expect(web.every(model => model.shell_type === "shell_command")).toBe(true);
    expect(web.every(model => model.tool_mode === null)).toBe(true);
  });

  test("uses a ChatGPT-visible template even when it is not available to API-key auth", () => {
    const native = source();
    const models = native.models as Array<Record<string, unknown>>;
    for (const model of models) model.supported_in_api = false;

    const config = defaultConfig("browser-only");
    config.subagentProtocol = "native";
    const result = augmentNativeModelCatalog(native, config);
    const web = (result.models as Array<Record<string, unknown>>)
      .filter(model => String(model.slug).startsWith("chatgpt-web/"));

    expect(web).toHaveLength(CHATGPT_WEB_MODEL_ROUTES.length + CHATGPT_WEB_LEGACY_MODEL_ROUTES.length);
    expect(web.every(model => model.supported_in_api === true)).toBe(true);
    expect((result.models as Array<Record<string, unknown>>).slice(0, models.length))
      .toEqual(models);
  });

  test("follows official catalog order instead of preferring a named paid-tier model", () => {
    const native = source();
    const sourceModels = native.models as Array<Record<string, unknown>>;
    const sol = sourceModels[1]!;
    const terra = {
      ...structuredClone(sol),
      slug: "gpt-5.6-terra",
      display_name: "5.6 Terra",
      shell_type: "terra-shell",
    };
    native.models = [sourceModels[0], terra, sol];

    const result = augmentNativeModelCatalog(native, defaultConfig("full"));
    const web = (result.models as Array<Record<string, unknown>>)
      .filter(model => String(model.slug).startsWith("chatgpt-web/"));
    expect(web.every(model => model.shell_type === "terra-shell")).toBe(true);
  });

  test("fails closed when no official model satisfies the harness contract", () => {
    expect(() => augmentNativeModelCatalog({
      models: [{
        slug: "other",
        visibility: "list",
        supported_in_api: true,
        supported_reasoning_levels: [],
        tool_mode: null,
      }],
    }, defaultConfig("full"))).toThrow("no list-visible, tool-capable model");
  });
});
