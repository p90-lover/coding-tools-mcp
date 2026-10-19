package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/iotest"
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

func TestDeepSeekEffortCatalogAndTransport(t *testing.T) {
	var sent map[string]any
	calls := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/models" {
			fmt.Fprint(w, `{"data":[{"id":"cline-pass/deepseek-v4.1-flash"},{"id":"cline-pass/unknown"}]}`)
			return
		}
		calls++
		if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
			t.Error(err)
		}
		fmt.Fprint(w, `{"choices":[{"message":{"content":"OK"}}]}`)
	}))
	defer upstream.Close()
	previous := active
	active = &service{base: upstream.URL, key: "fixture", ctx: context.Background(), cfg: pluginConfig{DataDir: t.TempDir()}}
	t.Cleanup(func() { active = previous })
	catalog, err := models()
	if err != nil {
		t.Fatal(err)
	}
	var listed struct {
		Models []struct {
			ID       string
			Thinking struct {
				Levels []string `json:"levels"`
			} `json:"thinking"`
		}
	}
	if err := json.Unmarshal(result(t, catalog), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Models) != 2 || strings.Join(listed.Models[0].Thinking.Levels, ",") != "none,low,high,max" {
		t.Fatalf("wrong native efforts: %s", catalog)
	}
	if len(listed.Models[1].Thinking.Levels) != 0 {
		t.Fatal("unknown model inherited generic reasoning tiers")
	}
	for _, effort := range []string{"none", "low", "high", "max"} {
		req, _ := json.Marshal(map[string]any{
			"Model":   "cline-pass/deepseek-v4.1-flash(" + effort + ")",
			"Payload": []byte(`{"model":"ignored","reasoning_effort":"xhigh","messages":[{"role":"user","content":"OK"}]}`),
		})
		reply, err := execute(req, false)
		if err != nil {
			t.Fatal(err)
		}
		result(t, reply)
		if sent["model"] != "cline-pass/deepseek-v4.1-flash" || sent["reasoning_effort"] != effort {
			t.Fatalf("%s sent wrong model/effort: %v", effort, sent)
		}
	}
	before := calls
	req, _ := json.Marshal(map[string]any{"Model": "cline-pass/deepseek-v4.1-flash(xhigh)", "Payload": []byte(`{}`)})
	reply, err := execute(req, false)
	if err != nil {
		t.Fatal(err)
	}
	var rejected envelope
	_ = json.Unmarshal(reply, &rejected)
	if rejected.OK || rejected.Error == nil || rejected.Error.HTTPStatus != 400 || calls != before {
		t.Fatal("unsupported effort was sent upstream")
	}
}

func TestSSEPreservesReasoningToolsAndUsage(t *testing.T) {
	wire := ": keepalive\n\ndata: {\"choices\":[{\"delta\":{\"reasoning_content\":\"reason\",\"tool_calls\":[{\"id\":\"call_1\"}]}}]}\n\ndata: {\"choices\":[],\"usage\":{\"completion_tokens\":1}}\n\ndata: [DONE]\n\n"
	var chunks [][]byte
	if e := relaySSE(strings.NewReader(wire), true, func(b []byte) error { chunks = append(chunks, append([]byte(nil), b...)); return nil }); e != nil {
		t.Fatal(e)
	}
	if len(chunks) != 2 || !bytes.Contains(chunks[0], []byte("reasoning_content")) || !bytes.Contains(chunks[0], []byte("tool_calls")) || !bytes.Contains(chunks[1], []byte("usage")) {
		t.Fatalf("lost stream payload: %q", chunks)
	}
}
func TestSSEFramesAreCompleteForCPAAndPreserveMultilineJSON(t *testing.T) {
	for _, wire := range []string{
		": keepalive\n\nevent: chunk\ndata: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n",
		": keepalive\r\ndata:{\"choices\": [\r\ndata: {\"delta\":{\"content\":\"OK\"}}]}\r\n\r\ndata: [DONE]\r\n\r\n",
		"data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}",
	} {
		var chunks [][]byte
		err := relaySSE(iotest.OneByteReader(strings.NewReader(wire)), true, func(b []byte) error {
			chunks = append(chunks, append([]byte(nil), b...))
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		if len(chunks) != 1 {
			t.Fatalf("expected one JSON frame; CPA host close owns DONE: %q", chunks)
		}
		if !bytes.HasPrefix(chunks[0], []byte("data: ")) || !bytes.HasSuffix(chunks[0], []byte("\n\n")) {
			t.Fatalf("missing CPA stream framing: %q", chunks[0])
		}
		payload := bytes.TrimSuffix(bytes.TrimPrefix(chunks[0], []byte("data: ")), []byte("\n\n"))
		if !json.Valid(payload) || bytes.Contains(payload, []byte("\n")) || !bytes.Contains(payload, []byte(`"content":"OK"`)) {
			t.Fatalf("multiline data was not reconstructed as one JSON event: %q", chunks[0])
		}
	}
}

func TestSSEFramingPreservesEmitAndReadFailures(t *testing.T) {
	sentinel := errors.New("fixture stream failure")
	if err := relaySSE(strings.NewReader("data: {}\n\n"), true, func([]byte) error { return sentinel }); !errors.Is(err, sentinel) {
		t.Fatalf("lost emit failure: %v", err)
	}
	reader := io.MultiReader(strings.NewReader("data: {}\n\n"), iotest.ErrReader(sentinel))
	if err := relaySSE(reader, true, func([]byte) error { return nil }); !errors.Is(err, sentinel) {
		t.Fatalf("lost read failure: %v", err)
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
	for _, requestPath := range []string{"/v1/chat/completions", "/v1/messages", "/v1/responses", "", " /v1/completions/ "} {
		streamReq, _ := json.Marshal(map[string]any{"Payload": payload, "Model": "cline-pass/fixture", "stream_id": "fixture-stream",
			"Metadata": map[string]any{"request_path": requestPath}, "SourceFormat": "openai"})
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
			framed := requestPath == "/v1/messages" || requestPath == "/v1/responses"
			if bytes.HasPrefix(chunk, []byte("data: ")) != framed {
				t.Fatalf("wrong framing for request path %q: %q", requestPath, chunk)
			}
			if !framed && !json.Valid(chunk) {
				t.Fatalf("OpenAI host requires raw JSON, got %q", chunk)
			}
		default:
			t.Fatal("native stream emitted no chunks")
		}
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

func TestDatedDeepSeekBuildsTakeTheSameEfforts(t *testing.T) {
	for _, model := range []string{"cline-pass/deepseek-v4.1-flash", "cline-pass/deepseek-v4.1-flash-1017", "cline-pass/deepseek-v4.1-flash-20261017"} {
		if got := modelEfforts(model); len(got) != 4 || got[3] != "max" {
			t.Fatalf("%s: %v", model, got)
		}
	}
	for _, model := range []string{"cline-pass/deepseek-v4.1-flash-x", "cline-pass/deepseek-v4-flash", "cline-pass/deepseek-v4.1-flash-1017(high)"} {
		if got := modelEfforts(model); got != nil {
			t.Fatalf("%s should take no effort: %v", model, got)
		}
	}
}
