package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func decodeResult(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var result struct {
		OK     bool           `json:"ok"`
		Result map[string]any `json:"result"`
		Error  *envelopeError `json:"error"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	if !result.OK {
		t.Fatalf("unexpected plugin error: %+v", result.Error)
	}
	return result.Result
}
func configureTest(t *testing.T) {
	t.Helper()
	base := filepath.Join("..", "..", "..", "..", "aiTemp", "codex-review-account-selector-tests")
	if err := os.MkdirAll(base, 0700); err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp(base, "case-")
	if err != nil {
		t.Fatal(err)
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	raw, _ := json.Marshal(map[string]any{"config_yaml": []byte("data-dir: " + strconvQuote(dir) + "\n")})
	if err := configure(raw); err != nil {
		t.Fatal(err)
	}
}
func strconvQuote(value string) string { raw, _ := json.Marshal(value); return string(raw) }
func mockHost(t *testing.T, fn func(string, any) (json.RawMessage, error)) {
	t.Helper()
	previous := hostCall
	hostCall = fn
	t.Cleanup(func() { quiesce(); hostCall = previous })
}
func hostAccounts(list string) json.RawMessage { return json.RawMessage(`{"files":` + list + `}`) }
func managementCall(t *testing.T, method, path string, body string) map[string]any {
	t.Helper()
	request, _ := json.Marshal(map[string]any{"Method": method, "Path": path, "Body": []byte(body)})
	raw, err := management(request)
	if err != nil {
		t.Fatal(err)
	}
	return decodeResult(t, raw)
}
func TestRegistrationSatisfiesPinnedHostMetadataContract(t *testing.T) {
	configureTest(t)
	state.Lock()
	dir := state.dir
	state.Unlock()
	request, _ := json.Marshal(map[string]any{"config_yaml": []byte("data-dir: " + strconvQuote(dir))})
	raw, err := handleMethod("plugin.register", request)
	if err != nil {
		t.Fatal(err)
	}
	registered := decodeResult(t, raw)
	metadata := registered["metadata"].(map[string]any)
	// CPA 8.0.32 host.validPlugin rejects an empty one of these four metadata fields.
	for _, field := range []string{"Name", "Version", "Author", "GitHubRepository"} {
		value, ok := metadata[field].(string)
		if !ok || strings.TrimSpace(value) == "" {
			t.Fatalf("missing host-required metadata %s", field)
		}
	}
	if metadata["GitHubRepository"] != "https://github.com/p90-lover/coding-tools-mcp" {
		t.Fatal("unexpected source repository")
	}
	if registered["schema_version"] != float64(6) {
		t.Fatal("unsupported host registration schema")
	}
	capabilities := registered["capabilities"].(map[string]any)
	if capabilities["model_router"] != true || capabilities["executor"] != true || capabilities["management_api"] != true {
		t.Fatal("missing plugin capabilities")
	}
}

func TestSanitizedAccountsAndAtomicSelection(t *testing.T) {
	configureTest(t)
	mockHost(t, func(method string, payload any) (json.RawMessage, error) {
		if method != "host.auth.list" {
			t.Fatalf("unexpected credential access: %s", method)
		}
		return hostAccounts(`[{"id":"chosen","provider":"codex","email":"user@example.test","label":"Codex","last_refresh":"2026-10-18T10:00:00Z","access_token":"SECRET","path":"SECRET_PATH"},{"id":"off","provider":"codex","disabled":true},{"id":"busy","provider":"codex","unavailable":true},{"id":"other","provider":"claude"}]`), nil
	})
	listed := managementCall(t, "GET", apiPrefix+"/accounts", "")
	var data map[string]any
	publicJSON, err := base64.StdEncoding.DecodeString(listed["Body"].(string))
	if err != nil || json.Unmarshal(publicJSON, &data) != nil {
		t.Fatal("invalid accounts response")
	}
	if len(data["accounts"].([]any)) != 3 {
		t.Fatal("non-Codex account exposed")
	}
	encoded := publicJSON
	if strings.Contains(string(encoded), "SECRET") {
		t.Fatal("credential material leaked")
	}
	request, _ := json.Marshal(map[string]any{"selectedAuthId": "chosen"})
	if err := saveSelection(selection{"chosen"}); err != nil {
		t.Fatal(err)
	}
	state.Lock()
	dir := state.dir
	state.Unlock()
	persisted, err := os.ReadFile(filepath.Join(dir, "selection.json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(persisted)) != string(request) {
		t.Fatalf("unexpected saved fields: %s", persisted)
	}
	for _, id := range []string{"off", "busy", "other", "missing", ""} {
		if saveSelection(selection{id}) == nil {
			t.Fatalf("invalid selection accepted: %s", id)
		}
		after, _ := os.ReadFile(filepath.Join(dir, "selection.json"))
		if string(after) != string(persisted) {
			t.Fatal("invalid selection replaced previous settings")
		}
	}
	files, _ := os.ReadDir(dir)
	if len(files) != 1 {
		t.Fatal("temporary selection files leaked")
	}
	raw, _ := json.Marshal(map[string]any{"config_yaml": []byte("data-dir: " + strconvQuote(dir))})
	if err := configure(raw); err != nil {
		t.Fatal(err)
	}
	state.Lock()
	selected := state.selected.SelectedAuthID
	state.Unlock()
	if selected != "chosen" {
		t.Fatal("selection did not persist across configuration")
	}
}
func TestInvalidSavedSelectionKeepsReviewRouteFailClosed(t *testing.T) {
	configureTest(t)
	state.Lock()
	dir := state.dir
	state.Unlock()
	if err := os.WriteFile(filepath.Join(dir, "selection.json"), []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{"config_yaml": []byte("data-dir: " + strconvQuote(dir))})
	registration, err := handleMethod("plugin.reconfigure", raw)
	if err != nil {
		t.Fatal(err)
	}
	decodeResult(t, registration)
	mockHost(t, func(method string, payload any) (json.RawMessage, error) {
		t.Fatalf("bad settings reached host execution: %s", method)
		return nil, nil
	})
	request, _ := json.Marshal(executeRequest{Model: reviewModel, Payload: []byte(`{}`)})
	response, _ := execute(request, false)
	var result envelope
	json.Unmarshal(response, &result)
	if result.OK || result.Error.Code != "review_account_unavailable" {
		t.Fatal("invalid saved selection did not fail closed")
	}
	route, _ := handleMethod("model.route", []byte(`{"RequestedModel":"codex-auto-review"}`))
	if decodeResult(t, route)["Handled"] != true {
		t.Fatal("invalid settings removed review route")
	}
}

func TestMalformedSelectionCanBeRepairedThroughManagement(t *testing.T) {
	configureTest(t)
	state.Lock()
	dir := state.dir
	state.Unlock()
	savedPath := filepath.Join(dir, "selection.json")
	if err := os.WriteFile(savedPath, []byte("invalid"), 0600); err != nil {
		t.Fatal(err)
	}
	config, _ := json.Marshal(map[string]any{"config_yaml": []byte("data-dir: " + strconvQuote(dir))})
	registration, err := handleMethod("plugin.reconfigure", config)
	if err != nil {
		t.Fatal(err)
	}
	decodeResult(t, registration)
	executions := 0
	mockHost(t, func(method string, payload any) (json.RawMessage, error) {
		if method == "host.auth.list" {
			return hostAccounts(`[{"id":"chosen","provider":"codex"},{"id":"off","provider":"codex","disabled":true}]`), nil
		}
		if method != "host.model.execute" {
			t.Fatalf("unexpected host callback: %s", method)
		}
		executions++
		if payload.(map[string]any)["auth_id"] != "chosen" {
			t.Fatal("repair changed the selected account")
		}
		result, _ := json.Marshal(modelResponse{StatusCode: 200, Body: []byte(`{"outcome":"allow"}`)})
		return result, nil
	})
	request, _ := json.Marshal(executeRequest{Model: reviewModel, Payload: []byte(`{}`)})
	blocked, _ := execute(request, false)
	var failure envelope
	json.Unmarshal(blocked, &failure)
	if failure.OK || executions != 0 {
		t.Fatal("malformed selection did not block execution")
	}
	denied := managementCall(t, "PUT", apiPrefix+"/settings", `{"selectedAuthId":"off"}`)
	if denied["StatusCode"] != float64(400) {
		t.Fatal("disabled recovery account was accepted")
	}
	untouched, _ := os.ReadFile(savedPath)
	if string(untouched) != "invalid" {
		t.Fatal("invalid save replaced malformed settings")
	}
	repaired := managementCall(t, "PUT", apiPrefix+"/settings", `{"selectedAuthId":"chosen"}`)
	if repaired["StatusCode"] != float64(200) {
		t.Fatalf("management could not repair settings: %v", repaired)
	}
	persisted, _ := os.ReadFile(savedPath)
	if strings.TrimSpace(string(persisted)) != `{"selectedAuthId":"chosen"}` {
		t.Fatalf("unexpected recovery data: %s", persisted)
	}
	response, err := execute(request, false)
	if err != nil {
		t.Fatal(err)
	}
	decodeResult(t, response)
	if executions != 1 {
		t.Fatal("repaired selection did not execute once")
	}
}

func TestExactRouteAndManagementValidation(t *testing.T) {
	configureTest(t)
	for _, model := range []string{reviewModel, "gpt-6", "codex-auto-review-extra", "CODEX-AUTO-REVIEW"} {
		raw, _ := json.Marshal(map[string]string{"RequestedModel": model})
		result, err := handleMethod("model.route", raw)
		if err != nil {
			t.Fatal(err)
		}
		decision := decodeResult(t, result)
		if decision["Handled"] != (model == reviewModel) {
			t.Fatalf("incorrect route: %s", model)
		}
	}
	mockHost(t, func(string, any) (json.RawMessage, error) {
		return hostAccounts(`[{"id":"chosen","provider":"codex"}]`), nil
	})
	for _, body := range []string{`{"selectedAuthId":"chosen","access_token":"forbidden"}`, `{"selectedAuthId":"missing"}`, `{}`, `{"selectedAuthId":"chosen"} garbage`} {
		result := managementCall(t, "PUT", apiPrefix+"/settings", body)
		if result["StatusCode"] != float64(400) {
			t.Fatalf("invalid settings accepted: %s", body)
		}
	}
	result := managementCall(t, "PUT", apiPrefix+"/settings", `{"selectedAuthId":"chosen"}`)
	if result["StatusCode"] != float64(200) {
		t.Fatal("valid settings rejected")
	}
	page := managementCall(t, "GET", resourcePath, "")
	if page["StatusCode"] != float64(200) {
		t.Fatal("management resource missing")
	}
}
func TestNormalExecutionPinsOnlySelectedAccount(t *testing.T) {
	configureTest(t)
	state.Lock()
	state.selected = selection{"chosen"}
	state.Unlock()
	calls := 0
	mockHost(t, func(method string, payload any) (json.RawMessage, error) {
		if method == "host.auth.list" {
			return hostAccounts(`[{"id":"chosen","provider":"codex"},{"id":"fallback","provider":"codex"}]`), nil
		}
		if method != "host.model.execute" {
			t.Fatalf("unexpected host call: %s", method)
		}
		calls++
		request := payload.(map[string]any)
		for key, want := range map[string]any{"auth_id": "chosen", "forced_provider": "codex", "model": reviewModel, "stream": false, "host_callback_id": "cb"} {
			if request[key] != want {
				t.Fatalf("%s=%v", key, request[key])
			}
		}
		var body map[string]any
		json.Unmarshal(request["body"].([]byte), &body)
		if body["model"] != reviewModel || body["stream"] != false {
			t.Fatal("review payload changed model")
		}
		state.Lock()
		state.selected = selection{"fallback"}
		state.Unlock()
		data, _ := json.Marshal(modelResponse{StatusCode: 200, Body: []byte(`{"outcome":"allow"}`), Headers: map[string][]string{}})
		return data, nil
	})
	raw, _ := json.Marshal(executeRequest{Model: reviewModel, Format: "openai-response", Payload: []byte(`{"model":"ignored","input":"review"}`), HostCallbackID: "cb"})
	response, err := execute(raw, false)
	if err != nil {
		t.Fatal(err)
	}
	result := decodeResult(t, response)
	headers := result["Headers"].(map[string]any)
	if headers["X-Codex-Review-Auth-Id"].([]any)[0] != "chosen" {
		t.Fatal("request did not retain its initial account")
	}
	if calls != 1 {
		t.Fatal("execution retried through another account")
	}
}
func TestUnavailableAccountsNeverExecuteOrFallback(t *testing.T) {
	for _, row := range []string{`[]`, `[{"id":"chosen","provider":"codex","disabled":true}]`, `[{"id":"chosen","provider":"codex","unavailable":true}]`} {
		t.Run(row, func(t *testing.T) {
			configureTest(t)
			state.Lock()
			state.selected = selection{"chosen"}
			state.Unlock()
			mockHost(t, func(method string, payload any) (json.RawMessage, error) {
				if method != "host.auth.list" {
					t.Fatalf("unexpected execution: %s", method)
				}
				return hostAccounts(row), nil
			})
			raw, _ := json.Marshal(executeRequest{Model: reviewModel, Payload: []byte(`{}`)})
			response, err := execute(raw, false)
			if err != nil {
				t.Fatal(err)
			}
			var result envelope
			json.Unmarshal(response, &result)
			if result.OK || result.Error.Code != "review_account_unavailable" {
				t.Fatal("unavailable selected account accepted")
			}
		})
	}
}
func TestExecutionFailureNeverFallsBack(t *testing.T) {
	configureTest(t)
	state.Lock()
	state.selected = selection{"chosen"}
	state.Unlock()
	calls := 0
	mockHost(t, func(method string, payload any) (json.RawMessage, error) {
		if method == "host.auth.list" {
			return hostAccounts(`[{"id":"chosen","provider":"codex"},{"id":"fallback","provider":"codex"}]`), nil
		}
		calls++
		return nil, fmt.Errorf("quota limited")
	})
	raw, _ := json.Marshal(executeRequest{Model: reviewModel, Payload: []byte(`{}`)})
	response, _ := execute(raw, false)
	var result envelope
	json.Unmarshal(response, &result)
	if result.OK || result.Error.Retryable || calls != 1 {
		t.Fatal("failed review fell back or was marked retryable")
	}
}
func TestStreamingKeepsInitialPinAndClosesBothStreams(t *testing.T) {
	configureTest(t)
	state.Lock()
	state.selected = selection{"chosen"}
	state.Unlock()
	var mu sync.Mutex
	events := []string{}
	release := make(chan struct{})
	mockHost(t, func(method string, payload any) (json.RawMessage, error) {
		if method == "host.auth.list" {
			return hostAccounts(`[{"id":"chosen","provider":"codex"}]`), nil
		}
		mu.Lock()
		events = append(events, method)
		mu.Unlock()
		switch method {
		case "host.model.execute_stream":
			request := payload.(map[string]any)
			if request["auth_id"] != "chosen" || request["forced_provider"] != "codex" || request["stream"] != true {
				t.Error("stream not pinned")
			}
			raw, _ := json.Marshal(modelResponse{StatusCode: 200, StreamID: "native", Headers: map[string][]string{}})
			return raw, nil
		case "host.model.stream_read":
			<-release
			raw, _ := json.Marshal(map[string]any{"payload": []byte("data: review\n\n"), "done": true})
			return raw, nil
		case "host.stream.emit":
			if string(payload.(map[string]any)["payload"].([]byte)) != "data: review\n\n" {
				t.Error("stream payload changed")
			}
		}
		return json.RawMessage(`{}`), nil
	})
	raw, _ := json.Marshal(executeRequest{Model: reviewModel, Format: "openai", Payload: []byte(`{}`), StreamID: "client", HostCallbackID: "cb"})
	response, err := execute(raw, true)
	if err != nil {
		t.Fatal(err)
	}
	decodeResult(t, response)
	state.Lock()
	state.selected = selection{"another"}
	state.Unlock()
	close(release)
	state.wait.Wait()
	mu.Lock()
	defer mu.Unlock()
	for _, want := range []string{"host.model.execute_stream", "host.stream.emit", "host.stream.close", "host.model.stream_close"} {
		found := false
		for _, event := range events {
			if event == want {
				found = true
			}
		}
		if !found {
			t.Errorf("missing %s", want)
		}
	}
}
