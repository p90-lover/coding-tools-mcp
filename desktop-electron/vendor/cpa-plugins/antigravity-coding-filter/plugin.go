package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

const pluginVersion = "0.2.1-codingtools.1"

func handlePluginCall(method string, request []byte) ([]byte, int) {
	switch method {
	case "plugin.register", "plugin.reconfigure":
		cfg, err := filterConfigFromLifecycleRequest(request)
		if err != nil {
			return errorEnvelope("invalid_config", err.Error()), 0
		}
		applyFilterConfig(cfg)
		return envelope(registration()), 0
	case "request.intercept_before":
		return envelope(map[string]any{}), 0
	case "request.intercept_after":
		var req struct {
			ToFormat string
			Body     []byte
		}
		if err := json.Unmarshal(request, &req); err != nil {
			return errorEnvelope("invalid_request", err.Error()), 0
		}
		// CPA sets ToFormat from the selected executor, after aliases and credential selection.
		if !strings.EqualFold(strings.TrimSpace(req.ToFormat), "antigravity") {
			return envelope(map[string]any{}), 0
		}
		cfg := activeFilterConfig()
		body, matched := filterSystem(req.Body, cfg)
		if matched && cfg.Mode == filterModeBlock {
			payload, _ := json.Marshal(map[string]any{"error": map[string]string{
				"type": "invalid_request_error", "code": "blocked_by_antigravity_coding_filter",
				"message": "System text matches a configured coding-client keyword",
			}})
			return envelope(map[string]any{"Terminate": true, "StatusCode": 403,
				"ResponseHeaders": map[string][]string{"Content-Type": {"application/json"}},
				"ResponseBody":    payload}), 0
		}
		if len(body) > 0 {
			return envelope(map[string]any{"Body": body}), 0
		}
		return envelope(map[string]any{}), 0
	default:
		return errorEnvelope("unknown_method", fmt.Sprintf("unknown method %q", method)), 0
	}
}

func registration() any {
	return map[string]any{"schema_version": 6, "metadata": map[string]any{
		"Name": "Antigravity Coding Filter", "Version": pluginVersion,
		"Author":           "jellyfish-p / Coding Tools",
		"GitHubRepository": "https://github.com/jellyfish-p/cpa-plugin-antigravity-coding-filter",
		"ConfigFields": []map[string]any{
			{"Name": "mode", "Type": "enum", "EnumValues": []string{"block", "rewrite"}, "Default": "block",
				"Description": "Rewrite configured system keywords or reject matching Antigravity requests with HTTP 403"},
			{"Name": "use_default_keywords", "Type": "boolean", "Default": true,
				"Description": "Use the upstream coding-client keyword preset, including Claude Code"},
			{"Name": "custom_mappings", "Type": "object", "Default": map[string]string{},
				"Description": "Case-insensitive keyword: replacement mappings in system text"},
		}}, "capabilities": map[string]bool{"request_interceptor": true, "request_interceptor_omit_body_before": true}}
}

func envelope(result any) []byte {
	raw, _ := json.Marshal(map[string]any{"ok": true, "result": result})
	return raw
}

func errorEnvelope(code, message string) []byte {
	raw, _ := json.Marshal(map[string]any{"ok": false, "error": map[string]string{"code": code, "message": message}})
	return raw
}
