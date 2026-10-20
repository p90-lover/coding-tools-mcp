import type { ReactElement } from "react";
import antigravityLogo from "../assets/harness/antigravity.png";
import claudeCodeLogo from "../assets/harness/claude-code.png";
import openaiLogo from "../assets/harness/openai.png";
import opencodeLogo from "../assets/harness/opencode.png";

// The mark shown beside each harness in the composer, so a harness reads at a glance the way
// Claude Code's own picker does. Claude Code, Codex (Native Codex too), Antigravity (agy) and
// opencode show their own app icons, taken from the installed apps (the hand-drawn marks read as
// the wrong brands: a Gemini sparkle for Antigravity, an approximate knot for OpenAI); any other
// agent gets a lettered badge.

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

const cursor: Mark = (size) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" d="M12 2.5 20.5 7.3v9.4L12 21.5 3.5 16.7V7.3Z M12 2.5v19 M3.5 7.3 20.5 16.7" />
  </svg>
);

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
  if (agent === "cursor") return cursor;
  return badge(label);
}

export function HarnessLogo({ harnessId, label, size = 16 }: { harnessId: string; label: string; size?: number }) {
  return <span className="ao-harness-logo">{harnessMark(harnessId, label)(size)}</span>;
}
