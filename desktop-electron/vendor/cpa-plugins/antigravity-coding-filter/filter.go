package main

import (
	"encoding/json"
	"strings"
)

// Keep all unrelated fields raw: decoding an entire request into any rounds large integers.
func filterSystem(body []byte, cfg filterConfig) ([]byte, bool) {
	if cfg.pattern == nil {
		return nil, false
	}
	var root map[string]json.RawMessage
	if json.Unmarshal(body, &root) != nil {
		return nil, false
	}
	system, exists := root["system"]
	if !exists {
		return nil, false
	}
	matched, changed := false, false
	rewrite := func(raw json.RawMessage) json.RawMessage {
		var text string
		if json.Unmarshal(raw, &text) != nil || !cfg.pattern.MatchString(text) {
			return raw
		}
		matched = true
		if cfg.Mode == filterModeBlock {
			return raw
		}
		next := cfg.pattern.ReplaceAllStringFunc(text, func(match string) string {
			for _, mapping := range cfg.mappings {
				if strings.EqualFold(match, mapping.Match) {
					return mapping.Replacement
				}
			}
			return match
		})
		if next == text {
			return raw
		}
		changed = true
		value, _ := json.Marshal(next)
		return value
	}
	var text string
	if json.Unmarshal(system, &text) == nil {
		root["system"] = rewrite(system)
	} else {
		var blocks []json.RawMessage
		if json.Unmarshal(system, &blocks) != nil {
			return nil, false
		}
		for i, raw := range blocks {
			var block map[string]json.RawMessage
			if json.Unmarshal(raw, &block) != nil {
				continue
			}
			var kind string
			if json.Unmarshal(block["type"], &kind) != nil || kind != "text" {
				continue
			}
			block["text"] = rewrite(block["text"])
			blocks[i], _ = json.Marshal(block)
		}
		if changed {
			root["system"], _ = json.Marshal(blocks)
		}
	}
	if !changed {
		return nil, matched
	}
	result, _ := json.Marshal(root)
	return result, matched
}
