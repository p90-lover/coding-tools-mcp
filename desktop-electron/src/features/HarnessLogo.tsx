import type { ReactElement } from "react";
import agyLogo from "../assets/harness/ao/agy.png";
import aiderLogo from "../assets/harness/ao/aider.png";
import auggieLogo from "../assets/harness/ao/auggie.svg";
import autohandLogo from "../assets/harness/ao/autohand.svg";
import codexLogo from "../assets/harness/ao/codex.svg";
import continueLogo from "../assets/harness/ao/continue.png";
import copilotLogo from "../assets/harness/ao/copilot.svg";
import crushLogo from "../assets/harness/ao/crush.png";
import deepseekHarnessLogo from "../assets/harness/ao/deepseek-harness.svg";
import devinLogo from "../assets/harness/ao/devin.png";
import droidLogo from "../assets/harness/ao/droid.png";
import fxLogo from "../assets/harness/ao/fx.svg";
import gooseLogo from "../assets/harness/ao/goose.svg";
import kimchiLogo from "../assets/harness/ao/kimchi.svg";
import kiroLogo from "../assets/harness/ao/kiro.png";
import mimoCodeLogo from "../assets/harness/ao/mimo-code.svg";
import ompLogo from "../assets/harness/ao/omp.png";
import primeAgentLogo from "../assets/harness/ao/prime-agent.png";
import unrealAgentLogo from "../assets/harness/ao/unreal-agent.png";
import vibeLogo from "../assets/harness/ao/vibe.png";
import ampLogo from "../assets/harness/brand/amp.svg";
import claudeCodeLogo from "../assets/harness/brand/claude-code.png";
import clineLogo from "../assets/harness/brand/cline.svg";
import cursorLogo from "../assets/harness/brand/cursor.svg";
import geminiCliLogo from "../assets/harness/brand/gemini-cli.svg";
import grokBuildLogo from "../assets/harness/brand/grok-build.png";
import kilocodeLogo from "../assets/harness/brand/kilocode.svg";
import opencodeLogo from "../assets/harness/brand/opencode.png";
import piLogo from "../assets/harness/brand/pi.svg";
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

// The mark beside each harness is the icon that product's own site or repository shows for it.
// - brand/: copied byte for byte from the product (Claude Code's docs, cursor.com, kilo.ai,
//   cline.bot, opencode.ai, ampcode.com, pi.dev, Grok Build's README), or LobeHub's copy of
//   Gemini CLI's mark. SOURCES.md lists each file's URL and SHA-256.
// - ao/: Agent Orchestrator's own AgentAvatar files (unmodified), kept only where they are the
//   product's own icon. Unreal Agent is AO's own harness.
// - Kimi Code, Qwen Code and Muse Code (Meta's) share their maker's mark with the model lists.
// AO's copies were wrong for these, and the user saw them: Claude Code showed the pixel mascot,
// Qwen Code showed Alibaba Cloud, Kimi showed Moonshot's ball, Grok Build showed a stray "xI",
// Gemini CLI showed the Gemini model's sparkle, Amp showed its retired chevrons, and opencode,
// Cline, Cursor and Kilo Code showed faded grey outlines.
// An agent with no known mark gets a lettered badge.

type Mark = (size: number) => ReactElement;

/** `mono` turns a black glyph white in dark mode; `backed` keeps mixed black/colour marks readable. */
function image(src: string, mono = false, backed = false): Mark {
  return (size) => <img src={src} width={size} height={size} alt="" draggable={false}
    className={`ao-harness-mark${mono ? " is-mono" : ""}${backed ? " is-backed" : ""}`} />;
}
const openaiMark = image(openaiLogo, true);
const gemini = image(geminiLogo);

// Harness id (without "ao:") → its mark, keyed as AO's AgentAvatar keys them. Cline's robot and
// Grok Build's SpaceXAI symbol are black glyphs (mono); Kimi's black K keeps a light backing.
const MARKS: Record<string, Mark> = {
  "claude-code": image(claudeCodeLogo), codex: image(codexLogo), agy: image(agyLogo), opencode: image(opencodeLogo),
  "opencode-v2": image(opencodeLogo), aider: image(aiderLogo), amp: image(ampLogo), auggie: image(auggieLogo),
  autohand: image(autohandLogo), cline: image(clineLogo, true), continue: image(continueLogo), copilot: image(copilotLogo),
  crush: image(crushLogo), cursor: image(cursorLogo), "deepseek-harness": image(deepseekHarnessLogo), devin: image(devinLogo),
  droid: image(droidLogo), fx: image(fxLogo, false, true), gemini: image(geminiCliLogo), goose: image(gooseLogo),
  grok: image(grokBuildLogo, true), kilocode: image(kilocodeLogo), kimchi: image(kimchiLogo, false, true),
  kimi: image(kimiLogo, false, true), kiro: image(kiroLogo), "mimo-code": image(mimoCodeLogo, true), muse: image(metaLogo),
  omp: image(ompLogo), pi: image(piLogo), "prime-agent": image(primeAgentLogo, true), qwen: image(qwenLogo),
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
const known = (name: string) => MARKS[ALIASES[name] ?? name];

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
 * A model-list group's mark: the agent's, as the harness list shows it (Antigravity, Claude Code, Native Codex),
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
