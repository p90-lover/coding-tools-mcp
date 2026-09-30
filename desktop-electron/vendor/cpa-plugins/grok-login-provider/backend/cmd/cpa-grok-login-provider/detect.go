package main

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/chenyme/grok2api/backend/internal/infra/provider"
)

// importFormat names a Grok credential file layout recognized on CPA auth-file import.
//
// CPA offers a file to every plugin's auth.parse when it has no "type" field, and the first
// plugin that answers Handled owns it. Recognizing a file therefore claims it from every
// other plugin, so classification has to be precise, not merely plausible.
type importFormat int

const (
	formatUnknown importFormat = iota
	// formatGrokStorage is this plugin's own file: {"type":"grok","grok_upstream":...}.
	formatGrokStorage
	// formatGrokBuildCLI is Grok Build's ~/.grok/auth.json:
	// {"https://auth.x.ai::<client_id>": {"key":..., "refresh_token":..., "auth_mode":"oidc"}}.
	formatGrokBuildCLI
	// formatGrok2APIBuild is a grok2api Grok Build export:
	// {"accounts":[{"provider":"grok_build","refresh_token":...}]} or one such entry.
	formatGrok2APIBuild
	// formatGrok2APIWeb is a grok2api Grok Web export:
	// {"provider":"grok_web","accounts":[{"sso_token":...,"tier":"super"}]}.
	formatGrok2APIWeb
	// formatGrok2APIConsole is a grok2api Grok Console export (same shape, "grok_console").
	formatGrok2APIConsole
	// formatLegacyTokenJSON is the pre-v3 grok2api token.json:
	// {"ssoNormal":{"<sso>":{...}},"ssoSuper":{"<sso>":{...}}} (older files: "sso").
	formatLegacyTokenJSON
	// formatSSOCookie is a bare cookie object: {"sso":"eyJ..."} or {"sso_token":"eyJ..."}.
	formatSSOCookie
)

func (f importFormat) String() string {
	return [...]string{"unknown", "grok", "grok-build-cli", "grok2api-build", "grok2api-web",
		"grok2api-console", "grok2api-legacy-token", "sso-cookie"}[f]
}

// classifyImport decides which Grok layout doc is, or formatUnknown when the file belongs to
// someone else. doc is the top-level JSON object; the caller has already confirmed that it
// has no "type" field, or that "type" is "grok".
func classifyImport(doc map[string]json.RawMessage) importFormat {
	if jsonString(doc["type"]) == providerIdentifier {
		return formatGrokStorage
	}
	// Every rule keys on a Grok-only signal; generic token field names never claim a file.
	for key, raw := range doc {
		if strings.HasPrefix(key, grokBuildIssuerKey) && jsonObjectHasAny(raw, "key", "refresh_token") {
			return formatGrokBuildCLI
		}
	}
	if provider, tagged := doc["provider"]; tagged {
		return formatForProviderTag(jsonString(provider))
	}
	if rawAccounts, batch := doc["accounts"]; batch {
		return formatForAccountTags(rawAccounts)
	}
	for _, pool := range []string{"ssoNormal", "ssoSuper", "sso"} {
		if isTokenPool(doc[pool]) {
			return formatLegacyTokenJSON
		}
	}
	if looksLikeJWT(sanitizeSSO(jsonString(doc["sso"]))) || looksLikeJWT(sanitizeSSO(jsonString(doc["sso_token"]))) {
		return formatSSOCookie
	}
	return formatUnknown
}

// grokBuildIssuerKey prefixes Grok Build's auth.json session keys ("<issuer>::<client_id>").
const grokBuildIssuerKey = "https://auth.x.ai::"

// formatForProviderTag maps grok2api's export "provider" tag; any other tag is not ours.
func formatForProviderTag(tag string) importFormat {
	switch strings.ToLower(tag) {
	case "grok_build", "build":
		return formatGrok2APIBuild
	case "grok_web", "web":
		return formatGrok2APIWeb
	case "grok_console", "console":
		return formatGrok2APIConsole
	default:
		return formatUnknown
	}
}

// formatForAccountTags classifies an untagged {"accounts":[...]} batch by its entries, which
// grok2api's Build export tags individually. Mixed or untagged entries stay unknown.
func formatForAccountTags(raw json.RawMessage) importFormat {
	var entries []struct {
		Provider string `json:"provider"`
	}
	if json.Unmarshal(raw, &entries) != nil || len(entries) == 0 {
		return formatUnknown
	}
	format := formatForProviderTag(entries[0].Provider)
	for _, entry := range entries[1:] {
		if formatForProviderTag(entry.Provider) != format {
			return formatUnknown
		}
	}
	return format
}

// isTokenPool reports a non-empty legacy pool: an object whose values are all objects
// ({"<sso>": {...metadata}}), which rules out ordinary settings like {"sso":{"enabled":true}}.
func isTokenPool(raw json.RawMessage) bool {
	var pool map[string]json.RawMessage
	if json.Unmarshal(raw, &pool) != nil || len(pool) == 0 {
		return false
	}
	for _, value := range pool {
		if trimmed := strings.TrimSpace(string(value)); !strings.HasPrefix(trimmed, "{") {
			return false
		}
	}
	return true
}

func jsonObjectHasAny(raw json.RawMessage, keys ...string) bool {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil {
		return false
	}
	for _, key := range keys {
		if jsonString(object[key]) != "" {
			return true
		}
	}
	return false
}

// looksLikeJWT accepts the three base64url segments of grok.com's sso cookie.
func looksLikeJWT(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if part == "" || strings.Trim(part, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=") != "" {
			return false
		}
	}
	return true
}

// detectedAccounts expands one imported file into storage records, one per Grok account.
func detectedAccounts(rt *grokRuntime, raw []byte) ([]grokStorage, importFormat, error) {
	var doc map[string]json.RawMessage
	if errUnmarshal := json.Unmarshal(raw, &doc); errUnmarshal != nil || doc == nil {
		return nil, formatUnknown, nil
	}
	format := classifyImport(doc)
	source := "import:" + format.String()
	switch format {
	case formatUnknown:
		return nil, format, nil
	case formatGrokStorage:
		value, errDecode := decodeStorage(raw)
		return []grokStorage{value}, format, errDecode
	case formatGrokBuildCLI:
		values, errCLI := grokBuildCLIAccounts(doc)
		return values, format, errCLI
	case formatGrok2APIBuild:
		seeds, errSeeds := rt.build.ParseImportedCredentials(raw)
		return seedsToStorage(upstreamBuild, seeds, source), format, errSeeds
	case formatGrok2APIWeb:
		seeds, errSeeds := rt.web.ParseImportedCredentials(raw)
		return seedsToStorage(upstreamWeb, seeds, source), format, errSeeds
	case formatGrok2APIConsole:
		seeds, errSeeds := rt.console.ParseImportedCredentials(raw)
		return seedsToStorage(upstreamConsole, seeds, source), format, errSeeds
	case formatLegacyTokenJSON:
		return legacyTokenAccounts(doc), format, nil
	case formatSSOCookie:
		token := sanitizeSSO(firstNonEmpty(jsonString(doc["sso"]), jsonString(doc["sso_token"])))
		if token == "" {
			return nil, format, fmt.Errorf("sso cookie is empty")
		}
		return ssoAccounts(token, jsonString(doc["cloudflare_cookies"]), loadedConfig().SSODefaultTarget, source, false), format, nil
	}
	return nil, formatUnknown, nil
}

func seedsToStorage(upstream string, seeds []provider.CredentialSeed, source string) []grokStorage {
	values := make([]grokStorage, 0, len(seeds))
	for _, seed := range seeds {
		values = append(values, seedStorage(upstream, seed, source))
	}
	return values
}

// grokBuildCLIAccounts reads Grok Build's auth.json, keeping only OIDC entries with tokens.
func grokBuildCLIAccounts(doc map[string]json.RawMessage) ([]grokStorage, error) {
	keys := make([]string, 0, len(doc))
	for key := range doc {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var values []grokStorage
	for _, key := range keys {
		var entry struct {
			Key          string `json:"key"`
			RefreshToken string `json:"refresh_token"`
			AuthMode     string `json:"auth_mode"`
			Email        string `json:"email"`
			UserID       string `json:"user_id"`
			TeamID       string `json:"team_id"`
			ExpiresAt    any    `json:"expires_at"`
			ClientID     string `json:"oidc_client_id"`
		}
		if json.Unmarshal(doc[key], &entry) != nil || (entry.Key == "" && entry.RefreshToken == "") {
			continue
		}
		if mode := strings.ToLower(entry.AuthMode); mode != "" && mode != "oidc" {
			continue
		}
		value := grokStorage{
			Type: providerIdentifier, Upstream: upstreamBuild, AuthKind: "oauth", Source: "import:grok-build-cli",
			Email: entry.Email, UserID: entry.UserID, TeamID: entry.TeamID,
			AccessToken: entry.Key, RefreshToken: entry.RefreshToken, ClientID: entry.ClientID,
			ExpiresAt: normalizeExpiry(entry.ExpiresAt),
		}
		if claims := jwtClaims(entry.Key); claims != nil {
			value.UserID = firstNonEmpty(value.UserID, claimString(claims, "sub"))
			value.Email = firstNonEmpty(value.Email, claimString(claims, "email"))
		}
		values = append(values, value)
	}
	if len(values) == 0 {
		return nil, fmt.Errorf("grok build auth.json has no OIDC session with tokens")
	}
	return values, nil
}

// legacyTokenAccounts maps pre-v3 token.json pools onto Web accounts; ssoSuper marks Super.
func legacyTokenAccounts(doc map[string]json.RawMessage) []grokStorage {
	var values []grokStorage
	for _, pool := range []struct{ key, tier string }{{"ssoSuper", "super"}, {"ssoNormal", "basic"}, {"sso", "auto"}} {
		var tokens map[string]json.RawMessage
		if json.Unmarshal(doc[pool.key], &tokens) != nil {
			continue
		}
		keys := make([]string, 0, len(tokens))
		for token := range tokens {
			keys = append(keys, token)
		}
		sort.Strings(keys)
		for _, token := range keys {
			if cleaned := sanitizeSSO(token); cleaned != "" {
				values = append(values, grokStorage{
					Type: providerIdentifier, Upstream: upstreamWeb, AuthKind: "sso", SSOToken: cleaned,
					WebTier: pool.tier, Source: "import:grok2api-legacy-token",
				})
			}
		}
	}
	return values
}

// ssoAccounts fans one SSO cookie out to the requested upstreams. Build needs a network
// conversion, so import (offline) skips it and only login performs it.
func ssoAccounts(token, cloudflare, target, source string, includeBuild bool) []grokStorage {
	var upstreams []string
	switch target {
	case ssoTargetWeb:
		upstreams = []string{upstreamWeb}
	case ssoTargetConsole:
		upstreams = []string{upstreamConsole}
	case ssoTargetBuild:
		upstreams = []string{upstreamBuild}
	default:
		upstreams = []string{upstreamWeb, upstreamConsole, upstreamBuild}
	}
	var values []grokStorage
	for _, upstream := range upstreams {
		if upstream == upstreamBuild && !includeBuild {
			continue
		}
		values = append(values, grokStorage{
			Type: providerIdentifier, Upstream: upstream, AuthKind: "sso", SSOToken: token,
			CloudflareCookies: cloudflare, Source: source,
		})
	}
	return values
}

// sanitizeSSO accepts "sso=<jwt>; sso-rw=..." pastes as well as the bare value.
func sanitizeSSO(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(strings.ToLower(value), "sso=") {
		value = strings.TrimSpace(value[len("sso="):])
	}
	if token, _, found := strings.Cut(value, ";"); found {
		value = token
	}
	return strings.TrimSpace(strings.NewReplacer("\r", "", "\n", "", "\x00", "", `"`, "").Replace(value))
}

func jsonString(raw json.RawMessage) string {
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

// normalizeExpiry accepts RFC3339 strings and Unix seconds (Grok Build writes either).
func normalizeExpiry(value any) string {
	switch typed := value.(type) {
	case string:
		if parsed, errParse := time.Parse(time.RFC3339Nano, strings.TrimSpace(typed)); errParse == nil {
			return parsed.UTC().Format(time.RFC3339Nano)
		}
	case float64:
		if typed > 0 {
			return time.Unix(int64(typed), 0).UTC().Format(time.RFC3339Nano)
		}
	}
	return ""
}
