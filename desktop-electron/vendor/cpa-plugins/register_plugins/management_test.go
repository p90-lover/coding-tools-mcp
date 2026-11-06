package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func managementRequest(t *testing.T, method, path string, body any) (int, []byte) {
	t.Helper()
	var data []byte
	if body != nil {
		data = raw(body)
	}
	response, err := management(raw(map[string]any{"Method": method, "Path": apiPrefix + path, "Body": data}))
	if err != nil {
		t.Fatal(err)
	}
	var envelope envelope
	if json.Unmarshal(response, &envelope) != nil || !envelope.OK {
		t.Fatalf("bad management envelope%s", response)
	}
	var result struct {
		StatusCode int
		Body       []byte
	}
	if json.Unmarshal(envelope.Result, &result) != nil {
		t.Fatal("bad HTTP response")
	}
	return result.StatusCode, result.Body
}

func TestManagementOnlyRegistrationAndPostMutationGuards(t *testing.T) {
	metadata := raw(registration())
	if !bytes.Contains(metadata, []byte(`"GitHubRepository":"https://github.com/p90-lover/coding-tools-mcp"`)) {
		t.Fatal("CPA requires repository metadata to register any capability")
	}
	if !bytes.Contains(metadata, []byte(`"schema_version":6`)) || !bytes.Contains(metadata, []byte(`"management_api":true`)) || bytes.Contains(metadata, []byte(`"executor"`)) || bytes.Contains(metadata, []byte(`"auth_provider"`)) {
		t.Fatalf("wrong capabilities%s", metadata)
	}
	registration := raw(managementRegistration())
	if !bytes.Contains(registration, []byte(`"Menu":"Register"`)) || !bytes.Contains(registration, []byte(apiPrefix+"/index.html")) {
		t.Fatal("missing working console registration")
	}
	e, _ := setup(t)
	engineMu.Lock()
	before := active
	active = e
	engineMu.Unlock()
	t.Cleanup(func() { engineMu.Lock(); active = before; engineMu.Unlock() })
	for _, path := range []string{"/api/sync", "/api/refresh"} {
		status, _ := managementRequest(t, "GET", path, nil)
		if status != 404 {
			t.Fatal("mutation allowed GET")
		}
		for _, ids := range [][]int64{nil, {}, {0}, {1, 1}} {
			status, _ = managementRequest(t, "POST", path, map[string]any{"ids": ids})
			if status != 400 {
				t.Fatal("accepted missing IDs")
			}
		}
	}
	status, body := managementRequest(t, "POST", "/api/settings", settings{AutoImport: false, AutoRefresh: false, IntervalSeconds: 120})
	if status != 200 || !bytes.Contains(body, []byte(`"interval_seconds":120`)) {
		t.Fatalf("settings%d%s", status, body)
	}
	loaded, err := newEngine(e.cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer loaded.cancel()
	if loaded.state.Settings.IntervalSeconds != 120 {
		t.Fatal("settings did not survive restart")
	}
	for _, request := range []any{map[string]any{"auto_import": true, "interval_seconds": 1}, map[string]any{"auto_import": false, "interval_seconds": 120, "arbitrary_command": "ignored"}} {
		status, _ = managementRequest(t, "POST", "/api/settings", request)
		if status != 400 {
			t.Fatal("accepted invalid settings")
		}
	}
	status, body = managementRequest(t, "GET", "/api/status", nil)
	if status != 200 || bytes.Contains(body, []byte(fixtureToken)) || bytes.Contains(body, []byte("fixture-original")) || bytes.Contains(body, []byte(e.cfg.Descriptor)) {
		t.Fatal("status exposed private material")
	}
	status, body = managementRequest(t, "GET", "/index.html", nil)
	if status != 200 || !bytes.Contains(body, []byte("Import selected")) || strings.Contains(string(body), "/v1/export") {
		t.Fatal("console is missing or bypasses management")
	}
}

func TestInvalidStateAndDescriptorAreNotOverwritten(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, "state.json")
	if err := os.WriteFile(state, []byte("invalid-user-recovery-state"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := newEngine(pluginConfig{Descriptor: filepath.Join(dir, "bridge.json"), DataDir: dir}); err == nil {
		t.Fatal("invalid state was accepted")
	}
	stored, _ := os.ReadFile(state)
	if string(stored) != "invalid-user-recovery-state" {
		t.Fatal("invalid state was overwritten")
	}
	path := filepath.Join(dir, "descriptor.json")
	_ = os.WriteFile(path, bytes.Repeat([]byte("x"), 4097), 0600)
	if _, err := openBridge(path); err == nil {
		t.Fatal("oversized descriptor accepted")
	}
	_ = os.Remove(path)
	_ = os.Mkdir(path, 0700)
	if _, err := openBridge(path); err == nil {
		t.Fatal("nonregular descriptor accepted")
	}
}
