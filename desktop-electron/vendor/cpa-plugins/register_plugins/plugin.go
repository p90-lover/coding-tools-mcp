package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	"gopkg.in/yaml.v3"
)

const pluginID = "register_plugins"
const apiPrefix = "/v0/management/" + pluginID
const resourcePrefix = "/v0/resource/plugins/" + pluginID
const pluginVersion = "0.1.0-codingtools.1"

//go:embed console.html
var console []byte

var hostAvailable atomic.Bool

type envelope struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *envelopeError  `json:"error,omitempty"`
}
type envelopeError struct {
	Code       string `json:"code"`
	Message    string `json:"message"`
	HTTPStatus int    `json:"http_status,omitempty"`
	Retryable  bool   `json:"retryable,omitempty"`
}

func okEnvelope(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return json.Marshal(envelope{OK: true, Result: raw})
}
func errorEnvelope(code, message string) []byte {
	return upstreamErrorEnvelope(code, message, 500, false)
}
func upstreamErrorEnvelope(code, message string, status int, retry bool) []byte {
	raw, _ := json.Marshal(envelope{Error: &envelopeError{Code: code, Message: message, HTTPStatus: status, Retryable: retry}})
	return raw
}
func unwrapHostEnvelope(method string, raw []byte, code int) (json.RawMessage, error) {
	var response envelope
	if json.Unmarshal(raw, &response) != nil || code != 0 || !response.OK {
		return nil, errors.New("CPA auth storage is unavailable")
	}
	return response.Result, nil
}

type pluginConfig struct {
	Descriptor string `yaml:"bridge-descriptor"`
	DataDir    string `yaml:"data-dir"`
}
type settings struct {
	AutoImport      bool `json:"auto_import"`
	AutoRefresh     bool `json:"auto_refresh"`
	IntervalSeconds int  `json:"interval_seconds"`
}
type savedState struct {
	SchemaVersion int               `json:"schema_version"`
	Settings      settings          `json:"settings"`
	Imported      map[string]string `json:"imported"`
}
type engine struct {
	cfg         pluginConfig
	mu          sync.Mutex
	state       savedState
	closed      bool
	busy        bool
	lastRun     string
	lastError   string
	lastResults []jobResult
	opMu        sync.Mutex
	ctx         context.Context
	cancel      context.CancelFunc
	wake        chan struct{}
	done        chan struct{}
	wg          sync.WaitGroup
}

var engineMu sync.RWMutex
var active *engine

func strictJSON(raw []byte, out any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return errors.New("invalid request")
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("invalid request")
	}
	return nil
}
func validSettings(s settings) bool { return s.IntervalSeconds >= 60 && s.IntervalSeconds <= 86400 }

func newEngine(cfg pluginConfig) (*engine, error) {
	if !filepath.IsAbs(cfg.Descriptor) || !filepath.IsAbs(cfg.DataDir) {
		return nil, errors.New("bridge-descriptor and data-dir must be absolute")
	}
	if err := os.MkdirAll(cfg.DataDir, 0700); err != nil {
		return nil, errors.New("private Register plugin directory is unavailable")
	}
	state := savedState{SchemaVersion: 1, Settings: settings{IntervalSeconds: 900}, Imported: map[string]string{}}
	path := filepath.Join(cfg.DataDir, "state.json")
	if _, err := os.Lstat(path); err == nil {
		raw, err := readBoundedFile(path, 2<<20)
		if err != nil || strictJSON(raw, &state) != nil || state.SchemaVersion != 1 || !validSettings(state.Settings) || len(state.Imported) > 10000 {
			return nil, errors.New("invalid private Register plugin state; refusing to overwrite")
		}
	} else if !os.IsNotExist(err) {
		return nil, errors.New("private Register plugin state is unavailable")
	}
	if state.Imported == nil {
		state.Imported = map[string]string{}
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &engine{cfg: cfg, state: state, ctx: ctx, cancel: cancel, wake: make(chan struct{}, 1), done: make(chan struct{})}, nil
}

func (e *engine) persistLocked() error {
	raw, err := json.MarshalIndent(e.state, "", "  ")
	if err != nil || len(raw) > 2<<20 || len(e.state.Imported) > 10000 {
		return errors.New("could not save Register plugin state")
	}
	f, err := os.CreateTemp(e.cfg.DataDir, ".state-*.json")
	if err != nil {
		return errors.New("could not save Register plugin state")
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(raw)
	}
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(name, filepath.Join(e.cfg.DataDir, "state.json"))
	}
	if err != nil {
		return errors.New("could not save Register plugin state")
	}
	return nil
}

func (e *engine) recordRevision(key, revision string) error {
	e.mu.Lock()
	defer e.mu.Unlock()
	before, exists := e.state.Imported[key]
	e.state.Imported[key] = revision
	if err := e.persistLocked(); err != nil {
		if exists {
			e.state.Imported[key] = before
		} else {
			delete(e.state.Imported, key)
		}
		return errState
	}
	return nil
}

func (e *engine) begin() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return false
	}
	e.wg.Add(1)
	return true
}
func (e *engine) close() {
	e.mu.Lock()
	if !e.closed {
		e.closed = true
		e.cancel()
	}
	e.mu.Unlock()
	<-e.done
	e.wg.Wait()
}

func configure(raw []byte) error {
	var req struct {
		ConfigYAML []byte `json:"config_yaml"`
	}
	if json.Unmarshal(raw, &req) != nil {
		return errors.New("invalid Register plugin configuration")
	}
	var cfg pluginConfig
	decoder := yaml.NewDecoder(bytes.NewReader(req.ConfigYAML))
	if decoder.Decode(&cfg) != nil {
		return errors.New("invalid Register plugin configuration")
	}
	engineMu.Lock()
	defer engineMu.Unlock()
	if active != nil && active.cfg == cfg {
		return nil
	}
	if active != nil {
		active.close()
		active = nil
	}
	e, err := newEngine(cfg)
	if err != nil {
		return err
	}
	active = e
	go e.schedule()
	return nil
}
func quiesce() {
	engineMu.Lock()
	defer engineMu.Unlock()
	if active != nil {
		active.close()
		active = nil
	}
}

func registration() any {
	return map[string]any{"schema_version": 6, "metadata": map[string]any{
		"Name": "Register", "Version": pluginVersion, "Author": "Coding Tools",
		"GitHubRepository": "https://github.com/p90-lover/coding-tools-mcp",
		"ConfigFields": []map[string]string{
			{"Name": "bridge-descriptor", "Type": "string", "Description": "Private Coding Tools Register bridge descriptor path"},
			{"Name": "data-dir", "Type": "string", "Description": "Private Register plugin automation state directory"},
		},
	}, "capabilities": map[string]any{"management_api": true}}
}

var apiRoutes = []struct{ Method, Path string }{
	{"GET", "/index.html"}, {"GET", "/api/settings"}, {"POST", "/api/settings"},
	{"GET", "/api/status"}, {"POST", "/api/sync"}, {"POST", "/api/refresh"},
}

func managementRegistration() any {
	routes := []map[string]string{}
	for _, r := range apiRoutes {
		routes = append(routes, map[string]string{"Method": r.Method, "Path": apiPrefix + r.Path})
	}
	return map[string]any{"routes": routes, "resources": []map[string]string{{"Path": "index.html", "Menu": "Register", "Description": "Import Register OAuth accounts into CPA and enable optional token renewal"}}}
}
func httpResult(status int, v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return okEnvelope(map[string]any{"StatusCode": status, "Headers": http.Header{"Content-Type": {"application/json; charset=utf-8"}, "Cache-Control": {"no-store"}, "X-Content-Type-Options": {"nosniff"}}, "Body": raw})
}
func management(raw []byte) ([]byte, error) {
	var req struct {
		Method, Path string
		Body         []byte
	}
	if json.Unmarshal(raw, &req) != nil || len(req.Body) > 16384 {
		return httpResult(400, map[string]string{"error": "invalid_request"})
	}
	if req.Method == "GET" && (req.Path == resourcePrefix+"/index.html" || req.Path == apiPrefix+"/index.html") {
		return okEnvelope(map[string]any{"StatusCode": 200, "Headers": http.Header{"Content-Type": {"text/html; charset=utf-8"}, "Cache-Control": {"no-store"}, "X-Content-Type-Options": {"nosniff"}, "Content-Security-Policy": {"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"}}, "Body": console})
	}
	matched := false
	for _, r := range apiRoutes {
		if req.Method == r.Method && req.Path == apiPrefix+r.Path {
			matched = true
			break
		}
	}
	if !matched {
		return httpResult(404, map[string]string{"error": "route_not_found"})
	}
	engineMu.RLock()
	e := active
	engineMu.RUnlock()
	if e == nil || !e.begin() {
		return httpResult(503, map[string]string{"error": "plugin_unavailable"})
	}
	defer e.wg.Done()
	if req.Path == apiPrefix+"/api/settings" {
		e.mu.Lock()
		if req.Method == "POST" {
			var next settings
			if strictJSON(req.Body, &next) != nil || !validSettings(next) {
				e.mu.Unlock()
				return httpResult(400, map[string]string{"error": "invalid_settings"})
			}
			before := e.state.Settings
			e.state.Settings = next
			if err := e.persistLocked(); err != nil {
				e.state.Settings = before
				e.mu.Unlock()
				return httpResult(500, map[string]string{"error": "settings_not_saved"})
			}
		}
		current := e.state.Settings
		e.mu.Unlock()
		if req.Method == "POST" {
			select {
			case e.wake <- struct{}{}:
			default:
			}
		}
		return httpResult(200, current)
	}
	if req.Path == apiPrefix+"/api/status" {
		return httpResult(200, e.status())
	}
	var request struct {
		IDs []int64 `json:"ids"`
	}
	if strictJSON(req.Body, &request) != nil || !validIDs(request.IDs) {
		return httpResult(400, map[string]string{"error": "explicit_account_ids_required"})
	}
	results, err := e.run(request.IDs, req.Path == apiPrefix+"/api/refresh", false)
	if err != nil {
		status := http.StatusBadGateway
		if errors.Is(err, errBusy) {
			status = http.StatusConflict
		}
		return httpResult(status, map[string]string{"error": err.Error()})
	}
	return httpResult(200, map[string]any{"results": results})
}

func handleMethod(method string, raw []byte) ([]byte, error) {
	switch method {
	case "plugin.register", "plugin.reconfigure":
		if err := configure(raw); err != nil {
			return nil, err
		}
		return okEnvelope(registration())
	case "plugin.quiesce", "plugin.shutdown":
		quiesce()
		return okEnvelope(map[string]any{})
	case "management.register":
		return okEnvelope(managementRegistration())
	case "management.handle":
		return management(raw)
	default:
		return nil, fmt.Errorf("unsupported Register plugin method")
	}
}
