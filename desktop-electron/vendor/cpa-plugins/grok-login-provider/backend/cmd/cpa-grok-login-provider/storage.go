package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"strings"
	"time"

	"github.com/chenyme/grok2api/backend/internal/domain/account"
	egressdomain "github.com/chenyme/grok2api/backend/internal/domain/egress"
)

// Upstream kinds a "grok" auth file can target. They map 1:1 onto grok2api providers.
const (
	upstreamBuild   = "build"
	upstreamWeb     = "web"
	upstreamConsole = "console"
)

// grokStorage is the provider-owned JSON persisted in CPA's auth directory:
//
//	{"type":"grok","grok_upstream":"build","auth_kind":"oauth","email":...,"access_token":...}
//
// Build accounts carry OAuth tokens; Web and Console accounts carry the grok.com / x.ai
// "sso" cookie. Unknown keys written by CPA (prefix, priority, weight...) are preserved by
// patchStorage when the plugin rewrites a file.
type grokStorage struct {
	Type              string `json:"type"`
	Upstream          string `json:"grok_upstream"`
	AuthKind          string `json:"auth_kind"`
	Label             string `json:"label,omitempty"`
	Email             string `json:"email,omitempty"`
	UserID            string `json:"user_id,omitempty"`
	TeamID            string `json:"team_id,omitempty"`
	AccessToken       string `json:"access_token,omitempty"`
	RefreshToken      string `json:"refresh_token,omitempty"`
	IDToken           string `json:"id_token,omitempty"`
	ClientID          string `json:"client_id,omitempty"`
	ExpiresAt         string `json:"expires_at,omitempty"`
	SSOToken          string `json:"sso_token,omitempty"`
	CloudflareCookies string `json:"cloudflare_cookies,omitempty"`
	WebTier           string `json:"web_tier,omitempty"`
	ProxyURL          string `json:"proxy_url,omitempty"`
	Disabled          bool   `json:"disabled,omitempty"`
	Source            string `json:"source,omitempty"`
}

func decodeStorage(raw []byte) (grokStorage, error) {
	var value grokStorage
	if errUnmarshal := json.Unmarshal(raw, &value); errUnmarshal != nil {
		return grokStorage{}, errUnmarshal
	}
	value.Upstream = strings.ToLower(strings.TrimSpace(value.Upstream))
	return value, value.validate()
}

func (s grokStorage) validate() error {
	switch s.Upstream {
	case upstreamBuild:
		if strings.TrimSpace(s.AccessToken) == "" && strings.TrimSpace(s.RefreshToken) == "" {
			return fmt.Errorf("grok build auth needs access_token or refresh_token")
		}
	case upstreamWeb, upstreamConsole:
		if strings.TrimSpace(s.SSOToken) == "" {
			return fmt.Errorf("grok %s auth needs sso_token", s.Upstream)
		}
	default:
		return fmt.Errorf("grok_upstream must be build, web or console")
	}
	return nil
}

func (s grokStorage) expiresAt() time.Time {
	parsed, errParse := time.Parse(time.RFC3339Nano, strings.TrimSpace(s.ExpiresAt))
	if errParse != nil {
		return time.Time{}
	}
	return parsed.UTC()
}

// identity is a stable, non-secret key for one account; it names files and derives IDs.
func (s grokStorage) identity() string {
	for _, value := range []string{s.UserID, strings.ToLower(s.Email)} {
		if value = strings.TrimSpace(value); value != "" {
			return s.Upstream + ":" + value
		}
	}
	secret := firstNonEmpty(s.RefreshToken, s.SSOToken, s.AccessToken)
	return s.Upstream + ":h" + shortHash(secret)
}

func (s grokStorage) displayLabel() string {
	name := firstNonEmpty(s.Label, s.Email, s.UserID)
	if name == "" {
		name = "account " + shortHash(firstNonEmpty(s.RefreshToken, s.SSOToken, s.AccessToken))[:8]
	}
	return "Grok " + upstreamTitle(s.Upstream) + " · " + name
}

func (s grokStorage) fileName() string {
	slug := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			return r
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		default:
			return '-'
		}
	}, strings.TrimPrefix(s.identity(), s.Upstream+":"))
	return "grok-" + s.Upstream + "-" + strings.Trim(slug, "-.") + ".json"
}

func (s grokStorage) accountProvider() account.Provider {
	switch s.Upstream {
	case upstreamWeb:
		return account.ProviderWeb
	case upstreamConsole:
		return account.ProviderConsole
	default:
		return account.ProviderBuild
	}
}

func (s grokStorage) egressScope() egressdomain.Scope {
	switch s.Upstream {
	case upstreamWeb:
		return egressdomain.ScopeWeb
	case upstreamConsole:
		return egressdomain.ScopeConsole
	default:
		return egressdomain.ScopeBuild
	}
}

func (s grokStorage) marshal() []byte {
	s.Type = providerIdentifier
	raw, _ := json.MarshalIndent(s, "", "  ")
	return raw
}

// patchStorage overlays updated onto the original file JSON, keeping keys this plugin does
// not own (CPA's prefix, priority, weight, excluded_models...).
func patchStorage(original []byte, updated grokStorage) []byte {
	merged := map[string]any{}
	_ = json.Unmarshal(original, &merged)
	var overlay map[string]any
	_ = json.Unmarshal(updated.marshal(), &overlay)
	for key, value := range overlay {
		merged[key] = value
	}
	raw, _ := json.MarshalIndent(merged, "", "  ")
	return raw
}

func upstreamTitle(upstream string) string {
	switch upstream {
	case upstreamWeb:
		return "Web"
	case upstreamConsole:
		return "Console"
	default:
		return "Build"
	}
}

func stableCredentialID(identity string) uint64 {
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(identity))
	// Keep the ID positive and non-zero; grok2api treats 0 as "unset".
	return hash.Sum64()>>1 | 1
}

func shortHash(value string) string {
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(value))
	return fmt.Sprintf("%016x", hash.Sum64())
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// jwtClaims decodes an unverified JWT payload for identity fields only (sub, email, exp).
func jwtClaims(token string) map[string]any {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) < 2 {
		return nil
	}
	payload, errDecode := base64.RawURLEncoding.DecodeString(parts[1])
	if errDecode != nil {
		return nil
	}
	var claims map[string]any
	if json.Unmarshal(payload, &claims) != nil {
		return nil
	}
	return claims
}

func claimString(claims map[string]any, key string) string {
	value, _ := claims[key].(string)
	return strings.TrimSpace(value)
}
