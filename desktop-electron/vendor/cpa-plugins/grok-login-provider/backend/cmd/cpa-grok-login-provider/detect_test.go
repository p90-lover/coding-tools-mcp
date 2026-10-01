package main

import (
	"encoding/json"
	"testing"
)

func classifyRaw(t *testing.T, raw string) importFormat {
	t.Helper()
	var doc map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		t.Fatalf("fixture is not a JSON object: %v", err)
	}
	return classifyImport(doc)
}

func TestClassifyImportRecognizesGrokLayouts(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want importFormat
	}{
		{"own storage", `{"type":"grok","grok_upstream":"web","sso_token":"x"}`, formatGrokStorage},
		{"grok build auth.json", `{"https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828":{"key":"eyJ.a.b","refresh_token":"r","auth_mode":"oidc"}}`, formatGrokBuildCLI},
		{"grok2api build batch", `{"accounts":[{"provider":"grok_build","refresh_token":"r1"}]}`, formatGrok2APIBuild},
		{"grok2api build single", `{"provider":"grok_build","access_token":"a","refresh_token":"r"}`, formatGrok2APIBuild},
		{"grok2api web", `{"provider":"grok_web","accounts":[{"sso_token":"s","tier":"super"}]}`, formatGrok2APIWeb},
		{"grok2api console", `{"provider":"grok_console","accounts":[{"sso_token":"s"}]}`, formatGrok2APIConsole},
		{"legacy token.json", `{"ssoNormal":{"tok1":{"status":"active"}},"ssoSuper":{}}`, formatLegacyTokenJSON},
		{"legacy token.json old key", `{"sso":{"tok1":{}}}`, formatLegacyTokenJSON},
		{"bare sso cookie", `{"sso":"eyJhbGciOiJIUzI1NiJ9.e30.sig"}`, formatSSOCookie},
		{"bare sso_token", `{"sso_token":"eyJhbGciOiJIUzI1NiJ9.e30.sig"}`, formatSSOCookie},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyRaw(t, tc.raw); got != tc.want {
				t.Fatalf("classifyImport = %s, want %s", got, tc.want)
			}
		})
	}
}

// Claiming a file hides it from every other CPA plugin, so look-alikes must stay unknown.
func TestClassifyImportLeavesOtherProvidersAlone(t *testing.T) {
	cases := []struct{ name, raw string }{
		{"generic oauth tokens", `{"access_token":"a","refresh_token":"r","email":"x@y.z"}`},
		{"other provider batch", `{"accounts":[{"provider":"commandcode","api_key":"k"}]}`},
		{"accounts without provider or tokens", `{"accounts":[{"name":"n"}]}`},
		{"other provider tag", `{"provider":"kimi","access_token":"a"}`},
		{"sso that is an object, not a cookie", `{"sso":{"enabled":true}}`},
		{"auth.json of another issuer", `{"https://login.example.com::abc":{"key":"k","auth_mode":"oidc"}}`},
		{"empty object", `{}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := classifyRaw(t, tc.raw); got != formatUnknown {
				t.Fatalf("classifyImport = %s, want unknown", got)
			}
		})
	}
}

func TestDetectedAccountsExpandsLegacyPoolsWithTiers(t *testing.T) {
	rt := testRuntime(t)
	accounts, format, err := detectedAccounts(rt, []byte(`{"ssoNormal":{"sso=tokA; sso-rw=tokA":{}},"ssoSuper":{"tokB":{}}}`))
	if err != nil || format != formatLegacyTokenJSON {
		t.Fatalf("format=%s err=%v", format, err)
	}
	if len(accounts) != 2 {
		t.Fatalf("got %d accounts, want 2", len(accounts))
	}
	if accounts[0].SSOToken != "tokB" || accounts[0].WebTier != "super" {
		t.Fatalf("first account = %+v, want super tokB", accounts[0])
	}
	if accounts[1].SSOToken != "tokA" || accounts[1].WebTier != "basic" {
		t.Fatalf("second account = %+v, want basic tokA (cookie prefix stripped)", accounts[1])
	}
}

func TestDetectedAccountsReadsGrokBuildCLIFile(t *testing.T) {
	rt := testRuntime(t)
	raw := `{"https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828":{"key":"access","refresh_token":"refresh","auth_mode":"oidc","email":"dev@example.com","expires_at":1893456000},
	         "xai::api_key":{"key":"xai-key","auth_mode":"api_key"}}`
	accounts, format, err := detectedAccounts(rt, []byte(raw))
	if err != nil || format != formatGrokBuildCLI {
		t.Fatalf("format=%s err=%v", format, err)
	}
	if len(accounts) != 1 {
		t.Fatalf("got %d accounts, want only the OIDC session", len(accounts))
	}
	got := accounts[0]
	if got.Upstream != upstreamBuild || got.AccessToken != "access" || got.RefreshToken != "refresh" || got.Email != "dev@example.com" {
		t.Fatalf("account = %+v", got)
	}
	if got.ExpiresAt != "2030-01-01T00:00:00Z" {
		t.Fatalf("expires_at = %q, want Unix seconds normalized", got.ExpiresAt)
	}
}

func TestDetectedAccountsUsesGrok2APIParsers(t *testing.T) {
	rt := testRuntime(t)
	accounts, format, err := detectedAccounts(rt, []byte(`{"provider":"grok_web","accounts":[{"name":"main","sso_token":"sso=abc;x","tier":"heavy"},{"token":"def"}]}`))
	if err != nil || format != formatGrok2APIWeb {
		t.Fatalf("format=%s err=%v", format, err)
	}
	if len(accounts) != 2 || accounts[0].SSOToken != "abc" || accounts[0].WebTier != "heavy" || accounts[0].Label != "main" {
		t.Fatalf("accounts = %+v", accounts)
	}
	if accounts[1].SSOToken != "def" || accounts[1].WebTier != "auto" {
		t.Fatalf("second account = %+v", accounts[1])
	}
}

func TestBareSSOCookieImportCreatesWebAndConsoleOffline(t *testing.T) {
	rt := testRuntime(t)
	accounts, format, err := detectedAccounts(rt, []byte(`{"sso":"sso=eyJ0eXAiOiJKV1QifQ.eyJzdWIiOiIxIn0.c2ln; sso-rw=eyJ0eXAiOiJKV1QifQ.eyJzdWIiOiIxIn0.c2ln"}`))
	if err != nil || format != formatSSOCookie {
		t.Fatalf("format=%s err=%v", format, err)
	}
	if len(accounts) != 2 || accounts[0].Upstream != upstreamWeb || accounts[1].Upstream != upstreamConsole {
		t.Fatalf("accounts = %+v, want web + console (build conversion needs the network)", accounts)
	}
	for _, account := range accounts {
		if account.SSOToken != "eyJ0eXAiOiJKV1QifQ.eyJzdWIiOiIxIn0.c2ln" {
			t.Fatalf("sso token = %q", account.SSOToken)
		}
	}
}
