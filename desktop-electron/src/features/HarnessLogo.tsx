import type { ReactElement } from "react";

// The mark shown beside each harness in the composer, so a harness reads at a glance the way
// Claude Code's own picker does: Claude's starburst for Claude Code, OpenAI's blossom for the
// Codex harnesses, Gemini's sparkle for Antigravity, and a lettered badge for any other agent.

type Mark = (size: number) => ReactElement;

const claude: Mark = (size) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <g stroke="#D97757" strokeWidth="2.2" strokeLinecap="round">
      {Array.from({ length: 12 }, (_, index) => {
        const angle = (index * Math.PI) / 6;
        const inner = index % 2 ? 3.2 : 2.2;
        const outer = index % 2 ? 8.6 : 10.2;
        return <line key={index} x1={12 + inner * Math.cos(angle)} y1={12 + inner * Math.sin(angle)}
          x2={12 + outer * Math.cos(angle)} y2={12 + outer * Math.sin(angle)} />;
      })}
    </g>
  </svg>
);

const openai: Mark = (size) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <g fill="none" stroke="currentColor" strokeWidth="1.7">
      {[0, 60, 120, 180, 240, 300].map((angle) => (
        <ellipse key={angle} cx="12" cy="7.6" rx="3.1" ry="5.2" transform={`rotate(${angle} 12 12)`} />
      ))}
    </g>
  </svg>
);

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
  if (agent === "claude-code") return claude;
  if (agent === "codex" || harnessId === "codex-native") return openai;
  if (agent === "agy" || agent === "gemini" || agent === "antigravity") return gemini;
  if (agent === "cursor") return cursor;
  return badge(label);
}

export function HarnessLogo({ harnessId, label, size = 16 }: { harnessId: string; label: string; size?: number }) {
  return <span className="ao-harness-logo">{harnessMark(harnessId, label)(size)}</span>;
}
