export const DEFAULT_OAUTH_REDIRECT_URIS = [
  "https://chatgpt.com/connector_platform/oauth/callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
];

/** Preserve exact spelling; never infer trusted callbacks from an incoming login. */
export function parseOAuthRedirectUris(text: string): string[] {
  const values = [...new Set(text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
  if (values.length === 0 || values.length > 32) {
    throw new Error("請登記 1 至 32 個完整 OAuth Callback URL，每行一個。");
  }
  for (const value of values) {
    let uri: URL;
    try { uri = new URL(value); } catch { throw new Error("OAuth Callback URL 格式無效。"); }
    const loopback = uri.hostname === "localhost" || uri.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(uri.hostname);
    if (new TextEncoder().encode(value).length > 2048 || /[\s\u0000-\u001f\u007f\\*]/.test(value)
      || uri.username || uri.password || uri.hash
      || (uri.protocol !== "https:" && !(uri.protocol === "http:" && loopback))) {
      throw new Error("Callback 必須使用 HTTPS；已登記的本機 loopback 可用 HTTP。不得含帳密、空白、fragment 或萬用字元。");
    }
  }
  return values;
}
