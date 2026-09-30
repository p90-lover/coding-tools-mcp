package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
	"gopkg.in/yaml.v3"
)

const (
	defaultBuildBaseURL      = "https://cli-chat-proxy.grok.com/v1"
	defaultBuildFallbackURL  = "https://api.x.ai/v1"
	defaultBuildVersion      = "1.0.40"
	defaultWebBaseURL        = "https://grok.com"
	defaultConsoleBaseURL    = "https://console.x.ai"
	defaultStatsigSignerURL  = "https://grok.wodf.de/sign"
	defaultQualityHold       = 30 * time.Second
	statsigModeURL           = "url"
	statsigModeManual        = "manual"
	ssoTargetBuild           = "build"
	ssoTargetWeb             = "web"
	ssoTargetConsole         = "console"
	ssoTargetAll             = "all"
	qualityExhaustedFailOpen = "fail_open"
)

// pluginConfig is plugins.configs.grok-login-provider in CPA's config.yaml.
type pluginConfig struct {
	ProxyURL         string        `yaml:"proxy-url"`
	BuildBaseURL     string        `yaml:"build-base-url"`
	BuildVersion     string        `yaml:"build-client-version"`
	WebBaseURL       string        `yaml:"web-base-url"`
	ConsoleBaseURL   string        `yaml:"console-base-url"`
	StatsigMode      string        `yaml:"statsig-mode"`
	StatsigSignerURL string        `yaml:"statsig-signer-url"`
	StatsigManual    string        `yaml:"statsig-manual-value"`
	SSODefaultTarget string        `yaml:"sso-default-target"`
	Quality          qualityConfig `yaml:"quality-guard"`
}

// qualityConfig is the anti-downgrade guard (grok2api qualityGuard.requestRetry).
type qualityConfig struct {
	Enabled     *bool  `yaml:"enabled"`
	HoldTimeout string `yaml:"hold-timeout"`
	MinOutput   int64  `yaml:"min-output-tokens"`
	OnExhausted string `yaml:"on-exhausted"`
}

var currentConfig atomic.Pointer[pluginConfig]

func defaultPluginConfig() pluginConfig {
	return pluginConfig{
		BuildBaseURL: defaultBuildBaseURL, BuildVersion: defaultBuildVersion,
		WebBaseURL: defaultWebBaseURL, ConsoleBaseURL: defaultConsoleBaseURL,
		StatsigMode: statsigModeURL, StatsigSignerURL: defaultStatsigSignerURL,
		SSODefaultTarget: ssoTargetAll,
	}
}

func configure(raw []byte) error {
	var req lifecycleRequest
	if len(raw) > 0 {
		if errUnmarshal := json.Unmarshal(raw, &req); errUnmarshal != nil {
			return errUnmarshal
		}
	}
	cfg, errDecode := decodeConfig(req.ConfigYAML)
	if errDecode != nil {
		return errDecode
	}
	currentConfig.Store(&cfg)
	resetRuntime()
	return nil
}

func decodeConfig(raw []byte) (pluginConfig, error) {
	cfg := defaultPluginConfig()
	if len(strings.TrimSpace(string(raw))) > 0 {
		if errUnmarshal := yaml.Unmarshal(raw, &cfg); errUnmarshal != nil {
			return pluginConfig{}, errUnmarshal
		}
	}
	for _, field := range []struct {
		name  string
		value *string
		def   string
	}{
		{"build-base-url", &cfg.BuildBaseURL, defaultBuildBaseURL},
		{"web-base-url", &cfg.WebBaseURL, defaultWebBaseURL},
		{"console-base-url", &cfg.ConsoleBaseURL, defaultConsoleBaseURL},
		{"statsig-signer-url", &cfg.StatsigSignerURL, defaultStatsigSignerURL},
	} {
		normalized, errURL := normalizeHTTPSURL(*field.value, field.def)
		if errURL != nil {
			return pluginConfig{}, fmt.Errorf("%s: %w", field.name, errURL)
		}
		*field.value = normalized
	}
	cfg.ProxyURL = strings.TrimSpace(cfg.ProxyURL)
	if cfg.ProxyURL != "" {
		if _, errProxy := url.Parse(cfg.ProxyURL); errProxy != nil {
			return pluginConfig{}, fmt.Errorf("proxy-url is not a valid URL")
		}
	}
	if strings.TrimSpace(cfg.BuildVersion) == "" {
		cfg.BuildVersion = defaultBuildVersion
	}
	switch cfg.StatsigMode = strings.ToLower(strings.TrimSpace(cfg.StatsigMode)); cfg.StatsigMode {
	case "":
		cfg.StatsigMode = statsigModeURL
	case statsigModeURL, statsigModeManual:
	default:
		return pluginConfig{}, fmt.Errorf("statsig-mode must be url or manual")
	}
	switch cfg.SSODefaultTarget = strings.ToLower(strings.TrimSpace(cfg.SSODefaultTarget)); cfg.SSODefaultTarget {
	case "":
		cfg.SSODefaultTarget = ssoTargetAll
	case ssoTargetBuild, ssoTargetWeb, ssoTargetConsole, ssoTargetAll:
	default:
		return pluginConfig{}, fmt.Errorf("sso-default-target must be build, web, console or all")
	}
	if cfg.Quality.HoldTimeout != "" {
		if _, errDuration := time.ParseDuration(cfg.Quality.HoldTimeout); errDuration != nil {
			return pluginConfig{}, fmt.Errorf("quality-guard.hold-timeout: %w", errDuration)
		}
	}
	return cfg, nil
}

func normalizeHTTPSURL(raw, fallback string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return fallback, nil
	}
	parsed, errParse := url.Parse(value)
	if errParse != nil || parsed.Host == "" {
		return "", fmt.Errorf("not a valid URL")
	}
	if scheme := strings.ToLower(parsed.Scheme); scheme != "https" && scheme != "http" {
		return "", fmt.Errorf("must be an http(s) URL")
	}
	if parsed.User != nil {
		return "", fmt.Errorf("must not include credentials")
	}
	parsed.Fragment, parsed.RawQuery = "", ""
	return strings.TrimRight(parsed.String(), "/"), nil
}

func loadedConfig() pluginConfig {
	if cfg := currentConfig.Load(); cfg != nil {
		return *cfg
	}
	return defaultPluginConfig()
}

// qualityRuntime maps the plugin config onto grok2api's guard runtime. The guard is on by
// default: silently downgraded Grok answers are the failure this plugin exists to catch.
func (cfg pluginConfig) qualityRuntime() QualityRetryRuntime {
	enabled := cfg.Quality.Enabled == nil || *cfg.Quality.Enabled
	hold := defaultQualityHold
	if parsed, errParse := time.ParseDuration(cfg.Quality.HoldTimeout); errParse == nil && parsed > 0 {
		hold = parsed
	}
	minOutput := cfg.Quality.MinOutput
	if minOutput <= 0 {
		minOutput = defaultQualityMinOutput
	}
	return normalizeQualityRetry(QualityRetryRuntime{
		Enabled: enabled, HoldTimeout: hold, MinOutputTokens: minOutput, OnExhausted: cfg.Quality.OnExhausted,
	})
}

func configFields() []pluginapi.ConfigField {
	return []pluginapi.ConfigField{
		{Name: "proxy-url", Type: pluginapi.ConfigFieldTypeString, Description: "Proxy for Grok traffic when an auth file sets no proxy_url. Empty uses the global CPA proxy-url."},
		{Name: "build-base-url", Type: pluginapi.ConfigFieldTypeString, Description: "Grok Build API base. Default " + defaultBuildBaseURL + "."},
		{Name: "build-client-version", Type: pluginapi.ConfigFieldTypeString, Description: "x-grok-client-version sent to Grok Build. Default " + defaultBuildVersion + "."},
		{Name: "web-base-url", Type: pluginapi.ConfigFieldTypeString, Description: "Grok Web origin. Default " + defaultWebBaseURL + "."},
		{Name: "console-base-url", Type: pluginapi.ConfigFieldTypeString, Description: "Grok Console origin. Default " + defaultConsoleBaseURL + "."},
		{Name: "statsig-mode", Type: pluginapi.ConfigFieldTypeEnum, EnumValues: []string{statsigModeURL, statsigModeManual}, Description: "How Grok Web x-statsig-id is produced. url asks statsig-signer-url (sends only method, path and the public grok.com meta value); manual uses statsig-manual-value."},
		{Name: "statsig-signer-url", Type: pluginapi.ConfigFieldTypeString, Description: "x-statsig-id signer for statsig-mode url. Default " + defaultStatsigSignerURL + "."},
		{Name: "statsig-manual-value", Type: pluginapi.ConfigFieldTypeString, Description: "Fixed x-statsig-id for statsig-mode manual."},
		{Name: "sso-default-target", Type: pluginapi.ConfigFieldTypeEnum, EnumValues: []string{ssoTargetAll, ssoTargetBuild, ssoTargetWeb, ssoTargetConsole}, Description: "Which accounts an SSO cookie creates by default in the login page and on import. all creates Build (converted OAuth), Web and Console accounts."},
		{Name: "quality-guard", Type: pluginapi.ConfigFieldTypeObject, Description: "Anti-downgrade guard: {enabled: true, hold-timeout: 30s, min-output-tokens: 8, on-exhausted: fail_closed|fail_open}. Withholds Build/Console reasoning streams that arrive without streamed reasoning and returns a retryable 503 so CPA retries another Grok account."},
	}
}
