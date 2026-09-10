# OAuth popup repair impact

The current main commit is 07faa97255e6b60d909f956fa2cebd3b829bbf97. The released rc.2 is ac6a7b21df3391277f6687a2a5a6aef0314663b7.
The exact project MCP-probe launcher is absent; offline installation returned ENOTCACHED, and direct Git transport failed DNS. No AI-backed reviewer or indexer was invoked. Direct source tracing was used as the fallback.

Affected production behavior: auth::http_security::guard -> allowed_request_origin -> allowed_origin. Both MCP and Actions listeners use this middleware, so origin validation is security-sensitive. Only GET/POST /oauth/authorize gains the exact ChatGPT-origin exception. Untrusted request Host/Forwarded headers no longer nominate trusted origins; desktop-managed trusted_external_base_url is consulted per request. The same-origin, authentication, capacity and rate-limit paths remain intact. OAuth issuance, consent, PKCE, redirect registration, token validation, command execution, sandbox and vision implementation are unchanged. New test attachments and version/readme wiring do not add a tool or a permission bypass.

Before the fix, actual guard regressions reproduce rc.2 rejecting ChatGPT Origin and main accepting attacker-supplied matching Host/Origin and broadening MCP access. Final checks must cover both problems plus a complete isolated HTTP consent-to-catalog flow. No test contacts a live ChatGPT account or spends Codex quota.

影響：MCP 與 Actions 共用 HTTP 來源檢查，屬安全敏感修改。只對 GET／POST /oauth/authorize 開放明確的 ChatGPT 來源，不以 Host／Forwarded 自行建立信任。保留本機同意、PKCE、Token、工具權限、沙箱及記憶體截圖；本機 HTTP 驗證不代表使用者帳戶已連接。
