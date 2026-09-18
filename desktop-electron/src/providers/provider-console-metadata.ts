export const PROVIDER_CONSOLE_CATEGORIES = [
  "All",
  "OAuth",
  "API",
  "Reverse Proxy",
  "Custom",
] as const;

export const PROVIDER_DISPLAY_OVERRIDES = {
  "codex-oauth": {
    displayName: "Codex OAuth",
    categoryLabel: "OAuth",
  },
  "claude-oauth": {
    displayName: "Claude OAuth",
    categoryLabel: "OAuth",
  },
  "commandcode-proxy": {
    displayName: "CommandCode Proxy",
    categoryLabel: "Reverse Proxy",
  },
  "cliproxyapi-antigravity": {
    displayName: "Gemini Antigravity Reverse Proxy",
    categoryLabel: "Reverse Proxy",
  },
} as const;

export function providerConsoleDisplayName(providerId: string, fallback: string): string {
  return PROVIDER_DISPLAY_OVERRIDES[providerId as keyof typeof PROVIDER_DISPLAY_OVERRIDES]?.displayName
    ?? fallback;
}
