package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"gopkg.in/yaml.v3"
)

//go:embed upstream/* upstream/public/*
var assets embed.FS

const providerIdentifier = "cline"
const pluginID = "cline-pass-switcher"
const apiPrefix = "/v0/management/" + pluginID
const resourcePrefix = "/v0/resource/plugins/" + pluginID

var pluginVersion = "0.1.0-codingtools.1"
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
	b, e := json.Marshal(v)
	if e != nil {
		return nil, e
	}
	return json.Marshal(envelope{OK: true, Result: b})
}
func errorEnvelope(code, msg string) []byte { return upstreamErrorEnvelope(code, msg, 500, false) }
func upstreamErrorEnvelope(code, msg string, status int, retry bool) []byte {
	b, _ := json.Marshal(envelope{Error: &envelopeError{Code: code, Message: msg, HTTPStatus: status, Retryable: retry}})
	return b
}
func unwrapHostEnvelope(method string, raw []byte, code int) (json.RawMessage, error) {
	var e envelope
	if err := json.Unmarshal(raw, &e); err != nil {
		return nil, fmt.Errorf("invalid host response: %s", method)
	}
	if code != 0 || !e.OK {
		return nil, fmt.Errorf("host callback failed: %s", method)
	}
	return e.Result, nil
}

type pluginConfig struct {
	Runtime  string `yaml:"runtime-executable"`
	DataDir  string `yaml:"data-dir"`
	ProxyURL string `yaml:"proxy-url"`
}
type service struct {
	cfg       pluginConfig
	key, base string
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	ctx       context.Context
	cancel    context.CancelFunc
	done      chan struct{}
}

var runtimeMu sync.Mutex
var active *service
var loopbackClient = &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 15 * time.Minute,
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}

func configure(raw []byte) error {
	var req struct {
		ConfigYAML []byte `json:"config_yaml"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return err
	}
	var cfg pluginConfig
	if err := yaml.Unmarshal(req.ConfigYAML, &cfg); err != nil {
		return err
	}
	if !filepath.IsAbs(cfg.Runtime) || !filepath.IsAbs(cfg.DataDir) {
		return fmt.Errorf("Cline runtime-executable and data-dir must be absolute")
	}
	runtimeMu.Lock()
	defer runtimeMu.Unlock()
	if active != nil && active.cfg == cfg {
		return nil
	}
	stopRuntime()
	if err := os.MkdirAll(cfg.DataDir, 0700); err != nil {
		return err
	}
	runtimeDir := filepath.Join(cfg.DataDir, "runtime")
	if err := os.MkdirAll(filepath.Join(runtimeDir, "public"), 0700); err != nil {
		return err
	}
	for _, name := range []string{"server.js", "public/index.html", "package.json", "LICENSE"} {
		b, err := assets.ReadFile("upstream/" + name)
		if err != nil {
			return err
		}
		if name == "server.js" {
			b = bytes.Replace(b, []byte("Number(process.env.PORT) || config.port"), []byte("Number(process.env.PORT)"), 1)
			b = bytes.Replace(b, []byte("server.listen(config.port, BIND_HOST, () => {"), []byte("server.listen(config.port, BIND_HOST, () => {\n  config.port = server.address().port; console.log('CLINE_SWITCHER_READY:' + config.port);"), 1)
		}

		b = bytes.Replace(b, []byte("              const { value, done } = await reader.read();\n              if (done) {\n                isSSE = false;\n                netError = 'empty stream';\n              } else {\n                firstChunk = Buffer.from(value);\n                const head = firstChunk.toString('utf8').trimStart().slice(0, 200);\n                if (head.startsWith('data:')) {\n                  const payload = head.replace(/^data:\\s*/, '').slice(0, 160);\n                  if (payload.startsWith('{\"error\"')) { isSSE = false; netError = `stream error: ${payload.slice(0, 120)}`; }\n                } else {\n                  isSSE = false;\n                  netError = `unexpected stream head: ${head.slice(0, 60)}`;\n                }\n              }"), []byte(`               const chunks = [];
               while (true) {
                 const { value, done } = await reader.read();
                 if (done) { isSSE = false; netError = 'empty stream'; break; }
                 chunks.push(Buffer.from(value));
                 firstChunk = Buffer.concat(chunks);
                 if (firstChunk.length > 1024 * 1024) { isSSE = false; netError = 'stream prelude too large'; break; }
                 const text = firstChunk.toString('utf8');
                 // Only complete lines can classify an SSE prelude; comments and fragmented prefixes are valid.
                 const lines = text.split(/\r?\n/).slice(0, -1);
                 const firstData = lines.find((line) => line.startsWith('data:'));
                 if (firstData) {
                   const payload = firstData.replace(/^data:\s*/, '').slice(0, 160);
                   if (payload.startsWith('{"error"')) { isSSE = false; netError = 'stream error: ' + payload.slice(0, 120); }
                   break;
                 }
                 if (text.trimStart().startsWith('{')) { isSSE = false; netError = 'upstream returned JSON instead of SSE'; break; }
               }`), 1)

		b = bytes.Replace(b, []byte("  const upstreams = r.pipeline === 'planner'\n    ? [...new Set([...(harvest || []), ...r.fallbacks])]\n    : [...new Set([...r.fallbacks, ...(harvest || []), ...Object.keys(detail)])];"), []byte("  // The gateway may hide its fallback catalog; the successful provider is still observed evidence.\n  const observed = r.finalProvider ? [r.finalProvider] : [];\n  const upstreams = r.pipeline === 'planner'\n    ? [...new Set([...observed, ...(harvest || []), ...r.fallbacks])]\n    : [...new Set([...observed, ...r.fallbacks, ...(harvest || []), ...Object.keys(detail)])];"), 1)
		b = bytes.Replace(b, []byte("availableProviders: harvest || prev.availableProviders || [],"), []byte("availableProviders: [...new Set([...observed, ...(harvest || prev.availableProviders || [])])],"), 1)

		if err := os.WriteFile(filepath.Join(runtimeDir, filepath.FromSlash(name)), b, 0600); err != nil {
			return err
		}
	}
	if err := os.WriteFile(filepath.Join(runtimeDir, "managed.mjs"), []byte(runtimeWrapper), 0600); err != nil {
		return err
	}
	keyBytes := make([]byte, 32)
	if _, err := rand.Read(keyBytes); err != nil {
		return err
	}
	key := hex.EncodeToString(keyBytes)
	configFile := filepath.Join(cfg.DataDir, "config.json")
	persisted := map[string]any{}
	if b, err := os.ReadFile(configFile); err == nil {
		if err := json.Unmarshal(b, &persisted); err != nil {
			return fmt.Errorf("invalid local Cline configuration; refusing to overwrite")
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	persisted["proxyKey"] = key
	b, err := json.MarshalIndent(persisted, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(configFile, b, 0600); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &service{cfg: cfg, key: key, ctx: ctx, cancel: cancel, done: make(chan struct{})}
	s.cmd = exec.Command(cfg.Runtime, filepath.Join(runtimeDir, "managed.mjs"))
	hideWindow(s.cmd)
	s.cmd.Dir = runtimeDir
	s.cmd.Env = append(os.Environ(), "DATA_DIR="+cfg.DataDir, "BIND_HOST=127.0.0.1", "PORT=0", "PROXY_KEY="+key,
		"NODE_USE_ENV_PROXY=1", "HTTP_PROXY="+cfg.ProxyURL, "HTTPS_PROXY="+cfg.ProxyURL, "ALL_PROXY="+cfg.ProxyURL)
	s.stdin, err = s.cmd.StdinPipe()
	if err != nil {
		cancel()
		return err
	}
	stdout, err := s.cmd.StdoutPipe()
	if err != nil {
		cancel()
		return err
	}
	s.cmd.Stderr = io.Discard
	if err := s.cmd.Start(); err != nil {
		cancel()
		_ = s.stdin.Close()
		return fmt.Errorf("start managed Cline runtime: %w", err)
	}
	ready := make(chan int, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			if strings.HasPrefix(sc.Text(), "CLINE_SWITCHER_READY:") {
				port, e := strconv.Atoi(strings.TrimPrefix(sc.Text(), "CLINE_SWITCHER_READY:"))
				if e == nil && port > 0 && port <= 65535 {
					select {
					case ready <- port:
					default:
					}
				}
			}
		}
	}()
	go func() { _ = s.cmd.Wait(); close(s.done) }()
	active = s
	select {
	case port := <-ready:
		s.base = "http://127.0.0.1:" + strconv.Itoa(port)
		return nil
	case <-s.done:
		stopRuntime()
		return fmt.Errorf("managed Cline runtime exited before readiness")
	case <-time.After(15 * time.Second):
		stopRuntime()
		return fmt.Errorf("managed Cline runtime readiness timed out")
	}
}
func stopRuntime() {
	if active == nil {
		return
	}
	s := active
	active = nil
	s.cancel()
	_ = s.stdin.Close()
	select {
	case <-s.done:
		return
	case <-time.After(2 * time.Second):
	}
	_ = s.cmd.Process.Kill()
	select {
	case <-s.done:
	case <-time.After(3 * time.Second):
	}
}
func quiesce() { runtimeMu.Lock(); defer runtimeMu.Unlock(); stopRuntime() }
func localRequest(method, path string, body []byte) (*http.Response, error) {
	runtimeMu.Lock()
	s := active
	runtimeMu.Unlock()
	if s == nil {
		return nil, fmt.Errorf("managed Cline runtime is not available")
	}
	key := s.key
	if b, e := os.ReadFile(filepath.Join(s.cfg.DataDir, "config.json")); e == nil {
		var c struct {
			ProxyKey string `json:"proxyKey"`
		}
		if json.Unmarshal(b, &c) == nil && c.ProxyKey != "" {
			key = c.ProxyKey
		}
	}
	req, e := http.NewRequestWithContext(s.ctx, method, s.base+path, bytes.NewReader(body))
	if e != nil {
		return nil, e
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	return loopbackClient.Do(req)
}
func readLocal(method, path string, body []byte) (int, http.Header, []byte, error) {
	r, e := localRequest(method, path, body)
	if e != nil {
		return 0, nil, nil, e
	}
	defer r.Body.Close()
	b, e := io.ReadAll(io.LimitReader(r.Body, 40<<20))
	return r.StatusCode, r.Header, b, e
}
func registration() any {
	return map[string]any{"schema_version": 6, "metadata": map[string]any{
		"Name": "Cline Pass Switcher", "Version": pluginVersion, "Author": "Coding Tools / munmunjaklin458-afk",
		"GitHubRepository": "https://github.com/munmunjaklin458-afk/cline-pass-switcher",
		"ConfigFields": []map[string]string{
			{"Name": "runtime-executable", "Type": "string", "Description": "Absolute managed Bun or Node executable"},
			{"Name": "data-dir", "Type": "string", "Description": "Private local Cline Pass account/configuration directory"},
			{"Name": "proxy-url", "Type": "string", "Description": "Selected outbound proxy; local CPA traffic bypasses it"},
		}},
		"capabilities": map[string]any{"auth_provider": true, "model_provider": true, "executor": true, "management_api": true,
			"executor_model_scope": "oauth", "executor_input_formats": []string{"chat-completions"}, "executor_output_formats": []string{"chat-completions"}}}
}

var apiRoutes = []struct{ Method, Path string }{
	{"GET", "/api/meta"}, {"GET", "/api/models"}, {"GET", "/api/accounts"}, {"POST", "/api/accounts"},
	{"POST", "/api/accounts/test"}, {"GET", "/api/security"}, {"POST", "/api/security"},
	{"POST", "/api/probe"}, {"POST", "/api/test"}, {"POST", "/api/validate-upstreams"},
	{"POST", "/api/fetch-official-models"}, {"GET", "/api/history"}, {"GET", "/api/config"}, {"POST", "/api/config"},
}

func managementRegistration() any {
	routes := []map[string]string{}
	for _, r := range apiRoutes {
		routes = append(routes, map[string]string{"Method": r.Method, "Path": apiPrefix + r.Path})
	}
	return map[string]any{"routes": routes, "resources": []map[string]string{{"Path": "index.html", "Menu": "Cline Pass", "Description": "Full Cline Pass accounts, upstream selection and failover console"}}}
}
func consoleHTML() ([]byte, error) {
	b, e := assets.ReadFile("upstream/public/index.html")
	if e != nil {
		return nil, e
	}
	return bytes.Replace(b, []byte("<head>"), []byte("<head>"+consoleBridge), 1), nil
}
func management(raw []byte) ([]byte, error) {
	var req struct {
		Method, Path string
		Query        url.Values
		Body         []byte
	}
	if e := json.Unmarshal(raw, &req); e != nil {
		return nil, e
	}
	if req.Method == "GET" && req.Path == resourcePrefix+"/index.html" {
		b, e := consoleHTML()
		if e != nil {
			return nil, e
		}
		return okEnvelope(map[string]any{"StatusCode": 200, "Headers": http.Header{"Content-Type": {"text/html; charset=utf-8"}}, "Body": b})
	}
	route := ""
	for _, r := range apiRoutes {
		if req.Method == r.Method && req.Path == apiPrefix+r.Path {
			route = r.Path
			break
		}
	}
	if route == "" {
		return upstreamErrorEnvelope("route_not_found", "unknown Cline plugin route", 404, false), nil
	}
	// A managed loopback backend must always require a private proxy credential.
	if route == "/api/security" && req.Method == "POST" {
		var values map[string]any
		if e := json.Unmarshal(req.Body, &values); e != nil {
			return nil, e
		}
		if v, ok := values["proxyKey"]; ok && strings.TrimSpace(fmt.Sprint(v)) == "" {
			return upstreamErrorEnvelope("invalid_proxy_key", "managed Cline proxy key must not be empty", 400, false), nil
		}
	}
	if len(req.Query) > 0 {
		route += "?" + req.Query.Encode()
	}
	status, headers, b, e := readLocal(req.Method, route, req.Body)
	if e != nil {
		return nil, e
	}
	return okEnvelope(map[string]any{"StatusCode": status, "Headers": headers, "Body": b})
}
func models() ([]byte, error) {
	status, _, b, e := readLocal("GET", "/v1/models", nil)
	if e != nil {
		return nil, e
	}
	if status != 200 {
		return upstreamErrorEnvelope("catalog_error", "Cline catalog is unavailable", status, status >= 500), nil
	}
	var result struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if e := json.Unmarshal(b, &result); e != nil {
		return nil, e
	}
	infos := []map[string]any{}
	for _, m := range result.Data {
		infos = append(infos, map[string]any{"ID": m.ID, "Object": "model", "OwnedBy": "cline", "Type": "cline", "DisplayName": m.ID, "Name": m.ID})
	}
	return okEnvelope(map[string]any{"Provider": providerIdentifier, "Models": infos})
}
func parseAuth(raw []byte) ([]byte, error) {
	var req struct {
		RawJSON  []byte
		FileName string
	}
	if e := json.Unmarshal(raw, &req); e != nil {
		return nil, e
	}
	var data struct {
		Type     string `json:"type"`
		Switcher bool   `json:"switcher"`
		Disabled bool   `json:"disabled"`
	}
	if json.Unmarshal(req.RawJSON, &data) != nil || data.Type != "cline" || !data.Switcher {
		return okEnvelope(map[string]any{"Handled": false})
	}
	return okEnvelope(map[string]any{"Handled": true, "Auth": map[string]any{"Provider": "cline", "FileName": req.FileName, "Label": "Cline Pass", "Disabled": data.Disabled, "StorageJSON": req.RawJSON}})
}
func execute(raw []byte, stream bool) ([]byte, error) {
	var req struct {
		Payload  []byte
		Model    string
		StreamID string `json:"stream_id"`
	}
	if e := json.Unmarshal(raw, &req); e != nil {
		return nil, e
	}
	var body map[string]any
	if e := json.Unmarshal(req.Payload, &body); e != nil {
		return nil, e
	}
	if req.Model != "" {
		body["model"] = req.Model
	}
	body["stream"] = stream
	b, e := json.Marshal(body)
	if e != nil {
		return nil, e
	}
	r, e := localRequest("POST", "/v1/chat/completions", b)
	if e != nil {
		return nil, e
	}
	if r.StatusCode < 200 || r.StatusCode >= 300 {
		defer r.Body.Close()
		out, _ := io.ReadAll(io.LimitReader(r.Body, 8192))
		return upstreamErrorEnvelope("cline_upstream", string(out), r.StatusCode, r.StatusCode == 429 || r.StatusCode >= 500), nil
	}
	if !stream {
		defer r.Body.Close()
		b, e = io.ReadAll(io.LimitReader(r.Body, 40<<20))
		if e != nil {
			return nil, e
		}
		return okEnvelope(map[string]any{"Payload": b, "Headers": r.Header})
	}
	if !strings.Contains(r.Header.Get("Content-Type"), "text/event-stream") {
		_ = r.Body.Close()
		return upstreamErrorEnvelope("invalid_stream", "Cline returned a non-SSE streaming response", 502, true), nil
	}
	if req.StreamID == "" {
		_ = r.Body.Close()
		return errorEnvelope("invalid_stream", "missing stream ID"), nil
	}
	go func() {
		defer r.Body.Close()
		err := relaySSE(r.Body, func(b []byte) error {
			_, e := hostCall("host.stream.emit", map[string]any{"stream_id": req.StreamID, "payload": b})
			return e
		})
		msg := ""
		if err != nil {
			msg = "Cline stream interrupted"
		}
		_, _ = hostCall("host.stream.close", map[string]any{"stream_id": req.StreamID, "error": msg})
	}()
	return okEnvelope(map[string]any{"headers": r.Header})
}
func relaySSE(reader io.Reader, emit func([]byte) error) error {
	sc := bufio.NewScanner(reader)
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	parts := []string{}
	flush := func() error {
		if len(parts) == 0 {
			return nil
		}
		b := []byte(strings.Join(parts, "\n"))
		parts = nil
		if string(b) == "[DONE]" {
			return nil
		}
		return emit(b)
	}
	for sc.Scan() {
		line := sc.Text()
		if line == "" {
			if e := flush(); e != nil {
				return e
			}
		} else if strings.HasPrefix(line, "data:") {
			parts = append(parts, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if e := sc.Err(); e != nil {
		return e
	}
	return flush()
}
func handleMethod(method string, raw []byte) ([]byte, error) {
	switch method {
	case "plugin.register", "plugin.reconfigure":
		if e := configure(raw); e != nil {
			return nil, e
		}
		return okEnvelope(registration())
	case "plugin.quiesce", "plugin.shutdown":
		quiesce()
		return okEnvelope(map[string]any{})
	case "management.register":
		return okEnvelope(managementRegistration())
	case "management.handle":
		return management(raw)
	case "auth.identifier", "executor.identifier":
		return okEnvelope(map[string]string{"identifier": "cline"})
	case "auth.parse":
		return parseAuth(raw)
	case "auth.refresh":
		var r struct{ StorageJSON []byte }
		if e := json.Unmarshal(raw, &r); e != nil {
			return nil, e
		}
		return okEnvelope(map[string]any{"Auth": map[string]any{"Provider": "cline", "Label": "Cline Pass", "StorageJSON": r.StorageJSON}})
	case "model.static":
		return okEnvelope(map[string]any{"Provider": "cline", "Models": []any{}})
	case "model.for_auth":
		return models()
	case "executor.execute":
		return execute(raw, false)
	case "executor.execute_stream":
		return execute(raw, true)
	case "auth.login.start", "auth.login.poll":
		return upstreamErrorEnvelope("api_key_setup", "Add a Cline Pass API key in Plugins > Cline Pass > Accounts", 501, false), nil
	default:
		return upstreamErrorEnvelope("unsupported_method", "unsupported Cline plugin method: "+method, 501, false), nil
	}
}

const runtimeWrapper = `process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
if (typeof Bun !== 'undefined' && process.env.HTTPS_PROXY) {
 const original = globalThis.fetch;
 globalThis.fetch = (input, options = {}) => {
  const host = new URL(typeof input === 'string' ? input : input.url || String(input)).hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  return original(input, local ? options : { ...options, proxy: process.env.HTTPS_PROXY });
 };
}
await import('./server.js');
`
const consoleBridge = `<script>
(() => {
 let key = sessionStorage.getItem('coding-tools-cpa-session') || localStorage.getItem('cpaHelper.managementKey') || localStorage.getItem('managementKey') || '';
 try { key = JSON.parse(key); } catch {}
 if (!key) { try { key = JSON.parse(localStorage.getItem('cli-proxy-auth')).state.managementKey; } catch {} }
 if (key) localStorage.setItem('cps_key', key);
 const original = window.fetch.bind(window);
 window.fetch = (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
   let key = sessionStorage.getItem('coding-tools-cpa-session') || localStorage.getItem('cpaHelper.managementKey') || localStorage.getItem('managementKey') || '';
   try { key = JSON.parse(key); } catch {}
   if (!key) { try { key = JSON.parse(localStorage.getItem('cli-proxy-auth')).state.managementKey; } catch {} }
   const headers = new Headers(options.headers);
   headers.delete('X-Admin-Key'); headers.set('Authorization', 'Bearer ' + key);
   return original('/v0/management/cline-pass-switcher' + url.pathname + url.search, { ...options, headers });
  }
  return original(input, options);
 };
})();
</script>`
