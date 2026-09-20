import { describe, expect, test } from "bun:test";
import { chatGptConversationKey } from "../src/adapters/chatgpt-web/conversation-key";
import {
  availableChatGptWebModelRoutes,
  CHATGPT_WEB_BACKEND_MODEL,
  CHATGPT_WEB_GPT55_BACKEND_MODEL,
  CHATGPT_WEB_GPT55_MODEL_ROUTE,
  CHATGPT_WEB_LATEST_MODEL_ROUTE,
  CHATGPT_WEB_LUNA_BACKEND_MODEL,
  CHATGPT_WEB_LUNA_MODEL_ROUTE,
  CHATGPT_WEB_LUNA_MODEL_ROUTES,
  CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE,
  CHATGPT_WEB_LEGACY_EFFORT_ROUTES,
  CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL,
  CHATGPT_WEB_ZERO_RISK_CONTEXT_WINDOW,
  CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE,
  CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL,
  CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE,
  CHATGPT_WEB_MODEL_ROUTES,
  CHATGPT_WEB_PICKER_REASONING_LEVELS,
  CHATGPT_WEB_SOL_MODEL_ROUTE,
  chatgptWebPickerDefaultEffort,
  chatgptWebPickerReasoningLevelsForRoute,
  requireChatGptWebModelRoute,
  resolveChatGptWebContextLimits,
  resolveChatGptWebTransportLimits,
} from "../src/chatgpt-web-models";
import { defaultConfig } from "../src/config";
import { parseRequest } from "../src/responses/parser";
import { routeChatGptWebRequest } from "../src/server";
import type { CodexParsedRequest } from "../src/types";

function parsed(modelId: string, reasoning = "medium"): CodexParsedRequest {
  return {
    modelId,
    context: { messages: [] },
    stream: false,
    options: { reasoning },
    _rawBody: { model: modelId, reasoning: { effort: reasoning } },
  };
}

describe("fixed ChatGPT Web model routes", () => {
  const plus = { solAvailable: true, proAvailable: false };
  const pro = { solAvailable: true, proAvailable: true };

  test("exposes pinned Web Latest / Sol / 5.5 rows with effort on the bar", () => {
    expect(new Set(CHATGPT_WEB_MODEL_ROUTES.map(route => route.slug)).size).toBe(CHATGPT_WEB_MODEL_ROUTES.length);
    expect(CHATGPT_WEB_MODEL_ROUTES.map(route => [route.slug, route.displayName, route.webPin])).toEqual([
      ["chatgpt-web/latest", "Web Latest", "latest"],
      ["chatgpt-web/sol", "Web GPT-5.6 Sol", "sol"],
      ["chatgpt-web/gpt-5.5", "Web GPT-5.5", "gpt-5.5"],
    ]);
    expect(CHATGPT_WEB_MODEL_ROUTES.every(route => !/\b(Instant|Deep|Extra|Pro)\b/.test(route.displayName))).toBe(true);
    expect(CHATGPT_WEB_PICKER_REASONING_LEVELS.map(level => [level.effort, level.description])).toEqual([
      ["low", "Instant"],
      ["medium", "Medium"],
      ["high", "High"],
      ["xhigh", "Extra High"],
      ["pro", "Pro"],
    ]);
    expect(CHATGPT_WEB_PICKER_REASONING_LEVELS.some(level => level.effort === "max")).toBe(false);
    expect(chatgptWebPickerDefaultEffort(CHATGPT_WEB_LATEST_MODEL_ROUTE)).toBe("high");
    expect(chatgptWebPickerDefaultEffort(CHATGPT_WEB_SOL_MODEL_ROUTE)).toBe("medium");
    expect(chatgptWebPickerReasoningLevelsForRoute(CHATGPT_WEB_LATEST_MODEL_ROUTE, pro).map(level => level.effort))
      .toEqual(["low", "medium", "high", "xhigh", "pro"]);
    expect(chatgptWebPickerReasoningLevelsForRoute(CHATGPT_WEB_SOL_MODEL_ROUTE, pro).map(level => level.effort))
      .toEqual(["low", "medium", "high", "xhigh"]);
    expect(chatgptWebPickerReasoningLevelsForRoute(CHATGPT_WEB_GPT55_MODEL_ROUTE, pro).map(level => level.effort))
      .toEqual(["low", "medium", "high"]);
    expect(CHATGPT_WEB_LEGACY_EFFORT_ROUTES.map(route => route.slug)).toEqual([
      "chatgpt-web/light",
      "chatgpt-web/medium",
      "chatgpt-web/high",
      "chatgpt-web/extra-high",
      "chatgpt-web/pro",
    ]);
  });

  test("lists pinned rows for Sol accounts and keeps legacy effort slugs request-enabled", () => {
    expect(availableChatGptWebModelRoutes(plus).map(route => route.slug)).toEqual([
      "chatgpt-web/latest",
      "chatgpt-web/sol",
      "chatgpt-web/gpt-5.5",
    ]);
    expect(availableChatGptWebModelRoutes({ solAvailable: true, proAvailable: true }).map(route => route.slug))
      .toEqual(["chatgpt-web/latest", "chatgpt-web/sol", "chatgpt-web/gpt-5.5"]);
    expect(requireChatGptWebModelRoute("chatgpt-web/gpt-5.6-sol", plus)).toBe(CHATGPT_WEB_SOL_MODEL_ROUTE);
    expect(requireChatGptWebModelRoute("chatgpt-web/5.5", plus)).toBe(CHATGPT_WEB_GPT55_MODEL_ROUTE);
    expect(requireChatGptWebModelRoute("chatgpt-web/light", plus).adapterEffort).toBe("low");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/extra-high", plus))
      .toThrow("Web Latest is not available for this account");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/pro", plus))
      .toThrow("Web Latest is not available for this account");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/gpt-5.5", { ...plus, gpt55Available: false }))
      .toThrow("did not expose a GPT-5.5 model chip");
  });

  test("exposes Luna and Think when the authenticated account has no Sol selector", () => {
    const free = { solAvailable: false, proAvailable: false };
    expect(availableChatGptWebModelRoutes(free)).toEqual(CHATGPT_WEB_LUNA_MODEL_ROUTES);
    expect(requireChatGptWebModelRoute("chatgpt-web/luna", free).backendModel)
      .toBe(CHATGPT_WEB_LUNA_BACKEND_MODEL);
    expect(requireChatGptWebModelRoute("chatgpt-web/think", free))
      .toBe(CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE);
    expect(() => requireChatGptWebModelRoute("chatgpt-web/light", free))
      .toThrow("Luna-only account");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/luna", {
      solAvailable: true,
      proAvailable: false,
    })).toThrow("only available for Luna-only accounts");
  });

  test("Zero Risk exposes one generic route independent of account capabilities", () => {
    const manual = {
      solAvailable: false,
      proAvailable: false,
      browserInteractionMode: "manual" as const,
    };
    expect(availableChatGptWebModelRoutes(manual)).toEqual([CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE]);
    expect(requireChatGptWebModelRoute("chatgpt-web/zero-risk", manual))
      .toBe(CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE);
    expect(() => requireChatGptWebModelRoute("chatgpt-web/zero-risk-pro", manual))
      .toThrow("not enabled in Zero Risk model settings");
    const manualPro = { ...manual, zeroRiskProEnabled: true };
    expect(availableChatGptWebModelRoutes(manualPro)).toEqual([
      CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE,
      CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE,
    ]);
    expect(requireChatGptWebModelRoute("chatgpt-web/zero-risk-pro", manualPro))
      .toBe(CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE);
    expect(() => requireChatGptWebModelRoute("chatgpt-web/luna", manual))
      .toThrow("not available while Zero Risk is enabled");
    expect(() => requireChatGptWebModelRoute("chatgpt-web/zero-risk", plus))
      .toThrow("only available while Zero Risk is enabled");
  });

  test("Zero Risk always publishes its fixed three-turn compaction interval and rejects multipart Bigger Context", () => {
    const manual = {
      solAvailable: true,
      proAvailable: true,
      browserInteractionMode: "manual" as const,
    };
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, "low", manual)).toEqual({
      contextWindow: 123_000,
      effectiveContextWindowPercent: 78,
      autoCompactTokenLimit: 96_000,
    });
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL, "low", manual)).toEqual({});
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL, "low", manual)).toEqual({
      contextWindow: 336_579,
      effectiveContextWindowPercent: 85,
      autoCompactTokenLimit: 285_000,
    });
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL, "low", manual)).toEqual({});
    expect(() => availableChatGptWebModelRoutes({
      ...manual,
      experimentalBiggerContext: true,
    })).toThrow("does not support Bigger Context");
  });

  test("publishes measured Plus browser windows and compacts before the transport ceiling", () => {
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "low", plus)).toEqual({
      contextWindow: 41_000,
      effectiveContextWindowPercent: 78,
      autoCompactTokenLimit: 32_000,
    });
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "medium", plus)).toEqual({
      contextWindow: 90_000,
      effectiveContextWindowPercent: 89,
      autoCompactTokenLimit: 80_000,
    });
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "high", plus)).toEqual({
      contextWindow: 90_000,
      effectiveContextWindowPercent: 89,
      autoCompactTokenLimit: 80_000,
    });
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "low", plus)).toEqual({
      browserComposerCharLimit: 211_256,
    });
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "medium", plus)).toEqual({
      browserComposerCharLimit: 1_048_572,
    });
    expect(() => resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "xhigh", plus))
      .toThrow("unavailable effort");
  });

  test("publishes the usable Pro browser window instead of the unreachable underlying model window", () => {
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "low", pro)).toEqual({
      contextWindow: 111_193,
      effectiveContextWindowPercent: 85,
      autoCompactTokenLimit: 95_000,
    });
    for (const effort of ["medium", "high", "xhigh"] as const) {
      expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, effort, pro)).toEqual({
        contextWindow: 111_193,
        effectiveContextWindowPercent: 85,
        autoCompactTokenLimit: 95_000,
      });
    }
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "max", pro)).toEqual({
      contextWindow: 112_193,
      effectiveContextWindowPercent: 85,
      autoCompactTokenLimit: 95_000,
    });
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "low", pro)).toEqual({
      browserMessageTokenLimit: 103_000,
      browserComposerCharLimit: 545_000,
    });
    for (const effort of ["medium", "high", "xhigh"] as const) {
      expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, effort, pro)).toEqual({
        browserMessageTokenLimit: 103_000,
        browserComposerCharLimit: 1_045_000,
      });
    }
    expect(resolveChatGptWebTransportLimits(CHATGPT_WEB_BACKEND_MODEL, "max", pro)).toEqual({
      browserMessageTokenLimit: 104_000,
      browserComposerCharLimit: 1_635_000,
    });
  });

  test("publishes Luna's real model window without early native compaction", () => {
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_LUNA_BACKEND_MODEL, "low", {
      solAvailable: false,
      proAvailable: false,
    })).toEqual({
      contextWindow: 1_050_000,
      effectiveContextWindowPercent: 100,
      autoCompactTokenLimit: 1_050_000,
    });
  });

  test("triples Sol context and compaction limits only when Bigger Context is enabled", () => {
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_BACKEND_MODEL, "max", {
      ...pro,
      experimentalBiggerContext: true,
    })).toEqual({
      contextWindow: 336_579,
      effectiveContextWindowPercent: 85,
      autoCompactTokenLimit: 285_000,
    });
    expect(resolveChatGptWebContextLimits(CHATGPT_WEB_LUNA_BACKEND_MODEL, "low", {
      solAvailable: false,
      proAvailable: false,
      experimentalBiggerContext: true,
    })).toEqual({
      contextWindow: 1_050_000,
      effectiveContextWindowPercent: 100,
      autoCompactTokenLimit: 1_050_000,
    });
  });

  test("binds the selected model authoritatively and ignores a conflicting request effort", () => {
    const request = parsed("chatgpt-web/high", "low");
    const rawSnapshot = structuredClone(request._rawBody);
    const route = routeChatGptWebRequest(request, defaultConfig("browser-only"));

    expect(route.slug).toBe("chatgpt-web/high");
    expect(request.modelId).toBe(CHATGPT_WEB_BACKEND_MODEL);
    expect(request.options.reasoning).toBe("high");
    expect(request._rawBody).toEqual(rawSnapshot);
  });

  test("binds the Pro model to the browser Pro effort and fails closed for unknown routes", () => {
    const config = defaultConfig("full");
    config.proAvailable = true;
    const request = parsed("chatgpt-web/pro", "low");
    expect(routeChatGptWebRequest(request, config).adapterEffort).toBe("max");
    expect(request.options.reasoning).toBe("max");
    expect(() => routeChatGptWebRequest(parsed("chatgpt-web/not-enabled"), config))
      .toThrow("model is not enabled");
  });

  test("keeps Pro compaction on the same retained Pro conversation", () => {
    const config = defaultConfig("full");
    config.proAvailable = true;
    const normal = parsed("chatgpt-web/pro", "low");
    const compact = parsed("chatgpt-web/pro", "low");
    const metadata = {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_pro_compaction" }),
    };
    normal._rawBody = {
      model: "chatgpt-web/pro",
      reasoning: { effort: "low" },
      client_metadata: metadata,
    };
    compact._rawBody = structuredClone(normal._rawBody);
    compact._compactionRequest = true;

    expect(routeChatGptWebRequest(normal, config).slug).toBe("chatgpt-web/pro");
    expect(normal.options.reasoning).toBe("max");
    expect(routeChatGptWebRequest(compact, config).slug).toBe("chatgpt-web/pro");
    expect(compact.options.reasoning).toBe("max");
    expect(chatGptConversationKey(compact, "provider"))
      .toBe(chatGptConversationKey(normal, "provider"));
  });

  test("keeps Latest and Sol pins on distinct retained conversations at the same effort", () => {
    const config = defaultConfig("full");
    const metadata = {
      "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread_pin_isolation" }),
    };
    const latest = parsed("chatgpt-web/latest", "high");
    const sol = parsed("chatgpt-web/sol", "high");
    latest._rawBody = { model: "chatgpt-web/latest", reasoning: { effort: "high" }, client_metadata: metadata };
    sol._rawBody = { model: "chatgpt-web/sol", reasoning: { effort: "high" }, client_metadata: metadata };
    routeChatGptWebRequest(latest, config);
    routeChatGptWebRequest(sol, config);
    expect(latest._webPin).toBe("latest");
    expect(sol._webPin).toBe("sol");
    expect(chatGptConversationKey(latest, "provider"))
      .not.toBe(chatGptConversationKey(sol, "provider"));
  });

  test("binds the Luna route to Luna without a selectable effort", () => {
    const config = defaultConfig("browser-only");
    config.solAvailable = false;
    const request = parsed("chatgpt-web/luna", "high");
    const route = routeChatGptWebRequest(request, config);
    expect(route).toBe(CHATGPT_WEB_LUNA_MODEL_ROUTE);
    expect(request.modelId).toBe(CHATGPT_WEB_LUNA_BACKEND_MODEL);
    expect(request.options.reasoning).toBe("low");
  });

  test("binds the Think route to the Luna backend with explicit Think mode", () => {
    const config = defaultConfig("browser-only");
    config.solAvailable = false;
    const request = parsed("chatgpt-web/think", "high");
    const route = routeChatGptWebRequest(request, config);
    expect(route).toBe(CHATGPT_WEB_LUNA_THINK_MODEL_ROUTE);
    expect(request.modelId).toBe(CHATGPT_WEB_LUNA_BACKEND_MODEL);
    expect(request.options.reasoning).toBe("medium");
  });

  test("Zero Risk routing preserves its internal backend identity and only a technical Codex effort", () => {
    const config = defaultConfig("full");
    config.browserInteractionMode = "manual";
    const request = parsed("chatgpt-web/zero-risk", "ultra");
    const route = routeChatGptWebRequest(request, config);

    expect(route).toBe(CHATGPT_WEB_ZERO_RISK_MODEL_ROUTE);
    expect(request.modelId).toBe(CHATGPT_WEB_ZERO_RISK_BACKEND_MODEL);
    expect(request.options.reasoning).toBe("low");

    config.zeroRiskProEnabled = true;
    const proRequest = parsed("chatgpt-web/zero-risk-pro", "ultra");
    const proRoute = routeChatGptWebRequest(proRequest, config);
    expect(proRoute).toBe(CHATGPT_WEB_ZERO_RISK_PRO_MODEL_ROUTE);
    expect(proRequest.modelId).toBe(CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL);
    expect(proRequest.options.reasoning).toBe("low");
  });

  test("pinned Web slugs honor request effort and select the ChatGPT model pin", () => {
    const config = defaultConfig("full");
    config.proAvailable = true;
    const latest = parsed("chatgpt-web/latest", "low");
    expect(routeChatGptWebRequest(latest, config)).toBe(CHATGPT_WEB_LATEST_MODEL_ROUTE);
    expect(latest.modelId).toBe(CHATGPT_WEB_BACKEND_MODEL);
    expect(latest.options.reasoning).toBe("low");
    expect(latest._webPin).toBe("latest");

    const latestPro = parsed("chatgpt-web/latest", "max");
    routeChatGptWebRequest(latestPro, config);
    expect(latestPro.options.reasoning).toBe("max");

    const sol = parsed("chatgpt-web/sol", "high");
    expect(routeChatGptWebRequest(sol, config)).toBe(CHATGPT_WEB_SOL_MODEL_ROUTE);
    expect(sol.modelId).toBe(CHATGPT_WEB_BACKEND_MODEL);
    expect(sol.options.reasoning).toBe("high");
    expect(sol._webPin).toBe("sol");
    expect(() => routeChatGptWebRequest(parsed("chatgpt-web/sol", "max"), config))
      .toThrow("does not support max effort");

    const gpt55 = parsed("chatgpt-web/gpt-5.5", "low");
    expect(routeChatGptWebRequest(gpt55, config)).toBe(CHATGPT_WEB_GPT55_MODEL_ROUTE);
    expect(gpt55.modelId).toBe(CHATGPT_WEB_GPT55_BACKEND_MODEL);
    expect(gpt55.options.reasoning).toBe("low");
    expect(gpt55._webPin).toBe("gpt-5.5");
  });

  test("maps catalog picker effort pro to adapter max like ultra", () => {
    const body = (effort: string) => parseRequest({
      model: "gpt-5.6-sol",
      input: "hi",
      reasoning: { effort },
    });
    expect(body("pro").options.reasoning).toBe("max");
    expect(body("ultra").options.reasoning).toBe("max");
    expect(body("medium").options.reasoning).toBe("medium");
  });
});
