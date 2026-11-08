import type { ReactElement } from "react";
import agyLogo from "../assets/harness/ao/agy.png";
import aiderLogo from "../assets/harness/ao/aider.png";
import ampLogo from "../assets/harness/ao/amp.svg";
import auggieLogo from "../assets/harness/ao/auggie.svg";
import autohandLogo from "../assets/harness/ao/autohand.svg";
import claudeCodeLogo from "../assets/harness/ao/claude-code.svg";
import clineLogo from "../assets/harness/ao/cline.svg";
import codexLogo from "../assets/harness/ao/codex.svg";
import continueLogo from "../assets/harness/ao/continue.png";
import copilotLogo from "../assets/harness/ao/copilot.svg";
import crushLogo from "../assets/harness/ao/crush.png";
import cursorLogo from "../assets/harness/ao/cursor.svg";
import deepseekHarnessLogo from "../assets/harness/ao/deepseek-harness.svg";
import devinLogo from "../assets/harness/ao/devin.png";
import droidLogo from "../assets/harness/ao/droid.png";
import fxLogo from "../assets/harness/ao/fx.svg";
import geminiCliLogo from "../assets/harness/ao/gemini.svg";
import gooseLogo from "../assets/harness/ao/goose.svg";
import grokCliLogo from "../assets/harness/ao/grok.png";
import kilocodeLogo from "../assets/harness/ao/kilocode.svg";
import kimchiLogo from "../assets/harness/ao/kimchi.svg";
import kimiCliLogo from "../assets/harness/ao/kimi.png";
import kiroLogo from "../assets/harness/ao/kiro.png";
import mimoCodeLogo from "../assets/harness/ao/mimo-code.svg";
import museLogo from "../assets/harness/ao/muse.png";
import ompLogo from "../assets/harness/ao/omp.png";
import opencodeLogo from "../assets/harness/ao/opencode.svg";
import piLogo from "../assets/harness/ao/pi.png";
import primeAgentLogo from "../assets/harness/ao/prime-agent.png";
import qwenCodeLogo from "../assets/harness/ao/qwen.png";
import unrealAgentLogo from "../assets/harness/ao/unreal-agent.png";
import vibeLogo from "../assets/harness/ao/vibe.png";
import geminiLogo from "../assets/harness/gemini.svg";
import kimiLogo from "../assets/harness/kimi.svg";
import metaLogo from "../assets/harness/meta.svg";
import mistralLogo from "../assets/harness/mistral.svg";
import openaiLogo from "../assets/harness/openai.png";
import qwenLogo from "../assets/harness/qwen.svg";
import claudeLogo from "../assets/models/claude.svg";
import deepseekLogo from "../assets/models/deepseek.svg";
import grokLogo from "../assets/models/grok.svg";
import minimaxLogo from "../assets/models/minimax.svg";
import stepfunLogo from "../assets/models/stepfun.svg";
import zhipuLogo from "../assets/models/zhipu.svg";

// The mark beside each harness is the one Agent Orchestrator itself shows for that agent (its
// AgentAvatar logos, copied unmodified into assets/harness/ao from the pinned AO frontend), so a
// harness reads the same here as in AO. Before, the picker mixed sources and showed the wrong
// brands: the Claude app's starburst for Claude Code, OpenAI's knot for Codex, Earendil's GitHub
// avatar for Pi and Unreal Engine's logo for AO's own Unreal Agent. An agent AO has no mark for
// gets a lettered badge, as in AO.

type Mark = (size: number) => ReactElement;

/** `mono` turns a black glyph white in dark mode; `backed` keeps mixed black/colour marks readable. */
function image(src: string, mono = false, backed = false): Mark {
  return (size) => <img src={src} width={size} height={size} alt="" draggable={false}
    className={`ao-harness-mark${mono ? " is-mono" : ""}${backed ? " is-backed" : ""}`} />;
}
const openaiMark = image(openaiLogo, true);
const gemini = image(geminiLogo);

// Harness id (without "ao:") → its mark, keyed as AO's AgentAvatar keys them.
const AO_MARKS: Record<string, Mark> = {
  "claude-code": image(claudeCodeLogo), codex: image(codexLogo), agy: image(agyLogo), opencode: image(opencodeLogo),
  "opencode-v2": image(opencodeLogo), aider: image(aiderLogo), amp: image(ampLogo), auggie: image(auggieLogo),
  autohand: image(autohandLogo), cline: image(clineLogo), continue: image(continueLogo), copilot: image(copilotLogo),
  crush: image(crushLogo), cursor: image(cursorLogo), "deepseek-harness": image(deepseekHarnessLogo), devin: image(devinLogo),
  droid: image(droidLogo), fx: image(fxLogo, false, true), gemini: image(geminiCliLogo), goose: image(gooseLogo),
  grok: image(grokCliLogo, true), kilocode: image(kilocodeLogo), kimchi: image(kimchiLogo, false, true),
  kimi: image(kimiCliLogo, false, true), kiro: image(kiroLogo), "mimo-code": image(mimoCodeLogo, true), muse: image(museLogo),
  omp: image(ompLogo), pi: image(piLogo), "prime-agent": image(primeAgentLogo, true), qwen: image(qwenCodeLogo),
  "unreal-agent": image(unrealAgentLogo), vibe: image(vibeLogo),
};
// Other names a harness goes by: Native Codex and Antigravity's long id, and the display names a
// custom id may carry ("Gemini CLI", "Kilo Code").
const ALIASES: Record<string, string> = {
  "codex-native": "codex", "native codex": "codex", antigravity: "agy", deepseek: "deepseek-harness", "gemini-cli": "gemini",
  "gemini cli": "gemini", "github copilot": "copilot", "grok build": "grok", "kilo code": "kilocode", "muse code": "muse",
  "prime agent": "prime-agent", "qwen code": "qwen", "unreal agent": "unreal-agent", "mistral vibe": "vibe", "mimo code": "mimo-code",
  "claude code": "claude-code", "opencode 2": "opencode-v2",
};
const known = (name: string) => AO_MARKS[ALIASES[name] ?? name];

/** A neutral badge with the harness's initial, for agents without a known mark. */
function badge(label: string): Mark {
  const initial = (label.trim()[0] || "?").toUpperCase();
  return (size) => (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="6" fill="currentColor" opacity="0.14" />
      <text x="12" y="16.2" textAnchor="middle" fontSize="12" fontWeight="700" fill="currentColor">{initial}</text>
    </svg>
  );
}

/** The mark for a harness id ("ao:claude-code", "codex-native", …). */
export function harnessMark(harnessId: string, label: string): Mark {
  const agent = harnessId.trim().replace(/^ao:/i, "").toLowerCase();
  return known(agent) ?? known(label.trim().toLowerCase()) ?? badge(label);
}

export function HarnessLogo({ harnessId, label, size = 16 }: { harnessId: string; label: string; size?: number }) {
  return <span className="ao-harness-logo">{harnessMark(harnessId, label)(size)}</span>;
}

/**
 * A model-list group's mark: the agent's, as AO shows it (Antigravity, Claude Code, Native Codex),
 * else the maker's (OpenAI and WebGPT, Claude, Zhipu); none rather than a lettered badge for a
 * group no brand fits.
 */
export function GroupLogo({ group, size = 12 }: { group: string; size?: number }) {
  const key = group.trim().toLowerCase();
  const mark = ["web gpt", "openai"].includes(key) ? openaiMark
    : known(key) ?? known(key.replace(/\s+/g, "-")) ?? MODEL_BRANDS.find(([pattern]) => pattern.test(key))?.[1];
  return mark ? <span className="ao-harness-logo">{mark(size)}</span> : null;
}

// The model lists show the maker's mark: DeepSeek, GPT (WebGPT too), Claude, Grok, Gemini, GLM
// (Zhipu), Kimi, Qwen, MiniMax, StepFun, Mistral and Llama; any other model gets a lettered badge.
// The marks are LobeHub's brand icons (MIT); Grok's is a black glyph.
const MODEL_BRANDS: [RegExp, Mark][] = [
  [/^deepseek/, image(deepseekLogo)], [/^(?:gpt|o\d|codex|chatgpt)/, openaiMark],
  [/^claude|^(?:opus|sonnet|haiku)\b/, image(claudeLogo)], [/^grok/, image(grokLogo, true)], [/^(?:gemini|gemma)/, gemini],
  [/^(?:glm|chatglm|zhipu|codegeex)/, image(zhipuLogo)], [/^(?:kimi|moonshot)/, image(kimiLogo, false, true)], [/^(?:qwen|qwq)/, image(qwenLogo)],
  [/^(?:minimax|abab)/, image(minimaxLogo)], [/^step/, image(stepfunLogo, true)],
  [/^(?:mistral|codestral|devstral|magistral|ministral|mixtral)/, image(mistralLogo)], [/^llama/, image(metaLogo)],
];

/** The mark for a model id ("cpa/deepseek-v4.1-flash", "chatgpt-web/high", "claude-opus-4-6"): its maker's, else a lettered badge. */
export function modelMark(model: string, label = model): Mark {
  if (model.replace(/^cpa\//, "").startsWith("chatgpt-web/")) return openaiMark;
  const own = (model.split("/").pop() ?? model).toLowerCase();
  return MODEL_BRANDS.find(([pattern]) => pattern.test(own))?.[1] ?? badge(label);
}

export function ModelLogo({ model, label, size = 16 }: { model: string; label?: string; size?: number }) {
  return <span className="ao-harness-logo ao-model-logo">{modelMark(model, label)(size)}</span>;
}
