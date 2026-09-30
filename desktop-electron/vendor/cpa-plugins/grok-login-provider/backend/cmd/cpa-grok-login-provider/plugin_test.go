package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/chenyme/grok2api/backend/internal/domain/account"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

func testRuntime(t *testing.T) *grokRuntime {
	t.Helper()
	currentConfig.Store(nil)
	resetRuntime()
	rt, err := getRuntime()
	if err != nil {
		t.Fatalf("runtime: %v", err)
	}
	return rt
}

func decodeEnvelope(t *testing.T, raw []byte) envelope {
	t.Helper()
	var env envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("envelope: %v (%s)", err, raw)
	}
	return env
}

func TestRegistrationDeclaresGrokProviderAndAllTextFormats(t *testing.T) {
	raw, err := handleMethod("plugin.register", []byte(`{"config_yaml":null,"schema_version":6}`))
	if err != nil {
		t.Fatal(err)
	}
	env := decodeEnvelope(t, raw)
	var reg map[string]any
	_ = json.Unmarshal(env.Result, &reg)
	caps := reg["capabilities"].(map[string]any)
	for _, key := range []string{"auth_provider", "model_provider", "executor"} {
		if caps[key] != true {
			t.Fatalf("capability %s = %v", key, caps[key])
		}
	}
	if got := caps["executor_input_formats"].([]any); len(got) != 3 {
		t.Fatalf("input formats = %v", got)
	}
	id, _ := handleMethod("auth.identifier", nil)
	if !strings.Contains(string(id), `"identifier":"grok"`) {
		t.Fatalf("identifier = %s", id)
	}
}

func TestConfigRejectsBadValues(t *testing.T) {
	for _, bad := range []string{"statsig-mode: magic", "sso-default-target: everything", "web-base-url: ftp://grok.com", "quality-guard: {hold-timeout: soon}"} {
		if _, err := decodeConfig([]byte(bad)); err == nil {
			t.Fatalf("config %q accepted", bad)
		}
	}
	cfg, err := decodeConfig([]byte("quality-guard: {enabled: false}\nweb-base-url: https://grok.com/\n"))
	if err != nil || cfg.WebBaseURL != "https://grok.com" || cfg.qualityRuntime().Enabled {
		t.Fatalf("cfg=%+v err=%v", cfg, err)
	}
	if !defaultPluginConfig().qualityRuntime().Enabled {
		t.Fatal("anti-downgrade guard must default on")
	}
}

func TestStorageValidationAndFileNames(t *testing.T) {
	if _, err := decodeStorage([]byte(`{"type":"grok","grok_upstream":"web"}`)); err == nil {
		t.Fatal("web auth without sso_token accepted")
	}
	value, err := decodeStorage([]byte(`{"type":"grok","grok_upstream":"BUILD","refresh_token":"r","email":"Dev.User@Example.com"}`))
	if err != nil || value.Upstream != upstreamBuild {
		t.Fatalf("value=%+v err=%v", value, err)
	}
	if got := value.fileName(); got != "grok-build-dev.user-example.com.json" {
		t.Fatalf("file name = %q", got)
	}
	if stableCredentialID(value.identity()) == 0 {
		t.Fatal("credential id must be non-zero")
	}
}

func TestPatchStoragePreservesCPAKeys(t *testing.T) {
	original := []byte(`{"type":"grok","grok_upstream":"build","access_token":"old","refresh_token":"r","priority":7,"prefix":"team"}`)
	value, _ := decodeStorage(original)
	value.AccessToken = "new"
	var merged map[string]any
	_ = json.Unmarshal(patchStorage(original, value), &merged)
	if merged["access_token"] != "new" || merged["priority"] != float64(7) || merged["prefix"] != "team" {
		t.Fatalf("merged = %v", merged)
	}
}

func TestParseAuthIgnoresForeignFilesAndHandlesGrokFiles(t *testing.T) {
	testRuntime(t)
	request := func(provider, rawJSON string) envelope {
		raw, _ := json.Marshal(pluginapi.AuthParseRequest{Provider: provider, FileName: "f.json", RawJSON: []byte(rawJSON)})
		out, err := parseAuth(raw)
		if err != nil {
			t.Fatal(err)
		}
		return decodeEnvelope(t, out)
	}
	foreign := request("", `{"access_token":"a","refresh_token":"r"}`)
	if !strings.Contains(string(foreign.Result), `"Handled":false`) {
		t.Fatalf("foreign file handled: %s", foreign.Result)
	}
	if other := request("codex", `{"type":"grok","grok_upstream":"web","sso_token":"s"}`); !strings.Contains(string(other.Result), `"Handled":false`) {
		t.Fatal("parse for another provider must not be handled")
	}
	own := request("grok", `{"type":"grok","grok_upstream":"web","sso_token":"s","email":"a@b.c"}`)
	var parsed pluginapi.AuthParseResponse
	_ = json.Unmarshal(own.Result, &parsed)
	if !parsed.Handled || parsed.Auth.Provider != "grok" || parsed.Auth.Attributes["grok_upstream"] != "web" {
		t.Fatalf("parsed = %+v", parsed)
	}
	if !parsed.Auth.NextRefreshAfter.After(time.Now().Add(300 * 24 * time.Hour)) {
		t.Fatal("sso auth must not be scheduled for refresh")
	}
	broken := request("grok", `{"type":"grok","grok_upstream":"build"}`)
	if broken.OK || broken.Error == nil || broken.Error.HTTPStatus != 400 {
		t.Fatalf("broken grok file = %+v", broken)
	}
}

func TestParseAuthGivesEachImportedAccountItsOwnID(t *testing.T) {
	testRuntime(t)
	raw, _ := json.Marshal(pluginapi.AuthParseRequest{FileName: "multi.json", RawJSON: []byte(
		`{"provider":"grok_console","accounts":[{"name":"one","sso_token":"a.b.c"},{"name":"two","sso_token":"d.e.f"}]}`)})
	out, err := parseAuth(raw)
	if err != nil {
		t.Fatal(err)
	}
	var parsed pluginapi.AuthParseResponse
	_ = json.Unmarshal(decodeEnvelope(t, out).Result, &parsed)
	if len(parsed.Auths) != 2 || parsed.Auths[0].ID == "" || parsed.Auths[0].ID == parsed.Auths[1].ID {
		t.Fatalf("auths = %+v, want two distinct IDs", parsed.Auths)
	}
	again, _ := parseAuth(raw)
	var reparsed pluginapi.AuthParseResponse
	_ = json.Unmarshal(decodeEnvelope(t, again).Result, &reparsed)
	if reparsed.Auths[0].ID != parsed.Auths[0].ID {
		t.Fatal("IDs must be stable across re-parses")
	}
}

func TestNextRefreshSchedulesBuildBeforeExpiry(t *testing.T) {
	expires := time.Now().Add(2 * time.Hour).UTC()
	value := grokStorage{Upstream: upstreamBuild, AccessToken: "a", RefreshToken: "r", ExpiresAt: expires.Format(time.RFC3339Nano)}
	if got := nextRefresh(value); !got.Equal(expires.Add(-oauthRefreshLead)) {
		t.Fatalf("next refresh = %v", got)
	}
	value.AccessToken = ""
	if got := nextRefresh(value); time.Until(got) > time.Second {
		t.Fatal("refresh-token-only import must refresh immediately")
	}
}

func TestPumpSSEFramesChatAsBareJSONAndResponsesAsEvents(t *testing.T) {
	stream := ": grok2api-reasoning-start\n\ndata: {\"a\":1}\n\ndata: {\"b\":2}\n\ndata: [DONE]\n\n"
	var chat []string
	if err := pumpSSE(strings.NewReader(stream), operationChat, func(b []byte) error { chat = append(chat, string(b)); return nil }); err != nil {
		t.Fatal(err)
	}
	if strings.Join(chat, "|") != `{"a":1}|{"b":2}` {
		t.Fatalf("chat chunks = %q", chat)
	}
	responses := "event: response.created\ndata: {\"x\":1}\n\n: keepalive\n\nevent: response.completed\ndata: {\"y\":2}"
	var events []string
	if err := pumpSSE(strings.NewReader(responses), operationResponses, func(b []byte) error { events = append(events, string(b)); return nil }); err != nil {
		t.Fatal(err)
	}
	want := []string{"event: response.created\ndata: {\"x\":1}\n\n", "event: response.completed\ndata: {\"y\":2}\n\n"}
	if len(events) != 2 || events[0] != want[0] || events[1] != want[1] {
		t.Fatalf("responses events = %q", events)
	}
}

// A downgraded Grok reasoning model streams its answer with no reasoning deltas; the guard
// must withhold it so CPA retries another account.
func TestQualityHoldWithholdsAnswerWithoutReasoning(t *testing.T) {
	var sse bytes.Buffer
	for i := 0; i < 20; i++ {
		sse.WriteString(`data: {"type":"response.output_text.delta","delta":"The answer is forty-two. "}` + "\n\n")
	}
	sse.WriteString(`data: {"type":"response.completed","response":{"usage":{"output_tokens":120,"output_tokens_details":{"reasoning_tokens":0}}}}` + "\n\n")
	cfg := defaultPluginConfig().qualityRuntime()
	body, verdict, _, _, err := peekQualityStream(context.Background(), io.NopCloser(&sse), qualityProtocolResponses, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()
	if verdict != QualityWithhold {
		t.Fatalf("verdict = %s, want withhold", verdict)
	}
}

func TestQualityHoldDeliversStreamedReasoningAndReplaysPrefix(t *testing.T) {
	stream := `data: {"type":"response.reasoning_text.delta","delta":"Let me think."}` + "\n\n" +
		`data: {"type":"response.output_text.delta","delta":"Hi"}` + "\n\n"
	cfg := defaultPluginConfig().qualityRuntime()
	body, verdict, _, _, err := peekQualityStream(context.Background(), io.NopCloser(strings.NewReader(stream)), qualityProtocolResponses, cfg)
	if err != nil || verdict != QualityDeliver {
		t.Fatalf("verdict=%s err=%v", verdict, err)
	}
	replayed, _ := io.ReadAll(body)
	if string(replayed) != stream {
		t.Fatalf("held prefix not replayed intact: %q", replayed)
	}
}

func TestWithholdTrackerFollowsAttemptBudget(t *testing.T) {
	tracker := &withholdTracker{entries: map[string]withholdEntry{}}
	cfg := normalizeQualityRetry(QualityRetryRuntime{Enabled: true, MaxAttempts: 3, OnExhausted: "fail_closed"})
	got := []QualityRetryAction{tracker.record("k", cfg), tracker.record("k", cfg), tracker.record("k", cfg)}
	if got[0] != QualityActionRetry || got[1] != QualityActionRetry || got[2] != QualityActionReject {
		t.Fatalf("fail_closed actions = %v", got)
	}
	cfg.OnExhausted = "fail_open"
	for i := 0; i < 2; i++ {
		tracker.record("open", cfg)
	}
	if last := tracker.record("open", cfg); last != QualityActionDeliverLast {
		t.Fatalf("fail_open last action = %s", last)
	}
}

func TestQualityGuardScope(t *testing.T) {
	call := executorCall{credential: account.Credential{Provider: account.ProviderWeb}, model: "grok-chat-expert", body: []byte(`{}`)}
	cfg := defaultPluginConfig().qualityRuntime()
	if call.qualityGuarded(cfg) {
		t.Fatal("grok2api does not guard Grok Web streams")
	}
	call.credential.Provider = account.ProviderBuild
	call.model = "grok-4.3"
	call.body = []byte(`{"reasoning_effort":"none"}`)
	if call.qualityGuarded(cfg) {
		t.Fatal("reasoning disabled by the client must not be guarded")
	}
}

func TestOperationForFormat(t *testing.T) {
	for format, want := range map[string]string{"openai": operationChat, "chat-completions": operationChat, "openai-response": operationResponses, "claude": operationMessages} {
		if got := operationForFormat(format); got != want {
			t.Fatalf("%s -> %s, want %s", format, got, want)
		}
	}
}

func TestUpstreamStatusEnvelopeClassifiesRetry(t *testing.T) {
	env := decodeEnvelope(t, upstreamStatusEnvelope(429, []byte(`{"error":{"message":"slow down"}}`)))
	if !env.Error.Retryable || env.Error.HTTPStatus != 429 || env.Error.Message != "Grok: slow down" {
		t.Fatalf("429 = %+v", env.Error)
	}
	if env := decodeEnvelope(t, upstreamStatusEnvelope(400, []byte("bad"))); env.Error.Retryable {
		t.Fatal("400 must not be retried on another account")
	}
}

func TestLoginPageGuardsPosts(t *testing.T) {
	testRuntime(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	session := &loginSession{state: "s3cret", expires: time.Now().Add(time.Minute), status: loginIdle, cancel: cancel}
	resolved := make(chan grokStorage, 4)
	resolveSSOAccount = func(_ context.Context, _ *grokRuntime, value grokStorage) (grokStorage, error) {
		resolved <- value
		value.Email = "me@example.com"
		return value, nil
	}
	defer func() {
		resolveSSOAccount = func(ctx context.Context, rt *grokRuntime, value grokStorage) (grokStorage, error) {
			return resolveSSO(ctx, rt, value)
		}
	}()
	server := httptest.NewServer(nil)
	defer server.Close()
	server.Config.Handler = session.routes(ctx, server.URL)

	post := func(state, origin string) int {
		form := url.Values{"state": {state}, "sso": {"sso=tok; sso-rw=tok"}, "target": {"web"}}
		req, _ := http.NewRequest(http.MethodPost, server.URL+"/grok/sso", strings.NewReader(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if code := post("wrong", ""); code != http.StatusForbidden {
		t.Fatalf("wrong state = %d", code)
	}
	if code := post("s3cret", "https://evil.example"); code != http.StatusForbidden {
		t.Fatalf("cross-origin = %d", code)
	}
	if code := post("s3cret", server.URL); code != http.StatusSeeOther {
		t.Fatalf("valid post = %d", code)
	}
	select {
	case value := <-resolved:
		if value.SSOToken != "tok" || value.Upstream != upstreamWeb {
			t.Fatalf("resolved = %+v", value)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("sso was not resolved")
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		session.mu.Lock()
		status, accounts := session.status, session.accounts
		session.mu.Unlock()
		if status == loginDone {
			if len(accounts) != 1 || accounts[0].Email != "me@example.com" {
				t.Fatalf("accounts = %+v", accounts)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("login did not complete")
}
