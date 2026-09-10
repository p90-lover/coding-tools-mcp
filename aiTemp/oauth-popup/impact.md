# OAuth popup repair impact

Base main: 07faa97255e6b60d909f956fa2cebd3b829bbf97. Prior rc.2: ac6a7b21df3391277f6687a2a5a6aef0314663b7.
The exact MCP-probe launcher is absent; offline installation returned ENOTCACHED and direct Git transport failed DNS. No model-backed reviewer or indexer was invoked. Direct callers and source were inspected instead.

Security-sensitive shared origin path: auth::http_security::guard -> allowed_request_origin -> allowed_origin, used by both MCP and Actions. Only GET/POST /oauth/authorize gains the exact ChatGPT-origin exception. Request Host/Forwarded cannot select trust; desktop-managed trusted_external_base_url remains authoritative.

A real Chrome 152 probe showed an additional blocker: a same-origin form POST followed by the cross-origin 303 callback is rejected by form-action self. The bounded CSP fix touches authorize_get -> with_oauth_form_redirect -> secure_response. The complete redirect has already passed the existing OAuth callback policy before its normalized origin is allowed. A private response extension survives the outer security middleware, so untrusted response/request headers cannot select CSP. Token issuance, password, nonce/cookie/state binding, one-use codes, PKCE, refresh tokens and origin admission are not bypassed. Only the validated login response gets the callback form target; scripts, framing and unrelated destinations stay blocked.

No catalog membership, native commands, sandbox backend, screenshots or computer-control changes are included. Tests use actual isolated HTTP handlers and a real browser with intercepted production-response fixtures, not a live user account. Build and validation never invoke Codex inference.

影響：MCP 與 Actions 共用 HTTP 來源檢查，屬安全敏感範圍。只為 OAuth 入口開放精確來源；不信任請求 Host／Forwarded。Chrome 測試亦重現同源表單後的跨源回呼被 CSP 阻擋，故只在已驗證的授權頁面加入回呼來源，並用私有回應標記保留規則。密碼、同意、Nonce／Cookie／State、PKCE、單次授權碼及 Token 驗證不變。其餘工具、沙箱及視覺功能不改動；本機及受攔截瀏覽器測試不代表真實帳戶驗收。
