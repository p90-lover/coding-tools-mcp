package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func invoke(t *testing.T, method string, payload any) (bool, map[string]json.RawMessage) {
	t.Helper()
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	out, code := handlePluginCall(method, raw)
	if code != 0 {
		t.Fatalf("ABI returned %d", code)
	}
	var reply struct {
		OK     bool                       `json:"ok"`
		Result map[string]json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(out, &reply); err != nil {
		t.Fatal(err)
	}
	return reply.OK, reply.Result
}

func configure(t *testing.T, yaml string) {
	t.Helper()
	ok, _ := invoke(t, "plugin.reconfigure", map[string]any{"config_yaml": []byte(yaml)})
	if !ok {
		t.Fatal("configuration rejected")
	}
}

func intercept(t *testing.T, provider, body string) map[string]json.RawMessage {
	t.Helper()
	ok, result := invoke(t, "request.intercept_after", map[string]any{"ToFormat": provider, "Model": "a-custom-alias", "Body": []byte(body)})
	if !ok {
		t.Fatal("interception failed")
	}
	return result
}

func responseBody(t *testing.T, result map[string]json.RawMessage) string {
	t.Helper()
	var body []byte
	if raw, ok := result["Body"]; ok {
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatal(err)
		}
	}
	return string(body)
}

func TestRegistration(t *testing.T) {
	ok, result := invoke(t, "plugin.register", map[string]any{"config_yaml": []byte("mode: rewrite")})
	if !ok {
		t.Fatal("registration failed")
	}
	var caps map[string]bool
	json.Unmarshal(result["capabilities"], &caps)
	if !caps["request_interceptor"] || !caps["request_interceptor_omit_body_before"] || caps["executor"] || caps["model_router"] {
		t.Fatalf("wrong capabilities: %v", caps)
	}
	_, before := invoke(t, "request.intercept_before", map[string]any{"Body": []byte(`{"system":"Claude Code"}`)})
	if len(before) != 0 {
		t.Fatal("before-auth modified the request")
	}
}

func TestRewritePreservesOtherJSON(t *testing.T) {
	configure(t, "mode: rewrite")
	body := `{"system":[{"type":"text","text":"İ你好 — cLaUdE CoDe and Cursor","cache_control":{"type":"ephemeral","note":"Cursor"}}],"messages":[{"role":"user","content":"Claude Code","system":"Cursor"},{"role":"user","content":[{"type":"tool_result","tool_use_id":"Claude Code","content":"Cursor"}]}],"tools":[{"name":"Cursor","input_schema":{"type":"object","properties":{"system":{"const":"Claude Code"}}}}],"stream":true,"large_id":9007199254740993}`
	out := responseBody(t, intercept(t, "antigravity", body))
	var original, rewritten map[string]json.RawMessage
	json.Unmarshal([]byte(body), &original)
	if err := json.Unmarshal([]byte(out), &rewritten); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"messages", "tools", "stream", "large_id"} {
		if string(original[key]) != string(rewritten[key]) {
			t.Fatalf("changed %s: %s", key, rewritten[key])
		}
	}
	var blocks []map[string]json.RawMessage
	json.Unmarshal(rewritten["system"], &blocks)
	var text string
	json.Unmarshal(blocks[0]["text"], &text)
	if text != "İ你好 — Antigravity and Antigravity" {
		t.Fatalf("unexpected rewrite: %s", text)
	}
	if string(blocks[0]["cache_control"]) != `{"type":"ephemeral","note":"Cursor"}` {
		t.Fatal("cache control changed")
	}
}

func TestProviderIsolationAndNoMatch(t *testing.T) {
	configure(t, "mode: rewrite")
	for _, provider := range []string{"", "claude", "gemini", "codex"} {
		if len(intercept(t, provider, `{"model":"antigravity-claude","system":"Claude Code"}`)) != 0 {
			t.Fatalf("changed provider %s", provider)
		}
	}
	for _, body := range []string{`{}`, `null`, `[]`, `{invalid`, `{"system":"Antigravity","messages":[{"system":"Claude Code"}]}`, `{"system":[{"type":"image","text":"Claude Code"}]}`} {
		if len(intercept(t, "antigravity", body)) != 0 {
			t.Fatalf("changed non-text or no-match body: %s", body)
		}
	}
}

func TestCustomMappingsAndSinglePass(t *testing.T) {
	configure(t, "mode: rewrite\nuse_default_keywords: false\ncustom_mappings:\n  Alpha: Beta\n  Beta: Gamma\n  S: '$value'\n")
	out := responseBody(t, intercept(t, "antigravity", `{"system":"Alpha Beta ſ Claude Code"}`))
	if !strings.Contains(out, "Beta Gamma $value Claude Code") {
		t.Fatalf("unexpected replacement: %s", out)
	}
	configure(t, "mode: rewrite\ncustom_mappings: 'Claude Code: My IDE'\n")
	out = responseBody(t, intercept(t, "antigravity", `{"system":"Claude Code"}`))
	if !strings.Contains(out, "My IDE") {
		t.Fatal("custom mapping did not override preset")
	}
}

func TestBlockAndInvalidReconfigure(t *testing.T) {
	configure(t, "mode: block")
	result := intercept(t, "antigravity", `{"system":"Claude Code"}`)
	if string(result["Terminate"]) != "true" || string(result["StatusCode"]) != "403" {
		t.Fatalf("wrong block: %v", result)
	}
	var payload []byte
	json.Unmarshal(result["ResponseBody"], &payload)
	if !strings.Contains(string(payload), "blocked_by_antigravity_coding_filter") {
		t.Fatal("missing error code")
	}
	ok, _ := invoke(t, "plugin.reconfigure", map[string]any{"config_yaml": []byte("mode: invalid")})
	if ok {
		t.Fatal("invalid mode accepted")
	}
	if string(intercept(t, "antigravity", `{"system":"Claude Code"}`)["Terminate"]) != "true" {
		t.Fatal("invalid config changed active filter")
	}
}
