package main

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/chenyme/grok2api/backend/internal/domain/account"
	"github.com/chenyme/grok2api/backend/internal/infra/egress"
	"github.com/chenyme/grok2api/backend/internal/infra/provider"
	"github.com/chenyme/grok2api/backend/internal/infra/provider/cli"
	"github.com/chenyme/grok2api/backend/internal/infra/provider/console"
	"github.com/chenyme/grok2api/backend/internal/infra/provider/web"
	"github.com/chenyme/grok2api/backend/internal/infra/security"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

// grokRuntime holds grok2api's adapters wired to in-memory stores. Credentials never persist
// in this process: each call decrypts nothing from disk, it encrypts the auth file's tokens
// with a per-process key because grok2api's adapters only accept cipher text.
type grokRuntime struct {
	cipher    *security.Cipher
	egressDB  *memoryEgressRepository
	egress    *egress.Manager
	responses *memoryResponseRepository
	build     *cli.Adapter
	web       *web.Adapter
	console   *console.Adapter
}

var (
	runtimeMu      sync.Mutex
	activeRuntime  *grokRuntime
	hostProxyURL   atomic.Value // string: last CPA proxy-url seen in a HostConfigSummary
	processKeyOnce sync.Once
	processKey     string
)

func processCipherKey() string {
	processKeyOnce.Do(func() {
		key := make([]byte, 32)
		if _, errRead := rand.Read(key); errRead != nil {
			panic(fmt.Sprintf("grok plugin: generate cipher key: %v", errRead))
		}
		processKey = base64.StdEncoding.EncodeToString(key)
	})
	return processKey
}

func getRuntime() (*grokRuntime, error) {
	runtimeMu.Lock()
	defer runtimeMu.Unlock()
	if activeRuntime != nil {
		return activeRuntime, nil
	}
	cipher, errCipher := security.NewCipher(processCipherKey())
	if errCipher != nil {
		return nil, errCipher
	}
	cfg := loadedConfig()
	egressDB := newMemoryEgressRepository()
	manager := egress.NewManager(egressDB, cipher)
	responses := newMemoryResponseRepository()

	build := cli.NewAdapter(cli.Config{
		BaseURL: cfg.BuildBaseURL, FallbackBaseURL: defaultBuildFallbackURL,
		ClientVersion: cfg.BuildVersion, ClientIdentifier: "grok-shell", TokenAuth: "xai-grok-cli",
		UserAgent: "grok-shell/" + cfg.BuildVersion + " (linux; x86_64)",
	}, cipher)
	build.SetEgress(manager)
	webAdapter := web.NewAdapter(web.Config{
		BaseURL: cfg.WebBaseURL, StatsigMode: cfg.StatsigMode, StatsigSignerURL: cfg.StatsigSignerURL,
		StatsigManualValue: cfg.StatsigManual, ChatTimeoutSeconds: 120, QuotaTimeoutSeconds: 25,
	}, manager, cipher, responses, nil)
	consoleAdapter := console.NewAdapter(console.Config{BaseURL: cfg.ConsoleBaseURL, TimeoutSeconds: 300}, manager, cipher, nil)

	activeRuntime = &grokRuntime{
		cipher: cipher, egressDB: egressDB, egress: manager, responses: responses,
		build: build, web: webAdapter, console: consoleAdapter,
	}
	return activeRuntime, nil
}

// resetRuntime drops the adapters so the next call rebuilds them from the new config.
func resetRuntime() {
	runtimeMu.Lock()
	activeRuntime = nil
	runtimeMu.Unlock()
}

func rememberHost(summary pluginapi.HostConfigSummary) {
	hostProxyURL.Store(strings.TrimSpace(summary.ProxyURL))
}

func (s grokStorage) resolvedProxyURL() string {
	if value := strings.TrimSpace(s.ProxyURL); value != "" {
		return value
	}
	if value := loadedConfig().ProxyURL; value != "" {
		return value
	}
	value, _ := hostProxyURL.Load().(string)
	return value
}

func (rt *grokRuntime) adapterFor(upstream string) provider.ResponseAdapter {
	switch upstream {
	case upstreamWeb:
		return rt.web
	case upstreamConsole:
		return rt.console
	default:
		return rt.build
	}
}

// credential converts one auth file into the account.Credential grok2api's adapters expect.
func (rt *grokRuntime) credential(s grokStorage) (account.Credential, error) {
	credential := account.Credential{
		ID: stableCredentialID(s.identity()), Provider: s.accountProvider(),
		Name: firstNonEmpty(s.Label, s.Email, s.UserID), Email: s.Email, UserID: s.UserID, TeamID: s.TeamID,
		OIDCClientID: s.ClientID, ExpiresAt: s.expiresAt(), Enabled: !s.Disabled,
		AuthStatus: account.AuthStatusActive, WebTier: account.WebTier(s.WebTier),
		SourceKey: s.identity(),
	}
	secret := s.SSOToken
	credential.AuthType = account.AuthTypeSSO
	if s.Upstream == upstreamBuild {
		secret = s.AccessToken
		credential.AuthType = account.AuthTypeOAuth
	}
	var errEncrypt error
	if credential.EncryptedAccessToken, errEncrypt = rt.cipher.Encrypt(secret); errEncrypt != nil {
		return account.Credential{}, errEncrypt
	}
	if credential.EncryptedRefreshToken, errEncrypt = rt.cipher.Encrypt(s.RefreshToken); errEncrypt != nil {
		return account.Credential{}, errEncrypt
	}
	if credential.EncryptedCloudflareCookie, errEncrypt = rt.cipher.Encrypt(s.CloudflareCookies); errEncrypt != nil {
		return account.Credential{}, errEncrypt
	}
	if proxyURL := s.resolvedProxyURL(); proxyURL != "" {
		encryptedProxy, errProxy := rt.cipher.Encrypt(proxyURL)
		if errProxy != nil {
			return account.Credential{}, errProxy
		}
		credential.EgressNodeID = rt.egressDB.nodeFor(s.egressScope(), proxyURL, encryptedProxy)
	}
	if credential.WebTier == "" && s.Upstream == upstreamWeb {
		credential.WebTier = account.WebTierAuto
	}
	return credential, nil
}

// seedStorage turns a grok2api CredentialSeed (login, import, SSO conversion) into a file.
func seedStorage(upstream string, seed provider.CredentialSeed, source string) grokStorage {
	value := grokStorage{
		Type: providerIdentifier, Upstream: upstream, Label: seed.Name, Email: seed.Email,
		UserID: seed.UserID, TeamID: seed.TeamID, Source: source,
		CloudflareCookies: seed.CloudflareCookies, WebTier: string(seed.WebTier),
	}
	if upstream == upstreamBuild {
		value.AuthKind = "oauth"
		value.AccessToken, value.RefreshToken, value.ClientID = seed.AccessToken, seed.RefreshToken, seed.OIDCClientID
		if !seed.ExpiresAt.IsZero() {
			value.ExpiresAt = seed.ExpiresAt.UTC().Format(time.RFC3339Nano)
		}
	} else {
		value.AuthKind = "sso"
		value.SSOToken = seed.AccessToken
	}
	if value.Label == "Grok Build account" || strings.HasPrefix(value.Label, "Grok Web ") || strings.HasPrefix(value.Label, "Grok Console ") {
		value.Label = ""
	}
	return value
}
