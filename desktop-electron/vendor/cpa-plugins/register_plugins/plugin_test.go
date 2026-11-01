package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const fixtureSource = "fixture-source-0001"
const fixtureToken = "fixture-bearer-not-a-real-token-00000000001"

type fixture struct {
	t             *testing.T
	mu            sync.Mutex
	auths         map[string]map[string]json.RawMessage
	saves         int
	failSave      bool
	accounts      []sourceAccount
	revision      string
	access        string
	refreshIDs    [][]int64
	paths         []string
	block         chan struct{}
	entered       chan struct{}
	loginRequired bool
}

func raw(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
func cloneAuth(a map[string]json.RawMessage) map[string]json.RawMessage {
	b, _ := json.Marshal(a)
	var copy map[string]json.RawMessage
	_ = json.Unmarshal(b, &copy)
	return copy
}
func (f *fixture) host(method string, payload any) (json.RawMessage, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	request := map[string]json.RawMessage{}
	_ = json.Unmarshal(raw(payload), &request)
	switch method {
	case "host.auth.list":
		files := []authEntry{}
		for name, auth := range f.auths {
			var disabled bool
			_ = json.Unmarshal(auth["disabled"], &disabled)
			files = append(files, authEntry{Name: name, Index: name, Disabled: disabled})
		}
		sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
		return raw(map[string]any{"files": files}), nil
	case "host.auth.get":
		var name string
		_ = json.Unmarshal(request["auth_index"], &name)
		return raw(map[string]any{"name": name, "json": f.auths[name]}), nil
	case "host.auth.save":
		if f.failSave {
			return nil, errors.New("secret fixture should never be exposed")
		}
		var name string
		_ = json.Unmarshal(request["name"], &name)
		var auth map[string]json.RawMessage
		_ = json.Unmarshal(request["json"], &auth)
		f.saves++
		f.auths[name] = auth
		return raw(map[string]string{"name": name}), nil
	default:
		f.t.Fatalf("unexpected host capability %s", method)
		return nil, nil
	}
}
func (f *fixture) serve(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+fixtureToken || r.Header.Get("Origin") != "" {
		f.t.Error("missing private bearer or unexpected browser origin")
		w.WriteHeader(401)
		return
	}
	f.mu.Lock()
	f.paths = append(f.paths, r.Method+" "+r.URL.Path)
	f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	response := map[string]any{"source_id": fixtureSource}
	switch r.URL.Path {
	case "/v1/status", "/v1/start":
		response["ready"] = true
		response["owned"] = true
	case "/v1/accounts":
		response["accounts"] = f.accounts
	case "/v1/export":
		var request struct {
			IDs []int64 `json:"ids"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		if !validIDs(request.IDs) {
			f.t.Error("export IDs were not explicit")
		}
		if f.entered != nil {
			select {
			case f.entered <- struct{}{}:
			default:
			}
		}
		if f.block != nil {
			select {
			case <-f.block:
			case <-r.Context().Done():
				return
			}
		}
		files := []exportedFile{}
		for _, id := range request.IDs {
			files = append(files, exportedFile{ID: id, Revision: f.revision, JSON: map[string]json.RawMessage{"type": raw("codex"), "email": raw("fixture@example.invalid"), "access_token": raw(f.access), "refresh_token": raw("fixture-refresh")}})
		}
		response["files"] = files
	case "/v1/refresh":
		var request struct {
			IDs []int64 `json:"ids"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		f.mu.Lock()
		f.refreshIDs = append(f.refreshIDs, request.IDs)
		f.mu.Unlock()
		results := []map[string]any{}
		for _, id := range request.IDs {
			results = append(results, map[string]any{"id": id, "ok": !f.loginRequired, "requires_login": f.loginRequired, "error": "fixture token secret never forwarded"})
		}
		if !f.loginRequired {
			f.revision = "revision-2"
			f.access = "fixture-renewed"
		}
		response["results"] = results
	default:
		w.WriteHeader(404)
		return
	}
	_ = json.NewEncoder(w).Encode(response)
}
func setup(t *testing.T) (*engine, *fixture) {
	t.Helper()
	f := &fixture{t: t, auths: map[string]map[string]json.RawMessage{}, accounts: []sourceAccount{{ID: 1, Email: "fixture@example.invalid", Eligible: true, Revision: "revision-1"}, {ID: 2, Email: "other@example.invalid", Eligible: true, Revision: "revision-1"}}, revision: "revision-1", access: "fixture-original"}
	server := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(server.Close)
	dir := t.TempDir()
	path := filepath.Join(dir, "bridge.json")
	if err := os.WriteFile(path, raw(descriptor{SchemaVersion: 1, URL: server.URL, Token: fixtureToken, SourceID: fixtureSource}), 0600); err != nil {
		t.Fatal(err)
	}
	e, err := newEngine(pluginConfig{Descriptor: path, DataDir: filepath.Join(dir, "private")})
	if err != nil {
		t.Fatal(err)
	}
	before := hostCall
	hostCall = f.host
	t.Cleanup(func() { hostCall = before })
	go e.schedule()
	t.Cleanup(e.close)
	return e, f
}
func expectStates(t *testing.T, results []jobResult, states ...string) {
	t.Helper()
	got := []string{}
	for _, r := range results {
		got = append(got, r.State)
	}
	if !reflect.DeepEqual(got, states) {
		t.Fatalf("states %v, want %v", got, states)
	}
}

func TestImportsAreIdempotentAndPreserveCPARotations(t *testing.T) {
	e, f := setup(t)
	results, err := e.run([]int64{1}, false, false)
	if err != nil {
		t.Fatal(err)
	}
	expectStates(t, results, "imported")
	results, err = e.run([]int64{1}, false, false)
	if err != nil {
		t.Fatal(err)
	}
	expectStates(t, results, "unchanged")
	name := authName(fixtureSource, 1)
	f.auths[name]["access_token"] = raw("fixture-CPA-rotated")
	results, err = e.run([]int64{1}, false, false)
	if err != nil {
		t.Fatal(err)
	}
	expectStates(t, results, "cpa_newer")
	f.revision = "revision-2"
	f.access = "fixture-source-newer-but-not-CPA"
	results, err = e.run([]int64{1}, false, false)
	if err != nil {
		t.Fatal(err)
	}
	expectStates(t, results, "cpa_newer")
	if f.saves != 1 || string(f.auths[name]["access_token"]) != `"fixture-CPA-rotated"` {
		t.Fatal("CPA rotated token was overwritten")
	}
	encoded, _ := json.Marshal(e.status())
	if strings.Contains(string(encoded), "fixture-CPA-rotated") || strings.Contains(string(encoded), fixtureToken) {
		t.Fatal("status leaked credentials")
	}
	loaded, err := newEngine(e.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.state.Imported[ledgerKey(fixtureSource, 1)] != "revision-1" {
		t.Fatal("revision ledger was not persisted")
	}
	loaded.cancel()
}

func TestDisabledForeignAndRoutingSettingsArePreserved(t *testing.T) {
	e, f := setup(t)
	if _, err := e.run([]int64{1}, false, false); err != nil {
		t.Fatal(err)
	}
	name := authName(fixtureSource, 1)
	f.auths[name]["disabled"] = raw(true)
	f.revision = "revision-2"
	results, err := e.run([]int64{1}, false, false)
	if err != nil {
		t.Fatal(err)
	}
	expectStates(t, results, "disabled")
	f.auths[authName(fixtureSource, 2)] = map[string]json.RawMessage{"type": raw("codex"), "access_token": raw("foreign-secret")}
	results, err = e.run([]int64{2}, false, false)
	if err != nil {
		t.Fatal(err)
	}
	expectStates(t, results, "conflict")
	f.auths[name]["disabled"] = raw(false)
	f.auths[name]["priority"] = raw(17)
	f.auths[name]["prefix"] = raw("keep-me")
	results, err = e.run([]int64{1}, false, false)
	if err != nil {
		t.Fatal(err)
	}
	expectStates(t, results, "imported")
	if string(f.auths[name]["priority"]) != "17" || string(f.auths[name]["prefix"]) != `"keep-me"` || f.saves != 2 {
		t.Fatal("CPA settings were lost")
	}
}

func TestRefreshOnlyOwnActiveAccountsAndImportsSuccessfulRotation(t *testing.T) {
	e, f := setup(t)
	if _, err := e.run([]int64{1}, false, false); err != nil {
		t.Fatal(err)
	}
	results, err := e.run([]int64{1, 2}, true, false)
	if err != nil {
		t.Fatal(err)
	}
	expectStates(t, results, "missing", "imported")
	if !reflect.DeepEqual(f.refreshIDs, [][]int64{{1}}) || f.saves != 2 {
		t.Fatalf("wrong renewal scope: %v saves%d", f.refreshIDs, f.saves)
	}
	f.loginRequired = true
	results, err = e.run([]int64{1}, true, false)
	if err != nil {
		t.Fatal(err)
	}
	expectStates(t, results, "requires_login")
	if f.saves != 2 {
		t.Fatal("login-required refresh wrote credentials")
	}
	f.auths[authName(fixtureSource, 1)]["disabled"] = raw(true)
	results, err = e.run([]int64{1}, true, false)
	if err != nil {
		t.Fatal(err)
	}
	expectStates(t, results, "disabled")
	if len(f.refreshIDs) != 2 {
		t.Fatal("disabled CPA credential was renewed")
	}
}

func TestFailedSaveDoesNotAdvanceSourceRevision(t *testing.T) {
	e, f := setup(t)
	f.failSave = true
	_, err := e.run([]int64{1}, false, false)
	if !errors.Is(err, errStorage) {
		t.Fatalf("error %v", err)
	}
	if len(e.state.Imported) != 0 {
		t.Fatal("failed save advanced revision")
	}
	if strings.Contains(e.lastError, "secret") {
		t.Fatal("error leaked host payload")
	}
	f.failSave = false
	results, err := e.run([]int64{1}, false, false)
	if err != nil {
		t.Fatal(err)
	}
	expectStates(t, results, "imported")
}

func TestJobsRequireExplicitEligibleIDsAndAutomationStartsOff(t *testing.T) {
	e, f := setup(t)
	for _, ids := range [][]int64{nil, {}, {0}, {-1}, {1, 1}, {9007199254740992}} {
		if _, err := e.run(ids, false, false); err == nil {
			t.Fatalf("accepted IDs%v", ids)
		}
	}
	if _, err := e.run(nil, false, true); err != nil {
		t.Fatal(err)
	}
	if len(f.paths) != 0 || e.state.Settings.AutoImport || e.state.Settings.AutoRefresh {
		t.Fatal("automation performed work before opt-in")
	}
	if _, err := e.run([]int64{99}, false, false); err == nil {
		t.Fatal("accepted foreign account")
	}
	e.mu.Lock()
	e.state.Settings.AutoRefresh = true
	e.mu.Unlock()
	if _, err := e.run(nil, false, true); err != nil {
		t.Fatal(err)
	}
	if f.saves != 0 || len(f.refreshIDs) != 0 {
		t.Fatal("auto refresh touched nonimported accounts")
	}
	e.mu.Lock()
	e.state.Settings.AutoImport = true
	e.state.Settings.AutoRefresh = false
	e.mu.Unlock()
	if _, err := e.run(nil, false, true); err != nil {
		t.Fatal(err)
	}
	if f.saves != 2 {
		t.Fatal("auto import did not import eligible records")
	}
}

func TestShutdownCancelsJobsAndSingleFlightRejectsOverlap(t *testing.T) {
	e, f := setup(t)
	f.block = make(chan struct{})
	f.entered = make(chan struct{}, 1)
	done := make(chan error, 1)
	go func() { _, err := e.run([]int64{1}, false, false); done <- err }()
	select {
	case <-f.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("export never started")
	}
	if _, err := e.run([]int64{1}, false, false); !errors.Is(err, errBusy) {
		t.Fatalf("overlap %v", err)
	}
	start := time.Now()
	e.close()
	if time.Since(start) > 2*time.Second {
		t.Fatal("shutdown did not cancel promptly")
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("canceled export succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("job survived shutdown")
	}
	if f.saves != 0 {
		t.Fatal("shutdown job saved auth")
	}
}

func TestBridgeRejectsUnsafeDescriptorsRedirectsAndSourceChanges(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bridge.json")
	for _, url := range []string{"http://localhost:12", "http://127.0.0.1", "http://127.0.0.1:12/other", "http://127.0.0.1:12?x=1", "http://127.0.0.1:12#secret", "http://user:secret@127.0.0.1:12", "https://127.0.0.1:12", "http://127.0.0.2:12", "http://127.0.0.1:0012"} {
		_ = os.WriteFile(path, raw(descriptor{SchemaVersion: 1, URL: url, Token: fixtureToken, SourceID: fixtureSource}), 0600)
		if _, err := openBridge(path); err == nil {
			t.Fatalf("accepted unsafe URL%s", url)
		}
	}
	var followed atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { followed.Store(true) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 302) }))
	defer server.Close()
	_ = os.WriteFile(path, raw(descriptor{SchemaVersion: 1, URL: server.URL, Token: fixtureToken, SourceID: fixtureSource}), 0600)
	b, err := openBridge(path)
	if err != nil {
		t.Fatal(err)
	}
	if b.request(context.Background(), "GET", "/v1/status", nil, new(sourceStatus)) == nil || followed.Load() {
		t.Fatal("followed credential-bearing redirect")
	}
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"source_id": "different-source-0001", "ready": true})
	}))
	defer other.Close()
	_ = os.WriteFile(path, raw(descriptor{SchemaVersion: 1, URL: other.URL, Token: fixtureToken, SourceID: fixtureSource}), 0600)
	b, _ = openBridge(path)
	if b.request(context.Background(), "GET", "/v1/status", nil, new(sourceStatus)) == nil {
		t.Fatal("accepted changed source identity")
	}
}
