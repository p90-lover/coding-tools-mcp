package main

// Keyword presets and YAML configuration adapted from jellyfish-p's MIT filter.
import (
	"encoding/json"
	"fmt"
	"gopkg.in/yaml.v3"
	"regexp"
	"sort"
	"strings"
	"sync"
)

var defaultRewriteMappings = []rewriteMapping{
	// Major AI code editors, assistants, and terminal coding agents.
	{Match: "Claude Code", Replacement: "Antigravity"},
	{Match: "OpenAI Codex", Replacement: "Antigravity"},
	{Match: "Codex CLI", Replacement: "Antigravity"},
	{Match: "Codex", Replacement: "Antigravity"},
	{Match: "OpenCode", Replacement: "Antigravity"},
	{Match: "GitHub Copilot CLI", Replacement: "Antigravity"},
	{Match: "GitHub Copilot", Replacement: "Antigravity"},
	{Match: "Gemini Code Assist", Replacement: "Antigravity"},
	{Match: "Gemini CLI", Replacement: "Antigravity"},
	{Match: "Cursor", Replacement: "Antigravity"},
	{Match: "Windsurf", Replacement: "Antigravity"},
	{Match: "Codeium", Replacement: "Antigravity"},
	{Match: "Cline", Replacement: "Antigravity"},
	{Match: "Roo Code", Replacement: "Antigravity"},
	{Match: "Kilo Code", Replacement: "Antigravity"},
	{Match: "Aider", Replacement: "Antigravity"},
	{Match: "Continue.dev", Replacement: "Antigravity"},
	{Match: "Amazon Q Developer", Replacement: "Antigravity"},
	{Match: "Amazon CodeWhisperer", Replacement: "Antigravity"},
	{Match: "JetBrains AI Assistant", Replacement: "Antigravity"},
	{Match: "JetBrains Junie", Replacement: "Antigravity"},
	{Match: "Kiro", Replacement: "Antigravity"},
	{Match: "Qoder CLI", Replacement: "Antigravity"},
	{Match: "Qoder", Replacement: "Antigravity"},
	{Match: "Qwen Code", Replacement: "Antigravity"},
	{Match: "Trae", Replacement: "Antigravity"},
	{Match: "Tabnine", Replacement: "Antigravity"},
	{Match: "Sourcegraph Cody", Replacement: "Antigravity"},
	{Match: "Augment Code", Replacement: "Antigravity"},
	{Match: "Replit Agent", Replacement: "Antigravity"},
	{Match: "Replit Ghostwriter", Replacement: "Antigravity"},
	{Match: "Devin", Replacement: "Antigravity"},
	{Match: "OpenHands", Replacement: "Antigravity"},
	{Match: "SWE-agent", Replacement: "Antigravity"},
	{Match: "Goose", Replacement: "Antigravity"},
	{Match: "Zed AI", Replacement: "Antigravity"},
	{Match: "Void Editor", Replacement: "Antigravity"},
	{Match: "PearAI", Replacement: "Antigravity"},
	{Match: "Refact.ai", Replacement: "Antigravity"},
	{Match: "Tabby", Replacement: "Antigravity"},
	{Match: "GitLab Duo", Replacement: "Antigravity"},
	{Match: "Visual Studio IntelliCode", Replacement: "Antigravity"},
	{Match: "CodeBuddy", Replacement: "Antigravity"},
	{Match: "Blackbox AI", Replacement: "Antigravity"},
	{Match: "Pieces for Developers", Replacement: "Antigravity"},
	{Match: "Qodo", Replacement: "Antigravity"},
	{Match: "CodiumAI", Replacement: "Antigravity"},
	{Match: "Rovo Dev CLI", Replacement: "Antigravity"},
	{Match: "Factory Droid", Replacement: "Antigravity"},

	// General-purpose local agents that can generate and modify code.
	{Match: "OpenClaw", Replacement: "Antigravity"},
	{Match: "Clawdbot", Replacement: "Antigravity"},
	{Match: "Moltbot", Replacement: "Antigravity"},
	{Match: "Hermes Agent", Replacement: "Antigravity"},
	{Match: "Hermes", Replacement: "Antigravity"},
	{Match: "WorkBuddy", Replacement: "Antigravity"},
}

type filterMode string

const (
	filterModeBlock   filterMode = "block"
	filterModeRewrite filterMode = "rewrite"
)

type rewriteMapping struct {
	Match       string
	Replacement string
}

type filterConfig struct {
	Mode               filterMode
	UseDefaultKeywords bool
	CustomMappings     []rewriteMapping
	pattern            *regexp.Regexp
	mappings           []rewriteMapping
}

var (
	filterConfigMu      sync.RWMutex
	currentFilterConfig = compileFilterConfig(defaultFilterConfig())
)

func defaultFilterConfig() filterConfig {
	return filterConfig{Mode: filterModeBlock, UseDefaultKeywords: true}
}

func applyFilterConfig(cfg filterConfig) {
	filterConfigMu.Lock()
	defer filterConfigMu.Unlock()

	currentFilterConfig = compileFilterConfig(cfg)
}

func activeFilterConfig() filterConfig {
	filterConfigMu.RLock()
	defer filterConfigMu.RUnlock()

	return currentFilterConfig
}

type lifecycleRequest struct {
	ConfigYAML []byte `json:"config_yaml"`
}

func filterConfigFromLifecycleRequest(request []byte) (filterConfig, error) {
	var req lifecycleRequest
	if err := json.Unmarshal(request, &req); err != nil {
		return filterConfig{}, fmt.Errorf("decode lifecycle request: %w", err)
	}
	return parseFilterConfigYAML(req.ConfigYAML)
}

func parseFilterConfigYAML(raw []byte) (filterConfig, error) {
	cfg := defaultFilterConfig()
	if len(strings.TrimSpace(string(raw))) == 0 {
		return cfg, nil
	}

	var values map[string]any
	if err := yaml.Unmarshal(raw, &values); err != nil {
		return filterConfig{}, fmt.Errorf("decode config yaml: %w", err)
	}
	if value, exists := values["mode"]; exists {
		text, ok := value.(string)
		if !ok {
			return filterConfig{}, fmt.Errorf("mode must be a string")
		}
		cfg.Mode = filterMode(strings.ToLower(strings.TrimSpace(text)))
		if cfg.Mode != filterModeBlock && cfg.Mode != filterModeRewrite {
			return filterConfig{}, fmt.Errorf("mode must be one of: block, rewrite")
		}
	}
	if value, exists := values["use_default_keywords"]; exists {
		boolValue, ok := value.(bool)
		if !ok {
			return filterConfig{}, fmt.Errorf("use_default_keywords must be a boolean")
		}
		cfg.UseDefaultKeywords = boolValue
	}
	if value, exists := values["custom_mappings"]; exists {
		mappings, err := parseCustomMappings(value)
		if err != nil {
			return filterConfig{}, err
		}
		cfg.CustomMappings = mappings
	}
	return cfg, nil
}

func parseCustomMappings(value any) ([]rewriteMapping, error) {
	switch typed := value.(type) {
	case nil:
		return nil, nil
	case string:
		return parseMappingString(typed)
	case map[string]any:
		mappings := make([]rewriteMapping, 0, len(typed))
		for match, replacement := range typed {
			text, ok := replacement.(string)
			if !ok {
				return nil, fmt.Errorf("custom_mappings values must be strings")
			}
			mappings = append(mappings, rewriteMapping{Match: match, Replacement: text})
		}
		return mappings, nil
	case []any:
		mappings := make([]rewriteMapping, 0, len(typed))
		for _, item := range typed {
			text, ok := item.(string)
			if !ok {
				return nil, fmt.Errorf("custom_mappings entries must be strings")
			}
			parsed, err := parseMappingString(text)
			if err != nil {
				return nil, err
			}
			mappings = append(mappings, parsed...)
		}
		return mappings, nil
	default:
		return nil, fmt.Errorf("custom_mappings must be an object, array, or string")
	}
}

func parseMappingString(value string) ([]rewriteMapping, error) {
	entries := strings.FieldsFunc(value, func(r rune) bool {
		return r == ',' || r == '\n' || r == '\r'
	})
	mappings := make([]rewriteMapping, 0, len(entries))
	for _, entry := range entries {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		match, replacement, ok := strings.Cut(entry, ":")
		if !ok {
			return nil, fmt.Errorf("custom_mappings entries must use match: replacement")
		}
		mappings = append(mappings, rewriteMapping{Match: match, Replacement: replacement})
	}
	return mappings, nil
}

func effectiveMappings(cfg filterConfig) []rewriteMapping {
	mappings := make([]rewriteMapping, 0, len(defaultRewriteMappings)+len(cfg.CustomMappings))
	if cfg.UseDefaultKeywords {
		mappings = append(mappings, defaultRewriteMappings...)
	}
	mappings = append(mappings, cfg.CustomMappings...)
	return normalizeMappings(mappings)
}

func normalizeMappings(mappings []rewriteMapping) []rewriteMapping {
	seen := make(map[string]struct{}, len(mappings))
	reversed := make([]rewriteMapping, 0, len(mappings))
	for i := len(mappings) - 1; i >= 0; i-- {
		match := strings.ToLower(strings.TrimSpace(mappings[i].Match))
		replacement := strings.TrimSpace(mappings[i].Replacement)
		if match == "" || replacement == "" {
			continue
		}
		if _, exists := seen[match]; exists {
			continue
		}
		seen[match] = struct{}{}
		reversed = append(reversed, rewriteMapping{Match: match, Replacement: replacement})
	}
	out := make([]rewriteMapping, 0, len(reversed))
	for i := len(reversed) - 1; i >= 0; i-- {
		out = append(out, reversed[i])
	}
	sort.SliceStable(out, func(i, j int) bool {
		if len(out[i].Match) == len(out[j].Match) {
			return out[i].Match < out[j].Match
		}
		return len(out[i].Match) > len(out[j].Match)
	})
	return out
}

func compileFilterConfig(cfg filterConfig) filterConfig {
	cfg.mappings = effectiveMappings(cfg)
	patterns := make([]string, 0, len(cfg.mappings))
	for _, mapping := range cfg.mappings {
		patterns = append(patterns, regexp.QuoteMeta(mapping.Match))
	}
	if len(patterns) > 0 {
		cfg.pattern = regexp.MustCompile("(?i)(?:" + strings.Join(patterns, "|") + ")")
	}
	return cfg
}
