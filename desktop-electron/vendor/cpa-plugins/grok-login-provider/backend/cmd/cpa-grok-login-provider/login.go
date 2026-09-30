package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/chenyme/grok2api/backend/internal/infra/provider"
	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

// CPA keeps a plugin OAuth session for 30 minutes; the loopback page lives as long.
const loginSessionTTL = 30 * time.Minute

type loginStatus string

const (
	loginIdle    loginStatus = "idle"
	loginWorking loginStatus = "working"
	loginDone    loginStatus = "done"
	loginFailed  loginStatus = "failed"
)

// loginSession is one "Start Grok login" click. The page at /grok/login offers two methods:
// xAI OAuth (device flow, opened in the browser) and an SSO cookie form that POSTs back here.
type loginSession struct {
	mu        sync.Mutex
	state     string
	expires   time.Time
	status    loginStatus
	message   string
	accounts  []grokStorage
	server    *http.Server
	cancel    context.CancelFunc
	userCode  string
	verifyURL string
}

var logins = struct {
	sync.Mutex
	sessions map[string]*loginSession
}{sessions: make(map[string]*loginSession)}

func loginStart(raw []byte) ([]byte, error) {
	var req rpcAuthLoginStartRequest
	if errUnmarshal := json.Unmarshal(raw, &req); errUnmarshal != nil {
		return nil, errUnmarshal
	}
	rememberHost(req.Host)
	random := make([]byte, 24)
	if _, errRandom := rand.Read(random); errRandom != nil {
		return nil, errRandom
	}
	state := hex.EncodeToString(random)
	listener, errListen := net.Listen("tcp", "127.0.0.1:0")
	if errListen != nil {
		return nil, errListen
	}
	ctx, cancel := context.WithTimeout(context.Background(), loginSessionTTL)
	session := &loginSession{state: state, expires: time.Now().Add(loginSessionTTL), status: loginIdle, cancel: cancel}
	base := fmt.Sprintf("http://127.0.0.1:%d", listener.Addr().(*net.TCPAddr).Port)
	session.server = &http.Server{Handler: session.routes(ctx, base), ReadHeaderTimeout: 10 * time.Second}

	logins.Lock()
	logins.sessions[state] = session
	logins.Unlock()
	go func() { _ = session.server.Serve(listener) }()
	go func() {
		<-ctx.Done()
		_ = session.server.Close()
		time.AfterFunc(time.Minute, func() { forgetLogin(state) })
	}()

	loginURL := base + "/grok/login?state=" + state
	// API callers can skip the page: ?method=oauth returns xAI's verification URL directly.
	if method, _ := req.Metadata["method"].(string); strings.EqualFold(method, "oauth") {
		if errOAuth := session.startOAuth(ctx); errOAuth != nil {
			cancel()
			return nil, errOAuth
		}
		loginURL = session.verifyURL
	}
	return okEnvelope(pluginapi.AuthLoginStartResponse{
		Provider: providerIdentifier, URL: loginURL, State: state, ExpiresAt: session.expires,
	})
}

func loginPoll(raw []byte) ([]byte, error) {
	var req rpcAuthLoginPollRequest
	if errUnmarshal := json.Unmarshal(raw, &req); errUnmarshal != nil {
		return nil, errUnmarshal
	}
	logins.Lock()
	session := logins.sessions[req.State]
	logins.Unlock()
	if session == nil || time.Now().After(session.expires) {
		return okEnvelope(pluginapi.AuthLoginPollResponse{Status: pluginapi.AuthLoginStatusError, Message: "Grok login expired; start it again"})
	}
	session.mu.Lock()
	status, message, accounts := session.status, session.message, session.accounts
	session.mu.Unlock()
	switch status {
	case loginFailed:
		forgetLogin(req.State)
		return okEnvelope(pluginapi.AuthLoginPollResponse{Status: pluginapi.AuthLoginStatusError, Message: message})
	case loginDone:
		forgetLogin(req.State)
		session.cancel()
		auths := make([]pluginapi.AuthData, 0, len(accounts))
		for _, value := range accounts {
			auths = append(auths, authData(value, value.marshal(), value.fileName()))
		}
		return okEnvelope(pluginapi.AuthLoginPollResponse{
			Status: pluginapi.AuthLoginStatusSuccess, Message: message, Auth: auths[0], Auths: auths,
		})
	default:
		return okEnvelope(pluginapi.AuthLoginPollResponse{Status: pluginapi.AuthLoginStatusPending, Message: message})
	}
}

func forgetLogin(state string) {
	logins.Lock()
	delete(logins.sessions, state)
	logins.Unlock()
}

func stopLoginServers() {
	logins.Lock()
	sessions := make([]*loginSession, 0, len(logins.sessions))
	for _, session := range logins.sessions {
		sessions = append(sessions, session)
	}
	logins.Unlock()
	for _, session := range sessions {
		session.cancel()
	}
}

func (s *loginSession) set(status loginStatus, message string, accounts []grokStorage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.status == loginDone {
		return // the first completed method wins
	}
	s.status, s.message = status, message
	if accounts != nil {
		s.accounts = accounts
	}
}

func (s *loginSession) routes(ctx context.Context, base string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/grok/login", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || !s.validState(r.URL.Query().Get("state")) {
			http.Error(w, "Unknown or expired Grok login", http.StatusNotFound)
			return
		}
		writeLoginPage(w, s.state, loadedConfig().SSODefaultTarget)
	})
	mux.HandleFunc("/grok/oauth", func(w http.ResponseWriter, r *http.Request) {
		if !s.acceptPost(w, r, base) {
			return
		}
		if errOAuth := s.startOAuth(ctx); errOAuth != nil {
			http.Error(w, "Could not start xAI sign-in: "+errOAuth.Error(), http.StatusBadGateway)
			return
		}
		http.Redirect(w, r, s.verifyURL, http.StatusSeeOther)
	})
	mux.HandleFunc("/grok/sso", func(w http.ResponseWriter, r *http.Request) {
		if !s.acceptPost(w, r, base) {
			return
		}
		token := sanitizeSSO(r.PostFormValue("sso"))
		if token == "" {
			http.Error(w, "Paste the value of the grok.com sso cookie", http.StatusBadRequest)
			return
		}
		target := strings.ToLower(strings.TrimSpace(r.PostFormValue("target")))
		cloudflare := strings.TrimSpace(r.PostFormValue("cloudflare"))
		s.set(loginWorking, "Checking the SSO cookie…", nil)
		go s.completeSSO(ctx, token, cloudflare, target)
		http.Redirect(w, r, "/grok/login?state="+s.state+"#status", http.StatusSeeOther)
	})
	mux.HandleFunc("/grok/status", func(w http.ResponseWriter, r *http.Request) {
		if !s.validState(r.URL.Query().Get("state")) {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		s.mu.Lock()
		body := map[string]any{"status": s.status, "message": s.message, "user_code": s.userCode, "accounts": len(s.accounts)}
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(body)
	})
	return securityHeaders(mux)
}

func (s *loginSession) validState(candidate string) bool {
	return subtle.ConstantTimeCompare([]byte(candidate), []byte(s.state)) == 1 && time.Now().Before(s.expires)
}

// acceptPost enforces POST, the session state, and a same-origin request: the page is the only
// legitimate sender, so a cross-site form cannot submit a cookie into this session.
func (s *loginSession) acceptPost(w http.ResponseWriter, r *http.Request, base string) bool {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if errParse := r.ParseForm(); errParse != nil || !s.validState(r.PostFormValue("state")) {
		http.Error(w, "Unknown or expired Grok login", http.StatusForbidden)
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != base {
		http.Error(w, "cross-origin request refused", http.StatusForbidden)
		return false
	}
	return true
}

// startOAuth begins xAI's device flow once and polls it in the background.
func (s *loginSession) startOAuth(ctx context.Context) error {
	s.mu.Lock()
	if s.verifyURL != "" {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()
	rt, errRuntime := getRuntime()
	if errRuntime != nil {
		return errRuntime
	}
	device, errDevice := rt.build.StartDeviceAuthorization(ctx)
	if errDevice != nil {
		return errDevice
	}
	s.mu.Lock()
	s.userCode = device.UserCode
	s.verifyURL = firstNonEmpty(device.VerificationURIComplete, device.VerificationURI)
	s.mu.Unlock()
	s.set(loginWorking, "Waiting for xAI approval (code "+device.UserCode+")…", nil)
	go s.pollOAuth(ctx, rt, device)
	return nil
}

func (s *loginSession) pollOAuth(ctx context.Context, rt *grokRuntime, device provider.DeviceAuthorization) {
	interval := device.Interval
	if interval < time.Second {
		interval = 5 * time.Second
	}
	deadline := time.Now().Add(device.ExpiresIn)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
		seed, errPoll := rt.build.PollDeviceAuthorization(ctx, device.DeviceCode)
		switch {
		case errPoll == nil:
			value := seedStorage(upstreamBuild, seed, "login:oauth")
			s.set(loginDone, "Signed in to Grok Build as "+firstNonEmpty(value.Email, value.UserID), []grokStorage{value})
			return
		case errors.Is(errPoll, provider.ErrAuthorizationPending):
		case errors.Is(errPoll, provider.ErrSlowDown):
			interval += 5 * time.Second
		case errors.Is(errPoll, provider.ErrAuthorizationDenied):
			s.set(loginFailed, "xAI sign-in was denied or expired", nil)
			return
		default:
			s.set(loginFailed, "xAI sign-in failed: "+errPoll.Error(), nil)
			return
		}
	}
	s.set(loginFailed, "xAI sign-in timed out", nil)
}

// completeSSO validates the cookie per upstream and, for Build, converts it into OAuth tokens
// through xAI's device flow. Upstreams that fail are reported; the rest are still saved.
func (s *loginSession) completeSSO(ctx context.Context, token, cloudflare, target string) {
	if target == "" {
		target = loadedConfig().SSODefaultTarget
	}
	rt, errRuntime := getRuntime()
	if errRuntime != nil {
		s.set(loginFailed, errRuntime.Error(), nil)
		return
	}
	var saved []grokStorage
	var notes []string
	for _, value := range ssoAccounts(token, cloudflare, target, "login:sso", true) {
		resolved, errResolve := resolveSSOAccount(ctx, rt, value)
		if errResolve != nil {
			notes = append(notes, upstreamTitle(value.Upstream)+": "+errResolve.Error())
			continue
		}
		saved = append(saved, resolved)
		notes = append(notes, upstreamTitle(value.Upstream)+": ok")
	}
	summary := strings.Join(notes, "; ")
	if len(saved) == 0 {
		s.set(loginFailed, "SSO cookie was not accepted ("+summary+")", nil)
		return
	}
	s.set(loginDone, "Saved "+fmt.Sprint(len(saved))+" Grok account(s): "+summary, saved)
}

// resolveSSOAccount fills identity for Web/Console and converts Build; see sso.go.
var resolveSSOAccount = func(ctx context.Context, rt *grokRuntime, value grokStorage) (grokStorage, error) {
	return resolveSSO(ctx, rt, value)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}

var loginPage = template.Must(template.New("login").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grok login</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#deddd8;--accent:#1d1d1b;--accent-ink:#fff;--ok:#1f7a4d;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--card:#1c1c1c;--ink:#ececea;--muted:#9a9a94;--line:#2e2e2c;--accent:#ececea;--accent-ink:#121212;--ok:#5cc190;--bad:#f2867e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:560px;margin:0 auto;padding:40px 16px}h1{font-size:22px;margin:0 0 4px}p{margin:0 0 12px;color:var(--muted)}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-top:16px}
h2{font-size:16px;margin:0 0 8px}label{display:block;font-size:13px;margin:12px 0 4px;color:var(--muted)}
textarea,select{width:100%;font:13px ui-monospace,Consolas,monospace;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
textarea{min-height:84px;resize:vertical}button{margin-top:14px;padding:10px 16px;border:0;border-radius:8px;background:var(--accent);color:var(--accent-ink);font-weight:600;cursor:pointer}
#status{margin-top:16px;padding:12px 14px;border-radius:8px;border:1px solid var(--line);display:none}#status.ok{color:var(--ok)}#status.bad{color:var(--bad)}
code{font-size:13px}
</style></head><body><main>
<h1>Connect a Grok account to CPA</h1>
<p>Choose one method. When it finishes, return to the CPA management page; it picks the account up automatically.</p>
<section><h2>Sign in with xAI (OAuth)</h2>
<p>Opens accounts.x.ai. Creates a <b>Grok Build</b> account with refreshable tokens.</p>
<form method="post" action="/grok/oauth"><input type="hidden" name="state" value="{{.State}}"><button type="submit">Sign in with xAI</button></form></section>
<section><h2>Use an SSO cookie</h2>
<p>In a browser signed in to grok.com, copy the value of the <code>sso</code> cookie (DevTools → Application → Cookies).</p>
<form method="post" action="/grok/sso" autocomplete="off"><input type="hidden" name="state" value="{{.State}}">
<label for="sso">sso cookie</label><textarea id="sso" name="sso" required spellcheck="false" placeholder="eyJhbGciOi… or sso=eyJ…; sso-rw=…"></textarea>
<label for="cloudflare">Cloudflare cookies (optional, for Grok Web behind a challenge)</label><textarea id="cloudflare" name="cloudflare" spellcheck="false" placeholder="cf_clearance=…; __cf_bm=…"></textarea>
<label for="target">Create accounts for</label><select id="target" name="target">
<option value="all"{{if eq .Target "all"}} selected{{end}}>Build + Web + Console</option>
<option value="build"{{if eq .Target "build"}} selected{{end}}>Grok Build (cookie converted to OAuth)</option>
<option value="web"{{if eq .Target "web"}} selected{{end}}>Grok Web (grok.com)</option>
<option value="console"{{if eq .Target "console"}} selected{{end}}>Grok Console (console.x.ai)</option></select>
<button type="submit">Save cookie</button></form></section>
<div id="status" role="status"></div>
<script>
const box=document.getElementById("status");
async function tick(){try{const r=await fetch("/grok/status?state={{.State}}",{cache:"no-store"});if(!r.ok)return;const s=await r.json();
if(s.status==="idle")return setTimeout(tick,2000);box.style.display="block";box.className=s.status==="done"?"ok":s.status==="failed"?"bad":"";
box.textContent=(s.status==="done"?"Done. ":s.status==="failed"?"Failed. ":"")+(s.message||"");if(s.status==="working")setTimeout(tick,2000);}catch(e){setTimeout(tick,3000)}}
tick();
</script></main></body></html>`))

func writeLoginPage(w http.ResponseWriter, state, target string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = loginPage.Execute(w, struct{ State, Target string }{State: state, Target: target})
}
