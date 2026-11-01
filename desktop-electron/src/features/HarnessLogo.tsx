import type { ReactElement } from "react";
import aiderLogo from "../assets/harness/aider.png";
import ampLogo from "../assets/harness/amp.svg";
import antigravityLogo from "../assets/harness/antigravity.png";
import augmentLogo from "../assets/harness/augment.png";
import autohandLogo from "../assets/harness/autohand.png";
import charmLogo from "../assets/harness/charm.png";
import claudeCodeLogo from "../assets/harness/claude-code.png";
import clineLogo from "../assets/harness/cline.svg";
import continueLogo from "../assets/harness/continue.png";
import cursorLogo from "../assets/harness/cursor.svg";
import devinLogo from "../assets/harness/devin.svg";
import earendilLogo from "../assets/harness/earendil.png";
import factoryLogo from "../assets/harness/factory.png";
import githubCopilotLogo from "../assets/harness/github-copilot.svg";
import gooseLogo from "../assets/harness/goose.svg";
import kilocodeLogo from "../assets/harness/kilocode.svg";
import kimiLogo from "../assets/harness/kimi.svg";
import kiroLogo from "../assets/harness/kiro.svg";
import metaLogo from "../assets/harness/meta.svg";
import mistralLogo from "../assets/harness/mistral.svg";
import openaiLogo from "../assets/harness/openai.png";
import opencodeLogo from "../assets/harness/opencode.png";
import qwenLogo from "../assets/harness/qwen.svg";
import unrealLogo from "../assets/harness/unreal.svg";
import claudeLogo from "../assets/models/claude.svg";
import deepseekLogo from "../assets/models/deepseek.svg";
import grokLogo from "../assets/models/grok.svg";

// The mark shown beside each harness in the composer, so a harness reads at a glance the way
// Claude Code's own picker does. Claude Code, Codex (Native Codex too), Antigravity (agy) and
// opencode show their own app icons, taken from the installed apps (the hand-drawn marks read as
// the wrong brands: a Gemini sparkle for Antigravity, an approximate knot for OpenAI). The other
// agents show their maker's mark: LobeHub's brand icons (MIT; Mistral for Vibe, Meta for Muse
// Code), Simple Icons' Unreal Engine (CC0), and the makers' GitHub avatars for Aider, Augment
// (Auggie), Autohand, Continue, Charm (Crush), Factory (Droid) and Earendil (Pi). An agent with no
// known mark (OMP, Kimchi, Prime Agent) gets a lettered badge.

type Mark = (size: number) => ReactElement;

/** A brand's own icon; `mono` is a black glyph that turns white on the dark theme. */
function image(src: string, mono = false): Mark {
  return (size) => <img src={src} width={size} height={size} alt="" draggable={false}
    className={mono ? "ao-harness-mark is-mono" : "ao-harness-mark"} />;
}
const claudeCodeMark = image(claudeCodeLogo);
const openaiMark = image(openaiLogo, true);
const antigravityMark = image(antigravityLogo);
const opencodeMark = image(opencodeLogo);

const gemini: Mark = (size) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <defs>
      <linearGradient id="harness-gemini" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#4F8DF5" />
        <stop offset="1" stopColor="#A26BF2" />
      </linearGradient>
    </defs>
    <path fill="url(#harness-gemini)" d="M12 1.5c.6 5.6 4.9 9.9 10.5 10.5-5.6.6-9.9 4.9-10.5 10.5C11.4 16.9 7.1 12.6 1.5 12 7.1 11.4 11.4 7.1 12 1.5Z" />
  </svg>
);

// Harness id (without "ao:") or lower-case name → its mark.
const HARNESS_BRANDS: Record<string, Mark> = {
  aider: image(aiderLogo), amp: image(ampLogo), auggie: image(augmentLogo), autohand: image(autohandLogo),
  cline: image(clineLogo, true), continue: image(continueLogo), crush: image(charmLogo), cursor: image(cursorLogo, true),
  devin: image(devinLogo), droid: image(factoryLogo), goose: image(gooseLogo, true), grok: image(grokLogo, true),
  "grok build": image(grokLogo, true), kilocode: image(kilocodeLogo, true), "kilo code": image(kilocodeLogo, true),
  kimi: image(kimiLogo), kiro: image(kiroLogo), muse: image(metaLogo), "muse code": image(metaLogo), pi: image(earendilLogo),
  qwen: image(qwenLogo), "qwen code": image(qwenLogo), copilot: image(githubCopilotLogo, true),
  "github copilot": image(githubCopilotLogo, true), "unreal-agent": image(unrealLogo, true), "unreal agent": image(unrealLogo, true),
  vibe: image(mistralLogo),
};

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
  const agent = harnessId.replace(/^ao:/, "");
  if (agent === "claude-code") return claudeCodeMark;
  if (agent === "codex" || harnessId === "codex-native") return openaiMark;
  if (agent === "agy" || agent === "antigravity") return antigravityMark;
  if (agent === "opencode") return opencodeMark;
  if (agent === "gemini") return gemini;
  return HARNESS_BRANDS[agent] ?? HARNESS_BRANDS[label.trim().toLowerCase()] ?? badge(label);
}

export function HarnessLogo({ harnessId, label, size = 16 }: { harnessId: string; label: string; size?: number }) {
  return <span className="ao-harness-logo">{harnessMark(harnessId, label)(size)}</span>;
}

// The model lists show the maker's mark for DeepSeek, GPT (WebGPT too), Claude and Grok; any other
// model gets a lettered badge. The marks are LobeHub's brand icons (MIT); Grok's is a black glyph.
const MODEL_BRANDS: [RegExp, Mark][] = [
  [/^deepseek/, image(deepseekLogo)], [/^(?:gpt|o\d|codex|chatgpt)/, openaiMark],
  [/^claude|^(?:opus|sonnet|haiku)\b/, image(claudeLogo)], [/^grok/, image(grokLogo, true)], [/^gemini/, gemini],
];

/** The mark for a model id ("cpa/deepseek-v4.1-flash", "chatgpt-web/high", "claude-opus-4-6"): its maker's, else a lettered badge. */
export function modelMark(model: string, label = model): Mark {
  if (model.startsWith("chatgpt-web/")) return openaiMark;
  const own = (model.split("/").pop() ?? model).toLowerCase();
  return MODEL_BRANDS.find(([pattern]) => pattern.test(own))?.[1] ?? badge(label);
}

export function ModelLogo({ model, label, size = 16 }: { model: string; label?: string; size?: number }) {
  return <span className="ao-harness-logo ao-model-logo">{modelMark(model, label)(size)}</span>;
}
