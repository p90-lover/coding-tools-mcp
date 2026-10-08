package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func result(t *testing.T, b []byte) json.RawMessage {
	t.Helper()
	var e envelope
	if err := json.Unmarshal(b, &e); err != nil {
		t.Fatal(err)
	}
	if !e.OK {
		t.Fatalf("native call failed: %+v", e.Error)
	}
	return e.Result
}
func TestSSEPreservesReasoningToolsAndUsage(t *testing.T) {
	wire := ": keepalive\n\ndata: {\"choices\":[{\"delta\":{\"reasoning_content\":\"reason\",\"tool_calls\":[{\"id\":\"call_1\"}]}}]}\n\ndata: {\"choices\":[],\"usage\":{\"completion_tokens\":1}}\n\ndata: [DONE]\n\n"
	var chunks [][]byte
	if e := relaySSE(strings.NewReader(wire), func(b []byte) error { chunks = append(chunks, append([]byte(nil), b...)); return nil }); e != nil {
		t.Fatal(e)
	}
	if len(chunks) != 2 || !bytes.Contains(chunks[0], []byte("reasoning_content")) || !bytes.Contains(chunks[0], []byte("tool_calls")) || !bytes.Contains(chunks[1], []byte("usage")) {
		t.Fatalf("lost stream payload: %q", chunks)
	}
}
func TestFullNativeProviderConsoleAndLifecycle(t *testing.T) {
	runtime := os.Getenv("CLINE_TEST_RUNTIME")
	if runtime == "" {
		t.Fatal("CLINE_TEST_RUNTIME is required")
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer fixture-cline-key" {
			http.Error(w, "wrong upstream route/credential", 401)
			return
		}
		var body map[string]any
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			http.Error(w, "invalid body", 400)
			return
		}
		if body["model"] != "cline-pass/fixture" {
			http.Error(w, "wrong model", 400)
			return
		}
		if options, ok := body["providerOptions"].(map[string]any); ok && options["gateway"] != nil {
			w.WriteHeader(500)
			fmt.Fprint(w, `{"error":"empty response content","success":false}`)
			return
		}
		if stream, _ := body["stream"].(bool); stream {
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, ": keepalive\n\n")
			w.(http.Flusher).Flush()
			time.Sleep(10 * time.Millisecond)
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"OK\",\"reasoning_content\":\"think\"}}]}\n\ndata: [DONE]\n\n")
		} else {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"id":"fixture","choices":[{"message":{"role":"assistant","content":"OK","provider_metadata":{"gateway":{"routing":{"finalProvider":"openai-compatible-private","canonicalSlug":"private/fixture","fallbacksAvailable":[]}}}}}],"usage":{"total_tokens":2}}`)
		}
	}))
	defer upstream.Close()
	dir := t.TempDir()
	data := map[string]any{"accounts": []map[string]any{{"key": "fixture-cline-key", "name": "Fixture", "enabled": true}},
		"knownModels": []string{"cline-pass/fixture"}, "upstreamBase": upstream.URL + "/v1"}
	b, _ := json.Marshal(data)
	if e := os.WriteFile(filepath.Join(dir, "config.json"), b, 0600); e != nil {
		t.Fatal(e)
	}
	cfg := fmt.Sprintf("runtime-executable: %q\ndata-dir: %q\nproxy-url: \"\"\n", runtime, dir)
	req, _ := json.Marshal(map[string]any{"config_yaml": []byte(cfg)})
	registered, e := handleMethod("plugin.register", req)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(quiesce)
	if !bytes.Contains(result(t, registered), []byte(`"management_api":true`)) {
		t.Fatal("missing management capability")
	}
	catalog, e := handleMethod("model.for_auth", []byte("{}"))
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Contains(result(t, catalog), []byte("cline-pass/fixture")) {
		t.Fatal("missing live local catalog")
	}
	_, _, probeBody, probeErr := readLocal("POST", "/api/probe", []byte(`{"model":"cline-pass/fixture"}`))
	if probeErr != nil {
		t.Fatal(probeErr)
	}
	var discovered struct {
		Upstreams []string `json:"upstreams"`
	}
	if err := json.Unmarshal(probeBody, &discovered); err != nil {
		t.Fatal(err)
	}
	if len(discovered.Upstreams) != 1 || discovered.Upstreams[0] != "openai-compatible-private" {
		t.Fatalf("observed successful provider missing: %s", probeBody)
	}
	marker := []byte(`{"type":"cline","switcher":true}`)
	authReq, _ := json.Marshal(map[string]any{"RawJSON": marker, "FileName": "cline-pass-switcher.json"})
	parsed, e := handleMethod("auth.parse", authReq)
	if e != nil {
		t.Fatal(e)
	}
	if !bytes.Contains(result(t, parsed), []byte(`"Provider":"cline"`)) {
		t.Fatal("missing native provider")
	}
	resourceReq, _ := json.Marshal(map[string]any{"Method": "GET", "Path": resourcePrefix + "/index.html"})
	resource, e := handleMethod("management.handle", resourceReq)
	if e != nil {
		t.Fatal(e)
	}
	var page struct {
		StatusCode int
		Body       []byte
	}
	if e := json.Unmarshal(result(t, resource), &page); e != nil {
		t.Fatal(e)
	}
	if page.StatusCode != 200 || !bytes.Contains(page.Body, []byte(apiPrefix)) || !bytes.Contains(page.Body, []byte("账号")) {
		t.Fatal("full console/CPA API mapping missing")
	}
	if !bytes.Contains(page.Body, []byte("localStorage.setItem('cps_key'")) {
		t.Error("managed console key bootstrap missing")
	}
	_, _, meta, metaErr := readLocal("GET", "/api/meta", nil)
	if metaErr != nil || bytes.Contains(meta, []byte("127.0.0.1:0/v1")) {
		t.Error("console proxy URL uses port zero")
	}
	forbidden, _ := json.Marshal(map[string]any{"Method": "GET", "Path": "/v0/management/config"})
	rejected, e := management(forbidden)
	if e != nil {
		t.Fatal(e)
	}
	var reject envelope
	_ = json.Unmarshal(rejected, &reject)
	if reject.Error == nil || reject.Error.HTTPStatus != 404 {
		t.Fatal("management route escape was allowed")
	}
	payload := []byte(`{"model":"cline-pass/fixture","messages":[{"role":"user","content":"Say OK"}],"max_tokens":4}`)
	execReq, _ := json.Marshal(map[string]any{"Payload": payload, "Model": "cline-pass/fixture"})
	output, e := execute(execReq, false)
	if e != nil {
		t.Fatal(e)
	}
	var completion struct{ Payload []byte }
	if e := json.Unmarshal(result(t, output), &completion); e != nil {
		t.Fatal(e)
	}
	if !bytes.Contains(completion.Payload, []byte(`"content":"OK"`)) {
		t.Fatalf("wrong inference response: %s", completion.Payload)
	}
	oldHost := hostCall
	t.Cleanup(func() { hostCall = oldHost })
	chunks := make(chan []byte, 8)
	closed := make(chan struct{}, 1)
	hostCall = func(method string, payload any) (json.RawMessage, error) {
		b, _ := json.Marshal(payload)
		if method == "host.stream.emit" {
			var p struct{ Payload []byte }
			_ = json.Unmarshal(b, &p)
			chunks <- p.Payload
		}
		if method == "host.stream.close" {
			closed <- struct{}{}
		}
		return json.RawMessage("{}"), nil
	}
	streamReq, _ := json.Marshal(map[string]any{"Payload": payload, "Model": "cline-pass/fixture", "stream_id": "fixture-stream"})
	stream, e := execute(streamReq, true)
	if e != nil {
		t.Fatal(e)
	}
	result(t, stream)
	select {
	case <-closed:
	case <-time.After(10 * time.Second):
		t.Fatal("native stream did not close")
	}
	select {
	case chunk := <-chunks:
		if !bytes.Contains(chunk, []byte("reasoning_content")) {
			t.Fatal("lost native streaming reasoning")
		}
	default:
		t.Fatal("native stream emitted no chunks")
	}
	runtimeMu.Lock()
	s := active
	runtimeMu.Unlock()
	if s == nil {
		t.Fatal("managed child missing")
	}
	quiesce()
	select {
	case <-s.done:
	default:
		t.Fatal("managed child remained after shutdown")
	}
}
