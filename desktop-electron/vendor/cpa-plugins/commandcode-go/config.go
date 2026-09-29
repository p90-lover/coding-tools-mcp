package plugin

import (
	"strings"

	"gopkg.in/yaml.v3"
)

// pluginConfig mirrors the plugins.configs.<id> mapping the host hands us
// as raw YAML at register/reconfigure time.
//
// CPA auth files supply per-account keys. APIKeys is a fallback for older setups.
type pluginConfig struct {
	Enabled  bool `yaml:"enabled"`
	Priority int  `yaml:"priority"`

	// APIKeys is an optional fallback; CPA auth files handle multiple accounts.
	APIKeys []string `yaml:"api_keys"`

	// BaseURL overrides the upstream API root (tests, mirrors).
	BaseURL string `yaml:"base_url"`

	// Models declares which models this plugin claims. Entries are structured
	// ("- alias: x / name: y") or bare strings ("- y", alias == name).
	Models []ModelEntry `yaml:"models"`

	// Derived from Models at parse time. Not YAML fields.
	claimed  map[string]struct{}
	rewrites map[string]string
}

// ModelEntry maps a client-facing alias to the name the vendor serves.
//
//	name  — the model name sent upstream ("deepseek/deepseek-v4.1-flash")
//	alias — the name clients request ("deepseek-v4.1-flash")
//
// The mapping is REQUIRED: this executor talks to /alpha/generate with its
// own base URL, so the host's alias table never applies, and the gateway
// rejects a bare alias ("deepseek-v4.1-flash is not recognized").
type ModelEntry struct {
	Alias       string `yaml:"alias"`
	Name        string `yaml:"name"`
	DisplayName string `yaml:"display_name"`
}

// UnmarshalYAML accepts the structured mapping and the bare-string form.
func (m *ModelEntry) UnmarshalYAML(node *yaml.Node) error {
	if node.Kind == yaml.ScalarNode {
		v := strings.TrimSpace(node.Value)
		m.Alias, m.Name = v, v
		return nil
	}
	type plain ModelEntry
	var decoded plain
	if err := node.Decode(&decoded); err != nil {
		return err
	}
	*m = ModelEntry(decoded)
	return nil
}

// label resolves the human-readable label for model registration.
func (m ModelEntry) label() string {
	if label := strings.TrimSpace(m.DisplayName); label != "" {
		return label
	}
	if name := strings.TrimSpace(m.Name); name != "" {
		return name
	}
	return strings.TrimSpace(m.Alias)
}

// defaultModelEntries: every entry verified live (HTTP 200 on
// /alpha/generate) against a Go plan key on 2026-09-12. Open-weight models
// the Go plan covers; minimax/qwen/longcat ids were rejected ("Model/provider
// not recognized") and are left out. Override via config when the vendor
// renames or adds models.
func defaultModelEntries() []ModelEntry {
	return []ModelEntry{
		{Alias: "deepseek-v4.1-flash", Name: "deepseek/deepseek-v4.1-flash"},
		{Alias: "deepseek-v4-flash", Name: "deepseek/deepseek-v4-flash"},
		{Alias: "deepseek-v4-flash-fast", Name: "deepseek/deepseek-v4-flash-fast"},
		{Alias: "deepseek-v4-flash-vision-exp", Name: "deepseek/deepseek-v4-flash-vision-exp"},
		{Alias: "glm-5.3-flash", Name: "z-ai/glm-5.3-flash"},
		{Alias: "glm-5.3", Name: "zai-org/GLM-5.3"},
		{Alias: "kimi-k3", Name: "moonshotai/Kimi-K3"},
		{Alias: "kimi-k2.7-code", Name: "moonshotai/Kimi-K2.7-Code"},
		{Alias: "kimi-k2.6", Name: "moonshotai/Kimi-K2.6"},
	}
}

func parseConfig(raw []byte) *pluginConfig {
	cfg := &pluginConfig{}
	if len(raw) > 0 {
		_ = yaml.Unmarshal(raw, cfg)
	}
	cfg.buildIndexes()
	return cfg
}

// effectiveModels returns the configured entries, or the built-in defaults
// when configuration declares none.
func (c *pluginConfig) effectiveModels() []ModelEntry {
	if c != nil && len(c.Models) > 0 {
		return c.Models
	}
	return defaultModelEntries()
}

// buildIndexes derives the lookup tables once per configuration. Keys are
// built with normalizeModel (so "commandcode-go/deepseek-v4.1-flash",
// "deepseek/deepseek-v4.1-flash" and "deepseek-v4.1-flash" all match one
// entry); values are the operator's literal Name — the vendor's identifier
// must never be normalized or the gateway would reject it.
func (c *pluginConfig) buildIndexes() {
	entries := c.effectiveModels()
	c.claimed = make(map[string]struct{}, len(entries)*2)
	c.rewrites = make(map[string]string, len(entries)*2)
	for _, entry := range entries {
		alias := normalizeModel(entry.Alias)
		name := strings.TrimSpace(entry.Name)
		if alias == "" && name == "" {
			continue
		}
		if alias != "" {
			c.claimed[alias] = struct{}{}
		}
		if name == "" {
			continue
		}
		if normalizedName := normalizeModel(name); normalizedName != "" {
			c.claimed[normalizedName] = struct{}{}
		}
		target := name
		if alias == "" {
			// Bare upstream form: alias and name are one.
			target = name
			if a := normalizeModel(name); a != "" {
				c.rewrites[a] = name
			}
			continue
		}
		c.rewrites[alias] = target
		if normalizedName := normalizeModel(name); normalizedName != "" {
			c.rewrites[normalizedName] = target
		}
	}
}

// upstreamName returns the vendor's model name for a client-requested model.
// An empty result means "forward the client's name verbatim".
func (c *pluginConfig) upstreamName(model string) string {
	if c == nil || len(c.rewrites) == 0 {
		return ""
	}
	return c.rewrites[normalizeModel(model)]
}

// firstKey returns the configured API key ("" when none).
func (c *pluginConfig) firstKey() string {
	if c == nil {
		return ""
	}
	for _, k := range c.APIKeys {
		if k = strings.TrimSpace(k); k != "" {
			return k
		}
	}
	return ""
}

func (c *pluginConfig) baseURL() string {
	if c != nil && strings.TrimSpace(c.BaseURL) != "" {
		return strings.TrimSuffix(strings.TrimSpace(c.BaseURL), "/")
	}
	return upstreamBaseURL
}
