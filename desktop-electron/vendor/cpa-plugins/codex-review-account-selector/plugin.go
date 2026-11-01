package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

const pluginID = "codex-review-account-selector"
const reviewModel = "codex-auto-review"
const pluginVersion = "0.1.0-codingtools.4"
const apiPrefix = "/v0/management/" + pluginID
const resourcePath = "/v0/resource/plugins/" + pluginID + "/index.html"

//go:embed web/index.html
var settingsHTML []byte

type envelopeError struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	HTTPStatus int    `json:"http_status,omitempty"`
	Retryable  bool   `json:"retryable,omitempty"`
}
type envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *envelopeError  `json:"error,omitempty"`
}

func okEnvelope(value any) ([]byte, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return json.Marshal(envelope{OK: true, Result: data})
}
func errorEnvelope(code, message string) []byte {
	return upstreamErrorEnvelope(code, message, 500, false)
}
func upstreamErrorEnvelope(code, message string, status int, retry bool) []byte {
	data, _ := json.Marshal(envelope{Error: &envelopeError{Code: code, Message: message, HTTPStatus: status, Retryable: retry}})
	return data
}
func unwrapHostEnvelope(method string, raw []byte, code int) (json.RawMessage, error) {
	var value envelope
	if json.Unmarshal(raw, &value) != nil {
		return nil, fmt.Errorf("invalid host response: %s", method)
	}
	if code != 0 || !value.OK {
		// Host error bodies can contain upstream material; do not reflect them into the settings page.
		if value.Error != nil {
			return nil, fmt.Errorf("%s failed (%s, HTTP %d)", method, value.Error.Code, value.Error.HTTPStatus)
		}
		return nil, fmt.Errorf("%s failed", method)
	}
	return value.Result, nil
}

type selection struct {
	SelectedAuthID string `json:"selectedAuthId"`
}
type account struct {
	ID          string `json:"id"`
	Provider    string `json:"provider,omitempty"`
	Type        string `json:"type,omitempty"`
	Label       string `json:"label,omitempty"`
	Email       string `json:"email,omitempty"`
	LastRefresh string `json:"last_refresh,omitempty"`
	Disabled    bool   `json:"disabled"`
	Unavailable bool   `json:"unavailable"`
}
type publicAccount struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Email       string `json:"email"`
	LastRefresh string `json:"lastRefresh"`
	Disabled    bool   `json:"disabled"`
	Unavailable bool   `json:"unavailable"`
}

var state = struct {
	sync.Mutex
	dir      string
	problem  string
	selected selection
	stopping bool
	streams  map[string]bool
	wait     sync.WaitGroup
}{streams: map[string]bool{}}

func configure(raw []byte) error {
	var request struct {
		ConfigYAML []byte `json:"config_yaml"`
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		return fmt.Errorf("invalid plugin configuration")
	}
	dir := ""
	for _, line := range strings.Split(string(request.ConfigYAML), "\n") {
		key, value, ok := strings.Cut(strings.TrimSpace(line), ":")
		if !ok || key != "data-dir" {
			continue
		}
		value = strings.TrimSpace(value)
		if strings.HasPrefix(value, "\"") {
			unquoted, err := strconv.Unquote(value)
			if err != nil {
				return fmt.Errorf("invalid data-dir")
			}
			value = unquoted
		}
		if len(value) >= 2 && strings.HasPrefix(value, "'") && strings.HasSuffix(value, "'") {
			value = strings.ReplaceAll(value[1:len(value)-1], "''", "'")
		}
		dir = value
	}
	if !filepath.IsAbs(dir) {
		return fmt.Errorf("data-dir must be an absolute private plugin directory")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("cannot prepare plugin settings directory")
	}
	saved := selection{}
	problem := ""
	data, err := os.ReadFile(filepath.Join(dir, "selection.json"))
	if err == nil {
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&saved) != nil || decoder.Decode(new(any)) != io.EOF {
			saved = selection{}
			problem = "Saved account selection is invalid. Select an available Codex account to replace it."
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("cannot read saved account selection")
	}
	state.Lock()
	defer state.Unlock()
	state.dir = dir
	state.problem = problem
	state.selected = saved
	state.stopping = false
	return nil
}
func accounts() ([]account, error) {
	raw, err := hostCall("host.auth.list", map[string]any{})
	if err != nil {
		return nil, err
	}
	var response struct {
		Files []account `json:"files"`
	}
	if json.Unmarshal(raw, &response) != nil {
		return nil, fmt.Errorf("invalid host account list")
	}
	out := []account{}
	for _, item := range response.Files {
		provider := item.Provider
		if provider == "" {
			provider = item.Type
		}
		if provider == "codex" && item.ID != "" {
			out = append(out, item)
		}
	}
	return out, nil
}
func validateAccount(id string) error {
	if id == "" {
		return fmt.Errorf("Select a Codex account in Plugins > Codex Auto Review first")
	}
	list, err := accounts()
	if err != nil {
		return fmt.Errorf("Cannot check the selected Codex account")
	}
	for _, item := range list {
		if item.ID != id {
			continue
		}
		if item.Disabled {
			return fmt.Errorf("The selected Codex account is disabled; choose an available account")
		}
		if item.Unavailable {
			return fmt.Errorf("The selected Codex account is unavailable; no other account will be used")
		}
		return nil
	}
	return fmt.Errorf("The selected Codex account no longer exists; choose an available account")
}
func saveSelection(next selection) error {
	if next.SelectedAuthID != strings.TrimSpace(next.SelectedAuthID) || len(next.SelectedAuthID) > 512 {
		return fmt.Errorf("Invalid account ID")
	}
	if err := validateAccount(next.SelectedAuthID); err != nil {
		return err
	}
	state.Lock()
	defer state.Unlock()
	if state.dir == "" {
		return fmt.Errorf("Plugin settings are not configured")
	}
	data, _ := json.Marshal(next)
	file, err := os.CreateTemp(state.dir, ".selection-")
	if err != nil {
		return fmt.Errorf("Cannot save account selection")
	}
	name := file.Name()
	defer os.Remove(name)
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(append(data, '\n'))
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(name, filepath.Join(state.dir, "selection.json"))
	}
	if err != nil {
		return fmt.Errorf("Cannot save account selection; previous selection preserved")
	}
	state.selected = next
	state.problem = ""
	return nil
}
func registration() any {
	return map[string]any{"schema_version": 6, "metadata": map[string]any{
		"Name": "Codex Auto Review", "Version": pluginVersion, "Author": "Coding Tools",
		"GitHubRepository": "https://github.com/p90-lover/coding-tools-mcp",
		"ConfigFields":     []map[string]string{{"Name": "data-dir", "Type": "string", "Description": "Absolute private directory for the selected account ID; no credentials"}}},
		"capabilities": map[string]any{"model_router": true, "executor": true, "management_api": true,
			"executor_model_scope": "static", "executor_input_formats": []string{"openai", "openai-response"},
			"executor_output_formats": []string{"openai", "openai-response"}}}
}
func managementRegistration() any {
	return map[string]any{"routes": []map[string]string{
		{"Method": "GET", "Path": apiPrefix + "/accounts"}, {"Method": "GET", "Path": apiPrefix + "/settings"}, {"Method": "PUT", "Path": apiPrefix + "/settings"}},
		"resources": []map[string]string{{"Path": "index.html", "Menu": "Codex Auto Review", "Description": "Choose the existing Codex account for permission reviews"}}}
}
func management(raw []byte) ([]byte, error) {
	var request struct {
		Method, Path string
		Body         []byte
	}
	if json.Unmarshal(raw, &request) != nil {
		return nil, fmt.Errorf("invalid management request")
	}
	status := 200
	headers := map[string][]string{"Content-Type": {"application/json; charset=utf-8"}, "Cache-Control": {"no-store"}}
	var result any
	switch {
	case request.Method == "GET" && request.Path == resourcePath:
		headers["Content-Type"] = []string{"text/html; charset=utf-8"}
		return okEnvelope(map[string]any{"StatusCode": 200, "Headers": headers, "Body": settingsHTML})
	case request.Method == "GET" && request.Path == apiPrefix+"/accounts":
		list, err := accounts()
		if err != nil {
			return upstreamErrorEnvelope("accounts_unavailable", "Cannot read configured Codex accounts", 503, false), nil
		}
		safe := []publicAccount{}
		for _, item := range list {
			safe = append(safe, publicAccount{item.ID, item.Label, item.Email, item.LastRefresh, item.Disabled, item.Unavailable})
		}
		result = map[string]any{"accounts": safe}
	case request.Method == "GET" && request.Path == apiPrefix+"/settings":
		state.Lock()
		result = state.selected
		state.Unlock()
	case request.Method == "PUT" && request.Path == apiPrefix+"/settings":
		var next selection
		decoder := json.NewDecoder(bytes.NewReader(request.Body))
		decoder.DisallowUnknownFields()
		if decoder.Decode(&next) != nil || decoder.Decode(new(any)) != io.EOF {
			status = 400
			result = map[string]string{"error": "Only selectedAuthId is accepted"}
		} else if err := saveSelection(next); err != nil {
			status = 400
			result = map[string]string{"error": err.Error()}
		} else {
			result = next
		}
	default:
		return upstreamErrorEnvelope("route_not_found", "Unknown Codex Auto Review route", 404, false), nil
	}
	body, _ := json.Marshal(result)
	return okEnvelope(map[string]any{"StatusCode": status, "Headers": headers, "Body": body})
}

type executeRequest struct {
	Model, SourceFormat, Format, Alt string
	Payload, OriginalRequest         []byte
	Headers                          map[string][]string
	Query                            map[string][]string
	StreamID                         string `json:"stream_id"`
	HostCallbackID                   string `json:"host_callback_id"`
}
type modelResponse struct {
	StatusCode int                 `json:"status_code"`
	Body       []byte              `json:"body"`
	Headers    map[string][]string `json:"headers"`
	StreamID   string              `json:"stream_id"`
}

func execute(raw []byte, stream bool) ([]byte, error) {
	var request executeRequest
	if json.Unmarshal(raw, &request) != nil {
		return nil, fmt.Errorf("invalid executor request")
	}
	if request.Model != reviewModel {
		return upstreamErrorEnvelope("model_not_supported", "This plugin only serves codex-auto-review", 400, false), nil
	}
	state.Lock()
	id := state.selected.SelectedAuthID
	stopping := state.stopping
	problem := state.problem
	state.Unlock()
	if stopping {
		return upstreamErrorEnvelope("plugin_stopping", "Codex Auto Review is stopping", 503, false), nil
	}
	if problem != "" {
		return upstreamErrorEnvelope("review_account_unavailable", problem, 503, false), nil
	}
	if err := validateAccount(id); err != nil {
		return upstreamErrorEnvelope("review_account_unavailable", err.Error(), 503, false), nil
	}
	format := request.Format
	if format == "" {
		format = request.SourceFormat
	}
	if format == "" {
		format = "openai"
	}
	if format != "openai" && format != "openai-response" {
		return upstreamErrorEnvelope("unsupported_format", "Use OpenAI Chat Completions or Responses", 400, false), nil
	}
	body := request.Payload
	if len(body) == 0 {
		body = request.OriginalRequest
	}
	var payload map[string]json.RawMessage
	if json.Unmarshal(body, &payload) != nil || payload == nil {
		return upstreamErrorEnvelope("invalid_request", "A JSON review request is required", 400, false), nil
	}
	payload["model"], _ = json.Marshal(reviewModel)
	payload["stream"], _ = json.Marshal(stream)
	body, _ = json.Marshal(payload)
	method := "host.model.execute"
	if stream {
		method = "host.model.execute_stream"
		if request.StreamID == "" {
			return errorEnvelope("invalid_stream", "stream_id is required"), nil
		}
	}
	forwarded := map[string]any{"entry_protocol": format, "exit_protocol": format, "model": reviewModel, "stream": stream,
		"body": body, "headers": request.Headers, "query": request.Query, "alt": request.Alt, "forced_provider": "codex", "auth_id": id, "host_callback_id": request.HostCallbackID}
	rawResult, err := hostCall(method, forwarded)
	if err != nil {
		return upstreamErrorEnvelope("review_execution_failed", "The selected Codex account could not complete the review; no other account was used", 503, false), nil
	}
	var response modelResponse
	if json.Unmarshal(rawResult, &response) != nil {
		return errorEnvelope("invalid_host_response", "Invalid native review response"), nil
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return upstreamErrorEnvelope("review_execution_failed", "The selected Codex account rejected the review; no other account was used", response.StatusCode, false), nil
	}
	if response.Headers == nil {
		response.Headers = map[string][]string{}
	}
	response.Headers["X-Codex-Review-Auth-Id"] = []string{id}
	if !stream {
		return okEnvelope(map[string]any{"Payload": response.Body, "Headers": response.Headers})
	}
	if response.StreamID == "" {
		return errorEnvelope("invalid_stream", "Native review stream is missing"), nil
	}
	state.Lock()
	if state.stopping {
		state.Unlock()
		_, _ = hostCall("host.model.stream_close", map[string]string{"stream_id": response.StreamID})
		return errorEnvelope("plugin_stopping", "Codex Auto Review is stopping"), nil
	}
	state.streams[response.StreamID] = true
	state.wait.Add(1)
	state.Unlock()
	go relayStream(response.StreamID, request.StreamID)
	return okEnvelope(map[string]any{"headers": response.Headers})
}
func relayStream(nativeID, clientID string) {
	defer func() {
		_, _ = hostCall("host.model.stream_close", map[string]string{"stream_id": nativeID})
		state.Lock()
		delete(state.streams, nativeID)
		state.Unlock()
		state.wait.Done()
	}()
	message := ""
	for {
		raw, err := hostCall("host.model.stream_read", map[string]string{"stream_id": nativeID})
		if err != nil {
			message = "The selected Codex review stream ended unexpectedly"
			break
		}
		var chunk struct {
			Payload []byte `json:"payload"`
			Error   string `json:"error"`
			Done    bool   `json:"done"`
		}
		if json.Unmarshal(raw, &chunk) != nil {
			message = "Invalid native review stream"
			break
		}
		if chunk.Error != "" {
			message = "The selected Codex review stream failed; no other account was used"
			break
		}
		if len(chunk.Payload) > 0 {
			if _, err = hostCall("host.stream.emit", map[string]any{"stream_id": clientID, "payload": chunk.Payload}); err != nil {
				break
			}
		}
		if chunk.Done {
			break
		}
	}
	_, _ = hostCall("host.stream.close", map[string]string{"stream_id": clientID, "error": message})
}
func quiesce() {
	state.Lock()
	state.stopping = true
	ids := []string{}
	for id := range state.streams {
		ids = append(ids, id)
	}
	state.Unlock()
	for _, id := range ids {
		_, _ = hostCall("host.model.stream_close", map[string]string{"stream_id": id})
	}
	state.wait.Wait()
}
func handleMethod(method string, raw []byte) ([]byte, error) {
	switch method {
	case "plugin.register", "plugin.reconfigure":
		if err := configure(raw); err != nil {
			// Keep the exact-model route active so bad settings cannot fall back to another account.
			state.Lock()
			state.dir, state.problem, state.selected, state.stopping = "", err.Error(), selection{}, false
			state.Unlock()
		}
		return okEnvelope(registration())
	case "plugin.quiesce", "plugin.shutdown":
		quiesce()
		return okEnvelope(map[string]any{})
	case "management.register":
		return okEnvelope(managementRegistration())
	case "management.handle":
		return management(raw)
	case "executor.identifier":
		return okEnvelope(map[string]string{"identifier": pluginID})
	case "model.route":
		var request struct{ RequestedModel string }
		if json.Unmarshal(raw, &request) != nil {
			return nil, fmt.Errorf("invalid model route")
		}
		if request.RequestedModel != reviewModel {
			return okEnvelope(map[string]any{"Handled": false})
		}
		return okEnvelope(map[string]any{"Handled": true, "TargetKind": "self"})
	case "executor.execute":
		return execute(raw, false)
	case "executor.execute_stream":
		return execute(raw, true)
	default:
		return upstreamErrorEnvelope("unsupported_method", "Unsupported Codex Auto Review method", 501, false), nil
	}
}
